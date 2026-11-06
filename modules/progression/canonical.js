/** Deterministic serialization and digest helpers for DefinitionV1 receipts. */

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function assertCanonicalJson(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite JSON number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertCanonicalJson(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${path} is not JSON serializable`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain JSON object`);
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) throw new TypeError(`${path}.${key} is forbidden`);
    assertCanonicalJson(entry, `${path}.${key}`);
  }
}

function serialize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${serialize(value[key])}`).join(",")}}`;
}

export function canonicalJson(value) {
  assertCanonicalJson(value);
  return serialize(value);
}

export function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

function bytes(value) {
  return new TextEncoder().encode(value);
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Asynchronous SHA-256 which uses Web Crypto in Foundry/browser and Node's
 * built-in crypto only as a test/runtime fallback.
 */
export async function digestCanonicalJson(value) {
  const input = canonicalJson(value);
  if (globalThis.crypto?.subtle?.digest) return toHex(await globalThis.crypto.subtle.digest("SHA-256", bytes(input)));
  try {
    const crypto = await import("node:crypto");
    return crypto.createHash("sha256").update(input, "utf8").digest("hex");
  } catch (error) {
    throw new Error("SHA-256 is unavailable in this runtime", {cause: error});
  }
}

export const definitionDigest = digestCanonicalJson;
