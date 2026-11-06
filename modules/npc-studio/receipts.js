import {canonicalClone, canonicalJson} from "../progression/canonical.js";
import {AGE_NPC_STUDIO_RECEIPT_VERSION, npcStudioError} from "./contracts.js";

const SYSTEM_ID = "age-system";
const RECEIPT_KINDS = new Set(["npc.create"]);
const RECEIPT_STATES = new Set(["committed", "undone"]);
const SHA256 = /^[0-9a-f]{64}$/u;

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw npcStudioError("AGE_NPC_STUDIO_RECEIPT_INVALID", `${field} must be a non-empty string.`);
  return value;
}

function timestamp(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw npcStudioError("AGE_NPC_STUDIO_RECEIPT_INVALID", `${field} must be a timestamp.`);
  return number;
}

export function validateNpcStudioReceipt(receipt) {
  const errors = [];
  try { canonicalJson(receipt); } catch (error) { errors.push(error.message); }
  if (!plainObject(receipt)) return Object.freeze({valid: false, errors: Object.freeze(["Receipt must be a plain object."])});
  const allowed = new Set([
    "schemaVersion", "id", "kind", "state", "previewId", "inputDigest", "snapshotDigest", "planDigest",
    "profileId", "actorUuid", "afterDigest", "sourceActorUuid", "sourceDigest", "createdAt", "committedAt",
    "undoneAt", "committedBy", "reversible",
  ]);
  for (const key of Object.keys(receipt)) if (!allowed.has(key)) errors.push(`Receipt field "${key}" is not allowed.`);
  if (receipt.schemaVersion !== AGE_NPC_STUDIO_RECEIPT_VERSION) errors.push(`schemaVersion must be ${AGE_NPC_STUDIO_RECEIPT_VERSION}.`);
  for (const field of ["id", "kind", "state", "previewId", "inputDigest", "snapshotDigest", "planDigest", "profileId", "actorUuid", "afterDigest", "committedBy"]) {
    if (typeof receipt[field] !== "string" || !receipt[field].trim()) errors.push(`${field} must be a non-empty string.`);
  }
  if (!RECEIPT_KINDS.has(receipt.kind)) errors.push("kind must be npc.create.");
  if (!RECEIPT_STATES.has(receipt.state)) errors.push("state must be committed or undone.");
  for (const field of ["inputDigest", "snapshotDigest", "planDigest", "afterDigest"]) {
    if (typeof receipt[field] === "string" && !SHA256.test(receipt[field])) errors.push(`${field} must be a lowercase SHA-256 digest.`);
  }
  for (const field of ["sourceActorUuid", "sourceDigest"]) {
    if (receipt[field] !== null && receipt[field] !== undefined && (typeof receipt[field] !== "string" || !receipt[field].trim())) errors.push(`${field} must be null or non-empty text.`);
  }
  if (receipt.sourceActorUuid && !SHA256.test(receipt.sourceDigest ?? "")) errors.push("A clone receipt requires a sourceDigest.");
  if (!receipt.sourceActorUuid && receipt.sourceDigest !== null && receipt.sourceDigest !== undefined) errors.push("A non-clone receipt may not carry sourceDigest.");
  for (const field of ["createdAt", "committedAt"]) if (!Number.isFinite(Number(receipt[field])) || Number(receipt[field]) < 0) errors.push(`${field} must be a timestamp.`);
  if (receipt.undoneAt !== null && receipt.undoneAt !== undefined && (!Number.isFinite(Number(receipt.undoneAt)) || Number(receipt.undoneAt) < 0)) errors.push("undoneAt must be null or a timestamp.");
  if (typeof receipt.reversible !== "boolean") errors.push("reversible must be Boolean.");
  if (receipt.state === "undone" && receipt.undoneAt === null) errors.push("An undone receipt requires undoneAt.");
  return Object.freeze({valid: errors.length === 0, errors: Object.freeze(errors)});
}

export function assertNpcStudioReceipt(receipt) {
  const validation = validateNpcStudioReceipt(receipt);
  if (!validation.valid) throw npcStudioError("AGE_NPC_STUDIO_RECEIPT_INVALID", validation.errors.join(" "), {errors: validation.errors});
  return receipt;
}

export function createNpcStudioReceipt(data, {now = Date.now()} = {}) {
  const sourceActorUuid = data.sourceActorUuid ?? null;
  const receipt = {
    schemaVersion: AGE_NPC_STUDIO_RECEIPT_VERSION,
    id: requiredText(data.id, "id"),
    kind: "npc.create",
    state: data.state ?? "committed",
    previewId: requiredText(data.previewId, "previewId"),
    inputDigest: requiredText(data.inputDigest, "inputDigest"),
    snapshotDigest: requiredText(data.snapshotDigest, "snapshotDigest"),
    planDigest: requiredText(data.planDigest, "planDigest"),
    profileId: requiredText(data.profileId, "profileId"),
    actorUuid: requiredText(data.actorUuid, "actorUuid"),
    afterDigest: requiredText(data.afterDigest, "afterDigest"),
    sourceActorUuid,
    sourceDigest: sourceActorUuid ? requiredText(data.sourceDigest, "sourceDigest") : null,
    createdAt: timestamp(data.createdAt ?? now, "createdAt"),
    committedAt: timestamp(data.committedAt ?? now, "committedAt"),
    undoneAt: data.undoneAt ?? null,
    committedBy: requiredText(data.committedBy, "committedBy"),
    reversible: data.reversible !== false,
  };
  assertNpcStudioReceipt(receipt);
  return Object.freeze(canonicalClone(receipt));
}

export function markNpcStudioReceiptUndone(receipt, {now = Date.now()} = {}) {
  assertNpcStudioReceipt(receipt);
  return createNpcStudioReceipt({...receipt, state: "undone", undoneAt: Number(now)}, {now: receipt.createdAt});
}

export function getNpcStudioReceipt(actorOrSource) {
  const source = actorOrSource?._source ?? actorOrSource;
  const receipt = source?.flags?.[SYSTEM_ID]?.npcStudio?.creationReceipt
    ?? actorOrSource?.flags?.[SYSTEM_ID]?.npcStudio?.creationReceipt
    ?? null;
  if (!receipt) return null;
  assertNpcStudioReceipt(receipt);
  return Object.freeze(canonicalClone(receipt));
}

export function npcStudioReceiptUpdate(receipt) {
  assertNpcStudioReceipt(receipt);
  return {[`flags.${SYSTEM_ID}.npcStudio.creationReceipt`]: canonicalClone(receipt)};
}

