import {
  AGE_PROGRESSION_DEFINITION_VERSION,
  assertProgressionDefinitionV1,
  validateProgressionDefinitionV1,
} from "./contracts.js";

/**
 * Pure compatibility adapter for the v3 Class Item advancement schema.
 *
 * This module deliberately accepts raw `system` data only.  In particular it
 * never resolves UUIDs, reads an Actor, evaluates a Roll, or receives a live
 * Foundry Document.  Resolving formulas and source references is a preview
 * concern, before an advancement is committed.
 */
export const CLASS_V3_ADAPTER_VERSION = 1;
export const CLASS_V3_MAX_LEVEL = 20;

const PROGRESSIVE_TRAITS = new Set([
  "health",
  "conviction",
  "advAbility",
  "powerPoints",
  "defenseAndToughness",
]);
const GRANT_TRAITS = new Set(["spec", "stunts", "talent", "power", "focus", "relationship"]);
const PROGRESSABLE_TRAITS = new Set(["spec", "talent", "focus", "relationship"]);
const EMPTY_VALUES = new Set(["", null, undefined, 0, "0"]);

const clone = value => structuredClone(value);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = value => !EMPTY_VALUES.has(value);
const text = value => typeof value === "string" ? value.trim() : "";
const idPart = value => String(value ?? "").replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "legacy";

function issue(path, message, severity = "error") {
  return {path, message, severity};
}

function isLiveDocument(value) {
  return isObject(value) && (
    typeof value.toObject === "function"
    || typeof value.update === "function"
    || typeof value.documentName === "string"
    || "_source" in value
  );
}

function hasNonPlainValue(value, seen = new Set()) {
  if (value === null || value === undefined) return false;
  const type = typeof value;
  if (type === "function" || type === "symbol" || type === "bigint") return true;
  if (type !== "object") return false;
  if (seen.has(value)) return true;
  if (isLiveDocument(value)) return true;
  seen.add(value);
  const invalid = Array.isArray(value)
    ? value.some(entry => hasNonPlainValue(entry, seen))
    : Object.values(value).some(entry => hasNonPlainValue(entry, seen));
  seen.delete(value);
  return invalid;
}

function normalizeValues(values) {
  const source = Array.isArray(values)
    ? values
    : isObject(values)
      ? Object.keys(values).sort((left, right) => Number(left) - Number(right)).map(key => values[key])
      : [];
  return Array.from({length: CLASS_V3_MAX_LEVEL}, (_value, index) => source[index] ?? 0);
}

function rawValueCount(values) {
  if (Array.isArray(values)) return values.length;
  if (isObject(values)) return Object.keys(values).length;
  return 0;
}

function normalizeGrant(grant = {}, index = 0) {
  const trait = grant.trait === "spec" ? "spec" : (grant.trait ?? grant.type ?? "");
  return {
    id: String(grant.id ?? `grant-${index}`),
    uuid: text(grant.uuid) || null,
    type: String(grant.type ?? (trait === "spec" ? "talent" : trait)),
    trait: String(trait),
    name: String(grant.name ?? ""),
    img: String(grant.img ?? ""),
    isItemProg: grant.isItemProg === true,
  };
}

function normalizeProgressive(entry = {}, index = 0) {
  return {
    id: String(entry.id ?? `progressive-${index}`),
    trait: String(entry.trait ?? "health"),
    alias: String(entry.alias ?? ""),
    values: normalizeValues(entry.values ?? entry.adv),
  };
}

function normalizeItem(entry = {}, index = 0) {
  const grants = (entry.grants ?? entry.itemArr ?? []).map(normalizeGrant);
  const requestedMode = entry.selectionMode ?? (entry.itemOption === "multiple" ? "choose" : "all");
  const selectionMode = requestedMode === "choose" ? "choose" : "all";
  const requestedQuantity = Number(entry.quantity ?? entry.itemQtd ?? grants.length);
  const quantity = selectionMode === "choose"
    ? Math.max(1, Math.min(Number.isFinite(requestedQuantity) ? requestedQuantity : 1, Math.max(1, grants.length)))
    : grants.length;
  return {
    id: String(entry.id ?? `item-${index}`),
    level: Math.max(1, Math.min(CLASS_V3_MAX_LEVEL, Number(entry.level) || 1)),
    alias: String(entry.alias ?? ""),
    selectionMode,
    quantity,
    allowProgression: entry.allowProgression !== false,
    grants,
  };
}

function normalizedClassV3(system = {}) {
  const progressive = Array.isArray(system?.advancements?.progressive)
    ? system.advancements.progressive.map(normalizeProgressive)
    : [];
  const items = Array.isArray(system?.advancements?.item)
    ? system.advancements.item.map(normalizeItem)
    : [];
  return {
    level: Math.max(0, Math.min(CLASS_V3_MAX_LEVEL, Number(system?.level) || 0)),
    primaryAbl: Array.isArray(system?.primaryAbl) ? [...new Set(system.primaryAbl.filter(Boolean).map(String))] : [],
    wgroups: Array.isArray(system?.wgroups) ? [...new Set(system.wgroups.filter(Boolean).map(String))] : [],
    progressionVersion: Number(system?.advancementVersion ?? system?.progression?.version ?? 0),
    advancements: {progressive, item: items},
  };
}

function validateRawShape(system, errors) {
  if (!isObject(system)) {
    errors.push(issue("$", "Class v3 input must be a plain system-data object."));
    return;
  }
  if (isLiveDocument(system)) errors.push(issue("$", "Live Documents are not valid Class v3 adapter input; pass raw item.system data."));
  if (hasNonPlainValue(system)) errors.push(issue("$", "Class v3 input contains a live, cyclic, or non-serializable value."));
  if (system.advancements !== undefined && !isObject(system.advancements)) {
    errors.push(issue("advancements", "Class v3 advancements must be an object."));
  }
  for (const name of ["progressive", "item"]) {
    const value = system.advancements?.[name];
    if (value !== undefined && !Array.isArray(value)) errors.push(issue(`advancements.${name}`, "Must be an array."));
  }
}

function formulaAmount(formula, rollId = null) {
  return {kind: "formula", formula: String(formula), ...(rollId ? {rollId} : {})};
}

function effect(id, type, data = {}) {
  return {id, type, ...data};
}

function sourceKindForUuid(uuid) {
  if (String(uuid).startsWith("Compendium.")) return "compendium";
  if (String(uuid).startsWith("JournalEntry.")) return "journal";
  return "manual";
}

function addSourceReference(sourceRefs, grant, groupIndex, grantIndex) {
  const id = `grant:${groupIndex}:${grantIndex}:${idPart(grant.id)}`;
  const existing = sourceRefs.find(reference => reference.uuid && reference.uuid === grant.uuid);
  if (existing) return existing.id;
  sourceRefs.push({
    id,
    kind: sourceKindForUuid(grant.uuid),
    uuid: grant.uuid,
    label: grant.name || grant.uuid,
  });
  return id;
}

function grantEffect(grant, sourceRefId, id) {
  if (grant.isItemProg) return effect(id, "item.advance", {trait: grant.trait});
  return effect(id, "item.acquire", {sourceRefId, quantity: 1});
}

function progressiveEffects(entry, level, result) {
  const id = `${idPart(entry.id)}:${level}`;
  const amount = entry.trait === "advAbility"
    ? Number(entry.values[level - 1])
    : formulaAmount(entry.values[level - 1], `class-v3:${id}`);
  switch (entry.trait) {
    case "advAbility":
      return [effect(`effect:ability:${id}`, "ability.allocate", {amount})];
    case "health":
    case "powerPoints":
    case "conviction":
      return [
        effect(`effect:resource:${id}`, "resource.gain", {resource: entry.trait, amount}),
        effect(`effect:bonus:${id}`, "classBonus.gain", {bonus: entry.trait, amount}),
        effect(`effect:summary:${id}`, "summary.add", {entryId: `progressive:${id}`, label: entry.alias || entry.trait}),
      ];
    case "defenseAndToughness":
      return [
        effect(`effect:defense:${id}`, "classBonus.gain", {bonus: "defense", amount}),
        effect(`effect:toughness:${id}`, "classBonus.gain", {bonus: "toughness", amount}),
        effect(`effect:summary:${id}`, "summary.add", {entryId: `progressive:${id}`, label: entry.alias || entry.trait}),
      ];
    default:
      result.errors.push(issue(`advancements.progressive.${entry.id}`, `Unsupported progressive trait "${entry.trait}".`));
      return [];
  }
}

/**
 * Validate whether raw Class v3 system data can be expressed by
 * Progression Definition V1.  Errors deliberately include an exact source
 * path, so content authors can repair a legacy definition without guessing.
 */
export function validateClassV3Compatibility(system, options = {}) {
  const errors = [];
  const warnings = [];
  validateRawShape(system, errors);
  if (errors.length) return {valid: false, errors, warnings, normalized: null};

  const normalized = normalizedClassV3(system);
  const version = Number(system.advancementVersion ?? system.progression?.version ?? 0);
  if (version !== 0 && version !== 3) {
    errors.push(issue("advancementVersion", `Expected Class advancement schema v3, received v${version}.`));
  }

  if (Array.isArray(system.primaryAbl) === false && system.primaryAbl !== undefined) {
    errors.push(issue("primaryAbl", "Primary ability group must be an array."));
  }
  if (Array.isArray(system.wgroups) === false && system.wgroups !== undefined) {
    errors.push(issue("wgroups", "Weapon group grants must be an array."));
  }

  const progressiveIds = new Set();
  for (const [index, raw] of (system.advancements?.progressive ?? []).entries()) {
    const path = `advancements.progressive[${index}]`;
    if (!isObject(raw)) { errors.push(issue(path, "Progressive advancement must be an object.")); continue; }
    const entry = normalized.advancements.progressive[index];
    if (progressiveIds.has(entry.id)) errors.push(issue(`${path}.id`, `Duplicate progressive advancement id "${entry.id}".`));
    progressiveIds.add(entry.id);
    if (!PROGRESSIVE_TRAITS.has(entry.trait)) errors.push(issue(`${path}.trait`, `Unsupported progressive trait "${entry.trait}".`));
    const rawValues = raw.values ?? raw.adv;
    if (rawValueCount(rawValues) > CLASS_V3_MAX_LEVEL) {
      errors.push(issue(`${path}.${raw.values !== undefined ? "values" : "adv"}`, "Contains more than the supported 20 class levels."));
    }
    entry.values.forEach((value, levelIndex) => {
      if (!nonEmpty(value)) return;
      const valuePath = `${path}.${raw.values !== undefined ? "values" : "adv"}[${levelIndex}]`;
      if (entry.trait === "advAbility") {
        if (!Number.isInteger(Number(value)) || Number(value) < 0) {
          errors.push(issue(valuePath, "Ability advancement must be a non-negative integer."));
        }
      } else if (!text(value)) {
        errors.push(issue(valuePath, "Resource advancement requires a non-empty formula."));
      } else if (typeof options.formulaValidator === "function" && !options.formulaValidator(String(value))) {
        errors.push(issue(valuePath, `Formula "${value}" is invalid.`));
      }
    });
  }

  const itemIds = new Set();
  for (const [index, raw] of (system.advancements?.item ?? []).entries()) {
    const path = `advancements.item[${index}]`;
    if (!isObject(raw)) { errors.push(issue(path, "Item advancement must be an object.")); continue; }
    const entry = normalized.advancements.item[index];
    if (itemIds.has(entry.id)) errors.push(issue(`${path}.id`, `Duplicate item advancement id "${entry.id}".`));
    itemIds.add(entry.id);
    if (!Number.isInteger(Number(raw.level)) || Number(raw.level) < 1 || Number(raw.level) > CLASS_V3_MAX_LEVEL) {
      errors.push(issue(`${path}.level`, "Item advancement level must be an integer from 1 to 20."));
    }
    if (!entry.grants.length) errors.push(issue(`${path}.grants`, "Item advancement needs at least one grant."));
    const requestedQuantity = raw.quantity ?? raw.itemQtd ?? entry.grants.length;
    if (entry.selectionMode === "choose" && (!Number.isInteger(Number(requestedQuantity)) || Number(requestedQuantity) < 1 || Number(requestedQuantity) > entry.grants.length)) {
      errors.push(issue(`${path}.quantity`, "Choice quantity must be an integer within the grant count."));
    }
    const grantIds = new Set();
    const rawGrants = raw.grants ?? raw.itemArr ?? [];
    for (const [grantIndex] of entry.grants.entries()) {
      const grantPath = `${path}.${raw.grants !== undefined ? "grants" : "itemArr"}[${grantIndex}]`;
      const grant = entry.grants[grantIndex];
      if (grantIds.has(grant.id)) errors.push(issue(`${grantPath}.id`, `Duplicate grant id "${grant.id}".`));
      grantIds.add(grant.id);
      if (!GRANT_TRAITS.has(grant.trait)) errors.push(issue(`${grantPath}.trait`, `Unsupported grant trait "${grant.trait}".`));
      if (grant.isItemProg && !PROGRESSABLE_TRAITS.has(grant.trait)) {
        errors.push(issue(`${grantPath}.isItemProg`, `Generic progression is not supported for trait "${grant.trait}".`));
      }
      if (!grant.isItemProg && !grant.uuid) errors.push(issue(`${grantPath}.uuid`, "Concrete grant requires a source UUID."));
      if (grant.isItemProg && grant.uuid) warnings.push(issue(`${grantPath}.uuid`, "Ignored by generic progression.", "warning"));
      if (!isObject(rawGrants[grantIndex] ?? {})) errors.push(issue(grantPath, "Grant must be an object."));
    }
  }

  return {valid: errors.length === 0, errors, warnings, normalized};
}

function addItemMilestoneData(milestone, entry, groupIndex, sourceRefs) {
  const effects = [];
  const options = entry.grants.map((grant, grantIndex) => {
    const sourceRefId = grant.isItemProg ? null : addSourceReference(sourceRefs, grant, groupIndex, grantIndex);
    return {
      id: `grant:${idPart(entry.id)}:${grantIndex}:${idPart(grant.id)}`,
      label: grant.name || grant.trait,
      sourceRefIds: sourceRefId ? [sourceRefId] : [],
      evaluations: [],
      effects: [grantEffect(grant, sourceRefId, `effect:grant:${idPart(entry.id)}:${grantIndex}:${idPart(grant.id)}`)],
    };
  });
  if (entry.selectionMode === "choose") {
    milestone.choiceGroups.push({
      id: `choice:${idPart(entry.id)}`,
      label: entry.alias || "Class advancement",
      minimum: entry.quantity,
      maximum: entry.quantity,
      distinct: true,
      options,
    });
  } else {
    effects.push(...options.flatMap(option => option.effects));
  }
  milestone.effects.push(...effects);
}

/**
 * Convert raw v3 Class Item system data into the strict, serializable
 * Progression Definition V1 contract.  This only describes work: it does not
 * resolve a UUID, evaluate a formula, or mutate a character.
 */
export function adaptClassV3Definition(system, options = {}) {
  const compatibility = validateClassV3Compatibility(system, options);
  if (!compatibility.valid) {
    const details = compatibility.errors.map(entry => `${entry.path}: ${entry.message}`).join("\n");
    throw new Error(`Class v3 progression cannot be adapted:\n${details}`);
  }
  const classId = idPart(options.id ?? options.classId ?? "class-v3");
  const sourceRefs = [{
    id: "class-v3",
    kind: "manual",
    label: String(options.label ?? options.className ?? classId),
    ...(text(options.uuid) ? {uuid: text(options.uuid)} : {}),
    ...(text(options.revision) ? {revision: text(options.revision)} : {}),
  }];
  const milestones = Array.from({length: CLASS_V3_MAX_LEVEL}, (_value, index) => ({
    id: `class-v3:${classId}:level:${index + 1}`,
    rank: index + 1,
    triggers: index === 0 ? ["character.create", "rank.advance"] : ["rank.advance"],
    sourceRefIds: ["class-v3"],
    choiceGroups: [],
    evaluations: [],
    effects: [],
  }));
  const normalized = compatibility.normalized;
  const capabilities = [
    "age.class-v3",
    "age.class-v3.ability-eligibility",
    "age.class-v3.item-progression-targeting",
    "age.class-v3.reversible-transaction",
  ];

  // Class v3 applies these once when its first level is gained.
  for (const abilityId of normalized.primaryAbl) {
    milestones[0].effects.push(effect(`effect:primary:${idPart(abilityId)}`, "ability.setPrimary", {abilityId}));
  }
  for (const weaponGroupId of normalized.wgroups) {
    milestones[0].effects.push(effect(`effect:weapon-group:${idPart(weaponGroupId)}`, "weaponGroup.add", {weaponGroupId}));
  }

  normalized.advancements.progressive.forEach(entry => {
    entry.values.forEach((value, index) => {
      if (!nonEmpty(value)) return;
      milestones[index].effects.push(...progressiveEffects(entry, index + 1, compatibility));
    });
  });
  normalized.advancements.item.forEach((entry, index) => {
    addItemMilestoneData(milestones[entry.level - 1], entry, index, sourceRefs);
  });
  for (const milestone of milestones) {
    if (milestone.effects.length) {
      milestone.effects.push(effect(
        `effect:level-summary:${milestone.rank}`,
        "summary.add",
        {entryId: `class-v3:${classId}:level:${milestone.rank}`, label: `Class level ${milestone.rank}`},
      ));
    }
  }

  const definitionId = `class-v3:${classId}`;
  const definition = {
    schemaVersion: AGE_PROGRESSION_DEFINITION_VERSION,
    id: definitionId,
    version: `${CLASS_V3_ADAPTER_VERSION}.0.0`,
    profileId: String(options.profileId ?? "legacy.class-v3"),
    capabilities,
    sourceRefs,
    rank: {kind: "level", minimum: 1, maximum: CLASS_V3_MAX_LEVEL},
    trackBinding: {
      kind: "class-item",
      trackId: definitionId,
      ...(text(options.uuid) ? {sourceUuids: [text(options.uuid)]} : {}),
    },
    milestones,
  };
  assertProgressionDefinitionV1(definition);
  return definition;
}

function formulaAddresses(definition) {
  const addresses = [];
  const inspectEffect = (effect, path) => {
    if (effect?.amount?.kind === "formula") addresses.push({path, formula: effect.amount.formula});
  };
  definition.milestones.forEach((milestone, milestoneIndex) => {
    milestone.effects.forEach((effect, effectIndex) => inspectEffect(effect, `milestones[${milestoneIndex}].effects[${effectIndex}]`));
    milestone.choiceGroups.forEach((group, groupIndex) => {
      group.options.forEach((option, optionIndex) => option.effects.forEach((effect, effectIndex) => {
        inspectEffect(effect, `milestones[${milestoneIndex}].choiceGroups[${groupIndex}].options[${optionIndex}].effects[${effectIndex}]`);
      }));
    });
  });
  return addresses;
}

function replaceFormulaAmounts(value, results, counter = {value: 0}) {
  if (Array.isArray(value)) return value.map(entry => replaceFormulaAmounts(entry, results, counter));
  if (!isObject(value)) return value;
  if (value.kind === "formula" && typeof value.formula === "string") {
    const index = counter.value++;
    const resolved = results[index] ?? results[value.formula];
    if (!Number.isFinite(Number(resolved)) || Number(resolved) < 0) {
      throw new Error(`Preview must resolve non-negative result for formula #${index + 1} (${value.formula}).`);
    }
    return Number(resolved);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceFormulaAmounts(entry, results, counter)]));
}

/**
 * Turn formula specifications into fixed numeric effect amounts for one
 * preview receipt.  A commit receives only this result, never a Roll/formula.
 * Results may be supplied by order (`[3, 2]`) or formula (`{"1d6": 3}`).
 */
export function resolveClassV3Preview(definition, resolvedFormulaResults = {}) {
  assertProgressionDefinitionV1(definition);
  const addresses = formulaAddresses(definition);
  const resultMap = Array.isArray(resolvedFormulaResults)
    ? Object.fromEntries(resolvedFormulaResults.map((value, index) => [index, value]))
    : {...resolvedFormulaResults};
  const resolved = replaceFormulaAmounts(clone(definition), resultMap);
  const validation = validateProgressionDefinitionV1(resolved);
  if (!validation.valid) throw new Error(`Resolved Class v3 preview is invalid: ${validation.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
  return {
    definition: resolved,
    resolvedFormulas: addresses.map((address, index) => ({...address, result: Number(resultMap[index] ?? resultMap[address.formula])})),
  };
}

export function isClassV3Definition(definition) {
  return definition?.schemaVersion === AGE_PROGRESSION_DEFINITION_VERSION
    && definition?.id?.startsWith("class-v3:")
    && Array.isArray(definition?.capabilities)
    && definition.capabilities.includes("age.class-v3");
}
