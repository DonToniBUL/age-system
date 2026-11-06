import { ageSystem } from "./config.js";

export const CLASS_ADVANCEMENT_VERSION = 3;
export const CLASS_MAX_LEVEL = 20;

const clone = value => foundry.utils.deepClone(value);
const cloneMaybe = value => value === undefined ? undefined : clone(value);
const getProperty = (object, path) => foundry.utils.getProperty(object, path);
const randomId = () => foundry.utils.randomID(20);
const equals = (left, right) => typeof foundry.utils.equals === "function"
  ? foundry.utils.equals(left, right)
  : JSON.stringify(left) === JSON.stringify(right);

/**
 * Produce the exact JSON value which Foundry can persist in a serializable
 * AnyField. Class transactions intentionally use omitted properties to record
 * source absence (for example a previously missing advancement summary).
 * `deepClone` retains those `undefined` members, but Foundry 14 correctly
 * rejects them because JSON serialization would silently remove them.
 */
export function classAdvancementJournalSnapshot(value, path = "classProgression") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (entry === undefined) throw new TypeError(`${path}[${index}] cannot be undefined.`);
      return classAdvancementJournalSnapshot(entry, `${path}[${index}]`);
    });
  }
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new TypeError(`${path} is not JSON serializable.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain JSON object.`);
  }
  const snapshot = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    snapshot[key] = classAdvancementJournalSnapshot(entry, `${path}.${key}`);
  }
  return snapshot;
}

/**
 * Normalize a persisted Class progression base level without converting an
 * explicit absence marker to zero. JavaScript's Number(null) and Number("")
 * both produce 0, but those source values mean "not established yet" and
 * must survive an apply/rollback cycle exactly.
 */
export function classAdvancementBaseLevel(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function atomicSnapshot(value) {
  if (value === null || value === undefined || typeof value !== "object") return cloneMaybe(value);
  return foundry.data.operators.ForcedReplacement.create(clone(value));
}

function completeItemSystemSnapshot(id, system) {
  // Class progression stores complete raw owned-Item system snapshots. Use a
  // system-level replacement so rollback also removes top-level and nested
  // keys which exist only in the current state.
  return {_id: id, system: atomicSnapshot(system)};
}

const PROGRESSIVE_TRAITS = new Set([
  "health",
  "conviction",
  "advAbility",
  "powerPoints",
  "defenseAndToughness"
]);
const GRANT_TRAITS = new Set(["spec", "stunts", "talent", "power", "focus", "relationship"]);
const PROGRESSABLE_TRAITS = new Set(["spec", "talent", "focus", "relationship"]);
const advancementLocks = new Set();
const ADVANCEMENT_LOCK_FLAG = "classAdvancementLock";
const ADVANCEMENT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const ADVANCEMENT_LOCK_SETTLE_MS = 75;

function sourceSystem(document) {
  const source = document?._source?.system ?? document?.toObject?.().system ?? document?.system ?? {};
  return clone(source);
}

function sourceItemData(item) {
  const data = item?._source ? clone(item._source) : (item?.toObject ? item.toObject() : clone(item ?? {}));
  return {
    name: data.name ?? item?.name ?? "",
    type: data.type ?? item?.type ?? "",
    img: data.img ?? item?.img ?? "",
    system: clone(data.system ?? {}),
    flags: clone(data.flags ?? {}),
  };
}

function clamp(value, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  const min = Number.isFinite(Number(minimum)) ? Number(minimum) : 0;
  const max = Number.isFinite(Number(maximum)) ? Number(maximum) : Number.POSITIVE_INFINITY;
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function resourceMaximum(system, resource, bonuses) {
  const data = system?.[resource] ?? {};
  return Math.max(0, (Number(data.set) || 0) + (Number(data.mod) || 0) + (Number(bonuses?.[resource]) || 0));
}

function rollbackResourceMaximum(actor, transaction, resource) {
  const derivedMaximum = Number(actor.system?.[resource]?.max);
  const sourceMaximum = resourceMaximum(sourceSystem(actor), resource, classBonuses(actor));
  const currentMaximum = Number.isFinite(derivedMaximum) ? Math.max(derivedMaximum, sourceMaximum) : sourceMaximum;
  const classDelta = Number(transaction.resourceDeltas?.[resource] ?? 0);
  if (Number.isFinite(currentMaximum)) return Math.max(0, currentMaximum - classDelta);
  const recordedMaximum = Number(transaction.before?.resourceMaximums?.[resource]);
  if (Number.isFinite(recordedMaximum)) return Math.max(0, recordedMaximum);
  return resourceMaximum(sourceSystem(actor), resource, transaction.before?.classBonuses);
}

function transactionKey(actor, classItem) {
  return `${actor?.uuid ?? actor?.id ?? "actor"}:${classItem?.id ?? "class"}`;
}

async function withLock(actor, classItem, operation) {
  const key = transactionKey(actor, classItem);
  if (advancementLocks.has(key)) throw new Error(localize("age-system.WARNING.classAdvancementBusy", "A class advancement operation is already running for this character."));
  advancementLocks.add(key);
  const token = `${game.user?.id ?? "user"}:${randomId()}`;
  let ownsSharedLock = false;
  try {
    if (typeof actor?.getFlag === "function" && typeof actor?.setFlag === "function") {
      const current = actor.getFlag("age-system", ADVANCEMENT_LOCK_FLAG);
      const currentAge = Date.now() - Number(current?.timestamp ?? 0);
      if (current?.token && currentAge < ADVANCEMENT_LOCK_TIMEOUT_MS) {
        throw new Error(localize("age-system.WARNING.classAdvancementBusy", "A class advancement operation is already running for this character."));
      }

      await actor.setFlag("age-system", ADVANCEMENT_LOCK_FLAG, {token, key, timestamp: Date.now()});
      // Let simultaneous clients' Actor updates settle, then only the final lock owner proceeds.
      await new Promise(resolve => setTimeout(resolve, ADVANCEMENT_LOCK_SETTLE_MS));
      const confirmed = actor.getFlag("age-system", ADVANCEMENT_LOCK_FLAG);
      if (confirmed?.token !== token) {
        throw new Error(localize("age-system.WARNING.classAdvancementBusy", "A class advancement operation is already running for this character."));
      }
      ownsSharedLock = true;
    }
    return await operation();
  } finally {
    try {
      if (ownsSharedLock && actor.getFlag("age-system", ADVANCEMENT_LOCK_FLAG)?.token === token) {
        if (typeof actor.unsetFlag === "function") await actor.unsetFlag("age-system", ADVANCEMENT_LOCK_FLAG);
        else await actor.setFlag("age-system", ADVANCEMENT_LOCK_FLAG, null);
      }
    } finally {
      advancementLocks.delete(key);
    }
  }
}

function itemArray(actor) {
  if (!actor?.items) return [];
  if (Array.isArray(actor.items)) return actor.items;
  if (Array.isArray(actor.items.contents)) return actor.items.contents;
  return Array.from(actor.items);
}

function getItem(actor, id) {
  if (!id) return null;
  if (typeof actor?.items?.get === "function") return actor.items.get(id) ?? null;
  return itemArray(actor).find(item => item.id === id || item._id === id) ?? null;
}

function classItems(actor) {
  return itemArray(actor).filter(item => item.type === "class");
}

function localize(key, fallback = key) {
  const value = game.i18n.localize(key);
  return value === key ? fallback : value;
}

function format(key, data, fallback) {
  const value = game.i18n.format(key, data);
  return value.startsWith(`${key}:`) || value === key ? fallback : value;
}

function normalizeValues(values) {
  const source = Array.isArray(values)
    ? values
    : values && typeof values === "object"
      ? Object.keys(values).sort((a, b) => Number(a) - Number(b)).map(key => values[key])
      : [];
  return Array.from({length: CLASS_MAX_LEVEL}, (_, index) => source[index] ?? 0);
}

function normalizeGrant(grant = {}, index = 0) {
  const trait = grant.trait === "spec" ? "spec" : (grant.trait ?? grant.type ?? "");
  return {
    id: grant.id ?? `grant-${index}`,
    uuid: grant.uuid || null,
    type: grant.type ?? (trait === "spec" ? "talent" : trait),
    trait,
    name: grant.name ?? "",
    img: grant.img ?? "",
    isItemProg: grant.isItemProg === true,
  };
}

export function normalizeProgressiveAdvancement(entry = {}, index = 0) {
  return {
    id: entry.id ?? `progressive-${index}`,
    trait: entry.trait ?? "health",
    alias: entry.alias ?? "",
    img: entry.img || ageSystem.advData.icon.progressive,
    values: normalizeValues(entry.values ?? entry.adv),
  };
}

export function normalizeItemAdvancement(entry = {}, index = 0) {
  const grants = (entry.grants ?? entry.itemArr ?? []).map(normalizeGrant);
  const requestedMode = entry.selectionMode ?? (entry.itemOption === "multiple" ? "choose" : "all");
  const selectionMode = requestedMode === "choose" ? "choose" : "all";
  const requested = Number(entry.quantity ?? entry.itemQtd ?? grants.length);
  const quantity = selectionMode === "choose"
    ? Math.max(1, Math.min(Number.isFinite(requested) ? requested : 1, Math.max(1, grants.length)))
    : grants.length;
  return {
    id: entry.id ?? `item-${index}`,
    level: Math.max(1, Math.min(CLASS_MAX_LEVEL, Number(entry.level) || 1)),
    alias: entry.alias ?? "",
    img: entry.img || ageSystem.advData.icon.item,
    selectionMode,
    quantity,
    allowProgression: entry.allowProgression !== false,
    grants,
  };
}

export function normalizeClassSystem(system = {}) {
  const progressive = (system.advancements?.progressive ?? []).map(normalizeProgressiveAdvancement);
  const items = (system.advancements?.item ?? []).map(normalizeItemAdvancement);
  return {
    ...clone(system),
    level: Math.max(0, Math.min(CLASS_MAX_LEVEL, Number(system.level) || 0)),
    primaryAbl: Array.isArray(system.primaryAbl) ? [...new Set(system.primaryAbl.filter(Boolean))] : [],
    wgroups: Array.isArray(system.wgroups) ? [...new Set(system.wgroups.filter(Boolean))] : [],
    advancementVersion: CLASS_ADVANCEMENT_VERSION,
    progression: {
      version: CLASS_ADVANCEMENT_VERSION,
      lastTransactionId: system.progression?.lastTransactionId ?? null,
      legacyLevel: Math.max(0, Number(system.progression?.legacyLevel) || 0),
    },
    advancements: {progressive, item: items},
  };
}

export function prepareClassAdvancements(system = {}) {
  const normalized = normalizeClassSystem(system);
  const levels = Array.from({length: CLASS_MAX_LEVEL}, () => []);
  normalized.advancements.progressive.forEach((entry, index) => {
    entry.values.forEach((value, levelIndex) => {
      if (["", null, undefined, 0, "0"].includes(value)) return;
      levels[levelIndex].push({
        type: "progressive",
        id: index,
        entryId: entry.id,
        level: levelIndex + 1,
        trait: entry.trait,
        value,
        img: entry.img,
        alias: entry.alias || entry.trait,
      });
    });
  });
  normalized.advancements.item.forEach((entry, index) => {
    levels[entry.level - 1].push({
      type: "item",
      id: index,
      entryId: entry.id,
      level: entry.level,
      img: entry.img,
      alias: entry.alias || localize("age-system.advNewItem", "New item"),
    });
  });
  return {normalized, levels};
}

export function validateClassDefinition(system = {}) {
  const normalized = normalizeClassSystem(system);
  const errors = [];
  const warnings = [];

  const progressiveIds = new Set();
  normalized.advancements.progressive.forEach((entry, index) => {
    if (progressiveIds.has(entry.id)) errors.push(`Progressive advancement ${index + 1} duplicates the id "${entry.id}".`);
    progressiveIds.add(entry.id);
    if (!PROGRESSIVE_TRAITS.has(entry.trait)) errors.push(`Progressive advancement ${index + 1} has unsupported trait "${entry.trait}".`);
    const nonEmpty = entry.values.some(value => !["", null, undefined, 0, "0"].includes(value));
    if (!nonEmpty) warnings.push(`Progressive advancement ${index + 1} has no non-zero levels.`);
    entry.values.forEach((value, levelIndex) => {
      if (["", null, undefined, 0, "0"].includes(value)) return;
      if (entry.trait === "advAbility") {
        const amount = Number(value);
        if (!Number.isInteger(amount) || amount < 0) errors.push(`Ability advancement at level ${levelIndex + 1} must be a non-negative integer.`);
      } else if (globalThis.Roll?.validate && !Roll.validate(String(value))) {
        errors.push(`${entry.alias || entry.trait} at level ${levelIndex + 1} has invalid formula "${value}".`);
      }
    });
  });

  const itemIds = new Set();
  normalized.advancements.item.forEach((entry, index) => {
    if (itemIds.has(entry.id)) errors.push(`Item advancement ${index + 1} duplicates the id "${entry.id}".`);
    itemIds.add(entry.id);
    if (!entry.grants.length) errors.push(`Item advancement ${index + 1} has no grants.`);
    if (entry.selectionMode === "choose" && (entry.quantity < 1 || entry.quantity > entry.grants.length)) {
      errors.push(`Item advancement ${index + 1} has an invalid selection quantity.`);
    }
    const grantIds = new Set();
    entry.grants.forEach((grant, grantIndex) => {
      if (grantIds.has(grant.id)) errors.push(`Grant ${grantIndex + 1} in item advancement ${index + 1} duplicates the id "${grant.id}".`);
      grantIds.add(grant.id);
      if (!GRANT_TRAITS.has(grant.trait)) errors.push(`Grant ${grantIndex + 1} in item advancement ${index + 1} has unsupported trait "${grant.trait}".`);
      if (grant.isItemProg && !PROGRESSABLE_TRAITS.has(grant.trait)) {
        errors.push(`Generic progression is not supported for ${grant.trait}. Drag a concrete item instead.`);
      }
      if (!grant.isItemProg && !grant.uuid) errors.push(`Grant ${grantIndex + 1} in item advancement ${index + 1} has no source UUID.`);
      if (grant.isItemProg && grant.uuid) warnings.push(`Grant ${grantIndex + 1} in item advancement ${index + 1} ignores its source UUID because it is generic progression.`);
    });
  });

  return {valid: errors.length === 0, errors, warnings, normalized};
}

function classProgression(actor) {
  const source = sourceSystem(actor).classProgression ?? actor.system?.classProgression ?? {};
  return {
    version: CLASS_ADVANCEMENT_VERSION,
    baseLevel: classAdvancementBaseLevel(source.baseLevel),
    transactions: Array.isArray(source.transactions) ? clone(source.transactions) : [],
  };
}

export function classAdvancementRollbackArray(transaction, currentAdvancement) {
  if (Array.isArray(transaction?.before?.advancement)) return clone(transaction.before.advancement);
  const advancement = Array.isArray(currentAdvancement) ? clone(currentAdvancement) : [];
  if (transaction?.before?.hadAdvancementEntry) {
    advancement[transaction.level] = cloneMaybe(transaction.before.advancementEntry);
  } else {
    delete advancement[transaction?.level];
    while (advancement.length && advancement.at(-1) === undefined) advancement.pop();
  }
  return advancement;
}

/**
 * Build the Class progression branch for a successful latest-level rollback.
 * New transactions record the exact pre-advancement base-level marker. Older
 * schema-v3 transactions may not contain that member, so they retain the
 * established current base level rather than introducing an undefined value.
 */
export function classAdvancementRollbackProgression(transaction, currentProgression) {
  const rollback = clone(currentProgression ?? {});
  rollback.transactions = Array.isArray(rollback.transactions)
    ? rollback.transactions.slice(0, -1)
    : [];
  if (Object.prototype.hasOwnProperty.call(transaction?.before ?? {}, "classProgressionBaseLevel")) {
    rollback.baseLevel = cloneMaybe(transaction.before.classProgressionBaseLevel);
  }
  return rollback;
}

function classBonuses(actor) {
  const source = sourceSystem(actor).classBonuses ?? actor.system?.classBonuses ?? {};
  return {
    health: Number(source.health) || 0,
    powerPoints: Number(source.powerPoints) || 0,
    conviction: Number(source.conviction) || 0,
    defense: Number(source.defense) || 0,
    toughness: Number(source.toughness) || 0,
  };
}

function actorRollData(actor) {
  if (typeof actor.actorRollData === "function") return actor.actorRollData();
  const abilities = actor.system.abilities ?? {};
  const data = {level: Number(actor.system.level) || 0};
  for (const [key, value] of Object.entries(abilities)) data[key] = Number(value.total ?? value.value) || 0;
  return data;
}

async function evaluateFormula(formula, actor, options = {}) {
  if (typeof options.rollEvaluator === "function") return Number(await options.rollEvaluator(String(formula), actor));
  const roll = await new Roll(String(formula), actorRollData(actor)).evaluate();
  if (options.postRolls && typeof roll.toMessage === "function") {
    await roll.toMessage({flavor: options.flavor ?? localize("age-system.advancement", "Advancement")});
  }
  return Number(roll.total);
}

function traitForItem(item) {
  if (item.type === "talent" && item.system?.type === "spec") return "spec";
  return item.type;
}

function progressionCandidates(actor, trait, source = null) {
  if (!PROGRESSABLE_TRAITS.has(trait)) return [];
  const candidates = itemArray(actor).filter(item => traitForItem(item) === trait);
  if (!source) return candidates;
  const sourceUuid = source.uuid;
  const exact = candidates.filter(item => {
    const flags = item.flags?.["age-system"] ?? {};
    return flags.classSourceUuid === sourceUuid || item.flags?.core?.sourceId === sourceUuid;
  });
  if (exact.length) return exact;
  return candidates.filter(item => item.name.trim().toLowerCase() === source.name.trim().toLowerCase());
}

function duplicateCandidates(actor, trait, source) {
  if (!source) return [];
  const sourceUuid = source.uuid;
  return itemArray(actor).filter(item => {
    if (traitForItem(item) !== trait) return false;
    const flags = item.flags?.["age-system"] ?? {};
    if (flags.classSourceUuid === sourceUuid || item.flags?.core?.sourceId === sourceUuid) return true;
    return item.name.trim().toLowerCase() === source.name.trim().toLowerCase();
  });
}

async function resolveUuid(uuid) {
  if (!uuid) return null;
  if (typeof foundry.utils.fromUuid === "function") return foundry.utils.fromUuid(uuid);
  if (typeof globalThis.fromUuid === "function") return globalThis.fromUuid(uuid);
  if (typeof foundry.utils.fromUuidSync === "function") return foundry.utils.fromUuidSync(uuid);
  return null;
}

function abilityCost(nextScore) {
  const costs = ageSystem.advData.abilityScoreCost;
  const index = Math.max(0, Math.min(costs.length - 1, Number(nextScore) - 1));
  return Number(costs[index]) || 1;
}

function abilityOptions(actor, classSystem, targetLevel) {
  const all = ageSystem.ABILITY_KEYS ?? Object.keys(actor.system.abilities ?? {});
  if (game.settings.get("age-system", "primaryAbl")) {
    const primary = classSystem.primaryAbl.filter(key => all.includes(key));
    const secondary = all.filter(key => !primary.includes(key));
    return targetLevel % 2 === 0 ? primary : secondary;
  }
  const progression = classProgression(actor);
  const previous = progression.transactions.at(-1)?.choices?.ability ?? {};
  const used = Object.entries(previous).filter(([, amount]) => Number(amount) > 0).map(([key]) => key);
  const remaining = all.filter(key => !used.includes(key));
  return remaining.length ? remaining : all;
}

function advancementAtLevel(classSystem, level) {
  const progressive = [];
  classSystem.advancements.progressive.forEach(entry => {
    const value = entry.values[level - 1];
    if (!["", null, undefined, 0, "0"].includes(value)) progressive.push({...entry, value});
  });
  const items = classSystem.advancements.item.filter(entry => entry.level === level);
  return {progressive, items};
}

export class ClassAdvancementService {
  static getClassItems(actor) { return classItems(actor); }

  static canAttachClass(actor, incomingId = null) {
    if (actor?.type !== "char") return {allowed: false, reason: localize("age-system.WARNING.classCharacterOnly", "Classes can only be attached to characters.")};
    const existing = classItems(actor).filter(item => item.id !== incomingId);
    if (existing.length) return {allowed: false, reason: localize("age-system.WARNING.actorHasClass", "Actor already has a Class item!")};
    return {allowed: true, reason: ""};
  }

  static normalizeForAttachment(itemData) {
    const data = clone(itemData);
    data.system = normalizeClassSystem(data.system ?? {});
    data.system.level = 0;
    data.system.progression = {version: CLASS_ADVANCEMENT_VERSION, lastTransactionId: null, legacyLevel: Number(data.system.progression?.legacyLevel) || 0};
    return data;
  }

  static async createDraft(actor, classItem, targetLevel = Number(classItem.system.level) + 1, options = {}) {
    if (!actor || actor.type !== "char") throw new Error(localize("age-system.WARNING.classCharacterOnly", "Classes can only advance characters."));
    if (classItem.actor?.id !== actor.id && classItem.parent?.id !== actor.id) throw new Error(localize("age-system.WARNING.ownedClassLevelOnly", "Only an owned Class can be leveled."));
    const attachedClasses = classItems(actor);
    if (attachedClasses.length !== 1 || attachedClasses[0].id !== classItem.id) {
      throw new Error(localize("age-system.WARNING.multipleClassesUnsupported", "This character must have exactly one attached Class before advancement can be applied."));
    }
    if (targetLevel !== Number(classItem.system.level) + 1) throw new Error("Class advancement must be applied one level at a time.");
    if (targetLevel < 1 || targetLevel > CLASS_MAX_LEVEL) throw new Error("Target class level is outside the supported range.");

    const validation = validateClassDefinition(classItem.system);
    if (!validation.valid) throw new Error(validation.errors.join("\n"));
    const classSystem = validation.normalized;
    const levelData = advancementAtLevel(classSystem, targetLevel);

    const abilityEntries = levelData.progressive.filter(entry => entry.trait === "advAbility");
    const abilityPoints = abilityEntries.reduce((total, entry) => total + Number(entry.value), 0);
    const validAbilityKeys = abilityOptions(actor, classSystem, targetLevel);
    if (abilityPoints > 0 && !validAbilityKeys.length) {
      throw new Error(localize("age-system.WARNING.noEligibleClassAbilities", "This class level grants ability advancements, but no eligible abilities are configured."));
    }
    const ability = {
      points: abilityPoints,
      remaining: abilityPoints,
      options: validAbilityKeys.map(key => ({
        key,
        name: localize(`age-system.${key}`, key),
        currentValue: Number(actor.system.abilities?.[key]?.value) || 0,
        currentAdvances: Number(actor.system.abilities?.[key]?.advances) || 0,
        allocation: 0,
      }))
    };

    const formulas = [];
    for (const entry of levelData.progressive.filter(entry => entry.trait !== "advAbility")) {
      const key = `${entry.trait}:${entry.id}:${targetLevel}`;
      const result = await evaluateFormula(entry.value, actor, {
        rollEvaluator: options.rollEvaluator,
        postRolls: false,
        flavor: entry.alias,
      });
      if (!Number.isFinite(result) || result < 0) throw new Error(`${entry.alias || entry.trait} produced an invalid advancement result.`);
      formulas.push({key, trait: entry.trait, alias: entry.alias || entry.trait, formula: String(entry.value), result});
    }

    const itemGroups = [];
    for (const entry of levelData.items) {
      const grants = [];
      for (let index = 0; index < entry.grants.length; index++) {
        const grant = entry.grants[index];
        const key = `${entry.id}:${grant.id}:${index}`;
        let source = null;
        let unresolved = false;
        if (!grant.isItemProg) {
          source = await resolveUuid(grant.uuid);
          unresolved = !source || source.documentName !== "Item";
        }
        const candidateDocuments = (grant.isItemProg || entry.allowProgression)
          ? progressionCandidates(actor, grant.trait, source)
          : [];
        const duplicates = !grant.isItemProg ? duplicateCandidates(actor, grant.trait, source) : [];
        const candidates = candidateDocuments.map(item => ({
          id: item.id,
          name: item.name,
          img: item.img,
          type: item.type,
          trait: traitForItem(item),
        }));
        grants.push({
          ...grant,
          key,
          sourceName: source?.name ?? grant.name,
          sourceImg: source?.img ?? grant.img,
          unresolved,
          candidates,
          duplicateIds: duplicates.map(item => item.id),
          duplicateNames: duplicates.map(item => item.name),
          selected: entry.selectionMode === "all",
          progressionTarget: candidates.length === 1 ? candidates[0].id : "",
        });
      }
      itemGroups.push({
        key: entry.id,
        alias: entry.alias,
        img: entry.img,
        selectionMode: entry.selectionMode,
        quantity: entry.quantity,
        allowProgression: entry.allowProgression,
        grants,
      });
    }

    return {
      actor,
      classItem,
      classSystem,
      targetLevel,
      ability,
      formulas,
      itemGroups,
      warnings: validation.warnings,
      choices: {
        ability: Object.fromEntries(ability.options.map(option => [option.key, 0])),
        formulaResults: Object.fromEntries(formulas.map(formula => [formula.key, formula.result])),
        itemSelections: Object.fromEntries(itemGroups.map(group => [group.key, group.grants.filter(grant => grant.selected).map(grant => grant.key)])),
        progressionTargets: Object.fromEntries(itemGroups.flatMap(group => group.grants.map(grant => [grant.key, grant.progressionTarget]))),
      },
    };
  }

  static validateChoices(draft, choices = draft.choices) {
    const errors = [];
    const abilityTotal = Object.entries(choices.ability ?? {}).reduce((sum, [key, value]) => {
      const amount = Number(value);
      if (!draft.ability.options.some(option => option.key === key) && amount) errors.push(`Ability ${key} is not eligible at this level.`);
      if (!Number.isInteger(amount) || amount < 0) errors.push(`Ability advancement for ${key} must be a non-negative integer.`);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);
    if (abilityTotal !== draft.ability.points) errors.push(`Allocate exactly ${draft.ability.points} ability advancement point(s).`);

    for (const formula of draft.formulas) {
      const result = Number(choices.formulaResults?.[formula.key]);
      if (!Number.isFinite(result) || result < 0) errors.push(`${formula.alias} requires a non-negative numeric result.`);
    }

    for (const group of draft.itemGroups) {
      const selected = group.selectionMode === "all"
        ? group.grants.map(grant => grant.key)
        : [...new Set(choices.itemSelections?.[group.key] ?? [])];
      if (group.selectionMode === "choose" && selected.length !== group.quantity) {
        errors.push(`${group.alias || "Item advancement"} requires exactly ${group.quantity} selection(s).`);
      }
      for (const key of selected) {
        const grant = group.grants.find(candidate => candidate.key === key);
        if (!grant) { errors.push(`Unknown item grant ${key}.`); continue; }
        if (grant.unresolved) errors.push(`The source item for ${grant.sourceName || grant.name || key} cannot be resolved.`);
        const target = choices.progressionTargets?.[grant.key] ?? "";
        if (grant.isItemProg) {
          if (!grant.candidates.some(candidate => candidate.id === target)) errors.push(`${grant.sourceName || grant.name || grant.trait} requires an owned item selection.`);
        } else if (target && !grant.candidates.some(candidate => candidate.id === target)) {
          errors.push(`${grant.sourceName || grant.name || grant.trait} has an invalid progression target.`);
        }
        if (!grant.isItemProg && !PROGRESSABLE_TRAITS.has(grant.trait) && grant.duplicateIds.length) {
          errors.push(`${grant.sourceName || grant.name || grant.trait} is already owned and cannot be progressed.`);
        }
      }
    }
    return {valid: errors.length === 0, errors};
  }

  static async applyLevel(actor, classItem, choices, options = {}) {
    return withLock(actor, classItem, () => this._applyLevelUnlocked(actor, classItem, choices, options));
  }

  static async _applyLevelUnlocked(actor, classItem, choices, options = {}) {
    const draft = options.draft ?? await this.createDraft(actor, classItem, Number(classItem.system.level) + 1, options);
    const choiceValidation = this.validateChoices(draft, choices);
    if (!choiceValidation.valid) throw new Error(choiceValidation.errors.join("\n"));

    const transactionId = randomId();
    const actorSource = sourceSystem(actor);
    const classSource = sourceSystem(classItem);
    const progression = classProgression(actor);
    const classProgressionBaseLevelBefore = progression.baseLevel;
    const previousTransactionId = [...progression.transactions].reverse().find(tx => tx.classItemId === classItem.id)?.id ?? null;
    if (progression.transactions.some(tx => tx.classItemId === classItem.id && tx.level === draft.targetLevel)) {
      throw new Error(`Class level ${draft.targetLevel} has already been applied.`);
    }
    if (!progression.transactions.length && Number(classSource.level) === 0) progression.baseLevel = Math.max(0, Number(actorSource.level) || 0);
    else if (progression.baseLevel === null) progression.baseLevel = Math.max(0, (Number(actorSource.level) || 0) - (Number(classSource.level) || 0));

    const advancementBefore = Array.isArray(actorSource.advancement) ? clone(actorSource.advancement) : [];
    const hadAdvancementEntry = Object.prototype.hasOwnProperty.call(advancementBefore, draft.targetLevel);
    const before = {
      actorLevel: Number(actorSource.level) || 0,
      advancement: clone(advancementBefore),
      advancementEntry: cloneMaybe(advancementBefore[draft.targetLevel]),
      hadAdvancementEntry,
      classBonuses: classBonuses(actor),
      wgroups: clone(actorSource.wgroups ?? []),
      abilities: clone(actorSource.abilities ?? {}),
      healthValue: Number(actorSource.health?.value) || 0,
      powerPointsValue: Number(actorSource.powerPoints?.value) || 0,
      convictionValue: Number(actorSource.conviction?.value) || 0,
      resourceMaximums: {
        health: Number(actor.system?.health?.max) || resourceMaximum(actorSource, "health", classBonuses(actor)),
        powerPoints: Number(actor.system?.powerPoints?.max) || resourceMaximum(actorSource, "powerPoints", classBonuses(actor)),
        conviction: Number(actor.system?.conviction?.max) || resourceMaximum(actorSource, "conviction", classBonuses(actor)),
      },
      classLevel: Number(classSource.level) || 0,
      classProgressionBaseLevel: classProgressionBaseLevelBefore,
    };

    const bonuses = clone(before.classBonuses);
    const abilities = clone(before.abilities);
    const wgroups = [...new Set(before.wgroups)];
    const summaries = [];
    const resourceDeltas = {health: 0, powerPoints: 0, conviction: 0};
    let healthValue = before.healthValue;
    let powerPointsValue = before.powerPointsValue;
    let convictionValue = before.convictionValue;

    if (draft.targetLevel === 1) {
      for (const group of draft.classSystem.wgroups) if (!wgroups.includes(group)) wgroups.push(group);
      for (const key of draft.classSystem.primaryAbl) if (abilities[key]) abilities[key].primary = true;
    }

    for (const option of draft.ability.options) {
      const amount = Number(choices.ability?.[option.key]) || 0;
      if (!amount) continue;
      const ability = abilities[option.key];
      if (!ability) throw new Error(`Actor ability ${option.key} does not exist.`);
      let residual = (Number(ability.advances) || 0) + amount;
      let score = Number(ability.value) || 0;
      while (residual >= abilityCost(score + 1)) {
        residual -= abilityCost(score + 1);
        score += 1;
      }
      ability.advances = residual;
      ability.value = score;
      summaries.push(format("age-system.CLASS.abilityGain", {ability: option.name, amount}, `${option.name}: +${amount} advancement`));
    }

    for (const formula of draft.formulas) {
      const result = Number(choices.formulaResults[formula.key]);
      if (!Number.isFinite(result) || result < 0) throw new Error(`${formula.alias} requires a non-negative numeric result.`);
      switch (formula.trait) {
        case "health":
          bonuses.health += result;
          resourceDeltas.health += result;
          healthValue += result;
          summaries.push(format("age-system.CLASS.resourceGain", {resource: localize("age-system.health", "Health"), amount: result}, `Health +${result}`));
          break;
        case "powerPoints":
          bonuses.powerPoints += result;
          resourceDeltas.powerPoints += result;
          powerPointsValue += result;
          summaries.push(format("age-system.CLASS.resourceGain", {resource: ageSystem.POWER_FLAVOR?.points ?? "Power Points", amount: result}, `Power Points +${result}`));
          break;
        case "conviction":
          bonuses.conviction += result;
          resourceDeltas.conviction += result;
          convictionValue += result;
          summaries.push(format("age-system.CLASS.resourceGain", {resource: localize("age-system.conviction", "Conviction"), amount: result}, `Conviction +${result}`));
          break;
        case "defenseAndToughness":
          bonuses.defense += result;
          bonuses.toughness += result;
          summaries.push(format("age-system.CLASS.defenseGain", {amount: result}, `Defense and Toughness +${result}`));
          break;
        default:
          throw new Error(`Unsupported progressive trait ${formula.trait}.`);
      }
    }

    const existingUpdates = new Map();
    const existingBefore = new Map();
    const createData = [];

    for (const group of draft.itemGroups) {
      const selectedKeys = group.selectionMode === "all"
        ? group.grants.map(grant => grant.key)
        : (choices.itemSelections[group.key] ?? []);
      for (const grantKey of selectedKeys) {
        const grant = group.grants.find(item => item.key === grantKey);
        if (!grant) throw new Error(`Unknown item grant ${grantKey}.`);
        let source = null;
        if (!grant.isItemProg) {
          source = await resolveUuid(grant.uuid);
          if (!source || source.documentName !== "Item") throw new Error(`Unable to resolve ${grant.uuid}.`);
        }
        const targetId = choices.progressionTargets?.[grant.key] || "";
        const target = targetId ? getItem(actor, targetId) : null;

        if (grant.isItemProg || target) {
          if (!target) throw new Error(`${grant.name || grant.trait} requires an owned item to progress.`);
          if (traitForItem(target) !== grant.trait) throw new Error(`${target.name} is not a valid ${grant.trait} progression target.`);
          if (!existingBefore.has(target.id)) existingBefore.set(target.id, sourceSystem(target));
          const current = existingUpdates.get(target.id) ?? sourceSystem(target);
          const progressed = this.progressItemSystem(target.type, current, grant.trait);
          existingUpdates.set(target.id, progressed.system);
          summaries.push(progressed.summary.replace("{name}", target.name));
          continue;
        }

        const matching = duplicateCandidates(actor, grant.trait, source);
        if (source.type === "focus" && matching.length) {
          throw new Error(`Actor already owns the Focus "${source.name}". Select it as the progression target instead.`);
        }
        if (!PROGRESSABLE_TRAITS.has(grant.trait) && matching.length) {
          throw new Error(`${source.name} is already owned and cannot be progressed.`);
        }
        const data = source.toObject();
        delete data._id;
        delete data.id;
        delete data.uuid;
        delete data.folder;
        delete data.sort;
        delete data.ownership;
        delete data._stats;
        delete data.pack;
        data.system = clone(data.system ?? {});
        if (data.type === "talent" && ["", null, undefined].includes(data.system.degree)) data.system.degree = 0;
        data.flags ??= {};
        data.flags["age-system"] = {
          ...(data.flags["age-system"] ?? {}),
          classGrant: true,
          classSourceUuid: source.uuid,
          classItemId: classItem.id,
          classLevel: draft.targetLevel,
          transactionId,
        };
        createData.push(data);
        summaries.push(format("age-system.CLASS.itemGain", {item: source.name}, `Gained ${source.name}`));
      }
    }

    const advancement = clone(advancementBefore);
    advancement[draft.targetLevel] = summaries;
    const after = {
      actorLevel: progression.baseLevel + draft.targetLevel,
      advancementEntry: clone(summaries),
      classBonuses: clone(bonuses),
      wgroups: clone(wgroups),
      abilities: clone(abilities),
      healthValue,
      powerPointsValue,
      convictionValue,
      classLevel: draft.targetLevel,
    };
    const transaction = {
      id: transactionId,
      version: CLASS_ADVANCEMENT_VERSION,
      classItemId: classItem.id,
      className: classItem.name,
      level: draft.targetLevel,
      timestamp: Date.now(),
      choices: clone(choices),
      before,
      after,
      resourceDeltas,
      createdItems: [],
      createdItemIds: [],
      updatedItems: [...existingBefore.entries()].map(([id, beforeSystem]) => ({
        id,
        beforeSystem,
        afterSystem: clone(existingUpdates.get(id)),
      })),
      summaries,
    };

    const actorUpdate = {
      "system.level": after.actorLevel,
      "system.advancement": advancement,
      "system.classBonuses": atomicSnapshot(bonuses),
      "system.wgroups": wgroups,
      "system.abilities": atomicSnapshot(abilities),
      "system.health.value": healthValue,
      "system.powerPoints.value": powerPointsValue,
      "system.conviction.value": convictionValue,
    };

    let created = [];
    try {
      if (createData.length) created = await actor.createEmbeddedDocuments("Item", createData, {classAdvancement: true});
      transaction.createdItemIds = created.map(item => item.id);
      transaction.createdItems = created.map(item => ({id: item.id, afterData: sourceItemData(item)}));
      if (existingUpdates.size) {
        await actor.updateEmbeddedDocuments("Item", [...existingUpdates.entries()].map(([id, system]) => completeItemSystemSnapshot(id, system)), {classAdvancement: true});
      }
      const persistedTransaction = classAdvancementJournalSnapshot(transaction, "classProgression.transaction");
      progression.transactions.push(persistedTransaction);
      actorUpdate["system.classProgression"] = atomicSnapshot(
        classAdvancementJournalSnapshot(progression)
      );
      await actor.update(actorUpdate, {classAdvancement: true});
      const persistedProgression = classProgression(actor);
      if (!persistedProgression.transactions.some(entry => entry?.id === transactionId)) {
        throw new Error("AGE class advancement transaction did not persist on the Actor.");
      }
      await classItem.update({
        "system.level": draft.targetLevel,
        "system.progression.version": CLASS_ADVANCEMENT_VERSION,
        "system.progression.lastTransactionId": transactionId,
      }, {classAdvancement: true});
      const persistedClass = sourceSystem(classItem);
      if (Number(persistedClass.level) !== draft.targetLevel
          || persistedClass.progression?.lastTransactionId !== transactionId) {
        throw new Error("AGE class advancement state did not persist on the Class Item.");
      }
    } catch (error) {
      try {
        if (created.length) await actor.deleteEmbeddedDocuments("Item", created.map(item => item.id), {classAdvancementRollback: true});
        if (existingBefore.size) {
          await actor.updateEmbeddedDocuments("Item", [...existingBefore.entries()].map(([id, system]) => completeItemSystemSnapshot(id, system)), {classAdvancementRollback: true});
        }
        const rollbackAdvancement = clone(advancementBefore);
        await actor.update({
          "system.level": before.actorLevel,
          "system.advancement": rollbackAdvancement,
          "system.classBonuses": atomicSnapshot(before.classBonuses),
          "system.wgroups": before.wgroups,
          "system.abilities": atomicSnapshot(before.abilities),
          "system.health.value": before.healthValue,
          "system.powerPoints.value": before.powerPointsValue,
          "system.conviction.value": before.convictionValue,
          "system.classProgression": atomicSnapshot({...classProgression(actor), baseLevel: before.classProgressionBaseLevel, transactions: progression.transactions.filter(tx => tx.id !== transactionId)}),
        }, {classAdvancementRollback: true});
        await classItem.update({
          "system.level": before.classLevel,
          "system.progression.lastTransactionId": previousTransactionId,
        }, {classAdvancementRollback: true});
      } catch (rollbackError) {
        console.error("AGE System | Class advancement rollback failed", rollbackError);
      }
      throw error;
    }

    return classAdvancementJournalSnapshot(transaction, "classProgression.transaction");
  }

  static progressItemSystem(itemType, sourceSystem, trait = itemType) {
    const system = clone(sourceSystem);
    switch (trait) {
      case "focus":
        if (system.improved) throw new Error("This Focus is already improved.");
        system.improved = true;
        return {system, summary: format("age-system.CLASS.itemImproved", {item: "{name}"}, "Improved {name}")};
      case "talent":
      case "spec": {
        const maxDegree = Math.max(0, (ageSystem.talentDegrees?.inUse?.length ?? 5) - 1);
        const current = ["", null, undefined].includes(system.degree) ? -1 : Number(system.degree);
        if (!Number.isFinite(current) || current >= maxDegree) throw new Error("This Talent is already at its maximum degree.");
        system.degree = current + 1;
        return {system, summary: format("age-system.CLASS.itemImproved", {item: "{name}"}, "Improved {name}")};
      }
      case "relationship":
        system.intensity = (Number(system.intensity) || 0) + 1;
        system.intensityMax = Math.max(Number(system.intensityMax) || 0, system.intensity);
        return {system, summary: format("age-system.CLASS.itemImproved", {item: "{name}"}, "Improved {name}")};
      default:
        throw new Error(`Generic progression is not supported for ${itemType}.`);
    }
  }

  static async rollbackLevel(actor, classItem) {
    return withLock(actor, classItem, () => this._rollbackLevelUnlocked(actor, classItem));
  }

  static async _rollbackLevelUnlocked(actor, classItem) {
    const progression = classProgression(actor);
    const transaction = progression.transactions.at(-1);
    if (!transaction) throw new Error(localize("age-system.WARNING.noClassLevelToRollback", "There is no applied class level to roll back."));
    if (transaction.classItemId !== classItem.id || transaction.level !== Number(classItem.system.level)) {
      throw new Error(localize("age-system.WARNING.classRollbackOrder", "Only the most recently applied class level can be rolled back."));
    }
    if (!transaction.after || Number(transaction.version) < 3) {
      throw new Error(localize("age-system.WARNING.classLegacyTransaction", "This class level was created by an older non-transactional build and cannot be rolled back automatically."));
    }

    const actorSource = sourceSystem(actor);
    const classSource = sourceSystem(classItem);
    const currentAdvancement = Array.isArray(actorSource.advancement) ? clone(actorSource.advancement) : [];
    const conflicts = [];
    if (Number(actorSource.level) !== Number(transaction.after.actorLevel)) conflicts.push("character level");
    if (Number(classSource.level) !== Number(transaction.after.classLevel)) conflicts.push("class level");
    if (!equals(actorSource.classBonuses ?? {}, transaction.after.classBonuses ?? {})) conflicts.push("class bonuses");
    if (!equals(actorSource.wgroups ?? [], transaction.after.wgroups ?? [])) conflicts.push("weapon groups");
    if (!equals(actorSource.abilities ?? {}, transaction.after.abilities ?? {})) conflicts.push("abilities");
    if (!equals(currentAdvancement[transaction.level], transaction.after.advancementEntry)) conflicts.push("advancement summary");

    const createdIds = [];
    for (const entry of transaction.createdItems ?? []) {
      const item = getItem(actor, entry.id);
      if (!item) {
        conflicts.push(`granted item ${entry.id} is missing`);
        continue;
      }
      const grant = item.flags?.["age-system"];
      if (grant?.transactionId !== transaction.id) conflicts.push(`granted item ${item.name} has different ownership metadata`);
      else if (!equals(sourceItemData(item), entry.afterData)) conflicts.push(`granted item ${item.name} was edited`);
      createdIds.push(entry.id);
    }
    if (!(transaction.createdItems?.length) && transaction.createdItemIds?.length) {
      for (const itemId of transaction.createdItemIds) {
        const item = getItem(actor, itemId);
        if (!item) conflicts.push(`granted item ${itemId} is missing`);
        else if (item.flags?.["age-system"]?.transactionId !== transaction.id) conflicts.push(`granted item ${item.name} has different ownership metadata`);
        createdIds.push(itemId);
      }
    }

    const restoreUpdates = [];
    const forwardUpdates = [];
    for (const entry of transaction.updatedItems ?? []) {
      const item = getItem(actor, entry.id);
      if (!item) {
        conflicts.push(`progressed item ${entry.id} is missing`);
        continue;
      }
      const afterSystem = entry.afterSystem ?? entry.data?.system;
      const beforeSystem = entry.beforeSystem ?? entry.data?.system;
      if (!equals(sourceSystem(item), afterSystem)) conflicts.push(`progressed item ${item.name} was edited`);
      restoreUpdates.push(completeItemSystemSnapshot(entry.id, beforeSystem));
      forwardUpdates.push(completeItemSystemSnapshot(entry.id, afterSystem));
    }

    if (conflicts.length) {
      throw new Error(format(
        "age-system.WARNING.classRollbackConflict",
        {changes: conflicts.join(", ")},
        `Rollback stopped because class-managed data changed: ${conflicts.join(", ")}.`
      ));
    }

    const advancement = classAdvancementRollbackArray(transaction, currentAdvancement);

    const currentResources = {
      health: Number(actorSource.health?.value) || 0,
      powerPoints: Number(actorSource.powerPoints?.value) || 0,
      conviction: Number(actorSource.conviction?.value) || 0,
    };
    const beforeBonuses = clone(transaction.before.classBonuses);
    const healthMax = rollbackResourceMaximum(actor, transaction, "health");
    const powerPointsMax = rollbackResourceMaximum(actor, transaction, "powerPoints");
    const convictionMax = rollbackResourceMaximum(actor, transaction, "conviction");
    const rolledBackResources = {
      health: clamp(currentResources.health - Number(transaction.resourceDeltas?.health ?? 0), actorSource.health?.min, healthMax),
      powerPoints: clamp(currentResources.powerPoints - Number(transaction.resourceDeltas?.powerPoints ?? 0), actorSource.powerPoints?.min, powerPointsMax),
      conviction: clamp(currentResources.conviction - Number(transaction.resourceDeltas?.conviction ?? 0), actorSource.conviction?.min, convictionMax),
    };

    const originalProgression = clone(progression);
    const rollbackProgression = classAdvancementRollbackProgression(transaction, progression);
    const previousTransaction = [...rollbackProgression.transactions].reverse().find(tx => tx.classItemId === classItem.id);
    const rollbackActorUpdate = {
      "system.level": transaction.before.actorLevel,
      "system.advancement": advancement,
      "system.classBonuses": atomicSnapshot(beforeBonuses),
      "system.wgroups": transaction.before.wgroups,
      "system.abilities": atomicSnapshot(transaction.before.abilities),
      "system.health.value": rolledBackResources.health,
      "system.powerPoints.value": rolledBackResources.powerPoints,
      "system.conviction.value": rolledBackResources.conviction,
      "system.classProgression": atomicSnapshot(rollbackProgression),
    };
    const forwardActorUpdate = {
      "system.level": transaction.after.actorLevel,
      "system.advancement": currentAdvancement,
      "system.classBonuses": atomicSnapshot(transaction.after.classBonuses),
      "system.wgroups": transaction.after.wgroups,
      "system.abilities": atomicSnapshot(transaction.after.abilities),
      "system.health.value": currentResources.health,
      "system.powerPoints.value": currentResources.powerPoints,
      "system.conviction.value": currentResources.conviction,
      "system.classProgression": atomicSnapshot(originalProgression),
    };

    let itemsRestored = false;
    let actorRestored = false;
    let classRestored = false;
    try {
      if (restoreUpdates.length) {
        await actor.updateEmbeddedDocuments("Item", restoreUpdates, {classAdvancementRollback: true});
        itemsRestored = true;
      }
      await actor.update(rollbackActorUpdate, {classAdvancementRollback: true});
      actorRestored = true;
      await classItem.update({
        "system.level": transaction.before.classLevel,
        "system.progression.version": CLASS_ADVANCEMENT_VERSION,
        "system.progression.lastTransactionId": previousTransaction?.id ?? null,
      }, {classAdvancementRollback: true});
      classRestored = true;
      if (createdIds.length) await actor.deleteEmbeddedDocuments("Item", createdIds, {classAdvancementRollback: true});
    } catch (error) {
      try {
        if (itemsRestored && forwardUpdates.length) await actor.updateEmbeddedDocuments("Item", forwardUpdates, {classAdvancementRecovery: true});
        if (actorRestored) await actor.update(forwardActorUpdate, {classAdvancementRecovery: true});
        if (classRestored) {
          await classItem.update({
            "system.level": transaction.after.classLevel,
            "system.progression.version": CLASS_ADVANCEMENT_VERSION,
            "system.progression.lastTransactionId": transaction.id,
          }, {classAdvancementRecovery: true});
        }
      } catch (recoveryError) {
        console.error("AGE System | Class rollback recovery failed", recoveryError);
      }
      throw error;
    }
    return transaction;
  }
}
