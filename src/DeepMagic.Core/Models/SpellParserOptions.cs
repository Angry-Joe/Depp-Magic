namespace DeepMagic.Core.Models;

/// <summary>
/// Configuration options for the spell parser, injected via IOptions&lt;SpellParserOptions&gt;.
/// </summary>
public class SpellParserOptions
{
    public const string Section = "SpellParser";

    /// <summary>
    /// Name of the source book being parsed (used as the <see cref="ParsedSpell.SourceName"/>).
    /// </summary>
    public string SourceBookName { get; set; } = "Dark Sun Revised Boxed Set";

    /// <summary>
    /// Output directory for the generated Markdown files.
    /// Defaults to "output/markdown" relative to the working directory.
    /// </summary>
    public string MarkdownOutputDirectory { get; set; } = "output/markdown";

    /// <summary>
    /// File name for the combined JSON seed file.
    /// Defaults to "output/priest-spells.json".
    /// </summary>
    public string JsonOutputPath { get; set; } = "output/priest-spells.json";

    /// <summary>
    /// If true, overwrite existing Markdown files; otherwise skip them.
    /// </summary>
    public bool OverwriteExisting { get; set; } = true;

    /// <summary>
    /// Maximum number of words allowed in the flavor text section.
    /// </summary>
    public int MaxFlavorWordCount { get; set; } = 300;
}
