import {canonicalClone, canonicalJson, digestCanonicalJson} from "../progression/canonical.js";
import {assertNpcStudioDraftV1, npcStudioError} from "./contracts.js";

const SYSTEM_ID = "age-system";
const OWNER_LEVEL = 3;
const SAFE_SOURCE_ITEM_TYPES = new Set([
  "equipment", "focus", "weapon", "power", "talent", "stunts",
  "relationship", "honorifics", "membership",
]);

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function jsonPlain(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw npcStudioError("AGE_NPC_STUDIO_SOURCE_INVALID", "A source document is not JSON serializable.");
  return JSON.parse(serialized);
}

function rawSource(document) {
  if (document?._source && typeof document._source === "object") return jsonPlain(document._source);
  if (typeof document?.toObject === "function") return jsonPlain(document.toObject(false));
  return jsonPlain(document ?? {});
}

function cleanFlags(flags) {
  const source = jsonPlain(flags ?? {});
  delete source["age-creature-forge"];
  if (source[SYSTEM_ID]) {
    delete source[SYSTEM_ID].progression;
    delete source[SYSTEM_ID].npcStudio;
    delete source[SYSTEM_ID].automation;
    delete source[SYSTEM_ID].importData;
    if (!Object.keys(source[SYSTEM_ID]).length) delete source[SYSTEM_ID];
  }
  return source;
}

function actorDigestFlags(flags) {
  const source = jsonPlain(flags ?? {});
  const studio = source[SYSTEM_ID]?.npcStudio;
  if (studio && typeof studio === "object" && !Array.isArray(studio)) {
    delete studio.creationReceipt;
    if (!Object.keys(studio).length) delete source[SYSTEM_ID].npcStudio;
  }
  if (source[SYSTEM_ID] && !Object.keys(source[SYSTEM_ID]).length) delete source[SYSTEM_ID];
  return source;
}

function stripMetadata(source, {keepId = false, keepFlags = false} = {}) {
  const data = jsonPlain(source ?? {});
  for (const key of ["id", "uuid", "_stats", "folder", "sort", "ownership", "pack"] ) delete data[key];
  if (!keepId) delete data._id;
  if (keepFlags) data.flags = cleanFlags(data.flags);
  else delete data.flags;
  return data;
}

function embeddedItemDigestSource(source) {
  const data = jsonPlain(source ?? {});
  // Preserve every persisted gameplay and module-owned field. Only transient
  // document wrappers and Foundry bookkeeping are outside the undo boundary.
  for (const key of ["id", "uuid", "_stats", "pack"]) delete data[key];
  return data;
}

function packFor(document, environment) {
  const packId = document?.pack;
  if (!packId) return null;
  return values(environment?.game?.packs).find(pack => (pack.collection ?? pack.metadata?.id) === packId) ?? null;
}

function normalizeProfileToken(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .trim()
    .toLocaleLowerCase();
}

function itemProfiles(document, pack) {
  const source = rawSource(document);
  const flags = document?.flags ?? source?.flags;
  const value = flags?.[SYSTEM_ID]?.profile
    ?? flags?.[SYSTEM_ID]?.automation?.profile
    ?? pack?.metadata?.flags?.[SYSTEM_ID]?.profile;
  if (!value) return [];
  return (Array.isArray(value) ? value : String(value).split(/[;,]/u))
    .map(normalizeProfileToken)
    .filter(Boolean);
}

function profileMatches(profiles, profileId) {
  if (!profiles.length) return true;
  const selected = normalizeProfileToken(profileId);
  return profiles.includes(selected) || profiles.includes(selected.split("-")[0]);
}

async function resolveUuid(uuid, environment) {
  const resolver = environment?.foundry?.utils?.fromUuid ?? environment?.fromUuid ?? globalThis.fromUuid;
  if (!(resolver instanceof Function)) throw npcStudioError("AGE_NPC_STUDIO_UUID_RESOLVER", "Foundry UUID resolution is unavailable.");
  return resolver.call(environment?.foundry?.utils ?? environment, uuid);
}

function documentName(document) {
  return document?.documentName ?? document?.constructor?.documentName ?? document?.constructor?.metadata?.name ?? null;
}

function talentSubtype(documentOrSource) {
  const source = rawSource(documentOrSource);
  return String(source?.system?.type ?? documentOrSource?.system?.type ?? "talent") === "spec" ? "spec" : "talent";
}

function itemSnapshotData(document) {
  const source = stripMetadata(rawSource(document), {keepFlags: true});
  return {
    uuid: String(document.uuid ?? ""),
    documentName: "Item",
    name: String(document.name ?? source.name ?? ""),
    type: String(document.type ?? source.type ?? ""),
    img: source.img ?? document.img ?? null,
    system: source.system ?? {},
    flags: cleanFlags(source.flags),
  };
}

function actorSnapshotData(document) {
  const source = stripMetadata(rawSource(document), {keepFlags: true});
  const items = values(document.items)
    .filter(item => SAFE_SOURCE_ITEM_TYPES.has(item.type))
    .map(itemSnapshotData)
    .sort((left, right) => left.uuid.localeCompare(right.uuid));
  return {
    uuid: String(document.uuid ?? ""),
    documentName: "Actor",
    name: String(document.name ?? source.name ?? ""),
    type: String(document.type ?? source.type ?? ""),
    img: source.img ?? document.img ?? null,
    system: source.system ?? {},
    prototypeToken: source.prototypeToken ?? {},
    flags: cleanFlags(source.flags),
    items,
  };
}

export async function npcStudioSourceSnapshot(document) {
  if (!document) throw npcStudioError("AGE_NPC_STUDIO_SOURCE_MISSING", "A bound NPC Studio source is unavailable.");
  const name = documentName(document);
  const data = name === "Actor" ? actorSnapshotData(document) : name === "Item" ? itemSnapshotData(document) : null;
  if (!data) throw npcStudioError("AGE_NPC_STUDIO_SOURCE_TYPE", "NPC Studio sources must be Actor or Item documents.");
  return Object.freeze({
    uuid: String(document.uuid ?? ""),
    documentName: name,
    type: String(document.type ?? ""),
    digest: await digestCanonicalJson(data),
  });
}

async function resolveActorSource(uuid, environment) {
  const actor = await resolveUuid(uuid, environment);
  if (!actor || documentName(actor) !== "Actor" || actor.type !== "char") {
    throw npcStudioError("AGE_NPC_STUDIO_SOURCE_STALE", "The clone source Actor is no longer available as an AGE Character.");
  }
  const pack = packFor(actor, environment);
  if (pack?.visible === false) throw npcStudioError("AGE_NPC_STUDIO_SOURCE_HIDDEN", "The clone source Actor is no longer visible.");
  return actor;
}

async function resolveItemSource(entry, draft, environment) {
  const item = await resolveUuid(entry.sourceUuid, environment);
  if (!item || documentName(item) !== "Item" || item.type !== entry.type || !SAFE_SOURCE_ITEM_TYPES.has(item.type)) {
    throw npcStudioError("AGE_NPC_STUDIO_SOURCE_STALE", `The source Item for "${entry.name}" is unavailable or changed type.`);
  }
  const pack = packFor(item, environment);
  if (pack?.visible === false) throw npcStudioError("AGE_NPC_STUDIO_SOURCE_HIDDEN", `The source Item for "${entry.name}" is no longer visible.`);
  if (!profileMatches(itemProfiles(item, pack), draft.profileId)) {
    throw npcStudioError("AGE_NPC_STUDIO_SOURCE_STALE", `The source Item for "${entry.name}" is not compatible with the signed AGE profile.`);
  }
  if (entry.resolution?.status === "matched" && entry.resolution.mode === "reuse") {
    const sourceKind = pack ? "compendium" : "world";
    if (String(item.uuid ?? "") !== entry.sourceUuid
      || String(item.name ?? rawSource(item)?.name ?? "") !== entry.resolution.sourceName
      || entry.resolution.sourceKind !== sourceKind) {
      throw npcStudioError("AGE_NPC_STUDIO_SOURCE_STALE", `The matched source binding for "${entry.name}" no longer resolves to the reviewed Item.`);
    }
  }
  if (entry.type === "talent" && entry.resolution?.status === "matched") {
    const expectedSubtype = entry.custom?.subtype === "spec" ? "spec" : "talent";
    if (talentSubtype(item) !== expectedSubtype || entry.resolution.sourceSubtype !== expectedSubtype) {
      throw npcStudioError("AGE_NPC_STUDIO_SOURCE_STALE", `The matched ${expectedSubtype === "spec" ? "Specialization" : "Talent"} source for "${entry.name}" changed subtype.`);
    }
  }
  if (entry.origin === "clone") {
    const parentUuid = item.parent?.uuid ?? String(item.uuid).split(".Item.")[0];
    if (!draft.origin.sourceActorUuid || parentUuid !== draft.origin.sourceActorUuid) {
      throw npcStudioError("AGE_NPC_STUDIO_SOURCE_BINDING", `Clone Item "${entry.name}" no longer belongs to the signed source Actor.`);
    }
  }
  return item;
}

function sanitizeRichText(value) {
  return String(value ?? "")
    .replace(/<\s*(?:script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\s*\/\s*(?:script|style|iframe|object|embed)\s*>/giu, "")
    .replace(/<\s*(?:script|style|iframe|object|embed|link|meta)\b[^>]*\/?\s*>/giu, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "")
    .replace(/\b(?:javascript|vbscript)\s*:/giu, "");
}

async function stableId(value, length = 16) {
  return (await digestCanonicalJson(value)).slice(0, length);
}

function modifier(key, type, formula, flavor = "") {
  return {[key]: {type, formula: String(formula), flavor, isActive: true, valid: true, conditions: {}, ftype: "", key}};
}

async function customItemSource(entry, profile) {
  const custom = entry.custom;
  const common = {
    name: entry.name,
    type: entry.type,
    img: entry.img,
    flags: {[SYSTEM_ID]: {npcStudio: {schemaVersion: 1, entryId: entry.entryId, origin: "custom"}}},
  };
  const description = sanitizeRichText(custom.description);
  if (entry.type === "focus") {
    return {...common, system: {initialValue: custom.bonus, useAbl: custom.ability || profile.abilityIds[0], favorite: true, longDesc: description}};
  }
  if (entry.type === "weapon") {
    const key = await stableId({entryId: entry.entryId, modifier: "itemActivation"}, 20);
    const useBallistic = ["mage", "mageInjury"].includes(profile.healthSystem);
    const source = useBallistic
      ? (["impact", "ballistic", "penetrating"].includes(custom.damageSource) ? custom.damageSource : "impact")
      : (custom.damageSource === "penetrating" ? "penetrating" : "normalDamage");
    const injuryDamage = custom.damageInjury == null ? {} : {damageInjury: custom.damageInjury};
    return {...common, system: {
      favorite: true, equiped: true, useAbl: "no-abl", useFocus: "", dmgAbl: "no-abl", dmgType: "wound",
      dmgSource: source, damageFormula: custom.damageFormula, ...injuryDamage, longDesc: description,
      modifiers: custom.bonus ? modifier(key, "itemActivation", custom.bonus, "NPC Studio attack bonus") : {},
    }};
  }
  if (entry.type === "power") {
    return {...common, system: {
      favorite: true, activate: true, useAbl: custom.ability || "will", useFocus: custom.focus,
      targetNumber: custom.targetNumber, powerPointCost: custom.powerPointCost, longDesc: description,
    }};
  }
  if (entry.type === "talent") return {...common, system: {favorite: true, degree: custom.degree, type: custom.subtype, longDesc: description}};
  if (entry.type === "stunts") {
    return {...common, system: {favorite: true, stuntPoints: custom.stuntPoints, stuntPointsMax: custom.stuntPoints, longDesc: description}};
  }
  if (entry.type === "relationship") {
    return {...common, system: {favorite: true, intensity: custom.intensity, intensityMax: custom.intensity, longDesc: description}};
  }
  if (entry.type === "membership") return {...common, system: {favorite: true, rank: custom.rank, longDesc: description}};
  if (entry.type === "honorifics") return {...common, system: {favorite: true, longDesc: description}};
  return {...common, system: {favorite: true, equiped: custom.equipped, activate: custom.equipped, longDesc: description}};
}

function copiedItemSource(entry, document) {
  const source = stripMetadata(rawSource(document));
  const system = jsonPlain(source.system ?? {});
  if (entry.resolution?.status === "matched" && entry.resolution.mode === "reuse" && entry.custom) {
    // These values are Actor-specific stat-block overlays. The library source
    // remains immutable and is still snapshotted/digest-checked in full.
    if (entry.type === "focus") {
      system.initialValue = entry.custom.bonus;
      system.useAbl = entry.custom.ability;
    }
    if (entry.type === "talent") {
      system.degree = entry.custom.degree;
      system.type = entry.custom.subtype;
    }
    if (entry.type === "relationship") {
      system.intensity = entry.custom.intensity;
      system.intensityMax = Math.max(Number(system.intensityMax) || 0, entry.custom.intensity);
    }
    if (entry.type === "membership") system.rank = entry.custom.rank;
  }
  return {
    name: String(source.name ?? document.name ?? entry.name),
    type: String(source.type ?? document.type),
    img: source.img ?? document.img ?? entry.img,
    system,
    flags: {[SYSTEM_ID]: {npcStudio: {
      schemaVersion: 1,
      entryId: entry.entryId,
      origin: entry.origin,
      sourceUuid: entry.sourceUuid,
      resolution: entry.resolution?.mode ?? "source",
    }}},
  };
}

function assertInjuryWeaponSource(entry, document, profile) {
  if (profile?.healthSystem !== "mageInjury" || entry.type !== "weapon") return;
  const injuryDamage = rawSource(document)?.system?.damageInjury;
  if (!Number.isInteger(injuryDamage) || injuryDamage < 1 || injuryDamage > 40) {
    throw npcStudioError(
      "AGE_NPC_STUDIO_INJURY_SOURCE_INVALID",
      `Source weapon "${entry.name}" must provide explicit Injury damage between 1 and 40 for this profile.`,
    );
  }
}

function characterModel(environment) {
  const model = environment?.game?.model?.Actor?.char;
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    throw npcStudioError("AGE_NPC_STUDIO_ACTOR_MODEL", "The AGE Character data model is unavailable.");
  }
  return jsonPlain(model);
}

function ensureBranch(object, key, fallback = {}) {
  if (!object[key] || typeof object[key] !== "object" || Array.isArray(object[key])) object[key] = jsonPlain(fallback);
  return object[key];
}

function buildActorSystem(draft, profile, environment) {
  const system = characterModel(environment);
  system.level = draft.identity.level;
  system.threat = draft.identity.threat;
  system.statBlockView = draft.identity.compactSheet;
  system.ancestry = draft.identity.ancestry;
  system.profession = draft.identity.profession;
  system.background = draft.identity.background;
  system.features = sanitizeRichText(draft.notes.features);
  system.traits = sanitizeRichText(draft.notes.traits);
  system.goals = sanitizeRichText(draft.notes.goals);
  system.gmNotes = sanitizeRichText(draft.notes.gmNotes);
  const abilities = ensureBranch(system, "abilities");
  for (const id of profile.abilityIds) {
    const ability = ensureBranch(abilities, id, {value: 0, primary: false, lastUp: false, testMod: 0, advances: 0});
    ability.value = draft.abilities[id].value;
    ability.primary = profile.primaryAbilities ? draft.abilities[id].primary : false;
  }
  Object.assign(ensureBranch(system, "defense"), {
    base: draft.combat.defenseBase,
    gameModeBonus: draft.combat.defenseGameModeBonus,
    mod: 0,
  });
  Object.assign(ensureBranch(system, "speed"), {base: draft.combat.speedBase, mod: 0});
  Object.assign(ensureBranch(system, "health"), {
    min: 0,
    value: draft.combat.healthValue,
    set: draft.combat.healthSet,
    max: draft.combat.healthSet,
  });
  const armor = ensureBranch(system, "armor");
  armor.impact = draft.combat.impactArmor;
  armor.ballistic = draft.combat.ballisticArmor;
  armor.penalty = 0;
  Object.assign(ensureBranch(armor, "toughness"), {mod: 0, gameModeBonus: draft.combat.toughnessGameModeBonus});
  Object.assign(ensureBranch(system, "powerPoints"), {
    min: 0, value: draft.resources.powerPointsValue, set: draft.resources.powerPointsSet,
  });
  Object.assign(ensureBranch(system, "conviction"), {
    min: 0, value: draft.resources.convictionValue, set: draft.resources.convictionSet,
  });
  ensureBranch(system, "fatigue").entered = draft.resources.fatigueEntered;
  system.initiativeMod = draft.combat.initiativeMod;
  system.attackMod = draft.combat.attackMod;
  system.testMod = draft.combat.testMod;
  system.dmgMod = draft.combat.damageMod;
  const gameMode = ensureBranch(system, "gameMode");
  gameMode.override = false;
  gameMode.selected = profile.gameMode;
  return system;
}

function baseActorSource(draft, profile, environment, actorId, userId) {
  const image = draft.identity.img || "icons/svg/mystery-man.svg";
  const tokenImage = draft.token.img || image;
  const flags = {
    [SYSTEM_ID]: {npcStudio: {schemaVersion: 1, draftId: draft.draftId, profileId: draft.profileId, kind: draft.identity.kind, origin: draft.origin.kind}},
  };
  if (draft.identity.compactSheet) flags.core = {sheetClass: "age-system.ageSystemSheetCharStatBlockV2"};
  return {
    _id: actorId,
    name: draft.identity.name,
    type: "char",
    img: image,
    system: buildActorSystem(draft, profile, environment),
    items: [],
    effects: [],
    folder: null,
    sort: 0,
    ownership: {default: 0, [userId]: OWNER_LEVEL},
    flags,
    prototypeToken: {
      name: draft.identity.name,
      actorLink: draft.token.actorLink,
      disposition: draft.token.disposition,
      width: draft.token.width,
      height: draft.token.height,
      texture: {src: tokenImage},
      bar1: {attribute: "health"},
      bar2: {attribute: profile.usePowerPoints ? "powerPoints" : ""},
    },
  };
}

/** Compile one immutable, write-free Actor creation plan from a normalized typed draft. */
export async function compileNpcStudioPlan(rawDraft, {
  environment = globalThis,
  profile,
  actorId,
  userId,
  draftDigest = null,
} = {}) {
  if (!profile?.abilityIds) throw npcStudioError("AGE_NPC_STUDIO_PROFILE_SNAPSHOT", "NPC Studio compilation requires a profile snapshot.");
  const draft = assertNpcStudioDraftV1(rawDraft, {abilityIds: profile.abilityIds, talentDegrees: profile.talentDegrees});
  if (!actorId || !userId) throw npcStudioError("AGE_NPC_STUDIO_PLAN_BINDING", "NPC Studio compilation requires stable Actor and User ids.");
  const sourceSnapshots = [];
  let cloneActor = null;
  if (draft.origin.kind === "clone") {
    cloneActor = await resolveActorSource(draft.origin.sourceActorUuid, environment);
    sourceSnapshots.push(await npcStudioSourceSnapshot(cloneActor));
  }
  const actorSource = baseActorSource(draft, profile, environment, actorId, userId);
  for (const entry of draft.items.filter(item => item.include)) {
    let itemSource;
    if (entry.origin === "custom") itemSource = await customItemSource(entry, profile);
    else {
      const document = await resolveItemSource(entry, draft, environment);
      assertInjuryWeaponSource(entry, document, profile);
      sourceSnapshots.push(await npcStudioSourceSnapshot(document));
      itemSource = copiedItemSource(entry, document);
    }
    itemSource._id = await stableId({draftId: draft.draftId, entryId: entry.entryId, type: entry.type});
    actorSource.items.push(itemSource);
  }
  sourceSnapshots.sort((left, right) => left.uuid.localeCompare(right.uuid));
  const inputDigest = draftDigest ?? await digestCanonicalJson(draft);
  const body = canonicalClone({
    schemaVersion: 1,
    targetActorId: actorId,
    userId,
    profileId: profile.profileId,
    inputDigest,
    sourceSnapshots,
    actorSource,
  });
  return Object.freeze({...body, planDigest: await digestCanonicalJson(body)});
}

function actorContentSource(actorOrSource) {
  const source = rawSource(actorOrSource);
  const flags = actorDigestFlags(source.flags);
  const hasLiveItems = actorOrSource?.items !== undefined;
  const items = hasLiveItems
    ? values(actorOrSource.items).map(rawSource)
    : Array.isArray(source.items) ? source.items : [];
  return canonicalClone({
    _id: source._id ?? actorOrSource?.id ?? actorOrSource?._id ?? null,
    name: source.name ?? actorOrSource?.name ?? "",
    type: source.type ?? actorOrSource?.type ?? "",
    img: source.img ?? actorOrSource?.img ?? null,
    system: source.system ?? {},
    items: items.map(embeddedItemDigestSource),
    effects: Array.isArray(source.effects) ? source.effects : [],
    folder: source.folder ?? null,
    sort: source.sort ?? 0,
    ownership: source.ownership ?? {},
    flags,
    prototypeToken: source.prototypeToken ?? {},
  });
}

/** Authoritative digest used to permit deletion only while the created Actor is byte-for-byte unchanged. */
export async function digestNpcStudioActor(actorOrSource) {
  return digestCanonicalJson(actorContentSource(actorOrSource));
}

export function npcStudioActorContent(actorOrSource) {
  return actorContentSource(actorOrSource);
}

export function sameNpcStudioSources(left, right) {
  return canonicalJson(left ?? []) === canonicalJson(right ?? []);
}
