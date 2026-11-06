import {ageSystem} from "./config.js";
import { controlledTokenByType } from "./age-chat.js";
import {AgeTransactionService} from "./automation/action-transactions.js";
import {applyColorSchemeToElement} from "./color-scheme.js";

const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2
  ?? globalThis.foundry?.appv1?.api?.FormApplication
  ?? class {};
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin
  ?? (Base => Base);

export class BreatherSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "breather-settings",
    classes: ["age-system", "age-v5-parity-sheet", "age-utility-workflow", "age-breather-settings-v2"],
    position: {width: 520, height: 460},
    window: {
      title: "SETTINGS.breatherSettings",
      icon: "fa-solid fa-kit-medical",
      resizable: true,
      minimizable: true
    },
    actions: {
      save: BreatherSettings._save
    }
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/rolls/breather-settings.hbs",
      scrollable: [".age-utility-workflow__scroll"]
    }
  };

  constructor(objectOrOptions = {}, options = undefined) {
    super(options ?? objectOrOptions ?? {});
    this.config = foundry.utils.deepClone(ageSystem.breather ?? {});
    this._ageBoundBreatherForms = new WeakSet();
  }

  render(options = {}) {
    if (typeof options === "boolean") options = {force: options};
    return super.render(options ?? {});
  }

  _buildContext() {
    return {
      ...this.config,
      abilities: ageSystem.abilities,
      settingMode: true
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
    const form = this.element?.querySelector?.("form.age-breather-settings-form");
    if (!form || this._ageBoundBreatherForms.has(form)) return;
    this._ageBoundBreatherForms.add(form);
    form.addEventListener("change", event => {
      this.onChangeInput(event);
      void this._updateObject(event, this.config).catch(error => {
        console.error("AGE System | Breather settings update failed.", error);
      });
    });
  }

  onChangeInput(event) {
    const el = event.target ?? event.currentTarget;
    if (!el?.name) return false;
    const type = el.type;
    const name = el.name;
    const obj = foundry.utils.deepClone(ageSystem.breather ?? {});
    obj[name] = type === "checkbox" ? el.checked : el.value;
    this.config = obj;
    return obj;
  }

  async _updateObject(event, data) {
    return game.settings.set("age-system", "breatherParam", data);
  }

  async _onClose(options) {
    await this._updateObject(null, this.config);
    if (typeof super._onClose === "function") await super._onClose(options);
  }

  static async _save(event, target) {
    event.preventDefault();
    const form = target?.closest?.("form")
      ?? this.element?.querySelector?.("form.age-breather-settings-form");
    const data = new foundry.applications.ux.FormDataExtended(form).object;
    this.config = {...foundry.utils.deepClone(ageSystem.breather ?? {}), ...data};
    await this._updateObject(event, this.config);
    return this.close();
  }
}

export default BreatherSettings;

/**
 * Apply Breather function to all select Character tokens
 * @param {string} rollMode String indicating breather card privacy
 */
export async function applyBreather(rollMode=null) {
  const tk = controlledTokenByType('char');
  if (tk.length === 0) return [];
  const transaction = AgeTransactionService.begin({
    label: game.i18n.localize("age-system.breather"),
    type: "breather",
    metadata: {targets: tk.length}
  });
  try {
    const settled = await Promise.allSettled(tk.map(t => t.actor.breather(true, {rollMode, transaction})));
    const failure = settled.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    const results = settled.map(result => result.value);
    await transaction.commit();
    ui.notifications.info(game.i18n.localize("age-system.WARNING.breatherAppliedAll"));
    return results;
  } catch (error) {
    try {
      await transaction.rollback({removeHistory: true});
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], game.i18n.localize("age-system.AUTOMATION.rollbackFailed"));
    }
    throw error;
  }
}
