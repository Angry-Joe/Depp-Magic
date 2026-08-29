/**
 * migrate-to-v3.6.1.mjs
 *
 * In-place cleanup of schema 3.6.0 spell/power corpora for editor 3.6.1.
 * Does NOT bump schemaVersion.
 *
 * - Every spell gets allowedCampaignSettings including "ds"
 * - Dark Sun rulebook spells become ["ds"] only
 * - Cleric/cleric -> Priest in class arrays
 * - Normalize EAFW / elemental bogus sources to "Earth, Air, Fire, and Water"
 * - Psionic MAC/PSP values fill rulesets["2e-rev"]; 2e keeps Power Score / costs
 * - Document ruleset labels updated to the three canonical names
 *
 * Usage:
 *   node migrate-to-v3.6.1.mjs
 *   node migrate-to-v3.6.1.mjs --dry-run
 *   node migrate-to-v3.6.1.mjs --in=Reference/spell-powers-official-v3.6.1.json
 *
 * Zero external dependencies. Works on Node 18+.
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULT_FILES = [
  'Reference/spell-powers-official-v3.6.1.json',
  'Reference/spell-powers-v3.6.1.json',
];

const CANONICAL_EAFW = 'Earth, Air, Fire, and Water';

const RULESET_CATALOG = [
  { code: '2e', name: 'AD&D 2nd Edition', alias: ['AD&D 2e'] },
  { code: '2e-rev', name: "Player's Option (Dark Sun Revised)", alias: ['Skills & Powers', 'DSCS Revised', 'xr', "Player's Option: Skills & Powers / Dark Sun Revised"] },
  { code: '5e', name: '5th Edition', alias: ['5e', 'D&D 5th Edition'] },
];

const PSI_REV_KEYS = ['mac', 'pspCost', 'pspCostSuccess', 'pspCostFailure'];
const PSI_2E_KEEP = [
  'initialCost', 'maintenanceCost', 'preparationTime', 'prerequisites',
  'powerScore', 'powerScoreStat', 'powerScoreMod', 'powerScoreEffect',
  'natural20', 'range', 'areaOfEffect', 'sourceBooks', 'description',
];

function parseArgs(argv) {
  const out = { dryRun: false, files: [] };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--in=')) out.files.push(a.slice(5));
  }
  if (!out.files.length) out.files = DEFAULT_FILES.slice();
  return out;
}

function uniq(arr) {
  const seen = new Set();
  const res = [];
  for (const v of arr) {
    const k = String(v ?? '').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    res.push(k);
  }
  return res;
}

function present(v) {
  return v !== undefined && v !== null && v !== '';
}

function sourceTitles(rec) {
  const books = Array.isArray(rec.sourceBooks) ? rec.sourceBooks : [];
  const titles = books.map(b => (b && typeof b === 'object' ? String(b.source || '') : String(b || ''))).filter(Boolean);
  if (!titles.length && rec.source) titles.push(String(rec.source));
  return titles;
}

function isElementSource(title) {
  return /^(air|earth|fire|water)$/i.test(String(title || '').trim());
}

function isEafwAlias(title) {
  const t = String(title || '').trim();
  if (!t) return false;
  if (isElementSource(t)) return true;
  if (/dss\s*2\b/i.test(t) || /\b2422\b/.test(t)) return true;
  if (/earth.*air.*fire.*water/i.test(t)) return true;
  if (/^earth,?\s*air,?\s*fire/i.test(t)) return true;
  return false;
}

function canonicalSourceTitle(title) {
  if (isEafwAlias(title)) return CANONICAL_EAFW;
  return String(title || '').trim();
}

function loadDsBookMatchers(booksJson) {
  const titles = [];
  if (booksJson && Array.isArray(booksJson.books)) {
    for (const b of booksJson.books) {
      if (b && b.title) titles.push(String(b.title));
    }
  }
  const extra = [
    'Dark Sun Rules Book',
    'Dragon Kings',
    CANONICAL_EAFW,
    'Earth, Air, Fire and Water',
    'Defilers and Preservers',
    'The Will and the Way',
    'The Way of the Psionicist',
    'Dark Sun Campaign Setting',
    'Dark Sun boxed set',
    'MC12',
    'MC Dark Sun',
    'Terrors of the Desert',
    'Terrors Beyond Tyr',
    'DSS2',
  ];
  const needles = [];
  for (const t of [...titles, ...extra]) {
    const n = String(t).toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (n) needles.push(n);
  }
  return needles;
}

function isDarkSunBook(title, needles) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  if (isEafwAlias(title)) return true;
  if (/\bdark\s*sun\b/.test(t)) return true;
  if (/\bathas\b/.test(t)) return true;
  if (/\bdragon kings\b/.test(t)) return true;
  if (/defilers and preservers/.test(t)) return true;
  if (/will and the way/.test(t)) return true;
  if (/way of the psionicist/.test(t)) return true;
  if (/\bmc\s*12\b/.test(t) || /terrors of the desert/.test(t) || /terrors beyond tyr/.test(t)) return true;
  if (/\bdss\s*2\b/.test(t) || /\b2422\b/.test(t)) return true;
  for (const n of needles) {
    if (n.length >= 8 && t.includes(n)) return true;
  }
  return false;
}

function renameClasses(rec, stats) {
  const rename = (v) => {
    if (typeof v !== 'string') return v;
    if (/^cleric$/i.test(v.trim())) {
      stats.clericToPriest++;
      return 'Priest';
    }
    return v;
  };
  if (Array.isArray(rec.classes)) {
    rec.classes = rec.classes.map(rename);
  }
  if (typeof rec.class === 'string') rec.class = rename(rec.class);
  if (Array.isArray(rec['5e_classes'])) rec['5e_classes'] = rec['5e_classes'].map(rename);
}

function normalizeSourceBooks(rec, stats) {
  const books = Array.isArray(rec.sourceBooks) ? rec.sourceBooks : null;
  if (!books) {
    if (rec.source && isEafwAlias(rec.source)) {
      rec.source = CANONICAL_EAFW;
      stats.sourceMerges++;
    }
    return;
  }
  let mergedElement = false;
  const out = [];
  const seen = new Set();
  for (const item of books) {
    const raw = item && typeof item === 'object' ? String(item.source || '') : String(item || '');
    const page = item && typeof item === 'object' ? item.page : undefined;
    if (!raw.trim()) continue;
    const wasElement = isElementSource(raw);
    const wasAlias = isEafwAlias(raw);
    const title = canonicalSourceTitle(raw);
    if (wasElement || (wasAlias && title !== raw)) {
      stats.sourceMerges++;
      if (wasElement) mergedElement = true;
    }
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (item && typeof item === 'object') {
      out.push({ ...item, source: title, ...(page !== undefined ? { page } : {}) });
    } else {
      out.push(title);
    }
  }
  rec.sourceBooks = out;
  if (mergedElement && !out.some(b => canonicalSourceTitle(typeof b === 'object' ? b.source : b) === CANONICAL_EAFW)) {
    rec.sourceBooks.push({ source: CANONICAL_EAFW });
  }
}

function updateCampaigns(spell, needles, stats) {
  const titles = sourceTitles(spell).map(canonicalSourceTitle);
  const dsNative = titles.some(t => isDarkSunBook(t, needles));
  let acs = Array.isArray(spell.allowedCampaignSettings)
    ? spell.allowedCampaignSettings.map(c => String(c).trim().toLowerCase()).filter(Boolean)
    : [];
  acs = uniq(acs);
  const hadDs = acs.includes('ds');
  const wasDsOnly = hadDs && acs.length === 1;

  if (!hadDs) {
    acs.push('ds');
    stats.gainedDs++;
  }
  if (dsNative && !(acs.length === 1 && acs[0] === 'ds')) {
    acs = ['ds'];
    if (!wasDsOnly) stats.becameDsOnly++;
  }
  spell.allowedCampaignSettings = acs;
}

function pickFrom(objs, key) {
  for (const o of objs) {
    if (o && present(o[key])) return o[key];
  }
  return undefined;
}

function splitPsiRulesets(power, donor, stats) {
  if (!power.rulesets || typeof power.rulesets !== 'object' || Array.isArray(power.rulesets)) {
    power.rulesets = {};
  }
  const bags = power.rulesets;
  const two = bags['2e'] && typeof bags['2e'] === 'object' && !Array.isArray(bags['2e']) ? { ...bags['2e'] } : {};
  const rev = bags['2e-rev'] && typeof bags['2e-rev'] === 'object' && !Array.isArray(bags['2e-rev']) ? { ...bags['2e-rev'] } : {};
  const donorTwo = donor?.rulesets?.['2e'] && typeof donor.rulesets['2e'] === 'object' ? donor.rulesets['2e'] : null;
  const donorRev = donor?.rulesets?.['2e-rev'] && typeof donor.rulesets['2e-rev'] === 'object' ? donor.rulesets['2e-rev'] : null;

  const sources = [rev, two, power, bags.revised, bags.xr, bags.adnd2e, donorRev, donorTwo, donor].filter(Boolean);

  const hadRevMac = present(rev.mac) || present(rev.pspCost) || present(rev.pspCostSuccess);
  const revOut = { ...rev };
  for (const k of PSI_REV_KEYS) {
    if (!present(revOut[k])) {
      const v = pickFrom(sources, k);
      if (v !== undefined) revOut[k] = v;
    }
  }
  for (const k of ['range', 'areaOfEffect', 'prerequisites']) {
    if (!present(revOut[k])) {
      const v = pickFrom([rev, two, power, donorRev, donorTwo, donor], k);
      if (v !== undefined) revOut[k] = v;
    }
  }

  const hasRev = present(revOut.mac) || present(revOut.pspCost) || present(revOut.pspCostSuccess);
  if (hasRev) {
    bags['2e-rev'] = revOut;
    if (!hadRevMac) stats.psiRevFilled++;
    if (!Array.isArray(power.allowedRulesets)) power.allowedRulesets = ['2e'];
    if (!power.allowedRulesets.includes('2e-rev')) power.allowedRulesets.push('2e-rev');
  }

  const twoOut = { ...two };
  for (const k of PSI_REV_KEYS) delete twoOut[k];
  // Restore missing 2e mechanics from the official corpus, but not
  // description/sourceBooks/range (those would duplicate base text).
  const DONOR_2E_RESTORE = [
    'initialCost', 'maintenanceCost', 'preparationTime', 'prerequisites',
    'powerScore', 'powerScoreStat', 'powerScoreMod', 'powerScoreEffect',
    'natural20',
  ];
  if (donorTwo) {
    for (const k of DONOR_2E_RESTORE) {
      if (!present(twoOut[k]) && present(donorTwo[k])) twoOut[k] = donorTwo[k];
    }
  }
  for (const k of PSI_REV_KEYS) delete twoOut[k];
  if (Object.keys(twoOut).length) bags['2e'] = twoOut;
  else if (bags['2e']) bags['2e'] = twoOut;

  delete bags.revised;
  delete bags.xr;
  delete bags.adnd2e;
}

function migrateDocument(doc, needles, donorDoc, stats) {
  if (Array.isArray(doc.rulesets)) {
    doc.rulesets = RULESET_CATALOG.map(r => ({ ...r }));
  }
  doc.schemaVersion = '3.6.0';
  doc.dateUpdated = new Date().toISOString().slice(0, 10);

  const donorById = new Map();
  if (donorDoc && Array.isArray(donorDoc.psionics)) {
    for (const p of donorDoc.psionics) if (p && p.id) donorById.set(p.id, p);
  }

  for (const s of doc.spells || []) {
    renameClasses(s, stats);
    normalizeSourceBooks(s, stats);
    updateCampaigns(s, needles, stats);
  }
  for (const p of doc.psionics || []) {
    renameClasses(p, stats);
    normalizeSourceBooks(p, stats);
    const donor = p.id ? donorById.get(p.id) : null;
    splitPsiRulesets(p, donor, stats);
  }
  return doc;
}

function emptyStats() {
  return { clericToPriest: 0, sourceMerges: 0, gainedDs: 0, becameDsOnly: 0, psiRevFilled: 0 };
}

async function processFile(rel, needles, donorCache, dryRun) {
  const path = resolve(HERE, rel);
  const raw = await readFile(path, 'utf8');
  const doc = JSON.parse(raw);
  const stats = emptyStats();
  const isOfficial = /official/i.test(rel);
  const donor = isOfficial ? null : donorCache.official;
  migrateDocument(doc, needles, donor, stats);
  if (isOfficial) donorCache.official = doc;
  const out = JSON.stringify(doc, null, 2) + '\n';
  if (!dryRun) await writeFile(path, out, 'utf8');
  return { rel, stats, spells: (doc.spells || []).length, psionics: (doc.psionics || []).length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let booksJson = null;
  try {
    booksJson = JSON.parse(await readFile(resolve(HERE, 'Reference/rules/dark-sun-books.json'), 'utf8'));
  } catch {
    booksJson = null;
  }
  const needles = loadDsBookMatchers(booksJson);
  const donorCache = { official: null };

  // Prefer transforming official first so it can donate 2e overlays to working.
  args.files.sort((a, b) => {
    const ao = /official/i.test(a) ? 0 : 1;
    const bo = /official/i.test(b) ? 0 : 1;
    return ao - bo;
  });

  console.log('Depp-Magic migrate-to-v3.6.1' + (args.dryRun ? ' (dry-run)' : ''));
  const reports = [];
  for (const rel of args.files) {
    const r = await processFile(rel, needles, donorCache, args.dryRun);
    reports.push(r);
    console.log(`\n${r.rel}`);
    console.log(`  spells ${r.spells}, psionics ${r.psionics}`);
    console.log(`  Cleric→Priest: ${r.stats.clericToPriest}`);
    console.log(`  source merges/normalizations: ${r.stats.sourceMerges}`);
    console.log(`  spells gained ds: ${r.stats.gainedDs}`);
    console.log(`  spells became ds-only: ${r.stats.becameDsOnly}`);
    console.log(`  psionic 2e-rev overlays filled from MAC: ${r.stats.psiRevFilled}`);
  }
  await writeFile(resolve(HERE, '_migrate-361-report.json'), JSON.stringify(reports, null, 2) + '\n', 'utf8');
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

