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
 *   • Class detection by evidence: a "Sphere:" field marks a Cleric spell
 *   • Psionics: true psionic powers only (discipline / tier / PSP costs,
 *     as in "The Will and the Way").  Dark Sun "Psionic Enchantments" are
 *     10th-level *spells* and are NOT treated as psionic powers.
 *   • Source label derived from the input filename
 *
 * Usage:  node run-parser.mjs [--start=N] [--end=N] [--out=path.json] file.pdf [more.pdf ...]
 *         --start/--end limit the page range (default: whole document)
 *         --out=path    write all results to this single file (overrides per-source default)
 *         Default out:  output/<source-title>-parsed.json  (one file per PDF)
 *
 * Output is always a flat array of Savage Sun Rising (SSR) schema records.
 */

import { readFile, writeFile } from 'fs/promises';
import { mkdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, basename, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load pdfjs-dist ──────────────────────────────────────────────────────────

let pdfjsLib;
try {
  pdfjsLib = await import(pathToFileURL(join(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
} catch {
  pdfjsLib = await import(pathToFileURL(join(__dirname, 'node_modules/pdfjs-dist/build/pdf.mjs')).href);
}

// ── Regexes ──────────────────────────────────────────────────────────────────

const SPELL_HEADER_RE = /^(?<Name>[A-Z][A-Za-z0-9 ,'\-\.\/&]+?)\s*\((?<School>[A-Za-z/\s,]+?)\)\s*(?:Reversible\s*)?$/;
const NAME_ONLY_RE = /^[A-Z][A-Za-z0-9 ,'\-\/&]{1,60}$/;
const SCHOOL_ONLY_RE = /^\((?<School>[A-Za-z/\s,]+?)\)\s*(?:Reversible\s*)?$/;
const JUNK_LINE_RE = /file:\/\/\/|^\d{1,2}\/\d{1,2}\/\d{2,4},\s|Full text of "|^\d+\/\d+$/;
const SECTION_LEVEL_RE = /^(?<Ordinal>First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth|Thirteenth|\d{1,2}(?:st|nd|rd|th))[\s-]*Level\s+(?:(?<Class>Priest|Wizard|Mage|Cleric|Druid|Defiler|Preserver)\s+)?(?:Spells?|Psionic)/i;
const PSIONIC_SECTION_RE = /^Psionic\s+Enchantments?/i;
const SPHERE_LINE_RE = /^Sphere\s*:\s*(?<Value>.+)$/i;

const PSIONIC_DISC_SECTION_RE =
  /^(?<Disc>Clairsentient|Psychokinetic|Psychometabolic|Psychoportive|Telepathic|Metapsionic)\s+(?<Tier>Sciences?|Devotions?)\s*$/i;
const POWER_SCORE_RE  = /^Power\s*Score\s*:/i;
const INITIAL_COST_RE = /^Initial\s*Cost\s*:/i;
const PSIONIC_FIELD_RE =
  /^(?<Field>Power\s*Score|Initial\s*Cost|Maintenance\s*Cost|Range|Preparation\s*Time|Area\s*of\s*Effect|Prerequisites?)\s*:\s*(?<Value>.*)$/i;
const HIGH_SCIENCE_RE = /\(\s*High\s+Sciences?\s*\)/i;

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

const ABILITY_VALUE_RE = /^(?:Str|Dex|Con|Int|Wis|Cha)\s*[-+]?\s*\d/i;

function isPsionicNameCandidate(line) {
  return /^[A-Z]/.test(line) && line.length <= 60 &&
    !ABILITY_VALUE_RE.test(line) &&
    !/\b(?:Sciences?|Devotions?)\s*$/i.test(line) &&
    !PSIONIC_FIELD_RE.test(line) && !PSIONIC_DISC_SECTION_RE.test(line) &&
    !JUNK_LINE_RE.test(line);
}

function psionicPowerStartsAt(lines, li) {
  const l1 = lines[li + 1]?.text ?? '';
  const l2 = lines[li + 2]?.text ?? '';
  const l3 = lines[li + 3]?.text ?? '';
  const psAt1 = POWER_SCORE_RE.test(l1);
  const psAt2 = POWER_SCORE_RE.test(l2);
  return (psAt1 && (INITIAL_COST_RE.test(l2) || INITIAL_COST_RE.test(l3))) ||
         (psAt2 && INITIAL_COST_RE.test(l3));
}

const FIELD_MARKER_RE = /(Range|Components?|Duration|Casting\s*Time|Area\s*of\s*Effect|Saving\s*Throw|Preparation\s*Time)\s*:?/gi;

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

function ordinalToLevel(ord) {
  const key = ord.toLowerCase();
  if (key in ORDINAL_TO_LEVEL) return ORDINAL_TO_LEVEL[key];
  const m = key.match(/^(\d{1,2})(?:st|nd|rd|th)$/);
  return m ? Number(m[1]) : null;
}

function collapseLetterSpacing(text) {
  if (!text) return text;
  const parts = text.split(' ');
  if (parts.length > 2 && parts.every(p => p.length <= 1))
    return parts.join('');
  return text;
}

const VALID_SCHOOL_WORDS = new Set([
  'abjuration','alteration','conjuration','divination','enchantment',
  'evocation','invocation','illusion','phantasm','necromancy','transmutation',
  'universal','charm','combat','creation','guardian','healing','plant',
  'protection','summoning','sun','weather','air','earth','fire','water',
  'elemental','thought','traveller','travellers','magma','rain','silt','cosmos',
]);

function isValidSchool(school) {
  if (!school) return false;
  const words = school.toLowerCase().split(/[/,\s]+/).filter(Boolean);
  return words.some(w => VALID_SCHOOL_WORDS.has(w));
}

// ── Source book name map (filename stem → human-readable) ────────────────────

const SOURCE_MAP = {
  'EAFW-Spells': 'Earth, Air, Fire and Water',
  'DragonKings-AllSpells': 'Dragon Kings',
  'DSCS-Spells': 'Dark Sun Campaign Setting',
  'DSCS-Rev-Spells': 'Dark Sun Campaign Setting (Revised)',
  'DSRB-Spells': 'Dark Sun Rules Book',
  'Tome_of_Magic__TSR2121_-Reduced': 'Tome of Magic',
  'Tome_of_Magic': 'Tome of Magic',
  'Players_Handbook': "Player's Handbook",
  'PHBR4': 'PHBR4 - The Complete Wizard\'s Handbook',
  'PHBR5': 'PHBR5 - The Complete Psionics Handbook',
  'Defilers_and_Preservers': 'Defilers and Preservers',
  'Veiled_Alliance': 'Veiled Alliance',
  'Wizards_Spell_Compendium': "Wizard's Spell Compendium",
};

function humanSource(sourceName) {
  if (SOURCE_MAP[sourceName]) return SOURCE_MAP[sourceName];
  // fuzzy: strip common suffixes
  for (const [k, v] of Object.entries(SOURCE_MAP)) {
    if (sourceName.toLowerCase().includes(k.toLowerCase().slice(0, 8))) return v;
  }
  return sourceName.replace(/_/g, ' ').replace(/-Reduced$/i, '').trim();
}

const DARK_SUN_SOURCES = [
  'eafw', 'dragonkings', 'dscs', 'dsrb', 'defilers', 'veiled', 'dark sun',
];

function isDarkSunSource(sourceName) {
  const s = sourceName.toLowerCase();
  return DARK_SUN_SOURCES.some(k => s.includes(k));
}

// ── SSR helpers ──────────────────────────────────────────────────────────────

function slug(name) {
  return String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

function parseComponents(raw) {
  if (!raw) return [];
  return String(raw).split(/[,/]/).map(s => s.trim()).filter(Boolean);
}

function buildSpheres(sphereRaw) {
  if (!sphereRaw) return [];
  const raw = String(sphereRaw).trim();
  // Bare "ALL" or "Elemental (All)" → keep as a single Elemental (All) entry
  if (/^all$/i.test(raw) || /^elemental\s*\(\s*all\s*\)$/i.test(raw)) {
    return [{ name: 'Elemental (All)', access: 'Major' }];
  }

  // Split on commas/semicolons that are not inside parentheses
  const parts = [];
  let buf = '', depth = 0;
  for (const ch of raw) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';') && depth === 0) {
      if (buf.trim()) parts.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf.trim());

  const results = [];
  for (const part of parts) {
    // Elemental (Earth) / Elemental (Air|Fire|Water) → capture paren contents
    const m = part.match(/^elemental\s*\((.+)\)\s*$/i);
    if (m) {
      const inner = m[1].trim();
      if (/^all$/i.test(inner)) {
        results.push({ name: 'Elemental (All)', access: 'Major' });
      } else {
        for (const sub of inner.split(/[|,]/).map(s => s.trim()).filter(Boolean)) {
          results.push({ name: sub, access: 'Major' });
        }
      }
    } else {
      results.push({ name: part.replace(/\s+/g, ' ').trim(), access: 'Major' });
    }
  }
  return results;
}

function toSsrSpell(legacy, sourceName) {
  // Already SSR-shaped if it has id + spheres array
  if (legacy.id && Array.isArray(legacy.spheres)) return legacy;

  const book = humanSource(sourceName || legacy.source || 'Unknown');
  const isPsi = legacy.class === 'Psionic' || String(legacy.source || '').includes('Psionic');

  if (isPsi) {
    return {
      id: `psionic_${slug(legacy.name)}_2e`,
      name: legacy.name,
      class: 'Psionic',
      discipline: legacy.discipline || null,
      tier: legacy.tier || null,
      level: null,
      powerScore: legacy.powerScore || '',
      initialCost: legacy.initialCost || '',
      maintenanceCost: legacy.maintenanceCost || '',
      range: legacy.range || '',
      preparationTime: legacy.preparationTime || '',
      areaOfEffect: legacy.areaOfEffect || '',
      prerequisites: legacy.prerequisites || '',
      description: legacy.description || '',
      page: legacy.page ?? null,
      sourceBooks: [book + (String(legacy.source || '').includes('Psionic') ? ' (Psionic)' : '')],
      verified: false,
      originalSource: legacy.source || sourceName,
    };
  }

  const cls = (legacy.class === 'Priest' || legacy.class === 'Cleric') ? 'Cleric' : 'Wizard';
  const sphereRaw = legacy.sphere || '';
  const spheres = Array.isArray(legacy.spheres) ? legacy.spheres : buildSpheres(sphereRaw);
  const comps = Array.isArray(legacy.components)
    ? legacy.components
    : parseComponents(legacy.components || '');
  const desc = legacy.description || '';
  const athStatus = isDarkSunSource(sourceName || legacy.source || '')
    ? 'New (Dark Sun)'
    : 'Core';

  const tags = [];
  if (athStatus.startsWith('New')) tags.push('#new-dark-sun');
  for (const sp of spheres) {
    if (sp.name) tags.push('#' + sp.name.toLowerCase());
  }

  return {
    id: `spell_${slug(legacy.name)}_2e`,
    name: legacy.name,
    srdIndex: null,
    level: legacy.level ?? 0,
    school: legacy.school || null,
    class: cls,
    spheres,
    castingTime: legacy.castingTime || '',
    range: legacy.range || '',
    components: comps,
    duration: legacy.duration || '',
    concentration: false,
    ritual: false,
    description: desc,
    higherLevel: null,
    athasianVariant: {
      modifiedEffect: null,
      materialComponentAthas: null,
      defilerCost: 0,
      planeSource: null,
    },
    flavorLore: '',
    artworkPrompt: '',
    tags,
    relatedEntries: [],
    sourceBooks: [book],
    verified: false,
    reversible: !!legacy.reversible,
    areaOfEffect: legacy.areaOfEffect || '',
    savingThrow: legacy.savingThrow || '',
    athasianStatus: athStatus,
    summary: desc.length > 160 ? desc.slice(0, 157) + '…' : desc,
    page: legacy.page ?? null,
    preparationTime: legacy.preparationTime || '',
    originalSource: legacy.source || sourceName,
  };
}

// ── PDF page text extraction ─────────────────────────────────────────────────

async function extractPageLines(page) {
  const content = await page.getTextContent();
  const items   = content.items.filter(i => i.str !== undefined && i.str !== '');

  if (!items.length) return [];

  const xs  = items.map(i => i.transform[4]);
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;

  const pageMid  = (page.view[0] + page.view[2]) / 2;
  const crossing = items.filter(i => {
    const x0 = i.transform[4];
    const x1 = x0 + (i.width ?? 0);
    return x0 < pageMid - 10 && x1 > pageMid + 10;
  }).length;
  const twoColumn = crossing / items.length < 0.05;

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

function fixPipes(v) {
  if (v == null) return v;
  return String(v).replace(/\|\s*(\S?)/g,
    (_, next) => (next && /[A-Za-z0-9]/.test(next) ? '1 ' + next : '1' + next));
}

function buildDescription(blockLines, fields) {
  let fieldCount = 0;
  let fieldsDone = false;
  const descLines = [];

  for (const line of blockLines.slice(1)) {
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

  const allLines = [];
  for (let p = startPage; p <= Math.min(endPage, pdf.numPages); p++) {
    const page  = await pdf.getPage(p);
    const lines = await extractPageLines(page);
    for (const line of lines) allLines.push({ text: line, page: p });
  }

  let currentLevel  = 1;
  let currentClass  = '';
  let isPsionic     = false;
  let currentDiscipline = '';
  let currentTier       = '';
  let currentName   = null;
  let currentSchool = null;
  let currentPage   = 0;
  let blockLines    = [];
  let fields        = {};
  let inBlock       = false;
  let blockLevel    = 1;
  let blockClass    = '';
  let blockPsionic  = false;
  let blockDiscipline = '';
  let blockTier       = '';

  const spells = [];

  function commitSpell() {
    if (!currentName) return;
    const rawDesc = buildDescription(blockLines, fields);
    const cleanDesc = rawDesc.replace(/(\w)-\s+(\w)/g, '$1$2');
    const finalDesc = cleanDesc.replace(/\|/g, '1 ');

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

    // Intermediate shape — converted to SSR schema on write
    spells.push({
      name:        currentName,
      school:      currentSchool ?? '',
      class:       fields['Sphere'] ? 'Cleric' : 'Wizard',  // aligned naming
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
    const secM = text.match(SECTION_LEVEL_RE);
    if (secM) {
      const lvl = ordinalToLevel(secM.groups.Ordinal);
      if (lvl) currentLevel = lvl;
      if (secM.groups.Class) currentClass = secM.groups.Class;
      // Leaving a normal level section clears true-psionic mode
      isPsionic = false;
      currentDiscipline = '';
      currentTier = '';
      continue;
    }

    // Dark Sun "Psionic Enchantments" = 10th-level SPELLS, not true psionics.
    // Set level and keep processing as Wizard/Cleric spell blocks.
    if (PSIONIC_SECTION_RE.test(text)) {
      currentLevel = 10;
      isPsionic = false;
      currentDiscipline = '';
      currentTier = '';
      continue;
    }

    const discM = text.match(PSIONIC_DISC_SECTION_RE);
    if (discM) {
      // True psionic power sections (Clairsentient Sciences, etc.)
      currentDiscipline = PSIONIC_DISCIPLINE[discM.groups.Disc.toLowerCase()] ?? discM.groups.Disc;
      currentTier       = /devotion/i.test(discM.groups.Tier) ? 'Devotion' : 'Science';
      isPsionic = true;
      continue;
    }

    if (currentDiscipline && isPsionicNameCandidate(text) &&
        psionicPowerStartsAt(allLines, li)) {
      commitSpell();
      currentName     = text.replace(HIGH_SCIENCE_RE, '').replace(/\s*\(\s*\)\s*$/, '').trim();
      currentSchool   = '';
      currentPage     = page;
      blockLines      = [text];
      fields          = {};
      const afterName = allLines[li + 1]?.text ?? '';
      if (ABILITY_VALUE_RE.test(afterName)) fields['PowerScore'] = collapseLetterSpacing(afterName.trim());
      inBlock         = true;
      blockPsionic    = true;
      blockDiscipline = currentDiscipline;
      blockTier       = HIGH_SCIENCE_RE.test(text) ? 'High Science' : currentTier;
      continue;
    }

    const spellM = text.match(SPELL_HEADER_RE);
    if (spellM) {
      const candidateSchool = spellM.groups.School.trim();
      if (!isValidSchool(candidateSchool)) {
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
        li++;
        continue;
      }
    }

    if (!inBlock) continue;

    if (blockPsionic && blockDiscipline) {
      const pfM = text.match(PSIONIC_FIELD_RE);
      if (pfM) {
        const key = normalisePsionicKey(pfM.groups.Field);
        if (!(key in fields)) fields[key] = collapseLetterSpacing(pfM.groups.Value.trim());
        blockLines.push(text);
        continue;
      }
    }

    const sphM = text.match(SPHERE_LINE_RE);
    if (sphM) {
      if (!fields['Sphere']) fields['Sphere'] = collapseLetterSpacing(sphM.groups.Value.trim());
      blockLines.push(text);
      continue;
    }

    const flds = extractFields(text);
    if (flds) {
      for (const [key, val] of flds)
        if (!fields[key]) fields[key] = collapseLetterSpacing(val);
    }

    blockLines.push(text);
  }

  commitSpell();
  return spells;
}

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

// ── CLI ──────────────────────────────────────────────────────────────────────

const cliArgs  = process.argv.slice(2);
let cliStart = null, cliEnd = null, cliOut = null;
const pdfPaths = [];
for (const a of cliArgs) {
  if (a.startsWith('--start=')) cliStart = Number(a.slice(8));
  else if (a.startsWith('--end=')) cliEnd = Number(a.slice(6));
  else if (a.startsWith('--out=')) cliOut = a.slice(6);
  else if (!a.startsWith('--')) pdfPaths.push(a);
}

if (pdfPaths.length === 0) {
  console.error('Usage: node run-parser.mjs [--start=N] [--end=N] [--out=path.json] file.pdf [more.pdf ...]');
  console.error('');
  console.error('  --start=N   first page to scan (default: 1)');
  console.error('  --end=N     last page to scan  (default: last page)');
  console.error('  --out=path  single output file (default: output/<source-title>-parsed.json per PDF)');
  process.exit(1);
}

const combinedSsr = [];  // only used when --out is set

for (const pdfPath of pdfPaths) {
  const fileName = basename(pdfPath);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Processing: ${fileName}`);
  console.log('═'.repeat(60));

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

  const byType  = { wizard: [], cleric: [], psionic: [] };
  const byLevel = {};

  for (const sp of spells) {
    if (sp.class === 'Psionic' || String(sp.source).includes('Psionic')) byType.psionic.push(sp);
    else if (sp.class === 'Cleric' || sp.class === 'Priest') byType.cleric.push(sp);
    else byType.wizard.push(sp);
    if (sp.class !== 'Psionic' && !String(sp.source).includes('Psionic'))
      byLevel[sp.level] = (byLevel[sp.level] ?? 0) + 1;
  }

  console.log(`\n  Total extracted: ${spells.length}`);
  console.log(`    Wizard Spells: ${byType.wizard.length}`);
  console.log(`    Cleric Spells: ${byType.cleric.length}`);
  console.log(`    Psionics:      ${byType.psionic.length}`);
  if (Object.keys(byLevel).length) {
    console.log('\n  By level:');
    for (const lvl of Object.keys(byLevel).sort((a, b) => +a - +b))
      console.log(`    Level ${lvl}: ${byLevel[lvl]}`);
  }

  if (byType.psionic.length) printPsionicSummary(byType.psionic);

  // Always convert to SSR schema
  const ssrSpells = spells.map(sp => toSsrSpell(sp, sourceName));

  if (cliOut) {
    // --out: accumulate into one combined file written after the loop
    combinedSsr.push(...ssrSpells);
  } else {
    // Default: one file per source → output/<source-title>-parsed.json
    const safeTitle = sourceName.replace(/[^A-Za-z0-9._-]+/g, '_');
    const outPath = join(__dirname, 'output', `${safeTitle}-parsed.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(ssrSpells, null, 2));
    console.log(`\n  Wrote ${ssrSpells.length} SSR records → ${outPath}`);
  }
}

if (cliOut) {
  const outPath = resolve(cliOut);
  mkdirSync(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(combinedSsr, null, 2));
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Output written → ${outPath}  (${combinedSsr.length} SSR records)`);
} else {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('Done. SSR schema files are in the output/ folder.');
}
