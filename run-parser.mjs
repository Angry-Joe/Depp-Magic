/**
 * run-parser.mjs  –  Node.js reimplementation of the fixed DKSpellExtractor
 * ═══════════════════════════════════════════════════════════════════════════
 * Mirrors the logic in the fixed C# DKSpellExtractor.cs:
 *   • Two-column layout (left column first, then right)
 *   • Section-level heading → current level number
 *   • Spell header: "SpellName (School)" Title Case
 *   • Letter-spacing collapse: "C o m p o n e n t s :" → "Components:"
 *   • Field parsing: Range, Components, Duration, Casting Time, etc.
 *   • Psionic Enchantments section flagging
 *
 * Generalised beyond Dragon Kings (bunsen-updates):
 *   • Two-line spell headers: "Spell Name" / "(School)" on the next line (PHB style)
 *   • Multiple stat fields on one line: "Range: 10 yds. Components: V, S, M"
 *   • Junk-line filter: browser print-to-PDF artifacts (timestamps, file:/// URLs)
 *   • Column-layout auto-detection (single vs. two-column pages)
 *   • Page range via --start=N / --end=N (defaults: full document; DK default file
 *     keeps its 83–162 spell-section range)
 *   • Source label derived from the input filename
 *
 * Usage:  node run-parser.mjs [--start=N] [--end=N] [--out=path.json] [path/to/*.pdf ...]
 *         (defaults to 04-DragonKings.pdf in the same directory)
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

const SPELL_HEADER_RE = /^(?<Name>[A-Z][A-Za-z ,'\-\.]+?)\s*\((?<School>[A-Za-z/\s,]+?)\)\s*(?:Reversible\s*)?$/;
// Two-line header support (PHB style): name alone, then "(School)" on the next line.
const NAME_ONLY_RE = /^[A-Z][A-Za-z ,'\-]{1,60}$/;
const SCHOOL_ONLY_RE = /^\((?<School>[A-Za-z/\s,]+?)\)\s*(?:Reversible\s*)?$/;
// Browser print-to-PDF artifacts: "7/4/26, 10:26 AM Full text of ...", file:/// URLs, "166/3963" page counters.
const JUNK_LINE_RE = /file:\/\/\/|^\d{1,2}\/\d{1,2}\/\d{2,4},\s|Full text of "|^\d+\/\d+$/;
const SECTION_LEVEL_RE = /^(?<Ordinal>First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth|Thirteenth|\d{1,2}(?:st|nd|rd|th))-Level\s+(?:Spells?|Psionic)/i;
const PSIONIC_SECTION_RE = /^Psionic\s+Enchantments?/i;
const FIELD_LINE_RE = /^(?<Field>Range|Components?|Duration|CastingTime|Casting\s+Time|AreaofEffect|Area\s+of\s+Effect|SavingThrow|Saving\s+Throw|PreparationTime|Preparation\s+Time)\s*:\s*(?<Value>.+)$/i;
// Global marker for splitting multiple fields that share one physical line,
// e.g. "Range: 5 yds./level Components: V, S, M".
const FIELD_MARKER_RE = /(Range|Components?|Duration|Casting\s*Time|Area\s*of\s*Effect|Saving\s*Throw|Preparation\s*Time)\s*:/gi;

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

// ── Description builder ──────────────────────────────────────────────────────

function buildDescription(blockLines, fields) {
  let fieldCount = 0;
  let fieldsDone = false;
  const descLines = [];

  for (const line of blockLines.slice(1)) {  // skip header line
    const flds = extractFields(line);
    if (flds) { fieldCount += flds.length; continue; }
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
  let isPsionic     = false;
  let currentName   = null;
  let currentSchool = null;
  let currentPage   = 0;
  let blockLines    = [];
  let fields        = {};
  let inBlock       = false;

  const spells = [];

  function commitSpell() {
    if (!currentName) return;
    spells.push({
      name:        currentName,
      school:      currentSchool ?? '',
      level:       currentLevel,
      castingTime: fields['CastingTime']     ?? '',
      range:       fields['Range']           ?? '',
      components:  fields['Components']      ?? '',
      duration:    fields['Duration']        ?? '',
      savingThrow: fields['SavingThrow']     ?? '',
      areaOfEffect:fields['AreaOfEffect']    ?? '',
      preparationTime: fields['PreparationTime'] ?? '',
      description: buildDescription(blockLines, fields),
      page:        currentPage,
      source:      isPsionic ? `${sourceName} (Psionic)` : sourceName,
    });
  }

  for (let li = 0; li < allLines.length; li++) {
    const { text, page } = allLines[li];
    // Section level heading
    const secM = text.match(SECTION_LEVEL_RE);
    if (secM) {
      const lvl = ordinalToLevel(secM.groups.Ordinal);
      if (lvl) currentLevel = lvl;
      continue;
    }

    // Psionic section marker
    if (PSIONIC_SECTION_RE.test(text)) { isPsionic = true; continue; }

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
        li++;  // consume the "(School)" line
        continue;
      }
    }

    if (!inBlock) continue;

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

// No PDFs supplied → default Dragon Kings file, whose spell section spans
// PDF pages 83–162. User-supplied PDFs default to the full document.
const usingDefaultPdf = pdfPaths.length === 0;
if (usingDefaultPdf) pdfPaths.push(join(__dirname, '04-DragonKings.pdf'));

const allResults = [];

for (const pdfPath of pdfPaths) {
  const fileName = basename(pdfPath);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Processing: ${fileName}`);
  console.log('═'.repeat(60));

  const startPage  = cliStart ?? (usingDefaultPdf ? 83 : 1);
  const endPage    = cliEnd   ?? (usingDefaultPdf ? 162 : 9999);
  const sourceName = fileName.replace(/\.pdf$/i, '');

  let spells;
  try {
    spells = await extractSpells(pdfPath, startPage, endPage, sourceName);
  } catch (e) {
    console.error(`  ERROR: ${e.message}`);
    continue;
  }

  const byType  = { spell: [], psionic: [] };
  const byLevel = {};

  for (const sp of spells) {
    const type = sp.source.includes('Psionic') ? 'psionic' : 'spell';
    byType[type].push(sp);
    byLevel[sp.level] = (byLevel[sp.level] ?? 0) + 1;
  }

  console.log(`\n  Total extracted: ${spells.length}`);
  console.log(`    Spells:   ${byType.spell.length}`);
  console.log(`    Psionics: ${byType.psionic.length}`);
  console.log('\n  By level:');
  for (const lvl of Object.keys(byLevel).sort((a, b) => +a - +b))
    console.log(`    Level ${lvl}: ${byLevel[lvl]}`);

  console.log('\n  Extracted entries:');
  for (const sp of spells) {
    const tag    = sp.source.includes('Psionic') ? '[PSI]' : '[SPL]';
    const fields = [sp.range, sp.duration, sp.components].filter(Boolean).join(' | ');
    console.log(`    ${tag} Lvl${sp.level.toString().padStart(2)} p.${String(sp.page).padStart(3)}  ${sp.name} (${sp.school})${fields ? '  ←  ' + fields : ''}`);
  }

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
