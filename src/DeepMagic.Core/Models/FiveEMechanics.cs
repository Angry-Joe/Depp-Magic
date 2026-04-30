using System.Text.Json.Serialization;

namespace DeepMagic.Core.Models;

/// <summary>
/// Full 5th-edition mechanical block for a spell.
/// </summary>
public record FiveEMechanics
{
    [JsonPropertyName("level")]
    public int Level { get; init; }

    [JsonPropertyName("school")]
    public SpellSchool School { get; init; }

    [JsonPropertyName("castingTime")]
    public string CastingTime { get; init; } = string.Empty;

    [JsonPropertyName("range")]
    public string Range { get; init; } = string.Empty;

    /// <summary>Verbal (V), Somatic (S), Material (M) components.</summary>
    [JsonPropertyName("components")]
    public List<string> Components { get; init; } = [];

    /// <summary>If M is in Components, this describes the material.</summary>
    [JsonPropertyName("materialComponent")]
    public string? MaterialComponent { get; init; }

    [JsonPropertyName("duration")]
    public string Duration { get; init; } = string.Empty;

    [JsonPropertyName("concentration")]
    public bool Concentration { get; init; }

    [JsonPropertyName("ritual")]
    public bool Ritual { get; init; }

    [JsonPropertyName("description")]
    public string Description { get; init; } = string.Empty;

    /// <summary>Text for the "At Higher Levels" section, if any.</summary>
    [JsonPropertyName("atHigherLevels")]
    public string? AtHigherLevels { get; init; }

    [JsonPropertyName("savingThrow")]
    public string? SavingThrow { get; init; }

    [JsonPropertyName("attackType")]
    public string? AttackType { get; init; }

    [JsonPropertyName("damageType")]
    public string? DamageType { get; init; }
}
