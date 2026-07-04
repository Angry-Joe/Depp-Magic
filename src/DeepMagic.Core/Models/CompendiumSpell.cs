namespace DeepMagic.Core.Models;

/// <summary>
/// A single spell captured from a 2e sourcebook, shaped to match the
/// SavageSun <c>spells.json</c> compendium schema.
/// </summary>
public sealed class CompendiumSpell
{
    public string Name { get; set; } = string.Empty;

    /// <summary>"Cleric" or "Wizard".</summary>
    public string Class { get; set; } = "Wizard";

    /// <summary>2e spell level (1-13); 0 when the source gave no level context.</summary>
    public int Level { get; set; }

    /// <summary>"1st", "2nd", ... derived from <see cref="Level"/>.</summary>
    public string LevelName { get; set; } = string.Empty;

    /// <summary>"Sphere" for Cleric spells, "School" for Wizard spells.</summary>
    public string Category { get; set; } = "School";

    /// <summary>Elemental/paraelemental spheres (Cleric spells only).</summary>
    public List<string> Spheres { get; set; } = [];

    /// <summary>"Elemental" | "Paraelemental" | "Cosmos", aligned with <see cref="Spheres"/>.</summary>
    public List<string> SphereTypes { get; set; } = [];

    /// <summary>Primary school (Wizard spells), e.g. "Evocation".</summary>
    public string? School { get; set; }

    /// <summary>Primary sphere (Cleric spells), e.g. "Air".</summary>
    public string? Sphere { get; set; }

    public string? SphereType { get; set; }

    /// <summary>Grouping key: primary sphere for clerics, school for wizards.</summary>
    public string Group { get; set; } = string.Empty;

    public string Source { get; set; } = string.Empty;

    public string AthasianStatus { get; set; } = "Core";

    public string Summary { get; set; } = string.Empty;

    public CompendiumSpellStats Stats { get; set; } = new();

    public bool FullDetail { get; set; }

    public string Description { get; set; } = string.Empty;

    public bool HasFullDescription { get; set; }

    // ── Parse-time metadata (not serialized to the compendium) ───────────────

    /// <summary>PDF page the spell header was found on (diagnostics only).</summary>
    public int SourcePage { get; set; }
}

public sealed class CompendiumSpellStats
{
    public string Range { get; set; } = string.Empty;
    public string Components { get; set; } = string.Empty;
    public string Duration { get; set; } = string.Empty;
    public string CastingTime { get; set; } = string.Empty;
    public string AreaOfEffect { get; set; } = string.Empty;
    public string SavingThrow { get; set; } = string.Empty;
}
