import {ageSystem} from "./config.js";
import { AdvancementSetup, AgeProgUI } from "./advancement.js";
import { CLASS_ADVANCEMENT_VERSION, ClassAdvancementService, normalizeClassSystem, prepareClassAdvancements } from "./class-advancement.js";
import * as Dice from "./dice.js";
import { applyMessageMode, getCoreMessageMode, MESSAGE_MODES } from "./compat.js";
import { showConfirmDialog } from "./dialogs.js";
import {normalizeDamageSource} from "./damage-utils.js";
import {MultiTargetService} from "./automation/multi-target.js";
import {PowerResistanceService} from "./automation/power-resistance.js";
import {AgeActionService} from "./automation/actions.js";
import {mutateAtomicSystemUpdate, normalizeAtomicSystemUpdate} from "./data/atomic-system-updates.js";
import {openLegacyClassAdvancementCenter} from "./progression/advancement-center.js";
import {
    AGE_PROGRESSION_DEFINITION_ITEM_TYPE,
    assertProgressionDefinitionMutation
} from "./progression/definition-documents.js";

function actionEvent(event = null) {
    return {
        type: typeof event?.type === "string" ? event.type : "ageaction",
        altKey: event?.altKey === true,
        ctrlKey: event?.ctrlKey === true,
        shiftKey: event?.shiftKey === true
    };
}

function resultTargetUuids(results = []) {
    return Array.from(new Set((results ?? []).map(result => result?.tokenUuid ?? result?.actorUuid).filter(Boolean)));
}

function progressionMutationUser(userOrId) {
    // Foundry v14 Document lifecycle methods receive the initiating User
    // object. Retain id resolution for older/internal callers, but never pass a
    // User object to Collection#get as though it were an id.
    if (userOrId && typeof userOrId === "object") return userOrId;
    return game.users?.get?.(userOrId) ?? (game.user?.id === userOrId ? game.user : null);
}

function allowProgressionDefinitionMutation(document, user, action) {
    try {
        assertProgressionDefinitionMutation({user: progressionMutationUser(user), document, action});
        return true;
    } catch (error) {
        ui.notifications.warn(error.message);
        return false;
    }
}

export class ageSystemItem extends foundry.documents.Item {

    // Check if Item can cause damage
    get hasDamage() {
        const type = this.type;
        if (type === "weapon") {return true};
        if (type === "power" && this.system.causeDamage === true) {return true};
        return false;
    };

    // Check if Item heals
    get hasHealing() {
        const type = this.type;
        if (type === "power" && this.system.causeHealing === true) {return true};
        return false;
    }

    // Check if Item requires Fatigue roll to be used
    get hasFatigue() {
        if (this.type === "power" && this.system.useFatigue) {return game.settings.get("age-system", "useFatigue")};
        return false;
    };

    /** @override */
    async _preCreate(data, options, user) {
        const allowed = await super._preCreate(data, options, user);
        if (allowed === false) return false;
        const updates = {};
        const type = data.type ?? this.type;
        if (type === AGE_PROGRESSION_DEFINITION_ITEM_TYPE
            && !allowProgressionDefinitionMutation(this, user, "create")) return false;
        if (!data.img || data.img === `icons/svg/item-bag.svg`) updates.img = ageSystem.itemIcons[type];
        let requestedSystem = data.system && typeof data.system === "object"
            ? foundry.utils.deepClone(data.system)
            : null;
        if (type === "class") {
            const parent = this.parent ?? this.actor;
            if (parent) {
                const attachment = ClassAdvancementService.canAttachClass(parent, this.id);
                if (!attachment.allowed) {
                    ui.notifications.warn(attachment.reason);
                    return false;
                }
            }
            requestedSystem = normalizeClassSystem(data.system ?? this.system ?? {});
            if (parent) {
                requestedSystem.level = 0;
                requestedSystem.progression = {version: CLASS_ADVANCEMENT_VERSION, lastTransactionId: null, legacyLevel: 0};
            }
        }
        if (requestedSystem && Object.keys(requestedSystem).length > 0) {
            const templateSystem = game.model?.Item?.[type] ?? this._source?.system ?? {};
            updates.system = normalizeAtomicSystemUpdate(
                {system: requestedSystem},
                {system: templateSystem}
            ).system;
        }
        this.updateSource(updates);
        return true;
    }

    /** @override */
    async _preUpdate(changed, options, user) {
        if (this.type === AGE_PROGRESSION_DEFINITION_ITEM_TYPE
            && !allowProgressionDefinitionMutation(this, user, "update")) return false;
        mutateAtomicSystemUpdate(changed, this._source, {recursive: options?.recursive});
        const allowed = await super._preUpdate(changed, options, user);
        if (allowed === false || this.type !== "class") return allowed;
        if (options?.classAdvancement || options?.classAdvancementRollback || options?.classAdvancementRecovery || options?.ageSystemMigration) return allowed;

        const dottedSystemChange = Object.keys(changed ?? {}).some(key => key === "system" || key.startsWith("system."));
        const identityChange = Object.prototype.hasOwnProperty.call(changed ?? {}, "name") || Object.prototype.hasOwnProperty.call(changed ?? {}, "img");
        if (this.isOwned && (dottedSystemChange || identityChange)) {
            ui.notifications.warn(game.i18n.localize("age-system.WARNING.ownedClassDefinitionLocked"));
            return false;
        }

        const requestedLevel = Object.prototype.hasOwnProperty.call(changed ?? {}, "system.level")
            ? changed["system.level"]
            : changed?.system?.level;
        if (!this.isOwned && requestedLevel !== undefined && Number(requestedLevel) !== 0) {
            ui.notifications.warn(game.i18n.localize("age-system.WARNING.classDefinitionLevelZero"));
            return false;
        }
        return allowed;
    }
    
    /** @override */
    prepareBaseData() {
        super.prepareBaseData();
        const itemData = this;
        const data = itemData.system;
        const itemType = itemData.type;

        // Progression Items are immutable rule-definition containers. Their
        // exact DefinitionV1 and checksum must never receive gameplay Item
        // preparation, modifiers, Actor-derived fields, or roll state.
        if (itemType === AGE_PROGRESSION_DEFINITION_ITEM_TYPE) return;

        data.colorScheme = `colorset-${game.settings.get("age-system", "colorScheme")}`;
        data.nameLowerCase = String(itemData.name ?? "").toLowerCase();

        // Validate each Modifier formula based on ftype and create Arrays by type
        const rawMods = data.modifiers ??= {};
        data.modifiersByType = {}
        for (const k in rawMods) {
            if (Object.hasOwnProperty.call(rawMods, k)) {
                rawMods[k] = this.evalMod(rawMods[k], k);
                if (rawMods[k].type !== "") {
                    if (data.modifiersByType[rawMods[k].type]) {
                        data.modifiersByType[rawMods[k].type].push(rawMods[k]);
                    } else {
                        data.modifiersByType[rawMods[k].type] = [rawMods[k]];
                    }
                }
            }
        }
        
        // Adding common data for Power and Weapon
        if (["power", "weapon"].includes(itemType)) {
            data.useFocusActorId = data.useFocus && this.actor?.system ? this.actor.checkFocus(data.useFocus).id : null;
            data.useFocusActor = this.actor ? this.actor.checkFocus(data.useFocus) : null;
            data.hasDamage = this.hasDamage;
            data.hasHealing = this.hasHealing;
            data.hasFatigue = this.hasFatigue;

            // Adds value to represent portion added to dice on damage roll
            if (this.isOwned && this.actor) {
                const actorData = this.actor.system;
                if (data.dmgAbl && data.dmgAbl !== "no-abl") {
                    data.ablDamageValue = Number(actorData.abilities?.[data.dmgAbl]?.total) || 0;
                }
                if (data.damageResisted?.dmgAbl && data.damageResisted.dmgAbl !== "no-abl") {
                    data.damageResisted.ablDamageValue = Number(actorData.abilities?.[data.damageResisted.dmgAbl]?.total) || 0;
                }
            };

            // Evaluate Attack and Damage modifier
            if (data.hasDamage || data.hasHealing) this.prepareDamageData(data)
        }

        switch (itemType) {
            case "focus": this._prepareFocus(data); break;
            case "power": this._preparePower(data); break;
            case "shipfeatures": this._prepareShipFeatures(data); break;
            case "class": this._prepareClass(data); break;
        }
    };

    _prepareClass(system) {
        const prepared = prepareClassAdvancements(system);
        Object.assign(system, prepared.normalized);
        system.advArrIndex = system.level - 1;
        system.advPerLvl = prepared.levels;
        system.definitionErrors = [];
    }

    prepareDamageData(data) {
        // Evaluate Attack and Damage formula to represent on Item sheet or stat block
        const actor = this.actor?.system;
        if (data.hasDamage || data.hasHealing) {
            const useFocus = actor ? this.actor.checkFocus(data.useFocus) : null;
            const mode = game.settings.get("age-system", "healthSys");
            const useInjury = [`mageInjury`, `mageVitality`].includes(mode);

            // ATTACK BUILDER
            // Attack Mod - Actor Scope
            const atkBonuses = [];
            if (useFocus) atkBonuses.push(useFocus.value);
            const actorAbl = actor?.abilities?.[data.useAbl]?.total;
            if (actorAbl) atkBonuses.push(actor.abilities[data.useAbl].total);
            const atkBonusActor = ["testMod", "attackMod"];
            if (actor) {
                for (let am = 0; am < atkBonusActor.length; am++) {
                    const modName = atkBonusActor[am];
                    if (actor[modName]) atkBonuses.push(actor[modName]);
                };
            };

            // Attack Mod - Item Scope
            const atkBonusItem = ["itemActivation"];
            const itemRollMod = [];
            if (data.modifiersByType) {
                for (let a = 0; a < atkBonusItem.length; a++) {
                    const modName = atkBonusItem[a];
                    const mods = data.modifiersByType[modName]
                    if (mods) {
                        for (let i = 0; i < mods.length; i++) {
                            const m = mods[i];
                            if (m.valid && m.isActive) itemRollMod.push(m.formula);
                        }
                    } 
                };
            }
            let itemRollModFormula = "";
            for (let i = 0; i < itemRollMod.length; i++) {
                const p = itemRollMod[i];
                if (i > 0) itemRollModFormula += " + ";
                itemRollModFormula += p;
                atkBonuses.push(p)
            }
            data.activateMod = itemRollModFormula;
            // Bonus to Roll item (Ability/Focus test)
            data.itemRollMod = itemRollModFormula;
            let atkBonus = ""
            for (let i = 0; i < atkBonuses.length; i++) {
                const p = atkBonuses[i];
                if (i > 0) atkBonus += " + ";
                atkBonus += p;
            }
            const attkPartials = Dice.resumeFormula(atkBonus, this.actor?.actorRollData() ?? {});
            data.atkRollMod = attkPartials ? attkPartials.shortFormula : "+0";

            // DAMAGE BUILDER
            // Item Base Damage
            const dmgBonusArr = []
            let baseDamage = 0;
            if (useInjury) baseDamage = data.damageInjury;
            else if (data.damageFormula) baseDamage = data.damageFormula;
            dmgBonusArr.push(baseDamage);
            // Damage Formula - Actor Scope
            if (data.dmgAbl !== "no-abl") {
                if (actor?.abilities?.[data.dmgAbl]?.total) dmgBonusArr.push(actor.abilities[data.dmgAbl].total)
            }
            const dmgBonusActor = ["dmgMod"];
            if (actor) {
                for (let am = 0; am < dmgBonusActor.length; am++) {
                    const modName = dmgBonusActor[am];
                    if (actor[modName]) dmgBonusArr.push(actor[modName]);
                };
            };
            // Damage Parts - Item Scope
            const dmgBonusItemArr = []
            const dmgBonusItem = ["itemDamage"];
            if (data.modifiersByType) {
                for (let a = 0; a < dmgBonusItem.length; a++) {
                    const modName = dmgBonusItem[a];
                    const mods = data.modifiersByType[modName]
                    if (mods) {
                        for (let i = 0; i < mods.length; i++) {
                            const m = mods[i];
                            if (m.valid && m.isActive) {
                                dmgBonusItemArr.push(m.formula);
                            }
                        }
                    } 
                };
            }
            let itemDmgModFormula = "";
            for (let i = 0; i < dmgBonusItemArr.length; i++) {
                const p = dmgBonusItemArr[i];
                if (i > 0) itemDmgModFormula += " + ";
                itemDmgModFormula += `${p}`;    
                dmgBonusArr.push(p)
            }
            let dmgBonus = ""
            for (let i = 0; i < dmgBonusArr.length; i++) {
                const p = dmgBonusArr[i];
                if (i > 0) dmgBonus += " + ";
                dmgBonus += p;
            }
            const dmgPartials = Dice.resumeFormula(dmgBonus, this.actor?.actorRollData() ?? {});
            data.itemDmgMod = itemDmgModFormula ? itemDmgModFormula : "0";
            data.dmgFormula = dmgPartials ? dmgPartials.shortFormula : 0;
        }

        if (actor && this.type === 'weapon') {
            const rangeParts = Dice.resumeFormula(`${data.range}`, this.actor?.actorRollData() ?? {});
            data.rangeCalc = rangeParts ? rangeParts.detValue : "";

            const rangeMaxParts = Dice.resumeFormula(`${data.rangeMax}`, this.actor?.actorRollData() ?? {});
            data.rangeMaxCalc = rangeMaxParts ? rangeMaxParts.detValue : "";
        } else {
            data.rangeCalc = data.range;
            data.rangeMaxCalc = data.rangeMax;
        }
    }

    _prepareFocus(data) {
        const focusParts = [];
        const actor = this.actor;
        const actorData = actor?.system;
        if (data.initialValue) focusParts.push(data.initialValue);
        if (data.improved) focusParts.push("1");
        if (this.isOwned && actorData) {
            const focusBonus = actorData.ownedMods?.focus?.parts;
            if (focusBonus?.length) {
                for (let f = 0; f < focusBonus.length; f++) {
                    const m = focusBonus[f];
                    const focusName = String(m.conditions?.focus ?? "").toLowerCase();
                    if (m.valid && m.isActive && data.nameLowerCase === focusName) focusParts.push(m.formula);
                }
            }
        }
        let focusFormula = "";
        for (let i = 0; i < focusParts.length; i++) {
            const p = focusParts[i];
            if (i > 0) focusFormula += " + "
            focusFormula += `${p}`
        }
        const partial = Dice.resumeFormula(focusFormula, actor?.actorRollData() ?? {});
        data.finalValue = partial ? partial.detValue : 0;

        const abilitiesOrg = Object.keys(ageSystem.abilitiesOrg);
        const abilitiesChar = Object.keys(ageSystem.abilities);
        const hasOrgAbl = abilitiesOrg.includes(data.useAbl);
        if (data.isOrg === !hasOrgAbl) data.useAbl = data.isOrg ? abilitiesOrg[0] : abilitiesChar[0]; 
    }

    _preparePower(data) {
        const useFatigue = game.settings.get("age-system", "useFatigue");
        if (!useFatigue) data.useFatigue = false;

        // Calculate Item Force
        // data.itemForce = 10;
        const itemForceBonus = []

        // Actor Scope
        const actor = this.actor;
        const actorData = actor?.system;
        if (actor) {

            // Ability bonus
            const abl = actorData?.abilities?.[data?.itemForceAbl]?.total;
            if (data.itemForceAbl !== "no-abl" && abl) itemForceBonus.push(actorData.abilities[data.itemForceAbl].total)

            // Focus Bonus
            if (data.useFocus) itemForceBonus.push(actor.checkFocus(data.useFocus).value)

            // General 'allPowerForce' bonus
            const actorForceBonus = ["allPowerForce"];
            if (actorData?.ownedMods) {
                for (let am = 0; am < actorForceBonus.length; am++) {
                    const modName = actorForceBonus[am];
                    if (actorData.ownedMods[modName]) itemForceBonus.push(actorData.ownedMods[modName].totalFormula);
                };
            };

            // Instances of 'focusPowerForce' mods
            const focusPowerForce = actorData?.ownedMods?.['focusPowerForce']?.parts;
            if (focusPowerForce?.length) {
                for (let f = 0; f < focusPowerForce.length; f++) {
                    const m = focusPowerForce[f];
                    const requiredFocus = String(m.conditions?.focus ?? "").trim().toLowerCase();
                    const usedFocus = String(data.useFocus ?? "").trim().toLowerCase();
                    if (m.valid && m.isActive && requiredFocus && requiredFocus === usedFocus) itemForceBonus.push(m.formula);
                }
            }
        }
        
        // Identify Bonus to Increase only this Power Item Force
        const thisPFmods = data.modifiersByType?.['powerForce'];
        if (thisPFmods) {
            const validMods = thisPFmods.filter(i => i.valid && i.isActive);
            if (validMods.length) {
                for (let i = 0; i < validMods.length; i++) {
                    const m = validMods[i];
                    itemForceBonus.push(m.formula)
                }
            }
        }

        let itemForceBonusFormula = "10";
        for (let i = 0; i < itemForceBonus.length; i++) {
            const b = itemForceBonus[i];
            itemForceBonusFormula += ` + ${b}`            
        }
        const itemForcePartials = Dice.resumeFormula(itemForceBonusFormula, actor?.actorRollData() ?? {});
        data.itemForceBonus = itemForcePartials ? itemForcePartials.detValue : 0;
        data.itemForce = data.itemForceBonus;
        
        // Calculate Power Points and Strain
        data.powerPointCostTotal = data.powerPointCost;
        const strain = actorData?.armor?.strain
        data.powerPointCostTotal += strain ? strain : 0;

        // Calculate Fatigue TN if it is not a manual input
        if (data.inputFatigueTN === false) data.fatigueTN = 9 + Math.floor(Number(data.powerPointCost)/2);
    }

    _prepareShipFeatures(data) {};

    // Code to for opening the correct sheet - used when opening Owned Items from char sheet (this can be removed when bug is clearly identified and fixed)
    async openSheet() {
        const ageSheet = 'age-system.ageSystemSheetItem'
        const sheet = this.sheet
        await sheet.close()
        this._sheet = null
        delete this.apps[sheet.appId]
        await this.setFlag('core', 'sheetClass', ageSheet)
        this.sheet.render(true)
    }

    /**
     * Adds a new object inside Modifiers object
     * @param {Object} object.type Modifier type
     * @param {Object} object.formula Modifier value to be used
     * @returns Promise to update Item with new Modifier slot
     */
    _newModifier({type = "", formula = "0", flavor = ""}={}) {
        const itemData = this.system
        const modifiers = foundry.utils.deepClone(itemData.modifiers);
        const keys = [];
        for (const k in modifiers) {
            if (Object.hasOwnProperty.call(modifiers, k)) {
                keys.push(k)
            }
        }

        let modName
        do {
            modName = foundry.utils.randomID(20);
        } while (keys.includes(modName));
        const path = `system.modifiers.${modName}`

        const newMod = {
            type: type,
            formula: formula,
            flavor: flavor,
            isActive: true,
            valid: true,
            conditions: {},
            ftype: "",
            key: modName,
        }
        return this.update({[path]: newMod});
    }

    async _onChangeAdvancement(data, action) {
        if (this.type !== "class" || this.isOwned) return false;
        const type = data.type;
        const id = Number(data.id);
        if (!["item", "progressive"].includes(type) || !Number.isInteger(id)) return false;
        const normalized = normalizeClassSystem(this.system);
        const entries = foundry.utils.deepClone(normalized.advancements[type]);
        if (!entries[id]) return false;
        if (action === "remove") {
            entries.splice(id, 1);
            return this.update({[`system.advancements.${type}`]: entries});
        }
        if (action === "edit") {
            return new AdvancementSetup(this.uuid, type, {data: entries[id], index: {id}}).render(true);
        }
        return false;
    }

    async _levelChange(action) {
        if (this.type !== "class") return null;
        if (!this.isOwned || !this.actor) return ui.notifications.warn(game.i18n.localize("age-system.WARNING.ownedClassLevelOnly"));
        if (action === "add") return this._levelUp();
        if (action === "remove") return this._levelDown();
        return null;
    }

    async _levelUp() {
        if (this.type !== "class" || !this.isOwned || !this.actor) return null;
        if (Number(this.system.level) >= ageSystem.maxLevel) return ui.notifications.warn(game.i18n.localize("age-system.WARNING.classMaxLevel"));
        const legacyFallback = () => AgeProgUI.open(this.actor, this);
        try {
            return await openLegacyClassAdvancementCenter({
                service: game.ageSystem?.progression ?? null,
                actor: this.actor,
                classItem: this,
                legacyFallback
            });
        } catch (error) {
            if (["profile-unsupported", "service-unavailable"].includes(error?.code)) return legacyFallback();
            console.error("AGE System | Unable to start class advancement", error);
            return ui.notifications.error(error.message);
        }
    }

    async _levelDown() {
        if (this.type !== "class" || !this.isOwned || !this.actor) return null;
        if (Number(this.system.level) <= ageSystem.minLevel) return ui.notifications.warn(game.i18n.localize("age-system.WARNING.classMinLevel"));
        const confirmed = await showConfirmDialog({
            title: game.i18n.localize("age-system.CLASS.rollbackTitle"),
            content: `<p>${game.i18n.format("age-system.CLASS.rollbackConfirm", {name: this.name, level: this.system.level})}</p>`,
            defaultYes: false,
        });
        if (!confirmed) return null;
        try {
            const transaction = await ClassAdvancementService.rollbackLevel(this.actor, this);
            ui.notifications.info(game.i18n.format("age-system.CLASS.levelRolledBack", {name: this.name, level: transaction.level}));
            return transaction;
        } catch (error) {
            console.error("AGE System | Class rollback failed", error);
            return ui.notifications.error(error.message);
        }
    }

    async _preDelete(options, user) {
        const allowed = await super._preDelete(options, user);
        if (allowed === false) return false;
        if (this.type === AGE_PROGRESSION_DEFINITION_ITEM_TYPE
            && !allowProgressionDefinitionMutation(this, user, "delete")) return false;
        if (this.type === "class" && this.isOwned && !options?.classAdvancementRollback) {
            const transactions = this.actor?.system?.classProgression?.transactions ?? [];
            const hasAppliedLevels = Number(this.system?.level) > 0
                || Number(this.system?.progression?.legacyLevel) > 0
                || transactions.some(transaction => transaction.classItemId === this.id);
            if (hasAppliedLevels) {
                ui.notifications.warn(game.i18n.localize("age-system.WARNING.classDeleteApplied"));
                return false;
            }
        }
        return allowed !== false;
    }

    // Assists to identify if the value of a Modifier has valid data according to Modifier's Formula Type (ftype)
    evalMod(m, key = null) {
        if (!m || typeof m !== "object") return m;
        // The map key is authoritative. Older and third-party modifiers may
        // omit the redundant stored `key`, but Character controls still need
        // it in prepared data. Compatible models isolate this branch from
        // `_source`, so the derived key is never persisted implicitly.
        if (key !== null && key !== undefined) m.key = String(key);
        if (m.type === "") return m;
        const modifierKey = ageSystem.modkeys[m.type];
        if (!modifierKey) {
            m.ftype = "";
            m.itemId = this.id;
            m.itemName = this.name;
            m.valid = false;
            m.isActive = false;
            return m;
        }
        m.ftype = modifierKey.dtype;
        let validFormula = true;
        try {
            switch (m.ftype) {
                case "nodice": {
                    // Check formula for Dice Terms
                    const tempRoll = new Roll(String(m.formula ?? ""));
                    tempRoll.terms.forEach(term => {
                        if (term instanceof foundry.dice.terms.DiceTerm) validFormula = false;
                    });
                    break;
                }

                case "number":
                    if (!Number.isFinite(Number(m.formula))) validFormula = false;
                    break;

                case "formula":
                    break;

                default:
                    validFormula = false;
                    break;
            }
        } catch (error) {
            validFormula = false;
        }
        m.itemId = this.id;
        m.itemName = this.name;
        m.valid = validFormula && Roll.validate(String(m.formula ?? ""));
        if (!m.valid) m.isActive = false;
        return m
    }

    // Rolls damage for the item
    rollDamage({
        event = null,
        stuntDie = null,
        addFocus = false,
        atkDmgTradeOff = 0,
        resistedDmg = false,
        ageAction = null}={}) {

        if (!ageAction && AgeActionService.supports("roll.damage")) {
            const options = {...(arguments[0] ?? {})};
            delete options.event;
            delete options.ageAction;
            const targetUuids = resultTargetUuids(options.targetResults);
            const request = {
                type: "roll.damage",
                actorUuid: this.actor?.uuid ?? null,
                itemUuid: this.uuid ?? null,
                sourceUuid: this.uuid ?? null,
                targetUuids,
                payload: {...options, event: actionEvent(event)},
                metadata: {origin: "item.rollDamage"}
            };
            return AgeActionService.execute(request, {
                executor: action => this.rollDamage({...arguments[0], ageAction: action})
            }).then(execution => execution.result);
        }

        const itemData = this.system;
        const actor = this.actor;
        const actorData = actor?.system;

        if (!itemData.hasDamage && !itemData.hasHealing) return false;

        const damageData = {
            // event: event,
            // atkDmgTradeOff: atkDmgTradeOff,
            // stuntDie: stuntDie,
            // addFocus: addFocus,
            // resistedDmg: resistedDmg,
            ...arguments[0],
            item: this,
            ageAction,
            actorDmgMod: actor ? actorData.dmgMod : 0,
            actorWgroups: actorData?.wgroups ?? []
        };
        return Dice.itemDamage(damageData);
    };

    // Roll item and check targetNumbers
    async roll(event, rollType = null, targetNumber = null, actionOptions = {}) {
        const ROLL_TYPE = ageSystem.ROLL_TYPE;
        const actor = this.actor;
        const itemData = this.system;
        if (this.type === "power" && !itemData.hasRoll) return false
        if (!actor) return false;

        if (rollType === null) {
            switch (this.type) {
                case "weapon":
                    rollType = ROLL_TYPE.ATTACK
                    break;
                case "power":
                    rollType = ROLL_TYPE.POWER
                    break
                case "focus":
                    rollType = ROLL_TYPE.FOCUS
                    break
                default:
                    break;
            }
        }

        const targetSource = actionOptions.targets ?? game.user.targets;
        const actionType = this.type === "power" && rollType !== ROLL_TYPE.FATIGUE
            ? "roll.power"
            : (this.type === "weapon" && MultiTargetService.isAttackRoll(rollType) ? "roll.attack" : null);
        if (!actionOptions.ageAction && actionType && AgeActionService.supports(actionType)) {
            const targets = Array.from(targetSource?.values?.() ?? targetSource ?? []);
            const snapshots = MultiTargetService.collect(targets);
            const request = {
                type: actionType,
                actorUuid: actor.uuid ?? null,
                itemUuid: this.uuid ?? null,
                sourceUuid: this.uuid ?? null,
                targetUuids: snapshots.map(target => target.tokenUuid ?? target.actorUuid).filter(Boolean),
                payload: {
                    rollType,
                    targetNumber,
                    event: actionEvent(event),
                    targetSnapshots: snapshots
                },
                metadata: {origin: "item.roll"}
            };
            const execution = await AgeActionService.execute(request, {
                // Enter the unwrapped roll body directly. Calling this.roll()
                // here can re-enter third-party wrappers (notably Ammo Belt's
                // per-Actor queue) and deadlock the outer tracked attack.
                executor: action => this._rollAgeAction(event, rollType, targetNumber, {ageAction: action, targets})
            });
            return execution.result;
        }

        return this._rollAgeAction(event, rollType, targetNumber, actionOptions);
    }

    async _rollAgeAction(event, rollType, targetNumber, actionOptions = {}) {
        const ROLL_TYPE = ageSystem.ROLL_TYPE;
        const actor = this.actor;
        const actorData = actor?.system;
        const itemData = this.system;
        if (this.type === "power" && !itemData.hasRoll) return false;
        if (!actor) return false;
        const targetSource = actionOptions.targets ?? game.user.targets;
        let ablCode = (rollType === ROLL_TYPE.FATIGUE) ? itemData.ablFatigue : itemData.useAbl;
        
        const isAttack = MultiTargetService.isAttackRoll(rollType);
        let rollTargets = [];
        if (isAttack) {
            const selectedTargets = MultiTargetService.collect(targetSource);
            if (selectedTargets.length > 1 && !MultiTargetService.enabled) {
                ui.notifications.warn(game.i18n.localize("age-system.WARNING.selectOnlyOneTarget"));
                return false;
            }
            if (MultiTargetService.enabled) rollTargets = selectedTargets;
        }

        if (targetNumber === null) {
            switch (rollType) {
                case ROLL_TYPE.FATIGUE:
                    ablCode = itemData.ablFatigue;
                    targetNumber = itemData.fatigueTN ? itemData.fatigueTN : null;
                    break;
                
                case ROLL_TYPE.POWER:
                    targetNumber = itemData.targetNumber ? itemData.targetNumber : null;
                    break;
    
                case ROLL_TYPE.ATTACK:
                case ROLL_TYPE.RANGED_ATTACK:
                case ROLL_TYPE.MELEE_ATTACK:
                case ROLL_TYPE.STUNT_ATTACK:
                    if (rollTargets.length === 1) targetNumber = rollTargets[0].defense;
                    else if (!MultiTargetService.enabled && game.user.targets.size === 1) {
                        const targetId = game.user.targets.ids[0];
                        const targetToken = canvas.tokens.placeables.find(t => t.id === targetId);
                        targetNumber = targetToken?.actor?.system?.defense?.total ?? null;
                    }
                    break;
        
                default:
                    break;
            }
        }

        const rollData = {
            event: event,
            actor: actor,
            abl: ablCode,
            itemRolled: this,
            rollTN: targetNumber,
            rollType,
            rollTargets,
            powerResistance: PowerResistanceService.prepare(this, targetSource),
            ageAction: actionOptions.ageAction ?? null
        }
        
        // Check if power is used and look for Power Points
        if (rollType !== ROLL_TYPE.FATIGUE && this.type === 'power' && Dice.powerPointConsumptionEnabled()) {
            if (!this.hasFatigue && actor) {
                const cost = itemData.powerPointCostTotal;
                const remainingPP = actorData?.powerPoints.value;
                rollData.ppCost = {
                    remainingPP,
                    cost,
                }
            }
        }

        return Dice.ageRollCheck(rollData);
    };

    chatTemplate = {
        "item-to-chat": "systems/age-system/templates/sheets/chat/item-to-chat.hbs"
    };

    async showItem(forceSelfRoll = false) {
        const item = this;
        const itemData = this.system;
        const rollMode = getCoreMessageMode();
        const cardData = {
            inChat: true,
            name: item.name,
            system: item.system,
            item: item,
            itemId: item.id,
            owner: this.actor,
            ownerUuid: this.actor?.uuid ?? null,
            config: ageSystem,
            // config: {
            //     colorScheme: ageSystem.colorScheme,
            //     wealthMode: game.settings.get("age-system", "wealthType")
            // },
            cssClass: `age-system colorset-${ageSystem.colorScheme} item-to-chat`,
            effectiveDamageSource: normalizeDamageSource(item.system?.dmgSource, ageSystem.healthSys)
        };
        const chatData = {
            user: game.user.id,
            speaker: ChatMessage.getSpeaker(),
            content: await foundry.applications.handlebars.renderTemplate(item.chatTemplate["item-to-chat"], cardData),
            flags: {
                "age-system": {messageData: cardData}
            }
        };
        if (forceSelfRoll) {
            applyMessageMode(chatData, MESSAGE_MODES.SELF);
        } else {
            applyMessageMode(chatData, rollMode);
        }
        return ChatMessage.create(chatData);
    };
};
