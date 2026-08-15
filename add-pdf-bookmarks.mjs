/**
 * add-pdf-bookmarks.mjs  –  Inject PDF bookmarks into the 26-book AD&D 2e collection
 * ══════════════════════════════════════════════════════════════════════════════════════
 * Reads the DnD2e-FullText-ToC.md, scans each book's page range for chapter headings,
 * then injects a full PDF outline (bookmarks) into the 3,963-page compilation PDF
 * using pdf-lib.
 *
 * Requires:  npm install pdf-lib
 *            (pdfjs-dist already required for chapter scanning — same as run-parser.mjs)
 *
 * Usage:
 *   node add-pdf-bookmarks.mjs [options]
 *
 * Options:
 *   --pdf=path        path to input PDF  (default: see DEFAULT_PDF below)
 *   --toc=path        path to ToC markdown (default: see DEFAULT_TOC below)
 *   --out=path        output PDF path     (default: <input-dir>/<stem>-bookmarked.pdf)
 *   --no-chapters     skip chapter-level scanning; add book-level bookmarks only
 *   --scan-only       scan for chapters and print results; don't modify the PDF
 *   --cache=path      JSON file to cache chapter-scan results (default: <out>.chapters.json)
 *   --force-rescan    ignore existing chapter cache and rescan
 *   --verbose         print each bookmark as it is added
 *
 * Chapter detection heuristics (best-effort):
 *   • "Chapter N[: Title]" or "Chapter One/Two/..." — explicit chapter markers
 *   • "Part N" or "Part One/Two/..."
 *   • "Appendix [Letter][: Title]"
 *   • Mythology group headers in Legends & Lore ("Celtic Mythology", "Norse Mythology", etc.)
 *   Scans the first 5 lines of every page within each book's range.
 *
 * Memory note:
 *   pdf-lib loads the entire PDF into memory to rewrite the outline.  For the 16 MB
 *   26-book collection, expect ~150–300 MB peak RAM.  The output file is roughly the
 *   same size as the input.
 */

import { readFile, writeFile, access } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, basename, resolve, extname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Default paths ─────────────────────────────────────────────────────────────
const DEFAULT_PDF =
  'L:\\Public\\DNDFinal\\D&D\\AD&D 2nd Edition\\Dark Sun\\better-copies\\' +
  'Full text of _Dungeons and Dragons, Second Edition, All 26 Books_.pdf';
const DEFAULT_TOC = '/mnt/bnkr-public/Bunsen/DnD2e-FullText-ToC.md';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let cliPdf        = null;
let cliToc        = null;
let cliOut        = null;
let cliCache      = null;
let noChapters    = false;
let scanOnly      = false;
let forceRescan   = false;
let verbose       = false;

for (const a of args) {
  if      (a.startsWith('--pdf='))    cliPdf      = a.slice(6);
  else if (a.startsWith('--toc='))    cliToc      = a.slice(6);
  else if (a.startsWith('--out='))    cliOut      = a.slice(6);
  else if (a.startsWith('--cache='))  cliCache    = a.slice(8);
  else if (a === '--no-chapters')     noChapters  = true;
  else if (a === '--scan-only')       scanOnly    = true;
  else if (a === '--force-rescan')    forceRescan = true;
  else if (a === '--verbose')         verbose     = true;
}

const pdfPath   = cliPdf  ?? DEFAULT_PDF;
const tocPath   = cliToc  ?? DEFAULT_TOC;
const stem      = basename(pdfPath, extname(pdfPath));
const pdfDir    = dirname(pdfPath);
const outPath   = cliOut  ?? join(pdfDir, `${stem}-bookmarked.pdf`);
const cachePath = cliCache ?? `${outPath}.chapters.json`;

// ── Load pdfjs-dist (for chapter scanning) ────────────────────────────────────
let pdfjsLib;
try {
  pdfjsLib = await import(pathToFileURL(join(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
} catch {
  try {
    pdfjsLib = await import(pathToFileURL(join(__dirname, 'node_modules/pdfjs-dist/build/pdf.mjs')).href);
  } catch {
    console.error('ERROR: pdfjs-dist not found. Run: npm install');
    process.exit(1);
  }
}

// ── Load pdf-lib (for outline injection) ──────────────────────────────────────
let PDFDocument, PDFString, PDFName, PDFNumber;
if (!scanOnly) {
  try {
    const pdfLib = await import('pdf-lib');
    ({ PDFDocument, PDFString, PDFName, PDFNumber } = pdfLib);
  } catch {
    console.error('ERROR: pdf-lib not found. Run: npm install pdf-lib');
    console.error('       (or use --scan-only to just scan for chapters without modifying the PDF)');
    process.exit(1);
  }
}

// ── ToC markdown parser ───────────────────────────────────────────────────────
// Parses the table in DnD2e-FullText-ToC.md.
// Expected row format:  | N | **Title** *(PHBRN)* | start | end | Notes |
async function parseTocMarkdown(path) {
  const text = await readFile(path, 'utf8');
  const books = [];

  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*\d+\s*\|\s*\*\*([^*]+)\*\*(?:[^|]*)?\|\s*~?(\d+)\s*\|\s*~?(\d+)\s*\|/);
    if (!m) continue;
    const title = m[1].replace(/\s*\*\([^)]*\)\*\s*/g, '').trim();
    const start = parseInt(m[2], 10);
    const end   = parseInt(m[3], 10);
    if (title && start && end) books.push({ title, start, end });
  }

  return books;
}

// Hardcoded fallback if markdown parse fails (confirmed page numbers from Joe)
const HARDCODED_TOC = [
  { title: "Player's Handbook",                          start:    1, end:  372 },
  { title: "Dungeon Master's Guide",                     start:  373, end:  673 },
  { title: "Monstrous Manual",                           start:  674, end: 1251 },
  { title: "Complete Book of Dwarves",                   start: 1252, end: 1334 },
  { title: "Complete Book of Elves",                     start: 1335, end: 1416 },
  { title: "Complete Book of Gnomes & Halflings",        start: 1417, end: 1492 },
  { title: "Complete Fighter's Handbook",                start: 1493, end: 1607 },
  { title: "Complete Ranger's Handbook",                 start: 1608, end: 1712 },
  { title: "Complete Paladin's Handbook",                start: 1713, end: 1807 },
  { title: "Complete Wizard's Handbook",                 start: 1808, end: 1927 },
  { title: "Complete Priest's Handbook",                 start: 1928, end: 2042 },
  { title: "Complete Druid's Handbook",                  start: 2043, end: 2122 },
  { title: "Complete Thief's Handbook",                  start: 2123, end: 2254 },
  { title: "Complete Bard's Handbook",                   start: 2255, end: 2340 },
  { title: "Complete Ninja's Handbook",                  start: 2341, end: 2439 },
  { title: "Complete Psionics Handbook",                 start: 2440, end: 2518 },
  { title: "Complete Book of Necromancers",              start: 2518, end: 2624 },
  { title: "Legends & Lore",                            start: 2624, end: 2831 },
  { title: "Tome of Magic",                             start: 2831, end: 3014 },
  { title: "Sages and Specialists",                     start: 3014, end: 3160 },
  { title: "Dungeon Master Option: High-Level Campaigns",start: 3160, end: 3329 },
  { title: "Player's Option: Combat & Tactics",         start: 3330, end: 3504 },
  { title: "Player's Option: Skills & Powers",          start: 3504, end: 3719 },
  { title: "Player's Option: Spells & Magic",           start: 3719, end: 3963 },
];

// ── Chapter heading patterns ──────────────────────────────────────────────────
const JUNK_LINE_RE = /file:\/\/\/|^\d{1,2}\/\d{1,2}\/\d{2,4},\s|Full text of "|^\d+\/\d+$/;

// Strong signals (high confidence)
const CHAPTER_RE = /^(?:Chapter\s+(?:\d{1,2}|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty)(?:\s*[:.\-]\s*|\s+)(?<Title>[A-Z].{0,60})?)$/i;
const PART_RE    = /^Part\s+(?:\d{1,2}|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)(?:\s*[:.\-]\s*|\s+)(?<Title>[A-Z].{0,60})?$/i;
const APPENDIX_RE= /^Appendix\s+(?:[A-Z\d]+)(?:\s*[:.\-]\s*|\s+)(?<Title>[A-Z].{0,60})?$/i;

// Legends & Lore mythology headers
const MYTHOLOGY_RE = /^(?<Title>[A-Z][A-Za-z ]{3,45}(?:Mythology|Pantheon|Heroes and Villains?|Deities|Gods?|Legends?))\s*$/;

// Supplement-specific chapter indicators
const SECTION_HEADER_RE = /^(?<Title>[A-Z][A-Za-z ]{2,45})$/;  // Short all-title-case lines

function collapseLetterSpacing(text) {
  if (!text) return text;
  const parts = text.split(' ');
  if (parts.length > 2 && parts.every(p => p.length <= 1)) return parts.join('');
  return text;
}

async function extractFirstLines(pdfDoc, pageNum, count = 6) {
  try {
    const page    = await pdfDoc.getPage(pageNum);
    const content = await page.getTextContent();
    const items   = content.items.filter(i => i.str?.trim());

    // Sort top-to-bottom (descending Y = higher on page)
    items.sort((a, b) => b.transform[5] - a.transform[5]);

    const lines = [];
    let prevY   = null;
    let curLine = [];

    for (const item of items) {
      const y = Math.round(item.transform[5] / 3) * 3;
      if (prevY !== null && Math.abs(y - prevY) > 4) {
        const txt = collapseLetterSpacing(curLine.join('')).trim();
        if (txt && !JUNK_LINE_RE.test(txt)) lines.push(txt);
        if (lines.length >= count) break;
        curLine = [];
      }
      curLine.push(item.str);
      prevY = y;
    }
    if (curLine.length) {
      const txt = collapseLetterSpacing(curLine.join('')).trim();
      if (txt && !JUNK_LINE_RE.test(txt)) lines.push(txt);
    }

    return lines.slice(0, count);
  } catch {
    return [];
  }
}

// ── Chapter scanner ───────────────────────────────────────────────────────────
async function scanForChapters(pdfPath, books) {
  console.log('\nScanning pages for chapter headings…');
  const data = await readFile(pdfPath);
  const pdf  = await pdfjsLib.getDocument({
    data: new Uint8Array(data.buffer),
    useWorkerFetch: false, isEvalSupported: false,
    useSystemFonts: true, disableFontFace: true, verbosity: 0,
  }).promise;

  const results = [];   // per-book chapter lists

  for (const book of books) {
    process.stdout.write(`  [${book.start}–${book.end}] ${book.title} … `);
    const chapters = [];
    let prevChapterTitle = '';

    for (let p = book.start; p <= Math.min(book.end, pdf.numPages); p++) {
      const lines = await extractFirstLines(pdf, p);

      for (const line of lines) {
        let title = null;
        let confidence = 0;

        const chM = line.match(CHAPTER_RE);
        if (chM) { title = line.trim(); confidence = 3; }

        if (!title) {
          const ptM = line.match(PART_RE);
          if (ptM) { title = line.trim(); confidence = 3; }
        }

        if (!title) {
          const apM = line.match(APPENDIX_RE);
          if (apM) { title = line.trim(); confidence = 3; }
        }

        if (!title) {
          const myM = line.match(MYTHOLOGY_RE);
          if (myM) { title = line.trim(); confidence = 2; }
        }

        if (title && title !== prevChapterTitle) {
          chapters.push({ title, page: p, confidence });
          prevChapterTitle = title;
          if (verbose) console.log(`\n      ch p.${p}: ${title}`);
          break;  // only one chapter heading per page
        }
      }
    }

    console.log(`${chapters.length} chapters`);
    results.push({ ...book, chapters });
  }

  return results;
}

// ── PDF outline injection ─────────────────────────────────────────────────────
async function injectOutline(pdfPath, outPath, booksWithChapters) {
  console.log('\nLoading PDF into pdf-lib…');
  const rawBytes = await readFile(pdfPath);

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(rawBytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    throw new Error(`pdf-lib failed to load PDF: ${e.message}\n` +
                    'The PDF may use unsupported features. Try --no-chapters and retry.');
  }

  const { context, catalog } = pdfDoc;
  const totalPages = pdfDoc.getPageCount();
  console.log(`  Loaded ${totalPages} pages.`);

  // Remove any existing outline
  if (catalog.has(PDFName.of('Outlines'))) {
    catalog.delete(PDFName.of('Outlines'));
  }

  const rootRef = context.nextRef();
  const topRefs = [];

  for (const book of booksWithChapters) {
    const bookPageIdx = Math.max(0, Math.min(book.start - 1, totalPages - 1));
    const bookPage    = pdfDoc.getPage(bookPageIdx);

    const bookRef    = context.nextRef();
    const childRefs  = [];

    // ── Chapter-level children ─────────────────────────────────────────────
    for (const ch of (book.chapters ?? [])) {
      const chPageIdx = Math.max(0, Math.min(ch.page - 1, totalPages - 1));
      const chPage    = pdfDoc.getPage(chPageIdx);
      const chRef     = context.nextRef();

      context.assign(chRef, context.obj({
        Title:  PDFString.of(ch.title),
        Parent: bookRef,
        Dest:   context.obj([chPage.ref, PDFName.of('Fit')]),
      }));
      childRefs.push(chRef);
      if (verbose) console.log(`    ch: ${ch.title} → p.${ch.page}`);
    }

    // Add Prev/Next links between siblings
    for (let j = 0; j < childRefs.length; j++) {
      const obj = context.lookup(childRefs[j]);
      if (j > 0)                      obj.set(PDFName.of('Prev'), childRefs[j - 1]);
      if (j < childRefs.length - 1)  obj.set(PDFName.of('Next'), childRefs[j + 1]);
    }

    // ── Book-level entry ───────────────────────────────────────────────────
    const bookEntry = {
      Title:  PDFString.of(book.title),
      Parent: rootRef,
      Dest:   context.obj([bookPage.ref, PDFName.of('Fit')]),
      Count:  PDFNumber.of(childRefs.length),
    };
    if (childRefs.length > 0) {
      bookEntry.First = childRefs[0];
      bookEntry.Last  = childRefs[childRefs.length - 1];
    }
    context.assign(bookRef, context.obj(bookEntry));
    topRefs.push({ ref: bookRef, childCount: childRefs.length });

    if (verbose) console.log(`  book: ${book.title} → p.${book.start}  (${childRefs.length} chapters)`);
  }

  // Prev/Next between top-level entries
  for (let i = 0; i < topRefs.length; i++) {
    const obj = context.lookup(topRefs[i].ref);
    if (i > 0)                    obj.set(PDFName.of('Prev'), topRefs[i - 1].ref);
    if (i < topRefs.length - 1)  obj.set(PDFName.of('Next'), topRefs[i + 1].ref);
  }

  // Outline root
  const totalCount = topRefs.reduce((s, x) => s + 1 + x.childCount, 0);
  context.assign(rootRef, context.obj({
    Type:  PDFName.of('Outlines'),
    First: topRefs[0].ref,
    Last:  topRefs[topRefs.length - 1].ref,
    Count: PDFNumber.of(totalCount),
  }));

  // Attach to catalog
  catalog.set(PDFName.of('Outlines'), rootRef);
  catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));

  console.log(`\nSaving PDF with ${topRefs.length} book bookmarks, ${totalCount - topRefs.length} chapter bookmarks…`);
  const savedBytes = await pdfDoc.save({ useObjectStreams: false });
  mkdirSync(dirname(outPath), { recursive: true });
  await writeFile(outPath, savedBytes);
  console.log(`✓ Wrote → ${outPath}  (${(savedBytes.length / 1024 / 1024).toFixed(1)} MB)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║        add-pdf-bookmarks.mjs — AD&D 2e 26-book PDF          ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`  PDF:   ${pdfPath}`);
console.log(`  ToC:   ${tocPath}`);
if (!scanOnly) console.log(`  Out:   ${outPath}`);

// Load ToC
let books;
try {
  books = await parseTocMarkdown(tocPath);
  if (books.length < 5) {
    console.warn(`  Warning: parsed only ${books.length} books from ToC markdown; using hardcoded fallback.`);
    books = HARDCODED_TOC;
  } else {
    console.log(`  ToC:   ${books.length} books loaded from markdown.`);
  }
} catch (e) {
  console.warn(`  Warning: could not read ToC markdown (${e.message}); using hardcoded fallback.`);
  books = HARDCODED_TOC;
}

// Chapter scan
let booksWithChapters = books.map(b => ({ ...b, chapters: [] }));

if (!noChapters) {
  // Try cache first
  let cacheHit = false;
  if (!forceRescan && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'));
      if (Array.isArray(cached) && cached.length === books.length) {
        booksWithChapters = cached;
        console.log(`\n  Chapter cache loaded from ${cachePath}`);
        for (const b of booksWithChapters) {
          console.log(`    [${b.start}–${b.end}] ${b.title}: ${b.chapters?.length ?? 0} chapters`);
        }
        cacheHit = true;
      }
    } catch { /* ignore bad cache */ }
  }

  if (!cacheHit) {
    booksWithChapters = await scanForChapters(pdfPath, books);
    // Save cache
    try {
      await writeFile(cachePath, JSON.stringify(booksWithChapters, null, 2));
      console.log(`  Chapter scan cached → ${cachePath}`);
    } catch { /* non-fatal */ }
  }
}

// Summary
const totalChapters = booksWithChapters.reduce((s, b) => s + (b.chapters?.length ?? 0), 0);
console.log(`\nBookmark summary:`);
console.log(`  Books:    ${booksWithChapters.length}`);
console.log(`  Chapters: ${totalChapters}`);
for (const b of booksWithChapters) {
  const chs = b.chapters?.length ?? 0;
  console.log(`  [${String(b.start).padStart(4)}–${String(b.end).padStart(4)}] ${b.title}${chs ? ` (${chs} ch)` : ''}`);
}

if (scanOnly) {
  console.log('\n--scan-only: done. PDF not modified.');
  process.exit(0);
}

// Inject outline
await injectOutline(pdfPath, outPath, booksWithChapters);
console.log('\nDone.');
