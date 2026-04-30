using DeepMagic.Core.Models;
using DeepMagic.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace DeepMagic.Tests;

/// <summary>
/// Unit tests for <see cref="AthasianSpellParserService"/> covering the public API
/// and the internal helpers that are observable via output artefacts.
/// </summary>
public class AthasianSpellParserServiceTests : IDisposable
{
    private readonly string _tempDir;
    private readonly AthasianSpellParserService _service;

    public AthasianSpellParserServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        Directory.CreateDirectory(_tempDir);

        var opts = Options.Create(new SpellParserOptions
        {
            SourceBookName          = "Test Book",
            MarkdownOutputDirectory = Path.Combine(_tempDir, "md"),
            JsonOutputPath          = Path.Combine(_tempDir, "spells.json"),
            OverwriteExisting       = true,
            MaxFlavorWordCount      = 300
        });

        _service = new AthasianSpellParserService(
            NullLogger<AthasianSpellParserService>.Instance, opts);
    }

    public void Dispose() => Directory.Delete(_tempDir, recursive: true);

    // ── ParseSpellsAsync ──────────────────────────────────────────────────────

    [Fact]
    public async Task ParseSpellsAsync_ThrowsFileNotFoundException_WhenPdfMissing()
    {
        await Assert.ThrowsAsync<FileNotFoundException>(async () =>
        {
            await foreach (var _ in _service.ParseSpellsAsync("/nonexistent/path.pdf"))
            {
                // drain
            }
        });
    }

    // ── ExportMarkdownAsync ───────────────────────────────────────────────────

    [Fact]
    public async Task ExportMarkdownAsync_CreatesMarkdownFile_WithCorrectContent()
    {
        var spell = BuildCreateWaterSpell();

        await _service.ExportMarkdownAsync([spell]);

        var mdPath = Path.Combine(_tempDir, "md", "create-water.md");
        Assert.True(File.Exists(mdPath), "Markdown file should be created.");

        var content = await File.ReadAllTextAsync(mdPath);
        Assert.Contains("# Create Water", content);
        Assert.Contains("## 5e Mechanics", content);
        Assert.Contains("## Athasian Variant", content);
        Assert.Contains("Gerald Brom style", content);
        Assert.Contains("#dark-sun", content);
    }

    [Fact]
    public async Task ExportMarkdownAsync_DoesNotOverwrite_WhenOverwriteExistingFalse()
    {
        var opts = Options.Create(new SpellParserOptions
        {
            MarkdownOutputDirectory = Path.Combine(_tempDir, "md-no-overwrite"),
            JsonOutputPath          = Path.Combine(_tempDir, "spells2.json"),
            OverwriteExisting       = false
        });
        var svc = new AthasianSpellParserService(
            NullLogger<AthasianSpellParserService>.Instance, opts);

        var spell = BuildCreateWaterSpell();
        await svc.ExportMarkdownAsync([spell]);

        // Write sentinel content to the file
        var mdPath = Path.Combine(_tempDir, "md-no-overwrite", "create-water.md");
        await File.WriteAllTextAsync(mdPath, "SENTINEL");

        // Export again – file should still have sentinel content
        await svc.ExportMarkdownAsync([spell]);
        var content = await File.ReadAllTextAsync(mdPath);
        Assert.Equal("SENTINEL", content);
    }

    // ── ExportJsonAsync ───────────────────────────────────────────────────────

    [Fact]
    public async Task ExportJsonAsync_CreatesValidJson_WithDarkSunSpellSchema()
    {
        var spell = BuildCreateWaterSpell();

        await _service.ExportJsonAsync([spell]);

        var jsonPath = Path.Combine(_tempDir, "spells.json");
        Assert.True(File.Exists(jsonPath), "JSON file should be created.");

        var json = await File.ReadAllTextAsync(jsonPath);
        Assert.Contains("\"PK\": \"SPELL\"", json);
        Assert.Contains("\"SK\": \"create-water\"", json);
        Assert.Contains("\"name\": \"Create Water\"", json);
        Assert.Contains("\"school\": \"Conjuration\"", json);
        Assert.Contains("\"athasianVariant\"", json);
    }

    [Fact]
    public async Task ExportJsonAsync_MultipleSpells_AllAppearInOutput()
    {
        var spells = new[]
        {
            BuildCreateWaterSpell(),
            BuildCreateWaterSpell() with
            {
                Id   = "purify-water",
                Name = "Purify Water"
            }
        };

        await _service.ExportJsonAsync(spells);

        var json = await File.ReadAllTextAsync(Path.Combine(_tempDir, "spells.json"));
        Assert.Contains("create-water", json);
        Assert.Contains("purify-water", json);
    }

    // ── DarkSunSpell.FromParsedSpell ──────────────────────────────────────────

    [Fact]
    public void FromParsedSpell_MapsAllFields_Correctly()
    {
        var spell = BuildCreateWaterSpell();
        var entity = DarkSunSpell.FromParsedSpell(spell);

        Assert.Equal("SPELL", entity.PK);
        Assert.Equal("create-water", entity.SK);
        Assert.Equal("Create Water", entity.Name);
        Assert.Equal("Spell", entity.Type);
        Assert.Equal("Priest", entity.SpellType);
        Assert.Equal("Test Book", entity.SourceName);
        Assert.Equal(95, entity.SourcePage);
        Assert.Equal(1, entity.Level);
        Assert.Equal("Conjuration", entity.School);
        Assert.Equal("1 action", entity.CastingTime);
        Assert.Equal("30 feet", entity.Range);
        Assert.Contains("V", entity.Components);
        Assert.Contains("S", entity.Components);
        Assert.Contains("M", entity.Components);
        Assert.Equal("Instantaneous", entity.Duration);
        Assert.False(entity.Concentration);
        Assert.False(entity.Ritual);
        Assert.NotEmpty(entity.FlavorText);
        Assert.Contains("Gerald Brom style", entity.ArtworkPrompt);
        Assert.Contains("#dark-sun", entity.Tags);
        Assert.NotNull(entity.AthasianVariant);
        Assert.Contains("Water", entity.AthasianVariant.MinorSpheres);
    }

    // ── SpellSeederService ────────────────────────────────────────────────────

    [Fact]
    public async Task SpellSeeder_RoundTrip_LoadsEntitiesFromExportedJson()
    {
        var spell = BuildCreateWaterSpell();
        await _service.ExportJsonAsync([spell]);

        var seeder = new SpellSeederService(
            NullLogger<SpellSeederService>.Instance);

        var entities = await seeder.LoadFromJsonAsync(
            Path.Combine(_tempDir, "spells.json"));

        Assert.Single(entities);
        Assert.Equal("create-water", entities[0].SK);
        Assert.Equal("Create Water", entities[0].Name);
    }

    [Fact]
    public async Task SpellSeeder_ThrowsFileNotFoundException_WhenJsonMissing()
    {
        var seeder = new SpellSeederService(
            NullLogger<SpellSeederService>.Instance);

        await Assert.ThrowsAsync<FileNotFoundException>(
            () => seeder.LoadFromJsonAsync("/no/such/file.json"));
    }

    [Fact]
    public void SpellSeeder_ToEntities_ConvertsCollection()
    {
        var seeder = new SpellSeederService(
            NullLogger<SpellSeederService>.Instance);

        var spells = new[] { BuildCreateWaterSpell() };
        var entities = seeder.ToEntities(spells);

        Assert.Single(entities);
        Assert.Equal("create-water", entities[0].SK);
    }

    // ── AthasianVariant ───────────────────────────────────────────────────────

    [Fact]
    public void AthasianVariant_DefaultValues_AreEmpty()
    {
        var v = new AthasianVariant();

        Assert.Empty(v.MajorSpheres);
        Assert.Empty(v.MinorSpheres);
        Assert.Null(v.DefilerCost);
        Assert.Null(v.PlaneSource);
        Assert.Empty(v.AthasianComponents);
        Assert.False(v.IsRareLostKnowledge);
    }

    [Fact]
    public void AthasianVariant_WithExpression_ProducesImmutableCopy()
    {
        var original = new AthasianVariant
        {
            MajorSpheres  = ["Water"],
            PlaneSource   = "Elemental Plane of Water",
            DefilerCost   = "Standard defiling radius"
        };

        var copy = original with { DefilerCost = "None" };

        Assert.Equal("Standard defiling radius", original.DefilerCost);
        Assert.Equal("None", copy.DefilerCost);
        Assert.Equal(original.PlaneSource, copy.PlaneSource);
    }

    // ── MarkdownBuilder ───────────────────────────────────────────────────────

    [Fact]
    public void MarkdownBuilder_IncludesAllRequiredSections()
    {
        var spell = BuildCreateWaterSpell();
        var md = MarkdownBuilder.Build(spell);

        Assert.Contains("# Create Water", md);
        Assert.Contains("## 5e Mechanics", md);
        Assert.Contains("## Flavor / Lore", md);
        Assert.Contains("## Artwork Prompt", md);
        Assert.Contains("## Athasian Variant", md);
        Assert.Contains("## Tags", md);
    }

    [Fact]
    public void MarkdownBuilder_ArtworkPrompt_EndsWithRequiredSuffix()
    {
        var spell = BuildCreateWaterSpell();
        var md = MarkdownBuilder.Build(spell);

        Assert.Contains(
            "Gerald Brom style, Dark Sun campaign setting, grimdark, surreal, detailed anatomy, cinematic lighting, desaturated colors",
            md);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static ParsedSpell BuildCreateWaterSpell() => new()
    {
        Id         = "create-water",
        Name       = "Create Water",
        Type       = "Spell",
        SpellType  = SpellType.Priest,
        SourceName = "Test Book",
        SourcePage = 95,

        Mechanics = new FiveEMechanics
        {
            Level             = 1,
            School            = SpellSchool.Conjuration,
            CastingTime       = "1 action",
            Range             = "30 feet",
            Components        = ["V", "S", "M"],
            MaterialComponent = "a drop of water and a pinch of sand",
            Duration          = "Instantaneous",
            Concentration     = false,
            Ritual            = false,
            Description       = "You conjure up to 10 gallons of clean water within range.",
            SavingThrow       = "None"
        },

        FlavorText =
            "In the dying world of Athas, clean water is more precious than obsidian steel.",

        ArtworkPrompt =
            "A gaunt Athasian Water cleric conjuring water from cracked red clay, " +
            ", Gerald Brom style, Dark Sun campaign setting, grimdark, surreal, " +
            "detailed anatomy, cinematic lighting, desaturated colors",

        Tags = ["#athas", "#conjuration", "#dark-sun", "#elemental", "#priest", "#sphere-water"],

        RelatedEntries = ["Purify Water"],

        AthasianVariant = new AthasianVariant
        {
            MajorSpheres       = [],
            MinorSpheres       = ["Water", "Creation"],
            DefilerCost        = null,
            PlaneSource        = "Elemental Plane of Water",
            AthasianComponents = ["A vial of clean water"],
            IsRareLostKnowledge = false
        }
    };
}
