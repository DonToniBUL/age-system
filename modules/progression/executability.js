import {validateProgressionDefinition} from "./contracts.js";

/**
 * Structural compatibility checks for the executors shipped with AGE 5.1.
 *
 * DefinitionV1 deliberately describes provider-neutral rules.  A definition
 * can therefore be a valid semantic document while asking the current
 * creation, Class-backed, or Actor-backed executor to do something it cannot
 * represent safely.  Keep that distinction explicit: registration continues
 * to use the version-dispatching contract validator, while authoring and workflow
 * readiness may opt into this validator before a preview is attempted.
 */
export const AGE_PROGRESSION_EXECUTABILITY_VERSION = 1;

export const AGE_PROGRESSION_EXECUTORS = Object.freeze({
  CREATION: "creation",
  CLASS_ITEM: "class-item",
  ACTOR: "actor",
});

const CLASS_RESOURCE_IDS = new Set(["health", "powerPoints", "conviction"]);
const ADVANCEMENT_ITEM_TRAITS = new Set(["spec", "talent", "focus", "relationship"]);
const CREATION_ITEM_TRAITS = new Set([
  "focus",
  "focus.improved",
  "talent",
  "talent.degree",
  "spec",
  "spec.degree",
  "relationship",
  "relationship.intensity",
  "membership",
  "membership.rank",
]);
const CLASS_EFFECT_TYPES = new Set([
  "resource.gain",
  "classBonus.gain",
  "ability.allocate",
  "ability.setPrimary",
  "weaponGroup.add",
  "item.acquire",
  "item.advance",
  "track.setRank",
  "summary.add",
]);
const VALID_TRIGGER_FILTERS = new Set(["character.create", "rank.advance"]);

function freeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) freeze(entry);
  return value;
}

function triggerForExecutor(executor) {
  return executor === AGE_PROGRESSION_EXECUTORS.CREATION ? "character.create" : "rank.advance";
}

function executableIssue(path, message, code, executor, milestone, trigger = triggerForExecutor(executor)) {
  return freeze({
    path,
    message,
    code,
    severity: "error",
    executor,
    trigger,
    rank: milestone.rank,
  });
}

function normalizeTriggerFilter(trigger) {
  if (trigger === undefined || trigger === null) return null;
  const values = Array.isArray(trigger) ? trigger : [trigger];
  const invalid = values.filter(value => !VALID_TRIGGER_FILTERS.has(value));
  if (invalid.length) throw new TypeError(`Unsupported progression executability trigger: ${invalid.join(", ")}.`);
  return new Set(values);
}

function sourceRefMap(definition) {
  return new Map((definition.sourceRefs ?? []).map(ref => [ref.id, ref]));
}

function optionCanExecute(group) {
  return Number(group?.maximum) > 0;
}

function effectEntries(milestone, milestoneIndex) {
  const entries = [];
  (milestone.effects ?? []).forEach((effect, effectIndex) => entries.push({
    effect,
    path: `$.milestones[${milestoneIndex}].effects[${effectIndex}]`,
    kind: "direct",
    effectIndex,
    groupIndex: null,
    optionIndex: null,
  }));
  (milestone.choiceGroups ?? []).forEach((group, groupIndex) => {
    if (!optionCanExecute(group)) return;
    (group.options ?? []).forEach((option, optionIndex) => {
      (option.effects ?? []).forEach((effect, effectIndex) => entries.push({
        effect,
        path: `$.milestones[${milestoneIndex}].choiceGroups[${groupIndex}].options[${optionIndex}].effects[${effectIndex}]`,
        kind: "option",
        effectIndex,
        groupIndex,
        optionIndex,
      }));
    });
  });
  return entries;
}

function executionContexts(definition, milestone, triggerFilter) {
  const contexts = [];
  if (milestone.triggers.includes("character.create") && (!triggerFilter || triggerFilter.has("character.create"))) {
    contexts.push(AGE_PROGRESSION_EXECUTORS.CREATION);
  }
  if (milestone.triggers.includes("rank.advance") && (!triggerFilter || triggerFilter.has("rank.advance"))) {
    contexts.push(definition.trackBinding.kind === "class-item"
      ? AGE_PROGRESSION_EXECUTORS.CLASS_ITEM
      : AGE_PROGRESSION_EXECUTORS.ACTOR);
  }
  return contexts;
}

function canCooccur(left, right, milestone) {
  if (left.kind === "direct" || right.kind === "direct") return true;
  if (left.groupIndex !== right.groupIndex) return true;
  if (left.optionIndex === right.optionIndex) return true;
  return Number(milestone.choiceGroups[left.groupIndex]?.maximum) >= 2;
}

function sameOptionCanRepeat(entry, milestone) {
  if (entry.kind !== "option") return false;
  const group = milestone.choiceGroups[entry.groupIndex];
  return group?.distinct === false && Number(group.maximum) >= 2;
}

function checkSharedRolls(entries, milestone, issues, triggers) {
  const formulaEntries = entries.filter(({effect}) => (
    effect?.amount?.kind === "formula"
    && typeof effect.amount.rollId === "string"
    && effect.amount.rollId
  ));
  for (let leftIndex = 0; leftIndex < formulaEntries.length; leftIndex += 1) {
    const left = formulaEntries[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < formulaEntries.length; rightIndex += 1) {
      const right = formulaEntries[rightIndex];
      if (left.effect.amount.rollId !== right.effect.amount.rollId
        || left.effect.amount.formula === right.effect.amount.formula
        || !canCooccur(left, right, milestone)) continue;
      for (const trigger of triggers) {
        issues.push(executableIssue(
          `${right.path}.amount.formula`,
          `Shared roll "${right.effect.amount.rollId}" can resolve with conflicting formulas in the same preview.`,
          "executor-roll-conflict",
          "compiler",
          milestone,
          trigger,
        ));
      }
    }
  }
}

function checkCreationInitializers(entries, milestone, issues) {
  const initializers = entries.filter(({effect}) => effect.type === "resource.initialize");
  for (const entry of initializers) {
    if (sameOptionCanRepeat(entry, milestone)) {
      issues.push(executableIssue(
        `${entry.path}.type`,
        `A repeated selection can initialize ${entry.effect.resource} more than once in one creation preview.`,
        "executor-resource-initialize-duplicate",
        AGE_PROGRESSION_EXECUTORS.CREATION,
        milestone,
      ));
    }
  }
  for (let leftIndex = 0; leftIndex < initializers.length; leftIndex += 1) {
    const left = initializers[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < initializers.length; rightIndex += 1) {
      const right = initializers[rightIndex];
      if (left.effect.resource !== right.effect.resource || !canCooccur(left, right, milestone)) continue;
      issues.push(executableIssue(
        `${right.path}.resource`,
        `A legal selection can initialize ${right.effect.resource} more than once in one creation preview.`,
        "executor-resource-initialize-duplicate",
        AGE_PROGRESSION_EXECUTORS.CREATION,
        milestone,
      ));
    }
  }
}

function acquiredRefs(effects) {
  return new Set(effects.filter(effect => effect.type === "item.acquire").map(effect => effect.sourceRefId));
}

function guaranteedGroupAcquisitions(group) {
  const minimum = Number(group.minimum);
  if (minimum < 1 || !group.options?.length) return new Set();
  const acquisitions = group.options.map(option => acquiredRefs(option.effects ?? []));
  const candidates = new Set(acquisitions.flatMap(ids => [...ids]));
  if (group.distinct !== true) {
    return new Set([...candidates].filter(sourceRefId => acquisitions.every(ids => ids.has(sourceRefId))));
  }
  return new Set([...candidates].filter(sourceRefId => (
    acquisitions.filter(ids => !ids.has(sourceRefId)).length < minimum
  )));
}

function guaranteedAcquisitionsBeforeOption(group, optionIndex) {
  if (group.distinct !== true || !group.options?.length) return new Set();
  const requiredOthers = Math.max(1, Number(group.minimum)) - 1;
  if (requiredOthers < 1) return new Set();
  const earlier = group.options.slice(0, optionIndex).map(option => acquiredRefs(option.effects ?? []));
  const candidates = new Set(earlier.flatMap(ids => [...ids]));
  return new Set([...candidates].filter(sourceRefId => {
    const earlierAcquirers = earlier.filter(ids => ids.has(sourceRefId)).length;
    const selectableOthersWithoutAcquisition = group.options.length - 1 - earlierAcquirers;
    return selectableOthersWithoutAcquisition < requiredOthers;
  }));
}

function checkCreationItemOrder(milestone, milestoneIndex, issues) {
  const directAcquired = new Set();
  (milestone.effects ?? []).forEach((effect, effectIndex) => {
    const path = `$.milestones[${milestoneIndex}].effects[${effectIndex}]`;
    if (effect.type === "item.advance" && !directAcquired.has(effect.sourceRefId)) {
      issues.push(executableIssue(
        `${path}.sourceRefId`,
        "Creation-time item.advance must follow a guaranteed item.acquire for the same sourceRef.",
        "executor-item-source-order",
        AGE_PROGRESSION_EXECUTORS.CREATION,
        milestone,
      ));
    }
    if (effect.type === "item.acquire") directAcquired.add(effect.sourceRefId);
  });

  const guaranteedBeforeGroup = new Set(acquiredRefs(milestone.effects ?? []));
  (milestone.choiceGroups ?? []).forEach((group, groupIndex) => {
    if (!optionCanExecute(group)) return;
    (group.options ?? []).forEach((option, optionIndex) => {
      const localAcquired = new Set(guaranteedBeforeGroup);
      for (const sourceRefId of guaranteedAcquisitionsBeforeOption(group, optionIndex)) localAcquired.add(sourceRefId);
      (option.effects ?? []).forEach((effect, effectIndex) => {
        const path = `$.milestones[${milestoneIndex}].choiceGroups[${groupIndex}].options[${optionIndex}].effects[${effectIndex}]`;
        if (effect.type === "item.advance" && !localAcquired.has(effect.sourceRefId)) {
          issues.push(executableIssue(
            `${path}.sourceRefId`,
            "Creation-time item.advance must follow a guaranteed item.acquire for the same sourceRef.",
            "executor-item-source-order",
            AGE_PROGRESSION_EXECUTORS.CREATION,
            milestone,
          ));
        }
        if (effect.type === "item.acquire") localAcquired.add(effect.sourceRefId);
      });
    });
    for (const sourceRefId of guaranteedGroupAcquisitions(group)) guaranteedBeforeGroup.add(sourceRefId);
  });
}

function groupEffectValueBounds(group, valueForEffect) {
  const counts = (group.options ?? []).map(option => (
    (option.effects ?? []).reduce((sum, effect) => sum + valueForEffect(effect), 0)
  ));
  if (!counts.length || Number(group.maximum) < 1) return {minimum: 0, maximum: 0};
  const minimumSelections = Number(group.minimum);
  const maximumSelections = Number(group.maximum);
  if (group.distinct === true) {
    const ascending = [...counts].sort((left, right) => left - right);
    const descending = [...ascending].reverse();
    return {
      minimum: ascending.slice(0, minimumSelections).reduce((sum, count) => sum + count, 0),
      maximum: descending.slice(0, maximumSelections).reduce((sum, count) => sum + count, 0),
    };
  }
  return {
    minimum: minimumSelections * Math.min(...counts),
    maximum: maximumSelections * Math.max(...counts),
  };
}

function conditionalGroupEffectValueBounds(group, selectedOptionIndex, valueForEffect) {
  const counts = (group.options ?? []).map(option => (
    (option.effects ?? []).reduce((sum, effect) => sum + valueForEffect(effect), 0)
  ));
  if (!counts.length || Number(group.maximum) < 1) return {minimum: 0, maximum: 0};
  const selected = counts[selectedOptionIndex];
  const minimumSelections = Math.max(1, Number(group.minimum));
  const maximumSelections = Number(group.maximum);
  const others = counts.filter((_, index) => index !== selectedOptionIndex);
  if (group.distinct === true) {
    const ascending = [...others].sort((left, right) => left - right);
    const descending = [...ascending].reverse();
    return {
      minimum: selected + ascending.slice(0, minimumSelections - 1).reduce((sum, count) => sum + count, 0),
      maximum: selected + descending.slice(0, maximumSelections - 1).reduce((sum, count) => sum + count, 0),
    };
  }
  const smallest = Math.min(...counts);
  const largest = Math.max(...counts);
  return {
    minimum: selected + (minimumSelections - 1) * smallest,
    maximum: selected + (maximumSelections - 1) * largest,
  };
}

function milestoneEffectValueBounds(milestone, valueForEffect, selectedEntry = null) {
  const direct = (milestone.effects ?? []).reduce((sum, effect) => sum + valueForEffect(effect), 0);
  return (milestone.choiceGroups ?? []).reduce((bounds, group, groupIndex) => {
    const contribution = selectedEntry?.kind === "option" && selectedEntry.groupIndex === groupIndex
      ? conditionalGroupEffectValueBounds(group, selectedEntry.optionIndex, valueForEffect)
      : groupEffectValueBounds(group, valueForEffect);
    bounds.minimum += contribution.minimum;
    bounds.maximum += contribution.maximum;
    return bounds;
  }, {minimum: direct, maximum: direct});
}

function milestoneEffectCountBounds(milestone, predicate, selectedEntry = null) {
  return milestoneEffectValueBounds(milestone, effect => predicate(effect) ? 1 : 0, selectedEntry);
}

function checkActorTrackCardinality(milestone, milestoneIndex, executor, issues) {
  const bounds = milestoneEffectCountBounds(milestone, effect => effect.type === "track.setRank");
  if (bounds.minimum === 1 && bounds.maximum === 1) return;
  issues.push(executableIssue(
    `$.milestones[${milestoneIndex}]`,
    `Every legal Actor-track selection must resolve exactly one track.setRank effect; this milestone can resolve ${bounds.minimum}-${bounds.maximum}.`,
    "executor-track-cardinality",
    executor,
    milestone,
  ));
}

function checkCreationItemCardinality(milestone, milestoneIndex, entries, issues) {
  for (const entry of entries.filter(({effect}) => effect.type === "item.advance" && effect.sourceRefId)) {
    const sourceRefId = entry.effect.sourceRefId;
    const bounds = milestoneEffectValueBounds(milestone, effect => (
      effect.type === "item.acquire" && effect.sourceRefId === sourceRefId ? Number(effect.quantity ?? 1) : 0
    ), entry.kind === "option" ? entry : null);
    if (bounds.minimum === 1 && bounds.maximum === 1) continue;
    issues.push(executableIssue(
      `${entry.path}.sourceRefId`,
      `Every legal selection containing this item.advance must acquire exactly one Item for sourceRef "${sourceRefId}"; it can acquire ${bounds.minimum}-${bounds.maximum}.`,
      "executor-item-source-cardinality",
      AGE_PROGRESSION_EXECUTORS.CREATION,
      milestone,
    ));
  }
}

function checkActorTrackEffect(entry, milestone, executor, issues) {
  const {effect, path} = entry;
  if (effect.type !== "track.setRank" || effect.rank === milestone.rank) return;
  issues.push(executableIssue(
    `${path}.rank`,
    `Actor-backed track.setRank must equal its milestone rank ${milestone.rank}.`,
    "executor-track-rank",
    executor,
    milestone,
  ));
}

function amountSignature(effect, path) {
  if (typeof effect.amount === "number") return `fixed:${JSON.stringify(effect.amount)}`;
  const rollId = effect.amount?.rollId;
  // Two unkeyed formulas are resolved independently. Even identical formula
  // text is not a safe Class resource/bonus pair because the totals may differ.
  const resolution = rollId ? `shared:${rollId}` : `independent:${path}`;
  return `formula:${effect.amount?.formula ?? ""}:${resolution}`;
}

function vectorAdd(target, source, scale = 1) {
  for (const [key, value] of source) {
    const next = (target.get(key) ?? 0) + value * scale;
    if (next) target.set(key, next);
    else target.delete(key);
  }
  return target;
}

function sameVector(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

function classPairVector(entries) {
  const vector = new Map();
  for (const {effect, path} of entries) {
    let family = null;
    let direction = 0;
    if (effect.type === "resource.gain" && CLASS_RESOURCE_IDS.has(effect.resource)) {
      family = effect.resource;
      direction = 1;
    } else if (effect.type === "classBonus.gain" && CLASS_RESOURCE_IDS.has(effect.bonus)) {
      family = effect.bonus;
      direction = -1;
    } else if (effect.type === "classBonus.gain" && effect.bonus === "defense") {
      family = "defenseAndToughness";
      direction = 1;
    } else if (effect.type === "classBonus.gain" && effect.bonus === "toughness") {
      family = "defenseAndToughness";
      direction = -1;
    }
    if (!family) continue;
    const key = `${family}\u0000${amountSignature(effect, path)}`;
    const next = (vector.get(key) ?? 0) + direction;
    if (next) vector.set(key, next);
    else vector.delete(key);
  }
  return vector;
}

function classPairLabel(key) {
  const family = key.split("\u0000", 1)[0];
  return family === "defenseAndToughness" ? "defense/toughness" : `${family} resource/Class bonus`;
}

function checkClassPairs(milestone, milestoneIndex, issues) {
  const baseEntries = (milestone.effects ?? []).map((effect, effectIndex) => ({
    effect,
    path: `$.milestones[${milestoneIndex}].effects[${effectIndex}]`,
  }));
  const total = classPairVector(baseEntries);
  let invariant = true;

  (milestone.choiceGroups ?? []).forEach((group, groupIndex) => {
    if (!optionCanExecute(group)) return;
    const vectors = (group.options ?? []).map((option, optionIndex) => classPairVector((option.effects ?? []).map((effect, effectIndex) => ({
      effect,
      path: `$.milestones[${milestoneIndex}].choiceGroups[${groupIndex}].options[${optionIndex}].effects[${effectIndex}]`,
    }))));
    const minimum = Number(group.minimum);
    const maximum = Number(group.maximum);
    let constant = new Map();
    let groupInvariant = true;
    if (minimum === maximum && minimum > 0) {
      if (group.distinct === true && minimum === vectors.length) {
        for (const vector of vectors) vectorAdd(constant, vector);
      } else if (vectors.length && vectors.every(vector => sameVector(vector, vectors[0]))) {
        constant = vectorAdd(new Map(), vectors[0], minimum);
      } else groupInvariant = false;
    } else if (minimum !== maximum && vectors.some(vector => vector.size)) groupInvariant = false;

    if (!groupInvariant) {
      invariant = false;
      issues.push(executableIssue(
        `$.milestones[${milestoneIndex}].choiceGroups[${groupIndex}]`,
        "Different legal selections can leave Class resource and Class-bonus effects unpaired.",
        "executor-class-choice-pair",
        AGE_PROGRESSION_EXECUTORS.CLASS_ITEM,
        milestone,
      ));
    } else vectorAdd(total, constant);
  });

  if (!invariant || !total.size) return;
  const labels = [...new Set([...total.keys()].map(classPairLabel))].sort();
  issues.push(executableIssue(
    `$.milestones[${milestoneIndex}]`,
    `Class-backed advancement requires identical paired effects for: ${labels.join(", ")}.`,
    "executor-class-pair",
    AGE_PROGRESSION_EXECUTORS.CLASS_ITEM,
    milestone,
  ));
}

function checkSourceUuid(effect, path, sourceRefs, executor, milestone, issues) {
  const ref = sourceRefs.get(effect.sourceRefId);
  if (ref && (typeof ref.uuid !== "string" || !ref.uuid.trim())) {
    issues.push(executableIssue(
      `${path}.sourceRefId`,
      `The ${executor} executor requires sourceRef "${effect.sourceRefId}" to declare an Item UUID.`,
      "executor-source-uuid",
      executor,
      milestone,
    ));
  }
}

function checkCreationEffect(entry, sourceRefs, milestone, issues) {
  const {effect, path} = entry;
  if (effect.type === "item.acquire") checkSourceUuid(effect, path, sourceRefs, AGE_PROGRESSION_EXECUTORS.CREATION, milestone, issues);
  if (effect.type !== "item.advance") return;
  if (!effect.sourceRefId) {
    issues.push(executableIssue(
      `${path}.sourceRefId`,
      "The creation executor requires item.advance to name an acquired sourceRef.",
      "executor-item-source",
      AGE_PROGRESSION_EXECUTORS.CREATION,
      milestone,
    ));
  }
  if (!CREATION_ITEM_TRAITS.has(effect.trait)) {
    issues.push(executableIssue(
      `${path}.trait`,
      `The creation executor cannot advance Item trait "${effect.trait}".`,
      "executor-item-trait",
      AGE_PROGRESSION_EXECUTORS.CREATION,
      milestone,
    ));
  }
}

function checkActorEffect(entry, sourceRefs, milestone, issues) {
  const {effect, path} = entry;
  if (effect.type === "item.acquire") {
    if ((effect.quantity ?? 1) !== 1) {
      issues.push(executableIssue(
        `${path}.quantity`,
        "Actor-backed advancement can acquire exactly one Item per effect.",
        "executor-item-quantity",
        AGE_PROGRESSION_EXECUTORS.ACTOR,
        milestone,
      ));
    }
    checkSourceUuid(effect, path, sourceRefs, AGE_PROGRESSION_EXECUTORS.ACTOR, milestone, issues);
  }
  if (effect.type === "item.advance") {
    if (!ADVANCEMENT_ITEM_TRAITS.has(effect.trait)) {
      issues.push(executableIssue(
        `${path}.trait`,
        `Actor-backed advancement cannot advance Item trait "${effect.trait}".`,
        "executor-item-trait",
        AGE_PROGRESSION_EXECUTORS.ACTOR,
        milestone,
      ));
    }
    if (effect.sourceRefId) checkSourceUuid(effect, path, sourceRefs, AGE_PROGRESSION_EXECUTORS.ACTOR, milestone, issues);
  }
  checkActorTrackEffect(entry, milestone, AGE_PROGRESSION_EXECUTORS.ACTOR, issues);
}

function checkClassEffect(entry, sourceRefs, milestone, issues) {
  const {effect, path} = entry;
  if (!CLASS_EFFECT_TYPES.has(effect.type)) {
    issues.push(executableIssue(
      `${path}.type`,
      `Class-backed advancement cannot represent effect "${effect.type}".`,
      "executor-effect",
      AGE_PROGRESSION_EXECUTORS.CLASS_ITEM,
      milestone,
    ));
    return;
  }
  if (effect.type === "resource.gain" && !CLASS_RESOURCE_IDS.has(effect.resource)) {
    issues.push(executableIssue(
      `${path}.resource`,
      `Class-backed advancement cannot delegate resource "${effect.resource}".`,
      "executor-resource",
      AGE_PROGRESSION_EXECUTORS.CLASS_ITEM,
      milestone,
    ));
  }
  if ((effect.type === "resource.gain" || effect.type === "classBonus.gain")
    && typeof effect.amount === "number" && effect.amount < 0) {
    issues.push(executableIssue(
      `${path}.amount`,
      "The Class transaction engine requires a non-negative resolved amount.",
      "executor-amount",
      AGE_PROGRESSION_EXECUTORS.CLASS_ITEM,
      milestone,
    ));
  }
  if (effect.type === "ability.setPrimary" && milestone.rank !== 1) {
    issues.push(executableIssue(
      `${path}.type`,
      "ability.setPrimary is representable by the Class transaction engine only at rank 1.",
      "executor-class-rank-one",
      AGE_PROGRESSION_EXECUTORS.CLASS_ITEM,
      milestone,
    ));
  }
  if (effect.type === "item.acquire") {
    if ((effect.quantity ?? 1) !== 1) {
      issues.push(executableIssue(
        `${path}.quantity`,
        "Class-backed advancement can acquire exactly one Item per effect.",
        "executor-item-quantity",
        AGE_PROGRESSION_EXECUTORS.CLASS_ITEM,
        milestone,
      ));
    }
    checkSourceUuid(effect, path, sourceRefs, AGE_PROGRESSION_EXECUTORS.CLASS_ITEM, milestone, issues);
  }
  if (effect.type === "item.advance" && !ADVANCEMENT_ITEM_TRAITS.has(effect.trait)) {
    issues.push(executableIssue(
      `${path}.trait`,
      `Class-backed advancement cannot advance Item trait "${effect.trait}".`,
      "executor-item-trait",
      AGE_PROGRESSION_EXECUTORS.CLASS_ITEM,
      milestone,
    ));
  }
  if (effect.type === "track.setRank" && effect.rank !== milestone.rank) {
    issues.push(executableIssue(
      `${path}.rank`,
      `Class-backed track.setRank must equal its milestone rank ${milestone.rank}.`,
      "executor-track-rank",
      AGE_PROGRESSION_EXECUTORS.CLASS_ITEM,
      milestone,
    ));
  }
}

/**
 * Validate that every legal effect path can be represented by the current AGE
 * executor selected by its trigger and trackBinding. This is intentionally
 * additive to, not a replacement for, DefinitionV1 validation.
 */
export function validateProgressionDefinitionExecutabilityV1(definition, {trigger = null} = {}) {
  const contract = validateProgressionDefinition(definition);
  if (!contract.valid) {
    return freeze({
      valid: false,
      contractValid: false,
      executabilityValid: false,
      issues: [...contract.issues],
      checkedExecutors: [],
    });
  }

  const triggerFilter = normalizeTriggerFilter(trigger);
  const issues = [];
  const checkedExecutors = new Set();
  const sourceRefs = sourceRefMap(definition);
  definition.milestones.forEach((milestone, milestoneIndex) => {
    const contexts = executionContexts(definition, milestone, triggerFilter);
    if (!contexts.length) return;
    const entries = effectEntries(milestone, milestoneIndex);
    checkSharedRolls(entries, milestone, issues, [...new Set(contexts.map(triggerForExecutor))]);
    for (const executor of contexts) {
      checkedExecutors.add(executor);
      if (executor === AGE_PROGRESSION_EXECUTORS.CREATION) {
        entries.forEach(entry => checkCreationEffect(entry, sourceRefs, milestone, issues));
        checkCreationInitializers(entries, milestone, issues);
        checkCreationItemOrder(milestone, milestoneIndex, issues);
        checkCreationItemCardinality(milestone, milestoneIndex, entries, issues);
        if (definition.trackBinding?.kind === "actor") {
          entries.forEach(entry => checkActorTrackEffect(entry, milestone, AGE_PROGRESSION_EXECUTORS.CREATION, issues));
          checkActorTrackCardinality(milestone, milestoneIndex, AGE_PROGRESSION_EXECUTORS.CREATION, issues);
        }
      } else if (executor === AGE_PROGRESSION_EXECUTORS.CLASS_ITEM) {
        entries.forEach(entry => checkClassEffect(entry, sourceRefs, milestone, issues));
        checkClassPairs(milestone, milestoneIndex, issues);
      } else {
        entries.forEach(entry => checkActorEffect(entry, sourceRefs, milestone, issues));
        checkActorTrackCardinality(milestone, milestoneIndex, AGE_PROGRESSION_EXECUTORS.ACTOR, issues);
      }
    }
  });

  const unique = [];
  const seen = new Set();
  for (const entry of issues) {
    const key = `${entry.path}\u0000${entry.code}\u0000${entry.executor}\u0000${entry.trigger}`;
    if (!seen.has(key)) unique.push(entry);
    seen.add(key);
  }
  return freeze({
    valid: unique.length === 0,
    contractValid: true,
    executabilityValid: unique.length === 0,
    issues: unique,
    checkedExecutors: [...checkedExecutors].sort(),
  });
}

export function assertProgressionDefinitionExecutableV1(definition, options = {}) {
  const validation = validateProgressionDefinitionExecutabilityV1(definition, options);
  if (!validation.valid) {
    const error = new Error(`AGE progression definition is not executable: ${validation.issues.map(issue => `${issue.path} ${issue.message}`).join("; ")}`);
    error.name = "AgeProgressionExecutabilityValidationError";
    error.issues = validation.issues;
    throw error;
  }
  return definition;
}
