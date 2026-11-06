import {canonicalClone, canonicalJson} from "./canonical.js";

export const AGE_PROGRESSION_PREVIEW_STORE_VERSION = 1;
export const AGE_PROGRESSION_RECEIPT_VERSION = 1;

const RECEIPT_KINDS = new Set(["character.create", "rank.advance"]);
const RECEIPT_STATES = new Set(["committed", "undone"]);
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LIMIT = 100;

function isObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteTimestamp(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function snapshot(value) {
  return deepFreeze(canonicalClone(value));
}

function randomId(prefix = "age-progression") {
  const id = globalThis.foundry?.utils?.randomID?.(16)
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${id}`;
}

/**
 * Strictly validate the cross-domain receipt persisted by progression
 * executors. Domain-specific rollback data remains in the owning document;
 * this receipt is the stable public link to it.
 */
export function validateProgressionReceiptV1(receipt) {
  const errors = [];
  try { canonicalJson(receipt); } catch (error) { errors.push(error.message); }
  if (!isObject(receipt)) return {valid: false, errors: ["Receipt must be a plain object."]};
  const allowed = new Set([
    "schemaVersion", "id", "kind", "state", "previewId", "planDigest",
    "definitionId", "definitionVersion", "definitionDigest", "profileId",
    "actorUuid", "transactionId", "beforeDigest", "afterDigest",
    "createdAt", "committedAt", "undoneAt", "committedBy", "reversible",
  ]);
  for (const key of Object.keys(receipt)) if (!allowed.has(key)) errors.push(`Receipt field "${key}" is not allowed.`);
  if (receipt.schemaVersion !== AGE_PROGRESSION_RECEIPT_VERSION) errors.push(`schemaVersion must be ${AGE_PROGRESSION_RECEIPT_VERSION}.`);
  for (const field of ["id", "kind", "state", "previewId", "planDigest", "definitionId", "definitionVersion", "definitionDigest", "profileId", "actorUuid", "committedBy"]) {
    if (typeof receipt[field] !== "string" || !receipt[field].trim()) errors.push(`${field} must be a non-empty string.`);
  }
  if (!RECEIPT_KINDS.has(receipt.kind)) errors.push("kind must be character.create or rank.advance.");
  if (!RECEIPT_STATES.has(receipt.state)) errors.push("state must be committed or undone.");
  if (receipt.transactionId !== null && receipt.transactionId !== undefined && (typeof receipt.transactionId !== "string" || !receipt.transactionId.trim())) errors.push("transactionId must be null or a non-empty string.");
  for (const field of ["beforeDigest", "afterDigest"]) {
    if (receipt[field] !== null && receipt[field] !== undefined && (typeof receipt[field] !== "string" || !receipt[field].trim())) errors.push(`${field} must be null or a non-empty string.`);
  }
  for (const field of ["createdAt", "committedAt"]) if (!finiteTimestamp(receipt[field])) errors.push(`${field} must be a timestamp.`);
  if (receipt.undoneAt !== null && receipt.undoneAt !== undefined && !finiteTimestamp(receipt.undoneAt)) errors.push("undoneAt must be null or a timestamp.");
  if (typeof receipt.reversible !== "boolean") errors.push("reversible must be boolean.");
  if (receipt.state === "undone" && !finiteTimestamp(receipt.undoneAt)) errors.push("An undone receipt requires undoneAt.");
  return Object.freeze({valid: errors.length === 0, errors: Object.freeze(errors)});
}

export function assertProgressionReceiptV1(receipt) {
  const validation = validateProgressionReceiptV1(receipt);
  if (!validation.valid) {
    const error = new Error(`Invalid AGE progression ReceiptV1: ${validation.errors.join(" ")}`);
    error.name = "AgeProgressionReceiptValidationError";
    error.errors = validation.errors;
    throw error;
  }
  return receipt;
}

export function createProgressionReceiptV1(data, {idFactory = randomId, now = Date.now()} = {}) {
  const receipt = {
    schemaVersion: AGE_PROGRESSION_RECEIPT_VERSION,
    id: String(data.id ?? idFactory("age-progression-receipt")),
    kind: requiredText(data.kind, "kind"),
    state: data.state ?? "committed",
    previewId: requiredText(data.previewId, "previewId"),
    planDigest: requiredText(data.planDigest, "planDigest"),
    definitionId: requiredText(data.definitionId, "definitionId"),
    definitionVersion: requiredText(data.definitionVersion, "definitionVersion"),
    definitionDigest: requiredText(data.definitionDigest, "definitionDigest"),
    profileId: requiredText(data.profileId, "profileId"),
    actorUuid: requiredText(data.actorUuid, "actorUuid"),
    transactionId: data.transactionId ?? null,
    beforeDigest: data.beforeDigest ?? null,
    afterDigest: data.afterDigest ?? null,
    createdAt: Number(data.createdAt ?? now),
    committedAt: Number(data.committedAt ?? now),
    undoneAt: data.undoneAt ?? null,
    committedBy: requiredText(data.committedBy, "committedBy"),
    reversible: data.reversible !== false,
  };
  assertProgressionReceiptV1(receipt);
  return snapshot(receipt);
}

export function markProgressionReceiptUndone(receipt, {now = Date.now()} = {}) {
  assertProgressionReceiptV1(receipt);
  if (receipt.state === "undone") return snapshot(receipt);
  return createProgressionReceiptV1({...receipt, state: "undone", undoneAt: Number(now)}, {idFactory: () => receipt.id, now: receipt.createdAt});
}

/**
 * Memory-only, single-use preview store. It deliberately stores plain frozen
 * snapshots instead of Documents and provides a reservation phase so rapid
 * duplicate clicks cannot commit the same plan twice.
 */
export class AgeProgressionPreviewStore {
  #entries = new Map();
  #ttlMs;
  #limit;
  #now;

  constructor({ttlMs = DEFAULT_TTL_MS, limit = DEFAULT_LIMIT, now = () => Date.now()} = {}) {
    if (!Number.isFinite(Number(ttlMs)) || Number(ttlMs) <= 0) throw new TypeError("Preview ttlMs must be positive.");
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1) throw new TypeError("Preview limit must be a positive integer.");
    this.#ttlMs = Number(ttlMs);
    this.#limit = Number(limit);
    this.#now = now;
  }

  put(preview) {
    const stored = snapshot(preview);
    requiredText(stored.previewId, "preview.previewId");
    requiredText(stored.planDigest, "preview.planDigest");
    requiredText(stored.definitionId, "preview.definitionId");
    requiredText(stored.profileId, "preview.profileId");
    if (this.#entries.has(stored.previewId)) throw new Error(`AGE progression preview "${stored.previewId}" already exists.`);
    const now = Number(this.#now());
    const expiresAt = finiteTimestamp(stored.expiresAt) ? Number(stored.expiresAt) : now + this.#ttlMs;
    if (expiresAt <= now) throw new Error("AGE progression preview is already expired.");
    this.prune(now);
    while (this.#entries.size >= this.#limit) this.#entries.delete(this.#entries.keys().next().value);
    this.#entries.set(stored.previewId, {preview: stored, expiresAt, state: "ready", token: null});
    return stored;
  }

  get(previewId, binding = {}) {
    const entry = this.#entry(previewId, binding);
    return entry.preview;
  }

  reserve(previewId, binding = {}) {
    const entry = this.#entry(previewId, binding);
    if (entry.state === "pending") throw new Error(`AGE progression preview "${previewId}" is already committing.`);
    if (entry.state === "consumed") throw new Error(`AGE progression preview "${previewId}" was already consumed.`);
    const token = randomId("age-progression-reservation");
    entry.state = "pending";
    entry.token = token;
    return Object.freeze({token, preview: entry.preview});
  }

  complete(previewId, token) {
    const entry = this.#entries.get(previewId);
    if (!entry || entry.state !== "pending" || entry.token !== token) throw new Error("AGE progression preview reservation is not active.");
    entry.state = "consumed";
    entry.token = null;
    return entry.preview;
  }

  release(previewId, token) {
    const entry = this.#entries.get(previewId);
    if (!entry || entry.state !== "pending" || entry.token !== token) return false;
    entry.state = "ready";
    entry.token = null;
    return true;
  }

  delete(previewId) {
    return this.#entries.delete(previewId);
  }

  status(previewId) {
    const entry = this.#entries.get(previewId);
    if (!entry) return "missing";
    if (entry.expiresAt <= Number(this.#now())) return "expired";
    return entry.state;
  }

  prune(now = Number(this.#now())) {
    let removed = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= Number(now)) {
        this.#entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  clear() {
    this.#entries.clear();
  }

  #entry(previewId, binding) {
    const entry = this.#entries.get(previewId);
    if (!entry) throw new Error(`AGE progression preview "${previewId}" does not exist.`);
    if (entry.expiresAt <= Number(this.#now())) {
      this.#entries.delete(previewId);
      throw new Error(`AGE progression preview "${previewId}" expired.`);
    }
    if (binding.planDigest && entry.preview.planDigest !== binding.planDigest) throw new Error("AGE progression preview digest does not match.");
    if (binding.userId && entry.preview.userId && entry.preview.userId !== binding.userId) throw new Error("AGE progression preview belongs to another user.");
    if (binding.actorUuid && entry.preview.actorUuid && entry.preview.actorUuid !== binding.actorUuid) throw new Error("AGE progression preview belongs to another Actor.");
    if (binding.profileId && entry.preview.profileId !== binding.profileId) throw new Error("AGE progression preview belongs to another rules profile.");
    if (entry.state === "consumed") throw new Error(`AGE progression preview "${previewId}" was already consumed.`);
    return entry;
  }
}

