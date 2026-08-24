import {ageSystem} from "./config.js";
import { applyMessageMode, MESSAGE_MODES } from "./compat.js";
import {buildDamageTargetData, finiteNumber, normalizeDamageSource} from "./damage-utils.js";
import {AgeTransactionService} from "./automation/action-transactions.js";
import {AgeActionService} from "./automation/actions.js";

export default class ApplyDamageDialog extends foundry.appv1.api.Application {
  constructor(targets, damageData, useInjury, options = {}) {
    super(options)

    if (!Array.isArray(targets)) targets = [targets]

    this.targets = targets;
    this.damageData = damageData;
    this.useInjury = useInjury;
    this._handler = new DamageHandler(targets, damageData);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ['age-system-dialog', 'age-system'],
      id: 'apply-damage-window',
      template: 'systems/age-system/templates/apply-damage-window.hbs',
      resizable: true,
      minimizable: false,
      width: 900,
      height: 'auto',
      title: game.i18n.localize('age-system.applyDamage'),
    })
  }

  getData() {
    const data = super.getData();
    data.targets = this.targets;
    data.damageData = this.damageData;
    data.useInjury = this.useInjury;
    data.handler = this._handler;
    data.config = ageSystem;

    data.radioB = {
      name: "handler.armorPenetration",
      choices: {
        none: game.i18n.localize('age-system.none'),
        half: game.i18n.localize('age-system.halfArmor'),
        ignore: game.i18n.localize('age-system.ignoreArmor')
      },
      options: {
        hash: {
          checked: data.handler.armorPenetration
        }
      }
    }
    return data
  }

  activateListeners(html) {
    super.activateListeners(html)

    // Open target sheet
    html.find(".individual img.item-image").click(async ev => {
      const i = ev.target.closest(".feature-controls").dataset.i;
      const targetId = this._handler.harmedOnes[i].uuid;
      const document = await foundry.utils.fromUuid(targetId);
      const actor = document?.documentName === "Token" ? document.actor : document?.actor ?? document;
      actor?.sheet?.render(true);
    })

    // Modify Armor Penetration properties for all targets
    html.find(".armor-penetration input").click(ev => {
      const newValue = ev.currentTarget.value
      this._handler.armorPenetration = newValue;
      this.updateUI()
    });

    // Modify Damage Type
    html.find('select.damage-type').change(ev => {
      const newValue = ev.currentTarget.value;
      this._handler.damageType = newValue;
      this.updateUI();
    })

    // Modify Damage Source
    html.find('select.damage-source').change(ev => {
      const newValue = ev.currentTarget.value;
      this._handler.damageSource = newValue;
      this.updateUI();
    })

    // Change Basic Damage for all targets - using symbols ( - or +)
    html.find(".overall-dmg .change-damage").click(ev => {
      let dmg = Number(this._handler.basicDamage);
      const classes = ev.currentTarget.classList;
      if (classes.contains("increase")) dmg += 1;
      if (classes.contains("decrease")) dmg -= 1;
      if (dmg < 0) dmg = 0
      this._handler.basicDamage = dmg;
      this.updateUI()
    });
    
    // Typing updates on input field for basic damage (all targets)
    html.find("input.basic-damage").change(ev => {
      const value = Number(ev.currentTarget.value);
      this._handler.basicDamage = Number(value);
      this.updateUI()
    })

    // Individual target mod (using + or -)
    html.find(".targets .individual .change-damage").click(ev => {
      const i = ev.target.closest(".feature-controls").dataset.i;
      let dmg = this._handler.harmedOnes[i].dmgMod;
      const classes = ev.currentTarget.classList;
      if (classes.contains("increase")) dmg += 1;
      if (classes.contains("decrease")) dmg -= 1;
      this._handler.harmedOnes[i].dmgMod = dmg;
      this.updateUI()
    });

    // Individual target Toughness Mod (using + or -)
    html.find(".targets .change-toughness").click(ev => {
      const i = ev.target.closest(".feature-controls").dataset.i;
      let mod = this._handler.harmedOnes[i].toughMod;
      const classes = ev.currentTarget.classList;
      if (classes.contains("increase")) mod += 1;
      if (classes.contains("decrease")) mod -= 1;
      this._handler.harmedOnes[i].toughMod = mod;
      this.updateUI()
    });

    // Typing updates on input field for individual target
    html.find(".targets .individual input.target-damage-mod").change(ev => {
      const value = Number(ev.currentTarget.value);
      const i = ev.target.closest(".feature-controls").dataset.i;
      this._handler.harmedOnes[i].dmgMod = value;
      this.updateUI()
    })

    // Select if that target will be spared
    html.find(".targets .individual .do-not-apply").change(ev => {
      const checked = ev.currentTarget.checked;
      const i = ev.target.closest(".feature-controls").dataset.i;
      this._handler.harmedOnes[i].ignoreDmg = checked;
    });

    // Select if that target will have Injury Auto implemented
    html.find(".targets .individual .auto-apply-injury").change(ev => {
      const checked = ev.currentTarget.checked;
      const i = ev.target.closest(".feature-controls").dataset.i;
      this._handler.harmedOnes[i].autoInjury = checked;
    });

    // Change Let Player Roll Toughness Test
    html.find(".players-roll").change(ev => {
      const checked = ev.currentTarget.checked;
      this._handler.letPlayerRoll = checked;
    });

    html.find("button.apply-damage").click(async (ev) => {
      const button = ev.currentTarget;
      button.disabled = true;
      try {
        const selected = this._handler.harmedOnes.filter(target => !target.ignoreDmg);
        const execution = await AgeActionService.execute({
          type: "apply.damage",
          targetUuids: selected.map(target => target.uuid).filter(Boolean),
          payload: {
            damage: this._handler.basicDamage,
            damageType: this._handler.damageType,
            damageSource: this._handler.damageSource,
            useInjury: this.useInjury,
            applyInjuryAll: button.classList.contains("apply-all")
          },
          metadata: {origin: "apply-damage-dialog", selectedTargets: selected.length}
        }, {
          executor: action => this._applyDamageSelection(button, action)
        });
        await this.close();
        return execution.result;
      } catch (error) {
        console.error("AGE System | Apply Damage failed", error);
        ui.notifications.error(game.i18n.format("age-system.WARNING.damageApplicationFailed", {
          reason: error?.message ?? game.i18n.localize("age-system.unknown")
        }), {permanent: true});
      } finally {
        if (button.isConnected !== false) button.disabled = false;
      }
    })
  }

  async _applyDamageSelection(button, ageAction) {
    const transaction = AgeTransactionService.begin({
      id: ageAction.id,
      label: game.i18n.localize("age-system.AUTOMATION.applyDamageTransaction"),
      type: ageAction.type,
      metadata: {
        targets: this._handler.harmedOnes.length,
        actionSchemaVersion: ageAction.schemaVersion
      }
    });
    try {
      const applyInjuryAll = button.classList.contains("apply-all");
      const settled = await Promise.allSettled(this._handler.harmedOnes.map(async h => {
        if (h.ignoreDmg) return null;
        const applyInjury = applyInjuryAll || h.autoInjury;
        let actor = await foundry.utils.fromUuid(h.uuid);
        if (!actor) return null;
        if (actor.documentName === "Token") actor = actor.actor;
        if (!actor) return null;
        if (!this.useInjury) return actor.applyHPchange(h.remainingHP, {transaction});
        if (actor.hasPlayerOwner && this._handler.letPlayerRoll) {
          await this.promptPlayerToRoll(actor, h.injuryParts, h.totalDmg, applyInjury);
          return null;
        }
        const card = await actor.toughnessTest(h.injuryParts, h.totalDmg, applyInjury, {transaction});
        const cardFlag = card?.flags?.["age-system"]?.ageroll?.rollData;
        const degree = cardFlag?.injuryDegree ?? null;
        if (applyInjury && cardFlag && !cardFlag.isSuccess && degree !== null) return {
          name: actor.name,
          img: actor.img,
          degree,
          totalInjuries: foundry.utils.deepClone(actor.system.injury?.degrees ?? {}),
          newMarks: actor.system.injury?.marks ?? 0
        };
        return null;
      }));
      const failure = settled.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      const results = settled.map(result => result.value);
      await transaction.commit();
      const summary = results.filter(Boolean);
      if (summary.length) await this.summaryToChat(summary, this.useInjury);
      return results;
    } catch (error) {
      try {
        await transaction.rollback({removeHistory: true});
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          game.i18n.localize("age-system.AUTOMATION.rollbackFailed")
        );
      }
      throw error;
    }
  }

  updateUI() {
    this.render(false)
  }

  async summaryToChat (summary, useInjury) {
    return await summaryToChat(summary, useInjury);
  }

  async promptPlayerToRoll (actor, injuryParts, totalDmg, autoApply) {
    const chatTemplate = "/systems/age-system/templates/rolls/owner-roll-toughness.hbs";
    const templateData = {
      img: actor.img,
      name: actor.name
    }

    let owners = [];
    for (const u of game.users) {
      if (actor.testUserPermission(u, 'OWNER') && u.id !== game.user.id) owners.push(u.id)
    }
    let chatData = {
      user: game.user.id,
      content: await foundry.applications.handlebars.renderTemplate(chatTemplate, templateData),
      style: CONST.CHAT_MESSAGE_STYLES.OOC,
      whisper: owners,
      flags: {
        "age-system": {
          "toughnessTestCard": {
            injuryParts,
            rollTN: totalDmg,
            autoApply,
            actorUuid: actor.uuid
          }
        }
      }
    }
    return ChatMessage.create(chatData);
  }
}

export class DamageHandler {
  constructor(targets, damageData = {}) {
    if (!Array.isArray(targets)) targets = [targets];
    const healthSys = damageData.healthSys ?? ageSystem.healthSys ?? {};
    const damageSource = normalizeDamageSource(damageData.dmgSrc, healthSys);
    this._damageData = {...damageData, healthSys, dmgSrc: damageSource};
    this._useBallistic = Boolean(healthSys.useBallistic);
    this._useInjury = Boolean(healthSys.useInjury);
    this._basicDamage = finiteNumber(damageData.totalDamage, 0);
    this._armorPenetration = damageSource === "penetrating" ? "ignore" : "none";
    this._damageType = damageData.dmgType ?? "wound";
    this._damageSource = damageSource;
    this._letPlayerRoll = true;

    const harmedOnes = [];
    for (const target of targets) {
      const actor = target?.actor ?? target?.document?.actor;
      if (!actor) continue;
      const document = target?.document ?? target;
      const data = buildDamageTargetData(actor);
      const injuryMarks = finiteNumber(data.system.injury?.marks, 0);
      harmedOnes.push({
        name: actor.name,
        img: document?.texture?.src ?? actor.img,
        uuid: document?.actorLink ? actor.uuid : (document?.uuid ?? actor.uuid),
        data,
        dmgMod: 0,
        remainingHP: 0,
        damage: 0,
        ignoreDmg: false,
        autoInjury: !data.hasPlayerOwner,
        injuryMarks,
        injurySDpenalty: Math.floor(injuryMarks / 3),
        testMod: finiteNumber(data.system.testMod, 0),
        toughMod: 0
      });
    }
    this._harmedOnes = harmedOnes.map(harmed => this.damage(harmed, this._damageData));
  }

  set harmedOnes(value) {
    this._harmedOnes = value;
  }

  get harmedOnes() {
    return this._harmedOnes.map(harmed => this.damage(harmed, this._damageData));
  }

  set armorPenetration(value) {
    this._armorPenetration = value;
  }

  get armorPenetration() {
    return this._armorPenetration;
  }

  set damageType(value) {
    this._damageType = value;
    this._damageData.dmgType = value
  }

  get damageType() {
    return this._damageType;
  }

  set damageSource(value) {
    const normalized = normalizeDamageSource(value, this._damageData.healthSys);
    this._damageSource = normalized;
    this._damageData.dmgSrc = normalized;
  }

  get damageSource() {
    return this._damageSource;
  }

  set basicDamage(value) {
    this._basicDamage = value;
  }

  get basicDamage() {
    return this._basicDamage;
  }

  get armorPenetrationMult() {
    const ap = this.armorPenetration;
    if (ap === "half") return 0.5;
    if (ap === "ignore") return 0;
    return 1;
  }

  set letPlayerRoll(value) {
    this._letPlayerRoll = value;
  }

  get letPlayerRoll() {
    return this._letPlayerRoll;
  }

  damage(h, d) {
    let ap = this.armorPenetration;
    let injuryParts = [];
    const hData = h?.data?.system ?? h?.system ?? {};
    const armor = hData.armor ?? {};
    const toughnessData = armor.toughness ?? {};
    if (ap === "none") ap = 1;
    if (ap === "half") ap = 0.5;
    if (ap === "ignore") ap = 0;
    const impactArmor = Math.floor(finiteNumber(armor.impact, 0) * ap);
    const ballisticArmor = Math.floor(finiteNumber(armor.ballistic, 0) * ap);
    const toughness = Math.max(finiteNumber(toughnessData.total, 0), 0);
    const source = normalizeDamageSource(this._damageSource, d.healthSys);
    const applyToughness = this.useToughness(d.healthSys.useToughness, this._damageType, source, d.healthSys.mode);
    const totalDmg = finiteNumber(this.basicDamage, 0) + finiteNumber(h.dmgMod, 0);
    
    let dmgProtection
    if (this._useInjury) {
      dmgProtection = applyToughness ? toughness : Math.ceil(toughness/2);
      injuryParts.push({
        label: game.i18n.localize("age-system.toughness"),
        value: dmgProtection
      })

      const toughnessMod = finiteNumber(h.toughMod, 0);
      dmgProtection += toughnessMod;
      if (toughnessMod !== 0) injuryParts.push({
        label: game.i18n.localize("age-system.mod"),
        value: toughnessMod
      })

      dmgProtection -= finiteNumber(h.injuryMarks, 0);
      // Injury Marks is not sent to chat card: when prompting for Toughness Roll, character will first check for current Marks and them apply to roll

      const testMod = finiteNumber(h.testMod, 0);
      dmgProtection += testMod;
      if (testMod) injuryParts.push({
        label: game.i18n.localize("age-system.bonus.testMod"),
        value: testMod
      })
    } else {
      dmgProtection = applyToughness ? toughness : 0;
    }

    let armorDesc
    if (this._useBallistic && source === 'ballistic') {
      dmgProtection += ballisticArmor;
      armorDesc = {
        label: game.i18n.localize("age-system.bonus.ballisticArmor"),
        value: ballisticArmor
      }
    } 
    if (this._useBallistic && source === 'impact') {
      dmgProtection += impactArmor;
      armorDesc = {
        label: game.i18n.localize("age-system.bonus.impactArmor"),
        value: impactArmor
      }
    }
    
    if (!this._useBallistic && source !== 'penetrating') {
      dmgProtection += impactArmor;
      armorDesc = {
        label: game.i18n.localize("age-system.armor"),
        value: impactArmor
      } 
    }
    if (armorDesc) injuryParts.push(armorDesc);

    let reducedDmg = totalDmg - dmgProtection;
    if (reducedDmg < 0) reducedDmg = 0;

    if (h.ignoreDmg) {
      h.remainingHP = finiteNumber(hData.health?.value, 0);
      h.totalDmg = 0;
      h.dmgProtection = dmgProtection;
    } else {
      h.remainingHP = finiteNumber(hData.health?.value, 0) - reducedDmg;
      if (h.remainingHP < 0) h.remainingHP = 0;
      h.damage = reducedDmg
      h.totalDmg = Number(totalDmg);
      h.dmgProtection = dmgProtection;
      h.injuryParts = injuryParts;
    }

    return h;
  }

  useToughness(setting, type, source, mode) {
    if (!setting) return false;
    switch (mode) {
      case 'none': return true;
      case 'gritty': return source === 'ballistic' ? false : ['stun'].includes(type);
      case 'pulp': return source === 'ballistic' ? false : ['stun'].includes(type) || (['impact'].includes(source) && ['wound'].includes(type));
      case 'cinematic': return !(['penetrating'].includes(source) && ['wound'].includes(type));
      default: return false;
    }
  }
}

/**
 * Send a summary of damage/healing to chat
 * @param {Array} summary - Array of damage/healing summaries
 * @param {boolean} useInjury - Whether the injury system is being used
 * @param {boolean} isHealing - Whether this is a healing summary (default: false)
 * @returns {Promise<ChatMessage>} The created chat message
 */
export async function summaryToChat(summary, useInjury, isHealing = false) {
  const chatTemplate = "/systems/age-system/templates/rolls/damage-summary.hbs";
  const templateData = {
    summary,
    useInjury,
    isHealing,
    healthName: CONFIG.ageSystem.healthSys.healthName
  }
  let chatData = {
    user: game.user.id,
    content: await foundry.applications.handlebars.renderTemplate(chatTemplate, templateData),
    style: CONST.CHAT_MESSAGE_STYLES.OOC,
  }
  applyMessageMode(chatData, MESSAGE_MODES.GM);
  return ChatMessage.create(chatData);
}
