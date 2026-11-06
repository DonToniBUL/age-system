import {showConfirmDialog} from "../dialogs.js";
import {progressionProfileAdapter} from "./profile-adapters.js";
import {
  humanizeProgressionIdentifier,
  progressionEffectItemLabel,
  progressionIdentityFieldLabel,
  progressionIdentityStage,
  progressionOptionDetail,
  progressionSourceLabel,
  progressionUiEvaluationResult,
} from "./ui-labels.js";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

const SYSTEM_ID = "age-system";
const FORMULA_CACHE_MISS = Symbol("formula-cache-miss");
const CHOICE_SEARCH_THRESHOLD = 12;

function asArray(collection) {
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection?.contents)) return collection.contents;
  if (collection?.values instanceof Function) return [...collection.values()];
  if (collection?.[Symbol.iterator] instanceof Function) return [...collection];
  return [];
}

function cloneDraft(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function publicError(error) {
  const code = error?.code ?? "error";
  const message = error?.message ?? String(error);
  return {
    code,
    message,
    details: error?.details ?? null,
    dependency: /source|uuid|compendium|pack|module/i.test(`${code} ${message}`),
  };
}

function builderError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "AgeCharacterBuilderError";
  error.code = code;
  error.details = details;
  return error;
}

function activeProfileId(settingResolver) {
  try {
    const value = settingResolver(SYSTEM_ID, "activeRuleProfile");
    return typeof value === "string" && value && value !== "custom" ? value : null;
  } catch {
    return null;
  }
}

function defaultService() {
  return globalThis.game?.ageSystem?.progression ?? globalThis.game?.ageSystem?.runtime?.service ?? null;
}

function defaultSettingsResolver(namespace, key) {
  return globalThis.game?.settings?.get?.(namespace, key);
}

function defaultProfileResolver(profileId) {
  try {
    return progressionProfileAdapter(profileId);
  } catch {
    const configured = globalThis.CONFIG?.ageSystem?.abilities ?? globalThis.game?.model?.Actor?.char?.system?.abilities ?? {};
    return {
      id: profileId,
      label: profileId,
      ability: {ids: Object.keys(configured)},
      identity: {ancestryLabel: "Ancestry", occupationLabel: "Class"},
      resource: {powerPoints: true, powerFlavor: "Power Points"},
    };
  }
}

async function defaultFormulaResolver(formula, metadata) {
  const roll = await new Roll(formula, metadata?.abilityValues ?? {}).evaluate();
  await roll.toMessage?.({flavor: `Character creation · ${metadata.effectId}`});
  return Number(roll.total);
}

async function defaultUndoConfirmation({receipt, preview}) {
  const reasons = preview.reasons?.length ? `<p>${preview.reasons.join(", ")}</p>` : "";
  return showConfirmDialog({
    title: "Delete Created AGE Character",
    content: `<p>This permanently deletes <strong>${receipt.actorUuid}</strong> if it is still an exact match for creation receipt <strong>${receipt.id}</strong>.</p>${reasons}`,
    yesLabel: "Delete Created Character",
    defaultYes: false,
  });
}

function creationMilestones(definition) {
  return (definition?.milestones ?? [])
    .filter(milestone => milestone.triggers?.includes("character.create"))
    .slice()
    .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
}

function creationMilestone(definition, rank) {
  return creationMilestones(definition).find(milestone => milestone.rank === rank) ?? null;
}

function choiceDefaults(milestone) {
  return Object.fromEntries((milestone?.choiceGroups ?? []).map(group => {
    const conditional = group.evaluations?.length || group.options.some(option => option.evaluations?.length);
    const forced = group.minimum === group.maximum && group.maximum === group.options.length;
    const only = group.minimum === 1 && group.maximum === 1 && group.options.length === 1;
    return [group.id, !conditional && (forced || only) ? group.options.map(option => option.id) : []];
  }));
}

function selectedOptions(group, choices) {
  const requested = new Set(Array.isArray(choices?.[group.id]) ? choices[group.id] : []);
  return group.options.filter(option => requested.has(option.id));
}

/**
 * Recreate the compiler's deterministic effect occurrence ids for creation
 * input presentation. The progression compiler remains the semantic authority.
 */
export function progressionCreationInputOccurrences(definition, rank, choices = {}) {
  const milestone = creationMilestone(definition, rank);
  if (!milestone) return [];
  const occurrences = milestone.effects.map(effect => ({
    ...effect,
    operationId: `${milestone.id}:direct:${effect.id}`,
    origin: {kind: "milestone", milestoneId: milestone.id},
  }));
  for (const group of milestone.choiceGroups) {
    selectedOptions(group, choices).forEach((option, selectionIndex) => {
      occurrences.push(...option.effects.map(effect => ({
        ...effect,
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

function abilityName(id) {
  const configured = globalThis.CONFIG?.ageSystem?.abilities?.[id]
    ?? globalThis.CONFIG?.ageSystem?.ability?.[id]
    ?? null;
  if (typeof configured === "string") return configured;
  if (configured?.name) return globalThis.game?.i18n?.localize?.(configured.name) ?? configured.name;
  return id;
}

function effectAmount(effect) {
  return typeof effect?.amount === "number" ? effect.amount : null;
}

function formulaLabel(effect) {
  return effect?.resolution?.formula ?? effect?.amount?.formula ?? null;
}

function formulaCacheKey(effect) {
  return effect?.resolution?.rollId ?? effect?.amount?.rollId ?? effect?.operationId;
}

function identityFieldLabel(field, profile) {
  return progressionIdentityFieldLabel(field, profile);
}

function semanticInputReference(value) {
  return value && typeof value === "object" && !Array.isArray(value) && value.kind === "input"
    ? String(value.inputId ?? "")
    : null;
}

function humanizeIdentifier(value) {
  return humanizeProgressionIdentifier(value);
}

function sourceRefLabel(definition, sourceRefId) {
  return progressionSourceLabel(definition, sourceRefId);
}

function optionDetail(option, definition) {
  return progressionOptionDetail(option, definition);
}

function milestoneLabel(milestone) {
  const finalId = String(milestone?.id ?? "").split(":").at(-1);
  const label = humanizeIdentifier(finalId);
  return label && !/^rank\s*\d+$/i.test(label) ? label : "Character creation";
}

function effectLabel(effect, profile, definition, semanticInputs = {}) {
  const amount = typeof effect?.amount === "number"
    ? effect.amount
    : effect?.amount?.kind === "formula" ? effect.amount.formula : effect?.amount;
  switch (effect.type) {
    case "identity.set": {
      const inputId = semanticInputReference(effect.value);
      const value = inputId ? String(semanticInputs[inputId] ?? "").trim() : effect.value;
      return `${identityFieldLabel(effect.field, profile)}: ${value || "—"}`;
    }
    case "resource.initialize": return `Start ${humanizeIdentifier(effect.resource)} at ${amount}`;
    case "resource.gain": return `${humanizeIdentifier(effect.resource)} +${amount}`;
    case "classBonus.gain": return `${humanizeIdentifier(effect.bonus)} bonus +${amount}`;
    case "ability.allocate": return `Allocate ${amount ?? "?"} ability point(s)`;
    case "ability.set": {
      const inputId = semanticInputReference(effect.value);
      const value = inputId ? semanticInputs[inputId] ?? "—" : effect.value;
      return `Set ${abilityName(effect.abilityId)} to ${value}`;
    }
    case "ability.setPrimary": return `Set ${abilityName(effect.abilityId)} primary`;
    case "weaponGroup.add": return `Add weapon group: ${humanizeIdentifier(effect.weaponGroupId)}`;
    case "language.add": {
      const inputId = semanticInputReference(effect.value);
      const value = inputId ? semanticInputs[inputId] ?? "—" : effect.value;
      return `Add language: ${value}`;
    }
    case "item.acquire": return `Acquire ${progressionEffectItemLabel(definition, effect)}`;
    case "item.advance": return `Advance ${humanizeIdentifier(effect.trait)}`;
    case "track.setRank": return effect.trackId === "level"
      ? `Start at level ${effect.rank}`
      : `Set ${humanizeIdentifier(effect.trackId)} rank to ${effect.rank}`;
    case "summary.add": return effect.label;
    default: return effect.type;
  }
}

function validationMessages(validation) {
  if (!validation || validation.valid !== false) return [];
  return (validation.errors ?? validation.issues ?? []).map(error => {
    if (typeof error === "string") return error;
    return `${error.path ?? "$"}: ${error.message ?? error.code ?? "Invalid definition"}`;
  });
}

function definitionReadinessMessages(service, definition, trigger) {
  if (!definition) return [];
  const validations = [];
  try {
    validations.push(service?.validateDefinition?.(definition) ?? {valid: true});
    if (service?.validateExecutability instanceof Function) {
      validations.push(service.validateExecutability(definition, {trigger}));
    }
  } catch (error) {
    return [`Progression readiness could not be checked: ${error?.message ?? String(error)}`];
  }
  return uniqueMessages(validations.flatMap(validationMessages));
}

function semanticInputError(input, value, {nameInput = false} = {}) {
  const blank = value === undefined || value === null || (typeof value === "string" && !value.trim());
  if (!input?.required && blank) return null;
  if (input?.type === "integer") {
    const number = typeof value === "string" && value.trim() ? Number(value) : value;
    if (!Number.isInteger(number)) return `${input?.label ?? input?.id}: enter a whole number.`;
    const minimum = Number.isInteger(input.minimum) ? input.minimum : Number.MIN_SAFE_INTEGER;
    const maximum = Number.isInteger(input.maximum) ? input.maximum : Number.MAX_SAFE_INTEGER;
    return number < minimum || number > maximum
      ? `${input?.label ?? input?.id}: enter ${minimum}-${maximum}.`
      : null;
  }
  if (input?.type === "select") {
    const allowed = new Set((input.options ?? []).map(option => option.value));
    return allowed.has(value) ? null : `${input?.label ?? input?.id}: choose an available option.`;
  }
  const raw = String(value ?? "");
  const normalized = raw.trim();
  const minimum = Math.max(Number.isInteger(input?.minLength) ? input.minLength : 0, input?.required ? 1 : 0);
  const maximum = Math.min(Number.isInteger(input?.maxLength) ? input.maxLength : 4096, nameInput ? 128 : 4096);
  const forbidden = input?.type === "longText" ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (forbidden.test(raw)) return `${input?.label ?? input?.id} contains control characters.`;
  if (normalized.length < minimum || normalized.length > maximum) {
    return `${input?.label ?? input?.id}: enter ${minimum}-${maximum} characters.`;
  }
  return null;
}

function uniqueMessages(messages) {
  return [...new Set(messages.map(message => String(message ?? "").trim()).filter(Boolean))];
}

function commitBlockerModels({
  busy,
  definitionErrors,
  inputErrors,
  previewError,
  preview,
  previewExpired,
}) {
  const blockers = [];
  if (busy) blockers.push("Please wait while the signed preview is being prepared.");
  blockers.push(...definitionErrors, ...inputErrors);
  if (previewError?.message) {
    blockers.push(previewError.dependency
      ? `Required progression content is unavailable. Enable or restore its module or compendium, then refresh the review. ${previewError.message}`
      : `Preview unavailable: ${previewError.message}`);
  }
  if (previewExpired) blockers.push("The signed preview expired. Refresh the review before creating the Character.");
  else if (!preview && blockers.length === 0) blockers.push("Refresh the review to create a signed preview.");
  return uniqueMessages(blockers).map((message, index) => ({id: `create-blocker-${index + 1}`, message}));
}

function normalizedAllocations(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const [abilityId, raw] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    const amount = Number(raw);
    if (!Number.isInteger(amount) || amount < 0) return null;
    if (amount > 0) result[abilityId] = amount;
  }
  return result;
}

function samePlainValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function receiptFromResult(result) {
  if (result?.receipt && typeof result.receipt === "object") return cloneDraft(result.receipt);
  if (result?.kind === "character.create") return cloneDraft(result);
  return null;
}

function actorUuidFromResult(result, receipt) {
  return String(result?.actorUuid ?? result?.actor?.uuid ?? receipt?.actorUuid ?? "");
}

function actorNameFromUuid(uuid) {
  const id = String(uuid ?? "").split(".").at(-1);
  const actor = globalThis.game?.actors?.get?.(id)
    ?? asArray(globalThis.game?.actors).find(entry => String(entry?.uuid ?? "") === String(uuid ?? ""));
  return String(actor?.name ?? "").trim();
}

function dateLabel(value, fallback) {
  const stamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toLocaleString() : fallback;
}

export class AgeCharacterBuilderController {
  #service;
  #settingResolver;
  #profileResolver;
  #formulaResolver;
  #confirmer;
  #initialDefinitionId;
  #definitions = [];
  #generation = 0;
  #formulaCache = new Map();
  #commitPromise = null;
  #undoPromise = null;

  constructor({
    service = defaultService(),
    settingResolver = defaultSettingsResolver,
    profileResolver = defaultProfileResolver,
    formulaResolver = defaultFormulaResolver,
    confirmer = defaultUndoConfirmation,
    definitionId = null,
  } = {}) {
    if (!(service?.listDefinitions instanceof Function)
      || !(service?.previewCreation instanceof Function)
      || !(service?.commitCreation instanceof Function)) {
      throw builderError("service-unavailable", "AGE Character Builder requires the AGE progression service.");
    }
    this.#service = service;
    this.#settingResolver = settingResolver;
    this.#profileResolver = profileResolver;
    this.#formulaResolver = formulaResolver;
    this.#confirmer = confirmer;
    this.#initialDefinitionId = definitionId;
    this.state = {
      initialized: false,
      definitionId: definitionId ?? "",
      rank: null,
      choices: {},
      abilityAllocations: {},
      semanticInputs: {},
      preview: null,
      previewError: null,
      inputErrors: [],
      busy: false,
      receipt: null,
      actorUuid: "",
      actorName: "",
      undoPreview: null,
      undoError: null,
    };
  }

  get service() { return this.#service; }
  get definition() { return this.#definitions.find(definition => definition.id === this.state.definitionId) ?? null; }

  profile() {
    const profileId = this.definition?.profileId ?? activeProfileId(this.#settingResolver);
    if (!profileId) return null;
    try { return this.#profileResolver(profileId); }
    catch { return null; }
  }

  async initialize({preview = true} = {}) {
    this.#refreshDefinitions();
    this.#selectInitialDefinition();
    this.#selectInitialRank();
    this.#resetInputs();
    this.state.initialized = true;
    if (preview) await this.refreshPreview();
    return this;
  }

  #refreshDefinitions() {
    const profileId = activeProfileId(this.#settingResolver);
    const definitions = asArray(this.#service.listDefinitions(profileId ? {profileId} : {}));
    this.#definitions = definitions.filter(definition => creationMilestones(definition).length > 0);
  }

  #selectInitialDefinition() {
    const requested = this.state.definitionId || this.#initialDefinitionId;
    this.state.definitionId = this.#definitions.some(definition => definition.id === requested)
      ? requested
      : this.#definitions[0]?.id ?? "";
  }

  #selectInitialRank() {
    const ranks = creationMilestones(this.definition).map(milestone => milestone.rank);
    this.state.rank = ranks.includes(Number(this.state.rank)) ? Number(this.state.rank) : (ranks[0] ?? null);
  }

  #milestone() {
    return creationMilestone(this.definition, this.state.rank);
  }

  #resetInputs() {
    this.#generation += 1;
    this.#formulaCache.clear();
    this.state.preview = null;
    this.state.previewError = null;
    this.state.inputErrors = [];
    this.state.receipt = null;
    this.state.actorUuid = "";
    this.state.actorName = "";
    this.state.undoPreview = null;
    this.state.undoError = null;
    this.state.choices = choiceDefaults(this.#milestone());
    this.state.abilityAllocations = {};
    this.state.semanticInputs = Object.fromEntries((this.#milestone()?.inputs ?? []).map(input => [
      input.id,
      input.default ?? (input.type === "integer" ? "" : ""),
    ]));
    this.#reconcileInputs();
  }

  #abilityIds(effect) {
    const profileIds = asArray(this.profile()?.ability?.ids).map(String);
    const eligible = asArray(effect.eligibleAbilityIds).map(String);
    if (eligible.length && profileIds.length) {
      const allowed = new Set(profileIds);
      return eligible.filter(id => allowed.has(id));
    }
    return eligible.length ? eligible : profileIds;
  }

  #reconcileInputs() {
    const milestone = this.#milestone();
    for (const group of milestone?.choiceGroups ?? []) {
      const status = progressionUiEvaluationResult(group.evaluations, {choices: this.state.choices, rank: this.state.rank});
      if (!status.available) {
        this.state.choices[group.id] = [];
        continue;
      }
      const availableOptionEntries = group.options.map(option => {
        const hypothetical = cloneDraft(this.state.choices);
        hypothetical[group.id] = [...new Set([...(hypothetical[group.id] ?? []), option.id])];
        return {
          option,
          status: progressionUiEvaluationResult(option.evaluations, {choices: hypothetical, rank: this.state.rank}),
        };
      }).filter(entry => entry.status.available);
      const availableOptions = availableOptionEntries.map(entry => entry.option);
      const availableIds = new Set(availableOptions.map(option => option.id));
      const selected = (this.state.choices[group.id] ?? []).filter(optionId => availableIds.has(optionId));
      this.state.choices[group.id] = selected;
      const automatic = !status.indeterminate && availableOptionEntries.every(entry => !entry.status.indeterminate);
      const forced = automatic && group.minimum === group.maximum && group.maximum === availableOptions.length;
      const only = automatic && group.minimum === 1 && group.maximum === 1 && availableOptions.length === 1;
      if (!selected.length && (forced || only)) this.state.choices[group.id] = availableOptions.map(option => option.id);
    }
    const occurrences = progressionCreationInputOccurrences(this.definition, this.state.rank, this.state.choices);
    const next = {};
    for (const effect of occurrences.filter(entry => entry.type === "ability.allocate")) {
      const abilityIds = this.#abilityIds(effect);
      const previous = this.state.abilityAllocations[effect.operationId] ?? {};
      const values = Object.fromEntries(abilityIds.map(id => [id, Math.max(0, Math.trunc(Number(previous[id]) || 0))]));
      const amount = effectAmount(effect);
      if (amount !== null && abilityIds.length === 1 && Object.values(values).every(value => value === 0)) values[abilityIds[0]] = amount;
      next[effect.operationId] = values;
    }
    this.state.abilityAllocations = next;
    const previousInputs = this.state.semanticInputs ?? {};
    this.state.semanticInputs = Object.fromEntries((this.#milestone()?.inputs ?? []).map(input => [
      input.id,
      Object.hasOwn(previousInputs, input.id) ? previousInputs[input.id] : (input.default ?? ""),
    ]));
  }

  async selectDefinition(definitionId) {
    this.state.definitionId = String(definitionId ?? "");
    this.state.rank = null;
    this.#selectInitialRank();
    this.#resetInputs();
    return this.refreshPreview();
  }

  async selectRank(rank) {
    this.state.rank = Number(rank);
    this.#resetInputs();
    return this.refreshPreview();
  }

  async setChoice(groupId, optionId, checked) {
    const group = this.#milestone()?.choiceGroups?.find(entry => entry.id === groupId);
    if (!group || !group.options.some(option => option.id === optionId)) return null;
    const groupStatus = progressionUiEvaluationResult(group.evaluations, {choices: this.state.choices, rank: this.state.rank});
    const option = group.options.find(entry => entry.id === optionId);
    const hypothetical = cloneDraft(this.state.choices);
    hypothetical[groupId] = [...new Set([...(hypothetical[groupId] ?? []), optionId])];
    const optionStatus = progressionUiEvaluationResult(option.evaluations, {choices: hypothetical, rank: this.state.rank});
    if (checked && (!groupStatus.available || !optionStatus.available)) return null;
    const selected = new Set(this.state.choices[groupId] ?? []);
    if (checked) {
      if (group.maximum === 1) selected.clear();
      if (selected.size < group.maximum) selected.add(optionId);
    } else selected.delete(optionId);
    this.state.choices[groupId] = group.options.filter(option => selected.has(option.id)).map(option => option.id);
    this.#formulaCache.clear();
    this.#invalidatePreview();
    this.#reconcileInputs();
    return this.refreshPreview();
  }

  async setAbilityAllocation(operationId, abilityId, value) {
    const allocations = this.state.abilityAllocations[operationId];
    if (!allocations || !Object.hasOwn(allocations, abilityId)) return null;
    allocations[abilityId] = Math.max(0, Math.trunc(Number(value) || 0));
    this.#formulaCache.clear();
    this.#invalidatePreview();
    return this.refreshPreview();
  }

  async setSemanticInput(inputId, value) {
    if (!Object.hasOwn(this.state.semanticInputs, inputId)) return null;
    const input = this.#milestone()?.inputs?.find(entry => entry.id === inputId);
    this.state.semanticInputs[inputId] = input?.type === "integer" && String(value ?? "").trim()
      ? Number(value)
      : String(value ?? "");
    this.#invalidatePreview();
    return this.refreshPreview();
  }

  async rerollFormula(operationId) {
    const effects = this.state.preview?.resolvedEffects
      ?? progressionCreationInputOccurrences(this.definition, this.state.rank, this.state.choices);
    const effect = effects.find(entry => entry.operationId === operationId);
    this.#formulaCache.delete(effect ? formulaCacheKey(effect) : operationId);
    this.#invalidatePreview();
    return this.refreshPreview();
  }

  #invalidatePreview() {
    this.#generation += 1;
    this.state.preview = null;
    this.state.previewError = null;
  }

  #allocationPayload() {
    return Object.fromEntries(Object.entries(this.state.abilityAllocations).map(([operationId, allocations]) => [
      operationId,
      normalizedAllocations(allocations) ?? {},
    ]));
  }

  #semanticInputPayload() {
    const inputs = new Map((this.#milestone()?.inputs ?? []).map(input => [input.id, input]));
    return Object.fromEntries(Object.entries(this.state.semanticInputs).flatMap(([inputId, value]) => {
      const input = inputs.get(inputId);
      const blank = value === undefined || value === null || (typeof value === "string" && !value.trim());
      if (!input?.required && blank) return [];
      return [[inputId, input?.type === "integer" ? Number(value) : String(value ?? "").trim()]];
    }));
  }

  #inputErrors() {
    const errors = [];
    if (!this.definition) errors.push("Select a registered character-creation definition.");
    const milestone = this.#milestone();
    if (this.definition && !milestone) errors.push("Select a valid character.create milestone.");
    if (this.definition && !this.profile()) errors.push(`Rules profile "${this.definition.profileId}" is unavailable.`);
    errors.push(...definitionReadinessMessages(this.#service, this.definition, "character.create"));
    for (const group of milestone?.choiceGroups ?? []) {
      const status = progressionUiEvaluationResult(group.evaluations, {choices: this.state.choices, rank: this.state.rank});
      if (!status.available || status.indeterminate) continue;
      const selected = this.state.choices[group.id] ?? [];
      if (selected.length < group.minimum || selected.length > group.maximum) {
        errors.push(`${group.label}: select ${group.minimum === group.maximum ? group.minimum : `${group.minimum}-${group.maximum}`} option(s).`);
      }
    }
    const nameInputs = new Set(progressionCreationInputOccurrences(this.definition, this.state.rank, this.state.choices)
      .filter(effect => effect.type === "identity.set" && effect.field === "name")
      .map(effect => semanticInputReference(effect.value))
      .filter(Boolean));
    for (const input of milestone?.inputs ?? []) {
      const value = String(this.state.semanticInputs[input.id] ?? "");
      const error = semanticInputError(input, value, {nameInput: nameInputs.has(input.id)});
      if (error) errors.push(error);
    }
    const occurrences = progressionCreationInputOccurrences(this.definition, this.state.rank, this.state.choices);
    for (const effect of occurrences.filter(entry => entry.type === "ability.allocate")) {
      const points = effectAmount(effect);
      const abilityIds = this.#abilityIds(effect);
      if (points === null) {
        errors.push(`Ability allocation "${effect.id}" has no fixed integer amount.`);
        continue;
      }
      if (!abilityIds.length) {
        errors.push(`Ability allocation "${effect.id}" has no abilities in the selected profile.`);
        continue;
      }
      const allocations = this.state.abilityAllocations[effect.operationId] ?? {};
      const spent = Object.values(allocations).reduce((sum, amount) => sum + Number(amount || 0), 0);
      if (spent !== points) errors.push(`Allocate exactly ${points} ability point(s) for ${effect.id}; ${spent} selected.`);
    }
    return errors;
  }

  async #resolveFormula(formula, metadata) {
    const key = metadata.rollId ?? metadata.operationId;
    const cached = this.#formulaCache.has(key) ? this.#formulaCache.get(key) : FORMULA_CACHE_MISS;
    if (cached !== FORMULA_CACHE_MISS) return Number(await cached);
    const pending = Promise.resolve(this.#formulaResolver(formula, metadata)).then(Number);
    this.#formulaCache.set(key, pending);
    try {
      const result = await pending;
      if (!Number.isFinite(result)) throw builderError("formula-result", `Formula "${formula}" did not produce a finite total.`);
      if (this.#formulaCache.get(key) === pending) this.#formulaCache.set(key, result);
      return result;
    } catch (error) {
      if (this.#formulaCache.get(key) === pending) this.#formulaCache.delete(key);
      throw error;
    }
  }

  #assertSignedInputBindings(preview, requestedAllocations, requestedSemanticInputs) {
    if (!preview || !Array.isArray(preview.resolvedEffects)) {
      throw builderError("preview-bindings", "Creation preview does not contain resolved effects.");
    }
    const resolvedById = new Map(preview.resolvedEffects.map(effect => [effect.operationId, effect]));
    const occurrences = progressionCreationInputOccurrences(this.definition, this.state.rank, this.state.choices);
    for (const effect of occurrences.filter(entry => entry.type === "ability.allocate")) {
      const requested = normalizedAllocations(requestedAllocations[effect.operationId]);
      const resolved = resolvedById.get(effect.operationId);
      const signed = normalizedAllocations(resolved?.allocations ?? resolved?.resolution?.allocations);
      const eligible = this.#abilityIds(effect);
      // The creation executor deterministically resolves a one-ability effect;
      // multi-ability input must be explicitly present in the signed preview.
      const safeSingleton = eligible.length === 1
        && requested?.[eligible[0]] === effectAmount(effect)
        && signed === null;
      if (!safeSingleton && (!requested || !signed || !samePlainValue(requested, signed))) {
        throw builderError(
          "allocation-not-signed",
          `Creation preview did not sign the requested allocation for "${effect.operationId}".`,
          {operationId: effect.operationId, requested, signed},
        );
      }
    }

    if (!samePlainValue(preview.semanticInputs ?? {}, requestedSemanticInputs)) {
      throw builderError("semantic-input-not-signed", "Creation preview did not sign the requested semantic inputs.", {
        requested: requestedSemanticInputs,
        signed: preview.semanticInputs ?? {},
      });
    }
    for (const effect of occurrences.filter(entry => entry.type === "identity.set" && semanticInputReference(entry.value))) {
      const inputId = semanticInputReference(effect.value);
      const resolved = resolvedById.get(effect.operationId);
      if (resolved?.resolution?.kind !== "input"
        || resolved.resolution.inputId !== inputId
        || resolved.value !== requestedSemanticInputs[inputId]
        || resolved.resolution.value !== requestedSemanticInputs[inputId]) {
        throw builderError(
          "semantic-input-not-signed",
          `Creation preview did not bind semantic input "${inputId}" to "${effect.operationId}".`,
          {operationId: effect.operationId, inputId},
        );
      }
    }

    const acquired = [...new Set(preview.resolvedEffects
      .filter(effect => effect.type === "item.acquire")
      .map(effect => effect.sourceRefId))].sort();
    const snapshots = asArray(preview.sourceSnapshots).map(binding => binding?.sourceRefId).sort();
    if (!samePlainValue(acquired, snapshots)) {
      throw builderError("source-not-signed", "Creation preview did not pin every selected Item source.", {acquired, snapshots});
    }
  }

  async refreshPreview() {
    const ticket = ++this.#generation;
    this.state.preview = null;
    this.state.previewError = null;
    this.state.inputErrors = this.#inputErrors();
    if (this.state.inputErrors.length) {
      // An input can become incomplete while an older preview request is in
      // flight. The older ticket is no longer allowed to clear UI state, so
      // the current generation must release the busy state itself.
      this.state.busy = false;
      return null;
    }
    this.state.busy = true;
    const requestedAllocations = this.#allocationPayload();
    const requestedSemanticInputs = this.#semanticInputPayload();
    try {
      const definition = this.definition;
      const preview = await this.#service.previewCreation({
        definitionId: definition.id,
        rank: this.state.rank,
        profileId: definition.profileId,
        choices: cloneDraft(this.state.choices),
        abilityAllocations: cloneDraft(requestedAllocations),
        semanticInputs: cloneDraft(requestedSemanticInputs),
        resolveFormula: (formula, metadata) => this.#resolveFormula(formula, metadata),
      });
      if (ticket !== this.#generation) return null;
      this.#assertSignedInputBindings(preview, requestedAllocations, requestedSemanticInputs);
      this.state.preview = preview;
      return preview;
    } catch (error) {
      if (ticket === this.#generation) this.state.previewError = publicError(error);
      return null;
    } finally {
      if (ticket === this.#generation) this.state.busy = false;
    }
  }

  async commitPreview() {
    if (this.#commitPromise) return this.#commitPromise;
    const preview = this.state.preview;
    if (!preview || this.isPreviewExpired()) throw builderError("preview-required", "Create a current valid character preview before committing.");
    this.#commitPromise = (async () => {
      this.state.busy = true;
      try {
        // This is intentionally the complete client commit payload.
        const result = await this.#service.commitCreation(preview.previewId, preview.planDigest);
        const receipt = receiptFromResult(result);
        if (!receipt || receipt.kind !== "character.create") throw builderError("receipt-invalid", "Character creation did not return a normalized creation receipt.");
        this.state.receipt = receipt;
        this.state.actorUuid = actorUuidFromResult(result, receipt);
        const signedName = preview.resolvedEffects?.find(effect => effect.type === "identity.set" && effect.field === "name")?.value;
        this.state.actorName = String(result?.actor?.name ?? signedName ?? actorNameFromUuid(this.state.actorUuid) ?? "").trim();
        this.state.preview = null;
        return result;
      } catch (error) {
        this.state.previewError = publicError(error);
        if (/stale|expired|digest|consumed/.test(String(error?.code ?? error?.message ?? "").toLowerCase())) this.state.preview = null;
        throw error;
      } finally {
        this.state.busy = false;
      }
    })();
    try { return await this.#commitPromise; }
    finally { this.#commitPromise = null; }
  }

  async undoReceipt(receiptId = this.state.receipt?.id) {
    if (this.#undoPromise) return this.#undoPromise;
    this.#undoPromise = this.#undoReceipt(receiptId);
    try { return await this.#undoPromise; }
    finally { this.#undoPromise = null; }
  }

  async #undoReceipt(receiptId) {
    if (!receiptId) throw builderError("receipt-missing", "No character-creation receipt is selected.");
    const receipt = await this.#service.lookupReceipt?.(receiptId) ?? this.#service.getReceipt?.(receiptId) ?? this.state.receipt;
    if (!receipt || receipt.kind !== "character.create") throw builderError("receipt-missing", `Creation receipt "${receiptId}" is unavailable.`);
    const undoPreview = await this.#service.previewUndo(receiptId);
    this.state.undoPreview = undoPreview;
    const exactDestructivePreview = undoPreview?.allowed === true
      && undoPreview?.destructive === true
      && undoPreview?.requiresConfirmation === true;
    if (!exactDestructivePreview) {
      const reasons = undoPreview?.reasons?.length ? undoPreview.reasons : ["exact-destructive-preview-required"];
      this.state.undoError = {message: reasons.join(", ")};
      return null;
    }
    const confirmed = await this.#confirmer({receipt, preview: undoPreview});
    if (confirmed !== true) return null;
    this.state.busy = true;
    try {
      const result = await this.#service.undo(receiptId, {
        confirmed: true,
        undoPreviewId: undoPreview.undoPreviewId ?? null,
        undoDigest: undoPreview.undoDigest ?? null,
      });
      this.state.receipt = receiptFromResult(result) ?? {...receipt, state: "undone"};
      this.state.undoError = null;
      return result;
    } catch (error) {
      this.state.undoError = publicError(error);
      throw error;
    } finally {
      this.state.busy = false;
    }
  }

  isPreviewExpired(now = Date.now()) {
    return !this.state.preview
      || !Number.isFinite(Date.parse(this.state.preview.expiresAt))
      || Date.parse(this.state.preview.expiresAt) <= now;
  }

  #definitionModels() {
    return this.#definitions.map(definition => {
      const provider = this.#service.provider?.(definition.id) ?? null;
      return {
        id: definition.id,
        label: provider?.label ?? definition.sourceRefs?.[0]?.label ?? definition.id,
        version: definition.version,
        profileId: definition.profileId,
        providerKind: provider?.kind ?? "definition",
        selected: definition.id === this.state.definitionId,
      };
    });
  }

  #choiceGroupModels() {
    const milestone = this.#milestone();
    const stages = milestone?.stages ?? [];
    return (milestone?.choiceGroups ?? []).map(group => {
      const selected = new Set(this.state.choices[group.id] ?? []);
      const status = progressionUiEvaluationResult(group.evaluations, {choices: this.state.choices, rank: this.state.rank});
      const stageId = group.stageId ?? stages.find(stage => stage.choiceGroupIds?.includes(group.id))?.id ?? null;
      return {
        ...group,
        available: status.available,
        indeterminate: status.indeterminate,
        unavailableReason: status.reason,
        identityStage: progressionIdentityStage(group, this.profile()),
        instruction: group.minimum === group.maximum ? `Choose ${group.minimum}` : `Choose ${group.minimum}-${group.maximum}`,
        searchable: group.options.length >= CHOICE_SEARCH_THRESHOLD,
        selectedCount: selected.size,
        optionCount: group.options.length,
        workflowStageId: stageId ? `definition-${stageId}` : "choices",
        options: group.options.map(option => {
          const detail = optionDetail(option, this.definition);
          const hypothetical = cloneDraft(this.state.choices);
          hypothetical[group.id] = [...new Set([...(hypothetical[group.id] ?? []), option.id])];
          const optionStatus = progressionUiEvaluationResult(option.evaluations, {choices: hypothetical, rank: this.state.rank});
          return {
            ...option,
            detail,
            searchText: `${option.label} ${detail} ${option.id}`.toLocaleLowerCase(),
            selected: selected.has(option.id),
            available: optionStatus.available,
            indeterminate: optionStatus.indeterminate,
            unavailableReason: optionStatus.reason,
          };
        }),
      };
    });
  }

  #abilityModels(occurrences) {
    return occurrences.filter(effect => effect.type === "ability.allocate").map(effect => {
      const allocations = this.state.abilityAllocations[effect.operationId] ?? {};
      const points = effectAmount(effect);
      const spent = Object.values(allocations).reduce((sum, amount) => sum + Number(amount || 0), 0);
      return {
        operationId: effect.operationId,
        label: effectLabel(effect, this.profile(), this.definition),
        points: points ?? "?",
        spent,
        remaining: points === null ? "?" : points - spent,
        options: this.#abilityIds(effect).map(id => ({id, name: abilityName(id), allocation: allocations[id] ?? 0})),
      };
    });
  }

  #receiptModels() {
    const entries = this.#service.receipts instanceof Function
      ? asArray(this.#service.receipts({kind: "character.create", state: "committed"}))
      : [];
    if (this.state.receipt?.state === "committed" && !entries.some(receipt => receipt.id === this.state.receipt.id)) entries.push(this.state.receipt);
    return entries.slice().sort((left, right) => Number(right.committedAt ?? 0) - Number(left.committedAt ?? 0)).map(receipt => {
      const definition = this.#definitions.find(entry => entry.id === receipt.definitionId) ?? null;
      const provider = this.#service.provider?.(receipt.definitionId) ?? null;
      return {
        ...receipt,
        actorLabel: actorNameFromUuid(receipt.actorUuid) || "Created Character",
        definitionLabel: provider?.label ?? definition?.sourceRefs?.[0]?.label ?? "Character creation path",
        stateLabel: receipt.state === "undone" ? "Deleted by exact undo" : "Created",
        createdLabel: dateLabel(receipt.committedAt ?? receipt.createdAt, "Recorded creation"),
      };
    });
  }

  context(now = Date.now()) {
    const definition = this.definition;
    const profile = this.profile();
    const anticipated = progressionCreationInputOccurrences(definition, this.state.rank, this.state.choices);
    const effects = this.state.preview?.resolvedEffects ?? anticipated;
    const definitionErrors = definitionReadinessMessages(this.#service, definition, "character.create");
    const expiresAt = this.state.preview ? Date.parse(this.state.preview.expiresAt) : null;
    const remainingMs = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : null;
    const acquiredIds = new Set(effects.filter(effect => effect.type === "item.acquire").map(effect => effect.sourceRefId));
    const nameInputIds = new Set(anticipated
      .filter(effect => effect.type === "identity.set" && effect.field === "name")
      .map(effect => semanticInputReference(effect.value))
      .filter(Boolean));
    const semanticInputsComplete = (this.#milestone()?.inputs ?? []).every(input => !semanticInputError(
      input,
      this.state.semanticInputs[input.id],
      {nameInput: nameInputIds.has(input.id)},
    ));
    const previewExpired = Boolean(this.state.preview) && remainingMs === 0;
    const pathComplete = Boolean(definition && this.#milestone() && profile)
      && definitionErrors.length === 0
      && semanticInputsComplete;
    const choicesComplete = pathComplete && this.state.inputErrors.length === 0;
    const reviewComplete = choicesComplete && Boolean(this.state.preview) && !previewExpired;
    const milestone = this.#milestone();
    const authoredStages = milestone?.stages ?? [];
    const inputById = new Map((milestone?.inputs ?? []).map(input => [input.id, input]));
    const groupById = new Map((milestone?.choiceGroups ?? []).map(group => [group.id, group]));
    const assignedInputs = new Set(authoredStages.flatMap(stage => stage.inputIds ?? []));
    const assignedGroups = new Set(authoredStages.flatMap(stage => stage.choiceGroupIds ?? []));
    const stageComplete = stage => {
      const inputsReady = (stage.inputIds ?? []).every(inputId => {
        const input = inputById.get(inputId);
        return input && !semanticInputError(input, this.state.semanticInputs[inputId], {nameInput: nameInputIds.has(inputId)});
      });
      const groupsReady = (stage.choiceGroupIds ?? []).every(groupId => {
        const group = groupById.get(groupId);
        if (!group) return false;
        const status = progressionUiEvaluationResult(group.evaluations, {choices: this.state.choices, rank: this.state.rank});
        if (!status.available || status.indeterminate) return true;
        const selected = this.state.choices[group.id] ?? [];
        return selected.length >= group.minimum && selected.length <= group.maximum;
      });
      return inputsReady && groupsReady;
    };
    const unassignedInputsReady = (milestone?.inputs ?? []).filter(input => !assignedInputs.has(input.id)).every(input => (
      !semanticInputError(input, this.state.semanticInputs[input.id], {nameInput: nameInputIds.has(input.id)})
    ));
    const unassignedGroupsReady = (milestone?.choiceGroups ?? []).filter(group => !assignedGroups.has(group.id)).every(group => {
      const status = progressionUiEvaluationResult(group.evaluations, {choices: this.state.choices, rank: this.state.rank});
      if (!status.available || status.indeterminate) return true;
      const selected = this.state.choices[group.id] ?? [];
      return selected.length >= group.minimum && selected.length <= group.maximum;
    });
    const abilityReady = this.#abilityModels(anticipated).every(group => Number(group.remaining) === 0);
    const middleStages = authoredStages.map(stage => ({
      id: `definition-${stage.id}`,
      label: stage.label,
      complete: stageComplete(stage),
    }));
    if (!authoredStages.length || !unassignedInputsReady || !unassignedGroupsReady || !abilityReady) {
      middleStages.push({id: "choices", label: "Choices and abilities", complete: choicesComplete});
    }
    const workflowStages = [
      {id: "path", label: "Choose the path", complete: Boolean(definition && milestone && profile) && definitionErrors.length === 0},
      ...middleStages,
      {id: "review", label: "Review and create", complete: reviewComplete || this.state.receipt?.state === "committed"},
    ].map((stage, index, stages) => ({
      ...stage,
      number: index + 1,
      current: stages.slice(0, index).every(previous => previous.complete) && !stage.complete,
    }));
    const commitBlockers = commitBlockerModels({
      busy: this.state.busy,
      definitionErrors,
      inputErrors: this.state.inputErrors,
      previewError: this.state.previewError,
      preview: this.state.preview,
      previewExpired,
    });
    const receiptResult = this.state.receipt ? {
      ...this.state.receipt,
      actorLabel: this.state.actorName || actorNameFromUuid(this.state.actorUuid) || "Created Character",
      title: this.state.receipt.state === "undone" ? "Character safely deleted" : "Character created",
      message: this.state.receipt.state === "undone"
        ? "The exact unchanged Character was removed and the signed receipt was retained for audit."
        : "The Character and its signed creation receipt were saved. You can now open the Character sheet.",
    } : null;
    return {
      definitions: this.#definitionModels(),
      definition,
      provider: definition ? this.#service.provider?.(definition.id) ?? null : null,
      profile,
      profileId: definition?.profileId ?? activeProfileId(this.#settingResolver) ?? "custom",
      ranks: creationMilestones(definition).map(milestone => ({
        rank: milestone.rank,
        id: milestone.id,
        label: milestoneLabel(milestone),
        selected: milestone.rank === this.state.rank,
      })),
      rank: this.state.rank,
      milestone: this.#milestone(),
      choiceGroups: this.#choiceGroupModels(),
      abilityGroups: this.#abilityModels(anticipated),
      semanticInputs: (this.#milestone()?.inputs ?? []).map(input => {
        const stageId = authoredStages.find(stage => stage.inputIds?.includes(input.id))?.id ?? null;
        return ({
        ...input,
        label: input.label ?? input.id,
        value: this.state.semanticInputs[input.id] ?? "",
        isInteger: input.type === "integer",
        isSelect: input.type === "select",
        isLongText: input.type === "longText",
        options: (input.options ?? []).map(option => ({...option, selected: option.value === this.state.semanticInputs[input.id]})),
        maximum: Math.min(Number.isInteger(input.maxLength) ? input.maxLength : 4096, nameInputIds.has(input.id) ? 128 : 4096),
        workflowStageId: stageId ? `definition-${stageId}` : "path",
      });}),
      identity: effects.filter(effect => effect.type === "identity.set").map(effect => ({
        field: effect.field,
        label: identityFieldLabel(effect.field, profile),
        value: semanticInputReference(effect.value)
          ? this.state.semanticInputs[semanticInputReference(effect.value)] ?? ""
          : effect.value,
        operationId: effect.operationId,
      })),
      profileAbilities: asArray(profile?.ability?.ids).map(id => ({id, name: abilityName(id)})),
      sources: (definition?.sourceRefs ?? []).map(source => ({
        ...source,
        selected: acquiredIds.has(source.id),
        detail: source.uuid ?? source.revision ?? source.kind,
      })),
      formulas: effects.filter(effect => formulaLabel(effect)).map(effect => ({
        operationId: effect.operationId,
        formula: formulaLabel(effect),
        result: effect.resolution ? effect.amount : this.#formulaCache.get(formulaCacheKey(effect)) ?? "—",
        pinned: Boolean(effect.resolution),
      })),
      effects: effects.map(effect => ({
        ...effect,
        display: effectLabel(effect, profile, definition, this.state.semanticInputs),
        pinned: Boolean(this.state.preview),
      })),
      summary: effects.filter(effect => effect.type === "summary.add").map(effect => effect.label),
      definitionErrors,
      inputErrors: [...this.state.inputErrors],
      previewError: this.state.previewError,
      undoError: this.state.undoError,
      preview: this.state.preview,
      receipt: this.state.receipt,
      receiptResult,
      receiptCanUndo: this.state.receipt?.kind === "character.create"
        && this.state.receipt?.state === "committed"
        && this.state.receipt?.reversible === true,
      actorUuid: this.state.actorUuid,
      receipts: this.#receiptModels(),
      busy: this.state.busy,
      canCommit: commitBlockers.length === 0 && Boolean(this.state.preview) && remainingMs > 0,
      commitBlockers,
      commitStatus: commitBlockers[0]?.message ?? "Signed preview ready. Review the changes, then create the Character.",
      workflowStages,
      hasPreview: Boolean(this.state.preview),
      previewExpired,
      previewExpiring: Boolean(this.state.preview) && remainingMs > 0 && remainingMs < 60_000,
      previewRemaining: remainingMs === null ? null : Math.ceil(remainingMs / 1000),
    };
  }
}

export class AgeCharacterBuilder extends HandlebarsApplicationMixin(ApplicationV2) {
  #choiceFilters = new Map();
  #selectedOnlyGroups = new Set();

  static DEFAULT_OPTIONS = {
    id: "age-character-builder",
    classes: ["age-system", "age-character-builder"],
    position: {width: 900, height: 780},
    window: {title: "AGE Character Builder", resizable: true, minimizable: true},
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/progression/character-builder.hbs",
      scrollable: [".age-character-builder__scroll"],
    },
  };

  constructor(options = {}) {
    const {
      controller = null,
      service,
      settingResolver,
      profileResolver,
      formulaResolver,
      confirmer,
      definitionId,
      ...applicationOptions
    } = options;
    super(applicationOptions);
    this.controller = controller ?? new AgeCharacterBuilderController({
      service,
      settingResolver,
      profileResolver,
      formulaResolver,
      confirmer,
      definitionId,
    });
  }

  static async open(options = {}) {
    const app = new this(options);
    await app.controller.initialize();
    await app.render({force: true});
    return app;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (!this.controller.state.initialized) await this.controller.initialize();
    return Object.assign(context, this.controller.context());
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const root = this.element;
    root?.addEventListener("change", event => this.#onChange(event));
    root?.addEventListener("click", event => this.#onClick(event));
    root?.addEventListener("input", event => this.#onChoiceFilter(event));
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    for (const input of this.element?.querySelectorAll?.("[data-age-character-choice-filter]") ?? []) {
      input.value = this.#choiceFilters.get(input.dataset.groupId) ?? "";
      const selectedOnly = input.closest?.("[data-age-character-choice-group]")
        ?.querySelector?.("[data-age-character-choice-selected]");
      if (selectedOnly) selectedOnly.checked = this.#selectedOnlyGroups.has(input.dataset.groupId);
      this.#applyChoiceFilter(input);
    }
  }

  #onChoiceFilter(event) {
    const input = event.target.closest?.("[data-age-character-choice-filter]");
    if (input) {
      this.#choiceFilters.set(input.dataset.groupId, input.value);
      this.#applyChoiceFilter(input);
      return;
    }
    const selectedOnly = event.target.closest?.("[data-age-character-choice-selected]");
    if (!selectedOnly) return;
    if (selectedOnly.checked) this.#selectedOnlyGroups.add(selectedOnly.dataset.groupId);
    else this.#selectedOnlyGroups.delete(selectedOnly.dataset.groupId);
    const search = selectedOnly.closest?.("[data-age-character-choice-group]")
      ?.querySelector?.("[data-age-character-choice-filter]");
    if (search) this.#applyChoiceFilter(search);
  }

  #applyChoiceFilter(input) {
    const panel = input.closest?.("[data-age-character-choice-group]");
    if (!panel) return;
    const query = String(input.value ?? "").trim().toLocaleLowerCase();
    const selectedOnly = this.#selectedOnlyGroups.has(input.dataset.groupId);
    let visible = 0;
    for (const option of panel.querySelectorAll?.("[data-age-character-choice-option]") ?? []) {
      const matchesSearch = !query || String(option.dataset.searchText ?? option.textContent ?? "").toLocaleLowerCase().includes(query);
      const matches = matchesSearch && (!selectedOnly || option.querySelector?.("input[type=checkbox]")?.checked === true);
      option.hidden = !matches;
      if (matches) visible += 1;
    }
    const empty = panel.querySelector?.("[data-age-character-choice-empty]");
    if (empty) empty.hidden = visible > 0;
    const count = panel.querySelector?.("[data-age-character-choice-visible]");
    if (count) count.textContent = String(visible);
    const clear = panel.querySelector?.("[data-age-character-action=clear-choice-filter]");
    if (clear) clear.disabled = !query && !selectedOnly;
  }

  async #run(operation, {render = true} = {}) {
    try {
      await operation();
    } catch (error) {
      if (!error?.code && !String(error?.name ?? "").startsWith("AgeProgression")) {
        console.error("AGE System | Character Builder", error);
      }
      globalThis.ui?.notifications?.error?.(error.message);
    }
    if (render) await this.render({force: true});
  }

  #onChange(event) {
    const target = event.target.closest?.("[data-age-character-change]");
    if (!target) return;
    const action = target.dataset.ageCharacterChange;
    return this.#run(async () => {
      if (action === "definition") return this.controller.selectDefinition(target.value);
      if (action === "rank") return this.controller.selectRank(target.value);
      if (action === "choice") return this.controller.setChoice(target.dataset.groupId, target.dataset.optionId, target.checked);
      if (action === "ability") return this.controller.setAbilityAllocation(target.dataset.operationId, target.dataset.abilityId, target.value);
      if (action === "semantic-input") return this.controller.setSemanticInput(target.dataset.inputId, target.value);
    });
  }

  #onClick(event) {
    const step = event.target.closest?.("[data-age-character-scroll]");
    if (step) {
      event.preventDefault();
      this.element?.querySelector?.(`[data-age-character-stage="${step.dataset.ageCharacterScroll}"]`)
        ?.scrollIntoView?.({behavior: "smooth", block: "start"});
      return;
    }
    const target = event.target.closest?.("[data-age-character-action]");
    if (!target) return;
    event.preventDefault();
    const action = target.dataset.ageCharacterAction;
    if (action === "cancel") return this.close();
    if (action === "clear-choice-filter") {
      const panel = target.closest?.("[data-age-character-choice-group]");
      const input = panel?.querySelector?.("[data-age-character-choice-filter]");
      if (!input) return;
      this.#choiceFilters.delete(input.dataset.groupId);
      this.#selectedOnlyGroups.delete(input.dataset.groupId);
      input.value = "";
      const selectedOnly = panel.querySelector?.("[data-age-character-choice-selected]");
      if (selectedOnly) selectedOnly.checked = false;
      this.#applyChoiceFilter(input);
      return;
    }
    return this.#run(async () => {
      if (action === "refresh") return this.controller.refreshPreview();
      if (action === "reroll") return this.controller.rerollFormula(target.dataset.operationId);
      if (action === "commit") {
        const result = await this.controller.commitPreview();
        globalThis.ui?.notifications?.info?.(`AGE Character created: ${result?.actorUuid ?? result?.receipt?.actorUuid ?? "ready"}.`);
        return result;
      }
      if (action === "undo") {
        const result = await this.controller.undoReceipt(target.dataset.receiptId);
        if (result) globalThis.ui?.notifications?.info?.("AGE created Character deleted by exact receipt.");
        return result;
      }
    });
  }
}

export default AgeCharacterBuilder;
