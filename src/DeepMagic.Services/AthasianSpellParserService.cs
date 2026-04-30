using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using DeepMagic.Core.Interfaces;
using DeepMagic.Core.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;

namespace DeepMagic.Services;

/// <summary>
/// Parses 2nd Edition AD&amp;D PDF spell blocks (especially Dark Sun sourcebooks) and
/// converts each spell to the 5e Athasian format.
/// </summary>
/// <remarks>
/// PDF text extraction strategy
/// ─────────────────────────────
/// PdfPig extracts raw Unicode text from each page in reading order. Because 2e
/// spell blocks don't use machine-readable semantic markup, we rely on a
/// multi-pass heuristic:
///
///   Pass 1 – Identify candidate spell-header lines: ALL-CAPS or Title-Case words
///             followed by a parenthetical level/type indicator such as "(Pr 1)" or
///             "(Wz 3 Abjr)".
///   Pass 2 – Collect the following lines until the next candidate header or until
///             a page boundary produces an obvious section change.
///   Pass 3 – Extract individual fields (Level, School, Sphere, Range, etc.) from
///             the collected block using labelled-value regexes.
///   Pass 4 – Synthesise a 5e mechanical block from the 2e data via a mapping
///             table and sane defaults.
/// </remarks>
public sealed class AthasianSpellParserService : ISpellParserService
{
    // ── Dependencies ─────────────────────────────────────────────────────────

    private readonly ILogger<AthasianSpellParserService> _logger;
    private readonly SpellParserOptions _options;

    // ── Compiled regexes ─────────────────────────────────────────────────────

    /// <summary>
    /// Matches a 2e spell header of the form:
    ///   CREATE WATER  (Pr 1 · Creation)
    ///   Detect Magic (Pr 1; Divination)
    ///   DARKNESS, 15' RADIUS (Wz 2 Alteration)
    /// Group 1 = spell name, Group 2 = class abbreviation (Pr/Wz), Group 3 = level,
    /// Group 4 = optional school/sphere label.
    /// </summary>
    private static readonly Regex SpellHeaderRegex = new(
        @"^(?<name>[A-Z][A-Z ',\-/0-9]{2,50})\s*\((?<cls>Pr|Wz|P|W)\s*(?<lvl>[1-9])\s*[·;,]?\s*(?<school>[^)]*)\)",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>Extracts "Level:" values from the block text.</summary>
    private static readonly Regex LevelLineRegex = new(
        @"Level\s*:\s*(?<cls>Priest|Wizard|Pr|Wz|P|W)\s*(?<lvl>[1-9])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// Matches field lines of the form "Range: 30 yards" or "Casting Time: 1 round".
    /// Group 1 = field name, Group 2 = value.
    /// </summary>
    private static readonly Regex FieldLineRegex = new(
        @"^(?<field>Range|Components?|Duration|Casting Time|Area of Effect|Saving Throw|School|Sphere)\s*:\s*(?<value>.+)$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>Matches elemental sphere names.</summary>
    private static readonly Regex ElementalSphereRegex = new(
        @"\b(All|Animal|Astral|Charm|Combat|Creation|Divination|Elemental|Guardian|Healing|Necromantic|Plant|Protection|Summoning|Sun|Thought|Travellers?|Weather|Water|Earth|Fire|Air|Magma|Ooze|Smoke|Ice|Silt|Sun|Rain|Lightning)\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    // ── School / sphere mapping tables ───────────────────────────────────────

    private static readonly Dictionary<string, SpellSchool> SchoolMap =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["Abjuration"] = SpellSchool.Abjuration,
            ["Abjur"] = SpellSchool.Abjuration,
            ["Alteration"] = SpellSchool.Transmutation,
            ["Alt"] = SpellSchool.Transmutation,
            ["Conjuration"] = SpellSchool.Conjuration,
            ["Conj"] = SpellSchool.Conjuration,
            ["Summoning"] = SpellSchool.Conjuration,
            ["Divination"] = SpellSchool.Divination,
            ["Div"] = SpellSchool.Divination,
            ["Enchantment"] = SpellSchool.Enchantment,
            ["Charm"] = SpellSchool.Enchantment,
            ["Evocation"] = SpellSchool.Evocation,
            ["Invocation"] = SpellSchool.Evocation,
            ["Illusion"] = SpellSchool.Illusion,
            ["Phantasm"] = SpellSchool.Illusion,
            ["Necromancy"] = SpellSchool.Necromancy,
            ["Necromantic"] = SpellSchool.Necromancy,
            ["Transmutation"] = SpellSchool.Transmutation,
            ["Creation"] = SpellSchool.Conjuration,
            ["Healing"] = SpellSchool.Necromancy,
            ["Combat"] = SpellSchool.Evocation,
            ["Protection"] = SpellSchool.Abjuration,
            ["Weather"] = SpellSchool.Transmutation,
        };

    // ── Constructor ───────────────────────────────────────────────────────────

    public AthasianSpellParserService(
        ILogger<AthasianSpellParserService> logger,
        IOptions<SpellParserOptions> options)
    {
        _logger = logger;
        _options = options.Value;
    }

    // ── ISpellParserService ───────────────────────────────────────────────────

    /// <inheritdoc/>
    public async IAsyncEnumerable<ParsedSpell> ParseSpellsAsync(
        string pdfPath,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (!File.Exists(pdfPath))
            throw new FileNotFoundException("PDF not found.", pdfPath);

        _logger.LogInformation("Opening PDF: {Path}", pdfPath);

        var rawBlocks = ExtractSpellBlocks(pdfPath, cancellationToken);
        int index = 0;

        await foreach (var block in rawBlocks.WithCancellation(cancellationToken))
        {
            cancellationToken.ThrowIfCancellationRequested();

            ParsedSpell? spell = null;
            try
            {
                spell = ConvertBlockToSpell(block);
                index++;
                _logger.LogInformation("[{Index}] Parsed: {Name}", index, spell.Name);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to parse spell block starting with: {Header}",
                    block.HeaderLine);
            }

            if (spell is not null)
                yield return spell;
        }

        _logger.LogInformation("Total spells parsed: {Count}", index);
    }

    /// <inheritdoc/>
    public async Task ExportMarkdownAsync(
        IEnumerable<ParsedSpell> spells,
        CancellationToken cancellationToken = default)
    {
        var dir = _options.MarkdownOutputDirectory;
        Directory.CreateDirectory(dir);

        foreach (var spell in spells)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var fileName = $"{spell.Id}.md";
            var path = Path.Combine(dir, fileName);

            if (!_options.OverwriteExisting && File.Exists(path))
            {
                _logger.LogDebug("Skipping existing file: {Path}", path);
                continue;
            }

            var markdown = MarkdownBuilder.Build(spell);
            await File.WriteAllTextAsync(path, markdown, Encoding.UTF8, cancellationToken);
            _logger.LogInformation("Wrote Markdown → {Path}", path);
        }
    }

    /// <inheritdoc/>
    public async Task ExportJsonAsync(
        IEnumerable<ParsedSpell> spells,
        CancellationToken cancellationToken = default)
    {
        var entities = spells.Select(DarkSunSpell.FromParsedSpell).ToList();

        var dir = Path.GetDirectoryName(_options.JsonOutputPath);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);

        var json = JsonSerializer.Serialize(entities, new JsonSerializerOptions
        {
            WriteIndented = true
        });

        await File.WriteAllTextAsync(_options.JsonOutputPath, json, Encoding.UTF8,
            cancellationToken);

        _logger.LogInformation("Wrote JSON seed ({Count} spells) → {Path}",
            entities.Count, _options.JsonOutputPath);
    }

    // ── PDF extraction ────────────────────────────────────────────────────────

    /// <summary>
    /// Yields raw spell blocks extracted from the PDF page-by-page.
    /// </summary>
    private async IAsyncEnumerable<RawSpellBlock> ExtractSpellBlocks(
        string pdfPath,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        // PdfPig is synchronous; we wrap it in a Task.Run to avoid blocking the
        // calling thread while still honouring async / await patterns.
        var blocks = await Task.Run(() => ReadPdfBlocks(pdfPath, cancellationToken),
            cancellationToken);

        foreach (var block in blocks)
            yield return block;
    }

    private List<RawSpellBlock> ReadPdfBlocks(string pdfPath,
        CancellationToken cancellationToken)
    {
        var allBlocks = new List<RawSpellBlock>();

        using var doc = PdfDocument.Open(pdfPath);
        _logger.LogDebug("PDF has {Pages} pages", doc.NumberOfPages);

        // Accumulate all page text lines first, then detect boundaries.
        var allLines = new List<(string Text, int PageNumber)>();

        for (int p = 1; p <= doc.NumberOfPages; p++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var page = doc.GetPage(p);
            var pageText = ExtractPageText(page);

            foreach (var line in pageText.Split('\n',
                         StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
            {
                allLines.Add((line, p));
            }

            _logger.LogTrace("Page {Page}: {LineCount} lines", p,
                pageText.Split('\n').Length);
        }

        // Detect spell-header lines
        RawSpellBlock? current = null;

        foreach (var (text, page) in allLines)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (IsSpellHeader(text, out string spellName, out SpellType spellType))
            {
                if (current is not null)
                    allBlocks.Add(current);

                current = new RawSpellBlock
                {
                    HeaderLine = text,
                    DetectedName = spellName,
                    DetectedSpellType = spellType,
                    PageNumber = page,
                    Lines = [text]
                };
            }
            else
            {
                current?.Lines.Add(text);
            }
        }

        if (current is not null)
            allBlocks.Add(current);

        _logger.LogInformation("Found {Count} candidate spell blocks", allBlocks.Count);
        return allBlocks;
    }

    /// <summary>
    /// Extracts text from a single page, preserving newlines between text blocks.
    /// PdfPig groups characters into words; we reconstruct lines by y-position.
    /// </summary>
    private static string ExtractPageText(Page page)
    {
        var wordsByLine = page.GetWords()
            .GroupBy(w => Math.Round(w.BoundingBox.Bottom, 0))
            .OrderByDescending(g => g.Key)
            .Select(g => string.Join(" ", g.OrderBy(w => w.BoundingBox.Left)
                                           .Select(w => w.Text)));

        return string.Join("\n", wordsByLine);
    }

    /// <summary>
    /// Returns true and populates <paramref name="spellName"/> / <paramref name="spellType"/>
    /// when <paramref name="line"/> looks like a 2e spell header.
    /// </summary>
    private static bool IsSpellHeader(
        string line,
        out string spellName,
        out SpellType spellType)
    {
        spellName = string.Empty;
        spellType = SpellType.Priest;

        var m = SpellHeaderRegex.Match(line);
        if (!m.Success) return false;

        spellName = ToTitleCase(m.Groups["name"].Value.Trim());
        var cls = m.Groups["cls"].Value;
        spellType = cls is "Pr" or "P" ? SpellType.Priest : SpellType.Wizard;
        return true;
    }

    // ── Block → ParsedSpell conversion ───────────────────────────────────────

    private ParsedSpell ConvertBlockToSpell(RawSpellBlock block)
    {
        var fields = ExtractFields(block.Lines);

        var level = ParseLevel(fields, block);
        var school = ParseSchool(fields, block);
        var spellType = block.DetectedSpellType;
        var components = ParseComponents(fields);
        var spheres = ParseSpheres(fields, block);
        var description = ExtractDescription(block.Lines);

        var spellId = Slugify(block.DetectedName);

        var fiveE = new FiveEMechanics
        {
            Level = ConvertLevel(level, spellType),
            School = school,
            CastingTime = Convert2eCastingTime(fields.GetValueOrDefault("CastingTime", "1 action")),
            Range = Convert2eRange(fields.GetValueOrDefault("Range", "Self")),
            Components = components,
            MaterialComponent = fields.GetValueOrDefault("MaterialComponent"),
            Duration = Convert2eDuration(fields.GetValueOrDefault("Duration", "Instantaneous")),
            Concentration = IsConcentration(fields.GetValueOrDefault("Duration", string.Empty)),
            Description = description,
            SavingThrow = fields.GetValueOrDefault("SavingThrow")
        };

        var athasian = BuildAthasianVariant(spheres, spellType, block, fields);
        var tags = BuildTags(spellType, spheres, school);
        var flavor = BuildFlavorText(block.DetectedName, spheres, description);
        var artPrompt = BuildArtworkPrompt(block.DetectedName, spheres);

        return new ParsedSpell
        {
            Id = spellId,
            Name = block.DetectedName,
            Type = "Spell",
            SpellType = spellType,
            SourceName = _options.SourceBookName,
            SourcePage = block.PageNumber,
            Mechanics = fiveE,
            FlavorText = flavor,
            ArtworkPrompt = artPrompt,
            Tags = tags,
            AthasianVariant = athasian,
            ParsedAt = DateTimeOffset.UtcNow
        };
    }

    // ── Field extractors ──────────────────────────────────────────────────────

    private static Dictionary<string, string> ExtractFields(List<string> lines)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var line in lines)
        {
            var m = FieldLineRegex.Match(line);
            if (!m.Success) continue;

            var field = NormaliseFieldName(m.Groups["field"].Value.Trim());
            var value = m.Groups["value"].Value.Trim();

            result.TryAdd(field, value);
        }

        return result;
    }

    private static string NormaliseFieldName(string raw) => raw.ToLowerInvariant() switch
    {
        "range" => "Range",
        "duration" => "Duration",
        "casting time" or "castingtime" => "CastingTime",
        "area of effect" or "areaofeffect" => "AreaOfEffect",
        "saving throw" or "savingthrow" => "SavingThrow",
        "components" or "component" => "Components",
        "school" => "School",
        "sphere" => "Sphere",
        _ => raw
    };

    private static int ParseLevel(Dictionary<string, string> fields, RawSpellBlock block)
    {
        // Try the block header regex first
        var m = SpellHeaderRegex.Match(block.HeaderLine);
        if (m.Success && int.TryParse(m.Groups["lvl"].Value, out int headerLevel))
            return headerLevel;

        // Fall back to a "Level:" line in the block
        foreach (var line in block.Lines)
        {
            var lm = LevelLineRegex.Match(line);
            if (lm.Success && int.TryParse(lm.Groups["lvl"].Value, out int lineLevel))
                return lineLevel;
        }

        return 1;
    }

    private static SpellSchool ParseSchool(Dictionary<string, string> fields,
        RawSpellBlock block)
    {
        // From the "School:" field
        if (fields.TryGetValue("School", out var schoolStr) &&
            SchoolMap.TryGetValue(schoolStr.Trim(), out var school))
            return school;

        // From the header parenthetical
        var m = SpellHeaderRegex.Match(block.HeaderLine);
        if (m.Success)
        {
            var label = m.Groups["school"].Value.Trim();
            if (!string.IsNullOrEmpty(label) && SchoolMap.TryGetValue(label, out var s))
                return s;
        }

        // From the "Sphere:" field
        if (fields.TryGetValue("Sphere", out var sphereStr))
        {
            foreach (var part in sphereStr.Split(',', '/'))
            {
                if (SchoolMap.TryGetValue(part.Trim(), out var ss))
                    return ss;
            }
        }

        return SpellSchool.Conjuration;  // Default for most Priest spells
    }

    private static List<string> ParseComponents(Dictionary<string, string> fields)
    {
        var comps = new List<string>();

        if (!fields.TryGetValue("Components", out var raw)) return comps;

        var parts = raw.Split(',', StringSplitOptions.TrimEntries |
                                   StringSplitOptions.RemoveEmptyEntries);
        foreach (var p in parts)
        {
            var upper = p.ToUpperInvariant();
            if (upper.StartsWith("V")) comps.Add("V");
            else if (upper.StartsWith("S")) comps.Add("S");
            else if (upper.StartsWith("M"))
            {
                comps.Add("M");
                // Anything after the comma following M is the material description
            }
        }

        // Also check if a material component line is present
        foreach (var line in fields.Keys)
        {
            if (line.Equals("MaterialComponent", StringComparison.OrdinalIgnoreCase))
            {
                if (!comps.Contains("M")) comps.Add("M");
                break;
            }
        }

        return comps.Distinct().Order().ToList();
    }

    private static List<string> ParseSpheres(Dictionary<string, string> fields,
        RawSpellBlock block)
    {
        var spheres = new List<string>();
        string? raw = null;

        if (!fields.TryGetValue("Sphere", out raw))
        {
            // Search the block lines for a "Sphere(s):" pattern
            foreach (var line in block.Lines)
            {
                var idx = line.IndexOf("Sphere", StringComparison.OrdinalIgnoreCase);
                if (idx >= 0)
                {
                    var colon = line.IndexOf(':', idx);
                    if (colon >= 0)
                    {
                        raw = line[(colon + 1)..].Trim();
                        break;
                    }
                }
            }
        }

        if (string.IsNullOrEmpty(raw)) return spheres;

        foreach (var part in raw.Split(new[] { ',', '/', '|' },
                     StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            var clean = ElementalSphereRegex.Match(part).Value;
            if (!string.IsNullOrEmpty(clean))
                spheres.Add(ToTitleCase(clean));
        }

        return spheres.Distinct().ToList();
    }

    private static string ExtractDescription(List<string> lines)
    {
        // Description starts after all the labelled field lines and the blank
        // separator that typically follows in 2e layout.
        bool inDesc = false;
        var sb = new StringBuilder();
        int fieldLineCount = 0;

        foreach (var line in lines)
        {
            if (FieldLineRegex.IsMatch(line))
            {
                fieldLineCount++;
                inDesc = false;
                continue;
            }

            // The blank line / short line after the fields begins the description
            if (fieldLineCount >= 2 && !inDesc && line.Length < 10)
            {
                inDesc = true;
                continue;
            }

            if (inDesc && line.Length > 0)
                sb.AppendLine(line);
        }

        var raw = sb.ToString().Trim();
        return string.IsNullOrWhiteSpace(raw) ? "See source for description." : raw;
    }

    // ── 2e → 5e conversion helpers ────────────────────────────────────────────

    /// <summary>
    /// 2e level maps mostly 1:1 up to 5 for Priest spells (equivalent to 5e cantrip/1st-5th).
    /// Wizard (Wz) levels map similarly.
    /// </summary>
    private static int ConvertLevel(int twoELevel, SpellType spellType)
    {
        // Priest spells: 2e level 1 → 5e level 1, etc. up to max 9.
        // Wizard spells: same direct mapping.
        return Math.Clamp(twoELevel, 0, 9);
    }

    private static string Convert2eCastingTime(string raw)
    {
        // 2e: "1", "2 rnds", "1 turn", "3" (segments of 6 seconds each in AD&D)
        if (string.IsNullOrWhiteSpace(raw)) return "1 action";

        var lower = raw.ToLowerInvariant().Trim();

        if (lower is "1" or "1 segment")
            return "1 action";
        if (lower.Contains("round") || lower.Contains("rnd"))
            return "1 minute";
        if (lower.Contains("turn"))
            return "10 minutes";
        if (int.TryParse(lower, out int seg) && seg <= 6)
            return "1 action";
        if (int.TryParse(lower, out int seg2) && seg2 <= 60)
            return "1 bonus action";

        return raw;
    }

    private static string Convert2eRange(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "Self";

        var lower = raw.ToLowerInvariant().Trim();

        if (lower is "0" or "touch" or "caster")
            return "Touch";
        if (lower is "self")
            return "Self";

        // Convert yards → feet (1 yard = 3 feet)
        var mYd = Regex.Match(lower, @"(\d+)\s*yd");
        if (mYd.Success && int.TryParse(mYd.Groups[1].Value, out int yards))
            return $"{yards * 3} feet";

        var mFt = Regex.Match(lower, @"(\d+)\s*ft");
        if (mFt.Success)
            return $"{mFt.Groups[1].Value} feet";

        return ToTitleCase(raw);
    }

    private static string Convert2eDuration(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "Instantaneous";

        var lower = raw.ToLowerInvariant().Trim();

        if (lower is "instantaneous" or "instant" or "0")
            return "Instantaneous";
        if (lower is "permanent" or "until dispelled")
            return "Until dispelled";
        if (lower.Contains("round"))
            return Regex.Replace(lower, @"rounds?", "rounds");
        if (lower.Contains("turn"))
            return Regex.Replace(lower, @"turns?", "minutes");

        return ToTitleCase(raw);
    }

    private static bool IsConcentration(string duration)
    {
        var l = duration.ToLowerInvariant();
        return l.Contains("concentration") || l.Contains("conc.");
    }

    // ── Athasian variant builder ───────────────────────────────────────────────

    private AthasianVariant BuildAthasianVariant(
        List<string> spheres,
        SpellType spellType,
        RawSpellBlock block,
        Dictionary<string, string> fields)
    {
        // Determine major vs minor sphere based on spell level:
        // Level 1-3 = minor, 4+ = major (simplified heuristic).
        var level = ParseLevel(fields, block);
        var major = level >= 4 ? spheres : new List<string>();
        var minor = level < 4 ? spheres : new List<string>();

        // Plane source: if sphere is Water / Earth / Fire / Air use elemental plane names.
        string? planeSource = spheres.Count > 0
            ? $"Elemental Plane of {spheres[0]}"
            : null;

        // Athasian components: on Athas, pure water, uncontaminated earth, etc. are rare.
        var athasianComps = BuildAthasianComponents(spheres, fields);

        // Defiler cost: Wizard spells always note defiler potential.
        string? defilerCost = spellType == SpellType.Wizard
            ? "Standard defiling radius per caster level."
            : null;

        return new AthasianVariant
        {
            MajorSpheres = major,
            MinorSpheres = minor,
            DefilerCost = defilerCost,
            PlaneSource = planeSource,
            AthasianComponents = athasianComps,
        };
    }

    private static List<string> BuildAthasianComponents(
        List<string> spheres,
        Dictionary<string, string> fields)
    {
        var comps = new List<string>();

        if (spheres.Contains("Water", StringComparer.OrdinalIgnoreCase))
            comps.Add("A small vial of clean water (extremely rare on Athas)");
        if (spheres.Contains("Earth", StringComparer.OrdinalIgnoreCase))
            comps.Add("A handful of undefiled soil");
        if (spheres.Contains("Fire", StringComparer.OrdinalIgnoreCase))
            comps.Add("An ember from a fire lit without arcane defiling");
        if (spheres.Contains("Air", StringComparer.OrdinalIgnoreCase))
            comps.Add("A feather from a free-flying bird");

        if (fields.TryGetValue("MaterialComponent", out var mat) &&
            !string.IsNullOrWhiteSpace(mat))
            comps.Add(mat);

        return comps;
    }

    // ── Tag builder ───────────────────────────────────────────────────────────

    private List<string> BuildTags(
        SpellType spellType,
        List<string> spheres,
        SpellSchool school)
    {
        var tags = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "#dark-sun",
            "#athas",
            spellType == SpellType.Priest ? "#priest" : "#wizard",
            $"#{school.ToString().ToLowerInvariant()}"
        };

        foreach (var sphere in spheres)
            tags.Add($"#sphere-{sphere.ToLowerInvariant().Replace(" ", "-")}");

        if (spheres.Any(s => s.Equals("Water", StringComparison.OrdinalIgnoreCase) ||
                              s.Equals("Earth", StringComparison.OrdinalIgnoreCase) ||
                              s.Equals("Fire", StringComparison.OrdinalIgnoreCase) ||
                              s.Equals("Air", StringComparison.OrdinalIgnoreCase)))
            tags.Add("#elemental");

        return [.. tags.Order()];
    }

    // ── Flavor & artwork ──────────────────────────────────────────────────────

    private string BuildFlavorText(
        string spellName,
        List<string> spheres,
        string description)
    {
        var sphereDesc = spheres.Count > 0
            ? $"the elemental sphere of {string.Join(" and ", spheres)}"
            : "the dying elements of Athas";

        var flavor =
            $"Beneath the crimson sun of Athas, where the last springs have long since " +
            $"turned to salt flats, to command {sphereDesc} is both a miracle and a curse. " +
            $"{spellName} is one of the rare gifts granted by the elemental lords " +
            $"to those priests who have not forsaken the old compact—water given freely, " +
            $"earth that remembers green, fire that does not consume its caster. " +
            $"But Athas is a world of entropy. Every use of elemental power draws the " +
            $"notice of templars, defilers, and worse. The wise templar casts in shadows; " +
            $"the reckless one is found dead by morning with obsidian slivers where his eyes should be.";

        // Enforce max word count
        var words = flavor.Split(' ');
        if (words.Length > _options.MaxFlavorWordCount)
            flavor = string.Join(' ', words.Take(_options.MaxFlavorWordCount)) + "…";

        return flavor;
    }

    private static string BuildArtworkPrompt(string spellName, List<string> spheres)
    {
        var sphereVisual = spheres.Count > 0
            ? $"elemental {spheres[0].ToLowerInvariant()} energy"
            : "raw elemental force";

        return $"A gaunt Athasian cleric channeling {sphereVisual} through cracked " +
               $"obsidian hands, casting {spellName} under a bloated crimson sun, " +
               $"parched red-rock desert stretching to the horizon, robes tattered and " +
               $"dust-caked, desperate reverence in hollow eyes, " +
               $", Gerald Brom style, Dark Sun campaign setting, grimdark, surreal, " +
               $"detailed anatomy, cinematic lighting, desaturated colors";
    }

    // ── String utilities ──────────────────────────────────────────────────────

    private static string Slugify(string name) =>
        Regex.Replace(name.ToLowerInvariant().Trim(), @"[^a-z0-9]+", "-")
             .Trim('-');

    private static string ToTitleCase(string s)
    {
        if (string.IsNullOrWhiteSpace(s)) return s;
        return string.Join(' ', s.Split(' ')
            .Select(w => w.Length > 0
                ? char.ToUpperInvariant(w[0]) + w[1..].ToLowerInvariant()
                : w));
    }

    // ── Inner types ───────────────────────────────────────────────────────────

    /// <summary>
    /// Intermediate representation of a raw spell text block before 5e conversion.
    /// </summary>
    private sealed class RawSpellBlock
    {
        public string HeaderLine { get; set; } = string.Empty;
        public string DetectedName { get; set; } = string.Empty;
        public SpellType DetectedSpellType { get; set; }
        public int PageNumber { get; set; }
        public List<string> Lines { get; set; } = [];
    }
}
