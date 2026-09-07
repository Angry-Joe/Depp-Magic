/**
 * migrate-to-v3.6.2.mjs
 *
 * Build schema 3.6.0 corpora for editor 3.6.2 from official 3.6.1.
 * Does NOT bump schemaVersion.
 *
 * - Ensure every psionic ruleset overlay has `prerequisites` (copy from 2e when
 *   2e-rev is missing; otherwise [] to match existing empty style)
 * - Add top-level `combatMode`: N/A | Att | Def (psionic combat modes)
 *
 * Usage:
 *   node migrate-to-v3.6.2.mjs
 *   node migrate-to-v3.6.2.mjs --dry-run
 *   node migrate-to-v3.6.2.mjs --in=Reference/spell-powers-official-v3.6.1.json --out=Reference/spell-powers-official-v3.6.2.json
 */

import { readFile, writeFile, copyFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

const ATTACKS = [
  'Ego Whip',
  'Id Insinuation',
  'Mind Thrust',
  'Psionic Blast',
  'Psychic Crush',
];
const DEFENSES = [
  'Intellect Fortress',
  'Mental Barrier',
  'Mind Blank',
  'Thought Shield',
  'Tower of Iron Will',
];

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const ATTACK_SET = new Set(ATTACKS.map(normName));
const DEFENSE_SET = new Set(DEFENSES.map(normName));

function combatModeFor(name) {
  const n = normName(name);
  if (ATTACK_SET.has(n)) return 'Att';
  if (DEFENSE_SET.has(n)) return 'Def';
  return 'N/A';
}

function parseArgs(argv) {
  const out = { dryRun: false, inFile: null, outFile: null };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--in=')) out.inFile = a.slice(5);
    else if (a.startsWith('--out=')) out.outFile = a.slice(6);
  }
  return out;
}

function ensurePrereqs(power, stats) {
  if (!power.rulesets || typeof power.rulesets !== 'object' || Array.isArray(power.rulesets)) {
    power.rulesets = {};
  }
  const bags = power.rulesets;
  const two = bags['2e'] && typeof bags['2e'] === 'object' && !Array.isArray(bags['2e']) ? bags['2e'] : null;

  for (const [code, bag] of Object.entries(bags)) {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue;
    if (!Object.prototype.hasOwnProperty.call(bag, 'prerequisites')) {
      if (two && Array.isArray(two.prerequisites)) {
        bag.prerequisites = Array.isArray(two.prerequisites) ? [...two.prerequisites] : [];
        stats.prereqCopied++;
      } else {
        bag.prerequisites = [];
        stats.prereqFilledEmpty++;
      }
    } else {
      stats.prereqAlready++;
    }
  }

  // If 2e exists and 2e-rev exists but 2e-rev prereqs are empty while 2e has real ones, copy.
  if (two && bags['2e-rev'] && typeof bags['2e-rev'] === 'object') {
    const a = two.prerequisites;
    const b = bags['2e-rev'].prerequisites;
    const aHas = Array.isArray(a) && a.length > 0 && !(a.length === 1 && String(a[0]).toLowerCase() === 'none');
    const bEmpty = !Array.isArray(b) || b.length === 0 || (b.length === 1 && String(b[0]).toLowerCase() === 'none');
    if (aHas && bEmpty) {
      bags['2e-rev'].prerequisites = [...a];
      stats.prereqSyncedToRev++;
    }
  }
}

function migrateDoc(doc) {
  const stats = {
    prereqAlready: 0,
    prereqFilledEmpty: 0,
    prereqCopied: 0,
    prereqSyncedToRev: 0,
    combatAtt: 0,
    combatDef: 0,
    combatNA: 0,
  };
  doc.schemaVersion = '3.6.0';
  doc.dateUpdated = new Date().toISOString().slice(0, 10);

  for (const p of doc.psionics || []) {
    ensurePrereqs(p, stats);
    const mode = combatModeFor(p.name);
    p.combatMode = mode;
    if (mode === 'Att') stats.combatAtt++;
    else if (mode === 'Def') stats.combatDef++;
    else stats.combatNA++;
  }
  return { doc, stats };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inRel = args.inFile || 'Reference/spell-powers-official-v3.6.1.json';
  const outOfficial = args.outFile || 'Reference/spell-powers-official-v3.6.2.json';
  const outWorking = 'Reference/spell-powers-v3.6.2.json';

  const inPath = resolve(HERE, inRel);
  const raw = await readFile(inPath, 'utf8');
  const { doc, stats } = migrateDoc(JSON.parse(raw));
  const out = JSON.stringify(doc, null, 2) + '\n';

  console.log('Depp-Magic migrate-to-v3.6.2' + (args.dryRun ? ' (dry-run)' : ''));
  console.log(`  in:  ${inRel}`);
  console.log(`  out: ${outOfficial}`);
  console.log(`  spells ${(doc.spells || []).length}, psionics ${(doc.psionics || []).length}`);
  console.log(`  prerequisites already present: ${stats.prereqAlready}`);
  console.log(`  prerequisites filled empty: ${stats.prereqFilledEmpty}`);
  console.log(`  prerequisites copied from 2e: ${stats.prereqCopied}`);
  console.log(`  prerequisites synced 2e→2e-rev: ${stats.prereqSyncedToRev}`);
  console.log(`  combatMode Att/Def/N/A: ${stats.combatAtt}/${stats.combatDef}/${stats.combatNA}`);

  if (!args.dryRun) {
    await writeFile(resolve(HERE, outOfficial), out, 'utf8');
    // Working copy mirrors official for auto-load fallbacks
    if (!args.outFile) {
      await writeFile(resolve(HERE, outWorking), out, 'utf8');
      console.log(`  also wrote ${outWorking}`);
    }
    await writeFile(resolve(HERE, '_migrate-362-report.json'), JSON.stringify(stats, null, 2) + '\n', 'utf8');
  }
  console.log('Done.');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
