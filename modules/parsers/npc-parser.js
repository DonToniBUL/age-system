import {ageSystem} from "../config.js";
import * as Dice from "../dice.js";
import {normalizeDamageSource} from "../damage-utils.js";
import {normalizeImportedTitle, splitImportedList} from "../automation/import-normalization.js";

/**
 * Parser for importing NPCs from AGE System books
 */
export class NpcParser {
  constructor (text, ageSetting, options = {}) {
    // Compêndio com Items (suportar vários? pastas?)
    this._mode = ageSetting;
    this.mode = ageSetting;
    this._modeSelected = ageSetting;
    this._text = String(text ?? "").trim();
    this.text = this._text;
    this.textLC = foundry.utils.deepClone(this.text.toLowerCase());
    this.options = options;
    this._parsed = false;

    // Object containing actor and item data parsed
    this.data = {
      items: []
    };

    this.ready = this.text
      ? (options.create === false ? this.parse() : this._parseAndCreate())
      : Promise.resolve(options.create === false ? this.data : null);
  }

  async _parseAndCreate() {
    await this.parse();
    return this.create();
  }

  async parse() {
    if (this._parsed) return foundry.utils.deepClone(this.data);
    if (!['expanse', 'mageL', 'mageM', 'fage', 'fage2e', 'dage'].includes(this._modeSelected)) {
      throw new Error(`Unsupported NPC import mode: ${this._modeSelected || "none"}.`);
    }
    const block = this.text.split(/\r?\n/).filter(line => line.trim());
    if (!block.length) throw new Error("No NPC text was provided.");

    // Identify 'Threat' and remove this section from this.textLC
    this._getThreat();
    this._getSectionKeys();
    this._getName(block);
    this._getAbilities();
    this._getDerivedData(this.text);
    this._getAttacks(this._modeSelected);
    this._getSpecialQualities();
    this._getItems();
    this._parsed = true;
    return foundry.utils.deepClone(this.data);
  }

  async create() {
    await this.parse();
    return this._createActor();
  }

  _getThreat() {
    const textLC = this.textLC;
    const threatLabels = [...new Set([this._localize('age-system.threat', 'Threat'), 'Threat'])];
    const match = threatLabels
      .map(label => ({text: `${label.toLowerCase()}:`, index: textLC.indexOf(`${label.toLowerCase()}:`)}))
      .filter(entry => entry.index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    const threatTXT = match?.text ?? "";
    const index = match?.index ?? -1;
    if (index < 0) {
      this.data.threat = "";
      return;
    }
    const str = textLC.substring(index);
    const threatStr = textLC.substring(index + threatTXT.length).trim();
    const threat = this.normalizeCase(threatStr);
    this.data.threat = threat;

    this.textLC = textLC.substring(0, textLC.length-str.length);
    this.text = this.text.substring(0, this.text.length-str.length);
  }

  _getSectionKeys() {
    const keys = {};
    const sections = {};

    // Separate block in 2 sections: Abilities/Derived Data and Special Qualities/Features:
    const captions = [...new Set([
      this._localize('age-system.specialQualities', 'Special Qualities'),
      this._localize('age-system.specialFeatures', 'Special Features'),
      'Special Qualities',
      'Special Features',
    ])].map(caption => `\n${caption}`);
    const captionMatch = captions
      .map(caption => ({caption, index: this.textLC.indexOf(caption.toLowerCase())}))
      .filter(entry => entry.index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    const qltCaption = captionMatch?.caption ?? "";
    const spcQltIndex = captionMatch?.index ?? -1;

    keys.specialQualities = {
      index: spcQltIndex,
      size: qltCaption.length
    };

    if (spcQltIndex < 0) {
      keys.specialQualities.index = this.text.length;
      keys.specialQualities.size = 0;
      sections.abilityPlusDerived = this.text;
      sections.specialQualities = "";
    } else {
      sections.abilityPlusDerived = this.text.substring(0, spcQltIndex);
      sections.specialQualities = this.text.substring(spcQltIndex + qltCaption.length);
    }

    this.keys = keys;
    this.sections = sections;
  }
  
  /**
   * Retrive character name and remove name string from input array
   * @param {Array} block Array containing data to be parsed
   * @param {Object} data Actor data
   * @returns Array without treated data
   */
  _getName(block) {
    this.data.name = block[0]?.trim() ?? "";
    if (!this.data.name) throw new Error("The first non-empty line must contain the NPC name.");
    block.splice(0, 1);
    return block
  }

  /**
   * Select which set of Abilities will be parsed and populate actor data, including Focuses
   * @param {Array} block Array contained data to be parsed
   * @returns Array with unparsed data or False if Ability selection is invalid
   */
  _getAbilities() {
    // Identify which Setting the Ability block belongs
    const mode = this._modeSelected
    const ablType = ['expanse', 'mageL', 'mageM', 'fage', 'fage2e'].includes(mode) ? 'main' : (mode === 'dage' ? 'dage' : null);
    
    // Initialize focus as empty array to prevent errors
    const focus = [];
    
    if (!ablType) {
      this.data.focus = focus;
      return false;
    }

    const abls = foundry.utils.deepClone(ageSystem.abilitiesSettings[ablType]);
    for (const a in abls) {
      if (Object.hasOwnProperty.call(abls, a)) {
        abls[a] = this._localize(abls[a], a);            
      }
    }
    
    const abilities = {};
    for (const key of Object.keys(abls)) abilities[key] = {value: 0};

    // Handle Fantasy AGE 2e format (comma-separated abilities)
    if (mode === 'fage2e') {
      this._parseFantasyAge2eAbilities(abls, abilities, focus);
    } else {
      // Search for condensed NPC sheet (original logic)
      for (const a in abls) {
        if (Object.hasOwnProperty.call(abls, a)) {
          const abl = abls[a].toLowerCase();
          const escapedAbility = this._escapeRegExp(abl);
          let hasFocus = false;
          const numberPattern = `[-–]?\\d+`;
          const r0 = ["mageL", "dage", "fage"].includes(mode)
            ? `${numberPattern}\\s+${escapedAbility}`
            : `${escapedAbility}\\s+${numberPattern}`;
          const r1 = `\\s*\\(([^\\)]+)\\)`;
          const ri = new RegExp(`${r0}${r1}`, "iu");
          const text = this.sections.abilityPlusDerived.toLowerCase();
          // Try to match ability + focus entry
          let ablM = text.match(ri);
          // If matches, flag "hasFocus" as true, otherwise, match ability without focus
          if (ablM) hasFocus = true; else ablM = text.match(new RegExp(r0, "iu"));
          if (!ablM) continue;
          
          // Ability value
          const noLineBreak = ablM[0].replace('\n', '').replaceAll('–','-').replace(abl, '').trim();
          const ablArr = noLineBreak.split(" ");
          const value = ablArr[0];
          const abilityValue = Number(value);
          abilities[a] = {value: abilityValue};

          // Focuses
          if (hasFocus) {
            let str = ablM[1].replace('\n', '').replace('(', '').replace(')','');
            const fociArr = str.split(',');
            for (let f = 0; f < fociArr.length; f++) {
              const e = fociArr[f].trim();
              // Identify if there is modified Focus
              const mod = e.lastIndexOf('+');
              const parsedValue = mod < 0 ? 2 : Number(e.slice(mod, e.length));
              const value = Number.isFinite(parsedValue) ? parsedValue : 2;
              const nameStr = mod > 0 ? e.slice(0, mod) : e;
              focus.push({
                name: this.normalizeCase(nameStr),
                type: 'focus',
                system: {
                  initialValue: value,
                  useAbl: a
                }
              })
            }
          }
        }
      }
    }

    // Estimates compatibility for 'dage' and 'main' ability settings
    switch (ablType) {
      case 'main':
        abilities.cunn = {value: abilities.int.value};
        abilities.magic = {value: Math.max(abilities.int.value, abilities.will.value)};
        break;
      case 'dage':
        abilities.int = {value: Math.max(abilities.cunn.value, abilities.magic.value)};
        abilities.fight = {value: Math.max(abilities.str.value, abilities.dex.value)};
        abilities.acc = {value: abilities.dex.value};
        break;
    }
    
    this.data.abilities = abilities;
    this.data.focus = focus;
  }

  /**
   * Parse abilities for Fantasy AGE 2e format (comma-separated)
   * @param {Object} abls Localized ability names
   * @param {Object} abilities Object to populate with ability values
   * @param {Array} focus Array to populate with focus data
   */
  _parseFantasyAge2eAbilities(abls, abilities, focus) {
    const text = this.sections.abilityPlusDerived.toLowerCase();
    
    // Find the abilities section - it comes after "ABILITIES (FOCUSES)" header
    const abilityLabel = this._escapeRegExp(game.i18n.localize("age-system.abl"));
    const focusLabel = this._escapeRegExp(game.i18n.localize("age-system.focus"));
    const abilityHeaderRegexes = [
      /abilities?\s*\(\s*focus(?:es)?\s*\)/iu,
      new RegExp(`${abilityLabel}s?\\s*\\(\\s*${focusLabel}(?:es|s)?\\s*\\)`, "iu"),
    ];
    const abilityHeaderMatch = abilityHeaderRegexes.map(regex => text.match(regex)).find(Boolean);
    if (!abilityHeaderMatch) return;
    
    const abilityStartIndex = abilityHeaderMatch.index + abilityHeaderMatch[0].length;
    
    // Find where abilities section ends (before SPEED, HEALTH, DEFENSE line)
    const speed = this._escapeRegExp(game.i18n.localize("age-system.speed"));
    const health = this._escapeRegExp(game.i18n.localize("age-system.health"));
    const defense = this._escapeRegExp(game.i18n.localize("age-system.defense"));
    const speedHealthDefenseRegex = new RegExp(`(?:speed\\s+health\\s+defense|${speed}\\s+${health}\\s+${defense})`, "iu");
    const speedHealthDefenseMatch = text.match(speedHealthDefenseRegex);
    const abilityEndIndex = speedHealthDefenseMatch ? speedHealthDefenseMatch.index : text.length;
    
    // Extract the abilities text
    const abilitiesText = text.substring(abilityStartIndex, abilityEndIndex).trim();
    
    // Split by commas, but be careful about commas inside parentheses
    const abilityEntries = this._splitRespectingParentheses(abilitiesText);
    
    // Process each ability entry
    for (const entry of abilityEntries) {
      const trimmedEntry = entry.trim();
      if (!trimmedEntry) continue;
      
      // Parse each ability entry
      this._parseFantasyAge2eAbilityEntry(trimmedEntry, abls, abilities, focus);
    }
  }

  /**
   * Split text by commas while respecting parentheses
   * @param {String} text Text to split
   * @returns {Array} Array of split entries
   */
  _splitRespectingParentheses(text) {
    text = text.replaceAll('–', '-'); // Replace en-dash with hyphen
    const entries = [];
    let current = '';
    let parenthesesDepth = 0;
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      
      if (char === '(') {
        parenthesesDepth++;
      } else if (char === ')') {
        parenthesesDepth--;
      } else if (char === ',' && parenthesesDepth === 0) {
        entries.push(current.trim());
        current = '';
        continue;
      }
      
      current += char;
    }
    
    if (current.trim()) {
      entries.push(current.trim());
    }
    
    return entries;
  }

  /**
   * Parse a single ability entry for Fantasy AGE 2e format
   * @param {String} entry Single ability entry (e.g., "Accuracy 2 (Light Blades, Bows)")
   * @param {Object} abls Localized ability names
   * @param {Object} abilities Object to populate with ability values
   * @param {Array} focus Array to populate with focus data
   */
  _parseFantasyAge2eAbilityEntry(entry, abls, abilities, focus) {
    // Pattern: Ability Name Number (Focus1, Focus2, etc.)
    const abilityPattern = /^(.+?)\s+(-?\d+)(?:\s*\(([^)]+)\))?/u;
    const match = entry.match(abilityPattern);
    
    if (!match) return;
    
    const abilityName = match[1].trim().toLowerCase();
    const abilityValue = parseInt(match[2]);
    const focusString = match[3];
    
    // Find the matching ability key
    let abilityKey = null;
    for (const [key, localizedName] of Object.entries(abls)) {
      if (localizedName.toLowerCase() === abilityName) {
        abilityKey = key;
        break;
      }
    }
    
    if (!abilityKey) return;
    
    // Set ability value
    abilities[abilityKey] = { value: abilityValue };
    
    // Parse focuses if present
    if (focusString) {
      const fociArr = focusString.split(',');
      for (const f of fociArr) {
        const focusName = f.trim();
        if (focusName) {
          // Check if focus has a modifier (like +3)
          const modMatch = focusName.match(/(.+?)\s*\+(\d+)$/);
          const focusValue = modMatch ? parseInt(modMatch[2]) : 2;
          const focusNameClean = modMatch ? modMatch[1].trim() : focusName;
          
          focus.push({
            name: this.normalizeCase(focusNameClean),
            type: 'focus',
            system: {
              initialValue: focusValue,
              useAbl: abilityKey
            }
          });
        }
      }
    }
  }

  // TODO - Incluir localização
  _getDerivedData() {
    const mode = this._modeSelected;
    const abilities = this.data.abilities;
    const header = {
      speed: this._localize("age-system.speed", "Speed"),
      health: mode === 'expanse' ? this._localize("age-system.fortune", "Fortune") : this._localize("age-system.health", "Health"),
      defense: this._localize("age-system.defense", "Defense")
    };
    const lines = this.sections.abilityPlusDerived.split(/\r?\n/);
    const aliases = {
      speed: [header.speed, "Speed"],
      health: [header.health, mode === "expanse" ? "Fortune" : "Health"],
      defense: [header.defense, "Defense"],
    };
    const includesAlias = (line, values) => values.filter(Boolean).some(value => line.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
    const headerIndex = lines.findIndex(line => includesAlias(line, aliases.speed)
      && includesAlias(line, aliases.health)
      && includesAlias(line, aliases.defense));
    if (headerIndex < 0) throw new Error("Could not find the Speed / Health / Defense heading in the NPC text.");
    let protoText = lines.slice(headerIndex + 1).find(line => line.trim())?.trim() ?? "";
    if (!protoText) throw new Error("The NPC derived-stat heading is not followed by a values row.");
    protoText = protoText.replaceAll("+ ", "+");
    
    // Logic to ensure "+" has a white space on its left and none to its right
    const wsLeft = [];
    for (let i = protoText.length-1; i > 0; i--) {
      const e = protoText[i];
      if (e === "+" && protoText[i-1] != " ") wsLeft.push(i);
    }
    for (let c = 0; c < wsLeft.length; c++) {
      const el = wsLeft[c];
      protoText = protoText.slice(0, el) + " " + protoText.slice(el, protoText.length);
    }
    let data = protoText.split(" ");
    const minimumValues = ["mageL", "mageM"].includes(mode) ? 11 : 4;
    if (data.length < minimumValues) {
      throw new Error(`The NPC derived-stat row contains ${data.length} value(s); ${minimumValues} are required for ${mode}.`);
    }

    // Add '+' if missing on Toughness values
    if (["mageL", "mageM"].includes(mode)) {
      for (let i = 1; i <= 2; i++) {
        if (data[data.length-i].indexOf("+") < 0 && data[data.length-i].indexOf("-") < 0) data[data.length-i] = `+${data[data.length-i]}`
      }
    }

    // Modern AGE logics
    // Initialize Game Mode object
    const gameMode = {
      specs: {
        gritty: {},
        pulp: {},
        cinematic: {},
        none: {}
      }
    };

    // Toughness attribute is differentiated for Modern AGE only - other cases equals do ZERO
    if (["mageL", "mageM"].includes(mode)) {
      this._populateMageMods(data, gameMode, 'toughness', abilities.cons.value);
    } else {
      for (const key in gameMode.specs) {
        if (Object.hasOwnProperty.call(gameMode.specs, key)) {
          gameMode.specs[key].toughness = 0;          
        }
      }
    }
    
    // Armor Rating (Ballistic and Impact), including logics to identify when xI/yB data is missing
    let armorStr = String(data.pop() ?? "0").trim();
    let totalArmor = ['0I', '0B'];
    if (armorStr.includes('/')) {
      totalArmor = armorStr.split('/')
    } else {
      if (!Number.isNaN(Number(armorStr))) {
        if (["expanse"].includes(mode)) armorStr = Number(armorStr) - abilities.cons.value;
        totalArmor = [`${armorStr}I`, `${armorStr}B`]
      }
    };
    const ballistic = Number.parseFloat(String(totalArmor.pop() ?? "0").replace(/[a-z]+$/iu, ""));
    const impact = Number.parseFloat(String(totalArmor.pop() ?? "0").replace(/[a-z]+$/iu, ""));
    const armor = {
      ballisticArmor: Number.isFinite(ballistic) ? ballistic : 0,
      impactArmor: Number.isFinite(impact) ? impact : 0,
    };
    this.data.armor = armor;

    // Defense
    const baseDef = 10;
    this._populateMageMods(data, gameMode, 'defense', baseDef + abilities.dex.value);

    // Health
    this._populateMageMods(data, gameMode, 'health');

    // Speed and different movement
    const baseSpeed = Number(data[0]) - abilities.dex.value;
    if (!Number.isFinite(baseSpeed)) throw new Error("The NPC Speed value is not numeric.");
    data.splice(0, 1);
    const otherSpeed = data.length ? data.join(' ') : null;
    this.data.speed = {base: baseSpeed};
    if (otherSpeed) this.data.traits = `${otherSpeed}`;
    this.data.flags = {
      "age-system": {
        importData: {speedOthers: otherSpeed}
      }
    };
    this.data.gameMode = gameMode;
  }

  _getAttacks(mode) {
    const text = this.textLC;
    const attacks = [];
    let attksTable;
    const endIndex = this.keys.specialQualities.index;
    const attkHeader = this._localize("age-system.attkHeader", "Weapon Attack Roll Damage");
    const headerCandidates = [...new Set([attkHeader, "Weapon Attack Roll Damage"])];
    let start = "";
    let startIndex = -1;
    for (const candidate of headerCandidates) {
      const candidateIndex = text.indexOf(candidate.toLowerCase());
      if (candidateIndex < 0) continue;
      const lineEnd = text.indexOf("\n", candidateIndex);
      startIndex = candidateIndex;
      start = text.substring(candidateIndex, lineEnd < 0 ? text.length : lineEnd + 1);
      break;
    }
    if (startIndex < 0) {
      this.data.attacks = attacks;
      return;
    }
    attksTable = text.substring(startIndex + start.length, endIndex).split('\n');
    if (["mageL", "mageM"].includes(mode)) attksTable.pop(); // Removes note at bottom of attacks' table

    // Go through attksTable and identify attacks
    for (let a = 0; a < attksTable.length; a++) {
      const str = attksTable[a].replaceAll('–','-').trim();
      if (!str) continue;
      const atkData = str.match(/(?:^|\s)([+-]\d+|0|-)(?=\s|$)/u);
      if (!atkData) continue;
      const dmgStr = this.removeLineBreake(str.substring(atkData.index + atkData[0].length));
      const formulaEval = Dice.resumeFormula(dmgStr, {});
      let dmg;
      if (formulaEval === null) {
        dmg = "0";
      } else {
        dmg = formulaEval.shortFormula === "+0" ? `${formulaEval.shortFormula}[${this.normalizeCase(dmgStr)}]` : dmgStr;
      }
      const atkName = this.removeLineBreake(str.substring(0, atkData.index));
      if (!atkName) continue;
      attacks.push({
        name: this.normalizeCase(atkName),
        toHit: atkData[1],
        dmg: formulaEval ? dmg : `0[${game.i18n.localize("age-system.seeDescription")}]`,
        longDesc: formulaEval ? "" :  `<p><strong>${game.i18n.format("age-system.attkNote", {attack: this.normalizeCase(atkName)})}:</strong> ${this.normalizeCase(dmgStr)}</p>`
      })
    }
    
    this.data.attacks = attacks;
  }

  /**
   * Extract Special Qualities from imported data and store array at this.data.features
   * @param {String} text Imported text without the 'Threat' string sequence
   * @param {*} mode AGE setting selected by user
   */
  _getSpecialQualities() {
    const features = []
    const rawFeatures = this.sections.specialQualities;
    const rawFeaturesLC = rawFeatures.toLowerCase();
    const featArr = rawFeatures.match(/(?:^|\n)([^\n:]+):/g) ?? [];
    for (let i = 0; i < featArr.length; i++) {
      const f = featArr[i];
      const size = f.length;
      const pos1 = rawFeatures.indexOf(f);
      const pos2 = (i < featArr.length-1) ? rawFeaturesLC.indexOf(featArr[i+1].toLowerCase()) : Infinity;
      features.push({
        name: this.normalizeCase(this.removeLineBreake(f.substring(0, f.length-1))),
        desc: this.removeLineBreake(rawFeatures.substring(pos1 + size, pos2))
      });
    }
    this.data.features = features;
  }

  async _createActor() {
    const data = this.data;
    const type = 'char';
    const selectedMode = game.settings.get("age-system", "gameMode");
    const modeData = data.gameMode?.specs?.[selectedMode] ?? data.gameMode?.specs?.none;
    const healthMax = Number(modeData?.health);
    if (!Number.isFinite(healthMax)) throw new Error("The imported NPC Health value is invalid.");
    const health = foundry.utils.deepClone(game.model?.Actor?.char?.health ?? {
      min: 0,
      value: healthMax,
      set: healthMax,
      max: healthMax
    });
    health.value = healthMax;
    health.set = healthMax;
    if (Object.prototype.hasOwnProperty.call(health, "max")) health.max = healthMax;

    // Organize data to create new Actor
    const actorData = {
      name: this.normalizeCase(data.name),
      type: type,
      flags: {
        core: {sheetClass: "age-system.ageSystemSheetCharStatBlock"}
      },
      system: {
        threat: data.threat,
        abilities: data.abilities,
        gameMode: data.gameMode,
        health,
        traits: data.traits || ""
      }
    }

    // Creates new Actor
    const actors = await game.actors.documentClass.createDocuments([actorData]);
    const actor = actors?.[0];
    if (!actor) throw new Error("Foundry did not create the imported NPC Actor.");
    await this._createItems(actor);
    return actor;
  }

  async _createItems(actor) {
    // Look at Compendium or Item Directory for Items with same name as Attack/Equipment/Stunt

    // Create documents for Items, except "Weapon" and Armor.
    // Ensure focus is an array to prevent errors
    const focusItems = this.data.focus || [];
    const items = this.data.items || [];
    
    const resolvedItems = [];
    for (const item of focusItems.concat(items)) resolvedItems.push(await this._resolveItemData(item));
    await actor.createEmbeddedDocuments('Item', resolvedItems);

    // Add Armor
    const armor = await actor.createEmbeddedDocuments('Item', [{
      name: game.i18n.localize("age-system.armor"),
      type: 'equipment',
      img: 'icons/svg/shield.svg',
      system: {equiped: true, favorite: true}
    }]);
    if (!armor?.[0]) throw new Error("Foundry did not create the imported NPC Armor Item.");
    await armor[0]._newModifier({type: 'impactArmor', formula: String(Number(this.data.armor.impactArmor) || 0)});
    await armor[0]._newModifier({type: 'ballisticArmor', formula: String(Number(this.data.armor.ballisticArmor) || 0)});

    // Create Weapons from "Attacks"
    const attks = this.data.attacks;
    for (let a = 0; a < attks.length; a++) {
      const attk = attks[a];
      const parsedAttack = {
        name: attk.name,
        type: 'weapon',
        system: {
          longDesc: attk.longDesc === "" ? "" : attk.longDesc,
          favorite: true,
          equiped: true,
          useAbl: 'no-abl',
          useFocus: '',
          dmgType: "wound",
          dmgSource: normalizeDamageSource("impact", ageSystem.healthSys),
          dmgAbl: "no-abl",
          damageInjury: 1, // TODO - elaborate formula to fill in this data
          damageFormula: `${attk.dmg}`
        }
      };
      const attackData = await this._resolveItemData(parsedAttack);
      attackData.system ??= {};
      attackData.system.favorite = true;
      attackData.system.equiped = true;
      const newAttk = await actor.createEmbeddedDocuments('Item', [attackData]);
      if (!newAttk?.[0]) throw new Error(`Foundry did not create the imported attack "${attk.name}".`);
      await newAttk[0]._newModifier({type: 'itemActivation', formula: attk.toHit, flavor: 'To Hit'});
    }
    await actor.sheet.render(true);
    return actor;
  }

  async _resolveItemData(parsed) {
    const fallback = foundry.utils.deepClone(parsed);
    if (typeof this.options?.resolveItem !== 'function') return fallback;
    try {
      const resolved = await this.options.resolveItem(fallback, {destination: 'actor', parser: this});
      return foundry.utils.deepClone(resolved?.data ?? fallback);
    } catch (error) {
      console.warn(`AGE System | Unable to resolve imported Item "${parsed?.name ?? 'unknown'}".`, error);
      return fallback;
    }
  }

  _getItems() {
    // Localized names
    const equipLocal = this._localize("age-system.equipment", "Equipment").toLowerCase();
    const talentLocal = this._localize("age-system.talentPlural", "Talents").toLowerCase();
    const favoredStuntLocal = this._localize("age-system.favoredStunts", "Favored Stunts").toLowerCase();

    // Item Type definition
    const feats = this.data.features ?? [];
    const items = {};
    const toRemove = [];
    
    // Save Equipment, Talent and Stunt on separate arrays
    for (let f = 0; f < feats.length; f++) {
      const ft = feats[f];
      const title = ft.name.toLowerCase()
      if (title === equipLocal || title === talentLocal || title === favoredStuntLocal) {
        toRemove.push(f);
        switch (title) {
          case equipLocal: items.equipment = splitImportedList(ft.desc);
            break;
          
          case talentLocal: items.talent = splitImportedList(ft.desc);
            break;
  
          case favoredStuntLocal: items.stunts = splitImportedList(ft.desc);
            break;
        }
      }
    }

    // Remove features already treated
    for (let i = toRemove.length-1; i > -1; i--) {
      const r = toRemove[i];
      feats.splice(r, 1);
    }

    // Try to identify if imported data has specific stunts
    // English version
    // const startsWith = `Stunt—`.toLowerCase();

    // Other Special Qualities as Powers
    const power = [];
    if (feats.length) {
      for (let f = 0; f < feats.length; f++) {
        const p = feats[f];
        power.push({
          name: p.name.trim(),
          type: 'power',
          system: {
            favorite: true,
            activate: true,
            longDesc: `<p>${p.desc.trim()}</p>`,
            hasRoll: false,
            powerPointCost: 0
          }
        })
      }
    }
    if (power.length) this.data.items.push(...power);

    // Create Array with data to create Items on Actor
    for (const key in items) {
      if (Object.hasOwnProperty.call(items, key)) {
        const e = items[key];
        for (let i = 0; i < e.length; i++) {
          e[i] = {
            name: e[i].trim(),
            type: key,
            img: ageSystem.itemIcons[key],
            system: {
              favorite: true,
              equiped: true,
              activate: true
            }
          };
        }
        this.data.items.push(...e)
      }
    }
  }

  /**
   * Replace line breaks from a string by white spaces
   * @param {String} str A regular string
   * @returns Regular string replacing all \n by a white space
   */
  removeLineBreake(str){
    return str.replaceAll(`\n`, ` `).trim();
  }

  _escapeRegExp(value) {
    return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  _localize(key, fallback) {
    const value = game.i18n.localize(key);
    return typeof value === "string" && value && value !== key ? value : fallback;
  }

  /**
   * Function to deliver proper capitalization for title of Items
   * @param {String} str Sring with any number of words
   * @returns String with first letter of each word on Upper Case and the other on Lower Case. Words after an '-' will also have first letter on Upper Case
   */
  normalizeCase(str) {
    return normalizeImportedTitle(str);
  }

  /**
   * Helper function to parse text to fetch Actor's Speed, Health, Defense and Armor
   * @param {Array} dataArr Array containing Speed, Health, Defense and Armor data
   * @param {String} gameMode Game Mode ID to be used to set Current Health
   * @param {String} type Derived data to be looked (Speed, Health, Defense or Armor)
   * @param {Number} offset Adjustment to be made on derived data
   * @returns {Array} Array containing remaining data to be parsed
   */
  _populateMageMods(dataArr, gameMode, type, offset = 0) {
    const modes = ['cinematic', 'pulp', 'gritty'];
    const setting = this._modeSelected;
    let baseData = ["mageL", "mageM"].includes(setting) ? dataArr : dataArr.pop();
    for (let m = 0; m < modes.length; m++) {
      const mode = modes[m];
      const rawValue = Array.isArray(baseData) ? dataArr.pop() : baseData;
      const v = Number(rawValue) - Number(offset || 0);
      if (!Number.isFinite(v)) throw new Error(`The imported ${type} value for ${mode} mode is not numeric.`);
      gameMode.specs[mode][type] = v;
      if (type === 'health') gameMode.specs[mode].healthCur = v;
      if (mode === 'gritty') {
        gameMode.specs.none[type] = v;
        if (type === 'health') gameMode.specs.none.healthCur = v;
      }
    }
    return dataArr;
  }
} 
