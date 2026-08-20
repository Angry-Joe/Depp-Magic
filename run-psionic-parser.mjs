/**
 * run-psionic-parser.mjs  –  AD&D 2e psionic power extractor
 * ════════════════════════════════════════════════════════════════════════════
 * Companion to run-parser.mjs. Reads the text layer of one or more PDFs and
 * emits a JSON output of psionic power records using the Depp-Magic unified
 * psionic schema (v2.0.0).
 *
 * Supports BOTH ruleset formats in a single run:
 *   2e original ("The Will and the Way", PHBR5):
 *     Power Score: Wis -3  •  Initial Cost: 6  •  Maintenance Cost: 4/round
 *   Revised Dark Sun ("Way of the Psionicist", DSCS-Rev):
 *     MAC: 8  •  PSP Cost: 5/2  (success / failure)
 *
 * Why separate from run-parser?
 *   run-parser.mjs targets the 2e format only and skips powers when it
 *   encounters the revised stat block pattern (MAC / PSP Cost). This script
 *   handles both, plus produces the full unified psionic schema with null
 *   placeholders for fields that don't apply to the detected ruleset.
 *
 * Usage:
 *   node run-psionic-parser.mjs [options] file.pdf [more.pdf ...]
 *
 * Options:
 *   --start=N          first PDF page to scan (default: 1)
 *   --end=N            last PDF page to scan  (default: last page)
 *   --ruleset=2e|revised|auto
 *                      force ruleset or auto-detect per power (default: auto)
 *   --out=path.json    single combined output file
 *                      (default: output/<source>-psionics.json per PDF)
 *   --verbose          print every power name as it is committed
 *
 * Output schema fields:
 *   id, name, class, 5e_classes, discipline, tier, level,
 *   powerScoreStat, powerScoreMod,          ← 2e only (null for revised)
 *   initialCost, maintenanceCost,           ← 2e only (null for revised)
 *   mac, macNotes,                          ← revised only (null for 2e)
 *   pspCost, pspCostSuccess, pspCostFailure,← revised only (null for 2e)
 *   range, preparationTime, areaOfEffect, prerequisites,
 *   description, page, sourceBooks, verified, originalSource, ruleset
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

function fixPipes(v) {
  if (v == null) return v;
  return String(v).replace(/\|\s*(\S?)/g,
    (_, next) => (next && /[A-Za-z0-9]/.test(next) ? '1 ' + next : '1' + next));
}

// ── Junk-line filter ─────────────────────────────────────────────────────────
const JUNK_LINE_RE = /file:\/\/\/|^\d{1,2}\/\d{1,2}\/\d{2,4},\s|Full text of "|^\d+\/\d+$/;

// ── Discipline section headers ────────────────────────────────────────────────
// Handles "Clairsentient Sciences", "Clairsentience Sciences", "Telepathic Devotions", etc.
const PSIONIC_DISC_SECTION_RE =
  /^(?<Disc>Clairsentien(?:t|ce)|Psychokineti(?:c|sis?)|Psychometaboli(?:c|sm)|Psychoporti(?:ve|on)|Telepathi(?:c|y)|Metapsionic(?:s)?)\s+(?<High>High\s+)?(?<Kind>Sciences?|Devotions?)\s*$/i;

// "Sciences" or "Devotions" as a standalone line under a prior discipline header
const TIER_STANDALONE_RE = /^(High\s+)?(Sciences?|Devotions?)\s*$/i;

// High Science marker embedded in power name: "Power Name (High Science)"
const HIGH_SCIENCE_RE = /\(\s*High\s+Sciences?\s*\)/i;

const PSIONIC_DISCIPLINE_MAP = {
  clairsentient:    'Clairsentience',
  clairsentience:   'Clairsentience',
  psychokinetic:    'Psychokinesis',
  psychokinesis:    'Psychokinesis',
  psychometabolic:  'Psychometabolism',
  psychometabolism: 'Psychometabolism',
  psychoportive:    'Psychoportation',
  psychoportation:  'Psychoportation',
  telepathic:       'Telepathy',
  telepathy:        'Telepathy',
  metapsionic:      'Metapsionics',
  metapsionics:     'Metapsionics',
};

function normDisc(raw) {
  const key = raw.toLowerCase().replace(/\s+/g, '');
  return PSIONIC_DISCIPLINE_MAP[key] ?? raw.trim();
}

// ── Field regexes ─────────────────────────────────────────────────────────────

// 2e format
const POWER_SCORE_RE   = /^Power\s*Score\s*:\s*(?<Value>.+)$/i;
const INITIAL_COST_RE  = /^Initial\s*Cost\s*:\s*(?<Value>.+)$/i;
const MAINT_COST_RE    = /^Maintenance\s*Cost\s*:\s*(?<Value>.+)$/i;

// Revised format
const MAC_RE           = /^MAC\s*:\s*(?<Value>.+)$/i;
const PSP_COST_RE      = /^PSP\s*Cost\s*:\s*(?<Value>.+)$/i;

// Common fields
const RANGE_RE         = /^Range\s*:\s*(?<Value>.+)$/i;
const PREP_TIME_RE     = /^Prep(?:aration)?\s*Time\s*:\s*(?<Value>.+)$/i;
const AREA_RE          = /^Area\s*of\s*Effect\s*:\s*(?<Value>.+)$/i;
const PREREQ_RE        = /^Pre[-\s]?req(?:uisite)?s?\s*:\s*(?<Value>.+)$/i;

// Combined field check (for filtering out field lines when building description)
const ANY_PSIONIC_FIELD_RE =
  /^(?:Power\s*Score|Initial\s*Cost|Maintenance\s*Cost|MAC|PSP\s*Cost|Range|Prep(?:aration)?\s*Time|Area\s*of\s*Effect|Pre[-\s]?req(?:uisite)?s?)\s*:/i;

// ── Power name candidate ──────────────────────────────────────────────────────
const ABILITY_START_RE = /^(?:Str|Dex|Con|Int|Wis|Cha)\s*[-+]?\s*\d/i;

function isPsionicNameCandidate(line) {
  if (!line || !/^[A-Z]/.test(line)) return false;
  if (line.length > 72) return false;
  if (ABILITY_START_RE.test(line)) return false;
  if (PSIONIC_DISC_SECTION_RE.test(line)) return false;
  if (TIER_STANDALONE_RE.test(line)) return false;
  if (JUNK_LINE_RE.test(line)) return false;
  if (/^\d+$/.test(line)) return false;
  if (ANY_PSIONIC_FIELD_RE.test(line)) return false;
  return true;
}

// A power block starts when at least one psionic stat field appears
// within the next 5 lines after the candidate name.
function powerBlockStartsAt(lines, li) {
  for (let i = 1; i <= 5; i++) {
    const t = lines[li + i]?.text ?? '';
    if (POWER_SCORE_RE.test(t) || INITIAL_COST_RE.test(t) ||
        MAC_RE.test(t) || PSP_COST_RE.test(t)) return true;
  }
  return false;
}

// ── Field parsers ─────────────────────────────────────────────────────────────

// "Wis -3"      → { powerScoreStat: 'Wis', powerScoreMod: '-3' }
// "Con"         → { powerScoreStat: 'Con', powerScoreMod: null }
// "Wis or Int"  → { powerScoreStat: 'Wis or Int', powerScoreMod: null }
function parsePowerScore(raw) {
  const s = raw.trim();
  const m = s.match(/^(?<stat>[A-Za-z]+(?:\/[A-Za-z]+)?(?:\s+or\s+[A-Za-z]+)?)\s*(?<mod>[+\-]\s*\d+)?$/);
  if (m) return { powerScoreStat: m.groups.stat.trim(), powerScoreMod: m.groups.mod?.replace(/\s+/g, '') ?? null };
  return { powerScoreStat: s, powerScoreMod: null };
}

// "8"       → { mac: 8, macNotes: null }
// "Special" → { mac: null, macNotes: 'Special' }
function parseMAC(raw) {
  const s = raw.trim();
  const m = s.match(/^(-?\d+)(.*)?$/);
  if (m) {
    const notes = m[2]?.trim().replace(/^[/(]/, '').replace(/[/)]$/, '').trim() || null;
    return { mac: parseInt(m[1], 10), macNotes: notes || null };
  }
  return { mac: null, macNotes: s };
}

// "5/2" → { pspCost:'5/2', pspCostSuccess:5, pspCostFailure:2 }
// "10"  → { pspCost:'10',  pspCostSuccess:10, pspCostFailure:0 }
function parsePspCost(raw) {
  const s = raw.trim();
  const slash = s.match(/^(\d+)\s*\/\s*(\d+)/);
  if (slash) return { pspCost: s, pspCostSuccess: +slash[1], pspCostFailure: +slash[2] };
  const single = s.match(/^(\d+)/);
  if (single) return { pspCost: s, pspCostSuccess: +single[1], pspCostFailure: 0 };
  return { pspCost: s, pspCostSuccess: null, pspCostFailure: null };
}

// "Contact, Mindlink" → ['Contact', 'Mindlink']
// "None"              → ['None']
function parsePrerequisites(raw) {
  const s = (raw ?? '').trim();
  if (!s || /^none$/i.test(s)) return ['None'];
  return s.split(/[,;]\s*/).map(x => x.trim()).filter(Boolean);
}

// ── Source / ruleset helpers ──────────────────────────────────────────────────
const SOURCE_MAP = {
  'PHBR5':                        'Complete Psionics Handbook',
  'WillAndTheWay':                'The Will and the Way',
  'Will_and_the_Way':             'The Will and the Way',
  'DSCS-Rev-WayOfThePsionicist':  'Dark Sun Campaign Setting (Revised)',
  'DarkSun':                      'Dark Sun Campaign Setting',
  'Players_Option_Skills_Powers': "Player's Option: Skills & Powers",
};

function humanSource(stem) {
  if (SOURCE_MAP[stem]) return SOURCE_MAP[stem];
  for (const [k, v] of Object.entries(SOURCE_MAP)) {
    if (stem.toLowerCase().replace(/[-_\s]/g,'').includes(k.toLowerCase().replace(/[-_\s]/g,'').slice(0, 8)))
      return v;
  }
  return stem.replace(/[-_]+/g, ' ').trim();
}

function guessRulesetFromStem(stem) {
  const s = stem.toLowerCase();
  if (s.includes('rev') || s.includes('wayofthe') || s.includes('way-of')) return 'revised';
  if (s.includes('phbr5') || s.includes('willandthe') || s.includes('will-and')) return '2e';
  return null;
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

// ── Description builder ───────────────────────────────────────────────────────
function buildDescription(blockLines) {
  let fieldsSeen = 0;
  const desc = [];
  for (const line of blockLines.slice(1)) {
    if (ANY_PSIONIC_FIELD_RE.test(line)) { fieldsSeen++; continue; }
    if (fieldsSeen >= 2) desc.push(line);
  }
  return desc.length
    ? desc.join(' ').replace(/(\w)-\s+(\w)/g, '$1$2').replace(/\|/g, '1 ').trim()
    : 'See source for description.';
}

// ── Build output record ───────────────────────────────────────────────────────
function buildRecord({ name, discipline, tier, page, fields }, sourceName, forcedRuleset) {
  const book   = humanSource(sourceName);
  const ruleset = forcedRuleset ??
    (fields.mac !== undefined ? 'revised' : fields.powerScoreStat ? '2e' : null);

  const is2e  = ruleset === '2e';
  const isRev = ruleset === 'revised';

  return {
    id:              `psionic_${slug(name)}_2e`,
    name,
    class:           'Psionic',
    '5e_classes':    [],
    discipline:      discipline ?? null,
    tier:            tier ?? null,
    level:           null,

    // 2e-only fields
    powerScoreStat:  is2e ? (fields.powerScoreStat  ?? null) : null,
    powerScoreMod:   is2e ? (fields.powerScoreMod   ?? null) : null,
    initialCost:     is2e ? (fields.initialCost     ?? null) : null,
    maintenanceCost: is2e ? (fields.maintenanceCost ?? null) : null,

    // Revised-only fields
    mac:             isRev ? (fields.mac             ?? null) : null,
    macNotes:        isRev ? (fields.macNotes        ?? null) : null,
    pspCost:         isRev ? (fields.pspCost         ?? null) : null,
    pspCostSuccess:  isRev ? (fields.pspCostSuccess  ?? null) : null,
    pspCostFailure:  isRev ? (fields.pspCostFailure  ?? null) : null,

    // Common fields
    range:           fixPipes(fields.range           ?? ''),
    preparationTime: fields.preparationTime          ?? '',
    areaOfEffect:    fields.areaOfEffect             ?? '',
    prerequisites:   fields.prerequisites            ?? [],
    description:     fields._description             ?? 'See source for description.',
    page:            page ?? null,
    sourceBooks:     [book],
    verified:        false,
    originalSource:  sourceName,
    ruleset:         ruleset ?? null,
  };
}

// ── Main extraction ───────────────────────────────────────────────────────────
async function extractPsionics(pdfPath, startPage, endPage, sourceName, forcedRuleset, verbose) {
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

  let currentDiscipline = '';
  let currentTier       = '';
  let inPsionicSection  = !!forcedRuleset;

  let name       = null;
  let curPage    = 0;
  let blockLines = [];
  let fields     = {};
  let blkDisc    = '';
  let blkTier    = '';

  const powers = [];

  function commitPower() {
    if (!name || !blkDisc) return;
    fields._description = buildDescription(blockLines);
    if (verbose) console.log(`    + ${name} [${blkDisc} ${blkTier}]`);
    powers.push(buildRecord({ name, discipline: blkDisc, tier: blkTier, page: curPage, fields }, sourceName, forcedRuleset));
    name = null; blockLines = []; fields = {};
  }

  for (let li = 0; li < allLines.length; li++) {
    const { text, page } = allLines[li];

    // Discipline section header
    const discM = text.match(PSIONIC_DISC_SECTION_RE);
    if (discM) {
      commitPower();
      currentDiscipline = normDisc(discM.groups.Disc);
      currentTier = /high/i.test(discM.groups.High ?? '') ? 'High Science'
        : /devotion/i.test(discM.groups.Kind) ? 'Devotion' : 'Science';
      inPsionicSection = true;
      continue;
    }

    // Standalone "Sciences" / "Devotions" line
    if (TIER_STANDALONE_RE.test(text) && currentDiscipline) {
      const isHigh = /high/i.test(text);
      currentTier = isHigh ? 'High Science' : /devotion/i.test(text) ? 'Devotion' : 'Science';
      continue;
    }

    if (!inPsionicSection) continue;

    // Power name start
    if (currentDiscipline && isPsionicNameCandidate(text) && powerBlockStartsAt(allLines, li)) {
      commitPower();
      name    = text.replace(HIGH_SCIENCE_RE, '').replace(/\s*\(\s*\)\s*$/, '').trim();
      curPage = page;
      blockLines = [text];
      blkDisc = currentDiscipline;
      blkTier = HIGH_SCIENCE_RE.test(text) ? 'High Science' : currentTier;
      continue;
    }

    if (!name) continue;

    // Parse field lines
    let m;
    if ((m = text.match(POWER_SCORE_RE))) {
      const ps = parsePowerScore(m.groups.Value);
      if (!('powerScoreStat' in fields)) { fields.powerScoreStat = ps.powerScoreStat; fields.powerScoreMod = ps.powerScoreMod; }
      blockLines.push(text); continue;
    }
    if ((m = text.match(INITIAL_COST_RE))) {
      if (!('initialCost' in fields)) fields.initialCost = m.groups.Value.trim();
      blockLines.push(text); continue;
    }
    if ((m = text.match(MAINT_COST_RE))) {
      if (!('maintenanceCost' in fields)) fields.maintenanceCost = m.groups.Value.trim();
      blockLines.push(text); continue;
    }
    if ((m = text.match(MAC_RE))) {
      if (!('mac' in fields)) { const r = parseMAC(m.groups.Value); fields.mac = r.mac; fields.macNotes = r.macNotes; }
      blockLines.push(text); continue;
    }
    if ((m = text.match(PSP_COST_RE))) {
      if (!('pspCost' in fields)) { const r = parsePspCost(m.groups.Value); Object.assign(fields, r); }
      blockLines.push(text); continue;
    }
    if ((m = text.match(RANGE_RE)))     { if (!('range'           in fields)) fields.range           = fixPipes(m.groups.Value.trim()); blockLines.push(text); continue; }
    if ((m = text.match(PREP_TIME_RE))) { if (!('preparationTime' in fields)) fields.preparationTime = m.groups.Value.trim(); blockLines.push(text); continue; }
    if ((m = text.match(AREA_RE)))      { if (!('areaOfEffect'    in fields)) fields.areaOfEffect    = m.groups.Value.trim(); blockLines.push(text); continue; }
    if ((m = text.match(PREREQ_RE)))    { if (!('prerequisites'   in fields)) fields.prerequisites   = parsePrerequisites(m.groups.Value); blockLines.push(text); continue; }

    blockLines.push(text);
  }

  commitPower();
  return powers;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
let cliStart   = 1, cliEnd = Infinity, cliOut = null, cliRuleset = null, cliVerbose = false;
const pdfPaths = [];

for (const a of args) {
  if      (a.startsWith('--start='))   cliStart   = Number(a.slice(8));
  else if (a.startsWith('--end='))     cliEnd     = Number(a.slice(6));
  else if (a.startsWith('--out='))     cliOut     = a.slice(6);
  else if (a.startsWith('--ruleset=')) cliRuleset = a.slice(10).toLowerCase() === 'auto' ? null : a.slice(10).toLowerCase();
  else if (a === '--verbose')          cliVerbose = true;
  else if (!a.startsWith('--'))        pdfPaths.push(a);
}

if (!pdfPaths.length) {
  console.error('Usage: node run-psionic-parser.mjs [--start=N] [--end=N] [--ruleset=2e|revised|auto]');
  console.error('                                    [--out=path.json] [--verbose] file.pdf [...]');
  console.error('');
  console.error('  --ruleset=2e      force 2e format (Power Score / Initial Cost / Maintenance Cost)');
  console.error('  --ruleset=revised force revised format (MAC / PSP Cost)');
  console.error('  --ruleset=auto    auto-detect per power from fields present (default)');
  process.exit(1);
}

const combined = [];

for (const pdfPath of pdfPaths) {
  const stem = basename(pdfPath).replace(/\.pdf$/i, '');
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`Processing: ${basename(pdfPath)}`);
  console.log('═'.repeat(64));

  const forcedRuleset = cliRuleset ?? guessRulesetFromStem(stem);
  console.log(`  Ruleset: ${forcedRuleset ?? 'auto-detect per power'}`);

  let powers;
  try {
    powers = await extractPsionics(pdfPath, cliStart, cliEnd, stem, forcedRuleset, cliVerbose);
  } catch (e) {
    console.error(`  ERROR: ${e.message}`);
    continue;
  }

  const byDisc    = {};
  const tierCount = { Science: 0, Devotion: 0, 'High Science': 0, Other: 0 };
  const rsCount   = { '2e': 0, revised: 0, unknown: 0 };

  for (const p of powers) {
    byDisc[p.discipline ?? 'Unknown'] = (byDisc[p.discipline ?? 'Unknown'] ?? 0) + 1;
    const t = p.tier ?? 'Other';
    tierCount[t in tierCount ? t : 'Other']++;
    rsCount[p.ruleset === '2e' ? '2e' : p.ruleset === 'revised' ? 'revised' : 'unknown']++;
  }

  console.log(`\n  Total: ${powers.length} powers`);
  console.log(`  By tier:    Sciences ${tierCount.Science}, Devotions ${tierCount.Devotion}, High Sciences ${tierCount['High Science']}`);
  console.log(`  By ruleset: 2e: ${rsCount['2e']}, revised: ${rsCount.revised}, unknown: ${rsCount.unknown}`);
  if (Object.keys(byDisc).length) {
    console.log('  By discipline:');
    for (const [d, n] of Object.entries(byDisc).sort()) console.log(`    ${d}: ${n}`);
  }

  if (cliOut) {
    combined.push(...powers);
  } else {
    const outPath = join(__dirname, 'output', `${stem}-psionics.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      generator:     'run-psionic-parser.mjs',
      generatedAt:   new Date().toISOString(),
      source:        humanSource(stem),
      sourceFile:    basename(pdfPath),
      recordCount:   powers.length,
      powers,
    };
    await writeFile(outPath, JSON.stringify(envelope, null, 2));
    console.log(`\n  ✓ Wrote ${powers.length} records → ${outPath}`);
  }
}

if (cliOut && combined.length > 0) {
  const outPath = resolve(cliOut);
  mkdirSync(dirname(outPath), { recursive: true });
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    generator:     'run-psionic-parser.mjs',
    generatedAt:   new Date().toISOString(),
    source:        pdfPaths.map(p => humanSource(basename(p).replace(/\.pdf$/i, ''))).join(' + '),
    sourceFile:    pdfPaths.map(basename).join(', '),
    recordCount:   combined.length,
    powers:        combined,
  };
  await writeFile(outPath, JSON.stringify(envelope, null, 2));
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`✓ Combined output → ${outPath}  (${combined.length} powers)`);
}
