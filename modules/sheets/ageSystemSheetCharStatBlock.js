import ageSystemSheetCharacter from "./ageSystemSheetCharacter.js";
import {colorSchemeClass} from "../color-scheme.js";
import {configurePersistentSheetPosition} from "./sheet-position.js";

export default class ageSystemSheetCharStatBlock extends ageSystemSheetCharacter {
    
    constructor(...args) {
        super(...args);
        configurePersistentSheetPosition(this, {
            key: "character-block",
            defaultWidth: 540,
            defaultHeight: 740,
            minWidth: 420,
            minHeight: 500,
            maxWidth: 780,
            maxHeight: 1000,
            rejectOversize: true
        });
    }

    static get defaultOptions() {
        const options = foundry.utils.mergeObject(super.defaultOptions, {
            popOut: true,
            resizable: true,
            minimizable: true,
            width: 540,
            height: 740,
            classes: ["age-system", "sheet", "char", "stat-block", colorSchemeClass()]
        });
        // The compact template deliberately has no tab navigation. Leaving the
        // Full sheet's inherited Tabs configuration active makes Foundry v14
        // call Tabs.activateListeners against a missing element while an Actor
        // is being created or its embedded Items are prepared.
        options.tabs = [];
        return options;
    }

    get template() {
        return `systems/age-system/templates/sheets/char-block/char-stat-block.hbs`;
    }

    _getHeaderButtons() {
        const buttons = super._getHeaderButtons();
        buttons.unshift({
            label: "",
            class: "age-minimize-sheet",
            icon: "fas fa-window-minimize",
            onclick: event => {
                event.preventDefault();
                event.stopPropagation();
                return this.minimize();
            }
        });
        return buttons;
    }

    /* -------------------------------------------- */
    /** @inheritdoc */
    async getData(options) {
        const data = await super.getData(options);
        data.isBlock = true; // This is used to identify if the sheet is a Stat Block
        return data
    };
    
    activateListeners(html) {
        html.find("a.editor-edit").hide();
        super.activateListeners(html);
    };
}
