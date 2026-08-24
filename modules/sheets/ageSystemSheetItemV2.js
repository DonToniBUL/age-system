import {flattenAppV2DocumentUpdate, omitBlankNumericFields} from "./v2-form.js";
import {prepareItemV2Context} from "./v2-context.js";
import {itemAdvancementContextMenu, runItemSheetAction} from "./v2-actions.js";
import {applyColorSchemeToElement} from "../color-scheme.js";
import {prepSheet} from "../setup.js";
import {
    itemCanonicalEditPaths,
    preserveItemCanonicalSubmitData
} from "./legacy-item-form.js";

const {HandlebarsApplicationMixin} = foundry.applications.api;
const {ItemSheetV2} = foundry.applications.sheets;
const {Tabs} = foundry.applications.ux;

function bindAll(root, selector, eventName, handler) {
    for (const element of root.querySelectorAll(selector)) element.addEventListener(eventName, handler);
}

class AgeSystemItemSheetV2Base extends HandlebarsApplicationMixin(ItemSheetV2) {
    static DEFAULT_OPTIONS = {
        classes: ["age-system", "sheet", "item", "age-v5-parity-sheet"],
        position: {width: 805, height: 500},
        window: {resizable: true},
        form: {closeOnSubmit: false, submitOnChange: true}
    };

    constructor(options = {}) {
        super(options);
        this._ageActivePrimaryTab = "main";
    }

    get object() {
        return this.document;
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        return Object.assign(context, await prepareItemV2Context(this));
    }

    _processFormData(event, form, formData) {
        return omitBlankNumericFields(super._processFormData(event, form, formData), form);
    }

    _prepareSubmitData(event, form, formData, updateData) {
        const submitData = this._processFormData(event, form, formData);
        if (updateData) {
            foundry.utils.mergeObject(submitData, updateData, {applyOperators: true});
            foundry.utils.mergeObject(submitData, updateData, {applyOperators: false});
        }
        preserveItemCanonicalSubmitData(
            this.item,
            submitData,
            itemCanonicalEditPaths(this.item, event?.target, updateData)
        );
        this.document.validate({changes: submitData, clean: {addTypes: true, copy: false}, fallback: false});
        return submitData;
    }

    async _processSubmitData(event, form, submitData, options = {}) {
        return super._processSubmitData(event, form, flattenAppV2DocumentUpdate(submitData), options);
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        const root = this.element;
        applyColorSchemeToElement(root);
        await prepSheet(this, root, context);
        for (const button of root.querySelectorAll("button:not([type])")) button.type = "button";
        for (const input of root.querySelectorAll("input")) input.addEventListener("focus", event => event.currentTarget.select());
        for (const editor of root.querySelectorAll(".editor")) {
            if (!editor.parentElement?.classList.contains("no-value-class")) editor.classList.add("values");
        }
        this.#bindImageEditing(root);
        this.#bindTabs(root);
        this.#bindItemControls(root);
        // Ammo Belt and other existing AGE companions currently consume the
        // generic V1 hook; keep it available during the AppV2 transition.
        Hooks.callAll("renderItemSheet", this, globalThis.jQuery(root), context);
    }

    #bindTabs(root) {
        if (!root.querySelector(".add-sheet-tabs")) return;
        this._ageTabs = new Tabs({
            navSelector: ".add-sheet-tabs",
            contentSelector: ".sheet-tab-section",
            initial: this._ageActivePrimaryTab,
            callback: (_event, _tabs, active) => { this._ageActivePrimaryTab = active; }
        });
        this._ageTabs.bind(root);
    }

    #bindImageEditing(root) {
        if (!this.isEditable) return;
        bindAll(root, "img[data-edit]", "click", async event => {
            const target = event.currentTarget;
            const attribute = target.dataset.edit;
            const current = foundry.utils.getProperty(this.document, attribute);
            const picker = new foundry.applications.apps.FilePicker({
                current,
                type: "image",
                document: this.document,
                callback: async selected => {
                    target.src = selected;
                    await this.document.update({[attribute]: selected});
                }
            });
            await picker.browse();
        });
    }

    #bindItemControls(root) {
        const call = method => event => runItemSheetAction(this, method, event);
        if (this.isEditable) {
            bindAll(root, "a.add-bonus, .add-modifier", "click", call("_onAddModifier"));
            bindAll(root, ".mod-controls a.remove", "click", call("_onRemoveModifier"));
            bindAll(root, ".mod-controls a.toggle", "click", call("_onToggleModifier"));
            bindAll(root, ".toggle-feature", "click", call("_onToggleFeature"));
            bindAll(root, ".trait-item", "click", call("_onTraitGroupToggle"));
            if (this.item.type === "focus" && this.item.isOwned) {
                bindAll(root, ".item-card-title", "keyup", call("_onOwnedFocusNameChange"));
            }
            if (this.item.type === "class" && !this.item.isOwned) {
                bindAll(root, ".add-adv", "click", call("_onAddAdvance"));
            }
        }
        bindAll(root, ".find-reference", "click", call("_onOpenPDF"));
        if (this.item.type === "class" && this.item.isOwned && this.item.isOwner) {
            bindAll(root, ".class-level-change", "click", event => this.item._levelChange(event.currentTarget.dataset.action));
        }
        if (this.item.type === "class" && !this.item.isOwned && this.item.isOwner) {
            new foundry.applications.ux.ContextMenu.implementation(root, ".advance", this.advContextMenu, {jQuery: false});
        }
    }

    get advContextMenu() {
        return itemAdvancementContextMenu(this);
    }
}

export class ageSystemSheetClassV2 extends AgeSystemItemSheetV2Base {
    static DEFAULT_OPTIONS = {position: {width: 805, height: 700}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/item-class.hbs", scrollable: [""]}};
}

export class ageSystemSheetEquipmentV2 extends AgeSystemItemSheetV2Base {
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/item-equipment.hbs", scrollable: [""]}};
}

export class ageSystemSheetFocusV2 extends AgeSystemItemSheetV2Base {
    static DEFAULT_OPTIONS = {position: {width: 805, height: 352}, window: {resizable: false}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/item-focus.hbs", scrollable: [""]}};
}

export class ageSystemSheetHonorificsV2 extends AgeSystemItemSheetV2Base {
    static DEFAULT_OPTIONS = {position: {width: 805, height: 352}, window: {resizable: false}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/item-honorifics.hbs", scrollable: [""]}};
}

export class ageSystemSheetMembershipV2 extends AgeSystemItemSheetV2Base {
    static DEFAULT_OPTIONS = {position: {width: 805, height: 352}, window: {resizable: false}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/item-membership.hbs", scrollable: [""]}};
}

export class ageSystemSheetPowerV2 extends AgeSystemItemSheetV2Base {
    static DEFAULT_OPTIONS = {position: {width: 805, height: 480}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/item-power.hbs", scrollable: [""]}};
}

export class ageSystemSheetRelationshipV2 extends AgeSystemItemSheetV2Base {
    static DEFAULT_OPTIONS = {position: {width: 805, height: 352}, window: {resizable: false}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/item-relationship.hbs", scrollable: [""]}};
}

export class ageSystemSheetShipFeaturesV2 extends AgeSystemItemSheetV2Base {
    static DEFAULT_OPTIONS = {position: {width: 805, height: 352}, window: {resizable: false}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/item-shipfeatures.hbs", scrollable: [""]}};
}

export class ageSystemSheetStuntsV2 extends AgeSystemItemSheetV2Base {
    static DEFAULT_OPTIONS = {position: {width: 805, height: 352}, window: {resizable: false}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/item-stunts.hbs", scrollable: [""]}};
}

export class ageSystemSheetTalentV2 extends AgeSystemItemSheetV2Base {
    static DEFAULT_OPTIONS = {position: {width: 1000, height: 790}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/item-talent.hbs", scrollable: [""]}};
}

export class ageSystemSheetWeaponV2 extends AgeSystemItemSheetV2Base {
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/item-weapon.hbs", scrollable: [""]}};
}

export default ageSystemSheetWeaponV2;
