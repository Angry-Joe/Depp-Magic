using UglyToad.PdfPig;
using UglyToad.PdfPig.DocumentLayoutAnalysis;
using Microsoft.Extensions.Logging;
using System.Text.RegularExpressions;

namespace DeepMagic.Services;

public class DragonKingsSpellExtractor
{
    private readonly ILogger<DragonKingsSpellExtractor> _logger;

    public DragonKingsSpellExtractor(ILogger<DragonKingsSpellExtractor> logger)
    {
        _logger = logger;
    }

    private static readonly Regex SpellHeaderRegex = new(
        @"^(?<Name>[A-Z][A-Za-z\s\-'\.]+?)\s*\((?<School>[A-Za-z\s]+?)\)\s*(?:Level\s*)?(?<Level>\d+)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public List<DragonKingsSpell> ExtractSpells(string pdfPath, int startPage = 1, int endPage = 999)
    {
        var spells = new List<DragonKingsSpell>();

        using var document = PdfDocument.Open(pdfPath);

        var pagesToProcess = document.GetPages()
            .Where(p => p.Number >= startPage && p.Number <= endPage);

        foreach (var page in pagesToProcess)
        {
            var words = page.GetWords();
            var text = string.Join(" ", words
                .OrderBy(w => w.BoundingBox.BottomLeft.Y)
                .ThenBy(w => w.BoundingBox.BottomLeft.X)
                .Select(w => w.Text));

            text = text.Replace("-\n", " ").Replace("\n", " ").Replace("  ", " ").Trim();

            var matches = SpellHeaderRegex.Matches(text);

            foreach (Match match in matches)
            {
                var name = match.Groups["Name"].Value.Trim();
                var school = match.Groups["School"].Value.Trim();
                var level = int.Parse(match.Groups["Level"].Value);

                // Basic sanity check — real spells usually have reasonable levels
                if (level > 0 && level <= 9)
                {
                    spells.Add(new DragonKingsSpell(
                        Name: name,
                        School: school,
                        Level: level,
                        CastingTime: "",
                        Range: "",
                        Components: "",
                        Duration: "",
                        Description: "",
                        PageNumber: page.Number
                    ));
                }
            }
        }

        _logger.LogInformation("Dragon Kings extractor found {Count} spells on pages {Start}-{End}",
            spells.Count, startPage, endPage);

        return spells;
    }
}