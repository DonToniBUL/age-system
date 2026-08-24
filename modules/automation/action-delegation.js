import {AgeActionService} from "./actions.js";

const SYSTEM_ID = "age-system";
const SOCKET_NAME = `system.${SYSTEM_ID}`;
const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT = 15000;
const RATE_WINDOW = 10000;
const RATE_LIMIT = 20;

const pendingRequests = new Map();
const processedRequests = new Set();
const requestRates = new Map();
let initializedSocket = null;
let socketListener = null;

function clone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return structuredClone(value);
}

function randomId() {
  return globalThis.foundry?.utils?.randomID?.(20)
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function users() {
  if (!globalThis.game?.users) return [];
  if (typeof game.users.values === "function") return Array.from(game.users.values());
  return Array.from(game.users);
}

function activeGms() {
  return users()
    .filter(user => user?.active && user?.isGM)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function userById(id) {
  return game.users?.get?.(id) ?? users().find(user => user?.id === id) ?? null;
}

function rateAllowed(userId) {
  const now = Date.now();
  const recent = (requestRates.get(userId) ?? []).filter(timestamp => now - timestamp < RATE_WINDOW);
  if (recent.length >= RATE_LIMIT) {
    requestRates.set(userId, recent);
    return false;
  }
  recent.push(now);
  requestRates.set(userId, recent);
  return true;
}

function rememberRequest(key) {
  processedRequests.add(key);
  if (processedRequests.size <= 500) return;
  const oldest = processedRequests.values().next().value;
  processedRequests.delete(oldest);
}

function serializedError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? "AGE_ACTION_DELEGATION_FAILED",
    message: error?.message ?? String(error)
  };
}

function responseError(data) {
  const error = new Error(data?.message ?? "The delegated AGE action failed.");
  error.name = data?.name ?? "Error";
  error.code = data?.code ?? "AGE_ACTION_DELEGATION_FAILED";
  return error;
}

export class AgeActionDelegationService {
  static get protocolVersion() {
    return PROTOCOL_VERSION;
  }

  static initialize(socket = game.socket) {
    if (!socket?.on || !socket?.emit) return false;
    if (initializedSocket === socket && socketListener) return true;
    if (initializedSocket?.off && socketListener) initializedSocket.off(SOCKET_NAME, socketListener);
    socketListener = (packet, senderUserId) => this._onSocket(packet, senderUserId);
    socket.on(SOCKET_NAME, socketListener);
    initializedSocket = socket;
    return true;
  }

  static status() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      initialized: Boolean(initializedSocket && socketListener),
      socketName: SOCKET_NAME,
      activeGmIds: activeGms().map(user => user.id),
      pending: pendingRequests.size
    };
  }

  static async request(request, {timeout = DEFAULT_TIMEOUT} = {}) {
    const action = AgeActionService.validate(request);
    if (game.user?.isGM) {
      return AgeActionService.execute(action, {context: {requestUser: game.user, delegated: false}});
    }
    if (!initializedSocket) this.initialize();
    if (!initializedSocket) throw new Error("AGE action delegation socket is unavailable.");
    const gm = activeGms()[0];
    if (!gm) {
      const error = new Error("No active GM is available for this AGE action.");
      error.code = "AGE_ACTION_NO_GM";
      throw error;
    }
    const milliseconds = Number(timeout);
    if (!Number.isFinite(milliseconds) || milliseconds < 1000 || milliseconds > 60000) {
      throw new RangeError("AGE action delegation timeout must be from 1000 to 60000 milliseconds.");
    }

    const requestId = randomId();
    const packet = {
      protocol: PROTOCOL_VERSION,
      kind: "request",
      requestId,
      gmId: gm.id,
      action: clone(action)
    };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        const error = new Error("The delegated AGE action timed out while waiting for the GM.");
        error.code = "AGE_ACTION_TIMEOUT";
        reject(error);
      }, milliseconds);
      pendingRequests.set(requestId, {resolve, reject, timer, gmId: gm.id, action: clone(action)});
      initializedSocket.emit(SOCKET_NAME, packet);
    });
    return promise;
  }

  static async _onSocket(packet, senderUserId) {
    if (!packet || packet.protocol !== PROTOCOL_VERSION || typeof senderUserId !== "string") return;
    if (packet.kind === "response") return this._handleResponse(packet, senderUserId);
    if (packet.kind !== "request" || !game.user?.isGM || packet.gmId !== game.user.id) return;

    const requester = userById(senderUserId);
    if (!requester?.active) return;
    const elected = activeGms()[0];
    if (!elected || elected.id !== game.user.id) return;
    if (!rateAllowed(senderUserId)) {
      return this._emitResponse(packet, senderUserId, {
        ok: false,
        error: {name: "Error", code: "AGE_ACTION_RATE_LIMIT", message: "Too many AGE action requests were submitted."}
      });
    }

    const requestId = typeof packet.requestId === "string" ? packet.requestId : "";
    const replayKey = `${senderUserId}:${requestId}`;
    if (!requestId || requestId.length > 128 || processedRequests.has(replayKey)) return;
    rememberRequest(replayKey);

    try {
      const received = AgeActionService.validate(packet.action);
      const action = AgeActionService.validate({
        ...clone(received),
        id: `delegated:${senderUserId}:${requestId}`
      });
      const execution = await AgeActionService.execute(action, {
        context: {requestUser: requester, delegated: true, requestId, senderUserId}
      });
      return this._emitResponse(packet, senderUserId, {
        ok: true,
        diagnostic: clone(execution.diagnostic)
      });
    } catch (error) {
      return this._emitResponse(packet, senderUserId, {ok: false, error: serializedError(error)});
    }
  }

  static _emitResponse(request, recipientId, data) {
    if (!initializedSocket?.emit) return false;
    initializedSocket.emit(SOCKET_NAME, {
      protocol: PROTOCOL_VERSION,
      kind: "response",
      requestId: request.requestId,
      gmId: game.user.id,
      recipientId,
      ...data
    });
    return true;
  }

  static _handleResponse(packet, senderUserId) {
    if (packet.recipientId !== game.user?.id) return;
    const pending = pendingRequests.get(packet.requestId);
    if (!pending || pending.gmId !== senderUserId || packet.gmId !== senderUserId) return;
    clearTimeout(pending.timer);
    pendingRequests.delete(packet.requestId);
    if (!packet.ok) return pending.reject(responseError(packet.error));
    return pending.resolve({
      action: clone(pending.action),
      result: null,
      diagnostic: clone(packet.diagnostic ?? null),
      delegated: true,
      gmId: senderUserId
    });
  }

  static resetForTests() {
    if (initializedSocket?.off && socketListener) initializedSocket.off(SOCKET_NAME, socketListener);
    for (const pending of pendingRequests.values()) clearTimeout(pending.timer);
    pendingRequests.clear();
    processedRequests.clear();
    requestRates.clear();
    initializedSocket = null;
    socketListener = null;
  }
}

export default AgeActionDelegationService;
