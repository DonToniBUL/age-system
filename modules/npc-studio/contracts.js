import {canonicalClone} from "../progression/canonical.js";

export const AGE_NPC_STUDIO_DRAFT_VERSION = 1;
export const AGE_NPC_STUDIO_PREVIEW_VERSION = 1;
export const AGE_NPC_STUDIO_RECEIPT_VERSION = 1;

export const AGE_NPC_STUDIO_PROFILE_IDS = Object.freeze([
  "dage",
  "fage-1e",
  "fage-2e",
  "mage-core",
  "mage-mastery-injury",
]);

export const AGE_NPC_STUDIO_ITEM_TYPES = Object.freeze([
  "equipment",
  "focus",
  "weapon",
  "power",
  "talent",
  "stunts",
  "relationship",
  "honorifics",
  "membership",
]);

export const AGE_NPC_STUDIO_CUSTOM_ITEM_TYPES = Object.freeze([
  "equipment",
  "focus",
  "weapon",
  "power",
  "talent",
  "stunts",
  "relationship",
  "honorifics",
  "membership",
]);

export const AGE_NPC_STUDIO_LIMITS = Object.freeze({
  name: 128,
  label: 256,
  image: 512,
  shortText: 1_000,
  richText: 12_000,
  pasteCharacters: 250_000,
  items: 250,
  depth: 16,
  objectKeys: 1_000,
});

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PROFILE_IDS = new Set(AGE_NPC_STUDIO_PROFILE_IDS);
const ITEM_TYPES = new Set(AGE_NPC_STUDIO_ITEM_TYPES);
const CUSTOM_ITEM_TYPES = new Set(AGE_NPC_STUDIO_CUSTOM_ITEM_TYPES);
const ORIGINS = new Set(["blank", "paste", "clone"]);
const ITEM_ORIGINS = new Set(["custom", "library", "clone"]);
const PARSER_MODES = new Set(["dage", "fage", "fage2e", "mageL", "mageM"]);
const RESOLUTION_STATUSES = new Set(["manual", "matched", "unmatched"]);
const RESOLUTION_MODES = new Set(["custom", "reuse", "pending"]);
const SOURCE_KINDS = new Set(["world", "compendium"]);

function studioError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "AgeNpcStudioContractError";
  error.code = code;
  Object.assign(error, details);
  return error;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reject prototypes, dangerous keys, excessive depth and excessively broad objects before normalization. */
export function assertNpcStudioSafeInput(value, path = "$", depth = 0) {
  if (depth > AGE_NPC_STUDIO_LIMITS.depth) {
    throw studioError("AGE_NPC_STUDIO_INPUT_DEPTH", `${path} exceeds the maximum nesting depth.`);
  }
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw studioError("AGE_NPC_STUDIO_NUMBER_INVALID", `${path} must be finite.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > AGE_NPC_STUDIO_LIMITS.items) {
      throw studioError("AGE_NPC_STUDIO_ARRAY_LIMIT", `${path} contains too many entries.`);
    }
    value.forEach((entry, index) => assertNpcStudioSafeInput(entry, `${path}[${index}]`, depth + 1));
    return value;
  }
  if (!plainObject(value)) throw studioError("AGE_NPC_STUDIO_INPUT_OBJECT", `${path} must be a plain JSON object.`);
  const entries = Object.entries(value);
  if (entries.length > AGE_NPC_STUDIO_LIMITS.objectKeys) {
    throw studioError("AGE_NPC_STUDIO_OBJECT_LIMIT", `${path} contains too many fields.`);
  }
  for (const [key, entry] of entries) {
    if (DANGEROUS_KEYS.has(key)) throw studioError("AGE_NPC_STUDIO_DANGEROUS_KEY", `${path}.${key} is forbidden.`);
    assertNpcStudioSafeInput(entry, `${path}.${key}`, depth + 1);
  }
  return value;
}

function assertKeys(value, allowed, path) {
  if (!plainObject(value)) throw studioError("AGE_NPC_STUDIO_INPUT_OBJECT", `${path} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw studioError("AGE_NPC_STUDIO_FIELD_UNKNOWN", `${path}.${key} is not an accepted NPC Studio field.`);
  }
}

function cleanText(value, maximum, {required = false, trim = true} = {}) {
  let text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  if (trim) text = text.trim();
  if (text.length > maximum) throw studioError("AGE_NPC_STUDIO_TEXT_LIMIT", `Text exceeds the ${maximum}-character limit.`);
  if (required && !text) throw studioError("AGE_NPC_STUDIO_TEXT_REQUIRED", "A required text field is empty.");
  return text;
}

function boundedNumber(value, {fallback = 0, minimum = -999, maximum = 999, integer = true, path = "value"} = {}) {
  const parsed = value === "" || value === null || value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed)) throw studioError("AGE_NPC_STUDIO_NUMBER_INVALID", `${path} must be numeric.`);
  const number = integer ? Math.trunc(parsed) : parsed;
  if (number < minimum || number > maximum) {
    throw studioError("AGE_NPC_STUDIO_NUMBER_RANGE", `${path} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function boolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw studioError("AGE_NPC_STUDIO_BOOLEAN_INVALID", "Expected a Boolean value.");
  return value;
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === "") return null;
  return cleanText(value, maximum, {required: true});
}

function nullableInjuryDamage(value, path) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw studioError("AGE_NPC_STUDIO_NUMBER_INVALID", `${path} must be a whole number.`);
  if (parsed < 1 || parsed > 40) throw studioError("AGE_NPC_STUDIO_NUMBER_RANGE", `${path} must be between 1 and 40.`);
  return parsed;
}

const TOP_KEYS = new Set(["schemaVersion", "draftId", "profileId", "origin", "identity", "abilities", "combat", "resources", "token", "notes", "items"]);
const ORIGIN_KEYS = new Set(["kind", "parserMode", "sourceActorUuid"]);
const IDENTITY_KEYS = new Set(["name", "kind", "threat", "level", "ancestry", "profession", "background", "img", "compactSheet"]);
const ABILITY_KEYS = new Set(["value", "primary"]);
const COMBAT_KEYS = new Set([
  "defenseBase", "defenseGameModeBonus", "speedBase", "healthValue", "healthSet",
  "toughnessGameModeBonus", "impactArmor", "ballisticArmor", "initiativeMod",
  "attackMod", "testMod", "damageMod",
]);
const RESOURCE_KEYS = new Set(["powerPointsValue", "powerPointsSet", "convictionValue", "convictionSet", "fatigueEntered"]);
const TOKEN_KEYS = new Set(["actorLink", "disposition", "width", "height", "img"]);
const NOTES_KEYS = new Set(["features", "traits", "goals", "gmNotes"]);
const ITEM_KEYS = new Set(["entryId", "origin", "include", "name", "type", "img", "sourceUuid", "custom", "resolution"]);
const CUSTOM_KEYS = new Set([
  "description", "ability", "focus", "bonus", "damageFormula", "damageInjury", "damageInjuryConfirmed", "damageSource", "targetNumber",
  "powerPointCost", "degree", "subtype", "stuntPoints", "equipped", "intensity", "rank",
]);
const RESOLUTION_KEYS = new Set([
  "status", "mode", "sourceUuid", "sourceName", "sourceKind", "sourceLabel", "sourceSubtype", "alternatives",
]);
const RESOLUTION_SOURCE_KEYS = new Set(["sourceUuid", "sourceName", "sourceKind", "sourceLabel", "sourceSubtype"]);

function normalizeOrigin(raw) {
  assertKeys(raw, ORIGIN_KEYS, "$.origin");
  const kind = cleanText(raw.kind, 16, {required: true});
  if (!ORIGINS.has(kind)) throw studioError("AGE_NPC_STUDIO_ORIGIN_UNSUPPORTED", `Unsupported NPC Studio origin: ${kind}.`);
  const parserMode = nullableText(raw.parserMode, 32);
  if (parserMode && !PARSER_MODES.has(parserMode)) throw studioError("AGE_NPC_STUDIO_DIALECT_UNSUPPORTED", `Unsupported NPC parser dialect: ${parserMode}.`);
  const sourceActorUuid = nullableText(raw.sourceActorUuid, AGE_NPC_STUDIO_LIMITS.image);
  if (kind === "clone" && !sourceActorUuid) throw studioError("AGE_NPC_STUDIO_CLONE_SOURCE", "Clone drafts require a source Actor UUID.");
  if (kind !== "clone" && sourceActorUuid) throw studioError("AGE_NPC_STUDIO_CLONE_SOURCE", "Only clone drafts may bind a source Actor UUID.");
  if (kind !== "paste" && parserMode) throw studioError("AGE_NPC_STUDIO_DIALECT_UNSUPPORTED", "Only pasted drafts may bind a parser dialect.");
  return {kind, parserMode, sourceActorUuid};
}

function normalizeIdentity(raw) {
  assertKeys(raw, IDENTITY_KEYS, "$.identity");
  const kind = cleanText(raw.kind ?? "adversary", 32, {required: true});
  if (!["adversary", "monster", "npc", "ally"].includes(kind)) {
    throw studioError("AGE_NPC_STUDIO_KIND_UNSUPPORTED", `Unsupported NPC kind: ${kind}.`);
  }
  return {
    name: cleanText(raw.name, AGE_NPC_STUDIO_LIMITS.name, {required: true}),
    kind,
    threat: cleanText(raw.threat, AGE_NPC_STUDIO_LIMITS.label),
    level: boundedNumber(raw.level, {fallback: 0, minimum: 0, maximum: 100, path: "identity.level"}),
    ancestry: cleanText(raw.ancestry, AGE_NPC_STUDIO_LIMITS.label),
    profession: cleanText(raw.profession, AGE_NPC_STUDIO_LIMITS.label),
    background: cleanText(raw.background, AGE_NPC_STUDIO_LIMITS.shortText),
    img: cleanText(raw.img || "icons/svg/mystery-man.svg", AGE_NPC_STUDIO_LIMITS.image, {required: true}),
    compactSheet: boolean(raw.compactSheet, true),
  };
}

function normalizeAbilities(raw) {
  if (!plainObject(raw)) throw studioError("AGE_NPC_STUDIO_INPUT_OBJECT", "$.abilities must be an object.");
  const result = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(id)) throw studioError("AGE_NPC_STUDIO_ABILITY_ID", `Invalid ability id: ${id}.`);
    assertKeys(value, ABILITY_KEYS, `$.abilities.${id}`);
    result[id] = {
      value: boundedNumber(value.value, {fallback: 0, minimum: -5, maximum: 20, path: `abilities.${id}.value`}),
      primary: boolean(value.primary, false),
    };
  }
  return result;
}

function normalizeCombat(raw) {
  assertKeys(raw, COMBAT_KEYS, "$.combat");
  const field = (key, fallback, minimum, maximum) => boundedNumber(raw[key], {fallback, minimum, maximum, path: `combat.${key}`});
  return {
    defenseBase: field("defenseBase", 10, -50, 100),
    defenseGameModeBonus: field("defenseGameModeBonus", 0, -50, 100),
    speedBase: field("speedBase", 10, -50, 100),
    healthValue: field("healthValue", 15, 0, 9_999),
    healthSet: field("healthSet", 15, 1, 9_999),
    toughnessGameModeBonus: field("toughnessGameModeBonus", 0, -50, 100),
    impactArmor: field("impactArmor", 0, 0, 100),
    ballisticArmor: field("ballisticArmor", 0, 0, 100),
    initiativeMod: field("initiativeMod", 0, -30, 30),
    attackMod: field("attackMod", 0, -30, 30),
    testMod: field("testMod", 0, -30, 30),
    damageMod: field("damageMod", 0, -30, 30),
  };
}

function normalizeResources(raw) {
  assertKeys(raw, RESOURCE_KEYS, "$.resources");
  const field = (key, fallback, maximum) => boundedNumber(raw[key], {fallback, minimum: 0, maximum, path: `resources.${key}`});
  return {
    powerPointsValue: field("powerPointsValue", 0, 9_999),
    powerPointsSet: field("powerPointsSet", 0, 9_999),
    convictionValue: field("convictionValue", 0, 999),
    convictionSet: field("convictionSet", 0, 999),
    fatigueEntered: field("fatigueEntered", 0, 99),
  };
}

function normalizeToken(raw) {
  assertKeys(raw, TOKEN_KEYS, "$.token");
  const disposition = boundedNumber(raw.disposition, {fallback: -1, minimum: -1, maximum: 1, path: "token.disposition"});
  if (![-1, 0, 1].includes(disposition)) throw studioError("AGE_NPC_STUDIO_DISPOSITION", "Token disposition must be -1, 0, or 1.");
  return {
    actorLink: boolean(raw.actorLink, false),
    disposition,
    width: boundedNumber(raw.width, {fallback: 1, minimum: 0.25, maximum: 20, integer: false, path: "token.width"}),
    height: boundedNumber(raw.height, {fallback: 1, minimum: 0.25, maximum: 20, integer: false, path: "token.height"}),
    img: cleanText(raw.img, AGE_NPC_STUDIO_LIMITS.image),
  };
}

function normalizeNotes(raw) {
  assertKeys(raw, NOTES_KEYS, "$.notes");
  return Object.fromEntries([...NOTES_KEYS].map(key => [key, cleanText(raw[key], AGE_NPC_STUDIO_LIMITS.richText, {trim: false})]));
}

function normalizeCustom(raw, path) {
  assertKeys(raw, CUSTOM_KEYS, path);
  const subtype = cleanText(raw.subtype || "talent", 16, {required: true});
  if (!["talent", "spec"].includes(subtype)) throw studioError("AGE_NPC_STUDIO_TALENT_SUBTYPE", `${path}.subtype must be talent or spec.`);
  return {
    description: cleanText(raw.description, AGE_NPC_STUDIO_LIMITS.richText, {trim: false}),
    ability: cleanText(raw.ability, 32),
    focus: cleanText(raw.focus, AGE_NPC_STUDIO_LIMITS.name),
    bonus: boundedNumber(raw.bonus, {fallback: 0, minimum: -30, maximum: 30, path: `${path}.bonus`}),
    damageFormula: cleanText(raw.damageFormula || "1d6", 128, {required: true}),
    damageInjury: nullableInjuryDamage(raw.damageInjury, `${path}.damageInjury`),
    damageInjuryConfirmed: boolean(raw.damageInjuryConfirmed, false),
    damageSource: cleanText(raw.damageSource || "impact", 32, {required: true}),
    targetNumber: boundedNumber(raw.targetNumber, {fallback: 10, minimum: 0, maximum: 99, path: `${path}.targetNumber`}),
    powerPointCost: boundedNumber(raw.powerPointCost, {fallback: 0, minimum: 0, maximum: 999, path: `${path}.powerPointCost`}),
    degree: boundedNumber(raw.degree, {fallback: 0, minimum: 0, maximum: 4, path: `${path}.degree`}),
    subtype,
    stuntPoints: boundedNumber(raw.stuntPoints, {fallback: 1, minimum: 0, maximum: 99, path: `${path}.stuntPoints`}),
    equipped: boolean(raw.equipped, true),
    intensity: boundedNumber(raw.intensity, {fallback: 1, minimum: 0, maximum: 99, path: `${path}.intensity`}),
    rank: boundedNumber(raw.rank, {fallback: 1, minimum: 0, maximum: 99, path: `${path}.rank`}),
  };
}

function emptyResolution(status = "manual") {
  return {status, mode: "custom", sourceUuid: null, sourceName: "", sourceKind: "", sourceLabel: "", sourceSubtype: "", alternatives: []};
}

function normalizeResolutionSource(raw, path, type) {
  assertKeys(raw, RESOLUTION_SOURCE_KEYS, path);
  const sourceUuid = cleanText(raw.sourceUuid, AGE_NPC_STUDIO_LIMITS.image, {required: true});
  const sourceName = cleanText(raw.sourceName, AGE_NPC_STUDIO_LIMITS.name, {required: true});
  const sourceKind = cleanText(raw.sourceKind, 16, {required: true});
  const sourceLabel = cleanText(raw.sourceLabel, AGE_NPC_STUDIO_LIMITS.label);
  const sourceSubtype = cleanText(raw.sourceSubtype, 16);
  if (!SOURCE_KINDS.has(sourceKind)) throw studioError("AGE_NPC_STUDIO_RESOLUTION_SOURCE", `${path}.sourceKind is unsupported.`);
  if (type === "talent" && !["talent", "spec"].includes(sourceSubtype)) {
    throw studioError("AGE_NPC_STUDIO_TALENT_SUBTYPE", `${path}.sourceSubtype must be talent or spec.`);
  }
  return {sourceUuid, sourceName, sourceKind, sourceLabel, sourceSubtype};
}

function normalizeResolution(raw, path, {origin, type, sourceUuid}) {
  if (raw === null || raw === undefined) return origin === "custom" ? emptyResolution() : null;
  assertKeys(raw, RESOLUTION_KEYS, path);
  const status = cleanText(raw.status, 16, {required: true});
  const mode = cleanText(raw.mode, 16, {required: true});
  if (!RESOLUTION_STATUSES.has(status)) throw studioError("AGE_NPC_STUDIO_RESOLUTION_STATUS", `${path}.status is unsupported.`);
  if (!RESOLUTION_MODES.has(mode)) throw studioError("AGE_NPC_STUDIO_RESOLUTION_MODE", `${path}.mode is unsupported.`);
  const candidateUuid = nullableText(raw.sourceUuid, AGE_NPC_STUDIO_LIMITS.image);
  const sourceName = cleanText(raw.sourceName, AGE_NPC_STUDIO_LIMITS.name);
  const sourceKind = cleanText(raw.sourceKind, 16);
  const sourceLabel = cleanText(raw.sourceLabel, AGE_NPC_STUDIO_LIMITS.label);
  const sourceSubtype = cleanText(raw.sourceSubtype, 16);
  if (!Array.isArray(raw.alternatives ?? [])) throw studioError("AGE_NPC_STUDIO_RESOLUTION_SOURCE", `${path}.alternatives must be an array.`);
  if ((raw.alternatives ?? []).length > 25) throw studioError("AGE_NPC_STUDIO_RESOLUTION_SOURCE", `${path}.alternatives exceeds 25 exact sources.`);
  const seenSources = new Set();
  const alternatives = (raw.alternatives ?? []).map((source, index) => {
    const normalized = normalizeResolutionSource(source, `${path}.alternatives[${index}]`, type);
    if (seenSources.has(normalized.sourceUuid)) throw studioError("AGE_NPC_STUDIO_RESOLUTION_SOURCE", `${path}.alternatives contains a duplicate source.`);
    seenSources.add(normalized.sourceUuid);
    return normalized;
  });
  if (status === "matched") {
    if (!alternatives.length) throw studioError("AGE_NPC_STUDIO_RESOLUTION_SOURCE", `${path} requires at least one verified exact source.`);
    if (mode === "reuse" && (origin !== "library" || sourceUuid !== candidateUuid)) {
      throw studioError("AGE_NPC_STUDIO_RESOLUTION_BINDING", `${path} does not match the selected library Item.`);
    }
    if (mode === "reuse" && (!candidateUuid || !sourceName || !SOURCE_KINDS.has(sourceKind) || !seenSources.has(candidateUuid))) {
      throw studioError("AGE_NPC_STUDIO_RESOLUTION_SOURCE", `${path} requires a selected verified source.`);
    }
    if (mode === "reuse") {
      const selected = alternatives.find(source => source.sourceUuid === candidateUuid);
      if (!selected || selected.sourceName !== sourceName || selected.sourceKind !== sourceKind
        || selected.sourceLabel !== sourceLabel || selected.sourceSubtype !== sourceSubtype) {
        throw studioError("AGE_NPC_STUDIO_RESOLUTION_BINDING", `${path} selected source metadata does not match its verified alternative.`);
      }
    }
    if (mode === "custom" && (origin !== "custom" || sourceUuid)) {
      throw studioError("AGE_NPC_STUDIO_RESOLUTION_BINDING", `${path} does not match the custom creation choice.`);
    }
    if (mode === "pending" && (origin !== "custom" || sourceUuid || candidateUuid || sourceName || sourceKind || sourceLabel || sourceSubtype)) {
      throw studioError("AGE_NPC_STUDIO_RESOLUTION_BINDING", `${path} contains an invalid pending resolution.`);
    }
  } else {
    if (mode !== "custom" || origin !== "custom" || candidateUuid || sourceName || sourceKind || sourceLabel || sourceSubtype || alternatives.length) {
      throw studioError("AGE_NPC_STUDIO_RESOLUTION_BINDING", `${path} contains an invalid ${status} resolution.`);
    }
  }
  return {status, mode, sourceUuid: candidateUuid, sourceName, sourceKind, sourceLabel, sourceSubtype, alternatives};
}

function normalizeItems(raw) {
  if (!Array.isArray(raw)) throw studioError("AGE_NPC_STUDIO_INPUT_ARRAY", "$.items must be an array.");
  if (raw.length > AGE_NPC_STUDIO_LIMITS.items) throw studioError("AGE_NPC_STUDIO_ITEM_LIMIT", `NPC Studio supports at most ${AGE_NPC_STUDIO_LIMITS.items} Items.`);
  const ids = new Set();
  return raw.map((entry, index) => {
    const path = `$.items[${index}]`;
    assertKeys(entry, ITEM_KEYS, path);
    const entryId = cleanText(entry.entryId, 128, {required: true});
    if (ids.has(entryId)) throw studioError("AGE_NPC_STUDIO_ITEM_ID_DUPLICATE", `Duplicate NPC Studio Item id: ${entryId}.`);
    ids.add(entryId);
    const origin = cleanText(entry.origin, 16, {required: true});
    if (!ITEM_ORIGINS.has(origin)) throw studioError("AGE_NPC_STUDIO_ITEM_ORIGIN", `${path}.origin is unsupported.`);
    const type = cleanText(entry.type, 32, {required: true});
    if (!ITEM_TYPES.has(type)) throw studioError("AGE_NPC_STUDIO_ITEM_TYPE", `${path}.type is unsupported.`);
    const sourceUuid = nullableText(entry.sourceUuid, AGE_NPC_STUDIO_LIMITS.image);
    if (origin === "custom" && sourceUuid) throw studioError("AGE_NPC_STUDIO_RAW_SOURCE", "Custom Items may not carry a source UUID.");
    if (origin !== "custom" && !sourceUuid) throw studioError("AGE_NPC_STUDIO_ITEM_SOURCE", `${path} requires a verified source UUID.`);
    if (origin === "custom" && !CUSTOM_ITEM_TYPES.has(type)) throw studioError("AGE_NPC_STUDIO_CUSTOM_ITEM_TYPE", `Custom ${type} Items are not supported.`);
    const resolution = normalizeResolution(entry.resolution, `${path}.resolution`, {origin, type, sourceUuid});
    const matchedOverlay = origin === "library" && resolution?.status === "matched" && resolution.mode === "reuse";
    if (origin !== "custom" && !matchedOverlay && entry.custom && Object.keys(entry.custom).length) {
      throw studioError("AGE_NPC_STUDIO_RAW_SOURCE", "Only matched library Items may carry a bounded parsed overlay.");
    }
    if (resolution?.status === "matched" && (!entry.custom || !Object.keys(entry.custom).length)) {
      throw studioError("AGE_NPC_STUDIO_RESOLUTION_OVERLAY", `${path} requires its bounded parsed custom alternative.`);
    }
    return {
      entryId,
      origin,
      include: boolean(entry.include, true),
      name: cleanText(entry.name, AGE_NPC_STUDIO_LIMITS.name, {required: true}),
      type,
      img: cleanText(entry.img || "icons/svg/item-bag.svg", AGE_NPC_STUDIO_LIMITS.image, {required: true}),
      sourceUuid,
      custom: origin === "custom" || matchedOverlay ? normalizeCustom(entry.custom ?? {}, `${path}.custom`) : null,
      resolution,
    };
  });
}

export function normalizeNpcStudioDraft(raw) {
  assertNpcStudioSafeInput(raw);
  assertKeys(raw, TOP_KEYS, "$");
  if (raw.schemaVersion !== AGE_NPC_STUDIO_DRAFT_VERSION) {
    throw studioError("AGE_NPC_STUDIO_DRAFT_VERSION", `NPC Studio draft schemaVersion must be ${AGE_NPC_STUDIO_DRAFT_VERSION}.`);
  }
  const profileId = cleanText(raw.profileId, 64, {required: true});
  if (!PROFILE_IDS.has(profileId)) throw studioError("AGE_NPC_STUDIO_PROFILE_UNSUPPORTED", `Unsupported NPC Studio profile: ${profileId}.`);
  return canonicalClone({
    schemaVersion: AGE_NPC_STUDIO_DRAFT_VERSION,
    draftId: cleanText(raw.draftId, 128, {required: true}),
    profileId,
    origin: normalizeOrigin(raw.origin),
    identity: normalizeIdentity(raw.identity),
    abilities: normalizeAbilities(raw.abilities),
    combat: normalizeCombat(raw.combat),
    resources: normalizeResources(raw.resources),
    token: normalizeToken(raw.token),
    notes: normalizeNotes(raw.notes),
    items: normalizeItems(raw.items),
  });
}

export function validateNpcStudioDraft(raw, {
  abilityIds = null,
  talentDegrees = null,
  allowPendingResolution = false,
  allowIncompleteInjuryDamage = false,
} = {}) {
  try {
    const draft = normalizeNpcStudioDraft(raw);
    const errors = [];
    if (Array.isArray(abilityIds)) {
      const expected = [...abilityIds].sort();
      const actual = Object.keys(draft.abilities).sort();
      if (expected.join("\u0000") !== actual.join("\u0000")) {
        errors.push({code: "AGE_NPC_STUDIO_ABILITY_PROFILE", message: "Draft abilities do not exactly match the selected AGE profile."});
      }
      const supported = new Set(expected);
      for (const item of draft.items) {
        if (!item.custom || !["focus", "power"].includes(item.type) || !item.custom.ability) continue;
        if (!supported.has(item.custom.ability)) {
          errors.push({
            code: "AGE_NPC_STUDIO_ABILITY_PROFILE",
            message: `Custom ${item.type} "${item.name}" uses an ability outside the selected AGE profile.`,
          });
        }
      }
    }
    if (Array.isArray(talentDegrees) && talentDegrees.length) {
      const maximum = talentDegrees.length - 1;
      for (const item of draft.items) {
        if (item.type !== "talent" || !item.custom || item.custom.degree <= maximum) continue;
        errors.push({
          code: "AGE_NPC_STUDIO_TALENT_DEGREE",
          message: `Talent "${item.name}" degree must be between 0 and ${maximum} for the selected AGE profile.`,
        });
      }
    }
    if (!allowPendingResolution) for (const item of draft.items) {
      if (item.resolution?.status === "matched" && item.resolution.mode === "pending") {
        errors.push({
          code: "AGE_NPC_STUDIO_RESOLUTION_REQUIRED",
          message: `Choose one verified source or explicit custom creation for "${item.name}".`,
        });
      }
    }
    if (!allowIncompleteInjuryDamage && draft.profileId === "mage-mastery-injury") for (const item of draft.items) {
      if (!item.include || item.type !== "weapon" || item.origin !== "custom" || item.resolution?.mode === "pending") continue;
      if (!Number.isInteger(item.custom?.damageInjury)) {
        errors.push({
          code: "AGE_NPC_STUDIO_INJURY_DAMAGE_REQUIRED",
          message: `Review and enter Injury damage between 1 and 40 for custom attack "${item.name}".`,
        });
      }
      if (item.custom?.damageInjuryConfirmed !== true) {
        errors.push({
          code: "AGE_NPC_STUDIO_INJURY_DAMAGE_CONFIRMATION_REQUIRED",
          message: `Confirm the reviewed Injury damage for custom attack "${item.name}".`,
        });
      }
    }
    if (draft.combat.healthValue > draft.combat.healthSet) {
      errors.push({code: "AGE_NPC_STUDIO_HEALTH_RANGE", message: "Current Health cannot exceed its base maximum."});
    }
    return Object.freeze({valid: errors.length === 0, errors: Object.freeze(errors), draft});
  } catch (error) {
    return Object.freeze({valid: false, errors: Object.freeze([{code: error.code ?? "AGE_NPC_STUDIO_DRAFT_INVALID", message: error.message}]), draft: null});
  }
}

export function assertNpcStudioDraftV1(raw, options = {}) {
  const validation = validateNpcStudioDraft(raw, options);
  if (!validation.valid) {
    throw studioError("AGE_NPC_STUDIO_DRAFT_INVALID", validation.errors.map(error => error.message).join(" "), {errors: validation.errors});
  }
  return validation.draft;
}

export function npcStudioError(code, message, details = {}) {
  return studioError(code, message, details);
}
