import { normalizeActiveEffectChange, normalizeActiveEffectData, statusEffectArray, statusEffectRecord } from "./compat.js";
import { ageSystem } from "./config.js";
import { showFileImportDialog } from "./dialogs.js";

export default class ConditionsWorkshop extends foundry.appv1.api.Application {
  constructor(options = {}) {
    super(options)
    this._inUseConditions = game.settings.get("age-system", "inUseConditions");
    this._customEffects = statusEffectArray(game.settings.get("age-system", "customTokenEffects")).map(e => normalizeActiveEffectData(e, [...ageSystem.actorDerivedDataKey, ...ageSystem.charAblKey]));
    this._inUseEffects = statusEffectArray(CONFIG.statusEffects);

    let hasDead = false;
    for (const k in this._customEffects) {
      if (Object.hasOwnProperty.call(this._customEffects, k)) {
        if (this._customEffects[k].id === `dead`) hasDead = true;
      }
    }
    if (!hasDead) this._customEffects.splice(0, 0, {
      img: `${CONFIG.ageSystem.statusEffectsPath}pirate-grave.svg`,
      id: `dead`,
      name: game.i18n.localize(`EFFECT.StatusDead`),
    });
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ['age-system-dialog', 'age-system'],
      id: 'age-conditions-workshop',
      template: 'systems/age-system/templates/conditions-workshop.hbs',
      resizable: true,
      minimizable: false,
      width: 900,
      height: 'auto',
      title: game.i18n.localize('age-system.conditionsWorkshop'),
    })
  }

  getData() {
    const data = super.getData();
    data.conditions = this._inUseConditions === 'custom' ? this._customEffects : CONFIG.ageSystem.statusEffects[this._inUseConditions];
    data.inUseConditions = this._inUseConditions;
    data.modes = Object.fromEntries(Object.entries(CONFIG.ActiveEffect.changeTypes ?? {}).map(([type, cfg]) => [
      type,
      game.i18n.localize(cfg.label ?? `EFFECT.MODE_${type.toUpperCase()}`)
    ]));

    data.radioB = {
      name: "inUseConditions",
      choices: {
        expanse: "The Expanse",
        custom: game.i18n.localize('age-system.custom')
      },
      options: {
        hash: {
          checked: data.inUseConditions
        }
      }
    }
    return data
  }

  activateListeners(html) {
    super.activateListeners(html)

    if (this._inUseConditions == 'custom') {
      html.find(".effect-control").click(this._onManageChange.bind(this));
      // Update changes on fields
      html.find('.user-entry').change(this._onFieldUpdate.bind(this));
      html.find('img.user-entry').click(ev => this._onEditImage(ev));
      html.find('.delete-effect.active').click(this._onDeleteEffect.bind(this));
      html.find('.add-effect').click(this._onAddEffect.bind(this));
      html.find('.change-order').click(this._onOrderEffect.bind(this));
      html.find('.copy-effects').click(this._onCopyToCustom.bind(this));
      html.find('.export').click(this._onSaveToFile.bind(this));
      html.find('.import').click(this._onReadFromFile.bind(this));
    }
    html.find('.in-use-condition input').change(this._onInUseConditionsSwap.bind(this));
    html.find('.save-close').click(this._onCloseWorkshop.bind(this));
  }

  _onSaveToFile(ev) {
    const fileName = `fvtt-${game.system.id}-custom-effects-${game.world.id}.json`;
    const effects = game.settings.get("age-system", "customTokenEffects");
    foundry.utils.saveDataToFile(JSON.stringify(effects), 'text/json', fileName);
  }

  /**
   * Render an import dialog for updating the data related to this Document through an exported JSON file
   * @returns {Promise<void>}
   */
  async _onReadFromFile() {
    const content = await foundry.applications.handlebars.renderTemplate("templates/apps/import-data.html", {
      hint1: game.i18n.format("DOCUMENT.ImportDataHint1", {document: game.i18n.localize("age-system.customEffectsSet")})
    });
    return showFileImportDialog({
      title: "Import Custom Effects",
      content,
      onImport: json => this.importFromJSON(json),
    });
  }

  /**
   * Read a JSON from a file with Custom Token Effects data, validate and save it.
   * @param {string} json Stringfied JSON object
   */
  importFromJSON(json){
    let effects
    try {
      effects = JSON.parse(json);
      // this._customEffects = effects;
    }
    catch(err) {
      console.log(err.message)
      return ui.notifications.warn(game.i18n.localize("age-system.invalidFileContent"));
    }
    this._customEffects = statusEffectArray(effects).map(e => normalizeActiveEffectData(e, [...ageSystem.actorDerivedDataKey, ...ageSystem.charAblKey]));
    this._refresh();
  }

  _onCopyToCustom(ev) {
    const origin = ev.currentTarget.dataset.origin;
    const newEffects = foundry.utils.deepClone(CONFIG.ageSystem.statusEffects[origin]);
    for (let ef = 0; ef < newEffects.length; ef++) {
      newEffects[ef].name = game.i18n.localize(newEffects[ef].name);
      newEffects[ef].id = newEffects[ef].id === `dead` ? `dead` : ('AGEcustom.' + foundry.utils.randomID(20));
      const newDesc = newEffects[ef].flags?.["age-system"]?.desc;
      const newFlags = {
        "age-system": {
          conditionType: 'custom',
          desc: newDesc ? game.i18n.localize(newDesc) : ""
        }
      };
      if (!newEffects[ef].flags) {
        newEffects[ef].flags = newFlags
      } else {
        foundry.utils.mergeObject(newEffects[ef].flags, newFlags)
      }
    }
    this._customEffects = newEffects;
    this._refresh()
  }

  _onInUseConditionsSwap(ev) {
    this._inUseConditions = ev.currentTarget.value;
    this._refresh();
  }

  async _onCloseWorkshop(ev) {
    const type = this._inUseConditions;
    const effects = this._customEffects.map(e => normalizeActiveEffectData(e, [...ageSystem.actorDerivedDataKey, ...ageSystem.charAblKey]));
    // Check if icons are repeated
    const icons = []
    if (type === 'custom') {
      for (let e = 0; e < effects.length; e++) {
        const icon = effects[e].img;
        if (icons.includes(icon)) return ui.notifications.warn(game.i18n.localize("age-system.WARNING.repetedIconCondition"));
        icons.push(icon);
      }
    }
    await game.settings.set("age-system", "inUseConditions", type);
    await game.settings.set("age-system", "customTokenEffects", effects);
    if (type === 'custom') CONFIG.ageSystem.statusEffects[type] = effects;
    CONFIG.statusEffects = statusEffectRecord(CONFIG.ageSystem.statusEffects[type], [...ageSystem.actorDerivedDataKey, ...ageSystem.charAblKey]);
    this.close();
  }

  _onOrderEffect(ev) {
    const i = Number(ev.currentTarget.closest('.feature-controls').dataset.conditionI);
    const direction = ev.currentTarget.dataset.direction;
    const size = this._customEffects.length;
    const effect = foundry.utils.deepClone(this._customEffects[i]);
    switch (direction) {
      case "up":
        if (i == 0) break;
        this._customEffects.splice(i, 1);
        this._customEffects.splice(i - 1, 0, effect);
        break;
    
      case 'down':
        if (i == size-1) break;
        this._customEffects.splice(i, 1);
        this._customEffects.splice(i + 1, 0, effect);
      default:
        break;
    }
    this._refresh();
  }

  _onAddEffect(ev) {
    const pos = ev.currentTarget.dataset.position;
    const newEffect = {
      img: "icons/svg/aura.svg",
      name: "",
      id: 'AGEcustom.' + foundry.utils.randomID(20),
      changes: [],
      flags: {
        "age-system": {
          desc: "",
          isCondition: false,
          conditionType: 'custom'
        }
      }
    }
    switch (pos) {
      case 'top':
        this._customEffects.splice(0, 0, newEffect);
        break;
    
      case 'bottom':
        this._customEffects.push(newEffect);
        break;

      default:
        break;
    }
    this._refresh();
  }

  _onDeleteEffect(ev) {
    const index = ev.currentTarget.closest('.feature-controls').dataset.conditionI;
    this._customEffects.splice(index, 1);
    this._refresh();
  }

  _onEditImage(event) {
    let path = event.currentTarget.src.toLowerCase();
    let current = path;
    if (path.includes("https://")) current = path.replace(/https:\/\/.*?\//i, '');
    if (path.includes("http://")) current = path.replace(/http:\/\/.*?\//i, '');
    const conditionId = event.currentTarget.closest('.individual-effects').dataset.conditionI;
    const condition = this._customEffects[conditionId];
    const fp = new foundry.applications.apps.FilePicker({
      current,
      type: "image",
      callback: path => {
        event.currentTarget.src = path;
        condition.img = path;
        // this._saveCustomEffects();
      },
      top: this.position.top + 40,
      left: this.position.left + 10
    });
    return fp.browse();
  }

  _onFieldUpdate(ev) {
    const conditionIndex = ev.currentTarget.closest('.individual-effects').dataset.conditionI;
    const part = ev.currentTarget.dataset.field;
    let changeId = ev.currentTarget.closest('.effect-change');
    if (changeId) changeId = changeId.dataset.index;
    const newValue = ev.currentTarget.value;
    const condition = this._customEffects[conditionIndex];
    if (!condition.flags) condition.flags = {};
    if (!condition.flags["age-system"]) condition.flags["age-system"] = {};

    switch (part) {
      case 'name':
        condition.name = newValue;
        break;

      case 'desc':
        condition.flags["age-system"].desc = newValue;
        break;
      
      case 'isCondition':
        condition.flags["age-system"].isCondition = ev.currentTarget.checked;
        break;

      case 'change-key': {
        const finalKeys = [...ageSystem.actorDerivedDataKey, ...ageSystem.charAblKey];
        condition.changes[changeId].key = newValue;
        condition.changes[changeId].phase = finalKeys.includes(newValue) ? "final" : "initial";
        break;
      }
      
      case 'change-mode':
        condition.changes[changeId].type = newValue;
        condition.changes[changeId].priority = CONFIG.ActiveEffect.changeTypes?.[newValue]?.priority ?? 0;
        break;

      case 'change-value':
        condition.changes[changeId].value = newValue;
        break;

      case 'img':
        condition.img = newValue;
        break;
    
      default:
        break;
    }
    this._refresh();
  }

  _onManageChange(ev) {
    const conditionIndex = ev.currentTarget.closest('.individual-effects').dataset.conditionI;
    const changeRow = ev.currentTarget.closest('.effect-change');
    const changeIndex = changeRow?.dataset.index;
    const condition = this._customEffects[conditionIndex];
    const operation = ev.currentTarget.dataset.action;
    switch (operation) {
      case 'add':
        const newEffect = {
          key: "",
          type: "add",
          phase: "initial",
          priority: CONFIG.ActiveEffect.changeTypes?.add?.priority ?? 0,
          value: ""
        };
        if (condition.changes) {
          condition.changes.push(newEffect)
        } else {
          condition.changes = [newEffect]
        }
        break;
    
      case 'delete':
        if (changeIndex !== undefined) condition.changes.splice(Number(changeIndex), 1);

      default:
        break;
    }
    this._refresh();
  };

  _refresh() {
    this.render(false)
  }
}