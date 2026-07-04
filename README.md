# Depp-Magic

Converter tool to read PDFs and parse out content for Dungeons and Dragons 2nd Edition.

## Usage

```
DeepMagic.App <pdf-file-or-directory> [output.json]
```

- A **directory** is scanned recursively for `*.pdf`. Every file is parsed for
  Wizard and Cleric (priest) spell blocks; results are merged, deduplicated,
  and written as a single compendium JSON.
- A **single PDF** is parsed the same way.
- Default output: `output/spells.json`. Per-file results are cached in
  `output/cache/` so an interrupted run resumes where it left off (delete the
  cache to force a full re-parse).

Example:

```
dotnet run --project src/DeepMagic.App -- "L:\DNDFinal\D&D\AD&D 2nd Edition\Dark Sun" output/spells.json
```

## Output

The compendium JSON matches the SavageSun `spells.json` schema: top-level
metadata (`sources`, `spheres`, `sphere_groups`, `schools`, `counts`,
`cleric_by_sphere`, `wizard_by_school`, `by_source`) plus a flat `spells`
array with snake_case keys (`name`, `class`, `level`, `stats`, `description`, …).

Class detection is evidence-based:

1. A `Sphere:` field (or an inline `(Pr n)` tag) marks a **Cleric** spell.
2. A recognised wizard school with no sphere marks a **Wizard** spell.
3. Chapter headings ("Priest Spells" / "Wizard Spells") are only a fallback,
   since OCR-damaged scans frequently lose headings.

## Parser design (src/DeepMagic.Services/DarkSunCompendiumParser.cs)

The parser is built to survive the defects of scanned TSR PDFs:

- **Letter-spaced OCR text** — `S p h e r e : C o s m o s` is collapsed; field
  labels are matched on a de-spaced copy of each line so `Co mpo n e n t s V, M`
  still parses.
- **Column segmentation** — each visual line is split wherever a large
  horizontal gap occurs, so narrow stat blocks don't merge with body text that
  flows beside them (the Defilers and Preservers layout).
- **Label/value splits** — when `Range:` and `20 yards` land in separate
  segments, a short look-ahead pairs them back up while skipping interleaved
  prose fragments.
- **Header validation** — a spell header must be followed by stat fields;
  stat-value vocabulary ("Touch", "Permanent", "Air"), sphere lists
  ("Elemental, Plant"), and "Reversible" lines are rejected as names.
- **Psionics filter** — blocks containing Power Score / PSP lines are psionic
  powers, not spells, and are dropped.

## Known limitations

- Some PDFs have no text layer PdfPig can decode (e.g. *Wizards Spell
  Compendium Volume 1*); these are logged and skipped.
- OCR quality caps output quality: badly scanned books (e.g. the reduced
  Player's Handbook) yield mangled spell names, and a few well-known spells
  are unrecoverable from the available scans.
- Spell *list tables* (e.g. the letter-spaced sphere tables in the Dark Sun
  boxed sets) are not parsed — only full spell stat blocks are captured.
- Battlesystem miniatures-rules PDFs are skipped by design; their spell
  summaries are not real 2e spell stat blocks.
