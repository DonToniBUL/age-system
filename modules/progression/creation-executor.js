import {canonicalClone, canonicalJson, digestCanonicalJson} from "./canonical.js";
import {ageSystem} from "../config.js";
import {
  AGE_PROGRESSION_RECEIPT_VERSION,
  createProgressionReceiptV1
} from "./receipts.js";

export const AGE_PROGRESSION_CREATION_RECEIPT_VERSION = AGE_PROGRESSION_RECEIPT_VERSION;
export const AGE_PROGRESSION_DEFINITION_BINDING_VERSION = 1;
export const AGE_PROGRESSION_CREATION_FLAG = Object.freeze([
  "age-system",
  "progression",
  "creationReceipt"
]);

const IDENTITY_PATHS = Object.freeze({
  ancestry: ["system", "ancestry"],
  background: ["system", "background"],
  socialClass: ["system", "socialClass"],
  class: ["system", "profession"],
  profession: ["system", "profession"],
  drive: ["system", "drive", "name"],
  quality: ["system", "drive", "quality"],
  downfall: ["system", "drive", "downfall"],
  goals: ["system", "goals"],
  ties: ["system", "traits"],
  language: ["system", "language"],
  description: ["system", "features"]
});

const DIRECT_RESOURCES = new Set(["health", "powerPoints", "conviction"]);
const SCALAR_RESOURCES = new Set(["currency"]);
const SCORE_RESOURCES = new Set(["resources"]);
// Map both provider-neutral advancement traits and the original creation-only
// dotted spellings onto one explicit operation vocabulary. A Map is
// intentional here: object-property lookup would accept inherited names such
// as `constructor` and turn an unsupported signed effect into a silent no-op.
const CREATION_ADVANCE_TRAITS = new Map([
  ["focus", "focus.improved"],
  ["focus.improved", "focus.improved"],
  ["talent", "talent.degree"],
  ["talent.degree", "talent.degree"],
  ["spec", "spec.degree"],
  ["spec.degree", "spec.degree"],
  ["relationship", "relationship.intensity"],
  ["relationship.intensity", "relationship.intensity"],
  ["membership", "membership.rank"],
  ["membership.rank", "membership.rank"],
]);
const DEFAULT_TALENT_DEGREE_COUNT = 5;

function creationError(message, code = "creation-invalid", details = {}) {
  const error = new Error(message);
  error.name = "AgeProgressionCreationError";
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

function ensureObject(parent, key) {
  if (!isPlainObject(parent[key])) parent[key] = {};
  return parent[key];
}

function setPath(root, path, value) {
  let current = root;
  for (const key of path.slice(0, -1)) current = ensureObject(current, key);
  current[path.at(-1)] = value;
}

function getPath(root, path) {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw creationError(`${label} must be a resolved finite number.`, "unresolved-effect");
  return number;
}

function stableId(value, label) {
  if (typeof value !== "string" || !value.trim() || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw creationError(`${label} must be a non-empty Foundry-safe id.`, "invalid-id");
  }
  return value;
}

function defaultIdFactory() {
  const foundryId = globalThis.foundry?.utils?.randomID?.();
  if (foundryId) return foundryId;
  const uuid = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  if (uuid) return uuid.slice(0, 16);
  throw creationError("No secure Foundry id factory is available.", "id-factory");
}

async function nextId(idFactory, kind, context) {
  return stableId(await idFactory(kind, context), `${kind} id`);
}

function documentSource(value, label) {
  let source = value;
  if (isPlainObject(value) && Object.hasOwn(value, "item")) source = value.item;
  // Pin the authoritative persisted source. Prepared document data and
  // toObject compatibility layers can normalize or cache fields differently;
  // progression staleness must observe the current raw `_source` exactly.
  if (isPlainObject(source?._source)) source = source._source;
  else if (source?.toObject instanceof Function) source = source.toObject(true);
  if (!isPlainObject(source)) throw creationError(`${label} did not resolve to plain Item source data.`, "source-resolution");
  return canonicalClone(source);
}

/** Canonical digest shared by preview-time and commit-time source pinning. */
export async function digestCreationSource(value, label = "Creation Item source") {
  return digestCanonicalJson(documentSource(value, label));
}

function progressionNamespace(source) {
  const flags = ensureObject(source, "flags");
  const systemFlags = ensureObject(flags, "age-system");
  return ensureObject(systemFlags, "progression");
}

function atomicValue(value) {
  const cloned = canonicalClone(value);
  const ForcedReplacement = globalThis.foundry?.data?.operators?.ForcedReplacement;
  return ForcedReplacement?.create instanceof Function ? ForcedReplacement.create(cloned) : cloned;
}

function markSourceReference(item, sourceRefId) {
  const flags = ensureObject(item, "flags");
  const systemFlags = ensureObject(flags, "age-system");
  systemFlags.progressionSourceRefId = sourceRefId;
}

function incrementResource(source, resource, amount) {
  const system = ensureObject(source, "system");
  if (SCALAR_RESOURCES.has(resource)) {
    system.currency = finiteNumber(system.currency ?? 0, "system.currency") + amount;
    return;
  }
  if (SCORE_RESOURCES.has(resource)) {
    const data = ensureObject(system, resource);
    data.base = finiteNumber(data.base ?? 0, `system.${resource}.base`) + amount;
    return;
  }
  if (!DIRECT_RESOURCES.has(resource)) throw creationError(`Unsupported creation resource "${resource}".`, "unsupported-effect");
  const data = ensureObject(system, resource);
  data.value = finiteNumber(data.value ?? 0, `system.${resource}.value`) + amount;
  data.set = finiteNumber(data.set ?? data.value - amount, `system.${resource}.set`) + amount;
  if (resource === "health" && Number.isFinite(Number(data.max))) data.max = Number(data.max) + amount;
}

function initializeResource(source, resource, amount) {
  const total = finiteNumber(amount, `system.${resource} starting total`);
  if (total < 0) throw creationError(`Starting resource "${resource}" must not be negative.`, "invalid-resource-initialization");
  const system = ensureObject(source, "system");
  if (SCALAR_RESOURCES.has(resource)) {
    system.currency = total;
    return;
  }
  if (SCORE_RESOURCES.has(resource)) {
    const data = ensureObject(system, resource);
    data.base = total;
    data.mod = 0;
    return;
  }
  if (!DIRECT_RESOURCES.has(resource)) throw creationError(`Unsupported starting resource "${resource}".`, "unsupported-effect");
  const data = ensureObject(system, resource);
  data.value = total;
  data.set = total;
  data.max = total;
}

function setAbilityValue(source, effect) {
  const abilityId = String(effect.abilityId ?? "");
  const ability = getPath(source, ["system", "abilities", abilityId]);
  if (!isPlainObject(ability)) throw creationError(`Character source has no ability "${abilityId}".`, "unknown-ability");
  const value = finiteNumber(effect.value, `system.abilities.${abilityId}.value`);
  if (!Number.isInteger(value)) throw creationError(`Starting ability "${abilityId}" must be an integer.`, "invalid-ability-value");
  ability.value = value;
  ability.advances = 0;
}

function addLanguage(source, rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) throw creationError("language.add requires a non-empty language.", "invalid-language");
  const system = ensureObject(source, "system");
  const languages = String(system.language ?? "")
    .split(/[,;\n]/)
    .map(entry => entry.trim())
    .filter(Boolean);
  if (!languages.some(entry => entry.localeCompare(value, undefined, {sensitivity: "accent"}) === 0)) languages.push(value);
  system.language = languages.join(", ");
}

function incrementClassBonus(source, bonus, amount) {
  const bonuses = ensureObject(ensureObject(source, "system"), "classBonuses");
  bonuses[bonus] = finiteNumber(bonuses[bonus] ?? 0, `system.classBonuses.${bonus}`) + amount;
}

function resolvedAllocations(effect) {
  const raw = effect.allocations ?? effect.allocation ?? effect.resolution?.allocations;
  if (typeof effect.abilityId === "string" && raw === undefined) return {[effect.abilityId]: effect.amount};
  if (raw === undefined && Array.isArray(effect.eligibleAbilityIds) && effect.eligibleAbilityIds.length === 1) {
    return {[effect.eligibleAbilityIds[0]]: effect.amount};
  }
  if (!isPlainObject(raw)) throw creationError(`Ability allocation "${effect.operationId ?? effect.id}" has no explicit resolved allocations.`, "unresolved-allocation");
  return raw;
}

function applyAbilityAllocation(source, effect) {
  const expected = finiteNumber(effect.amount, "ability.allocate amount");
  const allocations = resolvedAllocations(effect);
  const eligible = Array.isArray(effect.eligibleAbilityIds) ? new Set(effect.eligibleAbilityIds) : null;
  const abilities = ensureObject(ensureObject(source, "system"), "abilities");
  let total = 0;
  for (const [abilityId, rawAmount] of Object.entries(allocations)) {
    if (eligible && !eligible.has(abilityId)) throw creationError(`Ability "${abilityId}" is not eligible for this allocation.`, "ineligible-allocation");
    const amount = finiteNumber(rawAmount, `allocation.${abilityId}`);
    if (!Number.isInteger(amount) || amount < 0) throw creationError(`Allocation for "${abilityId}" must be a non-negative integer.`, "invalid-allocation");
    const ability = abilities[abilityId];
    if (!isPlainObject(ability)) throw creationError(`Character source has no ability "${abilityId}".`, "unknown-ability");
    ability.value = finiteNumber(ability.value ?? 0, `system.abilities.${abilityId}.value`) + amount;
    // Creation allocations establish the starting rating. They are not banked
    // post-creation advancement points; those are handled by the advancement
    // executors after the Character exists.
    ability.advances = finiteNumber(ability.advances ?? 0, `system.abilities.${abilityId}.advances`);
    total += amount;
  }
  if (total !== expected) throw creationError(`Resolved ability allocations total ${total}, expected ${expected}.`, "allocation-total");
}

function applyPrimary(source, abilityId) {
  const ability = getPath(source, ["system", "abilities", abilityId]);
  if (!isPlainObject(ability)) throw creationError(`Character source has no ability "${abilityId}".`, "unknown-ability");
  ability.primary = true;
}

function addWeaponGroup(source, weaponGroupId) {
  const system = ensureObject(source, "system");
  if (!Array.isArray(system.wgroups)) system.wgroups = [];
  if (!system.wgroups.includes(weaponGroupId)) system.wgroups.push(weaponGroupId);
}

function itemTrait(item) {
  const type = String(item?.type ?? "");
  const system = isPlainObject(item?.system) ? item.system : {};
  return type === "talent" && system.type === "spec" ? "spec" : type;
}

function talentMaximumDegree() {
  const configured = ageSystem.talentDegrees?.inUse;
  const count = Array.isArray(configured) ? configured.length : DEFAULT_TALENT_DEGREE_COUNT;
  return Math.max(0, count - 1);
}

function advanceDegree(value) {
  const current = ["", null, undefined].includes(value) ? -1 : Number(value);
  const maximum = talentMaximumDegree();
  if (!Number.isInteger(current) || current < -1 || current >= maximum) {
    throw creationError(`Cannot safely advance degree "${value}".`, "item-rank");
  }
  return current + 1;
}

function applyItemAdvance(acquiredByRef, effect) {
  const trait = CREATION_ADVANCE_TRAITS.get(effect.trait);
  if (!trait) throw creationError(`Unsupported explicit item advance trait "${effect.trait}".`, "unsupported-effect");
  if (!effect.sourceRefId) throw creationError("Creation-time item.advance requires an explicit sourceRefId.", "ambiguous-item");
  const item = acquiredByRef.get(effect.sourceRefId);
  if (!item) throw creationError(`No acquired Item matches sourceRef "${effect.sourceRefId}".`, "missing-item");
  const system = ensureObject(item, "system");
  switch (trait) {
    case "focus.improved":
      if (itemTrait(item) !== "focus") throw creationError("focus.improved can only advance a Focus.", "item-type");
      if (system.improved) throw creationError("This Focus is already improved.", "item-rank");
      system.improved = true;
      break;
    case "talent.degree": {
      if (itemTrait(item) !== "talent") throw creationError("talent.degree can only advance a non-specialization Talent.", "item-type");
      system.degree = advanceDegree(system.degree);
      break;
    }
    case "spec.degree": {
      if (itemTrait(item) !== "spec") throw creationError("spec.degree can only advance a Specialization Talent.", "item-type");
      system.degree = advanceDegree(system.degree);
      break;
    }
    case "relationship.intensity":
      if (itemTrait(item) !== "relationship") throw creationError("relationship.intensity can only advance a Relationship.", "item-type");
      system.intensity = finiteNumber(system.intensity ?? 0, "relationship intensity") + 1;
      system.intensityMax = Math.max(
        finiteNumber(system.intensityMax ?? 0, "relationship maximum intensity"),
        system.intensity,
      );
      break;
    case "membership.rank":
      if (itemTrait(item) !== "membership") throw creationError("membership.rank can only advance a Membership.", "item-type");
      system.rank = finiteNumber(system.rank ?? 0, "membership rank") + 1;
      break;
    default:
      // The Map above is the only accepted dispatch surface. Keep an explicit
      // fail-closed default in case a future alias is added without execution.
      throw creationError(`Unsupported explicit item advance trait "${effect.trait}".`, "unsupported-effect");
  }
}

function validateItemAdvanceBindings(effects) {
  const acquisitions = new Map();
  const advances = new Map();
  for (const [index, effect] of effects.entries()) {
    if (!isPlainObject(effect)) continue;
    if (effect.type === "item.acquire") {
      const entries = acquisitions.get(effect.sourceRefId) ?? [];
      entries.push({index, quantity: effect.quantity === undefined ? 1 : effect.quantity});
      acquisitions.set(effect.sourceRefId, entries);
    } else if (effect.type === "item.advance" && effect.sourceRefId) {
      const entries = advances.get(effect.sourceRefId) ?? [];
      entries.push(index);
      advances.set(effect.sourceRefId, entries);
    }
  }

  for (const [sourceRefId, advanceIndexes] of advances) {
    const grants = acquisitions.get(sourceRefId) ?? [];
    if (!grants.length) {
      throw creationError(`No acquired Item matches sourceRef "${sourceRefId}".`, "missing-item");
    }
    if (grants.length !== 1 || grants[0].quantity !== 1) {
      throw creationError(
        `Creation-time item.advance requires exactly one acquired Item for sourceRef "${sourceRefId}".`,
        "ambiguous-item",
        {sourceRefId, acquisitionCount: grants.length},
      );
    }
    if (grants[0].index > advanceIndexes[0]) {
      throw creationError(
        `Creation-time item.advance must follow item.acquire for sourceRef "${sourceRefId}".`,
        "item-source-order",
        {sourceRefId},
      );
    }
  }
}

function applyTrack(source, trackId, rank) {
  if (trackId === "level") {
    ensureObject(source, "system").level = rank;
    return;
  }
  const progression = progressionNamespace(source);
  const tracks = ensureObject(progression, "tracks");
  tracks[trackId] = rank;
}

function bindCreationDefinition(source, preview) {
  const binding = preview?.trackBinding;
  if (!isPlainObject(binding) || binding.kind !== "actor") return;
  const trackId = String(binding.trackId ?? "");
  if (!trackId || ["__proto__", "prototype", "constructor"].includes(trackId)) {
    throw creationError("Actor progression track binding is invalid.", "track-binding");
  }
  const rankEffects = preview.resolvedEffects.filter(effect => (
    effect?.type === "track.setRank"
      && effect.trackId === trackId
      && Number(effect.rank) === Number(preview.rank)
  ));
  if (rankEffects.length !== 1) {
    throw creationError("Actor-backed creation requires exactly one matching track.setRank effect.", "track-binding");
  }
  const progression = progressionNamespace(source);
  const existingRegistry = progression.actorTracks;
  if (existingRegistry !== undefined && (
    !isPlainObject(existingRegistry)
      || existingRegistry.schemaVersion !== AGE_PROGRESSION_DEFINITION_BINDING_VERSION
      || !isPlainObject(existingRegistry.tracks)
  )) {
    throw creationError("Character source has an incompatible Actor progression registry.", "track-binding");
  }
  const registry = existingRegistry ?? {
    schemaVersion: AGE_PROGRESSION_DEFINITION_BINDING_VERSION,
    tracks: {},
  };
  if (Object.hasOwn(registry.tracks, trackId)) {
    throw creationError(`Character source already contains Actor progression track "${trackId}".`, "track-binding-conflict");
  }
  registry.tracks[trackId] = {
    schemaVersion: AGE_PROGRESSION_DEFINITION_BINDING_VERSION,
    trackId,
    rank: Number(preview.rank),
    definitionId: String(preview.definitionId),
    profileId: String(preview.profileId),
    transactions: [],
  };
  progression.actorTracks = registry;
}

function withoutReceiptAndVolatile(source) {
  const clone = canonicalClone(source);
  const stripStats = value => {
    if (Array.isArray(value)) {
      value.forEach(stripStats);
      return;
    }
    if (!isPlainObject(value)) return;
    delete value._stats;
    Object.values(value).forEach(stripStats);
  };
  stripStats(clone);
  const systemFlags = clone.flags?.["age-system"];
  const progression = systemFlags?.progression;
  if (isPlainObject(progression)) {
    delete progression.creationReceipt;
    if (!Object.keys(progression).length) delete systemFlags.progression;
  }
  if (isPlainObject(systemFlags) && !Object.keys(systemFlags).length) delete clone.flags["age-system"];
  return clone;
}

function embeddedReceipt(source) {
  return source?.flags?.["age-system"]?.progression?.creationReceipt ?? null;
}

function previewBody(preview) {
  const body = canonicalClone(preview);
  delete body.planDigest;
  return body;
}

async function validatePreview(preview, {baseActorData, now = Date.now(), userId = null} = {}) {
  if (!isPlainObject(preview) || preview.schemaVersion !== 1) throw creationError("Creation requires a Progression PreviewV1.", "preview-version");
  if (preview.trigger !== "character.create") throw creationError("Creation executor only accepts character.create previews.", "preview-trigger");
  if (preview.actorUuid !== null && preview.actorUuid !== undefined) throw creationError("Creation preview must not be bound to an existing Actor.", "preview-actor");
  if (!Array.isArray(preview.resolvedEffects)) throw creationError("Creation preview has no resolvedEffects array.", "preview-effects");
  if (typeof preview.previewId !== "string" || !preview.previewId) throw creationError("Creation preview has no stable previewId.", "preview-id");
  if (typeof preview.planDigest !== "string" || !preview.planDigest) throw creationError("Creation preview has no planDigest.", "preview-digest");
  if (typeof preview.profileDigest !== "string" || !/^[0-9a-f]{64}$/i.test(preview.profileDigest)) {
    throw creationError("Creation preview has no valid profileDigest.", "preview-profile");
  }
  if (!Array.isArray(preview.sourceSnapshots)) throw creationError("Creation preview has no sourceSnapshots array.", "preview-sources");
  const acquiredSourceRefIds = [...new Set(preview.resolvedEffects
    .filter(effect => effect?.type === "item.acquire")
    .map(effect => effect.sourceRefId))].sort();
  const snapshotIds = [];
  for (const [index, binding] of preview.sourceSnapshots.entries()) {
    if (!isPlainObject(binding)
      || typeof binding.sourceRefId !== "string"
      || (binding.sourceUuid !== null && typeof binding.sourceUuid !== "string")
      || typeof binding.digest !== "string"
      || !/^[0-9a-f]{64}$/i.test(binding.digest)) {
      throw creationError(`Creation source snapshot ${index} is invalid.`, "preview-sources");
    }
    snapshotIds.push(binding.sourceRefId);
  }
  if (new Set(snapshotIds).size !== snapshotIds.length
    || canonicalJson([...snapshotIds].sort()) !== canonicalJson(acquiredSourceRefIds)) {
    throw creationError("Creation source snapshots do not exactly bind acquired sources.", "preview-sources");
  }
  const expectedPlanDigest = await digestCanonicalJson(previewBody(preview));
  if (expectedPlanDigest !== preview.planDigest) throw creationError("Creation preview planDigest does not match its immutable body.", "preview-digest", {expectedPlanDigest});
  const expiresAt = Date.parse(preview.expiresAt);
  const createdAt = Date.parse(preview.createdAt);
  if (!Number.isFinite(createdAt) || createdAt > now || createdAt >= expiresAt) throw creationError("Creation preview has an invalid creation time.", "preview-time");
  if (!Number.isFinite(expiresAt) || now >= expiresAt) throw creationError("Creation preview has expired.", "preview-expired");
  if (userId !== null && preview.userId !== null && preview.userId !== undefined && preview.userId !== userId) {
    throw creationError("Creation preview belongs to a different user.", "preview-user");
  }
  if (baseActorData !== undefined) {
    const actualBaseDigest = await digestCanonicalJson(canonicalClone(baseActorData));
    if (preview.baseDigest !== actualBaseDigest) throw creationError("Creation base data changed after preview.", "base-stale", {actualBaseDigest});
  }
  return true;
}

function creationReceipt(preview, actorId, sourceDigest, now) {
  return createProgressionReceiptV1({
    id: `create:${preview.previewId}`,
    kind: "character.create",
    previewId: preview.previewId,
    planDigest: preview.planDigest,
    definitionId: preview.definitionId,
    definitionVersion: preview.definitionVersion,
    definitionDigest: preview.definitionDigest,
    profileId: preview.profileId,
    actorUuid: `Actor.${actorId}`,
    transactionId: null,
    beforeDigest: preview.baseDigest,
    afterDigest: sourceDigest,
    createdAt: Date.parse(preview.createdAt),
    committedAt: Number(now),
    committedBy: preview.userId,
    reversible: true
  }, {idFactory: () => `create:${preview.previewId}`, now: Number(now)});
}

/**
 * Pure, deterministic Character-source materialization.  All formulas and
 * choices must already be pinned by PreviewV1; sourceResolver is the sole
 * authority allowed to turn an explicit sourceRefId into Item source data.
 */
export async function materializeCharacterSource(preview, baseActorData, {
  sourceResolver = null,
  idFactory = defaultIdFactory,
  now = Date.now()
} = {}) {
  await validatePreview(preview, {baseActorData, now});
  if (!isPlainObject(baseActorData)) throw creationError("Base Character data must be a complete plain object.", "base-source");
  const source = canonicalClone(baseActorData);
  if (source.type !== "char") throw creationError("Creation materializer only accepts a complete Character source (type char).", "actor-type");
  if (!isPlainObject(source.system)) throw creationError("Complete Character source is missing system data.", "base-source");
  if (!Array.isArray(source.items)) source.items = [];
  if (!isPlainObject(source.flags)) source.flags = {};
  validateItemAdvanceBindings(preview.resolvedEffects);

  source._id = source._id ? stableId(source._id, "actor id") : await nextId(idFactory, "actor", {preview});
  const usedIds = new Set();
  for (const [index, item] of source.items.entries()) {
    if (!isPlainObject(item)) throw creationError(`Base embedded Item ${index} is not plain source data.`, "base-item");
    item._id = item._id ? stableId(item._id, `base Item ${index} id`) : await nextId(idFactory, "item", {preview, index, base: true});
    if (usedIds.has(item._id)) throw creationError(`Duplicate embedded Item id "${item._id}".`, "duplicate-id");
    usedIds.add(item._id);
  }

  const acquiredByRef = new Map();
  const sourceSnapshots = new Map(preview.sourceSnapshots.map(binding => [binding.sourceRefId, binding]));
  const initializedResources = new Set();
  // Starting totals are a distinct materialization phase. They always replace
  // template defaults before additive gains, independent of provider ordering.
  for (const effect of preview.resolvedEffects) {
    if (effect?.type !== "resource.initialize") continue;
    if (initializedResources.has(effect.resource)) {
      throw creationError(`Creation preview initializes resource "${effect.resource}" more than once.`, "duplicate-resource-initialization");
    }
    initializeResource(source, effect.resource, effect.amount);
    initializedResources.add(effect.resource);
  }
  for (const [index, effect] of preview.resolvedEffects.entries()) {
    if (!isPlainObject(effect) || typeof effect.type !== "string") throw creationError(`Resolved effect ${index} is invalid.`, "preview-effect");
    switch (effect.type) {
      case "identity.set":
        if (effect.field === "name") source.name = String(effect.value);
        else if (IDENTITY_PATHS[effect.field]) setPath(source, IDENTITY_PATHS[effect.field], effect.value);
        else throw creationError(`Unsupported identity field "${effect.field}".`, "unsupported-effect");
        break;
      case "resource.gain":
        incrementResource(source, effect.resource, finiteNumber(effect.amount, `${effect.resource} amount`));
        break;
      case "resource.initialize":
        break; // Applied once in the starting-resource phase above.
      case "classBonus.gain":
        incrementClassBonus(source, effect.bonus, finiteNumber(effect.amount, `${effect.bonus} amount`));
        break;
      case "ability.allocate":
        applyAbilityAllocation(source, effect);
        break;
      case "ability.set":
        setAbilityValue(source, effect);
        break;
      case "ability.setPrimary":
        applyPrimary(source, effect.abilityId);
        break;
      case "weaponGroup.add":
        addWeaponGroup(source, effect.weaponGroupId);
        break;
      case "language.add":
        addLanguage(source, effect.value);
        break;
      case "item.acquire": { // Explicit resolver only; no compendium search or inference.
        if (!(sourceResolver instanceof Function)) throw creationError("item.acquire requires an explicit sourceResolver.", "source-resolver");
        const resolved = await sourceResolver(effect.sourceRefId, {preview, effect});
        const item = documentSource(resolved, `sourceRef "${effect.sourceRefId}"`);
        const pinned = sourceSnapshots.get(effect.sourceRefId);
        const currentDigest = await digestCanonicalJson(item);
        if (!pinned || currentDigest !== pinned.digest) {
          throw creationError(`Creation sourceRef "${effect.sourceRefId}" changed after preview.`, "source-stale", {
            sourceRefId: effect.sourceRefId,
            expectedDigest: pinned?.digest ?? null,
            currentDigest,
          });
        }
        if (item.img === "icons/svg/skill.svg") item.img = "icons/svg/book.svg";
        item._id = await nextId(idFactory, "item", {preview, effect, index});
        if (usedIds.has(item._id)) throw creationError(`Duplicate embedded Item id "${item._id}".`, "duplicate-id");
        usedIds.add(item._id);
        if (effect.quantity !== undefined) ensureObject(item, "system").quantity = effect.quantity;
        markSourceReference(item, effect.sourceRefId);
        source.items.push(item);
        acquiredByRef.set(effect.sourceRefId, item);
        break;
      }
      case "item.advance":
        applyItemAdvance(acquiredByRef, effect);
        break;
      case "track.setRank":
        applyTrack(source, effect.trackId, finiteNumber(effect.rank, `${effect.trackId} rank`));
        break;
      case "summary.add":
        break; // Preview-only presentation; never mutates a document.
      default:
        throw creationError(`Unsupported creation effect "${effect.type}".`, "unsupported-effect");
    }
  }

  bindCreationDefinition(source, preview);

  const sourceDigest = await digestCanonicalJson(withoutReceiptAndVolatile(source));
  const receipt = creationReceipt(preview, source._id, sourceDigest, now);
  progressionNamespace(source).creationReceipt = canonicalClone(receipt);
  return deepFreeze(source);
}

function permissionAllowsCreation(user) {
  if (!user) return false;
  if (user.isGM === true) return true;
  try {
    if (user.can?.("ACTOR_CREATE") === true) return true;
  } catch { /* Foundry permission helpers may throw outside an initialized world. */ }
  try {
    if (user.hasPermission?.("ACTOR_CREATE") === true) return true;
  } catch { /* See above. */ }
  return false;
}

function registryHas(registry, key) {
  return registry?.has?.(key) === true;
}

function registryAdd(registry, key) {
  if (registry?.add instanceof Function) registry.add(key);
  else if (registry?.set instanceof Function) registry.set(key, true);
  else throw creationError("Creation commit registry must implement Set/Map semantics.", "commit-registry");
}

function registryDelete(registry, key) {
  if (registry?.delete instanceof Function) registry.delete(key);
}

function actorRawSource(actor) {
  if (isPlainObject(actor?._source)) return actor._source;
  if (actor?.toObject instanceof Function) return actor.toObject(true);
  if (isPlainObject(actor)) return actor;
  throw creationError("Actor does not expose raw source data.", "actor-source");
}

export function getCreationReceipt(actorOrSource) {
  const source = isPlainObject(actorOrSource?._source) ? actorOrSource._source : actorOrSource;
  const receipt = embeddedReceipt(source);
  return receipt ? deepFreeze(canonicalClone(receipt)) : null;
}

/** Atomic creation and deliberately destructive, exact-match-only reversal. */
export class AgeProgressionCreationExecutor {
  #baseActorData;
  #sourceResolver;
  #idFactory;
  #registry;
  #clock;
  #actorCollection;

  constructor({
    baseActorData,
    sourceResolver = null,
    idFactory = defaultIdFactory,
    commitRegistry = new Set(),
    clock = () => Date.now(),
    actorCollection = null
  } = {}) {
    if (baseActorData === undefined) throw creationError("Creation executor requires baseActorData or a baseActorData factory.", "base-source");
    this.#baseActorData = baseActorData;
    this.#sourceResolver = sourceResolver;
    this.#idFactory = idFactory;
    this.#registry = commitRegistry;
    this.#clock = clock;
    this.#actorCollection = actorCollection;
  }

  async #resolveBase(preview) {
    const value = this.#baseActorData instanceof Function ? await this.#baseActorData(preview) : this.#baseActorData;
    return canonicalClone(value);
  }

  async commit({preview, actorCollection = this.#actorCollection, user} = {}) {
    if (!permissionAllowsCreation(user)) throw creationError("User may not create Actors.", "permission");
    await validatePreview(preview, {now: this.#clock(), userId: user.id ?? null});
    const commitKey = preview.previewId;
    if (registryHas(this.#registry, commitKey)) throw creationError("Creation preview has already been committed or attempted.", "duplicate-commit");
    if (!(actorCollection?.createDocuments instanceof Function)) throw creationError("Actor.createDocuments is unavailable.", "actor-collection");
    // Claim before any additional await to close concurrent double-submit.
    registryAdd(this.#registry, commitKey);
    let actorData;
    let receipt;
    try {
      const baseActorData = await this.#resolveBase(preview);
      actorData = await materializeCharacterSource(preview, baseActorData, {
        sourceResolver: this.#sourceResolver,
        idFactory: this.#idFactory,
        now: this.#clock()
      });
      receipt = getCreationReceipt(actorData);
    } catch (error) {
      // No document write was attempted, so releasing this claim is safe.
      registryDelete(this.#registry, commitKey);
      throw error;
    }

    // Once the write begins, retrying this signed preview would be ambiguous.
    this.#actorCollection = actorCollection;
    // The creation receipt is bound to the deterministic Actor id which was
    // included in the signed materialized source. Foundry generates a new
    // top-level id unless keepId is explicit, which would otherwise strand
    // the embedded receipt on a different Actor UUID after reload.
    const created = await actorCollection.createDocuments([canonicalClone(actorData)], {
      keepId: true,
      keepEmbeddedIds: true,
    });
    if (!Array.isArray(created) || created.length !== 1) throw creationError("Atomic Actor creation returned an unexpected result.", "creation-result");
    // Never recursively freeze a live Foundry Document.  Only the hand-off
    // envelope and its already immutable receipt are frozen.
    const actor = created[0];
    const actorId = actor?.id ?? actor?._id ?? actorData._id;
    const actorUuid = actor?.uuid ?? `Actor.${actorId}`;
    if (actorUuid !== receipt.actorUuid || String(actorId) !== String(actorData._id)) {
      throw creationError("Created Actor id does not match its signed creation receipt.", "creation-binding", {
        expectedActorUuid: receipt.actorUuid,
        actualActorUuid: actorUuid,
      });
    }
    // Foundry cleaning may materialize top-level defaults which were not part
    // of the portable pre-create source. Bind the durable receipt to the
    // authoritative stored source after creation, while the receipt itself is
    // excluded from that digest. This keeps immediate and reload-safe undo
    // exact without weakening edited-Actor detection.
    const storedDigest = await digestCanonicalJson(withoutReceiptAndVolatile(actorRawSource(actor)));
    if (storedDigest !== receipt.afterDigest) {
      receipt = createProgressionReceiptV1({...receipt, afterDigest: storedDigest}, {
        idFactory: () => receipt.id,
        now: receipt.createdAt,
      });
      let receiptError = null;
      try {
        if (!(actor?.update instanceof Function)) throw new Error("Actor.update is unavailable.");
        await actor.update({
          "flags.age-system.progression.creationReceipt": atomicValue(receipt),
        }, {ageProgressionCreationReceipt: true});
      } catch (error) { receiptError = error; }
      const persisted = embeddedReceipt(actorRawSource(actor));
      const verifiedDigest = await digestCanonicalJson(withoutReceiptAndVolatile(actorRawSource(actor)));
      if (!persisted || canonicalJson(persisted) !== canonicalJson(receipt) || verifiedDigest !== storedDigest) {
        let removed = false;
        try {
          if (actorCollection?.deleteDocuments instanceof Function) {
            await actorCollection.deleteDocuments([actorId]);
            removed = true;
          }
        } catch {}
        throw creationError("Created Actor receipt did not persist against its authoritative source.", removed ? "creation-receipt" : "creation-recovery", {
          cause: receiptError?.message ?? null,
          actorUuid,
          removed,
        });
      }
    }
    return Object.freeze({actor, actorId, actorUuid, receipt, previewId: preview.previewId, planDigest: preview.planDigest});
  }

  async previewUndo(actor, receipt = getCreationReceipt(actor)) {
    const reasons = [];
    if (!isPlainObject(receipt) || receipt.schemaVersion !== AGE_PROGRESSION_CREATION_RECEIPT_VERSION || receipt.kind !== "character.create") {
      reasons.push("invalid-receipt");
    }
    let currentDigest = null;
    let receiptMatches = false;
    try {
      const source = actorRawSource(actor);
      const embedded = embeddedReceipt(source);
      receiptMatches = Boolean(embedded && receipt && canonicalJson(embedded) === canonicalJson(receipt));
      if (!receiptMatches) reasons.push("receipt-mismatch");
      const actorId = actor.id ?? source._id;
      if (receipt?.actorUuid !== `Actor.${actorId}`) reasons.push("actor-mismatch");
      currentDigest = await digestCanonicalJson(withoutReceiptAndVolatile(source));
      if (receipt?.afterDigest !== currentDigest) reasons.push("source-changed");
    } catch (error) {
      reasons.push("source-unavailable");
    }
    return deepFreeze({
      allowed: reasons.length === 0,
      destructive: true,
      requiresConfirmation: true,
      reasons,
      expectedDigest: receipt?.afterDigest ?? null,
      currentDigest,
      receiptMatches
    });
  }

  async undo(actor, receipt = getCreationReceipt(actor), {confirmed = false} = {}) {
    if (confirmed !== true) throw creationError("Character creation undo requires explicit confirmation.", "confirmation-required");
    const preview = await this.previewUndo(actor, receipt);
    if (!preview.allowed) throw creationError(`Character creation cannot be undone safely: ${preview.reasons.join(", ")}.`, "unsafe-undo", {preview});
    const actorCollection = this.#actorCollection ?? actor?.constructor;
    if (!(actorCollection?.deleteDocuments instanceof Function)) throw creationError("Actor.deleteDocuments is unavailable.", "actor-collection");
    const actorId = actor.id ?? actor._source?._id;
    const deleted = await actorCollection.deleteDocuments([actorId]);
    return Object.freeze({deleted, actorId, receiptId: receipt.id});
  }
}
