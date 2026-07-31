/**
 * run-parser.mjs  –  AD&D 2e spell-block extractor for scanned TSR PDFs
 * ═══════════════════════════════════════════════════════════════════════════
 * Reads the text layer of one or more PDFs and emits a JSON array of spell
 * records. Built to survive the defects of scanned/print-to-PDF sources:
 *   • Two-column layout (left column first, then right), auto-detected per page
 *   • Section-level heading → current level number
 *   • Spell header: "SpellName (School)" Title Case
 *   • Two-line spell headers: "Spell Name" / "(School)" on the next line (PHB style)
 *   • Letter-spacing collapse: "C o m p o n e n t s :" → "Components:"
 *   • Field parsing: Range, Components, Duration, Casting Time, etc.
 *   • Multiple stat fields on one line: "Range: 10 yds. Components: V, S, M"
 *   • Junk-line filter: browser print-to-PDF artifacts (timestamps, file:/// URLs)
 *   • Class detection by evidence: a "Sphere:" field marks a Priest spell
 *   • Psionics: Dark Sun "Psionic Enchantments" plus true psionic powers
 *     (discipline / tier / PSP costs, as in "The Will and the Way")
 *   • Source label derived from the input filename
 *
 * Usage:  node run-parser.mjs [--start=N] [--end=N] [--out=path.json] file.pdf [more.pdf ...]
 *         --start/--end limit the page range (default: whole document)
 *         --out sets the output path (default: output/parsed-spells.json)
 */

import { readFile, writeFile } from 'fs/promises';
import { mkdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, basename, resolve } from 'path';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load pdfjs-dist ──────────────────────────────────────────────────────────

// pathToFileURL keeps Windows happy: raw "C:\..." paths are rejected by the
// ESM loader, which only accepts file:// URLs for absolute imports.
let pdfjsLib;
try {
  pdfjsLib = await import(pathToFileURL(join(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
} catch {
  pdfjsLib = await import(pathToFileURL(join(__dirname, 'node_modules/pdfjs-dist/build/pdf.mjs')).href);
}

// ── Regexes (mirrors C# DKSpellExtractor) ───────────────────────────────────

// Name class allows &, /, and digits so headers like "Detect Snares & Pits",
// "Resist Fire/Resist Cold" and "Control Temperature, 10' Radius" are recognised
// (otherwise those spells are dropped and leak into the previous description).
const SPELL_HEADER_RE = /^(?<Name>[A-Z][A-Za-z0-9 ,'\-\.\/&]+?)\s*\((?<School>[A-Za-z/\s,]+?)\)\s*(?:Reversible\s*)?$/;
// Two-line header support (PHB style): name alone, then "(School)" on the next line.
// Same broadened character set; the mandatory "(School)" line on the next row is
// the guard that keeps this from matching arbitrary prose.
const NAME_ONLY_RE = /^[A-Z][A-Za-z0-9 ,'\-\/&]{1,60}$/;
const SCHOOL_ONLY_RE = /^\((?<School>[A-Za-z/\s,]+?)\)\s*(?:Reversible\s*)?$/;
// Browser print-to-PDF artifacts: "7/4/26, 10:26 AM Full text of ...", file:/// URLs, "166/3963" page counters.
const JUNK_LINE_RE = /file:\/\/\/|^\d{1,2}\/\d{1,2}\/\d{2,4},\s|Full text of "|^\d+\/\d+$/;
// The separator before "Level" is optional: books are inconsistent between
// "First-Level Spells" (Dark Sun) and "First Level Spells" (Forgotten Realms
// Adventures), and letter-spacing collapse can drop it entirely. Requiring the
// hyphen silently left every spell in an unhyphenated book at the initial level.
const SECTION_LEVEL_RE = /^(?<Ordinal>First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth|Thirteenth|\d{1,2}(?:st|nd|rd|th))[\s-]*Level\s+(?:(?<Class>Priest|Wizard|Mage|Cleric|Druid|Defiler|Preserver)\s+)?(?:Spells?|Psionic)/i;
const PSIONIC_SECTION_RE = /^Psionic\s+Enchantments?/i;
const FIELD_LINE_RE = /^(?<Field>Range|Components?|Duration|CastingTime|Casting\s+Time|AreaofEffect|Area\s+of\s+Effect|SavingThrow|Saving\s+Throw|PreparationTime|Preparation\s+Time)\s*:\s*(?<Value>.+)$/i;
// Priest-spell Sphere line: "Sphere: Combat". Matched with a REQUIRED colon and
// anchored to the start of its own line, so the common word "sphere" appearing
// inside an Area-of-Effect value (e.g. "20-ft.-radius sphere") is never mistaken
// for this field. Presence of a Sphere is what marks a spell as a Priest spell.
const SPHERE_LINE_RE = /^Sphere\s*:\s*(?<Value>.+)$/i;

// ── True psionic powers (e.g. "The Will and the Way") ─────────────────────────
// Powers are organised under "<Discipline-adjective> Sciences|Devotions" section
// headings; each power is a name line followed by a "Power Score:" stat block.
// This is distinct from Dark Sun "Psionic Enchantments" (high-level spells).
const PSIONIC_DISC_SECTION_RE =
  /^(?<Disc>Clairsentient|Psychokinetic|Psychometabolic|Psychoportive|Telepathic|Metapsionic)\s+(?<Tier>Sciences?|Devotions?)\s*$/i;
const POWER_SCORE_RE  = /^Power\s*Score\s*:/i;   // first stat line of a power
const INITIAL_COST_RE = /^Initial\s*Cost\s*:/i;  // second stat line — confirms a real power header
// A psionic stat line: label at the start of its own line, required colon.
const PSIONIC_FIELD_RE =
  /^(?<Field>Power\s*Score|Initial\s*Cost|Maintenance\s*Cost|Range|Preparation\s*Time|Area\s*of\s*Effect|Prerequisites?)\s*:\s*(?<Value>.*)$/i;
const HIGH_SCIENCE_RE = /\(\s*High\s+Sciences?\s*\)/i;  // tier flag inside a power name

// Discipline adjective (as used in section headings) → canonical discipline noun.
const PSIONIC_DISCIPLINE = {
  clairsentient:   'Clairsentience',
  psychokinetic:   'Psychokinesis',
  psychometabolic: 'Psychometabolism',
  psychoportive:   'Psychoportation',
  telepathic:      'Telepathy',
  metapsionic:     'Metapsionics',
};

function normalisePsionicKey(raw) {
  switch (raw.toLowerCase().replace(/\s+/g, '')) {
    case    'powerscore':      return 'PowerScore';
    case    'initialcost':     return 'InitialCost';
    case    'maintenancecost': return 'MaintenanceCost';
    case    'range':           return 'Range';
    case    'preparationtime': return 'PreparationTime';
    case    'areaofeffect':    return 'AreaOfEffect';
    case    'prerequisite':
    case    'prerequisites':   return 'Prerequisites';
    default:                   return raw;
  }
}

// A raw ability-score value line ("Con-4", "Dex -1", "Int +2"). These get
// reordered above their "Power Score:" label by the column extractor and must
// not be mistaken for a power name.
const ABILITY_VALUE_RE = /^(?:Str|Dex|Con|Int|Wis|Cha)\s*[-+]?\s*\d/i;

// A psionic power name is any short Title-case line that is not itself a stat
// line, an ability value, or a section heading. The real gate is the stat-line
// lookahead at the call site, so this can stay lenient.
function isPsionicNameCandidate(line) {
  return /^[A-Z]/.test(line) && line.length <= 60 &&
    !ABILITY_VALUE_RE.test(line) &&
    !/\b(?:Sciences?|Devotions?)\s*$/i.test(line) &&  // a (possibly misspelled) section heading, not a power
    !PSIONIC_FIELD_RE.test(line) && !PSIONIC_DISC_SECTION_RE.test(line) &&
    !JUNK_LINE_RE.test(line);
}

// Does a psionic power stat block start at the name line `lines[li]`? Tolerates
// the column extractor's quirks: the value may be split from its "Power Score:"
// label, or reordered above it. Signature: "Power Score" within the next two
// lines, immediately followed by "Initial Cost".
//   clean:     Name / Power Score:Xxx-N / Initial Cost:N
//   split:     Name / Power Score: / Xxx-N / Initial Cost:N
//   reordered: Name / Xxx-N / Power Score: / Initial Cost:N
function psionicPowerStartsAt(lines, li) {
  const l1 = lines[li + 1]?.text ?? '';
  const l2 = lines[li + 2]?.text ?? '';
  const l3 = lines[li + 3]?.text ?? '';
  const psAt1 = POWER_SCORE_RE.test(l1);
  const psAt2 = POWER_SCORE_RE.test(l2);
  return (psAt1 && (INITIAL_COST_RE.test(l2) || INITIAL_COST_RE.test(l3))) ||
         (psAt2 && INITIAL_COST_RE.test(l3));
}
// Global marker for splitting multiple fields that share one physical line,
// e.g. "Range: 5 yds./level Components: V, S, M".
const FIELD_MARKER_RE = /(Range|Components?|Duration|Casting\s*Time|Area\s*of\s*Effect|Saving\s*Throw|Preparation\s*Time)\s*:?/gi;

/**
 * Extract every "Field: value" pair from a line. Returns null when the line
 * is not a stat line (first marker must sit at the start of the line so that
 * prose mentioning "range:" mid-sentence is not misread).
 */
function extractFields(line) {
  const markers = [...line.matchAll(FIELD_MARKER_RE)];
  if (!markers.length || markers[0].index > 2) return null;
  const out = [];
  for (let i = 0; i < markers.length; i++) {
    const key   = normaliseFieldKey(markers[i][1]);
    const start = markers[i].index + markers[i][0].length;
    const end   = i + 1 < markers.length ? markers[i + 1].index : line.length;
    out.push([key, line.slice(start, end).trim()]);
  }
  return out;
}

const ORDINAL_TO_LEVEL = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11,
  twelfth: 12, thirteenth: 13,
};

/** Word ("First") or numeric ("1st") ordinal → level number, else null. */
function ordinalToLevel(ord) {
  const key = ord.toLowerCase();
  if (key in ORDINAL_TO_LEVEL) return ORDINAL_TO_LEVEL[key];
  const m = key.match(/^(\d{1,2})(?:st|nd|rd|th)$/);
  return m ? Number(m[1]) : null;
}

// ── Letter-spacing collapse ──────────────────────────────────────────────────

function collapseLetterSpacing(text) {
  if (!text) return text;
  const parts = text.split(' ');
  if (parts.length > 2 && parts.every(p => p.length <= 1))
    return parts.join('');
  return text;
}

// ── School name validation ────────────────────────────────────────────────────
// Known AD&D 2e school/sphere names; any word in the school field must include
// at least one of these to be considered a real spell header.
const VALID_SCHOOL_WORDS = new Set([
  'abjuration','alteration','conjuration','divination','enchantment',
  'evocation','invocation','illusion','phantasm','necromancy','transmutation',
  'universal','charm','combat','creation','guardian','healing','plant',
  'protection','summoning','sun','weather','air','earth','fire','water',
  'elemental','thought','traveller','travellers',
]);

function isValidSchool(school) {
  if (!school) return false;
  const words = school.toLowerCase().split(/[/,\s]+/).filter(Boolean);
  return words.some(w => VALID_SCHOOL_WORDS.has(w));
}

// ── PDF page text extraction (two-column, letter-spacing collapsed) ───────────

async function extractPageLines(page) {
  const content = await page.getTextContent();
  const items   = content.items.filter(i => i.str !== undefined && i.str !== '');

  if (!items.length) return [];

  const xs  = items.map(i => i.transform[4]);
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;

  // Layout detection: in a true two-column page, text items stay inside
  // their column — almost nothing spans the central gutter. In a
  // single-column page, most body lines cross the page midline.
  const pageMid  = (page.view[0] + page.view[2]) / 2;  // view = [x0, y0, x1, y1]
  const crossing = items.filter(i => {
    const x0 = i.transform[4];
    const x1 = x0 + (i.width ?? 0);
    return x0 < pageMid - 10 && x1 > pageMid + 10;
  }).length;
  const twoColumn = crossing / items.length < 0.05;

  // Group by (column, rounded-y), then join items left→right.
  const groups = {};
  for (const item of items) {
    const x   = item.transform[4];
    const y   = item.transform[5];
    const col = twoColumn && x >= midX ? 'R' : 'L';
    const ry  = Math.round(y / 3) * 3;
    const key = `${col}:${ry}`;
    if (!groups[key]) groups[key] = { col, y: ry, items: [] };
    groups[key].items.push({ x, str: item.str });
  }

  // Sort: left column (L) before right (R); within each column, top→bottom (desc y).
  const sorted = Object.values(groups).sort((a, b) => {
    if (a.col !== b.col) return a.col < b.col ? -1 : 1;
    return b.y - a.y;
  });

  return sorted
    .map(g => {
      const text = g.items.sort((a, b) => a.x - b.x).map(i => i.str).join('');
      return collapseLetterSpacing(text).trim();
    })
    .filter(l => l.length > 0 && !JUNK_LINE_RE.test(l));
}

// ── Field key normalisation ──────────────────────────────────────────────────

function normaliseFieldKey(raw) {
  switch (raw.toLowerCase().replace(/\s+/g, '')) {
    case 'range':           return 'Range';
    case 'components':
    case 'component':       return 'Components';
    case 'duration':        return 'Duration';
    case 'castingtime':     return 'CastingTime';
    case 'areaofeffect':    return 'AreaOfEffect';
    case 'savingthrow':     return 'SavingThrow';
    case 'preparationtime': return 'PreparationTime';
    default:                return raw;
  }
}

// ── Pipe artifact cleanup ─────────────────────────────────────────────────────
// The PDF extraction frequently mis-reads the digit "1" as a pipe "|". Replace
// each pipe with "1", inserting a space only when the next character is a letter
// or digit (so "|rd."→"1 rd.", "| rd."→"1 rd.", "|/level"→"1/level", "|"→"1").
function fixPipes(v) {
  if (v == null) return v;
  return String(v).replace(/\|\s*(\S?)/g,
    (_, next) => (next && /[A-Za-z0-9]/.test(next) ? '1 ' + next : '1' + next));
}

// ── Description builder ──────────────────────────────────────────────────────

function buildDescription(blockLines, fields) {
  let fieldCount = 0;
  let fieldsDone = false;
  const descLines = [];

  for (const line of blockLines.slice(1)) {  // skip header line
    const flds = extractFields(line);
    if (flds) { fieldCount += flds.length; continue; }
    if (PSIONIC_FIELD_RE.test(line)) { fieldCount++; continue; }
    if (SPHERE_LINE_RE.test(line)) { fieldCount++; continue; }
    if (SCHOOL_ONLY_RE.test(line) || /^Reversible$/i.test(line)) continue;
    if (fieldCount >= 2) fieldsDone = true;
    if (fieldsDone && line.length > 0) descLines.push(line);
  }

  return descLines.length > 0 ? descLines.join(' ').trim() : 'See source for description.';
}

// ── Main extraction ──────────────────────────────────────────────────────────

async function extractSpells(pdfPath, startPage = 1, endPage = 9999, sourceName = 'Unknown') {
  const data = await readFile(pdfPath);
  const pdf  = await pdfjsLib.getDocument({
    data: new Uint8Array(data.buffer),
    useWorkerFetch: false, isEvalSupported: false,
    useSystemFonts: true, disableFontFace: true, verbosity: 0,
  }).promise;

  // Accumulate all lines across pages.
  const allLines = [];
  for (let p = startPage; p <= Math.min(endPage, pdf.numPages); p++) {
    const page  = await pdf.getPage(p);
    const lines = await extractPageLines(page);
    for (const line of lines) allLines.push({ text: line, page: p });
  }

  // ── Single-pass block extraction ─────────────────────────────────────────

  let currentLevel  = 1;
  let currentClass  = '';
  let isPsionic     = false;
  let currentDiscipline = '';   // set by a psionic "<Disc> Sciences/Devotions" heading
  let currentTier       = '';   // 'Science' | 'Devotion' (from the same heading)
  let currentName   = null;
  let currentSchool = null;
  let currentPage   = 0;
  let blockLines    = [];
  let fields        = {};
  let inBlock       = false;
  // Snapshots taken when a spell header is found. commitSpell() runs only when
  // the NEXT header appears — by then a section heading may already have
  // advanced currentLevel/isPsionic, which mislabeled the last spell of every
  // section (e.g. PHB Wizard Mark tagged Level 2).
  let blockLevel    = 1;
  let blockClass    = '';
  let blockPsionic  = false;
  let blockDiscipline = '';     // psionic: canonical discipline for this power
  let blockTier       = '';     // psionic: 'High Science' | 'Science' | 'Devotion'

  const spells = [];

  function commitSpell() {
    if (!currentName) return;
    const rawDesc = buildDescription(blockLines, fields);
    // Clean hyphenated line-break artifacts in description (e.g. "some- thing" → "something")
    const cleanDesc = rawDesc.replace(/(\w)-\s+(\w)/g, '$1$2');
    // Replace pipe characters with "1 " (number one + space) as requested
    const finalDesc = cleanDesc.replace(/\|/g, '1 ');

    // True psionic power → psionic-shaped record (discipline/tier + PSP costs).
    if (blockPsionic && blockDiscipline) {
      spells.push({
        name:            currentName,
        class:           'Psionic',
        discipline:      blockDiscipline,
        tier:            blockTier,
        level:           null,
        powerScore:      fields['PowerScore']      ?? '',
        initialCost:     fields['InitialCost']     ?? '',
        maintenanceCost: fields['MaintenanceCost'] ?? '',
        range:           fixPipes(fields['Range']  ?? ''),
        preparationTime: fields['PreparationTime'] ?? '',
        areaOfEffect:    fields['AreaOfEffect']    ?? '',
        prerequisites:   fields['Prerequisites']   ?? '',
        description:     finalDesc,
        page:            currentPage,
        source:          `${sourceName} (Psionic)`,
        verified:        false,
      });
      return;
    }

    spells.push({
      name:        currentName,
      school:      currentSchool ?? '',
      // A spell that carries a Sphere is a Priest spell; otherwise Wizard. Page
      // ranges overlap and section-heading class detection never fires, so Sphere
      // presence is the reliable discriminator.
      class:       fields['Sphere'] ? 'Priest' : 'Wizard',
      sphere:      fields['Sphere']          ?? '',
      level:       blockLevel,
      castingTime: fixPipes(fields['CastingTime'] ?? ''),
      range:       fixPipes(fields['Range']       ?? ''),
      components:  fields['Components']      ?? '',
      duration:    fixPipes(fields['Duration']    ?? ''),
      savingThrow: fields['SavingThrow']     ?? '',
      areaOfEffect:fields['AreaOfEffect']    ?? '',
      preparationTime: fields['PreparationTime'] ?? '',
      description: finalDesc,
      page:        currentPage,
      source:      blockPsionic ? `${sourceName} (Psionic)` : sourceName,
      reversible:  /Reversible/i.test(blockLines[0] || ''),
      verified:    false,
    });
  }

  for (let li = 0; li < allLines.length; li++) {
    const { text, page } = allLines[li];
    // Section level heading
    const secM = text.match(SECTION_LEVEL_RE);
    if (secM) {
      const lvl = ordinalToLevel(secM.groups.Ordinal);
      if (lvl) currentLevel = lvl;
      if (secM.groups.Class) currentClass = secM.groups.Class;
      continue;
    }

    // Psionic section marker
    if (PSIONIC_SECTION_RE.test(text)) { isPsionic = true; continue; }

    // Psionic discipline section heading ("Clairsentient Sciences" / "… Devotions").
    const discM = text.match(PSIONIC_DISC_SECTION_RE);
    if (discM) {
      currentDiscipline = PSIONIC_DISCIPLINE[discM.groups.Disc.toLowerCase()] ?? discM.groups.Disc;
      currentTier       = /devotion/i.test(discM.groups.Tier) ? 'Devotion' : 'Science';
      continue;
    }

    // Psionic power header — only inside a discipline section. The stat-line
    // lookahead (Power Score then Initial Cost) distinguishes a real power from
    // an optional-results "Power Score:" line inside prose.
    if (currentDiscipline && isPsionicNameCandidate(text) &&
        psionicPowerStartsAt(allLines, li)) {
      commitSpell();
      currentName     = text.replace(HIGH_SCIENCE_RE, '').replace(/\s*\(\s*\)\s*$/, '').trim();
      currentSchool   = '';
      currentPage     = page;
      blockLines      = [text];
      fields          = {};
      // Reordered layout: the ability-score value sits on the line above its
      // "Power Score:" label — capture it now before it is lost as prose.
      const afterName = allLines[li + 1]?.text ?? '';
      if (ABILITY_VALUE_RE.test(afterName)) fields['PowerScore'] = collapseLetterSpacing(afterName.trim());
      inBlock         = true;
      blockPsionic    = true;
      blockDiscipline = currentDiscipline;
      blockTier       = HIGH_SCIENCE_RE.test(text) ? 'High Science' : currentTier;
      continue;
    }

    // Spell header — reject if school doesn't look like a real AD&D school.
    const spellM = text.match(SPELL_HEADER_RE);
    if (spellM) {
      const candidateSchool = spellM.groups.School.trim();
      if (!isValidSchool(candidateSchool)) {
        // Not a real spell header (e.g., cross-ref table "(in DK)", table cell "(F)")
        if (inBlock) blockLines.push(text);
        continue;
      }
      commitSpell();
      currentName   = spellM.groups.Name.trim();
      currentSchool = candidateSchool;
      currentPage   = page;
      blockLines    = [text];
      fields        = {};
      inBlock       = true;
      blockLevel    = currentLevel;
      blockClass    = currentClass;
      blockPsionic  = isPsionic;
      continue;
    }

    // Two-line spell header (PHB style): "Spell Name" then "(School)" next line.
    if (NAME_ONLY_RE.test(text) && li + 1 < allLines.length) {
      const schoolM = allLines[li + 1].text.match(SCHOOL_ONLY_RE);
      if (schoolM && isValidSchool(schoolM.groups.School)) {
        commitSpell();
        currentName   = text.trim();
        currentSchool = schoolM.groups.School.trim();
        currentPage   = page;
        blockLines    = [text];
        fields        = {};
        inBlock       = true;
        blockLevel    = currentLevel;
        blockClass    = currentClass;
        blockPsionic  = isPsionic;
        li++;  // consume the "(School)" line
        continue;
      }
    }

    if (!inBlock) continue;

    // Psionic stat lines (Power Score / Initial Cost / Maintenance Cost / …).
    // First value wins so optional-results "Power Score:" lines in the prose are
    // ignored rather than overwriting the real stat.
    if (blockPsionic && blockDiscipline) {
      const pfM = text.match(PSIONIC_FIELD_RE);
      if (pfM) {
        const key = normalisePsionicKey(pfM.groups.Field);
        // First occurrence wins (locked even when empty), so a later optional-
        // results "Power Score:" line in the prose cannot clobber the real stat.
        if (!(key in fields)) fields[key] = collapseLetterSpacing(pfM.groups.Value.trim());
        blockLines.push(text);
        continue;
      }
    }

    // Sphere line (priest spells) — checked before extractFields so the required
    // colon guards against the "sphere" AoE-value word. First match wins.
    const sphM = text.match(SPHERE_LINE_RE);
    if (sphM) {
      if (!fields['Sphere']) fields['Sphere'] = collapseLetterSpacing(sphM.groups.Value.trim());
      blockLines.push(text);
      continue;
    }

    // Field lines — supports several "Field: value" pairs sharing one line;
    // letter-spacing collapse applied to each value.
    const flds = extractFields(text);
    if (flds) {
      for (const [key, val] of flds)
        if (!fields[key]) fields[key] = collapseLetterSpacing(val);
    }

    blockLines.push(text);
  }

  commitSpell();  // Flush last spell
  return spells;
}

// ── Psionic discipline / tier summary ─────────────────────────────────────────
// Groups psionic powers by Discipline and tallies each power tier (High Science,
// Science, Devotion). True psionics use an entry format the parser does not yet
// capture, so this reads whatever discipline/tier fields exist and prints a clear
// notice when they are absent rather than emitting an empty table.
function printPsionicSummary(psionics) {
  const disciplineOf = p => p.discipline ?? p.Discipline ?? '';
  const tierOf       = p => String(p.tier ?? p.powerType ?? p.category ?? '').toLowerCase();

  if (!psionics.some(p => disciplineOf(p))) {
    console.log('\n  Psionics present, but discipline/tier data is not captured yet' +
                ' (add psionic-format parsing to populate this breakdown).');
    return;
  }

  const normTier = t =>
    t.includes('high')     ? 'High Science' :
    t.includes('science')  ? 'Science'      :
    t.includes('devotion') ? 'Devotion'     : 'Other';

  const byDisc = {};
  for (const p of psionics) {
    const disc = disciplineOf(p) || 'Unclassified';
    const tier = normTier(tierOf(p));
    (byDisc[disc] ??= { 'High Science': 0, Science: 0, Devotion: 0, Other: 0 })[tier]++;
  }

  console.log('\n  Psionics by discipline:');
  for (const disc of Object.keys(byDisc).sort()) {
    const t = byDisc[disc];
    const extra = t.Other ? `, Other ${t.Other}` : '';
    console.log(`    ${disc}: High Sciences ${t['High Science']}, Sciences ${t.Science}, Devotions ${t.Devotion}${extra}`);
  }
}

// ── Run against supplied PDFs ────────────────────────────────────────────────

const cliArgs  = process.argv.slice(2);
let cliStart = null, cliEnd = null, cliOut = null;
const pdfPaths = [];
for (const a of cliArgs) {
  if (a.startsWith('--start=')) cliStart = Number(a.slice(8));
  else if (a.startsWith('--end=')) cliEnd = Number(a.slice(6));
  else if (a.startsWith('--out=')) cliOut = a.slice(6);
  else pdfPaths.push(a);
}

// At least one PDF is required — there is no default input file.
if (pdfPaths.length === 0) {
  console.error('Usage: node run-parser.mjs [--start=N] [--end=N] [--out=path.json] file.pdf [more.pdf ...]');
  console.error('');
  console.error('  --start=N   first page to scan (default: 1)');
  console.error('  --end=N     last page to scan  (default: last page)');
  console.error('  --out=path  output JSON path   (default: output/parsed-spells.json)');
  process.exit(1);
}

const allResults = [];

for (const pdfPath of pdfPaths) {
  const fileName = basename(pdfPath);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Processing: ${fileName}`);
  console.log('═'.repeat(60));

  // Page range is honoured only when given explicitly via --start / --end;
  // otherwise the whole document is scanned.
  const startPage  = cliStart ?? 1;
  const endPage    = cliEnd   ?? Infinity;
  const sourceName = fileName.replace(/\.pdf$/i, '');

  let spells;
  try {
    spells = await extractSpells(pdfPath, startPage, endPage, sourceName);
  } catch (e) {
    console.error(`  ERROR: ${e.message}`);
    continue;
  }

  const byType  = { wizard: [], priest: [], psionic: [] };
  const byLevel = {};

  for (const sp of spells) {
    // Psionics are flagged on the source label; everything else splits Wizard vs
    // Priest by the class field (Priest ⇔ has a Sphere).
    if (String(sp.source).includes('Psionic')) byType.psionic.push(sp);
    else if (sp.class === 'Priest')            byType.priest.push(sp);
    else                                       byType.wizard.push(sp);
    // Spell levels only — psionic powers have no spell level.
    if (!String(sp.source).includes('Psionic'))
      byLevel[sp.level] = (byLevel[sp.level] ?? 0) + 1;
  }

  console.log(`\n  Total extracted: ${spells.length}`);
  console.log(`    Wizard Spells: ${byType.wizard.length}`);
  console.log(`    Priest Spells: ${byType.priest.length}`);
  console.log(`    Psionics:      ${byType.psionic.length}`);
  if (Object.keys(byLevel).length) {
    console.log('\n  By level:');
    for (const lvl of Object.keys(byLevel).sort((a, b) => +a - +b))
      console.log(`    Level ${lvl}: ${byLevel[lvl]}`);
  }

  // Psionic power breakdown: High Sciences / Sciences / Devotions per Discipline.
  // Only produced when the psionic entries actually carry discipline/tier data
  // (true psionics use a different entry format the parser does not yet capture).
  if (byType.psionic.length) printPsionicSummary(byType.psionic);

  allResults.push({ file: fileName, spells });
}

// ── Write JSON output ────────────────────────────────────────────────────────

const outPath = cliOut
  ? resolve(cliOut)                                   // --out=path (relative to cwd)
  : join(__dirname, 'output', 'parsed-spells.json');  // default (back-compat)
mkdirSync(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(allResults, null, 2));

console.log(`\n${'═'.repeat(60)}`);
console.log(`Output written → ${outPath}`);
