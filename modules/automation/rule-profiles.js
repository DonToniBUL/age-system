import {showConfirmDialog} from "../dialogs.js";
import {applyColorSchemeToElement} from "../color-scheme.js";
import {isAssistMode, requireAssistMode} from "./mode.js";

const SYSTEM_ID = "age-system";
// Foundry v14 supplies the native AppV2 branch. The fallbacks keep profile
// service tests able to evaluate this module without constructing a browser.
const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2
  ?? globalThis.foundry?.appv1?.api?.FormApplication
  ?? class {};
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin
  ?? (Base => Base);

const common = {
  healthMode: "health",
  useFatigue: false,
  consumePP: true
};

export const AGE_RULE_PROFILES = Object.freeze({
  dage: {
    id: "dage",
    label: "age-system.AUTOMATION.profileDage",
    description: "age-system.AUTOMATION.profileDageHint",
    settings: {
      ...common,
      healthSys: "basic",
      gameMode: "none",
      abilitySelection: "dage",
      primaryAbl: true,
      DegressChoice: "fage",
      wealthType: "coins",
      occupation: "class",
      ancestryOpt: "race",
      useConviction: false,
      usePowerPoints: true,
      powerFlavor: "mana",
      complication: "none",
      serendipity: false,
      stuntAttack: 1
    }
  },
  "fage-1e": {
    id: "fage-1e",
    label: "age-system.AUTOMATION.profileFage1",
    description: "age-system.AUTOMATION.profileFage1Hint",
    settings: {
      ...common,
      healthSys: "basic",
      gameMode: "none",
      abilitySelection: "main",
      primaryAbl: true,
      DegressChoice: "fage",
      wealthType: "coins",
      occupation: "class",
      ancestryOpt: "race",
      useConviction: false,
      usePowerPoints: true,
      powerFlavor: "spell",
      complication: "none",
      serendipity: false,
      stuntAttack: 1
    }
  },
  "fage-2e": {
    id: "fage-2e",
    label: "age-system.AUTOMATION.profileFage2",
    description: "age-system.AUTOMATION.profileFage2Hint",
    settings: {
      ...common,
      healthSys: "basic",
      gameMode: "none",
      abilitySelection: "main",
      primaryAbl: true,
      DegressChoice: "fage",
      wealthType: "coins",
      occupation: "class",
      ancestryOpt: "ancestry",
      useConviction: false,
      usePowerPoints: true,
      powerFlavor: "spell",
      complication: "Peril",
      serendipity: true,
      stuntAttack: 1
    }
  },
  "mage-core": {
    id: "mage-core",
    label: "age-system.AUTOMATION.profileMageCore",
    description: "age-system.AUTOMATION.profileMageCoreHint",
    settings: {
      ...common,
      healthSys: "mage",
      gameMode: "pulp",
      abilitySelection: "main",
      primaryAbl: false,
      DegressChoice: "mage",
      wealthType: "resources",
      occupation: "profession",
      ancestryOpt: "ancestry",
      useConviction: false,
      usePowerPoints: true,
      powerFlavor: "power",
      complication: "none",
      serendipity: false,
      stuntAttack: 2
    }
  },
  "mage-mastery-injury": {
    id: "mage-mastery-injury",
    label: "age-system.AUTOMATION.profileMageInjury",
    description: "age-system.AUTOMATION.profileMageInjuryHint",
    settings: {
      ...common,
      healthSys: "mageInjury",
      gameMode: "pulp",
      abilitySelection: "main",
      primaryAbl: false,
      DegressChoice: "mage",
      wealthType: "resources",
      occupation: "profession",
      ancestryOpt: "ancestry",
      useConviction: false,
      usePowerPoints: true,
      powerFlavor: "power",
      complication: "none",
      serendipity: false,
      stuntAttack: 2
    }
  }
});

const clone = value => foundry.utils.deepClone(value);
const equal = (left, right) => {
  if (foundry.utils.equals) return foundry.utils.equals(left, right);
  if (foundry.utils.objectsEqual) return foundry.utils.objectsEqual(left, right);
  return JSON.stringify(left) === JSON.stringify(right);
};

function settingDefinition(key) {
  return game.settings.settings.get(`${SYSTEM_ID}.${key}`);
}

function validateValue(key, value) {
  const definition = settingDefinition(key);
  if (!definition) throw new Error(`Unknown AGE setting: ${key}`);
  if (definition.choices && !Object.hasOwn(definition.choices, value)) {
    throw new Error(`Invalid value for AGE setting ${key}: ${value}`);
  }
  if (definition.type === Boolean && typeof value !== "boolean") throw new TypeError(`${key} must be Boolean.`);
  if (definition.type === Number && !Number.isFinite(Number(value))) throw new TypeError(`${key} must be numeric.`);
  return definition;
}

function displayValue(definition, value) {
  if (definition?.choices?.[value]) return game.i18n.localize(definition.choices[value]);
  if (typeof value === "boolean") return game.i18n.localize(value ? "Yes" : "No");
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

async function restoreSettingValues(entries) {
  const failures = [];
  for (const [key, value] of entries) {
    try {
      await game.settings.set(SYSTEM_ID, key, clone(value));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "AGE rule-profile rollback was incomplete.");
}

export class RuleProfileService {
  static profile(id) {
    return AGE_RULE_PROFILES[id] ?? null;
  }

  static preview(id) {
    const profile = this.profile(id);
    if (!profile) throw new Error(`Unknown AGE rule profile: ${id}`);
    return Object.entries(profile.settings).map(([key, proposed]) => {
      const definition = validateValue(key, proposed);
      const current = game.settings.get(SYSTEM_ID, key);
      return {
        key,
        name: game.i18n.localize(definition.name ?? key),
        current,
        currentLabel: displayValue(definition, current),
        proposed,
        proposedLabel: displayValue(definition, proposed),
        changed: !equal(current, proposed),
        requiresReload: definition.requiresReload === true
      };
    });
  }

  static async apply(id) {
    if (!game.user?.isGM) throw new Error(game.i18n.localize("age-system.AUTOMATION.gmOnly"));
    requireAssistMode();
    const profile = this.profile(id);
    if (!profile) throw new Error(`Unknown AGE rule profile: ${id}`);
    const rows = this.preview(id);
    const changed = rows.filter(row => row.changed);
    const previous = Object.fromEntries(changed.map(row => [row.key, clone(row.current)]));
    const applied = Object.fromEntries(changed.map(row => [row.key, clone(row.proposed)]));
    const completed = [];
    const previousProfileState = clone(game.settings.get(SYSTEM_ID, "ruleProfileState") ?? {});
    const previousActiveProfile = game.settings.get(SYSTEM_ID, "activeRuleProfile");
    const state = {
      id: foundry.utils.randomID?.(16) ?? `${Date.now()}`,
      profileId: id,
      timestamp: Date.now(),
      previous,
      applied
    };

    try {
      for (const row of changed) {
        await game.settings.set(SYSTEM_ID, row.key, clone(row.proposed));
        completed.push(row.key);
      }
      await game.settings.set(SYSTEM_ID, "ruleProfileState", state);
      await game.settings.set(SYSTEM_ID, "activeRuleProfile", id);
    } catch (error) {
      try {
        await restoreSettingValues([
          ...[...completed].reverse().map(key => [key, previous[key]]),
          ["ruleProfileState", previousProfileState],
          ["activeRuleProfile", previousActiveProfile]
        ]);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "AGE rule-profile application and rollback both failed.");
      }
      throw error;
    }
    return {profile, rows, changed, requiresReload: changed.some(row => row.requiresReload), state};
  }

  static async revert() {
    if (!game.user?.isGM) throw new Error(game.i18n.localize("age-system.AUTOMATION.gmOnly"));
    const state = game.settings.get(SYSTEM_ID, "ruleProfileState") ?? {};
    const previousActiveProfile = game.settings.get(SYSTEM_ID, "activeRuleProfile");
    if (!state.id || !state.previous || !state.applied) return null;

    for (const [key, appliedValue] of Object.entries(state.applied)) {
      const current = game.settings.get(SYSTEM_ID, key);
      if (!equal(current, appliedValue)) {
        throw new Error(game.i18n.format("age-system.AUTOMATION.profileConflict", {setting: key}));
      }
    }

    const restored = [];
    try {
      for (const [key, value] of Object.entries(state.previous)) {
        await game.settings.set(SYSTEM_ID, key, clone(value));
        restored.push(key);
      }
      await game.settings.set(SYSTEM_ID, "ruleProfileState", {});
      await game.settings.set(SYSTEM_ID, "activeRuleProfile", "custom");
    } catch (error) {
      try {
        await restoreSettingValues([
          ...[...restored].reverse().map(key => [key, state.applied[key]]),
          ["ruleProfileState", state],
          ["activeRuleProfile", previousActiveProfile]
        ]);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "AGE rule-profile restoration and rollback both failed.");
      }
      throw error;
    }

    const requiresReload = restored.some(key => settingDefinition(key)?.requiresReload === true);
    return {restored, requiresReload};
  }
}

export class RuleProfileManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "age-rule-profile-manager",
    classes: ["age-system", "dialog", "age-v5-parity-sheet", "age-utility-workflow", "age-rule-profile-manager-v2"],
    position: {width: 760, height: 700},
    window: {
      title: "age-system.AUTOMATION.ruleProfiles",
      icon: "fa-solid fa-sliders",
      resizable: true,
      minimizable: true
    },
    actions: {
      applyProfile: RuleProfileManager._applyProfile,
      revertProfile: RuleProfileManager._revertProfile
    }
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/automation/rule-profile-manager.hbs",
      scrollable: [".age-utility-workflow__scroll"]
    }
  };

  constructor(object = {}, options = undefined) {
    // Accept both AppV2's (options) and the historical FormApplication
    // (object, options) signature used by a few integrations.
    super((options ?? object) || {});
    this._legacyObject = options === undefined ? null : object;
    const active = game.settings.get(SYSTEM_ID, "activeRuleProfile");
    this.selectedProfileId = AGE_RULE_PROFILES[active] ? active : "dage";
    this._busy = false;
    this._operationError = "";
    this._listenerAbort = null;
  }

  /** Preserve the boolean render signature used by settings-menu entry points. */
  render(options = {}) {
    if (typeof options === "boolean") options = {force: options};
    return super.render(options ?? {});
  }

  _buildContext() {
    const profiles = Object.values(AGE_RULE_PROFILES).map(profile => ({
      ...profile,
      localizedLabel: game.i18n.localize(profile.label)
    }));
    const selected = AGE_RULE_PROFILES[this.selectedProfileId];
    const state = game.settings.get(SYSTEM_ID, "ruleProfileState") ?? {};
    const automationEnabled = isAssistMode();
    const activeProfileId = game.settings.get(SYSTEM_ID, "activeRuleProfile");
    const activeProfile = AGE_RULE_PROFILES[activeProfileId];
    return {
      automationEnabled,
      busy: this._busy,
      operationError: this._operationError,
      profiles,
      selectedProfileId: this.selectedProfileId,
      selectedLabel: game.i18n.localize(selected.label),
      selectedDescription: game.i18n.localize(selected.description),
      rows: RuleProfileService.preview(this.selectedProfileId),
      canRevert: Boolean(state.id),
      activeProfile: activeProfileId,
      activeProfileLabel: activeProfile
        ? game.i18n.localize(activeProfile.label)
        : activeProfileId === "custom"
          ? game.i18n.localize("age-system.AUTOMATION.profileCustom")
          : activeProfileId
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
    return Object.assign(context ?? {}, this._buildContext());
  }

  async _onFirstRender(context, options) {
    if (typeof super._onFirstRender === "function") await super._onFirstRender(context, options);
    this._listenerAbort?.abort();
    this._listenerAbort = new AbortController();
    this.element?.addEventListener?.("change", event => {
      const select = event.target?.closest?.("select[name='profile']");
      if (!select || this._busy || !AGE_RULE_PROFILES[select.value]) return;
      this.selectedProfileId = select.value;
      void this._renderSafely();
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

  async _renderSafely() {
    try {
      return await this.render({force: true});
    } catch (error) {
      console.error("AGE System | Rule Profile Manager failed to render.", error);
      globalThis.ui?.notifications?.error?.(error?.message ?? String(error), {permanent: true});
      return null;
    }
  }

  async _perform(operation) {
    if (this._busy) return null;
    this._busy = true;
    this._operationError = "";
    await this._renderSafely();
    let result = null;
    try {
      result = await operation();
    } catch (error) {
      this._operationError = error?.message ?? String(error);
      globalThis.ui?.notifications?.error?.(this._operationError, {permanent: true});
    } finally {
      this._busy = false;
      await this._renderSafely();
    }
    return result;
  }

  static async _applyProfile(event) {
    event?.preventDefault?.();
    return this._perform(async () => {
      const selected = AGE_RULE_PROFILES[this.selectedProfileId];
      if (!selected) throw new Error(`Unknown AGE rule profile: ${this.selectedProfileId}`);
      const confirmed = await showConfirmDialog({
        title: game.i18n.localize("age-system.AUTOMATION.applyProfile"),
        content: `<p>${game.i18n.format("age-system.AUTOMATION.applyProfileConfirm", {profile: game.i18n.localize(selected.label)})}</p>`,
        yesLabel: game.i18n.localize("age-system.AUTOMATION.applyProfile"),
        noLabel: game.i18n.localize("age-system.cancel"),
        defaultYes: false
      });
      if (!confirmed) return false;
      const result = await RuleProfileService.apply(this.selectedProfileId);
      globalThis.ui?.notifications?.info?.(game.i18n.format("age-system.AUTOMATION.profileApplied", {profile: game.i18n.localize(result.profile.label)}));
      if (result.requiresReload) await globalThis.SettingsConfig?.reloadConfirm?.();
      return result;
    });
  }

  static async _revertProfile(event) {
    event?.preventDefault?.();
    return this._perform(async () => {
      const result = await RuleProfileService.revert();
      if (!result) {
        globalThis.ui?.notifications?.warn?.(game.i18n.localize("age-system.AUTOMATION.noProfileToRestore"));
        return null;
      }
      globalThis.ui?.notifications?.info?.(game.i18n.localize("age-system.AUTOMATION.profileRestored"));
      if (result.requiresReload) await globalThis.SettingsConfig?.reloadConfirm?.();
      return result;
    });
  }

  _updateObject() {}
}

export default RuleProfileService;
