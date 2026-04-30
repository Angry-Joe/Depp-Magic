using DeepMagic.Core.Interfaces;
using DeepMagic.Core.Models;
using Microsoft.Extensions.DependencyInjection;

namespace DeepMagic.Services;

/// <summary>
/// Extension methods to register DeepMagic services with the DI container.
/// </summary>
public static class ServiceCollectionExtensions
{
    /// <summary>
    /// Adds the <see cref="AthasianSpellParserService"/> and <see cref="SpellSeederService"/>
    /// to the DI container.
    /// </summary>
    /// <param name="services">The service collection.</param>
    /// <param name="configureOptions">Optional lambda to configure <see cref="SpellParserOptions"/>.</param>
    public static IServiceCollection AddDeepMagicServices(
        this IServiceCollection services,
        Action<SpellParserOptions>? configureOptions = null)
    {
        services.AddOptions<SpellParserOptions>()
                .Configure(configureOptions ?? (_ => { }));

        services.AddSingleton<ISpellParserService, AthasianSpellParserService>();
        services.AddSingleton<ISpellSeederService, SpellSeederService>();

        return services;
    }
}
