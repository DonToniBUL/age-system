import {ageSystem} from "../config.js";
import {statusEffectArray} from "../compat.js";
import {colorSchemeClass} from "../color-scheme.js";
import {normalizeDamageSource} from "../damage-utils.js";
import {focusList} from "../settings.js";
import {modifiersList, sortObjArrayByName} from "../setup.js";
import {validateClassDefinition} from "../class-advancement.js";
import {enrichAgeRichText, enrichEmbeddedLongDescriptions} from "./embedded-description.js";
import {prepareMassBattleContext} from "../mass-battle.js";

const ACTOR_EDITOR_PATHS = Object.freeze({
    char: ["system.features"],
    force: ["system.description", "system.notes", "system.gmNotes"],
    organization: ["system.description"],
    spaceship: ["system.description"],
    vehicle: ["system.description"]
});

const ITEM_EDITOR_PATHS = Object.freeze([
    "system.description",
    "system.longDesc",
    "system.degree0.desc",
    "system.degree1.desc",
    "system.degree2.desc",
    "system.degree3.desc",
    "system.degree4.desc"
]);

async function enrichFields(document, paths) {
    const enriched = {};
    for (const path of paths) {
        const raw = String(foundry.utils.getProperty(document, path) ?? "");
        foundry.utils.setProperty(enriched, path, await enrichAgeRichText(raw, document));
    }
    return enriched;
}

function baseActorContext(sheet, data) {
    const editable = sheet.isEditable;
    return {
        actor: sheet.actor,
        cssClass: editable ? "editable" : "locked",
        data,
        system: data.system,
        effects: data.effects,
        items: data.items,
        limited: sheet.actor.limited,
        options: sheet.options,
        owner: sheet.actor.isOwner,
        editable,
        title: sheet.title,
        isGM: game.user.isGM,
        appV2: true,
        parityVersion: 3
    };
}

async function prepareCharacterContext(sheet) {
    const data = sheet.actor.toObject(false);
    data.items.sort((a, b) => (a.sort || 0) - (b.sort || 0));
    data.config = ageSystem;

    const itemSorted = sortObjArrayByName(data.items, "name");
    data.class = itemSorted.filter(item => item.type === "class");
    data.classManagedLevel = data.class.some(item => Number(item.system?.level) > 0 || Number(item.system?.progression?.legacyLevel) > 0)
        || (data.system?.classProgression?.transactions ?? []).length > 0;
    for (const type of ["weapon", "talent", "power", "focus", "stunts", "equipment", "honorifics", "relationship", "membership"]) {
        data[type] = itemSorted.filter(item => item.type === type);
    }
    await enrichEmbeddedLongDescriptions(data.power, sheet.actor);
    data.stunts.sort((a, b) => a.system.stuntPoints - b.system.stuntPoints);
    for (const [key, collection] of Object.entries({
        favWeapon: "weapon", favPower: "power", favEquip: "equipment", favStunt: "stunts",
        favTalent: "talent", favRelation: "relationship", favHonor: "honorifics", favMembership: "membership"
    })) data[key] = data[collection].filter(item => item.system.favorite);

    data.conditions = statusEffectArray(CONFIG.statusEffects).filter(effect => effect.flags?.["age-system"]?.isCondition);
    for (const condition of data.conditions) {
        if (ageSystem.inUseStatusEffects !== "custom") {
            condition.name = game.i18n.localize(condition.name);
            if (condition.flags?.["age-system"]?.desc) {
                condition.flags["age-system"].desc = game.i18n.localize(condition.flags["age-system"].desc);
            }
        }
        if (data.effects.some(effect => effect.statuses.includes(condition.id))) condition.active = true;
    }
    data.conditions = sortObjArrayByName(data.conditions, "name");
    const statusIds = statusEffectArray(CONFIG.statusEffects).map(effect => effect.id).filter(Boolean);
    data.effects = sortObjArrayByName(data.effects.filter(effect => !statusIds.includes(effect.statuses[0])), "name");
    data.ancestry = game.settings.get("age-system", "ancestryOpt");
    data.occupation = game.settings.get("age-system", "occupation");
    data.healthMode = game.settings.get("age-system", "healthMode");
    data.weaponGroups = ageSystem.weaponGroups;

    return {
        ...baseActorContext(sheet, data),
        conditions: data.condEffects,
        inUseStatusEffects: ageSystem.inUseStatusEffects,
        classManagedLevel: data.classManagedLevel,
        colorScheme: colorSchemeClass()
    };
}

function prepareVehicleContext(sheet) {
    const data = sheet.actor.toObject(false);
    data.config = CONFIG.ageSystem;
    data.passengers = sortObjArrayByName(data.system.passengers ?? [], "name");
    return baseActorContext(sheet, data);
}

function prepareSpaceshipContext(sheet) {
    const data = sheet.actor.toObject(false);
    data.config = CONFIG.ageSystem;
    data.passengers = sortObjArrayByName(data.system.passengers ?? [], "name");
    const itemSorted = sortObjArrayByName(data.items, "name");
    data.qualities = itemSorted.filter(item => item.system.quality === "quality" && item.system.type !== "weapon");
    data.flaws = itemSorted.filter(item => item.system.quality === "flaw" && item.system.type !== "weapon");
    data.weapon = itemSorted.filter(item => item.system.type === "weapon");
    data.notSynth = !(sheet.token && !sheet.token.actorLink);
    data.isSynth = !data.notSynth;
    return baseActorContext(sheet, data);
}

function prepareOrganizationContext(sheet) {
    const data = sheet.actor.toObject(false);
    data.items.sort((a, b) => (a.sort || 0) - (b.sort || 0));
    return {
        ...baseActorContext(sheet, data),
        focus: data.items.filter(item => item.type === "focus"),
        config: CONFIG.ageSystem,
        ROLL_TYPE: CONFIG.ageSystem.ROLL_TYPE
    };
}

async function prepareForceContext(sheet) {
    const data = sheet.actor.toObject(false);
    return {
        ...baseActorContext(sheet, data),
        config: CONFIG.ageSystem,
        massBattle: await prepareMassBattleContext(sheet.actor)
    };
}

export async function prepareActorV2Context(sheet) {
    let context;
    switch (sheet.actor.type) {
        case "char": context = await prepareCharacterContext(sheet); break;
        case "vehicle": context = prepareVehicleContext(sheet); break;
        case "spaceship": context = prepareSpaceshipContext(sheet); break;
        case "organization": context = prepareOrganizationContext(sheet); break;
        case "force": context = await prepareForceContext(sheet); break;
        default: throw new Error(`AGE System | No native AppV2 context for Actor type ${sheet.actor.type}.`);
    }
    context.ageEditors = await enrichFields(sheet.actor, ACTOR_EDITOR_PATHS[sheet.actor.type] ?? []);
    return context;
}

export async function prepareItemV2Context(sheet) {
    const item = sheet.item;
    const context = {
        item,
        document: item,
        data: item.system,
        system: item.system,
        cssClass: sheet.isEditable ? "editable" : "locked",
        editable: sheet.isEditable,
        owner: item.isOwner,
        limited: item.limited,
        options: sheet.options,
        title: sheet.title,
        isGM: game.user.isGM,
        appV2: true,
        parityVersion: 3,
        colorScheme: colorSchemeClass()
    };
    ageSystem.focus = focusList(game.settings.get("age-system", "masterFocusCompendium"));
    context.config = ageSystem;
    context.localType = game.i18n.localize(`TYPES.Item.${item.type}`);
    context.config.wealthMode = game.settings.get("age-system", "wealthType");
    if (item.type === "shipfeatures") {
        context.config.featuresTypeLocal = sortObjArrayByName(context.config.featuresType.map(key => ({
            key,
            name: game.i18n.localize(`age-system.spaceship.${key}`)
        })), "name");
    }
    context.weaponGroups = ageSystem.weaponGroups;
    context.usePrimaryAbl = game.settings.get("age-system", "primaryAbl");
    if (item.type === "class" && context.usePrimaryAbl) {
        const selected = foundry.utils.deepClone(ageSystem.abilities);
        const all = foundry.utils.deepClone(ageSystem.abilitiesTotal);
        const extra = {};
        for (const key of Object.keys(all)) if (!selected[key]) extra[key] = game.i18n.localize(`age-system.${key}`);
        context.ablOptions = {...selected, ...extra};
    }
    context.hasOptionsTab = item.type === "weapon" && context.weaponGroups;
    if (item.actor?.type === "char") context.actorEffects = item.actor.effects;
    context.displayIsOrg = !item.isOwned;
    context.modifiersList = modifiersList();
    context.fatigueSet = game.settings.get("age-system", "useFatigue");
    context.effectiveDamageSource = normalizeDamageSource(item.system?.dmgSource, ageSystem.healthSys);
    if (item.type === "talent") context.expandedDegrees = ageSystem.talentDegrees.inUse.length > 3;
    if (item.type === "class") {
        context.classValidation = validateClassDefinition(item.system);
        context.classDefinitionEditable = sheet.isEditable && !item.isOwned;
        context.classOwned = item.isOwned;
        const last = item.actor?.system?.classProgression?.transactions?.at(-1);
        context.classLevelCanIncrease = item.isOwned && Number(item.system.level) < ageSystem.maxLevel;
        context.classLevelCanDecrease = item.isOwned && last?.classItemId === item.id && Number(last.level) === Number(item.system.level);
        context.classLegacyLevel = Number(item.system.progression?.legacyLevel) || 0;
    }
    context.ageEditors = await enrichFields(item, ITEM_EDITOR_PATHS);
    return context;
}
