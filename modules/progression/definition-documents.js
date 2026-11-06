import {validateProgressionDefinition} from "./contracts.js";
import {canonicalClone, canonicalJson, definitionDigest} from "./canonical.js";
import {
  AGE_PROGRESSION_DEFINITION_LIFECYCLE,
  classifyProgressionDefinition,
  compactProgressionDefinitionIssues,
} from "./definition-lifecycle.js";

export const AGE_PROGRESSION_DEFINITION_ITEM_TYPE = "progression";
export const AGE_PROGRESSION_DEFINITION_DOCUMENT_VERSION = 1;
export const AGE_PROGRESSION_DEFINITION_ICON = "icons/svg/book.svg";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DOCUMENT_SYSTEM_KEYS = new Set(["definition", "digest", "enabled", "provenance"]);
const PROVENANCE_KEYS = new Set(["schemaVersion", "originKind", "originId", "importedAt", "importedBy"]);
const ORIGIN_KINDS = new Set(["system", "module", "world", "compendium", "import"]);
const PROVIDER_ID_PREFIX = "progression-document:";
const DEFAULT_OBSERVER_LEVEL = 2;

function documentError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "AgeProgressionDefinitionDocumentError";
  error.code = code;
  error.details = snapshot(details);
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

function snapshot(value) {
  return deepFreeze(canonicalClone(value));
}

function requiredText(value, label, code = "metadata") {
  if (typeof value !== "string" || !value.trim()) throw documentError(code, `${label} must be a non-empty string.`);
  return value.trim();
}

function optionalText(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, label);
}

function issue(path, message, code = "invalid") {
  return Object.freeze({path, message, code});
}

function prefixDefinitionPath(path) {
  return path === "$" ? "$.system.definition" : `$.system.definition${path.slice(1)}`;
}

function rawDocumentSource(document) {
  if (isPlainObject(document?._source)) return document._source;
  if (document?.toObject instanceof Function) {
    const source = document.toObject(true);
    if (isPlainObject(source)) return source;
  }
  if (isPlainObject(document)) return document;
  throw documentError("document-source", "Progression definition Item does not expose complete raw source data.");
}

function documentUuid(document, source = null) {
  const uuid = document?.uuid ?? source?.uuid;
  if (typeof uuid === "string" && uuid) return uuid;
  const id = document?.id ?? document?._id ?? source?._id;
  if (typeof id !== "string" || !id) throw documentError("document-uuid", "Progression definition Item has no stable UUID or id.");
  return `Item.${id}`;
}

function documentPackId(document) {
  return document?.pack
    ?? document?.compendium?.collection
    ?? null;
}

function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (collection.values instanceof Function) return [...collection.values()];
  try { return [...collection]; } catch { return []; }
}

function compareVersions(left, right) {
  const parse = version => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(String(version));
    if (!match) throw documentError("version", `Invalid semantic version "${version}".`);
    return {
      core: match.slice(1, 4).map(value => BigInt(value)),
      prerelease: match[4]?.split(".") ?? null,
    };
  };
  const leftVersion = parse(left);
  const rightVersion = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.core[index] > rightVersion.core[index]) return 1;
    if (leftVersion.core[index] < rightVersion.core[index]) return -1;
  }
  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0;
  if (!leftVersion.prerelease) return 1;
  if (!rightVersion.prerelease) return -1;
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftIdentifier);
      const rightNumber = BigInt(rightIdentifier);
      if (leftNumber > rightNumber) return 1;
      if (leftNumber < rightNumber) return -1;
      return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

function normalizeProvenance(value = {}, {
  originKind = "world",
  originId = undefined,
  importedAt = undefined,
  importedBy = undefined,
} = {}) {
  if (!isPlainObject(value)) throw documentError("provenance", "Progression definition provenance must be a plain object.");
  const unknown = Object.keys(value).filter(key => !PROVENANCE_KEYS.has(key));
  if (unknown.length) throw documentError("provenance", `Unknown progression provenance field(s): ${unknown.join(", ")}.`, {unknown});
  const normalizedKind = value.originKind ?? originKind;
  if (!ORIGIN_KINDS.has(normalizedKind)) throw documentError("provenance", `Unsupported progression provenance origin "${normalizedKind}".`);
  const normalized = {
    schemaVersion: AGE_PROGRESSION_DEFINITION_DOCUMENT_VERSION,
    originKind: normalizedKind,
  };
  const normalizedOriginId = optionalText(value.originId ?? originId, "provenance.originId");
  if (normalizedOriginId !== undefined) normalized.originId = normalizedOriginId;
  const normalizedImportedAt = optionalText(value.importedAt ?? importedAt, "provenance.importedAt");
  const normalizedImportedBy = optionalText(value.importedBy ?? importedBy, "provenance.importedBy");
  if (normalizedKind === "import") {
    if (!normalizedImportedAt || !Number.isFinite(Date.parse(normalizedImportedAt))) {
      throw documentError("provenance", "Imported progression provenance requires a valid importedAt timestamp.");
    }
    if (!normalizedImportedBy) throw documentError("provenance", "Imported progression provenance requires importedBy.");
    normalized.importedAt = new Date(normalizedImportedAt).toISOString();
    normalized.importedBy = normalizedImportedBy;
  } else if (normalizedImportedAt !== undefined || normalizedImportedBy !== undefined) {
    throw documentError("provenance", "importedAt/importedBy are only allowed for imported progression definitions.");
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== AGE_PROGRESSION_DEFINITION_DOCUMENT_VERSION) {
    throw documentError("provenance-version", `Progression provenance schemaVersion must be ${AGE_PROGRESSION_DEFINITION_DOCUMENT_VERSION}.`);
  }
  return snapshot(normalized);
}

function validateProvenance(value, path, issues) {
  if (!isPlainObject(value)) {
    issues.push(issue(path, "must be a plain object", "object"));
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!PROVENANCE_KEYS.has(key)) issues.push(issue(`${path}.${key}`, "is not allowed", "unknown-key"));
  }
  if (value.schemaVersion !== AGE_PROGRESSION_DEFINITION_DOCUMENT_VERSION) {
    issues.push(issue(`${path}.schemaVersion`, `must be ${AGE_PROGRESSION_DEFINITION_DOCUMENT_VERSION}`, "schema-version"));
  }
  if (!ORIGIN_KINDS.has(value.originKind)) issues.push(issue(`${path}.originKind`, "is not a supported origin", "origin-kind"));
  if (value.originId !== undefined && (typeof value.originId !== "string" || !value.originId.trim())) {
    issues.push(issue(`${path}.originId`, "must be a non-empty string", "string"));
  }
  if (value.originKind === "import") {
    if (typeof value.importedAt !== "string" || !Number.isFinite(Date.parse(value.importedAt))) {
      issues.push(issue(`${path}.importedAt`, "must be a valid timestamp for an import", "timestamp"));
    }
    if (typeof value.importedBy !== "string" || !value.importedBy.trim()) {
      issues.push(issue(`${path}.importedBy`, "must identify the importing GM", "string"));
    }
  } else {
    if (value.importedAt !== undefined) issues.push(issue(`${path}.importedAt`, "is only allowed for an import", "origin-field"));
    if (value.importedBy !== undefined) issues.push(issue(`${path}.importedBy`, "is only allowed for an import", "origin-field"));
  }
  return value;
}

function providerMetadata(document, source, provenance, environment) {
  const uuid = documentUuid(document, source);
  const packId = documentPackId(document);
  if (packId) {
    const pack = environment?.game?.packs?.get?.(packId) ?? null;
    return snapshot({
      kind: "compendium",
      id: String(packId),
      // The progression Item is the rules definition users select. The pack
      // name remains available through `id`, but using it as the primary
      // label made every definition in one compendium look identical.
      label: String(source.name ?? document?.name ?? pack?.metadata?.label ?? pack?.title ?? packId),
      containerUuid: uuid,
    });
  }
  const imported = provenance?.originKind === "import";
  const worldId = environment?.game?.world?.id ?? environment?.game?.world?.name ?? "world";
  return snapshot({
    kind: imported ? "import" : "world",
    id: imported ? `import:${source._id ?? document?.id ?? uuid}` : `world:${worldId}`,
    label: String(source.name ?? document?.name ?? provenance?.originId ?? "AGE progression definition"),
    containerUuid: uuid,
  });
}

/**
 * Validate the strict persisted representation without trusting its stored
 * checksum.  The DefinitionV1 remains exact under `system.definition`; all
 * provider/container data is kept beside it and never affects rule semantics.
 */
export async function validateProgressionDefinitionDocument(document, {environment = globalThis} = {}) {
  let source;
  try {
    source = rawDocumentSource(document);
  } catch (error) {
    return snapshot({valid: false, issues: [issue("$", error.message, error.code ?? "document-source")]});
  }
  const issues = [];
  if ((source.type ?? document?.type) !== AGE_PROGRESSION_DEFINITION_ITEM_TYPE) {
    issues.push(issue("$.type", `must be "${AGE_PROGRESSION_DEFINITION_ITEM_TYPE}"`, "document-type"));
  }
  if (document?.parent || document?.actor || document?.isOwned === true) {
    issues.push(issue("$.parent", "progression definitions must be top-level Items, never owned/embedded Items", "owned-document"));
  }
  const system = source.system;
  if (!isPlainObject(system)) {
    issues.push(issue("$.system", "must be a plain object", "object"));
    return snapshot({valid: false, issues});
  }
  for (const key of Object.keys(system)) {
    if (!DOCUMENT_SYSTEM_KEYS.has(key)) issues.push(issue(`$.system.${key}`, "is not allowed", "unknown-key"));
  }
  if (typeof system.enabled !== "boolean") issues.push(issue("$.system.enabled", "must be boolean", "boolean"));
  const provenance = validateProvenance(system.provenance, "$.system.provenance", issues);
  const lifecycle = classifyProgressionDefinition(system.definition, {enabled: system.enabled});
  issues.push(...lifecycle.issues.map(entry => issue(prefixDefinitionPath(entry.path), entry.message, entry.code)));
  let digest = null;
  if (lifecycle.valid) {
    try {
      digest = await definitionDigest(system.definition);
    } catch (error) {
      issues.push(issue("$.system.definition", error.message, "digest"));
    }
  }
  if (lifecycle.valid && (typeof system.digest !== "string" || !DIGEST_PATTERN.test(system.digest))) {
    issues.push(issue("$.system.digest", "must be a lowercase SHA-256 digest", "digest-format"));
  } else if (digest && system.digest !== digest) {
    issues.push(issue("$.system.digest", "does not match the canonical DefinitionV1 digest", "digest-mismatch"));
  }
  const valid = lifecycle.valid && issues.length === 0;
  const state = valid
    ? (system.enabled ? AGE_PROGRESSION_DEFINITION_LIFECYCLE.ACTIVE : AGE_PROGRESSION_DEFINITION_LIFECYCLE.VALID)
    : (lifecycle.state === AGE_PROGRESSION_DEFINITION_LIFECYCLE.DRAFT && issues.every(entry => entry.code === "definition-draft")
      ? AGE_PROGRESSION_DEFINITION_LIFECYCLE.DRAFT
      : AGE_PROGRESSION_DEFINITION_LIFECYCLE.INVALID);
  if (!valid) return snapshot({valid, state, active: false, runnable: false, issues: compactProgressionDefinitionIssues(issues)});
  const provider = providerMetadata(document, source, provenance, environment);
  return snapshot({
    valid,
    state,
    active: system.enabled,
    runnable: system.enabled,
    issues: [],
    documentUuid: documentUuid(document, source),
    enabled: system.enabled,
    definition: canonicalClone(system.definition),
    digest,
    provenance: canonicalClone(provenance),
    provider,
  });
}

export async function assertProgressionDefinitionDocument(document, options = {}) {
  const result = await validateProgressionDefinitionDocument(document, options);
  if (!result.valid) {
    throw documentError("document-invalid", "Progression definition Item failed validation.", {issues: result.issues});
  }
  return result;
}

/** Build one complete source for an atomic top-level Item creation. */
export async function createProgressionDefinitionItemSource(definition, {
  name = null,
  img = AGE_PROGRESSION_DEFINITION_ICON,
  folder = null,
  enabled = true,
  ownership = {default: DEFAULT_OBSERVER_LEVEL},
  provenance = {},
} = {}) {
  const validation = validateProgressionDefinition(definition);
  if (!validation.valid) {
    throw documentError("definition-invalid", "Cannot persist an invalid progression definition.", {issues: validation.issues});
  }
  if (typeof enabled !== "boolean") throw documentError("enabled", "Progression definition enabled must be boolean.");
  const storedDefinition = canonicalClone(definition);
  const digest = await definitionDigest(storedDefinition);
  const normalizedProvenance = normalizeProvenance(provenance);
  return snapshot({
    name: optionalText(name, "name") ?? storedDefinition.id,
    type: AGE_PROGRESSION_DEFINITION_ITEM_TYPE,
    img: optionalText(img, "img") ?? AGE_PROGRESSION_DEFINITION_ICON,
    folder,
    ownership: isPlainObject(ownership) ? canonicalClone(ownership) : {default: DEFAULT_OBSERVER_LEVEL},
    system: {
      definition: storedDefinition,
      digest,
      enabled,
      provenance: normalizedProvenance,
    },
  });
}

/** Reject every progression-definition mutation which is not a GM, top-level operation. */
export function assertProgressionDefinitionMutation({
  user = globalThis.game?.user,
  document = null,
  action = "update",
  environment = globalThis,
} = {}) {
  if (user?.isGM !== true) throw documentError("permission", "Only a GM may mutate progression definition Items.", {action});
  if (document && (document.parent || document.actor || document.isOwned === true)) {
    throw documentError("owned-document", "Progression definition Items cannot be embedded in an Actor.", {action});
  }
  if (document && action !== "create") {
    try {
      if (document.canUserModify instanceof Function && document.canUserModify(user, action) !== true) {
        throw documentError("permission", `The GM may not ${action} this progression definition Item.`, {action});
      }
    } catch (error) {
      if (error?.name === "AgeProgressionDefinitionDocumentError") throw error;
      throw documentError("permission", `Unable to verify permission to ${action} this progression definition Item.`, {action});
    }
    const packId = documentPackId(document);
    const pack = packId ? environment?.game?.packs?.get?.(packId) : null;
    if (pack?.locked === true) {
      throw documentError("pack-locked", `Compendium "${packId}" is locked.`, {action, packId});
    }
    if (pack?.testUserPermission instanceof Function) {
      try {
        if (pack.testUserPermission(user, "OWNER") !== true) {
          throw documentError("permission", `The GM does not own Compendium "${packId}".`, {action, packId});
        }
      } catch (error) {
        if (error?.name === "AgeProgressionDefinitionDocumentError") throw error;
        throw documentError("permission", `Unable to verify ownership of Compendium "${packId}".`, {action, packId});
      }
    }
  }
  return true;
}

function itemDocumentClass(environment) {
  const documentClass = environment?.CONFIG?.Item?.documentClass
    ?? environment?.game?.items?.documentClass
    ?? environment?.Item
    ?? null;
  if (!(documentClass?.createDocuments instanceof Function)) {
    throw documentError("item-collection", "Foundry Item.createDocuments is unavailable.");
  }
  return documentClass;
}

function isTopLevelDefinitionDocument(document) {
  return !document?.parent && !document?.actor && document?.isOwned !== true;
}

function assertDefinitionItemType(document) {
  if ((document?.type ?? document?._source?.type) !== AGE_PROGRESSION_DEFINITION_ITEM_TYPE) {
    throw documentError("document-type", "Document is not a progression definition Item.");
  }
}

function forcedReplacement(environment, value, path) {
  const ForcedReplacement = environment?.foundry?.data?.operators?.ForcedReplacement
    ?? globalThis.foundry?.data?.operators?.ForcedReplacement;
  if (!(ForcedReplacement?.create instanceof Function)) {
    throw documentError("data-operator", `Foundry's atomic replacement operator is unavailable for ${path}.`);
  }
  return ForcedReplacement.create(canonicalClone(value));
}

/**
 * Core-owned Item provider. It is intentionally not an authoring UI: it owns
 * persistence, validation, registration, hot reload, and safe import/export.
 */
export class AgeProgressionDefinitionDocumentProvider {
  #service;
  #environment;
  #logger;
  #clock;
  #records = new Map();
  #validationIssues = new Map();
  #conflictIssues = new Map();
  #scanIssues = new Map();
  #active = new Map();
  #documentStates = new Map();
  #ownedDefinitionIds = new Set();
  #hooks = [];
  #unsubscribeServiceChanges = null;
  #suppressServiceChanges = 0;
  #queue = Promise.resolve();
  #started = false;

  constructor({service, environment = globalThis, logger = console, clock = () => Date.now()} = {}) {
    if (!(service?.registerDefinition instanceof Function)
      || !(service?.unregisterDefinition instanceof Function)
      || !(service?.definitionRecord instanceof Function)) {
      throw documentError("service", "Definition document provider requires the shared progression service.");
    }
    if (!(clock instanceof Function)) throw documentError("clock", "Definition document provider clock must be a function.");
    this.#service = service;
    this.#environment = environment;
    this.#logger = logger;
    this.#clock = clock;
  }

  get started() { return this.#started; }

  records({definitionId = null, enabled = null} = {}) {
    return Object.freeze([...this.#records.values()]
      .filter(record => !definitionId || record.definition.id === definitionId)
      .filter(record => enabled === null || record.enabled === enabled)
      .sort((left, right) => left.documentUuid.localeCompare(right.documentUuid)));
  }

  issues() {
    const entries = [];
    for (const [documentUuid, issues] of this.#validationIssues) entries.push({documentUuid, issues});
    for (const [documentUuid, issues] of this.#conflictIssues) entries.push({documentUuid, issues});
    for (const [documentUuid, issues] of this.#scanIssues) entries.push({documentUuid, issues});
    return snapshot(entries.sort((left, right) => left.documentUuid.localeCompare(right.documentUuid)));
  }

  activeDefinitions() {
    return snapshot([...this.#active.entries()]
      .map(([definitionId, value]) => ({definitionId, ...value}))
      .sort((left, right) => left.definitionId.localeCompare(right.definitionId)));
  }

  async initialize({installHooks = true} = {}) {
    if (this.#started) return this.status();
    await this.refreshAll();
    if (installHooks) this.#installHooks();
    if (this.#service.subscribeDefinitionChanges instanceof Function) {
      this.#unsubscribeServiceChanges = this.#service.subscribeDefinitionChanges(event => {
        this.#handleServiceDefinitionChange(event);
      });
    }
    this.#started = true;
    return this.status();
  }

  async stop({unregister = true} = {}) {
    await this.whenIdle();
    this.#started = false;
    this.#unsubscribeServiceChanges?.();
    this.#unsubscribeServiceChanges = null;
    const hooks = this.#environment?.Hooks ?? globalThis.Hooks;
    if (hooks?.off instanceof Function) {
      for (const {name, id, callback} of this.#hooks) hooks.off(name, id ?? callback);
    }
    this.#hooks = [];
    if (unregister) {
      for (const id of [...this.#ownedDefinitionIds]) this.#unregisterOwned(id);
    }
    return this.status();
  }

  whenIdle() {
    return this.#queue;
  }

  status() {
    const states = [...this.#documentStates.values()];
    return snapshot({
      version: AGE_PROGRESSION_DEFINITION_DOCUMENT_VERSION,
      started: this.#started,
      documents: this.#documentStates.size,
      draftDocuments: states.filter(state => state === AGE_PROGRESSION_DEFINITION_LIFECYCLE.DRAFT).length,
      validDocuments: states.filter(state => state === AGE_PROGRESSION_DEFINITION_LIFECYCLE.VALID || state === AGE_PROGRESSION_DEFINITION_LIFECYCLE.ACTIVE).length,
      invalidDocuments: states.filter(state => state === AGE_PROGRESSION_DEFINITION_LIFECYCLE.INVALID).length,
      enabledDocuments: [...this.#records.values()].filter(record => record.enabled).length,
      activeDefinitions: this.#active.size,
      managedDefinitions: this.#ownedDefinitionIds.size,
      issues: this.issues().reduce((total, entry) => total + entry.issues.length, 0),
    });
  }

  async refreshAll() {
    const nextRecords = new Map();
    const nextValidationIssues = new Map();
    const nextScanIssues = new Map();
    const nextDocumentStates = new Map();
    const documents = collectionValues(this.#environment?.game?.items);

    for (const pack of collectionValues(this.#environment?.game?.packs)) {
      if ((pack?.documentName ?? pack?.metadata?.type) !== "Item") continue;
      const packId = String(pack.collection ?? pack.metadata?.id ?? pack.metadata?.name ?? "unknown");
      try {
        const packDocuments = await pack.getDocuments({type: AGE_PROGRESSION_DEFINITION_ITEM_TYPE});
        documents.push(...collectionValues(packDocuments).filter(document => document?.type === AGE_PROGRESSION_DEFINITION_ITEM_TYPE));
      } catch (error) {
        nextScanIssues.set(`Compendium.${packId}`, [issue("$", `Unable to read progression definitions: ${error.message ?? error}`, "pack-read")]);
      }
    }

    for (const document of documents) {
      if (document?.type !== AGE_PROGRESSION_DEFINITION_ITEM_TYPE
        && document?._source?.type !== AGE_PROGRESSION_DEFINITION_ITEM_TYPE) continue;
      const uuid = (() => {
        try { return documentUuid(document, document?._source); } catch { return `Item.invalid-${nextValidationIssues.size + 1}`; }
      })();
      const result = await validateProgressionDefinitionDocument(document, {environment: this.#environment});
      nextDocumentStates.set(uuid, result.state ?? AGE_PROGRESSION_DEFINITION_LIFECYCLE.INVALID);
      if (result.valid) nextRecords.set(uuid, result);
      else nextValidationIssues.set(uuid, result.issues);
    }

    const affected = new Set([
      ...[...this.#records.values()].map(record => record.definition.id),
      ...[...nextRecords.values()].map(record => record.definition.id),
      ...this.#ownedDefinitionIds,
    ]);
    this.#records = nextRecords;
    this.#validationIssues = nextValidationIssues;
    this.#scanIssues = nextScanIssues;
    this.#documentStates = nextDocumentStates;
    this.#conflictIssues.clear();
    for (const id of [...affected].sort()) await this.#reconcileDefinition(id);
    return this.status();
  }

  async refreshDocument(document) {
    const uuid = documentUuid(document, document?._source);
    const previous = this.#records.get(uuid);
    const affected = new Set(previous ? [previous.definition.id] : []);
    this.#records.delete(uuid);
    this.#validationIssues.delete(uuid);
    this.#conflictIssues.delete(uuid);
    this.#documentStates.delete(uuid);
    if (document?.type === AGE_PROGRESSION_DEFINITION_ITEM_TYPE
      || document?._source?.type === AGE_PROGRESSION_DEFINITION_ITEM_TYPE) {
      const result = await validateProgressionDefinitionDocument(document, {environment: this.#environment});
      this.#documentStates.set(uuid, result.state ?? AGE_PROGRESSION_DEFINITION_LIFECYCLE.INVALID);
      if (result.valid) {
        this.#records.set(uuid, result);
        affected.add(result.definition.id);
      } else this.#validationIssues.set(uuid, result.issues);
    }
    for (const id of [...affected].sort()) await this.#reconcileDefinition(id);
    return this.status();
  }

  async removeDocument(document) {
    const uuid = documentUuid(document, document?._source);
    const previous = this.#records.get(uuid);
    this.#records.delete(uuid);
    this.#validationIssues.delete(uuid);
    this.#conflictIssues.delete(uuid);
    this.#documentStates.delete(uuid);
    if (previous) await this.#reconcileDefinition(previous.definition.id);
    return this.status();
  }

  async createWorldDefinition(definition, options = {}) {
    const user = options.user ?? this.#environment?.game?.user;
    assertProgressionDefinitionMutation({user, action: "create"});
    const source = await createProgressionDefinitionItemSource(definition, {
      ...options,
      provenance: normalizeProvenance(options.provenance ?? {}, {originKind: "world"}),
    });
    // The public source snapshot is deeply frozen. Foundry's cleaning pipeline
    // mutates creation data, so pass a mutable clone across that boundary.
    const created = await itemDocumentClass(this.#environment).createDocuments([canonicalClone(source)], {
      ageProgressionDefinition: true,
      renderSheet: options.renderSheet === true,
    });
    const document = created?.[0] ?? null;
    if (!document) throw documentError("create-failed", "Foundry did not return the created progression definition Item.");
    await this.refreshDocument(document);
    return document;
  }

  async importDefinition(jsonOrDefinition, {
    sourceLabel = "JSON import",
    user = this.#environment?.game?.user,
    ...options
  } = {}) {
    assertProgressionDefinitionMutation({user, action: "import"});
    let definition = jsonOrDefinition;
    if (typeof jsonOrDefinition === "string") {
      try { definition = JSON.parse(jsonOrDefinition); }
      catch (cause) { throw documentError("import-json", "Progression definition import is not valid JSON.", {cause: cause.message}); }
    }
    const importedAt = new Date(Number(this.#clock())).toISOString();
    const provenance = normalizeProvenance({
      ...(options.provenance ?? {}),
      originKind: "import",
      originId: sourceLabel,
      importedAt,
      importedBy: user.id,
    });
    return this.createWorldDefinition(definition, {...options, user, provenance});
  }

  async updateDefinitionDocument(document, definition, {
    name = undefined,
    enabled = undefined,
    user = this.#environment?.game?.user,
    allowIdentityChange = false,
  } = {}) {
    assertProgressionDefinitionMutation({user, document, action: "update", environment: this.#environment});
    if (!isTopLevelDefinitionDocument(document)) throw documentError("container", "Only top-level progression Items can be updated by this operation.");
    assertDefinitionItemType(document);
    const validation = validateProgressionDefinition(definition);
    if (!validation.valid) throw documentError("definition-invalid", "Cannot persist an invalid progression definition.", {issues: validation.issues});
    const source = rawDocumentSource(document);
    const previous = source.system?.definition;
    const previousIsValid = validateProgressionDefinition(previous).valid;
    if (previousIsValid) {
      if (!allowIdentityChange && (previous.id !== definition.id || previous.profileId !== definition.profileId)) {
        throw documentError("identity-change", "Editing a progression Item cannot change definition id/profile; duplicate it instead.");
      }
      const beforeDigest = await definitionDigest(previous);
      const nextDigest = await definitionDigest(definition);
      if (beforeDigest !== nextDigest && compareVersions(definition.version, previous.version) <= 0) {
        throw documentError("version", "A changed progression definition must use a newer semantic version.");
      }
    }
    if (enabled !== undefined && typeof enabled !== "boolean") throw documentError("enabled", "Progression definition enabled must be boolean.");
    const digest = await definitionDigest(definition);
    const updates = {
      // DefinitionV1 is an exact atomic contract. AGE's Item pre-update hook
      // deliberately merges ordinary object updates into AnyFields, so mark
      // this complete branch as a forced replacement while retaining normal
      // recursive Document.update semantics.
      "system.definition": forcedReplacement(this.#environment, definition, "system.definition"),
      "system.digest": digest,
    };
    if (enabled !== undefined) updates["system.enabled"] = enabled;
    if (name !== undefined) updates.name = requiredText(name, "name");
    if (!previousIsValid) {
      // A newly-created Foundry Item starts from template defaults before its
      // authoring sheet has a valid DefinitionV1. On the first validated save,
      // bind its provenance to its actual container instead of retaining the
      // world template default inside an editable Compendium.
      const packId = documentPackId(document);
      const provenance = normalizeProvenance({}, {
        originKind: packId ? "compendium" : "world",
        originId: packId ?? undefined,
      });
      updates["system.provenance"] = forcedReplacement(this.#environment, provenance, "system.provenance");
    }
    const updated = await document.update(updates, {ageProgressionDefinition: true});
    await this.refreshDocument(updated ?? document);
    return updated ?? document;
  }

  updateWorldDefinition(document, definition, options = {}) {
    return this.updateDefinitionDocument(document, definition, options);
  }

  async setDefinitionEnabled(document, enabled, {user = this.#environment?.game?.user} = {}) {
    assertProgressionDefinitionMutation({user, document, action: "update", environment: this.#environment});
    if (!isTopLevelDefinitionDocument(document)) throw documentError("container", "Only top-level progression Items can be enabled or disabled.");
    assertDefinitionItemType(document);
    if (typeof enabled !== "boolean") throw documentError("enabled", "Progression definition enabled must be boolean.");
    const updated = await document.update({"system.enabled": enabled}, {ageProgressionDefinition: true});
    await this.refreshDocument(updated ?? document);
    return updated ?? document;
  }

  setWorldDefinitionEnabled(document, enabled, options = {}) {
    return this.setDefinitionEnabled(document, enabled, options);
  }

  async deleteDefinitionDocument(document, {user = this.#environment?.game?.user} = {}) {
    assertProgressionDefinitionMutation({user, document, action: "delete", environment: this.#environment});
    if (!isTopLevelDefinitionDocument(document)) throw documentError("container", "Only top-level progression Items can be deleted by this operation.");
    assertDefinitionItemType(document);
    const deleted = await document.delete({ageProgressionDefinition: true});
    await this.removeDocument(document);
    return deleted;
  }

  deleteWorldDefinition(document, options = {}) {
    return this.deleteDefinitionDocument(document, options);
  }

  async exportDefinition(document, {pretty = true} = {}) {
    const record = await assertProgressionDefinitionDocument(document, {environment: this.#environment});
    return pretty ? `${JSON.stringify(record.definition, null, 2)}\n` : canonicalJson(record.definition);
  }

  #installHooks() {
    const hooks = this.#environment?.Hooks ?? globalThis.Hooks;
    if (!(hooks?.on instanceof Function)) return;
    const listen = (name, operation) => {
      const callback = (...args) => {
        void this.#enqueue(() => operation(...args));
      };
      const id = hooks.on(name, callback);
      this.#hooks.push({name, id, callback});
    };
    listen("createItem", document => this.refreshDocument(document));
    listen("updateItem", document => this.refreshDocument(document));
    listen("deleteItem", document => this.removeDocument(document));
    for (const name of ["createCompendium", "updateCompendium", "deleteCompendium"] ) {
      listen(name, () => this.refreshAll());
    }
  }

  #enqueue(operation) {
    const run = async () => operation();
    this.#queue = this.#queue.then(run, run).catch(error => {
      this.#logger?.error?.("AGE System | Progression definition document refresh failed.", error);
      return this.status();
    });
    return this.#queue;
  }

  #handleServiceDefinitionChange(event) {
    if (!this.#started || this.#suppressServiceChanges > 0) return;
    const definitionId = event?.definitionId;
    if (typeof definitionId !== "string" || !definitionId) return;
    const hasStoredCandidate = [...this.#records.values()]
      .some(record => record.enabled && record.definition.id === definitionId);
    if (!hasStoredCandidate) return;

    // A caller may deliberately replace or unregister a definition through
    // the stable service API. If that id was document-managed, relinquish the
    // stale ownership marker before reconciling; never unregister the new
    // external provider while resolving the stored document conflict.
    if (this.#ownedDefinitionIds.has(definitionId)) {
      this.#ownedDefinitionIds.delete(definitionId);
      this.#active.delete(definitionId);
    }
    void this.#enqueue(() => this.#reconcileDefinition(definitionId));
  }

  #clearConflictIssues(definitionId) {
    for (const [uuid, issues] of this.#conflictIssues) {
      const remaining = issues.filter(entry => entry.definitionId !== definitionId);
      if (remaining.length) this.#conflictIssues.set(uuid, remaining);
      else this.#conflictIssues.delete(uuid);
    }
  }

  #recordConflict(records, definitionId, message, code) {
    for (const record of records) {
      const current = this.#conflictIssues.get(record.documentUuid) ?? [];
      this.#conflictIssues.set(record.documentUuid, [...current, snapshot({
        path: "$.system.definition.id",
        message,
        code,
        definitionId,
      })]);
    }
  }

  #unregisterOwned(definitionId) {
    if (!this.#ownedDefinitionIds.has(definitionId)) return false;
    this.#suppressServiceChanges += 1;
    try {
      this.#service.unregisterDefinition(definitionId);
    } finally {
      this.#suppressServiceChanges -= 1;
    }
    this.#ownedDefinitionIds.delete(definitionId);
    this.#active.delete(definitionId);
    return true;
  }

  async #reconcileDefinition(definitionId) {
    this.#clearConflictIssues(definitionId);
    const candidates = [...this.#records.values()]
      .filter(record => record.enabled && record.definition.id === definitionId)
      .sort((left, right) => compareVersions(right.definition.version, left.definition.version)
        || left.documentUuid.localeCompare(right.documentUuid));
    if (!candidates.length) {
      this.#unregisterOwned(definitionId);
      this.#active.delete(definitionId);
      return;
    }
    const highestVersion = candidates[0].definition.version;
    const highest = candidates.filter(record => record.definition.version === highestVersion);
    const digests = new Set(highest.map(record => record.digest));
    if (digests.size > 1) {
      this.#unregisterOwned(definitionId);
      this.#active.delete(definitionId);
      this.#recordConflict(highest, definitionId,
        `Definition "${definitionId}" has conflicting documents at version ${highestVersion}.`,
        "definition-version-conflict");
      return;
    }
    const selected = highest[0];
    const existing = await this.#service.definitionRecord(definitionId);
    if (!this.#ownedDefinitionIds.has(definitionId) && existing) {
      if (existing.digest === selected.digest && existing.definition.version === selected.definition.version) {
        this.#active.set(definitionId, snapshot({
          documentUuid: selected.documentUuid,
          version: selected.definition.version,
          digest: selected.digest,
          managed: false,
        }));
        return;
      }
      this.#active.delete(definitionId);
      this.#recordConflict(highest, definitionId,
        `Definition "${definitionId}" conflicts with an already registered non-document provider.`,
        "external-provider-conflict");
      return;
    }
    if (this.#ownedDefinitionIds.has(definitionId)
      && existing?.digest === selected.digest
      && existing?.provider?.id === `${PROVIDER_ID_PREFIX}${selected.documentUuid}`) {
      this.#active.set(definitionId, snapshot({
        documentUuid: selected.documentUuid,
        version: selected.definition.version,
        digest: selected.digest,
        managed: true,
      }));
      return;
    }
    this.#unregisterOwned(definitionId);
    const provider = {
      ...selected.provider,
      id: `${PROVIDER_ID_PREFIX}${selected.documentUuid}`,
    };
    this.#suppressServiceChanges += 1;
    try {
      this.#service.registerDefinition(selected.definition, {provider});
    } catch (error) {
      this.#active.delete(definitionId);
      this.#recordConflict([selected], definitionId,
        `Definition "${definitionId}" could not be activated: ${error?.message ?? error}`,
        "definition-registration");
      this.#logger?.warn?.(
        `AGE System | Progression definition "${definitionId}" was isolated because it could not be registered.`,
        error,
      );
      return;
    } finally {
      this.#suppressServiceChanges -= 1;
    }
    this.#ownedDefinitionIds.add(definitionId);
    this.#active.set(definitionId, snapshot({
      documentUuid: selected.documentUuid,
      version: selected.definition.version,
      digest: selected.digest,
      managed: true,
    }));
  }
}
