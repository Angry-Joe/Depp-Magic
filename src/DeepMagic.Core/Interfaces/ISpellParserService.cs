using DeepMagic.Core.Models;

namespace DeepMagic.Core.Interfaces;

/// <summary>
/// Abstracts over a PDF spell-parser so that different book formats can be
/// handled by separate implementations without changing consumer code.
/// </summary>
public interface ISpellParserService
{
    /// <summary>
    /// Parses all spell blocks found in the PDF at <paramref name="pdfPath"/>.
    /// </summary>
    /// <param name="pdfPath">Absolute or relative path to the source PDF file.</param>
    /// <param name="cancellationToken">Allows the caller to cancel the operation.</param>
    /// <returns>An async enumerable of parsed spells in document order.</returns>
    IAsyncEnumerable<ParsedSpell> ParseSpellsAsync(
        string pdfPath,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Exports <paramref name="spells"/> to the configured Markdown output directory.
    /// </summary>
    Task ExportMarkdownAsync(
        IEnumerable<ParsedSpell> spells,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Exports <paramref name="spells"/> to a single JSON file ready for DynamoDB seeding.
    /// </summary>
    Task ExportJsonAsync(
        IEnumerable<ParsedSpell> spells,
        CancellationToken cancellationToken = default);
}
