namespace DeepMagic.Services;

public record DragonKingsSpell(
    string Name,
    string School,
    int Level,
    string CastingTime,
    string Range,
    string Components,
    string Duration,
    string Description,
    int PageNumber,
    string Source = "Dragon Kings"
);