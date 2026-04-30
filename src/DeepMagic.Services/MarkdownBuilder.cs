using System.Text;
using DeepMagic.Core.Models;

namespace DeepMagic.Services;

/// <summary>
/// Builds a Markdown file from a <see cref="ParsedSpell"/>, matching the Dark Sun
/// homebrew document style.
/// </summary>
public static class MarkdownBuilder
{
    public static string Build(ParsedSpell spell)
    {
        var sb = new StringBuilder();

        // ── Title block ──────────────────────────────────────────────────────
        sb.AppendLine($"# {spell.Name}");
        sb.AppendLine();
        sb.AppendLine($"**Type:** {spell.Type}  ");
        sb.AppendLine($"**Source:** {spell.SourceName}" +
                      (spell.SourcePage.HasValue ? $", p. {spell.SourcePage}" : string.Empty) +
                      "  ");
        sb.AppendLine();

        // ── 5e Mechanics ─────────────────────────────────────────────────────
        sb.AppendLine("## 5e Mechanics");
        sb.AppendLine();

        var m = spell.Mechanics;

        sb.AppendLine($"- **Level:** {(m.Level == 0 ? "Cantrip" : m.Level.ToString())}");
        sb.AppendLine($"- **School:** {m.School}");
        sb.AppendLine($"- **Casting Time:** {m.CastingTime}");
        sb.AppendLine($"- **Range:** {m.Range}");
        sb.AppendLine($"- **Components:** {string.Join(", ", m.Components)}" +
                      (m.MaterialComponent is not null ? $" ({m.MaterialComponent})" : string.Empty));
        sb.AppendLine($"- **Duration:** {(m.Concentration ? "Concentration, " : string.Empty)}{m.Duration}");

        if (m.SavingThrow is not null)
            sb.AppendLine($"- **Saving Throw:** {m.SavingThrow}");
        if (m.AttackType is not null)
            sb.AppendLine($"- **Attack Type:** {m.AttackType}");
        if (m.DamageType is not null)
            sb.AppendLine($"- **Damage Type:** {m.DamageType}");
        if (m.Ritual)
            sb.AppendLine("- **Ritual:** Yes");

        sb.AppendLine();
        sb.AppendLine("### Description");
        sb.AppendLine();
        sb.AppendLine(m.Description);

        if (!string.IsNullOrWhiteSpace(m.AtHigherLevels))
        {
            sb.AppendLine();
            sb.AppendLine("**At Higher Levels.** " + m.AtHigherLevels);
        }

        // ── Flavor text ──────────────────────────────────────────────────────
        sb.AppendLine();
        sb.AppendLine("## Flavor / Lore");
        sb.AppendLine();
        sb.AppendLine($"*{spell.FlavorText}*");

        // ── Artwork prompt ────────────────────────────────────────────────────
        sb.AppendLine();
        sb.AppendLine("## Artwork Prompt");
        sb.AppendLine();
        sb.AppendLine($"> {spell.ArtworkPrompt}");

        // ── Athasian variant ──────────────────────────────────────────────────
        sb.AppendLine();
        sb.AppendLine("## Athasian Variant");
        sb.AppendLine();

        var av = spell.AthasianVariant;

        if (av.MajorSpheres.Count > 0)
            sb.AppendLine($"- **Major Spheres:** {string.Join(", ", av.MajorSpheres)}");
        if (av.MinorSpheres.Count > 0)
            sb.AppendLine($"- **Minor Spheres:** {string.Join(", ", av.MinorSpheres)}");
        if (av.PlaneSource is not null)
            sb.AppendLine($"- **Plane Source:** {av.PlaneSource}");
        if (av.DefilerCost is not null)
            sb.AppendLine($"- **Defiler Cost:** {av.DefilerCost}");
        if (av.AthasianComponents.Count > 0)
            sb.AppendLine($"- **Athasian Components:** {string.Join("; ", av.AthasianComponents)}");
        if (av.TemplarRestriction is not null)
            sb.AppendLine($"- **Templar Restriction:** {av.TemplarRestriction}");
        if (av.IsRareLostKnowledge)
            sb.AppendLine("- **Rare / Lost Knowledge:** Yes");
        if (av.LoreNote is not null)
        {
            sb.AppendLine();
            sb.AppendLine($"*{av.LoreNote}*");
        }

        // ── Tags ──────────────────────────────────────────────────────────────
        sb.AppendLine();
        sb.AppendLine("## Tags");
        sb.AppendLine();
        sb.AppendLine(string.Join(" ", spell.Tags));

        // ── Related entries ───────────────────────────────────────────────────
        if (spell.RelatedEntries.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("## Related Entries");
            sb.AppendLine();
            foreach (var rel in spell.RelatedEntries)
                sb.AppendLine($"- {rel}");
        }

        return sb.ToString();
    }
}
