import {automationFeatureEnabled} from "./mode.js";
import {MultiTargetService} from "./multi-target.js";
import {AgeActionService} from "./actions.js";

const SYSTEM_ID = "age-system";
const locks = new Set();

function clone(value) {
  return foundry.utils.deepClone(value);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function messageDocument(messageOrId) {
  return typeof messageOrId === "string" ? game.messages?.get?.(messageOrId) : messageOrId;
}

function resistanceState(message) {
  return clone(message?.flags?.[SYSTEM_ID]?.automation?.powerResistance ?? null);
}

function targetKey(target) {
  return target?.key ?? target?.tokenUuid ?? target?.actorUuid ?? null;
}

function resultFor(state, key) {
  if (!state?.results || !key) return null;
  if (Array.isArray(state.results)) {
    return state.results.find(result => result?.key === key) ?? null;
  }
  return state.results[key] ?? foundry.utils.getProperty(state.results, key) ?? null;
}

function resultEntries(state) {
  if (Array.isArray(state?.results)) return state.results.map(clone);
  return (state?.targets ?? []).flatMap(target => {
    const key = targetKey(target);
    const result = resultFor(state, key);
    return result ? [{key, ...clone(result)}] : [];
  });
}

async function resolveActor(target) {
  let document = target?.tokenUuid ? await foundry.utils.fromUuid(target.tokenUuid) : null;
  if (document?.documentName === "Token") return document.actor;
  if (document?.actor) return document.actor;
  document = target?.actorUuid ? await foundry.utils.fromUuid(target.actorUuid) : document;
  return document?.actor ?? document ?? null;
}

function canRollActor(actor) {
  return Boolean(actor && (game.user?.isGM || actor.isOwner));
}

function canUpdateMessage(message) {
  const authorId = message?.author?.id ?? message?.user?.id ?? message?.user;
  return Boolean(game.user?.isGM || message?.isOwner || authorId === game.user?.id);
}

function rollOutcome(result) {
  const data = result?.flags?.[SYSTEM_ID]?.ageroll?.rollData
    ?? result?.data?.flags?.[SYSTEM_ID]?.ageroll?.rollData
    ?? null;
  const total = result?.rolls?.[0]?.total ?? result?.data?.rolls?.[0]?.total ?? data?.rolls?.[0]?.total ?? null;
  return {
    success: data?.isSuccess === true,
    total: Number.isFinite(Number(total)) ? Number(total) : null,
    messageId: result?.id ?? result?._id ?? null
  };
}

function escape(value) {
  return Handlebars.escapeExpression(String(value ?? ""));
}

export class PowerResistanceService {
  static get enabled() {
    return automationFeatureEnabled("enablePowerResistance");
  }

  static prepare(item, targets = game.user?.targets) {
    if (!this.enabled || item?.type !== "power" || item.system?.hasTest !== true) return null;
    const heals = Boolean(item.hasHealing || item.system?.hasHealing || item.system?.causeHealing);
    const damages = Boolean(item.hasDamage || item.system?.hasDamage || item.system?.causeDamage);
    // A healing-only Power may have an activation test, but recipients do not
    // roll resistance and must never be split into damage groups.
    if (heals && !damages) return null;
    return {
      version: 2,
      itemUuid: item.uuid ?? null,
      itemName: item.name,
      force: Math.max(0, finite(item.system?.itemForce, 10)),
      ability: item.system?.testAbl || "will",
      focus: String(item.system?.testFocus ?? "").trim(),
      hasDamage: damages,
      targets: MultiTargetService.collect(targets),
      results: [],
      createdAt: Date.now()
    };
  }

  static state(messageOrId) {
    return resistanceState(messageDocument(messageOrId));
  }

  static async _writeState(message, state) {
    if (!message?.update) throw new TypeError("A Chat Message is required for a resistance test.");
    await message.update({[`flags.${SYSTEM_ID}.automation.powerResistance`]: clone(state)});
    return state;
  }

  static async _ensureTargets(message, state) {
    if (state.targets?.length) return state;
    const targets = MultiTargetService.collect(game.user?.targets);
    if (!targets.length) return state;
    state.targets = targets;
    await this._writeState(message, state);
    return state;
  }

  static async rollTarget(messageOrId, key, {ageAction = null} = {}) {
    const message = messageDocument(messageOrId);
    let state = resistanceState(message);
    if (!message || !state || !this.enabled) return false;
    if (!ageAction && AgeActionService.supports("roll.resistance")) {
      const target = state.targets?.find(entry => targetKey(entry) === key);
      const execution = await AgeActionService.execute({
        type: "roll.resistance",
        messageUuid: message.uuid ?? `ChatMessage.${message.id ?? message._id}`,
        targetUuids: [target?.tokenUuid ?? target?.actorUuid].filter(Boolean),
        payload: {targetKey: key, all: false},
        metadata: {origin: "power-resistance.rollTarget"}
      }, {
        executor: action => this.rollTarget(message, key, {ageAction: action})
      });
      return execution.result;
    }
    if (!canUpdateMessage(message)) {
      ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.cannotUpdateResistance"));
      return false;
    }
    state = await this._ensureTargets(message, state);
    const target = state.targets.find(entry => targetKey(entry) === key);
    if (!target) return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.noResistanceTarget"));

    const lockKey = message.id ?? message._id;
    if (locks.has(lockKey)) return false;
    locks.add(lockKey);
    try {
      const actor = await resolveActor(target);
      if (!canRollActor(actor)) {
        ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.cannotRollResistance"));
        return false;
      }
      const ROLL_TYPE = CONFIG.ageSystem.ROLL_TYPE;
      const focus = state.focus || null;
      const result = await game.ageSystem.roll({
        actor,
        abl: state.ability,
        itemRolled: focus,
        rollTN: state.force,
        rollType: focus ? ROLL_TYPE.FOCUS : ROLL_TYPE.ABILITY,
        flavor: actor.name,
        flavor2: game.i18n.format("age-system.AUTOMATION.resistanceAgainst", {power: state.itemName}),
        ageAction
      });
      if (!result) return false;

      const outcome = rollOutcome(result);
      state = resistanceState(message) ?? state;
      const previous = resultFor(state, key)?.attempts ?? [];
      const resistanceResult = {
        key,
        ...outcome,
        actorUuid: actor.uuid,
        actionId: ageAction?.id ?? null,
        rolledAt: Date.now(),
        rolledBy: game.user?.id ?? null,
        attempts: [...previous, {...outcome, rolledAt: Date.now(), rolledBy: game.user?.id ?? null}].slice(-10)
      };
      state.version = 2;
      state.results = resultEntries(state).filter(entry => entry.key !== key);
      state.results.push(resistanceResult);
      await this._writeState(message, state);
      return resistanceResult;
    } finally {
      locks.delete(lockKey);
    }
  }

  static async rollAll(messageOrId, {ageAction = null} = {}) {
    const message = messageDocument(messageOrId);
    let state = resistanceState(message);
    if (!message || !state || !this.enabled) return [];
    if (!ageAction && AgeActionService.supports("roll.resistance")) {
      const execution = await AgeActionService.execute({
        type: "roll.resistance",
        messageUuid: message.uuid ?? `ChatMessage.${message.id ?? message._id}`,
        targetUuids: (state.targets ?? []).map(target => target.tokenUuid ?? target.actorUuid).filter(Boolean),
        payload: {all: true},
        metadata: {origin: "power-resistance.rollAll"}
      }, {
        executor: action => this.rollAll(message, {ageAction: action})
      });
      return execution.result;
    }
    if (!canUpdateMessage(message)) {
      ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.cannotUpdateResistance"));
      return [];
    }
    state = await this._ensureTargets(message, state);
    if (!state.targets.length) {
      ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.noResistanceTargets"));
      return [];
    }
    const results = [];
    for (const target of state.targets) {
      const actor = await resolveActor(target);
      if (!canRollActor(actor)) continue;
      const result = await this.rollTarget(message, targetKey(target), {ageAction});
      if (result) results.push(result);
    }
    if (!results.length) ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.noOwnedResistanceTargets"));
    return results;
  }

  static damageTargets(messageOrId, {resisted = false, fallback = []} = {}) {
    const state = resistanceState(messageDocument(messageOrId));
    if (!state?.targets?.length) return clone(fallback ?? []);
    return state.targets
      .filter(target => {
        const result = resultFor(state, targetKey(target));
        return resisted ? result?.success === true : result?.success !== true;
      })
      .map(target => ({...clone(target), hit: true}));
  }

  static damageGroupStatus(messageOrId) {
    const state = resistanceState(messageDocument(messageOrId));
    const targets = state?.targets ?? [];
    if (!targets.length) {
      return {locked: false, total: 0, rolled: 0, unrolled: 0, allRolled: false, full: 0, resisted: 0};
    }
    let rolled = 0;
    let resisted = 0;
    let full = 0;
    for (const target of targets) {
      const result = resultFor(state, targetKey(target));
      if (result) rolled += 1;
      if (result?.success === true) resisted += 1;
      else full += 1;
    }
    return {
      locked: true,
      total: targets.length,
      rolled,
      unrolled: targets.length - rolled,
      allRolled: rolled === targets.length,
      full,
      resisted
    };
  }

  static decorate(message, html) {
    const state = resistanceState(message);
    if (!state || !this.enabled || !html?.querySelector) return;
    const root = html.querySelector(".age-system.age-roll-card, .age-roll-card, .base-age-roll");
    if (!root || root.querySelector(".age-power-resistance-controls")) return;
    const rows = state.targets?.length
      ? state.targets.map(target => {
          const key = targetKey(target);
          const result = resultFor(state, key);
          const status = result
            ? game.i18n.localize(result.success ? "age-system.AUTOMATION.resisted" : "age-system.AUTOMATION.notResisted")
            : game.i18n.localize("age-system.AUTOMATION.notRolled");
          const icon = result ? (result.success ? "fa-shield" : "fa-shield-halved") : "fa-dice";
          return `<div class="flexrow" style="align-items:center;gap:.35rem"><span style="flex:1 1 auto">${escape(target.name)}</span><span class="notes">${escape(status)}</span><button type="button" class="age-button age-roll-power-resistance" data-target-key="${escape(key)}" style="flex:0 0 auto;width:auto;margin:0"><i class="fa-solid ${icon}"></i> ${escape(game.i18n.localize("age-system.roll"))}</button></div>`;
        }).join("")
      : `<p class="notes" style="margin:.25rem 0">${escape(game.i18n.localize("age-system.AUTOMATION.resistanceUsesCurrentTargets"))}</p>`;
    const resistedDamage = state.hasDamage
      ? `<button type="button" class="age-button roll-damage resisted"><i class="fa-solid fa-shield"></i> ${escape(game.i18n.localize("age-system.AUTOMATION.rollResistedDamage"))}</button>`
      : "";
    const section = document.createElement("section");
    section.className = "age-power-resistance-controls chat-buttons flexcol";
    section.style.cssText = "margin-top:.35rem;padding:.35rem;border-top:1px solid rgba(0,0,0,.25);gap:.3rem";
    section.innerHTML = `<strong>${escape(game.i18n.format("age-system.AUTOMATION.powerResistance", {force: state.force, ability: game.i18n.localize(`age-system.${state.ability}`), focus: state.focus || "—"}))}</strong>${rows}<button type="button" class="age-button age-roll-all-power-resistance"><i class="fa-solid fa-dice-d6"></i> ${escape(game.i18n.localize("age-system.AUTOMATION.rollAllResistance"))}</button>${resistedDamage}`;
    const groups = this.damageGroupStatus(message);
    const noFullTargets = groups.allRolled && groups.full === 0;
    const noResistedTargets = groups.allRolled && groups.resisted === 0;
    if (noResistedTargets) {
      const button = section.querySelector(".roll-damage.resisted");
      const notice = game.i18n.localize("age-system.AUTOMATION.noResistedDamageTargets");
      if (button) {
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        button.title = notice;
      }
      const noticeElement = document.createElement("p");
      noticeElement.className = "notes";
      noticeElement.style.margin = ".2rem 0";
      noticeElement.textContent = notice;
      section.append(noticeElement);
    } else if (noFullTargets) {
      const fullDamage = root.querySelector(".roll-damage.main-dmg");
      const notice = game.i18n.localize("age-system.AUTOMATION.noFullDamageTargets");
      if (fullDamage) {
        fullDamage.disabled = true;
        fullDamage.setAttribute("aria-disabled", "true");
        fullDamage.title = notice;
      }
      const noticeElement = document.createElement("p");
      noticeElement.className = "notes";
      noticeElement.style.margin = ".2rem 0";
      noticeElement.textContent = notice;
      section.append(noticeElement);
    }
    const buttons = root.querySelector(".chat-buttons");
    (buttons ?? root).append(section);
  }
}

export default PowerResistanceService;
