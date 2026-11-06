import {showConfirmDialog} from "../dialogs.js";
import {canonicalJson} from "./canonical.js";
import {classBindingMatches} from "./class-binding.js";
import {adaptClassV3Definition, CLASS_V3_ADAPTER_VERSION} from "./class-v3-adapter.js";
import {AGE_PROGRESSION_PROFILE_IDS, cloneProgressionProfileAdapter} from "./profile-adapters.js";
import {
  actorProgressionDefinitionBinding,
  actorProgressionRank,
  readActorProgressionTracks,
} from "./actor-advancement-executor.js";
import {
  humanizeProgressionIdentifier,
  progressionEffectItemLabel,
  progressionOptionDetail,
  progressionSourceReference,
  progressionSourceLabel,
  progressionUiEvaluationResult,
} from "./ui-labels.js";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

const SYSTEM_ID = "age-system";
const LEGACY_CLASS_CAPABILITY = "age.class-v3";
const FORMULA_CACHE_MISS = Symbol("formula-cache-miss");
const CHOICE_SEARCH_THRESHOLD = 12;

function asArray(collection) {
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection?.contents)) return collection.contents;
  if (collection?.values instanceof Function) return [...collection.values()];
  if (collection?.[Symbol.iterator] instanceof Function) return [...collection];
  return [];
}

function sourceSystem(document) {
  return document?._source?.system ?? document?.system ?? {};
}

function stableDocumentId(document) {
  return String(document?.id ?? document?._id ?? "");
}

function documentUuid(document) {
  const uuid = String(document?.uuid ?? "");
  if (uuid) return uuid;
  const id = stableDocumentId(document);
  return id ? `Actor.${id}` : "";
}

function ownerLevel(ownership, userId) {
  const direct = Number(ownership?.[userId]);
  const fallback = Number(ownership?.default);
  return Number.isFinite(direct) ? direct : (Number.isFinite(fallback) ? fallback : 0);
}

export function canUseProgressionDocument(document, user = globalThis.game?.user) {
  if (!document || !user) return false;
  if (user.isGM === true) return true;
  try {
    if (document.testUserPermission?.(user, "OWNER") === true) return true;
  } catch { /* Fall through to the persisted ownership source. */ }
  try {
    if (document.canUserModify?.(user, "update") === true) return true;
  } catch { /* Fall through to the persisted ownership source. */ }
  return ownerLevel(document?._source?.ownership ?? document?.ownership, user.id) >= 3;
}

function activeProfileId(settingResolver) {
  try {
    const value = settingResolver(SYSTEM_ID, "activeRuleProfile");
    return typeof value === "string" && value && value !== "custom" ? value : null;
  } catch {
    return null;
  }
}

function actorItems(actor) {
  return asArray(actor?.items);
}

function progressionOwnedSourceRefIds(actor, definition) {
  const references = new Set();
  const sourceRefByUuid = new Map((definition?.sourceRefs ?? [])
    .filter(sourceRef => typeof sourceRef?.uuid === "string" && sourceRef.uuid)
    .map(sourceRef => [sourceRef.uuid, sourceRef.id]));
  for (const item of actorItems(actor)) {
    const source = item?._source ?? item ?? {};
    const flags = source.flags ?? item?.flags ?? {};
    const explicitId = flags?.[SYSTEM_ID]?.progressionSourceRefId
      ?? item?.flags?.[SYSTEM_ID]?.progressionSourceRefId;
    if (typeof explicitId === "string" && explicitId) references.add(explicitId);
    const origins = [
      item?.uuid,
      flags?.core?.sourceId,
      source?._stats?.compendiumSource,
      item?._stats?.compendiumSource,
    ];
    for (const origin of origins) {
      const sourceRefId = sourceRefByUuid.get(origin);
      if (sourceRefId) references.add(sourceRefId);
    }
  }
  return references;
}

function progressionAbilityValues(actor, definition) {
  let abilityIds = [];
  try { abilityIds = cloneProgressionProfileAdapter(definition?.profileId).ability.ids; }
  catch { return {}; }
  const abilities = sourceSystem(actor).abilities ?? {};
  const values = {};
  for (const abilityId of abilityIds) {
    const value = Number(abilities?.[abilityId]?.value);
    if (Number.isFinite(value)) values[abilityId] = value;
  }
  return values;
}

function ownedClasses(actor, user) {
  return actorItems(actor).filter(item => item?.type === "class" && canUseProgressionDocument(item, user));
}

function traitForItem(item) {
  if (item?.type === "talent" && sourceSystem(item).type === "spec") return "spec";
  return String(item?.type ?? "");
}

function currentRank(actor, classItem, definition) {
  if (definition?.trackBinding?.kind === "actor") {
    const fallback = Math.max(0, Number(definition?.rank?.minimum ?? 1) - 1);
    return actorProgressionRank(actor, definition.trackBinding.trackId, fallback);
  }
  const classLevel = Number(sourceSystem(classItem).level);
  if (Number.isInteger(classLevel)) return classLevel;
  const actorLevel = Number(sourceSystem(actor).level);
  if (Number.isInteger(actorLevel)) return actorLevel;
  return Math.max(Number(definition?.rank?.minimum) || 0, 0);
}

function rankMilestone(definition, rank) {
  return definition?.milestones?.find(milestone => (
    milestone.rank === rank && milestone.triggers?.includes("rank.advance")
  )) ?? null;
}

function classMatchesDefinition(classItem, definition) {
  if (definition?.trackBinding?.kind === "actor") return true;
  return classBindingMatches(definition, classItem);
}

function actorDefinitionMatchesBinding(actor, definition) {
  if (definition?.trackBinding?.kind !== "actor") return true;
  const binding = actorProgressionDefinitionBinding(actor, definition.trackBinding.trackId);
  return !binding || (
    binding.definitionId === definition.id
      && binding.profileId === definition.profileId
  );
}

function choiceDefaults(milestone) {
  return Object.fromEntries((milestone?.choiceGroups ?? []).map(group => {
    const forced = group.minimum === group.maximum && group.maximum === group.options.length;
    const only = group.minimum === 1 && group.maximum === 1 && group.options.length === 1;
    return [group.id, forced || only ? group.options.map(option => option.id) : []];
  }));
}

function normalizeSelectedOptions(group, choices) {
  const requested = new Set(Array.isArray(choices?.[group.id]) ? choices[group.id] : []);
  return group.options.filter(option => requested.has(option.id));
}

/**
 * Recreate the compiler's stable occurrence ids without resolving effects.
 * This powers inputs only; the compiler remains the sole semantic authority.
 */
export function progressionInputOccurrences(definition, rank, choices = {}) {
  const milestone = rankMilestone(definition, rank);
  if (!milestone) return [];
  const occurrences = milestone.effects.map(effect => ({
    ...effect,
    operationId: `${milestone.id}:direct:${effect.id}`,
    origin: {kind: "milestone", milestoneId: milestone.id},
  }));
  for (const group of milestone.choiceGroups) {
    normalizeSelectedOptions(group, choices).forEach((option, selectionIndex) => {
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

function legacyEligibleAbilityIds(actor, classItem, targetRank, settingResolver) {
  const abilities = Object.keys(sourceSystem(actor).abilities ?? {});
  let alternatePrimary = false;
  try { alternatePrimary = settingResolver(SYSTEM_ID, "primaryAbl") === true; } catch { /* Use non-alternating fallback. */ }
  if (alternatePrimary) {
    const primary = (sourceSystem(classItem).primaryAbl ?? []).filter(key => abilities.includes(key));
    const primarySet = new Set(primary);
    const secondary = abilities.filter(key => !primarySet.has(key));
    return targetRank % 2 === 0 ? primary : secondary;
  }
  const transactions = sourceSystem(actor).classProgression?.transactions;
  const previous = Array.isArray(transactions) ? transactions.at(-1)?.choices?.ability ?? {} : {};
  const used = new Set(Object.entries(previous).filter(([, amount]) => Number(amount) > 0).map(([key]) => key));
  const remaining = abilities.filter(key => !used.has(key));
  return remaining.length ? remaining : abilities;
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
  if (typeof effect?.amount === "number") return effect.amount;
  if (effect?.amount?.kind === "formula") return null;
  return 0;
}

function humanizeIdentifier(value) {
  return humanizeProgressionIdentifier(value);
}

function sourceRefLabel(definition, sourceRefId) {
  return progressionSourceLabel(definition, sourceRefId);
}

function normalizedItemName(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function itemProgressionFlags(item) {
  const flags = item?.flags ?? item?._source?.flags ?? {};
  return {
    age: flags?.[SYSTEM_ID] ?? {},
    core: flags?.core ?? {},
  };
}

/**
 * Find an already-owned Focus represented by one item.acquire source.
 *
 * Creation receipts retain sourceRef ids, while imported/legacy Characters
 * may only retain the source UUID or name.  All three identities are useful,
 * but the Item trait must still be Focus so an unrelated same-name Item can
 * never disable an authored acquisition choice.
 */
function ownedFocusAcquisitionConflict(actor, definition, effect) {
  if (effect?.type !== "item.acquire") return null;
  const sourceRef = progressionSourceReference(definition, effect.sourceRefId);
  if (!sourceRef) return null;
  const sourceRefId = String(sourceRef.id ?? effect.sourceRefId ?? "");
  const sourceUuid = String(sourceRef.uuid ?? "");
  const sourceName = normalizedItemName(sourceRef.label);
  const item = actorItems(actor).find(candidate => {
    if (traitForItem(candidate) !== "focus") return false;
    const flags = itemProgressionFlags(candidate);
    const explicit = Boolean(
      sourceRefId && flags.age.progressionSourceRefId === sourceRefId
      || sourceUuid && [
        flags.age.progressionSourceUuid,
        flags.age.classSourceUuid,
        flags.core.sourceId,
      ].includes(sourceUuid)
    );
    return explicit || Boolean(sourceName && normalizedItemName(candidate?.name ?? candidate?._source?.name) === sourceName);
  });
  if (!item) return null;
  const label = progressionEffectItemLabel(definition, effect) || item.name || "This Focus";
  return {
    item,
    label,
    message: `${label} is already owned; choose a different Focus. This acquisition cannot improve an owned Focus.`,
  };
}

function optionDetail(option, definition) {
  return progressionOptionDetail(option, definition);
}

function receiptRank(actor, receipt) {
  const classTransactions = sourceSystem(actor).classProgression?.transactions;
  const classTransaction = Array.isArray(classTransactions)
    ? classTransactions.find(transaction => transaction?.id === receipt?.transactionId)
    : null;
  if (Number.isInteger(Number(classTransaction?.level))) return Number(classTransaction.level);
  try {
    for (const track of Object.values(readActorProgressionTracks(actor).tracks ?? {})) {
      const transaction = track.transactions?.find(entry => entry?.id === receipt?.transactionId);
      if (Number.isInteger(Number(transaction?.rank))) return Number(transaction.rank);
    }
  } catch { /* A malformed history is handled by the executor; keep the receipt readable. */ }
  return null;
}

function effectLabel(effect, definition) {
  const amount = typeof effect?.amount === "number"
    ? effect.amount
    : effect?.amount?.kind === "formula" ? effect.amount.formula : effect?.amount;
  switch (effect.type) {
    case "resource.gain": return `${humanizeIdentifier(effect.resource)} +${amount}`;
    case "classBonus.gain": return `${humanizeIdentifier(effect.bonus)} bonus +${amount}`;
    case "ability.allocate": return `Allocate ${typeof effect.amount === "number" ? effect.amount : effect.amount?.formula ?? "?"} ability point(s)`;
    case "ability.setPrimary": return `Set ${abilityName(effect.abilityId)} primary`;
    case "weaponGroup.add": return `Add weapon group: ${humanizeIdentifier(effect.weaponGroupId)}`;
    case "item.acquire": return `Acquire ${progressionEffectItemLabel(definition, effect)}`;
    case "item.advance": return `Advance ${humanizeIdentifier(effect.trait)}`;
    case "track.setRank": return effect.trackId === "level"
      ? `Advance to level ${effect.rank}`
      : `Set ${humanizeIdentifier(effect.trackId)} rank to ${effect.rank}`;
    case "identity.set": return `Set ${humanizeIdentifier(effect.field)}`;
    case "summary.add": return effect.label;
    default: return effect.type;
  }
}

function providerLabel(provider, definition) {
  if (provider?.label) return String(provider.label);
  if (provider?.kind === "world") return "World progression definition";
  if (provider?.kind === "compendium") return "Compendium progression definition";
  if (provider?.kind === "module") return "Module progression definition";
  if (provider?.kind === "import") return "Imported progression definition";
  if (provider?.kind === "legacy-class") return "Legacy Class progression";
  return definition?.sourceRefs?.[0]?.label ?? definition?.id ?? "Progression definition";
}

function providerKindLabel(provider) {
  switch (provider?.kind) {
    case "world": return "World";
    case "compendium": return "Compendium";
    case "module": return "Content module";
    case "import": return "Imported";
    case "legacy-class": return "Owned Class";
    default: return "Registered provider";
  }
}

function readableProgressionError(error) {
  const code = String(error?.code ?? "error");
  const exact = {
    "definition-missing": "No active progression definition is available for this Character and rules profile.",
    "profile-stale": "The active rules profile changed. Rebuild the preview before advancing.",
    "definition-stale": "The progression definition changed. Rebuild the preview before advancing.",
    "source-stale": "A referenced Item changed or is unavailable. Ask a GM to review the progression definition.",
    "base-stale": "The Character changed after this preview was created. Rebuild the preview.",
    "preview-expired": "This preview expired. Rebuild it before committing.",
    "preview-consumed": "This preview was already committed or cancelled.",
    "permission": "You no longer have permission to advance this Character.",
    "source-ref": "A required progression Item reference is incomplete. Ask a GM to review the definition.",
    "source-binding": "A required progression Item could not be loaded. Enable or restore its module or compendium, then rebuild the preview.",
    "source-snapshot": "A required progression Item could not be verified. Enable or restore its module or compendium, then rebuild the preview.",
  };
  const message = exact[code] ?? error?.message ?? String(error);
  return {
    code,
    message,
    details: error?.details ?? null,
    dependency: /source|uuid|compendium|pack|module/i.test(`${code} ${message}`),
  };
}

function formulaLabel(effect) {
  return effect?.resolution?.formula ?? effect?.amount?.formula ?? null;
}

function formulaCacheKey(effect) {
  return effect?.resolution?.rollId ?? effect?.amount?.rollId ?? effect?.operationId;
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
  availability,
}) {
  const blockers = [];
  if (busy) blockers.push("Please wait while the signed preview is being prepared.");
  if (!availability?.available && availability?.reason) blockers.push(availability.reason);
  blockers.push(...definitionErrors, ...inputErrors);
  if (previewError?.message) blockers.push(previewError.dependency
    ? `Required progression content is unavailable. ${previewError.message}`
    : `Preview unavailable: ${previewError.message}`);
  if (previewExpired) blockers.push("The signed preview expired. Refresh the review before applying advancement.");
  else if (!preview && blockers.length === 0) blockers.push("Refresh the review to create a signed preview.");
  return uniqueMessages(blockers).map((message, index) => ({id: `advance-blocker-${index + 1}`, message}));
}

function cloneDraft(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

async function defaultFormulaResolver(formula, metadata, actor) {
  const rollData = actor?.actorRollData?.() ?? actor?.getRollData?.() ?? {};
  const roll = await new Roll(formula, rollData).evaluate();
  await roll.toMessage?.({flavor: `Advancement · ${metadata.effectId}`});
  return Number(roll.total);
}

async function defaultUndoConfirmation({receipt, preview}) {
  const reasons = preview.reasons?.length ? `<p>${preview.reasons.join(", ")}</p>` : "";
  return showConfirmDialog({
    title: "Undo AGE Advancement",
    content: `<p>Undo progression receipt <strong>${receipt.id}</strong>?</p>${reasons}`,
    yesLabel: "Undo Advancement",
    defaultYes: false,
  });
}

function defaultSettingsResolver(namespace, key) {
  return globalThis.game?.settings?.get?.(namespace, key);
}

function defaultActorsProvider() {
  return asArray(globalThis.game?.actors);
}

function defaultUserResolver() {
  return globalThis.game?.user ?? null;
}

function defaultService() {
  return globalThis.game?.ageSystem?.progressionService
    ?? globalThis.game?.ageSystem?.progression
    ?? null;
}

function centerBootstrapError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function classProgressionRevision(classItem) {
  const source = classItem?._source ?? {};
  const candidates = [
    source._stats?.modifiedTime,
    classItem?._stats?.modifiedTime,
    source.system?.progression?.revision,
    source.system?.advancementRevision,
    source.system?.advancementVersion,
  ];
  const revision = candidates.find(value => (
    (typeof value === "string" && value.trim())
    || (typeof value === "number" && Number.isFinite(value))
  ));
  return String(revision ?? "unversioned");
}

function definitionPayload(definition) {
  const value = cloneDraft(definition);
  delete value.version;
  return canonicalJson(value);
}

function nextLegacyDefinitionVersion(existingVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(existingVersion ?? ""));
  if (!match) return `${CLASS_V3_ADAPTER_VERSION}.0.1`;
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (major > CLASS_V3_ADAPTER_VERSION) {
    throw centerBootstrapError(
      "definition-version",
      `Legacy Class definition version ${existingVersion} is newer than adapter ${CLASS_V3_ADAPTER_VERSION}.`,
      {existingVersion, adapterVersion: CLASS_V3_ADAPTER_VERSION},
    );
  }
  if (major < CLASS_V3_ADAPTER_VERSION) return `${CLASS_V3_ADAPTER_VERSION}.0.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Adapt and register one live owned Class Item without making legacy content
 * a dependency of the progression engine. Nothing is registered at startup;
 * callers invoke this bridge only when opening legacy Class advancement.
 */
export function registerLegacyClassProgressionDefinition({
  service = defaultService(),
  actor,
  classItem,
  profileId = activeProfileId(defaultSettingsResolver),
} = {}) {
  if (!(service?.registerDefinition instanceof Function)) {
    throw centerBootstrapError("service-unavailable", "AGE progression definition registration is unavailable.");
  }
  if (!AGE_PROGRESSION_PROFILE_IDS.includes(profileId)) {
    throw centerBootstrapError(
      "profile-unsupported",
      `AGE legacy Class advancement does not support profile "${profileId ?? "custom"}".`,
      {profileId: profileId ?? null, supportedProfiles: [...AGE_PROGRESSION_PROFILE_IDS]},
    );
  }
  if (actor?.type !== "char") {
    throw centerBootstrapError("actor-invalid", "Legacy Class advancement requires a Character Actor.");
  }
  if (classItem?.type !== "class") {
    throw centerBootstrapError("class-invalid", "Legacy Class advancement requires a Class Item.");
  }
  const classId = stableDocumentId(classItem);
  const classUuid = String(classItem.uuid ?? "").trim();
  const actorUuid = documentUuid(actor);
  const belongsToActor = actorItems(actor).some(item => (
    item === classItem
    || (classUuid && String(item?.uuid ?? "") === classUuid)
    || (classId && stableDocumentId(item) === classId)
  ));
  if (!classId || !classUuid || !actorUuid || !belongsToActor) {
    throw centerBootstrapError(
      "class-binding",
      "Legacy Class advancement requires an embedded Class with stable Actor, Item, and UUID bindings.",
      {actorUuid: actorUuid || null, classItemId: classId || null, classItemUuid: classUuid || null},
    );
  }

  let rawSystem;
  try {
    rawSystem = cloneDraft(sourceSystem(classItem));
  } catch (cause) {
    throw centerBootstrapError("class-source", "Legacy Class progression source is not plain serializable data.", {cause});
  }
  let definition = adaptClassV3Definition(rawSystem, {
    // Embedded Item ids can be retained when the same Class source is added
    // to multiple Actors. Include the owning Actor id so each live bridge has
    // one unambiguous registry key.
    id: `${stableDocumentId(actor)}:${classId}`,
    className: String(classItem.name ?? classId),
    uuid: classUuid,
    revision: classProgressionRevision(classItem),
    profileId,
  });
  const existing = service.getDefinition instanceof Function ? service.getDefinition(definition.id) : null;
  if (existing) {
    const provider = service.provider instanceof Function ? service.provider(definition.id) : null;
    if (provider && (provider.kind !== "legacy-class" || provider.id !== classUuid || provider.containerUuid !== actorUuid)) {
      throw centerBootstrapError(
        "definition-collision",
        `Progression definition "${definition.id}" is already owned by another provider.`,
        {definitionId: definition.id, provider},
      );
    }
    if (definitionPayload(existing) === definitionPayload(definition)) return existing;
    definition = {...definition, version: nextLegacyDefinitionVersion(existing.version)};
  }
  return service.registerDefinition(definition, {
    provider: {
      kind: "legacy-class",
      id: classUuid,
      label: String(classItem.name ?? classId),
      containerUuid: actorUuid,
    },
    replace: true,
  });
}

/** Register the selected legacy Class and open its provider-neutral AppV2 UI. */
export async function openLegacyClassAdvancementCenter({
  service = defaultService(),
  actor,
  classItem,
  profileId = activeProfileId(defaultSettingsResolver),
  legacyFallback = null,
} = {}) {
  const definition = registerLegacyClassProgressionDefinition({service, actor, classItem, profileId});
  return AgeAdvancementCenter.open({
    service,
    actor,
    classItem,
    definitionId: definition.id,
    legacyFallback,
  });
}

/**
 * Provider-neutral Character entry point used by AppV2 sheets. It adapts every
 * usable owned legacy Class on demand, while already registered Actor-track and
 * authored Class-track DefinitionV1 records remain first-class candidates.
 */
export async function openActorAdvancementCenter({
  service = defaultService(),
  actor,
  definitionId = null,
  profileId = activeProfileId(defaultSettingsResolver),
  legacyFallback = null,
} = {}) {
  const user = defaultUserResolver();
  if (actor?.type !== "char" || !canUseProgressionDocument(actor, user)) {
    throw centerBootstrapError("permission", "AGE advancement requires a player-owned Character.");
  }
  const registrationFailures = [];
  for (const classItem of ownedClasses(actor, user)) {
    try {
      registerLegacyClassProgressionDefinition({service, actor, classItem, profileId});
    } catch (error) {
      // One malformed or unsupported legacy Class must not hide otherwise
      // valid authored/Actor-track definitions from the Character entry point.
      registrationFailures.push({classItemUuid: documentUuid(classItem), ...publicError(error)});
    }
  }
  const definitions = asArray(service.listDefinitions(profileId ? {profileId} : {}));
  const classes = ownedClasses(actor, user);
  const compatible = definitions.filter(definition => {
    if (!definition?.milestones?.some(milestone => milestone.triggers?.includes("rank.advance"))) return false;
    if (definition.trackBinding?.kind === "actor") return actorDefinitionMatchesBinding(actor, definition);
    return classes.some(classItem => classMatchesDefinition(classItem, definition));
  });
  if (!compatible.length) {
    throw centerBootstrapError(
      "definition-missing",
      "This Character has no compatible Actor-track or Class-track progression definition.",
      {actorUuid: documentUuid(actor), profileId, registrationFailures},
    );
  }
  const selectedDefinitionId = compatible.some(definition => definition.id === definitionId)
    ? definitionId
    : compatible[0].id;
  const selected = compatible.find(definition => definition.id === selectedDefinitionId);
  const classItem = selected?.trackBinding?.kind === "class-item"
    ? classes.find(item => classMatchesDefinition(item, selected)) ?? null
    : null;
  return AgeAdvancementCenter.open({service, actor, classItem, definitionId: selectedDefinitionId, legacyFallback});
}

/** Read-only Character-sheet summary. It never registers or mutates content. */
export function characterAdvancementSummary({
  service = defaultService(),
  actor,
  profileId = activeProfileId(defaultSettingsResolver),
  user = defaultUserResolver(),
} = {}) {
  const unavailable = message => Object.freeze({
    state: "unavailable",
    available: false,
    currentRank: Number(sourceSystem(actor).level) || 0,
    targetRank: null,
    pathCount: 0,
    label: "Advancement unavailable",
    message,
  });
  if (actor?.type !== "char" || !canUseProgressionDocument(actor, user)) {
    return unavailable("You must own this Character to use progression.");
  }
  if (!(service?.listDefinitions instanceof Function)) {
    return unavailable("The progression service is not ready.");
  }
  const classes = ownedClasses(actor, user);
  const definitions = asArray(service.listDefinitions(profileId ? {profileId} : {}))
    .filter(definition => definition?.milestones?.some(milestone => milestone.triggers?.includes("rank.advance")));
  for (const classItem of classes) {
    if (definitions.some(definition => definition.trackBinding?.kind === "class-item" && classMatchesDefinition(classItem, definition))) continue;
    try {
      const adapted = adaptClassV3Definition(cloneDraft(sourceSystem(classItem)), {
        id: `sheet:${stableDocumentId(actor)}:${stableDocumentId(classItem)}`,
        className: String(classItem.name ?? stableDocumentId(classItem)),
        uuid: String(classItem.uuid ?? ""),
        revision: classProgressionRevision(classItem),
        profileId,
      });
      definitions.push(adapted);
    } catch { /* Malformed legacy Classes are reported when the Center opens. */ }
  }
  const paths = [];
  for (const definition of definitions) {
    if (!actorDefinitionMatchesBinding(actor, definition)) continue;
    const classItems = definition.trackBinding?.kind === "class-item"
      ? classes.filter(item => classMatchesDefinition(item, definition))
      : [null];
    for (const classItem of classItems) {
      const rank = currentRank(actor, classItem, definition);
      const target = rank + 1;
      const milestone = rankMilestone(definition, target);
      const provider = service.provider?.(definition.id) ?? (definition.id.startsWith("sheet:")
        ? {kind: "legacy-class", label: classItem?.name ?? "Owned Class"}
        : null);
      paths.push({
        definitionId: definition.id,
        label: providerLabel(provider, definition),
        provider: providerKindLabel(provider),
        currentRank: rank,
        targetRank: target,
        available: Boolean(milestone),
        reason: milestone ? `Rank ${target} is ready to preview.`
          : rank >= Number(definition.rank?.maximum) ? `Maximum rank ${rank} reached.`
            : `No rank ${target} milestone is defined.`,
      });
    }
  }
  const ordered = paths.sort((left, right) => Number(right.available) - Number(left.available) || left.label.localeCompare(right.label));
  const selected = ordered[0];
  if (!selected) return unavailable(classes.length
    ? "No active definition matches this Character's Class and rules profile."
    : "No active Actor-track progression definition matches this Character and rules profile.");
  const availableCount = ordered.filter(path => path.available).length;
  return Object.freeze({
    state: selected.available ? "available" : "complete",
    available: selected.available,
    currentRank: selected.currentRank,
    targetRank: selected.available ? selected.targetRank : null,
    pathCount: availableCount,
    label: selected.available ? `Advance to rank ${selected.targetRank}` : "No next rank available",
    message: selected.available
      ? `${availableCount} progression path${availableCount === 1 ? " is" : "s are"} ready to preview.`
      : selected.reason,
    definitionId: selected.definitionId,
    provider: selected.provider,
  });
}

function publicError(error) { return readableProgressionError(error); }

export class AgeAdvancementCenterController {
  #service;
  #actorsProvider;
  #settingResolver;
  #userResolver;
  #formulaResolver;
  #confirmer;
  #initialActor;
  #initialClassItem;
  #initialDefinitionId;
  #actors = [];
  #definitions = [];
  #generation = 0;
  #formulaCache = new Map();
  #commitPromise = null;
  #undoPromise = null;

  constructor({
    service = defaultService(),
    actorsProvider = defaultActorsProvider,
    settingResolver = defaultSettingsResolver,
    userResolver = defaultUserResolver,
    formulaResolver = defaultFormulaResolver,
    confirmer = defaultUndoConfirmation,
    actor = null,
    classItem = null,
    definitionId = null,
  } = {}) {
    if (!(service?.listDefinitions instanceof Function) || !(service?.previewAdvancement instanceof Function)) {
      throw new Error("AGE Advancement Center requires the AGE progression service.");
    }
    this.#service = service;
    this.#actorsProvider = actorsProvider;
    this.#settingResolver = settingResolver;
    this.#userResolver = userResolver;
    this.#formulaResolver = formulaResolver;
    this.#confirmer = confirmer;
    this.#initialActor = actor;
    this.#initialClassItem = classItem;
    this.#initialDefinitionId = definitionId;
    this.state = {
      initialized: false,
      actorUuid: documentUuid(actor),
      classItemId: stableDocumentId(classItem),
      definitionId: definitionId ?? "",
      choices: {},
      abilityAllocations: {},
      progressionTargets: {},
      preview: null,
      previewError: null,
      inputErrors: [],
      busy: false,
      receipt: null,
      undoPreview: null,
      undoError: null,
    };
  }

  get service() { return this.#service; }
  get actor() { return this.#actors.find(actor => documentUuid(actor) === this.state.actorUuid) ?? null; }
  get user() { return this.#userResolver(); }
  get classItem() { return ownedClasses(this.actor, this.user).find(item => stableDocumentId(item) === this.state.classItemId) ?? null; }
  get definition() { return this.#definitions.find(definition => definition.id === this.state.definitionId) ?? null; }

  async initialize({preview = true} = {}) {
    this.#actors = this.#ownedActors();
    const initialActorUuid = documentUuid(this.#initialActor);
    if (!this.state.actorUuid || !this.#actors.some(actor => documentUuid(actor) === this.state.actorUuid)) {
      this.state.actorUuid = this.#actors.some(actor => documentUuid(actor) === initialActorUuid)
        ? initialActorUuid
        : documentUuid(this.#actors[0]);
    }
    this.#refreshDefinitions();
    this.#selectInitialClass();
    this.#selectInitialDefinition();
    this.#resetInputs();
    this.state.initialized = true;
    if (preview) await this.refreshPreview();
    return this;
  }

  #ownedActors() {
    return asArray(this.#actorsProvider()).filter(actor => (
      actor?.type === "char" && canUseProgressionDocument(actor, this.user)
    ));
  }

  #selectInitialClass() {
    const classes = ownedClasses(this.actor, this.user);
    const requestedId = this.state.classItemId || stableDocumentId(this.#initialClassItem);
    this.state.classItemId = classes.some(item => stableDocumentId(item) === requestedId)
      ? requestedId
      : stableDocumentId(classes[0]);
  }

  #refreshDefinitions() {
    const profileId = activeProfileId(this.#settingResolver);
    const definitions = asArray(this.#service.listDefinitions(profileId ? {profileId} : {}));
    this.#definitions = definitions.filter(definition => definition?.milestones?.some(milestone => milestone.triggers?.includes("rank.advance")));
  }

  #compatibleDefinitions() {
    const actor = this.actor;
    const classItem = this.classItem;
    return this.#definitions.filter(definition => {
      if (!classMatchesDefinition(classItem, definition)) return false;
      if (!actorDefinitionMatchesBinding(actor, definition)) return false;
      return Boolean(actor);
    });
  }

  #availability(definition, classItem = this.classItem) {
    if (!this.actor) return {available: false, state: "unavailable", reason: "Select an owned Character."};
    if (!definition) return {available: false, state: "unavailable", reason: "Select a progression definition."};
    if (!classMatchesDefinition(classItem, definition)) {
      return {available: false, state: "unavailable", reason: "Select the owned Class bound to this progression definition."};
    }
    const rank = currentRank(this.actor, classItem, definition);
    const target = rank + 1;
    if (rank >= Number(definition.rank?.maximum)) {
      return {available: false, state: "complete", reason: `Maximum rank ${rank} has been reached.`, currentRank: rank, targetRank: target};
    }
    if (!rankMilestone(definition, target)) {
      return {available: false, state: "unavailable", reason: `No advancement is defined for rank ${target}.`, currentRank: rank, targetRank: target};
    }
    return {available: true, state: "available", reason: `Rank ${target} is ready to preview.`, currentRank: rank, targetRank: target};
  }

  #selectInitialDefinition() {
    const compatible = this.#compatibleDefinitions();
    const requested = this.state.definitionId || this.#initialDefinitionId;
    const requestedDefinition = compatible.find(definition => definition.id === requested);
    const available = compatible.find(definition => this.#availability(definition).available);
    this.state.definitionId = requestedDefinition?.id ?? available?.id ?? compatible[0]?.id ?? "";
  }

  #resetInputs() {
    this.#generation += 1;
    this.#formulaCache.clear();
    this.state.preview = null;
    this.state.previewError = null;
    const milestone = this.#milestone();
    this.state.choices = choiceDefaults(milestone);
    this.state.abilityAllocations = {};
    this.state.progressionTargets = {};
    this.#reconcileInputs();
  }

  #milestone() {
    if (!this.definition) return null;
    return rankMilestone(this.definition, this.targetRank());
  }

  targetRank() {
    return this.definition ? currentRank(this.actor, this.classItem, this.definition) + 1 : null;
  }

  currentRank() {
    return this.definition ? currentRank(this.actor, this.classItem, this.definition) : null;
  }

  #eligibleAbilityIds(effect = null) {
    if (!this.actor) return [];
    const available = this.definition?.trackBinding?.kind === "class-item"
      ? legacyEligibleAbilityIds(this.actor, this.classItem, this.targetRank(), this.#settingResolver)
      : cloneProgressionProfileAdapter(this.definition.profileId).ability.ids
        .filter(id => Object.hasOwn(sourceSystem(this.actor).abilities ?? {}, id));
    const requested = Array.isArray(effect?.eligibleAbilityIds)
      ? new Set(effect.eligibleAbilityIds.map(String))
      : null;
    return requested ? available.filter(id => requested.has(id)) : available;
  }

  #evaluationContext(choices = this.state.choices) {
    return {
      choices,
      rank: this.targetRank(),
      ownedSourceRefIds: progressionOwnedSourceRefIds(this.actor, this.definition),
      abilities: progressionAbilityValues(this.actor, this.definition),
    };
  }

  #evaluationResult(evaluations, choices = this.state.choices) {
    return progressionUiEvaluationResult(evaluations, this.#evaluationContext(choices));
  }

  #reconcileInputs() {
    const groups = this.#milestone()?.choiceGroups ?? [];
    // A condition may depend on a later-authored group. Iterate to a stable
    // selection state so clearing one inactive default also clears anything
    // that depended upon it, regardless of authoring order.
    let converged = groups.length === 0;
    for (let pass = 0; pass <= groups.length; pass += 1) {
      let changed = false;
      for (const group of groups) {
        const previous = this.state.choices[group.id] ?? [];
        if (!this.#evaluationResult(group.evaluations).available) {
          if (previous.length) changed = true;
          this.state.choices[group.id] = [];
          continue;
        }
        const conditionAvailableOptions = group.options.filter(option => {
          const hypothetical = cloneDraft(this.state.choices);
          if (group.maximum === 1) hypothetical[group.id] = [option.id];
          else hypothetical[group.id] = [...new Set([...(hypothetical[group.id] ?? []), option.id])];
          return this.#evaluationResult(option.evaluations, hypothetical).available;
        });
        const availableOptions = conditionAvailableOptions.filter(option => !this.#choiceOptionConflict(option));
        const availableIds = new Set(availableOptions.map(option => option.id));
        let selected = group.options
          .filter(option => previous.includes(option.id) && availableIds.has(option.id))
          .slice(0, group.maximum)
          .map(option => option.id);
        const allConditionOptionsUsable = conditionAvailableOptions.length === availableOptions.length;
        const forced = allConditionOptionsUsable
          && group.minimum === group.maximum
          && group.maximum === conditionAvailableOptions.length;
        const only = allConditionOptionsUsable
          && group.minimum === 1
          && group.maximum === 1
          && conditionAvailableOptions.length === 1;
        if (!selected.length && (forced || only)) selected = availableOptions.map(option => option.id);
        if (selected.length !== previous.length || selected.some((optionId, index) => optionId !== previous[index])) changed = true;
        this.state.choices[group.id] = selected;
      }
      if (!changed) {
        converged = true;
        break;
      }
    }
    if (!converged) {
      // Cross-group choice.selected cycles are legal references but cannot be
      // presented as stable automatic defaults. Clear every condition-bearing
      // group and let cardinality validation fail closed instead of sending an
      // arbitrary oscillating selection to the signed compiler.
      for (const group of groups.filter(entry => (
        entry.evaluations?.length
        || entry.options.some(option => option.evaluations?.length)
      ))) this.state.choices[group.id] = [];
    }
    const occurrences = progressionInputOccurrences(this.definition, this.targetRank(), this.state.choices);
    const abilityEffects = occurrences.filter(effect => effect.type === "ability.allocate");
    const nextAllocations = {};
    for (const effect of abilityEffects) {
      const abilityIds = this.#eligibleAbilityIds(effect);
      const previous = this.state.abilityAllocations[effect.operationId] ?? {};
      const values = Object.fromEntries(abilityIds.map(id => [id, Math.max(0, Math.trunc(Number(previous[id]) || 0))]));
      const points = effectAmount(effect);
      if (points !== null && abilityIds.length === 1 && Object.values(values).every(value => value === 0)) values[abilityIds[0]] = points;
      nextAllocations[effect.operationId] = values;
    }
    this.state.abilityAllocations = nextAllocations;

    const itemEffects = occurrences.filter(effect => effect.type === "item.acquire" || effect.type === "item.advance");
    const nextTargets = {};
    for (const effect of itemEffects) {
      const candidates = this.#targetCandidates(effect);
      const previous = this.state.progressionTargets[effect.operationId] ?? "";
      nextTargets[effect.operationId] = candidates.some(item => stableDocumentId(item) === previous)
        ? previous
        : effect.type === "item.advance" && candidates.length === 1 ? stableDocumentId(candidates[0]) : "";
    }
    this.state.progressionTargets = nextTargets;
  }

  #targetCandidates(effect) {
    const trait = effect.trait;
    if (!trait) return [];
    return actorItems(this.actor).filter(item => traitForItem(item) === trait);
  }

  async selectActor(uuid) {
    this.state.receipt = null;
    this.state.actorUuid = String(uuid ?? "");
    this.#refreshDefinitions();
    this.state.classItemId = "";
    this.state.definitionId = "";
    this.#selectInitialClass();
    this.#selectInitialDefinition();
    this.#resetInputs();
    return this.refreshPreview();
  }

  async selectClass(itemId) {
    this.state.receipt = null;
    this.state.classItemId = String(itemId ?? "");
    this.state.definitionId = "";
    this.#selectInitialDefinition();
    this.#resetInputs();
    return this.refreshPreview();
  }

  async selectDefinition(definitionId) {
    this.state.receipt = null;
    this.state.definitionId = String(definitionId ?? "");
    this.#resetInputs();
    return this.refreshPreview();
  }

  async setChoice(groupId, optionId, checked) {
    const group = this.#milestone()?.choiceGroups?.find(entry => entry.id === groupId);
    const option = group?.options?.find(entry => entry.id === optionId);
    if (!group || !option) return null;
    const selected = new Set(this.state.choices[groupId] ?? []);
    if (checked) {
      if (!this.#evaluationResult(group.evaluations).available || this.#choiceOptionConflict(option)) return null;
      if (group.maximum === 1) selected.clear();
      if (selected.size < group.maximum) selected.add(optionId);
      const hypothetical = cloneDraft(this.state.choices);
      hypothetical[group.id] = group.options.filter(entry => selected.has(entry.id)).map(entry => entry.id);
      if (!this.#evaluationResult(option.evaluations, hypothetical).available) return null;
    } else selected.delete(optionId);
    this.state.choices[groupId] = group.options.filter(option => selected.has(option.id)).map(option => option.id);
    this.#invalidatePreview();
    this.#reconcileInputs();
    return this.refreshPreview();
  }

  async setAbilityAllocation(operationId, abilityId, value) {
    if (!this.state.abilityAllocations[operationId] || !Object.hasOwn(this.state.abilityAllocations[operationId], abilityId)) return null;
    this.state.abilityAllocations[operationId][abilityId] = Math.max(0, Math.trunc(Number(value) || 0));
    this.#invalidatePreview();
    return this.refreshPreview();
  }

  async setProgressionTarget(operationId, itemId) {
    if (!Object.hasOwn(this.state.progressionTargets, operationId)) return null;
    this.state.progressionTargets[operationId] = String(itemId ?? "");
    this.#invalidatePreview();
    return this.refreshPreview();
  }

  async rerollFormula(operationId) {
    const effects = this.state.preview?.resolvedEffects
      ?? progressionInputOccurrences(this.definition, this.targetRank(), this.state.choices);
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

  #inputErrors() {
    const errors = [];
    if (!this.actor) errors.push("Select an owned Character.");
    if (!this.definition) errors.push("Select a compatible progression definition.");
    if (this.definition?.trackBinding?.kind === "class-item" && !this.classItem) errors.push("Select the owned Class bound to this definition.");
    errors.push(...definitionReadinessMessages(this.#service, this.definition, "rank.advance"));
    const availability = this.#availability(this.definition);
    const milestone = this.#milestone();
    if (this.definition && !availability.available) errors.push(availability.reason);
    for (const group of milestone?.choiceGroups ?? []) {
      if (!this.#evaluationResult(group.evaluations).available) continue;
      const selected = this.state.choices[group.id] ?? [];
      if (selected.length < group.minimum || selected.length > group.maximum) {
        errors.push(`${group.label}: select ${group.minimum === group.maximum ? group.minimum : `${group.minimum}-${group.maximum}`} option(s).`);
      }
      for (const option of group.options.filter(entry => selected.includes(entry.id))) {
        if (!this.#evaluationResult(option.evaluations).available) {
          errors.push(`${option.label}: this option is not currently available.`);
        }
        const conflict = this.#choiceOptionConflict(option);
        if (conflict) errors.push(conflict.message);
      }
    }
    const occurrences = progressionInputOccurrences(this.definition, this.targetRank(), this.state.choices);
    for (const effect of occurrences.filter(entry => entry.type === "ability.allocate")) {
      const points = effectAmount(effect);
      if (points === null) {
        errors.push(`Ability allocation "${effect.id}" uses a formula and cannot be allocated before it is pinned.`);
        continue;
      }
      const spent = Object.values(this.state.abilityAllocations[effect.operationId] ?? {}).reduce((sum, amount) => sum + Number(amount || 0), 0);
      if (spent !== points) errors.push(`Allocate exactly ${points} ability point(s) for ${effect.id}; ${spent} selected.`);
    }
    for (const effect of occurrences.filter(entry => entry.type === "item.advance")) {
      if (!this.state.progressionTargets[effect.operationId]) errors.push(`Select an owned ${effect.trait} to advance.`);
    }
    return uniqueMessages(errors);
  }

  async #resolveFormula(formula, metadata) {
    const key = metadata.rollId ?? metadata.operationId;
    const cached = this.#formulaCache.has(key) ? this.#formulaCache.get(key) : FORMULA_CACHE_MISS;
    if (cached !== FORMULA_CACHE_MISS) return cached;
    const result = Number(await this.#formulaResolver(formula, metadata, this.actor));
    if (!Number.isFinite(result)) throw new Error(`Formula "${formula}" did not produce a finite total.`);
    this.#formulaCache.set(key, result);
    return result;
  }

  async refreshPreview() {
    const ticket = ++this.#generation;
    this.state.preview = null;
    this.state.previewError = null;
    // The selected Character can change while this window remains open. A
    // manual refresh must re-evaluate owned-Item and ability conditions before
    // validation so hidden stale choices never reach the signed compiler.
    this.#reconcileInputs();
    this.state.inputErrors = this.#inputErrors();
    if (this.state.inputErrors.length) {
      // A now-incomplete input supersedes any older in-flight preview and must
      // immediately release the disabled UI state for this generation.
      this.state.busy = false;
      return null;
    }
    this.state.busy = true;
    try {
      const definition = this.definition;
      const preview = await this.#service.previewAdvancement({
        definitionId: definition.id,
        actor: this.actor,
        classItem: this.classItem,
        rank: this.targetRank(),
        profileId: definition.profileId,
        choices: cloneDraft(this.state.choices),
        abilityAllocations: cloneDraft(this.state.abilityAllocations),
        progressionTargets: cloneDraft(this.state.progressionTargets),
        resolveFormula: (formula, metadata) => this.#resolveFormula(formula, metadata),
        // Both owned-Class and Actor-backed definitions cross a signed domain
        // executor boundary. Provider provenance remains irrelevant.
        prepareExecutor: true,
      });
      if (ticket !== this.#generation) return null;
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
    if (!preview || this.isPreviewExpired()) throw new Error("Create a current valid advancement preview before committing.");
    this.#commitPromise = (async () => {
      this.state.busy = true;
      try {
      // This is intentionally the complete client commit payload.
      const result = await this.#service.commitAdvancement(preview.previewId, preview.planDigest);
      this.state.receipt = result?.receipt ?? result ?? null;
      // The live Actor/Class now represents the next base state. Rebuild the
      // in-memory draft for that state without silently rolling the next rank.
      this.#resetInputs();
      this.state.inputErrors = this.#inputErrors();
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

  async undoReceipt(receiptId) {
    if (this.#undoPromise) return this.#undoPromise;
    this.#undoPromise = this.#undoReceipt(receiptId);
    try { return await this.#undoPromise; }
    finally { this.#undoPromise = null; }
  }

  async #undoReceipt(receiptId) {
    const receipt = await this.#service.lookupReceipt?.(receiptId) ?? this.#service.getReceipt?.(receiptId);
    if (!receipt) throw new Error(`Progression receipt "${receiptId}" is unavailable.`);
    const undoPreview = await this.#service.previewUndo(receiptId);
    this.state.undoPreview = undoPreview;
    this.state.undoError = undoPreview.allowed ? null : {message: undoPreview.reasons?.join(", ") || "Undo is not safe."};
    if (!undoPreview.allowed) return null;
    const confirmed = await this.#confirmer({receipt, preview: undoPreview, actor: this.actor, classItem: this.classItem});
    if (confirmed !== true) return null;
    this.state.busy = true;
    try {
      const result = await this.#service.undo(receiptId, {
        confirmed: true,
        undoPreviewId: undoPreview.undoPreviewId,
        undoDigest: undoPreview.undoDigest,
      });
      this.state.receipt = result?.receipt ?? result ?? null;
      this.#resetInputs();
      this.state.inputErrors = this.#inputErrors();
      return result;
    } catch (error) {
      this.state.undoError = publicError(error);
      throw error;
    } finally {
      this.state.busy = false;
    }
  }

  isPreviewExpired(now = Date.now()) {
    return !this.state.preview || !Number.isFinite(Date.parse(this.state.preview.expiresAt)) || Date.parse(this.state.preview.expiresAt) <= now;
  }

  #definitionRecords() {
    const compatible = new Set(this.#compatibleDefinitions().map(definition => definition.id));
    return this.#definitions.map(definition => {
      const provider = this.#service.provider?.(definition.id) ?? null;
      const source = definition.sourceRefs?.[0];
      const availability = this.#availability(definition);
      return {
        id: definition.id,
        label: provider?.label ?? source?.label ?? definition.id,
        version: definition.version,
        profileId: definition.profileId,
        selected: definition.id === this.state.definitionId,
        compatible: compatible.has(definition.id),
        available: availability.available,
        state: availability.state,
        reason: availability.reason,
        currentRank: availability.currentRank,
        targetRank: availability.targetRank,
        providerLabel: providerKindLabel(provider),
      };
    });
  }

  #choiceGroupModels() {
    return (this.#milestone()?.choiceGroups ?? []).map(group => {
      const selected = new Set(this.state.choices[group.id] ?? []);
      const groupStatus = this.#evaluationResult(group.evaluations);
      return {
        ...group,
        available: groupStatus.available,
        unavailableReason: groupStatus.reason,
        instruction: group.minimum === group.maximum ? `Choose ${group.minimum}` : `Choose ${group.minimum}-${group.maximum}`,
        searchable: group.options.length >= CHOICE_SEARCH_THRESHOLD,
        selectedCount: selected.size,
        optionCount: group.options.length,
        options: group.options.map(option => {
          const detail = optionDetail(option, this.definition);
          const conflict = this.#choiceOptionConflict(option);
          const hypothetical = cloneDraft(this.state.choices);
          if (group.maximum === 1) hypothetical[group.id] = [option.id];
          else hypothetical[group.id] = [...new Set([...(hypothetical[group.id] ?? []), option.id])];
          const optionStatus = this.#evaluationResult(option.evaluations, hypothetical);
          const unavailableReason = !groupStatus.available
            ? groupStatus.reason
            : !optionStatus.available ? optionStatus.reason : conflict?.message ?? "";
          return {
            ...option,
            detail,
            available: groupStatus.available && optionStatus.available && !conflict,
            unavailable: !groupStatus.available || !optionStatus.available || Boolean(conflict),
            unavailableReason,
            searchText: `${option.label} ${detail} ${unavailableReason} ${option.id}`.toLocaleLowerCase(),
            selected: selected.has(option.id),
          };
        }),
      };
    });
  }

  #choiceOptionConflict(option) {
    for (const effect of option?.effects ?? []) {
      const conflict = ownedFocusAcquisitionConflict(this.actor, this.definition, effect);
      if (conflict) return conflict;
    }
    return null;
  }

  #abilityModels(occurrences) {
    const abilities = sourceSystem(this.actor).abilities ?? {};
    return occurrences.filter(effect => effect.type === "ability.allocate").map(effect => {
      const allocations = this.state.abilityAllocations[effect.operationId] ?? {};
      const points = effectAmount(effect);
      const spent = Object.values(allocations).reduce((sum, amount) => sum + Number(amount || 0), 0);
      return {
        operationId: effect.operationId,
        label: effectLabel(effect, this.definition),
        points: points ?? "?",
        spent,
        remaining: points === null ? "?" : points - spent,
        options: this.#eligibleAbilityIds(effect).map(id => ({
          id,
          name: abilityName(id),
          current: Number(abilities[id]?.value) || 0,
          allocation: allocations[id] ?? 0,
        })),
      };
    });
  }

  #targetModels(occurrences) {
    return occurrences.filter(effect => effect.type === "item.acquire" || effect.type === "item.advance").map(effect => {
      const candidates = this.#targetCandidates(effect).map(item => ({
        id: stableDocumentId(item),
        name: item.name ?? stableDocumentId(item),
        img: item.img ?? "icons/svg/item-bag.svg",
        selected: stableDocumentId(item) === this.state.progressionTargets[effect.operationId],
      }));
      const required = effect.type === "item.advance";
      return {
        operationId: effect.operationId,
        label: effectLabel(effect, this.definition),
        itemLabel: effect.type === "item.acquire" ? sourceRefLabel(this.definition, effect.sourceRefId) : humanizeIdentifier(effect.trait),
        trait: effect.trait ?? "",
        required,
        help: required
          ? `Required: choose the owned ${humanizeIdentifier(effect.trait)} to improve.`
          : "Optional: choose a matching owned Item to improve instead of adding a duplicate.",
        value: this.state.progressionTargets[effect.operationId] ?? "",
        candidates,
      };
    }).filter(target => target.required || target.candidates.length > 0);
  }

  #receiptModels() {
    if (!(this.#service.receipts instanceof Function) || !this.actor) return [];
    return asArray(this.#service.receipts({actorUuid: documentUuid(this.actor), kind: "rank.advance", state: "committed"}))
      .slice().reverse().map((receipt, index) => {
        const definition = this.#definitions.find(entry => entry.id === receipt.definitionId) ?? null;
        const rank = receiptRank(this.actor, receipt);
        return {
          ...receipt,
          latest: index === 0,
          stateLabel: receipt.state === "undone" ? "Undone" : "Committed",
          rankLabel: rank === null ? "Advancement" : `Rank ${rank}`,
          definitionLabel: providerLabel(this.#service.provider?.(receipt.definitionId) ?? null, definition),
          createdLabel: receipt.createdAt ? new Date(receipt.createdAt).toLocaleString() : "Recorded advancement",
        };
      });
  }

  context(now = Date.now()) {
    const definition = this.definition;
    const milestone = this.#milestone();
    const anticipated = progressionInputOccurrences(definition, this.targetRank(), this.state.choices);
    const effects = this.state.preview?.resolvedEffects ?? anticipated;
    const definitionErrors = definitionReadinessMessages(this.#service, definition, "rank.advance");
    const expiresAt = this.state.preview ? Date.parse(this.state.preview.expiresAt) : null;
    const remainingMs = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : null;
    const profileId = activeProfileId(this.#settingResolver) ?? definition?.profileId ?? "custom";
    const availability = this.#availability(definition);
    const previewExpired = Boolean(this.state.preview) && remainingMs === 0;
    const pathComplete = availability.available && definitionErrors.length === 0;
    const choicesComplete = pathComplete && this.state.inputErrors.length === 0;
    const reviewComplete = choicesComplete && Boolean(this.state.preview) && !previewExpired;
    const workflowStages = [
      {id: "path", number: 1, label: "Choose the path", complete: pathComplete, current: !pathComplete},
      {id: "choices", number: 2, label: "Make rank choices", complete: choicesComplete, current: pathComplete && !choicesComplete},
      {id: "review", number: 3, label: "Review and apply", complete: reviewComplete || this.state.receipt?.state === "committed", current: choicesComplete},
    ];
    const commitBlockers = commitBlockerModels({
      busy: this.state.busy,
      definitionErrors,
      inputErrors: this.state.inputErrors,
      previewError: this.state.previewError,
      preview: this.state.preview,
      previewExpired,
      availability,
    });
    const provider = definition ? this.#service.provider?.(definition.id) ?? null : null;
    const receiptResult = this.state.receipt ? {
      id: this.state.receipt.id,
      state: this.state.receipt.state,
      title: this.state.receipt.state === "undone" ? "Advancement safely undone" : "Advancement committed",
      message: this.state.receipt.state === "undone"
        ? "The signed transaction was reversed and its receipt was retained for audit."
        : "The signed transaction and recovery receipt were saved. Reopen the Character to verify the new rank.",
      rank: receiptRank(this.actor, this.state.receipt),
    } : null;
    return {
      actors: this.#actors.map(actor => ({uuid: documentUuid(actor), name: actor.name, selected: documentUuid(actor) === this.state.actorUuid})),
      classes: ownedClasses(this.actor, this.user).map(item => ({id: stableDocumentId(item), name: item.name, level: Number(sourceSystem(item).level) || 0, selected: stableDocumentId(item) === this.state.classItemId})),
      definitions: this.#definitionRecords(),
      actor: this.actor,
      classItem: this.classItem,
      definition,
      usesClassTrack: definition?.trackBinding?.kind === "class-item",
      provider,
      providerLabel: providerLabel(provider, definition),
      providerKindLabel: providerKindLabel(provider),
      profileId,
      currentRank: this.currentRank(),
      targetRank: this.targetRank(),
      milestone,
      sources: (definition?.sourceRefs ?? []).map(source => ({...source, detail: source.uuid ?? source.revision ?? source.kind})),
      choiceGroups: this.#choiceGroupModels(),
      abilityGroups: this.#abilityModels(anticipated),
      targetGroups: this.#targetModels(anticipated),
      formulas: effects.filter(effect => formulaLabel(effect)).map(effect => ({
        operationId: effect.operationId,
        formula: formulaLabel(effect),
        result: effect.resolution ? effect.amount : this.#formulaCache.get(formulaCacheKey(effect)) ?? "—",
        pinned: Boolean(effect.resolution),
      })),
      effects: effects.map(effect => ({...effect, display: effectLabel(effect, definition), pinned: Boolean(this.state.preview)})),
      summary: effects.filter(effect => effect.type === "summary.add").map(effect => effect.label),
      definitionErrors,
      inputErrors: [...this.state.inputErrors],
      availability,
      advancementAvailable: availability.available,
      availabilityMessage: availability.reason,
      hasDefinitions: this.#definitions.length > 0,
      hasCompatibleDefinitions: this.#compatibleDefinitions().length > 0,
      previewError: this.state.previewError,
      undoError: this.state.undoError,
      preview: this.state.preview,
      receipt: this.state.receipt,
      receiptResult,
      receipts: this.#receiptModels(),
      busy: this.state.busy,
      canCommit: commitBlockers.length === 0 && availability.available && Boolean(this.state.preview) && remainingMs > 0,
      commitBlockers,
      commitStatus: commitBlockers[0]?.message ?? "Signed preview ready. Review the changes, then apply advancement.",
      workflowStages,
      hasPreview: Boolean(this.state.preview),
      previewExpired,
      previewExpiring: Boolean(this.state.preview) && remainingMs > 0 && remainingMs < 60_000,
      previewRemaining: remainingMs === null ? null : Math.ceil(remainingMs / 1000),
      hasLegacyFallback: Boolean(this.classItem),
    };
  }
}

export class AgeAdvancementCenter extends HandlebarsApplicationMixin(ApplicationV2) {
  #choiceFilters = new Map();
  #selectedOnlyGroups = new Set();

  static DEFAULT_OPTIONS = {
    id: "age-advancement-center",
    classes: ["age-system", "age-advancement-center"],
    position: {width: 900, height: 780},
    window: {title: "AGE Advancement Center", resizable: true, minimizable: true},
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/progression/advancement-center.hbs",
      scrollable: [".age-advancement-center__scroll"],
    },
  };

  constructor(options = {}) {
    const {
      controller = null,
      legacyFallback = null,
      service,
      actorsProvider,
      settingResolver,
      userResolver,
      formulaResolver,
      confirmer,
      actor,
      classItem,
      definitionId,
      ...applicationOptions
    } = options;
    super(applicationOptions);
    this.controller = controller ?? new AgeAdvancementCenterController({
      service,
      actorsProvider,
      settingResolver,
      userResolver,
      formulaResolver,
      confirmer,
      actor,
      classItem,
      definitionId,
    });
    this.legacyFallback = legacyFallback;
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
    const prepared = this.controller.context();
    prepared.hasLegacyFallback = Boolean(this.legacyFallback && prepared.classItem);
    return Object.assign(context, prepared);
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
    for (const input of this.element?.querySelectorAll?.("[data-age-advancement-choice-filter]") ?? []) {
      input.value = this.#choiceFilters.get(input.dataset.groupId) ?? "";
      const selectedOnly = input.closest?.("[data-age-advancement-choice-group]")
        ?.querySelector?.("[data-age-advancement-choice-selected]");
      if (selectedOnly) selectedOnly.checked = this.#selectedOnlyGroups.has(input.dataset.groupId);
      this.#applyChoiceFilter(input);
    }
  }

  #onChoiceFilter(event) {
    const input = event.target.closest?.("[data-age-advancement-choice-filter]");
    if (input) {
      this.#choiceFilters.set(input.dataset.groupId, input.value);
      this.#applyChoiceFilter(input);
      return;
    }
    const selectedOnly = event.target.closest?.("[data-age-advancement-choice-selected]");
    if (!selectedOnly) return;
    if (selectedOnly.checked) this.#selectedOnlyGroups.add(selectedOnly.dataset.groupId);
    else this.#selectedOnlyGroups.delete(selectedOnly.dataset.groupId);
    const search = selectedOnly.closest?.("[data-age-advancement-choice-group]")
      ?.querySelector?.("[data-age-advancement-choice-filter]");
    if (search) this.#applyChoiceFilter(search);
  }

  #applyChoiceFilter(input) {
    const panel = input.closest?.("[data-age-advancement-choice-group]");
    if (!panel) return;
    const query = String(input.value ?? "").trim().toLocaleLowerCase();
    const selectedOnly = this.#selectedOnlyGroups.has(input.dataset.groupId);
    let visible = 0;
    for (const option of panel.querySelectorAll?.("[data-age-advancement-choice-option]") ?? []) {
      const matchesSearch = !query || String(option.dataset.searchText ?? option.textContent ?? "").toLocaleLowerCase().includes(query);
      const matches = matchesSearch && (!selectedOnly || option.querySelector?.("input[type=checkbox]")?.checked === true);
      option.hidden = !matches;
      if (matches) visible += 1;
    }
    const empty = panel.querySelector?.("[data-age-advancement-choice-empty]");
    if (empty) empty.hidden = visible > 0;
    const count = panel.querySelector?.("[data-age-advancement-choice-visible]");
    if (count) count.textContent = String(visible);
    const clear = panel.querySelector?.("[data-age-advancement-action=clear-choice-filter]");
    if (clear) clear.disabled = !query && !selectedOnly;
  }

  async #run(operation, {render = true} = {}) {
    try {
      await operation();
    } catch (error) {
      if (!error?.code && !String(error?.name ?? "").startsWith("AgeProgression")) {
        console.error("AGE System | Advancement Center", error);
      }
      globalThis.ui?.notifications?.error?.(error.message);
    }
    if (render) await this.render({force: true});
  }

  #onChange(event) {
    const target = event.target.closest?.("[data-age-advancement-change]");
    if (!target) return;
    const action = target.dataset.ageAdvancementChange;
    return this.#run(async () => {
      if (action === "actor") return this.controller.selectActor(target.value);
      if (action === "class") return this.controller.selectClass(target.value);
      if (action === "definition") return this.controller.selectDefinition(target.value);
      if (action === "choice") return this.controller.setChoice(target.dataset.groupId, target.dataset.optionId, target.checked);
      if (action === "ability") return this.controller.setAbilityAllocation(target.dataset.operationId, target.dataset.abilityId, target.value);
      if (action === "target") return this.controller.setProgressionTarget(target.dataset.operationId, target.value);
    });
  }

  #onClick(event) {
    const step = event.target.closest?.("[data-age-advancement-scroll]");
    if (step) {
      event.preventDefault();
      this.element?.querySelector?.(`[data-age-advancement-stage="${step.dataset.ageAdvancementScroll}"]`)
        ?.scrollIntoView?.({behavior: "smooth", block: "start"});
      return;
    }
    const target = event.target.closest?.("[data-age-advancement-action]");
    if (!target) return;
    event.preventDefault();
    const action = target.dataset.ageAdvancementAction;
    if (action === "cancel") return this.close();
    if (action === "clear-choice-filter") {
      const panel = target.closest?.("[data-age-advancement-choice-group]");
      const input = panel?.querySelector?.("[data-age-advancement-choice-filter]");
      if (!input) return;
      this.#choiceFilters.delete(input.dataset.groupId);
      this.#selectedOnlyGroups.delete(input.dataset.groupId);
      input.value = "";
      const selectedOnly = panel.querySelector?.("[data-age-advancement-choice-selected]");
      if (selectedOnly) selectedOnly.checked = false;
      this.#applyChoiceFilter(input);
      return;
    }
    if (action === "legacy") {
      return this.#run(async () => {
        if (!(this.legacyFallback instanceof Function)) throw new Error("Legacy advancement fallback is unavailable.");
        await this.close();
        return this.legacyFallback(this.controller.actor, this.controller.classItem);
      }, {render: false});
    }
    return this.#run(async () => {
      if (action === "refresh") return this.controller.refreshPreview();
      if (action === "reroll") return this.controller.rerollFormula(target.dataset.operationId);
      if (action === "commit") {
        const result = await this.controller.commitPreview();
        globalThis.ui?.notifications?.info?.("AGE advancement committed.");
        return result;
      }
      if (action === "undo") {
        const result = await this.controller.undoReceipt(target.dataset.receiptId);
        if (result) globalThis.ui?.notifications?.info?.("AGE advancement undone.");
        return result;
      }
    });
  }
}

export default AgeAdvancementCenter;
