export const AGE_ACTOR_SOURCE_FIELDS = Object.freeze({
    char: ["advancement", "level", "xp", "threat", "dmgMod", "testMod", "attackMod", "statBlockView", "features", "traits", "goals", "age", "language", "background", "secretNote", "gmNotes", "socialClass", "ancestry", "profession", "drive", "speed", "wgroups", "defense", "armor", "injury", "resources", "gp", "sp", "cp", "currency", "fear", "horror", "aim", "defend", "guardUp", "allOutAttack", "initiativeMod", "abilities", "gameMode", "health", "powerPoints", "fatigue", "conviction", "advTestThreshold", "conditions"],
    vehicle: ["handling", "capacity", "velocity", "ramDmg", "hull", "cost", "description", "gmNotes", "coverRating", "armorRating", "partHealth", "conductor", "passengers", "customSideswipeDmg", "customCollisionDmg"],
    spaceship: ["size", "hull", "drive", "description", "gmNotes", "passengers", "crew", "weapons", "systems", "losses", "takenOut"],
    organization: ["description", "abilities", "combat", "scope", "notes", "gmNotes"]
});

export const AGE_ITEM_SOURCE_FIELDS = Object.freeze({
    equipment: ["shortDesc", "longDesc", "favorite", "reference", "weight", "cost", "quantity", "equiped", "modifiers", "itemMods"],
    focus: ["shortDesc", "longDesc", "favorite", "reference", "useAbl", "targetNumber", "powerPointCost", "fatigueTN", "improved", "isOrg", "initialValue"],
    weapon: ["useAbl", "targetNumber", "powerPointCost", "fatigueTN", "dmgType", "dmgSource", "nrDice", "diceType", "extraValue", "dmgAbl", "damageInjury", "damageFormula", "minStr", "useFocus", "weight", "cost", "quantity", "equiped", "shortDesc", "longDesc", "favorite", "reference", "modifiers", "itemMods", "reload", "capacity", "range", "rangeMax", "rof", "ranged", "wgroups"],
    power: ["dmgType", "dmgSource", "nrDice", "diceType", "extraValue", "dmgAbl", "damageInjury", "damageFormula", "minStr", "useFocus", "shortDesc", "longDesc", "favorite", "reference", "useAbl", "targetNumber", "powerPointCost", "fatigueTN", "modifiers", "itemMods", "powerLevel", "castTime", "activate", "useFatigue", "inputFatigueTN", "ablFatigue", "causeDamage", "causeHealing", "itemForceAbl", "hasTest", "testAbl", "testFocus", "damageResisted", "requirement", "hasRoll"],
    talent: ["shortDesc", "longDesc", "favorite", "reference", "modifiers", "itemMods", "requirement", "degree", "type", "activate", "degree0", "degree1", "degree2", "degree3", "degree4"],
    stunts: ["shortDesc", "longDesc", "favorite", "reference", "stuntPoints", "stuntPointsMax", "costType", "type"],
    relationship: ["shortDesc", "longDesc", "favorite", "reference", "intensity", "intensityMax"],
    honorifics: ["shortDesc", "longDesc", "favorite", "reference"],
    membership: ["shortDesc", "longDesc", "favorite", "reference", "rank"],
    shipfeatures: ["shortDesc", "longDesc", "favorite", "reference", "weight", "cost", "quantity", "equiped", "dmgType", "dmgSource", "nrDice", "diceType", "extraValue", "dmgAbl", "damageInjury", "damageFormula", "type", "damage", "sensorMod", "maneuverSizeStep", "juiceMod", "hullPlating", "hullMod", "useFocus", "useAbl", "quality", "isActive"],
    class: ["description", "level", "primaryAbl", "wgroups", "advancements"]
});

export const AGE_ACTOR_DERIVED_FIELDS = Object.freeze({
    char: ["useResources", "useIncome", "useCurrency", "useCoins", "useConviction", "useFatigue", "usePowerPoints", "initiative", "ownedMods", "itemMods"],
    vehicle: ["useResources", "useIncome", "useCurrency", "useCoins", "defenseTotal", "pob"],
    spaceship: ["useResources", "useIncome", "useCurrency", "useCoins", "pob", "sizeNumeric", "crewPenalty", "itemMods"],
    organization: ["useResources", "useIncome", "useCurrency", "useCoins"]
});

const ITEM_COMMON_DERIVED_FIELDS = ["colorScheme", "nameLowerCase", "modifiersByType"];
const ITEM_ACTION_DERIVED_FIELDS = [
    ...ITEM_COMMON_DERIVED_FIELDS, "useFocusActorId", "useFocusActor", "hasDamage", "hasHealing", "hasFatigue",
    "ablDamageValue", "activateMod", "itemRollMod", "atkRollMod", "itemDmgMod", "dmgFormula", "rangeCalc", "rangeMaxCalc"
];

export const AGE_ITEM_DERIVED_FIELDS = Object.freeze({
    equipment: ITEM_COMMON_DERIVED_FIELDS,
    focus: [...ITEM_COMMON_DERIVED_FIELDS, "finalValue"],
    weapon: ITEM_ACTION_DERIVED_FIELDS,
    power: [...ITEM_ACTION_DERIVED_FIELDS, "itemForceBonus", "itemForce", "powerPointCostTotal"],
    talent: ITEM_COMMON_DERIVED_FIELDS,
    stunts: ITEM_COMMON_DERIVED_FIELDS,
    relationship: ITEM_COMMON_DERIVED_FIELDS,
    honorifics: ITEM_COMMON_DERIVED_FIELDS,
    membership: ITEM_COMMON_DERIVED_FIELDS,
    shipfeatures: ITEM_COMMON_DERIVED_FIELDS,
    class: ["advArrIndex", "advPerLvl"]
});
