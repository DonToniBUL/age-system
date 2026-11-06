import {canonicalClone, digestCanonicalJson} from "./canonical.js";
import {AgeProgressionDefinitionRegistry} from "./definition-registry.js";
import {
  AGE_PROGRESSION_PROFILE_IDS,
  cloneProgressionProfileAdapter,
} from "./profile-adapters.js";
import {
  AgeProgressionPreviewStore,
  validateProgressionReceiptV1,
} from "./receipts.js";
import {
  AgeProgressionCreationExecutor,
  digestCreationSource,
  getCreationReceipt,
} from "./creation-executor.js";
import {
  AgeProgressionAdvancementExecutor,
  createPersistedProgressionReceiptResolver,
  digestClassAdvancementBase,
  hydratePersistedProgressionReceipts,
} from "./advancement-executor.js";
import {AgeActorProgressionAdvancementExecutor, digestActorAdvancementBase} from "./actor-advancement-executor.js";
import {AgeProgressionAdvancementRouter} from "./advancement-router.js";
import {AgeProgressionService} from "./service.js";

export const AGE_PROGRESSION_RUNTIME_VERSION = 1;
export const AGE_PROGRESSION_SYSTEM_ID = "age-system";

const ACTIVE_PROFILE_SETTING = "activeRuleProfile";
const PRIMARY_ABILITIES_SETTING = "primaryAbl";
const CHARACTER_TYPE = "char";
const OWNER_LEVEL = 3;

function runtimeError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "AgeProgressionRuntimeError";
  error.code = code;
  error.details = Object.freeze({...details});
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

function snapshot(value) {
  return deepFreeze(canonicalClone(value));
}

function requiredText(value, label, code = "runtime-metadata") {
  if (typeof value !== "string" || !value.trim()) throw runtimeError(code, `${label} must be a non-empty string.`);
  return value;
}

function actorCollectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (collection.values instanceof Function) return [...collection.values()];
  try { return [...collection]; } catch { return []; }
}

function itemCollectionValues(actor) {
  return actorCollectionValues(actor?.items);
}

function rawSource(document) {
  if (isPlainObject(document?._source)) return document._source;
  if (document?.toObject instanceof Function) {
    const source = document.toObject(true);
    if (isPlainObject(source)) return source;
  }
  if (isPlainObject(document)) return document;
  throw runtimeError("document-source", "Foundry Document does not expose complete raw source data.");
}

function systemSource(document) {
  const source = document?._source?.system ?? document?.system;
  if (!isPlainObject(source)) throw runtimeError("document-source", "Foundry Document does not expose plain system source data.");
  return source;
}

function documentName(document) {
  return document?.documentName
    ?? document?.constructor?.documentName
    ?? document?.constructor?.metadata?.name
    ?? null;
}

function ownershipLevel(document, userId) {
  const ownership = document?._source?.ownership ?? document?.ownership;
  if (!ownership || typeof ownership !== "object") return null;
  const explicit = Number(ownership[userId]);
  if (Number.isFinite(explicit)) return explicit;
  const fallback = Number(ownership.default);
  return Number.isFinite(fallback) ? fallback : 0;
}

function canOwnDocument(document, user) {
  if (user?.isGM === true) return true;
  if (!document || !user?.id) return false;
  try {
    if (document.testUserPermission instanceof Function) return document.testUserPermission(user, "OWNER") === true;
  } catch { return false; }
  try {
    if (document.canUserModify instanceof Function) return document.canUserModify(user, "update") === true;
  } catch { return false; }
  const level = ownershipLevel(document, user.id);
  return level !== null && level >= OWNER_LEVEL;
}

function canObserveDocument(document, user, environment) {
  if (user?.isGM === true) return true;
  if (!document || !user?.id) return false;
  try {
    if (document.testUserPermission instanceof Function && document.testUserPermission(user, "OBSERVER") === true) return true;
  } catch { return false; }
  if (document.visible === true) return true;
  const level = ownershipLevel(document, user.id);
  if (level !== null) return level >= 2;
  const packId = document.pack ?? document.compendium?.collection ?? null;
  const pack = packId ? environment?.game?.packs?.get?.(packId) : null;
  try {
    if (pack?.testUserPermission instanceof Function) return pack.testUserPermission(user, "OBSERVER") === true;
  } catch { return false; }
  return pack?.visible === true;
}

function assertOwned(document, user, label) {
  if (!canOwnDocument(document, user)) throw runtimeError("permission", `User does not own ${label}.`);
  return document;
}

function assertObservable(document, user, environment, label) {
  if (!canObserveDocument(document, user, environment)) throw runtimeError("permission", `User may not access ${label}.`);
  return document;
}

function settingsApi(environment) {
  const settings = environment?.game?.settings;
  if (!(settings?.get instanceof Function)) throw runtimeError("settings-unavailable", "Foundry settings are unavailable.");
  return settings;
}

function readSetting(environment, key) {
  try {
    return settingsApi(environment).get(AGE_PROGRESSION_SYSTEM_ID, key);
  } catch (cause) {
    throw runtimeError("setting-unavailable", `Required AGE setting "${key}" is unavailable.`, {cause: String(cause?.message ?? cause)});
  }
}

function configuredRuleProfile(environment) {
  return requiredText(readSetting(environment, ACTIVE_PROFILE_SETTING), "Active AGE rule profile", "profile-unavailable");
}

function primaryAbilitySetting(environment) {
  const value = readSetting(environment, PRIMARY_ABILITIES_SETTING);
  if (typeof value !== "boolean") {
    throw runtimeError("setting-invalid", `AGE setting "${PRIMARY_ABILITIES_SETTING}" must be boolean.`);
  }
  return value;
}

function profileAvailability(environment) {
  try {
    const profileId = configuredRuleProfile(environment);
    primaryAbilitySetting(environment);
    if (!AGE_PROGRESSION_PROFILE_IDS.includes(profileId)) {
      return {profileId, available: false, reason: "profile-unsupported"};
    }
    return {profileId, available: true, reason: null};
  } catch (error) {
    return {profileId: null, available: false, reason: error?.code ?? "profile-unavailable"};
  }
}

/** Resolve the active, explicitly supported AGE rule profile. Custom is fail-closed per operation. */
export function resolveActiveRuleProfile(environment = globalThis) {
  const profileId = configuredRuleProfile(environment);
  if (!AGE_PROGRESSION_PROFILE_IDS.includes(profileId)) {
    throw runtimeError("profile-unsupported", `AGE progression does not have an adapter for active profile "${profileId}".`);
  }
  return profileId;
}

/**
 * Capture the immutable profile contract used by a preview and its executor.
 * The live primary-ability switch is included so changing it invalidates an
 * accepted preview instead of silently changing allocation rules at commit.
 */
export function adaptRuleProfile(profileId = null, {environment = globalThis} = {}) {
  const resolvedId = profileId ?? resolveActiveRuleProfile(environment);
  if (!AGE_PROGRESSION_PROFILE_IDS.includes(resolvedId)) {
    throw runtimeError("profile-unsupported", `AGE progression does not have an adapter for profile "${resolvedId}".`);
  }
  const primaryAbilityAlternation = primaryAbilitySetting(environment);
  return snapshot({
    ...cloneProgressionProfileAdapter(resolvedId),
    primaryAbilityAlternation,
  });
}

function actorDocumentClass(environment) {
  const documentClass = environment?.CONFIG?.Actor?.documentClass
    ?? environment?.game?.actors?.documentClass
    ?? environment?.Actor
    ?? null;
  if (!(documentClass?.createDocuments instanceof Function) || !(documentClass?.deleteDocuments instanceof Function)) {
    throw runtimeError("actor-collection", "Foundry Actor.createDocuments/deleteDocuments are unavailable.");
  }
  return documentClass;
}

function currentUser(environment) {
  const user = environment?.game?.user;
  if (!user || typeof user.id !== "string" || !user.id) throw runtimeError("user-unavailable", "The current Foundry user is unavailable.");
  if (user.isGM !== true && !(user.can instanceof Function)) {
    throw runtimeError("permission-api", "The current Foundry user has no verifiable permission API.");
  }
  return user;
}

function characterModel(environment) {
  const model = environment?.game?.model?.Actor?.[CHARACTER_TYPE];
  if (!isPlainObject(model)) throw runtimeError("character-model", "Foundry has no plain AGE Character data model.");
  if (!isPlainObject(model.abilities) || !isPlainObject(model.health) || !isPlainObject(model.powerPoints)) {
    throw runtimeError("character-model", "AGE Character model is incomplete for progression materialization.");
  }
  return model;
}

/** Return a complete, deterministic raw Actor source suitable for one atomic create. */
export function createBlankCharacterSource({environment = globalThis, user = currentUser(environment)} = {}) {
  const model = canonicalClone(characterModel(environment));
  const name = "New Character";
  const img = "icons/svg/mystery-man.svg";
  return snapshot({
    name,
    type: CHARACTER_TYPE,
    img,
    system: model,
    items: [],
    effects: [],
    folder: null,
    sort: 0,
    ownership: {default: 0, [user.id]: OWNER_LEVEL},
    flags: {},
    prototypeToken: {
      name,
      actorLink: true,
      texture: {src: img},
      bar1: {attribute: "health"},
      bar2: {attribute: "powerPoints"},
    },
  });
}

function uuidResolver(environment) {
  const candidates = [
    [environment, environment?.fromUuid],
    [environment?.foundry?.utils, environment?.foundry?.utils?.fromUuid],
    [environment?.foundry?.utils, environment?.foundry?.utils?.fromUuidSync],
  ].filter(([, resolver]) => resolver instanceof Function);
  if (!candidates.length) throw runtimeError("uuid-resolver", "Foundry UUID resolution is unavailable.");
  return async uuid => {
    const value = requiredText(uuid, "Document UUID", "uuid-invalid");
    for (const [owner, resolver] of candidates) {
      const document = await resolver.call(owner, value);
      if (document) return document;
    }
    return null;
  };
}

function isActor(document) {
  const name = documentName(document);
  if (name) return name === "Actor";
  return typeof document?.uuid === "string" && document.uuid.startsWith("Actor.") && typeof document?.type === "string";
}

function isItem(document) {
  const name = documentName(document);
  if (name) return name === "Item";
  return typeof (document?.type ?? document?._source?.type) === "string" && isPlainObject(document?._source?.system ?? document?.system);
}

function actorItemsGet(actor, id) {
  return actor?.items?.get?.(id) ?? itemCollectionValues(actor).find(item => String(item.id ?? item._id) === String(id)) ?? null;
}

function ownedClassBinding(preview) {
  return {
    uuid: preview?.advancementBindings?.classItemUuid
      ?? preview?.classItemUuid
      ?? preview?.receipt?.classItemUuid
      ?? null,
    id: preview?.advancementBindings?.classItemId
      ?? preview?.classItemId
      ?? preview?.receipt?.classItemId
      ?? null,
  };
}

function itemOrigins(item) {
  const source = item?._source ?? {};
  const flags = source.flags ?? item?.flags ?? {};
  return new Set([
    item?.uuid,
    flags?.core?.sourceId,
    source?._stats?.compendiumSource,
    item?._stats?.compendiumSource,
  ].filter(value => typeof value === "string" && value));
}

function explicitOwnedSourceRefIds(actor, definition) {
  const references = new Set();
  const sourceRefByUuid = new Map((definition?.sourceRefs ?? [])
    .filter(ref => typeof ref?.uuid === "string" && ref.uuid)
    .map(ref => [ref.uuid, ref.id]));
  for (const item of itemCollectionValues(actor)) {
    const source = item?._source ?? item;
    const id = source?.flags?.[AGE_PROGRESSION_SYSTEM_ID]?.progressionSourceRefId
      ?? item?.flags?.[AGE_PROGRESSION_SYSTEM_ID]?.progressionSourceRefId;
    if (typeof id === "string" && id) references.add(id);
    for (const origin of itemOrigins(item)) {
      const sourceRefId = sourceRefByUuid.get(origin);
      if (sourceRefId) references.add(sourceRefId);
    }
  }
  return [...references].sort();
}

function abilityValues(source, profile) {
  const abilities = source?.system?.abilities ?? source?.abilities;
  if (!isPlainObject(abilities)) throw runtimeError("abilities-unavailable", "Character abilities are unavailable.");
  const result = {};
  for (const abilityId of profile.ability.ids) {
    if (!isPlainObject(abilities[abilityId])) continue;
    const value = Number(abilities[abilityId].value);
    if (!Number.isFinite(value)) throw runtimeError("ability-invalid", `Ability "${abilityId}" has no finite value.`);
    result[abilityId] = value;
  }
  if (!Object.keys(result).length) throw runtimeError("abilities-unavailable", "No active-profile abilities exist on this Character.");
  return result;
}

function createDurableReceiptResolver(environment) {
  const actors = () => environment?.game?.actors;
  const advancementResolver = typeof createPersistedProgressionReceiptResolver === "function"
    ? createPersistedProgressionReceiptResolver({actors})
    : null;
  return async receiptId => {
    const id = requiredText(receiptId, "receiptId", "receipt-id");
    const matches = [];
    if (advancementResolver) {
      const advancement = await advancementResolver(id);
      if (advancement) matches.push(advancement);
    }
    for (const actor of actorCollectionValues(await actors())) {
      const receipt = getCreationReceipt(actor);
      if (receipt?.id !== id) continue;
      const validation = validateProgressionReceiptV1(receipt);
      if (!validation.valid) throw runtimeError("receipt-invalid", `Persisted creation receipt "${id}" is invalid.`);
      matches.push({receipt, context: {}});
    }
    if (matches.length > 1) throw runtimeError("receipt-duplicate", `Progression receipt id "${id}" is duplicated.`);
    return matches[0] ?? null;
  };
}

function hydrateDurableReceipts(service, environment) {
  for (const actor of actorCollectionValues(environment?.game?.actors)) {
    hydratePersistedProgressionReceipts(actor, {service, replace: true});
    const receipt = getCreationReceipt(actor);
    if (!receipt) continue;
    const validation = validateProgressionReceiptV1(receipt);
    if (!validation.valid) {
      throw runtimeError("receipt-invalid", `Persisted creation receipt "${receipt.id ?? "unknown"}" is invalid.`);
    }
    service.recordReceipt(receipt, {replace: true});
  }
}

/** Construct production resolvers without registering any game-content definition. */
export function createFoundryProgressionResolvers({environment = globalThis, registry} = {}) {
  if (!(registry?.get instanceof Function)) throw runtimeError("registry", "Progression resolver factory requires the shared DefinitionRegistry.");
  const resolveUuid = uuidResolver(environment);
  const userResolver = () => currentUser(environment);
  const profileIdResolver = () => resolveActiveRuleProfile(environment);
  const profileResolver = profileId => adaptRuleProfile(profileId, {environment});
  const blankCharacterSource = () => createBlankCharacterSource({environment, user: currentUser(environment)});

  const actorResolver = async uuid => {
    const id = requiredText(uuid, "Actor UUID", "actor-uuid");
    let actor = await resolveUuid(id);
    if (!actor && id.startsWith("Actor.")) actor = environment?.game?.actors?.get?.(id.slice(6)) ?? null;
    if (!actor || !isActor(actor) || (actor.type ?? actor._source?.type) !== CHARACTER_TYPE) {
      throw runtimeError("actor-resolution", `UUID "${id}" is not an AGE Character Actor.`);
    }
    return assertOwned(actor, currentUser(environment), `Actor "${id}"`);
  };

  const classItemResolver = async (preview, actor) => {
    const binding = ownedClassBinding(preview);
    const uuid = requiredText(binding.uuid, "Owned Class UUID", "class-uuid");
    let item = await resolveUuid(uuid);
    if (!item && binding.id && uuid === `${actor?.uuid}.Item.${binding.id}`) item = actorItemsGet(actor, binding.id);
    const parentUuid = item?.parent?.uuid ?? item?.actor?.uuid ?? (uuid.includes(".Item.") ? uuid.slice(0, uuid.lastIndexOf(".Item.")) : null);
    if (!item || !isItem(item) || (item.type ?? item._source?.type) !== "class" || parentUuid !== actor?.uuid) {
      throw runtimeError("class-resolution", `UUID "${uuid}" is not the bound owned Class Item.`);
    }
    if (binding.id && String(item.id ?? item._id) !== String(binding.id)) {
      throw runtimeError("class-resolution", "Owned Class id does not match its signed preview binding.");
    }
    return assertOwned(item, currentUser(environment), `Class Item "${uuid}"`);
  };

  const sourceUuidResolver = async uuid => {
    const id = requiredText(uuid, "Source UUID", "source-uuid");
    const item = await resolveUuid(id);
    if (!item || !isItem(item)) throw runtimeError("source-resolution", `UUID "${id}" is not an Item source.`);
    assertObservable(item, currentUser(environment), environment, `source Item "${id}"`);
    rawSource(item); // A readable live shell without stable source data is not executable.
    return item;
  };

  const resolveCreationSource = async (sourceRefId, definition) => {
    if (!definition) throw runtimeError("definition-stale", "Creation definition is no longer registered.");
    const sourceRef = definition.sourceRefs.find(ref => ref.id === sourceRefId);
    if (!sourceRef) throw runtimeError("source-ref", `SourceRef "${sourceRefId}" is not declared by the signed definition.`);
    if (!sourceRef.uuid) throw runtimeError("source-ref", `SourceRef "${sourceRefId}" has no explicit UUID.`);
    return sourceUuidResolver(sourceRef.uuid);
  };

  const creationSourceResolver = async (sourceRefId, {preview} = {}) => {
    const definition = registry.get(preview?.definitionId);
    return resolveCreationSource(sourceRefId, definition);
  };

  const creationSourceSnapshotResolver = async (sourceRefId, {definition, preview} = {}) => {
    const currentDefinition = definition ?? registry.get(preview?.definitionId);
    const source = await resolveCreationSource(sourceRefId, currentDefinition);
    return digestCreationSource(source, `sourceRef "${sourceRefId}"`);
  };

  const abilityEligibilityResolver = ({actor, classSystem, targetLevel, profileSnapshot}) => {
    const profile = profileSnapshot ?? profileResolver(resolveActiveRuleProfile(environment));
    const all = profile.ability.ids.filter(id => isPlainObject(systemSource(actor).abilities?.[id]));
    if (!all.length) throw runtimeError("abilities-unavailable", "Character has no abilities eligible under the active profile.");
    if (profile.primaryAbilityAlternation === true) {
      const primary = [...new Set((classSystem?.primaryAbl ?? []).map(String))].filter(id => all.includes(id));
      const primarySet = new Set(primary);
      const secondary = all.filter(id => !primarySet.has(id));
      const eligible = Number(targetLevel) % 2 === 0 ? primary : secondary;
      if (!eligible.length) throw runtimeError("ability-eligibility", "Class/profile primary-ability policy produced no legal allocation target.");
      return Object.freeze(eligible);
    }
    const transactions = systemSource(actor).classProgression?.transactions;
    const previous = Array.isArray(transactions) ? transactions.at(-1)?.choices?.ability : null;
    const used = new Set(isPlainObject(previous)
      ? Object.entries(previous).filter(([, amount]) => Number(amount) > 0).map(([id]) => id)
      : []);
    const remaining = all.filter(id => !used.has(id));
    return Object.freeze(remaining.length ? remaining : all);
  };

  const baseDigestResolver = async ({trigger, actor, definition}) => {
    if (trigger === "character.create") return digestCanonicalJson(await blankCharacterSource());
    if (trigger === "rank.advance") {
      if (!actor) throw runtimeError("actor-resolution", "Advancement base digest requires an Actor.");
      return definition?.trackBinding?.kind === "actor"
        ? digestActorAdvancementBase(actor)
        : digestClassAdvancementBase(actor);
    }
    throw runtimeError("trigger", `Unsupported progression trigger "${trigger}".`);
  };

  const contextResolver = async ({trigger, actor, definition}) => {
    const profile = profileResolver(definition?.profileId ?? resolveActiveRuleProfile(environment));
    const source = trigger === "character.create" ? await blankCharacterSource() : rawSource(actor);
    return snapshot({
      abilities: abilityValues(source, profile),
      ownedSourceRefIds: trigger === "character.create" ? [] : explicitOwnedSourceRefIds(actor, definition),
    });
  };

  return Object.freeze({
    userResolver,
    profileIdResolver,
    profileResolver,
    blankCharacterSource,
    actorResolver,
    classItemResolver,
    sourceUuidResolver,
    creationSourceResolver,
    creationSourceSnapshotResolver,
    abilityEligibilityResolver,
    baseDigestResolver,
    contextResolver,
    receiptResolver: createDurableReceiptResolver(environment),
  });
}

/** One fail-closed service graph per Foundry client runtime. */
export class AgeProgressionRuntime {
  #environment;
  #options;
  #state = "uninitialized";
  #error = null;
  #activeProfileId = null;
  #registry = null;
  #previewStore = null;
  #creationExecutor = null;
  #advancementExecutor = null;
  #service = null;
  #resolvers = null;

  constructor({environment = globalThis, clock = () => Date.now(), randomId = null, previewTtlMs} = {}) {
    this.#environment = environment;
    this.#options = {clock, randomId, previewTtlMs};
  }

  get service() { return this.#service; }
  get registry() { return this.#registry; }
  get previewStore() { return this.#previewStore; }
  get creationExecutor() { return this.#creationExecutor; }
  get advancementExecutor() { return this.#advancementExecutor; }
  get resolvers() { return this.#resolvers; }

  initialize() {
    if (this.#state === "ready") return this.#service;
    this.#state = "initializing";
    this.#error = null;
    try {
      const environment = this.#environment;
      const game = environment?.game;
      // Progression initializes during Foundry setup, after the current User
      // and world Actor collection exist. Keep this boundary fail-closed so a
      // lifecycle regression cannot create a partially usable service graph.
      if (!game || !game.actors) {
        throw runtimeError("game-unavailable", "Foundry game/Actor collection is unavailable.");
      }
      currentUser(environment);
      const activeProfileId = configuredRuleProfile(environment);
      primaryAbilitySetting(environment);
      if (AGE_PROGRESSION_PROFILE_IDS.includes(activeProfileId)) adaptRuleProfile(activeProfileId, {environment});
      characterModel(environment);
      const actorCollection = actorDocumentClass(environment);
      uuidResolver(environment);

      const rawId = this.#options.randomId ?? (() => {
        const value = environment?.foundry?.utils?.randomID?.(16)
          ?? environment?.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 16);
        if (!value) throw runtimeError("id-factory", "Foundry has no secure random id factory.");
        return value;
      });
      const documentIdFactory = () => requiredText(rawId(), "Foundry document id", "id-factory");
      const serviceIdFactory = prefix => `${prefix}:${documentIdFactory()}`;
      const registry = new AgeProgressionDefinitionRegistry({profiles: AGE_PROGRESSION_PROFILE_IDS});
      const previewStoreOptions = {now: this.#options.clock};
      if (this.#options.previewTtlMs !== undefined) previewStoreOptions.ttlMs = this.#options.previewTtlMs;
      const previewStore = new AgeProgressionPreviewStore(previewStoreOptions);
      const resolvers = createFoundryProgressionResolvers({environment, registry});
      const creationExecutor = new AgeProgressionCreationExecutor({
        baseActorData: resolvers.blankCharacterSource,
        sourceResolver: resolvers.creationSourceResolver,
        idFactory: documentIdFactory,
        clock: this.#options.clock,
        actorCollection,
      });
      const classAdvancementExecutor = new AgeProgressionAdvancementExecutor({
        profileResolver: resolvers.profileResolver,
        profileIdResolver: resolvers.profileIdResolver,
        sourceResolver: resolvers.sourceUuidResolver,
        abilityEligibilityResolver: resolvers.abilityEligibilityResolver,
        previewStore,
        clock: this.#options.clock,
        idFactory: serviceIdFactory,
      });
      const actorAdvancementExecutor = new AgeActorProgressionAdvancementExecutor({
        profileResolver: resolvers.profileResolver,
        profileIdResolver: resolvers.profileIdResolver,
        sourceResolver: resolvers.sourceUuidResolver,
        previewStore,
        clock: this.#options.clock,
        idFactory: serviceIdFactory,
      });
      const advancementExecutor = new AgeProgressionAdvancementRouter({
        classExecutor: classAdvancementExecutor,
        actorExecutor: actorAdvancementExecutor,
      });
      const serviceOptions = {
        registry,
        previewStore,
        creationExecutor,
        advancementExecutor,
        clock: this.#options.clock,
        idFactory: serviceIdFactory,
        userResolver: resolvers.userResolver,
        actorResolver: resolvers.actorResolver,
        classItemResolver: resolvers.classItemResolver,
        profileIdResolver: resolvers.profileIdResolver,
        profileSnapshotResolver: resolvers.profileResolver,
        baseDigestResolver: resolvers.baseDigestResolver,
        contextResolver: resolvers.contextResolver,
        sourceSnapshotResolver: resolvers.creationSourceSnapshotResolver,
        receiptResolver: resolvers.receiptResolver,
        actorCollection,
      };
      if (this.#options.previewTtlMs !== undefined) serviceOptions.previewTtlMs = this.#options.previewTtlMs;
      const service = new AgeProgressionService(serviceOptions);
      hydrateDurableReceipts(service, environment);

      this.#activeProfileId = activeProfileId;
      this.#registry = registry;
      this.#previewStore = previewStore;
      this.#creationExecutor = creationExecutor;
      this.#advancementExecutor = advancementExecutor;
      this.#resolvers = resolvers;
      this.#service = service;
      this.#state = "ready";
      return service;
    } catch (error) {
      this.#registry = null;
      this.#previewStore = null;
      this.#creationExecutor = null;
      this.#advancementExecutor = null;
      this.#resolvers = null;
      this.#service = null;
      this.#activeProfileId = null;
      this.#state = "failed";
      this.#error = error;
      throw error;
    }
  }

  status() {
    const availability = profileAvailability(this.#environment);
    const runtimeReady = this.#state === "ready" && Boolean(this.#service);
    const progressionAvailable = runtimeReady && availability.available;
    const progressionUnavailableReason = progressionAvailable
      ? null
      : runtimeReady
        ? availability.reason
        : this.#error?.code ?? (this.#state === "uninitialized" ? "runtime-uninitialized" : "runtime-unavailable");
    return snapshot({
      runtimeVersion: AGE_PROGRESSION_RUNTIME_VERSION,
      state: this.#state,
      initialized: this.#state === "ready",
      ready: runtimeReady,
      activeProfileId: availability.profileId ?? this.#activeProfileId,
      progressionAvailable,
      progressionUnavailableReason,
      definitions: this.#registry?.definitions?.().length ?? 0,
      service: this.#service?.status?.() ?? null,
      dependencies: {
        definitionRegistry: Boolean(this.#registry),
        previewStore: Boolean(this.#previewStore),
        creationExecutor: Boolean(this.#creationExecutor),
        advancementExecutor: Boolean(this.#advancementExecutor),
        receiptResolver: Boolean(this.#resolvers?.receiptResolver),
      },
      error: this.#error ? {
        name: this.#error.name ?? "Error",
        code: this.#error.code ?? "runtime",
        message: this.#error.message ?? String(this.#error),
      } : null,
    });
  }
}

export const ageProgressionRuntime = new AgeProgressionRuntime();
export const progressionRuntime = ageProgressionRuntime;
export let ageProgressionService = null;
export let progressionService = null;

export function initializeAgeProgressionRuntime() {
  const service = ageProgressionRuntime.initialize();
  ageProgressionService = service;
  progressionService = service;
  return service;
}

export const initializeProgressionRuntime = initializeAgeProgressionRuntime;

export function progressionRuntimeStatus() {
  return ageProgressionRuntime.status();
}
