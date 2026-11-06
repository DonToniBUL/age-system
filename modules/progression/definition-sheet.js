import {
  AGE_PROGRESSION_DEFINITION_VERSION,
  AGE_PROGRESSION_LATEST_DEFINITION_VERSION,
  AGE_PROGRESSION_EFFECT_TYPES,
  AGE_PROGRESSION_EFFECT_TYPES_V2,
  AGE_PROGRESSION_EVALUATION_TYPES,
  AGE_PROGRESSION_INPUT_TYPES,
  AGE_PROGRESSION_INPUT_TYPES_V2,
  AGE_PROGRESSION_TRIGGERS,
  validateProgressionDefinition,
} from "./contracts.js";
import {canonicalClone, canonicalJson, definitionDigest} from "./canonical.js";
import {validateProgressionDefinitionExecutabilityV1} from "./executability.js";
import {
  AGE_PROGRESSION_DEFINITION_ICON,
  validateProgressionDefinitionDocument,
} from "./definition-documents.js";
import {
  AGE_PROGRESSION_DEFINITION_LIFECYCLE,
  compactProgressionDefinitionIssues,
} from "./definition-lifecycle.js";
import {AgeCharacterBuilder} from "./character-builder.js";
import {AgeAdvancementCenter} from "./advancement-center.js";
import {
  AGE_PROGRESSION_PROFILE_IDS,
  progressionProfileAdapter,
} from "./profile-adapters.js";

const {HandlebarsApplicationMixin} = foundry.applications.api;
const {ItemSheetV2} = foundry.applications.sheets;

export const AGE_PROGRESSION_DEFINITION_SHEET_VERSION = 1;
export const AGE_PROGRESSION_QUICK_START_WORKFLOWS = Object.freeze([
  "character-creation",
  "complete-actor-path",
  "class-advancement",
  "actor-advancement",
]);

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/i;
const PROFILE_FALLBACK = "fage-2e";
const JSON_INDENT = 2;
const DRAFT_PATH_SEGMENT = /^(?:[A-Za-z][A-Za-z0-9]*|0|[1-9]\d*)$/;
const DANGEROUS_DRAFT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SOURCE_KINDS = Object.freeze(["compendium", "journal", "manual"]);
const CONTENT_COVERAGE = Object.freeze(["synthetic", "partial", "complete"]);
const IDENTITY_FIELDS = Object.freeze(["name", "ancestry", "background", "socialClass", "class", "description"]);
const IDENTITY_FIELDS_V2 = Object.freeze([
  ...IDENTITY_FIELDS,
  "profession", "drive", "quality", "downfall", "goals", "ties", "language",
]);
const RESOURCE_IDS = Object.freeze(["health", "powerPoints", "conviction", "currency"]);
const RESOURCE_IDS_V2 = Object.freeze([...RESOURCE_IDS, "resources"]);
const INITIALIZABLE_RESOURCE_IDS = Object.freeze(["health", "powerPoints", "conviction"]);
const INITIALIZABLE_RESOURCE_IDS_V2 = Object.freeze([...INITIALIZABLE_RESOURCE_IDS, "currency", "resources"]);
const CLASS_BONUS_IDS = Object.freeze(["health", "powerPoints", "conviction", "defense", "toughness"]);

function authoringError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "AgeProgressionDefinitionAuthoringError";
  error.code = code;
  error.details = structuredClone(details);
  return error;
}

function sourceOf(item) {
  if (item?._source && typeof item._source === "object") return item._source;
  if (item?.toObject instanceof Function) return item.toObject(true);
  if (item && typeof item === "object") return item;
  throw authoringError("document", "Progression authoring requires a progression Item.");
}

function userCanUpdate(item, user) {
  if (user?.isGM !== true) return false;
  if (item?.parent || item?.actor || item?.isOwned === true) return false;
  if (item?.canUserModify instanceof Function && !item.canUserModify(user, "update")) return false;
  const pack = item?.pack ? globalThis.game?.packs?.get?.(item.pack) : null;
  if (pack?.locked === true) return false;
  return true;
}

function activeProfileId(environment = globalThis) {
  try {
    const value = environment?.game?.settings?.get?.("age-system", "activeRuleProfile");
    if (typeof value === "string" && value.trim()) return value.trim();
  } catch {}
  return PROFILE_FALLBACK;
}

function safeId(value, fallback = "world.progression") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, ".")
    .replace(/^[^a-z]+/i, "")
    .replace(/[._:-]{2,}/g, ".")
    .replace(/[._:-]+$/g, "");
  return ID_PATTERN.test(normalized) ? normalized : fallback;
}

export function createProgressionDefinitionSkeleton({
  id = "world.progression",
  profileId = PROFILE_FALLBACK,
  version = "1.0.0",
  trigger = "character.create",
} = {}) {
  const normalizedTrigger = AGE_PROGRESSION_TRIGGERS.includes(trigger) ? trigger : "character.create";
  const creation = normalizedTrigger === "character.create";
  const definitionId = safeId(id);
  const definition = {
    schemaVersion: AGE_PROGRESSION_LATEST_DEFINITION_VERSION,
    id: definitionId,
    version,
    profileId: safeId(profileId, PROFILE_FALLBACK),
    rulesContentCoverage: "partial",
    capabilities: [creation ? "character-builder" : "advancement-center"],
    sourceRefs: [],
    rank: {kind: "level", minimum: 0, maximum: 20},
    milestones: [{
      id: creation ? "creation" : "level.1",
      rank: creation ? 0 : 1,
      triggers: [normalizedTrigger],
      sourceRefIds: [],
      inputs: creation ? [{
        id: "character.name",
        label: "Character name",
        type: "text",
        required: true,
        minLength: 1,
        maxLength: 100,
      }] : [],
      choiceGroups: [],
      evaluations: [],
      stages: creation ? [{
        id: "identity",
        label: "Name and identity",
        description: "Enter the Character name and any profile-specific identity choices.",
        inputIds: ["character.name"],
        choiceGroupIds: [],
      }] : [],
      effects: creation ? [{
        id: "character.name",
        type: "identity.set",
        field: "name",
        value: {kind: "input", inputId: "character.name"},
      }, {
        id: "summary",
        type: "summary.add",
        entryId: "character.created",
        label: "Character created",
      }] : [{
        id: "track.rank.1",
        type: "track.setRank",
        trackId: definitionId,
        rank: 1,
      }, {
        id: "summary",
        type: "summary.add",
        entryId: "rank.advanced",
        label: "Rank advanced",
      }],
    }],
  };
  if (!creation) definition.trackBinding = {kind: "actor", trackId: definitionId};
  return definition;
}

function rankMilestone(definitionId, rank) {
  return {
    id: `rank.${rank}`,
    rank,
    triggers: ["rank.advance"],
    sourceRefIds: [],
    inputs: [],
    choiceGroups: [],
    evaluations: [],
    effects: [{
      id: `track.rank.${rank}`,
      type: "track.setRank",
      trackId: definitionId,
      rank,
    }, {
      id: `summary.rank.${rank}`,
      type: "summary.add",
      entryId: `rank.${rank}.advanced`,
      label: `Advance to rank ${rank}`,
    }],
  };
}

/**
 * Build a safe, editable DefinitionV1 starting point without requiring a GM
 * to understand track bindings, milestone ids, triggers, or rank effects.
 */
export function createProgressionQuickStartDefinition({
  workflow = "character-creation",
  id = "world.progression",
  profileId = PROFILE_FALLBACK,
  version = "1.0.0",
  maximumRank = 20,
} = {}) {
  if (!AGE_PROGRESSION_QUICK_START_WORKFLOWS.includes(workflow)) {
    throw authoringError("quick-start", `Unknown progression quick-start workflow: ${workflow}`);
  }
  const definitionId = safeId(id);
  const maximum = Math.max(1, Math.min(20, Math.trunc(Number(maximumRank) || 20)));
  const includesCreation = workflow === "character-creation" || workflow === "complete-actor-path";
  const includesAdvancement = workflow !== "character-creation";
  const definition = createProgressionDefinitionSkeleton({
    id: definitionId,
    profileId,
    version,
    trigger: includesCreation ? "character.create" : "rank.advance",
  });
  definition.rank.maximum = maximum;
  definition.capabilities = [
    ...(includesCreation ? ["character-builder"] : []),
    ...(includesAdvancement ? ["advancement-center"] : []),
  ];
  definition.milestones = [
    ...(includesCreation ? [definition.milestones[0]] : []),
    ...(includesAdvancement
      ? Array.from({length: maximum}, (_, index) => rankMilestone(definitionId, index + 1))
      : []),
  ];
  if (includesAdvancement) {
    definition.trackBinding = {
      kind: workflow === "class-advancement" ? "class-item" : "actor",
      trackId: definitionId,
    };
  } else delete definition.trackBinding;
  return definition;
}

export function progressionAuthoringChecklist(definition, {valid = false} = {}) {
  const milestones = Array.isArray(definition?.milestones) ? definition.milestones : [];
  const hasAdvancement = milestones.some(milestone => milestone?.triggers?.includes("rank.advance"));
  const itemEffects = milestones.flatMap(milestone => [
    ...asArray(milestone?.effects),
    ...asArray(milestone?.choiceGroups).flatMap(group => asArray(group?.options).flatMap(option => asArray(option?.effects))),
  ]).filter(effect => effect?.type === "item.acquire" || effect?.type === "item.advance");
  const sourceIds = new Set(asArray(definition?.sourceRefs).map(source => source?.id));
  const sourcesReady = itemEffects.every(effect => !effect.sourceRefId || sourceIds.has(effect.sourceRefId));
  const choicesReady = milestones.every(milestone => asArray(milestone?.choiceGroups).every(group => (
    Array.isArray(group?.options) && group.options.length >= Number(group?.minimum ?? 0)
  )));
  return [
    {id: "identity", label: "Choose the game profile and internal name", complete: Boolean(definition?.id && definition?.profileId)},
    {id: "workflow", label: "Choose creation, Class advancement, or Actor advancement", complete: milestones.length > 0 && (!hasAdvancement || Boolean(definition?.trackBinding))},
    {id: "sources", label: "Add any Items this progression grants", complete: sourcesReady, optional: itemEffects.length === 0},
    {id: "choices", label: "Add the choices players make", complete: choicesReady, optional: !milestones.some(milestone => asArray(milestone?.choiceGroups).length)},
    {id: "effects", label: "Review what each rank changes", complete: milestones.every(milestone => asArray(milestone?.effects).length > 0)},
    {id: "validation", label: "Validate and save the definition", complete: Boolean(valid)},
  ];
}

export function parseProgressionDefinitionJson(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw authoringError("json-empty", "Progression definition JSON cannot be empty.");
  }
  let definition;
  try {
    definition = JSON.parse(text);
  } catch (cause) {
    const match = String(cause?.message ?? "").match(/position\s+(\d+)/i);
    throw authoringError("json-parse", `Progression definition JSON is invalid: ${cause.message}`, {
      position: match ? Number(match[1]) : null,
    });
  }
  return definition;
}

export function bumpProgressionPatchVersion(version) {
  const match = String(version ?? "").match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw authoringError("version", "A semantic version is required before it can be bumped.");
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function parsedProgressionVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version ?? ""));
  if (!match) throw authoringError("version", `Invalid semantic version "${version}".`);
  return {
    core: match.slice(1, 4).map(value => BigInt(value)),
    prerelease: match[4]?.split(".") ?? null,
  };
}

/** Compare two Definition semantic versions using SemVer precedence. */
export function compareProgressionDefinitionVersions(left, right) {
  const leftVersion = parsedProgressionVersion(left);
  const rightVersion = parsedProgressionVersion(right);
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
      const difference = BigInt(leftIdentifier) - BigInt(rightIdentifier);
      if (difference > 0n) return 1;
      if (difference < 0n) return -1;
      return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    // SemVer compares non-numeric identifiers by raw ASCII code points. A
    // locale-aware comparison can disagree with the provider preflight for
    // mixed-case identifiers and must not be used here.
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

/** Convert a validator path such as $.milestones[2].effects[0] to the draft path used by controls. */
export function progressionValidationPathToDraftPath(path) {
  const normalized = String(path ?? "").trim();
  if (!normalized || normalized === "$") return "";
  return normalized
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/^\./, "");
}

/** Select the Studio panel which owns a validator path. */
export function progressionAuthoringSectionForIssue(path, code = "") {
  if (["json-empty", "json-parse"].includes(String(code))) return "advanced";
  const draftPath = progressionValidationPathToDraftPath(path);
  if (draftPath.startsWith("sourceRefs")) return "sources";
  if (/\.(?:evaluations|effects)(?:\.|$)/.test(draftPath)) return "rules";
  if (draftPath.startsWith("milestones")) return "timeline";
  return "setup";
}

export function duplicateProgressionDefinition(definition, {suffix = "copy"} = {}) {
  const copy = canonicalClone(definition);
  const normalizedSuffix = safeId(suffix, "copy").replace(/^world\./, "");
  copy.id = safeId(`${copy.id}.${normalizedSuffix}`);
  copy.version = "1.0.0";
  return copy;
}

function formatDefinition(definition) {
  return `${JSON.stringify(definition, null, JSON_INDENT)}\n`;
}

function normalizeIssues(issues = []) {
  return compactProgressionDefinitionIssues(issues).map(entry => ({
    path: String(entry.path ?? "$"),
    message: String(entry.message ?? "Invalid progression definition"),
    code: String(entry.code ?? "invalid"),
    severity: "error",
  }));
}

function optionMap(values) {
  return Object.fromEntries(values.map(value => [value, value]));
}

function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (collection.values instanceof Function) return [...collection.values()];
  try { return [...collection]; } catch { return []; }
}

function itemDocumentType(document) {
  return document?.documentName === "Item"
    || document?.constructor?.documentName === "Item";
}

function sourceResult(document, {uuid = document?.uuid, location = "World"} = {}) {
  if (!uuid || !itemDocumentType(document) || document?.type === "progression") return null;
  return {
    uuid: String(uuid),
    name: String(document.name ?? "Unnamed Item"),
    type: String(document.type ?? "Item"),
    img: String(document.img ?? "icons/svg/item-bag.svg"),
    location: String(location),
  };
}

/** Search visible world and Item-compendium content for Definition source refs. */
export async function searchProgressionSourceItems(query, {
  environment = globalThis,
  limit = 40,
} = {}) {
  const needle = String(query ?? "").trim().toLocaleLowerCase();
  if (!needle) return [];
  const maximum = Math.max(1, Math.min(100, Number(limit) || 40));
  const results = [];
  const add = result => {
    if (!result || results.some(entry => entry.uuid === result.uuid)) return;
    const haystack = `${result.name} ${result.type} ${result.location}`.toLocaleLowerCase();
    if (haystack.includes(needle)) results.push(result);
  };
  for (const item of collectionValues(environment?.game?.items)) add(sourceResult(item));
  for (const pack of collectionValues(environment?.game?.packs)) {
    if (results.length >= maximum || pack?.visible === false) continue;
    const documentName = pack?.documentName ?? pack?.metadata?.type;
    if (documentName !== "Item" || !(pack?.getIndex instanceof Function)) continue;
    let index;
    try { index = await pack.getIndex({fields: ["name", "type", "img"]}); }
    catch { continue; }
    const collection = pack.collection ?? pack.metadata?.id;
    const label = pack.metadata?.label ?? pack.title ?? collection ?? "Compendium";
    for (const entry of collectionValues(index)) {
      const id = entry?._id ?? entry?.id;
      const uuid = entry?.uuid ?? pack.getUuid?.(id) ?? (collection && id ? `Compendium.${collection}.${id}` : null);
      add(sourceResult({...entry, documentName: "Item"}, {uuid, location: label}));
      if (results.length >= maximum) break;
    }
  }
  return results
    .sort((left, right) => left.name.localeCompare(right.name) || left.uuid.localeCompare(right.uuid))
    .slice(0, maximum);
}

function sourceChoices(definition, {optional = false} = {}) {
  const choices = optional ? {"": "None"} : {};
  for (const rawRef of asArray(definition?.sourceRefs)) {
    const ref = asRecord(rawRef);
    if (typeof ref.id === "string" && ref.id) choices[ref.id] = ref.label ? `${ref.label} (${ref.id})` : ref.id;
  }
  return choices;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function csv(values) {
  return Array.isArray(values) ? values.join(", ") : "";
}

function csvValues(value) {
  return [...new Set(String(value ?? "")
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(Boolean))];
}

function draftPathParts(path) {
  if (typeof path !== "string" || !path.trim()) throw authoringError("draft-path", "A semantic draft path is required.");
  const parts = path.split(".");
  if (parts.some(part => !DRAFT_PATH_SEGMENT.test(part) || DANGEROUS_DRAFT_KEYS.has(part))) {
    throw authoringError("draft-path", `Unsafe semantic draft path: ${path}`);
  }
  return parts.map(part => /^\d+$/.test(part) ? Number(part) : part);
}

function validationPath(path) {
  return draftPathParts(path).reduce((result, part) => (
    typeof part === "number" ? `${result}[${part}]` : `${result}.${part}`
  ), "$");
}

function valueAt(root, path) {
  return draftPathParts(path).reduce((value, part) => value?.[part], root);
}

function parentAt(root, path) {
  const parts = draftPathParts(path);
  const key = parts.pop();
  let parent = root;
  for (const part of parts) {
    if (parent === null || typeof parent !== "object" || !(part in parent)) {
      throw authoringError("draft-path", `Semantic draft path does not exist: ${path}`);
    }
    parent = parent[part];
  }
  if (parent === null || typeof parent !== "object") throw authoringError("draft-path", `Semantic draft path is not editable: ${path}`);
  return {parent, key};
}

function arrayAt(root, path) {
  const value = valueAt(root, path);
  if (!Array.isArray(value)) throw authoringError("draft-path", `Semantic draft collection is not an array: ${path}`);
  return value;
}

function nextId(entries, prefix) {
  const used = new Set(entries.map(entry => entry?.id).filter(id => typeof id === "string"));
  let index = 1;
  while (used.has(`${prefix}.${index}`)) index += 1;
  return `${prefix}.${index}`;
}

function newSourceRef(definition) {
  return {id: nextId(definition.sourceRefs ?? [], "source"), kind: "manual", label: "New source"};
}

function newInput(milestone) {
  const id = nextId(milestone.inputs ?? [], "input");
  return {id, label: `Input ${(milestone.inputs?.length ?? 0) + 1}`, type: "text", required: false};
}

function inputDefaults(type, {id = "input.1", label = "Input"} = {}) {
  const input = {id, label, type, required: false};
  switch (type) {
    case "longText": return {...input, minLength: 0, maxLength: 4096};
    case "integer": return {...input, minimum: 0, maximum: 20};
    case "select": return {...input, options: [{value: "option.1", label: "Option 1"}]};
    case "text": return {...input, minLength: 0, maxLength: 128};
    default: return input;
  }
}

function newOption(group) {
  const id = nextId(group.options ?? [], "option");
  return {id, label: `Option ${(group.options?.length ?? 0) + 1}`, sourceRefIds: [], evaluations: [], effects: []};
}

function newChoiceGroup(milestone, {supportsEvaluations = false} = {}) {
  const group = {
    id: nextId(milestone.choiceGroups ?? [], "choice"),
    label: `Choice ${(milestone.choiceGroups?.length ?? 0) + 1}`,
    minimum: 1,
    maximum: 1,
    distinct: true,
    options: [],
  };
  if (supportsEvaluations) group.evaluations = [];
  group.options.push(newOption(group));
  return group;
}

function newStage(milestone) {
  const id = nextId(milestone.stages ?? [], "stage");
  return {
    id,
    label: `Stage ${(milestone.stages?.length ?? 0) + 1}`,
    inputIds: [],
    choiceGroupIds: [],
  };
}

function evaluationDefaults(kind, {id = "evaluation.1", rank = 0, choiceGroupId = "choice.1", sourceRefId = "source.1", evaluationId = "evaluation.1"} = {}) {
  const evaluation = {id, kind};
  switch (kind) {
    case "rank.atLeast": return {...evaluation, rank};
    case "choice.selected": return {...evaluation, choiceGroupId};
    case "item.owned": return {...evaluation, sourceRefId};
    case "ability.minimum": return {...evaluation, abilityId: "accuracy", value: 0};
    case "allOf":
    case "anyOf": return {...evaluation, evaluationIds: [evaluationId]};
    case "not": return {...evaluation, evaluationIds: [evaluationId]};
    default: return {...evaluation, rank};
  }
}

function effectDefaults(type, {id = "effect.1", definition, milestone} = {}) {
  const effect = {id, type};
  const sourceRefId = definition?.sourceRefs?.[0]?.id ?? "source.1";
  switch (type) {
    case "identity.set": return {...effect, field: "name", value: ""};
    case "resource.initialize": return {...effect, resource: "health", amount: 0};
    case "resource.gain": return {...effect, resource: "health", amount: 0};
    case "classBonus.gain": return {...effect, bonus: "health", amount: 0};
    case "ability.allocate": return {...effect, amount: 1};
    case "ability.set": return {...effect, abilityId: "accuracy", value: 0};
    case "ability.setPrimary": return {...effect, abilityId: "accuracy"};
    case "language.add": return {...effect, value: "Trade Tongue"};
    case "weaponGroup.add": return {...effect, weaponGroupId: "light.blades"};
    case "item.acquire": return {...effect, sourceRefId, quantity: 1};
    case "item.advance": return {...effect, trait: "talent"};
    case "track.setRank": return {
      ...effect,
      trackId: definition?.trackBinding?.trackId ?? definition?.id ?? "world.progression",
      rank: milestone?.rank ?? definition?.rank?.minimum ?? 0,
    };
    case "summary.add": return {...effect, entryId: "progression.summary", label: "Progression applied"};
    default: return {...effect, entryId: "progression.summary"};
  }
}

function ownerMilestone(definition, collectionPath) {
  const match = String(collectionPath).match(/^milestones\.(\d+)/);
  return match ? definition.milestones?.[Number(match[1])] : null;
}

function newEvaluation(definition, collectionPath) {
  const collection = arrayAt(definition, collectionPath);
  const milestone = ownerMilestone(definition, collectionPath);
  const group = milestone?.choiceGroups?.[0];
  const source = definition.sourceRefs?.[0];
  return evaluationDefaults("rank.atLeast", {
    id: nextId(collection, "evaluation"),
    rank: milestone?.rank ?? definition.rank?.minimum ?? 0,
    choiceGroupId: group?.id,
    sourceRefId: source?.id,
    evaluationId: collection[0]?.id,
  });
}

function newEffect(definition, collectionPath) {
  const collection = arrayAt(definition, collectionPath);
  return effectDefaults("summary.add", {
    id: nextId(collection, "effect"),
    definition,
    milestone: ownerMilestone(definition, collectionPath),
  });
}

function nextMilestoneRank(definition) {
  const ranks = new Set((definition.milestones ?? []).map(milestone => milestone?.rank));
  for (let rank = definition.rank?.minimum ?? 0; rank <= (definition.rank?.maximum ?? 20); rank += 1) {
    if (!ranks.has(rank)) return rank;
  }
  return definition.rank?.maximum ?? 20;
}

function newMilestone(definition) {
  const rank = nextMilestoneRank(definition);
  const creation = rank === 0 && !(definition.milestones ?? []).some(milestone => milestone?.triggers?.includes("character.create"));
  const id = nextId(definition.milestones ?? [], creation ? "creation" : "milestone");
  const milestone = {
    id,
    rank,
    triggers: [creation ? "character.create" : "rank.advance"],
    sourceRefIds: [],
    inputs: [],
    choiceGroups: [],
    evaluations: [],
    effects: [],
  };
  if (definition.schemaVersion !== AGE_PROGRESSION_DEFINITION_VERSION) milestone.stages = [];
  milestone.effects.push(effectDefaults(creation ? "summary.add" : "track.setRank", {definition, milestone}));
  return milestone;
}

function normalizeSemanticValue(raw, type, {optional = false} = {}) {
  if (type === "boolean") return Boolean(raw);
  if (type === "csv") {
    const values = csvValues(raw);
    return optional && !values.length ? undefined : values;
  }
  if (type === "integer") {
    if (raw === "" || raw === null || raw === undefined) return optional ? undefined : null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) ? parsed : null;
  }
  if (type === "number") {
    if (raw === "" || raw === null || raw === undefined) return optional ? undefined : null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (type === "select-options") {
    const values = String(raw ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const separator = line.indexOf("|");
      const value = (separator < 0 ? line : line.slice(0, separator)).trim();
      const label = (separator < 0 ? line : line.slice(separator + 1)).trim();
      return {value, label: label || value};
    });
    return optional && !values.length ? undefined : values;
  }
  const value = String(raw ?? "");
  return optional && !value.trim() ? undefined : value;
}

/**
 * Return a changed clone of a DefinitionV1 draft. This never writes a Foundry
 * document and rejects prototype-pollution or non-existent paths.
 */
export function setProgressionSemanticDraftField(definition, path, raw, {type = "string", optional = false} = {}) {
  const draft = canonicalClone(definition);
  const {parent, key} = parentAt(draft, path);
  const value = normalizeSemanticValue(raw, type, {optional});
  if (value === undefined) delete parent[key];
  else parent[key] = value;
  return draft;
}

export function moveProgressionSemanticDraftEntry(definition, collectionPath, index, direction) {
  const draft = canonicalClone(definition);
  const collection = arrayAt(draft, collectionPath);
  const from = Number(index);
  const to = from + Number(direction);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= collection.length || to < 0 || to >= collection.length) return draft;
  const [entry] = collection.splice(from, 1);
  collection.splice(to, 0, entry);
  return draft;
}

function viewEvaluation(evaluation, collectionPath, index, ownerLabel, definition) {
  const value = asRecord(evaluation);
  return {
    ...canonicalClone(value),
    collectionPath,
    nodePath: `${collectionPath}.${index}`,
    validationPath: validationPath(`${collectionPath}.${index}`),
    index,
    ownerLabel,
    optionIdsText: csv(value.optionIds),
    evaluationIdsText: csv(value.evaluationIds),
    kindChoices: optionMap(AGE_PROGRESSION_EVALUATION_TYPES),
    sourceChoices: sourceChoices(definition),
  };
}

function viewEffect(effect, collectionPath, index, ownerLabel, definition) {
  const value = asRecord(effect);
  const inputReference = value.value && typeof value.value === "object" && value.value.kind === "input";
  const formulaAmount = value.amount && typeof value.amount === "object" && value.amount.kind === "formula";
  return {
    ...canonicalClone(value),
    collectionPath,
    nodePath: `${collectionPath}.${index}`,
    validationPath: validationPath(`${collectionPath}.${index}`),
    index,
    ownerLabel,
    eligibleAbilityIdsText: csv(value.eligibleAbilityIds),
    inputReference,
    identityMode: inputReference ? "input" : "literal",
    identityValue: inputReference ? value.value.inputId : (value.value ?? ""),
    amountMode: formulaAmount ? "formula" : "number",
    amountValue: formulaAmount ? value.amount.formula : (value.amount ?? 0),
    amountRollId: formulaAmount ? (value.amount.rollId ?? "") : "",
    amountMinimum: formulaAmount ? (value.amount.minimum ?? "") : "",
    amountMaximum: formulaAmount ? (value.amount.maximum ?? "") : "",
    typeChoices: optionMap(definition?.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION
      ? AGE_PROGRESSION_EFFECT_TYPES
      : AGE_PROGRESSION_EFFECT_TYPES_V2),
    identityFieldChoices: optionMap(definition?.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION ? IDENTITY_FIELDS : IDENTITY_FIELDS_V2),
    resourceChoices: optionMap(value.type === "resource.initialize"
      ? (definition?.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION ? INITIALIZABLE_RESOURCE_IDS : INITIALIZABLE_RESOURCE_IDS_V2)
      : (definition?.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION ? RESOURCE_IDS : RESOURCE_IDS_V2)),
    classBonusChoices: optionMap(CLASS_BONUS_IDS),
    sourceChoices: sourceChoices(definition, {optional: value.type === "item.advance"}),
  };
}

export function buildProgressionSemanticAuthoringView(definition) {
  const draft = canonicalClone(definition);
  const evaluations = [];
  const effects = [];
  const milestones = asArray(draft?.milestones).map((rawMilestone, milestoneIndex) => {
    const milestone = asRecord(rawMilestone);
    const milestonePath = `milestones.${milestoneIndex}`;
    const ownerLabel = `Milestone: ${milestone.label ?? milestone.id ?? milestoneIndex + 1}`;
    asArray(milestone.evaluations).forEach((entry, index) => evaluations.push(viewEvaluation(entry, `${milestonePath}.evaluations`, index, ownerLabel, draft)));
    asArray(milestone.effects).forEach((entry, index) => effects.push(viewEffect(entry, `${milestonePath}.effects`, index, ownerLabel, draft)));
    const choiceGroups = asArray(milestone.choiceGroups).map((rawGroup, groupIndex) => {
      const group = asRecord(rawGroup);
      const groupPath = `${milestonePath}.choiceGroups.${groupIndex}`;
      const groupEvaluations = asArray(group.evaluations);
      const groupOwner = `${ownerLabel} / Choice group: ${group.label ?? group.id ?? groupIndex + 1}`;
      groupEvaluations.forEach((entry, index) => evaluations.push(
        viewEvaluation(entry, `${groupPath}.evaluations`, index, groupOwner, draft),
      ));
      return {
        ...group,
        index: groupIndex,
        nodePath: groupPath,
        collectionPath: `${milestonePath}.choiceGroups`,
        validationPath: validationPath(groupPath),
        evaluations: groupEvaluations,
        supportsEvaluations: draft.schemaVersion !== AGE_PROGRESSION_DEFINITION_VERSION,
        options: asArray(group.options).map((rawOption, optionIndex) => {
          const option = asRecord(rawOption);
          const optionPath = `${groupPath}.options.${optionIndex}`;
          const optionOwner = `${ownerLabel} / ${group.label ?? group.id} / ${option.label ?? option.id}`;
          asArray(option.evaluations).forEach((entry, index) => evaluations.push(viewEvaluation(entry, `${optionPath}.evaluations`, index, optionOwner, draft)));
          asArray(option.effects).forEach((entry, index) => effects.push(viewEffect(entry, `${optionPath}.effects`, index, optionOwner, draft)));
          return {
            ...option,
            index: optionIndex,
            nodePath: optionPath,
            collectionPath: `${groupPath}.options`,
            validationPath: validationPath(optionPath),
            sourceRefIdsText: csv(option.sourceRefIds),
          };
        }),
      };
    });
    return {
      ...milestone,
      index: milestoneIndex,
      filterValue: String(milestoneIndex),
      selectorLabel: `Rank ${milestone.rank} · ${milestone.label ?? milestone.id ?? `Milestone ${milestoneIndex + 1}`} · ${asArray(milestone.triggers).includes("character.create") ? "Creation" : "Advancement"}`,
      nodePath: milestonePath,
      collectionPath: "milestones",
      validationPath: validationPath(milestonePath),
      sourceRefIdsText: csv(milestone.sourceRefIds),
      creationTrigger: asArray(milestone.triggers).includes("character.create"),
      advancementTrigger: asArray(milestone.triggers).includes("rank.advance"),
      inputs: asArray(milestone.inputs).map((rawInput, inputIndex) => {
        const input = asRecord(rawInput);
        return {
        ...input,
        index: inputIndex,
        nodePath: `${milestonePath}.inputs.${inputIndex}`,
        collectionPath: `${milestonePath}.inputs`,
        validationPath: validationPath(`${milestonePath}.inputs.${inputIndex}`),
        typeChoices: optionMap(draft.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION
          ? AGE_PROGRESSION_INPUT_TYPES
          : AGE_PROGRESSION_INPUT_TYPES_V2),
        isText: input.type === "text" || input.type === "longText",
        isInteger: input.type === "integer",
        isSelect: input.type === "select",
        selectOptionsText: asArray(input.options).map(rawOption => {
          const option = asRecord(rawOption);
          return `${option.value ?? ""}|${option.label ?? ""}`;
        }).join("\n"),
      }; }),
      choiceGroups,
      supportsStages: draft.schemaVersion !== AGE_PROGRESSION_DEFINITION_VERSION,
      stages: asArray(milestone.stages).map((rawStage, stageIndex) => {
        const stage = asRecord(rawStage);
        return {
        ...stage,
        index: stageIndex,
        nodePath: `${milestonePath}.stages.${stageIndex}`,
        collectionPath: `${milestonePath}.stages`,
        validationPath: validationPath(`${milestonePath}.stages.${stageIndex}`),
        inputIdsText: csv(stage.inputIds),
        choiceGroupIdsText: csv(stage.choiceGroupIds),
      }; }),
    };
  });
  return {
    definition: draft,
    capabilitiesText: csv(draft.capabilities),
    classSourceUuidsText: csv(draft.trackBinding?.sourceUuids),
    trackKindChoices: optionMap(["actor", "class-item"]),
    sourceRefs: asArray(draft?.sourceRefs).map((rawRef, index) => {
      const ref = asRecord(rawRef);
      return {
      ...ref,
      index,
      nodePath: `sourceRefs.${index}`,
      collectionPath: "sourceRefs",
      validationPath: validationPath(`sourceRefs.${index}`),
      kindChoices: optionMap(SOURCE_KINDS),
    }; }),
    milestones,
    evaluations,
    effects,
    coverageChoices: optionMap(CONTENT_COVERAGE),
    identityFieldChoices: optionMap(draft.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION ? IDENTITY_FIELDS : IDENTITY_FIELDS_V2),
    resourceChoices: optionMap(draft.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION ? RESOURCE_IDS : RESOURCE_IDS_V2),
    classBonusChoices: optionMap(CLASS_BONUS_IDS),
  };
}

export class AgeProgressionDefinitionAuthoringController {
  #item;
  #provider;
  #service;
  #environment;
  #definition;
  #originalDefinition;
  #originalDefinitionValid = false;
  #initialDraft;
  #issues = [];
  #parseError = null;
  #rawJsonText = null;
  #digest = null;
  #initialized = false;
  #busy = false;
  #lastSavedAt = null;
  #draftName = "";
  #originalName = "";
  #draftEnabled = false;
  #originalEnabled = false;

  constructor({item, provider, service, environment = globalThis} = {}) {
    if (!item) throw authoringError("document", "Progression authoring requires an Item.");
    this.#item = item;
    this.#provider = provider ?? environment?.game?.ageSystem?.progressionDefinitions ?? null;
    this.#service = service ?? environment?.game?.ageSystem?.progression ?? null;
    this.#environment = environment;
  }

  get item() { return this.#item; }
  get definition() { return this.#definition ? canonicalClone(this.#definition) : null; }
  get initialized() { return this.#initialized; }
  get busy() { return this.#busy; }

  #assertIdle(action = "change this draft") {
    if (this.#busy) throw authoringError("busy", `Wait for the current operation to finish before you ${action}.`);
  }

  async initialize() {
    const source = sourceOf(this.#item);
    const stored = source.system?.definition;
    this.#draftName = String(source.name ?? this.#item.name ?? "Progression Definition");
    this.#originalName = this.#draftName;
    this.#draftEnabled = source.system?.enabled !== false;
    this.#originalEnabled = this.#draftEnabled;
    this.#definition = stored && typeof stored === "object"
      ? canonicalClone(stored)
      : createProgressionDefinitionSkeleton({
        id: safeId(source.name, `world.progression.${source._id ?? "new"}`),
        profileId: activeProfileId(this.#environment),
      });
    this.#initialDraft = canonicalClone(this.#definition);
    this.#originalDefinition = stored && typeof stored === "object" ? canonicalClone(stored) : null;
    this.#originalDefinitionValid = Boolean(
      this.#originalDefinition
      && validateProgressionDefinition(this.#originalDefinition).valid
    );
    await this.validate();
    this.#initialized = true;
    return this.context();
  }

  loadJson(text) {
    this.#assertIdle("replace its JSON");
    this.#parseError = null;
    this.#rawJsonText = null;
    try {
      this.#definition = parseProgressionDefinitionJson(text);
    } catch (error) {
      this.#parseError = error;
      this.#rawJsonText = String(text ?? "");
      this.#issues = [{path: "$", message: error.message, code: error.code ?? "json-parse", severity: "error"}];
      this.#digest = null;
      return false;
    }
    const result = validateProgressionDefinitionExecutabilityV1(this.#definition);
    this.#issues = normalizeIssues(result.issues);
    this.#digest = null;
    return result.valid;
  }

  async reset() {
    this.#assertIdle("reset it");
    this.#busy = true;
    try {
      this.#definition = canonicalClone(this.#originalDefinition ?? this.#initialDraft);
      this.#draftName = this.#originalName;
      this.#draftEnabled = this.#originalEnabled;
      this.#parseError = null;
      this.#rawJsonText = null;
      return await this.validate();
    } finally {
      this.#busy = false;
    }
  }

  /** Track Item chrome as part of the same draft without writing the document. */
  updateDocumentMetadata({name, enabled} = {}) {
    if (name !== undefined) this.#draftName = String(name);
    if (enabled !== undefined) this.#draftEnabled = Boolean(enabled);
    return this.context();
  }

  async #mutate(mutator) {
    this.#assertIdle("edit it");
    this.#busy = true;
    try {
      const draft = canonicalClone(this.#definition);
      mutator(draft);
      this.#definition = draft;
      this.#parseError = null;
      this.#rawJsonText = null;
      this.#digest = null;
      await this.validate();
      return this.definition;
    } finally {
      this.#busy = false;
    }
  }

  /** Change one semantic field in the in-memory draft only. */
  async updateSemanticField(path, raw, options = {}) {
    return this.#mutate(draft => {
      const changed = setProgressionSemanticDraftField(draft, path, raw, options);
      if (path === "trackBinding.kind" && changed.trackBinding?.kind === "actor") delete changed.trackBinding.sourceUuids;
      Object.assign(draft, changed);
      for (const key of Object.keys(draft)) {
        if (!(key in changed)) delete draft[key];
      }
    });
  }

  /** Add a valid-shaped semantic node. References may still require GM input. */
  async addSemanticEntry(kind, collectionPath = null) {
    return this.#mutate(draft => {
      if (kind === "sourceRef") return draft.sourceRefs.push(newSourceRef(draft));
      if (kind === "milestone") {
        const milestone = newMilestone(draft);
        draft.milestones.push(milestone);
        if (milestone.triggers.includes("rank.advance") && !draft.trackBinding) draft.trackBinding = {kind: "actor", trackId: draft.id};
        return draft.milestones.length;
      }
      if (!collectionPath) throw authoringError("draft-path", `A collection path is required to add ${kind}.`);
      if (kind === "evaluation"
        && draft.schemaVersion !== AGE_PROGRESSION_DEFINITION_VERSION
        && /^milestones\.\d+\.choiceGroups\.\d+\.evaluations$/.test(collectionPath)
        && valueAt(draft, collectionPath) === undefined) {
        const {parent, key} = parentAt(draft, collectionPath);
        parent[key] = [];
      }
      const collection = arrayAt(draft, collectionPath);
      const milestone = ownerMilestone(draft, collectionPath);
      if (kind === "input") return collection.push(newInput(milestone));
      if (kind === "stage") {
        if (draft.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION) throw authoringError("draft-kind", "Stages require DefinitionV2.");
        return collection.push(newStage(milestone));
      }
      if (kind === "choiceGroup") return collection.push(newChoiceGroup(milestone, {
        supportsEvaluations: draft.schemaVersion !== AGE_PROGRESSION_DEFINITION_VERSION,
      }));
      if (kind === "option") {
        const groupPath = collectionPath.replace(/\.options$/, "");
        return collection.push(newOption(valueAt(draft, groupPath)));
      }
      if (kind === "evaluation") return collection.push(newEvaluation(draft, collectionPath));
      if (kind === "effect") return collection.push(newEffect(draft, collectionPath));
      throw authoringError("draft-kind", `Unsupported semantic node kind: ${kind}`);
    });
  }

  /** Add or reuse a portable source reference from a real Foundry Item. */
  async addSourceDocument(document) {
    if (!itemDocumentType(document) || document?.type === "progression") {
      throw authoringError("source-document", "Drop or select a gameplay Item, not a progression Definition.");
    }
    const uuid = String(document?.uuid ?? "").trim();
    if (!uuid) throw authoringError("source-uuid", "The selected Item has no stable Foundry UUID.");
    const existing = this.#definition?.sourceRefs?.find(ref => ref.uuid === uuid);
    if (existing) return {definition: this.definition, sourceRefId: existing.id, added: false};
    let sourceRefId = null;
    await this.#mutate(draft => {
      const base = safeId(`source.${document.name ?? document.type ?? "item"}`, "source.item");
      const used = new Set((draft.sourceRefs ?? []).map(ref => ref.id));
      sourceRefId = base;
      let suffix = 2;
      while (used.has(sourceRefId)) sourceRefId = `${base}.${suffix++}`;
      draft.sourceRefs.push({
        id: sourceRefId,
        kind: uuid.startsWith("Compendium.") ? "compendium" : "manual",
        uuid,
        label: String(document.name ?? sourceRefId),
      });
    });
    return {definition: this.definition, sourceRefId, added: true};
  }

  async removeSemanticEntry(collectionPath, index) {
    return this.#mutate(draft => {
      const collection = arrayAt(draft, collectionPath);
      const position = Number(index);
      if (!Number.isInteger(position) || position < 0 || position >= collection.length) {
        throw authoringError("draft-index", `Semantic draft index is out of range: ${collectionPath}.${index}`);
      }
      collection.splice(position, 1);
    });
  }

  async moveSemanticEntry(collectionPath, index, direction) {
    return this.#mutate(draft => {
      const moved = moveProgressionSemanticDraftEntry(draft, collectionPath, index, direction);
      for (const key of Object.keys(draft)) delete draft[key];
      Object.assign(draft, moved);
    });
  }

  async toggleMilestoneTrigger(milestoneIndex, trigger, checked) {
    if (!AGE_PROGRESSION_TRIGGERS.includes(trigger)) throw authoringError("trigger", `Unsupported progression trigger: ${trigger}`);
    return this.#mutate(draft => {
      const milestone = draft.milestones?.[Number(milestoneIndex)];
      if (!milestone) throw authoringError("draft-index", "The milestone no longer exists.");
      const triggers = new Set(milestone.triggers ?? []);
      if (checked) triggers.add(trigger);
      else triggers.delete(trigger);
      milestone.triggers = [...triggers];
      if (trigger === "rank.advance" && checked && !draft.trackBinding) draft.trackBinding = {kind: "actor", trackId: draft.id};
    });
  }

  async toggleTrackBinding(enabled) {
    return this.#mutate(draft => {
      if (enabled) draft.trackBinding ??= {kind: "actor", trackId: draft.id};
      else delete draft.trackBinding;
    });
  }

  async changeEvaluationKind(nodePath, kind) {
    if (!AGE_PROGRESSION_EVALUATION_TYPES.includes(kind)) throw authoringError("evaluation-kind", `Unsupported evaluation kind: ${kind}`);
    return this.#mutate(draft => {
      const {parent, key} = parentAt(draft, nodePath);
      const current = parent[key];
      const collectionPath = nodePath.split(".").slice(0, -1).join(".");
      const collection = arrayAt(draft, collectionPath);
      const milestone = ownerMilestone(draft, nodePath);
      const siblingId = collection.find(entry => (
        entry !== current
        && typeof entry?.id === "string"
        && entry.id
        && entry.id !== current?.id
      ))?.id;
      if (["allOf", "anyOf", "not"].includes(kind) && !siblingId) {
        throw authoringError(
          "evaluation-reference",
          "Add another evaluation in this same condition block before using a composite condition.",
        );
      }
      parent[key] = evaluationDefaults(kind, {
        id: current?.id ?? nextId(collection, "evaluation"),
        rank: milestone?.rank ?? draft.rank?.minimum ?? 0,
        choiceGroupId: milestone?.choiceGroups?.[0]?.id ?? "choice.1",
        sourceRefId: draft.sourceRefs?.[0]?.id ?? "source.1",
        evaluationId: siblingId,
      });
    });
  }

  async changeEffectType(nodePath, type) {
    const allowed = this.#definition?.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION
      ? AGE_PROGRESSION_EFFECT_TYPES
      : AGE_PROGRESSION_EFFECT_TYPES_V2;
    if (!allowed.includes(type)) throw authoringError("effect-type", `Unsupported effect type: ${type}`);
    return this.#mutate(draft => {
      const {parent, key} = parentAt(draft, nodePath);
      const current = parent[key];
      parent[key] = effectDefaults(type, {
        id: current?.id ?? "effect.1",
        definition: draft,
        milestone: ownerMilestone(draft, nodePath),
      });
    });
  }

  async changeInputType(nodePath, type) {
    const allowed = this.#definition?.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION
      ? AGE_PROGRESSION_INPUT_TYPES
      : AGE_PROGRESSION_INPUT_TYPES_V2;
    if (!allowed.includes(type)) throw authoringError("input-type", `Unsupported semantic input type: ${type}`);
    return this.#mutate(draft => {
      const {parent, key} = parentAt(draft, nodePath);
      const current = parent[key];
      parent[key] = inputDefaults(type, {
        id: current?.id ?? "input.1",
        label: current?.label ?? "Input",
      });
    });
  }

  async setIdentityValueMode(nodePath, mode) {
    if (!["literal", "input"].includes(mode)) throw authoringError("identity-mode", "Semantic values support literal or input modes.");
    return this.#mutate(draft => {
      const effect = valueAt(draft, nodePath);
      if (!["identity.set", "ability.set", "language.add"].includes(effect?.type)) {
        throw authoringError("effect-type", "The selected effect does not support a semantic value.");
      }
      const milestone = ownerMilestone(draft, nodePath);
      effect.value = mode === "input"
        ? {kind: "input", inputId: milestone?.inputs?.[0]?.id ?? "input.1"}
        : (typeof effect.value === "object" ? (effect.type === "ability.set" ? 0 : "") : effect.value);
    });
  }

  async updateIdentityValue(nodePath, raw) {
    return this.#mutate(draft => {
      const effect = valueAt(draft, nodePath);
      if (!["identity.set", "ability.set", "language.add"].includes(effect?.type)) {
        throw authoringError("effect-type", "The selected effect does not support a semantic value.");
      }
      if (effect.value && typeof effect.value === "object" && effect.value.kind === "input") effect.value.inputId = String(raw ?? "");
      else if (effect.type === "ability.set") {
        const parsed = Number(raw);
        effect.value = Number.isFinite(parsed) ? parsed : null;
      } else effect.value = String(raw ?? "");
    });
  }

  async setAmountMode(nodePath, mode) {
    if (!["number", "formula"].includes(mode)) throw authoringError("amount-mode", "Amounts support number or deterministic formula modes.");
    return this.#mutate(draft => {
      const effect = valueAt(draft, nodePath);
      if (!effect || !["resource.initialize", "resource.gain", "classBonus.gain"].includes(effect.type)) throw authoringError("effect-type", "The selected effect has no semantic amount mode.");
      effect.amount = mode === "formula"
        ? {kind: "formula", formula: typeof effect.amount === "number" ? String(effect.amount) : (effect.amount?.formula ?? "0")}
        : (typeof effect.amount === "number" ? effect.amount : 0);
    });
  }

  async updateAmount(nodePath, raw) {
    return this.#mutate(draft => {
      const effect = valueAt(draft, nodePath);
      if (!effect || !["resource.initialize", "resource.gain", "classBonus.gain"].includes(effect.type)) throw authoringError("effect-type", "The selected effect has no semantic amount.");
      if (effect.amount && typeof effect.amount === "object" && effect.amount.kind === "formula") effect.amount.formula = String(raw ?? "");
      else {
        const parsed = Number(raw);
        effect.amount = Number.isFinite(parsed) ? parsed : null;
      }
    });
  }

  async validate() {
    if (this.#parseError) {
      this.#digest = null;
      return false;
    }
    const result = validateProgressionDefinitionExecutabilityV1(this.#definition);
    this.#issues = normalizeIssues(result.issues);
    this.#digest = result.valid ? await definitionDigest(this.#definition) : null;
    return result.valid;
  }

  async bumpVersion() {
    if (!this.#definition) throw authoringError("definition", "No definition is loaded.");
    return this.#mutate(draft => {
      draft.version = bumpProgressionPatchVersion(draft.version);
    });
  }

  async applyQuickStart(workflow, {maximumRank = 20} = {}) {
    if (!AGE_PROGRESSION_QUICK_START_WORKFLOWS.includes(workflow)) {
      throw authoringError("quick-start", `Unknown progression quick-start workflow: ${workflow}`);
    }
    if (this.#definition?.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION) {
      throw authoringError(
        "quick-start-v1",
        "Guided setup creates DefinitionV2 and never converts DefinitionV1 in place. Create a new Progression Definition for a V2 template.",
      );
    }
    return this.#mutate(draft => {
      const next = createProgressionQuickStartDefinition({
        workflow,
        id: draft.id,
        profileId: draft.profileId,
        version: draft.version,
        maximumRank,
      });
      for (const key of Object.keys(draft)) delete draft[key];
      Object.assign(draft, next);
    });
  }

  async save({json, name, enabled} = {}) {
    this.#assertIdle("save it again");
    if (!userCanUpdate(this.#item, this.#environment?.game?.user)) {
      throw authoringError("permission", "Only a GM may save an editable top-level progression definition.");
    }
    if (!this.#provider) throw authoringError("provider", "The progression definition provider is unavailable.");
    if (json !== undefined && !this.loadJson(json) && this.#parseError) {
      throw authoringError("validation", "Fix progression definition JSON syntax before saving.", {issues: this.#issues});
    }
    this.updateDocumentMetadata({name, enabled});
    const update = this.#provider.updateDefinitionDocument
      ?? this.#provider.updateWorldDefinition;
    if (!(update instanceof Function)) throw authoringError("provider", "The progression definition provider cannot update documents.");
    const savingDefinition = canonicalClone(this.#definition);
    const savingCanonical = canonicalJson(savingDefinition);
    const savingName = this.#draftName;
    const savingEnabled = this.#draftEnabled;
    this.#busy = true;
    try {
      if (!(await this.validate())) throw authoringError("validation", "Fix progression definition validation errors before saving.", {issues: this.#issues});
      const preflight = this.context();
      if (preflight.identityChanged) {
        throw authoringError("identity", "A saved definition's id and game profile are immutable. Duplicate it to create a new identity.");
      }
      if (preflight.needsVersionBump) {
        throw authoringError("version", "Changed definition semantics require a newer semantic version. Bump the patch version or enter a newer version before saving.");
      }
      const result = await update.call(this.#provider, this.#item, canonicalClone(savingDefinition), {
        name: savingName.trim() || undefined,
        enabled: savingEnabled,
        user: this.#environment?.game?.user,
      });
      this.#item = result ?? this.#item;
      this.#originalDefinitionValid = true;
      const savedSource = sourceOf(this.#item);
      const savedDefinition = validateProgressionDefinition(savedSource.system?.definition).valid
        ? canonicalClone(savedSource.system.definition)
        : savingDefinition;
      this.#originalDefinition = savedDefinition;
      if (canonicalJson(this.#definition) === savingCanonical) this.#definition = canonicalClone(savedDefinition);
      const savedName = String(savedSource.name ?? savingName);
      this.#originalName = savedName;
      if (this.#draftName === savingName) this.#draftName = savedName;
      const savedEnabled = savedSource.system?.enabled ?? savingEnabled;
      this.#originalEnabled = savedEnabled;
      if (this.#draftEnabled === savingEnabled) this.#draftEnabled = savedEnabled;
      this.#lastSavedAt = new Date().toISOString();
      return result;
    } finally {
      this.#busy = false;
    }
  }

  async duplicateToWorld({json, name} = {}) {
    this.#assertIdle("duplicate it");
    if (this.#environment?.game?.user?.isGM !== true) throw authoringError("permission", "Only a GM may duplicate progression definitions.");
    if (!this.#provider?.createWorldDefinition) throw authoringError("provider", "The progression definition provider cannot create world definitions.");
    if (json !== undefined && !this.loadJson(json) && this.#parseError) {
      throw authoringError("validation", "Fix progression definition JSON syntax before duplicating.", {issues: this.#issues});
    }
    if (!(await this.validate())) throw authoringError("validation", "Fix progression definition validation errors before duplicating.", {issues: this.#issues});
    const duplicate = duplicateProgressionDefinition(this.#definition, {
      suffix: `copy.${Date.now().toString(36)}`,
    });
    return this.#provider.createWorldDefinition(duplicate, {
      name: `Copy of ${String(name ?? this.#draftName ?? this.#item.name ?? this.#definition.id)}`,
      enabled: false,
      renderSheet: true,
      user: this.#environment?.game?.user,
    });
  }

  async exportJson({json} = {}) {
    this.#assertIdle("export it");
    if (json !== undefined && !this.loadJson(json) && this.#parseError) {
      throw authoringError("validation", "Fix progression definition JSON syntax before exporting.", {issues: this.#issues});
    }
    if (!(await this.validate())) throw authoringError("validation", "Fix progression definition validation errors before exporting.", {issues: this.#issues});
    return formatDefinition(this.#definition);
  }

  async openCharacterBuilder() {
    if (!(await this.validate())) throw authoringError("validation", "Only a valid definition can be tested in the Character Builder.");
    if (!this.#definition.milestones.some(milestone => milestone.triggers.includes("character.create"))) {
      throw authoringError("trigger", "This definition has no character.create milestone.");
    }
    const context = this.context();
    if (context.dirty) throw authoringError("preview-unsaved", "Save this draft before opening it in the Character Builder.");
    if (!context.enabled) throw authoringError("preview-disabled", "Enable and save this definition before opening it in the Character Builder.");
    return AgeCharacterBuilder.open({service: this.#service, definitionId: this.#definition.id});
  }

  async openAdvancementCenter() {
    if (!(await this.validate())) throw authoringError("validation", "Only a valid definition can be tested in the Advancement Center.");
    if (!this.#definition.milestones.some(milestone => milestone.triggers.includes("rank.advance"))) {
      throw authoringError("trigger", "This definition has no rank.advance milestone.");
    }
    const context = this.context();
    if (context.dirty) throw authoringError("preview-unsaved", "Save this draft before opening it in the Advancement Center.");
    if (!context.enabled) throw authoringError("preview-disabled", "Enable and save this definition before opening it in the Advancement Center.");
    return AgeAdvancementCenter.open({service: this.#service, definitionId: this.#definition.id});
  }

  context() {
    const source = sourceOf(this.#item);
    const valid = this.#issues.length === 0 && !this.#parseError;
    const currentJson = this.#parseError && this.#rawJsonText !== null
      ? this.#rawJsonText
      : (this.#definition ? formatDefinition(this.#definition) : "");
    const originalJson = this.#originalDefinition ? canonicalJson(this.#originalDefinition) : null;
    const currentCanonical = this.#definition ? canonicalJson(this.#definition) : null;
    const canEdit = userCanUpdate(this.#item, this.#environment?.game?.user);
    const definitionDirty = Boolean(this.#parseError) || originalJson !== currentCanonical;
    const metadataDirty = this.#draftName !== this.#originalName || this.#draftEnabled !== this.#originalEnabled;
    const identityChanged = this.#originalDefinitionValid && (
      this.#definition?.id !== this.#originalDefinition.id
      || this.#definition?.profileId !== this.#originalDefinition.profileId
    );
    let hasNewerVersion = !this.#originalDefinitionValid;
    if (valid && this.#originalDefinitionValid) {
      try {
        hasNewerVersion = compareProgressionDefinitionVersions(
          this.#definition?.version,
          this.#originalDefinition.version,
        ) > 0;
      } catch {
        hasNewerVersion = false;
      }
    }
    const needsVersionBump = Boolean(
      valid
      && this.#originalDefinitionValid
      && definitionDirty
      && !identityChanged
      && !hasNewerVersion
    );
    const hasCreation = asArray(this.#definition?.milestones).some(milestone => asArray(milestone?.triggers).includes("character.create"));
    const hasAdvancement = asArray(this.#definition?.milestones).some(milestone => asArray(milestone?.triggers).includes("rank.advance"));
    const enabled = this.#draftEnabled;
    const dirty = definitionDirty || metadataDirty;
    const saveBlockers = [];
    if (identityChanged) saveBlockers.push({
      code: "identity",
      message: "A saved definition's id and game profile cannot change. Duplicate it to create a new identity.",
      canBump: false,
    });
    if (needsVersionBump) saveBlockers.push({
      code: "version",
      message: "The semantics changed without a newer version. Bump the patch version before saving.",
      canBump: true,
    });
    const canSaveDefinition = canEdit && valid && !this.#busy && saveBlockers.length === 0;
    const canDuplicate = this.#environment?.game?.user?.isGM === true
      && typeof this.#provider?.createWorldDefinition === "function"
      && valid
      && !this.#busy;
    const launchReason = hasTrigger => {
      if (this.#busy) return "Wait for the current operation to finish.";
      if (!hasTrigger) return "This definition does not declare the required trigger.";
      if (!valid) return "Fix validation errors first.";
      if (dirty) return "Save the current draft before testing.";
      if (!enabled) return "Enable and save this definition before testing.";
      return "Ready to open.";
    };
    const lifecycleState = !valid
      ? AGE_PROGRESSION_DEFINITION_LIFECYCLE.INVALID
      : dirty
        ? AGE_PROGRESSION_DEFINITION_LIFECYCLE.DRAFT
        : enabled
          ? AGE_PROGRESSION_DEFINITION_LIFECYCLE.ACTIVE
          : AGE_PROGRESSION_DEFINITION_LIFECYCLE.VALID;
    const lifecycle = {
      state: lifecycleState,
      label: lifecycleState === "active" ? "Valid · Active"
        : lifecycleState === "valid" ? "Valid · Disabled"
          : lifecycleState === "draft" ? "Draft"
            : "Invalid",
      tone: lifecycleState === "active" ? "good"
        : lifecycleState === "valid" ? "neutral"
          : lifecycleState === "draft" ? "warn"
            : "bad",
      description: lifecycleState === "active"
        ? "Saved, validated, and available to the Character Builder and Advancement Center."
        : lifecycleState === "valid"
          ? "Saved and validated, but disabled and unavailable to progression workflows."
          : lifecycleState === "draft"
            ? "This working draft is not runnable. Validate and save it to make it available."
            : "This definition is not runnable. Correct the listed errors before saving.",
    };
    const localize = this.#environment?.game?.i18n?.localize;
    const profileChoices = Object.fromEntries(AGE_PROGRESSION_PROFILE_IDS.map(profileId => {
      let label = profileId;
      try {
        const labelKey = progressionProfileAdapter(profileId).label ?? profileId;
        label = localize instanceof Function ? localize.call(this.#environment.game.i18n, labelKey) : labelKey;
      } catch {}
      return [profileId, label];
    }));
    const quickStarts = [
      {id: "character-creation", icon: "fa-user-plus", label: "Character creation only", help: "Ask for a name and build a new Character from one creation milestone."},
      {id: "complete-actor-path", icon: "fa-route", label: "Creation + Actor ranks", help: "Create a Character and provide a complete classless rank timeline."},
      {id: "class-advancement", icon: "fa-shield-halved", label: "Class-based advancement", help: "Create a full rank timeline stored on an owned Class Item."},
      {id: "actor-advancement", icon: "fa-arrow-trend-up", label: "Classless advancement", help: "Create a full rank timeline stored directly on the Character."},
    ];
    return {
      sheetVersion: AGE_PROGRESSION_DEFINITION_SHEET_VERSION,
      item: this.#item,
      name: this.#draftName,
      img: String(source.img ?? AGE_PROGRESSION_DEFINITION_ICON),
      enabled,
      definition: this.definition,
      definitionJson: currentJson,
      digest: this.#digest ?? source.system?.digest ?? null,
      issues: structuredClone(this.#issues),
      valid,
      dirty,
      definitionDirty,
      metadataDirty,
      identityChanged,
      needsVersionBump,
      hasNewerVersion,
      saveBlockers,
      lifecycle,
      isDraft: lifecycleState === AGE_PROGRESSION_DEFINITION_LIFECYCLE.DRAFT,
      isActive: lifecycleState === AGE_PROGRESSION_DEFINITION_LIFECYCLE.ACTIVE,
      isSavedValid: lifecycleState === AGE_PROGRESSION_DEFINITION_LIFECYCLE.VALID,
      isInvalid: lifecycleState === AGE_PROGRESSION_DEFINITION_LIFECYCLE.INVALID,
      saveState: this.#busy ? "Saving…"
        : dirty ? "Unsaved changes"
          : this.#lastSavedAt ? "Saved just now"
            : "Saved",
      lastSavedAt: this.#lastSavedAt,
      busy: this.#busy,
      canEdit,
      canEditIdentity: canEdit && !this.#originalDefinitionValid,
      canSaveDefinition,
      canDuplicate,
      canUseQuickStart: canEdit && this.#definition?.schemaVersion !== AGE_PROGRESSION_DEFINITION_VERSION,
      isCompendium: Boolean(this.#item.pack),
      hasCreation,
      hasAdvancement,
      canLaunchCreation: valid && enabled && !dirty && !this.#busy && hasCreation,
      canLaunchAdvancement: valid && enabled && !dirty && !this.#busy && hasAdvancement,
      creationLaunchReason: launchReason(hasCreation),
      advancementLaunchReason: launchReason(hasAdvancement),
      profileChoices,
      quickStarts,
      checklist: progressionAuthoringChecklist(this.#definition, {valid}),
      semantic: this.#definition ? buildProgressionSemanticAuthoringView(this.#definition) : null,
      effectTypes: this.#definition?.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION
        ? AGE_PROGRESSION_EFFECT_TYPES
        : AGE_PROGRESSION_EFFECT_TYPES_V2,
      evaluationTypes: AGE_PROGRESSION_EVALUATION_TYPES,
      triggerTypes: AGE_PROGRESSION_TRIGGERS,
    };
  }
}

export class AgeProgressionDefinitionSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["age-system", "sheet", "item", "age-progression-definition-sheet"],
    position: {width: 980, height: 820},
    window: {title: "AGE Progression Definition", resizable: true, minimizable: true},
    form: {closeOnSubmit: false, submitOnChange: false},
    actions: {
      validate: AgeProgressionDefinitionSheet._validate,
      save: AgeProgressionDefinitionSheet._save,
      reset: AgeProgressionDefinitionSheet._reset,
      bumpVersion: AgeProgressionDefinitionSheet._bumpVersion,
      duplicate: AgeProgressionDefinitionSheet._duplicate,
      export: AgeProgressionDefinitionSheet._export,
      openBuilder: AgeProgressionDefinitionSheet._openBuilder,
      openCenter: AgeProgressionDefinitionSheet._openCenter,
      showSection: AgeProgressionDefinitionSheet._showSection,
      focusIssue: AgeProgressionDefinitionSheet._focusIssue,
      copyIssue: AgeProgressionDefinitionSheet._copyIssue,
      semanticAdd: AgeProgressionDefinitionSheet._semanticAdd,
      semanticRemove: AgeProgressionDefinitionSheet._semanticRemove,
      semanticMove: AgeProgressionDefinitionSheet._semanticMove,
      semanticToggleBinding: AgeProgressionDefinitionSheet._semanticToggleBinding,
      quickStart: AgeProgressionDefinitionSheet._quickStart,
      sourceSearch: AgeProgressionDefinitionSheet._sourceSearch,
      sourceSelect: AgeProgressionDefinitionSheet._sourceSelect,
    },
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/progression/definition-sheet.hbs",
      scrollable: [".age-progression-definition-sheet__body"],
    },
  };

  constructor(options = {}) {
    const {controller = null, provider = null, service = null, environment = globalThis, ...applicationOptions} = options;
    super(applicationOptions);
    this.controller = controller ?? new AgeProgressionDefinitionAuthoringController({
      item: this.document,
      provider,
      service,
      environment,
    });
    this._ageImportAbort = null;
    this._ageSemanticQueue = Promise.resolve();
    this._ageSourceSearchQuery = "";
    this._ageSourceSearchResults = [];
    this._ageStudioSection = "setup";
    this._ageMilestoneFilter = null;
  }

  get object() { return this.document; }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (!this.controller.initialized) await this.controller.initialize();
    const prepared = Object.assign(context, this.controller.context(), {
      sourceSearchQuery: this._ageSourceSearchQuery,
      sourceSearchResults: structuredClone(this._ageSourceSearchResults),
    });
    const milestones = prepared.semantic?.milestones ?? [];
    const allowedFilters = new Set(["all", ...milestones.map(entry => entry.filterValue)]);
    if (!allowedFilters.has(this._ageMilestoneFilter)) {
      this._ageMilestoneFilter = milestones.length > 5 ? "0" : "all";
    }
    prepared.milestoneFilter = this._ageMilestoneFilter;
    prepared.studioSection = this._ageStudioSection;
    prepared.studioSections = [
      {id: "setup", label: "Basics", icon: "fa-wand-magic-sparkles", count: null},
      {id: "sources", label: "Source Items", icon: "fa-books", count: prepared.semantic?.sourceRefs?.length ?? 0},
      {id: "timeline", label: "Timeline", icon: "fa-timeline", count: milestones.length},
      {id: "rules", label: "Rules", icon: "fa-gears", count: (prepared.semantic?.evaluations?.length ?? 0) + (prepared.semantic?.effects?.length ?? 0)},
      {id: "advanced", label: "Advanced JSON", icon: "fa-code", count: null},
    ].map(section => ({...section, active: section.id === this._ageStudioSection}));
    return prepared;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._ageImportAbort?.abort();
    this._ageImportAbort = new AbortController();
    this.element?.querySelector?.("[data-age-progression-import]")?.addEventListener("change", event => {
      void this.#importFile(event);
    }, {signal: this._ageImportAbort.signal});
    this.element?.addEventListener?.("change", event => {
      if (event.target?.matches?.("[data-age-progression-milestone-filter]")) {
        this.#applyMilestoneFilter(event.target.value);
        return;
      }
      if (event.target?.matches?.("[data-age-progression-metadata], [data-age-progression-semantic-field], [data-age-progression-special], [data-age-progression-trigger], [data-age-progression-raw]")) {
        const target = event.target;
        this._ageSemanticQueue = this._ageSemanticQueue.then(() => (
          target.matches("[data-age-progression-metadata]")
            ? this.#metadataFieldChanged({target})
            : this.#semanticFieldChanged({target})
        ));
      }
    }, {signal: this._ageImportAbort.signal});
    this.element?.addEventListener?.("dragover", event => {
      if (event.target?.closest?.("[data-age-progression-source-drop]")) event.preventDefault();
    }, {signal: this._ageImportAbort.signal});
    this.element?.addEventListener?.("drop", event => {
      if (!event.target?.closest?.("[data-age-progression-source-drop]")) return;
      event.preventDefault();
      void this.#sourceDropped(event);
    }, {signal: this._ageImportAbort.signal});
    this.element?.addEventListener?.("keydown", event => {
      if (event.target?.matches?.("[role='tab'][data-action='showSection']")) this.#handleStudioTabKey(event);
    }, {signal: this._ageImportAbort.signal});
    this.#applyStudioSection(this._ageStudioSection);
    this.#applyMilestoneFilter(this._ageMilestoneFilter);
  }

  async close(options = {}) {
    if (!options.force && this.controller.initialized && this.controller.busy) {
      globalThis.ui?.notifications?.warn?.("Wait for the current Progression Definition operation to finish before closing this sheet.");
      return this;
    }
    if (!options.force && this.controller.initialized && this.controller.context().dirty) {
      const discard = await this.#confirmDiscard({
        title: "Discard progression draft?",
        content: "<p>This Progression Definition has unsaved changes. Close it and discard the draft?</p>",
        yesLabel: "Discard and close",
      });
      if (!discard) return this;
    }
    this._ageImportAbort?.abort();
    this._ageImportAbort = null;
    return super.close(options);
  }

  #field(name) {
    return this.element?.querySelector?.(`[name="${name}"]`) ?? null;
  }

  #json() { return this.#field("definitionJson")?.value ?? ""; }
  #name() { return this.#field("name")?.value ?? this.document.name; }
  #enabled() { return Boolean(this.#field("enabled")?.checked); }

  async #confirmDiscard({title, content, yesLabel = "Discard changes"} = {}) {
    const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
    if (!(DialogV2?.confirm instanceof Function)) return false;
    return (await DialogV2.confirm({
      window: {title},
      content,
      yes: {label: yesLabel},
      no: {label: "Keep editing"},
    })) === true;
  }

  #applyStudioSection(section) {
    const allowed = new Set(["setup", "sources", "timeline", "rules", "advanced"]);
    this._ageStudioSection = allowed.has(section) ? section : "setup";
    for (const button of this.element?.querySelectorAll?.("[data-action='showSection']") ?? []) {
      const active = button.dataset.section === this._ageStudioSection;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const panel of this.element?.querySelectorAll?.("[data-age-progression-section-panel]") ?? []) {
      const active = panel.dataset.ageProgressionSectionPanel === this._ageStudioSection;
      panel.hidden = !active;
      if (active && this._ageStudioSection === "advanced" && panel.tagName === "DETAILS") panel.open = true;
    }
  }

  #handleStudioTabKey(event) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const tabs = [...(this.element?.querySelectorAll?.("[role='tab'][data-action='showSection']") ?? [])];
    if (!tabs.length) return;
    const current = Math.max(0, tabs.indexOf(event.target));
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
        : event.key === "ArrowLeft" ? (current - 1 + tabs.length) % tabs.length
          : (current + 1) % tabs.length;
    event.preventDefault();
    const next = tabs[nextIndex];
    this.#applyStudioSection(next.dataset.section);
    next.focus();
  }

  #applyMilestoneFilter(value) {
    const articles = [...(this.element?.querySelectorAll?.("[data-age-progression-milestone]") ?? [])];
    const requested = String(value ?? "all");
    const allowed = requested === "all" || articles.some(article => article.dataset.ageProgressionMilestone === requested);
    this._ageMilestoneFilter = allowed ? requested : "all";
    const selector = this.element?.querySelector?.("[data-age-progression-milestone-filter]");
    if (selector) selector.value = this._ageMilestoneFilter;
    for (const article of articles) {
      article.hidden = this._ageMilestoneFilter !== "all"
        && article.dataset.ageProgressionMilestone !== this._ageMilestoneFilter;
    }
  }

  async #metadataFieldChanged({target}) {
    this.controller.updateDocumentMetadata({
      name: target.name === "name" ? target.value : undefined,
      enabled: target.name === "enabled" ? Boolean(target.checked) : undefined,
    });
    await this.render({force: true});
  }

  #focusValidationIssue(path, code = "") {
    const section = progressionAuthoringSectionForIssue(path, code);
    const draftPath = progressionValidationPathToDraftPath(path);
    const milestoneMatch = draftPath.match(/^milestones\.(\d+)/);
    if (milestoneMatch) this.#applyMilestoneFilter(milestoneMatch[1]);
    this.#applyStudioSection(section);

    const controls = [...(this.element?.querySelectorAll?.("[data-path]") ?? [])];
    let destination = controls.find(control => control.dataset.path === draftPath) ?? null;
    if (!destination) {
      const nodes = [...(this.element?.querySelectorAll?.("[data-definition-path]") ?? [])]
        .filter(node => String(path).startsWith(node.dataset.definitionPath))
        .sort((left, right) => right.dataset.definitionPath.length - left.dataset.definitionPath.length);
      destination = nodes[0] ?? null;
    }
    destination ??= section === "advanced"
      ? this.element?.querySelector?.("[data-age-progression-raw]")
      : this.element?.querySelector?.(`[data-age-progression-section-panel="${section}"]`);
    for (const details of destination?.closest?.("details") ? [destination.closest("details")] : []) details.open = true;
    const focusTarget = destination?.matches?.("input, select, textarea, button, summary")
      ? destination
      : destination?.querySelector?.("input, select, textarea, button, summary");
    destination?.scrollIntoView?.({behavior: "smooth", block: "center"});
    focusTarget?.focus?.({preventScroll: true});
    destination?.classList?.add?.("age-progression-definition-sheet__issue-target");
    globalThis.setTimeout?.(() => destination?.classList?.remove?.("age-progression-definition-sheet__issue-target"), 1800);
  }

  async #syncRawDraft() {
    const loaded = this.controller.loadJson(this.#json());
    if (!loaded && this.controller.context().issues.some(issue => issue.code === "json-parse" || issue.code === "json-empty")) {
      throw authoringError("json-parse", "Fix the Advanced JSON syntax before using the semantic editor.");
    }
    return this.controller.definition;
  }

  async #run(operation, {render = true, success = null} = {}) {
    try {
      const result = await operation();
      if (success) globalThis.ui?.notifications?.info?.(success);
      if (render) await this.render({force: true});
      return result;
    } catch (error) {
      if (!error?.code && !String(error?.name ?? "").startsWith("AgeProgression")) {
        console.error("AGE System | Progression Definition", error);
      }
      globalThis.ui?.notifications?.error?.(error.message);
      if (render) await this.render({force: true});
      return null;
    }
  }

  static async _validate(_event, _target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      const loaded = this.controller.loadJson(this.#json());
      if (!loaded && this.controller.context().issues.some(issue => issue.code === "json-parse" || issue.code === "json-empty")) {
        throw authoringError("validation", "Fix progression definition JSON syntax before validating.");
      }
      if (!(await this.controller.validate())) throw authoringError("validation", "The progression definition has validation errors.");
    }, {success: "Progression definition is valid."});
  }

  static async _save(_event, _target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      return this.controller.save({
        json: this.#json(),
        name: this.#name(),
        enabled: this.#enabled(),
      });
    }, {success: "Progression definition saved."});
  }

  static async _reset(_event, _target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      if (this.controller.context().dirty) {
        const discard = await this.#confirmDiscard({
          title: "Reset progression draft?",
          content: "<p>Resetting restores the last saved Progression Definition and discards every unsaved change.</p>",
          yesLabel: "Discard and reset",
        });
        if (!discard) return null;
      }
      return this.controller.reset();
    });
  }

  static async _bumpVersion(_event, _target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      await this.#syncRawDraft();
      await this.controller.bumpVersion();
    });
  }

  static async _duplicate(_event, _target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      return this.controller.duplicateToWorld({json: this.#json(), name: this.#name()});
    }, {
      success: "A disabled world copy was created.",
    });
  }

  static async _export(_event, _target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      const json = await this.controller.exportJson({json: this.#json()});
      const fileName = `${safeId(this.controller.definition.id)}-${this.controller.definition.version}.json`;
      globalThis.saveDataToFile?.(json, "application/json", fileName);
      return json;
    }, {render: false});
  }

  static async _openBuilder(_event, _target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      return this.controller.openCharacterBuilder();
    }, {render: false});
  }

  static async _openCenter(_event, _target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      return this.controller.openAdvancementCenter();
    }, {render: false});
  }

  static async _showSection(_event, target) {
    this.#applyStudioSection(target?.dataset?.section);
    const body = this.element?.querySelector?.(".age-progression-definition-sheet__body");
    if (body) body.scrollTop = 0;
  }

  static async _focusIssue(_event, target) {
    this.#focusValidationIssue(target?.dataset?.issuePath ?? "$", target?.dataset?.issueCode ?? "");
  }

  static async _copyIssue(_event, target) {
    const value = target?.dataset?.issue ?? "";
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(value);
      globalThis.ui?.notifications?.info?.("Validation issue copied.");
    }
  }

  static async _semanticAdd(_event, target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      await this.#syncRawDraft();
      await this.controller.addSemanticEntry(target?.dataset?.kind, target?.dataset?.collection || null);
      if (target?.dataset?.kind === "milestone") {
        this._ageStudioSection = "timeline";
        this._ageMilestoneFilter = String((this.controller.definition?.milestones?.length ?? 1) - 1);
      }
    });
  }

  static async _semanticRemove(_event, target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      await this.#syncRawDraft();
      await this.controller.removeSemanticEntry(target?.dataset?.collection, Number(target?.dataset?.index));
    });
  }

  static async _semanticMove(_event, target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      await this.#syncRawDraft();
      await this.controller.moveSemanticEntry(
        target?.dataset?.collection,
        Number(target?.dataset?.index),
        Number(target?.dataset?.direction),
      );
    });
  }

  static async _semanticToggleBinding(_event, target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      await this.#syncRawDraft();
      await this.controller.toggleTrackBinding(target?.dataset?.enabled === "true");
    });
  }

  static async _quickStart(_event, target) {
    return this.#run(async () => {
      await this._ageSemanticQueue;
      await this.#syncRawDraft();
      if (!this.controller.context().canUseQuickStart) {
        throw authoringError("quick-start-v1", "Guided setup creates DefinitionV2 and never converts DefinitionV1 in place. Create a new Progression Definition for a V2 template.");
      }
      const maximumRank = Number(this.element?.querySelector?.("[data-age-progression-quick-ranks]")?.value ?? 20);
      const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
      if (DialogV2?.confirm instanceof Function) {
        const accepted = await DialogV2.confirm({
          window: {title: "Replace progression draft?"},
          content: "<p>This replaces the current in-memory draft with a guided starting structure. Nothing is saved until you choose Save.</p>",
          yes: {label: "Replace draft"},
          no: {label: "Keep current draft"},
        });
        if (accepted !== true) return null;
      }
      const result = await this.controller.applyQuickStart(target?.dataset?.workflow, {maximumRank});
      this._ageStudioSection = "timeline";
      this._ageMilestoneFilter = "0";
      return result;
    }, {success: "Guided progression structure created. Review each rank, then validate and save."});
  }

  static async _sourceSearch(_event, _target) {
    return this.#run(async () => {
      const input = this.element?.querySelector?.("[data-age-progression-source-search]");
      this._ageSourceSearchQuery = String(input?.value ?? "").trim();
      this._ageSourceSearchResults = await searchProgressionSourceItems(this._ageSourceSearchQuery);
    });
  }

  static async _sourceSelect(_event, target) {
    return this.#run(() => this.#addSourceUuid(target?.dataset?.uuid));
  }

  async #addSourceUuid(uuid) {
    const resolve = globalThis.foundry?.utils?.fromUuid ?? globalThis.fromUuid;
    if (!(resolve instanceof Function)) throw authoringError("source-resolver", "Foundry UUID resolution is unavailable.");
    const document = await resolve(uuid);
    if (!document) throw authoringError("source-resolution", `The selected Item could not be resolved: ${uuid}`);
    await this._ageSemanticQueue;
    await this.#syncRawDraft();
    const result = await this.controller.addSourceDocument(document);
    this._ageSourceSearchResults = [];
    this._ageSourceSearchQuery = "";
    return result;
  }

  async #sourceDropped(event) {
    return this.#run(async () => {
      let data = null;
      try {
        const TextEditor = globalThis.foundry?.applications?.ux?.TextEditor?.implementation;
        data = TextEditor?.getDragEventData?.(event);
      } catch {}
      if (!data) {
        try { data = JSON.parse(event.dataTransfer?.getData?.("text/plain") ?? "null"); } catch {}
      }
      const uuid = data?.uuid ?? (data?.type === "Item" && data?.id ? `Item.${data.id}` : null);
      if (!uuid || (data?.type && data.type !== "Item")) {
        throw authoringError("source-drop", "Drop an Item from the sidebar, a compendium, or search results.");
      }
      return this.#addSourceUuid(uuid);
    });
  }

  async #semanticFieldChanged(event) {
    const target = event.target;
    await this.#run(async () => {
      if (target.matches("[data-age-progression-raw]")) {
        const loaded = this.controller.loadJson(target.value);
        if (!loaded && this.controller.context().issues.some(issue => issue.code === "json-parse" || issue.code === "json-empty")) return;
        await this.controller.validate();
        return;
      }
      await this.#syncRawDraft();
      if (target.matches("[data-age-progression-trigger]")) {
        await this.controller.toggleMilestoneTrigger(
          Number(target.dataset.milestone),
          target.dataset.ageProgressionTrigger,
          Boolean(target.checked),
        );
        return;
      }
      const special = target.dataset.ageProgressionSpecial;
      const path = target.dataset.path;
      if (special === "evaluation-kind") return this.controller.changeEvaluationKind(path, target.value);
      if (special === "input-type") return this.controller.changeInputType(path, target.value);
      if (special === "effect-type") return this.controller.changeEffectType(path, target.value);
      if (special === "identity-mode") return this.controller.setIdentityValueMode(path, target.value);
      if (special === "identity-value") return this.controller.updateIdentityValue(path, target.value);
      if (special === "amount-mode") return this.controller.setAmountMode(path, target.value);
      if (special === "amount-value") return this.controller.updateAmount(path, target.value);
      const raw = target.type === "checkbox" ? Boolean(target.checked) : target.value;
      return this.controller.updateSemanticField(path, raw, {
        type: target.dataset.valueType ?? (target.type === "checkbox" ? "boolean" : "string"),
        optional: target.dataset.optional === "true",
      });
    });
  }

  async #importFile(event) {
    const input = event.currentTarget;
    const file = input.files?.[0] ?? null;
    if (!file) return;
    await this.#run(async () => {
      if (this.controller.context().dirty) {
        const discard = await this.#confirmDiscard({
          title: "Replace progression draft?",
          content: "<p>Loading this JSON file replaces every unsaved draft change.</p>",
          yesLabel: "Replace draft",
        });
        if (!discard) return null;
      }
      const text = await file.text();
      const loaded = this.controller.loadJson(text);
      if (!loaded && this.controller.context().issues.some(issue => issue.code === "json-parse" || issue.code === "json-empty")) return;
      await this.controller.validate();
    });
    input.value = "";
  }
}

export async function validateProgressionDefinitionSheetDocument(item, {environment = globalThis} = {}) {
  return validateProgressionDefinitionDocument(item, {environment});
}
