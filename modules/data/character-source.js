function hasFiniteStoredValue(value) {
    return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

const GAME_MODE_SOURCE_PATHS = Object.freeze({
    healthCur: "system.health.value",
    health: "system.health.set",
    defense: "system.defense.gameModeBonus",
    toughness: "system.armor.toughness.gameModeBonus"
});

export function characterGameModeProfileUpdate(mode, detail, value) {
    const sourcePath = GAME_MODE_SOURCE_PATHS[detail];
    const number = Number(value);
    if (!mode || !sourcePath || !Number.isFinite(number)) return {};
    return {
        [`system.gameMode.specs.${mode}.${detail}`]: number,
        [sourcePath]: number
    };
}

/**
 * Modern AGE game-mode records are retained as legacy presets. Direct
 * Character resource fields are authoritative once present in raw source, so
 * preparation cannot undo a native AppV2 edit or couple it to another branch.
 */
export function applyCharacterGameModeFallbacks(data, stored, specs) {
    if (!data || !specs) return data;
    data.health ??= {};
    data.defense ??= {};
    data.armor ??= {};
    data.armor.toughness ??= {};
    if (!hasFiniteStoredValue(stored?.health?.set)) data.health.set = Number(specs.health) || 0;
    if (!hasFiniteStoredValue(stored?.defense?.gameModeBonus)) {
        data.defense.gameModeBonus = Number(specs.defense) || 0;
    }
    if (!hasFiniteStoredValue(stored?.armor?.toughness?.gameModeBonus)) {
        data.armor.toughness.gameModeBonus = Number(specs.toughness) || 0;
    }
    return data;
}
