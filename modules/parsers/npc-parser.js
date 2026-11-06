import {ageSystem} from "../config.js";
import * as Dice from "../dice.js";
import {normalizeDamageSource} from "../damage-utils.js";
import {suggestInjuryDamageFromFormula} from "../injury-damage.js";
import {normalizeImportedTitle, normalizePdfClipboardText, splitImportedList} from "../automation/import-normalization.js";

const CANONICAL_MAIN_ABILITY_NAMES = Object.freeze({
  acc: "Accuracy",
  comm: "Communication",
  cons: "Constitution",
  dex: "Dexterity",
  fight: "Fighting",
  int: "Intelligence",
  per: "Perception",
  str: "Strength",
  will: "Willpower",
});

const IMPORTED_DEGREES = Object.freeze(new Map([
  ["novice", 0], ["apprentice", 0], ["journeyman", 1], ["expert", 1],
  ["master", 2], ["grandmaster", 3], ["apex", 4],
]));
const IMPORTED_DEGREE_LABEL = "novice|apprentice|journeyman|expert|master|grandmaster|apex";
const DERIVED_VALUE_LINE_LIMIT = 4;

/**
 * Parser for importing NPCs from AGE System books
 */
export class NpcParser {
  constructor (text, ageSetting, options = {}) {
    // Compêndio com Items (suportar vários? pastas?)
    this._mode = ageSetting;
    this.mode = ageSetting;
    this._modeSelected = ageSetting;
    this.normalization = normalizePdfClipboardText(text);
    this._text = this.normalization.text;
    this.text = this._text;
    this.textLC = foundry.utils.deepClone(this.text.toLowerCase());
    this.options = options;
    // Older integrations construct NpcParser directly and omit profileId. Freeze
    // the active profile at construction so Injury behavior cannot be bypassed or
    // changed by a later settings mutation while an import is in flight.
    let activeProfile = options?.profileId ?? options?.profile ?? null;
    if (!activeProfile) {
      try { activeProfile = game.settings.get("age-system", "activeRuleProfile"); } catch (_error) { /* Optional legacy context. */ }
    }
    this._profileId = String(activeProfile ?? "");
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

  _usesMasteryInjuryProfile() {
    return this._profileId === "mage-mastery-injury"
      || (!Object.hasOwn(this, "_profileId")
        && [this.options?.profileId, this.options?.profile].includes("mage-mastery-injury"));
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
    ])].filter(Boolean);
    const decoration = String.raw`(?:[\u2022*#]+\s*|-{1,3}\s+)?`;
    const captionPattern = captions.map(caption => this._escapeRegExp(caption).replace(/\s+/gu, "\\s+"));
    const captionRegex = new RegExp(`^\\s*${decoration}(?:${captionPattern.join("|")})\\s*(?:-{1,3})?\\s*:?[ \\t]*$`, "imu");
    const captionMatch = this.text.match(captionRegex);
    const qltCaption = captionMatch?.[0] ?? "";
    let spcQltIndex = captionMatch?.index ?? -1;
    let includeFallbackHeading = false;

    // Some stat blocks omit the umbrella Special Qualities caption and begin
    // directly with a bounded content heading. Keep the heading in the section
    // so the normal feature parser can classify it.
    if (spcQltIndex < 0) {
      const contentHeadings = [
        this._localize("age-system.equipment", "Equipment"),
        this._localize("age-system.talentPlural", "Talents"),
        this._localize("age-system.favoredStunts", "Favored Stunts"),
        this._localize("age-system.item.spec", "Specializations"),
        this._localize("age-system.relationship", "Relationship"),
        this._localize("age-system.membership", "Membership"),
        this._localize("age-system.honorifics", "Honorifics"),
        "Equipment", "Talents", "Favored Stunts", "Specializations",
        "Relationships", "Relationship", "Memberships", "Membership", "Honorifics",
      ].filter(Boolean);
      const headingPattern = [...new Set(contentHeadings)]
        .map(heading => this._escapeRegExp(heading).replace(/\s+/gu, "\\s+"));
      const fallbackRegex = new RegExp(`^\\s*${decoration}(?:${headingPattern.join("|")})\\s*:[ \\t]*`, "imu");
      const fallback = this.text.match(fallbackRegex);
      if (fallback) {
        spcQltIndex = fallback.index;
        includeFallbackHeading = true;
      }
    }

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
      sections.specialQualities = this.text.substring(spcQltIndex + (includeFallbackHeading ? 0 : qltCaption.length));
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

  _findDerivedHeader(lines, aliases) {
    const normalizedAliases = Object.fromEntries(Object.entries(aliases).map(([key, values]) => [
      key,
      [...new Set(values.filter(Boolean).map(value => String(value).toLocaleLowerCase()))]
        .sort((left, right) => right.length - left.length),
    ]));
    const aliasIndex = (text, values) => values.map(value => text.indexOf(value)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? -1;
    for (let start = 0; start < lines.length; start++) {
      let joined = "";
      for (let end = start; end < Math.min(lines.length, start + 3); end++) {
        if (!lines[end]?.trim()) break;
        joined = `${joined} ${lines[end]}`.trim().toLocaleLowerCase();
        if (/\d/u.test(joined)) break;
        const speed = aliasIndex(joined, normalizedAliases.speed);
        const health = aliasIndex(joined, normalizedAliases.health);
        const defense = aliasIndex(joined, normalizedAliases.defense);
        if (speed >= 0 && health > speed && defense > health) return {start, end};
      }
    }
    return null;
  }

  _derivedRowComplete(value, mode) {
    const tokens = String(value ?? "").replace(/\+\s+/gu, "+").trim().split(/\s+/u).filter(Boolean);
    const number = token => /^[+-]?\d+(?:\.\d+)?$/u.test(String(token ?? ""));
    const armor = token => /^[+-]?\d+(?:\.\d+)?(?:[ib])?(?:\/[+-]?\d+(?:\.\d+)?(?:[ib])?)?$/iu.test(String(token ?? ""));
    if (["mageL", "mageM"].includes(mode)) {
      return tokens.length >= 11 && number(tokens[0]) && tokens.slice(-10, -1).every(number) && armor(tokens.at(-1));
    }
    return tokens.length >= 4 && number(tokens[0]) && number(tokens.at(-3)) && number(tokens.at(-2)) && armor(tokens.at(-1));
  }

  _collectDerivedValueRow(lines, start, mode) {
    const valueLines = [];
    for (let index = start; index < lines.length && valueLines.length < DERIVED_VALUE_LINE_LIMIT; index++) {
      const line = lines[index]?.trim();
      if (!line) continue;
      valueLines.push(line);
      const candidate = valueLines.join(" ");
      if (this._derivedRowComplete(candidate, mode)) return candidate;
    }
    const count = valueLines.join(" ").split(/\s+/u).filter(Boolean).length;
    throw new Error(`Could not read a complete Speed / Health / Defense / Armor values row (${count} token(s) found).`);
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
   * Parse Fantasy AGE 2e abilities from both official value-first stat blocks
   * and community/name-first blocks. Entries may be separated by newlines,
   * commas, semicolons, or simple PDF column whitespace.
   * @param {Object} abls Localized ability names
   * @param {Object} abilities Object to populate with ability values
   * @param {Array} focus Array to populate with focus data
   */
  _parseFantasyAge2eAbilities(abls, abilities, focus) {
    const section = String(this.sections.abilityPlusDerived ?? "")
      .replace(/[\u2010-\u2014\u2212]/gu, "-")
      .replace(/[\u00a0\u2007\u202f]/gu, " ");
    const lines = section.split(/\r?\n/u);
    const headerAliases = {
      speed: [...new Set([this._localize("age-system.speed", "Speed"), "Speed"])],
      health: [...new Set([this._localize("age-system.health", "Health"), "Health"])],
      defense: [...new Set([this._localize("age-system.defense", "Defense"), "Defense"])],
    };
    const derivedHeader = this._findDerivedHeader(lines, headerAliases);
    const abilitiesText = lines.slice(0, derivedHeader?.start ?? lines.length).join("\n");
    const seen = new Set();

    for (const [key, localizedName] of Object.entries(abls)) {
      const aliases = [...new Set([localizedName, CANONICAL_MAIN_ABILITY_NAMES[key]].filter(Boolean))]
        .sort((left, right) => right.length - left.length)
        .map(alias => this._escapeRegExp(alias));
      const aliasPattern = `(?:${aliases.join("|")})`;
      const leadingBoundary = `(?:^|[^\\p{L}\\p{N}_])`;
      const trailingBoundary = `(?![\\p{L}\\p{N}_])`;
      const valueFirst = new RegExp(`${leadingBoundary}([+-]?\\d+)\\s+${aliasPattern}${trailingBoundary}(?:\\s*\\(([^)]*)\\))?`, "iu");
      const nameFirst = new RegExp(`${leadingBoundary}${aliasPattern}${trailingBoundary}\\s*[:=]?\\s+([+-]?\\d+)(?:\\s*\\(([^)]*)\\))?`, "iu");
      const matches = [abilitiesText.match(valueFirst), abilitiesText.match(nameFirst)].filter(Boolean)
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      const match = matches[0];
      if (!match) continue;
      const abilityValue = Number(match[1]);
      if (!Number.isFinite(abilityValue)) continue;
      abilities[key] = {value: abilityValue};
      seen.add(key);
      this._addFantasyAge2eFocuses(match[2], key, focus);
    }

    const missing = Object.keys(abls).filter(key => !seen.has(key));
    if (missing.length) {
      const names = missing.map(key => CANONICAL_MAIN_ABILITY_NAMES[key] ?? abls[key] ?? key).join(", ");
      throw new Error(`Could not read every Fantasy AGE 2e ability. Missing: ${names}. Check that the pasted block includes all ability scores before the Speed / Health / Defense heading.`);
    }
  }

  _addFantasyAge2eFocuses(focusString, abilityKey, focus) {
    for (const rawFocus of splitImportedList(focusString)) {
      const modifier = rawFocus.match(/^(.+?)\s*\+\s*(\d+)$/u);
      const name = (modifier?.[1] ?? rawFocus).trim();
      if (!name) continue;
      focus.push({
        name: this.normalizeCase(name),
        type: "focus",
        system: {
          initialValue: modifier ? Number(modifier[2]) : 2,
          useAbl: abilityKey,
        },
      });
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
    const derivedHeader = this._findDerivedHeader(lines, aliases);
    if (!derivedHeader) throw new Error("Could not find the Speed / Health / Defense heading in the NPC text.");
    let protoText = this._collectDerivedValueRow(lines, derivedHeader.end + 1, mode);
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
      let str = attksTable[a].replaceAll('–','-').trim();
      if (!str) continue;
      let atkData = str.match(/(?:^|\s)([+-]\d+|0|-)(?=\s|$)/u);
      if (!atkData && a + 1 < attksTable.length && str.length <= 80 && !/[\d:]/u.test(str)) {
        const continuation = attksTable[a + 1].replaceAll('–', '-').trim();
        const continuationAttack = continuation.match(/(?:^|\s)([+-]\d+|0|-)(?=\s|$)/u);
        if (continuationAttack) {
          str = `${str} ${continuation}`;
          atkData = str.match(/(?:^|\s)([+-]\d+|0|-)(?=\s|$)/u);
          a++;
        }
      }
      if (!atkData) continue;
      let dmgStr = this.removeLineBreake(str.substring(atkData.index + atkData[0].length));
      if ((!dmgStr || /[+\-*/]$/u.test(dmgStr)) && a + 1 < attksTable.length) {
        const continuation = attksTable[a + 1].replaceAll('–', '-').trim();
        if (/^(?:\d*d\d+|[+-]?\d+)/iu.test(continuation)
          && !/(?:^|\s)(?:[+-]\d+|0|-)(?=\s|$)/u.test(continuation)) {
          dmgStr = `${dmgStr} ${continuation}`.trim();
          a++;
        }
      }
      const formulaEval = Dice.resumeFormula(dmgStr, {});
      let dmg;
      if (formulaEval === null) {
        dmg = "0";
      } else {
        dmg = formulaEval.shortFormula === "+0" ? `${formulaEval.shortFormula}[${this.normalizeCase(dmgStr)}]` : dmgStr;
      }
      const atkName = this.removeLineBreake(str.substring(0, atkData.index));
      if (!atkName) continue;
      const damageInjurySuggestion = ["mageL", "mageM"].includes(mode)
        ? suggestInjuryDamageFromFormula(dmg)
        : null;
      const attack = {
        name: this.normalizeCase(atkName),
        toHit: atkData[1],
        dmg: formulaEval ? dmg : `0[${game.i18n.localize("age-system.seeDescription")}]`,
        longDesc: formulaEval ? "" :  `<p><strong>${game.i18n.format("age-system.attkNote", {attack: this.normalizeCase(atkName)})}:</strong> ${this.normalizeCase(dmgStr)}</p>`,
      };
      if (["mageL", "mageM"].includes(mode)) attack.damageInjurySuggestion = damageInjurySuggestion;
      if (this._usesMasteryInjuryProfile() && damageInjurySuggestion !== null) attack.damageInjury = damageInjurySuggestion;
      attacks.push(attack);
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
        desc: this.removeLineBreake(rawFeatures.substring(pos1 + size, pos2)
          .replace(/\n\s*(?:-{1,3})\s+/gu, "\n\u2022 "))
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
        core: {sheetClass: "age-system.ageSystemSheetCharStatBlockV2"}
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
    this.options?.onCreatedDocument?.(actor);
    try {
      await this._createItems(actor);
      return actor;
    } catch (error) {
      try {
        await actor.delete();
        this.options?.onDeletedDocument?.(actor);
      } catch (cleanupError) {
        const failure = new Error(`NPC import failed and the incomplete Actor could not be removed: ${cleanupError?.message ?? cleanupError}`);
        failure.code = "AGE_IMPORT_NPC_CLEANUP_FAILED";
        failure.cause = error;
        throw failure;
      }
      throw error;
    }
  }

  async _createItems(actor) {
    // Look at Compendium or Item Directory for Items with same name as Attack/Equipment/Stunt

    // Create documents for Items, except "Weapon" and Armor.
    // Ensure focus is an array to prevent errors
    const focusItems = this.data.focus || [];
    const items = this.data.items || [];
    const attacks = this.data.attacks || [];

    // Resolve and validate every attack before any embedded Item is written.
    // A reviewed world/compendium source keeps its explicit Injury value; only
    // a custom parsed fallback receives the safe formula suggestion.
    const resolvedAttacks = [];
    for (const attack of attacks) {
      const explicitInjuryDamage = Number.isInteger(attack.damageInjury) ? attack.damageInjury : null;
      const suggestedInjuryDamage = Number.isInteger(attack.damageInjurySuggestion)
        ? attack.damageInjurySuggestion
        : suggestInjuryDamageFromFormula(attack.dmg);
      const injuryDamage = explicitInjuryDamage ?? suggestedInjuryDamage;
      const parsedAttack = {
        name: attack.name,
        type: 'weapon',
        system: {
          longDesc: attack.longDesc === "" ? "" : attack.longDesc,
          favorite: true,
          equiped: true,
          useAbl: 'no-abl',
          useFocus: '',
          dmgType: "wound",
          dmgSource: normalizeDamageSource("impact", ageSystem.healthSys),
          dmgAbl: "no-abl",
          damageFormula: `${attack.dmg}`
        }
      };
      if (this._usesMasteryInjuryProfile() && injuryDamage !== null) {
        parsedAttack.system.damageInjury = injuryDamage;
      }
      const attackData = await this._resolveItemData(parsedAttack);
      attackData.system ??= {};
      if (this._usesMasteryInjuryProfile()
          && (!Number.isInteger(attackData.system.damageInjury)
            || attackData.system.damageInjury < 1 || attackData.system.damageInjury > 40)) {
        const formula = String(attack.dmg ?? "").trim() || "unknown";
        const error = new Error(`Cannot safely derive Modern AGE Injury damage for imported attack "${attack.name}" from "${formula}".`);
        error.code = "AGE_IMPORT_INJURY_DAMAGE_UNSUPPORTED";
        throw error;
      }
      attackData.system.favorite = true;
      attackData.system.equiped = true;
      resolvedAttacks.push({attack, data: attackData});
    }

    const resolvedItems = [];
    for (const item of focusItems.concat(items)) resolvedItems.push(await this._resolveItemData(item));
    if (resolvedItems.length) {
      const createdItems = await actor.createEmbeddedDocuments('Item', resolvedItems);
      if (createdItems?.length !== resolvedItems.length) throw new Error("Foundry did not create every imported NPC Item.");
    }

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
    for (const resolvedAttack of resolvedAttacks) {
      const newAttk = await actor.createEmbeddedDocuments('Item', [resolvedAttack.data]);
      if (!newAttk?.[0]) throw new Error(`Foundry did not create the imported attack "${resolvedAttack.attack.name}".`);
      await newAttk[0]._newModifier({type: 'itemActivation', formula: resolvedAttack.attack.toHit, flavor: 'To Hit'});
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
      if (this.options?.strictResolution) throw error;
      console.warn(`AGE System | Unable to resolve imported Item "${parsed?.name ?? 'unknown'}".`, error);
      return fallback;
    }
  }

  _getItems() {
    const feats = this.data.features ?? [];
    const toRemove = [];
    const categories = [
      {
        aliases: [this._localize("age-system.equipment", "Equipment"), "Equipment"],
        itemType: "equipment",
      },
      {
        aliases: [this._localize("age-system.talentPlural", "Talents"), "Talents", "Talent"],
        itemType: "talent",
        subtype: "talent",
      },
      {
        aliases: [this._localize("age-system.item.spec", "Specializations"), "Specializations", "Specialization"],
        itemType: "talent",
        subtype: "spec",
      },
      {
        aliases: [this._localize("age-system.favoredStunts", "Favored Stunts"), "Favored Stunts", "Stunts"],
        itemType: "stunts",
      },
      {
        aliases: [this._localize("age-system.relationship", "Relationship"), "Relationships", "Relationship"],
        itemType: "relationship",
        system: {favorite: true, intensity: 1, intensityMax: 1},
      },
      {
        aliases: [this._localize("age-system.membership", "Membership"), "Memberships", "Membership"],
        itemType: "membership",
        system: {favorite: true, rank: 1},
      },
      {
        aliases: [this._localize("age-system.honorifics", "Honorifics"), "Honorifics"],
        itemType: "honorifics",
        system: {favorite: true},
      },
    ].map(category => ({
      ...category,
      aliases: new Set(category.aliases.filter(Boolean).map(alias => normalizeImportedTitle(alias).toLocaleLowerCase())),
    }));

    // Save recognized content headings as typed Items. Talent and
    // specialization ranks are metadata, never part of the library-match name.
    for (let f = 0; f < feats.length; f++) {
      const ft = feats[f];
      const title = normalizeImportedTitle(ft.name).toLocaleLowerCase();
      const category = categories.find(entry => entry.aliases.has(title));
      if (!category) continue;
      toRemove.push(f);
      for (const rawName of splitImportedList(ft.desc)) {
        const ranked = category.itemType === "talent" ? this._parseImportedDegree(rawName) : {name: rawName.trim()};
        if (!ranked.name) continue;
        const system = category.system ? {...category.system} : {favorite: true, equiped: true, activate: true};
        if (category.itemType === "talent") {
          system.type = category.subtype;
          system.degree = ranked.degree;
        }
        this.data.items.push({
          name: normalizeImportedTitle(ranked.name),
          type: category.itemType,
          img: ageSystem.itemIcons[category.itemType],
          system,
        });
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

  }

  _parseImportedDegree(value) {
    const original = String(value ?? "").trim();
    if (!original) return {name: "", degree: 0};
    const labeled = new RegExp(`^(.*?)(?:\\s*[([{]\\s*|\\s+(?:-|:)?\\s*)(?:rank\\s+|degree\\s+)?(${IMPORTED_DEGREE_LABEL}|[1-5])\\s*[)\\]}]?\\s*$`, "iu");
    const match = original.match(labeled);
    if (!match?.[1]?.trim()) return {name: original, degree: 0};
    const rank = match[2].toLocaleLowerCase();
    const degree = /^\d$/u.test(rank) ? Number(rank) - 1 : IMPORTED_DEGREES.get(rank);
    if (!Number.isInteger(degree) || degree < 0 || degree > 4) return {name: original, degree: 0};
    return {name: match[1].trim().replace(/[\s,:-]+$/u, ""), degree};
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
