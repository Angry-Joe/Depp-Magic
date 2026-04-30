using DeepMagic.Core.Interfaces;
using DeepMagic.Core.Models;
using DeepMagic.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

var builder = Host.CreateApplicationBuilder(args);

// Configure the spell parser
builder.Services.AddDeepMagicServices(options =>
{
    options.SourceBookName         = "Dark Sun Revised Boxed Set";
    options.MarkdownOutputDirectory = "output/markdown";
    options.JsonOutputPath          = "output/priest-spells.json";
    options.OverwriteExisting       = true;
    options.MaxFlavorWordCount      = 300;
});

builder.Logging.AddConsole();

var app = builder.Build();

// ── Example usage ─────────────────────────────────────────────────────────────

var logger  = app.Services.GetRequiredService<ILogger<Program>>();
var parser  = app.Services.GetRequiredService<ISpellParserService>();
var seeder  = app.Services.GetRequiredService<ISpellSeederService>();

// When a real PDF is supplied as a CLI argument, parse it.
// Otherwise, inject the hardcoded "Create Water" example to demonstrate the pipeline.

string? pdfPath = args.Length > 0 ? args[0] : null;

List<ParsedSpell> spells;

if (pdfPath is not null && File.Exists(pdfPath))
{
    logger.LogInformation("Parsing spells from PDF: {Path}", pdfPath);

    spells = [];
    await foreach (var spell in parser.ParseSpellsAsync(pdfPath))
        spells.Add(spell);

    logger.LogInformation("Total spells parsed from PDF: {Count}", spells.Count);
}
else
{
    logger.LogInformation("No PDF supplied – using built-in 'Create Water' example.");
    spells = [CreateWaterExample()];
}

// Export Markdown + JSON
await parser.ExportMarkdownAsync(spells);
await parser.ExportJsonAsync(spells);

// Demonstrate seeder round-trip
var options = app.Services.GetRequiredService<
    Microsoft.Extensions.Options.IOptions<SpellParserOptions>>().Value;

if (File.Exists(options.JsonOutputPath))
{
    var entities = await seeder.LoadFromJsonAsync(options.JsonOutputPath);
    logger.LogInformation(
        "Seeder loaded {Count} DarkSunSpell entities from {Path}",
        entities.Count, options.JsonOutputPath);

    foreach (var e in entities)
        logger.LogInformation("  → {PK}/{SK}  {Name}  (Level {Level} {School})",
            e.PK, e.SK, e.Name, e.Level, e.School);
}

logger.LogInformation("Done. Check the 'output' folder for generated files.");

// ── Hardcoded example spell: Create Water ────────────────────────────────────

static ParsedSpell CreateWaterExample() => new()
{
    Id = "create-water",
    Name = "Create Water",
    Type = "Spell",
    SpellType = SpellType.Priest,
    SourceName = "Dark Sun Revised Boxed Set",
    SourcePage = 95,

    Mechanics = new FiveEMechanics
    {
        Level = 1,
        School = SpellSchool.Conjuration,
        CastingTime = "1 action",
        Range = "30 feet",
        Components = ["V", "S", "M"],
        MaterialComponent = "a drop of water and a pinch of sand",
        Duration = "Instantaneous",
        Concentration = false,
        Ritual = false,
        Description =
            "You call forth an elemental spirit to fill empty containers with up to " +
            "10 gallons of clean, fresh water. The water appears in containers you can " +
            "see within range. Alternatively, the water falls as rain in a 30-foot cube " +
            "within range, extinguishing exposed flames in the area.\n\n" +
            "On Athas, the Water cleric must make a DC 12 Wisdom saving throw when " +
            "casting this spell in an area that has been defiled within the last 24 hours. " +
            "On a failure, the spell produces brackish water that is safe to drink but " +
            "tastes of ash and carries the memory of ruin.",
        AtHigherLevels =
            "When you cast this spell using a spell slot of 2nd level or higher, " +
            "you create 10 additional gallons of water for each slot level above 1st.",
        SavingThrow = "None"
    },

    FlavorText =
        "In the dying world of Athas, clean water is more precious than obsidian steel " +
        "or even the rarest psionic crystal. The Water clerics — those who have sworn " +
        "oaths to the elemental lords of the deep places — carry their faith like a wound: " +
        "open, weeping, and terrifyingly vital. To cast Create Water is to defy the sun " +
        "itself. The templars call it sedition. The merchant houses call it commerce. " +
        "The dying call it salvation. A cleric who can conjure even a cupped handful of " +
        "pure water in the Ringing Mountains earns a loyalty no coin can buy — and an " +
        "enemy list that stretches to every sorcerer-king's palace.",

    ArtworkPrompt =
        "A gaunt Athasian Water cleric, robes sun-bleached and patched with hide, " +
        "kneels in cracked red clay as pure water spirals upward from her trembling " +
        "cupped hands, tiny elemental water spirits visible in the stream, bloated " +
        "crimson sun at noon behind her silhouette, desperate reverence in hollow eyes, " +
        "a dying halfling child reaching toward the water in the foreground, " +
        ", Gerald Brom style, Dark Sun campaign setting, grimdark, surreal, " +
        "detailed anatomy, cinematic lighting, desaturated colors",

    Tags =
    [
        "#athas",
        "#conjuration",
        "#dark-sun",
        "#elemental",
        "#priest",
        "#sphere-water"
    ],

    RelatedEntries = ["Purify Water", "Create Food and Water", "Water Walk"],

    AthasianVariant = new AthasianVariant
    {
        MajorSpheres = [],
        MinorSpheres = ["Water", "Creation"],
        DefilerCost = null,
        PlaneSource = "Elemental Plane of Water",
        AthasianComponents =
        [
            "A vial of clean water (extremely rare on Athas — worth 5 gp per ounce)",
            "A pinch of sand from a dry river bed"
        ],
        LoreNote =
            "The Water templars of Tyr once hoarded scrolls of this spell and executed " +
            "any cleric who cast it without a city-state licence. Since the death of " +
            "Kalak, enforcement has grown… inconsistent.",
        TemplarRestriction = null,
        IsRareLostKnowledge = false
    }
};
