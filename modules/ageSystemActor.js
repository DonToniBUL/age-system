import { ageSystem } from "./config.js";
import * as Dice from "./dice.js";
import { getCoreMessageMode, normalizeMessageMode, statusEffectArray } from "./compat.js";
import { CLASS_ADVANCEMENT_VERSION } from "./class-advancement.js";
import { showFormDialog } from "./dialogs.js";
import {AgeTransactionService} from "./automation/action-transactions.js";
import {characterControlUpdatePreservesSource} from "./data/source-guard.js";
import {applyCharacterGameModeFallbacks} from "./data/character-source.js";
import {
    mutateAtomicSystemUpdate,
    normalizeCharacterAtomicSystemUpdate
} from "./data/atomic-system-updates.js";

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export class ageSystemActor extends foundry.documents.Actor {

    /** @override */
    prepareData() {
        super.prepareData();
        // Sorting Items for final data preparation
        const items = this.items;
        if (this.type === 'char') {
            // First prepare Focus
            items.forEach(i => {
                if (i.type === "focus") {
                    i.prepareData();
                    // i.sheet.render(false); // Removed as this was causing owned Items' sheet to render using Base Sheet instead of AGE System Item Sheet
                }
            })
            // Then prepare other item types which require further prep
            items.forEach(i => {
                if (["weapon", "power"].includes(i.type)) {
                    i.prepareData();
                    // i.sheet.render(false); // Removed as this was causing owned Items' sheet to render using Base Sheet instead of AGE System Item Sheet
                }
            })
            
            // Calculate Initiative based on Focus (if set on System Settings)
            const initiativeFocus = game.settings.get("age-system", "initiativeFocus");
            if (initiativeFocus) {
                const init = this.checkFocus(initiativeFocus);
                this.system.initiative += init.value;
            }
        }
    }

    /** @override */
    async _preCreate(data, options, userId) {
        const allowed = await super._preCreate(data, options, userId);
        if (allowed === false) return false;
        const updates = {};
        if (!data.img || data.img === CONST.DEFAULT_TOKEN) updates.img = ageSystem.actorIcons[this.type];

        // AnyField cleaning does not fill members of a supplied partial
        // object. Rebuild creation-time system branches against the registered
        // template so imports and third-party Actor.create calls cannot begin
        // life with incomplete Health, ability, vehicle, or campaign data.
        const requestedSystem = data.system && typeof data.system === "object"
            ? foundry.utils.deepClone(data.system)
            : {};
        if (this.type === "char" && data.system?.health?.value === undefined) {
            const initialHealth = Number(this.system.health?.max ?? this.system.health?.set);
            if (Number.isFinite(initialHealth)) foundry.utils.setProperty(requestedSystem, "health.value", initialHealth);
        }
        if (Object.keys(requestedSystem).length > 0) {
            const templateSystem = game.model?.Actor?.[this.type] ?? this._source?.system ?? {};
            updates.system = normalizeCharacterAtomicSystemUpdate(
                {system: requestedSystem},
                {system: templateSystem}
            ).system;
        }
        this.updateSource(updates);
        return true;
    }

    /** @override */
    async _preUpdate(changed, options, userId) {
        // AGE Actor compatibility objects are top-level AnyFields. Normalize
        // every partial object update before Foundry performs its atomic field
        // commit so automation, legacy sheets, macros, advancement, and undo
        // receive the same source-preserving boundary as Character AppV2.
        mutateAtomicSystemUpdate(changed, this._source, {recursive: options?.recursive});
        const allowed = await super._preUpdate(changed, options, userId);
        if (allowed === false) return false;
        if (this.type !== "char") return allowed;
        if (Array.isArray(options?.ageSystemCharacterPaths) && !characterControlUpdatePreservesSource(
            changed,
            this._source,
            options.ageSystemCharacterPaths
        )) {
            throw new Error("AGE System blocked a Character edit which would change unrelated stored data.");
        }
        if (options?.classAdvancement || options?.classAdvancementRollback || options?.classAdvancementRecovery || options?.ageSystemMigration) return allowed;

        const hasLevelChange = Object.prototype.hasOwnProperty.call(changed ?? {}, "system.level")
            || Object.prototype.hasOwnProperty.call(changed?.system ?? {}, "level");
        if (!hasLevelChange) return allowed;

        const items = Array.isArray(this.items) ? this.items : (this.items?.contents ?? Array.from(this.items ?? []));
        const activeClass = items.find(item => item.type === "class" && (
            Number(item.system?.level) > 0
            || Number(item.system?.progression?.legacyLevel) > 0
            || (this.system?.classProgression?.transactions ?? []).some(transaction => transaction.classItemId === item.id)
        ));
        if (!activeClass) return allowed;

        ui.notifications.warn(game.i18n.localize("age-system.WARNING.classManagedLevel"));
        return false;
    }

    prepareBaseData() {
        super.prepareBaseData();
        const actorData = this;
        const data = actorData.system;

        // Check if split Armor is in use
        // data.useBallisticArmor = game.settings.get("age-system", "useBallisticArmor");

        // Retrieve wealth mode
        data.useResources = data.useIncome = data.useCurrency = data.useCoins = false;
        const wealthMode = game.settings.get("age-system", "wealthType");
        switch (wealthMode) {
            case "income":
                data.useIncome = true;
                break;
            case "resources":
                data.useResources = true;
                break;
            case "currency":
                data.useCurrency = true;
                break;
            case "coins":
                data.useCoins = true;
                break;
            default:
                break;
        };

        switch (actorData.type) {
            case "char":
                this._prepareBaseDataChar();
                break;
            case "vehicle":
                this._prepareBaseDataVehicle();
                break;
            case "spaceship":
                this._prepareBaseDataSpaceship();
                break;
            default:
                break;
        }
    }

    /** @override */
    prepareEmbeddedDocuments() {
        super.prepareEmbeddedDocuments();
        
        // Apply Item Modifiers to Actor before applying Active Effects!
        this.applyItemModifiers();
    }

    prepareDerivedData() {
        super.prepareDerivedData();
        const actorData = this;
        const data = actorData.system;

        switch (actorData.type) {
            case "char":
                this._prepareDerivedDataChar();
                break;
            case "vehicle":
                this._prepareDerivedDataVehicle();
                break;
            case "spaceship":
                this._prepareDerivedDataSpaceship();
                break;        
            default:
                break;
        }
    };

    _prepareBaseDataChar() {
        const actorData = this;
        const data = actorData.system;

        // Keep preparation safe if a partial legacy ability object survives
        // from an interrupted candidate edit. AppV2 Character submissions now
        // preserve and update this AnyField as one complete atomic branch.
        data.abilities ??= {};
        const abilityDefaults = game.model?.Actor?.char?.abilities ?? {};
        for (const key of Object.keys(ageSystem.abilitiesTotal)) {
            data.abilities[key] ??= foundry.utils.deepClone(abilityDefaults[key] ?? {
                value: 0,
                primary: false,
                lastUp: false,
                testMod: 0,
                advances: 0
            });
        }
        
        data.classBonuses ??= {health: 0, powerPoints: 0, conviction: 0, defense: 0, toughness: 0};
        data.classProgression ??= {version: CLASS_ADVANCEMENT_VERSION, baseLevel: null, transactions: []};
        data.classProgression.version = CLASS_ADVANCEMENT_VERSION;
        data.classProgression.transactions = Array.isArray(data.classProgression.transactions) ? data.classProgression.transactions : [];

        // Check if Conviction is in use
        data.useConviction = game.settings.get("age-system", "useConviction");

        // Check if Toughness is in use
        // data.useToughness = game.settings.get("age-system", "useToughness");

        // Check if Fatigue is in use
        data.useFatigue = game.settings.get("age-system", "useFatigue");

        // Check if Power Points is in use
        data.usePowerPoints = game.settings.get("age-system", "usePowerPoints");

        /**************************/
        /**    Configure MODE    **/
        /**************************/
        if (this.type === 'char') this._configureCharGameMode();

        // Ensure Fatigue has valid Values and creates Status text
        if (data.fatigue.entered > data.fatigue.max) data.fatigue.entered = data.fatigue.max;
        if (data.fatigue.entered < 0) data.fatigue.entered = 0;
        data.fatigue.value = data.fatigue.entered;
        switch (data.fatigue.value) {
            case 0:
                data.fatigue.status = game.i18n.localize(ageSystem.fatigueConditions.noFatigue);
            break;
            case 1:
                data.fatigue.status = game.i18n.localize(ageSystem.fatigueConditions.winded);
            break;
            case 2:
                data.fatigue.status = game.i18n.localize(ageSystem.fatigueConditions.fatigued);
            break;
            case 3:
                data.fatigue.status = game.i18n.localize(ageSystem.fatigueConditions.exhausted);
            break;
            case 4:
                data.fatigue.status = game.i18n.localize(ageSystem.fatigueConditions.dying);
            break;            
                                            
            default:
                break;
        };

        // Injury Degrees and Injury Marks
        const gameMode = game.settings.get("age-system", "gameMode");
        if (gameMode === 'none') data.injury.degrees.severeMult = 2;
        if (gameMode === 'gritty') data.injury.degrees.severeMult = 3;
        if (gameMode === 'pulp') data.injury.degrees.severeMult = 2;
        if (gameMode === 'cinematic') data.injury.degrees.severeMult = 1;
        data.injury.totalDegrees = data.injury.degrees.light + data.injury.degrees.serious + data.injury.degrees.severe;
        const expectedMarks = data.injury.degrees.light + data.injury.degrees.serious + data.injury.degrees.severe * data.injury.degrees.severeMult;
        const diffMarks = expectedMarks - data.injury.marks
        const marksArray = Array.from({length: data.injury.degrees.severeMult}, () => false)
        if (data.injury.degrees.severe) {
            for (let m = 0; m < marksArray.length; m++) {
                marksArray[m] = diffMarks <= m ? true : false
            }
        }
        data.injury.marksArray = marksArray;

    };

    _configureCharGameMode() {
        const actorData = this;
        const data = actorData.system;
        const gmode = data.gameMode;

        if (!gmode?.specs) return;
        
        // Keep the active mode visible without replacing persisted Character
        // resources during preparation. AppV2 submits one native control at a
        // time; deriving these source fields from a second stored profile made
        // a successful Health/Defense edit appear to revert after preparation.
        // Profile values remain available as legacy presets and are used only
        // as a fallback when an old document genuinely lacks the direct field.
        if (!gmode.override) gmode.selected = ageSystem.healthSys?.mode ?? gmode.selected ?? "none";
        const m = gmode.selected;
        const specs = gmode.specs[m] ?? gmode.specs.none ?? Object.values(gmode.specs)[0];
        if (!specs) return;
        
        applyCharacterGameModeFallbacks(data, this._source?.system, specs);
    }

    applyItemModifiers() {
        const type = this.type;

        switch (type) {
            case "char":
                this._charItemModifiers();
                break;
            case "spaceship":
                this._spaceshipItemModifiers();
                break;
            case "vehicle": 
                break;
            default:
                break;
        }
    }

    _charItemModifiers() {
        // Create Actor data with Modifiers from all Active/Equiped Items
        const mods = {};
        this.items.forEach(i => {
            const iMods = i.system.modifiersByType;
            const active = i.system.activate || i.system.equiped;
            if (!foundry.utils.isEmpty(iMods) && active) {
                for (const k in iMods) {
                    if (Object.hasOwnProperty.call(iMods, k)) {
                        if (mods[k]) {
                            mods[k].parts = [...mods[k].parts, ...iMods[k]];
                        } else {
                            mods[k] = {parts: iMods[k]};
                        }
                    }
                }
            }
        });

        // Calculate total Formula for Each Modifier
        for (const mtype in mods) {
            if (Object.hasOwnProperty.call(mods, mtype)) {
                const mPack = mods[mtype];
                mPack.totalFormula = "";
                mPack.badMods = [];
                for (let i = 0; i < mPack.parts.length; i++) {
                    const p = mPack.parts[i];
                    if (p.valid && p.isActive) {
                        if (mPack.totalFormula !== "") mPack.totalFormula += " + ";
                        mPack.totalFormula += `${p.formula}`;
                    } else {
                        mPack.badMods.push(i)
                    };
                    if (i === mPack.parts.length - 1) {
                        mPack.formParts = Dice.resumeFormula(mPack.totalFormula, foundry.utils.deepClone(this.actorRollData()));
                    }
                }
            }
        }

        const actorData = this;
        const data = actorData.system;
        data["ownedMods"] = mods;

     
    }

    _prepareDerivedDataChar() {
        // Calculate Abilities
        const actorData = this;
        const data = actorData.system;
        const mods = data.ownedMods;
        
        // Applying Abilities mods
        const settingAbls = ageSystem.abilities;
        for (const ablKey in settingAbls) {
            if (settingAbls.hasOwnProperty(ablKey)) {
                data.abilities[ablKey].mod = finiteNumber(mods[ablKey]?.formParts?.detValue) + finiteNumber(data.abilities[ablKey].mod);
                data.abilities[ablKey].value = finiteNumber(data.abilities[ablKey].value);
                data.abilities[ablKey].total = data.abilities[ablKey].mod + data.abilities[ablKey].value;
                data.abilities[ablKey].testMod = finiteNumber(mods[`${ablKey}Test`]?.formParts?.detValue) + finiteNumber(data.abilities[ablKey].testMod);
            };
        };

        // Calculate derived data
        this._preparePostModCharData();
        
    }

    _preparePostModCharData() {
        const actorData = this;
        const data = actorData.system;
        const mods = data.ownedMods;

        // Recalculate all Mods to ensure contribution from Abilities are updated
        const recalcMod = data.ownedMods;
        for (const k in recalcMod) {
            if (Object.hasOwnProperty.call(recalcMod, k)) {
                const mGroup = recalcMod[k];
                mGroup.formParts = Dice.resumeFormula(mGroup.totalFormula, foundry.utils.deepClone(this.actorRollData()));
            }
        }        

        // Armor Penalty & Strain
        data.armor.penalty = Math.max(mods?.armorPenalty?.formParts?.detValue ?? 0, 0);
        data.armor.strain = Math.max(mods?.armorStrain?.formParts?.detValue ?? 0, 0);

        // All damage delt by Actor
        data.dmgMod = mods?.actorDamage?.totalFormula ?? (data.dmgMod ?? "0");

        // Actor All Tests
        const testModFormula = mods?.testMod?.totalFormula;
        data.testMod = testModFormula ? Dice.resumeFormula(mods?.testMod?.totalFormula, this.actorRollData()).detValue : 0;

        // Actor All Attacks Mod
        const attkModFormula = mods?.attackMod?.totalFormula;
        data.attackMod = attkModFormula ? Dice.resumeFormula(mods?.attackMod?.totalFormula, this.actorRollData()).detValue : 0;

        // Defense
        data.defense.mod = mods?.defense?.formParts?.detValue ?? 0;

        // Impact Armor
        data.armor.impact = (mods?.impactArmor?.formParts?.detValue ?? 0) + (data.armor.impact ?? 0);

        // Ballistic Armor
        data.armor.ballistic = (mods?.ballisticArmor?.formParts?.detValue ?? 0) + (data.armor.ballistic ?? 0);

        // Toughness
        data.armor.toughness.mod = mods?.toughness?.formParts?.detValue ?? 0;

        // Speed
        data.speed.mod = mods?.speed?.formParts?.detValue ?? 0;

        // Defend Maneuver (bonus to Defense)
        data.defend.mod = mods?.defendMnv?.formParts?.detValue ?? 0;

        // Guard Up Maneuver
        data.guardUp.mod = mods?.guardupMnv?.formParts?.detValue ?? 0;

        // All Out Attack
        data.allOutAttack.mod = mods?.allOutAtkMnv?.formParts?.detValue ?? 0;

        // Max Health
        data.health.mod = mods?.maxHealth?.formParts?.detValue ?? 0;

        // Max Conviction
        data.conviction.mod = mods?.maxConviction?.formParts?.detValue ?? 0;

        // Max Power Points
        data.powerPoints.mod = mods?.maxPowerPoints?.formParts?.detValue ?? 0;

        // Aim Maneuver
        data.aim.mod = mods?.aimMnv?.formParts?.detValue ?? 0;

        // Power Force
        // This bonus must be treated on each Item

       // Calculate total Defense
        data.defense.total = 0;
        if (data.defend.active) {data.defense.total += finiteNumber(data.defend.defenseBonus) + finiteNumber(data.defend.mod)};
        if (data.guardUp.active) {data.defense.total += finiteNumber(data.guardUp.defenseBonus) + finiteNumber(data.guardUp.mod)};
        data.defense.total += finiteNumber(data.abilities.dex.total) + finiteNumber(data.defense.base) + finiteNumber(data.defense.mod)
            + finiteNumber(data.defense.gameModeBonus) + finiteNumber(data.classBonuses?.defense);
        if (data.allOutAttack.active) {
            data.defense.total -= Math.abs(Number(data.allOutAttack.defensePenalty));
        };
        if (data.defense.total < 0) {data.defense.total = 0};

        // Calculate toughness
        data.armor.toughness.total = finiteNumber(data.abilities.cons.total) + finiteNumber(data.armor.toughness.gameModeBonus)
            + finiteNumber(data.armor.toughness.mod) + finiteNumber(data.classBonuses?.toughness);

        // Calculate Speed
        data.speed.total = finiteNumber(data.abilities.dex.total) - Math.abs(finiteNumber(data.armor.penalty))
            + finiteNumber(data.speed.base) + finiteNumber(data.speed.mod)
        
        // Calculate Max Health
        data.health.max = finiteNumber(data.health.mod) + finiteNumber(data.health.set) + finiteNumber(data.classBonuses?.health);

        // Calculate Max Power Points
        data.powerPoints.max = finiteNumber(data.powerPoints.mod) + finiteNumber(data.powerPoints.set) + finiteNumber(data.classBonuses?.powerPoints);

        // Calculate Max Conviction
        data.conviction.max = finiteNumber(data.conviction.mod) + finiteNumber(data.conviction.set) + finiteNumber(data.classBonuses?.conviction);

        // Calculates total Initiative
        data.initiative = finiteNumber(data.initiativeMod) + finiteNumber(data.abilities.dex.total) - finiteNumber(data.armor.penalty);

        // Test-based wealth and single currency use separate canonical fields.
        data.resources.total = finiteNumber(data.resources.base) + finiteNumber(data.resources.mod);
        data.currency = Number(data.currency) || 0;
    };

    _spaceshipItemModifiers() {
        const actorData = this;
        const data = actorData.system;

        // Items With Mod
        const ownedItems = actorData.items.filter(i => !['special', 'rollable', 'weapon'].includes(i.system.type));
        let bonuses = {};
        ownedItems.map(f => {
            const item = f.system;
            const dataType = item.type;
            if (!bonuses[dataType]) {
                bonuses = {
                    ...bonuses,
                    [dataType]: 0
                };
            };
            bonuses[dataType] += item[dataType];
        })

        data.itemMods = bonuses;
    }

    _prepareBaseDataVehicle() {
        const actorData = this;
        const data = actorData.system;

        data.defenseTotal = 10;
        this.sortPassengers();
        data.pob = data.passengers.length;

    };

    _prepareDerivedDataVehicle() {

    };

    _prepareBaseDataSpaceship() {
        const actorData = this;
        const data = actorData.system;
        this.sortPassengers();

        data.pob = data.passengers.length;
        
        for (const loss in data.losses) {
            if (Object.hasOwnProperty.call(data.losses, loss)) {
                const severity = data.losses[loss];
                for (const type in severity) {
                    if (Object.hasOwnProperty.call(severity, type)) {
                        severity[type].maxArray = new Array(severity[type].max);
                        for (let b = 0; b < severity[type].maxArray.length; b++) {
                            severity[type].maxArray[b] = ((severity[type].actual-1) >= b) ? true : false;                    
                        }                        
                    }
                }
                
            }
        };

        // Calculated Total value for various aspects
        const systems = data.systems;
        const nloss = data.losses.normal;

        systems.sensors.loss = -Number(nloss.sensors.actual);
        systems.sensors.total = Number(systems.sensors.base) + Number(systems.sensors.mod) + systems.sensors.loss;

        systems.maneuver.loss = -Number(nloss.maneuverability.actual);
        systems.maneuver.total = Number(systems.maneuver.base) + Number(systems.maneuver.mod) + systems.maneuver.loss;

        systems.command.total = Number(systems.command.base) + Number(systems.command.mod);
        systems.damageControl.total = Number(systems.damageControl.base) + Number(systems.damageControl.mod);

        data.sizeNumeric = Number(data.size);
        data.hull.base = ageSystem.spaceshipHull[data.sizeNumeric - 1];

        data.crew.min = ageSystem.spaceshipCrew[data.sizeNumeric - 1].min
        data.crew.typical = ageSystem.spaceshipCrew[data.sizeNumeric - 1].typ

        data.crewPenalty = this._addCrewPenalty(data.sizeNumeric, data.crew.current, data.crew.min);

        return data
    }

    _addCrewPenalty(size, current, min) {
        if (current >= min) return 0;
        const sizeArray = ageSystem.spaceshipCrew;
        const sizePos = size - 1;
        let steps;
        for (let s = 0; s < sizeArray.length; s++) {
            const minC = sizeArray[s].min; 
            const diff = current - minC;
            if (diff < 0) {
                steps = s;
                break;
            }
        }
        const diff = sizePos - steps + 1;
        const penalty = 2 * diff;
        return -penalty;
    };

    _prepareDerivedDataSpaceship() {
        const actorData = this;
        const data = actorData.system;

        data.hull.baseMod = this._addSizeMod(data.sizeNumeric, data.itemMods.hullMod);
        data.hull.total = this._addHullPlatingLoss(data.hull.baseMod, data.itemMods.hullPlating);
        data.systems.sensors.total = this._addSensorBonus(data.systems.sensors.base, data.systems.sensors.mod, data.itemMods?.sensorMod);
    };

    _addSensorBonus(base, mod, bonus) {
        const sensorLoss = -this.system.losses.normal.sensors.actual;
        if (!bonus) bonus = 0;
        return base + mod + bonus + sensorLoss;
    }

    _addSizeMod(size, mod) {
        if (!mod) return this.system.hull.base;
        let newSize = size + mod;
        if (newSize < 1) newSize = 1;
        if (newSize > ageSystem.spaceshipHull.length) newSize = ageSystem.spaceshipHull.length;
        const newHull = ageSystem.spaceshipHull[newSize - 1];
        return newHull;
    }

    _addHullPlatingLoss(hull, plating) {
        const hullLoss = -this.system.losses.normal.hull.actual;
        if (Math.abs(hullLoss) === 0 && !plating) return hull;
        if (!plating) plating = 0;
        const platLoss = hullLoss + Number(plating);
        if (platLoss === 0) return hull;
        if (hull == 1) return platLoss + Number(hull); 
        const modulus = Math.abs(Number(platLoss));
        const newPart = platLoss >= 0 ? `+${modulus}` : `-${modulus}`;
        const newHull = `${hull}${newPart}`;
        return newHull;
    }

    sortWeapon(weapon) {
        if (!weapon) return {};
        let wArray = [];
        for (const w in weapon) {
            if (Object.hasOwnProperty.call(weapon, w)) {
                wArray.push(weapon[w]);
            }
        }
        wArray = wArray.sort(function(a, b) {
            const nameA = a.name.toLowerCase();
            const nameB = b.name.toLowerCase();
            if (nameA < nameB) {
                return -1;
            }
            if (nameA > nameB) {
                return 1;
            }
            return 0;
        });
        const newWpnObj = {};
        for (let w = 0; w < wArray.length; w++) {
            // const element = wArray[w];
            let wKey = String(w);
            while (wKey.length < 4) {
                wKey = "0" + wKey;
            }
            newWpnObj[wKey] = wArray[w];
        }
        return newWpnObj;
    }

    // Função em uso para Spaceship
    sortPassengers() {
        const data = this.system;
        data.passengers = Array.isArray(data.passengers) ? data.passengers : [];
        const passengers = data.passengers;
        let invalidPassengers = [];
        for (let pi = 0; pi < passengers.length; pi++) {
            const p = passengers[pi];
            if (!game.actors) {
                game.postReadyPrepare.push(this);
            } else {
                const pData = p.isToken ? game.actors.tokens?.[p.id] : game.actors.get(p.id);
                if (!pData) {
                    invalidPassengers.push(pi);
                } else {
                    p.name = pData.name;
                    p.picture = pData.prototypeToken.texture.src;
                };
                // Prepare Vehicle derived data
                if (this.type === 'vehicle') {
                    if (p.id === data.conductor && pData) {
                        p.isConductor = true;
                        const defenseAbl = Number(pData.system.abilities?.[data.handling.useAbl]?.total) || 0;
                        const defenseFocus = pData.checkFocus?.(data.handling.useFocus);
                        const defenseValue = Number(defenseFocus?.focusItem?.system?.initialValue) || 0;
                        data.defenseTotal += defenseAbl + defenseValue;
                    } else {
                        p.isConductor = false;
                    }
                };
            }
        }
        // Remove passengers whose sheets/tokens are not valid anymore
        for (let ip = invalidPassengers.length - 1; ip >= 0; ip--) {
            const i = invalidPassengers[ip];
            passengers.splice(i, 1);
        };

    };

    _vehicleOperator(operatorData) {
        if (!operatorData) return null;
        let operator;
        if (operatorData.isToken) operator = game.actors.tokens?.[operatorData.id];
        if (!operatorData.isToken) operator = game.actors.get(operatorData.id);
        if (!operator) {
            const parts = {name: operatorData.name ?? game.i18n.localize("age-system.unknown"), id: operatorData.id};
            let warning = game.i18n.format("age-system.WARNING.userNotAvailable", parts);
            ui.notifications.warn(warning);
            return null;
        }
        return operator;
    }

    rollVehicleDamage(damageData) {
        const operator = this._vehicleOperator(damageData.operatorData);
        const vehicleUseFocus = this.system.handling.useFocus
        const useFocus = operator ? operator.checkFocus(vehicleUseFocus) : null;

        damageData = {
            ...damageData,
            operator,
            useFocus,
            vehicle: this
        };

        return Dice.vehicleDamage(damageData);
    };

    /**
     * Retrieve object with Focus details if Actor owns focus matching the name informed
     * @param {string} namedFocus String with Focus name to be checked in actor inventory
     * @returns Object with focusName {string}, focusItem {ageSystemItem}, id {string} and value {number}.
     */
    checkFocus(namedFocus) {
        if (!namedFocus || namedFocus == "") return {focusName: null, focusItem: null, id: null, value: 0}

        const ownedFoci = this.items?.filter(a => a.type === "focus");
        const expectedFocus = namedFocus.toLowerCase();
        const validFocus = ownedFoci?.filter(c => c.name.toLowerCase() === expectedFocus);
        if (validFocus?.length > 0) {
            const focusId = validFocus[0].id;
            const focus = this.items.get(focusId);
            return {focusName: namedFocus, focusItem: focus, id: focusId, focusAbl: focus.system.useAbl, value: focus.system.finalValue}
        } else {
            return {focusName: namedFocus, focusItem: false, id: null, value: 0}
        }
    }

    async toughnessTest (parts = [], rollTN, applyInjury = false, {transaction = null} = {}) {
        const injuryParts = Array.isArray(parts) ? foundry.utils.deepClone(parts) : [];
        injuryParts.push({
            label: game.i18n.localize("age-system.injuryMarks"),
            value: -this.system.injury.marks
        });
        const rollData = {
          actor: this,
          event: {type: "click"},
          rollTN,
          rollType: applyInjury ? ageSystem.ROLL_TYPE.TOUGHNESS_AUTO : ageSystem.ROLL_TYPE.TOUGHNESS,
          moreParts: injuryParts,
          flavor: this.name,
          flavor2: `${game.i18n.localize("age-system.toughnessTest")}`
        };
        const toughTest = await Dice.ageRollCheck(rollData);
        const data = toughTest?.flags?.["age-system"]?.ageroll?.rollData;
        if (!data) throw new Error("AGE System | Toughness test did not create a valid roll card.");
        if (applyInjury && data.isSuccess !== null && !data.isSuccess) await this.applyInjury(data.injuryDegree, {transaction});
        return toughTest;
    }

    /**
     * Apply a Injury Degree and applicable Injury Marks to the Actor.
     * This allows for damage to be scaled by a multiplier to account for healing, critical hits, or resistance
     * @param {string} injuryDegree     The chat entry which contains the roll data
     * @returns {object}                Object with relevant data to identify Actor and new Injury values
     * @returns {false}                 If Injury Alternate Damage is not in use or if Actor is not of applicable type
     */
    async applyInjury (injuryDegree, {transaction = null} = {}) {
        if (!ageSystem.healthSys.useInjury) return false;
        if (this.type !== 'char') return false;
        if (!['light', 'serious', 'severe'].includes(injuryDegree)) return false;
        // Identify correct path and new amount for that degree
        const updateDegree = `system.injury.degrees.${injuryDegree}`;
        const newDegree = this.system.injury.degrees[injuryDegree] + 1;
        // Carries totalInjuries to summary
        const totalInjuries = foundry.utils.deepClone(this.system.injury.degrees);
        totalInjuries[injuryDegree] = newDegree;
        // Calculate new marks
        let newMarks = (injuryDegree === 'severe') ? this.system.injury.degrees.severeMult : 1;
        newMarks += this.system.injury.marks;
        const ownTransaction = !transaction;
        transaction ??= AgeTransactionService.begin({
            label: `${this.name}: ${game.i18n.localize(`age-system.${injuryDegree}InjuryInflicted`)}`,
            type: 'injury',
            sourceUuid: this.uuid
        });
        transaction.track(this, [updateDegree, 'system.injury.marks']);
        try {
            // Update Actor's injuries and marks
            await this.update(
                {
                    [updateDegree]: newDegree,
                    'system.injury.marks': newMarks
                },
                {
                    diffHP: {
                        value: game.i18n.localize(`age-system.${injuryDegree}InjuryInflicted`),
                        type: 'injury'
                    }
                }
            );
            if (ownTransaction) await transaction.commit();
        } catch (error) {
            if (ownTransaction) await transaction.rollback({removeHistory: true});
            throw error;
        }
        // Returns a summary object
        return {
            name: this.name,
            img: (this.isToken ? this.token?.texture?.src : this.prototypeToken?.texture?.src) ?? this.img,
            degree: injuryDegree,
            totalInjuries,
            newMarks
        }
    }

    /**
     * Heals a number of Injury Marks Character 
     * @param {number} qtd  Quantity of Injury Marks to be healed
     * @returns {Promise<boolean>} False if Character type or qtd is invalid, True otherwise
     */
    async healMarks (qtd, {transaction = null} = {}) {
        if (this.type !== 'char') return false
        if (Number.isNaN(Number(qtd))) return false
        qtd = Math.abs(Number(qtd));
        let totalHealed = 0
        const injuries = foundry.utils.deepClone(this.system.injury);
        const marks = injuries.marks;
        if (marks === 0) return true

        for (let m = 0; m < qtd; m++) {
            injuries.marks -= 1;
            if (injuries.degrees.severe > 0) {
                totalHealed += 1;
                const expectedMarks = injuries.degrees.light + injuries.degrees.serious + injuries.degrees.severe * injuries.degrees.severeMult;
                if (expectedMarks - (injuries.marks) === injuries.degrees.severeMult) {
                    injuries.degrees.severe -= 1
                }
            } else {
                if (injuries.degrees.serious > 0) {
                    totalHealed += 1;
                    injuries.degrees.serious -= 1;
                } else {
                    if (injuries.degrees.light > 0) {
                        totalHealed += 1;
                        injuries.degrees.light -= 1;
                    }
                }
            }
            if (injuries.marks === 0) break;
        }
        const updateData = {
            "system.injury.marks": injuries.marks,
            "system.injury.degrees.light": injuries.degrees.light,
            "system.injury.degrees.serious": injuries.degrees.serious,
            "system.injury.degrees.severe": injuries.degrees.severe,
        }
        const ownTransaction = !transaction;
        transaction ??= AgeTransactionService.begin({
            label: `${this.name}: ${game.i18n.localize('age-system.item.healing')}`,
            type: 'healing',
            sourceUuid: this.uuid
        });
        transaction.track(this, Object.keys(updateData));
        try {
            await this.update(updateData, {diffHP: {
                value: totalHealed,
                type: 'numeric'
            }});
            if (ownTransaction) await transaction.commit();
        } catch (error) {
            if (ownTransaction) await transaction.rollback({removeHistory: true});
            throw error;
        }
        return true
    }

    // Recalculate Injury Marks based on each Injury Degree and Game Mode (Gritty, Pulp or Cinematic)
    refreshMarks() {
        const data = this.system.injury.degrees;
        const marks = data.light + data.serious + data.severe * data.severeMult
        return this.update({"system.injury.marks": marks});
    }

    /**
     * This function applies damage or healing to a Character, Organization,
     * or Mass Battle Force and returns a summary with new values.
     * @param {number} newValue     Numeric value passed
     * @param {boolean} isHealing   Identify if newValue's modulus will Sum or Subtract from current HP
     * @param {boolean} isNewHP     Check new total Health will replace by newValue's modulus
     * @returns 
     */
    async applyHPchange (newValue, {isHealing = false, isNewHP = true, transaction = null} = {}) {
        const actorType = this.type;
        const charData = this.system;
        let previousHP = null;
        let updatePath = '';
        let maxHP = Infinity;
        newValue = Number(newValue);
        if (!Number.isFinite(newValue)) throw new TypeError("Health changes must be finite numbers.");
        newValue = Math.abs(newValue)
        if (!isNewHP) newValue = isHealing ? newValue : -newValue;
        switch (actorType) {
            case 'char':
                previousHP = charData.health.value;
                maxHP = charData.health.max
                updatePath = 'system.health.value';
                break;
            case 'organization':
                previousHP = charData.combat.stability.value;
                updatePath = 'system.combat.stability.value';
                break;
            case 'force':
                previousHP = charData.troops.value;
                maxHP = charData.troops.max;
                updatePath = 'system.troops.value';
                break;
            default: return false;
        }
        const tokenImg = this.isToken ? this.parent?.texture?.src : this.prototypeToken?.texture?.src;
        const summary = {
            name: this.name,
            img: tokenImg ?? this.img,
            previousHP,
            isHealing
        };

        summary.newHP = previousHP;
        if (!isNewHP && newValue === 0) return summary;
        if (isNewHP) {
            summary.newHP = newValue
        } else {
            if (newValue > 0) {
                const arr = [previousHP + newValue, maxHP];
                summary.newHP = Math.min(...arr);
            }
            if (newValue < 0) {
                const arr = [previousHP + newValue, 0];
                summary.newHP = Math.max(...arr);
            }
        }
        const deltaHP = summary.newHP - summary.previousHP
        const ownTransaction = !transaction;
        transaction ??= AgeTransactionService.begin({
            label: `${this.name}: ${game.i18n.localize(isHealing ? 'age-system.item.healing' : 'age-system.item.damage')}`,
            type: isHealing ? 'healing' : 'damage',
            sourceUuid: this.uuid,
            metadata: {delta: deltaHP}
        });
        transaction.track(this, updatePath);
        try {
            const update = normalizeCharacterAtomicSystemUpdate({[updatePath]: summary.newHP}, this._source);
            const updateOptions = {diffHP: {
                value: deltaHP,
                type: 'numeric'
            }};
            if (actorType === "char") updateOptions.ageSystemCharacterPaths = ["health.value"];
            await this.update(update, updateOptions);
            if (ownTransaction) await transaction.commit();
        } catch (error) {
            if (ownTransaction) await transaction.rollback({removeHistory: true});
            throw error;
        }
        return summary
    }

    /**
     * Roll Breather on demand
     * 
     * @param {boolean} direct Ask user to review inputs
     * @param {number} k Constant amount of Health recovered
     * @param {boolean} addLevel Indicate if level is added to the Breather
     * @param {string} abl String containing code for the Ability applicable to Breather
     * @param {number} dice Quantity of D6 rolled for the Breather
     * @param {boolean} autoApply Auto apply recovery after rolling Breather
     * @param {string} rollMode Visivility instruction to chat card with breather
     * @returns 
     */
    async breather(direct = true, {k=ageSystem.breather.k, addLevel=ageSystem.breather.addLevel, abl=ageSystem.breather.abl, autoApply=true, abilities=ageSystem.abilities, rollMode=null, transaction=null}={}) {
        if (this.type !== 'char') return false;
        const data = {
            k,
            addLevel,
            abl,
            autoApply,
            abilities,
        };

        const options = direct ? data : await this.breatherSettings(data);
        if (!options || options.cancelled) return false;

        let formula = `${options.k}`;
        const charData = this.system;
        if (options.abl !== 'no-abl') {
            const ability = charData.abilities?.[options.abl];
            if (!ability || !Number.isFinite(Number(ability.total))) {
                ui.notifications.warn(game.i18n.localize("age-system.WARNING.invalidBreatherAbility"));
            } else {
                formula += ` + ${Math.max(Number(ability.total), 0)}`;
            }
        }
        if (options.addLevel) formula += ageSystem.healthSys.useInjury ? ` + ${Math.floor(charData.level/4)}` : ` + ${charData.level}`;
        const roll = await new Roll(formula, this.actorRollData()).evaluate();
        await roll.toMessage(
            {flavor: `${this.name} | ${game.i18n.localize("age-system.breather")}`},
            {messageMode: normalizeMessageMode(rollMode ?? getCoreMessageMode())}
        );
        if (!options.autoApply) return roll;
        return ageSystem.healthSys.useInjury
            ? this.healMarks(roll.total, {transaction})
            : this.applyHPchange(roll.total, {isHealing: true, isNewHP: false, transaction});
    }

    async breatherSettings(data) {
        const template = "/systems/age-system/templates/rolls/breather-settings.hbs";
        const html = await foundry.applications.handlebars.renderTemplate(template, data);
        return showFormDialog({
            title: game.i18n.localize("age-system.breather"),
            content: html,
            confirmLabel: game.i18n.localize("age-system.confirm"),
            cancelLabel: game.i18n.localize("age-system.cancel"),
        });
    }

    /** @inheritdoc */
    _onUpdate(data, options, userId) {
        super._onUpdate(data, options, userId);
        if (options.diffHP) this._displayScrollingText(options.diffHP);
    }

    _displayScrollingText(diffHP) {
        let value = diffHP.value;
        const type = diffHP.type;
        if ( !value ) return;

        let color;
        switch (type) {
            case 'injury':
                color = 'damage'
                break;
            case 'numeric':
                color = value < 0 ? "damage" : "healing";
                break;
            case 'power':
                color = "power"
            default:
                color = 'power'
                break;
        }

        if (type !== 'injury') value = value.signedString();
        const tokens = this.isToken ? [this.token?.object] : this.getActiveTokens(true);
        for ( let t of tokens ) {
            if (t.visible || t.renderable) {
                if (!t.isOwner) value = "???"; // If player isn't token Onwer, display question marks instead of value
                canvas.interface.createScrollingText(t.center, value, {
                    anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
                    distance: 2*t.h,
                    fontSize: 30,
                    fill: ageSystem.tokenTextColors[color],
                    stroke: 0x000000,
                    strokeThickness: 4,
                    jitter: 0.25
                });
            }
        }
    }

    /**
     * Check if there is an Active Effect for this Condition and take action: create if none, delete all if detected.
     * @param {string} condId Condition unique Core ID
     * @returns 
     */
    async handleConditions(condId) {
        if (["spaceship", "vehicle"].includes(this.type)) return null;
        const effectsOn = this.effects.filter(e => e.flags?.["age-system"]?.isCondition && e.statuses.has(condId));
        
        if (effectsOn.length < 1) {
            // If there is no Effect on, create one
            const newEffect = foundry.utils.deepClone(CONFIG.statusEffects?.[condId] ?? statusEffectArray(CONFIG.statusEffects).find(e => e.id === condId));
            if (!newEffect) return false;
            newEffect.statuses = [newEffect.id];
            if (newEffect?.flags?.["age-system"]?.conditionType !== 'custom') newEffect.name = game.i18n.localize(newEffect.name);
            delete newEffect.id;
            await this.createEmbeddedDocuments("ActiveEffect", [newEffect]);
        } else {
            // If there are Effects, delete everything
            const toDelete = [];
            for (let c = 0; c < effectsOn.length; c++) {
                const effect = effectsOn[c];
                toDelete.push(effect.id);
            }
            return this.deleteEmbeddedDocuments("ActiveEffect", toDelete);
        }
        return true;
    }

    async openSheet(newSheet) {
        const sheet = this.sheet
        await sheet.close()
        this._sheet = null
        delete this.apps[sheet.appId]
        await this.setFlag('core', 'sheetClass', newSheet)
        this.sheet.render(true)
    }

    // Data to add Character ref. into rolls
    actorRollData(levelAbl = null) {
        if (!this) return null;
        if (this.type !== 'char') return null;
        const data = this.system;
        const charData = {
            acc: data.abilities?.acc?.total ?? data.abilities?.acc?.value ?? 0,
            comm: data.abilities?.comm?.total ?? data.abilities?.comm?.value ?? 0,
            cons: data.abilities?.cons?.total ?? data.abilities?.cons?.value ?? 0,
            dex: data.abilities?.dex?.total ?? data.abilities?.dex?.value ?? 0,
            fight: data.abilities?.fight?.total ?? data.abilities?.fight?.value ?? 0,
            int: data.abilities?.int?.total ?? data.abilities?.int?.value ?? 0,
            per: data.abilities?.per?.total ?? data.abilities?.per?.value ?? 0,
            str: data.abilities?.str?.total ?? data.abilities?.str?.value ?? 0,
            will: data.abilities?.will?.total ?? data.abilities?.will?.value ?? 0,
            magic: data.abilities?.magic?.total ?? data.abilities?.magic?.value ?? 0,
            cunn: data.abilities?.cunn?.total ?? data.abilities?.cunn?.value ?? 0,
            level: data.level ?? 0
        }
        if (levelAbl) {
            // Add code to replace Ability values by the ones recently progressed in the Level Up routing.
        };
        return charData;
    };
};
