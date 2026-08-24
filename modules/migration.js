import { normalizeActiveEffectData } from "./compat.js";
import { ageSystem } from "./config.js";
import { CLASS_ADVANCEMENT_VERSION, normalizeClassSystem } from "./class-advancement.js";
import { normalizeAtomicSystemUpdate } from "./data/atomic-system-updates.js";

const EFFECT_KEY_MIGRATIONS = Object.freeze({
  "system.defend.total": {key: "system.defend.defenseBonus", phase: "initial"},
  "system.guardUp.total": {key: "system.guardUp.defenseBonus", phase: "initial"},
  "system.allOutAttack.total": {key: "system.allOutAttack.dmgBonus", phase: "final"},
  "system.aim.total": {key: "system.aim.mod", phase: "final"},
});

function repairEffectChanges(changes = []) {
  return changes.map(change => {
    const repaired = foundry.utils.deepClone(change);
    const replacement = EFFECT_KEY_MIGRATIONS[repaired.key];
    if (replacement) Object.assign(repaired, replacement);
    return repaired;
  });
}

/**
 * Perform a system migration for the entire World, applying migrations for Actors, Items, and Compendium packs
 * @return {Promise}      A Promise which resolves once the migration is completed
 */
export const migrateWorld = async function() {
  ui.notifications.info(`Applying AGE System Migration for version ${game.system.version}. Please be patient and do not close your game or shut down your server.`, {permanent: true});
  const failures = [];
  const recordFailure = (scope, document, error) => {
    const label = document?.name ?? document?.collection ?? document?.id ?? "unknown";
    const wrapped = new Error(`Failed AGE System migration for ${scope} ${label}: ${error.message}`, {cause: error});
    console.error(wrapped);
    failures.push(wrapped);
  };

  // Migrate World Actors
  for ( let a of game.actors ) {
    try {
      const updateData = migrateActorData(a.toObject(), a._source);
      if ( !foundry.utils.isEmpty(updateData) ) {
        console.log(`Migrating Actor document ${a.name}`);
        await a.update(updateData, {enforceTypes: false, ageSystemMigration: true});
      }
    } catch(err) {
      recordFailure("Actor", a, err);
    }
  }

  // Migrate World Items
  for ( let i of game.items ) {
    try {
      const updateData = migrateItemData(i.toObject(), {owned: false});
      if ( !foundry.utils.isEmpty(updateData) ) {
        console.log(`Migrating Item document ${i.name}`);
        await i.update(updateData, {enforceTypes: false});
      }
    } catch(err) {
      recordFailure("Item", i, err);
    }
  }

  // Migrate Actor Override Tokens
  for ( let s of game.scenes ) {
    try {
      const updateData = await migrateSceneData(s);
      if ( !foundry.utils.isEmpty(updateData) ) {
        console.log(`Migrating Scene document ${s.name}`);
        await s.update(updateData, {enforceTypes: false});
        // If we do not do this, then synthetic token actors remain in cache
        // with the un-updated actorData.
        s.tokens.forEach(t => t._actor = null);
      }
    } catch(err) {
      recordFailure("Scene", s, err);
    }
  }

  // Migrate World Compendium Packs
  for ( let p of game.packs ) {
    if ( p.metadata.package !== "world" ) continue;
    if ( !["Actor", "Item", "Scene", "ActiveEffect"].includes(p.documentName) ) continue;
    try {
      await migrateCompendium(p);
    } catch (err) {
      recordFailure("Compendium", p, err);
    }
  }

  // Migrate Game Settings
  let settingsUpdates = [];
  try {
    settingsUpdates = await migrateSettings();
  } catch (err) {
    recordFailure("Settings", {name: "age-system"}, err);
  }

  // Migrate Chat Messagens
  for (let m of game.messages) {
    try {
      const updateData = await migrateMessage(m);
      if (foundry.utils.isEmpty(updateData)) continue;
      console.log(`Migrating ChatMessage document ${m.id}`);
      await m.update(updateData, {enforceTypes: false});
    } catch (err) {
      recordFailure("ChatMessage", m, err);
    }
  }

  // Apply deferred setting updates before marking the migration as complete.
  if (settingsUpdates.length > 0) {
    for (let s = 0; s < settingsUpdates.length; s++) {
      const setting = settingsUpdates[s];
      try {
        await game.settings.set("age-system", setting.key, setting.value);
      } catch (err) {
        recordFailure("Setting", {name: setting.key}, err);
      }
    }
  }

  if (failures.length > 0) {
    const message = `AGE System migration stopped with ${failures.length} failure(s). The world was not marked as migrated; correct the reported documents and retry.`;
    ui.notifications.error(message, {permanent: true});
    throw new AggregateError(failures, message);
  }

  await game.settings.set("age-system", "systemMigrationVersion", game.system.version);
  ui.notifications.info(`AGE System Migration to version ${game.system.version} completed!`, {permanent: true});
  return {version: game.system.version, failures: []};
};

/* -------------------------------------------- */

/**
 * Migrate Game Settings
 */
export async function migrateSettings() {
  const lastMigrationVer = (await game.settings.get("age-system", "systemMigrationVersion")) || "0.0.0";
  const healthSys = await game.settings.get("age-system", "healthSys");
  let updateSettings = [];
  let migData = (await game.settings.get("age-system", "settingsMigrationData")) ?? [];
  
  if (foundry.utils.isNewerVersion("0.8.0", lastMigrationVer)) { // Do not execute if last migration version was 0.8.0 or earlier
    const newHealthSys = await removeToughHealthBallistic();
    const newData = {key: "healthSys", value: newHealthSys, version: "0.8.0"}
    const alreadyRecorded = migData.some(entry => entry?.key === newData.key && entry?.version === newData.version);
    if (!alreadyRecorded) migData.push(newData)
    if (newHealthSys !== healthSys) updateSettings.push(newData)
  };

  if (foundry.utils.isNewerVersion("1.0.0", lastMigrationVer)) { // Do not execute if last migration version was 1.0.0 or earlier
    // Migrate Custom Token Status
    const te = game.settings.get("age-system", "customTokenEffects") ?? [];
    for (let e = 0; e < te.length; e++) {
      const changes = te[e].changes;
      if (changes) {
        for (let c = 0; c < changes.length; c++) {
          const k = changes[c];
          if (k.key.includes('data.')) te[e].changes[c].key = k.key.replace("data.", "system.")
        }
      }
    }
    await game.settings.set("age-system", "customTokenEffects", te);
  }

  if (foundry.utils.isNewerVersion("2.0.2", lastMigrationVer)) { // Do not execute if last migration version was 2.0.2 or earlier
    // Migrate field "label" from Custom Token Status to "name", to comply to FoundryVTT v11 new API.
    let te = game.settings.get("age-system", "customTokenEffects") ?? [];
    for (let i = 0; i < te.length; i++) {
      if (!te[i].name) {
        te[i].name = te[i].label;
        delete te[i].label;
      }
    }
    await game.settings.set("age-system", "customTokenEffects", te);
  }
  

  if (foundry.utils.isNewerVersion("4.1.0", lastMigrationVer)) {
    let effects = game.settings.get("age-system", "customTokenEffects") ?? [];
    const finalKeys = [...ageSystem.actorDerivedDataKey, ...ageSystem.charAblKey];
    effects = effects.map(effect => normalizeActiveEffectData(effect, finalKeys));
    await game.settings.set("age-system", "customTokenEffects", effects);
  }

  if (foundry.utils.isNewerVersion("4.2.6", lastMigrationVer)) {
    let effects = game.settings.get("age-system", "customTokenEffects") ?? [];
    const finalKeys = [...ageSystem.actorDerivedDataKey, ...ageSystem.charAblKey];
    effects = effects.map(effect => normalizeActiveEffectData({
      ...effect,
      changes: repairEffectChanges(effect.changes),
    }, finalKeys));
    await game.settings.set("age-system", "customTokenEffects", effects);

    const breather = game.settings.get("age-system", "breatherParam") ?? {};
    if (breather.abl && breather.abl !== "no-abl" && !Object.hasOwn(ageSystem.abilities, breather.abl)) {
      await game.settings.set("age-system", "breatherParam", {...breather, abl: "no-abl"});
    }
  }

  await game.settings.set("age-system", "settingsMigrationData", migData);
  return updateSettings;
};

export async function removeToughHealthBallistic() {
  let healthSys = "basic";
  return healthSys;
}

/**
 * Apply migration rules to all Documents within a single Compendium pack
 * @param pack
 * @return {Promise}
 */
export const migrateCompendium = async function(pack) {
  const documentName = pack.documentName;
  if ( !["Actor", "Item", "Scene", "ActiveEffect"].includes(documentName) ) return;

  // Unlock the pack for editing
  const wasLocked = pack.locked;
  const failures = [];
  let wasUnlocked = false;
  try {
    await pack.configure({locked: false});
    wasUnlocked = true;

    // Begin by requesting server-side data model migration and get the migrated content
    await pack.migrate();
    const documents = await pack.getDocuments();

    // Iterate over compendium entries - applying fine-tuned migration functions
    for ( let doc of documents ) {
      let updateData = {};
      try {
        switch (documentName) {
          case "Actor":
            updateData = migrateActorData(doc.toObject(), doc._source);
            break;
          case "Item":
            updateData = migrateItemData(doc.toObject(), {owned: false});
            break;
          case "Scene":
            updateData = await migrateSceneData(doc.toObject());
            break;
          case "ActiveEffect":
            updateData = migrateEffectData(doc.toObject());
            break;
        }

        // Save the entry, if data was changed
        if ( foundry.utils.isEmpty(updateData) ) continue;
        await doc.update(updateData, {ageSystemMigration: true});
        console.log(`Migrated ${documentName} document ${doc.name} in Compendium ${pack.collection}`);
      } catch(err) {
        const wrapped = new Error(`Failed AGE System migration for document ${doc.name} in pack ${pack.collection}: ${err.message}`, {cause: err});
        console.error(wrapped);
        failures.push(wrapped);
      }
    }
  } finally {
    // Never leave a formerly locked compendium writable after a migration error.
    if (wasUnlocked) await pack.configure({locked: wasLocked});
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to migrate ${failures.length} document(s) in ${pack.collection}.`);
  }
  console.log(`Migrated all ${documentName} documents from Compendium ${pack.collection}`);
  return true;
};

/* -------------------------------------------- */
/*  Document Type Migration Helpers             */
/* -------------------------------------------- */


/**
 * Migrate data of Chat Message document to incorporate latest system changes
 * Return an Object of updateData to be applied
 * @param {ChatMessage} message   The message to Update
 * @return {Object}               The udpateData to apply
 */
export const migrateMessage = function(message) {
  const lastMigrationVer = game.settings.get("age-system", "systemMigrationVersion") || "0.0.0";
  const updateData = {};

  if (foundry.utils.isNewerVersion("1.0.0", lastMigrationVer)) _adjustRollsArray(message, updateData); // Do not execute if last migration was 1.0.0 or earlier
  return updateData;
}

/**
 * Migrate a single Actor document to incorporate latest data model changes
 * Return an Object of updateData to be applied
 * @param {Actor} actor   The actor to Update
 * @return {Object}       The updateData to apply
 */
export const migrateActorData = function(actor, source={}) {
  const lastMigrationVer = game.settings.get("age-system", "systemMigrationVersion") || "0.0.0";
  const updateData = {};

  // Actor Data Updates
  if(foundry.utils.isNewerVersion("0.12.0", lastMigrationVer)) _updateModeHealth(actor, source, updateData);
  if(foundry.utils.isNewerVersion("4.2.0", lastMigrationVer)) _classActorProgression(actor, updateData);
  if(foundry.utils.isNewerVersion("4.2.6", lastMigrationVer)) _repairActorDefaults(actor, updateData);
  if(foundry.utils.isNewerVersion("4.2.7", lastMigrationVer)) _migrateSingleCurrency(actor, updateData);
  
  // Migrate Owned Effects
  const effects = migrateEffects(actor)
  if (effects.length > 0) updateData.effects = effects;

  // Migrate Owned Items
  const items = migrateItems(actor, source);
  if ( items.length > 0 ) updateData.items = items;
  return updateData;
};
/* -------------------------------------------- */

function _repairActorDefaults(actor, updateData) {
  if (actor.type === "vehicle" && actor.system?.velocity?.category === "standard") {
    updateData["system.velocity.category"] = "velStandard";
  }
  return updateData;
}

/**
 * Older character sheets displayed single-currency wealth from resources.base,
 * even though template.json has always provided system.currency. Preserve the
 * visible value while moving future edits to the canonical currency field.
 */
function _migrateSingleCurrency(actor, updateData) {
  if (actor.type !== "char" || game.settings.get("age-system", "wealthType") !== "currency") return updateData;
  const current = Number(actor.system?.currency);
  const legacy = Number(actor.system?.resources?.base);
  if ((!Number.isFinite(current) || current === 0) && Number.isFinite(legacy) && legacy !== 0) {
    updateData["system.currency"] = legacy;
  }
  return updateData;
}

/* -------------------------------------------- */

/**
 * Migrate Effects
 * @param {object} parent         Data of parent being migrated
 * @returns {object[]}            Updates to apply on the embedded effects
 */
const migrateEffects = function(parent) {
  if (!parent.effects) return []
  return parent.effects.reduce((arr, e) => {
    const effectData = e instanceof CONFIG.ActiveEffect.documentClass ? e.toObject() : e;
    let effectUpdate = migrateEffectData(effectData);
    if ( !foundry.utils.isEmpty(effectUpdate) ) {
      effectUpdate._id = effectData._id;
      arr.push(foundry.utils.expandObject(effectUpdate));
    }
    return arr;
  }, []);
}

/**
 * Migrate Item
 * @param {object} parent         Data of parent being migrated
 * @returns {object[]}            Updates to apply on the embedded Items
 */
 const migrateItems = function(parent, sourceParent = {}) {
  if (!parent.items) return []
  const sourceItems = Array.isArray(sourceParent?.items) ? sourceParent.items : [];
  return parent.items.reduce((arr, i) => {
    const itemData = i instanceof CONFIG.Item.documentClass ? i.toObject() : i;
    const baseSource = sourceItems.find(sourceItem => sourceItem?._id === itemData?._id);
    // Synthetic-token Item records are plain delta data. Materialize their
    // overrides over the base Actor Item before rebuilding an atomic branch;
    // otherwise a full replacement could erase the token-specific value.
    const itemSource = i?._source ?? (baseSource
      ? foundry.utils.mergeObject(
          foundry.utils.deepClone(baseSource),
          foundry.utils.deepClone(itemData),
          {inplace: true, recursive: true, insertKeys: true, overwrite: true}
        )
      : itemData);
    let itemUpdate = migrateItemData(itemData, {owned: true});
    if ( !foundry.utils.isEmpty(itemUpdate) ) {
      // Embedded Item migrations committed through a parent Actor bypass the
      // Item document lifecycle. Normalize their AnyField branches here so a
      // damage-formula migration cannot erase resisted-damage siblings.
      itemUpdate = normalizeAtomicSystemUpdate(itemUpdate, itemSource);
      itemUpdate._id = itemData._id;
      arr.push(foundry.utils.expandObject(itemUpdate));
    }
    return arr;
  }, []);
}

/**
 * Migrate a single Item document to incorporate latest data model changes
 * @param item
 */
export const migrateItemData = function(item, {owned = false} = {}) {
  const lastMigrationVer = game.settings.get("age-system", "systemMigrationVersion") || "0.0.0";
  const updateData = {};
  if (foundry.utils.isNewerVersion("0.7.0", lastMigrationVer)) _adjustFocusInitialValue(item, updateData); // Do not execute if last migration was 0.7.0 or earlier
  if (foundry.utils.isNewerVersion("0.11.0", lastMigrationVer)) {
    if (item.type === "weapon" ) _weaponRanged(item, updateData);
    if (["weapon", "power"].includes(item.type)) _itemDamage(item, updateData);
    _populateItemModifiers(item, updateData);
  }
  if (foundry.utils.isNewerVersion("0.11.2", lastMigrationVer)) _talentDegree(item, updateData);
  if (foundry.utils.isNewerVersion("4.2.0", lastMigrationVer)) _classItemAdvancement(item, updateData, {owned});
  const effects = migrateEffects(item);
  if (effects.length > 0) updateData.effects = effects;
  return updateData;
};

/**
 * Establish the v4.2 transactional class progression baseline without
 * attempting to reverse-engineer benefits from the unfinished legacy engine.
 * Existing Actor statistics remain untouched.
 */
function _classActorProgression(actor, updateData) {
  if (actor.type !== "char") return updateData;
  const system = actor.system ?? {};
  const existingBonuses = system.classBonuses ?? {};
  updateData["system.classBonuses"] = {
    health: Number(existingBonuses.health) || 0,
    powerPoints: Number(existingBonuses.powerPoints) || 0,
    conviction: Number(existingBonuses.conviction) || 0,
    defense: Number(existingBonuses.defense) || 0,
    toughness: Number(existingBonuses.toughness) || 0,
  };
  const ownedClass = (actor.items ?? []).find(item => item.type === "class");
  const classLevel = Math.max(0, Number(ownedClass?.system?.level) || 0);
  updateData["system.classProgression"] = {
    version: CLASS_ADVANCEMENT_VERSION,
    baseLevel: Math.max(0, (Number(system.level) || 0) - classLevel),
    transactions: [],
  };
  return updateData;
}

/** Normalize Class definitions and mark any pre-v4.2 owned levels as a
 * non-rollback legacy baseline. World/compendium Class definitions always
 * start at level zero when attached to a character.
 */
function _classItemAdvancement(item, updateData, {owned = false} = {}) {
  if (item.type !== "class") return updateData;
  const normalized = normalizeClassSystem(item.system ?? {});
  const oldLevel = Math.max(0, Number(item.system?.level) || 0);
  normalized.level = owned ? oldLevel : 0;
  normalized.progression = {
    version: CLASS_ADVANCEMENT_VERSION,
    lastTransactionId: null,
    legacyLevel: owned ? Math.max(oldLevel, Number(item.system?.progression?.legacyLevel) || 0) : 0,
  };
  updateData["system.level"] = normalized.level;
  updateData["system.primaryAbl"] = normalized.primaryAbl;
  updateData["system.wgroups"] = normalized.wgroups;
  updateData["system.advancements"] = normalized.advancements;
  updateData["system.advancementVersion"] = CLASS_ADVANCEMENT_VERSION;
  updateData["system.progression"] = normalized.progression;
  return updateData;
}

/* -------------------------------------------- */

/**
 * Migrate a single Effect Document to incorporate latest data model changes
 * @param effect
 */
export const migrateEffectData = function(effect) {
  const lastMigrationVer = game.settings.get("age-system", "systemMigrationVersion") || "0.0.0";
  const updateData = {};
  if (foundry.utils.isNewerVersion("0.8.8", lastMigrationVer)) _addEffectFlags(effect, updateData);
  if (foundry.utils.isNewerVersion("4.1.0", lastMigrationVer)) {
    const finalKeys = [...ageSystem.actorDerivedDataKey, ...ageSystem.charAblKey];
    const normalized = normalizeActiveEffectData(effect, finalKeys);
    if (effect.icon && !effect.img) updateData.img = normalized.img;
    if (JSON.stringify(effect.changes ?? []) !== JSON.stringify(normalized.changes)) updateData.changes = normalized.changes;
  }
  if (foundry.utils.isNewerVersion("4.2.6", lastMigrationVer)) {
    const finalKeys = [...ageSystem.actorDerivedDataKey, ...ageSystem.charAblKey];
    const normalized = normalizeActiveEffectData({
      ...effect,
      changes: repairEffectChanges(effect.changes),
    }, finalKeys);
    if (JSON.stringify(effect.changes ?? []) !== JSON.stringify(normalized.changes)) updateData.changes = normalized.changes;
  }
  return updateData;
};
/* -------------------------------------------- */

/**
 * Migrate a single Scene document to incorporate changes to the data model of it's actor data overrides
 * Return an Object of updateData to be applied
 * @param {Object} scene  The Scene data to Update
 * @return {Object}       The updateData to apply
 */
export const migrateSceneData = async function(scene) {
  const tokens = scene.tokens.map(token => {
    const t = token.toObject ? token.toObject() : foundry.utils.deepClone(token);
    const update = {};
    if ( Object.keys(update).length ) foundry.utils.mergeObject(t, update);
    if ( !t.actorId || t.actorLink ) {
      t.delta = {};
    }
    else if ( !game.actors.has(t.actorId) ) {
      t.actorId = null;
      t.delta = {};
    }
    else if ( !t.actorLink ) {
      const actorData = foundry.utils.deepClone(t.delta);
      actorData.type = token.actor?.type;
      const tokenSource = game.actors.get(t.actorId)._source;
      const update = migrateActorData(actorData, tokenSource);
      ["items", "effects"].forEach(embeddedName => {
        if (!update[embeddedName]?.length) return;
        const updates = new Map(update[embeddedName].map(u => [u._id, u]));
        const embeddedDocuments = Array.isArray(t.delta?.[embeddedName]) ? t.delta[embeddedName] : [];
        embeddedDocuments.forEach(original => {
          const update = updates.get(original._id);
          if (original.data) { // Addresses issue on migrating Item/Effects owned by synthetic tokens
            switch (embeddedName) {
              case 'items':
                original.system = original.data;
                break;
            
              case 'effects':
                foundry.utils.mergeObject(original, original.data);
                break;
            }
            delete original.data;
          }
          if (update) foundry.utils.mergeObject(original, update, {applyOperators: true});
        });
        delete update[embeddedName];
      });

      foundry.utils.mergeObject(t.delta, update, {applyOperators: true});
    }
    return t;    
  });
  return {tokens};
};

/* -------------------------------------------- */
/*  Low level migration utilities
/* -------------------------------------------- */

/**
 * Remove invalid terms from Rolls array
 * @private
 */
 function _adjustRollsArray(message, updateData) {
  const rolls = foundry.utils.deepClone(message._source.rolls ?? []).filter(Boolean);
  if (JSON.stringify(rolls) !== JSON.stringify(message._source.rolls ?? [])) updateData.rolls = rolls;
  return updateData;
}
/* -------------------------------------------- */

/**
 * Update Game Mode table with in use Health / Defense / Toughness 
 * @private
 */
function _updateModeHealth(actor, source, updateData) {
  if (actor.type !== "char") return updateData;
  const mode = CONFIG.ageSystem.healthSys.mode;
  const path = `system.gameMode.specs.${mode}`;
  const sourceSystem = source?.system ?? actor.system ?? {};
  const health = sourceSystem.health?.set;
  const defense = sourceSystem.defense?.gameModeBonus;
  const toughness = sourceSystem.armor?.toughness?.gameModeBonus;
  if (health !== undefined) updateData[`${path}.health`] = health;
  if (defense !== undefined) updateData[`${path}.defense`] = defense;
  if (toughness !== undefined) updateData[`${path}.toughness`] = toughness;
  
  return updateData
}
/* -------------------------------------------- */

/**
 * Add Effects flags for version 0.8.8
 * @private
 */
 function _addEffectFlags(effect, updateData) {
  if (effect.flags?.["age-system"]?.type === 'conditions' && effect.flags?.core?.statusId) {
    updateData.flags = {
      "age-system": {
        isCondition: true,
        conditionType: 'expanse',
        desc: `age-system.conditions.${effect.flags["age-system"].name}.desc`
      }
    };
  }
  return updateData
}
/* -------------------------------------------- */

/**
 * Adjust Focus value to make for the Improved field
 * @private
 */
 function _adjustFocusInitialValue(item, updateData) {
  if (item.type !== "focus") return updateData;
  const itemData = item.system ?? item.data;
  if (itemData.improved) updateData["system.initialValue"] = itemData.initialValue - 1;
  return updateData
}
/* -------------------------------------------- */

/**
 * Set ranged to TRUE (as standard is FALSE) for old items
 * @private
 */
 function _weaponRanged(item, updateData) {
  if (item.type !== 'weapon') return updateData;
  const itemData = item.system ?? item.data;
  const meleeDist = {
    min: false,
    max: false
  }
  if (!itemData.range || itemData.range <= 2) meleeDist.min = true
  if (!itemData.rangeMax || itemData.rangeMax === itemData.range) meleeDist.max = true;
  const isRanged = meleeDist.min && meleeDist.max ? false : true;
  updateData["system.ranged"] = isRanged;
  return updateData
}
/* -------------------------------------------- */

/**
 * Calculated Damage formula based on previous data template
 * @private
 */
 function _itemDamage(item, updateData) {
  if (!['weapon', 'power'].includes(item.type)) return updateData;
  let formula = ""
  let first = true;
  const itemData = item.system ?? item.data;
  if (itemData.nrDice && itemData.diceType) {
    formula += `${itemData.nrDice}d${itemData.diceType}`;
    first = false
  }
  if (itemData.extraValue) {
    if (!first && itemData.extraValue > 0) formula += `+`;
    formula += `${itemData.extraValue}`
  }
  updateData["system.damageFormula"] = formula;

  // Resisted Damage
  if (itemData.damageResisted) {
    formula = ""
    first = true;
    if (itemData.damageResisted.nrDice && itemData.damageResisted.diceType) {
      formula += `${itemData.damageResisted.nrDice}d${itemData.damageResisted.diceType}`;
      first = false
    }
    if (itemData.damageResisted.extraValue) {
      if (!first && itemData.damageResisted.extraValue > 0) formula += `+`;
      formula += `${itemData.damageResisted.extraValue}`
    }
    updateData["system.damageResisted.damageFormula"] = formula;
  }
  return updateData
}
/* -------------------------------------------- */

/**
 * Populate Migration object on Item based on former itemMods
 * @private
 */
 function _populateItemModifiers(item, updateData) {
  if (!['equipment', 'weapon', 'power', 'talent'].includes(item.type)) return updateData;
  const itemMods = item.system?.itemMods ?? item.data?.itemMods;
  if (!itemMods || typeof itemMods !== "object") return updateData;
  const mods = {};
  const keys = []

  for (const k in itemMods) {
    if (Object.hasOwnProperty.call(itemMods, k)) {
      const m = itemMods[k];
      if (m.value) {
        const modifierConfig = ageSystem.modkeys[k];
        if (!modifierConfig) {
          console.warn(`AGE System | Skipping obsolete modifier type "${k}" on Item ${item.name}.`);
          continue;
        }
        let modKey
        do {
          modKey = foundry.utils.randomID(20);
        } while (keys.includes(modKey));
        keys.push(modKey);
        
        mods[modKey] = {
          type: k,
          formula: `${m.value}`,
          flavor: "",
          isActive: m.isActive,
          conditions: {focus: m.name ? m.name : ""},
          key: modKey,
          // The following data will be recalculated, anyway...
          ftype: modifierConfig.dtype,
          valid: true,
          itemId: item._id,
          itemName: item.name
        }
      }
    }
  }
  
  // This map supersedes the legacy itemMods collection. Mark it as an
  // intentional complete replacement so obsolete previously migrated keys
  // are removed instead of being merged back by the AnyField safety boundary.
  updateData['system.modifiers'] = foundry.data.operators.ForcedReplacement.create(mods);
  return updateData
}
/* -------------------------------------------- */

/**
 * Try to identify Talent Degree and save old data on "Requirements" field
 * @private
 */
 function _talentDegree(item, updateData) {
  const itemData = item.system ?? item.data;
  if (item.type !== 'talent') return updateData;
  if (itemData.degree !== "") return updateData
  const prevDegree = itemData.shortDesc;
  if (!prevDegree) return updateData
  if (prevDegree.trim() === "") return updateData
  const prevDegreeLC = prevDegree.toLowerCase();

  let tdMA = foundry.utils.deepClone(CONFIG.ageSystem.talentDegrees.mage);
  let tdFA = foundry.utils.deepClone(CONFIG.ageSystem.talentDegrees.fage);
  let matches = false;
  let newDegree = "";
  for (let i = 0; i < tdMA.length; i++) {
    tdMA[i] = game.i18n.localize(tdMA[i].toLowerCase());
    tdFA[i] = game.i18n.localize(tdFA[i].toLowerCase());
  }
  for (let i = 0; i < tdMA.length; i++) {
    if (!matches && prevDegreeLC == tdMA[i].toLowerCase()) {
      matches = true;
      newDegree = i
    }
    if (!matches && prevDegreeLC == tdFA[i].toLowerCase()) {
      matches = true;
      newDegree = i
    }
  }

  if (newDegree !== "") { 
    updateData['system.degree'] = newDegree;
  } else {
    updateData['system.degree'] = 0;
  }
  let req = itemData.requirement;
  const degreeText = `${game.i18n.localize('age-system.talentDegree')}: ${itemData.shortDesc}`;
  req = req ? `${req} | ${degreeText}` : degreeText;
  updateData['system.requirement'] = req;

  return updateData
}
/* -------------------------------------------- */
