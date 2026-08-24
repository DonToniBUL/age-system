import {showConfirmDialog} from "../dialogs.js";
import {isAssistMode, requireAssistMode} from "./mode.js";

const SYSTEM_ID = "age-system";

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
const equal = (left, right) => foundry.utils.objectsEqual
  ? foundry.utils.objectsEqual(left, right)
  : JSON.stringify(left) === JSON.stringify(right);

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

export class RuleProfileManager extends foundry.appv1.api.FormApplication {
  constructor(object = {}, options = {}) {
    super(object, options);
    const active = game.settings.get(SYSTEM_ID, "activeRuleProfile");
    this.selectedProfileId = AGE_RULE_PROFILES[active] ? active : "dage";
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "age-rule-profile-manager",
      template: "systems/age-system/templates/automation/rule-profile-manager.hbs",
      classes: ["age-system", "dialog"],
      title: game.i18n.localize("age-system.AUTOMATION.ruleProfiles"),
      width: 760,
      height: 700,
      resizable: true,
      minimizable: true,
      closeOnSubmit: false
    });
  }

  getData() {
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
      ...super.getData(),
      automationEnabled,
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

  activateListeners(html) {
    super.activateListeners(html);
    html.find("select[name=profile]").on("change", event => {
      this.selectedProfileId = event.currentTarget.value;
      this.render(false);
    });
    html.find(".apply-rule-profile").on("click", async event => {
      event.currentTarget.disabled = true;
      try {
        const confirmed = await showConfirmDialog({
          title: game.i18n.localize("age-system.AUTOMATION.applyProfile"),
          content: `<p>${game.i18n.format("age-system.AUTOMATION.applyProfileConfirm", {profile: game.i18n.localize(AGE_RULE_PROFILES[this.selectedProfileId].label)})}</p>`,
          yesLabel: game.i18n.localize("age-system.AUTOMATION.applyProfile"),
          noLabel: game.i18n.localize("age-system.cancel"),
          defaultYes: false
        });
        if (!confirmed) return;
        const result = await RuleProfileService.apply(this.selectedProfileId);
        ui.notifications.info(game.i18n.format("age-system.AUTOMATION.profileApplied", {profile: game.i18n.localize(result.profile.label)}));
        if (result.requiresReload) SettingsConfig.reloadConfirm();
        this.render(false);
      } catch (error) {
        ui.notifications.error(error.message, {permanent: true});
      } finally {
        event.currentTarget.disabled = false;
      }
    });
    html.find(".revert-rule-profile").on("click", async event => {
      event.currentTarget.disabled = true;
      try {
        const result = await RuleProfileService.revert();
        if (!result) return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.noProfileToRestore"));
        ui.notifications.info(game.i18n.localize("age-system.AUTOMATION.profileRestored"));
        if (result.requiresReload) SettingsConfig.reloadConfirm();
        this.render(false);
      } catch (error) {
        ui.notifications.error(error.message, {permanent: true});
      } finally {
        event.currentTarget.disabled = false;
      }
    });
  }

  _updateObject() {}
}

export default RuleProfileService;
