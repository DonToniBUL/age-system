import {canonicalClone} from "../progression/canonical.js";
import {npcStudioError} from "./contracts.js";

export const AGE_NPC_STUDIO_SESSION_TTL_MS = 15 * 60 * 1_000;
export const AGE_NPC_STUDIO_SESSION_LIMIT = 20;

function snapshot(value) {
  const cloned = canonicalClone(value);
  const freeze = entry => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
    Object.freeze(entry);
    Object.values(entry).forEach(freeze);
    return entry;
  };
  return freeze(cloned);
}

export class AgeNpcStudioSessionStore {
  #sessions = new Map();
  #clock;
  #ttlMs;
  #limit;
  #idFactory;

  constructor({clock = () => Date.now(), ttlMs = AGE_NPC_STUDIO_SESSION_TTL_MS, limit = AGE_NPC_STUDIO_SESSION_LIMIT, idFactory} = {}) {
    if (!(idFactory instanceof Function)) throw new TypeError("NPC Studio session store requires an idFactory.");
    if (!Number.isFinite(Number(ttlMs)) || Number(ttlMs) <= 0) throw new TypeError("NPC Studio ttlMs must be positive.");
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1) throw new TypeError("NPC Studio session limit must be a positive integer.");
    this.#clock = clock;
    this.#ttlMs = Number(ttlMs);
    this.#limit = Number(limit);
    this.#idFactory = idFactory;
  }

  get ttlMs() { return this.#ttlMs; }

  put(data, {kind = "create"} = {}) {
    const now = Number(this.#clock());
    this.prune(now);
    const id = String(data.id ?? this.#idFactory(kind === "undo" ? "npc-undo" : "npc-preview"));
    const expiresAt = Number(data.expiresAt ?? now + this.#ttlMs);
    if (!id || !Number.isFinite(expiresAt) || expiresAt <= now) throw npcStudioError("AGE_NPC_STUDIO_SESSION_INVALID", "NPC Studio session metadata is invalid.");
    if (this.#sessions.has(id)) throw npcStudioError("AGE_NPC_STUDIO_SESSION_DUPLICATE", `NPC Studio session "${id}" already exists.`);
    while (this.#sessions.size >= this.#limit) {
      const removable = [...this.#sessions.entries()].find(([, entry]) => entry.state !== "committing");
      if (!removable) throw npcStudioError("AGE_NPC_STUDIO_SESSION_LIMIT", "Every NPC Studio session is currently committing.");
      this.#sessions.delete(removable[0]);
    }
    const session = snapshot({...data, id, kind, createdAt: Number(data.createdAt ?? now), expiresAt});
    this.#sessions.set(id, {session, state: "ready", token: null});
    return session;
  }

  get(id, {userId, kind = null, allowConsumed = false} = {}) {
    const entry = this.#entry(id, {userId, kind, allowConsumed});
    return entry.session;
  }

  reserve(id, {userId, kind = null} = {}) {
    const entry = this.#entry(id, {userId, kind});
    if (entry.state === "committing") throw npcStudioError("AGE_NPC_STUDIO_COMMIT_IN_FLIGHT", "This NPC Studio session is already committing.");
    if (entry.state === "consumed") throw npcStudioError("AGE_NPC_STUDIO_ALREADY_COMMITTED", "This NPC Studio session was already consumed.");
    const token = String(this.#idFactory("npc-reservation"));
    entry.state = "committing";
    entry.token = token;
    return Object.freeze({token, session: entry.session});
  }

  release(id, token) {
    const entry = this.#sessions.get(String(id));
    if (!entry || entry.state !== "committing" || entry.token !== token) return false;
    entry.state = "ready";
    entry.token = null;
    return true;
  }

  complete(id, token) {
    const entry = this.#sessions.get(String(id));
    if (!entry || entry.state !== "committing" || entry.token !== token) {
      throw npcStudioError("AGE_NPC_STUDIO_RESERVATION", "NPC Studio reservation is not active.");
    }
    entry.state = "consumed";
    entry.token = null;
    return entry.session;
  }

  cancel(id, {userId} = {}) {
    const entry = this.#entry(id, {userId, allowConsumed: true});
    if (entry.state === "committing") {
      throw npcStudioError("AGE_NPC_STUDIO_COMMIT_IN_FLIGHT", "An in-flight NPC Studio operation cannot be cancelled.");
    }
    return this.#sessions.delete(String(id));
  }

  status(id) {
    const entry = this.#sessions.get(String(id));
    if (!entry) return "missing";
    if (Number(this.#clock()) >= entry.session.expiresAt) return "expired";
    return entry.state;
  }

  prune(now = Number(this.#clock())) {
    let count = 0;
    for (const [id, entry] of this.#sessions) {
      if (entry.state !== "committing" && Number(now) >= entry.session.expiresAt) {
        this.#sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  clear() {
    this.#sessions.clear();
  }

  #entry(id, {userId, kind, allowConsumed = false} = {}) {
    const key = String(id ?? "");
    const entry = this.#sessions.get(key);
    if (!entry) throw npcStudioError("AGE_NPC_STUDIO_PREVIEW_EXPIRED", "The NPC Studio preview is missing or expired.");
    if (Number(this.#clock()) >= entry.session.expiresAt) {
      if (entry.state !== "committing") this.#sessions.delete(key);
      throw npcStudioError("AGE_NPC_STUDIO_PREVIEW_EXPIRED", "The NPC Studio preview expired.");
    }
    if (userId && entry.session.userId !== userId) throw npcStudioError("AGE_NPC_STUDIO_SESSION_OWNER", "This NPC Studio preview belongs to another user.");
    if (kind && entry.session.kind !== kind) throw npcStudioError("AGE_NPC_STUDIO_SESSION_KIND", "NPC Studio session type does not match this operation.");
    if (!allowConsumed && entry.state === "consumed") throw npcStudioError("AGE_NPC_STUDIO_ALREADY_COMMITTED", "This NPC Studio preview was already consumed.");
    return entry;
  }
}
