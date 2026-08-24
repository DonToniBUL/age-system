import {dropChar, newItemData, normalizeFreeTextFields} from "./helper.js";
import {
    buildCharacterAppV2AtomicUpdate,
    characterAppV2ControlDelta,
    flattenCharacterAppV2AtomicBranches,
    flattenAppV2DocumentUpdate,
    normalizeCharacterAppV2Submission,
    omitBlankNumericFields,
    retainCharacterAppV2Changes
} from "./v2-form.js";
import {prepareActorV2Context} from "./v2-context.js";
import {runActorSheetAction} from "./v2-actions.js";
import {applyColorSchemeToElement} from "../color-scheme.js";
import {hidePrimaryAblCheckbox, prepSheet} from "../setup.js";
import {characterControlAuthorizedPaths} from "../data/source-guard.js";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;
const {ActorSheetV2} = foundry.applications.sheets;
const {Tabs} = foundry.applications.ux;

function bindAll(root, selector, eventName, handler) {
    for (const element of root.querySelectorAll(selector)) element.addEventListener(eventName, handler);
}

function openDocumentSheet(document) {
    const sheet = document?.sheet;
    if (!sheet) return null;
    return sheet instanceof ApplicationV2 ? sheet.render({force: true}) : sheet.render(true);
}

/**
 * Native AppV2 shell for the complete, accepted 4.5 Actor-sheet feature surface.
 * Context preparation and actions are document-oriented shared services; no
 * AppV1 class is constructed or invoked through its prototype.
 */
class AgeSystemActorSheetV2Base extends HandlebarsApplicationMixin(ActorSheetV2) {
    static DEFAULT_OPTIONS = {
        classes: ["age-system", "sheet", "age-v5-parity-sheet"],
        position: {width: 700, height: 800},
        window: {resizable: true},
        form: {closeOnSubmit: false, submitOnChange: true}
    };

    constructor(options = {}) {
        super(options);
        this._ageActivePrimaryTab = "main";
        this._ageSubmitQueue = Promise.resolve();
        this._ageSubmitDeltas = new WeakMap();
    }

    get object() {
        return this.document;
    }

    get observerRoll() {
        return game.settings.get("age-system", "observerRoll");
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        return Object.assign(context, await prepareActorV2Context(this));
    }

    _processFormData(event, form, formData) {
        let submitData = omitBlankNumericFields(super._processFormData(event, form, formData), form);
        for (const path of Object.keys(foundry.utils.flattenObject(this.actor.overrides ?? {}))) {
            foundry.utils.deleteProperty(submitData, path);
        }
        if (this.actor.type === "char") {
            submitData = retainCharacterAppV2Changes(submitData, this.actor, event?.target);
            normalizeCharacterAppV2Submission(submitData, this.actor, event?.target);
        }
        return submitData;
    }

    _prepareSubmitData(event, form, formData, updateData) {
        if (this.actor.type !== "char") return super._prepareSubmitData(event, form, formData, updateData);
        const delta = this._processFormData(event, form, formData);
        if (updateData) {
            foundry.utils.mergeObject(delta, updateData, {applyOperators: true});
            foundry.utils.mergeObject(delta, updateData, {applyOperators: false});
        }
        const submitData = buildCharacterAppV2AtomicUpdate(delta, this.actor._source);
        this.document.validate({changes: submitData, clean: {addTypes: true, copy: false}, fallback: false});
        this._ageSubmitDeltas.set(submitData, foundry.utils.deepClone(delta));
        return submitData;
    }

    async _processSubmitData(event, form, submitData, options = {}) {
        if (this.actor.type !== "char") {
            return super._processSubmitData(event, form, flattenAppV2DocumentUpdate(submitData), options);
        }
        const delta = this._ageSubmitDeltas.get(submitData) ?? submitData;
        this._ageSubmitDeltas.delete(submitData);
        const submit = () => {
            const atomic = buildCharacterAppV2AtomicUpdate(delta, this.actor._source);
            return super._processSubmitData(
                event,
                form,
                flattenCharacterAppV2AtomicBranches(atomic),
                {
                    ...options,
                    ageSystemCharacterPaths: characterControlAuthorizedPaths(delta)
                }
            );
        };
        const pending = this._ageSubmitQueue.then(submit, submit);
        this._ageSubmitQueue = pending.catch(() => undefined);
        return pending;
    }

    _onChangeForm(formConfig, event) {
        if (this.actor.type !== "char") return super._onChangeForm(formConfig, event);
        void this.#submitCharacterControl(event).catch(error => {
            console.error("AGE System | Character AppV2 control update failed.", error);
            ui.notifications.error(error.message, {console: false});
        });
    }

    async _onRender(context, options) {
        const root = this.element;
        for (const element of root.querySelectorAll(".drag-to-macro, [data-item-id].item-card, .feature-controls[data-item-id], .feature-controls[data-effect-id]")) {
            element.classList.add("draggable");
            element.draggable = true;
        }
        await super._onRender(context, options);
        applyColorSchemeToElement(root);
        await prepSheet(this, root, context);
        for (const button of root.querySelectorAll("button:not([type])")) button.type = "button";
        this.#bindImageEditing(root);
        this.#bindTabs(root);
        this.#bindSharedPresentation(root);

        switch (this.actor.type) {
            case "char": this.#bindCharacter(root); break;
            case "vehicle": this.#bindVehicle(root); break;
            case "spaceship": this.#bindSpaceship(root); break;
            case "organization": this.#bindOrganization(root); break;
        }
        // Preserve the generic V1-era integration hook while modules migrate
        // to renderActorSheetV2 or this sheet's class-specific AppV2 hook.
        Hooks.callAll("renderActorSheet", this, globalThis.jQuery(root), context);
    }

    #bindTabs(root) {
        const nav = root.querySelector(".add-sheet-tabs");
        if (!nav) return;
        this._ageTabs = new Tabs({
            navSelector: ".add-sheet-tabs",
            contentSelector: ".sheet-tab-section",
            initial: this._ageActivePrimaryTab,
            callback: (_event, _tabs, active) => { this._ageActivePrimaryTab = active; }
        });
        this._ageTabs.bind(root);
    }

    #bindSharedPresentation(root) {
        const html = globalThis.jQuery(root);
        for (const input of root.querySelectorAll("input")) {
            input.addEventListener("focus", event => event.currentTarget.select());
        }
        for (const editor of root.querySelectorAll(".editor")) {
            const parent = editor.parentElement;
            if (!parent?.classList.contains("no-value-class")) editor.classList.add("values");
        }
        for (const link of root.querySelectorAll("a.entity-link")) link.classList.add("colorset-second-tier");
        if (this.isEditable && ["char", "vehicle", "spaceship"].includes(this.actor.type)) {
            void normalizeFreeTextFields(html, this.actor);
        }
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

    #bindCharacter(root) {
        const call = method => event => runActorSheetAction(this, method, event);
        hidePrimaryAblCheckbox(globalThis.jQuery(root));
        if (this.isEditable) {
            new foundry.applications.ux.ContextMenu.implementation(root, ".main-data", this.itemContextMenu, {jQuery: false});
            bindAll(root, ".item-edit", "click", event => this._openOwnedItem(event));
            bindAll(root, ".item-delete", "click", call("_onItemDelete"));
            bindAll(root, ".effect-edit", "click", event => this._openEffect(event));
            bindAll(root, ".effect-remove", "click", call("_onRemoveEffect"));
            bindAll(root, "p.effect-add, span.effect-add", "click", event => this._addEffect(event));
            bindAll(root, "a.change-qtd", "click", call("_onChangeQuantity"));
            bindAll(root, ".degree .change-injury", "click", call("_onChangeInjury"));
            bindAll(root, ".mark .change-injury", "click", call("_onChangeMark"));
            bindAll(root, ".refresh-injury-marks", "click", call("_onRefreshMarks"));
            bindAll(root, ".heal-all-injuries", "click", call("_onFullHeal"));
            bindAll(root, ".roll-breather", "click", call("_onRollBreather"));
            bindAll(root, ".game-mode .override", "click", call("_onLockGameMode"));
        }
        bindAll(root, ".tooltip-container", "mouseenter", call("_onTooltipHover"));

        if (this.actor.isOwner || this.observerRoll) {
            for (const eventName of ["click", "contextmenu"]) {
                bindAll(root, ".roll-ability", eventName, call("_onRollAbility"));
                bindAll(root, ".roll-item", eventName, call("_onRollItem"));
                bindAll(root, ".roll-damage", eventName, call("_onRollDamage"));
                bindAll(root, ".roll-resources", eventName, call("_onRollResources"));
            }
            bindAll(root, ".effect-active", "click", call("_onActiveEffect"));
            bindAll(root, ".roll-toughness", "click", call("_onRollToughness"));
        }

        if (this.actor.isOwner) {
            new foundry.applications.ux.ContextMenu.implementation(root, ".focus-options", this.focusContextMenu, {jQuery: false});
            new foundry.applications.ux.ContextMenu.implementation(root, ".item-card .main-data img", this.itemContextMenu, {jQuery: false});
            bindAll(root, ".item-equip", "click", call("_onItemActivate"));
            bindAll(root, ".item-card .main-data", "click", event => this._openOwnedItem(event));
            bindAll(root, ".conditions .item-name", "click", call("_onChangeCondition"));
            bindAll(root, ".mod-active.icon", "click", call("_onToggleItemMod"));
            bindAll(root, ".trait-item", "click", call("_onTraitGroupToggle"));
        }
    }

    async #submitCharacterControl(event) {
        const target = event.target?.name ? event.target : event.currentTarget;
        const delta = characterAppV2ControlDelta(target);
        if (foundry.utils.isEmpty(delta)) return this.actor;
        normalizeCharacterAppV2Submission(delta, this.actor, target);
        const submit = () => {
            const atomic = buildCharacterAppV2AtomicUpdate(delta, this.actor._source);
            this.actor.validate({changes: atomic, clean: {addTypes: true, copy: true}, fallback: false});
            return this.actor.update(
                flattenCharacterAppV2AtomicBranches(atomic),
                {
                    ageSystemCharacterControl: target.name,
                    ageSystemCharacterPaths: characterControlAuthorizedPaths(delta)
                }
            );
        };
        const pending = this._ageSubmitQueue.then(submit, submit);
        this._ageSubmitQueue = pending.catch(() => undefined);
        return pending;
    }

    #bindVehicle(root) {
        const call = method => event => runActorSheetAction(this, method, event);
        for (const element of root.querySelectorAll(".passenger-container")) {
            element.addEventListener("dragenter", event => event.currentTarget.classList.add("dragover"));
            element.addEventListener("dragleave", event => event.currentTarget.classList.remove("dragover"));
        }
        if (this.actor.isOwner || this.observerRoll) {
            for (const eventName of ["click", "contextmenu"]) {
                bindAll(root, ".roll-vehicle-dmg", eventName, call("_onVehicleDamage"));
                bindAll(root, ".roll-maneuver", eventName, call("_onRollManeuver"));
            }
        }
        if (this.actor.isOwner) bindAll(root, ".remove-passenger", "click", call("_onRemovePassenger"));
    }

    #bindSpaceship(root) {
        const call = method => event => runActorSheetAction(this, method, event);
        if (this.isEditable) {
            bindAll(root, ".change-loss", "click", call("_onChangeLoss"));
            bindAll(root, ".feature-controls .toggle", "click", call("_onEquipChange"));
            bindAll(root, ".feature-controls .remove", "click", call("_onRemoveFeature"));
            bindAll(root, ".feature-controls .edit", "click", event => this._openFeature(event));
            bindAll(root, ".roll-hull", "click", call("_onRollDice"));
        }
        for (const element of root.querySelectorAll(".passenger.stats-block")) {
            element.addEventListener("dragenter", event => event.currentTarget.classList.add("dragover"));
            element.addEventListener("dragleave", event => event.currentTarget.classList.remove("dragover"));
        }
        if (this.actor.isOwner || this.observerRoll) {
            for (const eventName of ["click", "contextmenu"]) {
                bindAll(root, ".roll-maneuver", eventName, call("_onRollManeuver"));
                bindAll(root, ".roll-damage.roll", eventName, call("_onRollDice"));
            }
        }
        if (this.actor.isOwner) bindAll(root, ".remove-passenger", "click", call("_onRemovePassenger"));
    }

    #bindOrganization(root) {
        const call = method => event => runActorSheetAction(this, method, event);
        new foundry.applications.ux.ContextMenu.implementation(root, ".focus-options", this.orgFocusContextMenu, {jQuery: false});
        if (this.actor.isOwner || this.observerRoll) {
            for (const eventName of ["click", "contextmenu"]) {
                bindAll(root, ".roll-ability", eventName, call("_onRollAbility"));
                bindAll(root, ".roll-item", eventName, call("_onRollItem"));
                bindAll(root, ".roll-plot", eventName, call("_onRollPlot"));
            }
        }
    }

    async _onDropActor(event, actor) {
        if (!["vehicle", "spaceship"].includes(this.actor.type)) return super._onDropActor(event, actor);
        return await dropChar(event, this.actor) ? actor : null;
    }

    async _onDropItem(event, item) {
        if (!this.actor.isOwner) return null;
        if (this.actor.uuid === item.parent?.uuid) return super._onDropItem(event, item);
        const keepId = !this.actor.items.has(item.id);
        const source = item.inCompendium
            ? game.items.fromCompendium(item, {clearFolder: true, keepId})
            : item.toObject();
        const accepted = newItemData(this.actor, source);
        if (!accepted.length) return null;
        const created = await this.actor.createEmbeddedDocuments("Item", accepted, {keepId});
        return created[0] ?? null;
    }

    _selectItemFromHTML(html, {selector = "itemId", maxIterations = 5} = {}) {
        let element = html?.currentTarget ?? (html?.length ? html[0] : html);
        for (let i = 0; i < maxIterations && element; i++, element = element.parentElement) {
            const id = element.dataset?.[selector];
            if (id) return this.actor.items.get(id);
        }
        return null;
    }

    _focusFromContextTarget(target) {
        const node = target?.closest?.("[data-item-id]") ?? target;
        return this.actor.items.get(node?.dataset?.itemId);
    }

    _openOwnedItem(event) {
        event.preventDefault();
        return openDocumentSheet(this._selectItemFromHTML(event));
    }

    _openFeature(event) {
        event.preventDefault();
        return openDocumentSheet(this._selectItemFromHTML(event));
    }

    _openEffect(event) {
        event.preventDefault();
        const effectId = event.currentTarget.closest(".feature-controls")?.dataset.effectId;
        return openDocumentSheet(this.actor.effects.get(effectId));
    }

    async _addEffect(event) {
        event.preventDefault();
        const [effect] = await this.actor.createEmbeddedDocuments("ActiveEffect", [{
            name: game.i18n.localize("age-system.item.newItem"),
            origin: this.actor.uuid,
            img: "icons/svg/aura.svg",
            disabled: true,
            duration: {rounds: 1}
        }]);
        return openDocumentSheet(effect);
    }

    get focusContextMenu() {
        return [
            {label: game.i18n.localize("age-system.ageRollOptions"), icon: '<i class="fas fa-dice"></i>', onClick: (_event, target) => this._selectItemFromHTML(target)?.roll({type: "click", altKey: true})},
            {label: game.i18n.localize("age-system.chatCard.roll"), icon: '<i class="far fa-eye"></i>', onClick: (event, target) => this._selectItemFromHTML(target)?.showItem(Boolean(event?.shiftKey))},
            {label: game.i18n.localize("age-system.settings.changeRollContext"), icon: '<i class="fas fa-exchange-alt"></i>', onClick: (_event, target) => {
                const focus = this._selectItemFromHTML(target);
                return focus && game.ageSystem.roll({event: {type: "click"}, itemRolled: focus, actor: this.actor, selectAbl: true, rollType: CONFIG.ageSystem.ROLL_TYPE.FOCUS});
            }},
            {label: game.i18n.localize("age-system.settings.edit"), icon: '<i class="fas fa-edit"></i>', onClick: (_event, target) => openDocumentSheet(this._selectItemFromHTML(target))},
            {label: game.i18n.localize("age-system.settings.delete"), icon: '<i class="fas fa-trash"></i>', onClick: (_event, target) => this._selectItemFromHTML(target)?.delete()}
        ];
    }

    get itemContextMenu() {
        return [
            {label: game.i18n.localize("age-system.showOnChat"), icon: '<i class="far fa-eye"></i>', onClick: (event, target) => this._selectItemFromHTML(target)?.showItem(Boolean(event?.shiftKey))},
            {label: game.i18n.localize("age-system.settings.edit"), icon: '<i class="fas fa-edit"></i>', onClick: (_event, target) => openDocumentSheet(this._selectItemFromHTML(target))},
            {label: game.i18n.localize("age-system.settings.delete"), icon: '<i class="fas fa-trash"></i>', onClick: (_event, target) => this._selectItemFromHTML(target)?.delete()}
        ];
    }

    get orgFocusContextMenu() {
        return [
            {label: game.i18n.localize("age-system.ageRollOptions"), icon: '<i class="fas fa-dice"></i>', onClick: (_event, target) => this._focusFromContextTarget(target)?.roll(new MouseEvent("click", {altKey: true}))},
            {label: game.i18n.localize("age-system.chatCard.roll"), icon: '<i class="far fa-eye"></i>', onClick: (event, target) => this._focusFromContextTarget(target)?.showItem(Boolean(event?.shiftKey))},
            {label: game.i18n.localize("age-system.settings.changeRollContext"), icon: '<i class="fas fa-exchange-alt"></i>', onClick: (_event, target) => {
                const focus = this._focusFromContextTarget(target);
                return focus && game.ageSystem.roll({event: new MouseEvent("click"), itemRolled: focus, actor: this.actor, selectAbl: true, rollType: CONFIG.ageSystem.ROLL_TYPE.FOCUS});
            }},
            {label: game.i18n.localize("age-system.settings.edit"), icon: '<i class="fas fa-edit"></i>', onClick: (_event, target) => openDocumentSheet(this._focusFromContextTarget(target))},
            {label: game.i18n.localize("age-system.settings.delete"), icon: '<i class="fas fa-trash"></i>', onClick: (_event, target) => this._focusFromContextTarget(target)?.delete()}
        ];
    }
}

export class ageSystemSheetCharacterV2 extends AgeSystemActorSheetV2Base {
    static DEFAULT_OPTIONS = {classes: ["char-sheet-alt"], position: {width: 700, height: 875}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/actor-character.hbs", scrollable: [".sheet-main-content"]}};
}

export class ageSystemSheetCharStatBlockV2 extends AgeSystemActorSheetV2Base {
    static DEFAULT_OPTIONS = {classes: ["char", "stat-block"], position: {width: 540, height: 740}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/actor-character-block.hbs", scrollable: [".stat-block-container"]}};

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        context.isBlock = true;
        return context;
    }

}

export class ageSystemSheetVehicleV2 extends AgeSystemActorSheetV2Base {
    static DEFAULT_OPTIONS = {classes: ["vehicle"], position: {width: 680, height: 755}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/actor-vehicle.hbs", scrollable: [""]}};
}

export class ageSystemSheetSpaceshipV2 extends AgeSystemActorSheetV2Base {
    static DEFAULT_OPTIONS = {classes: ["spaceship"], position: {width: 680, height: 750}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/actor-spaceship.hbs", scrollable: [""]}};
}

export class ageSystemSheetOrgV2 extends AgeSystemActorSheetV2Base {
    static DEFAULT_OPTIONS = {classes: ["char", "stat-block"], position: {width: 400, height: 650}};
    static PARTS = {main: {template: "systems/age-system/templates/sheets/v2/parity/actor-organization.hbs", scrollable: [""]}};
}

export default ageSystemSheetCharacterV2;
