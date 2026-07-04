using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using DeepMagic.Core.Models;

namespace DeepMagic.Services;

/// <summary>
/// Aggregates parsed spells into the SavageSun <c>spells.json</c> compendium
/// document: top-level metadata (sources, spheres, schools, counts) plus the
/// flat <c>spells</c> array with snake_case keys.
/// </summary>
public static class CompendiumJsonBuilder
{
    private static readonly string[] CanonicalSpheres =
        ["Air", "Earth", "Fire", "Water", "Magma", "Rain", "Silt", "Sun", "Cosmos"];

    /// <summary>
    /// Removes duplicate captures of the same spell (same name/class/level from
    /// overlapping sourcebooks or re-issued PDFs), keeping the richest one.
    /// </summary>
    public static List<CompendiumSpell> Deduplicate(IEnumerable<CompendiumSpell> spells)
    {
        return spells
            .GroupBy(s => ($"{Norm(s.Name)}|{s.Class}|{s.Level}"))
            .Select(g => g
                .OrderByDescending(s => s.Description.Length)
                .ThenByDescending(s => Score(s))
                .First())
            .OrderBy(s => s.Class)
            .ThenBy(s => s.Level)
            .ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        static string Norm(string name) =>
            new(name.ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());

        static int Score(CompendiumSpell s) =>
            (s.Stats.Range.Length > 0 ? 1 : 0) + (s.Stats.Components.Length > 0 ? 1 : 0) +
            (s.Stats.Duration.Length > 0 ? 1 : 0) + (s.Stats.CastingTime.Length > 0 ? 1 : 0) +
            (s.Stats.AreaOfEffect.Length > 0 ? 1 : 0) + (s.Stats.SavingThrow.Length > 0 ? 1 : 0);
    }

    public static string Build(
        IReadOnlyList<CompendiumSpell> spells,
        string title = "Athasian Spell Compendium (Dark Sun, AD&D 2e)",
        string description =
            "Cleric and Wizard spell reference for the DARK SUN setting (AD&D 2nd Edition), " +
            "parsed from the source PDFs by Depp-Magic. Athasian clerical magic is organized " +
            "into the elemental spheres (Earth, Air, Fire, Water), the paraelemental " +
            "sub-spheres (Magma, Rain, Silt, Sun), and the general Sphere of the Cosmos.")
    {
        var clerics = spells.Where(s => s.Class == "Cleric").ToList();
        var wizards = spells.Where(s => s.Class == "Wizard").ToList();

        var clericBySphere = new JsonObject();
        foreach (var sphere in CanonicalSpheres)
        {
            int n = clerics.Count(s => s.Sphere == sphere);
            if (n > 0 || sphere == "Cosmos")
                clericBySphere[sphere] = n;
        }

        var wizardBySchool = new JsonObject();
        foreach (var group in wizards
                     .GroupBy(s => s.School ?? "Unknown")
                     .OrderByDescending(g => g.Count()))
            wizardBySchool[group.Key] = group.Count();

        var bySource = new JsonObject();
        foreach (var group in spells.GroupBy(s => s.Source).OrderByDescending(g => g.Count()))
            bySource[group.Key] = group.Count();

        var schools = wizards.Select(s => s.School)
            .Where(s => !string.IsNullOrEmpty(s))
            .Distinct()
            .OrderBy(s => s)
            .ToList();

        var root = new JsonObject
        {
            ["title"] = title,
            ["description"] = description,
            ["sources"] = new JsonArray(spells.Select(s => s.Source).Distinct()
                .Select(s => JsonValue.Create(s)).ToArray<JsonNode?>()),
            ["spheres"] = new JsonArray(CanonicalSpheres
                .Select(s => JsonValue.Create(s)).ToArray<JsonNode?>()),
            ["sphere_groups"] = new JsonObject
            {
                ["Elemental"] = new JsonArray("Air", "Earth", "Fire", "Water"),
                ["Paraelemental"] = new JsonArray("Magma", "Rain", "Silt", "Sun"),
                ["Cosmos"] = new JsonArray("Cosmos"),
            },
            ["schools"] = new JsonArray(schools
                .Select(s => JsonValue.Create(s)).ToArray<JsonNode?>()),
            ["counts"] = new JsonObject
            {
                ["total"] = spells.Count,
                ["cleric"] = clerics.Count,
                ["wizard"] = wizards.Count,
            },
            ["cleric_by_sphere"] = clericBySphere,
            ["wizard_by_school"] = wizardBySchool,
            ["by_source"] = bySource,
            ["spells"] = new JsonArray(spells.Select(SpellToJson).ToArray<JsonNode?>()),
        };

        return root.ToJsonString(new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
    }

    private static JsonObject SpellToJson(CompendiumSpell s)
    {
        var obj = new JsonObject
        {
            ["name"] = s.Name,
            ["class"] = s.Class,
            ["level"] = s.Level,
            ["level_name"] = s.LevelName,
            ["category"] = s.Category,
        };

        if (s.Class == "Cleric")
        {
            obj["spheres"] = new JsonArray(s.Spheres.Select(x => JsonValue.Create(x)).ToArray<JsonNode?>());
            obj["sphere_types"] = new JsonArray(s.SphereTypes.Select(x => JsonValue.Create(x)).ToArray<JsonNode?>());
        }

        obj["school"] = s.School;
        obj["sphere"] = s.Sphere;
        obj["sphere_type"] = s.SphereType;
        obj["group"] = s.Group;
        obj["source"] = s.Source;
        obj["athasian_status"] = s.AthasianStatus;
        obj["summary"] = s.Summary;
        obj["stats"] = new JsonObject
        {
            ["range"] = s.Stats.Range,
            ["components"] = s.Stats.Components,
            ["duration"] = s.Stats.Duration,
            ["casting_time"] = s.Stats.CastingTime,
            ["area_of_effect"] = s.Stats.AreaOfEffect,
            ["saving_throw"] = s.Stats.SavingThrow,
        };
        obj["full_detail"] = s.FullDetail;
        obj["description"] = s.Description;
        obj["has_full_description"] = s.HasFullDescription;

        return obj;
    }
}
