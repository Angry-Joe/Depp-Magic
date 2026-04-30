using System.Text.Json.Serialization;

namespace DeepMagic.Core.Models;

/// <summary>
/// Entity that maps a <see cref="ParsedSpell"/> to the DarkSunSpell DynamoDB table schema.
/// </summary>
public class DarkSunSpell
{
    // ── DynamoDB primary key ──────────────────────────────────────────────────

    /// <summary>Partition key: "SPELL".</summary>
    [JsonPropertyName("PK")]
    public string PK { get; set; } = "SPELL";

    /// <summary>Sort key: the spell's unique slug, e.g. "create-water".</summary>
    [JsonPropertyName("SK")]
    public string SK { get; set; } = string.Empty;

    // ── Top-level attributes ──────────────────────────────────────────────────

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; set; } = "Spell";

    [JsonPropertyName("spellType")]
    public string SpellType { get; set; } = string.Empty;

    [JsonPropertyName("sourceName")]
    public string SourceName { get; set; } = string.Empty;

    [JsonPropertyName("sourcePage")]
    public int? SourcePage { get; set; }

    [JsonPropertyName("level")]
    public int Level { get; set; }

    [JsonPropertyName("school")]
    public string School { get; set; } = string.Empty;

    [JsonPropertyName("castingTime")]
    public string CastingTime { get; set; } = string.Empty;

    [JsonPropertyName("range")]
    public string Range { get; set; } = string.Empty;

    [JsonPropertyName("components")]
    public List<string> Components { get; set; } = [];

    [JsonPropertyName("materialComponent")]
    public string? MaterialComponent { get; set; }

    [JsonPropertyName("duration")]
    public string Duration { get; set; } = string.Empty;

    [JsonPropertyName("concentration")]
    public bool Concentration { get; set; }

    [JsonPropertyName("ritual")]
    public bool Ritual { get; set; }

    [JsonPropertyName("description")]
    public string Description { get; set; } = string.Empty;

    [JsonPropertyName("atHigherLevels")]
    public string? AtHigherLevels { get; set; }

    [JsonPropertyName("savingThrow")]
    public string? SavingThrow { get; set; }

    [JsonPropertyName("attackType")]
    public string? AttackType { get; set; }

    [JsonPropertyName("damageType")]
    public string? DamageType { get; set; }

    [JsonPropertyName("flavorText")]
    public string FlavorText { get; set; } = string.Empty;

    [JsonPropertyName("artworkPrompt")]
    public string ArtworkPrompt { get; set; } = string.Empty;

    [JsonPropertyName("tags")]
    public List<string> Tags { get; set; } = [];

    [JsonPropertyName("relatedEntries")]
    public List<string> RelatedEntries { get; set; } = [];

    [JsonPropertyName("athasianVariant")]
    public AthasianVariant AthasianVariant { get; set; } = new();

    [JsonPropertyName("parsedAt")]
    public string ParsedAt { get; set; } = DateTimeOffset.UtcNow.ToString("O");

    // ── Factory ───────────────────────────────────────────────────────────────

    /// <summary>
    /// Creates a <see cref="DarkSunSpell"/> from a <see cref="ParsedSpell"/>.
    /// </summary>
    public static DarkSunSpell FromParsedSpell(ParsedSpell spell) => new()
    {
        PK = "SPELL",
        SK = spell.Id,
        Name = spell.Name,
        Type = spell.Type,
        SpellType = spell.SpellType.ToString(),
        SourceName = spell.SourceName,
        SourcePage = spell.SourcePage,
        Level = spell.Mechanics.Level,
        School = spell.Mechanics.School.ToString(),
        CastingTime = spell.Mechanics.CastingTime,
        Range = spell.Mechanics.Range,
        Components = spell.Mechanics.Components,
        MaterialComponent = spell.Mechanics.MaterialComponent,
        Duration = spell.Mechanics.Duration,
        Concentration = spell.Mechanics.Concentration,
        Ritual = spell.Mechanics.Ritual,
        Description = spell.Mechanics.Description,
        AtHigherLevels = spell.Mechanics.AtHigherLevels,
        SavingThrow = spell.Mechanics.SavingThrow,
        AttackType = spell.Mechanics.AttackType,
        DamageType = spell.Mechanics.DamageType,
        FlavorText = spell.FlavorText,
        ArtworkPrompt = spell.ArtworkPrompt,
        Tags = spell.Tags,
        RelatedEntries = spell.RelatedEntries,
        AthasianVariant = spell.AthasianVariant,
        ParsedAt = spell.ParsedAt.ToString("O")
    };
}
