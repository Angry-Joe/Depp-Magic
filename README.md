# Depp-Magic

Converter tool to read PDFs and parse out content for Dungeons & Dragons 2nd Edition.

## Parse a file

```
node run-parser.mjs file.pdf
```

That writes `output/parsed-spells.json`. Then open `spell-editor.html` in a
browser and load that file to review and correct the results.

## Version 2

Version 2 drops the original .NET implementation (`DeepMagic.App` and the
`src/` solution) in favour of the Node parser, which is now the whole tool.
There is nothing to build — just `npm install` and run the command above.

Two pieces:

- **`run-parser.mjs`** — extracts spell blocks from a PDF's text layer into JSON.
- **`spell-editor.html`** — a standalone, no-build browser page for reviewing and
  correcting that JSON before you use it. Open the file directly and load a
  parser output; edits are saved back out as JSON.

## Install

```
npm install
```

The only dependency is `pdfjs-dist`.

## Full usage

```
node run-parser.mjs [--start=N] [--end=N] [--out=path.json] file.pdf [more.pdf ...]
```

| Flag | Meaning | Default |
|---|---|---|
| `--start=N` | First page to scan | `1` |
| `--end=N` | Last page to scan | last page |
| `--out=path` | Output JSON path | `output/parsed-spells.json` |

Multiple PDFs may be passed in one run; results are grouped per file. The page
range, when given, applies to every file in the run — so narrowing to a spell
chapter is best done one book at a time.

Example:

```
node run-parser.mjs --start=83 --end=162 --out=output/DragonKings.json 04-DragonKings.pdf
```

Each run prints a summary: total extracted, the Wizard / Priest / Psionic split,
counts by spell level, and — when psionic powers are found — a per-discipline
breakdown of High Sciences, Sciences, and Devotions.

## Output

A JSON array of `{ file, spells }` groups. Spell records carry `name`, `school`,
`class`, `sphere`, `level`, the stat fields (`castingTime`, `range`,
`components`, `duration`, `savingThrow`, `areaOfEffect`, `preparationTime`),
`description`, `page`, `source`, `reversible`, and a `verified` flag for the
editor to track review state.

True psionic powers use a different shape: `discipline`, `tier`, `powerScore`,
`initialCost`, `maintenanceCost`, `prerequisites`.

Class detection is evidence-based rather than heading-based, since OCR-damaged
scans frequently lose headings: a `Sphere:` field marks a **Priest** spell,
and anything else with a recognised school is a **Wizard** spell.

## Parser design

The parser is built to survive the defects of scanned TSR PDFs:

- **Column auto-detection** — pages are classified single- or two-column by how
  many text runs cross the page midline; two-column pages are read left column
  fully, then right, so stat blocks don't interleave with adjacent body text.
- **Letter-spaced OCR text** — `C o m p o n e n t s :` is collapsed back to
  `Components:` before field matching.
- **Two-line headers** — PHB-style `Spell Name` followed by `(School)` on the
  next line is recognised alongside the single-line `Name (School)` form.
- **Shared stat lines** — `Range: 10 yds. Components: V, S, M` on one physical
  line is split into separate fields; the first value for a field wins, so
  later prose mentioning a label can't clobber a real stat.
- **Header validation** — the school must be a known 2e school or sphere word,
  which rejects cross-reference tables and stray parenthesised text as names.
- **Junk-line filter** — browser print-to-PDF artifacts (timestamps,
  `file:///` URLs, `166/3963` page counters) are dropped.
- **Pipe repair** — extraction commonly misreads the digit `1` as `|`; stat
  values are repaired (`|rd.` → `1 rd.`).

## Known limitations

- Some PDFs have no decodable text layer; these produce no output.
- OCR quality caps output quality — badly scanned books yield mangled spell
  names, and a few well-known spells are unrecoverable from available scans.
- Spell *list tables* (e.g. the letter-spaced sphere tables in the Dark Sun
  boxed sets) are not parsed — only full spell stat blocks are captured.
- Extraction is best-effort; run the output through `spell-editor.html` before
  treating it as final.
