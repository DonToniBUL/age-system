/**
 * A deliberately small, document-agnostic contract for AGE character creation
 * and advancement.  Providers may describe rules here, but execution belongs
 * to the compiler/service layer; definitions must never contain Foundry update
 * paths, callbacks, or random selection instructions.
 */
export const AGE_PROGRESSION_DEFINITION_VERSION = 1;
export const AGE_PROGRESSION_DEFINITION_V2_VERSION = 2;
export const AGE_PROGRESSION_LATEST_DEFINITION_VERSION = AGE_PROGRESSION_DEFINITION_V2_VERSION;
export const AGE_PROGRESSION_SUPPORTED_DEFINITION_VERSIONS = Object.freeze([
  AGE_PROGRESSION_DEFINITION_VERSION,
  AGE_PROGRESSION_DEFINITION_V2_VERSION,
]);

export const AGE_PROGRESSION_EFFECT_TYPES = Object.freeze([
  "identity.set",
  "resource.initialize",
  "resource.gain",
  "classBonus.gain",
  "ability.allocate",
  "ability.setPrimary",
  "weaponGroup.add",
  "item.acquire",
  "item.advance",
  "track.setRank",
  "summary.add"
]);

export const AGE_PROGRESSION_EVALUATION_TYPES = Object.freeze([
  "rank.atLeast",
  "choice.selected",
  "item.owned",
  "ability.minimum",
  "allOf",
  "anyOf",
  "not"
]);

export const AGE_PROGRESSION_TRIGGERS = Object.freeze([
  "character.create",
  "rank.advance"
]);

export const AGE_PROGRESSION_INPUT_TYPES = Object.freeze(["text"]);

export const AGE_PROGRESSION_EFFECT_TYPES_V2 = Object.freeze([
  ...AGE_PROGRESSION_EFFECT_TYPES,
  "ability.set",
  "language.add",
]);

export const AGE_PROGRESSION_INPUT_TYPES_V2 = Object.freeze([
  "text",
  "longText",
  "integer",
  "select",
]);

const EFFECT_TYPES = new Set(AGE_PROGRESSION_EFFECT_TYPES);
const EVALUATION_TYPES = new Set(AGE_PROGRESSION_EVALUATION_TYPES);
const TRIGGERS = new Set(AGE_PROGRESSION_TRIGGERS);
const INPUT_TYPES = new Set(AGE_PROGRESSION_INPUT_TYPES);
const EFFECT_TYPES_V2 = new Set(AGE_PROGRESSION_EFFECT_TYPES_V2);
const INPUT_TYPES_V2 = new Set(AGE_PROGRESSION_INPUT_TYPES_V2);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/i;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const IDENTITY_FIELDS = new Set(["name", "ancestry", "background", "socialClass", "class", "description"]);
// Only Character source fields which are present in the typed Actor model may
// be advertised by DefinitionV1. Stunt costs belong to owned Stunt Items;
// Characters do not have a persistable `system.stuntPoints` resource.
const RESOURCE_IDS = new Set(["health", "powerPoints", "conviction", "currency"]);
const INITIALIZABLE_RESOURCE_IDS = new Set(["health", "powerPoints", "conviction"]);
const CLASS_BONUS_IDS = new Set(["health", "powerPoints", "conviction", "defense", "toughness"]);
const SOURCE_KINDS = new Set(["compendium", "journal", "manual"]);
const CONTENT_COVERAGE = new Set(["synthetic", "partial", "complete"]);
const MAX_TEXT_INPUT_LENGTH = 4096;
const MAX_LONG_TEXT_INPUT_LENGTH = 65536;
const IDENTITY_FIELDS_V2 = new Set([
  ...IDENTITY_FIELDS,
  "profession",
  "drive",
  "quality",
  "downfall",
  "goals",
  "ties",
  "language",
]);
const RESOURCE_IDS_V2 = new Set([...RESOURCE_IDS, "resources"]);
const INITIALIZABLE_RESOURCE_IDS_V2 = new Set([...INITIALIZABLE_RESOURCE_IDS, "currency", "resources"]);

function issue(issues, path, message, code = "invalid") {
  issues.push(Object.freeze({path, message, code}));
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainJson(value, path, issues) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issue(issues, path, "must be a finite JSON number", "json-number");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPlainJson(entry, `${path}[${index}]`, issues));
    return;
  }
  if (!isPlainObject(value)) {
    issue(issues, path, "must be plain JSON data without functions or custom prototypes", "plain-json");
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) issue(issues, `${path}.${key}`, "uses a forbidden prototype-pollution key", "unsafe-key");
    assertPlainJson(entry, `${path}.${key}`, issues);
  }
}

function exactKeys(object, allowed, path, issues) {
  if (!isPlainObject(object)) {
    issue(issues, path, "must be an object", "object");
    return false;
  }
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) issue(issues, `${path}.${key}`, "is not allowed by DefinitionV1", "unknown-key");
  }
  return true;
}

function exactKeysV2(object, allowed, path, issues) {
  if (!isPlainObject(object)) {
    issue(issues, path, "must be an object", "object");
    return false;
  }
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) issue(issues, `${path}.${key}`, "is not allowed by DefinitionV2", "unknown-key");
  }
  return true;
}

function requiredString(value, path, issues, {pattern = null} = {}) {
  if (typeof value !== "string" || !value.trim()) {
    issue(issues, path, "must be a non-empty string", "string");
    return false;
  }
  if (pattern && !pattern.test(value)) {
    issue(issues, path, "is not a valid stable identifier", "identifier");
    return false;
  }
  return true;
}

function integer(value, path, issues, {minimum = null, maximum = null} = {}) {
  if (!Number.isInteger(value)) {
    issue(issues, path, "must be an integer", "integer");
    return false;
  }
  if (minimum !== null && value < minimum) issue(issues, path, `must be at least ${minimum}`, "minimum");
  if (maximum !== null && value > maximum) issue(issues, path, `must be at most ${maximum}`, "maximum");
  return true;
}

function uniqueIds(entries, path, issues) {
  const ids = new Set();
  for (const [index, entry] of entries.entries()) {
    const id = entry?.id;
    if (typeof id !== "string") continue;
    if (ids.has(id)) issue(issues, `${path}[${index}].id`, `duplicates "${id}"`, "duplicate-id");
    ids.add(id);
  }
  return ids;
}

function validateAmount(value, path, issues) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issue(issues, path, "must be a finite number", "amount-number");
    return Number.isFinite(value);
  }
  exactKeys(value, ["kind", "formula", "rollId"], path, issues);
  if (value?.kind !== "formula") issue(issues, `${path}.kind`, "must be the formula expression kind", "amount-kind");
  if (!requiredString(value?.formula, `${path}.formula`, issues)) return false;
  if (value.rollId !== undefined) requiredString(value.rollId, `${path}.rollId`, issues, {pattern: ID_PATTERN});
  if (/\b(?:table|rolltable|random|draw)\b/i.test(value.formula)) {
    issue(issues, `${path}.formula`, "must not use RollTables or random selection strategies", "forbidden-random");
  }
  return true;
}

function validateSourceRef(ref, path, issues) {
  exactKeys(ref, ["id", "kind", "uuid", "label", "revision"], path, issues);
  requiredString(ref?.id, `${path}.id`, issues, {pattern: ID_PATTERN});
  if (!SOURCE_KINDS.has(ref?.kind)) issue(issues, `${path}.kind`, "must be compendium, journal, or manual", "source-kind");
  if (ref?.uuid !== undefined) requiredString(ref.uuid, `${path}.uuid`, issues);
  if (ref?.label !== undefined) requiredString(ref.label, `${path}.label`, issues);
  if (ref?.revision !== undefined) requiredString(ref.revision, `${path}.revision`, issues);
}

function validateSourceIds(ids, sourceIds, path, issues) {
  if (!Array.isArray(ids)) {
    issue(issues, path, "must be an array", "array");
    return;
  }
  const seen = new Set();
  ids.forEach((id, index) => {
    requiredString(id, `${path}[${index}]`, issues, {pattern: ID_PATTERN});
    if (!sourceIds.has(id)) issue(issues, `${path}[${index}]`, `does not reference a declared sourceRef "${id}"`, "source-ref");
    if (seen.has(id)) issue(issues, `${path}[${index}]`, `duplicates "${id}"`, "duplicate-source-ref");
    seen.add(id);
  });
}

function validateTrackBinding(binding, path, issues) {
  exactKeys(binding, ["kind", "trackId", "sourceUuids"], path, issues);
  if (!new Set(["class-item", "actor"]).has(binding?.kind)) {
    issue(issues, `${path}.kind`, "must be class-item or actor", "track-binding-kind");
  }
  requiredString(binding?.trackId, `${path}.trackId`, issues, {pattern: ID_PATTERN});
  if (DANGEROUS_KEYS.has(binding?.trackId)) {
    issue(issues, `${path}.trackId`, "uses a reserved object-map key", "unsafe-key");
  }
  if (binding?.kind === "actor" && binding?.sourceUuids !== undefined) {
    issue(issues, `${path}.sourceUuids`, "is only valid for class-item tracks", "track-source-uuids");
  }
  if (binding?.sourceUuids !== undefined) {
    if (!Array.isArray(binding.sourceUuids) || !binding.sourceUuids.length) {
      issue(issues, `${path}.sourceUuids`, "must be a non-empty array when supplied", "class-source-uuids");
    } else {
      const seen = new Set();
      binding.sourceUuids.forEach((uuid, index) => {
        requiredString(uuid, `${path}.sourceUuids[${index}]`, issues);
        if (seen.has(uuid)) issue(issues, `${path}.sourceUuids[${index}]`, `duplicates "${uuid}"`, "duplicate-class-source-uuid");
        seen.add(uuid);
      });
    }
  }
}

function validateSemanticInput(input, path, issues) {
  exactKeys(input, ["id", "label", "type", "required", "default", "minLength", "maxLength"], path, issues);
  requiredString(input?.id, `${path}.id`, issues, {pattern: ID_PATTERN});
  if (input?.label !== undefined) requiredString(input.label, `${path}.label`, issues);
  if (!INPUT_TYPES.has(input?.type)) issue(issues, `${path}.type`, "must be a supported semantic input type", "input-type");
  if (typeof input?.required !== "boolean") issue(issues, `${path}.required`, "must be boolean", "boolean");
  if (input?.default !== undefined && typeof input.default !== "string") issue(issues, `${path}.default`, "must be a string", "input-default");
  if (input?.minLength !== undefined) integer(input.minLength, `${path}.minLength`, issues, {minimum: 0, maximum: MAX_TEXT_INPUT_LENGTH});
  if (input?.maxLength !== undefined) integer(input.maxLength, `${path}.maxLength`, issues, {minimum: 1, maximum: MAX_TEXT_INPUT_LENGTH});
  if (Number.isInteger(input?.minLength) && Number.isInteger(input?.maxLength) && input.minLength > input.maxLength) {
    issue(issues, path, "minLength cannot exceed maxLength", "input-length");
  }
  if (typeof input?.default === "string") {
    if (/[\u0000-\u001f\u007f]/.test(input.default)) issue(issues, `${path}.default`, "must not contain control characters", "input-control");
    if (Number.isInteger(input.minLength) && input.default.trim().length < input.minLength) issue(issues, `${path}.default`, "is shorter than minLength", "input-length");
    if (Number.isInteger(input.maxLength) && input.default.trim().length > input.maxLength) issue(issues, `${path}.default`, "is longer than maxLength", "input-length");
  }
}

function validateEvaluation(evaluation, path, issues, choiceOptions, sourceIds, rank) {
  exactKeys(evaluation, ["id", "kind", "rank", "choiceGroupId", "optionIds", "sourceRefId", "abilityId", "value", "evaluationIds"], path, issues);
  requiredString(evaluation?.id, `${path}.id`, issues, {pattern: ID_PATTERN});
  if (!EVALUATION_TYPES.has(evaluation?.kind)) {
    issue(issues, `${path}.kind`, "is not a supported semantic evaluation", "evaluation-kind");
    return;
  }
  switch (evaluation.kind) {
    case "rank.atLeast":
      integer(evaluation.rank, `${path}.rank`, issues, {minimum: rank.minimum, maximum: rank.maximum});
      break;
    case "choice.selected":
      requiredString(evaluation.choiceGroupId, `${path}.choiceGroupId`, issues, {pattern: ID_PATTERN});
      const knownOptionIds = choiceOptions.get(evaluation.choiceGroupId);
      if (!knownOptionIds) issue(issues, `${path}.choiceGroupId`, "does not name a local choice group", "choice-ref");
      if (evaluation.optionIds !== undefined) {
        if (!Array.isArray(evaluation.optionIds) || !evaluation.optionIds.length) issue(issues, `${path}.optionIds`, "must be a non-empty array when supplied", "option-ids");
        else {
          const seen = new Set();
          evaluation.optionIds.forEach((id, index) => {
            const optionPath = `${path}.optionIds[${index}]`;
            const validId = requiredString(id, optionPath, issues, {pattern: ID_PATTERN});
            if (validId && knownOptionIds && !knownOptionIds.has(id)) issue(issues, optionPath, `does not name an option in choice group "${evaluation.choiceGroupId}"`, "choice-option-ref");
            if (seen.has(id)) issue(issues, optionPath, `duplicates "${id}"`, "duplicate-option-ref");
            seen.add(id);
          });
        }
      }
      break;
    case "item.owned":
      if (requiredString(evaluation.sourceRefId, `${path}.sourceRefId`, issues, {pattern: ID_PATTERN}) && !sourceIds.has(evaluation.sourceRefId)) {
        issue(issues, `${path}.sourceRefId`, "does not reference a declared sourceRef", "source-ref");
      }
      break;
    case "ability.minimum":
      requiredString(evaluation.abilityId, `${path}.abilityId`, issues, {pattern: ID_PATTERN});
      integer(evaluation.value, `${path}.value`, issues);
      break;
    case "allOf":
    case "anyOf":
      if (!Array.isArray(evaluation.evaluationIds) || !evaluation.evaluationIds.length) issue(issues, `${path}.evaluationIds`, "must be a non-empty array", "evaluation-ids");
      else evaluation.evaluationIds.forEach((id, index) => requiredString(id, `${path}.evaluationIds[${index}]`, issues, {pattern: ID_PATTERN}));
      break;
    case "not":
      if (!Array.isArray(evaluation.evaluationIds) || evaluation.evaluationIds.length !== 1) issue(issues, `${path}.evaluationIds`, "must contain exactly one evaluation id", "evaluation-ids");
      else requiredString(evaluation.evaluationIds[0], `${path}.evaluationIds[0]`, issues, {pattern: ID_PATTERN});
      break;
  }
}

function validateEvaluationGraph(evaluations, path, issues) {
  const nodes = new Map();
  evaluations.forEach((evaluation, index) => {
    if (typeof evaluation?.id === "string" && !nodes.has(evaluation.id)) nodes.set(evaluation.id, {evaluation, index});
  });

  for (const [index, evaluation] of evaluations.entries()) {
    const references = Array.isArray(evaluation?.evaluationIds) ? evaluation.evaluationIds : [];
    const seen = new Set();
    references.forEach((referenceId, referenceIndex) => {
      const referencePath = `${path}[${index}].evaluationIds[${referenceIndex}]`;
      if (typeof referenceId === "string" && !nodes.has(referenceId)) {
        issue(issues, referencePath, `does not reference a local evaluation "${referenceId}"`, "evaluation-ref");
      }
      if (seen.has(referenceId)) issue(issues, referencePath, `duplicates "${referenceId}"`, "duplicate-evaluation-ref");
      seen.add(referenceId);
    });
  }

  const state = new Map();
  const visit = id => {
    state.set(id, 1);
    const {evaluation, index} = nodes.get(id);
    const references = Array.isArray(evaluation?.evaluationIds) ? evaluation.evaluationIds : [];
    references.forEach((referenceId, referenceIndex) => {
      if (!nodes.has(referenceId)) return;
      if (state.get(referenceId) === 1) {
        issue(
          issues,
          `${path}[${index}].evaluationIds[${referenceIndex}]`,
          `creates a cycle from "${id}" to "${referenceId}"`,
          "evaluation-cycle",
        );
      } else if (state.get(referenceId) !== 2) visit(referenceId);
    });
    state.set(id, 2);
  };
  for (const id of nodes.keys()) {
    if (!state.has(id)) visit(id);
  }
}

function validateEffect(effect, path, issues, sourceIds, rank, inputIds = new Set(), trackBinding = null) {
  if (!isPlainObject(effect)) {
    issue(issues, path, "must be an effect object", "effect");
    return;
  }
  const type = effect.type;
  if (!EFFECT_TYPES.has(type)) {
    issue(issues, `${path}.type`, "is not a supported semantic effect", "effect-type");
    return;
  }
  const common = ["id", "type"];
  const fields = {
    "identity.set": ["field", "value"],
    "resource.initialize": ["resource", "amount"],
    "resource.gain": ["resource", "amount"],
    "classBonus.gain": ["bonus", "amount"],
    "ability.allocate": ["amount", "eligibleAbilityIds"],
    "ability.setPrimary": ["abilityId"],
    "weaponGroup.add": ["weaponGroupId"],
    "item.acquire": ["sourceRefId", "quantity"],
    "item.advance": ["trait", "sourceRefId"],
    "track.setRank": ["trackId", "rank"],
    "summary.add": ["entryId", "label"]
  }[type];
  exactKeys(effect, [...common, ...fields], path, issues);
  requiredString(effect.id, `${path}.id`, issues, {pattern: ID_PATTERN});
  switch (type) {
    case "identity.set":
      if (!IDENTITY_FIELDS.has(effect.field)) issue(issues, `${path}.field`, "is not an allowed identity field", "identity-field");
      if (isPlainObject(effect.value)) {
        exactKeys(effect.value, ["kind", "inputId"], `${path}.value`, issues);
        if (effect.value.kind !== "input") issue(issues, `${path}.value.kind`, "must be the semantic input reference kind", "identity-input-kind");
        const validInputId = requiredString(effect.value.inputId, `${path}.value.inputId`, issues, {pattern: ID_PATTERN});
        if (validInputId && !inputIds.has(effect.value.inputId)) issue(issues, `${path}.value.inputId`, "does not reference a declared milestone input", "identity-input-ref");
      } else if (typeof effect.value !== "string" && typeof effect.value !== "number") {
        issue(issues, `${path}.value`, "must be a primitive value or semantic input reference", "identity-value");
      }
      break;
    case "resource.initialize":
      if (!INITIALIZABLE_RESOURCE_IDS.has(effect.resource)) issue(issues, `${path}.resource`, "must be health, powerPoints, or conviction", "resource-initialize-resource");
      validateAmount(effect.amount, `${path}.amount`, issues);
      if (typeof effect.amount === "number" && effect.amount < 0) issue(issues, `${path}.amount`, "must not be negative", "resource-initialize-amount");
      break;
    case "resource.gain":
      if (!RESOURCE_IDS.has(effect.resource)) issue(issues, `${path}.resource`, "is not an allowed resource", "resource");
      validateAmount(effect.amount, `${path}.amount`, issues);
      break;
    case "classBonus.gain":
      if (!CLASS_BONUS_IDS.has(effect.bonus)) issue(issues, `${path}.bonus`, "is not an allowed class bonus", "class-bonus");
      validateAmount(effect.amount, `${path}.amount`, issues);
      break;
    case "ability.allocate":
      integer(effect.amount, `${path}.amount`, issues, {minimum: 1});
      if (effect.eligibleAbilityIds !== undefined) {
        if (!Array.isArray(effect.eligibleAbilityIds) || !effect.eligibleAbilityIds.length) issue(issues, `${path}.eligibleAbilityIds`, "must be a non-empty array when supplied", "ability-ids");
        else effect.eligibleAbilityIds.forEach((id, index) => requiredString(id, `${path}.eligibleAbilityIds[${index}]`, issues, {pattern: ID_PATTERN}));
      }
      break;
    case "ability.setPrimary":
      requiredString(effect.abilityId, `${path}.abilityId`, issues, {pattern: ID_PATTERN});
      break;
    case "weaponGroup.add":
      requiredString(effect.weaponGroupId, `${path}.weaponGroupId`, issues, {pattern: ID_PATTERN});
      break;
    case "item.acquire":
      requiredString(effect.sourceRefId, `${path}.sourceRefId`, issues, {pattern: ID_PATTERN});
      if (!sourceIds.has(effect.sourceRefId)) issue(issues, `${path}.sourceRefId`, "does not reference a declared sourceRef", "source-ref");
      if (effect.quantity !== undefined) integer(effect.quantity, `${path}.quantity`, issues, {minimum: 1});
      break;
    case "item.advance":
      requiredString(effect.trait, `${path}.trait`, issues, {pattern: ID_PATTERN});
      if (effect.sourceRefId !== undefined) {
        requiredString(effect.sourceRefId, `${path}.sourceRefId`, issues, {pattern: ID_PATTERN});
        if (!sourceIds.has(effect.sourceRefId)) issue(issues, `${path}.sourceRefId`, "does not reference a declared sourceRef", "source-ref");
      }
      break;
    case "track.setRank":
      requiredString(effect.trackId, `${path}.trackId`, issues, {pattern: ID_PATTERN});
      integer(effect.rank, `${path}.rank`, issues, {minimum: rank.minimum, maximum: rank.maximum});
      if (trackBinding?.trackId && effect.trackId !== trackBinding.trackId) {
        issue(issues, `${path}.trackId`, `must match trackBinding.trackId "${trackBinding.trackId}"`, "track-binding");
      }
      break;
    case "summary.add":
      requiredString(effect.entryId, `${path}.entryId`, issues, {pattern: ID_PATTERN});
      if (effect.label !== undefined) requiredString(effect.label, `${path}.label`, issues);
      break;
  }
}

function validateChoiceGroup(group, path, issues, choiceOptions, sourceIds, rank, inputIds, trackBinding) {
  exactKeys(group, ["id", "label", "minimum", "maximum", "distinct", "options"], path, issues);
  requiredString(group?.id, `${path}.id`, issues, {pattern: ID_PATTERN});
  if (group?.label !== undefined) requiredString(group.label, `${path}.label`, issues);
  integer(group?.minimum, `${path}.minimum`, issues, {minimum: 0});
  integer(group?.maximum, `${path}.maximum`, issues, {minimum: 0});
  if (Number.isInteger(group?.minimum) && Number.isInteger(group?.maximum) && group.minimum > group.maximum) issue(issues, path, "minimum cannot exceed maximum", "choice-range");
  if (typeof group?.distinct !== "boolean") issue(issues, `${path}.distinct`, "must be boolean", "boolean");
  if (!Array.isArray(group?.options) || !group.options.length) {
    issue(issues, `${path}.options`, "must be a non-empty array", "options");
    return;
  }
  if (Number.isInteger(group.maximum) && group.maximum > group.options.length && group.distinct) issue(issues, `${path}.maximum`, "cannot exceed options for a distinct choice", "choice-range");
  uniqueIds(group.options, `${path}.options`, issues);
  for (const [index, option] of group.options.entries()) {
    const optionPath = `${path}.options[${index}]`;
    exactKeys(option, ["id", "label", "sourceRefIds", "evaluations", "effects"], optionPath, issues);
    requiredString(option?.id, `${optionPath}.id`, issues, {pattern: ID_PATTERN});
    if (option?.label !== undefined) requiredString(option.label, `${optionPath}.label`, issues);
    validateSourceIds(option?.sourceRefIds ?? [], sourceIds, `${optionPath}.sourceRefIds`, issues);
    if (!Array.isArray(option?.evaluations) || !Array.isArray(option?.effects)) issue(issues, optionPath, "must include evaluations and effects arrays", "choice-option");
    else {
      uniqueIds(option.evaluations, `${optionPath}.evaluations`, issues);
      option.evaluations.forEach((evaluation, evaluationIndex) => validateEvaluation(evaluation, `${optionPath}.evaluations[${evaluationIndex}]`, issues, choiceOptions, sourceIds, rank));
      validateEvaluationGraph(option.evaluations, `${optionPath}.evaluations`, issues);
      uniqueIds(option.effects, `${optionPath}.effects`, issues);
      option.effects.forEach((effect, effectIndex) => validateEffect(effect, `${optionPath}.effects[${effectIndex}]`, issues, sourceIds, rank, inputIds, trackBinding));
    }
  }
}

function validateAmountV2(value, path, issues) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issue(issues, path, "must be a finite number", "amount-number");
    return Number.isFinite(value);
  }
  exactKeysV2(value, ["kind", "formula", "rollId", "minimum", "maximum"], path, issues);
  const amount = isPlainObject(value) ? value : {};
  if (amount.kind !== "formula") issue(issues, `${path}.kind`, "must be the formula expression kind", "amount-kind");
  if (!requiredString(amount.formula, `${path}.formula`, issues)) return false;
  if (amount.rollId !== undefined) requiredString(amount.rollId, `${path}.rollId`, issues, {pattern: ID_PATTERN});
  if (amount.minimum !== undefined && (typeof amount.minimum !== "number" || !Number.isFinite(amount.minimum))) {
    issue(issues, `${path}.minimum`, "must be a finite number", "amount-clamp");
  }
  if (amount.maximum !== undefined && (typeof amount.maximum !== "number" || !Number.isFinite(amount.maximum))) {
    issue(issues, `${path}.maximum`, "must be a finite number", "amount-clamp");
  }
  if (Number.isFinite(amount.minimum) && Number.isFinite(amount.maximum) && amount.minimum > amount.maximum) {
    issue(issues, path, "minimum clamp cannot exceed maximum clamp", "amount-clamp-range");
  }
  if (/\b(?:table|rolltable|random|draw)\b/i.test(amount.formula)) {
    issue(issues, `${path}.formula`, "must not use RollTables or random selection strategies", "forbidden-random");
  }
  return true;
}

function validateSemanticInputV2(input, path, issues) {
  const type = input?.type;
  const common = ["id", "label", "type", "required"];
  const fields = {
    text: ["default", "minLength", "maxLength"],
    longText: ["default", "minLength", "maxLength"],
    integer: ["default", "minimum", "maximum"],
    select: ["default", "options"],
  }[type] ?? [];
  if (!exactKeysV2(input, [...common, ...fields], path, issues)) return;
  requiredString(input?.id, `${path}.id`, issues, {pattern: ID_PATTERN});
  if (input?.label !== undefined) requiredString(input.label, `${path}.label`, issues);
  if (!INPUT_TYPES_V2.has(type)) issue(issues, `${path}.type`, "must be a supported DefinitionV2 semantic input type", "input-type");
  if (typeof input?.required !== "boolean") issue(issues, `${path}.required`, "must be boolean", "boolean");

  if (type === "text" || type === "longText") {
    const lengthLimit = type === "longText" ? MAX_LONG_TEXT_INPUT_LENGTH : MAX_TEXT_INPUT_LENGTH;
    if (input.default !== undefined && typeof input.default !== "string") issue(issues, `${path}.default`, "must be a string", "input-default");
    if (input.minLength !== undefined) integer(input.minLength, `${path}.minLength`, issues, {minimum: 0, maximum: lengthLimit});
    if (input.maxLength !== undefined) integer(input.maxLength, `${path}.maxLength`, issues, {minimum: 1, maximum: lengthLimit});
    if (Number.isInteger(input.minLength) && Number.isInteger(input.maxLength) && input.minLength > input.maxLength) {
      issue(issues, path, "minLength cannot exceed maxLength", "input-length");
    }
    if (typeof input.default === "string") {
      const forbiddenControls = type === "longText"
        ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
        : /[\u0000-\u001f\u007f]/;
      if (forbiddenControls.test(input.default)) issue(issues, `${path}.default`, "must not contain unsupported control characters", "input-control");
      if (Number.isInteger(input.minLength) && input.default.trim().length < input.minLength) issue(issues, `${path}.default`, "is shorter than minLength", "input-length");
      if (Number.isInteger(input.maxLength) && input.default.trim().length > input.maxLength) issue(issues, `${path}.default`, "is longer than maxLength", "input-length");
    }
  } else if (type === "integer") {
    if (input.default !== undefined) integer(input.default, `${path}.default`, issues);
    if (input.minimum !== undefined) integer(input.minimum, `${path}.minimum`, issues);
    if (input.maximum !== undefined) integer(input.maximum, `${path}.maximum`, issues);
    if (Number.isInteger(input.minimum) && Number.isInteger(input.maximum) && input.minimum > input.maximum) {
      issue(issues, path, "minimum cannot exceed maximum", "input-range");
    }
    if (Number.isInteger(input.default) && Number.isInteger(input.minimum) && input.default < input.minimum) {
      issue(issues, `${path}.default`, "must be at least minimum", "input-range");
    }
    if (Number.isInteger(input.default) && Number.isInteger(input.maximum) && input.default > input.maximum) {
      issue(issues, `${path}.default`, "must be at most maximum", "input-range");
    }
  } else if (type === "select") {
    if (input.default !== undefined && typeof input.default !== "string") issue(issues, `${path}.default`, "must be a string", "input-default");
    if (!Array.isArray(input.options) || !input.options.length) {
      issue(issues, `${path}.options`, "must be a non-empty array", "input-options");
    } else {
      const values = new Set();
      input.options.forEach((option, index) => {
        const optionPath = `${path}.options[${index}]`;
        exactKeysV2(option, ["value", "label"], optionPath, issues);
        const validValue = requiredString(option?.value, `${optionPath}.value`, issues);
        requiredString(option?.label, `${optionPath}.label`, issues);
        if (validValue && values.has(option.value)) issue(issues, `${optionPath}.value`, `duplicates "${option.value}"`, "duplicate-input-option");
        if (validValue) values.add(option.value);
      });
      if (typeof input.default === "string" && !values.has(input.default)) issue(issues, `${path}.default`, "must name a declared select option", "input-default-option");
    }
  }
}

function validateInputReferenceV2(value, path, issues, inputTypes, {allowedTypes = null, codePrefix = "input"} = {}) {
  exactKeysV2(value, ["kind", "inputId"], path, issues);
  if (value?.kind !== "input") issue(issues, `${path}.kind`, "must be the semantic input reference kind", `${codePrefix}-input-kind`);
  const validInputId = requiredString(value?.inputId, `${path}.inputId`, issues, {pattern: ID_PATTERN});
  if (!validInputId) return;
  if (!inputTypes.has(value.inputId)) {
    issue(issues, `${path}.inputId`, "does not reference a declared milestone input", `${codePrefix}-input-ref`);
  } else if (allowedTypes && !allowedTypes.has(inputTypes.get(value.inputId))) {
    issue(issues, `${path}.inputId`, `must reference a ${[...allowedTypes].join(" or ")} input`, `${codePrefix}-input-type`);
  }
}

function validateEffectV2(effect, path, issues, sourceIds, rank, inputTypes = new Map(), trackBinding = null) {
  if (!isPlainObject(effect)) {
    issue(issues, path, "must be an effect object", "effect");
    return;
  }
  const type = effect.type;
  if (!EFFECT_TYPES_V2.has(type)) {
    issue(issues, `${path}.type`, "is not a supported DefinitionV2 semantic effect", "effect-type");
    return;
  }
  const common = ["id", "type"];
  const fields = {
    "identity.set": ["field", "value"],
    "resource.initialize": ["resource", "amount"],
    "resource.gain": ["resource", "amount"],
    "classBonus.gain": ["bonus", "amount"],
    "ability.allocate": ["amount", "eligibleAbilityIds", "minimumPerAbility", "maximumPerAbility"],
    "ability.set": ["abilityId", "value"],
    "ability.setPrimary": ["abilityId"],
    "language.add": ["value"],
    "weaponGroup.add": ["weaponGroupId"],
    "item.acquire": ["sourceRefId", "quantity"],
    "item.advance": ["trait", "sourceRefId"],
    "track.setRank": ["trackId", "rank"],
    "summary.add": ["entryId", "label"],
  }[type];
  exactKeysV2(effect, [...common, ...fields], path, issues);
  requiredString(effect.id, `${path}.id`, issues, {pattern: ID_PATTERN});
  switch (type) {
    case "identity.set":
      if (!IDENTITY_FIELDS_V2.has(effect.field)) issue(issues, `${path}.field`, "is not an allowed DefinitionV2 identity field", "identity-field");
      if (isPlainObject(effect.value)) validateInputReferenceV2(effect.value, `${path}.value`, issues, inputTypes, {codePrefix: "identity"});
      else if (typeof effect.value !== "string" && typeof effect.value !== "number") issue(issues, `${path}.value`, "must be a primitive value or semantic input reference", "identity-value");
      else if (typeof effect.value === "number" && !Number.isFinite(effect.value)) issue(issues, `${path}.value`, "must be a finite number", "identity-value");
      break;
    case "resource.initialize":
      if (!INITIALIZABLE_RESOURCE_IDS_V2.has(effect.resource)) issue(issues, `${path}.resource`, "must be health, powerPoints, conviction, currency, or resources", "resource-initialize-resource");
      validateAmountV2(effect.amount, `${path}.amount`, issues);
      if (typeof effect.amount === "number" && effect.amount < 0) issue(issues, `${path}.amount`, "must not be negative", "resource-initialize-amount");
      break;
    case "resource.gain":
      if (!RESOURCE_IDS_V2.has(effect.resource)) issue(issues, `${path}.resource`, "is not an allowed resource", "resource");
      validateAmountV2(effect.amount, `${path}.amount`, issues);
      break;
    case "classBonus.gain":
      if (!CLASS_BONUS_IDS.has(effect.bonus)) issue(issues, `${path}.bonus`, "is not an allowed class bonus", "class-bonus");
      validateAmountV2(effect.amount, `${path}.amount`, issues);
      break;
    case "ability.allocate":
      integer(effect.amount, `${path}.amount`, issues, {minimum: 1});
      if (effect.eligibleAbilityIds !== undefined) {
        if (!Array.isArray(effect.eligibleAbilityIds) || !effect.eligibleAbilityIds.length) issue(issues, `${path}.eligibleAbilityIds`, "must be a non-empty array when supplied", "ability-ids");
        else effect.eligibleAbilityIds.forEach((id, index) => requiredString(id, `${path}.eligibleAbilityIds[${index}]`, issues, {pattern: ID_PATTERN}));
      }
      if (effect.minimumPerAbility !== undefined) integer(effect.minimumPerAbility, `${path}.minimumPerAbility`, issues, {minimum: 0});
      if (effect.maximumPerAbility !== undefined) integer(effect.maximumPerAbility, `${path}.maximumPerAbility`, issues, {minimum: 0});
      if (Number.isInteger(effect.minimumPerAbility) && Number.isInteger(effect.maximumPerAbility)
        && effect.minimumPerAbility > effect.maximumPerAbility) {
        issue(issues, path, "minimumPerAbility cannot exceed maximumPerAbility", "ability-allocation-range");
      }
      break;
    case "ability.set":
      requiredString(effect.abilityId, `${path}.abilityId`, issues, {pattern: ID_PATTERN});
      if (isPlainObject(effect.value)) {
        validateInputReferenceV2(effect.value, `${path}.value`, issues, inputTypes, {allowedTypes: new Set(["integer"]), codePrefix: "ability"});
      } else if (typeof effect.value !== "number" || !Number.isFinite(effect.value)) {
        issue(issues, `${path}.value`, "must be a finite number or integer input reference", "ability-value");
      }
      break;
    case "ability.setPrimary":
      requiredString(effect.abilityId, `${path}.abilityId`, issues, {pattern: ID_PATTERN});
      break;
    case "language.add":
      if (isPlainObject(effect.value)) {
        validateInputReferenceV2(effect.value, `${path}.value`, issues, inputTypes, {allowedTypes: new Set(["text", "longText", "select"]), codePrefix: "language"});
      } else requiredString(effect.value, `${path}.value`, issues);
      break;
    case "weaponGroup.add":
      requiredString(effect.weaponGroupId, `${path}.weaponGroupId`, issues, {pattern: ID_PATTERN});
      break;
    case "item.acquire":
      requiredString(effect.sourceRefId, `${path}.sourceRefId`, issues, {pattern: ID_PATTERN});
      if (!sourceIds.has(effect.sourceRefId)) issue(issues, `${path}.sourceRefId`, "does not reference a declared sourceRef", "source-ref");
      if (effect.quantity !== undefined) integer(effect.quantity, `${path}.quantity`, issues, {minimum: 1});
      break;
    case "item.advance":
      requiredString(effect.trait, `${path}.trait`, issues, {pattern: ID_PATTERN});
      if (effect.sourceRefId !== undefined) {
        requiredString(effect.sourceRefId, `${path}.sourceRefId`, issues, {pattern: ID_PATTERN});
        if (!sourceIds.has(effect.sourceRefId)) issue(issues, `${path}.sourceRefId`, "does not reference a declared sourceRef", "source-ref");
      }
      break;
    case "track.setRank":
      requiredString(effect.trackId, `${path}.trackId`, issues, {pattern: ID_PATTERN});
      integer(effect.rank, `${path}.rank`, issues, {minimum: rank.minimum, maximum: rank.maximum});
      if (trackBinding?.trackId && effect.trackId !== trackBinding.trackId) issue(issues, `${path}.trackId`, `must match trackBinding.trackId "${trackBinding.trackId}"`, "track-binding");
      break;
    case "summary.add":
      requiredString(effect.entryId, `${path}.entryId`, issues, {pattern: ID_PATTERN});
      if (effect.label !== undefined) requiredString(effect.label, `${path}.label`, issues);
      break;
  }
}

function validateChoiceGroupV2(group, path, issues, choiceOptions, sourceIds, rank, inputTypes, trackBinding) {
  if (!exactKeysV2(group, ["id", "label", "minimum", "maximum", "distinct", "options", "evaluations", "stageId"], path, issues)) return;
  requiredString(group?.id, `${path}.id`, issues, {pattern: ID_PATTERN});
  if (group?.label !== undefined) requiredString(group.label, `${path}.label`, issues);
  integer(group?.minimum, `${path}.minimum`, issues, {minimum: 0});
  integer(group?.maximum, `${path}.maximum`, issues, {minimum: 0});
  if (Number.isInteger(group?.minimum) && Number.isInteger(group?.maximum) && group.minimum > group.maximum) issue(issues, path, "minimum cannot exceed maximum", "choice-range");
  if (typeof group?.distinct !== "boolean") issue(issues, `${path}.distinct`, "must be boolean", "boolean");
  if (group?.stageId !== undefined) requiredString(group.stageId, `${path}.stageId`, issues, {pattern: ID_PATTERN});
  if (group?.evaluations !== undefined && !Array.isArray(group.evaluations)) issue(issues, `${path}.evaluations`, "must be an array", "evaluations");
  const groupEvaluations = Array.isArray(group?.evaluations) ? group.evaluations : [];
  uniqueIds(groupEvaluations, `${path}.evaluations`, issues);
  groupEvaluations.forEach((evaluation, index) => validateEvaluation(evaluation, `${path}.evaluations[${index}]`, issues, choiceOptions, sourceIds, rank));
  validateEvaluationGraph(groupEvaluations, `${path}.evaluations`, issues);
  if (!Array.isArray(group?.options) || !group.options.length) {
    issue(issues, `${path}.options`, "must be a non-empty array", "options");
    return;
  }
  if (Number.isInteger(group.maximum) && group.maximum > group.options.length && group.distinct) issue(issues, `${path}.maximum`, "cannot exceed options for a distinct choice", "choice-range");
  uniqueIds(group.options, `${path}.options`, issues);
  for (const [index, option] of group.options.entries()) {
    const optionPath = `${path}.options[${index}]`;
    exactKeysV2(option, ["id", "label", "sourceRefIds", "evaluations", "effects"], optionPath, issues);
    requiredString(option?.id, `${optionPath}.id`, issues, {pattern: ID_PATTERN});
    if (option?.label !== undefined) requiredString(option.label, `${optionPath}.label`, issues);
    validateSourceIds(option?.sourceRefIds ?? [], sourceIds, `${optionPath}.sourceRefIds`, issues);
    if (!Array.isArray(option?.evaluations) || !Array.isArray(option?.effects)) issue(issues, optionPath, "must include evaluations and effects arrays", "choice-option");
    else {
      uniqueIds(option.evaluations, `${optionPath}.evaluations`, issues);
      option.evaluations.forEach((evaluation, evaluationIndex) => validateEvaluation(evaluation, `${optionPath}.evaluations[${evaluationIndex}]`, issues, choiceOptions, sourceIds, rank));
      validateEvaluationGraph(option.evaluations, `${optionPath}.evaluations`, issues);
      uniqueIds(option.effects, `${optionPath}.effects`, issues);
      option.effects.forEach((effect, effectIndex) => validateEffectV2(effect, `${optionPath}.effects[${effectIndex}]`, issues, sourceIds, rank, inputTypes, trackBinding));
    }
  }
}

function validateMilestoneStagesV2(stages, path, issues, inputIds, choiceGroupIds, choiceGroups) {
  if (stages === undefined) {
    choiceGroups.forEach((group, groupIndex) => {
      if (group?.stageId !== undefined) issue(issues, `${path.replace(/\.stages$/, ".choiceGroups")}[${groupIndex}].stageId`, "does not reference a declared local stage", "stage-ref");
    });
    return;
  }
  if (!Array.isArray(stages)) {
    issue(issues, path, "must be an array", "stages");
    return;
  }
  const stageIds = uniqueIds(stages, path, issues);
  const inputAssignments = new Map();
  const groupAssignments = new Map();
  stages.forEach((stage, stageIndex) => {
    const stagePath = `${path}[${stageIndex}]`;
    if (!exactKeysV2(stage, ["id", "label", "description", "inputIds", "choiceGroupIds"], stagePath, issues)) return;
    requiredString(stage?.id, `${stagePath}.id`, issues, {pattern: ID_PATTERN});
    requiredString(stage?.label, `${stagePath}.label`, issues);
    if (stage?.description !== undefined) requiredString(stage.description, `${stagePath}.description`, issues);
    for (const [field, knownIds, assignments, referenceCode, duplicateCode] of [
      ["inputIds", inputIds, inputAssignments, "stage-input-ref", "duplicate-stage-input"],
      ["choiceGroupIds", choiceGroupIds, groupAssignments, "stage-choice-group-ref", "duplicate-stage-choice-group"],
    ]) {
      if (!Array.isArray(stage?.[field])) {
        issue(issues, `${stagePath}.${field}`, "must be an array", "array");
        continue;
      }
      stage[field].forEach((id, referenceIndex) => {
        const referencePath = `${stagePath}.${field}[${referenceIndex}]`;
        const validId = requiredString(id, referencePath, issues, {pattern: ID_PATTERN});
        if (validId && !knownIds.has(id)) issue(issues, referencePath, "does not reference a local milestone entry", referenceCode);
        if (assignments.has(id)) issue(issues, referencePath, `is already assigned to stage "${assignments.get(id)}"`, duplicateCode);
        else assignments.set(id, stage?.id);
      });
    }
  });
  choiceGroups.forEach((group, groupIndex) => {
    if (group?.stageId === undefined) return;
    const groupPath = `${path.replace(/\.stages$/, ".choiceGroups")}[${groupIndex}].stageId`;
    if (!stageIds.has(group.stageId)) {
      issue(issues, groupPath, "does not reference a declared local stage", "stage-ref");
      return;
    }
    const assignedStage = groupAssignments.get(group.id);
    if (assignedStage !== undefined && assignedStage !== group.stageId) {
      issue(issues, groupPath, `conflicts with stage "${assignedStage}"`, "stage-assignment-conflict");
    }
  });
}

/** Validate a strict, plain-JSON AGE Progression DefinitionV1. */
export function validateProgressionDefinitionV1(definition) {
  const issues = [];
  assertPlainJson(definition, "$", issues);
  exactKeys(definition, ["schemaVersion", "id", "version", "profileId", "capabilities", "sourceRefs", "rank", "trackBinding", "milestones", "rulesContentCoverage"], "$", issues);
  if (definition?.schemaVersion !== AGE_PROGRESSION_DEFINITION_VERSION) issue(issues, "$.schemaVersion", `must be ${AGE_PROGRESSION_DEFINITION_VERSION}`, "schema-version");
  requiredString(definition?.id, "$.id", issues, {pattern: ID_PATTERN});
  if (!SEMVER_PATTERN.test(definition?.version ?? "")) issue(issues, "$.version", "must be a semantic version", "version");
  requiredString(definition?.profileId, "$.profileId", issues, {pattern: ID_PATTERN});
  if (definition?.rulesContentCoverage !== undefined && !CONTENT_COVERAGE.has(definition.rulesContentCoverage)) {
    issue(issues, "$.rulesContentCoverage", "must be synthetic, partial, or complete", "content-coverage");
  }
  if (!Array.isArray(definition?.capabilities) || !definition.capabilities.length) issue(issues, "$.capabilities", "must be a non-empty array", "capabilities");
  else {
    const seen = new Set();
    definition.capabilities.forEach((capability, index) => {
      requiredString(capability, `$.capabilities[${index}]`, issues, {pattern: ID_PATTERN});
      if (seen.has(capability)) issue(issues, `$.capabilities[${index}]`, `duplicates "${capability}"`, "duplicate-capability");
      seen.add(capability);
    });
  }
  if (!Array.isArray(definition?.sourceRefs)) issue(issues, "$.sourceRefs", "must be an array", "source-refs");
  else definition.sourceRefs.forEach((ref, index) => validateSourceRef(ref, `$.sourceRefs[${index}]`, issues));
  const sourceIds = Array.isArray(definition?.sourceRefs) ? uniqueIds(definition.sourceRefs, "$.sourceRefs", issues) : new Set();

  exactKeys(definition?.rank, ["kind", "minimum", "maximum"], "$.rank", issues);
  if (definition?.rank?.kind !== "level") issue(issues, "$.rank.kind", "currently supports the explicit level rank model only", "rank-kind");
  integer(definition?.rank?.minimum, "$.rank.minimum", issues, {minimum: 0});
  integer(definition?.rank?.maximum, "$.rank.maximum", issues, {minimum: 1});
  if (Number.isInteger(definition?.rank?.minimum) && Number.isInteger(definition?.rank?.maximum) && definition.rank.minimum >= definition.rank.maximum) issue(issues, "$.rank", "minimum must be less than maximum", "rank-range");
  const rank = {minimum: Number.isInteger(definition?.rank?.minimum) ? definition.rank.minimum : 0, maximum: Number.isInteger(definition?.rank?.maximum) ? definition.rank.maximum : Number.MAX_SAFE_INTEGER};

  const hasAdvancementMilestone = Array.isArray(definition?.milestones)
    && definition.milestones.some(milestone => Array.isArray(milestone?.triggers) && milestone.triggers.includes("rank.advance"));
  if (definition?.trackBinding !== undefined) validateTrackBinding(definition.trackBinding, "$.trackBinding", issues);
  else if (hasAdvancementMilestone) issue(issues, "$.trackBinding", "is required for rank.advance definitions", "track-binding-required");

  if (!Array.isArray(definition?.milestones) || !definition.milestones.length) issue(issues, "$.milestones", "must be a non-empty array", "milestones");
  else {
    uniqueIds(definition.milestones, "$.milestones", issues);
    const milestoneRanks = new Set();
    for (const [index, milestone] of definition.milestones.entries()) {
      const path = `$.milestones[${index}]`;
      exactKeys(milestone, ["id", "rank", "triggers", "sourceRefIds", "inputs", "choiceGroups", "evaluations", "effects"], path, issues);
      requiredString(milestone?.id, `${path}.id`, issues, {pattern: ID_PATTERN});
      integer(milestone?.rank, `${path}.rank`, issues, {minimum: rank.minimum, maximum: rank.maximum});
      if (milestoneRanks.has(milestone?.rank)) issue(issues, `${path}.rank`, `duplicates rank ${milestone.rank}; use one combined milestone per rank`, "duplicate-rank");
      milestoneRanks.add(milestone?.rank);
      if (!Array.isArray(milestone?.triggers) || !milestone.triggers.length) issue(issues, `${path}.triggers`, "must be a non-empty array", "triggers");
      else {
        const seen = new Set();
        milestone.triggers.forEach((trigger, triggerIndex) => {
          if (!TRIGGERS.has(trigger)) issue(issues, `${path}.triggers[${triggerIndex}]`, "is not a supported trigger", "trigger");
          if (seen.has(trigger)) issue(issues, `${path}.triggers[${triggerIndex}]`, `duplicates "${trigger}"`, "duplicate-trigger");
          seen.add(trigger);
        });
      }
      validateSourceIds(milestone?.sourceRefIds ?? [], sourceIds, `${path}.sourceRefIds`, issues);
      if (milestone?.inputs !== undefined && !Array.isArray(milestone.inputs)) issue(issues, `${path}.inputs`, "must be an array", "inputs");
      const inputs = Array.isArray(milestone?.inputs) ? milestone.inputs : [];
      if (inputs.length && (!milestone?.triggers?.includes("character.create") || milestone.triggers.some(trigger => trigger !== "character.create"))) {
        issue(issues, `${path}.inputs`, "may only be declared on a character.create-only milestone", "input-trigger");
      }
      const inputIds = uniqueIds(inputs, `${path}.inputs`, issues);
      inputs.forEach((input, inputIndex) => validateSemanticInput(input, `${path}.inputs[${inputIndex}]`, issues));
      if (!Array.isArray(milestone?.choiceGroups) || !Array.isArray(milestone?.evaluations) || !Array.isArray(milestone?.effects)) {
        issue(issues, path, "must include choiceGroups, evaluations, and effects arrays", "milestone-arrays");
        continue;
      }
      uniqueIds(milestone.choiceGroups, `${path}.choiceGroups`, issues);
      const choiceOptions = new Map();
      milestone.choiceGroups.forEach(group => {
        if (typeof group?.id !== "string" || choiceOptions.has(group.id)) return;
        choiceOptions.set(group.id, new Set(
          (Array.isArray(group?.options) ? group.options : [])
            .map(option => option?.id)
            .filter(id => typeof id === "string"),
        ));
      });
      milestone.choiceGroups.forEach((group, groupIndex) => validateChoiceGroup(group, `${path}.choiceGroups[${groupIndex}]`, issues, choiceOptions, sourceIds, rank, inputIds, definition.trackBinding));
      uniqueIds(milestone.evaluations, `${path}.evaluations`, issues);
      milestone.evaluations.forEach((evaluation, evaluationIndex) => validateEvaluation(evaluation, `${path}.evaluations[${evaluationIndex}]`, issues, choiceOptions, sourceIds, rank));
      validateEvaluationGraph(milestone.evaluations, `${path}.evaluations`, issues);
      uniqueIds(milestone.effects, `${path}.effects`, issues);
      milestone.effects.forEach((effect, effectIndex) => validateEffect(effect, `${path}.effects[${effectIndex}]`, issues, sourceIds, rank, inputIds, definition.trackBinding));
      const initializationLocations = [
        ...milestone.effects.map((effect, effectIndex) => ({effect, path: `${path}.effects[${effectIndex}]`})),
        ...milestone.choiceGroups.flatMap((group, groupIndex) => (Array.isArray(group?.options) ? group.options : []).flatMap((option, optionIndex) => (
          (Array.isArray(option?.effects) ? option.effects : []).map((effect, effectIndex) => ({
            effect,
            path: `${path}.choiceGroups[${groupIndex}].options[${optionIndex}].effects[${effectIndex}]`,
          }))
        ))),
      ].filter(entry => entry.effect?.type === "resource.initialize");
      if (initializationLocations.length
        && (!milestone.triggers.includes("character.create") || milestone.triggers.some(trigger => trigger !== "character.create"))) {
        initializationLocations.forEach(entry => issue(
          issues,
          `${entry.path}.type`,
          "may only be used on a character.create-only milestone",
          "resource-initialize-trigger",
        ));
      }
    }
  }
  return Object.freeze({valid: issues.length === 0, issues: Object.freeze(issues)});
}

/** Validate a strict, plain-JSON AGE Progression DefinitionV2. */
export function validateProgressionDefinitionV2(definition) {
  const issues = [];
  assertPlainJson(definition, "$", issues);
  exactKeysV2(definition, ["schemaVersion", "id", "version", "profileId", "capabilities", "sourceRefs", "rank", "trackBinding", "milestones", "rulesContentCoverage"], "$", issues);
  if (definition?.schemaVersion !== AGE_PROGRESSION_DEFINITION_V2_VERSION) issue(issues, "$.schemaVersion", `must be ${AGE_PROGRESSION_DEFINITION_V2_VERSION}`, "schema-version");
  requiredString(definition?.id, "$.id", issues, {pattern: ID_PATTERN});
  if (!SEMVER_PATTERN.test(definition?.version ?? "")) issue(issues, "$.version", "must be a semantic version", "version");
  requiredString(definition?.profileId, "$.profileId", issues, {pattern: ID_PATTERN});
  if (definition?.rulesContentCoverage !== undefined && !CONTENT_COVERAGE.has(definition.rulesContentCoverage)) {
    issue(issues, "$.rulesContentCoverage", "must be synthetic, partial, or complete", "content-coverage");
  }
  if (!Array.isArray(definition?.capabilities) || !definition.capabilities.length) issue(issues, "$.capabilities", "must be a non-empty array", "capabilities");
  else {
    const seen = new Set();
    definition.capabilities.forEach((capability, index) => {
      requiredString(capability, `$.capabilities[${index}]`, issues, {pattern: ID_PATTERN});
      if (seen.has(capability)) issue(issues, `$.capabilities[${index}]`, `duplicates "${capability}"`, "duplicate-capability");
      seen.add(capability);
    });
  }
  if (!Array.isArray(definition?.sourceRefs)) issue(issues, "$.sourceRefs", "must be an array", "source-refs");
  else definition.sourceRefs.forEach((ref, index) => validateSourceRef(ref, `$.sourceRefs[${index}]`, issues));
  const sourceIds = Array.isArray(definition?.sourceRefs) ? uniqueIds(definition.sourceRefs, "$.sourceRefs", issues) : new Set();

  exactKeysV2(definition?.rank, ["kind", "minimum", "maximum"], "$.rank", issues);
  if (definition?.rank?.kind !== "level") issue(issues, "$.rank.kind", "currently supports the explicit level rank model only", "rank-kind");
  integer(definition?.rank?.minimum, "$.rank.minimum", issues, {minimum: 0});
  integer(definition?.rank?.maximum, "$.rank.maximum", issues, {minimum: 1});
  if (Number.isInteger(definition?.rank?.minimum) && Number.isInteger(definition?.rank?.maximum) && definition.rank.minimum >= definition.rank.maximum) issue(issues, "$.rank", "minimum must be less than maximum", "rank-range");
  const rank = {
    minimum: Number.isInteger(definition?.rank?.minimum) ? definition.rank.minimum : 0,
    maximum: Number.isInteger(definition?.rank?.maximum) ? definition.rank.maximum : Number.MAX_SAFE_INTEGER,
  };

  const hasAdvancementMilestone = Array.isArray(definition?.milestones)
    && definition.milestones.some(milestone => Array.isArray(milestone?.triggers) && milestone.triggers.includes("rank.advance"));
  if (definition?.trackBinding !== undefined) validateTrackBinding(definition.trackBinding, "$.trackBinding", issues);
  else if (hasAdvancementMilestone) issue(issues, "$.trackBinding", "is required for rank.advance definitions", "track-binding-required");

  if (!Array.isArray(definition?.milestones) || !definition.milestones.length) issue(issues, "$.milestones", "must be a non-empty array", "milestones");
  else {
    uniqueIds(definition.milestones, "$.milestones", issues);
    const milestoneRanks = new Set();
    for (const [index, milestone] of definition.milestones.entries()) {
      const path = `$.milestones[${index}]`;
      exactKeysV2(milestone, ["id", "rank", "triggers", "sourceRefIds", "inputs", "choiceGroups", "evaluations", "effects", "stages"], path, issues);
      requiredString(milestone?.id, `${path}.id`, issues, {pattern: ID_PATTERN});
      integer(milestone?.rank, `${path}.rank`, issues, {minimum: rank.minimum, maximum: rank.maximum});
      if (milestoneRanks.has(milestone?.rank)) issue(issues, `${path}.rank`, `duplicates rank ${milestone.rank}; use one combined milestone per rank`, "duplicate-rank");
      milestoneRanks.add(milestone?.rank);
      if (!Array.isArray(milestone?.triggers) || !milestone.triggers.length) issue(issues, `${path}.triggers`, "must be a non-empty array", "triggers");
      else {
        const seen = new Set();
        milestone.triggers.forEach((trigger, triggerIndex) => {
          if (!TRIGGERS.has(trigger)) issue(issues, `${path}.triggers[${triggerIndex}]`, "is not a supported trigger", "trigger");
          if (seen.has(trigger)) issue(issues, `${path}.triggers[${triggerIndex}]`, `duplicates "${trigger}"`, "duplicate-trigger");
          seen.add(trigger);
        });
      }
      validateSourceIds(milestone?.sourceRefIds ?? [], sourceIds, `${path}.sourceRefIds`, issues);
      if (milestone?.inputs !== undefined && !Array.isArray(milestone.inputs)) issue(issues, `${path}.inputs`, "must be an array", "inputs");
      const inputs = Array.isArray(milestone?.inputs) ? milestone.inputs : [];
      if (inputs.length && (!milestone?.triggers?.includes("character.create") || milestone.triggers.some(trigger => trigger !== "character.create"))) {
        issue(issues, `${path}.inputs`, "may only be declared on a character.create-only milestone", "input-trigger");
      }
      const inputIds = uniqueIds(inputs, `${path}.inputs`, issues);
      const inputTypes = new Map();
      inputs.forEach((input, inputIndex) => {
        validateSemanticInputV2(input, `${path}.inputs[${inputIndex}]`, issues);
        if (typeof input?.id === "string" && !inputTypes.has(input.id)) inputTypes.set(input.id, input.type);
      });
      if (!Array.isArray(milestone?.choiceGroups) || !Array.isArray(milestone?.evaluations) || !Array.isArray(milestone?.effects)) {
        issue(issues, path, "must include choiceGroups, evaluations, and effects arrays", "milestone-arrays");
        continue;
      }
      const choiceGroupIds = uniqueIds(milestone.choiceGroups, `${path}.choiceGroups`, issues);
      const choiceOptions = new Map();
      milestone.choiceGroups.forEach(group => {
        if (typeof group?.id !== "string" || choiceOptions.has(group.id)) return;
        choiceOptions.set(group.id, new Set(
          (Array.isArray(group?.options) ? group.options : [])
            .map(option => option?.id)
            .filter(id => typeof id === "string"),
        ));
      });
      milestone.choiceGroups.forEach((group, groupIndex) => validateChoiceGroupV2(group, `${path}.choiceGroups[${groupIndex}]`, issues, choiceOptions, sourceIds, rank, inputTypes, definition.trackBinding));
      validateMilestoneStagesV2(milestone.stages, `${path}.stages`, issues, inputIds, choiceGroupIds, milestone.choiceGroups);
      uniqueIds(milestone.evaluations, `${path}.evaluations`, issues);
      milestone.evaluations.forEach((evaluation, evaluationIndex) => validateEvaluation(evaluation, `${path}.evaluations[${evaluationIndex}]`, issues, choiceOptions, sourceIds, rank));
      validateEvaluationGraph(milestone.evaluations, `${path}.evaluations`, issues);
      uniqueIds(milestone.effects, `${path}.effects`, issues);
      milestone.effects.forEach((effect, effectIndex) => validateEffectV2(effect, `${path}.effects[${effectIndex}]`, issues, sourceIds, rank, inputTypes, definition.trackBinding));
      const creationOnlyLocations = [
        ...milestone.effects.map((effect, effectIndex) => ({effect, path: `${path}.effects[${effectIndex}]`})),
        ...milestone.choiceGroups.flatMap((group, groupIndex) => (Array.isArray(group?.options) ? group.options : []).flatMap((option, optionIndex) => (
          (Array.isArray(option?.effects) ? option.effects : []).map((effect, effectIndex) => ({
            effect,
            path: `${path}.choiceGroups[${groupIndex}].options[${optionIndex}].effects[${effectIndex}]`,
          }))
        ))),
      ].filter(entry => new Set(["resource.initialize", "ability.set"]).has(entry.effect?.type));
      const milestoneTriggers = Array.isArray(milestone.triggers) ? milestone.triggers : [];
      if (creationOnlyLocations.length
        && (!milestoneTriggers.includes("character.create") || milestoneTriggers.some(trigger => trigger !== "character.create"))) {
        creationOnlyLocations.forEach(entry => issue(
          issues,
          `${entry.path}.type`,
          "may only be used on a character.create-only milestone",
          entry.effect.type === "ability.set" ? "ability-set-trigger" : "resource-initialize-trigger",
        ));
      }
    }
  }
  return Object.freeze({valid: issues.length === 0, issues: Object.freeze(issues)});
}

export function assertProgressionDefinitionV1(definition) {
  const validation = validateProgressionDefinitionV1(definition);
  if (!validation.valid) {
    const error = new Error(`Invalid AGE progression DefinitionV1: ${validation.issues.map(issue => `${issue.path} ${issue.message}`).join("; ")}`);
    error.name = "AgeProgressionDefinitionValidationError";
    error.issues = validation.issues;
    throw error;
  }
  return definition;
}

export function isProgressionDefinitionV1(definition) {
  return validateProgressionDefinitionV1(definition).valid;
}

export function assertProgressionDefinitionV2(definition) {
  const validation = validateProgressionDefinitionV2(definition);
  if (!validation.valid) {
    const error = new Error(`Invalid AGE progression DefinitionV2: ${validation.issues.map(issue => `${issue.path} ${issue.message}`).join("; ")}`);
    error.name = "AgeProgressionDefinitionValidationError";
    error.issues = validation.issues;
    throw error;
  }
  return definition;
}

export function isProgressionDefinitionV2(definition) {
  return validateProgressionDefinitionV2(definition).valid;
}

/** Validate any supported AGE progression definition schema version. */
export function validateProgressionDefinition(definition) {
  if (definition?.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION) return validateProgressionDefinitionV1(definition);
  if (definition?.schemaVersion === AGE_PROGRESSION_DEFINITION_V2_VERSION) return validateProgressionDefinitionV2(definition);
  const issues = [];
  assertPlainJson(definition, "$", issues);
  issue(
    issues,
    "$.schemaVersion",
    `must be one of ${AGE_PROGRESSION_SUPPORTED_DEFINITION_VERSIONS.join(", ")}`,
    "schema-version",
  );
  return Object.freeze({valid: false, issues: Object.freeze(issues)});
}

export function assertProgressionDefinition(definition) {
  const validation = validateProgressionDefinition(definition);
  if (!validation.valid) {
    const error = new Error(`Invalid AGE progression definition: ${validation.issues.map(issue => `${issue.path} ${issue.message}`).join("; ")}`);
    error.name = "AgeProgressionDefinitionValidationError";
    error.issues = validation.issues;
    throw error;
  }
  return definition;
}

export function isProgressionDefinition(definition) {
  return validateProgressionDefinition(definition).valid;
}

export function isPlainProgressionJson(value) {
  const issues = [];
  assertPlainJson(value, "$", issues);
  return issues.length === 0;
}
