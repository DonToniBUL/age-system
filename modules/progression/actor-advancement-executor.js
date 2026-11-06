import {ClassAdvancementService} from "../class-advancement.js";
import {ageSystem} from "../config.js";
import {assertProgressionDefinition} from "./contracts.js";
import {canonicalClone, canonicalJson, definitionDigest, digestCanonicalJson} from "./canonical.js";
import {
  AGE_PROGRESSION_RECEIPT_JOURNAL_LIMIT,
  persistProgressionReceipt,
  readProgressionReceiptJournal,
  writeProgressionReceiptJournal,
} from "./advancement-executor.js";
import {
  AgeProgressionPreviewStore,
  createProgressionReceiptV1,
  markProgressionReceiptUndone,
  validateProgressionReceiptV1,
} from "./receipts.js";

export const AGE_ACTOR_ADVANCEMENT_EXECUTOR_VERSION = 1;
export const AGE_ACTOR_ADVANCEMENT_BINDING_VERSION = 1;
export const AGE_ACTOR_ADVANCEMENT_TRACK_VERSION = 1;
export const AGE_ACTOR_ADVANCEMENT_UNDO_PREVIEW_VERSION = 1;
export const AGE_ACTOR_ADVANCEMENT_TRACK_LIMIT = 50;
export const AGE_ACTOR_ADVANCEMENT_FLAG_PATH = Object.freeze([
  "flags", "age-system", "progression", "actorTracks",
]);

const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;
const ACTOR_LOCK_FLAG = "classAdvancementLock";
const ACTOR_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_ACTOR_LOCK_SETTLE_MS = 75;
const actorLocks = new Set();
// Foundry 14 renders after each stage of the intentionally split Actor update.
// During that narrow window system.level is authoritative while the registry
// still contains the preceding rank. Persisted mismatches continue to fail.
const actorRankTransitions = new WeakSet();
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
  description: ["system", "features"],
});
const DIRECT_RESOURCES = new Set(["health", "powerPoints", "conviction"]);
const PROGRESSABLE_TRAITS = new Set(["spec", "talent", "focus", "relationship"]);
const RESOURCE_PATHS = new Set(["system.health", "system.powerPoints", "system.conviction", "system.currency"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SNAPSHOT_PATH_SEPARATOR = "/";

function actorError(message, code = "actor-advancement-invalid", details = {}) {
  const error = new Error(message);
  error.name = "AgeActorProgressionAdvancementError";
  error.code = code;
  error.details = frozen(details);
  return error;
}

function errorSummary(error) {
  return {name: error?.name ?? "Error", code: error?.code ?? "error", message: error?.message ?? String(error)};
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) { return canonicalClone(value); }

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

function frozen(value) { return deepFreeze(clone(value ?? null)); }

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw actorError(`${label} must be a non-empty string.`, "metadata");
  return value;
}

function safeMapKey(value, label) {
  const text = requiredText(value, label);
  if (DANGEROUS_KEYS.has(text)) throw actorError(`${label} is reserved.`, "metadata");
  return text;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function finite(value, label, {integer = false, minimum = null} = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || (minimum !== null && number < minimum)) {
    throw actorError(`${label} is invalid.`, "effect-value", {value});
  }
  return number;
}

function idFactory(prefix = "age-progression") {
  const value = globalThis.foundry?.utils?.randomID?.(16)
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${value}`;
}

function documentIdFactory() {
  return String(globalThis.foundry?.utils?.randomID?.(16)
    ?? globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 16)
    ?? Math.random().toString(36).slice(2, 18).padEnd(16, "0"));
}

function sourceSystem(document) {
  const source = document?._source?.system ?? document?.system;
  if (!isPlainObject(source)) throw actorError("Document does not expose plain system source data.", "document-source");
  return clone(source);
}

function actorItems(actor) {
  if (Array.isArray(actor?.items)) return actor.items;
  if (Array.isArray(actor?.items?.contents)) return actor.items.contents;
  try { return actor?.items ? Array.from(actor.items) : []; } catch { return []; }
}

function ownedItem(actor, id) {
  return actor?.items?.get?.(id) ?? actorItems(actor).find(item => String(item?.id ?? item?._id) === String(id)) ?? null;
}

function itemSource(item) {
  const source = item?._source ?? (item?.toObject instanceof Function ? item.toObject(true) : item);
  if (!isPlainObject(source)) throw actorError("Item does not expose plain source data.", "item-source");
  const snapshot = clone(source);
  // Keep every portable authored field (including Active Effects), but omit
  // database/runtime metadata which Foundry rewrites on every persistence
  // operation. The same canonical shape is used for stale checks, receipts,
  // origin checks, and recovery recreation.
  for (const key of ["id", "uuid", "folder", "sort", "ownership", "_stats", "pack", "parent"]) delete snapshot[key];
  snapshot._id = String(item?.id ?? item?._id ?? source._id ?? "");
  snapshot.name = String(source.name ?? item?.name ?? "");
  snapshot.type = String(source.type ?? item?.type ?? "");
  snapshot.img = String(source.img ?? item?.img ?? "");
  snapshot.system = clone(source.system ?? {});
  snapshot.flags = clone(source.flags ?? {});
  return snapshot;
}

function cleanCreationSource(source) {
  const data = clone(source);
  for (const key of ["_id", "id", "uuid", "folder", "sort", "ownership", "_stats", "pack", "parent"]) delete data[key];
  if (data.img === "icons/svg/skill.svg") data.img = "icons/svg/book.svg";
  data.system = clone(data.system ?? {});
  data.flags = clone(data.flags ?? {});
  return data;
}

function portableCreationSource(data) {
  return itemSource({id: String(data?._id ?? ""), _source: clone(data)});
}

function traitForItem(item) {
  const type = item?.type ?? item?._source?.type;
  const system = item?._source?.system ?? item?.system ?? {};
  return type === "talent" && system?.type === "spec" ? "spec" : type;
}

function normalizedName(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function sourceIdentity(source) {
  return {
    type: String(source?.snapshot?.type ?? ""),
    trait: String(source?.trait ?? ""),
    name: normalizedName(source?.snapshot?.name),
    sourceRefId: String(source?.sourceRefId ?? ""),
    sourceUuid: String(source?.uuid ?? ""),
  };
}

function itemMatchesSource(item, source) {
  const snapshot = itemSource(item);
  const identity = sourceIdentity(source);
  const flags = snapshot.flags?.["age-system"] ?? {};
  const explicit = flags.progressionSourceRefId === identity.sourceRefId
    || flags.progressionSourceUuid === identity.sourceUuid
    || snapshot.flags?.core?.sourceId === identity.sourceUuid;
  return snapshot.type === identity.type
    && traitForItem(item) === identity.trait
    && (explicit || normalizedName(snapshot.name) === identity.name);
}

function matchingOwnedSourceItems(actor, source) {
  return actorItems(actor).filter(item => itemMatchesSource(item, source));
}

function ownerLevel(ownership, userId) {
  const direct = Number(ownership?.[userId]);
  const fallback = Number(ownership?.default);
  return Number.isFinite(direct) ? direct : (Number.isFinite(fallback) ? fallback : 0);
}

function documentOwner(document, user) {
  if (user?.isGM === true) return true;
  if (!document || !user?.id) return false;
  try { if (document.testUserPermission?.(user, "OWNER") === true) return true; } catch { /* fail closed below */ }
  try { if (document.canUserModify?.(user, "update") === true) return true; } catch { /* fail closed below */ }
  return ownerLevel(document?._source?.ownership ?? document?.ownership, user.id) >= 3;
}

function getPath(root, path) {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function hasPath(root, path) {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== "object" || !hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

function setPath(root, path, value) {
  let current = root;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key];
  }
  current[path.at(-1)] = clone(value);
}

// Actor-track transactions live inside Document flags. Foundry recursively
// expands dotted keys in submitted object data, so a persisted snapshot key
// such as `system.level` can come back as `{system: {level: ...}}`. Encode
// managed paths as JSON-Pointer-like keys instead; the transaction remains
// plain JSON while its signed shape survives Foundry cleaning exactly.
function snapshotPathKey(path) {
  if (!Array.isArray(path) || !path.length || path.some(segment => typeof segment !== "string" || !segment)) {
    throw actorError("Actor snapshot path is invalid.", "snapshot-path");
  }
  return `${SNAPSHOT_PATH_SEPARATOR}${path
    .map(segment => segment.replaceAll("~", "~0").replaceAll(SNAPSHOT_PATH_SEPARATOR, "~1"))
    .join(SNAPSHOT_PATH_SEPARATOR)}`;
}

function snapshotPath(key) {
  if (typeof key !== "string" || !key.startsWith(SNAPSHOT_PATH_SEPARATOR)) {
    throw actorError("Actor snapshot key is invalid.", "snapshot-path", {key});
  }
  const path = key.slice(1).split(SNAPSHOT_PATH_SEPARATOR).map(segment => (
    segment.replaceAll("~1", SNAPSHOT_PATH_SEPARATOR).replaceAll("~0", "~")
  ));
  if (!path.length || path.some(segment => !segment)) {
    throw actorError("Actor snapshot key is invalid.", "snapshot-path", {key});
  }
  return path;
}

function snapshotDottedPath(key) {
  return snapshotPath(key).join(".");
}

function rawActorSource(actor) {
  const source = actor?._source ?? {};
  return clone({
    name: source.name ?? actor?.name ?? "",
    system: source.system ?? actor?.system ?? {},
    flags: source.flags ?? actor?.flags ?? {},
  });
}

function sanitizedActorSource(actor) {
  const source = clone(actor?._source ?? {});
  // Embedded Items are digested once, below, in a sorted portable form.
  // `_stats` changes when the cross-client lock flag is acquired and is not
  // authored game data, so neither field belongs in the signed base.
  delete source._stats;
  delete source.items;
  source._id ??= actor?.id ?? actor?._id ?? "";
  source.name ??= actor?.name ?? "";
  source.type ??= actor?.type ?? "";
  source.system = clone(source.system ?? actor?.system ?? {});
  source.flags = clone(source.flags ?? actor?.flags ?? {});
  if (isPlainObject(source.flags?.["age-system"])) {
    delete source.flags["age-system"][ACTOR_LOCK_FLAG];
    delete source.flags["age-system"].progressionReceiptJournal;
    if (!Object.keys(source.flags["age-system"]).length) delete source.flags["age-system"];
  }
  return source;
}

/** Digest every raw Character and owned-Item source field managed by Actor-track previews. */
export async function digestActorAdvancementBase(actor) {
  const items = actorItems(actor)
    .map(itemSource)
    .sort((left, right) => String(left._id).localeCompare(String(right._id)));
  return digestCanonicalJson({actor: sanitizedActorSource(actor), items});
}

async function withActorLock(actor, user, operation, {
  clock = () => Date.now(),
  createId = idFactory,
  settleMs = DEFAULT_ACTOR_LOCK_SETTLE_MS,
} = {}) {
  const actorId = safeMapKey(String(actor?.uuid ?? actor?.id ?? ""), "actor lock id");
  if (actorLocks.has(actorId)) throw actorError("Another progression transaction is already running for this Character.", "actor-busy");
  actorLocks.add(actorId);
  const token = `${user?.id ?? "user"}:${createId("age-actor-progression-lock")}`;
  let ownsSharedLock = false;
  try {
    if (actor?.getFlag instanceof Function && actor?.setFlag instanceof Function) {
      const current = actor.getFlag("age-system", ACTOR_LOCK_FLAG);
      const age = clock() - Number(current?.timestamp ?? 0);
      if (current?.token && age < ACTOR_LOCK_TIMEOUT_MS) {
        throw actorError("Another progression transaction is already running for this Character.", "actor-busy");
      }
      await actor.setFlag("age-system", ACTOR_LOCK_FLAG, {token, actorUuid: actorId, timestamp: clock()});
      if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs));
      const confirmed = actor.getFlag("age-system", ACTOR_LOCK_FLAG);
      if (confirmed?.token !== token) throw actorError("Another progression transaction acquired this Character.", "actor-busy");
      ownsSharedLock = true;
    }
    return await operation();
  } finally {
    try {
      if (ownsSharedLock && actor.getFlag("age-system", ACTOR_LOCK_FLAG)?.token === token) {
        if (actor.unsetFlag instanceof Function) await actor.unsetFlag("age-system", ACTOR_LOCK_FLAG);
        else await actor.setFlag("age-system", ACTOR_LOCK_FLAG, null);
        const remaining = rawActorSource(actor)?.flags?.["age-system"];
        if (isPlainObject(remaining) && Object.keys(remaining).length === 0 && actor.update instanceof Function) {
          await actor.update(deletionUpdate("flags.age-system"), {ageProgressionLockCleanup: true});
        }
      }
    } finally {
      actorLocks.delete(actorId);
    }
  }
}

function same(left, right) {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

function atomicValue(value) {
  const cloned = clone(value);
  if (cloned !== null && typeof cloned === "object") {
    const ForcedReplacement = globalThis.foundry?.data?.operators?.ForcedReplacement;
    if (ForcedReplacement?.create instanceof Function) return ForcedReplacement.create(cloned);
  }
  return cloned;
}

function deletionUpdate(path) {
  const ForcedDeletion = globalThis.foundry?.data?.operators?.ForcedDeletion;
  if (ForcedDeletion?.create instanceof Function) return {[path]: ForcedDeletion.create()};
  // Unit-test and pre-v14 compatibility fallback. Foundry v14 always takes
  // the operator branch above, so the deprecated spelling is never emitted
  // by the live system.
  const segments = path.split(".");
  const leaf = segments.pop();
  const legacyPath = [...segments, `-=${leaf}`].join(".");
  return {[legacyPath]: null};
}

function bodyWithoutDigest(value, field = "planDigest") {
  const body = clone(value);
  delete body[field];
  return body;
}

async function assertSignedPreview(preview, now, userId) {
  if (!isPlainObject(preview) || preview.schemaVersion !== 1 || preview.trigger !== "rank.advance") {
    throw actorError("Actor advancement requires rank.advance PreviewV1.", "preview-version");
  }
  requiredText(preview.previewId, "previewId");
  requiredText(preview.planDigest, "planDigest");
  requiredText(preview.actorUuid, "actorUuid");
  if (userId && preview.userId !== userId) throw actorError("Advancement preview belongs to another user.", "preview-user");
  if (Date.parse(preview.expiresAt) <= now) throw actorError("Advancement preview expired.", "preview-expired");
  const expected = await digestCanonicalJson(bodyWithoutDigest(preview));
  if (expected !== preview.planDigest) throw actorError("Advancement preview digest does not match its body.", "preview-digest", {expected});
}

function rawProgressionFlags(actor) {
  return actor?._source?.flags?.["age-system"]?.progression
    ?? actor?.flags?.["age-system"]?.progression
    ?? {};
}

function rawAgeSystemFlags(actor) {
  return actor?._source?.flags?.["age-system"]
    ?? actor?.flags?.["age-system"]
    ?? {};
}

function semanticTrackState(actor, trackId) {
  if (trackId === "level") return snapshotState(rawActorSource(actor), ["system", "level"]);
  return snapshotState(rawProgressionFlags(actor), ["tracks", trackId]);
}

function normalizeTransaction(transaction, trackId) {
  const allowedPaths = new Set(actorMutationPaths().map(snapshotPathKey));
  if (!isPlainObject(transaction)
    || transaction.schemaVersion !== AGE_ACTOR_ADVANCEMENT_TRACK_VERSION
    || transaction.trackId !== safeMapKey(trackId, "trackId")
    || typeof transaction.id !== "string"
    || !Number.isInteger(transaction.rank)
    || !Number.isInteger(transaction.previousRank)
    || transaction.rank !== transaction.previousRank + 1
    || typeof transaction.trackWasAbsent !== "boolean"
    || typeof transaction.actorTracksWasAbsent !== "boolean"
    || typeof transaction.progressionWasAbsent !== "boolean"
    || !isPlainObject(transaction.semanticTrackState)
    || !isPlainObject(transaction.before)
    || !isPlainObject(transaction.after)
    || !isPlainObject(transaction.resourceDeltas)
    || !isPlainObject(transaction.bonusDeltas)
    || !Array.isArray(transaction.createdItems)
    || !Array.isArray(transaction.updatedItems)) {
    throw actorError(`Actor progression track "${trackId}" contains a malformed transaction.`, "track-source");
  }
  if (transaction.definitionBindingWasAbsent !== undefined && typeof transaction.definitionBindingWasAbsent !== "boolean") {
    throw actorError(`Actor progression track "${trackId}" contains an invalid definition-binding marker.`, "track-source");
  }
  const beforeKeys = Object.keys(transaction.before).sort();
  const afterKeys = Object.keys(transaction.after).sort();
  if (!same(beforeKeys, afterKeys) || beforeKeys.some(path => !allowedPaths.has(path))) {
    throw actorError(`Actor progression track "${trackId}" contains unsafe managed paths.`, "track-source");
  }
  for (const path of beforeKeys) {
    for (const state of [transaction.before[path], transaction.after[path]]) {
      if (!isPlainObject(state)
        || typeof state.exists !== "boolean"
        || Object.keys(state).some(key => key !== "exists" && key !== "value")
        || state.exists && !hasOwn(state, "value")
        || !state.exists && hasOwn(state, "value")) {
        throw actorError(`Actor progression track "${trackId}" contains an unsafe snapshot.`, "track-source");
      }
    }
  }
  if (typeof transaction.semanticTrackState.exists !== "boolean"
    || Object.keys(transaction.semanticTrackState).some(key => key !== "exists" && key !== "value")
    || transaction.semanticTrackState.exists !== hasOwn(transaction.semanticTrackState, "value")) {
    throw actorError(`Actor progression track "${trackId}" contains an unsafe semantic baseline.`, "track-source");
  }
  if (Object.keys(transaction.resourceDeltas).some(resource => ![...DIRECT_RESOURCES, "currency"].includes(resource))
    || Object.values(transaction.resourceDeltas).some(value => !Number.isFinite(Number(value)))) {
    throw actorError(`Actor progression track "${trackId}" contains invalid resource deltas.`, "track-source");
  }
  if (Object.keys(transaction.bonusDeltas).some(bonus => !["health", "powerPoints", "conviction", "defense", "toughness"].includes(bonus))
    || Object.values(transaction.bonusDeltas).some(value => !Number.isFinite(Number(value)))) {
    throw actorError(`Actor progression track "${trackId}" contains invalid class-bonus deltas.`, "track-source");
  }
  const createdIds = transaction.createdItems.map(entry => String(entry?.id ?? ""));
  const updatedIds = transaction.updatedItems.map(entry => String(entry?.id ?? ""));
  if (createdIds.some(id => !id) || new Set(createdIds).size !== createdIds.length
    || updatedIds.some(id => !id) || new Set(updatedIds).size !== updatedIds.length
    || createdIds.some(id => updatedIds.includes(id))
    || transaction.createdItems.some(entry => !isPlainObject(entry?.afterData))
    || transaction.updatedItems.some(entry => !isPlainObject(entry?.beforeSystem) || !isPlainObject(entry?.afterSystem))) {
    throw actorError(`Actor progression track "${trackId}" contains invalid Item snapshots.`, "track-source");
  }
  return clone(transaction);
}

function normalizedTrackRegistry(actor) {
  const raw = rawProgressionFlags(actor).actorTracks;
  if (raw === undefined || raw === null) return {schemaVersion: AGE_ACTOR_ADVANCEMENT_TRACK_VERSION, tracks: {}};
  if (!isPlainObject(raw) || raw.schemaVersion !== AGE_ACTOR_ADVANCEMENT_TRACK_VERSION || !isPlainObject(raw.tracks)) {
    throw actorError("Actor progression tracks have an unsupported or malformed structure.", "track-source");
  }
  const tracks = {};
  for (const [key, track] of Object.entries(raw.tracks)) {
    safeMapKey(key, "actor progression track id");
    if (!isPlainObject(track)
      || track.schemaVersion !== AGE_ACTOR_ADVANCEMENT_TRACK_VERSION
      || track.trackId !== key
      || !Number.isInteger(track.rank)
      || !Array.isArray(track.transactions)
      || track.transactions.length > AGE_ACTOR_ADVANCEMENT_TRACK_LIMIT) {
      throw actorError(`Actor progression track "${key}" is malformed.`, "track-source");
    }
    const hasDefinitionId = hasOwn(track, "definitionId");
    const hasProfileId = hasOwn(track, "profileId");
    if (hasDefinitionId !== hasProfileId
      || hasDefinitionId && (typeof track.definitionId !== "string" || !track.definitionId.trim()
        || typeof track.profileId !== "string" || !track.profileId.trim())) {
      throw actorError(`Actor progression track "${key}" has a malformed definition binding.`, "track-source");
    }
    const transactions = track.transactions.map(transaction => normalizeTransaction(transaction, key));
    if (new Set(transactions.map(transaction => transaction.id)).size !== transactions.length) {
      throw actorError(`Actor progression track "${key}" contains duplicate transaction ids.`, "track-source");
    }
    for (let index = 1; index < transactions.length; index += 1) {
      if (transactions[index].previousRank !== transactions[index - 1].rank) {
        throw actorError(`Actor progression track "${key}" has a broken rank chain.`, "track-source");
      }
    }
    if (transactions.length && transactions.at(-1).rank !== track.rank) {
      throw actorError(`Actor progression track "${key}" rank does not match its latest transaction.`, "track-source");
    }
    tracks[key] = {
      schemaVersion: AGE_ACTOR_ADVANCEMENT_TRACK_VERSION,
      trackId: key,
      rank: track.rank,
      ...(hasDefinitionId ? {definitionId: track.definitionId, profileId: track.profileId} : {}),
      transactions,
    };
  }
  return {schemaVersion: AGE_ACTOR_ADVANCEMENT_TRACK_VERSION, tracks};
}

export function readActorProgressionTracks(actor) {
  return frozen(normalizedTrackRegistry(actor));
}

function trackDefinitionBinding(track) {
  if (!track) return null;
  if (typeof track.definitionId === "string" && track.definitionId
    && typeof track.profileId === "string" && track.profileId) {
    return {definitionId: track.definitionId, profileId: track.profileId, explicit: true};
  }
  const transaction = [...(track.transactions ?? [])].reverse().find(entry => (
    typeof entry?.definitionId === "string" && entry.definitionId
      && typeof entry?.profileId === "string" && entry.profileId
  ));
  return transaction
    ? {definitionId: transaction.definitionId, profileId: transaction.profileId, explicit: false}
    : null;
}

export function actorProgressionDefinitionBinding(actor, trackId) {
  const id = safeMapKey(trackId, "trackId");
  return frozen(trackDefinitionBinding(normalizedTrackRegistry(actor).tracks[id]));
}

export function actorProgressionRank(actor, trackId, fallback = 0) {
  const id = safeMapKey(trackId, "trackId");
  const registry = normalizedTrackRegistry(actor);
  if (hasOwn(registry.tracks, id)) {
    const semanticLevel = Number(rawActorSource(actor)?.system?.level);
    if (id === "level" && semanticLevel !== registry.tracks[id].rank) {
      if (actorRankTransitions.has(actor) && Number.isInteger(semanticLevel)) return semanticLevel;
      throw actorError("Actor level and its Actor-track registry rank disagree.", "track-source");
    }
    return registry.tracks[id].rank;
  }
  const semantic = Number(id === "level"
    ? rawActorSource(actor)?.system?.level
    : rawProgressionFlags(actor)?.tracks?.[id]);
  return Number.isInteger(semantic) ? semantic : Number(fallback);
}

function targetTrack(actor, definition, rank) {
  const binding = definition?.trackBinding;
  if (!isPlainObject(binding) || binding.kind !== "actor") throw actorError("Definition is not bound to an Actor track.", "track-binding");
  const trackId = safeMapKey(binding.trackId, "trackBinding.trackId");
  const fallback = Math.max(0, Number(definition.rank?.minimum ?? 1) - 1);
  const registry = normalizedTrackRegistry(actor);
  const trackWasAbsent = !hasOwn(registry.tracks, trackId);
  const existingTrack = trackWasAbsent ? null : registry.tracks[trackId];
  const definitionBinding = trackDefinitionBinding(existingTrack);
  if (definitionBinding && (
    definitionBinding.definitionId !== definition.id
      || definitionBinding.profileId !== definition.profileId
  )) {
    throw actorError(
      `Actor progression track "${trackId}" is bound to another progression path.`,
      "definition-binding",
      {trackId, expected: definitionBinding, received: {definitionId: definition.id, profileId: definition.profileId}},
    );
  }
  const actorTracksWasAbsent = !hasOwn(rawProgressionFlags(actor), "actorTracks");
  const progressionWasAbsent = !hasOwn(rawAgeSystemFlags(actor), "progression");
  const semanticState = semanticTrackState(actor, trackId);
  const currentRank = actorProgressionRank(actor, trackId, fallback);
  if (currentRank + 1 !== Number(rank)) {
    throw actorError("Target Actor-track rank changed after compilation.", "target-rank", {trackId, currentRank, targetRank: rank});
  }
  if (!trackWasAbsent && registry.tracks[trackId].transactions.length >= AGE_ACTOR_ADVANCEMENT_TRACK_LIMIT) {
    throw actorError(`Actor progression track "${trackId}" reached its ${AGE_ACTOR_ADVANCEMENT_TRACK_LIMIT}-transaction safety limit.`, "track-limit");
  }
  return {
    trackId,
    currentRank,
    trackWasAbsent,
    actorTracksWasAbsent,
    progressionWasAbsent,
    definitionBindingWasAbsent: !definitionBinding?.explicit,
    semanticTrackState: semanticState,
  };
}

function normalizeAllocations(preview, requested, actor, profileSnapshot) {
  if (!isPlainObject(requested)) throw actorError("Ability allocations must be a plain object.", "ability-binding");
  const effects = preview.resolvedEffects.filter(effect => effect.type === "ability.allocate");
  const unknown = Object.keys(requested).filter(operationId => !effects.some(effect => effect.operationId === operationId));
  if (unknown.length) throw actorError(`Unknown ability allocation operation(s): ${unknown.join(", ")}.`, "ability-binding");
  const abilities = sourceSystem(actor).abilities ?? {};
  const profileAbilities = Array.isArray(profileSnapshot?.ability?.ids)
    ? profileSnapshot.ability.ids.map(String).filter(id => isPlainObject(abilities[id]))
    : [];
  if (!profileAbilities.length) throw actorError("The active rules profile has no eligible Actor abilities.", "ability-binding");
  const allocations = {};
  const eligibleByOperation = {};
  for (const effect of effects) {
    const eligible = [...new Set((effect.eligibleAbilityIds ?? profileAbilities).map(String))]
      .filter(id => profileAbilities.includes(id));
    if (!eligible.length || eligible.some(id => !isPlainObject(abilities[id]))) {
      throw actorError(`Ability allocation "${effect.operationId}" has invalid eligible abilities.`, "ability-binding");
    }
    const values = requested[effect.operationId] ?? (effects.length === 1 ? requested : null);
    if (!isPlainObject(values)) throw actorError(`Ability allocation "${effect.operationId}" is not pinned.`, "ability-binding");
    let total = 0;
    const normalized = {};
    for (const [abilityId, raw] of Object.entries(values)) {
      const amount = finite(raw, `ability allocation ${abilityId}`, {integer: true, minimum: 0});
      if (!amount) continue;
      if (!eligible.includes(abilityId)) throw actorError(`Ability "${abilityId}" is not eligible.`, "ability-binding");
      if (amount) normalized[abilityId] = amount;
      total += amount;
    }
    if (total !== finite(effect.amount, "ability.allocate amount", {integer: true, minimum: 0})) {
      throw actorError(`Ability allocations for "${effect.operationId}" do not match the signed amount.`, "ability-binding");
    }
    allocations[effect.operationId] = normalized;
    eligibleByOperation[effect.operationId] = eligible;
  }
  return {allocations, eligibleByOperation};
}

async function bindSources(preview, definition, actor, sourceResolver) {
  const refs = new Map(definition.sourceRefs.map(ref => [ref.id, ref]));
  const result = [];
  for (const effect of preview.resolvedEffects.filter(effect => effect.type === "item.acquire" || effect.type === "item.advance" && effect.sourceRefId)) {
    const ref = refs.get(effect.sourceRefId);
    if (!ref?.uuid) throw actorError(`SourceRef "${effect.sourceRefId}" has no UUID.`, "source-binding");
    if (effect.type === "item.acquire" && (effect.quantity ?? 1) !== 1) {
      throw actorError("Actor-track item.acquire supports quantity 1 only.", "unsupported-effect");
    }
    const document = await sourceResolver(ref.uuid, {preview, effect, sourceRef: ref});
    if (!document) throw actorError(`Unable to resolve Item source "${ref.uuid}".`, "source-binding");
    const snapshot = itemSource(document);
    const trait = traitForItem(document);
    result.push({
      operationId: effect.operationId,
      sourceRefId: ref.id,
      uuid: ref.uuid,
      type: snapshot.type,
      trait,
      normalizedName: normalizedName(snapshot.name),
      digest: await digestCanonicalJson(snapshot),
      snapshot,
    });
  }
  return result;
}

async function bindTargets(preview, actor, requested, sourceBindings) {
  if (!isPlainObject(requested)) throw actorError("Progression targets must be a plain object.", "target-binding");
  const sourceMap = new Map(sourceBindings.map(entry => [entry.operationId, entry]));
  const effects = preview.resolvedEffects.filter(effect => effect.type === "item.advance" || effect.type === "item.acquire");
  const unknown = Object.keys(requested).filter(operationId => !effects.some(effect => effect.operationId === operationId));
  if (unknown.length) throw actorError(`Unknown progression target operation(s): ${unknown.join(", ")}.`, "target-binding");
  const bindings = [];
  for (const effect of effects) {
    const source = sourceMap.get(effect.operationId) ?? null;
    if (effect.type === "item.acquire" && source?.trait === "focus") {
      const duplicates = matchingOwnedSourceItems(actor, source);
      if (duplicates.length) {
        throw actorError(
          `${source.snapshot?.name || "Selected Focus"} is already owned; choose a different Focus. This acquisition cannot improve an owned Focus.`,
          "item-already-owned",
          {
            operationId: effect.operationId,
            sourceRefId: source.sourceRefId,
            duplicateIds: duplicates.map(item => String(item.id ?? item._id)),
          },
        );
      }
    }
    const raw = requested[effect.operationId];
    const itemId = isPlainObject(raw) ? raw.itemId : raw;
    if (!itemId) {
      if (effect.type === "item.advance") throw actorError(`Item advancement "${effect.operationId}" has no target.`, "target-binding");
      continue;
    }
    const item = ownedItem(actor, itemId);
    if (!item) throw actorError(`Progression target "${itemId}" is not owned.`, "target-binding");
    const trait = traitForItem(item);
    const expectedTrait = effect.type === "item.advance" ? effect.trait : source?.trait;
    if (trait !== expectedTrait || !PROGRESSABLE_TRAITS.has(trait)) {
      throw actorError(`Progression target "${itemId}" has the wrong or non-progressable trait.`, "target-binding");
    }
    if ((effect.type === "item.acquire" || effect.sourceRefId) && (!source || !itemMatchesSource(item, source))) {
      throw actorError(`Progression target "${itemId}" does not match the pinned source Item.`, "target-binding");
    }
    const snapshot = itemSource(item);
    bindings.push({
      operationId: effect.operationId,
      itemId: String(item.id ?? item._id),
      trait,
      type: snapshot.type,
      sourceRefId: source?.sourceRefId ?? null,
      sourceUuid: source?.uuid ?? null,
      digest: await digestCanonicalJson(snapshot),
    });
  }
  return bindings;
}

function actorMutationPaths() {
  return [
    ["name"], ["system", "level"], ["system", "classBonuses"],
    ["system", "wgroups"], ["system", "abilities"], ["system", "health"],
    ["system", "powerPoints"], ["system", "conviction"],
    ["system", "currency"], ...Object.values(IDENTITY_PATHS),
  ];
}

function snapshotState(root, path) {
  if (!hasPath(root, path)) return {exists: false};
  return {exists: true, value: clone(getPath(root, path))};
}

function stateMatches(root, path, state) {
  if (hasPath(root, path) !== state.exists) return false;
  return !state.exists || same(getPath(root, path), state.value);
}

function snapshotsForPaths(beforeSource, afterSource) {
  const before = {};
  const after = {};
  for (const path of actorMutationPaths()) {
    const key = snapshotPathKey(path);
    const left = snapshotState(beforeSource, path);
    const right = snapshotState(afterSource, path);
    if (!same(left, right)) {
      before[key] = left;
      after[key] = right;
    }
  }
  return {before, after};
}

function snapshotForKeys(source, keys) {
  return Object.fromEntries(keys.map(key => [key, snapshotState(source, snapshotPath(key))]));
}

function updateFromSnapshot(snapshot) {
  const update = {};
  for (const [key, state] of Object.entries(snapshot)) {
    const path = snapshotDottedPath(key);
    if (state.exists) update[path] = atomicValue(state.value);
    else Object.assign(update, deletionUpdate(path));
  }
  return update;
}

function incrementResource(source, resource, amount) {
  const system = source.system;
  if (resource === "currency") {
    system.currency = finite(system.currency ?? 0, "system.currency") + amount;
    return;
  }
  if (!DIRECT_RESOURCES.has(resource)) throw actorError(`Unsupported resource "${resource}".`, "unsupported-effect");
  const data = isPlainObject(system[resource]) ? system[resource] : (system[resource] = {});
  data.value = finite(data.value ?? 0, `${resource}.value`) + amount;
}

function addLanguage(source, rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) throw actorError("language.add requires a non-empty language.", "unsupported-effect");
  const languages = String(source.system.language ?? "")
    .split(/[,;\n]/)
    .map(entry => entry.trim())
    .filter(Boolean);
  if (!languages.some(entry => entry.localeCompare(value, undefined, {sensitivity: "accent"}) === 0)) languages.push(value);
  source.system.language = languages.join(", ");
}

function abilityCost(nextScore) {
  const costs = ageSystem?.advData?.abilityScoreCost;
  if (!Array.isArray(costs) || !costs.length) return 1;
  const index = Math.max(0, Math.min(costs.length - 1, Number(nextScore) - 1));
  return Number(costs[index]) || 1;
}

function applyActorEffects({preview, actor, binding, transactionId, createItemId = documentIdFactory}) {
  const beforeSource = rawActorSource(actor);
  const afterSource = clone(beforeSource);
  const system = afterSource.system;
  const summaries = [];
  const sourceMap = new Map(binding.sourceBindings.map(entry => [entry.operationId, entry]));
  const targetMap = new Map(binding.targetBindings.map(entry => [entry.operationId, entry]));
  const createData = [];
  const updateMap = new Map();
  const resourceDeltas = {};
  const bonusDeltas = {};

  const progressTarget = target => {
    const item = ownedItem(actor, target.itemId);
    if (!item) throw actorError(`Item target "${target.itemId}" is no longer owned.`, "target-binding");
    const existing = updateMap.get(target.itemId);
    const beforeSystem = existing?.beforeSystem ?? sourceSystem(item);
    const currentSystem = existing?.afterSystem ?? beforeSystem;
    const progressed = ClassAdvancementService.progressItemSystem(item.type, currentSystem, target.trait);
    updateMap.set(target.itemId, {id: target.itemId, beforeSystem, afterSystem: progressed.system});
  };

  for (const effect of preview.resolvedEffects) {
    switch (effect.type) {
      case "identity.set":
        if (effect.field === "name") afterSource.name = String(effect.value);
        else if (IDENTITY_PATHS[effect.field]) setPath(afterSource, IDENTITY_PATHS[effect.field], effect.value);
        else throw actorError(`Unsupported identity field "${effect.field}".`, "unsupported-effect");
        break;
      case "resource.gain":
        {
          const amount = finite(effect.amount, `${effect.resource} amount`);
          incrementResource(afterSource, effect.resource, amount);
          resourceDeltas[effect.resource] = finite(resourceDeltas[effect.resource] ?? 0, `${effect.resource} delta`) + amount;
        }
        break;
      case "classBonus.gain": {
        const amount = finite(effect.amount, `${effect.bonus} amount`);
        const bonuses = isPlainObject(system.classBonuses) ? system.classBonuses : (system.classBonuses = {});
        bonuses[effect.bonus] = finite(bonuses[effect.bonus] ?? 0, `classBonuses.${effect.bonus}`) + amount;
        bonusDeltas[effect.bonus] = finite(bonusDeltas[effect.bonus] ?? 0, `${effect.bonus} bonus delta`) + amount;
        break;
      }
      case "ability.allocate": {
        const allocations = binding.abilityAllocations[effect.operationId] ?? {};
        for (const [abilityId, amount] of Object.entries(allocations)) {
          const ability = system.abilities?.[abilityId];
          if (!isPlainObject(ability)) throw actorError(`Actor has no ability "${abilityId}".`, "ability-binding");
          let residual = finite(ability.advances ?? 0, `${abilityId}.advances`, {minimum: 0}) + amount;
          let score = finite(ability.value ?? 0, `${abilityId}.value`);
          while (residual >= abilityCost(score + 1)) { residual -= abilityCost(score + 1); score += 1; }
          ability.advances = residual;
          ability.value = score;
        }
        break;
      }
      case "ability.setPrimary": {
        const ability = system.abilities?.[effect.abilityId];
        if (!isPlainObject(ability)) throw actorError(`Actor has no ability "${effect.abilityId}".`, "ability-binding");
        ability.primary = true;
        break;
      }
      case "weaponGroup.add":
        if (!Array.isArray(system.wgroups)) system.wgroups = [];
        if (!system.wgroups.includes(effect.weaponGroupId)) system.wgroups.push(effect.weaponGroupId);
        break;
      case "language.add":
        addLanguage(afterSource, effect.value);
        break;
      case "item.acquire": {
        const target = targetMap.get(effect.operationId);
        if (target) {
          progressTarget(target);
        } else {
          const source = sourceMap.get(effect.operationId);
          if (!source) throw actorError(`Item effect "${effect.operationId}" has no pinned source.`, "source-binding");
          const data = cleanCreationSource(source.snapshot);
          data._id = String(createItemId());
          data.flags["age-system"] = {
            ...(data.flags["age-system"] ?? {}),
            actorProgressionGrant: true,
            actorProgressionTransactionId: transactionId,
            actorProgressionTrackId: binding.trackBinding.trackId,
            progressionSourceRefId: source.sourceRefId,
            progressionSourceUuid: source.uuid,
            progressionOperationId: effect.operationId,
          };
          createData.push(data);
        }
        break;
      }
      case "item.advance": {
        const target = targetMap.get(effect.operationId);
        if (!target) throw actorError(`Item effect "${effect.operationId}" has no pinned target.`, "target-binding");
        progressTarget(target);
        break;
      }
      case "track.setRank":
        if (effect.trackId !== binding.trackBinding.trackId || effect.rank !== preview.rank) {
          throw actorError("track.setRank does not match the signed Actor track.", "track-binding");
        }
        // `level` is the one explicit Actor-track mirror used by classless
        // rules profiles and by creation. Other Actor tracks remain flag-only.
        if (binding.trackBinding.trackId === "level") system.level = Number(preview.rank);
        break;
      case "summary.add": summaries.push(effect.label ?? effect.entryId); break;
      default: throw actorError(`Actor-backed advancement cannot execute effect "${effect.type}".`, "unsupported-effect");
    }
  }

  const snapshots = snapshotsForPaths(beforeSource, afterSource);
  return {
    beforeSource,
    afterSource,
    ...snapshots,
    createData,
    updatedItems: [...updateMap.values()],
    resourceDeltas,
    bonusDeltas,
    summaries,
  };
}

async function verifySourceBindings(binding, preview, actor, sourceResolver) {
  for (const source of binding.sourceBindings ?? []) {
    const document = await sourceResolver(source.uuid, {preview, binding: source});
    if (!document
      || traitForItem(document) !== source.trait
      || String(document.type ?? document?._source?.type ?? "") !== source.type
      || await digestCanonicalJson(itemSource(document)) !== source.digest) {
      throw actorError(`Item source "${source.uuid}" changed after preview.`, "source-stale");
    }
  }
  const sourceMap = new Map((binding.sourceBindings ?? []).map(entry => [entry.operationId, entry]));
  for (const target of binding.targetBindings ?? []) {
    const item = ownedItem(actor, target.itemId);
    const source = sourceMap.get(target.operationId) ?? null;
    if (!item
      || traitForItem(item) !== target.trait
      || String(item.type ?? item?._source?.type ?? "") !== target.type
      || source && !itemMatchesSource(item, source)
      || await digestCanonicalJson(itemSource(item)) !== target.digest) {
      throw actorError(`Owned progression target "${target.itemId}" changed after preview.`, "target-stale");
    }
  }
}

function nextRegistry(actor, transaction) {
  const registry = normalizedTrackRegistry(actor);
  const exists = hasOwn(registry.tracks, transaction.trackId);
  if (exists === transaction.trackWasAbsent) {
    throw actorError("Actor progression track presence changed before commit.", "track-stale");
  }
  const existing = exists ? registry.tracks[transaction.trackId] : {
    schemaVersion: AGE_ACTOR_ADVANCEMENT_TRACK_VERSION,
    trackId: transaction.trackId,
    rank: transaction.previousRank,
    transactions: [],
  };
  if (existing.rank !== transaction.previousRank || existing.transactions.some(entry => entry.id === transaction.id)) {
    throw actorError("Actor progression track changed before commit.", "track-stale");
  }
  const binding = trackDefinitionBinding(existing);
  if (binding && (binding.definitionId !== transaction.definitionId || binding.profileId !== transaction.profileId)) {
    throw actorError("Actor progression definition binding changed before commit.", "definition-binding");
  }
  existing.definitionId = transaction.definitionId;
  existing.profileId = transaction.profileId;
  existing.rank = transaction.rank;
  existing.transactions.push(clone(transaction));
  if (existing.transactions.length > AGE_ACTOR_ADVANCEMENT_TRACK_LIMIT) {
    throw actorError("Actor progression transaction history is full.", "track-limit");
  }
  registry.tracks[transaction.trackId] = existing;
  return registry;
}

function actorTrackUpdate(registry, {remove = false, removeProgression = false} = {}) {
  if (removeProgression) return deletionUpdate("flags.age-system.progression");
  return remove
    ? deletionUpdate("flags.age-system.progression.actorTracks")
    : {"flags.age-system.progression.actorTracks": atomicValue(registry)};
}

function previousRegistry(actor, transaction) {
  const registry = normalizedTrackRegistry(actor);
  const track = registry.tracks[transaction.trackId];
  if (!track || track.transactions.at(-1)?.id !== transaction.id || track.rank !== transaction.rank) {
    throw actorError("Only the latest Actor-track transaction can be rolled back.", "unsafe-undo");
  }
  track.transactions.pop();
  if (transaction.trackWasAbsent) delete registry.tracks[transaction.trackId];
  else {
    track.rank = transaction.previousRank;
    if (transaction.definitionBindingWasAbsent === true) {
      delete track.definitionId;
      delete track.profileId;
    }
  }
  if (transaction.actorTracksWasAbsent && Object.keys(registry.tracks).length) {
    throw actorError("Actor progression registry cannot restore its prior absence safely.", "unsafe-undo");
  }
  return {
    registry,
    remove: transaction.actorTracksWasAbsent,
    // A first-track transaction may be undone after another feature has
    // legitimately added progression metadata. Remove the parent only when
    // actorTracks is still its sole key; otherwise delete actorTracks alone.
    removeProgression: transaction.progressionWasAbsent
      && Object.keys(rawProgressionFlags(actor)).every(key => key === "actorTracks"),
  };
}

function actorSnapshotsMatch(actor, snapshot) {
  const source = rawActorSource(actor);
  return Object.entries(snapshot).every(([key, state]) => stateMatches(source, snapshotPath(key), state));
}

function rawActorTracks(actor) {
  return rawProgressionFlags(actor)?.actorTracks;
}

function registryMatches(actor, registry, {remove = false, removeProgression = false} = {}) {
  if (removeProgression) return !hasOwn(rawAgeSystemFlags(actor), "progression");
  const raw = rawActorTracks(actor);
  return remove ? raw === undefined : same(raw, registry);
}

function createdOriginMatches(item, transaction, expectedData = null) {
  if (!item) return false;
  const source = itemSource(item);
  const flags = source.flags?.["age-system"] ?? {};
  if (flags.actorProgressionGrant !== true
    || flags.actorProgressionTransactionId !== transaction.id
    || flags.actorProgressionTrackId !== transaction.trackId) return false;
  return expectedData === null || same(source, expectedData);
}

async function deleteTransactionItems(actor, transaction, entries, options) {
  const ids = [];
  for (const entry of entries) {
    const item = ownedItem(actor, entry.id);
    if (!item) continue;
    if (!createdOriginMatches(item, transaction, entry.afterData ?? null)) {
      throw actorError(`Transaction-created Item "${entry.id}" no longer has its exact signed origin.`, "transaction-recovery");
    }
    ids.push(entry.id);
  }
  let callError = null;
  if (ids.length) {
    try { await actor.deleteEmbeddedDocuments("Item", ids, options); } catch (error) { callError = error; }
  }
  if (entries.some(entry => ownedItem(actor, entry.id))) {
    throw actorError("Transaction-created Items were not deleted exactly.", "transaction-recovery", {cause: errorSummary(callError)});
  }
  // Foundry hooks can accept the authoritative deletion and still reject the
  // caller promise. Exact raw-source absence is the success criterion.
}

async function applyItemUpdatesExactly(actor, entries, {forward, options}) {
  if (!entries.length) return;
  const desiredKey = forward ? "afterSystem" : "beforeSystem";
  const alternateKey = forward ? "beforeSystem" : "afterSystem";
  const payload = entries.map(entry => ({_id: entry.id, system: atomicValue(entry[desiredKey])}));
  let callError = null;
  try { await actor.updateEmbeddedDocuments("Item", payload, options); } catch (error) { callError = error; }
  const states = entries.map(entry => {
    const item = ownedItem(actor, entry.id);
    if (!item) return "missing";
    const current = sourceSystem(item);
    if (same(current, entry[desiredKey])) return "desired";
    if (same(current, entry[alternateKey])) return "alternate";
    return "third";
  });
  if (states.every(state => state === "desired")) return;
  const partiallyApplied = entries.filter((_entry, index) => states[index] === "desired");
  if (partiallyApplied.length) {
    try {
      await actor.updateEmbeddedDocuments("Item", partiallyApplied.map(entry => ({_id: entry.id, system: atomicValue(entry[alternateKey])})), {
        ...options,
        ageProgressionRecovery: true,
      });
    } catch (recoveryError) {
      throw actorError("Known partial owned Item updates could not be recovered.", "transaction-recovery", {
        states,
        cause: errorSummary(callError),
        recoveryError: errorSummary(recoveryError),
      });
    }
  }
  const knownRestored = entries.every((entry, index) => {
    if (states[index] !== "desired" && states[index] !== "alternate") return true;
    const item = ownedItem(actor, entry.id);
    return item && same(sourceSystem(item), entry[alternateKey]);
  });
  if (!knownRestored) {
    throw actorError("Known partial owned Item updates were not restored exactly.", "transaction-recovery", {states});
  }
  if (states.some(state => state === "missing" || state === "third")) {
    throw actorError("Owned Item updates entered an unrecognized partial state; known siblings were restored.", "transaction-recovery", {states});
  }
  const restored = entries.every(entry => {
    const item = ownedItem(actor, entry.id);
    return item && same(sourceSystem(item), entry[alternateKey]);
  });
  if (!restored) throw actorError("Partial owned Item updates could not be recovered exactly.", "transaction-recovery");
  throw callError ?? actorError("Owned Item updates did not persist completely.", "transaction-persistence");
}

async function applyActorUpdateExactlyDuringTransition(actor, {
  desiredSnapshot,
  desiredRegistry,
  desiredRegistryOptions,
  alternateSnapshot,
  alternateRegistry,
  alternateRegistryOptions,
  options,
}) {
  const callErrors = [];
  const applyStage = async (update, postcondition, stageOptions) => {
    if (!Object.keys(update).length || postcondition()) return;
    let callError = null;
    try { await actor.update(update, stageOptions); } catch (error) { callError = error; }
    // Foundry hooks can persist the requested update and still reject the
    // caller promise. The raw-source postcondition is authoritative.
    if (postcondition()) return;
    if (callError) callErrors.push(callError);
    else callErrors.push(actorError("Actor advancement update did not persist.", "transaction-persistence"));
  };

  // Do not mix TypeDataModel changes and DocumentFlagsField operators in one
  // Actor update. Foundry 14 can partially commit that shape (observed when an
  // Actor-backed `level` track updates system.level and actorTracks together).
  // Each stage is independently postcondition-checked and the surrounding
  // Actor lock plus exact recovery preserves transaction semantics.
  await applyStage(
    updateFromSnapshot(desiredSnapshot),
    () => actorSnapshotsMatch(actor, desiredSnapshot),
    {...options, ageProgressionStage: "system"}
  );
  if (actorSnapshotsMatch(actor, desiredSnapshot)) {
    await applyStage(
      actorTrackUpdate(desiredRegistry, desiredRegistryOptions),
      () => registryMatches(actor, desiredRegistry, desiredRegistryOptions),
      {...options, ageProgressionStage: "track"}
    );
  }
  if (actorSnapshotsMatch(actor, desiredSnapshot) && registryMatches(actor, desiredRegistry, desiredRegistryOptions)) return;
  if (actorSnapshotsMatch(actor, alternateSnapshot) && registryMatches(actor, alternateRegistry, alternateRegistryOptions)) {
    throw callErrors[0] ?? actorError("Actor advancement update did not persist.", "transaction-persistence");
  }
  const recoveryErrors = [];
  try {
    await applyStage(
      updateFromSnapshot(alternateSnapshot),
      () => actorSnapshotsMatch(actor, alternateSnapshot),
      {...options, ageProgressionRecovery: true, ageProgressionStage: "system"}
    );
  } catch (error) { recoveryErrors.push(error); }
  try {
    await applyStage(
      actorTrackUpdate(alternateRegistry, alternateRegistryOptions),
      () => registryMatches(actor, alternateRegistry, alternateRegistryOptions),
      {...options, ageProgressionRecovery: true, ageProgressionStage: "track"}
    );
  } catch (error) { recoveryErrors.push(error); }
  if (recoveryErrors.length) {
    throw actorError("Actor update entered a partial state and recovery failed.", "transaction-recovery", {
      cause: errorSummary(callErrors[0]), recoveryErrors: recoveryErrors.map(errorSummary),
    });
  }
  if (!actorSnapshotsMatch(actor, alternateSnapshot) || !registryMatches(actor, alternateRegistry, alternateRegistryOptions)) {
    throw actorError("Actor update entered a partial state and was not restored exactly.", "transaction-recovery");
  }
  throw callErrors[0] ?? actorError("Actor advancement update partially persisted and was recovered.", "transaction-persistence");
}

async function applyActorUpdateExactly(actor, update) {
  actorRankTransitions.add(actor);
  try {
    return await applyActorUpdateExactlyDuringTransition(actor, update);
  } finally {
    actorRankTransitions.delete(actor);
  }
}

async function applyTransaction(actor, transaction, mutation) {
  let createdEntries = [];
  let itemsUpdated = false;
  let actorAttempted = false;
  const beforeRegistry = normalizedTrackRegistry(actor);
  const beforeRegistryOptions = {
    remove: transaction.actorTracksWasAbsent,
    removeProgression: transaction.progressionWasAbsent,
  };
  try {
    if (mutation.createData.length) {
      for (const data of mutation.createData) {
        if (ownedItem(actor, data._id)) throw actorError(`Generated Item id "${data._id}" is already occupied.`, "transaction-create-id");
      }
      let returned = [];
      let createError = null;
      try {
        returned = await actor.createEmbeddedDocuments("Item", mutation.createData, {keepId: true, ageProgression: true});
      } catch (error) { createError = error; }
      const discovered = mutation.createData.map(data => ownedItem(actor, data._id)).filter(Boolean);
      const requestedById = new Map(mutation.createData.map(data => [String(data._id), portableCreationSource(data)]));
      const exactSources = discovered.every(item => {
        const requested = requestedById.get(String(item.id ?? item._id));
        return requested && createdOriginMatches(item, transaction, requested);
      });
      // Foundry hooks may apply the exact deterministic sources and still
      // reject the caller promise or return an unexpected wrapper. Raw owned
      // sources at every requested id are the authoritative postcondition.
      if (discovered.length !== mutation.createData.length || !exactSources) {
        const partial = discovered
          .filter(item => createdOriginMatches(item, transaction))
          .map(item => ({id: String(item.id ?? item._id), afterData: itemSource(item)}));
        // Always remove every source we can prove this transaction created,
        // even when another expected id is occupied by an unknown document.
        if (partial.length) await deleteTransactionItems(actor, transaction, partial, {ageProgressionRecovery: true});
        if (discovered.length !== partial.length) {
          throw actorError("Item creation collided with an unrecognized source state; recognized partial Items were removed.", "transaction-recovery", {cause: errorSummary(createError)});
        }
        throw createError ?? actorError("Item creation did not persist the exact requested portable sources.", "transaction-persistence");
      }
      createdEntries = discovered.map(item => {
        const id = String(item.id ?? item._id);
        return {id, afterData: clone(requestedById.get(id))};
      });
      transaction.createdItems = clone(createdEntries);
    }
    if (mutation.updatedItems.length) {
      await applyItemUpdatesExactly(actor, transaction.updatedItems, {forward: true, options: {ageProgression: true}});
      itemsUpdated = true;
    }
    const registry = nextRegistry(actor, transaction);
    actorAttempted = true;
    await applyActorUpdateExactly(actor, {
      desiredSnapshot: transaction.after,
      desiredRegistry: registry,
      desiredRegistryOptions: {remove: false},
      alternateSnapshot: transaction.before,
      alternateRegistry: beforeRegistry,
      alternateRegistryOptions: beforeRegistryOptions,
      options: {ageProgression: true},
    });
    return transaction;
  } catch (error) {
    const recoveryErrors = [];
    try {
      if (actorAttempted && (!actorSnapshotsMatch(actor, transaction.before) || !registryMatches(actor, beforeRegistry, beforeRegistryOptions))) {
        const currentSnapshot = snapshotForKeys(rawActorSource(actor), Object.keys(transaction.before));
        const currentRegistry = normalizedTrackRegistry(actor);
        await applyActorUpdateExactly(actor, {
          desiredSnapshot: transaction.before,
          desiredRegistry: beforeRegistry,
          desiredRegistryOptions: beforeRegistryOptions,
          alternateSnapshot: currentSnapshot,
          alternateRegistry: currentRegistry,
          alternateRegistryOptions: {
            remove: !hasOwn(rawProgressionFlags(actor), "actorTracks"),
            removeProgression: !hasOwn(rawAgeSystemFlags(actor), "progression"),
          },
          options: {ageProgressionRecovery: true},
        });
        if (!actorSnapshotsMatch(actor, transaction.before) || !registryMatches(actor, beforeRegistry, beforeRegistryOptions)) {
          throw actorError("Actor source was not restored exactly.", "transaction-recovery");
        }
      }
    } catch (recovery) { recoveryErrors.push(errorSummary(recovery)); }
    try {
      if (itemsUpdated) await applyItemUpdatesExactly(actor, transaction.updatedItems, {forward: false, options: {ageProgressionRecovery: true}});
    } catch (recovery) { recoveryErrors.push(errorSummary(recovery)); }
    try {
      if (createdEntries.length) await deleteTransactionItems(actor, transaction, createdEntries, {ageProgressionRecovery: true});
    } catch (recovery) { recoveryErrors.push(errorSummary(recovery)); }
    if (recoveryErrors.length) throw actorError("Actor advancement failed and exact recovery also failed.", "transaction-recovery", {cause: errorSummary(error), recoveryErrors});
    throw error;
  }
}

function latestTransaction(actor, trackId) {
  return normalizedTrackRegistry(actor).tracks[trackId]?.transactions?.at(-1) ?? null;
}

function transactionForReceipt(actor, receipt, context = {}) {
  const trackId = context.execution === "actor-transaction-v1" && context.trackId
    ? safeMapKey(context.trackId, "receipt trackId")
    : Object.keys(normalizedTrackRegistry(actor).tracks).find(id => latestTransaction(actor, id)?.id === receipt?.transactionId);
  const transaction = trackId ? latestTransaction(actor, trackId) : null;
  return {trackId, transaction};
}

function undoConflicts(actor, user, receipt, context) {
  const reasons = [];
  const validation = validateProgressionReceiptV1(receipt);
  if (!validation.valid || receipt.kind !== "rank.advance" || receipt.state !== "committed") reasons.push("invalid-receipt");
  if (!documentOwner(actor, user)) reasons.push("permission");
  if (receipt?.actorUuid !== actor?.uuid) reasons.push("actor-mismatch");
  if (context?.execution !== "actor-transaction-v1") reasons.push("execution-mismatch");
  const {trackId, transaction} = transactionForReceipt(actor, receipt, context);
  if (!trackId || context?.trackId && context.trackId !== trackId) reasons.push("track-mismatch");
  if (!transaction || transaction.id !== receipt?.transactionId) reasons.push("not-latest-transaction");
  if (transaction) {
    if (transaction.trackId !== "level" && !same(semanticTrackState(actor, transaction.trackId), transaction.semanticTrackState)) {
      reasons.push("semantic-track");
    }
    const current = rawActorSource(actor);
    for (const [key, expected] of Object.entries(transaction.after)) {
      const path = snapshotPath(key);
      const dottedPath = path.join(".");
      if (RESOURCE_PATHS.has(dottedPath) && hasOwn(transaction.resourceDeltas, path.at(-1))) continue;
      if (!stateMatches(current, path, expected)) reasons.push(`actor-field:${dottedPath}`);
    }
    for (const entry of transaction.updatedItems) {
      const item = ownedItem(actor, entry.id);
      if (!item || !same(sourceSystem(item), entry.afterSystem)) reasons.push(`updated-item:${entry.id}`);
    }
    for (const entry of transaction.createdItems) {
      const item = ownedItem(actor, entry.id);
      if (!item || !same(itemSource(item), entry.afterData)) reasons.push(`created-item:${entry.id}`);
    }
  }
  try {
    const persisted = readProgressionReceiptJournal(actor).entries.find(entry => entry.receipt.id === receipt?.id) ?? null;
    const expectedContext = {execution: "actor-transaction-v1", trackId};
    if (!persisted || !same(persisted.receipt, receipt) || !same(persisted.context, expectedContext)) reasons.push("receipt-journal-mismatch");
  } catch {
    reasons.push("receipt-journal-invalid");
  }
  return {reasons: [...new Set(reasons)], trackId, transaction};
}

function resourceAwareUndoSnapshot(actor, transaction) {
  const snapshot = clone(transaction.before);
  const current = rawActorSource(actor);
  const resources = new Set([
    ...Object.keys(transaction.resourceDeltas),
    ...Object.keys(transaction.bonusDeltas ?? {}).filter(resource => DIRECT_RESOURCES.has(resource)),
  ]);
  for (const resource of resources) {
    const delta = Number(transaction.resourceDeltas?.[resource] ?? 0);
    const path = resource === "currency" ? ["system", "currency"] : ["system", resource];
    const key = snapshotPathKey(path);
    const currentState = snapshotState(current, path);
    if (!currentState.exists) throw actorError(`Resource "${resource}" is missing during undo.`, "unsafe-undo");
    if (resource === "currency") {
      const value = finite(currentState.value, "currency undo") - delta;
      snapshot[key] = {exists: true, value};
      continue;
    }
    if (!isPlainObject(currentState.value)) throw actorError(`Resource "${resource}" is malformed during undo.`, "unsafe-undo");
    const data = clone(currentState.value);
    const minimum = Number.isFinite(Number(data.min)) ? Number(data.min) : 0;
    const bonusDelta = Number(transaction.bonusDeltas?.[resource] ?? 0);
    const classBonusesKey = snapshotPathKey(["system", "classBonuses"]);
    const beforeBonuses = transaction.before[classBonusesKey]?.exists
      ? transaction.before[classBonusesKey].value
      : current.system?.classBonuses;
    const sourceMaximum = Number(data.set ?? 0) + Number(data.mod ?? 0) + Number(beforeBonuses?.[resource] ?? 0);
    const derivedMaximum = Number(actor?.system?.[resource]?.max);
    const recordedMaximum = Number(data.max);
    const candidates = [sourceMaximum];
    if (Number.isFinite(derivedMaximum)) candidates.push(derivedMaximum - bonusDelta);
    if (Number.isFinite(recordedMaximum)) candidates.push(recordedMaximum - bonusDelta);
    const maximumCandidate = Math.max(...candidates.filter(Number.isFinite));
    const maximum = Math.max(minimum, maximumCandidate);
    data.value = Math.max(minimum, Math.min(maximum, finite(data.value, `${resource}.value undo`) - delta));
    snapshot[key] = {exists: true, value: data};
  }
  return snapshot;
}

async function rollbackTransaction(actor, transaction, {preserveInterveningResources = false} = {}) {
  const forwardRegistry = normalizedTrackRegistry(actor);
  const restored = previousRegistry(actor, transaction);
  const forwardSnapshot = snapshotForKeys(rawActorSource(actor), Object.keys(transaction.after));
  const restoreSnapshot = preserveInterveningResources ? resourceAwareUndoSnapshot(actor, transaction) : transaction.before;
  const restoreItems = transaction.updatedItems.map(entry => ({_id: entry.id, system: clone(entry.beforeSystem)}));
  let itemsRestored = false;
  let actorRestored = false;
  let createdDeleteAttempted = false;
  try {
    if (restoreItems.length) {
      await applyItemUpdatesExactly(actor, transaction.updatedItems, {forward: false, options: {ageProgressionUndo: true}});
      itemsRestored = true;
    }
    await applyActorUpdateExactly(actor, {
      desiredSnapshot: restoreSnapshot,
      desiredRegistry: restored.registry,
      desiredRegistryOptions: {remove: restored.remove, removeProgression: restored.removeProgression},
      alternateSnapshot: forwardSnapshot,
      alternateRegistry: forwardRegistry,
      alternateRegistryOptions: {remove: false},
      options: {ageProgressionUndo: true},
    });
    actorRestored = true;
    if (transaction.createdItems.length) {
      createdDeleteAttempted = true;
      await deleteTransactionItems(actor, transaction, transaction.createdItems, {ageProgressionUndo: true});
    }
    return transaction;
  } catch (error) {
    const recoveryErrors = [];
    try {
      if (createdDeleteAttempted) {
        const missing = transaction.createdItems.filter(entry => !ownedItem(actor, entry.id));
        if (missing.length) await actor.createEmbeddedDocuments("Item", missing.map(entry => clone(entry.afterData)), {keepId: true, ageProgressionRecovery: true});
        if (transaction.createdItems.some(entry => !createdOriginMatches(ownedItem(actor, entry.id), transaction, entry.afterData))) {
          throw actorError("Deleted transaction Items could not be recreated exactly.", "undo-recovery-failed");
        }
      }
    } catch (recovery) { recoveryErrors.push(errorSummary(recovery)); }
    try {
      if (actorRestored) {
        await actor.update({...updateFromSnapshot(forwardSnapshot), ...actorTrackUpdate(forwardRegistry)}, {ageProgressionRecovery: true});
        if (!actorSnapshotsMatch(actor, forwardSnapshot) || !registryMatches(actor, forwardRegistry)) {
          throw actorError("Actor forward state could not be recovered exactly.", "undo-recovery-failed");
        }
      }
    } catch (recovery) { recoveryErrors.push(errorSummary(recovery)); }
    try {
      if (itemsRestored) await applyItemUpdatesExactly(actor, transaction.updatedItems, {forward: true, options: {ageProgressionRecovery: true}});
    } catch (recovery) { recoveryErrors.push(errorSummary(recovery)); }
    throw actorError("Actor-track rollback failed.", recoveryErrors.length ? "undo-recovery-failed" : "undo-failed", {cause: errorSummary(error), recoveryErrors});
  }
}

async function recreateTransactionItemsExactly(actor, transaction, entries, options) {
  const missing = [];
  for (const entry of entries) {
    const item = ownedItem(actor, entry.id);
    if (!item) missing.push(entry);
    else if (!createdOriginMatches(item, transaction, entry.afterData)) {
      throw actorError(`Transaction-created Item id "${entry.id}" is occupied by another source.`, "undo-recovery-failed");
    }
  }
  let createError = null;
  if (missing.length) {
    try {
      await actor.createEmbeddedDocuments("Item", missing.map(entry => clone(entry.afterData)), {
        keepId: true,
        ...options,
      });
    } catch (error) { createError = error; }
  }
  if (entries.every(entry => createdOriginMatches(ownedItem(actor, entry.id), transaction, entry.afterData))) return;
  throw actorError("Transaction-created Items could not be restored to their exact forward sources.", "undo-recovery-failed", {
    cause: errorSummary(createError),
  });
}

async function repairTrustedReceiptJournal(actor, committedJournal) {
  let callError = null;
  try {
    // The failed undone write may have left a malformed raw journal which the
    // normal writer correctly refuses even to normalize. This path is limited
    // to the previously validated, lock-held pre-undo snapshot and therefore
    // may replace the raw branch without consulting its corrupt current value.
    await actor.update({
      "flags.age-system.progressionReceiptJournal": atomicValue(committedJournal),
    }, {
      ageProgressionReceipt: true,
      ageProgressionRecovery: true,
      render: false,
    });
  } catch (error) { callError = error; }
  try {
    if (same(readProgressionReceiptJournal(actor), committedJournal)) return;
  } catch { /* report the original persistence failure below */ }
  throw actorError("Trusted committed receipt journal could not be restored exactly.", "undo-recovery-failed", {
    cause: errorSummary(callError),
  });
}

async function compensateFailedUndo(actor, transaction, {
  forwardSnapshot,
  forwardRegistry,
  forwardDigest,
  committedJournal,
}) {
  const rollbackSnapshot = snapshotForKeys(rawActorSource(actor), Object.keys(transaction.after));
  const rollbackRegistry = normalizedTrackRegistry(actor);
  const rollbackRegistryOptions = {
    remove: !hasOwn(rawProgressionFlags(actor), "actorTracks"),
    removeProgression: !hasOwn(rawAgeSystemFlags(actor), "progression"),
  };
  const rollbackDigest = await digestActorAdvancementBase(actor);
  try {
    await recreateTransactionItemsExactly(actor, transaction, transaction.createdItems, {ageProgressionRecovery: true});
    await applyItemUpdatesExactly(actor, transaction.updatedItems, {
      forward: true,
      options: {ageProgressionRecovery: true},
    });
    await applyActorUpdateExactly(actor, {
      desiredSnapshot: forwardSnapshot,
      desiredRegistry: forwardRegistry,
      desiredRegistryOptions: {remove: false},
      alternateSnapshot: rollbackSnapshot,
      alternateRegistry: rollbackRegistry,
      alternateRegistryOptions: rollbackRegistryOptions,
      options: {ageProgressionRecovery: true},
    });
    if (!actorSnapshotsMatch(actor, forwardSnapshot) || !registryMatches(actor, forwardRegistry)) {
      throw actorError("Actor forward state does not match its pre-undo state.", "undo-recovery-failed");
    }
    for (const entry of transaction.updatedItems) {
      const item = ownedItem(actor, entry.id);
      if (!item || !same(sourceSystem(item), entry.afterSystem)) {
        throw actorError(`Updated Item "${entry.id}" does not match its pre-undo state.`, "undo-recovery-failed");
      }
    }
    for (const entry of transaction.createdItems) {
      if (!createdOriginMatches(ownedItem(actor, entry.id), transaction, entry.afterData)) {
        throw actorError(`Created Item "${entry.id}" does not match its pre-undo state.`, "undo-recovery-failed");
      }
    }
    if (await digestActorAdvancementBase(actor) !== forwardDigest) {
      throw actorError("Compensated Actor source does not match its full pre-undo digest.", "undo-recovery-failed");
    }
  } catch (forwardError) {
    const reverseErrors = [];
    // A failed forward compensation must not continue into journal repair.
    // Reverse every stage in dependency order and prove the rolled-back data
    // state is once again exact before reporting the severe failure.
    try {
      const currentSnapshot = snapshotForKeys(rawActorSource(actor), Object.keys(transaction.after));
      const currentRegistry = normalizedTrackRegistry(actor);
      await applyActorUpdateExactly(actor, {
        desiredSnapshot: rollbackSnapshot,
        desiredRegistry: rollbackRegistry,
        desiredRegistryOptions: rollbackRegistryOptions,
        alternateSnapshot: currentSnapshot,
        alternateRegistry: currentRegistry,
        alternateRegistryOptions: {
          remove: !hasOwn(rawProgressionFlags(actor), "actorTracks"),
          removeProgression: !hasOwn(rawAgeSystemFlags(actor), "progression"),
        },
        options: {ageProgressionRecovery: true},
      });
    } catch (error) { reverseErrors.push({stage: "actor", ...errorSummary(error)}); }
    try {
      await applyItemUpdatesExactly(actor, transaction.updatedItems, {
        forward: false,
        options: {ageProgressionRecovery: true},
      });
    } catch (error) { reverseErrors.push({stage: "updated-items", ...errorSummary(error)}); }
    try {
      const removable = transaction.createdItems
        .map(entry => ownedItem(actor, entry.id))
        .filter(item => createdOriginMatches(item, transaction))
        .map(item => ({id: String(item.id ?? item._id), afterData: itemSource(item)}));
      await deleteTransactionItems(actor, transaction, removable, {ageProgressionRecovery: true});
    } catch (error) { reverseErrors.push({stage: "created-items", ...errorSummary(error)}); }
    try {
      if (!actorSnapshotsMatch(actor, rollbackSnapshot)
        || !registryMatches(actor, rollbackRegistry, rollbackRegistryOptions)
        || transaction.updatedItems.some(entry => !ownedItem(actor, entry.id) || !same(sourceSystem(ownedItem(actor, entry.id)), entry.beforeSystem))
        || transaction.createdItems.some(entry => ownedItem(actor, entry.id))
        || await digestActorAdvancementBase(actor) !== rollbackDigest) {
        throw actorError("Compensation reversal did not restore the exact rolled-back data state.", "undo-recovery-failed");
      }
    } catch (error) { reverseErrors.push({stage: "verification", ...errorSummary(error)}); }
    throw actorError("Failed undo could not be compensated to the exact forward transaction state.", "undo-recovery-failed", {
      cause: errorSummary(forwardError),
      reverseErrors,
      rollbackRestored: reverseErrors.length === 0,
    });
  }

  // Journal repair is deliberately last. A committed journal is never
  // restored for a partial forward data state.
  try {
    await repairTrustedReceiptJournal(actor, committedJournal);
    if (!same(readProgressionReceiptJournal(actor), committedJournal)) {
      throw actorError("Receipt journal does not match its committed pre-undo state.", "undo-recovery-failed");
    }
  } catch (journalError) {
    throw actorError("Forward data was restored, but the committed receipt journal could not be restored exactly.", "undo-recovery-failed", {
      cause: errorSummary(journalError),
      forwardDataRestored: true,
    });
  }
}

export class AgeActorProgressionAdvancementExecutor {
  #profileResolver;
  #profileIdResolver;
  #sourceResolver;
  #previewStore;
  #clock;
  #idFactory;
  #lockSettleMs;
  #receiptJournalLimit;
  #commitStates = new Map();
  #undoPreviews = new Map();

  constructor({
    profileResolver = null,
    profileIdResolver = null,
    sourceResolver = async uuid => globalThis.fromUuid?.(uuid) ?? null,
    previewStore = new AgeProgressionPreviewStore(),
    clock = () => Date.now(),
    idFactory: createId = idFactory,
    lockSettleMs = DEFAULT_ACTOR_LOCK_SETTLE_MS,
    receiptJournalLimit = AGE_PROGRESSION_RECEIPT_JOURNAL_LIMIT,
  } = {}) {
    if (!(sourceResolver instanceof Function)) throw actorError("Source resolver must be callable.", "source-resolver");
    this.#profileResolver = profileResolver;
    this.#profileIdResolver = profileIdResolver;
    this.#sourceResolver = sourceResolver;
    this.#previewStore = previewStore;
    this.#clock = clock;
    this.#idFactory = createId;
    this.#lockSettleMs = Math.max(0, Number(lockSettleMs) || 0);
    this.#receiptJournalLimit = Number(receiptJournalLimit);
  }

  get previewStore() { return this.#previewStore; }
  prepareFormulaResolver(_definition, resolveFormula) { return resolveFormula; }

  async acceptPreview({preview, definition, actor, profileId = preview?.profileId, profileSnapshot, abilityAllocations = {}, progressionTargets = {}, user = globalThis.game?.user} = {}) {
    await assertSignedPreview(preview, this.#clock(), user?.id ?? null);
    if (preview.advancementBindings !== undefined) throw actorError("Preview is already bound to an advancement executor.", "preview-binding");
    if (actor?.type !== "char" || preview.actorUuid !== actor?.uuid) throw actorError("Preview belongs to another or invalid Actor.", "actor-mismatch");
    if (!documentOwner(actor, user)) throw actorError("User does not own this Character.", "permission");
    assertProgressionDefinition(definition);
    if (definition.trackBinding?.kind !== "actor") throw actorError("Definition is not Actor-track bound.", "track-binding");
    if (definition.id !== preview.definitionId || definition.version !== preview.definitionVersion) throw actorError("Definition changed after compilation.", "definition-stale");
    const digest = await definitionDigest(definition);
    if (digest !== preview.definitionDigest) throw actorError("Definition changed after compilation.", "definition-stale");
    const track = targetTrack(actor, definition, preview.rank);
    const rankEffects = preview.resolvedEffects.filter(effect => effect.type === "track.setRank");
    if (rankEffects.length !== 1
      || rankEffects[0].trackId !== definition.trackBinding.trackId
      || Number(rankEffects[0].rank) !== Number(preview.rank)) {
      throw actorError("Actor-track advancement requires exactly one matching track.setRank effect.", "track-binding");
    }
    if (profileId !== preview.profileId) throw actorError("Rules profile changed after compilation.", "profile-stale");
    if (isPlainObject(profileSnapshot) && await digestCanonicalJson(profileSnapshot) !== preview.profileDigest) throw actorError("Rules profile data changed after compilation.", "profile-stale");
    if (await digestActorAdvancementBase(actor) !== preview.baseDigest) throw actorError("Character source changed after compilation.", "base-stale");
    const abilityBinding = normalizeAllocations(preview, abilityAllocations, actor, profileSnapshot);
    const sourceBindings = await bindSources(preview, definition, actor, this.#sourceResolver);
    const targetBindings = await bindTargets(preview, actor, progressionTargets, sourceBindings);
    const binding = {
      schemaVersion: AGE_ACTOR_ADVANCEMENT_BINDING_VERSION,
      executorVersion: AGE_ACTOR_ADVANCEMENT_EXECUTOR_VERSION,
      execution: "actor-transaction-v1",
      definitionId: definition.id,
      definitionDigest: digest,
      trackBinding: clone(definition.trackBinding),
      targetRank: preview.rank,
      previousRank: track.currentRank,
      trackWasAbsent: track.trackWasAbsent,
      actorTracksWasAbsent: track.actorTracksWasAbsent,
      progressionWasAbsent: track.progressionWasAbsent,
      definitionBindingWasAbsent: track.definitionBindingWasAbsent,
      semanticTrackState: clone(track.semanticTrackState),
      profileDigest: preview.profileDigest,
      abilityAllocations: abilityBinding.allocations,
      eligibleAbilityIdsByOperation: abilityBinding.eligibleByOperation,
      sourceBindings,
      targetBindings,
    };
    const body = {...bodyWithoutDigest(preview), advancementBindings: binding};
    const bound = frozen({...body, planDigest: await digestCanonicalJson(body)});
    applyActorEffects({preview: bound, actor, binding, transactionId: "preview-validation"});
    this.#previewStore.put(bound);
    return bound;
  }

  async #recheck(preview, actor, user) {
    await assertSignedPreview(preview, this.#clock(), user?.id ?? null);
    const binding = preview.advancementBindings;
    if (!isPlainObject(binding) || binding.execution !== "actor-transaction-v1" || binding.schemaVersion !== AGE_ACTOR_ADVANCEMENT_BINDING_VERSION) {
      throw actorError("Preview has no valid Actor advancement binding.", "preview-binding");
    }
    if (actor?.type !== "char" || actor?.uuid !== preview.actorUuid) throw actorError("Preview belongs to another Actor.", "actor-mismatch");
    if (!documentOwner(actor, user)) throw actorError("User no longer owns this Character.", "permission");
    const trackId = safeMapKey(binding.trackBinding?.trackId, "trackBinding.trackId");
    if (actorProgressionRank(actor, trackId, binding.previousRank) !== binding.previousRank) {
      throw actorError("Target Actor-track rank changed after preview.", "target-rank");
    }
    const registry = normalizedTrackRegistry(actor);
    if ((!hasOwn(registry.tracks, trackId)) !== binding.trackWasAbsent
      || (!hasOwn(rawProgressionFlags(actor), "actorTracks")) !== binding.actorTracksWasAbsent
      || (!hasOwn(rawAgeSystemFlags(actor), "progression")) !== binding.progressionWasAbsent
      || !same(semanticTrackState(actor, trackId), binding.semanticTrackState)) {
      throw actorError("Target Actor-track source changed after preview.", "track-stale");
    }
    const resolvedProfileId = this.#profileIdResolver instanceof Function ? await this.#profileIdResolver(actor, null, preview.profileId) : preview.profileId;
    if (resolvedProfileId !== preview.profileId) throw actorError("Rules profile changed after preview.", "profile-stale");
    if (this.#profileResolver instanceof Function) {
      const profile = await this.#profileResolver(preview.profileId, {actor, preview});
      if (await digestCanonicalJson(profile) !== preview.profileDigest) throw actorError("Rules profile data changed after preview.", "profile-stale");
    }
    if (await digestActorAdvancementBase(actor) !== preview.baseDigest) throw actorError("Character source changed after preview.", "base-stale");
    await verifySourceBindings(binding, preview, actor, this.#sourceResolver);
    return binding;
  }

  async commitPreview({preview, actor, user = globalThis.game?.user, planDigest = preview?.planDigest} = {}) {
    if (planDigest !== preview?.planDigest) throw actorError("Commit digest does not match the reserved preview.", "preview-digest");
    const key = `${preview.previewId}:${planDigest}`;
    if (this.#commitStates.has(key)) throw actorError("Advancement preview is already committing or consumed.", "duplicate-commit");
    this.#commitStates.set(key, "pending");
    try {
      return await withActorLock(actor, user, async () => {
        let applied = false;
        let transaction = null;
        let journalBefore = null;
        try {
          const binding = await this.#recheck(preview, actor, user);
          journalBefore = readProgressionReceiptJournal(actor);
          const track = {
            trackId: safeMapKey(binding.trackBinding.trackId, "trackBinding.trackId"),
            currentRank: binding.previousRank,
            trackWasAbsent: binding.trackWasAbsent,
            actorTracksWasAbsent: binding.actorTracksWasAbsent,
            progressionWasAbsent: binding.progressionWasAbsent,
            definitionBindingWasAbsent: binding.definitionBindingWasAbsent,
            semanticTrackState: clone(binding.semanticTrackState),
          };
          const transactionId = this.#idFactory("age-actor-progression-transaction");
          const mutation = applyActorEffects({preview, actor, binding, transactionId});
          transaction = {
        schemaVersion: AGE_ACTOR_ADVANCEMENT_TRACK_VERSION,
        id: transactionId,
        trackId: track.trackId,
        previousRank: track.currentRank,
        rank: preview.rank,
        trackWasAbsent: track.trackWasAbsent,
        actorTracksWasAbsent: track.actorTracksWasAbsent,
        progressionWasAbsent: track.progressionWasAbsent,
        definitionBindingWasAbsent: track.definitionBindingWasAbsent,
        semanticTrackState: clone(track.semanticTrackState),
        previewId: preview.previewId,
        planDigest: preview.planDigest,
        definitionId: preview.definitionId,
        definitionVersion: preview.definitionVersion,
        definitionDigest: preview.definitionDigest,
        profileId: preview.profileId,
        committedBy: user.id,
        committedAt: new Date(this.#clock()).toISOString(),
        before: mutation.before,
        after: mutation.after,
        resourceDeltas: mutation.resourceDeltas,
        bonusDeltas: mutation.bonusDeltas,
        createdItems: [],
        updatedItems: mutation.updatedItems,
        summaries: mutation.summaries,
          };
          await applyTransaction(actor, transaction, mutation);
          applied = true;
          const receipt = createProgressionReceiptV1({
        kind: "rank.advance", previewId: preview.previewId, planDigest: preview.planDigest,
        definitionId: preview.definitionId, definitionVersion: preview.definitionVersion,
        definitionDigest: preview.definitionDigest, profileId: preview.profileId, actorUuid: actor.uuid,
        transactionId: transaction.id, beforeDigest: preview.baseDigest,
            afterDigest: await digestActorAdvancementBase(actor), committedBy: user.id, reversible: true,
          }, {now: this.#clock()});
          await persistProgressionReceipt(actor, receipt, {execution: "actor-transaction-v1", trackId: track.trackId}, {limit: this.#receiptJournalLimit});
          this.#commitStates.set(key, "consumed");
          return receipt;
        } catch (error) {
          if (!applied) {
            if (error?.code === "transaction-recovery" || error?.code === "undo-recovery-failed") this.#commitStates.set(key, "consumed");
            else this.#commitStates.delete(key);
            throw error;
          }
          try {
            await rollbackTransaction(actor, transaction);
            await writeProgressionReceiptJournal(actor, journalBefore);
            if (await digestActorAdvancementBase(actor) !== preview.baseDigest) {
              throw actorError("Automatic rollback did not restore the exact pre-commit Actor source.", "transaction-recovery");
            }
          } catch (rollbackError) {
            this.#commitStates.set(key, "consumed");
            throw actorError("Actor advancement completed but receipt persistence and automatic rollback failed.", "receipt-persistence-rollback-failed", {cause: errorSummary(error), rollbackError: errorSummary(rollbackError)});
          }
          this.#commitStates.delete(key);
          throw actorError("Actor advancement was rolled back because its receipt could not be persisted.", "receipt-persistence", {cause: errorSummary(error)});
        }
      }, {clock: this.#clock, createId: this.#idFactory, settleMs: this.#lockSettleMs});
    } catch (error) {
      if (this.#commitStates.get(key) === "pending") this.#commitStates.delete(key);
      throw error;
    }
  }

  async previewUndo({actor, user = globalThis.game?.user, receipt, receiptContext = {}, expiresAt = new Date(this.#clock() + DEFAULT_PREVIEW_TTL_MS).toISOString()} = {}) {
    const {reasons, trackId, transaction} = undoConflicts(actor, user, receipt, receiptContext);
    let currentDigest = null;
    try { currentDigest = await digestActorAdvancementBase(actor); } catch { reasons.push("source-unavailable"); }
    const body = {
      schemaVersion: AGE_ACTOR_ADVANCEMENT_UNDO_PREVIEW_VERSION, kind: "rank.advance.undo",
      undoPreviewId: this.#idFactory("age-actor-progression-undo"), receiptId: receipt?.id ?? null,
      transactionId: receipt?.transactionId ?? null, actorUuid: actor?.uuid ?? null, trackId: trackId ?? null,
      userId: user?.id ?? null, currentDigest, expectedDigest: receipt?.afterDigest ?? null,
      createdAt: new Date(this.#clock()).toISOString(), expiresAt,
      allowed: reasons.length === 0, reasons: [...new Set(reasons)], latestTransactionId: transaction?.id ?? null,
    };
    const preview = frozen({...body, undoDigest: await digestCanonicalJson(body)});
    if (preview.allowed) this.#undoPreviews.set(preview.undoPreviewId, {preview, state: "ready"});
    return preview;
  }

  async undo({actor, user = globalThis.game?.user, receipt, receiptContext = {}, undoPreviewId, undoDigest} = {}) {
    const entry = this.#undoPreviews.get(undoPreviewId);
    if (!entry || entry.state !== "ready") throw actorError("Undo preview is missing, consumed, or running.", "undo-preview");
    if (entry.preview.undoDigest !== undoDigest || await digestCanonicalJson(bodyWithoutDigest(entry.preview, "undoDigest")) !== undoDigest) throw actorError("Undo preview digest does not match.", "undo-preview");
    if (Date.parse(entry.preview.expiresAt) <= this.#clock()) throw actorError("Undo preview expired.", "undo-expired");
    if (entry.preview.receiptId !== receipt?.id || entry.preview.actorUuid !== actor?.uuid || entry.preview.userId !== user?.id) throw actorError("Undo preview binding changed.", "undo-binding");
    entry.state = "pending";
    try {
      return await withActorLock(actor, user, async () => {
        const checked = undoConflicts(actor, user, receipt, receiptContext);
        if (checked.reasons.length) throw actorError(`Actor advancement cannot be undone safely: ${checked.reasons.join(", ")}.`, "unsafe-undo");
        const forwardDigest = await digestActorAdvancementBase(actor);
        const exactBeforeExpected = forwardDigest === receipt.afterDigest;
        const forwardSnapshot = snapshotForKeys(rawActorSource(actor), Object.keys(checked.transaction.after));
        const forwardRegistry = normalizedTrackRegistry(actor);
        const committedJournal = readProgressionReceiptJournal(actor);
        await rollbackTransaction(actor, checked.transaction, {preserveInterveningResources: true});
        if (exactBeforeExpected && await digestActorAdvancementBase(actor) !== receipt.beforeDigest) {
          try {
            await compensateFailedUndo(actor, checked.transaction, {
              forwardSnapshot,
              forwardRegistry,
              forwardDigest,
              committedJournal,
            });
          } catch (compensationError) {
            entry.state = "consumed";
            throw actorError("Actor advancement undo did not restore its exact pre-commit source and its forward state could not be recovered.", "undo-recovery-failed", {
              rollbackApplied: true,
              compensationError: errorSummary(compensationError),
            });
          }
          entry.state = "consumed";
          throw actorError("Actor advancement undo did not restore its exact pre-commit source; the exact committed state was recovered.", "undo-recovery-failed", {
            rollbackApplied: false,
            compensated: true,
          });
        }
        const undone = markProgressionReceiptUndone(receipt, {now: this.#clock()});
        try {
          await persistProgressionReceipt(actor, undone, {execution: "actor-transaction-v1", trackId: checked.trackId}, {limit: this.#receiptJournalLimit});
        } catch (persistenceError) {
          try {
            await compensateFailedUndo(actor, checked.transaction, {
              forwardSnapshot,
              forwardRegistry,
              forwardDigest,
              committedJournal,
            });
          } catch (compensationError) {
            entry.state = "consumed";
            throw actorError("Actor rank was rolled back, its receipt could not be marked undone, and the forward state could not be restored exactly.", "undo-recovery-failed", {
              rollbackApplied: true,
              persistenceError: errorSummary(persistenceError),
              compensationError: errorSummary(compensationError),
            });
          }
          entry.state = "ready";
          throw actorError("Actor undo was cancelled because its receipt could not be marked undone; the exact committed state was restored.", "receipt-state-persistence", {
            rollbackApplied: false,
            compensated: true,
            persistenceError: errorSummary(persistenceError),
          });
        }
        entry.state = "consumed";
        return undone;
      }, {clock: this.#clock, createId: this.#idFactory, settleMs: this.#lockSettleMs});
    } catch (error) {
      if (entry.state !== "consumed") entry.state = "ready";
      throw error;
    }
  }
}
