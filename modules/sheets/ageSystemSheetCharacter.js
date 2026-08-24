import * as Dice from "../dice.js";
import {ageSystem} from "../config.js";
import { sortObjArrayByName } from "../setup.js";
import {newItemData, normalizeFreeTextFields} from "./helper.js";
import { statusEffectArray } from "../compat.js";
import {colorSchemeClass} from "../color-scheme.js";
import {characterGameModeProfileUpdate} from "../data/character-source.js";
import {toggleItemModifierUpdate} from "../data/item-modifier-updates.js";
import {
    activatePersistentSheetPosition,
    configurePersistentSheetPosition,
    enforcePersistentSheetPosition,
    persistentSheetRenderOptions,
    queuePersistentSheetPositionSave,
    savePersistentSheetPosition
} from "./sheet-position.js";

export default class ageSystemSheetCharacter extends foundry.appv1.sheets.ActorSheet {

    constructor(...args) {
        super(...args);
        this._ageActivePrimaryTab = "main";
        configurePersistentSheetPosition(this, {
            key: "character-full",
            defaultWidth: 700,
            defaultHeight: 875,
            minWidth: 620,
            minHeight: 620,
            maxWidth: 1500,
            maxHeight: 1200
        });
    }
    
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            height: 875,
            width: 700,
            classes: ["age-system", "sheet", "char-sheet-alt", colorSchemeClass()],
            tabs: [{
                navSelector: ".add-sheet-tabs",
                contentSelector: ".sheet-tab-section",
                initial: "main"
            }]
        });
    }

    // static DEFAULT_OPTIONS = {
    //     classes: ["age-system", "sheet", "char-sheet-alt", colorSchemeClass()],
    //     position: {
    //         width: 700,
    //         height: 875
    //     },
    //     window: {
    //         resizable: true,
    //         title: `age-system.SHEETS.charStandard` // Just the localization key
    //     }
    // }

    // static PARTS = {
    //     form: {
    //         template: `systems/age-system/templates/sheets/char/char-sheet.hbs`
    //     }
    // }

    get template() {
        return `systems/age-system/templates/sheets/char/char-sheet.hbs`;
    }

    async _render(force = false, options = {}) {
        await super._render(force, persistentSheetRenderOptions(this, options));
        enforcePersistentSheetPosition(this);
    }

    setPosition(position = {}) {
        const result = super.setPosition(position);
        queuePersistentSheetPositionSave(this);
        return result;
    }

    get observerRoll () {
        return game.settings.get("age-system", "observerRoll");
    }

    /* -------------------------------------------- */

    /** @inheritdoc */
    async getData(options) {
        const isOwner = this.document.isOwner;
        const isEditable = this.isEditable;
    
        // Copy actor data to a safe copy
        const data = this.actor.toObject(false);
        data.items.sort((a, b) => (a.sort || 0) - (b.sort || 0));
        data.config = ageSystem;

        // Order itens into alphabetic order
        const itemSorted = sortObjArrayByName(data.items, "name");

        data.class = itemSorted.filter(i => i.type === "class");
        data.classManagedLevel = data.class.some(item => Number(item.system?.level) > 0 || Number(item.system?.progression?.legacyLevel) > 0)
            || (data.system?.classProgression?.transactions ?? []).length > 0;
        data.weapon = itemSorted.filter(i => i.type === "weapon");
        data.talent = itemSorted.filter(i => i.type === "talent");
        data.power = itemSorted.filter(i => i.type === "power");
        data.focus = itemSorted.filter(i => i.type === "focus");
        data.stunts = itemSorted.filter(i => i.type === "stunts");
        // Order Stunts by stunt points, lowest to highest
        data.stunts = data.stunts.sort((a, b) => a.system.stuntPoints - b.system.stuntPoints);
        data.equipment = itemSorted.filter(i => i.type === "equipment");
        data.honorifics = itemSorted.filter(i => i.type === "honorifics");
        data.relationship = itemSorted.filter(i => i.type === "relationship");
        data.membership = itemSorted.filter(i => i.type === "membership");
        // Groups of Fav Item
        data.favWeapon = data.weapon.filter(i => i.system.favorite);
        data.favPower = data.power.filter(i => i.system.favorite);
        data.favEquip = data.equipment.filter(i => i.system.favorite);
        data.favStunt = data.stunts.filter(i => i.system.favorite);
        data.favTalent = data.talent.filter(i => i.system.favorite);
        data.favRelation = data.relationship.filter(i => i.system.favorite);
        data.favHonor = data.honorifics.filter(i => i.system.favorite);
        data.favMembership = data.membership.filter(i => i.system.favorite);

        // Sort Conditions alphabetically
        data.conditions = statusEffectArray(CONFIG.statusEffects).filter(e => e.flags?.["age-system"]?.isCondition);
        for (let i = 0; i < data.conditions.length; i++) {
            if (ageSystem.inUseStatusEffects !== 'custom') {
                data.conditions[i].name = game.i18n.localize(data.conditions[i].name);
                if (data.conditions[i].flags?.["age-system"]?.desc) data.conditions[i].flags["age-system"].desc = game.i18n.localize(data.conditions[i].flags["age-system"].desc);
            }
            const cond = data.conditions[i];
            const hasCondition = data.effects.filter(c => c.statuses.includes(cond.id));
            if (hasCondition.length > 0) data.conditions[i].active = true;
        }
        data.conditions = sortObjArrayByName(data.conditions, "name");

        // Filtering non condition Active Effects
        const statusIds = statusEffectArray(CONFIG.statusEffects).reduce((arr, e) => {
            if (e.id) arr.push(e.id)
            return arr
        }, []);

        data.effects = data.effects.filter(e => !statusIds.includes(e.statuses[0])) // TO DO - confirm if this Active Effect will always have a Array with 1 element.
        data.effects = sortObjArrayByName(data.effects, `name`);    
    
        // Retrieve Prefession/Ancestry settings
        data.ancestry = game.settings.get("age-system", "ancestryOpt");
        data.occupation = game.settings.get("age-system", "occupation");

        // Retrieve Health Mode (Health/Fortune)
        data.healthMode = game.settings.get("age-system", "healthMode");

        // Options Tab Preparation
        // Weapon Groups
        data.weaponGroups = ageSystem.weaponGroups;

        // Return template data
        return {
            actor: this.object,
            cssClass: isEditable ? "editable" : "locked",
            data: data,
            system: data.system,
            effects: data.effects,
            items: data.items,
            limited: this.object.limited,
            options: this.options,
            owner: isOwner,
            editable: isEditable,
            title: this.title,
            isGM: game.user.isGM,
            conditions: data.condEffects,
            inUseStatusEffects: ageSystem.inUseStatusEffects,
            classManagedLevel: data.classManagedLevel,
            colorScheme: colorSchemeClass()
        };
    };

    _getHeaderButtons() {
        let buttons = super._getHeaderButtons();

        const sheet = this.actor.getFlag('core', 'sheetClass');
        const isFull = !sheet || sheet === 'age-system.ageSystemSheetCharacter';

        buttons = [
            {
              label: isFull ? game.i18n.localize("age-system.sheetBlock") : game.i18n.localize("age-system.sheetFull"),
              class: "configure-sheet-inuse",
              icon: "far fa-id-badge",
              onclick: ev => this._onToggleSheet(ev)
            }
        ].concat(buttons);

        return buttons;
    }

    async _onToggleSheet(event) {
        event.preventDefault()
        const fullSheet = 'age-system.ageSystemSheetCharacter';
        const blockSheet = 'age-system.ageSystemSheetCharStatBlock';
        const current = this.actor.getFlag('core', 'sheetClass') ?? fullSheet;
        const newSheet = current === blockSheet ? fullSheet : blockSheet;
        return this.actor.openSheet(newSheet);
    }
    
    activateListeners(html) {
        // Add class to TinyMCE
        const editor = html.find(".persona .resource .editor");
        for (let i = 0; i < editor.length; i++) {editor[i].classList.add('values')}
        
        // Add colorset class to entity-link inside TinyMCE editor
        const entityLink = html.find("a.entity-link");
        for (let i = 0; i < entityLink.length; i++) {entityLink[i].classList.add('colorset-second-tier')}
        
        html.find(".tooltip-container").hover(this._onTooltipHover.bind(this));
        // Normalize text only when the stored value actually differs.
        void normalizeFreeTextFields(html, this.actor);
        if (this.isEditable) {
            new foundry.applications.ux.ContextMenu.implementation(html[0] ?? html, ".main-data", this.itemContextMenu, {jQuery: false});
            html.find(".item-edit").click(this._onItemEdit.bind(this));
            html.find(".item-delete").click(this._onItemDelete.bind(this));
            html.find(".last-up").change(this._onLastUpSelect.bind(this));
            html.find(".effect-edit").click(this._onChangeEffect.bind(this));
            html.find(".effect-remove").click(this._onRemoveEffect.bind(this));   
            html.find("p.effect-add").click(this._onAddEffect.bind(this));
            html.find("a.change-qtd").click(this._onChangeQuantity.bind(this));
            html.find(".degree .change-injury").click(this._onChangeInjury.bind(this));
            html.find(".mark .change-injury").click(this._onChangeMark.bind(this));
            html.find(".refresh-injury-marks").click(this._onRefreshMarks.bind(this));
            html.find(".heal-all-injuries").click(this._onFullHeal.bind(this));
            html.find(".roll-breather").click(this._onRollBreather.bind(this));
            html.find("span.effect-add").click(this._onAddEffect.bind(this));

            // Listeners to be used to make the adjustment on Health/Defense/Toughness for different Game Modes
            html.find(".game-mode-details").change(this._onAdjustHealth.bind(this));
            html.find(".game-mode .override").click(this._onLockGameMode.bind(this));

            // Enable field to be focused when selecting it
            const inputs = html.find("input");
            inputs.focus(ev => ev.currentTarget.select());
        };
        
        // Actions by sheet owner and observers (when optional settings is on)
        if (this.actor.isOwner || this.observerRoll) {
            html.find(".roll-ability")
                .click(this._onRollAbility.bind(this))
                .contextmenu(this._onRollAbility.bind(this));
            html.find(".roll-item")
                .click(this._onRollItem.bind(this))
                .contextmenu(this._onRollItem.bind(this));
            html.find(".roll-damage")
                .click(this._onRollDamage.bind(this))
                .contextmenu(this._onRollDamage.bind(this));
            html.find(".roll-resources")
                .click(this._onRollResources.bind(this))
                .contextmenu(this._onRollResources.bind(this));
            html.find(".effect-active").click(this._onActiveEffect.bind(this));
            html.find(".roll-toughness").click(this._onRollToughness.bind(this));
            
            let handler = ev => this._onDragStart(ev);
            
            // Set HMTL elements with class item-box as draggable elements.
            let items = html.find(".drag-to-macro");
            for (let i = 0; i < items.length; i++) {
                const el = items[i];
                el.draggable = true;
                el.addEventListener("dragstart", handler, false);
            }
        };

        if (this.actor.isOwner) {
            new foundry.applications.ux.ContextMenu.implementation(html[0] ?? html, ".focus-options", this.focusContextMenu, {jQuery: false});
            new foundry.applications.ux.ContextMenu.implementation(html[0] ?? html, ".item-card .main-data img", this.itemContextMenu, {jQuery: false});
            html.find(".item-equip").click(this._onItemActivate.bind(this));
            html.find(".item-card .main-data").click(this._onItemEdit.bind(this));
            html.find(".defend-maneuver").change(this._onDefendSelect.bind(this));
            html.find(".guardup-maneuver").change(this._onGuardUpSelect.bind(this));
            html.find(".conditions .item-name").click(this._onChangeCondition.bind(this));
            html.find(".mod-active.icon").click(this._onToggleItemMod.bind(this));
            html.find(".trait-item").click(this._onTraitGroupToggle.bind(this));
        }

        super.activateListeners(html);
        activatePersistentSheetPosition(this);
        const primaryTabs = this._tabs?.find?.(tab => tab._nav?.matches?.(".add-sheet-tabs")) ?? this._tabs?.[0];
        if (primaryTabs?.activate && this._ageActivePrimaryTab) primaryTabs.activate(this._ageActivePrimaryTab, {triggerCallback: false});
        html.find(".add-sheet-tabs [data-tab]").click(event => {
            this._ageActivePrimaryTab = event.currentTarget.dataset.tab || this._ageActivePrimaryTab;
        });
    };

    async close(options = {}) {
        clearTimeout(this._agePositionSaveTimer);
        await savePersistentSheetPosition(this);
        return super.close(options);
    }

    _onAdjustHealth(ev) {
        const actorData = this.actor.system;
        const detail = ev.currentTarget.dataset.detail;
        const actorMode = actorData.gameMode;
        const mode = actorMode.selected;
        const value = Number(ev.currentTarget.value);
        return this.actor.update(characterGameModeProfileUpdate(mode, detail, value));
    }

    _onLockGameMode(ev) {
        const actorData = this.actor.system;
        const updateData = {};
        const override = actorData.gameMode.override;
        updateData["system.gameMode.override"] = !override;
        return this.actor.update(updateData);
    }

    _onDropItemCreate(itemData) {
        itemData = newItemData(this.actor, itemData);
        if (!itemData.length) return false
        return super._onDropItemCreate(itemData);
    }

    _onRollBreather(ev) {
        return this.actor.breather(false)
    }

    _onRollToughness(ev) {
        const actorData = this.actor.system;
        const event = {type: "contextmenu"};
        const rollData = {
            actor: this.actor,
            event,
            moreParts: [{
                label: game.i18n.localize("age-system.toughness"),
                value: actorData.armor.toughness.total
            }],
            rollType: ageSystem.ROLL_TYPE.TOUGHNESS
        }
        return Dice.ageRollCheck(rollData);
    }

    _onFullHeal() {
        const updateData = {
            "system.injury.degrees.light": 0,
            "system.injury.degrees.serious": 0,
            "system.injury.degrees.severe": 0,
            "system.injury.marks": 0,
        }
        return this.actor.update(updateData);
    }

    _onRefreshMarks(event) {
        return this.actor.refreshMarks();
    }

    _onChangeMark(event) {
        return this.actor.healMarks(1);
    }

    _onChangeInjury(event) {
        event.preventDefault();
        const data = this.actor.system;
        const e = event.currentTarget;
        const classList = e.classList;
        const supEl = event.currentTarget.closest('.arrow-control');
        const supClassList = supEl.classList;
        let parameter;
        let marks;
        if(supClassList.contains('light')) {parameter = "light"; marks = 1}
        if(supClassList.contains('serious')) {parameter = "serious"; marks = 1}
        if(supClassList.contains('severe')) {parameter = "severe"; marks = data.injury.degrees.severeMult}
        if (!parameter) return false;

        const qtd = data.injury.degrees[parameter]
        const updatePath = `system.injury.degrees.${parameter}`;

        if (classList.contains("add")) {
            return this.actor.update({
                [updatePath]: qtd+1,
                "system.injury.marks": data.injury.marks + marks
            });
        }
        if (classList.contains("remove") && qtd > 0) {
            marks = Math.min(Math.max(Number(data.injury.marks), 0), marks);
            return this.actor.update({
                [updatePath]: qtd-1,
                "system.injury.marks": Math.max(0, data.injury.marks - marks)
            });
        } 
    };

    _onTraitGroupToggle(event) {
        event.preventDefault();
        const doc = this.actor;
        const docData = doc.system;
        const dataset = event.currentTarget.closest(".feature-controls").dataset
        const traitId = dataset.traitId.trim();
        const traitType = dataset.traitType;
        const tGroups = foundry.utils.deepClone(docData[traitType] ?? []);
        const hasGroup = tGroups.includes(traitId);
        if (hasGroup) {
            const pos = tGroups.indexOf(traitId);
            tGroups.splice(pos, 1);
        } else {
            tGroups.push(traitId);
        }
        const path = `system.${traitType}`;
        return doc.update({[path]: tGroups});
    }

    _onChangeQuantity(event) {
        event.preventDefault();
        const e = event.currentTarget;
        const action = e.dataset.action;
        const classList = e.classList;
        const itemId = e.closest(".feature-controls").dataset.itemId;
        const item = this.actor.items.get(itemId);
        const itemType = item.type;
        if (itemType === "class") return item._levelChange(action);
        let qtd;
        let updatePath;
        switch (itemType) {
            case 'relationship':
                qtd = item.system.intensity;
                updatePath = 'system.intensity';
                break;
            default:
                qtd = item.system.quantity;
                updatePath = 'system.quantity';
                break;
        }

        let newQtd
        switch (action) {
            case "add":
                newQtd = qtd + 1;
                break;
            case "remove":
                if (qtd == 0) return null;
                newQtd = qtd - 1;
                break;
            default:
                return null;
        };

        return item.update({[updatePath]: newQtd});
    }

    _onToggleItemMod(event) {
        const data = event.currentTarget.dataset;
        const itemId = data.itemId;
        const key = data.key;
        const item = this.actor.items.get(itemId);
        const update = toggleItemModifierUpdate(item, key);
        return update ? item.update(update) : false;
    }

    _onChangeCondition(event) {
        // const isChecked = null;
        const condId = event.currentTarget.closest(".feature-controls").dataset.conditionId;
        return this.actor.handleConditions(condId);
    }

    _onTooltipHover(event){
        const tipCont = event.currentTarget.querySelector(".container-tooltip-text");
        if (!tipCont) return
        const windowSize = {
            x: event.view.innerWidth,
            y: event.view.innerHeight
        };
        let xPos = event.clientX;
        let yPos = event.clientY;
        tipCont.style.top = `${yPos - tipCont.clientHeight - 5}px`;

        const xMargin = windowSize.x - (xPos + tipCont.clientWidth);
        if (xMargin < 0) xPos += xMargin;
        tipCont.style.left = `${xPos}px`;
    };

    async _onAddEffect(event) {
        const newEffect = {
            name: game.i18n.localize("age-system.item.newItem"),
            origin: this.actor.uuid,
            img: `icons/svg/aura.svg`,
            disabled: true,
            duration: {rounds: 1}
        };
        const e = await this.actor.createEmbeddedDocuments("ActiveEffect", [newEffect]);
        return e[0].sheet.render(true);
    }

    _onActiveEffect(event){
        const effectId = event.currentTarget.closest(".feature-controls").dataset.effectId;
        const effect = this.actor.effects.get(effectId);
        const isDisabled = effect.disabled;
        return effect.update({"disabled": !isDisabled})
    }

    _onChangeEffect(event){
        const effectId = event.currentTarget.closest(".feature-controls").dataset.effectId;
        const effect = this.actor.effects.get(effectId);
        effect.sheet.render(true);
    }

    _onRemoveEffect(event){
        const effectId = event.currentTarget.closest(".feature-controls").dataset.effectId;
        const effect = this.actor.effects.get(effectId);
        return effect.delete();
    }

    _onItemActivate(event) {
        const itemId = event.currentTarget.closest(".feature-controls").dataset.itemId;
        const itemToToggle = this.actor.getEmbeddedDocument("Item", itemId);
        const itemType = itemToToggle.type;
        const itemData = itemToToggle.system;
        if (event.currentTarget.classList.contains('favorite')) {
            const toggleFav = !itemData.favorite;
            return itemToToggle.update({"system.favorite": toggleFav});
        }
        if (itemType === "power" || itemType === "talent") {
            const toggleAct = !itemData.activate;
            return itemToToggle.update({"system.activate": toggleAct});
        } else {
            const toggleEqp = !itemData.equiped;
            return itemToToggle.update({"system.equiped": toggleEqp});
        };
    };

    _onRollResources(event) {
        const rollData = {
            event: event,
            actor: this.actor,
            rollType: ageSystem.ROLL_TYPE.RESOURCES
        };
        return Dice.ageRollCheck(rollData);
    };

    _onLastUpSelect(ev) {
        const actorData = this.actor.system;
        const abl = ev.currentTarget.closest(".feature-controls").dataset.ablId;
        let actorAbls = {
            system: {
                abilities: {}
            }
        };
        for (const ablKey in actorData.abilities) {
            if (Object.hasOwnProperty.call(actorData.abilities, ablKey)) {
                actorAbls.system.abilities[ablKey] = {"lastUp": false};                
            };
        };
        actorAbls.system.abilities[abl].lastUp = true;
        return this.actor.update(actorAbls);
    };

    _onDefendSelect(event) {
        const actorData = this.actor.system;
        const guardupStatus = event.currentTarget.closest(".feature-controls").dataset.guardupActive;
        const defendStatus = actorData.defend.active;
        if (guardupStatus && !defendStatus) {
            return this.actor.update({"system.guardUp.active": false});
        };
    };

    _onGuardUpSelect(event) {
        const actorData = this.actor.system;
        const defendStatus = event.currentTarget.closest(".feature-controls").dataset.defendActive;
        const guardupStatus = actorData.guardUp.active;
        if (!guardupStatus && defendStatus) {
            return this.actor.update({"system.defend.active": false});
        };
    };

    _onRollAbility(event) {
        const rollData = {
            event: event,
            actor: this.actor,
            abl: event.currentTarget.closest(".feature-controls").dataset.ablId,
            rollType: ageSystem.ROLL_TYPE.ABILITY
        }
        return Dice.ageRollCheck(rollData);
    };

    _onRollItem(event) {
        event.preventDefault();
        const itemId = event.currentTarget.closest(".feature-controls").dataset.itemId;
        const rollType = event.currentTarget.closest(".feature-controls").dataset.rollType
        const itemRolled = this.actor.items.get(itemId);
        if (itemRolled.type === "focus" && event.button !== 0) return
        return itemRolled.roll(event, rollType);
    };

    _onItemShow(event) {
        event.preventDefault();
        if (event.detail != 1) return
        const itemId = event.currentTarget.closest(".feature-controls").dataset.itemId;
        const item = this.actor.items.get(itemId);
        return item.showItem(event.shiftKey);
    };

    _onItemEdit(event) {
        event.preventDefault();
        let e = event.currentTarget;
        let itemId = e.dataset.itemId ?? e.closest(".feature-controls").dataset.itemId;
        const item = this.actor.items.get(itemId);
        return item.sheet.render(true); /** This line of code can return when I discover why Owned Items are not always opening the correct Item Sheet */
        // return item.openSheet('age-system.ageSystemSheetItem');
    };

    _onItemDelete(event) {
        event.preventDefault();
        let e = event.currentTarget;
        let itemId = e.closest(".feature-controls").dataset.itemId;
        const item = this.actor.items.get(itemId);
        return item.delete();
    };

    _onRollDamage(event) {
        event.preventDefault();
        const e = event.currentTarget;
        const itemId = e.closest(".feature-controls").dataset.itemId;
        const item = this.actor.items.get(itemId);
        const damageData = {event: event};
        return item.rollDamage(damageData);
    };

    focusContextMenu = [
        {
            label: game.i18n.localize("age-system.ageRollOptions"),
            icon: '<i class="fas fa-dice"></i>',
            onClick: (event, target) => {
                const focus = this._selectItemFromHTML(target);
                if (!focus) return false;
                const ev = {type: "click", altKey: true};
                return focus.roll(ev);
            }
        },
        {
            label: game.i18n.localize("age-system.chatCard.roll"),
            icon: '<i class="far fa-eye"></i>',
            onClick: (event, target) => this._selectItemFromHTML(target)?.showItem(Boolean(event?.shiftKey))
        },
        {
            label: game.i18n.localize("age-system.settings.changeRollContext"),
            icon: '<i class="fas fa-exchange-alt"></i>',
            onClick: (event, target) => {
                const focus = this._selectItemFromHTML(target);
                if (!focus) return false;
                const ev = {type: "click"};
                return Dice.ageRollCheck({event: ev, itemRolled: focus, actor: this.actor, selectAbl: true, rollType: ageSystem.ROLL_TYPE.FOCUS});
            }
        },
        {
            label: game.i18n.localize("age-system.settings.edit"),
            icon: '<i class="fas fa-edit"></i>',
            onClick: (event, target) => this._selectItemFromHTML(target)?.sheet?.render(true)
        },
        {
            label: game.i18n.localize("age-system.settings.delete"),
            icon: '<i class="fas fa-trash"></i>',
            onClick: (event, target) => this._selectItemFromHTML(target)?.delete()
        }
    ];

    itemContextMenu = [
        {
            label: game.i18n.localize("age-system.showOnChat"),
            icon: '<i class="far fa-eye"></i>',
            onClick: (event, target) => this._selectItemFromHTML(target)?.showItem(Boolean(event?.shiftKey))
        },
        {
            label: game.i18n.localize("age-system.settings.edit"),
            icon: '<i class="fas fa-edit"></i>',
            onClick: (event, target) => this._selectItemFromHTML(target)?.sheet?.render(true)
        },
        {
            label: game.i18n.localize("age-system.settings.delete"),
            icon: '<i class="fas fa-trash"></i>',
            onClick: (event, target) => this._selectItemFromHTML(target)?.delete()
        }
    ];

    _selectItemFromHTML(html, {selector="itemId", maxIterations=5}={}) {
        let el = html?.currentTarget ?? (html?.length ? html[0] : html);
        let id;
        for (let i = 0; i < maxIterations && el; i++) {
            if (el.dataset?.[selector]) {
                id = el.dataset[selector];
                break;
            }
            el = el.parentElement;
        }
        return id ? this.actor.items.get(id) : null;
    }

}
