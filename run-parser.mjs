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
const SECTION_LEVEL_RE = /^(?<Ordinal>First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth|Thirteenth|\d{1,2}(?:st|nd|rd|th))-Level\s+(?:(?:Priest|Wizard|Mage|Cleric|Druid|Defiler|Preserver)\s+)?(?:Spells?|Psionic)/i;
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

// ── Field name normalisation ─────────────────────────────────────────────────

function normaliseFieldKey(raw) {
  const k = raw.replace(/\s+/g, '').toLowerCase();
  if (k === 'castingtime' || k === 'casting') return 'castingTime';
  if (k === 'areaofeffect' || k === 'area') return 'areaOfEffect';
  if (k === 'savingthrow' || k === 'saving') return 'savingThrow';
  if (k === 'preparationtime' || k === 'preparation') return 'preparationTime';
  if (k === 'component' || k === 'components') return 'components';
  return k;
}

// ── Main extraction ──────────────────────────────────────────────────────────

async function extractSpellsFromPDF(pdfPath, startPage = null, endPage = null) {
  const data = new Uint8Array(await readFile(pdfPath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const spells = [];
  let currentLevel = null;
  let currentSource = basename(pdfPath, '.pdf');
  let inPsionicSection = false;
  let blockLevel = null;
  let blockPsionic = false;

  const totalPages = pdf.numPages;
  const firstPage = startPage ?? 1;
  const lastPage = endPage ?? totalPages;

  for (let pageNum = firstPage; pageNum <= lastPage; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = textContent.items;

    // Column detection
    const pageWidth = page.view[2] - page.view[0];
    const midline = page.view[0] + pageWidth / 2;
    let crossing = 0;
    for (const item of items) {
      if (item.transform && item.transform[4] > midline - 10 && item.transform[4] < midline + 10) crossing++;
    }
    const twoColumn = crossing / items.length < 0.05;

    let leftItems = [], rightItems = [];
    if (twoColumn) {
      for (const item of items) {
        if (item.transform) {
          if (item.transform[4] < midline) leftItems.push(item);
          else rightItems.push(item);
        }
      }
    } else {
      leftItems = items;
    }

    const lines = [];
    const makeLine = (arr) => {
      arr.sort((a, b) => a.transform[5] - b.transform[5] || a.transform[4] - b.transform[4]);
      let currentY = null, buf = '';
      for (const it of arr) {
        const y = Math.round(it.transform[5]);
        if (currentY === null) currentY = y;
        if (Math.abs(y - currentY) > 3) {
          if (buf.trim()) lines.push(buf.trim());
          buf = it.str;
          currentY = y;
        } else {
          buf += ' ' + it.str;
        }
      }
      if (buf.trim()) lines.push(buf.trim());
    };

    makeLine(leftItems);
    if (twoColumn) makeLine(rightItems);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || JUNK_LINE_RE.test(line)) continue;

      // Section level heading
      const levelMatch = line.match(SECTION_LEVEL_RE);
      if (levelMatch) {
        const ord = levelMatch.groups.Ordinal;
        currentLevel = ordinalToLevel(ord);
        inPsionicSection = PSIONIC_SECTION_RE.test(line);
        blockLevel = currentLevel;
        blockPsionic = inPsionicSection;
        continue;
      }

      // Psionic section
      if (PSIONIC_SECTION_RE.test(line)) {
        inPsionicSection = true;
        blockPsionic = true;
        continue;
      }

      // Two-line header: name then (School)
      if (NAME_ONLY_RE.test(line) && i + 1 < lines.length) {
        const schoolLine = lines[i + 1];
        const schoolMatch = schoolLine.match(SCHOOL_ONLY_RE);
        if (schoolMatch) {
          const name = collapseLetterSpacing(line);
          const school = schoolMatch.groups.School.trim();
          const isReversible = /Reversible/i.test(schoolLine);
          spells.push({
            name, school, level: blockLevel ?? currentLevel,
            castingTime: null, range: null, components: null, duration: null,
            savingThrow: null, areaOfEffect: null, preparationTime: null,
            description: '', page: pageNum, source: currentSource,
            reversible: isReversible, verified: false,
            sphere: null
          });
          i++;
          continue;
        }
      }

      // Single-line header
      const headerMatch = line.match(SPELL_HEADER_RE);
      if (headerMatch) {
        const name = collapseLetterSpacing(headerMatch.groups.Name.trim());
        const school = headerMatch.groups.School.trim();
        const isReversible = /Reversible/i.test(line);
        spells.push({
          name, school, level: blockLevel ?? currentLevel,
          castingTime: null, range: null, components: null, duration: null,
          savingThrow: null, areaOfEffect: null, preparationTime: null,
          description: '', page: pageNum, source: currentSource,
          reversible: isReversible, verified: false,
          sphere: null
        });
        continue;
      }

      // Field lines
      const fields = extractFields(line);
      if (fields && spells.length) {
        const spell = spells[spells.length - 1];
        for (const [key, val] of fields) {
          if (spell[key] === null || spell[key] === undefined) spell[key] = val;
        }
        continue;
      }

      // Description accumulation
      if (spells.length) {
        const spell = spells[spells.length - 1];
        if (!spell.description) spell.description = line;
        else spell.description += ' ' + line;
      }
    }
  }

  // Post-process: clean descriptions
  for (const spell of spells) {
    if (spell.description) {
      spell.description = spell.description
        .replace(/\|/g, '1 ')
        .replace(/(\w)-\s+(\w)/g, '$1$2')
        .trim();
    }
  }

  return spells;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let start = null, end = null, outPath = null;
const pdfs = [];

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--start=')) start = parseInt(args[i].split('=')[1]);
  else if (args[i].startsWith('--end=')) end = parseInt(args[i].split('=')[1]);
  else if (args[i].startsWith('--out=')) outPath = args[i].split('=')[1];
  else pdfs.push(args[i]);
}

if (!pdfs.length) {
  pdfs.push(join(__dirname, '04-DragonKings.pdf'));
  if (start === null) start = 83;
  if (end === null) end = 162;
}

const allSpells = [];
for (const pdf of pdfs) {
  console.log(`Parsing ${pdf} ...`);
  const spells = await extractSpellsFromPDF(pdf, start, end);
  allSpells.push({ file: basename(pdf), spells });
  console.log(`  → ${spells.length} entries`);
}

if (outPath) {
  const dir = dirname(resolve(outPath));
  mkdirSync(dir, { recursive: true });
  await writeFile(outPath, JSON.stringify(allSpells, null, 2));
  console.log(`Wrote ${outPath}`);
} else {
  await writeFile(join(__dirname, 'output/parsed-spells.json'), JSON.stringify(allSpells, null, 2));
  console.log('Wrote output/parsed-spells.json');
}
