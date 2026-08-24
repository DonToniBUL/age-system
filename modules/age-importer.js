import {ageSystem} from "./config.js";
import * as Dice from "./dice.js";
import { NpcParser } from "./parsers/npc-parser.js";
import { TalentParser } from "./parsers/talent-parser.js";
import {AgeImporterService} from "./automation/importer-service.js";
import {automationFeatureEnabled} from "./automation/mode.js";

export default class AgeImporter extends foundry.appv1.api.Application {
  constructor(options = {}) {
    super(options)

    this._packList = [];
    this._importingAbilities = game.settings.get("age-system", "abilitySelection");
    
    // NPC Importer data
    this._npcImportingText = ""
    this._npcModeSelected = 'expanse';
    this._npcPreview = null;
    
    // Talent Importer data
    this._talentImportingText = ""
    this._talentModeSelected = 'dage';
    this._talentPreview = null;
    
    // Mode options for NPC import
    this._npcModeOptions = {
      "expanse": "The Expanse",
      "mageL": "Modern AGE (Major NPC)",
      "mageM": "Modern AGE (Minor NPC)",
      "fage": "Fantasy AGE",
      "fage2e": "Fantasy AGE 2e",
      "dage": "Dragon AGE"
    };
    
    // Mode options for Talent import (no NPC distinction needed)
    this._talentModeOptions = {
      "dage": "Dragon AGE",
      "fage": "Fantasy AGE",
      "fage2e": "Fantasy AGE 2e",
      "mage": "Modern AGE",
      "expanse": "The Expanse"
    };
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ['age-system-dialog', 'age-system'],
      id: 'age-importer',
      template: 'systems/age-system/templates/age-importer.hbs',
      resizable: true,
      minimizable: false,
      width: 900,
      height: 900,
      title: game.i18n.localize('age-system.ageImporter')
    })
  }

  getData() {
    const data = super.getData();
    
    // NPC Importer data
    data.npcImportingText = this._npcImportingText;
    data.npcModeSelected = this._npcModeSelected;
    data.npcPreview = this._npcPreview;
    data.npcRadioB = {
      name: "npcModeSelected",
      choices: this._npcModeOptions,
      options: {
        hash: {
          checked: data.npcModeSelected
        }
      }
    };
    
    // Talent Importer data
    data.talentImportingText = this._talentImportingText;
    data.talentModeSelected = this._talentModeSelected;
    data.talentPreview = this._talentPreview;
    data.talentRadioB = {
      name: "talentModeSelected",
      choices: this._talentModeOptions,
      options: {
        hash: {
          checked: data.talentModeSelected
        }
      }
    };
    
    data.importingAbilities = this._importingAbilities;
    data.packList = this._packList;
    data.importerV2 = this._useImporterV2();
    
    return data
  }

  activateListeners(html) {
    super.activateListeners(html)

    // NPC Importer listeners
    html.find(".text-to-import").change(ev => {
      this._npcImportingText = ev.target.value;
      this._npcPreview = null;
      this.updateUI()
    });

    html.find("input[name=npcModeSelected]").change(ev => {
      this._npcModeSelected = ev.target.value;
      this._npcPreview = null;
      this.updateUI();
    });

    html.find(".preview-npc-importing").click(ev => this._runButton(ev, async () => {
      this._npcPreview = await AgeImporterService.preview({
        kind: "npc",
        text: this._npcImportingText,
        mode: this._npcModeSelected
      });
      this.updateUI();
    }));

    html.find(".start-npc-importing").click(async ev => {
      const button = ev.currentTarget;
      button.disabled = true;
      try {
        if (this._useImporterV2()) {
          if (!this._npcPreview) {
            this._npcPreview = await AgeImporterService.preview({kind: "npc", text: this._npcImportingText, mode: this._npcModeSelected});
            ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.reviewImportPreview"));
            return this.updateUI();
          }
          const result = await AgeImporterService.commit(this._npcPreview.id);
          this._npcPreview = result.summary;
          ui.notifications.info(game.i18n.format("age-system.AUTOMATION.importCreated", {count: result.created.length}));
        } else {
          const actor = await new NpcParser(this._npcImportingText, this._npcModeSelected, {packs: this._packList}).ready;
          if (actor) ui.notifications.info(game.i18n.format("age-system.importNpcSuccess", {name: actor.name}));
        }
        this.updateUI();
      } catch (error) {
        console.error("AGE System | NPC import failed.", error);
        ui.notifications.error(game.i18n.format("age-system.importFailed", {reason: error.message}), {permanent: true});
      } finally {
        button.disabled = false;
      }
    });

    // Talent Importer listeners
    html.find(".talent-to-import").change(ev => {
      this._talentImportingText = ev.target.value;
      this._talentPreview = null;
      this.updateUI()
    });

    html.find("input[name=talentModeSelected]").change(ev => {
      this._talentModeSelected = ev.target.value;
      this._talentPreview = null;
      this.updateUI();
    });

    html.find(".preview-talent-importing").click(ev => this._runButton(ev, async () => {
      this._talentPreview = await AgeImporterService.preview({
        kind: "talent",
        text: this._talentImportingText,
        mode: this._talentModeSelected
      });
      this.updateUI();
    }));

    html.find(".start-talent-importing").click(async ev => {
      const button = ev.currentTarget;
      button.disabled = true;
      try {
        if (this._useImporterV2()) {
          if (!this._talentPreview) {
            this._talentPreview = await AgeImporterService.preview({kind: "talent", text: this._talentImportingText, mode: this._talentModeSelected});
            ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.reviewImportPreview"));
            return this.updateUI();
          }
          const result = await AgeImporterService.commit(this._talentPreview.id);
          this._talentPreview = result.summary;
          ui.notifications.info(game.i18n.format("age-system.AUTOMATION.importCreated", {count: result.created.length}));
        } else {
          await new TalentParser(this._talentImportingText, this._talentModeSelected, {packs: this._packList}).ready;
        }
        this.updateUI();
      } catch (error) {
        console.error("AGE System | Talent import failed.", error);
        ui.notifications.error(game.i18n.format("age-system.importFailed", {reason: error.message}), {permanent: true});
      } finally {
        button.disabled = false;
      }
    });

    html.find(".import-match-resolution").change(ev => this._runButton(ev, async () => {
      const control = ev.currentTarget;
      const summary = await AgeImporterService.setMatchResolution(control.dataset.sessionId, {
        entryIndex: control.dataset.entryIndex,
        matchIndex: control.dataset.matchIndex,
        uuid: control.value
      });
      this._setPreview(control.dataset.kind, summary);
      this.updateUI();
    }));

    html.find(".import-match-search-button").click(ev => this._runButton(ev, async () => {
      const button = ev.currentTarget;
      const row = button.closest(".import-match-row");
      const query = row?.querySelector(".import-match-search")?.value ?? "";
      const summary = await AgeImporterService.searchMatch(button.dataset.sessionId, {
        entryIndex: button.dataset.entryIndex,
        matchIndex: button.dataset.matchIndex,
        query
      });
      this._setPreview(button.dataset.kind, summary);
      this.updateUI();
    }));
  }

  updateUI() {
    this.render(false)
  }

  _useImporterV2() {
    return automationFeatureEnabled("importerV2Enabled");
  }

  _setPreview(kind, summary) {
    if (kind === "npc") this._npcPreview = summary;
    else if (kind === "talent") this._talentPreview = summary;
  }

  async _runButton(event, action) {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      return await action();
    } catch (error) {
      console.error("AGE System | Import preview failed.", error);
      ui.notifications.error(game.i18n.format("age-system.importFailed", {reason: error.message}), {permanent: true});
    } finally {
      button.disabled = false;
    }
  }

}

// Export the parser classes for backward compatibility
export { NpcParser, TalentParser };
