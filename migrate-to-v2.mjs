/**
 * migrate-to-v2.mjs — upgrade older spell/psionic JSON to the v2 schema.
 * ═══════════════════════════════════════════════════════════════════════════
 * Accepts, per input file, any of these shapes and converts every record to a
 * Savage Sun Rising v2 record, then writes ONE combined v2 wrapper file:
 *
 *   • v2 wrapper           { schemaVersion, spells:[ …SSR… ] }   (re-stamped, idempotent)
 *   • SSR v1 flat array    [ …SSR records… ]                     (backfilled)
 *   • parser-group array   [ { spells:[…] }, … ]
 *   • snake_case spells    { …, spells:[ {stats:{casting_time…}, spheres:[…] } ] }
 *   • psionics corpus      { …, powers:[ {discipline, type, stats:{power_score…}} ] }
 *
 * Usage:  node migrate-to-v2.mjs --out=combined-v2.json spells.json psionics.json [more…]
 *         node migrate-to-v2.mjs old-parsed.json          (writes old-parsed.v2.json)
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname, basename, join } from 'path';

const SCHEMA_VERSION = '2.0.0';

/* ── shared helpers (mirrors run-parser.mjs) ─────────────────────────────── */
function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}
function parseComponents(raw) {
  if (Array.isArray(raw)) return raw.map(x => String(x).trim()).filter(Boolean);
  if (!raw) return [];
  return String(raw).split(/[,/]/).map(s => s.trim()).filter(Boolean);
}
function default5eClasses(cls) { return cls ? [cls] : []; }
function toIntOrNull(v, dflt = null) {
  if (v === null || v === undefined || v === '') return dflt;
  if (Number.isInteger(v)) return v;
  const m = String(v).match(/-?\d+/);
  return m ? Number(m[0]) : dflt;
}
function str(v) { return v == null ? '' : String(v); }
function splitPowerScore(raw) {
  if (raw == null || String(raw).trim() === '') return { stat: null, mod: null };
  const m = String(raw).trim().match(/^([A-Za-z]{2,4})\s*([-+]?\d+)?$/);
  if (m) return { stat: m[1], mod: m[2] ?? null };
  return { stat: String(raw).trim(), mod: null };
}
function parsePspCost(raw) {
  if (raw == null || String(raw).trim() === '' || String(raw).trim() === '—') return { pspCost: null, success: null, failure: null };
  const s = String(raw).trim();
  const ints = s.match(/\d+/g);                                   // handles 9+/5+, 4/hour/2, 6+/day/3+
  if (!ints) return { pspCost: s, success: null, failure: null }; // e.g. "varies"
  if (ints.length >= 2) return { pspCost: s, success: Number(ints[0]), failure: Number(ints[ints.length - 1]) };
  return { pspCost: s, success: Number(ints[0]), failure: null };
}
function detectRuleset(src) { return /\brev(?:ised)?\b|-rev/i.test(String(src || '')) ? 'revised' : '2e'; }
function parseMac(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const m = String(raw).trim().match(/-?\d+/);
  return m ? Number(m[0]) : null;
}
function normPrereq(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null || String(raw).trim() === '') return [];
  const arr = String(raw).split(/[,;]|\band\b/i).map(x => x.trim()).filter(Boolean);
  if (arr.length === 1 && /^none$/i.test(arr[0])) return ['None'];
  return arr;
}
function buildSpheres(sphereRaw) {
  if (!sphereRaw) return [];
  const raw = String(sphereRaw).trim();
  if (/^all$/i.test(raw) || /^elemental\s*\(\s*all\s*\)$/i.test(raw)) return [{ name: 'Elemental (All)', access: 'Major' }];
  const parts = []; let buf = '', depth = 0;
  for (const ch of raw) {
    if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';') && depth === 0) { if (buf.trim()) parts.push(buf.trim()); buf = ''; }
    else buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  const out = [];
  for (const part of parts) {
    const m = part.match(/^elemental\s*\((.+)\)\s*$/i);
    if (m) {
      const inner = m[1].trim();
      if (/^all$/i.test(inner)) out.push({ name: 'Elemental (All)', access: 'Major' });
      else for (const sub of inner.split(/[|,]/).map(s => s.trim()).filter(Boolean)) out.push({ name: sub, access: 'Major' });
    } else out.push({ name: part.replace(/\s+/g, ' ').trim(), access: 'Major' });
  }
  return out;
}
const spheresToObjects = arr =>
  arr.map(x => (typeof x === 'string' ? { name: x, access: 'Major' } : x)).filter(x => x && x.name);

/* ── record classification ───────────────────────────────────────────────── */
const isPsionicRec = r => r.class === 'Psionic' || r.discipline != null || r.type === 'Science' || r.type === 'Devotion';
const isSnakeCase  = r => r.stats && typeof r.stats === 'object' && r.id == null;   // has stats{} bag, no id
const isSsr        = r => r.id != null && (Array.isArray(r.spheres) || r.discipline != null || Array.isArray(r.sourceBooks));

/* Psionic string fields the schema types as (non-null) strings. */
const PSI_STRING_FIELDS = ['initialCost', 'maintenanceCost', 'range', 'preparationTime', 'areaOfEffect'];

/* ── converters ──────────────────────────────────────────────────────────── */
function convertSnakeSpell(r) {
  const cls = (r.class === 'Priest' || r.class === 'Cleric') ? 'Cleric' : 'Wizard';
  const spheres = Array.isArray(r.spheres) && r.spheres.length ? spheresToObjects(r.spheres) : buildSpheres(r.sphere || '');
  const st = r.stats || {};
  const desc = r.description || (typeof r.full_detail === 'string' ? r.full_detail : '') || r.summary || '';
  const ath = r.athasian_status || 'Core';
  const tags = [];
  if (String(ath).startsWith('New')) tags.push('#new-dark-sun');
  for (const sp of spheres) if (sp.name) tags.push('#' + sp.name.toLowerCase());
  return {
    id: `spell_${slug(r.name)}_2e`,
    name: r.name,
    srdIndex: null,
    level: toIntOrNull(r.level, 0),
    levelName: r.level_name || null,
    school: r.school || null,
    class: cls,
    '5e_classes': default5eClasses(cls),
    spheres,
    castingTime: str(st.casting_time),
    range: str(st.range),
    components: parseComponents(st.components || ''),
    duration: str(st.duration),
    concentration: false,
    ritual: false,
    description: desc,
    higherLevel: null,
    athasianVariant: { modifiedEffect: null, materialComponentAthas: null, defilerCost: 0, planeSource: null },
    flavorLore: '',
    artworkPrompt: '',
    tags,
    relatedEntries: [],
    sourceBooks: r.source ? [r.source] : [],
    verified: false,
    reversible: !!r.reversible,
    areaOfEffect: str(st.area_of_effect),
    savingThrow: str(st.saving_throw),
    athasianStatus: ath,
    summary: r.summary || (desc.length > 160 ? desc.slice(0, 157) + '…' : desc),
    page: r.page ?? null,
    preparationTime: str(st.preparation_time),
    originalSource: r.source || null,
  };
}

function convertSnakePower(r) {
  const st = r.stats || {};
  const { stat, mod } = splitPowerScore(st.power_score);
  const tier = r.high_science ? 'High Science' : (r.type || r.tier || null);
  const src = Array.isArray(r.sources) ? r.sources : (r.sources ? [r.sources] : (r.source ? [r.source] : []));
  const psp = parsePspCost(st.psp_cost);
  return {
    id: `psionic_${slug(r.name)}_2e`,
    name: r.name,
    class: 'Psionic',
    '5e_classes': [],
    discipline: r.discipline || null,
    tier,
    level: null,
    powerScoreStat: stat,
    powerScoreMod: mod,
    initialCost: str(st.initial_cost),
    maintenanceCost: str(st.maintenance_cost),
    mac: parseMac(st.mac),
    pspCost: psp.pspCost,
    pspCostSuccess: psp.success,
    pspCostFailure: psp.failure,
    range: str(st.range),
    preparationTime: str(st.preparation_time),
    areaOfEffect: str(st.area_of_effect),
    prerequisites: normPrereq(st.prerequisites),
    description: r.description || r.summary || '',
    page: r.page ?? null,
    sourceBooks: src,
    verified: false,
    originalSource: src[0] || null,
    ruleset: detectRuleset(src[0] || ''),
  };
}

/** Backfill an already-SSR record to v2 (idempotent; never clobbers real data). */
function upgradeSsr(r) {
  const out = { ...r };
  // level must be integer|null
  if (out.level !== undefined && out.level !== null && !Number.isInteger(out.level)) {
    out.level = toIntOrNull(out.level, isPsionicRec(out) ? null : 0);
  }
  if (isPsionicRec(out)) {
    if (!Array.isArray(out['5e_classes'])) out['5e_classes'] = [];
    if (out.powerScoreStat === undefined && out.powerScoreMod === undefined && out.powerScore != null) {
      const { stat, mod } = splitPowerScore(out.powerScore);
      out.powerScoreStat = stat; out.powerScoreMod = mod;
      delete out.powerScore;
    }
    if (out.powerScoreStat === undefined) out.powerScoreStat = null;
    if (out.powerScoreMod === undefined) out.powerScoreMod = null;
    if (!Array.isArray(out.prerequisites)) out.prerequisites = normPrereq(out.prerequisites);
    if (out.pspCost !== undefined) {
      const psp = parsePspCost(out.pspCost);
      out.pspCost = psp.pspCost; out.pspCostSuccess = psp.success; out.pspCostFailure = psp.failure;
    } else {
      if (out.pspCost === undefined) out.pspCost = null;
      if (out.pspCostSuccess === undefined) out.pspCostSuccess = null;
      if (out.pspCostFailure === undefined) out.pspCostFailure = null;
    }
    out.mac = (out.mac === undefined) ? null : parseMac(out.mac);
    if (out.ruleset === undefined) out.ruleset = detectRuleset(out.originalSource || (out.sourceBooks || [])[0] || '');
    // schema types these as (non-null) strings — normalise nulls to ''
    for (const k of PSI_STRING_FIELDS) if (k in out) out[k] = str(out[k]);
  } else {
    if (!Array.isArray(out['5e_classes'])) {
      const cls = (out.class === 'Priest' || out.class === 'Cleric') ? 'Cleric' : 'Wizard';
      out['5e_classes'] = default5eClasses(cls);
    }
  }
  return out;
}

function convertRecord(r) {
  if (isSsr(r)) return upgradeSsr(r);
  if (isPsionicRec(r)) return convertSnakePower(r);
  return convertSnakeSpell(r);
}

/* ── extract the record list out of any supported top-level shape ─────────── */
function extractRecords(json) {
  if (Array.isArray(json) && json.length && Array.isArray(json[0]?.spells)) return json.flatMap(g => g.spells);
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.spells)) return json.spells;
  if (json && Array.isArray(json.powers)) return json.powers;
  throw new Error('Unrecognised JSON shape (no array, .spells, or .powers).');
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
let cliOut = null;
const inputs = [];
for (const a of args) {
  if (a.startsWith('--out=')) cliOut = a.slice(6);
  else if (!a.startsWith('--')) inputs.push(a);
}
if (!inputs.length) {
  console.error('Usage: node migrate-to-v2.mjs [--out=combined-v2.json] file1.json [file2.json …]');
  process.exit(1);
}

const all = [];
const srcLabels = [];
let spellN = 0, psiN = 0;
for (const inp of inputs) {
  const json = JSON.parse(await readFile(inp, 'utf8'));
  const recs = extractRecords(json);
  if (json && json.title) srcLabels.push(json.title);
  for (const r of recs) {
    const v2 = convertRecord(r);
    if (v2.class === 'Psionic') psiN++; else spellN++;
    all.push(v2);
  }
  console.log(`  ${basename(inp)}: ${recs.length} record(s)`);
}

const payload = {
  schemaVersion: SCHEMA_VERSION,
  generator: 'migrate-to-v2.mjs',
  generatedAt: new Date().toISOString(),
  sources: srcLabels.length ? srcLabels : undefined,
  recordCount: all.length,
  spells: all,
};

const outPath = cliOut
  ? resolve(cliOut)
  : join(dirname(resolve(inputs[0])), basename(inputs[0]).replace(/\.json$/i, '') + '.v2.json');
await writeFile(outPath, JSON.stringify(payload, null, 2));
console.log(`\nWrote ${all.length} v${SCHEMA_VERSION} records → ${outPath}`);
console.log(`  Spells: ${spellN} · Psionic powers: ${psiN}`);
