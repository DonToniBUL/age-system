import {ClassAdvancementService} from "../class-advancement.js";
import {
  adaptClassV3Definition,
  validateClassV3Compatibility,
} from "./class-v3-adapter.js";
import {assertProgressionDefinition} from "./contracts.js";
import {canonicalClone, canonicalJson, digestCanonicalJson, definitionDigest} from "./canonical.js";
import {classBindingMatches} from "./class-binding.js";
import {compileProgressionPreviewV1} from "./compiler.js";
import {
  AgeProgressionPreviewStore,
  createProgressionReceiptV1,
  markProgressionReceiptUndone,
  validateProgressionReceiptV1,
} from "./receipts.js";

export const AGE_CLASS_ADVANCEMENT_EXECUTOR_VERSION = 1;
export const AGE_CLASS_ADVANCEMENT_BINDING_VERSION = 1;
export const AGE_CLASS_ADVANCEMENT_UNDO_PREVIEW_VERSION = 1;
export const AGE_PROGRESSION_RECEIPT_JOURNAL_VERSION = 1;
export const AGE_PROGRESSION_RECEIPT_JOURNAL_FLAG = "progressionReceiptJournal";
export const AGE_PROGRESSION_RECEIPT_JOURNAL_LIMIT = 50;

const AGE_SYSTEM_FLAG_SCOPE = "age-system";
const RECEIPT_JOURNAL_UPDATE_PATH = `flags.${AGE_SYSTEM_FLAG_SCOPE}.${AGE_PROGRESSION_RECEIPT_JOURNAL_FLAG}`;
const RECEIPT_IMMUTABLE_FIELDS = Object.freeze([
  "schemaVersion", "id", "kind", "previewId", "planDigest", "definitionId",
  "definitionVersion", "definitionDigest", "profileId", "actorUuid", "transactionId",
  "beforeDigest", "afterDigest", "createdAt", "committedAt", "committedBy", "reversible",
]);

const PROGRESSABLE_TRAITS = new Set(["spec", "talent", "focus", "relationship"]);
const RESOURCE_TRAITS = new Set(["health", "powerPoints", "conviction"]);
const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;
const LEGACY_CLASS_CAPABILITY = "age.class-v3";

function advancementError(message, code = "advancement-invalid", details = {}) {
  const error = new Error(message);
  error.name = "AgeProgressionAdvancementError";
  error.code = code;
  error.details = deepFreeze(plainClone(details));
  return error;
}

function errorSummary(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: typeof error?.code === "string" ? error.code : null,
    message: String(error?.message ?? error ?? "Unknown error"),
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function plainClone(value) {
  if (value === undefined) return null;
  return canonicalClone(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

function frozen(value) {
  return deepFreeze(plainClone(value));
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw advancementError(`${label} must be a non-empty string.`, "metadata");
  return value;
}

function finiteNonNegative(value, label, {integer = false} = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw advancementError(`${label} must be a resolved non-negative${integer ? " integer" : " number"}.`, "unresolved-effect");
  }
  return value;
}

function idFactory(prefix = "age-progression") {
  const value = globalThis.foundry?.utils?.randomID?.(16)
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${value}`;
}

function itemArray(actor) {
  if (!actor?.items) return [];
  if (Array.isArray(actor.items)) return actor.items;
  if (Array.isArray(actor.items.contents)) return actor.items.contents;
  try { return Array.from(actor.items); } catch { return []; }
}

function getOwnedItem(actor, id) {
  if (!id) return null;
  if (actor?.items?.get instanceof Function) return actor.items.get(id) ?? null;
  return itemArray(actor).find(item => (item.id ?? item._id) === id) ?? null;
}

function sourceSystem(document) {
  const source = document?._source?.system ?? document?.system;
  if (!isPlainObject(source)) throw advancementError("Document does not expose plain system source data.", "document-source");
  return plainClone(source);
}

function safeFlags(document) {
  const flags = plainClone(document?._source?.flags ?? document?.flags ?? {});
  if (isPlainObject(flags?.[AGE_SYSTEM_FLAG_SCOPE])) {
    delete flags[AGE_SYSTEM_FLAG_SCOPE].classAdvancementLock;
    // Receipt persistence necessarily happens after the advancement mutation.
    // Excluding the journal keeps before/after digests stable and prevents a
    // receipt from recursively changing the digest stored inside itself.
    delete flags[AGE_SYSTEM_FLAG_SCOPE][AGE_PROGRESSION_RECEIPT_JOURNAL_FLAG];
    if (!Object.keys(flags[AGE_SYSTEM_FLAG_SCOPE]).length) delete flags[AGE_SYSTEM_FLAG_SCOPE];
  }
  return flags;
}

function journalError(message, code = "receipt-journal", details = {}) {
  return advancementError(message, code, details);
}

function receiptContext(context, actorUuid = null) {
  if (!isPlainObject(context)) throw journalError("Progression receipt context must be a plain object.", "receipt-context");
  if (context.execution === "actor-transaction-v1") {
    const trackId = requiredText(context.trackId, "receipt context trackId");
    return {execution: "actor-transaction-v1", trackId};
  }
  const classItemId = requiredText(context.classItemId, "receipt context classItemId");
  const classItemUuid = requiredText(context.classItemUuid, "receipt context classItemUuid");
  if (actorUuid && !classItemUuid.startsWith(`${actorUuid}.Item.`)) {
    throw journalError("Progression receipt Class UUID belongs to another Actor.", "receipt-context");
  }
  return {execution: "class-transaction-v1", classItemId, classItemUuid};
}

function receiptEntry(receipt, context, actorUuid = null) {
  const validation = validateProgressionReceiptV1(receipt);
  if (!validation.valid || receipt.kind !== "rank.advance") {
    throw journalError("Only valid rank.advance ReceiptV1 records can be stored in the Actor journal.", "receipt-journal-invalid", {
      errors: validation.errors,
    });
  }
  if (actorUuid && receipt.actorUuid !== actorUuid) {
    throw journalError("Progression receipt belongs to another Actor.", "receipt-journal-actor");
  }
  return {receipt: plainClone(receipt), context: receiptContext(context, actorUuid)};
}

function rawReceiptJournal(actor) {
  const flags = actor?._source?.flags ?? actor?.flags ?? {};
  return flags?.[AGE_SYSTEM_FLAG_SCOPE]?.[AGE_PROGRESSION_RECEIPT_JOURNAL_FLAG] ?? null;
}

function normalizeReceiptJournal(actor) {
  const raw = rawReceiptJournal(actor);
  if (raw === null || raw === undefined) {
    return {schemaVersion: AGE_PROGRESSION_RECEIPT_JOURNAL_VERSION, entries: []};
  }
  if (!isPlainObject(raw) || raw.schemaVersion !== AGE_PROGRESSION_RECEIPT_JOURNAL_VERSION || !Array.isArray(raw.entries)) {
    throw journalError("Actor progression receipt journal has an unsupported or malformed structure.", "receipt-journal-invalid");
  }
  if (raw.entries.length > AGE_PROGRESSION_RECEIPT_JOURNAL_LIMIT) {
    throw journalError(
      `Actor progression receipt journal exceeds its ${AGE_PROGRESSION_RECEIPT_JOURNAL_LIMIT}-entry hard limit.`,
      "receipt-journal-invalid",
    );
  }
  const actorUuid = requiredText(actor?.uuid, "actor.uuid");
  const ids = new Set();
  const entries = raw.entries.map((entry, index) => {
    if (!isPlainObject(entry) || Object.keys(entry).some(key => key !== "receipt" && key !== "context")) {
      throw journalError(`Progression receipt journal entry ${index} is malformed.`, "receipt-journal-invalid");
    }
    const normalized = receiptEntry(entry.receipt, entry.context, actorUuid);
    if (ids.has(normalized.receipt.id)) {
      throw journalError(`Progression receipt journal contains duplicate id "${normalized.receipt.id}".`, "receipt-journal-invalid");
    }
    ids.add(normalized.receipt.id);
    return normalized;
  });
  return {schemaVersion: AGE_PROGRESSION_RECEIPT_JOURNAL_VERSION, entries};
}

/** Return a frozen raw-source ReceiptV1 journal snapshot from an Actor. */
export function readProgressionReceiptJournal(actor) {
  return frozen(normalizeReceiptJournal(actor));
}

/** Find one persisted ReceiptV1 and its Class Item context on an Actor. */
export function findPersistedProgressionReceipt(actor, receiptId) {
  const id = requiredText(receiptId, "receiptId");
  const entry = normalizeReceiptJournal(actor).entries.find(candidate => candidate.receipt.id === id) ?? null;
  return entry ? frozen(entry) : null;
}

/**
 * Hydrate the service-compatible `{receipt, context}` records after reload.
 * Passing the shared service records them immediately; omitting it returns the
 * immutable records for use by a receiptResolver.
 */
export function hydratePersistedProgressionReceipts(actor, {service = null, replace = false} = {}) {
  const entries = readProgressionReceiptJournal(actor).entries;
  if (service !== null) {
    if (!(service?.recordReceipt instanceof Function)) {
      throw journalError("Receipt hydration service must implement recordReceipt.", "receipt-hydration");
    }
    for (const entry of entries) service.recordReceipt(entry.receipt, {replace, context: entry.context});
  }
  return entries;
}

function actorCollectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (collection.values instanceof Function) return [...collection.values()];
  try { return [...collection]; } catch { return []; }
}

/**
 * Build the exact resolver shape consumed by AgeProgressionService:
 * `receiptId -> {receipt, context} | null`. The default scans game.actors only
 * when called, so a new service instance can hydrate persisted receipts after
 * a world reload without maintaining a mutable sidecar index.
 */
export function createPersistedProgressionReceiptResolver({actors = () => globalThis.game?.actors} = {}) {
  if (!(actors instanceof Function)) throw journalError("Persisted receipt Actor resolver must be callable.", "receipt-hydration");
  return async receiptId => {
    const id = requiredText(receiptId, "receiptId");
    const matches = [];
    for (const actor of actorCollectionValues(await actors())) {
      const entry = findPersistedProgressionReceipt(actor, id);
      if (entry) matches.push(entry);
    }
    if (matches.length > 1) {
      throw journalError(`Progression receipt id "${id}" is duplicated across Actors.`, "receipt-journal-duplicate");
    }
    return matches[0] ?? null;
  };
}

function receiptIdentityMatches(left, right) {
  return RECEIPT_IMMUTABLE_FIELDS.every(field => left?.[field] === right?.[field]);
}

function boundedJournalWithEntry(actor, entry, limit) {
  const journal = normalizeReceiptJournal(actor);
  const index = journal.entries.findIndex(candidate => candidate.receipt.id === entry.receipt.id);
  if (index >= 0) {
    const existing = journal.entries[index];
    if (!receiptIdentityMatches(existing.receipt, entry.receipt)
      || !sameCanonical(existing.context, entry.context)) {
      throw journalError("Persisted progression receipt bindings cannot be changed.", "receipt-journal-binding");
    }
    if (existing.receipt.state === "undone" && entry.receipt.state !== "undone") {
      throw journalError("An undone persisted receipt cannot return to committed state.", "receipt-journal-state");
    }
    journal.entries.splice(index, 1);
  }
  journal.entries.push(entry);
  journal.entries = journal.entries.slice(-limit);
  return journal;
}

function sameCanonical(left, right) {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

export async function writeProgressionReceiptJournal(actor, journal) {
  const expected = frozen(journal);
  if (sameCanonical(normalizeReceiptJournal(actor), expected)) return expected;
  if (!(actor?.update instanceof Function)) {
    throw journalError("Actor cannot persist its progression receipt journal.", "receipt-persistence");
  }
  try {
    await actor.update({[RECEIPT_JOURNAL_UPDATE_PATH]: plainClone(expected)}, {
      ageProgressionReceipt: true,
      render: false,
    });
  } catch (error) {
    // Document.update can theoretically reject after the authoritative source
    // was accepted. Treat an exact raw-source match as success; otherwise the
    // caller must roll back the advancement.
    if (!sameCanonical(normalizeReceiptJournal(actor), expected)) throw error;
  }
  if (!sameCanonical(normalizeReceiptJournal(actor), expected)) {
    throw journalError("Actor receipt journal did not persist the expected raw source.", "receipt-persistence");
  }
  return expected;
}

export async function persistProgressionReceipt(actor, receipt, context, {limit = AGE_PROGRESSION_RECEIPT_JOURNAL_LIMIT} = {}) {
  const numericLimit = Number(limit);
  if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > AGE_PROGRESSION_RECEIPT_JOURNAL_LIMIT) {
    throw journalError(`Progression receipt journal limit must be between 1 and ${AGE_PROGRESSION_RECEIPT_JOURNAL_LIMIT}.`, "receipt-journal-limit");
  }
  const actorUuid = requiredText(actor?.uuid, "actor.uuid");
  const entry = receiptEntry(receipt, context, actorUuid);
  const journal = boundedJournalWithEntry(actor, entry, numericLimit);
  await writeProgressionReceiptJournal(actor, journal);
  return frozen(entry);
}

function itemSnapshot(item) {
  return {
    id: String(item?.id ?? item?._id ?? ""),
    uuid: String(item?.uuid ?? ""),
    name: String(item?._source?.name ?? item?.name ?? ""),
    type: String(item?._source?.type ?? item?.type ?? ""),
    img: String(item?._source?.img ?? item?.img ?? ""),
    system: sourceSystem(item),
    flags: safeFlags(item),
  };
}

function actorSnapshot(actor) {
  const source = actor?._source ?? {};
  const items = itemArray(actor).map(itemSnapshot).sort((left, right) => left.id.localeCompare(right.id));
  return {
    id: String(actor?.id ?? source._id ?? ""),
    uuid: String(actor?.uuid ?? ""),
    name: String(source.name ?? actor?.name ?? ""),
    type: String(source.type ?? actor?.type ?? ""),
    img: String(source.img ?? actor?.img ?? ""),
    system: sourceSystem(actor),
    flags: safeFlags(actor),
    ownership: plainClone(source.ownership ?? actor?.ownership ?? {}),
    items,
  };
}

function classSnapshot(classItem) {
  return itemSnapshot(classItem);
}

/** Digest the complete advancement-relevant Actor and owned-Item source. */
export async function digestClassAdvancementBase(actor, _classItem = null) {
  return digestCanonicalJson(actorSnapshot(actor));
}

/** Digest the exact owned Class transaction-track source independently of its definition provider. */
export async function digestOwnedClassSource(classItem) {
  return digestCanonicalJson(classSnapshot(classItem));
}

function traitForItem(item) {
  const type = item?.type ?? item?._source?.type;
  const system = item?._source?.system ?? item?.system ?? {};
  return type === "talent" && system?.type === "spec" ? "spec" : type;
}

function ownedClass(actor, classItem) {
  if (!actor || actor.type !== "char" || !classItem || classItem.type !== "class") return false;
  const parentId = classItem.actor?.id ?? classItem.parent?.id ?? classItem.parent?._id;
  if (parentId && parentId !== actor.id) return false;
  const item = getOwnedItem(actor, classItem.id ?? classItem._id);
  return Boolean(item && item.type === "class");
}

function ownerLevel(ownership, userId) {
  const direct = Number(ownership?.[userId]);
  const fallback = Number(ownership?.default);
  return Number.isFinite(direct) ? direct : (Number.isFinite(fallback) ? fallback : 0);
}

function documentOwner(document, user) {
  if (user?.isGM === true) return true;
  if (!user?.id) return false;
  try {
    if (document?.testUserPermission?.(user, "OWNER") === true) return true;
  } catch { /* fall through to source ownership */ }
  try {
    if (document?.canUserModify?.(user, "update") === true) return true;
  } catch { /* fall through to source ownership */ }
  const ownership = document?._source?.ownership ?? document?.ownership;
  return ownerLevel(ownership, user.id) >= 3;
}

function canAdvance(actor, classItem, user) {
  return documentOwner(actor, user) && documentOwner(classItem, user);
}

function definitionOptions(classItem, profileId) {
  return {
    id: classItem.id ?? classItem._id,
    classId: classItem.id ?? classItem._id,
    className: classItem.name ?? classItem._source?.name ?? "Class",
    label: classItem.name ?? classItem._source?.name ?? "Class",
    uuid: classItem.uuid ?? "",
    profileId,
  };
}

function assertClassTransactionTrack(classSystem, targetRank) {
  if (!isPlainObject(classSystem)) throw advancementError("Owned Class track has no plain system source.", "class-track");
  const currentRank = Number(classSystem.level);
  if (!Number.isInteger(currentRank) || currentRank < 0) {
    throw advancementError("Owned Class track has no valid integer level.", "class-track");
  }
  if (currentRank + 1 !== Number(targetRank)) {
    throw advancementError("Target Class-track level changed after compilation.", "target-level", {
      currentRank,
      targetRank,
    });
  }
  return classSystem;
}

function defaultProfileSnapshot(profileId) {
  let primaryAbilityAlternation = null;
  try { primaryAbilityAlternation = globalThis.game?.settings?.get?.("age-system", "primaryAbl") ?? null; } catch { /* unavailable */ }
  return {id: profileId, primaryAbilityAlternation};
}

function defaultAbilityEligibility({actor, classSystem, targetLevel, profileSnapshot}) {
  const all = Object.keys(sourceSystem(actor).abilities ?? {});
  const alternates = profileSnapshot?.primaryAbilityAlternation === true;
  if (alternates) {
    const primary = (classSystem.primaryAbl ?? []).filter(key => all.includes(key));
    const primarySet = new Set(primary);
    const secondary = all.filter(key => !primarySet.has(key));
    return targetLevel % 2 === 0 ? primary : secondary;
  }
  const transactions = sourceSystem(actor).classProgression?.transactions ?? [];
  const previous = Array.isArray(transactions) ? transactions.at(-1)?.choices?.ability ?? {} : {};
  const used = new Set(Object.entries(previous).filter(([, amount]) => Number(amount) > 0).map(([key]) => key));
  const remaining = all.filter(key => !used.has(key));
  return remaining.length ? remaining : all;
}

async function defaultSourceResolver(uuid) {
  if (!uuid) return null;
  if (globalThis.foundry?.utils?.fromUuid instanceof Function) return globalThis.foundry.utils.fromUuid(uuid);
  if (globalThis.fromUuid instanceof Function) return globalThis.fromUuid(uuid);
  if (globalThis.foundry?.utils?.fromUuidSync instanceof Function) return globalThis.foundry.utils.fromUuidSync(uuid);
  return null;
}

function profileIdFrom(profileIdResolver, actor, classItem, fallback) {
  if (!(profileIdResolver instanceof Function)) return fallback;
  return profileIdResolver(actor, classItem, fallback);
}

function bodyWithoutDigest(value, digestField = "planDigest") {
  const body = plainClone(value);
  delete body[digestField];
  return body;
}

async function assertSignedPreview(preview, now, userId = null) {
  if (!isPlainObject(preview) || preview.schemaVersion !== 1) throw advancementError("Advancement requires Progression PreviewV1.", "preview-version");
  if (preview.trigger !== "rank.advance") throw advancementError("Advancement executor only accepts rank.advance previews.", "preview-trigger");
  requiredText(preview.previewId, "previewId");
  requiredText(preview.planDigest, "planDigest");
  requiredText(preview.actorUuid, "actorUuid");
  if (!Array.isArray(preview.resolvedEffects)) throw advancementError("Preview has no resolvedEffects array.", "preview-effects");
  const expected = await digestCanonicalJson(bodyWithoutDigest(preview));
  if (expected !== preview.planDigest) throw advancementError("Advancement preview digest does not match its body.", "preview-digest", {expected});
  const expiresAt = Date.parse(preview.expiresAt);
  if (!Number.isFinite(expiresAt) || Number(now) >= expiresAt) throw advancementError("Advancement preview expired.", "preview-expired");
  if (userId !== null && preview.userId !== userId) throw advancementError("Advancement preview belongs to another user.", "preview-user");
  return true;
}

function legacyGrantRecords(classSystem) {
  const records = [];
  for (const [groupIndex, group] of (classSystem.advancements?.item ?? []).entries()) {
    const grants = group.grants ?? group.itemArr ?? [];
    for (const [grantIndex, grant] of grants.entries()) {
      const trait = grant.trait === "spec" ? "spec" : (grant.trait ?? grant.type ?? "");
      records.push({
        groupIndex,
        grantIndex,
        groupId: String(group.id ?? `item-${groupIndex}`),
        allowProgression: group.allowProgression !== false,
        id: String(grant.id ?? `grant-${grantIndex}`),
        uuid: String(grant.uuid ?? ""),
        type: String(grant.type ?? (trait === "spec" ? "talent" : trait)),
        trait: String(trait),
        name: String(grant.name ?? ""),
        img: String(grant.img ?? ""),
        isItemProg: grant.isItemProg === true,
      });
    }
  }
  return records;
}

function matchingLegacyGrant(classSystem, sourceRef) {
  const matches = legacyGrantRecords(classSystem).filter(grant => !grant.isItemProg && grant.uuid === sourceRef.uuid);
  if (!matches.length) throw advancementError(`No legacy Class grant matches sourceRef "${sourceRef.id}".`, "source-binding");
  const signatures = new Set(matches.map(grant => JSON.stringify([grant.type, grant.trait, grant.uuid])));
  if (signatures.size !== 1) throw advancementError(`Legacy grants using "${sourceRef.uuid}" have ambiguous traits.`, "source-binding");
  return matches[0];
}

function duplicateIds(actor, grant, source) {
  const uuid = source.uuid;
  const name = String(source.name ?? "").trim().toLowerCase();
  return itemArray(actor).filter(item => {
    if (traitForItem(item) !== grant.trait) return false;
    const flags = item.flags?.["age-system"] ?? item._source?.flags?.["age-system"] ?? {};
    const core = item.flags?.core ?? item._source?.flags?.core ?? {};
    if (flags.classSourceUuid === uuid || core.sourceId === uuid) return true;
    return Boolean(name && String(item.name ?? item._source?.name ?? "").trim().toLowerCase() === name);
  }).map(item => item.id ?? item._id);
}

function assertNoDuplicateFocusAcquisitions(sourceBindings) {
  const duplicate = sourceBindings.find(binding => (
    binding?.grant?.trait === "focus" && binding.duplicateIds?.length
  ));
  if (!duplicate) return;
  const name = duplicate.name || duplicate.grant?.name || "Selected Focus";
  throw advancementError(
    `${name} is already owned; choose a different Focus. This acquisition cannot improve an owned Focus.`,
    "item-already-owned",
    {
      operationId: duplicate.operationId,
      sourceRefId: duplicate.sourceRefId,
      duplicateIds: [...duplicate.duplicateIds],
    },
  );
}

function normalizeAllocationInput(input, abilityEffects) {
  if (!isPlainObject(input)) return {};
  if (abilityEffects.length === 1 && !Object.hasOwn(input, abilityEffects[0].operationId)) {
    return {[abilityEffects[0].operationId]: input};
  }
  return input;
}

function normalizeTargetInput(input) {
  if (!isPlainObject(input)) return {};
  return Object.fromEntries(Object.entries(input).map(([operationId, value]) => [operationId, isPlainObject(value) ? value.itemId : value]));
}

function effectChoiceIsPinned(preview, effect) {
  if (effect.origin?.kind !== "choice") return true;
  const selected = preview.selectedChoices?.find(choice => choice.groupId === effect.origin.choiceGroupId)?.optionIds ?? [];
  return selected.includes(effect.origin.optionId);
}

function sameResolution(left, right) {
  if (left.amount !== right.amount) return false;
  const leftFormula = left.resolution?.formula ?? null;
  const rightFormula = right.resolution?.formula ?? null;
  return leftFormula === rightFormula;
}

function pairFormulaEffects(effects) {
  const resource = effects.filter(effect => effect.type === "resource.gain");
  const bonuses = effects.filter(effect => effect.type === "classBonus.gain");
  const used = new Set();
  const formulas = [];

  for (const effect of resource) {
    if (!RESOURCE_TRAITS.has(effect.resource)) throw advancementError(`Class-backed advancement cannot delegate resource "${effect.resource}".`, "unsupported-effect");
    finiteNonNegative(effect.amount, `${effect.resource} result`);
    const match = bonuses.find(candidate => !used.has(candidate.operationId) && candidate.bonus === effect.resource && sameResolution(effect, candidate));
    if (!match) throw advancementError(`Resource ${effect.resource} is missing its matching Class bonus.`, "effect-pair");
    used.add(match.operationId);
    formulas.push({trait: effect.resource, effect});
  }

  const defense = bonuses.filter(effect => !used.has(effect.operationId) && effect.bonus === "defense");
  const toughness = bonuses.filter(effect => !used.has(effect.operationId) && effect.bonus === "toughness");
  for (const effect of defense) {
    finiteNonNegative(effect.amount, "defense result");
    const match = toughness.find(candidate => !used.has(candidate.operationId) && sameResolution(effect, candidate));
    if (!match) throw advancementError("Defense bonus is missing its matching Toughness bonus.", "effect-pair");
    used.add(effect.operationId);
    used.add(match.operationId);
    formulas.push({trait: "defenseAndToughness", effect});
  }

  const leftovers = bonuses.filter(effect => !used.has(effect.operationId));
  if (leftovers.length) throw advancementError(`Unpaired Class bonus effect(s): ${leftovers.map(effect => effect.operationId).join(", ")}.`, "effect-pair");
  return formulas;
}

/**
 * Pure bridge from a signed semantic preview to the old v3 transaction engine.
 * It deliberately returns no live Actor, Item, Roll, callbacks, or client data.
 */
export function buildClassTransactionDraftFromPreview({
  preview,
  classSystem,
  actorSource,
  sourceBindings = [],
  targetBindings = [],
  eligibleAbilityIds = [],
} = {}) {
  if (!isPlainObject(preview) || !Array.isArray(preview.resolvedEffects)) throw advancementError("Preview effects are required.", "preview-effects");
  if (!isPlainObject(classSystem) || !isPlainObject(actorSource)) throw advancementError("Plain Class-track and Actor source snapshots are required.", "document-source");
  for (const effect of preview.resolvedEffects) {
    if (!effectChoiceIsPinned(preview, effect)) throw advancementError(`Effect "${effect.operationId}" is not backed by a selected choice.`, "choice-binding");
  }

  const binding = preview.advancementBindings;
  if (!isPlainObject(binding) || binding.schemaVersion !== AGE_CLASS_ADVANCEMENT_BINDING_VERSION) {
    throw advancementError("Preview has no Class advancement binding.", "preview-binding");
  }
  const allocationMap = binding.abilityAllocations ?? {};
  const abilityEffects = preview.resolvedEffects.filter(effect => effect.type === "ability.allocate");
  const eligible = [...new Set(eligibleAbilityIds.map(String))];
  const abilities = actorSource.system?.abilities ?? {};
  const choiceAbility = Object.fromEntries(eligible.map(key => [key, 0]));
  let abilityPoints = 0;
  for (const effect of abilityEffects) {
    const points = finiteNonNegative(effect.amount, "ability.allocate amount", {integer: true});
    const allocations = allocationMap[effect.operationId];
    if (!isPlainObject(allocations)) throw advancementError(`Ability effect "${effect.operationId}" has no pinned allocation.`, "ability-binding");
    let total = 0;
    for (const [key, rawAmount] of Object.entries(allocations)) {
      const amount = finiteNonNegative(rawAmount, `ability allocation ${key}`, {integer: true});
      if (!eligible.includes(key)) throw advancementError(`Ability "${key}" is not eligible for this Class level.`, "ability-binding");
      if (!isPlainObject(abilities[key])) throw advancementError(`Actor has no ability "${key}".`, "ability-binding");
      choiceAbility[key] = (choiceAbility[key] ?? 0) + amount;
      total += amount;
    }
    if (total !== points) throw advancementError(`Ability allocations for "${effect.operationId}" total ${total}, expected ${points}.`, "ability-binding");
    abilityPoints += points;
  }

  const formulaPairs = pairFormulaEffects(preview.resolvedEffects);
  const formulas = formulaPairs.map(({trait, effect}, index) => ({
    key: `resolved:${index}:${effect.operationId}`,
    trait,
    alias: effect.resolution?.formula ?? trait,
    formula: effect.resolution?.formula ?? String(effect.amount),
    result: effect.amount,
  }));
  const formulaResults = Object.fromEntries(formulas.map(formula => [formula.key, formula.result]));

  const sourceMap = new Map(sourceBindings.map(entry => [entry.operationId, entry]));
  const targetMap = new Map(targetBindings.map(entry => [entry.operationId, entry]));
  const itemGroups = [];
  const itemSelections = {};
  const progressionTargets = {};
  for (const effect of preview.resolvedEffects.filter(entry => entry.type === "item.acquire" || entry.type === "item.advance")) {
    const groupKey = `resolved-group:${effect.operationId}`;
    const grantKey = `resolved-grant:${effect.operationId}`;
    const target = targetMap.get(effect.operationId) ?? null;
    let grant;
    if (effect.type === "item.acquire") {
      const source = sourceMap.get(effect.operationId);
      if (!source) throw advancementError(`Item effect "${effect.operationId}" has no pinned source.`, "source-binding");
      grant = {
        id: source.grant.id,
        uuid: source.uuid,
        type: source.grant.type,
        trait: source.grant.trait,
        name: source.grant.name,
        img: source.grant.img,
        isItemProg: false,
        key: grantKey,
        sourceName: source.name,
        sourceImg: source.img,
        unresolved: false,
        candidates: target ? [{id: target.itemId, name: target.name, img: target.img, type: target.type, trait: target.trait}] : [],
        duplicateIds: [...source.duplicateIds],
        duplicateNames: [...source.duplicateNames],
        selected: true,
        progressionTarget: target?.itemId ?? "",
      };
    } else {
      if (!target) throw advancementError(`Item advancement "${effect.operationId}" has no pinned owned target.`, "target-binding");
      grant = {
        id: effect.id ?? effect.operationId,
        uuid: null,
        type: effect.trait === "spec" ? "talent" : effect.trait,
        trait: effect.trait,
        name: target.name,
        img: target.img,
        isItemProg: true,
        key: grantKey,
        sourceName: target.name,
        sourceImg: target.img,
        unresolved: false,
        candidates: [{id: target.itemId, name: target.name, img: target.img, type: target.type, trait: target.trait}],
        duplicateIds: [],
        duplicateNames: [],
        selected: true,
        progressionTarget: target.itemId,
      };
    }
    itemGroups.push({
      key: groupKey,
      alias: grant.sourceName || grant.name || grant.trait,
      img: grant.sourceImg || grant.img || "",
      selectionMode: "all",
      quantity: 1,
      allowProgression: true,
      grants: [grant],
    });
    itemSelections[groupKey] = [grantKey];
    progressionTargets[grantKey] = target?.itemId ?? "";
  }

  const primaryAbl = preview.resolvedEffects.filter(effect => effect.type === "ability.setPrimary").map(effect => effect.abilityId);
  const wgroups = preview.resolvedEffects.filter(effect => effect.type === "weaponGroup.add").map(effect => effect.weaponGroupId);
  if (preview.rank !== 1 && primaryAbl.length) {
    throw advancementError(
      "The Class transaction engine can only apply ability.setPrimary at Class rank 1.",
      "unsupported-effect",
      {rank: preview.rank, effects: preview.resolvedEffects.filter(effect => effect.type === "ability.setPrimary").map(effect => effect.operationId)},
    );
  }
  const trackEffects = preview.resolvedEffects.filter(effect => effect.type === "track.setRank");
  const trackIds = [...new Set(trackEffects.map(effect => effect.trackId))];
  if (trackIds.length > 1) {
    throw advancementError(
      "One Class-backed advancement preview cannot update more than one semantic rank track.",
      "unsupported-effect",
      {trackIds},
    );
  }
  for (const effect of trackEffects) {
    if (effect.rank !== preview.rank) {
      throw advancementError(
        `Rank effect "${effect.operationId}" requests ${effect.rank}, but the signed Class-track rank is ${preview.rank}.`,
        "unsupported-effect",
        {operationId: effect.operationId, effectType: effect.type, requestedRank: effect.rank, previewRank: preview.rank},
      );
    }
  }
  const allowedTypes = new Set([
    "resource.gain", "classBonus.gain", "ability.allocate", "ability.setPrimary",
    "weaponGroup.add", "item.acquire", "item.advance", "track.setRank", "summary.add",
  ]);
  const unsupported = preview.resolvedEffects.filter(effect => !allowedTypes.has(effect.type));
  if (unsupported.length) {
    throw advancementError(
      `Class-backed advancement cannot represent effect(s): ${unsupported.map(effect => effect.type).join(", ")}.`,
      "unsupported-effect",
      {effects: unsupported.map(effect => ({operationId: effect.operationId, type: effect.type}))},
    );
  }

  const draft = {
    classSystem: {primaryAbl: [...new Set(primaryAbl)], wgroups: [...new Set(wgroups)]},
    targetLevel: preview.rank,
    ability: {
      points: abilityPoints,
      remaining: 0,
      options: eligible.map(key => ({
        key,
        name: key,
        currentValue: Number(abilities[key]?.value) || 0,
        currentAdvances: Number(abilities[key]?.advances) || 0,
        allocation: choiceAbility[key] ?? 0,
      })),
    },
    formulas,
    itemGroups,
    warnings: [],
  };
  const choices = {ability: choiceAbility, formulaResults, itemSelections, progressionTargets};
  return frozen({draft, choices});
}

// Kept for extensions/tests written against the 5.1 foundation name. The
// implementation is provider-neutral; "legacy" now describes only this alias.
export const buildLegacyClassDraftFromPreview = buildClassTransactionDraftFromPreview;

async function resolvedProfile(profileResolver, profileId, actor, classItem, supplied = undefined) {
  const value = supplied !== undefined
    ? supplied
    : profileResolver instanceof Function
      ? await profileResolver(profileId, {actor, classItem})
      : defaultProfileSnapshot(profileId);
  if (!isPlainObject(value)) throw advancementError("Rules profile resolver must return plain profile data.", "profile-source");
  return plainClone(value);
}

function abilityContext(actor) {
  return Object.fromEntries(Object.entries(sourceSystem(actor).abilities ?? {}).map(([key, ability]) => [key, Number(ability?.value) || 0]));
}

function ownedSourceRefIds(actor) {
  return [...new Set(itemArray(actor).map(item => (
    item.flags?.["age-system"]?.progressionSourceRefId
    ?? item._source?.flags?.["age-system"]?.progressionSourceRefId
  )).filter(value => typeof value === "string" && value))].sort();
}

function memoizedLegacyFormulaResolver(resolveFormula) {
  if (!(resolveFormula instanceof Function)) return resolveFormula;
  const results = new Map();
  return async (formula, metadata) => {
    // One Class-v3 progressive value is adapted into a semantic resource+
    // bonus pair (or defense+toughness pair). Resolve that legacy roll once,
    // then pin the same total into every effect in the pair.
    const key = String(metadata.operationId).replace(
      /:effect:(?:resource|bonus|defense|toughness):/,
      ":effect:legacy-progressive:",
    );
    if (!results.has(key)) results.set(key, Promise.resolve(resolveFormula(formula, metadata)));
    return results.get(key);
  };
}

function isLegacyClassDefinition(definition) {
  return definition?.capabilities?.includes?.(LEGACY_CLASS_CAPABILITY) === true;
}

function semanticGrant(effect, sourceRef, sourceDocument, snapshot) {
  const trait = traitForItem(sourceDocument);
  if (!trait) {
    throw advancementError(`Item source "${sourceRef.uuid}" has no usable AGE Item trait.`, "unsupported-effect", {
      operationId: effect.operationId,
      effectType: effect.type,
    });
  }
  const quantity = effect.quantity ?? 1;
  if (quantity !== 1) {
    throw advancementError(
      `Class-backed advancement cannot safely execute item.acquire quantity ${quantity}; only quantity 1 is representable.`,
      "unsupported-effect",
      {operationId: effect.operationId, effectType: effect.type, quantity},
    );
  }
  return {
    id: String(effect.id ?? effect.operationId),
    type: snapshot.type,
    trait,
    name: snapshot.name,
    img: snapshot.img,
    allowProgression: PROGRESSABLE_TRAITS.has(trait),
  };
}

async function bindSourceEffects(preview, definition, classSystem, actor, sourceResolver) {
  const refs = new Map(definition.sourceRefs.map(ref => [ref.id, ref]));
  const bindings = [];
  for (const effect of preview.resolvedEffects.filter(entry => entry.type === "item.acquire")) {
    const sourceRef = refs.get(effect.sourceRefId);
    if (!sourceRef?.uuid) throw advancementError(`SourceRef "${effect.sourceRefId}" has no resolvable UUID.`, "source-binding");
    const sourceDocument = await sourceResolver(sourceRef.uuid, {preview, effect, sourceRef});
    if (!sourceDocument || (!sourceDocument.type && sourceDocument.documentName !== "Item")) {
      throw advancementError(`Unable to resolve Item source "${sourceRef.uuid}".`, "source-binding");
    }
    const snapshot = itemSnapshot(sourceDocument);
    // Class-v3 providers retain their exact grant metadata. Every other
    // provider is bound only from the normalized effect plus the resolved
    // Item source; provider provenance has no execution semantics.
    const grant = isLegacyClassDefinition(definition)
      ? matchingLegacyGrant(classSystem, sourceRef)
      : semanticGrant(effect, sourceRef, sourceDocument, snapshot);
    const duplicates = duplicateIds(actor, grant, {...snapshot, uuid: sourceRef.uuid}).sort();
    bindings.push({
      operationId: effect.operationId,
      sourceRefId: effect.sourceRefId,
      uuid: sourceRef.uuid,
      digest: await digestCanonicalJson(snapshot),
      name: snapshot.name,
      img: snapshot.img,
      type: snapshot.type,
      grant: {
        id: grant.id,
        type: grant.type,
        trait: grant.trait,
        name: grant.name || snapshot.name,
        img: grant.img || snapshot.img,
        allowProgression: grant.allowProgression,
      },
      duplicateIds: duplicates,
      duplicateNames: itemArray(actor)
        .filter(item => duplicates.includes(item.id ?? item._id))
        .map(item => item.name ?? item._source?.name ?? "")
        .sort(),
    });
  }
  return bindings;
}

async function bindTargets(preview, actor, progressionTargets, sourceBindings) {
  const requested = normalizeTargetInput(progressionTargets);
  const sourceMap = new Map(sourceBindings.map(entry => [entry.operationId, entry]));
  const effects = preview.resolvedEffects.filter(entry => entry.type === "item.acquire" || entry.type === "item.advance");
  const unknown = Object.keys(requested).filter(operationId => !effects.some(effect => effect.operationId === operationId));
  if (unknown.length) throw advancementError(`Unknown item target operation(s): ${unknown.join(", ")}.`, "target-binding");
  const bindings = [];
  for (const effect of effects) {
    const itemId = requested[effect.operationId] ?? "";
    if (!itemId && effect.type === "item.advance") {
      throw advancementError(`Item advancement "${effect.operationId}" requires an owned target.`, "target-binding");
    }
    if (!itemId) continue;
    const item = getOwnedItem(actor, itemId);
    if (!item) throw advancementError(`Owned item target "${itemId}" no longer exists.`, "target-binding");
    const expectedTrait = effect.type === "item.advance" ? effect.trait : sourceMap.get(effect.operationId)?.grant?.trait;
    const actualTrait = traitForItem(item);
    if (actualTrait !== expectedTrait) {
      throw advancementError(`Owned item "${item.name ?? itemId}" is ${actualTrait}, expected ${expectedTrait}.`, "target-binding");
    }
    if (!PROGRESSABLE_TRAITS.has(actualTrait)) {
      throw advancementError(`Class-backed advancement cannot progress item trait "${actualTrait}".`, "target-binding");
    }
    const snapshot = itemSnapshot(item);
    bindings.push({
      operationId: effect.operationId,
      itemId: snapshot.id,
      itemUuid: snapshot.uuid,
      digest: await digestCanonicalJson(snapshot),
      name: snapshot.name,
      img: snapshot.img,
      type: snapshot.type,
      trait: actualTrait,
    });
  }
  return bindings;
}

function validateAbilityAllocations(preview, input, eligibleAbilityIds, actor) {
  const effects = preview.resolvedEffects.filter(effect => effect.type === "ability.allocate");
  const normalized = normalizeAllocationInput(input, effects);
  const unknown = Object.keys(normalized).filter(operationId => !effects.some(effect => effect.operationId === operationId));
  if (unknown.length) throw advancementError(`Unknown ability allocation operation(s): ${unknown.join(", ")}.`, "ability-binding");
  const actorAbilities = sourceSystem(actor).abilities ?? {};
  const fallbackEligible = new Set(eligibleAbilityIds);
  const boundEligibility = {};
  const allEligible = new Set();
  const result = {};
  for (const effect of effects) {
    const points = finiteNonNegative(effect.amount, "ability.allocate amount", {integer: true});
    const allocations = normalized[effect.operationId];
    if (!isPlainObject(allocations)) throw advancementError(`Ability effect "${effect.operationId}" requires pinned allocations.`, "ability-binding");
    const eligible = new Set(
      Array.isArray(effect.eligibleAbilityIds) && effect.eligibleAbilityIds.length
        ? effect.eligibleAbilityIds.map(String)
        : fallbackEligible,
    );
    for (const abilityId of eligible) {
      if (!isPlainObject(actorAbilities[abilityId])) {
        throw advancementError(`Definition makes unknown Actor ability "${abilityId}" eligible.`, "ability-binding");
      }
      if (!fallbackEligible.has(abilityId)) {
        throw advancementError(`Ability "${abilityId}" is not eligible under the active rules profile and Class track.`, "ability-binding");
      }
      allEligible.add(abilityId);
    }
    boundEligibility[effect.operationId] = [...eligible].sort();
    let total = 0;
    result[effect.operationId] = {};
    for (const [abilityId, rawAmount] of Object.entries(allocations)) {
      const amount = finiteNonNegative(rawAmount, `ability allocation ${abilityId}`, {integer: true});
      if (!eligible.has(abilityId) || !isPlainObject(actorAbilities[abilityId])) {
        throw advancementError(`Ability "${abilityId}" is not eligible for this Class level.`, "ability-binding");
      }
      result[effect.operationId][abilityId] = amount;
      total += amount;
    }
    if (total !== points) throw advancementError(`Ability allocations total ${total}, expected ${points}.`, "ability-binding");
  }
  return {
    allocations: result,
    eligibleAbilityIds: [...allEligible].sort(),
    eligibleAbilityIdsByOperation: boundEligibility,
  };
}

function latestClassTransaction(actor) {
  const transactions = sourceSystem(actor).classProgression?.transactions;
  return Array.isArray(transactions) ? transactions.at(-1) ?? null : null;
}

function undoReasons(actor, classItem, user, receipt) {
  const reasons = [];
  const validation = validateProgressionReceiptV1(receipt);
  if (!validation.valid || receipt.kind !== "rank.advance" || receipt.state !== "committed") reasons.push("invalid-receipt");
  if (!ownedClass(actor, classItem)) reasons.push("class-not-owned");
  if (!canAdvance(actor, classItem, user)) reasons.push("permission");
  if (receipt?.actorUuid !== actor?.uuid) reasons.push("actor-mismatch");
  const latest = latestClassTransaction(actor);
  if (!latest || latest.id !== receipt?.transactionId) reasons.push("not-latest-transaction");
  if (latest && latest.classItemId !== classItem?.id) reasons.push("class-mismatch");
  if (latest && Number(latest.level) !== Number(sourceSystem(classItem).level)) reasons.push("class-level-mismatch");
  try {
    const persisted = receipt?.id ? findPersistedProgressionReceipt(actor, receipt.id) : null;
    if (!persisted) reasons.push("receipt-not-persisted");
    else {
      if (!sameCanonical(persisted.receipt, receipt)) reasons.push("receipt-journal-mismatch");
      if (persisted.context.classItemId !== String(classItem?.id ?? classItem?._id ?? "")
        || persisted.context.classItemUuid !== String(classItem?.uuid ?? "")) {
        reasons.push("receipt-context-mismatch");
      }
    }
  } catch {
    reasons.push("receipt-journal-invalid");
  }
  return {reasons: [...new Set(reasons)], latest};
}

/**
 * Contract-driven compatibility executor for the existing Class v3 semantic
 * transaction engine. It is deliberately provider-neutral above the adapter:
 * no FAGE/DAGE/MAGE module is consulted or required.
 */
export class AgeProgressionAdvancementExecutor {
  #advancementService;
  #compiler;
  #profileResolver;
  #profileIdResolver;
  #sourceResolver;
  #abilityEligibilityResolver;
  #clock;
  #idFactory;
  #previewStore;
  #receiptJournalLimit;
  #commitStates = new Map();
  #undoPreviews = new Map();

  constructor({
    advancementService = ClassAdvancementService,
    compiler = compileProgressionPreviewV1,
    profileResolver = null,
    profileIdResolver = null,
    sourceResolver = defaultSourceResolver,
    abilityEligibilityResolver = defaultAbilityEligibility,
    previewStore = new AgeProgressionPreviewStore(),
    receiptJournalLimit = AGE_PROGRESSION_RECEIPT_JOURNAL_LIMIT,
    clock = () => Date.now(),
    idFactory: createId = idFactory,
  } = {}) {
    if (!(advancementService?.applyLevel instanceof Function) || !(advancementService?.rollbackLevel instanceof Function)) {
      throw advancementError("Advancement service must implement applyLevel and rollbackLevel.", "service");
    }
    if (!(compiler instanceof Function)) throw advancementError("Progression compiler must be callable.", "compiler");
    if (!(sourceResolver instanceof Function)) throw advancementError("Source resolver must be callable.", "source-resolver");
    if (!(abilityEligibilityResolver instanceof Function)) throw advancementError("Ability eligibility resolver must be callable.", "ability-resolver");
    if (!(previewStore?.put instanceof Function) || !(previewStore?.reserve instanceof Function)) {
      throw advancementError("Preview store must implement AGE preview store semantics.", "preview-store");
    }
    if (!Number.isInteger(Number(receiptJournalLimit))
      || Number(receiptJournalLimit) < 1
      || Number(receiptJournalLimit) > AGE_PROGRESSION_RECEIPT_JOURNAL_LIMIT) {
      throw advancementError(
        `Receipt journal limit must be between 1 and ${AGE_PROGRESSION_RECEIPT_JOURNAL_LIMIT}.`,
        "receipt-journal-limit",
      );
    }
    this.#advancementService = advancementService;
    this.#compiler = compiler;
    this.#profileResolver = profileResolver;
    this.#profileIdResolver = profileIdResolver;
    this.#sourceResolver = sourceResolver;
    this.#abilityEligibilityResolver = abilityEligibilityResolver;
    this.#previewStore = previewStore;
    this.#receiptJournalLimit = Number(receiptJournalLimit);
    this.#clock = clock;
    this.#idFactory = createId;
  }

  get previewStore() { return this.#previewStore; }

  /**
   * Preserve the Class-v3 adapter's one-roll progressive-value semantics when
   * it is compiled through the shared service. Other DefinitionV1 providers
   * retain the compiler's normal one-resolution-per-effect behavior.
   */
  prepareFormulaResolver(definition, resolveFormula) {
    return isLegacyClassDefinition(definition)
      ? memoizedLegacyFormulaResolver(resolveFormula)
      : resolveFormula;
  }

  async preview({
    actor,
    classItem,
    profileId,
    profileSnapshot,
    choices = {},
    abilityAllocations = {},
    progressionTargets = {},
    resolveFormula,
    user = globalThis.game?.user,
    previewId = this.#idFactory("age-progression-preview"),
    createdAt = new Date(this.#clock()).toISOString(),
    expiresAt = new Date(this.#clock() + DEFAULT_PREVIEW_TTL_MS).toISOString(),
  } = {}) {
    if (!ownedClass(actor, classItem)) throw advancementError("Only an owned Class can advance this Character.", "class-not-owned");
    if (!canAdvance(actor, classItem, user)) throw advancementError("User does not own this Character and Class.", "permission");
    const resolvedProfileId = requiredText(await profileIdFrom(this.#profileIdResolver, actor, classItem, profileId), "profileId");
    const profile = await resolvedProfile(this.#profileResolver, resolvedProfileId, actor, classItem, profileSnapshot);
    const rawClass = sourceSystem(classItem);
    const definition = adaptClassV3Definition(rawClass, definitionOptions(classItem, resolvedProfileId));
    const targetLevel = Number(rawClass.level) + 1;
    const compiled = await this.#compiler(definition, {
      trigger: "rank.advance",
      rank: targetLevel,
      choices,
      context: {abilities: abilityContext(actor), ownedSourceRefIds: ownedSourceRefIds(actor)},
      resolveFormula: this.prepareFormulaResolver(definition, resolveFormula),
      previewId,
      baseDigest: await digestClassAdvancementBase(actor, classItem),
      profileSnapshot: profile,
      createdAt,
      expiresAt,
      userId: requiredText(user?.id, "user.id"),
      actorUuid: requiredText(actor?.uuid, "actor.uuid"),
    });
    return this.acceptPreview({
      preview: compiled,
      definition,
      actor,
      classItem,
      profileId: resolvedProfileId,
      profileSnapshot: profile,
      abilityAllocations,
      progressionTargets,
      user,
    });
  }

  async acceptPreview({
    preview,
    definition,
    actor,
    classItem,
    profileId = preview?.profileId,
    profileSnapshot,
    abilityAllocations = {},
    progressionTargets = {},
    user = globalThis.game?.user,
  } = {}) {
    await assertSignedPreview(preview, this.#clock(), user?.id ?? null);
    if (preview.advancementBindings !== undefined) throw advancementError("Preview is already bound to an advancement executor.", "preview-binding");
    if (!ownedClass(actor, classItem)) throw advancementError("Only an owned Class can advance this Character.", "class-not-owned");
    if (!canAdvance(actor, classItem, user)) throw advancementError("User does not own this Character and Class.", "permission");
    if (preview.actorUuid !== actor.uuid) throw advancementError("Preview belongs to another Actor.", "actor-mismatch");

    assertProgressionDefinition(definition);
    if (definition.id !== preview.definitionId || definition.version !== preview.definitionVersion) {
      throw advancementError("Registered progression definition does not match the compiled preview.", "definition-stale");
    }
    const currentDefinitionDigest = await definitionDigest(definition);
    if (currentDefinitionDigest !== preview.definitionDigest) {
      throw advancementError("Progression definition changed after compilation.", "definition-stale");
    }
    if (definition.trackBinding?.kind !== "class-item" || !classBindingMatches(definition, classItem)) {
      throw advancementError("Selected Class does not match the signed progression Class binding.", "class-binding");
    }

    const resolvedProfileId = requiredText(await profileIdFrom(this.#profileIdResolver, actor, classItem, profileId), "profileId");
    if (resolvedProfileId !== preview.profileId) throw advancementError("Rules profile changed after compilation.", "profile-stale");
    const profile = await resolvedProfile(this.#profileResolver, resolvedProfileId, actor, classItem, profileSnapshot);
    const profileDigest = await digestCanonicalJson(profile);
    if (preview.profileDigest !== profileDigest) throw advancementError("Rules profile data changed after compilation.", "profile-stale");
    const rawClass = sourceSystem(classItem);
    assertClassTransactionTrack(rawClass, preview.rank);
    const baseDigest = await digestClassAdvancementBase(actor, classItem);
    if (baseDigest !== preview.baseDigest) throw advancementError("Character source changed after compilation.", "base-stale");

    const legacy = isLegacyClassDefinition(definition);
    const compatibility = legacy ? validateClassV3Compatibility(rawClass) : null;
    if (legacy && !compatibility.valid) throw advancementError("Current Class source is not compatible with its Class-v3 definition.", "definition");
    const classSystem = compatibility?.normalized ?? rawClass;
    const eligibleAbilityIds = [...new Set((await this.#abilityEligibilityResolver({
      actor,
      classItem,
      classSystem,
      targetLevel: preview.rank,
      profileId: resolvedProfileId,
      profileSnapshot: profile,
    })).map(String))];
    const abilityBinding = validateAbilityAllocations(preview, abilityAllocations, eligibleAbilityIds, actor);
    const sourceBindings = await bindSourceEffects(preview, definition, classSystem, actor, this.#sourceResolver);
    // A concrete Focus grant is an acquisition, never an implicit Focus
    // improvement.  Explicit item.advance effects retain the normal signed
    // target-binding path below.
    assertNoDuplicateFocusAcquisitions(sourceBindings);
    const targetBindings = await bindTargets(preview, actor, progressionTargets, sourceBindings);
    const trackBindings = preview.resolvedEffects
      .filter(effect => effect.type === "track.setRank")
      .map(effect => ({
        operationId: effect.operationId,
        trackId: effect.trackId,
        rank: effect.rank,
        classItemId: String(classItem.id ?? classItem._id),
        classItemUuid: String(classItem.uuid ?? ""),
      }));
    const bindings = {
      schemaVersion: AGE_CLASS_ADVANCEMENT_BINDING_VERSION,
      executorVersion: AGE_CLASS_ADVANCEMENT_EXECUTOR_VERSION,
      execution: "class-transaction-v1",
      definitionId: definition.id,
      definitionDigest: currentDefinitionDigest,
      trackBinding: canonicalClone(definition.trackBinding),
      classItemId: String(classItem.id ?? classItem._id),
      classItemUuid: String(classItem.uuid ?? ""),
      targetLevel: preview.rank,
      classSourceDigest: await digestOwnedClassSource(classItem),
      profileDigest,
      eligibleAbilityIds: abilityBinding.eligibleAbilityIds,
      eligibleAbilityIdsByOperation: abilityBinding.eligibleAbilityIdsByOperation,
      abilityAllocations: abilityBinding.allocations,
      sourceBindings,
      targetBindings,
      trackBindings,
    };
    const body = {...bodyWithoutDigest(preview), advancementBindings: bindings};
    const bound = frozen({...body, planDigest: await digestCanonicalJson(body)});

    // Build once during preview so an invalid semantic-to-legacy bridge never
    // reaches the write boundary. Commit rebuilds only from this signed data.
    buildClassTransactionDraftFromPreview({
      preview: bound,
      classSystem,
      actorSource: actorSnapshot(actor),
      sourceBindings,
      targetBindings,
      eligibleAbilityIds: abilityBinding.eligibleAbilityIds,
    });
    this.#previewStore.put(bound);
    return bound;
  }

  async #recheck(preview, actor, classItem, user) {
    await assertSignedPreview(preview, this.#clock(), user?.id ?? null);
    const binding = preview.advancementBindings;
    if (!isPlainObject(binding) || binding.schemaVersion !== AGE_CLASS_ADVANCEMENT_BINDING_VERSION) {
      throw advancementError("Preview has no Class advancement binding.", "preview-binding");
    }
    if (binding.execution !== "class-transaction-v1"
      || binding.definitionId !== preview.definitionId
      || binding.definitionDigest !== preview.definitionDigest) {
      throw advancementError("Preview Class-transaction binding is invalid.", "preview-binding");
    }
    if (!ownedClass(actor, classItem)) throw advancementError("Owned Class binding no longer matches.", "class-not-owned");
    if (!canAdvance(actor, classItem, user)) throw advancementError("User no longer owns this Character and Class.", "permission");
    if (preview.actorUuid !== actor.uuid) throw advancementError("Preview belongs to another Actor.", "actor-mismatch");
    if (binding.classItemId !== String(classItem.id ?? classItem._id) || binding.classItemUuid !== String(classItem.uuid ?? "")) {
      throw advancementError("Preview belongs to another Class Item.", "class-mismatch");
    }
    if (binding.trackBinding?.kind !== "class-item" || !classBindingMatches(binding.trackBinding, classItem)) {
      throw advancementError("Selected Class no longer matches the signed progression Class binding.", "class-binding");
    }
    const rawClass = sourceSystem(classItem);
    assertClassTransactionTrack(rawClass, binding.targetLevel);
    if (preview.rank !== binding.targetLevel) throw advancementError("Target Class level is stale.", "target-level");
    const currentProfileId = requiredText(await profileIdFrom(this.#profileIdResolver, actor, classItem, preview.profileId), "profileId");
    if (currentProfileId !== preview.profileId) throw advancementError("Rules profile changed after preview.", "profile-stale");
    const profile = await resolvedProfile(this.#profileResolver, currentProfileId, actor, classItem);
    const profileDigest = await digestCanonicalJson(profile);
    if (profileDigest !== preview.profileDigest || profileDigest !== binding.profileDigest) {
      throw advancementError("Rules profile data changed after preview.", "profile-stale");
    }
    if (await digestOwnedClassSource(classItem) !== binding.classSourceDigest) throw advancementError("Class source changed after preview.", "definition-stale");
    if (await digestClassAdvancementBase(actor, classItem) !== preview.baseDigest) throw advancementError("Character source changed after preview.", "base-stale");

    for (const sourceBinding of binding.sourceBindings ?? []) {
      const document = await this.#sourceResolver(sourceBinding.uuid, {preview, binding: sourceBinding});
      if (!document || (!document.type && document.documentName !== "Item")
        || await digestCanonicalJson(itemSnapshot(document)) !== sourceBinding.digest) {
        throw advancementError(`Item source "${sourceBinding.uuid}" changed after preview.`, "source-stale");
      }
    }
    for (const targetBinding of binding.targetBindings ?? []) {
      const item = getOwnedItem(actor, targetBinding.itemId);
      if (!item || traitForItem(item) !== targetBinding.trait || await digestCanonicalJson(itemSnapshot(item)) !== targetBinding.digest) {
        throw advancementError(`Owned progression target "${targetBinding.itemId}" changed after preview.`, "target-stale");
      }
    }
    return {rawClass, binding};
  }

  async commit({actor, classItem, user = globalThis.game?.user, previewId, planDigest} = {}) {
    const reservation = this.#previewStore.reserve(previewId, {
      planDigest,
      userId: user?.id,
      actorUuid: actor?.uuid,
    });
    try {
      const receipt = await this.commitPreview({
        preview: reservation.preview,
        actor,
        classItem,
        user,
        planDigest,
        reservation: reservation.token,
      });
      this.#previewStore.complete(previewId, reservation.token);
      return receipt;
    } catch (error) {
      this.#previewStore.release(previewId, reservation.token);
      throw error;
    }
  }

  /** Dispatch path for a central service which already reserved PreviewV1. */
  async commitPreview({preview, actor, classItem, user = globalThis.game?.user, planDigest = preview?.planDigest} = {}) {
    if (planDigest !== preview?.planDigest) throw advancementError("Commit digest does not match the reserved preview.", "preview-digest");
    const commitKey = `${preview?.previewId}:${planDigest}`;
    const state = this.#commitStates.get(commitKey);
    if (state === "pending") throw advancementError("Advancement preview is already committing.", "duplicate-commit");
    if (state === "consumed") throw advancementError("Advancement preview was already consumed.", "duplicate-commit");
    this.#commitStates.set(commitKey, "pending");
    let applied = false;
    let transaction = null;
    let phase = "preflight";
    let journalBefore = null;
    try {
      const {rawClass, binding} = await this.#recheck(preview, actor, classItem, user);
      const bridge = buildClassTransactionDraftFromPreview({
        preview,
        classSystem: rawClass,
        actorSource: actorSnapshot(actor),
        sourceBindings: binding.sourceBindings,
        targetBindings: binding.targetBindings,
        eligibleAbilityIds: binding.eligibleAbilityIds,
      });
      // Validate and snapshot the current raw-source journal before crossing
      // the Class mutation boundary. A malformed journal must stop the commit.
      journalBefore = readProgressionReceiptJournal(actor);

      // This is the sole mutation call. Formula totals and all choices came
      // from the signed frozen preview, never from commit arguments.
      phase = "apply";
      transaction = await this.#advancementService.applyLevel(
        actor,
        classItem,
        bridge.choices,
        {draft: bridge.draft},
      );
      applied = true;
      phase = "validate-transaction";
      if (!transaction?.id || transaction.classItemId !== classItem.id || Number(transaction.level) !== Number(preview.rank)) {
        throw advancementError("Class advancement returned an invalid transaction reference.", "transaction-result");
      }
      phase = "create-receipt";
      const receipt = createProgressionReceiptV1({
        kind: "rank.advance",
        previewId: preview.previewId,
        planDigest: preview.planDigest,
        definitionId: preview.definitionId,
        definitionVersion: preview.definitionVersion,
        definitionDigest: preview.definitionDigest,
        profileId: preview.profileId,
        actorUuid: actor.uuid,
        transactionId: transaction.id,
        beforeDigest: preview.baseDigest,
        afterDigest: await digestClassAdvancementBase(actor, classItem),
        committedBy: user.id,
        reversible: true,
      }, {now: this.#clock()});
      phase = "persist-receipt";
        await persistProgressionReceipt(actor, receipt, {
          execution: "class-transaction-v1",
          classItemId: String(classItem.id ?? classItem._id),
        classItemUuid: String(classItem.uuid ?? ""),
      }, {limit: this.#receiptJournalLimit});
      this.#commitStates.set(commitKey, "consumed");
      return receipt;
    } catch (error) {
      if (!applied) {
        this.#commitStates.delete(commitKey);
        throw error;
      }

      // A committed Class transaction without its durable ReceiptV1 would be
      // impossible to hydrate safely after reload. Roll it back immediately.
      let rolledBack = null;
      try {
        rolledBack = await this.#advancementService.rollbackLevel(actor, classItem);
        if (!rolledBack?.id || (transaction?.id && rolledBack.id !== transaction.id)) {
          throw advancementError("Receipt recovery rolled back another Class transaction.", "transaction-result");
        }
      } catch (rollbackError) {
        this.#commitStates.set(commitKey, "consumed");
        throw advancementError(
          "Class advancement completed but its durable receipt failed and automatic rollback also failed.",
          "receipt-persistence-rollback-failed",
          {
            phase,
            transactionId: transaction?.id ?? null,
            persistenceError: errorSummary(error),
            rollbackError: errorSummary(rollbackError),
          },
        );
      }

      // Restore the exact pre-commit journal in case Document.update rejected
      // after partially accepting the receipt update.
      try {
        await writeProgressionReceiptJournal(actor, journalBefore);
      } catch (journalRestoreError) {
        this.#commitStates.set(commitKey, "consumed");
        throw advancementError(
          "Class advancement was rolled back, but the previous receipt journal could not be restored.",
          "receipt-persistence-recovery-failed",
          {
            phase,
            transactionId: transaction?.id ?? null,
            rolledBackTransactionId: rolledBack?.id ?? null,
            persistenceError: errorSummary(error),
            journalRestoreError: errorSummary(journalRestoreError),
          },
        );
      }

      this.#commitStates.delete(commitKey);
      throw advancementError(
        "Class advancement was rolled back because its durable progression receipt could not be persisted.",
        phase === "persist-receipt" ? "receipt-persistence" : "receipt-finalization",
        {
          phase,
          transactionId: transaction?.id ?? null,
          rolledBack: true,
          cause: errorSummary(error),
        },
      );
    }
  }

  async previewUndo({
    actor,
    classItem,
    user = globalThis.game?.user,
    receipt,
    expiresAt = new Date(this.#clock() + DEFAULT_PREVIEW_TTL_MS).toISOString(),
  } = {}) {
    const {reasons, latest} = undoReasons(actor, classItem, user, receipt);
    let currentDigest = null;
    try {
      currentDigest = await digestClassAdvancementBase(actor, classItem);
    } catch { reasons.push("source-unavailable"); }
    const body = {
      schemaVersion: AGE_CLASS_ADVANCEMENT_UNDO_PREVIEW_VERSION,
      kind: "rank.advance.undo",
      undoPreviewId: this.#idFactory("age-progression-undo"),
      receiptId: receipt?.id ?? null,
      transactionId: receipt?.transactionId ?? null,
      actorUuid: actor?.uuid ?? null,
      classItemId: classItem?.id ?? null,
      userId: user?.id ?? null,
      currentDigest,
      expectedDigest: receipt?.afterDigest ?? null,
      createdAt: new Date(this.#clock()).toISOString(),
      expiresAt,
      allowed: reasons.length === 0,
      reasons: [...new Set(reasons)],
      latestTransactionId: latest?.id ?? null,
    };
    const preview = frozen({...body, undoDigest: await digestCanonicalJson(body)});
    if (preview.allowed) this.#undoPreviews.set(preview.undoPreviewId, {preview, state: "ready"});
    return preview;
  }

  async undo({
    actor,
    classItem,
    user = globalThis.game?.user,
    receipt,
    undoPreviewId,
    undoDigest,
  } = {}) {
    const entry = this.#undoPreviews.get(undoPreviewId);
    if (!entry || entry.state !== "ready") throw advancementError("Undo preview is missing, consumed, or already running.", "undo-preview");
    if (entry.preview.undoDigest !== undoDigest || await digestCanonicalJson(bodyWithoutDigest(entry.preview, "undoDigest")) !== undoDigest) {
      throw advancementError("Undo preview digest does not match.", "undo-preview");
    }
    if (Date.parse(entry.preview.expiresAt) <= this.#clock()) throw advancementError("Undo preview expired.", "undo-expired");
    if (entry.preview.receiptId !== receipt?.id || entry.preview.transactionId !== receipt?.transactionId) {
      throw advancementError("Undo preview targets another receipt.", "undo-receipt");
    }
    if (entry.preview.actorUuid !== actor?.uuid || entry.preview.classItemId !== classItem?.id || entry.preview.userId !== user?.id) {
      throw advancementError("Undo preview binding changed.", "undo-binding");
    }
    const {reasons} = undoReasons(actor, classItem, user, receipt);
    if (reasons.length) throw advancementError(`Class advancement cannot be undone safely: ${[...new Set(reasons)].join(", ")}.`, "unsafe-undo");

    entry.state = "pending";
    try {
      const transaction = await this.#advancementService.rollbackLevel(actor, classItem);
      if (transaction?.id !== receipt.transactionId) throw advancementError("Rollback returned another Class transaction.", "transaction-result");
      const undone = markProgressionReceiptUndone(receipt, {now: this.#clock()});
      try {
        await persistProgressionReceipt(actor, undone, {
          execution: "class-transaction-v1",
          classItemId: String(classItem.id ?? classItem._id),
          classItemUuid: String(classItem.uuid ?? ""),
        }, {limit: this.#receiptJournalLimit});
      } catch (persistenceError) {
        // Rollback already succeeded and must never be repeated. Leaving the
        // old committed journal entry is safe: latest-transaction validation
        // prevents another rollback, while callers receive an explicit error.
        entry.state = "consumed";
        throw advancementError(
          "Class level was rolled back, but the persisted receipt could not be marked undone.",
          "receipt-state-persistence",
          {
            transactionId: transaction.id,
            rollbackApplied: true,
            persistenceError: errorSummary(persistenceError),
          },
        );
      }
      entry.state = "consumed";
      return undone;
    } catch (error) {
      if (entry.state !== "consumed") entry.state = "ready";
      throw error;
    }
  }
}

export const AgeClassAdvancementExecutor = AgeProgressionAdvancementExecutor;
