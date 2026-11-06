import {assertProgressionDefinition} from "./contracts.js";
import {canonicalClone, canonicalJson} from "./canonical.js";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function compareVersions(left, right) {
  const parse = version => version.split(/[+-]/, 1)[0].split(".").map(Number);
  const [leftMajor, leftMinor, leftPatch] = parse(left);
  const [rightMajor, rightMinor, rightPatch] = parse(right);
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch;
}

function snapshot(definition) {
  return deepFreeze(canonicalClone(definition));
}

/** A small immutable registry. Providers may replace only with a newer version. */
export class AgeProgressionDefinitionRegistry {
  #definitions = new Map();
  #profiles;
  #capabilities;

  constructor({profiles = [], capabilities = []} = {}) {
    this.#profiles = new Set(profiles);
    this.#capabilities = new Set(capabilities);
  }

  register(definition, {replace = false} = {}) {
    assertProgressionDefinition(definition);
    if (this.#profiles.size && !this.#profiles.has(definition.profileId)) {
      throw new Error(`Unsupported AGE progression profile "${definition.profileId}".`);
    }
    for (const capability of definition.capabilities) {
      if (this.#capabilities.size && !this.#capabilities.has(capability)) {
        throw new Error(`Unsupported AGE progression capability "${capability}".`);
      }
    }
    const existing = this.#definitions.get(definition.id);
    if (existing) {
      if (!replace) throw new Error(`AGE progression definition "${definition.id}" is already registered.`);
      if (existing.profileId !== definition.profileId) throw new Error(`AGE progression definition "${definition.id}" cannot change profiles.`);
      if (compareVersions(definition.version, existing.version) <= 0) throw new Error(`AGE progression definition "${definition.id}" must use a newer version when replacing.`);
    }
    const stored = snapshot(definition);
    this.#definitions.set(stored.id, stored);
    return stored;
  }

  unregister(id) {
    return this.#definitions.delete(id);
  }

  get(id) {
    return this.#definitions.get(id) ?? null;
  }

  has(id) {
    return this.#definitions.has(id);
  }

  definitions({profileId = null, capability = null} = {}) {
    return Object.freeze([...this.#definitions.values()]
      .filter(definition => !profileId || definition.profileId === profileId)
      .filter(definition => !capability || definition.capabilities.includes(capability))
      .sort((left, right) => left.id.localeCompare(right.id)));
  }

  snapshot() {
    return deepFreeze(JSON.parse(canonicalJson(this.definitions())));
  }

  clear() {
    this.#definitions.clear();
  }
}
