using DeepMagic.Core.Models;

namespace DeepMagic.Core.Interfaces;

/// <summary>
/// Seeds <see cref="DarkSunSpell"/> records from a JSON file or an in-memory collection.
/// </summary>
public interface ISpellSeederService
{
    /// <summary>
    /// Loads spells from <paramref name="jsonPath"/> and returns them as
    /// <see cref="DarkSunSpell"/> entities ready for persistence.
    /// </summary>
    Task<IReadOnlyList<DarkSunSpell>> LoadFromJsonAsync(
        string jsonPath,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Converts <paramref name="spells"/> to <see cref="DarkSunSpell"/> entities.
    /// </summary>
    IReadOnlyList<DarkSunSpell> ToEntities(IEnumerable<ParsedSpell> spells);
}
