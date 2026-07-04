using System.Text;
using System.Text.RegularExpressions;
using DeepMagic.Core.Models;
using Microsoft.Extensions.Logging;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;

namespace DeepMagic.Services;

/// <summary>
/// Generic AD&amp;D 2e spell-block parser for Dark Sun (and core) sourcebook PDFs.
///
/// Handles the real-world defects of scanned TSR PDFs:
///   • Letter-spaced text  ("S p h e r e :  C o s m o s", "Co mpo n e n t s V, M")
///   • Two-column layouts, including narrow stat blocks embedded beside body text
///   • Spell headers with the school in parentheses ("Curse of Tongues (Alteration)"),
///     inline class/level ("Detect Magic (Pr 1; Divination)"), or bare names whose
///     school drifted into another column ("Cooling Canopy" … "(Evocation)")
///   • Section-level headings ("1st-Level Spells", "Third-Level Wizard Spells")
///
/// Class detection: a "Sphere:" field marks a Cleric (priest) spell; otherwise the
/// spell is a Wizard spell (optionally steered by "Priest Spells"/"Wizard Spells"
/// chapter headings).
/// </summary>
public sealed class DarkSunCompendiumParser
{
    private readonly ILogger<DarkSunCompendiumParser> _logger;

    public DarkSunCompendiumParser(ILogger<DarkSunCompendiumParser> logger)
        => _logger = logger;

    // ── Tunables ──────────────────────────────────────────────────────────────

    /// <summary>Horizontal gap (pt) that splits a visual line into separate segments.</summary>
    private const double SegmentGapThreshold = 18.0;

    /// <summary>Lines to look ahead of a header candidate for confirming stat fields.</summary>
    private const int FieldLookahead = 9;

    /// <summary>Maximum words kept in a spell description.</summary>
    private const int MaxDescriptionWords = 400;

    // ── Regexes ───────────────────────────────────────────────────────────────

    /// <summary>"Name (School)" or bare "Name" spell header candidates.</summary>
    private static readonly Regex HeaderRegex = new(
        @"^(?<name>[A-Z][A-Za-z0-9 ,'’\-\.]{1,55}?)\s*(?:\((?<paren>[^)]{1,48})\))?\s*(?:Reversible)?[\s\*†]*$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>Inline class+level parenthetical, e.g. "Pr 1", "Wz 3 Abjuration".</summary>
    private static readonly Regex InlineClassLevelRegex = new(
        @"^(?<cls>Pr|Wz|P|W)\s*(?<lvl>1[0-3]|[1-9])\b[;,·\s]*(?<school>.*)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>Matches section headings on de-spaced text: "1st-levelspells", "thirdlevelwizardspells".</summary>
    private static readonly Regex SectionLevelRegex = new(
        @"^(?<ord>first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|11th|12th|13th)[-–]?level(?<cls>wizard|priest|cleric)?(spells?|psionicenchantments?)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>Matches class-chapter headings on de-spaced text.</summary>
    private static readonly Regex ClassSectionRegex = new(
        @"^(?<cls>wizard|priest|cleric|templar|defiler|preserver)spells$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly Dictionary<string, int> OrdinalToLevel =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["first"] = 1,  ["second"] = 2,  ["third"] = 3,  ["fourth"] = 4,
            ["fifth"] = 5,  ["sixth"] = 6,   ["seventh"] = 7, ["eighth"] = 8,
            ["ninth"] = 9,  ["tenth"] = 10,  ["eleventh"] = 11,
            ["twelfth"] = 12, ["thirteenth"] = 13,
            ["1st"] = 1, ["2nd"] = 2, ["3rd"] = 3, ["4th"] = 4, ["5th"] = 5,
            ["6th"] = 6, ["7th"] = 7, ["8th"] = 8, ["9th"] = 9, ["10th"] = 10,
            ["11th"] = 11, ["12th"] = 12, ["13th"] = 13,
        };

    /// <summary>Known 2e school words; a parenthetical must contain one to count as a school.</summary>
    private static readonly HashSet<string> ValidSchoolWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "Abjuration", "Alteration", "Conjuration", "Divination", "Enchantment",
        "Evocation", "Invocation", "Illusion", "Phantasm", "Necromancy",
        "Transmutation", "Universal", "Charm", "Summoning", "Metamorphosis",
        "Geometry", "Song", "Shadow", "Dimension", "Force", "Alchemy",
        "Elemental", "Wild",
    };

    /// <summary>Field labels in de-spaced lowercase, longest first (prefix matching).</summary>
    private static readonly string[] FieldLabels =
    [
        "materialcomponents", "materialcomponent", "preparationtime",
        "castingtime", "areaofeffect", "savingthrow", "components",
        "component", "duration", "sphere", "school", "range", "level",
    ];

    /// <summary>Labels that require a trailing colon (too easy to confuse with prose otherwise).</summary>
    private static readonly HashSet<string> ColonRequired =
        ["range", "duration", "sphere", "school", "level"];

    // ── Public API ────────────────────────────────────────────────────────────

    public List<CompendiumSpell> ParseFile(string pdfPath, string sourceName)
    {
        var lines = new List<(string Text, int Page)>();

        using (var document = PdfDocument.Open(pdfPath, new ParsingOptions
               { UseLenientParsing = true, SkipMissingFonts = true }))
        {
            foreach (var page in document.GetPages())
                foreach (var line in ExtractPageLines(page))
                    lines.Add((line, page.Number));
        }

        if (lines.Count == 0)
        {
            _logger.LogWarning("No extractable text in {Path} (image-only or unsupported encoding)", pdfPath);
            return [];
        }

        return ParseLines(lines, sourceName);
    }

    // ── Block parsing ─────────────────────────────────────────────────────────

    private List<CompendiumSpell> ParseLines(List<(string Text, int Page)> lines, string sourceName)
    {
        var spells = new List<CompendiumSpell>();

        int currentLevel = 0;
        string? sectionClass = null;   // "Cleric" / "Wizard" from chapter headings

        for (int i = 0; i < lines.Count; i++)
        {
            var (text, page) = lines[i];
            var despaced = Despace(text);

            // Section-level heading?
            var sec = SectionLevelRegex.Match(despaced);
            if (sec.Success)
            {
                if (OrdinalToLevel.TryGetValue(sec.Groups["ord"].Value, out int lvl))
                    currentLevel = lvl;
                sectionClass = sec.Groups["cls"].Value.ToLowerInvariant() switch
                {
                    "wizard" => "Wizard",
                    "priest" or "cleric" => "Cleric",
                    _ => sectionClass,
                };
                continue;
            }

            // Class-chapter heading?
            var cls = ClassSectionRegex.Match(despaced);
            if (cls.Success)
            {
                sectionClass = cls.Groups["cls"].Value.ToLowerInvariant() switch
                {
                    "priest" or "cleric" or "templar" => "Cleric",
                    _ => "Wizard",
                };
                continue;
            }

            // Spell header?
            if (!TryMatchHeader(text, out string name, out string? school,
                    out string? inlineClass, out int inlineLevel))
                continue;

            // Confirm with stat fields in the lookahead window.
            int fieldCount = 0;
            for (int j = i + 1; j < Math.Min(i + 1 + FieldLookahead, lines.Count); j++)
                if (TryParseField(lines[j].Text, out _, out _))
                    fieldCount++;

            int required = school is null ? 3 : 2;
            if (fieldCount < required)
                continue;

            // Collect the block: everything until the next confirmed header/section.
            var block = new List<string>();
            int end = lines.Count;
            for (int j = i + 1; j < lines.Count; j++)
            {
                var d2 = Despace(lines[j].Text);
                if (SectionLevelRegex.IsMatch(d2)) { end = j; break; }
                if (TryMatchHeader(lines[j].Text, out _, out string? s2, out _, out _))
                {
                    int f2 = 0;
                    for (int k = j + 1; k < Math.Min(j + 1 + FieldLookahead, lines.Count); k++)
                        if (TryParseField(lines[k].Text, out _, out _)) f2++;
                    if (f2 >= (s2 is null ? 3 : 2)) { end = j; break; }
                }
                block.Add(lines[j].Text);
            }

            var spell = BuildSpell(name, school, inlineClass, inlineLevel,
                currentLevel, sectionClass, block, sourceName, page);
            if (spell is not null)
                spells.Add(spell);

            i = end - 1;
        }

        return spells;
    }

    private bool TryMatchHeader(string line, out string name, out string? school,
        out string? inlineClass, out int inlineLevel)
    {
        name = string.Empty;
        school = null;
        inlineClass = null;
        inlineLevel = 0;

        var collapsed = line.Trim().TrimEnd('*', '†').Trim();
        if (collapsed.Length is < 3 or > 80) return false;

        var m = HeaderRegex.Match(collapsed);
        if (!m.Success) return false;

        var candidate = m.Groups["name"].Value.Trim().TrimEnd(',');
        var paren = m.Groups["paren"].Success ? m.Groups["paren"].Value.Trim() : null;

        // Reject all-caps section banners and short junk.
        if (candidate.Length < 3) return false;
        if (candidate.Length > 8 && candidate == candidate.ToUpperInvariant()) return false;

        // Name plausibility: 1-6 words, mostly capitalised (connectors allowed).
        var words = candidate.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (words.Length is < 1 or > 6) return false;
        if (!words.Any(w => w.Count(char.IsLetter) >= 3)) return false;   // "V, S, M"
        if (BadNames.Contains(candidate)) return false;
        int capped = words.Count(w => char.IsUpper(w[0]) || char.IsDigit(w[0]));
        int connectors = words.Count(w => w is "of" or "the" or "and" or "to" or "from" or "vs." or "against");
        if (capped + connectors < words.Length) return false;
        if (!char.IsUpper(candidate[0])) return false;

        if (paren is not null)
        {
            // Inline class+level: "(Pr 1; Divination)" / "(Wz 3)"
            var icl = InlineClassLevelRegex.Match(paren);
            if (icl.Success)
            {
                name = candidate;
                inlineClass = icl.Groups["cls"].Value is "Pr" or "P" ? "Cleric" : "Wizard";
                inlineLevel = int.Parse(icl.Groups["lvl"].Value);
                var rest = icl.Groups["school"].Value.Trim();
                school = ContainsSchoolWord(rest) ? rest : null;
                return true;
            }

            // Otherwise the parenthetical must be a school; "(1st)" list entries,
            // "(in DK)" cross-references etc. are rejected.
            if (!ContainsSchoolWord(paren)) return false;
            name = candidate;
            school = paren;
            return true;
        }

        // Bare name (school lost to another column). Field confirmation is stricter.
        // Reject stat-value vocabulary ("Touch", "Permanent", "Air") and names
        // truncated mid-phrase by column segmentation ("Footsteps of").
        if (words.Length == 1 && StatValueWords.Contains(candidate)) return false;
        if (words[^1] is "of" or "the" or "and" or "to" or "from" or "per") return false;
        // "Elemental, Plant" – a Sphere value, not a name: every word is vocabulary.
        if (words.All(w => StatValueWords.Contains(w.TrimEnd(',')) ||
                           ValidSchoolWords.Contains(w.TrimEnd(',')) ||
                           SphereVocabWords.Contains(w.TrimEnd(','))))
            return false;
        name = candidate;
        return true;
    }

    /// <summary>2e priest sphere vocabulary (for rejecting Sphere values as names).</summary>
    private static readonly HashSet<string> SphereVocabWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "Plant", "Healing", "Combat", "Creation", "Guardian", "Protection",
        "Summoning", "Weather", "Animal", "Astral", "Law", "Chaos", "Numbers",
        "Thought", "Time", "Travelers", "Travellers", "Wards", "War", "Necromantic",
    };

    /// <summary>Single words that are stat values, never bare spell names.</summary>
    private static readonly HashSet<string> StatValueWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "Touch", "Special", "Permanent", "Various", "None", "Self", "Instantaneous",
        "Cosmos", "Air", "Earth", "Fire", "Water", "Magma", "Rain", "Silt", "Sun",
        "Elemental", "Paraelemental", "Yes", "No", "Negates", "None.", "Varies",
    };

    /// <summary>Lines that pass the header shape test but are never spell names.</summary>
    private static readonly HashSet<string> BadNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Reversible", "Material Component", "Material Components",
        "New Spells", "Table", "Note", "Notes", "Priest Spells", "Wizard Spells",
        "Spell Level", "Caster Level", "Saving Throw", "Casting Time",
        "Area of Effect", "The Material Component", "Area", "Power Score",
    };

    private static bool ContainsSchoolWord(string s)
        => s.Split(new[] { '/', ',', ' ', ';' }, StringSplitOptions.RemoveEmptyEntries)
            .Any(w => ValidSchoolWords.Contains(w));

    private CompendiumSpell? BuildSpell(
        string name, string? school, string? inlineClass, int inlineLevel,
        int sectionLevel, string? sectionClass, List<string> block,
        string sourceName, int page)
    {
        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var body = new StringBuilder();
        var consumed = new HashSet<int>();
        int bodyWords = 0;

        for (int i = 0; i < block.Count; i++)
        {
            if (consumed.Contains(i)) continue;
            var raw = block[i];

            if (TryParseField(raw, out string key, out string value))
            {
                // Stat blocks beside body text often split "Range:" and its value
                // "20 yards" into separate segments. Look ahead a few segments for
                // a short value-like line, skipping interleaved prose fragments.
                if (value.Length == 0)
                {
                    for (int j = i + 1; j <= Math.Min(i + 3, block.Count - 1); j++)
                    {
                        if (consumed.Contains(j)) continue;
                        var cand = block[j].Trim();
                        if (TryParseField(cand, out _, out _)) break;   // next field – give up
                        int wc = cand.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
                        if (cand.Length is > 0 and <= 40 && wc <= 4)
                        {
                            value = cand;
                            consumed.Add(j);
                            break;
                        }
                    }
                }

                if (!fields.ContainsKey(key) && value.Length > 0)
                    fields[key] = CleanFieldValue(key, value);
                continue;
            }

            // A lone "(School)" line inside the block recovers a school that the
            // column split separated from the header.
            var t = raw.Trim();
            if (school is null && t.StartsWith('(') && t.EndsWith(')') && ContainsSchoolWord(t.Trim('(', ')')))
            {
                school = t.Trim('(', ')').Trim();
                continue;
            }

            if (bodyWords < MaxDescriptionWords)
            {
                var w = t.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                body.Append(t).Append(' ');
                bodyWords += w.Length;
            }
        }

        // Require a minimally useful capture.
        if (fields.Count < 2) return null;

        // Psionic powers share Range/Duration stat blocks with spells but carry
        // Power Score / PSP lines. They are not Wizard or Cleric spells.
        foreach (var raw in block)
        {
            var d = Despace(raw);
            if (d.StartsWith("powerscore") || d.StartsWith("psps") ||
                d.StartsWith("pspcost") || d.StartsWith("initialcost") ||
                d.StartsWith("maintenancecost"))
                return null;
        }

        // Class evidence, strongest first: a Sphere field or inline "(Pr n)" marks
        // a Cleric; a recognised wizard school with no sphere marks a Wizard;
        // chapter headings ("Priest Spells") are only a fallback — OCR-damaged
        // scans frequently miss a heading and leave the section context stale.
        bool isCleric;
        if (fields.ContainsKey("Sphere") || inlineClass == "Cleric")
            isCleric = true;
        else if (inlineClass == "Wizard" || school is not null)
            isCleric = false;
        else
            isCleric = sectionClass == "Cleric";

        int level = inlineLevel > 0 ? inlineLevel : sectionLevel;
        if (fields.TryGetValue("Level", out var lvlText))
        {
            var digits = new string(lvlText.TakeWhile(char.IsDigit).ToArray());
            if (int.TryParse(digits, out int lf) && lf is >= 1 and <= 13)
                level = lf;
        }

        var description = NormaliseBody(body.ToString());
        if (fields.TryGetValue("MaterialComponent", out var mat) && mat.Length > 0)
            description = $"{description}\n\nMaterial Component: {mat}".Trim();

        var (spheres, sphereTypes) = ParseSpheres(fields.GetValueOrDefault("Sphere"));
        var primarySchool = isCleric ? null : CanonicalSchool(school);

        var spell = new CompendiumSpell
        {
            Name = TidyName(name),
            Class = isCleric ? "Cleric" : "Wizard",
            Level = level,
            LevelName = LevelName(level),
            Category = isCleric ? "Sphere" : "School",
            Spheres = spheres,
            SphereTypes = sphereTypes,
            School = primarySchool,
            Sphere = isCleric ? spheres.FirstOrDefault() : null,
            SphereType = isCleric ? sphereTypes.FirstOrDefault() : null,
            Group = isCleric
                ? spheres.FirstOrDefault() ?? "Cosmos"
                : primarySchool ?? "Unknown",
            Source = sourceName,
            Summary = Summarise(description),
            Stats = new CompendiumSpellStats
            {
                Range        = fields.GetValueOrDefault("Range", ""),
                Components   = fields.GetValueOrDefault("Components", ""),
                Duration     = fields.GetValueOrDefault("Duration", ""),
                CastingTime  = fields.GetValueOrDefault("CastingTime", ""),
                AreaOfEffect = fields.GetValueOrDefault("AreaOfEffect", ""),
                SavingThrow  = fields.GetValueOrDefault("SavingThrow", ""),
            },
            FullDetail = description.Length >= 40,
            Description = description,
            HasFullDescription = description.Length >= 40,
            SourcePage = page,
        };

        return spell;
    }

    // ── Field parsing (letter-spacing tolerant) ───────────────────────────────

    /// <summary>
    /// Detects labelled stat lines even when OCR letter-spacing corrupted them
    /// ("Du r atio n : 12 hours", "Co mpo n e n t s V, M"). Matching is done on a
    /// de-spaced copy while the value keeps its original spacing.
    /// </summary>
    internal static bool TryParseField(string line, out string key, out string value)
    {
        key = value = string.Empty;
        var trimmed = line.Trim();
        if (trimmed.Length is < 4 or > 100) return false;

        var sb = new StringBuilder(trimmed.Length);
        var map = new List<int>(trimmed.Length);
        for (int i = 0; i < trimmed.Length; i++)
        {
            if (char.IsWhiteSpace(trimmed[i])) continue;
            sb.Append(char.ToLowerInvariant(trimmed[i]));
            map.Add(i);
        }
        var d = sb.ToString();

        foreach (var label in FieldLabels)
        {
            if (!d.StartsWith(label, StringComparison.Ordinal)) continue;

            int pos = label.Length;
            bool colon = pos < d.Length && (d[pos] == ':' || d[pos] == '.');
            if (colon) pos++;
            if (!colon && ColonRequired.Contains(label)) return false;

            key = Canon(label);
            if (pos >= d.Length) { value = string.Empty; return true; }
            value = trimmed[map[pos]..].TrimStart(':', '.', ' ').Trim();
            return true;
        }

        return false;
    }

    private static string Canon(string label) => label switch
    {
        "materialcomponents" or "materialcomponent" => "MaterialComponent",
        "castingtime"     => "CastingTime",
        "areaofeffect"    => "AreaOfEffect",
        "savingthrow"     => "SavingThrow",
        "components" or "component" => "Components",
        "preparationtime" => "PreparationTime",
        "duration"        => "Duration",
        "sphere"          => "Sphere",
        "school"          => "School",
        "range"           => "Range",
        "level"           => "Level",
        _                 => label,
    };

    /// <summary>
    /// Field values captured from stat blocks embedded beside body text can drag
    /// description fragments along. Trim overlong values at sensible boundaries.
    /// </summary>
    private static string CleanFieldValue(string key, string value)
    {
        value = CollapseLetterSpacing(value).Trim('(', ')', ' ');
        int max = key switch
        {
            "MaterialComponent" => 160,
            "Components"        => 24,
            _                   => 48,
        };
        if (value.Length <= max) return value;

        int cut = value.LastIndexOf(' ', max);
        return (cut > 8 ? value[..cut] : value[..max]).TrimEnd(',', ';', ' ');
    }

    // ── Sphere / school helpers ───────────────────────────────────────────────

    private static readonly HashSet<string> ElementalSpheres =
        new(StringComparer.OrdinalIgnoreCase) { "Earth", "Air", "Fire", "Water" };

    private static readonly HashSet<string> ParaelementalSpheres =
        new(StringComparer.OrdinalIgnoreCase) { "Magma", "Rain", "Silt", "Sun" };

    private static (List<string> Spheres, List<string> Types) ParseSpheres(string? sphereField)
    {
        var spheres = new List<string>();
        var types = new List<string>();
        if (string.IsNullOrWhiteSpace(sphereField)) return (spheres, types);

        var text = CollapseLetterSpacing(sphereField);
        foreach (var part in text.Split(new[] { ',', '/', ';' }, StringSplitOptions.RemoveEmptyEntries))
        {
            var words = part.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                            .Select(w => w.Trim('.', '*', '†', '(', ')'))
                            .Where(w => w.Length > 0)
                            .ToList();

            string? name = words.LastOrDefault(w =>
                ElementalSpheres.Contains(w) || ParaelementalSpheres.Contains(w) ||
                w.Equals("Cosmos", StringComparison.OrdinalIgnoreCase));

            if (name is null)
            {
                // Non-elemental 2e sphere (Healing, Combat, …) – keep verbatim.
                name = words.LastOrDefault();
                if (name is null) continue;
                spheres.Add(Capitalise(name));
                types.Add("Cosmos");
                continue;
            }

            name = Capitalise(name);
            spheres.Add(name);
            types.Add(
                ElementalSpheres.Contains(name) ? "Elemental" :
                ParaelementalSpheres.Contains(name) ? "Paraelemental" : "Cosmos");
        }

        return (spheres, types);
    }

    private static string? CanonicalSchool(string? school)
    {
        if (string.IsNullOrWhiteSpace(school)) return null;
        var text = CollapseLetterSpacing(school);
        var first = text.Split(new[] { '/', ',', ';' }, StringSplitOptions.RemoveEmptyEntries)
                        .Select(s => s.Trim())
                        .FirstOrDefault(s => ContainsSchoolWord(s));
        if (first is null) return null;
        var word = first.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                        .FirstOrDefault(w => ValidSchoolWords.Contains(w));
        return word is null ? Capitalise(first) : Capitalise(word);
    }

    // ── Text extraction ───────────────────────────────────────────────────────

    /// <summary>
    /// Extracts lines in two-column reading order. Each visual line is further
    /// split into segments wherever a large horizontal gap occurs, so narrow
    /// stat blocks don't merge with the body text that flows beside them.
    /// </summary>
    private static List<string> ExtractPageLines(Page page)
    {
        var words = page.GetWords().ToList();
        var lines = new List<string>();
        if (words.Count == 0) return lines;

        double minX = words.Min(w => w.BoundingBox.Left);
        double maxX = words.Max(w => w.BoundingBox.Right);
        double midX = (minX + maxX) / 2.0;

        void EmitColumn(IEnumerable<Word> colWords)
        {
            foreach (var group in colWords
                         .GroupBy(w => Math.Round(w.BoundingBox.Bottom / 2.5) * 2.5)
                         .OrderByDescending(g => g.Key))
            {
                var ordered = group.OrderBy(w => w.BoundingBox.Left).ToList();
                var segment = new List<Word> { ordered[0] };

                for (int i = 1; i < ordered.Count; i++)
                {
                    double gap = ordered[i].BoundingBox.Left - ordered[i - 1].BoundingBox.Right;
                    if (gap > SegmentGapThreshold)
                    {
                        EmitSegment(segment, lines);
                        segment = [];
                    }
                    segment.Add(ordered[i]);
                }

                EmitSegment(segment, lines);
            }
        }

        EmitColumn(words.Where(w => w.BoundingBox.Left < midX));
        EmitColumn(words.Where(w => w.BoundingBox.Left >= midX));
        return lines;
    }

    private static void EmitSegment(List<Word> segment, List<string> lines)
    {
        if (segment.Count == 0) return;
        var text = CollapseLetterSpacing(
            string.Join(" ", segment.Select(w => w.Text))).Trim();
        if (text.Length > 0) lines.Add(text);
    }

    /// <summary>
    /// Collapses letter-spaced text: when most tokens on a line are single
    /// characters ("S a n d s t o r m") the spaces are OCR artefacts, not word
    /// boundaries, so the tokens are joined.
    /// </summary>
    internal static string CollapseLetterSpacing(string text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        var parts = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length >= 4 && parts.Count(p => p.Length == 1) >= parts.Length * 0.7)
            return string.Concat(parts);
        return string.Join(" ", parts);
    }

    private static string Despace(string text)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var c in text)
            if (!char.IsWhiteSpace(c))
                sb.Append(char.ToLowerInvariant(c));
        return sb.ToString();
    }

    // ── Misc helpers ──────────────────────────────────────────────────────────

    private static string NormaliseBody(string body)
    {
        var text = Regex.Replace(body, @"\s+", " ").Trim();
        // Strip page-number noise like " 78 " that lands between paragraphs.
        text = Regex.Replace(text, @"(?<= )\d{1,3}(?= [A-Z])", "");
        return Regex.Replace(text, @"\s+", " ").Trim();
    }

    private static string Summarise(string description)
    {
        if (string.IsNullOrWhiteSpace(description)) return string.Empty;
        int stop = description.IndexOf(". ", StringComparison.Ordinal);
        var summary = stop is > 20 and < 220 ? description[..(stop + 1)] : description;
        return summary.Length <= 220 ? summary : summary[..217].TrimEnd() + "…";
    }

    private static string LevelName(int level) => level switch
    {
        1 => "1st", 2 => "2nd", 3 => "3rd",
        >= 4 and <= 13 => $"{level}th",
        _ => "Unknown",
    };

    private static string TidyName(string name)
    {
        var cleaned = CollapseLetterSpacing(name).Trim().TrimEnd('*', '†', ',', '.').Trim();
        return Regex.Replace(cleaned, @"\s+", " ");
    }

    private static string Capitalise(string s) =>
        s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s[1..].ToLowerInvariant();
}
