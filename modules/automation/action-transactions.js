const SYSTEM_ID = "age-system";
const HISTORY_FLAG = "actionHistory";
const DEFAULT_HISTORY_LIMIT = 20;
export const ACTION_HISTORY_SCHEMA_VERSION = 2;
let historyQueue = Promise.resolve();
const operationQueue = new Map();

const clone = value => foundry.utils.deepClone(value);
const getProperty = (object, path) => foundry.utils.getProperty(object, path);
const sourceProperty = (document, path) => document?._source && typeof document._source === "object"
  ? getProperty(document._source, path)
  : getProperty(document, path);
const equal = (left, right) => {
  if (foundry.utils.equals) return foundry.utils.equals(left, right);
  if (foundry.utils.objectsEqual) return foundry.utils.objectsEqual(left, right);
  return JSON.stringify(left) === JSON.stringify(right);
};

function randomId() {
  return foundry.utils.randomID?.(16) ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function validUpdatePath(path) {
  if (typeof path !== "string" || !path.trim() || path.includes(".-=")) return false;
  return !path.split(".").some(part => ["__proto__", "prototype", "constructor"].includes(part));
}

function normalizeOperationId(value) {
  if (value === null || value === undefined || value === "") return randomId();
  if (typeof value !== "string") throw new TypeError("AGE operation IDs must be strings.");
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) throw new TypeError("AGE operation IDs must contain 1 to 128 characters.");
  return normalized;
}

function sameOptions(left, right) {
  return equal(left ?? {}, right ?? {});
}

function batchKey(document) {
  const implementation = document?.constructor?.implementation ?? document?.constructor;
  if (typeof implementation?.updateDocuments !== "function" || !document?.id) return null;
  const parent = document.parent ?? null;
  const pack = parent?.pack ?? document.pack ?? null;
  return {implementation, parent, pack};
}

function batchRequests(requests) {
  const groups = [];
  for (const request of requests) {
    const key = batchKey(request.document);
    if (!key) {
      groups.push({batched: false, requests: [request]});
      continue;
    }
    let group = groups.at(-1);
    if (!(group?.batched
      && group.implementation === key.implementation
      && group.parent === key.parent
      && group.pack === key.pack
      && sameOptions(group.options, request.options))) {
      group = {batched: true, implementation: key.implementation, parent: key.parent, pack: key.pack,
        options: {...(request.options ?? {})}, requests: []};
      groups.push(group);
    }
    group.requests.push(request);
  }
  return groups;
}

function assignUpdateValue(update, path, value) {
  if (value !== undefined) {
    const snapshot = clone(value);
    // Object-valued transaction entries are authoritative historical
    // snapshots. A plain object update would be merged by AGE's AnyField
    // safety boundary and could retain keys which did not exist in the
    // snapshot. Preserve exact undo/redo semantics with an explicit
    // replacement at the tracked path. Scalars and null retain their normal
    // update meaning; undefined continues to use Foundry deletion syntax.
    update[path] = snapshot !== null && typeof snapshot === "object"
      ? foundry.data.operators.ForcedReplacement.create(snapshot)
      : snapshot;
    return;
  }
  const parts = path.split(".");
  const property = parts.pop();
  const parent = parts.join(".");
  update[`${parent ? `${parent}.` : ""}-=${property}`] = null;
}

function automationEnabled() {
  try {
    return game.settings.get(SYSTEM_ID, "automationMode") === "assist"
      && game.settings.get(SYSTEM_ID, "enableActionUndo") !== false;
  } catch {
    return false;
  }
}

function historyLimit() {
  try {
    const configured = Number(game.settings.get(SYSTEM_ID, "actionHistoryLimit"));
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_HISTORY_LIMIT;
  } catch {
    return DEFAULT_HISTORY_LIMIT;
  }
}

async function resolveDocument(uuid) {
  if (!uuid) return null;
  return foundry.utils.fromUuid(uuid);
}

async function readHistory() {
  const history = await game.user?.getFlag?.(SYSTEM_ID, HISTORY_FLAG);
  return Array.isArray(history) ? clone(history) : [];
}

async function writeHistory(history) {
  const bounded = history.slice(-historyLimit());
  await game.user?.setFlag?.(SYSTEM_ID, HISTORY_FLAG, bounded);
  return bounded;
}

function withHistoryLock(callback) {
  const task = historyQueue.then(callback, callback);
  historyQueue = task.then(() => undefined, () => undefined);
  return task;
}

export class AgeActionTransaction {
  constructor({id = null, label = "AGE action", type = "generic", sourceUuid = null, metadata = {}} = {}) {
    this.id = normalizeOperationId(id);
    this.label = label;
    this.type = type;
    this.sourceUuid = sourceUuid;
    this.metadata = clone(metadata ?? {});
    this.enabled = automationEnabled();
    this._tracked = new Map();
    this._entry = null;
  }

  track(document, paths) {
    // Always retain an in-memory snapshot so technical failures can be rolled
    // back even when user-facing automation history is disabled.
    if (!document?.uuid) return this;
    const normalizedPaths = Array.isArray(paths) ? paths : [paths];
    for (const path of normalizedPaths.filter(Boolean)) {
      const key = `${document.uuid}\u0000${path}`;
      if (this._tracked.has(key)) continue;
      this._tracked.set(key, {
        document,
        uuid: document.uuid,
        documentName: document.documentName ?? document.constructor?.name ?? "Document",
        path,
        // Transaction history records persisted source, not prepared Actor or
        // Item data which may contain derived-only fields.
        before: clone(sourceProperty(document, path))
      });
    }
    return this;
  }

  async commit() {
    if (this._entry) return clone(this._entry);
    const operations = [];
    for (const tracked of this._tracked.values()) {
      const after = clone(sourceProperty(tracked.document, tracked.path));
      if (equal(tracked.before, after)) continue;
      operations.push({
        uuid: tracked.uuid,
        documentName: tracked.documentName,
        path: tracked.path,
        before: tracked.before,
        after
      });
    }
    if (!operations.length) return null;

    this._entry = {
      schemaVersion: ACTION_HISTORY_SCHEMA_VERSION,
      id: this.id,
      label: this.label,
      type: this.type,
      sourceUuid: this.sourceUuid,
      metadata: this.metadata,
      systemVersion: game.system?.version ?? null,
      userId: game.user?.id ?? null,
      timestamp: Date.now(),
      undone: false,
      operations
    };
    if (this.enabled) {
      await withHistoryLock(async () => {
        const history = await readHistory();
        history.push(this._entry);
        await writeHistory(history);
      });
    }
    return clone(this._entry);
  }

  async rollback({removeHistory = false, strict = false, documentUuids = null} = {}) {
    let operations = this._entry?.operations ?? Array.from(this._tracked.values()).map(tracked => ({
      uuid: tracked.uuid,
      path: tracked.path,
      before: tracked.before,
      after: clone(sourceProperty(tracked.document, tracked.path))
    }));
    if (documentUuids) {
      const allowed = documentUuids instanceof Set ? documentUuids : new Set(documentUuids);
      operations = operations.filter(operation => allowed.has(operation.uuid));
    }
    await AgeTransactionService.restoreOperations(operations, {direction: "before", strict});
    if (removeHistory && this.enabled && this._entry) {
      await withHistoryLock(async () => {
        const history = await readHistory();
        await writeHistory(history.filter(entry => entry.id !== this._entry.id));
      });
    }
    return true;
  }
}

export class AgeTransactionService {
  static _undoLock = false;

  static get schemaVersion() {
    return ACTION_HISTORY_SCHEMA_VERSION;
  }

  static get enabled() {
    return automationEnabled();
  }

  static begin(metadata = {}) {
    return new AgeActionTransaction(metadata);
  }

  /**
   * Validate and coalesce a list of document updates without mutating any
   * document. This is the common preflight contract for future AGE Actions.
   */
  static preflight(updates) {
    if (!Array.isArray(updates) || !updates.length) {
      throw new TypeError("At least one AGE document update is required.");
    }

    const grouped = new Map();
    for (const request of updates) {
      const document = request?.document;
      const update = request?.update;
      if (!document?.uuid || typeof document.update !== "function") {
        throw new TypeError("Every AGE update requires a persisted Foundry document.");
      }
      if (!update || typeof update !== "object" || Array.isArray(update)) {
        throw new TypeError(`AGE update data must be an object for ${document.uuid}.`);
      }

      const paths = Object.keys(update);
      if (!paths.length) throw new TypeError(`AGE update data is empty for ${document.uuid}.`);
      for (const path of paths) {
        if (!validUpdatePath(path)) throw new TypeError(`AGE update path is not reversible: ${path}`);
      }

      const group = grouped.get(document.uuid) ?? {
        document,
        update: {},
        options: {...(request.options ?? {})}
      };
      for (const path of paths) group.update[path] = clone(update[path]);
      group.options = {...group.options, ...(request.options ?? {})};
      grouped.set(document.uuid, group);
    }
    return Array.from(grouped.values());
  }

  /**
   * Apply one or more document updates as a single reversible operation.
   * Reusing an operationId while it is still running returns the same Promise,
   * preventing duplicate spending from rapid clicks or duplicate integrations.
   */
  static execute({
    label = "AGE action",
    type = "generic",
    sourceUuid = null,
    metadata = {},
    operationId = null,
    updates = []
  } = {}) {
    const id = normalizeOperationId(operationId);
    if (operationQueue.has(id)) return operationQueue.get(id);

    const task = (async () => {
      const requests = this.preflight(updates);
      const transaction = this.begin({id, label, type, sourceUuid, metadata});
      for (const request of requests) transaction.track(request.document, Object.keys(request.update));

      const results = [];
      const appliedDocuments = new Set();
      try {
        for (const group of batchRequests(requests)) {
          if (group.batched && group.requests.length > 1) {
            const updates = group.requests.map(request => ({_id: request.document.id, ...request.update}));
            // A bulk implementation may apply only part of a request before
            // rejecting. Mark the entire compatible group for restoration;
            // restoring an unchanged document is safe and preserves the
            // transaction's all-or-nothing contract.
            for (const request of group.requests) appliedDocuments.add(request.document.uuid);
            const updated = await group.implementation.updateDocuments(updates, {
              ...group.options,
              parent: group.parent,
              ...(group.pack ? {pack: group.pack} : {}),
              ageAutomation: true,
              ageOperationId: id
            });
            results.push(...updated);
            continue;
          }
          const request = group.requests[0];
          results.push(await request.document.update(request.update, {
              ...request.options,
              ageAutomation: true,
              ageOperationId: id
            }));
          appliedDocuments.add(request.document.uuid);
        }
        const entry = await transaction.commit();
        return {operationId: id, results, entry, transaction};
      } catch (error) {
        if (appliedDocuments.size) {
          await transaction.rollback({removeHistory: true, strict: false, documentUuids: appliedDocuments});
        }
        throw error;
      }
    })();

    operationQueue.set(id, task);
    task.finally(() => {
      if (operationQueue.get(id) === task) operationQueue.delete(id);
    }).catch(() => undefined);
    return task;
  }

  static pending(operationId) {
    return operationQueue.has(operationId);
  }

  static async history() {
    await historyQueue;
    return readHistory();
  }

  static async clearHistory() {
    return withHistoryLock(() => writeHistory([]));
  }

  static async recordDocumentUpdate(document, updateData, metadata = {}) {
    const execution = await this.execute({
      ...metadata,
      operationId: metadata.operationId ?? null,
      updates: [{document, update: updateData, options: metadata.updateOptions ?? {}}]
    });
    return {result: execution.results[0], transaction: execution.transaction, entry: execution.entry};
  }

  static async restoreOperations(operations, {direction = "before", strict = true} = {}) {
    const expectedKey = direction === "before" ? "after" : "before";
    const grouped = new Map();
    for (const operation of operations ?? []) {
      const document = await resolveDocument(operation.uuid);
      if (!document?.update) throw new Error(`AGE transaction document is unavailable: ${operation.uuid}`);
      const current = clone(sourceProperty(document, operation.path));
      if (strict && !equal(current, operation[expectedKey])) {
        throw new Error(`AGE transaction conflict at ${operation.uuid}:${operation.path}`);
      }
      // A failed bulk request can leave some documents untouched. Avoid a
      // needless restoration write when the desired value is already present;
      // this also prevents an unrelated validation failure from masking the
      // original transaction error.
      if (equal(current, operation[direction])) continue;
      const group = grouped.get(operation.uuid) ?? {document, update: {}};
      assignUpdateValue(group.update, operation.path, operation[direction]);
      grouped.set(operation.uuid, group);
    }

    const applied = [];
    try {
      for (const group of grouped.values()) {
        await group.document.update(group.update, {ageUndo: true});
        applied.push(group);
      }
    } catch (error) {
      const rollbackDirection = direction === "before" ? "after" : "before";
      for (const group of applied.reverse()) {
        const rollback = {};
        for (const operation of operations.filter(op => op.uuid === group.document.uuid)) {
          assignUpdateValue(rollback, operation.path, operation[rollbackDirection]);
        }
        await group.document.update(rollback, {ageUndoRollback: true});
      }
      throw error;
    }
    return applied.length;
  }

  static async undoLast() {
    if (this._undoLock) throw new Error("An AGE undo operation is already running.");
    this._undoLock = true;
    try {
      return withHistoryLock(async () => {
        const history = await readHistory();
        const index = history.findLastIndex(entry => !entry.undone && Array.isArray(entry.operations) && entry.operations.length);
        if (index < 0) return null;
        const entry = history[index];
        await this.restoreOperations(entry.operations, {direction: "before", strict: true});
        history[index] = {...entry, undone: true, undoneAt: Date.now(), undoneBy: game.user?.id ?? null};
        await writeHistory(history);
        return clone(history[index]);
      });
    } finally {
      this._undoLock = false;
    }
  }
}

export default AgeTransactionService;
