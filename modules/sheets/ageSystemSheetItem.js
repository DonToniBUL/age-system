import {ageSystem} from "../config.js";
import { modifiersList, sortObjArrayByName } from "../setup.js";
import { focusList } from "../settings.js";
import { AdvancementAdd } from "../advancement.js";
import { validateClassDefinition } from "../class-advancement.js";
import {colorSchemeClass} from "../color-scheme.js";
import { showConfirmDialog } from "../dialogs.js";
import {normalizeDamageSource} from "../damage-utils.js";
import {removeItemModifierUpdate, toggleItemModifierUpdate} from "../data/item-modifier-updates.js";
import {
    legacyCanonicalFieldsForItem,
    preserveLegacyItemSubmitData
} from "./legacy-item-form.js";

export default class ageSystemItemSheet extends foundry.appv1.sheets.ItemSheet {
    constructor(...args) {
        super(...args);
        this._ageExplicitLegacyItemEdits = new Set();
    
        // Expand the default size of different item sheet
        const itemType = this.object.type;
        switch (itemType) {
            case "focus":
                this.options.height = this.position.height = "352";
                this.options.resizable = false;
                break;
            // case "weapon":
            //     this.options.width = this.position.width = "700";
            //     this.options.height = this.position.height = "460";
            //     break;
            case "talent":
                this.options.width = this.position.width = "1000";
                this.options.height = this.position.height = "790";
                break;          
            case "stunts":
                // this.options.width = this.position.width = "300";
                this.options.height = this.position.height = "352";
                this.options.resizable = false;
                break;        
            case "shipfeatures":
                this.options.height = this.position.height = "352";
                this.options.resizable = false;
                break;             
            case "relationship":
                // this.options.width = this.position.width = "600";
                this.options.height = this.position.height = "352";
                this.options.resizable = false;
                break;
            case "membership":
                // this.options.width = this.position.width = "600";
                this.options.height = this.position.height = "352";
                this.options.resizable = false;
                break;
            case "honorifics":
                // this.options.width = this.position.width = "600";
                this.options.height = this.position.height = "352";
                this.options.resizable = false;
                break;
            case "power":
                // this.options.width = this.position.width = "700";
                this.options.height = this.position.height = "480";
                break; 
            case "class":
                // this.options.width = this.position.width = "770";
                this.options.height = this.position.height = "700";
                break; 
            default:
                break;
        };
    };
   
    static get defaultOptions() {        
        return foundry.utils.mergeObject(super.defaultOptions, {
            height: 500,
            width: 805,
            classes: ["age-system", "sheet", "item", colorSchemeClass()],
            tabs: [{
                navSelector: ".add-sheet-tabs",
                contentSelector: ".sheet-tab-section",
                initial: "main"
            }]
        });
    };

    get template() {
        return `systems/age-system/templates/sheets/${this.item.type}-sheet.hbs`;
    };

    _getSubmitData(updateData = {}) {
        const submitData = super._getSubmitData(updateData);
        const explicitEdits = new Set(this._ageExplicitLegacyItemEdits);
        for (const path of legacyCanonicalFieldsForItem(this.item)) {
            const field = path.slice("system.".length);
            if (Object.prototype.hasOwnProperty.call(updateData ?? {}, path)
                || Object.prototype.hasOwnProperty.call(updateData?.system ?? {}, field)) {
                explicitEdits.add(path);
            }
        }
        return preserveLegacyItemSubmitData(
            this.item,
            submitData,
            explicitEdits
        );
    }

    async _updateObject(event, formData) {
        try {
            return await super._updateObject(event, formData);
        } finally {
            this._ageExplicitLegacyItemEdits.clear();
        }
    }

    getData(options) {
        const data = super.getData(options);
        data.item = data.document;
        data.colorScheme = colorSchemeClass();
        ageSystem.focus = focusList(game.settings.get("age-system", "masterFocusCompendium"));
        data.config = ageSystem;
        
        // Fetch localized name for Item Type
        const i = this.item.type;
        data.localType = game.i18n.localize(`TYPES.Item.${i}`)
        
        // Setting which ability settings will be used
        data.config.wealthMode = game.settings.get("age-system", "wealthType");

        // Spaceship Features
        if (this.item.type === "shipfeatures") {
            data.config.featuresTypeLocal = [];
            for (let f = 0; f < data.config.featuresType.length; f++) {
                const feat = data.config.featuresType[f];
                data.config.featuresTypeLocal.push({
                    key: feat,
                    name: game.i18n.localize(`age-system.spaceship.${feat}`)
                });
            }
            data.config.featuresTypeLocal = sortObjArrayByName(data.config.featuresTypeLocal, "name");
        };

        // Options Tab Preparation
        // Weapon Groups
        data.weaponGroups = ageSystem.weaponGroups;

        // Primary Abilities (if applicable)
        data.usePrimaryAbl = game.settings.get("age-system", "primaryAbl");
        if (this.object.type === 'class' && data.usePrimaryAbl) {
            const selectedAbl = foundry.utils.deepClone(ageSystem.abilities);
            const allAbl = foundry.utils.deepClone(ageSystem.abilitiesTotal);
            const extraAbl = {}
            for (const k in allAbl) {
                if (Object.hasOwnProperty.call(allAbl, k)) {
                    if (!selectedAbl[k]) extraAbl[k] = game.i18n.localize(`age-system.${k}`);
                }
            };
            data.ablOptions = {
                ...selectedAbl,
                ...extraAbl
            };
        }

        // Does it have Options tab?
        data.hasOptionsTab = (['weapon'].includes(this.item.type) && data.weaponGroups);

        // Active Effects if item owner is a Character
        if (this.item.actor?.type === "char") data.actorEffects = this.item.actor.effects;
        
        data.displayIsOrg = !this.item.isOwned;

        // Modifiers Dropdown List
        data.modifiersList = modifiersList()

        // Check if Use Fatigue setting is TRUE
        data.fatigueSet = game.settings.get("age-system", "useFatigue");
        data.system = this.item.system;
        data.effectiveDamageSource = normalizeDamageSource(this.item.system?.dmgSource, ageSystem.healthSys);

        // If it is a Talent, check if it uses expanded talent degrees
        if(this.item.type === "talent") {
            data.expandedDegrees = ageSystem.talentDegrees.inUse.length > 3;
        }
        if (this.item.type === "class") {
            const validation = validateClassDefinition(this.item.system);
            data.classDefinitionEditable = this.isEditable && !this.item.isOwned;
            data.classOwned = this.item.isOwned;
            data.classValidation = validation;
            const transactions = this.item.actor?.system?.classProgression?.transactions ?? [];
            const lastTransaction = transactions.at(-1);
            data.classLevelCanIncrease = this.item.isOwned && Number(this.item.system.level) < ageSystem.maxLevel;
            data.classLevelCanDecrease = this.item.isOwned
                && lastTransaction?.classItemId === this.item.id
                && Number(lastTransaction.level) === Number(this.item.system.level);
            data.classLegacyLevel = Number(this.item.system.progression?.legacyLevel) || 0;
        }
        return data
    };    
    
    activateListeners(html) {
        const root = html?.[0] ?? html;
        root?.addEventListener?.("change", event => {
            const path = event.target?.name;
            if (legacyCanonicalFieldsForItem(this.item).includes(path)) {
                this._ageExplicitLegacyItemEdits.add(path);
            }
        }, {capture: true});
        if (this.isEditable) {
            html.find("a.add-bonus").click(this._onAddModifier.bind(this));
            html.find(".add-modifier").click(this._onAddModifier.bind(this));
            html.find(".mod-controls a.remove").click(this._onRemoveModifier.bind(this));
            html.find(".mod-controls a.toggle").click(this._onToggleModifier.bind(this));
            html.find(".toggle-feature").click(this._onToggleFeature.bind(this));
            html.find(".trait-item").click(this._onTraitGroupToggle.bind(this));
            if (this.item.type === "focus") {
                if (this.item.isOwned) {
                    html.find(".item-card-title").keyup(this._onOwnedFocusNameChange.bind(this));
                };
            };
            if (this.item.type === "class" && !this.item.isOwned) {
                html.find(".add-adv").click(this._onAddAdvance.bind(this));
            }

            // Enable field to be focused when selecting it
            const inputs = html.find("input");
            inputs.focus(ev => ev.currentTarget.select());

        };
        html.find(".find-reference").click(this._onOpenPDF.bind(this));
        if (this.item.type === "class" && this.item.isOwned && this.item.isOwner) {
            html.find(".class-level-change").click(event => this.item._levelChange(event.currentTarget.dataset.action));
        }
        if (this.item.type === "class" && !this.item.isOwned && this.item.isOwner) {
            const root = html[0] ?? html;
            new foundry.applications.ux.ContextMenu.implementation(root, ".advance", this.advContextMenu);
        }

        // Add class to TinyMCE
        const editor = html.find(".editor");
        for (let i = 0; i < editor.length; i++) {
            const el = editor[i].parentElement;
            // Add specific class unless Editor's parent node states otherwise
            if (!el.classList.contains("no-value-class")) editor[i].classList.add('values')
        };

        super.activateListeners(html);
    };



    _onAddAdvance() {
        return new AdvancementAdd(this.document.uuid).render(true);
    }

    get advContextMenu() {
        return [
            {
                label: game.i18n.localize("age-system.settings.edit"),
                icon: '<i class="fas fa-edit"></i>',
                onClick: (event, target) => {
                    const node = target?.closest?.(".advance") ?? target;
                    return this.object._onChangeAdvancement(node?.dataset ?? {}, "edit");
                }
            },
            {
                label: game.i18n.localize("age-system.settings.delete"),
                icon: '<i class="fas fa-trash"></i>',
                onClick: async (event, target) => {
                    const node = target?.closest?.(".advance") ?? target;
                    const confirmed = await showConfirmDialog({
                        title: game.i18n.localize("age-system.CLASS.deleteAdvancementTitle"),
                        content: `<p>${game.i18n.localize("age-system.CLASS.deleteAdvancementConfirm")}</p>`,
                        defaultYes: false,
                    });
                    if (confirmed) return this.object._onChangeAdvancement(node?.dataset ?? {}, "remove");
                }
            }
        ];
    }

    _onOpenPDF(e) {
        const ref = e.currentTarget.closest('.feature-controls').dataset.reference;
        if (ref == "") return false;
        const regex = new RegExp('([0-9]+)|([a-zA-Z]+)','g');
        const splittedArray = ref.match(regex);

        const code = splittedArray[0];
        const page = Number(splittedArray[1]);
        
        if (ui.PDFoundry) {
            ui.PDFoundry.openPDFByCode(code, { page });
        } else {
            ui.notifications.warn('PDFoundry must be installed to use source links.');
        }
    }

    _onToggleFeature(e) {
        const item = this.item;
        const itemData = item.system;
        const feature = e.currentTarget.dataset.feature;
        const value = !itemData[feature];
        const updatePath = "system." + feature;
        const update = {[updatePath]: value};
        if (value && feature === "causeHealing") update["system.causeDamage"] = false
        if (value && feature === "causeDamage") update["system.causeHealing"] = false
        return item.update(update);
    }

    _onAddModifier(e) {
        return this.item._newModifier();
    }

    _onRemoveModifier(e) {
        const i = e.currentTarget.closest(".feature-controls")?.dataset.modIndex;
        if (!i) return false;
        const update = removeItemModifierUpdate(this.item, i);
        return update ? this.item.update(update) : false;
    }

    _onToggleModifier(event) {
        const item = this.item;
        const i = event.currentTarget.closest(".feature-controls").dataset.modIndex;
        const update = toggleItemModifierUpdate(item, i);
        return update ? item.update(update) : false;
    }

    _onTraitGroupToggle(event) {
        event.preventDefault();
        const item = this.item;
        const itemData = item.system;
        const dataset = event.currentTarget.closest(".feature-controls").dataset
        const traitId = dataset.traitId.trim();
        const traitType = dataset.traitType;
        const tGroups = itemData[traitType];
        const hasGroup = tGroups.includes(traitId);
        if (hasGroup) {
            const pos = tGroups.indexOf(traitId);
            tGroups.splice(pos, 1);
        } else {
            tGroups.push(traitId);
        }
        const path = `system.${traitType}`;
        return item.update({[path]: tGroups});
    }
    
    // Adds an * in front of the owned Focus name whenever the user types a name of another owned Focus
    // => Actors are not allowed to have more than 1 Focus with the same name
    // TODO replace this solution with warning message informing about the name exclusivity and prevent item.name to be changed
    _onOwnedFocusNameChange(event) {
        const itemId = this.item.id;
        const owner = this.item.actor;
        const ownedFoci = owner.itemTypes.focus;

        let nameField = event.target;
        const typedEntry = nameField.value;
        const typedLowerCase = typedEntry.toLowerCase();

        for (let i = 0; i < ownedFoci.length; i++) {
            const e = ownedFoci[i];
            const eName = e.system.nameLowerCase;
            const eId = e.id;
            if (eId !== itemId && eName === typedLowerCase) {
                nameField.value = "*" + typedEntry;
            };            
        };
    };

};
