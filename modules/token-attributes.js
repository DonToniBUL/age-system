/** Explicit Token resource paths for compatibility AnyField data models. */
export const AGE_TOKEN_TRACKABLE_ATTRIBUTES = Object.freeze({
    char: Object.freeze({
        bar: Object.freeze(["health", "powerPoints", "conviction"]),
        value: Object.freeze(["level", "xp.value", "xp.next", "xp.advPoints", "fatigue.entered"])
    }),
    vehicle: Object.freeze({
        bar: Object.freeze(["partHealth"]),
        value: Object.freeze(["capacity", "hull", "coverRating", "armorRating"])
    }),
    spaceship: Object.freeze({
        bar: Object.freeze([]),
        value: Object.freeze([
            "size", "crew.current", "crew.min", "crew.typical", "crew.competence",
            "losses.normal.collateral.actual", "losses.normal.hull.actual",
            "losses.normal.maneuverability.actual", "losses.normal.sensors.actual",
            "losses.normal.weapons.actual", "losses.serious.reactorOffline.actual",
            "losses.serious.weaponOffline.actual"
        ])
    }),
    organization: Object.freeze({
        bar: Object.freeze([]),
        value: Object.freeze([
            "combat.stability.value", "combat.structure", "abilities.might.total",
            "abilities.wealth.total", "abilities.influence.total", "abilities.intrigue.total",
            "abilities.phenomena.total"
        ])
    })
});

function cloneAttributes(value) {
    if (globalThis.structuredClone instanceof Function) return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

export function registerAgeTokenTrackableAttributes(environment = globalThis) {
    const actorConfig = environment?.CONFIG?.Actor;
    if (!actorConfig) throw new TypeError("CONFIG.Actor is unavailable for token attribute registration.");
    actorConfig.trackableAttributes = cloneAttributes(AGE_TOKEN_TRACKABLE_ATTRIBUTES);
    return actorConfig.trackableAttributes;
}
