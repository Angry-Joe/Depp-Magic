/**
 * run-nwp-parser.mjs  –  AD&D 2e Non-Weapon Proficiency extractor
 * ════════════════════════════════════════════════════════════════════════════
 * Companion to run-parser.mjs. Reads the text layer of one or more PDFs and
 * emits a JSON array of non-weapon proficiency (NWP) records.
 *
 * What it detects:
 *   • NWP table headers (e.g. "Proficiency   Slots   Relevant Ability   Modifier")
 *   • Table rows: name, slots, ability, check modifier
 *   • Proficiency group column (Warrior / Priest / Rogue / Wizard / General)
 *     when present
 *   • Description blocks that follow or accompany each proficiency
 *   • Class and race restriction notes in descriptions
 *
 * Output schema per record:
 *   id, name, slots, relevantAbility, checkModifier, group,
 *   description, prerequisites, classRestrictions, raceRestrictions,
 *   page, sourceBooks, verified, originalSource, ruleset
 *
 * Usage:
 *   node run-nwp-parser.mjs [options] file.pdf [more.pdf ...]
 *
 * Options:
 *   --start=N       first page to scan (default: 1)
 *   --end=N         last page to scan  (default: last page)
 *   --out=path      combined output file
 *                   (default: output/<source>-nwp.json per PDF)
 *   --verbose       print each proficiency as it is found
 */

import { readFile, writeFile } from 'fs/promises';
import { mkdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, basename, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_VERSION = '2.0.0';

// ── Load pdfjs-dist ──────────────────────────────────────────────────────────
let pdfjsLib;
try {
  pdfjsLib = await import(pathToFileURL(join(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
} catch {
  pdfjsLib = await import(pathToFileURL(join(__dirname, 'node_modules/pdfjs-dist/build/pdf.mjs')).href);
}

// ── Utility ──────────────────────────────────────────────────────────────────

function slug(name) {
  return String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

function collapseLetterSpacing(text) {
  if (!text) return text;
  const parts = text.split(' ');
  if (parts.length > 2 && parts.every(p => p.length <= 1)) return parts.join('');
  return text;
}

// ── Junk-line filter ─────────────────────────────────────────────────────────
const JUNK_LINE_RE = /file:\/\/\/|^\d{1,2}\/\d{1,2}\/\d{2,4},\s|Full text of "|^\d+\/\d+$/;

// ── NWP table detection ───────────────────────────────────────────────────────
// Table header line (flexible — handles single/double column PHB and PHBR styles)
const NWP_HEADER_RE = /Proficiency\b.{0,40}(?:Slot|Ability|Modifier)/i;

// Full-ability name alternatives
const ABILITY_MAP = {
  strength:      'Strength',
  str:           'Strength',
  dexterity:     'Dexterity',
  dex:           'Dexterity',
  constitution:  'Constitution',
  con:           'Constitution',
  intelligence:  'Intelligence',
  int:           'Intelligence',
  wisdom:        'Wisdom',
  wis:           'Wisdom',
  charisma:      'Charisma',
  cha:           'Charisma',
  special:       'Special',
  'n/a':         'N/A',
  none:          'None',
  '—':           'None',
  '-':           'None',
};

function normaliseAbility(raw) {
  const key = (raw ?? '').trim().toLowerCase().replace(/[^a-z/]/g, '');
  return ABILITY_MAP[key] ?? raw.trim();
}

// Group / category headers in the PHB and Complete Handbooks
const GROUP_SECTION_RE =
  /^(?<Group>Warrior|Rogue|Wizard|Priest|General|Fighter|Ranger|Paladin|Cleric|Druid|Thief|Bard|Mage)\s+(?:Non[-\s]?Weapon\s+)?Proficiencies?/i;

const GROUP_NAME_MAP = {
  warrior: 'Warrior', fighter: 'Warrior', ranger: 'Warrior', paladin: 'Warrior',
  rogue:   'Rogue',   thief:   'Rogue',   bard:   'Rogue',
  wizard:  'Wizard',  mage:    'Wizard',
  priest:  'Priest',  cleric:  'Priest',  druid:  'Priest',
  general: 'General',
};

function normGroup(raw) {
  return GROUP_NAME_MAP[raw.toLowerCase()] ?? raw;
}

// Class/race restriction patterns in description text
const CLASS_RESTRICTION_RE = /(?:available\s+(?:only\s+)?to|restricted\s+to|for\s+(?:use\s+by)?)\s+([A-Z][a-zA-Z\s,/]+?)(?:\s+only)?(?:[.;]|$)/gi;
const RACE_RESTRICTION_RE  = /(?:race(?:s)?[: ]+|only\s+for\s+|available\s+to\s+races?:\s*)([A-Z][a-zA-Z\s,]+?)(?:[.;]|$)/gi;

// ── NWP table row patterns ────────────────────────────────────────────────────
// Ability keywords (for row detection)
const ABILITY_KEYWORDS = ['Strength','Dexterity','Constitution','Intelligence','Wisdom','Charisma',
                          'Str','Dex','Con','Int','Wis','Cha','Special','None'];
const ABILITY_PATTERN  = ABILITY_KEYWORDS.join('|');

// NWP row: "Animal Lore  1  Intelligence  0"
const NWP_ROW_RE = new RegExp(
  `^(?<Name>[A-Z][A-Za-z '\\-,/]+?)\\s{2,}(?<Slots>\\d+)\\s{2,}(?<Ability>${ABILITY_PATTERN})\\s{2,}(?<Mod>[+\\-]?\\d+|Special|\u2014|-+)\\s*$`
);

// Looser row: sometimes modifier is missing, or ability-then-modifier is squished
const NWP_ROW_LOOSE_RE = new RegExp(
  `^(?<Name>[A-Z][A-Za-z '\\-,/]{2,30})\\s+(?<Slots>\\d)\\s+(?<Ability>${ABILITY_PATTERN})\\s+(?<Mod>[+\\-]?\\d+|Special|\u2014|-+)\\s*$`
);

// Description section header: the proficiency name appears as a standalone header
// followed by description text. Matches "Animal Lore" or "Animal Lore (Wisdom, 0)"
const DESC_HEADER_RE = /^(?<Name>[A-Z][A-Za-z '\/\-,]{2,40})(?:\s*\([^)]+\))?\s*$/;

// ── Source book map ───────────────────────────────────────────────────────────
const SOURCE_MAP = {
  'Players_Handbook':           "Player's Handbook",
  'PHB':                        "Player's Handbook",
  'Dungeon_Masters_Guide':      "Dungeon Master's Guide",
  'DMG':                        "Dungeon Master's Guide",
  'Complete_Fighters_Handbook': "Complete Fighter's Handbook",
  'Complete_Rangers_Handbook':  "Complete Ranger's Handbook",
  'Complete_Paladins_Handbook': "Complete Paladin's Handbook",
  'Complete_Wizards_Handbook':  "Complete Wizard's Handbook",
  'Complete_Priests_Handbook':  "Complete Priest's Handbook",
  'Complete_Druids_Handbook':   "Complete Druid's Handbook",
  'Complete_Thiefs_Handbook':   "Complete Thief's Handbook",
  'Complete_Bards_Handbook':    "Complete Bard's Handbook",
  'Complete_Ninjas_Handbook':   "Complete Ninja's Handbook",
  'Complete_Psionics_Handbook': "Complete Psionics Handbook",
};

function humanSource(stem) {
  if (SOURCE_MAP[stem]) return SOURCE_MAP[stem];
  for (const [k, v] of Object.entries(SOURCE_MAP)) {
    if (stem.toLowerCase().replace(/[-_\s]/g,'').startsWith(k.toLowerCase().replace(/[-_\s]/g,'').slice(0,6)))
      return v;
  }
  return stem.replace(/[-_]+/g, ' ').trim();
}

// ── PDF page text extraction (column-aware, mirrors run-parser.mjs) ───────────
async function extractPageLines(page) {
  const content = await page.getTextContent();
  const items   = content.items.filter(i => i.str !== undefined && i.str !== '');
  if (!items.length) return [];

  const xs      = items.map(i => i.transform[4]);
  const midX    = (Math.min(...xs) + Math.max(...xs)) / 2;
  const pageMid = (page.view[0] + page.view[2]) / 2;

  const crossing = items.filter(i => {
    const x0 = i.transform[4], x1 = x0 + (i.width ?? 0);
    return x0 < pageMid - 10 && x1 > pageMid + 10;
  }).length;
  const twoColumn = items.length > 0 && crossing / items.length < 0.05;

  const groups = {};
  for (const item of items) {
    const col = twoColumn && item.transform[4] >= midX ? 'R' : 'L';
    const ry  = Math.round(item.transform[5] / 3) * 3;
    const key = `${col}:${ry}`;
    if (!groups[key]) groups[key] = { col, y: ry, items: [] };
    groups[key].items.push({ x: item.transform[4], str: item.str });
  }

  return Object.values(groups)
    .sort((a, b) => a.col < b.col ? -1 : a.col > b.col ? 1 : b.y - a.y)
    .map(g => collapseLetterSpacing(g.items.sort((a, b) => a.x - b.x).map(i => i.str).join('')).trim())
    .filter(l => l.length > 0 && !JUNK_LINE_RE.test(l));
}

// ── Extract restriction hints from description text ───────────────────────────
function extractRestrictions(desc) {
  const classR = [], raceR = [];
  for (const m of desc.matchAll(CLASS_RESTRICTION_RE)) {
    const val = m[1].trim();
    if (val && !classR.includes(val)) classR.push(val);
  }
  for (const m of desc.matchAll(RACE_RESTRICTION_RE)) {
    const val = m[1].trim();
    if (val && !raceR.includes(val)) raceR.push(val);
  }
  return { classRestrictions: classR, raceRestrictions: raceR };
}

// ── Build output record ───────────────────────────────────────────────────────
function buildRecord({ name, slots, ability, modifier, group, description, page }, sourceName) {
  const book = humanSource(sourceName);
  const { classRestrictions, raceRestrictions } = extractRestrictions(description ?? '');
  return {
    id:               `nwp_${slug(name)}_2e`,
    name,
    slots:            slots ?? 1,
    relevantAbility:  normaliseAbility(ability),
    checkModifier:    modifier ?? 0,
    group:            group ?? 'General',
    description:      description ?? 'See source for description.',
    prerequisites:    [],
    classRestrictions,
    raceRestrictions,
    page:             page ?? null,
    sourceBooks:      [book],
    verified:         false,
    originalSource:   sourceName,
    ruleset:          '2e',
  };
}

// ── Main extraction ───────────────────────────────────────────────────────────
async function extractNWPs(pdfPath, startPage, endPage, sourceName, verbose) {
  const data = await readFile(pdfPath);
  const pdf  = await pdfjsLib.getDocument({
    data: new Uint8Array(data.buffer),
    useWorkerFetch: false, isEvalSupported: false,
    useSystemFonts: true, disableFontFace: true, verbosity: 0,
  }).promise;

  const allLines = [];
  for (let p = startPage; p <= Math.min(endPage, pdf.numPages); p++) {
    const pg    = await pdf.getPage(p);
    const lines = await extractPageLines(pg);
    for (const line of lines) allLines.push({ text: line, page: p });
  }

  // ── Pass 1: collect table rows ────────────────────────────────────────────
  // tableEntries = Map<lowerName → { name, slots, ability, modifier, group, page }>
  const tableEntries = new Map();
  let   inTable      = false;
  let   currentGroup = 'General';

  for (const { text, page } of allLines) {
    // Group section header
    const grpM = text.match(GROUP_SECTION_RE);
    if (grpM) { currentGroup = normGroup(grpM.groups.Group); inTable = false; continue; }

    // Table header line
    if (NWP_HEADER_RE.test(text)) { inTable = true; continue; }

    // Blank-ish lines reset table mode
    if (inTable && text.length < 3) { inTable = false; continue; }

    if (!inTable) continue;

    // Try to match a table row (strict first, then loose)
    const rowM = text.match(NWP_ROW_RE) ?? text.match(NWP_ROW_LOOSE_RE);
    if (!rowM) {
      if (!/^[A-Z]/.test(text) || text.length < 5) inTable = false;
      continue;
    }

    const name  = rowM.groups.Name.trim();
    const slots = parseInt(rowM.groups.Slots, 10);
    const raw   = rowM.groups.Mod.trim();
    const mod   = /^[+\-]?\d+$/.test(raw) ? parseInt(raw, 10) : 0;
    const key   = name.toLowerCase();

    if (!tableEntries.has(key)) {
      tableEntries.set(key, { name, slots, ability: rowM.groups.Ability.trim(), modifier: mod, group: currentGroup, page, description: '' });
      if (verbose) console.log(`    [table] ${name} (${slots} slot, ${rowM.groups.Ability}, ${raw})`);
    }
  }

  // ── Pass 2: collect description blocks ───────────────────────────────────
  let descTarget = null;
  let descLines  = [];

  function flushDesc() {
    if (!descTarget || !descLines.length) return;
    const full = descLines.join(' ').replace(/(\w)-\s+(\w)/g, '$1$2').trim();
    const key  = descTarget.toLowerCase();
    if (tableEntries.has(key)) tableEntries.get(key).description = full;
    descTarget = null; descLines = [];
  }

  for (const { text } of allLines) {
    const hdrM = text.match(DESC_HEADER_RE);
    if (hdrM && tableEntries.has(hdrM.groups.Name.toLowerCase())) {
      flushDesc();
      descTarget = hdrM.groups.Name;
      continue;
    }
    if (descTarget) {
      if (hdrM && tableEntries.has(hdrM.groups.Name.toLowerCase()) &&
          hdrM.groups.Name.toLowerCase() !== descTarget.toLowerCase()) {
        flushDesc();
        descTarget = hdrM.groups.Name;
        continue;
      }
      if (NWP_ROW_RE.test(text) || NWP_ROW_LOOSE_RE.test(text) || NWP_HEADER_RE.test(text)) {
        flushDesc(); continue;
      }
      if (text.length > 0) descLines.push(text);
    }
  }
  flushDesc();

  return [...tableEntries.values()].map(e => buildRecord(e, sourceName));
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
let cliStart   = 1, cliEnd = Infinity, cliOut = null, cliVerbose = false;
const pdfPaths = [];

for (const a of args) {
  if      (a.startsWith('--start=')) cliStart   = Number(a.slice(8));
  else if (a.startsWith('--end='))   cliEnd     = Number(a.slice(6));
  else if (a.startsWith('--out='))   cliOut     = a.slice(6);
  else if (a === '--verbose')        cliVerbose = true;
  else if (!a.startsWith('--'))      pdfPaths.push(a);
}

if (!pdfPaths.length) {
  console.error('Usage: node run-nwp-parser.mjs [--start=N] [--end=N] [--out=path.json] [--verbose] file.pdf [...]');
  console.error('');
  console.error('Target the relevant chapter pages with --start/--end for best results.');
  console.error('Example (PHB NWP chapter, PDF pages 52-62):');
  console.error('  node run-nwp-parser.mjs --start=52 --end=62 Players_Handbook.pdf');
  process.exit(1);
}

const combined = [];

for (const pdfPath of pdfPaths) {
  const stem = basename(pdfPath).replace(/\.pdf$/i, '');
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`Processing: ${basename(pdfPath)}`);
  console.log('═'.repeat(64));

  let nwps;
  try {
    nwps = await extractNWPs(pdfPath, cliStart, cliEnd, stem, cliVerbose);
  } catch (e) {
    console.error(`  ERROR: ${e.message}`);
    continue;
  }

  const byGroup  = {};
  const withDesc = nwps.filter(n => n.description && n.description !== 'See source for description.').length;
  for (const n of nwps) byGroup[n.group] = (byGroup[n.group] ?? 0) + 1;

  console.log(`\n  Total: ${nwps.length} proficiencies`);
  console.log(`  With descriptions: ${withDesc} / ${nwps.length}`);
  if (Object.keys(byGroup).length) {
    console.log('  By group:');
    for (const [g, n] of Object.entries(byGroup).sort()) console.log(`    ${g}: ${n}`);
  }

  if (cliOut) {
    combined.push(...nwps);
  } else {
    const outPath = join(__dirname, 'output', `${stem}-nwp.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      generator:     'run-nwp-parser.mjs',
      generatedAt:   new Date().toISOString(),
      source:        humanSource(stem),
      sourceFile:    basename(pdfPath),
      recordCount:   nwps.length,
      proficiencies: nwps,
    };
    await writeFile(outPath, JSON.stringify(envelope, null, 2));
    console.log(`\n  ✓ Wrote ${nwps.length} records → ${outPath}`);
  }
}

if (cliOut && combined.length > 0) {
  const outPath = resolve(cliOut);
  mkdirSync(dirname(outPath), { recursive: true });
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    generator:     'run-nwp-parser.mjs',
    generatedAt:   new Date().toISOString(),
    source:        pdfPaths.map(p => humanSource(basename(p).replace(/\.pdf$/i, ''))).join(' + '),
    sourceFile:    pdfPaths.map(basename).join(', '),
    recordCount:   combined.length,
    proficiencies: combined,
  };
  await writeFile(outPath, JSON.stringify(envelope, null, 2));
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`✓ Combined output → ${outPath}  (${combined.length} proficiencies)`);
}
