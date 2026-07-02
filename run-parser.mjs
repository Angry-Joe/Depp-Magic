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
 * Usage:  node run-parser.mjs [path/to/*.pdf ...]
 *         (defaults to 04-DragonKings.pdf in the same directory)
 */

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load pdfjs-dist ──────────────────────────────────────────────────────────

let pdfjsLib;
try {
  pdfjsLib = await import(join(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'));
} catch {
  pdfjsLib = await import(join(__dirname, 'node_modules/pdfjs-dist/build/pdf.mjs'));
}

// ── Regexes (mirrors C# DKSpellExtractor) ───────────────────────────────────

const SPELL_HEADER_RE = /^(?<Name>[A-Z][A-Za-z ,'\-\.]+?)\s*\((?<School>[A-Za-z/\s,]+?)\)\s*(?:Reversible\s*)?$/;
const SECTION_LEVEL_RE = /^(?<Ordinal>First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth|Thirteenth)-Level\s+(?:Spells?|Psionic)/i;
const PSIONIC_SECTION_RE = /^Psionic\s+Enchantments?/i;
const FIELD_LINE_RE = /^(?<Field>Range|Components?|Duration|CastingTime|Casting\s+Time|AreaofEffect|Area\s+of\s+Effect|SavingThrow|Saving\s+Throw|PreparationTime|Preparation\s+Time)\s*:\s*(?<Value>.+)$/i;

const ORDINAL_TO_LEVEL = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11,
  twelfth: 12, thirteenth: 13,
};

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

  // Group by (column, rounded-y), then join items left→right.
  const groups = {};
  for (const item of items) {
    const x   = item.transform[4];
    const y   = item.transform[5];
    const col = x < midX ? 'L' : 'R';
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
    .filter(l => l.length > 0);
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
    if (FIELD_LINE_RE.test(line)) { fieldCount++; continue; }
    if (fieldCount >= 2) fieldsDone = true;
    if (fieldsDone && line.length > 0) descLines.push(line);
  }

  return descLines.length > 0 ? descLines.join(' ').trim() : 'See source for description.';
}

// ── Main extraction ──────────────────────────────────────────────────────────

async function extractSpells(pdfPath, startPage = 1, endPage = 9999) {
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
      source:      isPsionic ? 'Dragon Kings (Psionic)' : 'Dragon Kings',
    });
  }

  for (const { text, page } of allLines) {
    // Section level heading
    const secM = text.match(SECTION_LEVEL_RE);
    if (secM) {
      const lvl = ORDINAL_TO_LEVEL[secM.groups.Ordinal.toLowerCase()];
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

    if (!inBlock) continue;

    // Field lines — also apply letter-spacing collapse to the value.
    const fldM = text.match(FIELD_LINE_RE);
    if (fldM) {
      const key = normaliseFieldKey(fldM.groups.Field);
      if (!fields[key]) fields[key] = collapseLetterSpacing(fldM.groups.Value.trim());
    }

    blockLines.push(text);
  }

  commitSpell();  // Flush last spell
  return spells;
}

// ── Run against supplied PDFs ────────────────────────────────────────────────

const pdfPaths = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [join(__dirname, '04-DragonKings.pdf')];

const allResults = [];

for (const pdfPath of pdfPaths) {
  const fileName = basename(pdfPath);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Processing: ${fileName}`);
  console.log('═'.repeat(60));

  let spells;
  try {
    // Dragon Kings spells start at page 83 (PDF page), end ~112
    spells = await extractSpells(pdfPath, 83, 162);
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

const outPath = join(__dirname, 'output', 'parsed-spells.json');
await writeFile(outPath.replace('parsed-spells', 'parsed-spells').replace('/output/', '/'),
  JSON.stringify(allResults, null, 2));

// Simpler path
import { mkdirSync } from 'fs';
mkdirSync(join(__dirname, 'output'), { recursive: true });
await writeFile(join(__dirname, 'output', 'parsed-spells.json'),
  JSON.stringify(allResults, null, 2));

console.log(`\n${'═'.repeat(60)}`);
console.log(`Output written → output/parsed-spells.json`);
