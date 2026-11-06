import { ageSystem } from "./config.js";
import {applyColorSchemeToElement} from "./color-scheme.js";

const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2
  ?? globalThis.foundry?.appv1?.api?.FormApplication
  ?? class {};
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin
  ?? (Base => Base);

function systemSettingsContext() {
  const settings = {};
  const canConfigure = game.user.can("SETTINGS_MODIFY");
  for (const setting of game.settings.settings.values()) {
    const namespace = setting.namespace || setting.module;
    if (namespace !== game.system.id) continue;
    if (!canConfigure && setting.scope !== "client") continue;
    const entry = foundry.utils.deepClone(setting);
    entry.namespace = namespace;
    entry.id = `${entry.namespace}.${entry.key}`;
    entry.name = game.i18n.localize(entry.name);
    entry.hint = game.i18n.localize(entry.hint);
    entry.value = game.settings.get(entry.namespace, entry.key);
    entry.type = setting.type instanceof Function ? setting.type.name : "String";
    entry.isCheckbox = setting.type === Boolean;
    entry.isSelect = setting.choices !== undefined;
    entry.isRange = setting.type === Number && setting.range;
    entry.filePickerType = setting.filePicker === true ? "any" : setting.filePicker;
    settings[entry.key] = entry;
  }
  return settings;
}

function applicationForm(application, target) {
  return target?.closest?.("form")
    ?? application.element?.querySelector?.("form.game-settings-window")
    ?? application.form
    ?? null;
}

export class QuickSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "quick-settings",
    classes: ["age-system", "age-v5-parity-sheet", "age-utility-workflow", "age-quick-settings-v2"],
    position: {width: 760, height: 660},
    window: {
      title: "SETTINGS.quicksetting",
      icon: "fa-solid fa-wand-magic-sparkles",
      resizable: true,
      minimizable: true
    },
    actions: {
      selectPreset: QuickSettings._selectPreset,
      save: QuickSettings._save,
      cancel: QuickSettings._cancel
    }
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/quick-settings.hbs",
      scrollable: [".age-utility-workflow__scroll"]
    }
  };

  constructor(objectOrOptions = {}, options = undefined) {
    super(options ?? objectOrOptions ?? {});
    this.config = {};
  }

  render(options = {}) {
    if (typeof options === "boolean") options = {force: options};
    return super.render(options ?? {});
  }

  _buildContext() {
    return {
      presets: ageSystem.gameSettings,
      currentPreset: ageSystem.gameSettings[this.config.preset],
      colors: ageSystem.colorScheme,
      config: this.config,
      settings: systemSettingsContext()
    };
  }

  /** Kept for integrations which inspected the former FormApplication data. */
  getData() {
    const base = typeof super.getData === "function" ? super.getData() : {};
    return {...base, ...this._buildContext()};
  }

  async _prepareContext(options) {
    const context = typeof super._prepareContext === "function"
      ? await super._prepareContext(options)
      : {};
    return Object.assign(context, this._buildContext());
  }

  async _onRender(context, options) {
    if (typeof super._onRender === "function") await super._onRender(context, options);
    applyColorSchemeToElement(this.element);
    applyColorSchemeToElement(this.element?.querySelector?.(".colorset-selection"));
  }

  async onLoadSettings(event, target = null) {
    if (!this.config.preset) return this.close();
    const form = applicationForm(this, target);
    const fd = new foundry.applications.ux.FormDataExtended(form).object;
    const sets = {
      ...ageSystem.gameSettings[this.config.preset].settings.defined,
      ...fd
    };
    await Promise.all(Object.entries(sets).map(([setting, value]) => game.settings.set("age-system", setting, value)));
    return this.close();
  }

  onSelectPreset(event, target = event?.currentTarget) {
    const preset = target?.dataset?.preset;
    if (!Object.hasOwn(ageSystem.gameSettings, preset)) return false;
    this.config.preset = preset;
    return this.render({force: true});
  }

  static _selectPreset(event, target) {
    event.preventDefault();
    return this.onSelectPreset(event, target);
  }

  static async _save(event, target) {
    event.preventDefault();
    return this.onLoadSettings(event, target);
  }

  static async _cancel(event) {
    event.preventDefault();
    return this.close();
  }
}

export class AdvancedSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "adv-settings",
    classes: ["age-system", "age-v5-parity-sheet", "age-utility-workflow", "age-advanced-settings-v2"],
    position: {width: 620, height: 720},
    window: {
      title: "SETTINGS.advSettings",
      icon: "fa-solid fa-sliders",
      resizable: true,
      minimizable: true
    },
    actions: {
      save: AdvancedSettings._save,
      cancel: AdvancedSettings._cancel
    }
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/adv-settings.hbs",
      scrollable: [".age-utility-workflow__scroll"]
    }
  };

  constructor(objectOrOptions = {}, options = undefined) {
    super(options ?? objectOrOptions ?? {});
    this.config = {};
  }

  render(options = {}) {
    if (typeof options === "boolean") options = {force: options};
    return super.render(options ?? {});
  }

  _buildContext() {
    return {
      colors: ageSystem.colorScheme,
      advSettings: ageSystem.advSettings,
      settings: systemSettingsContext()
    };
  }

  /** Kept for integrations which inspected the former FormApplication data. */
  getData() {
    const base = typeof super.getData === "function" ? super.getData() : {};
    return {...base, ...this._buildContext()};
  }

  async _prepareContext(options) {
    const context = typeof super._prepareContext === "function"
      ? await super._prepareContext(options)
      : {};
    return Object.assign(context, this._buildContext());
  }

  async _onRender(context, options) {
    if (typeof super._onRender === "function") await super._onRender(context, options);
    applyColorSchemeToElement(this.element);
    applyColorSchemeToElement(this.element?.querySelector?.(".colorset-selection"));
  }

  // TODO - Filter which settings really need reload only prompt user in the correct cases
  async onLoadSettings(event, target = null) {
    const form = applicationForm(this, target);
    const sets = new foundry.applications.ux.FormDataExtended(form).object;
    await Promise.all(Object.entries(sets).map(([setting, value]) => game.settings.set("age-system", setting, value)));
    SettingsConfig.reloadConfirm();
    return this.close();
  }

  static async _save(event, target) {
    event.preventDefault();
    return this.onLoadSettings(event, target);
  }

  static async _cancel(event) {
    event.preventDefault();
    return this.close();
  }
}
