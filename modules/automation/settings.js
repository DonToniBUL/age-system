import {RuleProfileManager} from "./rule-profiles.js";
import {ageCompendiumIndex, UnifiedAgeSearch} from "./compendium-index.js";
import {isAssistMode} from "./mode.js";

const SYSTEM_ID = "age-system";

export function registerAutomationSettings() {
  game.settings.registerMenu(SYSTEM_ID, "ruleProfiles", {
    name: "age-system.AUTOMATION.ruleProfiles",
    hint: "age-system.AUTOMATION.ruleProfilesHint",
    icon: "fa-solid fa-sliders",
    label: "age-system.AUTOMATION.openRuleProfiles",
    config: true,
    type: RuleProfileManager,
    restricted: true
  });

  game.settings.registerMenu(SYSTEM_ID, "unifiedLibrarySearch", {
    name: "age-system.AUTOMATION.librarySearch",
    hint: "age-system.AUTOMATION.librarySearchHint",
    icon: "fa-solid fa-magnifying-glass",
    label: "age-system.AUTOMATION.openLibrarySearch",
    config: true,
    type: UnifiedAgeSearch,
    restricted: false
  });

  game.settings.register(SYSTEM_ID, "automationMode", {
    name: "age-system.AUTOMATION.mode",
    hint: "age-system.AUTOMATION.modeHint",
    scope: "world",
    requiresReload: false,
    config: true,
    default: "assist",
    type: String,
    choices: {
      off: "age-system.AUTOMATION.modeOff",
      assist: "age-system.AUTOMATION.modeAssist"
    },
    onChange: async value => {
      if (value === "assist" && game.settings.get(SYSTEM_ID, "enableCompendiumIndex")) await ageCompendiumIndex.rebuild();
      else ageCompendiumIndex.clear();
      ui.controls?.render?.();
    }
  });

  game.settings.register(SYSTEM_ID, "enableActionUndo", {
    name: "age-system.AUTOMATION.enableUndo",
    hint: "age-system.AUTOMATION.enableUndoHint",
    scope: "world",
    requiresReload: false,
    config: true,
    default: true,
    type: Boolean,
    onChange: () => ui.controls?.render?.()
  });

  game.settings.register(SYSTEM_ID, "actionHistoryLimit", {
    scope: "world",
    requiresReload: false,
    config: false,
    default: 20,
    type: Number
  });

  game.settings.register(SYSTEM_ID, "activeRuleProfile", {
    scope: "world",
    requiresReload: false,
    config: false,
    default: "custom",
    type: String
  });

  game.settings.register(SYSTEM_ID, "ruleProfileState", {
    scope: "world",
    requiresReload: false,
    config: false,
    default: {},
    type: Object
  });

  game.settings.register(SYSTEM_ID, "importerV2Enabled", {
    name: "age-system.AUTOMATION.importerV2",
    hint: "age-system.AUTOMATION.importerV2Hint",
    scope: "world",
    requiresReload: false,
    config: true,
    default: true,
    type: Boolean
  });

  game.settings.register(SYSTEM_ID, "enableCompendiumIndex", {
    name: "age-system.AUTOMATION.compendiumIndex",
    hint: "age-system.AUTOMATION.compendiumIndexHint",
    scope: "world",
    requiresReload: false,
    config: true,
    default: true,
    type: Boolean,
    onChange: async value => {
      if (value && isAssistMode()) await ageCompendiumIndex.rebuild();
      else ageCompendiumIndex.clear();
      ui.controls?.render?.();
    }
  });

  const featureSettings = [
    ["enableStuntAssistant", "stuntAssistantSetting", "stuntAssistantSettingHint"],
    ["enableMultiTargetAttacks", "multiTargetSetting", "multiTargetSettingHint"],
    ["enablePowerResistance", "powerResistanceSetting", "powerResistanceSettingHint"],
    ["enableCombatLifecycle", "combatLifecycleSetting", "combatLifecycleSettingHint"],
    ["enableAdvancedTests", "advancedTestsSetting", "advancedTestsSettingHint"],
    ["enableRequestedRolls", "requestedRollsSetting", "requestedRollsSettingHint"],
    ["enableRecoveryAutomation", "recoverySetting", "recoverySettingHint"],
    ["enableCombatEconomy", "combatEconomySetting", "combatEconomySettingHint"]
  ];
  for (const [key, name, hint] of featureSettings) {
    game.settings.register(SYSTEM_ID, key, {
      name: `age-system.AUTOMATION.${name}`,
      hint: `age-system.AUTOMATION.${hint}`,
      scope: "world",
      requiresReload: false,
      config: true,
      default: true,
      type: Boolean,
      onChange: () => ui.controls?.render?.()
    });
  }

  game.settings.register(SYSTEM_ID, "combatLifecycleMode", {
    name: "age-system.AUTOMATION.combatLifecycleMode",
    hint: "age-system.AUTOMATION.combatLifecycleModeHint",
    scope: "world",
    requiresReload: false,
    config: true,
    default: "remind",
    type: String,
    choices: {
      off: "age-system.AUTOMATION.lifecycleOff",
      remind: "age-system.AUTOMATION.lifecycleRemind",
      automatic: "age-system.AUTOMATION.lifecycleAutomatic"
    }
  });

  game.settings.register(SYSTEM_ID, "advancedTestState", {
    scope: "world",
    requiresReload: false,
    config: false,
    default: {version: 1, revision: 0, trackers: []},
    type: Object
  });
}

export default registerAutomationSettings;
