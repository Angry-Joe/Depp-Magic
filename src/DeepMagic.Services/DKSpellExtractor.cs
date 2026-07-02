using UglyToad.PdfPig;
using Microsoft.Extensions.Logging;
using System.Text;
using System.Text.RegularExpressions;
using UglyToad.PdfPig.Content;

namespace DeepMagic.Services;

public class DragonKingsSpellExtractor
{
    private readonly ILogger<DragonKingsSpellExtractor> _logger;

    public DragonKingsSpellExtractor(ILogger<DragonKingsSpellExtractor> logger)
    {
        _logger = logger;
    }

    // ── Regexes ───────────────────────────────────────────────────────────────

    /// <summary>
    /// Matches Dragon Kings spell headers of the form:
    ///   Wakefulness (Enchantment/Charm)
    ///   Improved Haste (Alteration)
    ///   Defiler Metamorphosis (Alteration/Evocation)
    /// Name = Title Case (may include spaces, hyphens, apostrophes, commas).
    /// School = one or two school names separated by / or comma.
    /// An optional "Reversible" token may immediately follow.
    /// </summary>
    private static readonly Regex SpellHeaderRegex = new(
        @"^(?<Name>[A-Z][A-Za-z ,\-'\.]+?)\s*\((?<School>[A-Za-z/\s,]+?)\)\s*(?:Reversible\s*)?$",
        RegexOptions.Compiled);

    /// <summary>
    /// Matches section-level headings such as:
    ///   Second-Level Spells
    ///   Sixth-Level Spells
    ///   Tenth-Level Spells  (used for psionic enchantments)
    /// </summary>
    private static readonly Regex SectionLevelRegex = new(
        @"^(?<Ordinal>First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth|Thirteenth)-Level\s+(?:Spells?|Psionic)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>Matches the "Psionic Enchantments" section header.</summary>
    private static readonly Regex PsionicSectionRegex = new(
        @"^Psionic\s+Enchantments?",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>
    /// Matches labelled field lines: "Range: 30 yards", "Casting Time: 2", etc.
    /// Handles run-together variants produced by two-column text reconstruction
    /// ("CastingTime:", "AreaofEffect:") as well as spaced variants.
    /// </summary>
    private static readonly Regex FieldLineRegex = new(
        @"^(?<Field>Range|Components?|Duration|CastingTime|Casting\s+Time|AreaofEffect|Area\s+of\s+Effect|SavingThrow|Saving\s+Throw|PreparationTime|Preparation\s+Time)\s*:\s*(?<Value>.+)$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // ── Level ordinal map ─────────────────────────────────────────────────────

    private static readonly Dictionary<string, int> OrdinalToLevel =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["First"]      = 1,  ["Second"]   = 2,  ["Third"]    = 3,
            ["Fourth"]     = 4,  ["Fifth"]    = 5,  ["Sixth"]    = 6,
            ["Seventh"]    = 7,  ["Eighth"]   = 8,  ["Ninth"]    = 9,
            ["Tenth"]      = 10, ["Eleventh"] = 11, ["Twelfth"]  = 12,
            ["Thirteenth"] = 13,
        };

    // ── Public API ────────────────────────────────────────────────────────────

    public List<DragonKingsSpell> ExtractSpells(string pdfPath, int startPage = 1, int endPage = 999)
    {
        var spells         = new List<DragonKingsSpell>();
        int currentLevel   = 1;
        bool isPsionic     = false;

        using var document = PdfDocument.Open(pdfPath);

        // Accumulate all lines across pages, preserving page numbers.
        var allLines = new List<(string Text, int PageNumber)>();
        foreach (var page in document.GetPages()
                     .Where(p => p.Number >= startPage && p.Number <= endPage))
        {
            foreach (var line in ExtractPageLines(page))
                allLines.Add((line, page.Number));
        }

        // ── Single-pass block extraction ─────────────────────────────────────

        string? currentName   = null;
        string? currentSchool = null;
        int     currentPage   = 0;
        var     blockLines    = new List<string>();
        var     fields        = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        bool    inSpellBlock  = false;

        void CommitSpell()
        {
            if (currentName is null) return;
            spells.Add(new DragonKingsSpell(
                Name:        currentName,
                School:      currentSchool ?? string.Empty,
                Level:       currentLevel,
                CastingTime: fields.GetValueOrDefault("CastingTime", ""),
                Range:       fields.GetValueOrDefault("Range", ""),
                Components:  fields.GetValueOrDefault("Components", ""),
                Duration:    fields.GetValueOrDefault("Duration", ""),
                Description: BuildDescription(blockLines, fields),
                PageNumber:  currentPage,
                Source:      isPsionic ? "Dragon Kings (Psionic)" : "Dragon Kings"
            ));
        }

        foreach (var (text, pageNum) in allLines)
        {
            // ── Section level heading ────────────────────────────────────────
            var secMatch = SectionLevelRegex.Match(text);
            if (secMatch.Success)
            {
                if (OrdinalToLevel.TryGetValue(secMatch.Groups["Ordinal"].Value, out int lvl))
                    currentLevel = lvl;
                continue;
            }

            // ── Psionic section marker ───────────────────────────────────────
            if (PsionicSectionRegex.IsMatch(text))
            {
                isPsionic = true;
                continue;
            }

            // ── Spell header ─────────────────────────────────────────────────
            var spellMatch = SpellHeaderRegex.Match(text);
            if (spellMatch.Success)
            {
                var candidateSchool = spellMatch.Groups["School"].Value.Trim();
                // Reject cross-reference table entries such as "(in DK)", "(F)".
                if (!IsValidSchool(candidateSchool))
                {
                    if (inSpellBlock) blockLines.Add(text);
                    continue;
                }
                CommitSpell();
                currentName   = spellMatch.Groups["Name"].Value.Trim();
                currentSchool = candidateSchool;
                currentPage   = pageNum;
                blockLines    = [text];
                fields        = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                inSpellBlock  = true;
                continue;
            }

            if (!inSpellBlock) continue;

            // ── Field lines ──────────────────────────────────────────────────
            var fieldMatch = FieldLineRegex.Match(text);
            if (fieldMatch.Success)
            {
                var key   = NormaliseFieldKey(fieldMatch.Groups["Field"].Value);
                var value = fieldMatch.Groups["Value"].Value.Trim();
                fields.TryAdd(key, value);
            }

            blockLines.Add(text);
        }

        CommitSpell();  // Flush last spell

        _logger.LogInformation(
            "Dragon Kings extractor found {Count} spells/psionics on pages {Start}-{End}",
            spells.Count, startPage, endPage);

        return spells;
    }

    // ── Text extraction ───────────────────────────────────────────────────────

    /// <summary>
    /// Extracts text lines from a page in two-column reading order (left column
    /// top→bottom, then right column top→bottom). This prevents the two columns
    /// from being interleaved when sorted by y-position alone.
    /// Also collapses letter-spaced text such as "C o m p o n e n t s :" →
    /// "Components:".
    /// </summary>
    private static List<string> ExtractPageLines(Page page)
    {
        var words = page.GetWords().ToList();
        if (words.Count == 0) return [];

        double minX = words.Min(w => w.BoundingBox.Left);
        double maxX = words.Max(w => w.BoundingBox.Right);
        double midX = (minX + maxX) / 2.0;

        IEnumerable<string> ExtractColumn(IEnumerable<Word> colWords)
        {
            const double yTolerance = 2.0;
            return colWords
                .GroupBy(w => Math.Round(w.BoundingBox.Bottom / yTolerance) * yTolerance)
                .OrderByDescending(g => g.Key)
                .Select(g =>
                {
                    var raw = string.Join(" ",
                        g.OrderBy(w => w.BoundingBox.Left).Select(w => w.Text));
                    return CollapseLetterSpacing(raw).Trim();
                })
                .Where(l => l.Length > 0);
        }

        var leftLines  = ExtractColumn(words.Where(w => w.BoundingBox.Left <  midX));
        var rightLines = ExtractColumn(words.Where(w => w.BoundingBox.Left >= midX));

        return [.. leftLines, .. rightLines];
    }

    /// <summary>
    /// Collapses letter-spaced text where every token between spaces is a
    /// single character (e.g., "C o m p o n e n t s :" → "Components:").
    /// Normal multi-word phrases are left unchanged.
    /// </summary>
    private static string CollapseLetterSpacing(string text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        var parts = text.Split(' ');
        if (parts.Length > 2 && parts.All(p => p.Length <= 1))
            return string.Concat(parts);
        return text;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// <summary>
    /// Known AD&amp;D 2e school and sphere names. At least one word in the
    /// parenthetical must match for the line to be treated as a spell header,
    /// excluding cross-reference table entries like "(in DK)".
    /// </summary>
    private static readonly HashSet<string> ValidSchoolWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "Abjuration", "Alteration", "Conjuration", "Divination", "Enchantment",
        "Evocation", "Invocation", "Illusion", "Phantasm", "Necromancy",
        "Transmutation", "Universal", "Charm", "Combat", "Creation",
        "Guardian", "Healing", "Plant", "Protection", "Summoning",
        "Sun", "Weather", "Air", "Earth", "Fire", "Water",
        "Elemental", "Thought", "Travellers",
    };

    private static bool IsValidSchool(string school)
    {
        if (string.IsNullOrWhiteSpace(school)) return false;
        foreach (var word in school.Split(new[] { '/', ',', ' ' },
                     StringSplitOptions.RemoveEmptyEntries))
        {
            if (ValidSchoolWords.Contains(word)) return true;
        }
        return false;
    }

    private static string NormaliseFieldKey(string raw) =>
        raw.ToLowerInvariant().Replace(" ", "") switch
        {
            "range"           => "Range",
            "components"      => "Components",
            "component"       => "Components",
            "duration"        => "Duration",
            "castingtime"     => "CastingTime",
            "areaofeffect"    => "AreaOfEffect",
            "savingthrow"     => "SavingThrow",
            "preparationtime" => "PreparationTime",
            _                 => raw,
        };

    private static string BuildDescription(List<string> lines,
        Dictionary<string, string> fields)
    {
        bool fieldsDone = false;
        int  fieldCount = 0;
        var  sb         = new StringBuilder();

        foreach (var line in lines.Skip(1))  // Skip the header line
        {
            if (FieldLineRegex.IsMatch(line))
            {
                fieldCount++;
                continue;
            }
            if (fieldCount >= 2) fieldsDone = true;
            if (fieldsDone && line.Length > 0)
                sb.AppendLine(line);
        }

        var result = sb.ToString().Trim();
        return string.IsNullOrWhiteSpace(result) ? "See source for description." : result;
    }
}
