function text(value) {
  return String(value ?? "").trim();
}

export function humanizeProgressionIdentifier(value) {
  const normalized = text(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.replace(/\b\w/g, letter => letter.toUpperCase()) : "";
}

function looksTechnicalIdentifier(value) {
  const raw = text(value);
  if (!raw) return true;
  if (/^(?:grant|effect|choice|class-v\d+|item-\d+)(?::|-)/i.test(raw)) return true;
  if (/^(?:Actor|Item|Compendium)\./.test(raw)) return true;
  if (/[A-Za-z0-9]{14,}$/.test(raw)) return true;
  return false;
}

export function progressionSourceReference(definition, sourceRefId) {
  const id = text(sourceRefId);
  return definition?.sourceRefs?.find(entry => entry?.id === id) ?? null;
}

export function progressionSourceLabel(definition, sourceRefId, {fallback = "Selected Item"} = {}) {
  const source = progressionSourceReference(definition, sourceRefId);
  const authored = text(source?.label);
  if (authored) return authored;
  const id = text(sourceRefId);
  if (!id || looksTechnicalIdentifier(id)) return fallback;
  return humanizeProgressionIdentifier(id.split(":").at(-1)) || fallback;
}

export function progressionChoiceOption(definition, effect) {
  const origin = effect?.origin;
  if (origin?.kind !== "choice") return null;
  const milestone = definition?.milestones?.find(entry => entry?.id === origin.milestoneId);
  const group = milestone?.choiceGroups?.find(entry => entry?.id === origin.choiceGroupId);
  return group?.options?.find(entry => entry?.id === origin.optionId) ?? null;
}

export function progressionEffectItemLabel(definition, effect) {
  const source = progressionSourceReference(definition, effect?.sourceRefId);
  const authored = text(source?.label);
  if (authored) return authored;
  const option = progressionChoiceOption(definition, effect);
  const optionLabel = text(option?.label);
  if (optionLabel && !looksTechnicalIdentifier(optionLabel)) return optionLabel;
  return progressionSourceLabel(definition, effect?.sourceRefId);
}

export function progressionOptionDetail(option, definition) {
  const sourceIds = new Set([
    ...(option?.sourceRefIds ?? []),
    ...(option?.effects ?? []).map(effect => effect?.sourceRefId).filter(Boolean),
  ]);
  const labels = [...sourceIds]
    .map(id => text(progressionSourceReference(definition, id)?.label))
    .filter(Boolean);
  return [...new Set(labels)].filter(label => label !== text(option?.label)).join(" · ");
}

export function progressionIdentityFieldLabel(field, profile = null) {
  switch (field) {
    case "name": return "Character name";
    case "ancestry": return profile?.identity?.ancestryLabel ?? "Ancestry";
    case "class": return profile?.identity?.occupationLabel ?? "Class";
    case "background": return "Background";
    case "socialClass": return "Social class";
    case "description": return "Description";
    default: return humanizeProgressionIdentifier(field) || "Identity";
  }
}

/**
 * Detect an authored choice in which every option sets the same identity field.
 * This adds presentation metadata only; DefinitionV1 remains the sole source
 * of behavior.
 */
export function progressionIdentityStage(group, profile = null) {
  const optionFields = (group?.options ?? []).map(option => new Set(
    (option?.effects ?? [])
      .filter(effect => effect?.type === "identity.set")
      .map(effect => text(effect.field))
      .filter(Boolean),
  ));
  if (!optionFields.length || optionFields.some(fields => fields.size === 0)) return null;
  const common = [...optionFields[0]].filter(field => optionFields.every(fields => fields.has(field)));
  if (common.length !== 1) return null;
  const field = common[0];
  return Object.freeze({field, label: progressionIdentityFieldLabel(field, profile)});
}

/**
 * Evaluate one local DefinitionV2 condition block for presentation purposes.
 *
 * The compiler remains the semantic authority. Callers that have an owned
 * Character can supply its exact progression source refs and ability values.
 * Creation UIs may omit those contexts; unknown leaves then propagate through
 * composites and remain presentable until the signed preview decides them.
 */
export function progressionUiEvaluationResult(evaluations = [], {
  choices = {},
  rank = 0,
  ownedSourceRefIds = null,
  abilities = null,
} = {}) {
  if (!evaluations.length) return {available: true, reason: ""};
  const UNKNOWN = Symbol("progression-ui-evaluation-unknown");
  const ownedSourceRefs = ownedSourceRefIds === null
    ? null
    : new Set(ownedSourceRefIds);
  const byId = new Map(evaluations.map(evaluation => [evaluation.id, evaluation]));
  const referenced = new Set(evaluations.flatMap(evaluation => evaluation.evaluationIds ?? []));
  const roots = evaluations.filter(evaluation => !referenced.has(evaluation.id));
  const cache = new Map();
  const visiting = new Set();
  const evaluate = id => {
    if (cache.has(id)) return cache.get(id);
    if (visiting.has(id)) return false;
    const evaluation = byId.get(id);
    if (!evaluation) return true;
    visiting.add(id);
    let result = true;
    if (evaluation.kind === "choice.selected") {
      const selected = choices[evaluation.choiceGroupId] ?? [];
      result = evaluation.optionIds?.length
        ? selected.some(optionId => evaluation.optionIds.includes(optionId))
        : selected.length > 0;
    } else if (evaluation.kind === "rank.atLeast") {
      result = Number(rank) >= Number(evaluation.rank);
    } else if (evaluation.kind === "item.owned") {
      result = ownedSourceRefs === null ? UNKNOWN : ownedSourceRefs.has(evaluation.sourceRefId);
    } else if (evaluation.kind === "ability.minimum") {
      result = abilities === null ? UNKNOWN : (
        Number.isFinite(Number(abilities?.[evaluation.abilityId]))
        && Number(abilities[evaluation.abilityId]) >= Number(evaluation.value)
      );
    } else if (evaluation.kind === "allOf") {
      const results = (evaluation.evaluationIds ?? []).map(evaluate);
      result = results.includes(false) ? false : results.includes(UNKNOWN) ? UNKNOWN : true;
    } else if (evaluation.kind === "anyOf") {
      const results = (evaluation.evaluationIds ?? []).map(evaluate);
      result = results.includes(true) ? true : results.includes(UNKNOWN) ? UNKNOWN : false;
    } else if (evaluation.kind === "not") {
      const nested = evaluate(evaluation.evaluationIds?.[0]);
      result = nested === UNKNOWN ? UNKNOWN : !nested;
    }
    visiting.delete(id);
    cache.set(id, result);
    return result;
  };
  const rootResults = roots.map(root => evaluate(root.id));
  const available = roots.length ? rootResults.every(result => result !== false) : false;
  const indeterminate = available && rootResults.includes(UNKNOWN);
  return {
    available,
    indeterminate,
    reason: !available
      ? "Unavailable until an earlier choice or requirement is satisfied."
      : indeterminate ? "Availability will be verified by the signed preview." : "",
  };
}
