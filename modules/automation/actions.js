const SYSTEM_ID = "age-system";
const DIAGNOSTICS_FLAG = "actionDiagnostics";
const DEFAULT_DIAGNOSTICS_LIMIT = 50;
const MAX_TARGETS = 100;
const MAX_UUID_LENGTH = 512;

export const AGE_ACTION_SCHEMA_VERSION = 1;

const registry = new Map();
const templates = new Map();
const pendingActions = new Map();
let diagnosticQueue = Promise.resolve();

function clone(value) {
  if (value === undefined) return undefined;
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return structuredClone(value);
}

function randomId() {
  return globalThis.foundry?.utils?.randomID?.(16)
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializable(value, path = "value", seen = new Set()) {
  if (value === null || value === undefined) return;
  if (["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`AGE action ${path} must contain only finite numbers.`);
    return;
  }
  if (["function", "symbol", "bigint"].includes(typeof value)) {
    throw new TypeError(`AGE action ${path} is not serializable.`);
  }
  if (seen.has(value)) throw new TypeError(`AGE action ${path} contains a circular reference.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => serializable(entry, `${path}[${index}]`, seen));
  } else {
    if (!plainObject(value)) throw new TypeError(`AGE action ${path} must be plain serializable data.`);
    for (const [key, entry] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new TypeError(`AGE action ${path} contains an unsafe key.`);
      }
      serializable(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function normalizedString(value, name, {required = false, maximum = MAX_UUID_LENGTH} = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new TypeError(`AGE action ${name} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new TypeError(`AGE action ${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized && required) throw new TypeError(`AGE action ${name} is required.`);
  if (normalized.length > maximum) throw new TypeError(`AGE action ${name} is too long.`);
  return normalized || null;
}

function normalizedId(value) {
  const id = normalizedString(value ?? randomId(), "id", {required: true, maximum: 128});
  return id;
}

function normalizedType(value) {
  const type = normalizedString(value, "type", {required: true, maximum: 64});
  if (!/^[a-z][a-z0-9.-]*$/.test(type)) {
    throw new TypeError("AGE action types must use lowercase letters, numbers, dots, and hyphens.");
  }
  return type;
}

function normalizedTargets(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("AGE action targetUuids must be an array.");
  if (value.length > MAX_TARGETS) throw new RangeError(`AGE actions support at most ${MAX_TARGETS} targets.`);
  return Array.from(new Set(value.map((uuid, index) => normalizedString(uuid, `targetUuids[${index}]`, {required: true}))));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function diagnosticsLimit() {
  try {
    const configured = Number(game.settings.get(SYSTEM_ID, "actionHistoryLimit"));
    if (Number.isInteger(configured) && configured > 0) return Math.max(DEFAULT_DIAGNOSTICS_LIMIT, configured);
  } catch {
    // The API is also exercised before settings exist in isolated tests.
  }
  return DEFAULT_DIAGNOSTICS_LIMIT;
}

async function readDiagnostics() {
  const stored = await globalThis.game?.user?.getFlag?.(SYSTEM_ID, DIAGNOSTICS_FLAG);
  return Array.isArray(stored) ? clone(stored) : [];
}

async function writeDiagnostic(entry) {
  const task = diagnosticQueue.then(async () => {
    if (!globalThis.game?.user?.setFlag) return entry;
    try {
      const history = await readDiagnostics();
      history.push(clone(entry));
      await game.user.setFlag(SYSTEM_ID, DIAGNOSTICS_FLAG, history.slice(-diagnosticsLimit()));
    } catch (error) {
      console.warn("AGE System | Action diagnostics could not be persisted.", error);
    }
    return entry;
  }, async () => entry);
  diagnosticQueue = task.then(() => undefined, () => undefined);
  return task;
}

function safeSummary(handler, result, action) {
  try {
    const summary = handler.summarize ? handler.summarize(result, action) : null;
    if (summary === null || summary === undefined) return null;
    serializable(summary, "result summary");
    return clone(summary);
  } catch {
    return null;
  }
}

function callHook(name, ...args) {
  try {
    globalThis.Hooks?.callAll?.(name, ...args);
  } catch (error) {
    console.warn(`AGE System | ${name} hook failed.`, error);
  }
}

function definitionFor(type, handler) {
  return deepFreeze({
    type,
    label: String(handler.label ?? type),
    category: String(handler.category ?? type.split(".")[0]),
    mutates: handler.mutates === true,
    reversible: handler.reversible === true,
    supportsTargets: handler.supportsTargets === true
  });
}

function mergeTemplate(base, overrides) {
  const merged = {
    ...clone(base),
    ...clone(overrides),
    payload: {...clone(base.payload ?? {}), ...clone(overrides?.payload ?? {})},
    metadata: {...clone(base.metadata ?? {}), ...clone(overrides?.metadata ?? {})}
  };
  delete merged.id;
  return merged;
}

export class AgeActionService {
  static get schemaVersion() {
    return AGE_ACTION_SCHEMA_VERSION;
  }

  static register(type, handler, {replace = false} = {}) {
    const normalized = normalizedType(type);
    if (!plainObject(handler) || typeof handler.execute !== "function") {
      throw new TypeError(`AGE action handler ${normalized} requires an execute function.`);
    }
    if (registry.has(normalized) && !replace) throw new Error(`AGE action handler is already registered: ${normalized}`);
    registry.set(normalized, handler);
    return definitionFor(normalized, handler);
  }

  static registerTemplate(id, action, {replace = false} = {}) {
    const normalized = normalizedString(id, "template id", {required: true, maximum: 96});
    if (!/^[a-z][a-z0-9.-]*$/.test(normalized)) throw new TypeError("AGE action template IDs are invalid.");
    if (templates.has(normalized) && !replace) throw new Error(`AGE action template is already registered: ${normalized}`);
    const validated = this.validate({...action, id: action?.id ?? `template:${normalized}`});
    const stored = clone(validated);
    delete stored.id;
    templates.set(normalized, deepFreeze(stored));
    return this.template(normalized);
  }

  static definitions() {
    return Array.from(registry, ([type, handler]) => definitionFor(type, handler))
      .sort((left, right) => left.type.localeCompare(right.type));
  }

  static supports(type) {
    try {
      return registry.has(normalizedType(type));
    } catch {
      return false;
    }
  }

  static templates() {
    return Array.from(templates.keys()).sort().map(id => this.template(id));
  }

  static template(id) {
    const action = templates.get(id);
    return action ? deepFreeze({id, action: clone(action)}) : null;
  }

  static create(templateId, overrides = {}) {
    const template = templates.get(templateId);
    if (!template) throw new Error(`Unknown AGE action template: ${templateId}`);
    return this.validate({...mergeTemplate(template, overrides), templateId});
  }

  static validate(request, {requireHandler = true} = {}) {
    if (!plainObject(request)) throw new TypeError("AGE actions must be plain objects.");
    const schemaVersion = Number(request.schemaVersion ?? AGE_ACTION_SCHEMA_VERSION);
    if (schemaVersion !== AGE_ACTION_SCHEMA_VERSION) {
      throw new TypeError(`Unsupported AGE action schema version: ${request.schemaVersion}`);
    }
    const type = normalizedType(request.type);
    if (requireHandler && !registry.has(type)) throw new Error(`Unsupported AGE action type: ${type}`);
    const requestPayload = request.payload ?? {};
    const requestMetadata = request.metadata ?? {};
    if (!plainObject(requestPayload) || !plainObject(requestMetadata)) {
      throw new TypeError("AGE action payload and metadata must be plain objects.");
    }
    serializable(requestPayload, "payload");
    serializable(requestMetadata, "metadata");
    const payload = clone(requestPayload);
    const metadata = clone(requestMetadata);

    return deepFreeze({
      schemaVersion: AGE_ACTION_SCHEMA_VERSION,
      id: normalizedId(request.id),
      type,
      templateId: normalizedString(request.templateId, "templateId", {maximum: 96}),
      actorUuid: normalizedString(request.actorUuid, "actorUuid"),
      itemUuid: normalizedString(request.itemUuid, "itemUuid"),
      messageUuid: normalizedString(request.messageUuid, "messageUuid"),
      sourceUuid: normalizedString(request.sourceUuid, "sourceUuid"),
      targetUuids: normalizedTargets(request.targetUuids),
      payload,
      metadata
    });
  }

  static async preview(request) {
    const action = this.validate(request);
    const handler = registry.get(action.type);
    const preview = handler.preview
      ? await handler.preview(action)
      : {type: action.type, targetCount: action.targetUuids.length, mutates: handler.mutates === true};
    serializable(preview, "preview");
    return deepFreeze({action: clone(action), preview: clone(preview)});
  }

  static execute(request, {executor = null, context = {}} = {}) {
    const action = this.validate(request);
    if (pendingActions.has(action.id)) return pendingActions.get(action.id);
    const handler = registry.get(action.type);
    const run = typeof executor === "function" ? executor : handler.execute;

    const task = (async () => {
      const startedAt = Date.now();
      let status = "success";
      let result;
      try {
        if (handler.authorize && await handler.authorize(action, context) === false) {
          const error = new Error(`Permission denied for AGE action ${action.type}.`);
          error.code = "AGE_ACTION_PERMISSION";
          throw error;
        }
        const prepared = handler.preview ? await handler.preview(action, context) : null;
        callHook("ageSystemPreAction", clone(action), clone(prepared));
        result = await run(action, {...context, prepared});
        if (result === false || result === null) status = "cancelled";
        const finishedAt = Date.now();
        const diagnostic = {
          schemaVersion: AGE_ACTION_SCHEMA_VERSION,
          id: action.id,
          type: action.type,
          templateId: action.templateId,
          status,
          actorUuid: action.actorUuid,
          itemUuid: action.itemUuid,
          messageUuid: action.messageUuid,
          targetUuids: clone(action.targetUuids),
          userId: globalThis.game?.user?.id ?? null,
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
          summary: safeSummary(handler, result, action)
        };
        await writeDiagnostic(diagnostic);
        callHook("ageSystemActionCompleted", clone(action), clone(diagnostic));
        return {action: clone(action), result, diagnostic: clone(diagnostic)};
      } catch (error) {
        const finishedAt = Date.now();
        const diagnostic = {
          schemaVersion: AGE_ACTION_SCHEMA_VERSION,
          id: action.id,
          type: action.type,
          templateId: action.templateId,
          status: "failed",
          actorUuid: action.actorUuid,
          itemUuid: action.itemUuid,
          messageUuid: action.messageUuid,
          targetUuids: clone(action.targetUuids),
          userId: globalThis.game?.user?.id ?? null,
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
          error: {name: error?.name ?? "Error", code: error?.code ?? null, message: error?.message ?? String(error)}
        };
        await writeDiagnostic(diagnostic);
        callHook("ageSystemActionFailed", clone(action), clone(diagnostic));
        throw error;
      }
    })();

    pendingActions.set(action.id, task);
    task.finally(() => {
      if (pendingActions.get(action.id) === task) pendingActions.delete(action.id);
    }).catch(() => undefined);
    return task;
  }

  static pending(id) {
    return pendingActions.has(id);
  }

  static status() {
    return deepFreeze({
      schemaVersion: AGE_ACTION_SCHEMA_VERSION,
      registeredActions: registry.size,
      registeredTemplates: templates.size,
      pendingIds: Array.from(pendingActions.keys())
    });
  }

  static async history({type = null, status = null, limit = null} = {}) {
    await diagnosticQueue;
    let history = await readDiagnostics();
    if (type) history = history.filter(entry => entry.type === type);
    if (status) history = history.filter(entry => entry.status === status);
    const maximum = Number(limit);
    if (Number.isInteger(maximum) && maximum >= 0) history = history.slice(-maximum);
    return history;
  }

  static async clearHistory() {
    const task = diagnosticQueue.then(async () => {
      await globalThis.game?.user?.setFlag?.(SYSTEM_ID, DIAGNOSTICS_FLAG, []);
      return [];
    });
    diagnosticQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  static resetForTests() {
    registry.clear();
    templates.clear();
    pendingActions.clear();
    diagnosticQueue = Promise.resolve();
  }
}

export default AgeActionService;
