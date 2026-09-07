/**
 * migrate-to-v3.6.mjs
 *
 * Migrates mixed 3.5-era spell/power JSON into the clean 3.6 schema.
 *
 * Key changes:
 *   - Flat root object (no outer array)
 *   - Flat spells[] and psionics[] (no Arcane/Divine wrappers)
 *   - Consistent field names
 *   - rulesets  → mechanical overrides   (object keyed by code)
 *   - campaignSettings → world/flavor overrides (object keyed by code)
 *   - Normalized sourceBooks, school, classes, etc.
 *   - Legacy fields stripped
 *
 * Usage:
 *   node migrate-to-v3.6.mjs
 *   node migrate-to-v3.6.mjs --in=path/to/old.json --out=path/to/new.json
 *   node migrate-to-v3.6.mjs --in=Reference/ --out=Reference/v3.6/
 *
 * Zero external dependencies. Works on Node 18+.
 */

import { readFile, writeFile, readdir, mkdir, stat } from 'fs/promises';
import { resolve, basename, join, extname } from 'path';

// ── Defaults ──────────────────────────────────────────────────────────────
const DEFAULT_IN  = 'Reference/Spells-Powers-Combined-DarkSun.json';
const DEFAULT_OUT = 'Reference/Spells-Powers-v3.6.json';

// ── Catalogs written into every output document ───────────────────────────
const RULESET_CATALOG = [
  { code: '2e',     name: 'AD&D 2nd Edition',                                          alias: ['AD&D 2e'] },
  { code: '2e-rev', name: "Player's Option: Skills & Powers / Dark Sun Revised",       alias: ['Skills & Powers', 'DSCS Revised', 'xr'] },
  { code: '5e',     name: 'D&D 5th Edition',                                           alias: ['5e'] },
];

const CAMPAIGN_CATALOG = [
  { code: 'xx', name: 'Generic / Core' },
  { code: 'ds', name: 'Dark Sun (Athas)' },
  { code: 'fr', name: 'Forgotten Realms' },
];

// ── Old → new code maps ───────────────────────────────────────────────────
const RULESET_MAP = {
  xx: '2e',
  adnd2e: '2e',
  '2e': '2e',
  xr: '2e-rev',
  revised: '2e-rev',
  '2e-rev': '2e-rev',
  'skills-powers': '2e-rev',
  '5e': '5e',
  fifth: '5e',
};

const SETTING_MAP = {
  xx: 'xx',
  ds: 'ds',
  fr: 'fr',
  athas: 'ds',
  'dark-sun': 'ds',
  'forgotten-realms': 'fr',
};

// Fields that belong exclusively to mechanical rulesets
const MECHANICAL_FIELDS = new Set([
  'range', 'components', 'duration', 'castingTime', 'areaOfEffect',
  'savingThrow', 'materialComponent', 'preparationTime', 'concentration',
  'ritual', 'higherLevel', 'description', 'summary',
  'initialCost', 'maintenanceCost', 'powerScore', 'powerScoreStat',
  'powerScoreMod', 'powerScoreEffect', 'natural20', 'mac',
  'pspCost', 'pspCostSuccess', 'pspCostFailure', 'prerequisites',
  'level', // for 5e conversion of classic powers
]);

// Fields that belong exclusively to campaign settings
const SETTING_FIELDS = new Set([
  'athasianStatus', 'defilerCost', 'flavorLore',
  'materialComponentAthas', 'planeSource', 'modifiedEffect',
]);

// Fields we never want in the final record
const STRIP_FIELDS = new Set([
  'athasianVariant', 'originalSource', 'page', 'sphere',
  'class', 'charClass', '5e_classes', 'allowedSettings',
  'allowedCampaignSettings', // will be rebuilt
  'ruleset', // old singular key
]);

// ── Helpers ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { in: DEFAULT_IN, out: DEFAULT_OUT };
  for (const a of argv) {
    if (a.startsWith('--in='))  out.in  = a.slice(5);
    else if (a.startsWith('--out=')) out.out = a.slice(6);
  }
  return out;
}

function uniq(arr) {
  const seen = new Set();
  const res = [];
  for (const v of arr) {
    const k = String(v || '').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    res.push(k);
  }
  return res;
}

function mapRuleset(code) {
  return RULESET_MAP[String(code || '').toLowerCase()] || null;
}

function mapSetting(code) {
  return SETTING_MAP[String(code || '').toLowerCase()] || null;
}

function normalizeSchool(val) {
  if (val == null) return null;
  if (Array.isArray(val)) return val.filter(Boolean).join(', ') || null;
  return String(val).trim() || null;
}

function normalizeClasses(rec) {
  const raw = rec.classes ?? rec.charClass ?? rec['5e_classes'] ?? rec.class ?? [];
  if (typeof raw === 'string') {
    if (raw.toLowerCase() === 'psionic') return [];
    return [raw];
  }
  if (Array.isArray(raw)) {
    return uniq(raw.filter(c => c && String(c).toLowerCase() !== 'psionic'));
  }
  return [];
}

function normalizeSourceBooks(val, fallbackPage) {
  if (!val) return [];
  const list = Array.isArray(val) ? val : [val];
  return list.map(item => {
    if (item && typeof item === 'object' && item.source) {
      return {
        source: String(item.source).trim(),
        page: item.page != null ? String(item.page) : (fallbackPage != null ? String(fallbackPage) : undefined),
      };
    }
    return {
      source: String(item).trim(),
      page: fallbackPage != null ? String(fallbackPage) : undefined,
    };
  }).filter(b => b.source);
}

function isPsionic(rec) {
  return (
    rec?.discipline != null ||
    rec?.tier != null ||
    (typeof rec?.class === 'string' && rec.class.toLowerCase() === 'psionic') ||
    (Array.isArray(rec?.class) && rec.class.some(c => String(c).toLowerCase() === 'psionic'))
  );
}

function detectTradition(rec) {
  if (isPsionic(rec)) return 'psionic';
  const cls = normalizeClasses(rec).map(c => c.toLowerCase());
  if (cls.some(c => /cleric|druid|priest|templar|elemental/.test(c))) return 'divine';
  if (rec.spheres && Array.isArray(rec.spheres) && rec.spheres.length) return 'divine';
  return 'arcane';
}

function cleanObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// ── Core migration for a single spell ─────────────────────────────────────
function migrateSpell(raw) {
  const rec = { ...raw };

  // Identity
  const id = rec.id || `spell_${(rec.name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  const name = rec.name || 'Unnamed Spell';

  // Base mechanical fields
  const base = {
    id,
    name,
    level: rec.level ?? null,
    school: normalizeSchool(rec.school),
    tradition: detectTradition(rec),
    classes: normalizeClasses(rec),
    spheres: Array.isArray(rec.spheres) ? rec.spheres : (rec.sphere ? [rec.sphere] : []),
    reversible: Boolean(rec.reversible),

    range: rec.range ?? null,
    components: Array.isArray(rec.components) ? rec.components : (rec.components ? [rec.components] : []),
    duration: rec.duration ?? null,
    castingTime: rec.castingTime ?? null,
    areaOfEffect: rec.areaOfEffect ?? null,
    savingThrow: rec.savingThrow ?? null,
    materialComponent: rec.materialComponent ?? null,
    preparationTime: rec.preparationTime ?? null,
    concentration: Boolean(rec.concentration),
    ritual: Boolean(rec.ritual),
    higherLevel: rec.higherLevel ?? null,
    description: rec.description ?? '',
    summary: rec.summary ?? '',

    tags: Array.isArray(rec.tags) ? rec.tags : [],
    artworkPrompt: rec.artworkPrompt ?? null,
    sourceBooks: normalizeSourceBooks(rec.sourceBooks, rec.page),
    relatedEntries: Array.isArray(rec.relatedEntries) ? rec.relatedEntries : [],
    verified: Boolean(rec.verified),
  };

  // Allowed lists
  const allowedRulesets = uniq(
    (rec.allowedRulesets || [])
      .map(mapRuleset)
      .filter(Boolean)
  );
  if (!allowedRulesets.length) {
    // Heuristic: classic 2e material defaults to 2e
    allowedRulesets.push('2e');
  }

  const allowedCampaignSettings = uniq(
    (rec.allowedCampaignSettings || rec.allowedSettings || [])
      .map(mapSetting)
      .filter(Boolean)
  );
  if (!allowedCampaignSettings.length) {
    allowedCampaignSettings.push('xx');
  }

  // ── rulesets bag ────────────────────────────────────────────────────────
  const rulesets = {};

  // Migrate any existing rulesets object / array
  if (rec.rulesets && typeof rec.rulesets === 'object') {
    if (Array.isArray(rec.rulesets)) {
      for (const entry of rec.rulesets) {
        if (!entry || typeof entry !== 'object') continue;
        for (const [k, v] of Object.entries(entry)) {
          const code = mapRuleset(k);
          if (code && v && typeof v === 'object') rulesets[code] = { ...v };
        }
      }
    } else {
      for (const [k, v] of Object.entries(rec.rulesets)) {
        const code = mapRuleset(k);
        if (code && v && typeof v === 'object') rulesets[code] = { ...v };
      }
    }
  }

  // Old singular "ruleset" key
  if (rec.ruleset && typeof rec.ruleset === 'object' && !Array.isArray(rec.ruleset)) {
    for (const [k, v] of Object.entries(rec.ruleset)) {
      const code = mapRuleset(k);
      if (code && v && typeof v === 'object') {
        rulesets[code] = { ...(rulesets[code] || {}), ...v };
      }
    }
  }

  // ── campaignSettings bag ────────────────────────────────────────────────
  const campaignSettings = {};

  if (rec.campaignSettings && typeof rec.campaignSettings === 'object' && !Array.isArray(rec.campaignSettings)) {
    for (const [k, v] of Object.entries(rec.campaignSettings)) {
      const code = mapSetting(k);
      if (code && v && typeof v === 'object') {
        campaignSettings[code] = { ...v };
      }
    }
  }

  // Lift legacy Athas fields into campaignSettings.ds
  const ds = { ...(campaignSettings.ds || {}) };
  if (rec.athasianStatus && ds.athasianStatus === undefined) {
    ds.athasianStatus = rec.athasianStatus;
  }
  if (rec.athasianVariant && typeof rec.athasianVariant === 'object') {
    const av = rec.athasianVariant;
    if (av.defilerCost != null && ds.defilerCost === undefined) ds.defilerCost = av.defilerCost;
    if (av.materialComponentAthas && ds.materialComponent === undefined) {
      ds.materialComponent = av.materialComponentAthas;
    }
    if (av.modifiedEffect && ds.modifiedEffect === undefined) ds.modifiedEffect = av.modifiedEffect;
    if (av.planeSource && ds.planeSource === undefined) ds.planeSource = av.planeSource;
  }
  if (Object.keys(ds).length) campaignSettings.ds = ds;

  // Ensure Dark Sun appears in allowed list if we have DS-specific data
  if (campaignSettings.ds && !allowedCampaignSettings.includes('ds')) {
    allowedCampaignSettings.push('ds');
  }

  // Final assembly
  const result = {
    ...base,
    allowedRulesets,
    allowedCampaignSettings,
    rulesets: cleanObject(rulesets),
    campaignSettings: cleanObject(campaignSettings),
  };

  // Remove empty bags for cleanliness
  if (!Object.keys(result.rulesets).length) delete result.rulesets;
  if (!Object.keys(result.campaignSettings).length) delete result.campaignSettings;

  return result;
}

// ── Core migration for a single psionic power ─────────────────────────────
function migratePower(raw) {
  const rec = { ...raw };

  const id = rec.id || `psionic_${(rec.name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  const name = rec.name || 'Unnamed Power';

  const base = {
    id,
    name,
    discipline: rec.discipline ?? null,
    tier: rec.tier ?? null,               // Devotion | Science
    level: rec.level ?? null,
    range: rec.range ?? null,
    areaOfEffect: rec.areaOfEffect ?? null,

    tags: Array.isArray(rec.tags) ? rec.tags : [],
    artworkPrompt: rec.artworkPrompt ?? null,
    relatedEntries: Array.isArray(rec.relatedEntries) ? rec.relatedEntries : [],
    verified: Boolean(rec.verified),
  };

  // Allowed lists
  let allowedRulesets = uniq(
    (rec.allowedRulesets || rec.allowedRuleset || [])
      .map(mapRuleset)
      .filter(Boolean)
  );
  if (!allowedRulesets.length) {
    // Most classic powers exist in both 2e and 2e-rev
    allowedRulesets = ['2e', '2e-rev'];
  }

  const allowedCampaignSettings = uniq(
    (rec.allowedCampaignSettings || rec.allowedSettings || [])
      .map(mapSetting)
      .filter(Boolean)
  );
  if (!allowedCampaignSettings.length) {
    allowedCampaignSettings.push('ds', 'xx');
  }

  // ── rulesets bag ────────────────────────────────────────────────────────
  const rulesets = {};

  // Handle the awkward array-of-single-key-objects form from the draft
  if (Array.isArray(rec.rulesets)) {
    for (const entry of rec.rulesets) {
      if (!entry || typeof entry !== 'object') continue;
      for (const [k, v] of Object.entries(entry)) {
        const code = mapRuleset(k);
        if (code && v && typeof v === 'object') {
          rulesets[code] = normalizePowerRuleset(v);
        }
      }
    }
  } else if (rec.rulesets && typeof rec.rulesets === 'object') {
    for (const [k, v] of Object.entries(rec.rulesets)) {
      const code = mapRuleset(k);
      if (code && v && typeof v === 'object') {
        rulesets[code] = normalizePowerRuleset(v);
      }
    }
  }

  // Old singular "ruleset" key
  if (rec.ruleset && typeof rec.ruleset === 'object' && !Array.isArray(rec.ruleset)) {
    for (const [k, v] of Object.entries(rec.ruleset)) {
      const code = mapRuleset(k);
      if (code && v && typeof v === 'object') {
        rulesets[code] = { ...(rulesets[code] || {}), ...normalizePowerRuleset(v) };
      }
    }
  }

  // If we still have no ruleset data, try to lift top-level mechanical fields
  // into the primary ruleset (usually 2e)
  if (!Object.keys(rulesets).length) {
    const lifted = normalizePowerRuleset(rec);
    if (Object.keys(lifted).length) {
      rulesets['2e'] = lifted;
    }
  }

  // ── campaignSettings bag ────────────────────────────────────────────────
  const campaignSettings = {};
  if (rec.campaignSettings && typeof rec.campaignSettings === 'object' && !Array.isArray(rec.campaignSettings)) {
    for (const [k, v] of Object.entries(rec.campaignSettings)) {
      const code = mapSetting(k);
      if (code && v && typeof v === 'object') {
        campaignSettings[code] = { ...v };
      }
    }
  }

  const result = {
    ...base,
    allowedRulesets,
    allowedCampaignSettings,
    rulesets: cleanObject(rulesets),
    campaignSettings: cleanObject(campaignSettings),
  };

  if (!Object.keys(result.rulesets).length) delete result.rulesets;
  if (!Object.keys(result.campaignSettings).length) delete result.campaignSettings;

  return result;
}

function normalizePowerRuleset(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};

  // Common mechanical keys
  const keys = [
    'initialCost', 'maintenanceCost', 'preparationTime', 'prerequisites',
    'powerScore', 'powerScoreStat', 'powerScoreMod', 'powerScoreEffect',
    'natural20', 'mac', 'pspCost', 'pspCostSuccess', 'pspCostFailure',
    'description', 'range', 'areaOfEffect', 'sourceBooks',
  ];

  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      out[k] = obj[k];
    }
  }

  // Normalize sourceBooks inside the ruleset bag
  if (out.sourceBooks) {
    out.sourceBooks = normalizeSourceBooks(out.sourceBooks);
  }

  // Normalize prerequisites to array of strings
  if (out.prerequisites) {
    if (typeof out.prerequisites === 'string') {
      out.prerequisites = out.prerequisites.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    } else if (!Array.isArray(out.prerequisites)) {
      delete out.prerequisites;
    }
  }

  // Handle the odd "20" key that sometimes appeared
  if (obj['20'] && !out.natural20) {
    out.natural20 = obj['20'];
  }

  return out;
}

// ── Document-level migration ──────────────────────────────────────────────
function migrateDocument(raw) {
  const spells = [];
  const powers = [];

  // ── Case 0: top-level array of individual spell/power records ────────────
  // (this is the shape of Spells-Powers-Combined-DarkSun.json — 1300+ records)
  if (Array.isArray(raw) && raw.length > 0 && raw[0]?.id && raw[0]?.name) {
    for (const rec of raw) {
      if (!rec || typeof rec !== 'object') continue;
      if (isPsionic(rec)) powers.push(migratePower(rec));
      else spells.push(migrateSpell(rec));
    }
  } else {
    // Accept either a plain object or an array that wraps a single document
    let doc = Array.isArray(raw) ? (raw[0] || {}) : raw;
    if (!doc || typeof doc !== 'object') {
      throw new Error('Input is not a valid document object');
    }

    // Case 1: already flat spells[] / psionics[]
    if (Array.isArray(doc.spells)) {
      for (const s of doc.spells) {
        if (s && typeof s === 'object') {
          if (isPsionic(s)) powers.push(migratePower(s));
          else spells.push(migrateSpell(s));
        }
      }
    }

    // Case 2: nested under class wrappers  [{ class: "Arcane", spells: [...] }, ...]
    if (Array.isArray(doc.spells) && doc.spells.length && doc.spells[0]?.spells) {
      spells.length = 0;
      powers.length = 0;
      for (const wrapper of doc.spells) {
        if (!wrapper || !Array.isArray(wrapper.spells)) continue;
        const traditionHint = (wrapper.class || '').toLowerCase();
        for (const s of wrapper.spells) {
          if (!s || typeof s !== 'object') continue;
          if (isPsionic(s) || traditionHint === 'psionic') {
            powers.push(migratePower(s));
          } else {
            const migrated = migrateSpell(s);
            if (traditionHint === 'divine' || traditionHint === 'arcane') {
              migrated.tradition = traditionHint;
            }
            spells.push(migrated);
          }
        }
      }
    }

    // Case 3: dedicated psionics array (possibly nested)
    if (Array.isArray(doc.psionics)) {
      for (const entry of doc.psionics) {
        if (!entry) continue;
        if (Array.isArray(entry.powers)) {
          for (const p of entry.powers) {
            if (p && typeof p === 'object') powers.push(migratePower(p));
          }
        } else if (isPsionic(entry) || entry.discipline) {
          powers.push(migratePower(entry));
        }
      }
    }
  }

  // Deduplicate by id (last one wins)
  const spellMap = new Map();
  for (const s of spells) spellMap.set(s.id, s);
  const powerMap = new Map();
  for (const p of powers) powerMap.set(p.id, p);

  return {
    schemaVersion: '3.6.0',
    dateUpdated: new Date().toISOString().slice(0, 10),
    rulesets: RULESET_CATALOG,
    campaignSettings: CAMPAIGN_CATALOG,
    spells: [...spellMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    psionics: [...powerMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ── File / directory handling ─────────────────────────────────────────────
async function processFile(inPath, outPath) {
  console.log(`→ Reading ${inPath}`);
  const text = await readFile(inPath, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${inPath}: ${err.message}`);
  }

  const migrated = migrateDocument(raw);

  await mkdir(resolve(outPath, '..'), { recursive: true });
  await writeFile(outPath, JSON.stringify(migrated, null, 2) + '\n', 'utf8');

  console.log(`  ✓ ${migrated.spells.length} spells, ${migrated.psionics.length} powers → ${outPath}`);
  return migrated;
}

async function processPath(inPath, outPath) {
  const st = await stat(inPath);
  if (st.isFile()) {
    return processFile(inPath, outPath);
  }

  if (st.isDirectory()) {
    await mkdir(outPath, { recursive: true });
    const entries = await readdir(inPath);
    const results = [];
    for (const name of entries) {
      if (extname(name).toLowerCase() !== '.json') continue;
      const src = join(inPath, name);
      const dst = join(outPath, name.replace(/\.json$/i, '.v3.6.json'));
      results.push(await processFile(src, dst));
    }
    return results;
  }

  throw new Error(`Path is neither file nor directory: ${inPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inPath  = resolve(args.in);
  const outPath = resolve(args.out);

  console.log('Depp-Magic migrate-to-v3.6');
  console.log(`  in : ${inPath}`);
  console.log(`  out: ${outPath}`);
  console.log('');

  try {
    await processPath(inPath, outPath);
    console.log('\nDone.');
  } catch (err) {
    console.error('\nMigration failed:', err.message);
    process.exit(1);
  }
}

main();
