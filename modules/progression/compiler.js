import {
  AGE_PROGRESSION_TRIGGERS,
  assertProgressionDefinition,
  isPlainProgressionJson,
} from "./contracts.js";
import {
  canonicalClone,
  definitionDigest as digestDefinition,
  digestCanonicalJson,
} from "./canonical.js";

/** The public, commit-bindable preview contract produced by this compiler. */
export const AGE_PROGRESSION_PREVIEW_VERSION = 1;

const ALLOWED_OPTION_KEYS = new Set([
  "trigger",
  "rank",
  "choices",
  "abilityAllocations",
  "semanticInputs",
  "context",
  "resolveFormula",
  "resolveSourceSnapshot",
  "profileSnapshot",
  "previewId",
  "baseDigest",
  "createdAt",
  "expiresAt",
  "userId",
  "actorUuid",
]);
const ALLOWED_CONTEXT_KEYS = new Set(["abilities", "ownedSourceRefIds"]);
const HEX_DIGEST = /^[0-9a-f]{64}$/i;
const STABLE_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/i;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

function errorDetailsClone(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(errorDetailsClone);
  if (!isPlainObject(value)) return String(value);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, errorDetailsClone(entry)]));
}

function compileError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "AgeProgressionCompileError";
  error.code = code;
  error.details = deepFreeze(errorDetailsClone(details));
  return error;
}

function requireText(value, name, {nullable = false} = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f]/.test(value)) {
    throw compileError("metadata-invalid", `${name} must be a non-empty text value.`, {field: name});
  }
  return value;
}

function requireIsoTimestamp(value, name) {
  requireText(value, name);
  if (!Number.isFinite(Date.parse(value))) {
    throw compileError("metadata-invalid", `${name} must be an ISO-compatible timestamp.`, {field: name});
  }
  return value;
}

function validateCompilerOptions(options) {
  if (!isPlainObject(options)) throw compileError("options-invalid", "Progression compiler options must be an object.");
  const unknown = Object.keys(options).filter(key => !ALLOWED_OPTION_KEYS.has(key));
  if (unknown.length) {
    throw compileError("options-invalid", `Unknown progression compiler option(s): ${unknown.join(", ")}.`, {unknown});
  }
  if (!AGE_PROGRESSION_TRIGGERS.includes(options.trigger)) {
    throw compileError("trigger-invalid", `Unsupported progression trigger "${options.trigger}".`, {trigger: options.trigger});
  }
  if (!Number.isInteger(options.rank)) {
    throw compileError("rank-invalid", "Progression rank must be an integer.", {rank: options.rank});
  }
  const previewId = requireText(options.previewId, "previewId");
  const userId = requireText(options.userId, "userId");
  const createdAt = requireIsoTimestamp(options.createdAt, "createdAt");
  const expiresAt = requireIsoTimestamp(options.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw compileError("metadata-invalid", "expiresAt must be later than createdAt.", {createdAt, expiresAt});
  }
  if (typeof options.baseDigest !== "string" || !HEX_DIGEST.test(options.baseDigest)) {
    throw compileError("base-digest-invalid", "baseDigest must be a SHA-256 hexadecimal digest.");
  }
  const actorUuid = options.actorUuid === undefined ? null : requireText(options.actorUuid, "actorUuid", {nullable: true});
  if (options.trigger === "rank.advance" && actorUuid === null) {
    throw compileError("actor-required", "rank.advance previews must be bound to an actorUuid.");
  }
  if (options.resolveFormula !== undefined && typeof options.resolveFormula !== "function") {
    throw compileError("formula-resolver-invalid", "resolveFormula must be an async-compatible function when supplied.");
  }
  if (options.resolveSourceSnapshot !== undefined && typeof options.resolveSourceSnapshot !== "function") {
    throw compileError("source-snapshot-resolver-invalid", "resolveSourceSnapshot must be an async-compatible function when supplied.");
  }
  return {previewId, userId, createdAt, expiresAt, actorUuid, baseDigest: options.baseDigest.toLowerCase()};
}

function normalizeProfileSnapshot(profileSnapshot, profileId) {
  if (profileSnapshot === undefined) {
    throw compileError("profile-snapshot-required", "Progression previews require an immutable rules profile snapshot.", {profileId});
  }
  const value = profileSnapshot;
  if (!isPlainObject(value) || !isPlainProgressionJson(value)) {
    throw compileError("profile-snapshot-invalid", "Rules profile snapshot must be plain JSON data.");
  }
  const declaredId = value.id ?? value.profileId;
  if (declaredId !== undefined && declaredId !== profileId) {
    throw compileError("profile-snapshot-invalid", `Rules profile snapshot does not match profile "${profileId}".`, {
      profileId,
      snapshotProfileId: declaredId,
    });
  }
  return deepFreeze(canonicalClone(value));
}

function normalizeContext(context = {}) {
  if (!isPlainObject(context) || !isPlainProgressionJson(context)) {
    throw compileError("context-invalid", "Evaluation context must be plain JSON data.");
  }
  const unknown = Object.keys(context).filter(key => !ALLOWED_CONTEXT_KEYS.has(key));
  if (unknown.length) {
    throw compileError("context-invalid", `Unknown evaluation context field(s): ${unknown.join(", ")}.`, {unknown});
  }
  const abilities = context.abilities ?? {};
  if (!isPlainObject(abilities)) throw compileError("context-invalid", "context.abilities must be an object.");
  const normalizedAbilities = {};
  for (const [abilityId, value] of Object.entries(abilities)) {
    if (!STABLE_ID.test(abilityId) || typeof value !== "number" || !Number.isFinite(value)) {
      throw compileError("context-invalid", `Invalid ability context entry "${abilityId}".`, {abilityId});
    }
    normalizedAbilities[abilityId] = value;
  }
  const owned = context.ownedSourceRefIds ?? [];
  if (!Array.isArray(owned)) throw compileError("context-invalid", "context.ownedSourceRefIds must be an array.");
  const ownedSet = new Set();
  for (const sourceRefId of owned) {
    if (typeof sourceRefId !== "string" || !STABLE_ID.test(sourceRefId)) {
      throw compileError("context-invalid", "Owned source references must be stable identifiers.", {sourceRefId});
    }
    if (ownedSet.has(sourceRefId)) {
      throw compileError("context-invalid", `Owned source reference "${sourceRefId}" is duplicated.`, {sourceRefId});
    }
    ownedSet.add(sourceRefId);
  }
  return deepFreeze({
    abilities: Object.fromEntries(Object.entries(normalizedAbilities).sort(([left], [right]) => left.localeCompare(right))),
    ownedSourceRefIds: [...ownedSet].sort(),
  });
}

function normalizeAbilityAllocations(value, trigger) {
  if (value === undefined) return new Map();
  if (trigger !== "character.create") {
    throw compileError("ability-allocations-trigger", "Ability allocations may only be supplied for character.create previews.");
  }
  if (!isPlainObject(value) || !isPlainProgressionJson(value)) {
    throw compileError("ability-allocations-invalid", "Ability allocations must be a plain object keyed by operationId.");
  }
  const normalized = new Map();
  for (const [operationId, allocation] of Object.entries(value)) {
    requireText(operationId, "abilityAllocations operationId");
    if (!isPlainObject(allocation) || !isPlainProgressionJson(allocation)) {
      throw compileError("ability-allocations-invalid", `Ability allocation "${operationId}" must be a plain ability map.`, {operationId});
    }
    normalized.set(operationId, canonicalClone(allocation));
  }
  return normalized;
}

function selectMilestone(definition, rank, trigger) {
  if (rank < definition.rank.minimum || rank > definition.rank.maximum) {
    throw compileError("rank-out-of-range", `Rank ${rank} is outside ${definition.rank.minimum}-${definition.rank.maximum}.`, {rank});
  }
  const candidates = definition.milestones.filter(milestone => milestone.rank === rank && milestone.triggers.includes(trigger));
  if (candidates.length !== 1) {
    throw compileError(
      candidates.length ? "milestone-ambiguous" : "milestone-missing",
      candidates.length
        ? `More than one milestone matches rank ${rank} and trigger "${trigger}".`
        : `No milestone matches rank ${rank} and trigger "${trigger}".`,
      {rank, trigger, milestoneIds: candidates.map(entry => entry.id)},
    );
  }
  return candidates[0];
}

function normalizeSemanticInputs(milestone, value, trigger) {
  if (value === undefined) value = {};
  if (trigger !== "character.create") {
    if (isPlainObject(value) && !Object.keys(value).length) return new Map();
    throw compileError("semantic-inputs-trigger", "Semantic inputs may only be supplied for character.create previews.");
  }
  if (!isPlainObject(value) || !isPlainProgressionJson(value)) {
    throw compileError("semantic-inputs-invalid", "Semantic inputs must be a plain object keyed by declared input id.");
  }
  const inputs = new Map((milestone.inputs ?? []).map(input => [input.id, input]));
  const stale = Object.keys(value).filter(inputId => !inputs.has(inputId));
  if (stale.length) {
    throw compileError("semantic-input-stale", `Unknown or stale semantic input(s): ${stale.join(", ")}.`, {inputIds: stale});
  }
  const normalized = new Map();
  for (const input of inputs.values()) {
    const supplied = Object.hasOwn(value, input.id) ? value[input.id] : input.default;
    if (supplied === undefined) {
      if (input.required) throw compileError("semantic-input-required", `Semantic input "${input.id}" is required.`, {inputId: input.id});
      continue;
    }
    if (input.type === "text" || input.type === "longText") {
      if (typeof supplied !== "string") {
        throw compileError("semantic-input-type", `Semantic input "${input.id}" must be text.`, {inputId: input.id, type: input.type});
      }
      const forbiddenControls = input.type === "longText"
        ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
        : /[\u0000-\u001f\u007f]/;
      if (forbiddenControls.test(supplied)) {
        throw compileError("semantic-input-control", `Semantic input "${input.id}" contains control characters.`, {inputId: input.id});
      }
      const text = supplied.trim();
      const minimum = Math.max(Number.isInteger(input.minLength) ? input.minLength : 0, input.required ? 1 : 0);
      const maximum = Number.isInteger(input.maxLength) ? input.maxLength : 4096;
      if (text.length < minimum || text.length > maximum) {
        throw compileError(
          "semantic-input-length",
          `Semantic input "${input.id}" must contain ${minimum}-${maximum} characters.`,
          {inputId: input.id, minimum, maximum, actual: text.length},
        );
      }
      normalized.set(input.id, text);
      continue;
    }
    if (input.type === "integer") {
      const integer = typeof supplied === "string" && supplied.trim() ? Number(supplied) : supplied;
      if (!Number.isInteger(integer)) {
        throw compileError("semantic-input-type", `Semantic input "${input.id}" must be an integer.`, {inputId: input.id, type: input.type});
      }
      const minimum = Number.isInteger(input.minimum) ? input.minimum : Number.MIN_SAFE_INTEGER;
      const maximum = Number.isInteger(input.maximum) ? input.maximum : Number.MAX_SAFE_INTEGER;
      if (integer < minimum || integer > maximum) {
        throw compileError("semantic-input-range", `Semantic input "${input.id}" must be ${minimum}-${maximum}.`, {
          inputId: input.id,
          minimum,
          maximum,
          actual: integer,
        });
      }
      normalized.set(input.id, integer);
      continue;
    }
    if (input.type === "select") {
      if (typeof supplied !== "string") {
        throw compileError("semantic-input-type", `Semantic input "${input.id}" must select a declared value.`, {inputId: input.id, type: input.type});
      }
      const allowed = new Set((input.options ?? []).map(option => option.value));
      if (!allowed.has(supplied)) {
        throw compileError("semantic-input-option", `Semantic input "${input.id}" selected an unknown value.`, {inputId: input.id, value: supplied});
      }
      normalized.set(input.id, supplied);
      continue;
    }
    throw compileError("semantic-input-type", `Semantic input "${input.id}" uses unsupported type "${input.type}".`, {inputId: input.id, type: input.type});
  }
  return normalized;
}

function normalizeChoices(definition, milestone, choices = {}, rank, context) {
  if (!isPlainObject(choices) || !isPlainProgressionJson(choices)) {
    throw compileError("choices-invalid", "Progression choices must be a plain object keyed by choice-group id.");
  }
  const groups = new Map(milestone.choiceGroups.map(group => [group.id, group]));
  const staleGroups = Object.keys(choices).filter(groupId => !groups.has(groupId));
  if (staleGroups.length) {
    throw compileError("choice-group-stale", `Unknown or stale choice group(s): ${staleGroups.join(", ")}.`, {groupIds: staleGroups});
  }
  const selectedChoices = milestone.choiceGroups.map(group => {
    const supplied = choices[group.id] ?? [];
    if (!Array.isArray(supplied)) {
      throw compileError("choices-invalid", `Choice group "${group.id}" must contain an array of option ids.`, {groupId: group.id});
    }
    const options = new Map(group.options.map((option, index) => [option.id, {option, index}]));
    const selected = supplied.map((optionId, selectionIndex) => {
      if (typeof optionId !== "string" || !options.has(optionId)) {
        throw compileError("choice-option-stale", `Unknown or stale option "${optionId}" in choice group "${group.id}".`, {
          groupId: group.id,
          optionId,
          selectionIndex,
        });
      }
      return {optionId, optionIndex: options.get(optionId).index, selectionIndex};
    });
    if (group.distinct && new Set(selected.map(entry => entry.optionId)).size !== selected.length) {
      throw compileError("choice-distinct", `Choice group "${group.id}" does not allow duplicate options.`, {groupId: group.id});
    }
    // Choice order has no contract semantics, so normalize it for a stable plan digest.
    selected.sort((left, right) => left.optionIndex - right.optionIndex || left.selectionIndex - right.selectionIndex);
    return {
      groupId: group.id,
      optionIds: selected.map(entry => entry.optionId),
    };
  });
  const environment = evaluationEnvironment({definition, milestone, rank, selectedChoices, context});
  return selectedChoices.map(selection => {
    const group = groups.get(selection.groupId);
    const active = !group.evaluations?.length
      || evaluateConditions(group.evaluations, environment, `choice group "${group.id}"`, {throwOnFailure: false});
    if (!active) {
      if (selection.optionIds.length) {
        throw compileError("choice-group-inactive", `Choice group "${group.id}" is not available for the selected path.`, {groupId: group.id});
      }
      return selection;
    }
    if (selection.optionIds.length < group.minimum || selection.optionIds.length > group.maximum) {
      throw compileError(
        "choice-cardinality",
        `Choice group "${group.id}" requires ${group.minimum}-${group.maximum} selections; received ${selection.optionIds.length}.`,
        {groupId: group.id, minimum: group.minimum, maximum: group.maximum, actual: selection.optionIds.length},
      );
    }
    return selection;
  });
}

function evaluationEnvironment({definition, milestone, rank, selectedChoices, context}) {
  return {
    rank,
    choiceGroups: new Map(milestone.choiceGroups.map(group => [group.id, group])),
    selectedChoices: new Map(selectedChoices.map(choice => [choice.groupId, choice.optionIds])),
    declaredSourceRefs: new Set(definition.sourceRefs.map(ref => ref.id)),
    ownedSourceRefs: new Set(context.ownedSourceRefIds),
    abilities: context.abilities,
  };
}

function evaluationRoots(evaluations) {
  const referenced = new Set();
  for (const evaluation of evaluations) {
    for (const id of evaluation.evaluationIds ?? []) referenced.add(id);
  }
  return evaluations.filter(evaluation => !referenced.has(evaluation.id));
}

function evaluateConditions(evaluations, environment, location, {throwOnFailure = true} = {}) {
  if (!evaluations.length) return true;
  const byId = new Map(evaluations.map(evaluation => [evaluation.id, evaluation]));
  const cache = new Map();
  const visiting = new Set();

  const evaluate = id => {
    if (cache.has(id)) return cache.get(id);
    const evaluation = byId.get(id);
    if (!evaluation) {
      throw compileError("evaluation-reference", `Evaluation "${id}" referenced by ${location} does not exist.`, {location, evaluationId: id});
    }
    if (visiting.has(id)) {
      throw compileError("evaluation-cycle", `Evaluation graph for ${location} contains a cycle at "${id}".`, {location, evaluationId: id});
    }
    visiting.add(id);
    let result;
    switch (evaluation.kind) {
      case "rank.atLeast":
        result = environment.rank >= evaluation.rank;
        break;
      case "choice.selected": { // validated against the milestone-local choice vocabulary
        const group = environment.choiceGroups.get(evaluation.choiceGroupId);
        if (!group) {
          throw compileError("evaluation-choice-reference", `Evaluation "${id}" references unknown choice group "${evaluation.choiceGroupId}".`, {
            location,
            evaluationId: id,
            choiceGroupId: evaluation.choiceGroupId,
          });
        }
        const allowed = new Set(group.options.map(option => option.id));
        for (const optionId of evaluation.optionIds ?? []) {
          if (!allowed.has(optionId)) {
            throw compileError("evaluation-option-reference", `Evaluation "${id}" references unknown option "${optionId}".`, {
              location,
              evaluationId: id,
              optionId,
            });
          }
        }
        const selected = environment.selectedChoices.get(evaluation.choiceGroupId) ?? [];
        result = evaluation.optionIds?.length
          ? selected.some(optionId => evaluation.optionIds.includes(optionId))
          : selected.length > 0;
        break;
      }
      case "item.owned":
        if (!environment.declaredSourceRefs.has(evaluation.sourceRefId)) {
          throw compileError("evaluation-source-reference", `Evaluation "${id}" references undeclared source "${evaluation.sourceRefId}".`, {
            location,
            evaluationId: id,
            sourceRefId: evaluation.sourceRefId,
          });
        }
        result = environment.ownedSourceRefs.has(evaluation.sourceRefId);
        break;
      case "ability.minimum":
        result = Number.isFinite(environment.abilities[evaluation.abilityId])
          && environment.abilities[evaluation.abilityId] >= evaluation.value;
        break;
      case "allOf":
        result = evaluation.evaluationIds.every(evaluate);
        break;
      case "anyOf":
        result = evaluation.evaluationIds.some(evaluate);
        break;
      case "not":
        result = !evaluate(evaluation.evaluationIds[0]);
        break;
      default:
        throw compileError("evaluation-kind", `Unsupported evaluation kind "${evaluation.kind}".`, {location, evaluationId: id});
    }
    visiting.delete(id);
    cache.set(id, result);
    return result;
  };

  // Evaluate every node once so invalid orphan references/cycles cannot hide
  // outside the active root expression.
  for (const evaluation of evaluations) evaluate(evaluation.id);
  const roots = evaluationRoots(evaluations);
  if (!roots.length) {
    throw compileError("evaluation-cycle", `Evaluation graph for ${location} has no root.`, {location});
  }
  const failed = roots.filter(evaluation => !cache.get(evaluation.id)).map(evaluation => evaluation.id);
  if (failed.length) {
    if (!throwOnFailure) return false;
    throw compileError("evaluation-failed", `Progression conditions failed for ${location}: ${failed.join(", ")}.`, {location, evaluationIds: failed});
  }
  return true;
}

function occurrenceDescriptors(milestone, selectedChoices) {
  const occurrences = milestone.effects.map(effect => ({
    effect,
    operationId: `${milestone.id}:direct:${effect.id}`,
    origin: {kind: "milestone", milestoneId: milestone.id},
  }));
  const groups = new Map(milestone.choiceGroups.map(group => [group.id, group]));
  for (const selection of selectedChoices) {
    const group = groups.get(selection.groupId);
    selection.optionIds.forEach((optionId, selectionIndex) => {
      const option = group.options.find(entry => entry.id === optionId);
      occurrences.push(...option.effects.map(effect => ({
        effect,
        operationId: `${milestone.id}:choice:${group.id}:${option.id}:${selectionIndex}:${effect.id}`,
        origin: {
          kind: "choice",
          milestoneId: milestone.id,
          choiceGroupId: group.id,
          optionId: option.id,
          selectionIndex,
        },
      })));
    });
  }
  return occurrences;
}

function bindAbilityAllocation(next, suppliedAllocations, context) {
  if (next.type !== "ability.allocate") return;
  const declared = Array.isArray(next.eligibleAbilityIds) ? next.eligibleAbilityIds : null;
  const effective = declared ?? Object.keys(context.abilities ?? {});
  const unavailable = effective.filter(abilityId => !Object.hasOwn(context.abilities ?? {}, abilityId));
  if (unavailable.length) {
    throw compileError("ability-allocation-unknown", `Ability allocation "${next.operationId}" references unavailable abilities: ${unavailable.join(", ")}.`, {
      operationId: next.operationId,
      abilityIds: unavailable,
    });
  }
  const eligible = new Set(effective);
  if (!eligible.size) {
    throw compileError("ability-allocation-eligible", `Ability allocation "${next.operationId}" has no eligible abilities.`, {
      operationId: next.operationId,
    });
  }
  let allocation = suppliedAllocations.get(next.operationId);
  if (allocation === undefined && effective.length === 1) allocation = {[effective[0]]: next.amount};
  if (allocation === undefined) {
    throw compileError("ability-allocation-required", `Ability allocation "${next.operationId}" requires an explicit allocation map.`, {
      operationId: next.operationId,
      eligibleAbilityIds: effective,
    });
  }
  suppliedAllocations.delete(next.operationId);
  const normalized = {};
  let total = 0;
  for (const [abilityId, rawAmount] of Object.entries(allocation)) {
    if (!eligible.has(abilityId)) {
      throw compileError("ability-allocation-ineligible", `Ability "${abilityId}" is not eligible for allocation "${next.operationId}".`, {
        operationId: next.operationId,
        abilityId,
      });
    }
    if (!Number.isInteger(rawAmount) || rawAmount < 0) {
      throw compileError("ability-allocation-value", `Allocation for ability "${abilityId}" must be a non-negative integer.`, {
        operationId: next.operationId,
        abilityId,
        amount: rawAmount,
      });
    }
    normalized[abilityId] = rawAmount;
    total += rawAmount;
  }
  if (total !== next.amount) {
    throw compileError("ability-allocation-total", `Ability allocation "${next.operationId}" totals ${total}, expected ${next.amount}.`, {
      operationId: next.operationId,
      total,
      expected: next.amount,
    });
  }
  const minimum = Number.isInteger(next.minimumPerAbility) ? next.minimumPerAbility : null;
  const maximum = Number.isInteger(next.maximumPerAbility) ? next.maximumPerAbility : null;
  for (const abilityId of effective) {
    const finalValue = Number(context.abilities[abilityId] ?? 0) + Number(normalized[abilityId] ?? 0);
    if (minimum !== null && finalValue < minimum || maximum !== null && finalValue > maximum) {
      throw compileError("ability-allocation-range", `Ability "${abilityId}" would end at ${finalValue}, outside the allowed ${minimum ?? "unbounded"}-${maximum ?? "unbounded"} range.`, {
        operationId: next.operationId,
        abilityId,
        finalValue,
        minimum,
        maximum,
      });
    }
  }
  next.resolution = {...(isPlainObject(next.resolution) ? next.resolution : {}), allocations: normalized};
}

function creationAbilityValues(context, effects) {
  const values = {...context.abilities};
  for (const effect of effects) {
    if (effect.type !== "ability.set") continue;
    if (!Object.hasOwn(values, effect.abilityId)) {
      throw compileError("ability-set-unknown", `Ability assignment "${effect.operationId}" references unavailable ability "${effect.abilityId}".`, {
        operationId: effect.operationId,
        abilityId: effect.abilityId,
      });
    }
    if (!Number.isInteger(effect.value)) {
      throw compileError("ability-set-value", `Ability assignment "${effect.operationId}" did not resolve to an integer.`, {
        operationId: effect.operationId,
        value: effect.value,
      });
    }
    values[effect.abilityId] = effect.value;
  }
  for (const effect of effects) {
    if (effect.type !== "ability.allocate") continue;
    const allocations = effect.resolution?.allocations;
    if (!isPlainObject(allocations)) {
      throw compileError("ability-allocation-unresolved", `Ability allocation "${effect.operationId}" was not signed before formula resolution.`, {
        operationId: effect.operationId,
      });
    }
    for (const [abilityId, amount] of Object.entries(allocations)) {
      if (!Object.hasOwn(values, abilityId)) {
        throw compileError("ability-allocation-unknown", `Ability allocation "${effect.operationId}" references unavailable ability "${abilityId}".`, {
          operationId: effect.operationId,
          abilityId,
        });
      }
      values[abilityId] += amount;
    }
  }
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
}

function bindSemanticInputEffects(effects, semanticInputs) {
  for (const next of effects) {
    if (!["identity.set", "ability.set", "language.add"].includes(next.type)
      || !isPlainObject(next.value)
      || next.value.kind !== "input") continue;
    const inputId = next.value.inputId;
    if (!semanticInputs.has(inputId)) {
      throw compileError("semantic-input-required", `Effect "${next.operationId}" requires semantic input "${inputId}".`, {
        operationId: next.operationId,
        inputId,
      });
    }
    const value = semanticInputs.get(inputId);
    if (next.type === "identity.set" && next.field === "name" && (typeof value !== "string" || !value || value.length > 128)) {
      throw compileError("character-name-invalid", "Character name must contain 1-128 visible characters.", {
        operationId: next.operationId,
        inputId,
      });
    }
    next.value = value;
    next.resolution = {kind: "input", inputId, value};
  }
}

async function resolveEffects({definition, milestone, trigger, rank, selectedChoices, context, resolveFormula, abilityAllocations, semanticInputs}) {
  const environment = evaluationEnvironment({definition, milestone, rank, selectedChoices, context});
  evaluateConditions(milestone.evaluations, environment, `milestone "${milestone.id}"`);
  const groups = new Map(milestone.choiceGroups.map(group => [group.id, group]));
  for (const selection of selectedChoices) {
    const group = groups.get(selection.groupId);
    for (const optionId of new Set(selection.optionIds)) {
      const option = group.options.find(entry => entry.id === optionId);
      evaluateConditions(option.evaluations, environment, `choice option "${group.id}.${option.id}"`);
    }
  }

  const occurrences = occurrenceDescriptors(milestone, selectedChoices);
  const resolved = occurrences.map(occurrence => ({
      operationId: occurrence.operationId,
      origin: occurrence.origin,
      ...canonicalClone(occurrence.effect),
  }));

  // Creation allocations are validated and signed before any formula is
  // evaluated. Formula-bearing starting resources therefore see the final
  // selected creation abilities regardless of effect ordering in a provider.
  if (trigger === "character.create") {
    for (const next of resolved) bindAbilityAllocation(next, abilityAllocations, context);
    if (abilityAllocations.size) {
      const operationIds = [...abilityAllocations.keys()].sort();
      throw compileError("ability-allocation-stale", `Unknown or stale ability allocation operation(s): ${operationIds.join(", ")}.`, {operationIds});
    }
    bindSemanticInputEffects(resolved, semanticInputs);
  }
  const signedAbilityValues = trigger === "character.create"
    ? creationAbilityValues(context, resolved)
    : context.abilities;
  const initializedResources = new Map();
  for (const next of resolved) {
    if (next.type !== "resource.initialize") continue;
    if (initializedResources.has(next.resource)) {
      throw compileError("resource-initialize-duplicate", `Creation preview initializes resource "${next.resource}" more than once.`, {
        resource: next.resource,
        operationIds: [initializedResources.get(next.resource), next.operationId],
      });
    }
    initializedResources.set(next.resource, next.operationId);
  }

  const sharedFormulaTotals = new Map();
  for (const [index, next] of resolved.entries()) {
    const occurrence = occurrences[index];
    if (isPlainObject(next.amount) && next.amount.kind === "formula") {
      if (typeof resolveFormula !== "function") {
        throw compileError("formula-resolver-required", `Effect "${occurrence.effect.id}" requires a formula resolver.`, {
          effectId: occurrence.effect.id,
          operationId: occurrence.operationId,
        });
      }
      const amountSpec = canonicalClone(next.amount);
      const formula = amountSpec.formula;
      const rollId = amountSpec.rollId ?? null;
      const metadata = deepFreeze({
        definitionId: definition.id,
        definitionVersion: definition.version,
        profileId: definition.profileId,
        milestoneId: milestone.id,
        effectId: occurrence.effect.id,
        operationId: occurrence.operationId,
        ...(rollId ? {rollId} : {}),
        trigger,
        rank,
        context: canonicalClone(context),
        abilityValues: canonicalClone(signedAbilityValues),
      });
      const shared = rollId ? sharedFormulaTotals.get(rollId) : null;
      if (shared && shared.formula !== formula) {
        throw compileError("formula-roll-conflict", `Shared roll "${rollId}" uses more than one formula.`, {
          rollId,
          formulas: [shared.formula, formula],
        });
      }
      // An authored rollId deliberately resolves one random result for every
      // effect that consumes that same rules roll (for example current and
      // maximum Health). Unkeyed formulas remain independent occurrences.
      const rawTotal = shared ? shared.rawTotal : await resolveFormula(formula, metadata);
      if (typeof rawTotal !== "number" || !Number.isFinite(rawTotal)) {
        throw compileError("formula-result-invalid", `Formula resolver returned a non-finite total for "${formula}".`, {
          effectId: occurrence.effect.id,
          operationId: occurrence.operationId,
        });
      }
      const total = Math.min(
        Number.isFinite(amountSpec.maximum) ? amountSpec.maximum : Number.POSITIVE_INFINITY,
        Math.max(Number.isFinite(amountSpec.minimum) ? amountSpec.minimum : Number.NEGATIVE_INFINITY, rawTotal),
      );
      if (rollId && !shared) sharedFormulaTotals.set(rollId, {formula, rawTotal, total});
      if (next.type === "resource.initialize" && total < 0) {
        throw compileError("resource-initialize-result", `Starting resource formula "${formula}" resolved to a negative total.`, {
          effectId: occurrence.effect.id,
          operationId: occurrence.operationId,
          total,
        });
      }
      next.amount = total;
      next.resolution = {
        ...(isPlainObject(next.resolution) ? next.resolution : {}),
        kind: "formula",
        formula,
        total,
        ...(total !== rawTotal ? {rawTotal} : {}),
        ...(Number.isFinite(amountSpec.minimum) ? {minimum: amountSpec.minimum} : {}),
        ...(Number.isFinite(amountSpec.maximum) ? {maximum: amountSpec.maximum} : {}),
        ...(rollId ? {rollId} : {}),
        ...(trigger === "character.create" ? {abilityValues: canonicalClone(signedAbilityValues)} : {}),
      };
    }
  }
  return resolved;
}

async function resolveCreationSourceSnapshots({definition, trigger, resolvedEffects, resolveSourceSnapshot}) {
  if (trigger !== "character.create") return [];
  const sourceRefIds = [...new Set(resolvedEffects
    .filter(effect => effect.type === "item.acquire")
    .map(effect => effect.sourceRefId))].sort();
  if (!sourceRefIds.length) return [];
  if (!(resolveSourceSnapshot instanceof Function)) {
    throw compileError("source-snapshot-resolver-required", "Creation item acquisitions require a source snapshot resolver.", {sourceRefIds});
  }
  const references = new Map(definition.sourceRefs.map(reference => [reference.id, reference]));
  const snapshots = [];
  for (const sourceRefId of sourceRefIds) {
    const sourceRef = references.get(sourceRefId);
    if (!sourceRef) {
      throw compileError("source-reference", `Creation sourceRef "${sourceRefId}" is not declared.`, {sourceRefId});
    }
    const metadata = deepFreeze({
      definitionId: definition.id,
      definitionVersion: definition.version,
      profileId: definition.profileId,
      trigger,
      sourceRef: canonicalClone(sourceRef),
    });
    const digest = await resolveSourceSnapshot(sourceRefId, metadata);
    if (typeof digest !== "string" || !HEX_DIGEST.test(digest)) {
      throw compileError("source-snapshot-invalid", `Source snapshot resolver returned an invalid digest for "${sourceRefId}".`, {sourceRefId});
    }
    snapshots.push({
      sourceRefId,
      sourceUuid: sourceRef.uuid ?? null,
      digest: digest.toLowerCase(),
    });
  }
  return snapshots;
}

function previewWarnings(definition, resolvedEffects) {
  const warnings = [];
  if (definition.rulesContentCoverage && definition.rulesContentCoverage !== "complete") {
    warnings.push({
      code: "rules-content-coverage",
      message: `Definition rules-content coverage is ${definition.rulesContentCoverage}.`,
    });
  }
  if (!resolvedEffects.length) {
    warnings.push({code: "no-effects", message: "This milestone resolves no progression effects."});
  }
  return warnings;
}

/**
 * Compile one DefinitionV1 milestone into a deterministic, deeply frozen
 * PreviewV1.  The result is plain JSON and is safe to retain server-side;
 * callers must commit by previewId + planDigest rather than client-supplied
 * operations.
 */
export async function compileProgressionPreviewV1(definition, options = {}) {
  assertProgressionDefinition(definition);
  const metadata = validateCompilerOptions(options);
  const normalizedDefinition = canonicalClone(definition);
  const profileSnapshot = normalizeProfileSnapshot(options.profileSnapshot, normalizedDefinition.profileId);
  const context = normalizeContext(options.context);
  const milestone = selectMilestone(normalizedDefinition, options.rank, options.trigger);
  const selectedChoices = normalizeChoices(normalizedDefinition, milestone, options.choices, options.rank, context);
  const abilityAllocations = normalizeAbilityAllocations(options.abilityAllocations, options.trigger);
  const semanticInputs = normalizeSemanticInputs(milestone, options.semanticInputs, options.trigger);
  const resolvedEffects = await resolveEffects({
    definition: normalizedDefinition,
    milestone,
    trigger: options.trigger,
    rank: options.rank,
    selectedChoices,
    context,
    resolveFormula: options.resolveFormula,
    abilityAllocations,
    semanticInputs,
  });
  const sourceSnapshots = await resolveCreationSourceSnapshots({
    definition: normalizedDefinition,
    trigger: options.trigger,
    resolvedEffects,
    resolveSourceSnapshot: options.resolveSourceSnapshot,
  });
  const summaries = resolvedEffects
    .filter(effect => effect.type === "summary.add")
    .map(effect => ({id: effect.entryId, label: effect.label ?? effect.entryId, operationId: effect.operationId}));
  const body = {
    schemaVersion: AGE_PROGRESSION_PREVIEW_VERSION,
    previewId: metadata.previewId,
    definitionId: normalizedDefinition.id,
    definitionVersion: normalizedDefinition.version,
    definitionDigest: await digestDefinition(normalizedDefinition),
    profileId: normalizedDefinition.profileId,
    profileDigest: await digestCanonicalJson(profileSnapshot),
    ...(normalizedDefinition.trackBinding === undefined
      ? {}
      : {trackBinding: canonicalClone(normalizedDefinition.trackBinding)}),
    milestoneId: milestone.id,
    trigger: options.trigger,
    rank: options.rank,
    selectedChoices,
    semanticInputs: Object.fromEntries(semanticInputs),
    resolvedEffects,
    sourceSnapshots,
    summaries,
    warnings: previewWarnings(normalizedDefinition, resolvedEffects),
    baseDigest: metadata.baseDigest,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
    userId: metadata.userId,
    actorUuid: metadata.actorUuid,
  };
  const planDigest = await digestCanonicalJson(body);
  return deepFreeze({...body, planDigest});
}

export const compileProgressionPreview = compileProgressionPreviewV1;
