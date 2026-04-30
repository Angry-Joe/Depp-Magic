using System.Text.Json.Serialization;

namespace DeepMagic.Core.Models;

/// <summary>
/// A fully parsed Dark Sun spell ready for export to Markdown and DynamoDB JSON.
/// </summary>
public record ParsedSpell
{
    // ── Identity ─────────────────────────────────────────────────────────────

    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; init; } = string.Empty;

    /// <summary>Always "Spell".</summary>
    [JsonPropertyName("type")]
    public string Type { get; init; } = "Spell";

    /// <summary>E.g. "Priest" or "Wizard".</summary>
    [JsonPropertyName("spellType")]
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public SpellType SpellType { get; init; }

    // ── Provenance ───────────────────────────────────────────────────────────

    [JsonPropertyName("sourceName")]
    public string SourceName { get; init; } = string.Empty;

    [JsonPropertyName("sourcePage")]
    public int? SourcePage { get; init; }

    // ── 5e Mechanics ─────────────────────────────────────────────────────────

    [JsonPropertyName("mechanics")]
    public FiveEMechanics Mechanics { get; init; } = new();

    // ── Flavour ───────────────────────────────────────────────────────────────

    /// <summary>Grim, concise Dark Sun flavour text (max 300 words).</summary>
    [JsonPropertyName("flavorText")]
    public string FlavorText { get; init; } = string.Empty;

    /// <summary>Gerald Brom-style artwork prompt.</summary>
    [JsonPropertyName("artworkPrompt")]
    public string ArtworkPrompt { get; init; } = string.Empty;

    // ── Classification ────────────────────────────────────────────────────────

    /// <summary>Hashtag-style tags, e.g. ["#dark-sun", "#elemental", "#water"].</summary>
    [JsonPropertyName("tags")]
    public List<string> Tags { get; init; } = [];

    /// <summary>Names of related spells or entries.</summary>
    [JsonPropertyName("relatedEntries")]
    public List<string> RelatedEntries { get; init; } = [];

    // ── Athasian variant data ─────────────────────────────────────────────────

    [JsonPropertyName("athasianVariant")]
    public AthasianVariant AthasianVariant { get; init; } = new();

    // ── Metadata ──────────────────────────────────────────────────────────────

    [JsonPropertyName("parsedAt")]
    public DateTimeOffset ParsedAt { get; init; } = DateTimeOffset.UtcNow;
}
