/**
 * migrate-to-v3.5.mjs — add allowedSettings + campaignSettings / ruleset overlays.
 *
 * Spells get:
 *   allowedSettings: string[]   // abbreviated campaign settings (ds, xx, fr, …)
 *   campaignSettings: { [abbr]: partial spell }  // overrides applied when that setting is selected
 *
 * Psionic powers get:
 *   allowedSettings: string[]
 *   ruleset: { adnd2e?: partial, revised?: partial }  // replaces the old string tag
 *
 * Usage:
 *   node migrate-to-v3.5.mjs
 *   node migrate-to-v3.5.mjs --in=path.json --out=path.json
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

const DEFAULT_IN = 'Reference/Spells-Powers-Combined-DarkSun.json';

const BOOK_SETTINGS = [
  { re: /player'?s handbook/i, codes: ['xx'] },
  { re: /tome of magic/i, codes: ['xx'] },
  { re: /complete wizard/i, codes: ['xx'] },
  { re: /complete book of necromancers/i, codes: ['xx'] },
  { re: /legends\s*&\s*lore/i, codes: ['xx'] },
  { re: /forgotten realms/i, codes: ['fr'] },
  { re: /complete psionics/i, codes: ['xx', 'ds'] },
  { re: /dark sun|defilers and preservers|dragon kings|earth,\s*air,\s*fire|will and the way|athas|way of the psionicist/i, codes: ['ds'] },
];

const ADND2E_FIELDS = ['powerScoreStat', 'powerScoreMod', 'powerScore', 'initialCost', 'maintenanceCost'];
const REVISED_FIELDS = ['mac', 'pspCost', 'pspCostSuccess', 'pspCostFailure'];

function parseArgs(argv) {
  const out = { in: DEFAULT_IN, out: DEFAULT_IN };
  for (const a of argv) {
    if (a.startsWith('--in=')) out.in = a.slice(5);
    else if (a.startsWith('--out=')) out.out = a.slice(6);
  }
  return out;
}

function isPsionic(rec) {
  return rec?.class === 'Psionic' || rec?.discipline != null;
}

function uniqCodes(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const k = String(c || '').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.sort();
}

function inferAllowedSettings(rec) {
  const codes = [];
  const books = [
    ...(Array.isArray(rec.sourceBooks) ? rec.sourceBooks : []),
    rec.originalSource,
    rec.source,
  ].filter(Boolean).map(String);

  for (const book of books) {
    for (const { re, codes: cs } of BOOK_SETTINGS) {
      if (re.test(book)) codes.push(...cs);
    }
  }

  if (rec.athasianStatus) codes.push('ds');
  if (isPsionic(rec)) codes.push('ds'); // wild talent / the Way is universal on Athas

  if (!codes.length) codes.push('xx');
  return uniqCodes(codes);
}

function pick(rec, keys) {
  const o = {};
  for (const k of keys) {
    if (rec[k] !== undefined && rec[k] !== null && rec[k] !== '') o[k] = rec[k];
  }
  return o;
}

function hasAthasianVariant(v) {
  if (!v || typeof v !== 'object') return false;
  return Boolean(v.modifiedEffect || v.materialComponentAthas || v.defilerCost || v.planeSource);
}

function migrateSpell(rec) {
  rec.allowedSettings = inferAllowedSettings(rec);
  if (!rec.campaignSettings || typeof rec.campaignSettings !== 'object' || Array.isArray(rec.campaignSettings)) {
    rec.campaignSettings = {};
  }
  if (hasAthasianVariant(rec.athasianVariant) || rec.athasianStatus === 'New (Dark Sun)') {
    const ds = { ...(rec.campaignSettings.ds || {}) };
    if (rec.athasianStatus && ds.athasianStatus === undefined) ds.athasianStatus = rec.athasianStatus;
    if (hasAthasianVariant(rec.athasianVariant) && ds.athasianVariant === undefined) {
      ds.athasianVariant = rec.athasianVariant;
    }
    rec.campaignSettings.ds = ds;
  }
  return rec;
}

function migratePower(rec) {
  rec.allowedSettings = inferAllowedSettings(rec);

  let key = 'revised';
  const existing = rec.ruleset;
  if (typeof existing === 'string') {
    key = (existing === '2e' || existing === 'adnd2e') ? 'adnd2e' : 'revised';
  } else if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    rec.ruleset = existing;
    if (!Object.keys(rec.ruleset).length) rec.ruleset[key] = {};
    return rec;
  }

  const overlay = key === 'adnd2e' ? pick(rec, ADND2E_FIELDS) : pick(rec, REVISED_FIELDS);
  rec.ruleset = { [key]: overlay };
  return rec;
}

function migrateRecord(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  return isPsionic(rec) ? migratePower(rec) : migrateSpell(rec);
}

function recordsOf(json) {
  if (Array.isArray(json) && json.length && Array.isArray(json[0]?.spells)) {
    return { kind: 'groups', records: json.flatMap(g => g.spells) };
  }
  if (Array.isArray(json)) return { kind: 'array', records: json };
  if (json && Array.isArray(json.spells)) return { kind: 'wrapper', records: json.spells };
  throw new Error('Unrecognised JSON shape');
}

const args = parseArgs(process.argv.slice(2));
const inPath = resolve(args.in);
const outPath = resolve(args.out);
const json = JSON.parse(await readFile(inPath, 'utf8'));
const { kind, records } = recordsOf(json);

let spells = 0, powers = 0;
for (const rec of records) {
  migrateRecord(rec);
  if (isPsionic(rec)) powers++; else spells++;
}

if (kind === 'wrapper') {
  json.schemaVersion = '3.5.0';
  json.recordCount = records.length;
  json.generatedAt = new Date().toISOString();
}

await writeFile(outPath, JSON.stringify(json, null, 2) + '\n');

const settingCounts = {};
const rulesetCounts = {};
for (const rec of records) {
  for (const c of rec.allowedSettings || []) settingCounts[c] = (settingCounts[c] || 0) + 1;
  if (isPsionic(rec) && rec.ruleset && typeof rec.ruleset === 'object') {
    for (const k of Object.keys(rec.ruleset)) rulesetCounts[k] = (rulesetCounts[k] || 0) + 1;
  }
}

console.log(`v3.5 migrate: ${records.length} records (${spells} spells, ${powers} powers)`);
console.log('allowedSettings', settingCounts);
console.log('ruleset keys', rulesetCounts);
console.log(`wrote ${outPath}`);
