// import * as Macros from "./modules/macros.js";
import {ageSystem} from "./modules/config.js";
import ageSystemSheetItem from "./modules/sheets/ageSystemSheetItem.js";
import ageSystemSheetCharacter from "./modules/sheets/ageSystemSheetCharacter.js";
import ageSystemSheetCharStatBlock from "./modules/sheets/ageSystemSheetCharStatBlock.js";
import ageSystemSheetVehicle from "./modules/sheets/ageSystemSheetVehicle.js";
import ageSystemSheetSpaceship from "./modules/sheets/ageSystemSheetSpaceship.js";
import ageSystemSheetOrg from "./modules/sheets/ageSystemSheetOrg.js";
import ageSystemSheetCharacterV2, {
    ageSystemSheetCharStatBlockV2,
    ageSystemSheetVehicleV2,
    ageSystemSheetSpaceshipV2,
    ageSystemSheetOrgV2
} from "./modules/sheets/ageSystemSheetCharacterV2.js";
import {
    ageSystemSheetClassV2,
    ageSystemSheetEquipmentV2,
    ageSystemSheetFocusV2,
    ageSystemSheetHonorificsV2,
    ageSystemSheetMembershipV2,
    ageSystemSheetPowerV2,
    ageSystemSheetRelationshipV2,
    ageSystemSheetShipFeaturesV2,
    ageSystemSheetStuntsV2,
    ageSystemSheetTalentV2,
    ageSystemSheetWeaponV2
} from "./modules/sheets/ageSystemSheetItemV2.js";
import {ageSystemActor} from "./modules/ageSystemActor.js";
import {ageSystemItem} from "./modules/ageSystemItem.js";
import { createAgeMacro} from "./modules/macros.js";
import { rollOwnedItem } from "./modules/macros.js";
import { AgeTracker } from "./modules/age-tracker.js";
import { applyBreather } from "./modules/breather.js";
import AgeImporter from "./modules/age-importer.js";
import ConditionsWorkshop from "./modules/conditions-workshop.js";
import { getCoreMessageMode, MESSAGE_MODES, statusEffectArray, statusEffectRecord } from "./modules/compat.js";
import {applyColorScheme} from "./modules/color-scheme.js";
import * as Currency from "./modules/currency.js";
import {registerAgeItemPilesIntegration} from "./modules/item-piles.js";
import {AgeTransactionService} from "./modules/automation/action-transactions.js";
import {PowerResourceService} from "./modules/automation/power-resources.js";
import {RuleProfileService} from "./modules/automation/rule-profiles.js";
import {ageCompendiumIndex, UnifiedAgeSearch} from "./modules/automation/compendium-index.js";
import {AgeImporterService} from "./modules/automation/importer-service.js";
import {automationFeatureEnabled} from "./modules/automation/mode.js";
import {StuntAssistantService} from "./modules/automation/stunt-assistant.js";
import {MultiTargetService} from "./modules/automation/multi-target.js";
import {PowerResistanceService} from "./modules/automation/power-resistance.js";
import {CombatLifecycleService} from "./modules/automation/combat-lifecycle.js";
import {AdvancedTestService} from "./modules/automation/advanced-tests.js";
import {ConditionLifecycleService} from "./modules/automation/condition-lifecycle.js";
import {RequestedRollService} from "./modules/automation/requested-rolls.js";
import {RecoveryService} from "./modules/automation/recovery.js";
import {CombatEconomyService} from "./modules/automation/combat-economy.js";
import {AgeContentValidator} from "./modules/automation/content-validator.js";
import {AgeActionService} from "./modules/automation/actions.js";
import {registerCoreAgeActions} from "./modules/automation/core-actions.js";
import {AgeActionDiagnostics} from "./modules/automation/action-diagnostics.js";
import {AgeActionDelegationService} from "./modules/automation/action-delegation.js";
import {createAgeSystemApi} from "./modules/api.js";
import {AgeDataContracts} from "./modules/data/contracts.js";
import {AGE_DATA_MODEL_STATUS, registerAgeDataModels} from "./modules/data/models.js";
import {registerAgeTokenTrackableAttributes} from "./modules/token-attributes.js";
import {AgeMigrationPreview} from "./modules/data/migration-preview.js";
import {StructuredChatCardService} from "./modules/chat/structured-chat.js";
import {
    migrateBeta1ItemSheetSelections,
    migrateStableAppV2SheetDefaults
} from "./modules/sheets/v2-sheet-migration.js";
import {registerLegacySelectHelper} from "./modules/handlebars-helpers.js";
import {registerNativeEditorHelper} from "./modules/sheets/native-editor.js";
import {registerAgeSystemTour} from "./modules/tour.js";

import * as Dice from "./modules/dice.js";
import * as Settings from "./modules/settings.js";
import * as AgeChat from "./modules/age-chat.js";
import * as Setup from "./modules/setup.js";
import * as migrations from "./modules/migration.js";

async function preloadHandlebarsTemplates() {
    const path = `systems/age-system/templates/partials/`;
    const pathRedux = `systems/age-system/templates/`;
    const templatePaths = [
        `${path}itemcontrols/class.hbs`,
        `${path}itemcontrols/equipment.hbs`,
        `${path}itemcontrols/honorifics.hbs`,
        `${path}itemcontrols/membership.hbs`,
        `${path}itemcontrols/power.hbs`,
        `${path}itemcontrols/relationship.hbs`,
        `${path}itemcontrols/stunts.hbs`,
        `${path}itemcontrols/talent.hbs`,
        `${path}itemcontrols/weapon.hbs`,
        `${path}ability-focus-select.hbs`,
        `${path}active-bonuses.hbs`,
        `${path}bonuses-sheet.hbs`,
        `${path}cost-resource-block.hbs`,
        `${path}dmg-block-sheet.hbs`,
        `${path}item-card-buttons.hbs`,
        `${path}item-options-sheet.hbs`,
        `${path}weapon-group-block.hbs`,

        `${pathRedux}sheets/char/adv.hbs`,
        `${pathRedux}sheets/char/effects.hbs`,
        `${pathRedux}sheets/char/equip.hbs`,
        `${pathRedux}sheets/char/main.hbs`,
        `${pathRedux}sheets/char/options.hbs`,
        `${pathRedux}sheets/char/persona.hbs`,
        `${pathRedux}sheets/char/powers.hbs`,
        `${pathRedux}sheets/char/social.hbs`,
        `${pathRedux}sheets/char/stunts.hbs`,
        `${pathRedux}sheets/char/talents.hbs`,
        
        `${pathRedux}sheets/char-block/column1.hbs`,
        `${pathRedux}sheets/char-block/injury-bar.hbs`,
        `${pathRedux}sheets/char-block/play-aid-bar.hbs`,

        `${pathRedux}sheets/v2/parity/partials/char-block-column1.hbs`,
        `${pathRedux}sheets/v2/parity/partials/char-persona.hbs`,
    ];

    return foundry.applications.handlebars.loadTemplates(templatePaths);
};

Hooks.once("init", async function() {
    const ageSystemText = `
     ___   ____________   _____            __               
    /   | / ____/ ____/  / ___/__  _______/ /____  ____ ___ 
   / /| |/ / __/ __/     \\__ \\/ / / / ___/ __/ _ \\/ __ \`__ \\
  / ___ / /_/ / /___    ___/ / /_/ (__  ) /_/  __/ / / / / /
 /_/  |_\\____/_____/   /____/\\__, /____/\\__/\\___/_/ /_/ /_/ 
                            /____/                          `;

    console.log("AGE System | Entering a new AGE...");
    console.log(ageSystemText);

    // Native AppV2 form controls must be emitted while Handlebars renders;
    // registering here avoids post-render DOM replacement.
    registerLegacySelectHelper();
    registerNativeEditorHelper();
    registerAgeDataModels();
    registerAgeTokenTrackableAttributes();

    // Create a namespace within the game global
    registerCoreAgeActions();
    const publicApi = createAgeSystemApi({
        transactions: AgeTransactionService,
        contentValidator: AgeContentValidator,
        migrationPreview: AgeMigrationPreview,
        actions: AgeActionService,
        delegation: AgeActionDelegationService,
        systemVersion: game.system.version
    });
    game.ageSystem = {
        api: publicApi,
        applications: {
            ageSystemSheetCharacter,
            ageSystemSheetCharStatBlock,
            ageSystemSheetVehicle,
            ageSystemSheetSpaceship,
            ageSystemSheetOrg,
            ageSystemSheetItem,
            ageSystemSheetCharacterV2,
            ageSystemSheetCharStatBlockV2,
            ageSystemSheetVehicleV2,
            ageSystemSheetSpaceshipV2,
            ageSystemSheetOrgV2,
            ageSystemSheetClassV2,
            ageSystemSheetEquipmentV2,
            ageSystemSheetFocusV2,
            ageSystemSheetHonorificsV2,
            ageSystemSheetMembershipV2,
            ageSystemSheetPowerV2,
            ageSystemSheetRelationshipV2,
            ageSystemSheetShipFeaturesV2,
            ageSystemSheetStuntsV2,
            ageSystemSheetTalentV2,
            ageSystemSheetWeaponV2,
            AgeTracker
        },
        dice: Dice,
        migrations: migrations,
        currency: Currency,
        rollOwnedItem,
        roll: Dice.ageRollCheck,
        dataContracts: AgeDataContracts,
        dataModels: AGE_DATA_MODEL_STATUS,
        migrationPreview: AgeMigrationPreview,
        structuredChat: StructuredChatCardService,
        // removeDoubledMods, // to be used in cases users has migration problems
        documents: {
            ageSystemActor,
            ageSystemItem
        },
        automation: {
            transactions: AgeTransactionService,
            actions: AgeActionService,
            actionDiagnostics: AgeActionDiagnostics,
            actionDelegation: AgeActionDelegationService,
            powerResources: PowerResourceService,
            ruleProfiles: RuleProfileService,
            compendiumIndex: ageCompendiumIndex,
            importer: AgeImporterService,
            stuntAssistant: StuntAssistantService,
            multiTargeting: MultiTargetService,
            powerResistance: PowerResistanceService,
            combatLifecycle: CombatLifecycleService,
            conditions: ConditionLifecycleService,
            requestedRolls: RequestedRollService,
            recovery: RecoveryService,
            combatEconomy: CombatEconomyService,
            advancedTests: AdvancedTestService,
            contentValidator: AgeContentValidator,
            indexReady: null
        }
    };

    const Actors = foundry.documents.collections.Actors;
    const ActorSheet = foundry.appv1.sheets.ActorSheet;
    Actors.unregisterSheet("core", ActorSheet);
    Actors.registerSheet("age-system", ageSystemSheetCharacter, {
        types: ["char"],
        makeDefault: false,
        label: "age-system.SHEETS.charLegacyFallback"
    });
    Actors.registerSheet("age-system", ageSystemSheetCharStatBlock, {
        types: ["char"],
        makeDefault: false,
        label: "age-system.SHEETS.charBlockLegacyFallback"
    });
    Actors.registerSheet("age-system", ageSystemSheetCharacterV2, {
        types: ["char"],
        makeDefault: true,
        label: "age-system.SHEETS.charAppV2Stable"
    });
    Actors.registerSheet("age-system", ageSystemSheetCharStatBlockV2, {
        types: ["char"],
        makeDefault: false,
        label: "age-system.SHEETS.charBlockAppV2Stable"
    });
    Actors.registerSheet("age-system", ageSystemSheetVehicle, {
        types: ["vehicle"],
        makeDefault: false,
        label: "age-system.SHEETS.vehicleLegacyFallback"
    });
    Actors.registerSheet("age-system", ageSystemSheetVehicleV2, {
        types: ["vehicle"],
        makeDefault: true,
        label: "age-system.SHEETS.vehicleAppV2Stable"
    });
    Actors.registerSheet("age-system", ageSystemSheetSpaceship, {
        types: ["spaceship"],
        makeDefault: false,
        label: "age-system.SHEETS.spaceshipLegacyFallback"
    });
    Actors.registerSheet("age-system", ageSystemSheetSpaceshipV2, {
        types: ["spaceship"],
        makeDefault: true,
        label: "age-system.SHEETS.spaceshipAppV2Stable"
    });
    Actors.registerSheet("age-system", ageSystemSheetOrg, {
        types: ["organization"],
        makeDefault: false,
        label: "age-system.SHEETS.orgLegacyFallback"
    });
    Actors.registerSheet("age-system", ageSystemSheetOrgV2, {
        types: ["organization"],
        makeDefault: true,
        label: "age-system.SHEETS.orgAppV2Stable"
    });
    
    const Items = foundry.documents.collections.Items;
    const ItemSheet = foundry.appv1.sheets.ItemSheet;
    Items.unregisterSheet("core", ItemSheet);
    Items.registerSheet("age-system", ageSystemSheetItem, {
        types: [
            "equipment",
            "focus",
            "weapon",
            "power",
            "talent",
            "stunts",
            "relationship",
            "honorifics",
            "membership",
            "shipfeatures",
            "class"
        ],
        makeDefault: false,
        label: "age-system.SHEETS.itemLegacyFallback"
    });
    const appV2ItemSheets = [
        ["class", ageSystemSheetClassV2],
        ["equipment", ageSystemSheetEquipmentV2],
        ["focus", ageSystemSheetFocusV2],
        ["honorifics", ageSystemSheetHonorificsV2],
        ["membership", ageSystemSheetMembershipV2],
        ["power", ageSystemSheetPowerV2],
        ["relationship", ageSystemSheetRelationshipV2],
        ["shipfeatures", ageSystemSheetShipFeaturesV2],
        ["stunts", ageSystemSheetStuntsV2],
        ["talent", ageSystemSheetTalentV2],
        ["weapon", ageSystemSheetWeaponV2]
    ];
    for (const [type, sheetClass] of appV2ItemSheets) {
        Items.registerSheet("age-system", sheetClass, {
            types: [type],
            makeDefault: true,
            label: "age-system.SHEETS.itemAppV2Stable"
        });
    }

    game.ageSystem.ageTracker = new AgeTracker({
        popOut: false,
        minimizable: false,
        resizable: false
    });

    // Define extra data for Age System (Actors, Items, ActiveEffectConfig)
    CONFIG.Actor.documentClass = ageSystemActor;
    CONFIG.Item.documentClass = ageSystemItem;
    CONFIG.ageSystem = ageSystem;
    CONFIG.ageSystem.classAdvancementSupported = true;

    // Load partials for Handlebars
    await preloadHandlebarsTemplates();

    // Register System Settings
    await Settings.registerSystemSettings();
    // Client settings are already user-specific. Apply the selected colour as
    // soon as settings exist so sheets opened during startup never receive an
    // undefined colour class.
    applyColorScheme(game.settings.get("age-system", "colorScheme"));
    
    // Identify Ability set in use
    const abilitySelection = game.settings.get("age-system", "abilitySelection");
    const abilityOptions = ageSystem.abilitiesSettings;
    ageSystem.abilities = abilityOptions[abilitySelection];

    // Register Settings
    ageSystem.stuntAttackPoints = game.settings.get("age-system", "stuntAttack");
    ageSystem.breather = game.settings.get('age-system', 'breatherParam');
    ageSystem.autoConsumePP = game.settings.get('age-system', 'consumePP');

    // Useful concat Helper from Boilerplate system!
    Handlebars.registerHelper('concat', function() {
        let outStr = '';
        for (let arg in arguments) {
            if (typeof arguments[arg] != 'object') {
                outStr += arguments[arg];
            }
        }
        return outStr;
    });

    // Compatibility replacement for the legacy {{#select}} helper.
    Handlebars.registerHelper("select", function(value, options) {
        const selectedValues = (Array.isArray(value) ? value : [value])
            .filter(v => v !== null && v !== undefined)
            .map(v => String(v));
        const escapedValues = selectedValues.map(v => Handlebars.escapeExpression(v));
        const html = options.fn(this);
        const selectedHtml = html.replace(/<option\b([^>]*)>/gi, (tag, attributes) => {
            const valueMatch = attributes.match(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
            if (!valueMatch) return tag;
            const optionValue = valueMatch[1] ?? valueMatch[2] ?? valueMatch[3] ?? "";
            if (!selectedValues.includes(optionValue) && !escapedValues.includes(optionValue)) return tag;
            if (/\sselected(?:\s|=|$)/i.test(attributes)) return tag;
            return tag.replace(/>$/, " selected>");
        });
        return new Handlebars.SafeString(selectedHtml);
    });

    Handlebars.registerHelper('effectModeName', function(type) {
        const legacy = ["custom", "multiply", "add", "downgrade", "upgrade", "override"];
        const normalized = typeof type === "number" ? legacy[type] : type;
        const label = CONFIG.ActiveEffect.changeTypes?.[normalized]?.label ?? `EFFECT.MODE_${String(normalized ?? "custom").toUpperCase()}`;
        return game.i18n.localize(label);
    });

    // Handlebar to set dice icon based on numeric value
    Handlebars.registerHelper('facename', function(face) {
        const faces = {
            "1": "one",
            "2": "two",
            "3": "three",
            "4": "four",
            "5": "five",
            "6": "six"
        };
        return faces[face];
    })

    // Handlebar to identify type of Effect
    Handlebars.registerHelper('ageffect', function(mask, options) {
        for (let o = 0; o < options.length; o++) {
            const e = options[o];
            if (e[1] == mask) return e[0];
        }
        return `${mask} (${game.i18n.localize("age-system.custom")})`;
    });

    // Handlebar returning array with Focus for a given Ability
    Handlebars.registerHelper('focusbyabl', function(focus, abl) {
        return focus.filter(f => f.system.useAbl === abl)
    });

    // Handlebar returning array with equiped weapon
    Handlebars.registerHelper('equippedwpn', function(weapons) {
        return weapons.filter(f => f.system.equiped === true)
    });

    // Handlebar returning array with active Power dealing damage
    Handlebars.registerHelper('dmgpower', function(powers) {
        return powers.filter(p => p.system.activate === true && (p.system.hasDamage || p.system.hasHealing))
    });

    // Handlebar returning all carried itens
    Handlebars.registerHelper('carriedequip', function(items) {
        return items.filter(p => p.type === "equipment" || p.type === "weapon")
    });

    // Handlebar to itentify if Weapon Group is knowN
    Handlebars.registerHelper('haswgroup', function(wGroup, groupArray) {
        if (!Array.isArray(groupArray)) return false;
        return groupArray.includes(wGroup) ? true : false;
    });

    // Handlebar to itentify if array is empty
    Handlebars.registerHelper('isempty', function(array, abl) {
        if (!Array.isArray(array)) return false;
        array = array.filter(f => f.system.useAbl === abl)
        return array.length === 0 ? true : false;
    });

    // Handlebar to build damage summary on chat card
    Handlebars.registerHelper('termOperator', function(diceTerms, k) {
        if (k === 0) return ``;
        const op = diceTerms[k-1].operator;
        return op === `+` ? `` : op;
    });

    // Handlebar to select Talent Degree
    Handlebars.registerHelper('tdegree', function(value) {
        value = Number(value);
        if (isNaN(value)) return ""
        return ageSystem.talentDegrees.inUse[value];
    });

    // Handlebar so show Level 1 to 20 using a Array with 20 positions
    Handlebars.registerHelper("levelarr", function(value, options)
    {
        return parseInt(value) + 1;
    });

    // Handlebar helper to compare 2 data
    Handlebars.registerHelper("when",function(operand_1, operator, operand_2, options) {
        let operators = {
            'eq': function(l,r) { return l == r; },
            'noteq': function(l,r) { return l != r; },
            'gt': function(l,r) { return Number(l) > Number(r); },
            'or': function(l,r) { return l || r; },
            'and': function(l,r) { return l && r; },
            '%': function(l,r) { return (l % r) === 0; }
        },
        result = operators[operator](operand_1,operand_2);
      
        if (result) return options.fn(this);
        else return options.inverse(this);
    });

    // Keep a list of actors that need to prepareData after 'ready' (generally those that rely on other actor data - passengers/mounts)
    game.postReadyPrepare = [];

    // Log core version
    ageSystem.coreVersion = game.release?.version ?? game.world?.coreVersion;
    ageSystem.systemVersion = game.system?.version ?? game.world?.systemVersion;
  
    // Pre-definition of Health System setting
    const hstype = game.settings.get("age-system", "healthSys");
    const HEALTH_SYS = {
        type: hstype,
        mode: game.settings.get("age-system", "gameMode"),
        // healthName: game.i18n.localize(`SETTINGS.healthMode${game.settings.get("age-system", "healthMode")}`),
        useToughness: ![`basic`].includes(hstype),
        useFortune: [`expanse`].includes(hstype),
        useHealth: [`basic`, `mage`].includes(hstype),
        useInjury: [`mageInjury`, `mageVitality`].includes(hstype),
        useVitality: [`mageVitality`].includes(hstype),
        useBallistic: [`mage`, `mageInjury`, `mageVitality`].includes(hstype),
        baseDamageTN: 13
    };
    ageSystem.damageSource = HEALTH_SYS.useBallistic ? CONFIG.ageSystem.damageSourceOpts.useBallistic : CONFIG.ageSystem.damageSourceOpts.noBallistic;
    ageSystem.healthSys = HEALTH_SYS;

});

Hooks.once("item-piles-ready", () => registerAgeItemPilesIntegration().catch(error => {
        console.error("AGE System | Item Piles integration failed.", error);
        ui.notifications.error(game.i18n.localize("age-system.WARNING.itemPilesIntegrationFailed"));
    }));

Hooks.once("setup", function() {
    // Specific Localization
    Setup.localizePower();
    Setup.abilitiesName();
    Setup.localizeAgeEffects();
    ageSystem.healthSys.healthName = game.i18n.localize(`SETTINGS.healthMode${game.settings.get("age-system", "healthMode")}`);

    // Maximum Talent Degree definition
    const degreeChoice = foundry.utils.deepClone(game.settings.get("age-system", "DegressChoice"));
    const inUseDegrees = ageSystem.talentDegrees[degreeChoice];
    for (let i = 0; i < inUseDegrees.length; i++) {
        inUseDegrees[i] = game.i18n.localize(inUseDegrees[i]);
    }
    ageSystem.talentDegrees.inUse = inUseDegrees;

    // Useful Array containing key of Actor Abilities
    const ablKeys = [];
    for (const k in CONFIG.ageSystem.abilities) {
        if (Object.hasOwnProperty.call(CONFIG.ageSystem.abilities, k)) {
            ablKeys.push(k)
        }
    }
    CONFIG.ageSystem.ABILITY_KEYS = ablKeys;

    // Target/Controlled option to damage/heal
    CONFIG.ageSystem.useTargeted = game.settings.get("age-system", "useTargeted");
    
    // Indicates Migration Version
    CONFIG.ageSystem.lastMigrationVer = game.settings.get("age-system", "systemMigrationVersion")
    Hooks.callAll("ageSystemApiReady", game.ageSystem.api);
});

Hooks.once("ready", async function() {
    AgeActionDelegationService.initialize();
    await migrateBeta1ItemSheetSelections();
    await migrateStableAppV2SheetDefaults();
    await registerAgeSystemTour();
    // The client-scoped setting is the source of truth. Older builds also
    // stored a user flag which could become stale and overwrite the selection.
    const color = applyColorScheme(game.settings.get("age-system", "colorScheme"));
    if (game.user.getFlag("age-system", "colorScheme") !== color) {
        await game.user.setFlag("age-system", "colorScheme", color);
    }

    // Tracker Handling
    // Identify if User already has ageTrackerPos flag set
    const userTrackerFlag = await game.user.getFlag("age-system", "ageTrackerPos");
    const useTracker = (game.settings.get("age-system", "serendipity") || game.settings.get("age-system", "complication") !== "none") ? true : false;
    if (!userTrackerFlag) await game.user.setFlag("age-system", "ageTrackerPos", ageSystem.ageTrackerPos);
    if (useTracker) await game.ageSystem.ageTracker.render({force: true});

    // Safe copy of original Status Effects
    ageSystem.statusEffects.original = statusEffectArray(CONFIG.statusEffects);

    // Define Token Icons and In Use Token Effects
    ageSystem.statusEffects.custom = await game.settings.get("age-system", "customTokenEffects");
    let inUseConditions = await game.settings.get("age-system", "inUseConditions");
    if (!['expanse', 'custom'].includes(inUseConditions)) inUseConditions = 'custom';
    ageSystem.inUseStatusEffects = inUseConditions;
    CONFIG.statusEffects = statusEffectRecord(ageSystem.statusEffects[inUseConditions], [...ageSystem.actorDerivedDataKey, ...ageSystem.charAblKey]);
    
    // Changing a few control icons
    CONFIG.controlIcons.defeated = "systems/age-system/resources/imgs/effects/pirate-grave.svg"

    // Prepare Actors dependent on other Actors
    for(let e of game.postReadyPrepare){
        e.prepareData();
    }
    
    // Register System Settings related to Focus Compendium
    ageSystem.itemCompendia = Settings.allCompendia("Item");
    const rollTables = Settings.allRollTables();
    ageSystem.rollTables = { ...ageSystem.rollTables, ...rollTables };

    Settings.loadCompendiaSettings();
    const setCompendium = game.settings.get("age-system", "masterFocusCompendium");
    ageSystem.focus = Settings.focusList(setCompendium);

    if (automationFeatureEnabled("enableCompendiumIndex")) {
        game.ageSystem.automation.indexReady = ageCompendiumIndex.rebuild().catch(error => {
            console.error("AGE System | Unified compendium index failed.", error);
            return {count: 0, errors: [{message: error?.message ?? String(error)}]};
        });
    }

    // Register Weapon Groups (if any)
    const userGroups = game.settings.get("age-system", "weaponGroups");
    if (userGroups.length === 0) {
        ageSystem.weaponGroups = null;
    } else {
        ageSystem.weaponGroups = userGroups.split(`;`);
        for (let index = 0; index < ageSystem.weaponGroups.length; index++) {
            ageSystem.weaponGroups[index] = ageSystem.weaponGroups[index].trim();
        };
        // Sort Weapon Group names alphabetically
        ageSystem.weaponGroups.sort(function(a, b) {
            let nameA = a.toUpperCase(); // ignore upper and lowercase
            let nameB = b.toUpperCase(); // ignore upper and lowercase
            if (nameA < nameB) {
                return -1;
            }
            if (nameA > nameB) {
                return 1;
            }
            // names must be equal
            return 0;
        });
    }
    // Check if PDFoundry is active
    if (game.modules.get("pdfoundry")?.active) ageSystem.pdfoundryOn = true;

    // Wait to register hotbar drop hook on ready so that modules could register earlier if they want to
    Hooks.on("hotbarDrop", (bar, data, slot) => {
        if (typeof data !== 'object' || data == null) return false;
        let item = null;
        try {
            item = foundry.utils.fromUuidSync(data.uuid);
        } catch (error) {
            console.error("AGE System | Unable to resolve dropped Item UUID.", error);
        }
        if (!item || item.documentName !== "Item") return true;
        const itemType = item.type;
        const rollTypes = ['weapon', 'focus'];
        let hasRoll = rollTypes.includes(itemType)
        if (!hasRoll && itemType === 'power') hasRoll = item.system.hasRoll;
        if (hasRoll) createAgeMacro(item, slot).catch(error => {
            console.error("AGE System | Failed to create hotbar macro.", error);
            ui.notifications.error(game.i18n.localize("age-system.WARNING.macroCreationFailed"));
        });
        return !hasRoll;
    });

    // Determine whether a system migration is required and feasible
    if ( !game.user.isGM ) return;
    const currentVersion = game.settings.get("age-system", "systemMigrationVersion");
    const NEEDS_MIGRATION_VERSION = "4.2.7";
    const needsMigration = !currentVersion || foundry.utils.isNewerVersion(NEEDS_MIGRATION_VERSION, currentVersion);
    if ( !needsMigration ) return;
    await migrations.migrateWorld();
});

Hooks.on('chatMessage', (chatLog, content, userData) => AgeChat.ageCommand(chatLog, content, userData));
Hooks.on("preCreateChatMessage", (message, source) => StructuredChatCardService.prepare(message, source));
Hooks.on("renderageSystemSheetCharacter", (app, html, data) => {Setup.hidePrimaryAblCheckbox(html)});
Hooks.on("renderChatMessageHTML", (app, html, data) => {
    StructuredChatCardService.decorate(app, html);
    AgeChat.addChatListeners(app, html);
    AgeChat.sortCustomAgeChatCards(app, html, data);
});
Hooks.on("updateCombat", combat => {
    CombatLifecycleService.onUpdateCombat(combat).catch(error => console.error("AGE System | Combat lifecycle failed.", error));
    CombatEconomyService.onUpdateCombat(combat).catch(error => console.error("AGE System | Combat economy failed.", error));
});
Hooks.on("deleteCombat", combat => {
    Promise.resolve()
        .then(() => RecoveryService.recordEncounter(combat))
        .then(() => CombatLifecycleService.onDeleteCombat(combat))
        .catch(error => console.error("AGE System | Encounter cleanup failed.", error));
});
Hooks.on("ageSystemActionCompleted", (action, diagnostic) => {
    CombatLifecycleService.onActionCompleted(action, diagnostic).catch(error => console.error("AGE System | Timed effect consumption failed.", error));
    CombatEconomyService.onActionCompleted(action, diagnostic).catch(error => console.error("AGE System | Action economy tracking failed.", error));
});
Hooks.on("updateActor", (actor, changed, options) => {
    CombatEconomyService.onActorUpdate(actor, changed, options).catch(error => console.error("AGE System | Maneuver economy tracking failed.", error));
    ConditionLifecycleService.onActorUpdate(actor, changed, options).catch(error => console.error("AGE System | Condition assistance failed.", error));
});
Hooks.on("getChatMessageContextOptions", AgeChat.addChatMessageContextOptions);
Hooks.on('renderActorSheet', (sheet, html, data) => Setup.prepSheet(sheet, html, data));
Hooks.on('renderItemSheet', (sheet, html, data) => Setup.prepSheet(sheet, html, data));
Hooks.once('diceSoNiceReady', async () => {
    const colorset = game.dice3d.exports.COLORSETS;
    let colorChoices = {};
    for (const type in colorset) {
        if (colorset.hasOwnProperty(type)) {
            const colorCode = colorset[type].name;
            if (colorCode != "custom") {
                const colorName = colorset[type].description;
                const newChoice = {[colorCode]: colorName}
                colorChoices = {
                    ...colorChoices,
                    ...newChoice
                }
            };
        };
    };

    // Register Stunt So Nice setting
    Settings.stuntSoNice(colorChoices, Object.keys(game.dice3d.box.dicefactory.systems));
    
    // Identify if user has registered Dice so Nice Stunt Die option
    const stuntSoNiceFlag = game.user.getFlag("age-system", "stuntSoNice");
    if (stuntSoNiceFlag) await game.settings.set("age-system", "stuntSoNice", stuntSoNiceFlag);
    else await game.user.setFlag("age-system", "stuntSoNice", game.settings.get("age-system", "stuntSoNice"));
});
Hooks.on('renderSettingsConfig', (SettingsConfig, html, data) => {
    Settings.updateFocusCompendia();
    // Settings.updateCompTable(); // TODO - this function will be useful only when dynamic choices for System Settings is implemented
});
// Adding AGE Roller as Canvas Control menu.
Hooks.on(`getSceneControlButtons`, controls => {
    controls["ageroller"] = {
        "name": "ageroller",
        "title": "AGE Roller",
        "icon": "fa-duotone fa-dice",
        "order": 99,
        "activeTool": "age",
        "tools": {
            "age": {
                "name": "age",
                "title": "AGE Toolbox",
                "icon": "fa-solid fa-toolbox",
                "order": 0,
                "button": false
            },
            "ageroll": {
                "name": "ageroll",
                "order": 1,
                "title": "Roll 3D6",
                "icon": "fa-duotone fa-light fa-dice",
                "button": true,
                onChange: (event, active) => {
                    const rollData = {
                        event,
                        flavor: game.user.name,
                        flavor2: game.i18n.localize("age-system.chatCard.looseRoll")
                    }
                    return Dice.ageRollCheck(rollData);
                },
            },
            "singleroll": {
                "name": "singleroll",
                "order": 2,
                "title": "Roll 1D6",
                "icon": "fa-duotone fa-light fa-dice-six",
                "button": true,
                "activate": true,
                onChange: async (event, active) => {
                    let roll = await new Roll("1d6").evaluate();
                    return roll.toMessage({}, {messageMode: event?.shiftKey ? MESSAGE_MODES.BLIND : getCoreMessageMode()});
                }
            },
            "d66": {
                "name": "d66",
                "order": 3,
                "title": "D66",
                "icon": "fa-regular fa-2",
                "button": true,
                onChange: async (event, active) => {
                    let roll = await new Roll("1d6*10 + 1d6").evaluate();
                    return roll.toMessage({}, {messageMode: event?.shiftKey ? MESSAGE_MODES.BLIND : getCoreMessageMode()})
                }
            },
            "d666": {
                "name": "d666",
                "order": 4,
                "title": "D666",
                "icon": "fa-regular fa-3",
                "button": true,
                onChange: async (event, active) => {
                    let roll = await new Roll("1d6*100 + 1d6*10 + 1d6").evaluate();
                    return roll.toMessage({}, {messageMode: event?.shiftKey ? MESSAGE_MODES.BLIND : getCoreMessageMode()})
                }
            },
            // Figure out a way to select token when using this tool!!!
            "breather": {
                "name": "breather",
                "order": 5,
                "title": "age-system.breather",
                "icon": "fa-regular fa-briefcase-medical",
                "button": true,
                onChange: (event, active) => applyBreather(MESSAGE_MODES.SELF)
            },
            "conditions": {
                "name": "conditions",
                "order": 6,
                "title": "age-system.conditionsWorkshop",
                "icon": "fa-solid fa-list",
                "button": true,
                "visible": game.user.isGM,
                onChange: (event, active) => new ConditionsWorkshop().render(true)
            },
            "importer": {
                "name": "importer",
                "order": 7,
                "title": "age-system.ageImporter",
                "icon": "fa-regular fa-file-import",
                "button": true,
                "visible": game.user.isGM,
                onChange: (event, active) => new AgeImporter().render(true)
            },
            "library": {
                "name": "library",
                "order": 8,
                "title": "age-system.AUTOMATION.librarySearch",
                "icon": "fa-solid fa-magnifying-glass",
                "button": true,
                "visible": automationFeatureEnabled("enableCompendiumIndex"),
                onChange: () => new UnifiedAgeSearch().render(true)
            },
            "undo": {
                "name": "undo",
                "order": 9,
                "title": "age-system.AUTOMATION.undoLastAction",
                "icon": "fa-solid fa-rotate-left",
                "button": true,
                "visible": automationFeatureEnabled("enableActionUndo"),
                onChange: async () => {
                    try {
                        const entry = await AgeTransactionService.undoLast();
                        if (!entry) return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.nothingToUndo"));
                        return ui.notifications.info(game.i18n.format("age-system.AUTOMATION.actionUndone", {action: entry.label}));
                    } catch (error) {
                        console.error("AGE System | Undo failed.", error);
                        return ui.notifications.error(game.i18n.format("age-system.AUTOMATION.undoFailed", {reason: error.message}), {permanent: true});
                    }
                }
            },
            "advancedTests": {
                "name": "advancedTests",
                "order": 10,
                "title": "age-system.AUTOMATION.advancedTests",
                "icon": "fa-solid fa-bars-progress",
                "button": true,
                "visible": automationFeatureEnabled("enableAdvancedTests"),
                onChange: () => AdvancedTestService.open()
            },
            "actionDiagnostics": {
                "name": "actionDiagnostics",
                "order": 14,
                "title": "age-system.AUTOMATION.actionDiagnostics",
                "icon": "fa-solid fa-stethoscope",
                "button": true,
                "visible": automationFeatureEnabled(),
                onChange: () => AgeActionDiagnostics.open()
            },
            "requestedRolls": {
                "name": "requestedRolls",
                "order": 11,
                "title": "age-system.AUTOMATION.requestedRolls",
                "icon": "fa-solid fa-bullhorn",
                "button": true,
                "visible": game.user.isGM && automationFeatureEnabled("enableRequestedRolls"),
                onChange: () => RequestedRollService.open()
            },
            "recoveryAssistant": {
                "name": "recoveryAssistant",
                "order": 12,
                "title": "age-system.AUTOMATION.recoveryAssistant",
                "icon": "fa-solid fa-bed",
                "button": true,
                "visible": automationFeatureEnabled("enableRecoveryAutomation"),
                onChange: () => RecoveryService.open()
            },
            "combatEconomy": {
                "name": "combatEconomy",
                "order": 13,
                "title": "age-system.AUTOMATION.combatEconomy",
                "icon": "fa-solid fa-hourglass-half",
                "button": true,
                "visible": automationFeatureEnabled("enableCombatEconomy"),
                onChange: () => CombatEconomyService.open()
            },
            "help": {
                "name": "help",
                "order": 15,
                "title": "AGE System (unofficial) Wiki",
                "icon": "fa-regular fa-circle-info",
                "button": true,
                onChange: (e, a) => window.open(ageSystem.wiki, '_blank')
            }
        }
    }
});
