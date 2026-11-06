import {
  AGE_PROGRESSION_LATEST_DEFINITION_VERSION,
  AGE_PROGRESSION_SUPPORTED_DEFINITION_VERSIONS,
  AGE_PROGRESSION_TRIGGERS,
  validateProgressionDefinition,
} from "./contracts.js";
import {canonicalClone, canonicalJson, definitionDigest, digestCanonicalJson} from "./canonical.js";
import {compileProgressionPreviewV1, AGE_PROGRESSION_PREVIEW_VERSION} from "./compiler.js";
import {AgeProgressionDefinitionRegistry} from "./definition-registry.js";
import {validateProgressionDefinitionExecutabilityV1} from "./executability.js";
import {
  AGE_PROGRESSION_RECEIPT_VERSION,
  AgeProgressionPreviewStore,
  assertProgressionReceiptV1,
  markProgressionReceiptUndone,
} from "./receipts.js";

export const AGE_PROGRESSION_SERVICE_VERSION = 1;
export const AGE_PROGRESSION_PROVIDER_KINDS = Object.freeze([
  "system",
  "module",
  "world",
  "compendium",
  "import",
  "legacy-class",
]);

const PROVIDER_KINDS = new Set(AGE_PROGRESSION_PROVIDER_KINDS);
const RECEIPT_KINDS = new Set(["character.create", "rank.advance"]);
const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;

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

function errorDetails(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(errorDetails);
  if (!isPlainObject(value)) return String(value);
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => [key, errorDetails(entry)]));
}

function serviceError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "AgeProgressionServiceError";
  error.code = code;
  error.details = snapshot(errorDetails(details));
  return error;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw serviceError("metadata", `${label} must be a non-empty string.`);
  return value;
}

function timestamp(value) {
  const number = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(number) || number < 0) throw serviceError("clock", "Progression service clock returned an invalid timestamp.");
  return number;
}

function defaultIdFactory(prefix) {
  const value = globalThis.foundry?.utils?.randomID?.(16)
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${value}`;
}

function defaultUserResolver() {
  return globalThis.game?.user ?? null;
}

async function defaultActorResolver(uuid) {
  if (globalThis.fromUuid instanceof Function) return globalThis.fromUuid(uuid);
  if (uuid?.startsWith("Actor.")) return globalThis.game?.actors?.get?.(uuid.slice(6)) ?? null;
  return null;
}

async function defaultClassItemResolver(preview, actor) {
  const uuid = preview?.advancementBindings?.classItemUuid ?? preview?.classItemUuid ?? null;
  if (uuid && globalThis.fromUuid instanceof Function) return globalThis.fromUuid(uuid);
  const id = preview?.advancementBindings?.classItemId ?? null;
  return id ? actor?.items?.get?.(id) ?? null : null;
}

function actorUuid(actor) {
  if (typeof actor?.uuid === "string" && actor.uuid) return actor.uuid;
  if (typeof actor?.id === "string" && actor.id) return `Actor.${actor.id}`;
  if (typeof actor?._id === "string" && actor._id) return `Actor.${actor._id}`;
  throw serviceError("actor-binding", "A progression Actor must expose a stable UUID or id.");
}

function canOwn(user, actor) {
  if (!user || !actor) return false;
  if (user.isGM === true) return true;
  try {
    if (actor.testUserPermission?.(user, "OWNER") === true) return true;
  } catch { /* A malformed permission implementation must fail closed. */ }
  return actor.isOwner === true && globalThis.game?.user?.id === user.id;
}

function normalizeProvider(provider) {
  const value = typeof provider === "string" ? {kind: provider, id: provider} : provider;
  if (!isPlainObject(value)) throw serviceError("provider", "Progression provider metadata must be a plain object.");
  const allowed = new Set(["kind", "id", "label", "containerUuid"]);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw serviceError("provider", `Unknown progression provider field(s): ${unknown.join(", ")}.`, {unknown});
  if (!PROVIDER_KINDS.has(value.kind)) throw serviceError("provider", `Unsupported progression provider kind "${value.kind}".`);
  const normalized = {kind: value.kind, id: requiredText(value.id, "provider.id")};
  if (value.label !== undefined) normalized.label = requiredText(value.label, "provider.label");
  if (value.containerUuid !== undefined) normalized.containerUuid = requiredText(value.containerUuid, "provider.containerUuid");
  return snapshot(normalized);
}

function receiptFromResult(result) {
  if (isPlainObject(result?.receipt)) return result.receipt;
  if (isPlainObject(result) && result.schemaVersion === AGE_PROGRESSION_RECEIPT_VERSION) return result;
  throw serviceError("receipt", "Progression executor did not return a ReceiptV1.");
}

function publicCommitResult(result, receipt) {
  if (isPlainObject(result) && result.schemaVersion === AGE_PROGRESSION_RECEIPT_VERSION) return receipt;
  if (result && typeof result === "object") return Object.freeze({...result, actorUuid: result.actorUuid ?? receipt.actorUuid, receipt});
  return Object.freeze({result, actorUuid: receipt.actorUuid, receipt});
}

/**
 * Provider-neutral orchestration for DefinitionV1 registration, immutable
 * previews, domain executor dispatch, receipts, and targeted reversal.
 *
 * Provider/container metadata never enters DefinitionV1 and therefore never
 * changes its canonical digest or execution semantics.  Commit methods accept
 * only previewId + planDigest; all authority and live Documents are resolved
 * from injected server-side collaborators.
 */
export class AgeProgressionService {
  #registry;
  #previewStore;
  #compiler;
  #creationExecutor;
  #advancementExecutor;
  #clock;
  #idFactory;
  #previewTtlMs;
  #userResolver;
  #actorResolver;
  #classItemResolver;
  #profileIdResolver;
  #profileSnapshotResolver;
  #baseDigestResolver;
  #contextResolver;
  #sourceSnapshotResolver;
  #receiptResolver;
  #actorCollection;
  #providers = new Map();
  #definitionChangeListeners = new Set();
  #receipts = new Map();
  #receiptContexts = new Map();
  #previewIds = new Set();

  constructor({
    registry = new AgeProgressionDefinitionRegistry(),
    previewStore = new AgeProgressionPreviewStore(),
    compiler = compileProgressionPreviewV1,
    creationExecutor = null,
    advancementExecutor = null,
    clock = () => Date.now(),
    idFactory = defaultIdFactory,
    previewTtlMs = DEFAULT_PREVIEW_TTL_MS,
    userResolver = defaultUserResolver,
    actorResolver = defaultActorResolver,
    classItemResolver = defaultClassItemResolver,
    profileIdResolver = null,
    profileSnapshotResolver = null,
    baseDigestResolver = null,
    contextResolver = null,
    sourceSnapshotResolver = null,
    receiptResolver = null,
    actorCollection = null,
  } = {}) {
    if (!(registry?.register instanceof Function) || !(registry?.definitions instanceof Function)) {
      throw serviceError("registry", "Progression service requires a compatible definition registry.");
    }
    if (!(previewStore?.put instanceof Function) || !(previewStore?.reserve instanceof Function)) {
      throw serviceError("preview-store", "Progression service requires a compatible preview store.");
    }
    if (!(compiler instanceof Function)) throw serviceError("compiler", "Progression service requires a preview compiler.");
    if (!Number.isFinite(Number(previewTtlMs)) || Number(previewTtlMs) <= 0) throw serviceError("preview-ttl", "previewTtlMs must be positive.");
    this.#registry = registry;
    this.#previewStore = previewStore;
    this.#compiler = compiler;
    this.#creationExecutor = creationExecutor;
    this.#advancementExecutor = advancementExecutor;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#previewTtlMs = Number(previewTtlMs);
    this.#userResolver = userResolver;
    this.#actorResolver = actorResolver;
    this.#classItemResolver = classItemResolver;
    this.#profileIdResolver = profileIdResolver;
    this.#profileSnapshotResolver = profileSnapshotResolver;
    this.#baseDigestResolver = baseDigestResolver;
    this.#contextResolver = contextResolver;
    this.#sourceSnapshotResolver = sourceSnapshotResolver;
    this.#receiptResolver = receiptResolver;
    this.#actorCollection = actorCollection;
  }

  get registry() {
    return this.#registry;
  }

  get previewStore() {
    return this.#previewStore;
  }

  validateDefinition(definition) {
    return validateProgressionDefinition(definition);
  }

  /**
   * Additive runtime-compatibility validation. Generic DefinitionV1
   * registration intentionally continues to use validateDefinition().
   */
  validateExecutability(definition, options = {}) {
    return validateProgressionDefinitionExecutabilityV1(definition, options);
  }

  registerDefinition(definition, {provider = {kind: "world", id: "world"}, replace = false} = {}) {
    const provenance = normalizeProvider(provider);
    const registered = this.#registry.register(definition, {replace});
    this.#providers.set(registered.id, provenance);
    this.#emitDefinitionChange({
      type: "register",
      definitionId: registered.id,
      definition: registered,
      provider: provenance,
      replace: replace === true,
    });
    return registered;
  }

  register(definition, options = {}) {
    return this.registerDefinition(definition, options);
  }

  unregisterDefinition(definitionId) {
    const id = requiredText(definitionId, "definitionId");
    const definition = this.#registry.get(id);
    const provider = this.#providers.get(id) ?? null;
    const removed = this.#registry.unregister(id);
    if (removed) {
      this.#providers.delete(id);
      this.#emitDefinitionChange({type: "unregister", definitionId: id, definition, provider, replace: false});
    }
    return removed;
  }

  unregister(definitionId) {
    return this.unregisterDefinition(definitionId);
  }

  /**
   * Subscribe to successful registry changes without exposing mutable
   * registry internals. Core persistence providers use this signal to
   * reconcile dormant world/compendium definitions when an external module
   * unregisters or deliberately replaces an active definition.
   */
  subscribeDefinitionChanges(listener) {
    if (!(listener instanceof Function)) throw serviceError("definition-listener", "Progression definition listener must be a function.");
    this.#definitionChangeListeners.add(listener);
    return () => this.#definitionChangeListeners.delete(listener);
  }

  getDefinition(definitionId) {
    return this.#registry.get(requiredText(definitionId, "definitionId"));
  }

  get(definitionId) {
    return this.getDefinition(definitionId);
  }

  listDefinitions(filters = {}) {
    return this.#registry.definitions(filters);
  }

  definitions(filters = {}) {
    return this.listDefinitions(filters);
  }

  provider(definitionId) {
    return this.#providers.get(requiredText(definitionId, "definitionId")) ?? null;
  }

  async definitionRecord(definitionId) {
    const definition = this.getDefinition(definitionId);
    if (!definition) return null;
    return deepFreeze({
      definition,
      digest: await definitionDigest(definition),
      provider: this.provider(definitionId),
    });
  }

  #emitDefinitionChange(event) {
    const notification = deepFreeze({...event});
    for (const listener of [...this.#definitionChangeListeners]) {
      // Registry changes must remain authoritative even if an optional
      // observer has already been torn down or contains a local bug.
      try { listener(notification); }
      catch (error) {
        console.error("AGE System | Progression definition change listener failed.", error);
      }
    }
  }

  async previewCreation(options = {}) {
    const definition = this.#requireExecutableDefinition("character.create", options);
    return this.#preview("character.create", null, options, definition);
  }

  async previewAdvancement(options = {}) {
    const definition = this.#requireExecutableDefinition("rank.advance", options);
    const actor = options.actor ?? await this.#resolveActor(options.actorUuid);
    const user = await this.#currentUser();
    if (!canOwn(user, actor)) throw serviceError("permission", "User does not own the progression Actor.");
    return this.#preview("rank.advance", actor, {...options, user}, definition);
  }

  async commitCreation(previewId, planDigest) {
    if (!(this.#creationExecutor?.commit instanceof Function)) throw serviceError("executor", "Character creation executor is unavailable.");
    const user = await this.#currentUser();
    return this.#commit({
      kind: "character.create",
      previewId,
      planDigest,
      user,
      dispatch: async ({preview}) => this.#creationExecutor.commit({
        preview,
        actorCollection: this.#actorCollection,
        user,
      }),
    });
  }

  async commitAdvancement(previewId, planDigest) {
    if (!this.#advancementExecutor) throw serviceError("executor", "Advancement executor is unavailable.");
    const user = await this.#currentUser();
    const preview = this.#previewStore.get(previewId, {planDigest, userId: user.id});
    const actor = await this.#resolveActor(preview.actorUuid);
    if (!canOwn(user, actor)) throw serviceError("permission", "User does not own the progression Actor.");
    const execution = preview?.advancementBindings?.execution;
    const classItem = execution === "class-transaction-v1"
      ? await this.#classItemResolver?.(preview, actor) ?? null
      : null;
    const receiptContext = execution === "actor-transaction-v1"
      ? {execution, trackId: preview.advancementBindings?.trackBinding?.trackId ?? null}
      : classItem ? {
        execution: "class-transaction-v1",
        classItemUuid: classItem.uuid ?? null,
        classItemId: classItem.id ?? classItem._id ?? null,
      } : {};
    return this.#commit({
      kind: "rank.advance",
      previewId,
      planDigest,
      user,
      actor,
      receiptContext,
      dispatch: async ({preview: stored, reservation}) => {
        if (this.#advancementExecutor.commitPreview instanceof Function) {
          return this.#advancementExecutor.commitPreview({
            preview: stored,
            actor,
            classItem,
            user,
            planDigest,
            reservation,
          });
        }
        if (this.#advancementExecutor.commit instanceof Function) {
          return this.#advancementExecutor.commit({preview: stored, actor, classItem, user, previewId, planDigest});
        }
        throw serviceError("executor", "Advancement executor has no commit method.");
      },
    });
  }

  getReceipt(receiptId) {
    return this.#receipts.get(requiredText(receiptId, "receiptId")) ?? null;
  }

  async lookupReceipt(receiptId) {
    return this.#lookupReceipt(receiptId);
  }

  /** Hydrate a validated receipt recovered from its owning Actor/Class flags. */
  recordReceipt(receipt, {replace = false, context = {}} = {}) {
    assertProgressionReceiptV1(receipt);
    const existing = this.#receipts.get(receipt.id);
    if (existing && !replace) throw serviceError("receipt-duplicate", `Receipt "${receipt.id}" already exists.`);
    if (existing) {
      const immutableFields = [
        "schemaVersion", "id", "kind", "previewId", "planDigest", "definitionId",
        "definitionVersion", "definitionDigest", "profileId", "actorUuid", "transactionId",
        "beforeDigest", "afterDigest", "createdAt", "committedAt", "committedBy", "reversible",
      ];
      if (immutableFields.some(field => existing[field] !== receipt[field])) {
        throw serviceError("receipt-binding", "A persisted receipt cannot change immutable transaction bindings.");
      }
      if (existing.state === "undone" && receipt.state !== "undone") {
        throw serviceError("receipt-state", "An undone receipt cannot return to committed state.");
      }
    }
    const stored = snapshot(receipt);
    this.#receipts.set(stored.id, stored);
    if (isPlainObject(context) && Object.keys(context).length) this.#receiptContexts.set(stored.id, snapshot(context));
    return stored;
  }

  forgetReceipt(receiptId) {
    const id = requiredText(receiptId, "receiptId");
    this.#receiptContexts.delete(id);
    return this.#receipts.delete(id);
  }

  receipts({actorUuid: boundActor = null, kind = null, state = null} = {}) {
    return Object.freeze([...this.#receipts.values()]
      .filter(receipt => !boundActor || receipt.actorUuid === boundActor)
      .filter(receipt => !kind || receipt.kind === kind)
      .filter(receipt => !state || receipt.state === state)
      .sort((left, right) => left.committedAt - right.committedAt || left.id.localeCompare(right.id)));
  }

  async previewUndo(receiptId) {
    const {receipt, actor, classItem, user, receiptContext} = await this.#undoContext(receiptId);
    if (receipt.kind === "character.create") {
      if (!(this.#creationExecutor?.previewUndo instanceof Function)) throw serviceError("executor", "Character creation undo is unavailable.");
      return this.#creationExecutor.previewUndo(actor, receipt);
    }
    if (!(this.#advancementExecutor?.previewUndo instanceof Function)) throw serviceError("executor", "Advancement undo is unavailable.");
    return this.#advancementExecutor.previewUndo({actor, classItem, user, receipt, receiptContext});
  }

  async undo(receiptId, {confirmed = false, undoPreviewId = null, undoDigest = null} = {}) {
    if (confirmed !== true) throw serviceError("confirmation-required", "Progression undo requires explicit confirmation.");
    const {receipt, actor, classItem, user, receiptContext} = await this.#undoContext(receiptId);
    let result;
    if (receipt.kind === "character.create") {
      if (!(this.#creationExecutor?.undo instanceof Function)) throw serviceError("executor", "Character creation undo is unavailable.");
      result = await this.#creationExecutor.undo(actor, receipt, {confirmed: true});
    } else {
      if (!(this.#advancementExecutor?.undo instanceof Function)) throw serviceError("executor", "Advancement undo is unavailable.");
      result = await this.#advancementExecutor.undo({
        actor,
        classItem,
        user,
        receipt,
        receiptContext,
        undoPreviewId,
        undoDigest,
      });
    }
    const undone = receipt.kind === "character.create"
      ? markProgressionReceiptUndone(receipt, {now: timestamp(this.#clock())})
      : receiptFromResult(result);
    if (undone.id !== receipt.id || undone.state !== "undone") throw serviceError("receipt", "Undo returned an unrelated or active receipt.");
    this.#receipts.set(undone.id, snapshot(undone));
    return publicCommitResult(result, this.#receipts.get(undone.id));
  }

  capabilities() {
    const definitionCapabilities = [...new Set(this.listDefinitions().flatMap(definition => definition.capabilities))].sort();
    return snapshot({
      serviceVersion: AGE_PROGRESSION_SERVICE_VERSION,
      definitionVersion: AGE_PROGRESSION_LATEST_DEFINITION_VERSION,
      definitionVersions: AGE_PROGRESSION_SUPPORTED_DEFINITION_VERSIONS,
      previewVersion: AGE_PROGRESSION_PREVIEW_VERSION,
      receiptVersion: AGE_PROGRESSION_RECEIPT_VERSION,
      providerNeutral: true,
      providers: AGE_PROGRESSION_PROVIDER_KINDS,
      triggers: AGE_PROGRESSION_TRIGGERS,
      definitionCapabilities,
      operations: {
        definitionRegistration: true,
        executabilityValidation: true,
        creationPreview: true,
        advancementPreview: true,
        creationCommit: Boolean(this.#creationExecutor?.commit),
        advancementCommit: Boolean(this.#advancementExecutor?.commitPreview || this.#advancementExecutor?.commit),
        targetedUndo: Boolean(this.#creationExecutor?.undo || this.#advancementExecutor?.undo),
        receiptHydration: true,
      },
      genericActionTransactionLifecycle: false,
      contentModuleRequired: false,
    });
  }

  status() {
    const previews = {ready: 0, pending: 0, consumed: 0, expired: 0, missing: 0};
    for (const id of this.#previewIds) previews[this.#previewStore.status(id)] += 1;
    return snapshot({
      serviceVersion: AGE_PROGRESSION_SERVICE_VERSION,
      definitions: this.listDefinitions().length,
      providers: Object.fromEntries(AGE_PROGRESSION_PROVIDER_KINDS.map(kind => [kind, [...this.#providers.values()].filter(provider => provider.kind === kind).length])),
      previews,
      receipts: {
        total: this.#receipts.size,
        committed: [...this.#receipts.values()].filter(receipt => receipt.state === "committed").length,
        undone: [...this.#receipts.values()].filter(receipt => receipt.state === "undone").length,
      },
      executors: {
        creation: Boolean(this.#creationExecutor),
        advancement: Boolean(this.#advancementExecutor),
      },
      receiptResolver: Boolean(this.#receiptResolver),
    });
  }

  #requireExecutableDefinition(trigger, options) {
    if (!isPlainObject(options)) throw serviceError("preview-options", "Progression preview options must be a plain object.");
    const definition = this.getDefinition(requiredText(options.definitionId, "definitionId"));
    if (!definition) throw serviceError("definition-missing", `Progression definition "${options.definitionId}" is not registered.`);
    const validation = this.validateExecutability(definition, {trigger});
    if (!validation.valid) {
      throw serviceError(
        "definition-not-executable",
        `Progression definition "${definition.id}" cannot execute ${trigger}.`,
        {trigger, issues: validation.issues, checkedExecutors: validation.checkedExecutors},
      );
    }
    return definition;
  }

  async #preview(trigger, actor, options, definition) {
    const user = options.user ?? await this.#currentUser();
    const actualActorUuid = trigger === "rank.advance" ? actorUuid(actor) : null;
    const resolvedProfile = await this.#resolveProfileId(actor, definition, options.profileId);
    const profileSnapshot = await this.#resolveProfileSnapshot(actor, definition, resolvedProfile);
    const baseDigest = options.baseDigest ?? await this.#resolveBaseDigest({trigger, actor, definition, options});
    const context = options.context ?? await this.#resolveContext({trigger, actor, definition, options});
    const now = timestamp(this.#clock());
    const previewId = options.previewId ?? await this.#idFactory("age-progression-preview", {trigger, actorUuid: actualActorUuid, definitionId: definition.id});
    const formulaResolver = trigger === "rank.advance"
      && options.prepareExecutor === true
      && this.#advancementExecutor?.prepareFormulaResolver instanceof Function
      ? this.#advancementExecutor.prepareFormulaResolver(definition, options.resolveFormula)
      : options.resolveFormula;
    const preview = await this.#compiler(definition, {
      trigger,
      rank: options.rank,
      choices: options.choices ?? {},
      abilityAllocations: trigger === "character.create" ? options.abilityAllocations : undefined,
      semanticInputs: trigger === "character.create" ? options.semanticInputs : undefined,
      context: context ?? {},
      resolveFormula: formulaResolver,
      resolveSourceSnapshot: trigger === "character.create"
        ? (sourceRefId, metadata) => this.#resolveSourceSnapshot(sourceRefId, {
          phase: "preview",
          definition,
          sourceRef: metadata.sourceRef,
          user,
        })
        : undefined,
      profileSnapshot,
      previewId: requiredText(previewId, "previewId"),
      baseDigest,
      createdAt: options.createdAt ?? new Date(now).toISOString(),
      expiresAt: options.expiresAt ?? new Date(now + this.#previewTtlMs).toISOString(),
      userId: user.id,
      actorUuid: actualActorUuid,
    });
    if (preview.profileId !== resolvedProfile) throw serviceError("profile-binding", "Compiled preview does not match the active rules profile.");

    let storedPreview = preview;
    // Class-backed execution preparation is explicit: the selected owned
    // Class is the transaction track, while the registered DefinitionV1 is
    // the sole source of progression semantics. Provider provenance is never
    // consulted here (legacy Class-v3 is just one definition provider).
    if (trigger === "rank.advance" && this.#advancementExecutor?.acceptPreview instanceof Function && options.prepareExecutor === true) {
      storedPreview = await this.#advancementExecutor.acceptPreview({
        preview,
        definition,
        actor,
        classItem: options.classItem ?? null,
        profileId: resolvedProfile,
        profileSnapshot,
        abilityAllocations: options.abilityAllocations ?? {},
        progressionTargets: options.progressionTargets ?? {},
        user,
      }) ?? preview;
    }
    try {
      await this.#assertPreparedPreview(storedPreview, preview);
    } catch (error) {
      if (storedPreview?.previewId) this.#previewStore.delete?.(storedPreview.previewId);
      throw error;
    }
    if (this.#previewStore.status(storedPreview.previewId) === "missing") this.#previewStore.put(storedPreview);
    this.#previewIds.add(storedPreview.previewId);
    return storedPreview;
  }

  async #commit({kind, previewId, planDigest, user, actor = null, receiptContext = {}, dispatch}) {
    requiredText(previewId, "previewId");
    requiredText(planDigest, "planDigest");
    const expectedActorUuid = actor ? actorUuid(actor) : null;
    const reservation = this.#previewStore.reserve(previewId, {
      planDigest,
      userId: user.id,
      actorUuid: expectedActorUuid,
    });
    let succeeded = false;
    try {
      const {preview} = reservation;
      if (preview.trigger !== kind) throw serviceError("preview-kind", `Preview is ${preview.trigger}, not ${kind}.`);
      await this.#assertDefinitionCurrent(preview);
      await this.#assertBaseCurrent(preview, actor);
      await this.#assertCreationSourcesCurrent(preview, user);
      // Profile configuration is the last server-side read before executor
      // dispatch. Creation sources are independently re-digested by the
      // materializer, while legacy advancement rechecks the profile again.
      await this.#assertProfileCurrent(preview, actor);
      const result = await dispatch({preview, reservation: Object.freeze({previewId, token: reservation.token})});
      const receipt = snapshot(receiptFromResult(result));
      this.#assertReceiptBinding(receipt, preview, user, actor);
      this.#receipts.set(receipt.id, receipt);
      if (isPlainObject(receiptContext) && Object.keys(receiptContext).length) this.#receiptContexts.set(receipt.id, snapshot(receiptContext));
      this.#previewStore.complete(previewId, reservation.token);
      succeeded = true;
      return publicCommitResult(result, receipt);
    } finally {
      if (!succeeded) this.#previewStore.release(previewId, reservation.token);
    }
  }

  async #assertDefinitionCurrent(preview) {
    const definition = this.getDefinition(preview.definitionId);
    if (!definition) throw serviceError("definition-stale", "Progression definition was unregistered after preview.");
    const digest = await definitionDigest(definition);
    if (definition.version !== preview.definitionVersion || digest !== preview.definitionDigest) {
      throw serviceError("definition-stale", "Progression definition changed after preview.", {currentVersion: definition.version, currentDigest: digest});
    }
  }

  async #assertPreparedPreview(prepared, original) {
    if (!isPlainObject(prepared)) throw serviceError("preview-invalid", "Progression preview preparation did not return a plain PreviewV1.");
    for (const field of [
      "schemaVersion", "previewId", "definitionId", "definitionVersion", "definitionDigest",
      "profileId", "profileDigest", "milestoneId", "trigger", "rank", "baseDigest", "createdAt", "expiresAt",
      "userId", "actorUuid",
    ]) {
      if (prepared[field] !== original[field]) throw serviceError("preview-binding", `Prepared preview changed signed field "${field}".`);
    }
    if (canonicalJson(prepared.sourceSnapshots ?? []) !== canonicalJson(original.sourceSnapshots ?? [])) {
      throw serviceError("preview-binding", "Prepared preview changed signed source snapshots.");
    }
    const originalBody = canonicalClone(original);
    delete originalBody.planDigest;
    const preparedOriginalBody = canonicalClone(prepared);
    delete preparedOriginalBody.planDigest;
    delete preparedOriginalBody.advancementBindings;
    if (canonicalJson(preparedOriginalBody) !== canonicalJson(originalBody)) {
      throw serviceError("preview-binding", "Prepared preview changed the compiler-owned immutable plan.");
    }
    const body = canonicalClone(prepared);
    const planDigest = body.planDigest;
    delete body.planDigest;
    if (typeof planDigest !== "string" || await digestCanonicalJson(body) !== planDigest) {
      throw serviceError("preview-digest", "Prepared preview planDigest does not match its immutable body.");
    }
  }

  async #assertProfileCurrent(preview, actor) {
    const profileId = this.#profileIdResolver instanceof Function
      ? await this.#profileIdResolver(actor, {preview})
      : preview.profileId;
    if (profileId !== preview.profileId) throw serviceError("profile-stale", "Rules profile changed after preview.", {profileId});
    const definition = this.getDefinition(preview.definitionId);
    const profileSnapshot = await this.#resolveProfileSnapshot(actor, definition, profileId, {preview});
    const profileDigest = await digestCanonicalJson(profileSnapshot);
    if (profileDigest !== preview.profileDigest) {
      throw serviceError("profile-stale", "Rules profile data changed after preview.", {profileId, profileDigest});
    }
  }

  async #assertCreationSourcesCurrent(preview, user) {
    if (preview.trigger !== "character.create") return;
    const snapshots = preview.sourceSnapshots ?? [];
    if (!Array.isArray(snapshots)) throw serviceError("source-snapshot", "Creation preview source snapshots are invalid.");
    if (!snapshots.length) return;
    const definition = this.getDefinition(preview.definitionId);
    for (const binding of snapshots) {
      const sourceRef = definition?.sourceRefs?.find(reference => reference.id === binding.sourceRefId) ?? null;
      const digest = await this.#resolveSourceSnapshot(binding.sourceRefId, {
        phase: "commit",
        definition,
        sourceRef,
        preview,
        user,
      });
      if (digest !== binding.digest) {
        throw serviceError("source-stale", `Creation source "${binding.sourceRefId}" changed after preview.`, {
          sourceRefId: binding.sourceRefId,
          digest,
        });
      }
    }
  }

  async #assertBaseCurrent(preview, actor) {
    if (!(this.#baseDigestResolver instanceof Function)) return;
    const definition = this.getDefinition(preview.definitionId);
    const digest = await this.#baseDigestResolver({trigger: preview.trigger, actor, preview, definition});
    if (digest !== preview.baseDigest) throw serviceError("base-stale", "Progression base data changed after preview.", {digest});
  }

  #assertReceiptBinding(receipt, preview, user, actor) {
    assertProgressionReceiptV1(receipt);
    const expectedKind = preview.trigger;
    if (!RECEIPT_KINDS.has(receipt.kind) || receipt.kind !== expectedKind) throw serviceError("receipt-binding", "Receipt kind does not match its preview.");
    for (const field of ["previewId", "planDigest", "definitionId", "definitionVersion", "definitionDigest", "profileId"]) {
      if (receipt[field] !== preview[field]) throw serviceError("receipt-binding", `Receipt ${field} does not match its preview.`);
    }
    if (receipt.committedBy !== user.id) throw serviceError("receipt-binding", "Receipt was committed for another user.");
    if (actor && receipt.actorUuid !== actorUuid(actor)) throw serviceError("receipt-binding", "Receipt belongs to another Actor.");
    if (this.#receipts.has(receipt.id)) throw serviceError("receipt-duplicate", `Receipt "${receipt.id}" already exists.`);
  }

  async #undoContext(receiptId) {
    const receipt = await this.#lookupReceipt(receiptId);
    if (receipt.state !== "committed" || receipt.reversible !== true) throw serviceError("receipt-state", "Progression receipt is not reversibly committed.");
    const user = await this.#currentUser();
    const actor = await this.#resolveActor(receipt.actorUuid);
    if (!canOwn(user, actor)) throw serviceError("permission", "User does not own the receipt Actor.");
    const receiptContext = this.#receiptContexts.get(receipt.id) ?? {};
    const classItem = receipt.kind === "rank.advance"
      && (receiptContext.execution === "class-transaction-v1" || (!receiptContext.execution && receiptContext.classItemId))
      ? await this.#classItemResolver?.({actorUuid: receipt.actorUuid, receipt, ...receiptContext}, actor) ?? null
      : null;
    return {receipt, actor, classItem, user, receiptContext};
  }

  async #lookupReceipt(receiptId) {
    const id = requiredText(receiptId, "receiptId");
    let receipt = this.#receipts.get(id) ?? null;
    if (!receipt && this.#receiptResolver instanceof Function) {
      const resolved = await this.#receiptResolver(id);
      if (resolved) {
        const value = isPlainObject(resolved?.receipt) ? resolved.receipt : resolved;
        const context = isPlainObject(resolved?.receipt) && isPlainObject(resolved.context) ? resolved.context : {};
        receipt = this.recordReceipt(value, {context});
      }
    }
    if (!receipt) throw serviceError("receipt-missing", `Progression receipt "${id}" is unknown.`);
    return receipt;
  }

  async #currentUser() {
    const user = await this.#userResolver?.();
    if (!user || typeof user.id !== "string" || !user.id) throw serviceError("user", "Progression service could not resolve the current user.");
    return user;
  }

  async #resolveActor(uuid) {
    const actor = await this.#actorResolver?.(uuid);
    if (!actor) throw serviceError("actor-missing", `Progression Actor "${uuid ?? "unknown"}" could not be resolved.`);
    if (uuid && actorUuid(actor) !== uuid) throw serviceError("actor-binding", "Resolved Actor does not match the signed Actor UUID.");
    return actor;
  }

  async #resolveProfileId(actor, definition, requested) {
    const resolved = requested ?? (this.#profileIdResolver instanceof Function ? await this.#profileIdResolver(actor, {definition}) : definition.profileId);
    if (resolved !== definition.profileId) throw serviceError("profile-binding", `Definition profile "${definition.profileId}" does not match active profile "${resolved}".`);
    return resolved;
  }

  async #resolveProfileSnapshot(actor, definition, profileId, context = {}) {
    if (!(this.#profileSnapshotResolver instanceof Function)) {
      throw serviceError("profile-snapshot", "A profileSnapshotResolver is required for progression previews.", {profileId});
    }
    const value = await this.#profileSnapshotResolver(profileId, {actor, definition, ...context});
    if (!isPlainObject(value)) throw serviceError("profile-snapshot", "Rules profile resolver must return a plain object.");
    try {
      return snapshot(value);
    } catch (cause) {
      throw serviceError("profile-snapshot", "Rules profile resolver must return plain JSON data.", {cause: String(cause?.message ?? cause)});
    }
  }

  async #resolveSourceSnapshot(sourceRefId, context) {
    if (!(this.#sourceSnapshotResolver instanceof Function)) {
      throw serviceError("source-snapshot", `No source snapshot resolver is available for "${sourceRefId}".`, {sourceRefId});
    }
    const digest = await this.#sourceSnapshotResolver(sourceRefId, context);
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest)) {
      throw serviceError("source-snapshot", `Source snapshot resolver returned an invalid digest for "${sourceRefId}".`, {sourceRefId});
    }
    return digest.toLowerCase();
  }

  async #resolveBaseDigest(context) {
    if (!(this.#baseDigestResolver instanceof Function)) throw serviceError("base-digest", "A baseDigest or baseDigestResolver is required for progression preview.");
    return this.#baseDigestResolver(context);
  }

  async #resolveContext(context) {
    if (!(this.#contextResolver instanceof Function)) return {};
    return this.#contextResolver(context);
  }
}
