using System.Text.Json;
using DeepMagic.Core.Models;
using DeepMagic.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

// ═════════════════════════════════════════════════════════════════════════════
// Depp-Magic – AD&D 2e spell extractor
//
// Usage:
//   DeepMagic.App <pdf-file-or-directory> [output.json]
//
// A directory is scanned recursively for *.pdf; each file is parsed for Wizard
// and Cleric (priest) spell blocks. Results are merged, deduplicated, and
// written as a compendium JSON matching the SavageSun spells.json schema.
// Per-file results are cached in output/cache so interrupted runs resume.
// ═════════════════════════════════════════════════════════════════════════════

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddSingleton<DarkSunCompendiumParser>();
builder.Logging.AddConsole();
builder.Logging.SetMinimumLevel(LogLevel.Information);

var app    = builder.Build();
var logger = app.Services.GetRequiredService<ILogger<Program>>();
var parser = app.Services.GetRequiredService<DarkSunCompendiumParser>();

string input      = args.Length > 0 ? args[0] : ".";
string outputPath = args.Length > 1 ? args[1] : Path.Combine("output", "spells.json");
string cacheDir   = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(outputPath))!, "cache");

// ── Collect PDFs ──────────────────────────────────────────────────────────────

List<string> pdfFiles;
if (Directory.Exists(input))
{
    pdfFiles = Directory.EnumerateFiles(input, "*.pdf", SearchOption.AllDirectories)
        .Where(f => !Path.GetFileName(f).Contains("Battlesystem", StringComparison.OrdinalIgnoreCase))
        .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
        .ToList();
    logger.LogInformation("Found {Count} PDFs under {Dir}", pdfFiles.Count, input);
}
else if (File.Exists(input))
{
    pdfFiles = [input];
}
else
{
    logger.LogError("Input not found: {Input}", input);
    return 1;
}

Directory.CreateDirectory(cacheDir);

// ── Parse (with per-file cache) ───────────────────────────────────────────────

var jsonOptions = new JsonSerializerOptions { WriteIndented = false };
var allSpells   = new List<CompendiumSpell>();
int filesWithSpells = 0, filesSkippedNoText = 0;

foreach (var pdf in pdfFiles)
{
    var cacheKey  = SanitiseFileName(Path.GetRelativePath(
        Directory.Exists(input) ? input : Path.GetDirectoryName(input) ?? ".", pdf));
    var cacheFile = Path.Combine(cacheDir, cacheKey + ".json");

    List<CompendiumSpell> spells;

    if (File.Exists(cacheFile))
    {
        spells = JsonSerializer.Deserialize<List<CompendiumSpell>>(
            File.ReadAllText(cacheFile), jsonOptions) ?? [];
        logger.LogInformation("[cache] {File}: {Count} spells", Path.GetFileName(pdf), spells.Count);
    }
    else
    {
        var source = SourceNameFor(pdf);
        try
        {
            spells = parser.ParseFile(pdf, source);
        }
        catch (Exception ex)
        {
            logger.LogWarning("FAILED {File}: {Message}", Path.GetFileName(pdf), ex.Message);
            spells = [];
        }

        foreach (var s in spells)
            s.AthasianStatus = AthasianStatusFor(source);

        File.WriteAllText(cacheFile, JsonSerializer.Serialize(spells, jsonOptions));
        logger.LogInformation("{File}: {Count} spells", Path.GetFileName(pdf), spells.Count);
    }

    if (spells.Count > 0) filesWithSpells++; else filesSkippedNoText++;
    allSpells.AddRange(spells);
}

// ── Merge, dedupe, write ──────────────────────────────────────────────────────

var deduped = CompendiumJsonBuilder.Deduplicate(allSpells);

logger.LogInformation(
    "Parsed {Raw} spell blocks from {Files}/{Total} files → {Final} unique spells " +
    "({Cleric} Cleric, {Wizard} Wizard)",
    allSpells.Count, filesWithSpells, pdfFiles.Count, deduped.Count,
    deduped.Count(s => s.Class == "Cleric"),
    deduped.Count(s => s.Class == "Wizard"));

Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
File.WriteAllText(outputPath, CompendiumJsonBuilder.Build(deduped));
logger.LogInformation("Wrote compendium to {Path}", outputPath);

return 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

static string SanitiseFileName(string path)
{
    var chars = path.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_');
    return new string(chars.ToArray());
}

/// <summary>Maps a PDF filename to its canonical sourcebook title.</summary>
static string SourceNameFor(string pdfPath)
{
    var name = Path.GetFileNameWithoutExtension(pdfPath)
        .Replace("-Reduced", "", StringComparison.OrdinalIgnoreCase);
    var lower = name.ToLowerInvariant();

    return lower switch
    {
        _ when lower.Contains("dscs-rev") => "Dark Sun Campaign Setting (Revised)",
        _ when lower.Contains("dark sun campaign setting (revised)") => "Dark Sun Campaign Setting (Revised)",
        _ when lower.Contains("dscs") => "Dark Sun Campaign Setting",
        _ when lower.Contains("dark sun campaign setting") => "Dark Sun Campaign Setting",
        _ when lower.Contains("eafw") => "Earth, Air, Fire and Water",
        _ when lower.Contains("earth, air, fire and water") => "Earth, Air, Fire and Water",
        _ when lower.Contains("dnp") => "Defilers and Preservers",
        _ when lower.Contains("defilers and preservers") => "Defilers and Preservers",
        _ when lower.Contains("dragonkings") => "Dragon Kings",
        _ when lower.Contains("dragon kings") => "Dragon Kings",
        _ when lower.Contains("phb") && !lower.Contains("phbr") => "Player's Handbook",
        _ when lower.Contains("tome of magic") => "Tome of Magic",
        _ when lower.Contains("wizards spell compendium") => "Wizard's Spell Compendium",
        _ when lower.Contains("will and the way") => "The Will and the Way",
        _ when lower.Contains("dune trader") => "Dune Trader",
        _ when lower.Contains("veiled alliance") => "Veiled Alliance",
        _ when lower.Contains("ivory triangle") => "The Ivory Triangle",
        _ when lower.Contains("city by the silt sea") => "City by the Silt Sea",
        _ when lower.Contains("windriders") => "Windriders of the Jagged Cliffs",
        _ when lower.Contains("mind lords") => "Mind Lords of the Last Sea",
        _ when lower.Contains("thri-kreen") => "Thri-Kreen of Athas",
        _ when lower.Contains("elves of athas") => "Elves of Athas",
        _ when lower.Contains("earth, air") => "Earth, Air, Fire and Water",
        _ when lower.Contains("valley of dust") => "Valley of Dust and Fire",
        _ => name,
    };
}

/// <summary>Dark Sun-native sources vs. AD&amp;D core sources.</summary>
static string AthasianStatusFor(string source) => source switch
{
    "Dark Sun Campaign Setting" or "Dark Sun Campaign Setting (Revised)" or
    "Earth, Air, Fire and Water" or "Defilers and Preservers" or "Dragon Kings" or
    "The Will and the Way" or "Dune Trader" or "Veiled Alliance" or
    "The Ivory Triangle" or "City by the Silt Sea" or "Windriders of the Jagged Cliffs" or
    "Mind Lords of the Last Sea" or "Thri-Kreen of Athas" or "Elves of Athas" or
    "Valley of Dust and Fire"
        => "New (Dark Sun)",
    _ => "Core",
};
