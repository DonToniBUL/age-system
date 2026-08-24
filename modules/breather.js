import {ageSystem} from "./config.js";
import { controlledTokenByType } from "./age-chat.js";
import {AgeTransactionService} from "./automation/action-transactions.js";

export default class BreatherSettings extends foundry.appv1.api.FormApplication {
  constructor(object ={}, options = {}) {
    super(object, options);
    this.config = ageSystem.breather;
  }
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'breather-settings',
      template: 'systems/age-system/templates/rolls/breather-settings.hbs',
      resizable: false,
      minimizable: false,
      width: 'auto',
      height: 'auto',
      title: game.i18n.localize('SETTINGS.breatherSettings'),
      closeOnSubmit: false,
      submitOnClose: true,
      submitOnChange: true,
    })
  }

  getData() {
    const data = {
      ...super.getData(),
      ...ageSystem.breather,
      abilities: ageSystem.abilities,
      settingMode: true
    }
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find('input').change(this.onChangeInput.bind(this));
  }

  onChangeInput(ev) {
    const el = ev.currentTarget
    const type = el.type;
    const name = el.name
    const obj = foundry.utils.deepClone(ageSystem.breather);
    obj[name] = type === 'checkbox' ? el.checked : el.value;
    this.config = obj
  }

  async _updateObject(event, data) {
    return game.settings.set('age-system', 'breatherParam', data);
  }
}

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
