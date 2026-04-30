using System.Text.Json;
using DeepMagic.Core.Interfaces;
using DeepMagic.Core.Models;
using Microsoft.Extensions.Logging;

namespace DeepMagic.Services;

/// <summary>
/// Loads <see cref="DarkSunSpell"/> entities from the JSON seed file produced by
/// <see cref="AthasianSpellParserService.ExportJsonAsync"/>.
/// </summary>
public sealed class SpellSeederService : ISpellSeederService
{
    private readonly ILogger<SpellSeederService> _logger;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public SpellSeederService(ILogger<SpellSeederService> logger)
    {
        _logger = logger;
    }

    /// <inheritdoc/>
    public async Task<IReadOnlyList<DarkSunSpell>> LoadFromJsonAsync(
        string jsonPath,
        CancellationToken cancellationToken = default)
    {
        if (!File.Exists(jsonPath))
            throw new FileNotFoundException("JSON seed file not found.", jsonPath);

        _logger.LogInformation("Loading spells from {Path}", jsonPath);

        await using var stream = File.OpenRead(jsonPath);
        var spells = await JsonSerializer.DeserializeAsync<List<DarkSunSpell>>(
            stream, JsonOptions, cancellationToken);

        if (spells is null)
            throw new InvalidDataException($"Could not deserialise spell list from {jsonPath}");

        _logger.LogInformation("Loaded {Count} spells", spells.Count);
        return spells;
    }

    /// <inheritdoc/>
    public IReadOnlyList<DarkSunSpell> ToEntities(IEnumerable<ParsedSpell> spells) =>
        spells.Select(DarkSunSpell.FromParsedSpell).ToList();
}
