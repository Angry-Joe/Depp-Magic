using System.Text.Json.Serialization;

namespace DeepMagic.Core.Models;

/// <summary>
/// Dark Sun (Athasian) specific variant data appended to every parsed spell.
/// Captures the unique ecology of Athas where elemental worship drives priestly magic
/// and psionics intertwine with arcane casting.
/// </summary>
public record AthasianVariant
{
    /// <summary>Major sphere access granted by this spell (e.g., "Water", "Earth").</summary>
    [JsonPropertyName("majorSpheres")]
    public List<string> MajorSpheres { get; init; } = [];

    /// <summary>Minor sphere access (priest has access but at reduced depth).</summary>
    [JsonPropertyName("minorSpheres")]
    public List<string> MinorSpheres { get; init; } = [];

    /// <summary>
    /// Whether Defiler casting is possible and at what environmental cost.
    /// Null means the spell has no additional defiling cost beyond the standard rule.
    /// </summary>
    [JsonPropertyName("defilerCost")]
    public string? DefilerCost { get; init; }

    /// <summary>
    /// The elemental or para-elemental plane from which the spell draws power
    /// (e.g., "Elemental Plane of Water", "Para-elemental Plane of Silt").
    /// Null for spells not derived from elemental sources.
    /// </summary>
    [JsonPropertyName("planeSource")]
    public string? PlaneSource { get; init; }

    /// <summary>
    /// Material components that are unique to Athas (replaces or augments the standard
    /// component list, e.g., "a vial of muddy water from the Silt Sea").
    /// </summary>
    [JsonPropertyName("athasianComponents")]
    public List<string> AthasianComponents { get; init; } = [];

    /// <summary>Flavour note about the spell's place in Athasian society/religion.</summary>
    [JsonPropertyName("loreNote")]
    public string? LoreNote { get; init; }

    /// <summary>
    /// Whether this spell is restricted to templars of a specific sorcerer-king.
    /// Null if available to all priests of the relevant sphere.
    /// </summary>
    [JsonPropertyName("templarRestriction")]
    public string? TemplarRestriction { get; init; }

    /// <summary>Indicates if the spell is considered rare / lost knowledge on Athas.</summary>
    [JsonPropertyName("isRareLostKnowledge")]
    public bool IsRareLostKnowledge { get; init; }
}
