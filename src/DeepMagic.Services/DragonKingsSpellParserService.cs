using DeepMagic.Core.Interfaces;
using DeepMagic.Core.Models;
using Microsoft.Extensions.Logging;
using System.Runtime.CompilerServices;
using System.Text.Json;

namespace DeepMagic.Services;

public class DragonKingsSpellParserService : ISpellParserService
{
    private readonly DragonKingsSpellExtractor _extractor;
    private readonly ILogger<DragonKingsSpellParserService> _logger;

    public DragonKingsSpellParserService(
        DragonKingsSpellExtractor extractor,
        ILogger<DragonKingsSpellParserService> logger)
    {
        _extractor = extractor;
        _logger = logger;
    }

    public async IAsyncEnumerable<ParsedSpell> ParseSpellsAsync(
        string pdfPath,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Using Dragon Kings specific extractor for: {Path}", pdfPath);

        var dkSpells = _extractor.ExtractSpells(pdfPath, startPage: 83, endPage: 112);
        _logger.LogInformation("Dragon Kings extractor found {Count} raw spells", dkSpells.Count);

        foreach (var dkSpell in dkSpells)
        {
            if (cancellationToken.IsCancellationRequested)
                yield break;

            yield return ConvertToParsedSpell(dkSpell);
        }

        await Task.CompletedTask;
    }

    public async Task ExportMarkdownAsync(IEnumerable<ParsedSpell> spells, CancellationToken cancellationToken = default)
    {
        var path = "output/dragon-kings-spells.md";
        Directory.CreateDirectory("output");

        var lines = new List<string> { "# Dragon Kings Spells\n" };

        foreach (var spell in spells)
        {
            lines.Add($"## {spell.Name} (Level {spell.Mechanics.Level})");
            lines.Add($"**School:** {spell.Mechanics.School}");
            lines.Add($"**Source:** {spell.SourceName} p.{spell.SourcePage}");
            lines.Add("");
            lines.Add(spell.Mechanics.Description);
            lines.Add("");
        }

        await File.WriteAllLinesAsync(path, lines, cancellationToken);
        _logger.LogInformation("Exported {Count} spells to {Path}", spells.Count(), path);
    }

    public async Task ExportJsonAsync(IEnumerable<ParsedSpell> spells, CancellationToken cancellationToken = default)
    {
        var path = "output/dragon-kings-spells.json";
        Directory.CreateDirectory("output");

        var options = new JsonSerializerOptions { WriteIndented = true };
        await File.WriteAllTextAsync(path, JsonSerializer.Serialize(spells, options), cancellationToken);

        _logger.LogInformation("Exported {Count} spells to {Path}", spells.Count(), path);
    }

    private ParsedSpell ConvertToParsedSpell(DragonKingsSpell dk)
    {
        return new ParsedSpell
        {
            Id = dk.Name.ToLower().Replace(" ", "-"),
            Name = dk.Name,
            Type = "Spell",
            SpellType = SpellType.Wizard,
            SourceName = "Dragon Kings",
            SourcePage = dk.PageNumber,

            Mechanics = new FiveEMechanics
            {
                Level = dk.Level,
                School = ParseSchool(dk.School),
                CastingTime = dk.CastingTime,
                Range = dk.Range,
                Components = string.IsNullOrWhiteSpace(dk.Components)
                    ? new List<string>()
                    : dk.Components.Split(',').Select(c => c.Trim()).ToList(),
                Duration = dk.Duration,
                Description = dk.Description
            },

            FlavorText = "",
            ArtworkPrompt = "",
            Tags = new List<string> { "#dragon-kings", "#athas", "#spell" },
            RelatedEntries = new List<string>()
        };
    }

    private SpellSchool ParseSchool(string school) =>
        school.ToLower() switch
        {
            var s when s.Contains("evocation") => SpellSchool.Evocation,
            var s when s.Contains("conjuration") => SpellSchool.Conjuration,
            var s when s.Contains("necromancy") => SpellSchool.Necromancy,
            var s when s.Contains("alteration") => SpellSchool.Alteration,
            _ => SpellSchool.Universal
        };
}