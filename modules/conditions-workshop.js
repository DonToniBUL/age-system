import { normalizeActiveEffectChange, normalizeActiveEffectData, statusEffectArray, statusEffectRecord } from "./compat.js";
import { ageSystem } from "./config.js";
import { applyColorSchemeToElement } from "./color-scheme.js";
import { showFileImportDialog } from "./dialogs.js";

const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2
  ?? globalThis.foundry?.appv1?.api?.Application
  ?? class {};
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin
  ?? (Base => Base);

const SYSTEM_ID = "age-system";
const CUSTOM_SET = "custom";
const EXPANSE_SET = "expanse";

function finalEffectKeys() {
  return [...ageSystem.actorDerivedDataKey, ...ageSystem.charAblKey];
}

function localized(value) {
  return value ? game.i18n.localize(value) : "";
}

function changeTypePriority(type) {
  const definition = CONFIG.ActiveEffect.changeTypes?.[type];
  return definition?.priority ?? definition?.defaultPriority ?? 0;
}

/**
 * GM-facing editor for selecting and authoring AGE token conditions.
 *
 * The window intentionally edits an in-memory draft. Only the explicit Save
 * action writes the established inUseConditions and customTokenEffects
 * settings; Cancel and the window close control discard the draft.
 */
export default class ConditionsWorkshop extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "age-conditions-workshop",
    classes: ["age-system", "age-v5-parity-sheet", "age-utility-workflow", "age-conditions-workshop-v2"],
    position: {width: 900, height: 720},
    window: {
      title: "age-system.conditionsWorkshop",
      icon: "fa-solid fa-list-check",
      resizable: true,
      minimizable: true
    },
    actions: {
      addEffect: ConditionsWorkshop._addEffect,
      deleteEffect: ConditionsWorkshop._deleteEffect,
      moveEffect: ConditionsWorkshop._moveEffect,
      pickImage: ConditionsWorkshop._pickImage,
      addChange: ConditionsWorkshop._addChange,
      deleteChange: ConditionsWorkshop._deleteChange,
      copyExpanse: ConditionsWorkshop._copyExpanse,
      exportEffects: ConditionsWorkshop._exportEffects,
      importEffects: ConditionsWorkshop._importEffects,
      save: ConditionsWorkshop._save,
      cancel: ConditionsWorkshop._cancel
    }
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/conditions-workshop.hbs",
      scrollable: [".age-utility-workflow__scroll"]
    }
  };

  constructor(objectOrOptions = {}, options = undefined) {
    // Accept AppV2's (options) and the historical Application (object,
    // options) shape used by a small number of integrations.
    super((options ?? objectOrOptions) || {});
    this._inUseConditions = game.settings.get(SYSTEM_ID, "inUseConditions");
    this._customEffects = statusEffectArray(game.settings.get(SYSTEM_ID, "customTokenEffects"))
      .map(effect => normalizeActiveEffectData(effect, finalEffectKeys()));
    this._inUseEffects = statusEffectArray(CONFIG.statusEffects);
    this._listenerAbort = null;
    this._ensureDeadCondition();
  }

  /** Preserve the boolean render signature used by canvas and chat callers. */
  render(options = {}) {
    if (typeof options === "boolean") options = {force: options};
    return super.render(options ?? {});
  }

  _ensureDeadCondition() {
    if (this._customEffects.some(effect => effect.id === "dead")) return;
    this._customEffects.unshift({
      img: `${CONFIG.ageSystem.statusEffectsPath}pirate-grave.svg`,
      id: "dead",
      name: game.i18n.localize("EFFECT.StatusDead"),
      changes: []
    });
  }

  get canConfigure() {
    if (!game.user?.isGM) return false;
    return typeof game.user.can !== "function" || game.user.can("SETTINGS_MODIFY");
  }

  _requireConfigure() {
    if (this.canConfigure) return true;
    ui.notifications.warn(game.i18n.localize("age-system.WARNING.conditionsGMOnly"));
    return false;
  }

  _buildContext() {
    const customSelected = this._inUseConditions === CUSTOM_SET;
    const source = customSelected
      ? this._customEffects
      : statusEffectArray(CONFIG.ageSystem.statusEffects[this._inUseConditions]);
    const deadCount = source.filter(condition => condition.id === "dead").length;
    const conditions = source.map((condition, index) => {
      const systemFlags = condition.flags?.[SYSTEM_ID] ?? {};
      return {
        ...condition,
        index,
        displayName: customSelected ? (condition.name ?? "") : localized(condition.name),
        description: customSelected ? (systemFlags.desc ?? "") : localized(systemFlags.desc),
        isCondition: Boolean(systemFlags.isCondition),
        isDead: condition.id === "dead",
        canDelete: customSelected && (condition.id !== "dead" || deadCount > 1),
        canMoveUp: customSelected && index > 0,
        canMoveDown: customSelected && index < source.length - 1,
        changes: (condition.changes ?? []).map((change, changeIndex) => ({...change, index: changeIndex}))
      };
    });
    const modes = Object.fromEntries(Object.entries(CONFIG.ActiveEffect.changeTypes ?? {}).map(([type, cfg]) => [
      type,
      game.i18n.localize(cfg.label ?? `EFFECT.MODE_${type.toUpperCase()}`)
    ]));

    return {
      conditions,
      inUseConditions: this._inUseConditions,
      canConfigure: this.canConfigure,
      customSelected,
      expanseSelected: this._inUseConditions === EXPANSE_SET,
      modes,
      radioB: {
        name: "inUseConditions",
        choices: {
          [EXPANSE_SET]: game.i18n.localize("age-system.conditionsExpanse"),
          [CUSTOM_SET]: game.i18n.localize("age-system.custom")
        },
        options: {hash: {checked: this._inUseConditions}}
      }
    };
  }

  /** Kept for integrations which inspected the former Application data. */
  getData() {
    const base = typeof super.getData === "function" ? super.getData() : {};
    return {...base, ...this._buildContext()};
  }

  async _prepareContext(options) {
    const context = typeof super._prepareContext === "function"
      ? await super._prepareContext(options)
      : {};
    return Object.assign(context ?? {}, this._buildContext());
  }

  async _onFirstRender(context, options) {
    if (typeof super._onFirstRender === "function") await super._onFirstRender(context, options);
    this._listenerAbort?.abort();
    this._listenerAbort = new AbortController();
    this.element?.addEventListener?.("change", event => {
      const sourceChoice = event.target?.closest?.("input[name='inUseConditions']");
      if (sourceChoice) {
        this._onInUseConditionsSwap({currentTarget: sourceChoice});
        return;
      }
      const field = event.target?.closest?.(".user-entry[data-field]");
      if (!field || this._inUseConditions !== CUSTOM_SET) return;
      this._onFieldUpdate({currentTarget: field});
    }, {signal: this._listenerAbort.signal});
  }

  async _onRender(context, options) {
    if (typeof super._onRender === "function") await super._onRender(context, options);
    applyColorSchemeToElement(this.element);
    applyColorSchemeToElement(this.element?.querySelector?.(".colorset-selection"));
  }

  async _onClose(options) {
    this._listenerAbort?.abort();
    this._listenerAbort = null;
    if (typeof super._onClose === "function") await super._onClose(options);
  }

  _onSaveToFile(event) {
    event?.preventDefault?.();
    if (!this._requireConfigure()) return false;
    const fileName = `fvtt-${game.system.id}-custom-effects-${game.world.id}.json`;
    // Preserve the historical contract: Export downloads the last saved set.
    const effects = game.settings.get(SYSTEM_ID, "customTokenEffects");
    return foundry.utils.saveDataToFile(JSON.stringify(effects), "text/json", fileName);
  }

  /** Render Foundry's import dialog and load the selected JSON into the draft. */
  async _onReadFromFile(event) {
    event?.preventDefault?.();
    if (!this._requireConfigure()) return false;
    const content = await foundry.applications.handlebars.renderTemplate("templates/apps/import-data.html", {
      hint1: game.i18n.format("DOCUMENT.ImportDataHint1", {document: game.i18n.localize("age-system.customEffectsSet")})
    });
    return showFileImportDialog({
      title: game.i18n.localize("age-system.customEffectsSet"),
      content,
      onImport: json => this.importFromJSON(json)
    });
  }

  /**
   * Read Custom Token Effects JSON, normalize its v14 fields, and keep it as a
   * draft until Save is chosen.
   * @param {string} json Stringified JSON object
   * @returns {boolean}
   */
  importFromJSON(json) {
    if (!this._requireConfigure()) return false;
    let normalized;
    try {
      const effects = JSON.parse(json);
      const entries = statusEffectArray(effects);
      if (!entries.every(effect => effect && typeof effect === "object" && !Array.isArray(effect))) {
        throw new TypeError("Custom effects JSON must contain effect objects.");
      }
      normalized = entries.map(effect => normalizeActiveEffectData(effect, finalEffectKeys()));
    } catch (_error) {
      ui.notifications.warn(game.i18n.localize("age-system.invalidFileContent"));
      return false;
    }
    this._customEffects = normalized;
    this._ensureDeadCondition();
    this._refresh();
    return true;
  }

  _onCopyToCustom(event) {
    event?.preventDefault?.();
    if (!this._requireConfigure()) return false;
    const origin = event?.currentTarget?.dataset?.origin ?? EXPANSE_SET;
    const newEffects = statusEffectArray(CONFIG.ageSystem.statusEffects[origin]);
    for (const effect of newEffects) {
      effect.name = game.i18n.localize(effect.name);
      effect.id = effect.id === "dead" ? "dead" : `AGEcustom.${foundry.utils.randomID(20)}`;
      const description = effect.flags?.[SYSTEM_ID]?.desc;
      const newFlags = {
        [SYSTEM_ID]: {
          conditionType: CUSTOM_SET,
          desc: description ? game.i18n.localize(description) : ""
        }
      };
      if (!effect.flags) effect.flags = newFlags;
      else foundry.utils.mergeObject(effect.flags, newFlags);
    }
    this._customEffects = newEffects.map(effect => normalizeActiveEffectData(effect, finalEffectKeys()));
    this._ensureDeadCondition();
    return this._refresh();
  }

  _onInUseConditionsSwap(event) {
    if (!this._requireConfigure()) return false;
    const value = event?.currentTarget?.value;
    if (![EXPANSE_SET, CUSTOM_SET].includes(value)) return false;
    this._inUseConditions = value;
    return this._refresh();
  }

  async _onCloseWorkshop(event) {
    event?.preventDefault?.();
    if (!this._requireConfigure()) return false;
    const type = this._inUseConditions;
    const effects = this._customEffects.map(effect => normalizeActiveEffectData(effect, finalEffectKeys()));
    if (!this._validateDraft(effects)) return false;

    const previousType = game.settings.get(SYSTEM_ID, "inUseConditions");
    const previousEffects = foundry.utils.deepClone(game.settings.get(SYSTEM_ID, "customTokenEffects"));
    const previousCustomRuntime = foundry.utils.deepClone(CONFIG.ageSystem.statusEffects[CUSTOM_SET]);
    const previousStatusEffects = foundry.utils.deepClone(CONFIG.statusEffects);
    const previousInUse = ageSystem.inUseStatusEffects;
    try {
      await game.settings.set(SYSTEM_ID, "inUseConditions", type);
      await game.settings.set(SYSTEM_ID, "customTokenEffects", effects);
      CONFIG.ageSystem.statusEffects[CUSTOM_SET] = effects;
      ageSystem.inUseStatusEffects = type;
      CONFIG.statusEffects = statusEffectRecord(CONFIG.ageSystem.statusEffects[type], finalEffectKeys());
    } catch (error) {
      const rollbackErrors = [];
      try {
        // Both writes are restored unconditionally. A storage adapter may
        // persist a value and then reject, so a rejected Promise alone cannot
        // prove that its setting remained untouched.
        try {
          await game.settings.set(SYSTEM_ID, "customTokenEffects", previousEffects);
        } catch (failure) {
          rollbackErrors.push(failure);
        }
        try {
          await game.settings.set(SYSTEM_ID, "inUseConditions", previousType);
        } catch (failure) {
          rollbackErrors.push(failure);
        }
      } finally {
        CONFIG.ageSystem.statusEffects[CUSTOM_SET] = previousCustomRuntime;
        CONFIG.statusEffects = previousStatusEffects;
        ageSystem.inUseStatusEffects = previousInUse;
      }
      const reason = error?.message ?? String(error);
      if (rollbackErrors.length) {
        ui.notifications.error(game.i18n.format("age-system.WARNING.conditionRollbackFailed", {reason}), {permanent: true});
        throw new AggregateError([error, ...rollbackErrors], "AGE condition save and rollback both failed.");
      }
      ui.notifications.error(game.i18n.format("age-system.WARNING.conditionSaveFailed", {reason}), {permanent: true});
      return false;
    }
    await this.close();
    return true;
  }

  _validateDraft(effects = this._customEffects) {
    const deadCount = effects.filter(effect => effect.id === "dead").length;
    if (deadCount !== 1) {
      ui.notifications.warn(game.i18n.localize("age-system.WARNING.invalidDeadCondition"));
      return false;
    }
    const ids = new Set();
    const icons = new Set();
    for (const effect of effects) {
      const id = typeof effect.id === "string" ? effect.id.trim() : "";
      if (!id) {
        ui.notifications.warn(game.i18n.localize("age-system.WARNING.invalidConditionId"));
        return false;
      }
      if (ids.has(id)) {
        ui.notifications.warn(game.i18n.localize("age-system.WARNING.duplicateConditionId"));
        return false;
      }
      ids.add(id);
      const icon = typeof effect.img === "string" ? effect.img.trim() : "";
      if (!icon) {
        ui.notifications.warn(game.i18n.localize("age-system.WARNING.missingConditionIcon"));
        return false;
      }
      if (icons.has(icon)) {
        ui.notifications.warn(game.i18n.localize("age-system.WARNING.repetedIconCondition"));
        return false;
      }
      icons.add(icon);
    }
    return true;
  }

  _onOrderEffect(event) {
    event?.preventDefault?.();
    if (!this._requireConfigure() || this._inUseConditions !== CUSTOM_SET) return false;
    const row = event?.currentTarget?.closest?.(".feature-controls");
    const index = Number(row?.dataset?.conditionIndex ?? row?.dataset?.conditionI);
    const direction = event?.currentTarget?.dataset?.direction;
    if (!Number.isInteger(index) || !["up", "down"].includes(direction)) return false;
    const destination = direction === "up" ? index - 1 : index + 1;
    if (destination < 0 || destination >= this._customEffects.length) return false;
    const [effect] = this._customEffects.splice(index, 1);
    this._customEffects.splice(destination, 0, effect);
    return this._refresh();
  }

  _onAddEffect(event) {
    event?.preventDefault?.();
    if (!this._requireConfigure() || this._inUseConditions !== CUSTOM_SET) return false;
    const position = event?.currentTarget?.dataset?.position;
    const newEffect = {
      img: "icons/svg/aura.svg",
      name: "",
      id: `AGEcustom.${foundry.utils.randomID(20)}`,
      changes: [],
      flags: {
        [SYSTEM_ID]: {
          desc: "",
          isCondition: false,
          conditionType: CUSTOM_SET
        }
      }
    };
    if (position === "top") this._customEffects.unshift(newEffect);
    else if (position === "bottom") this._customEffects.push(newEffect);
    else return false;
    return this._refresh();
  }

  _onDeleteEffect(event) {
    event?.preventDefault?.();
    if (!this._requireConfigure() || this._inUseConditions !== CUSTOM_SET) return false;
    const row = event?.currentTarget?.closest?.(".feature-controls");
    const index = Number(row?.dataset?.conditionIndex ?? row?.dataset?.conditionI);
    if (!Number.isInteger(index) || !this._customEffects[index]) return false;
    if (this._customEffects[index].id === "dead"
      && this._customEffects.filter(effect => effect.id === "dead").length <= 1) return false;
    this._customEffects.splice(index, 1);
    return this._refresh();
  }

  async _onEditImage(event) {
    event?.preventDefault?.();
    if (!this._requireConfigure() || this._inUseConditions !== CUSTOM_SET) return false;
    const row = event?.currentTarget?.closest?.(".individual-effects");
    const index = Number(row?.dataset?.conditionIndex ?? row?.dataset?.conditionI);
    const condition = this._customEffects[index];
    if (!condition) return false;
    const picker = new foundry.applications.apps.FilePicker({
      current: condition.img,
      type: "image",
      callback: selected => {
        condition.img = selected;
        this._refresh();
      },
      top: (this.position?.top ?? 0) + 40,
      left: (this.position?.left ?? 0) + 10
    });
    return picker.browse();
  }

  _onFieldUpdate(event) {
    if (!this._requireConfigure() || this._inUseConditions !== CUSTOM_SET) return false;
    const field = event?.currentTarget;
    const row = field?.closest?.(".individual-effects");
    const conditionIndex = Number(row?.dataset?.conditionIndex ?? row?.dataset?.conditionI);
    const condition = this._customEffects[conditionIndex];
    if (!condition) return false;
    const part = field.dataset.field;
    const changeRow = field.closest?.(".effect-change");
    const changeIndex = Number(changeRow?.dataset?.index);
    if (!condition.flags) condition.flags = {};
    if (!condition.flags[SYSTEM_ID]) condition.flags[SYSTEM_ID] = {};

    switch (part) {
      case "name":
        condition.name = field.value;
        break;
      case "desc":
        condition.flags[SYSTEM_ID].desc = field.value;
        break;
      case "isCondition":
        condition.flags[SYSTEM_ID].isCondition = field.checked;
        break;
      case "change-key":
        if (!Number.isInteger(changeIndex) || !condition.changes?.[changeIndex]) return false;
        condition.changes[changeIndex].key = field.value;
        condition.changes[changeIndex].phase = finalEffectKeys().includes(field.value) ? "final" : "initial";
        break;
      case "change-mode":
        if (!Number.isInteger(changeIndex) || !condition.changes?.[changeIndex]) return false;
        condition.changes[changeIndex].type = field.value;
        condition.changes[changeIndex].priority = changeTypePriority(field.value);
        break;
      case "change-value":
        if (!Number.isInteger(changeIndex) || !condition.changes?.[changeIndex]) return false;
        condition.changes[changeIndex].value = field.value;
        break;
      case "img":
        condition.img = field.value;
        break;
      default:
        return false;
    }
    // The control already displays the changed value. Keeping this update
    // render-free preserves focus and guarantees a blur/change immediately
    // before clicking Save cannot replace the pending action target.
    return true;
  }

  _onManageChange(event) {
    event?.preventDefault?.();
    if (!this._requireConfigure() || this._inUseConditions !== CUSTOM_SET) return false;
    const row = event?.currentTarget?.closest?.(".individual-effects");
    const conditionIndex = Number(row?.dataset?.conditionIndex ?? row?.dataset?.conditionI);
    const condition = this._customEffects[conditionIndex];
    if (!condition) return false;
    const operation = event?.currentTarget?.dataset?.operation ?? event?.currentTarget?.dataset?.action;
    if (operation === "add" || operation === "addChange") {
      const change = normalizeActiveEffectChange({
        key: "",
        type: "add",
        phase: "initial",
        priority: changeTypePriority("add"),
        value: ""
      }, finalEffectKeys());
      if (condition.changes) condition.changes.push(change);
      else condition.changes = [change];
    } else if (operation === "delete" || operation === "deleteChange") {
      const changeRow = event?.currentTarget?.closest?.(".effect-change");
      const changeIndex = Number(changeRow?.dataset?.index);
      if (!Number.isInteger(changeIndex) || !condition.changes?.[changeIndex]) return false;
      condition.changes.splice(changeIndex, 1);
    } else return false;
    return this._refresh();
  }

  _refresh() {
    return this.render({force: true});
  }

  static _addEffect(event, target) {
    return this._onAddEffect({currentTarget: target, preventDefault: () => event?.preventDefault?.()});
  }

  static _deleteEffect(event, target) {
    return this._onDeleteEffect({currentTarget: target, preventDefault: () => event?.preventDefault?.()});
  }

  static _moveEffect(event, target) {
    return this._onOrderEffect({currentTarget: target, preventDefault: () => event?.preventDefault?.()});
  }

  static _pickImage(event, target) {
    return this._onEditImage({currentTarget: target, preventDefault: () => event?.preventDefault?.()});
  }

  static _addChange(event, target) {
    return this._onManageChange({currentTarget: target, preventDefault: () => event?.preventDefault?.()});
  }

  static _deleteChange(event, target) {
    return this._onManageChange({currentTarget: target, preventDefault: () => event?.preventDefault?.()});
  }

  static _copyExpanse(event, target) {
    return this._onCopyToCustom({currentTarget: target, preventDefault: () => event?.preventDefault?.()});
  }

  static _exportEffects(event) {
    return this._onSaveToFile(event);
  }

  static _importEffects(event) {
    return this._onReadFromFile(event);
  }

  static _save(event) {
    return this._onCloseWorkshop(event);
  }

  static _cancel(event) {
    event?.preventDefault?.();
    return this.close();
  }
}
