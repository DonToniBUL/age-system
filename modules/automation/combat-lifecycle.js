import {AgeTransactionService} from "./action-transactions.js";
import {ConditionLifecycleService} from "./condition-lifecycle.js";
import {automationFeatureEnabled} from "./mode.js";

const SYSTEM_ID = "age-system";
const MANEUVERS_BY_TIMING = Object.freeze({
  startOfTurn: ["defend", "allOutAttack"],
  endOfTurn: [],
  endOfRound: ["guardUp"],
  endOfEncounter: [],
  nextAttack: ["aim"],
  nextTest: []
});
const processed = new Set();
const combatState = new Map();

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function escape(value) {
  return Handlebars.escapeExpression(String(value ?? ""));
}

function actorFromCombat(combat) {
  return combat?.combatant?.actor ?? combat?.turns?.[combat.turn]?.actor ?? null;
}

function responsibleGM() {
  const active = values(game.users).filter(user => user?.isGM && user?.active !== false).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return active[0]?.id ?? (game.user?.isGM ? game.user.id : null);
}

function turnKey(combat) {
  return `${combat?.round ?? 0}:${combat?.turn ?? -1}:${combat?.combatant?.id ?? combat?.turns?.[combat?.turn]?.id ?? "none"}`;
}

function snapshot(combat) {
  const actor = actorFromCombat(combat);
  return {
    round: Number(combat?.round ?? 0),
    turn: Number(combat?.turn ?? -1),
    actorUuid: actor?.uuid ?? null,
    turnKey: turnKey(combat)
  };
}

async function resolveActor(uuid) {
  const document = uuid ? await foundry.utils.fromUuid(uuid) : null;
  return document?.actor ?? document ?? null;
}

function timingLabel(timing) {
  return game.i18n.localize(`age-system.AUTOMATION.duration.${timing}`);
}

export class CombatLifecycleService {
  static get enabled() {
    return automationFeatureEnabled("enableCombatLifecycle") && this.mode !== "off";
  }

  static get mode() {
    try {
      return game.settings.get(SYSTEM_ID, "combatLifecycleMode") ?? "remind";
    } catch {
      return "off";
    }
  }

  static expiring(actor, timing = "startOfTurn") {
    if (!actor) return {timing, paths: [], effects: []};
    const paths = (MANEUVERS_BY_TIMING[timing] ?? [])
      .map(name => `system.${name}.active`)
      .filter(path => foundry.utils.getProperty(actor, path) === true);
    const effects = ConditionLifecycleService.effects(actor, timing);
    return {timing, paths, effects};
  }

  static async expire(actor, {timing = "startOfTurn", paths = null, effectUuids = null, reason = null} = {}) {
    if (!actor?.update || !this.enabled || !(game.user?.isGM || actor?.isOwner)) return false;
    const current = this.expiring(actor, timing);
    const selectedPaths = Array.isArray(paths) ? paths.filter(path => foundry.utils.getProperty(actor, path) === true) : current.paths;
    const requestedEffects = Array.isArray(effectUuids) ? new Set(effectUuids) : null;
    const selectedEffects = current.effects.filter(effect => !requestedEffects || requestedEffects.has(effect.uuid));
    if (!selectedPaths.length && !selectedEffects.length) return false;

    const transaction = AgeTransactionService.begin({
      label: game.i18n.format("age-system.AUTOMATION.expireTimedEffectsFor", {actor: actor.name, timing: timingLabel(timing)}),
      type: "combat-lifecycle",
      sourceUuid: actor.uuid,
      metadata: {reason: reason ?? timing, timing}
    });
    if (selectedPaths.length) transaction.track(actor, selectedPaths);
    for (const effect of selectedEffects) transaction.track(effect, "disabled");

    try {
      if (selectedPaths.length) await actor.update(Object.fromEntries(selectedPaths.map(path => [path, false])), {ageAutomation: true});
      for (const effect of selectedEffects) await effect.update({disabled: true}, {ageAutomation: true});
      await transaction.commit();
      return {timing, paths: selectedPaths, effects: selectedEffects.map(effect => effect.uuid)};
    } catch (error) {
      await transaction.rollback({removeHistory: true});
      throw error;
    }
  }

  static async _remind(combat, actor, expiring) {
    const names = expiring.paths.map(path => game.i18n.localize(`age-system.${path.split(".")[1]}`));
    names.push(...expiring.effects.map(effect => effect.name));
    const state = {
      version: 2,
      combatUuid: combat?.uuid ?? null,
      turnKey: combat ? turnKey(combat) : null,
      timing: expiring.timing,
      actorUuid: actor.uuid,
      paths: expiring.paths,
      effectUuids: expiring.effects.map(effect => effect.uuid),
      createdAt: Date.now()
    };
    const content = `<div class="age-system age-combat-lifecycle-card"><p><strong>${escape(game.i18n.format("age-system.AUTOMATION.timedEffectsReady", {actor: actor.name, timing: timingLabel(expiring.timing)}))}</strong></p><p>${escape(names.join(" · "))}</p><div class="chat-buttons"><button type="button" class="age-button age-expire-turn-effects"><i class="fa-solid fa-hourglass-end"></i> ${escape(game.i18n.localize("age-system.AUTOMATION.expireNow"))}</button></div></div>`;
    return ChatMessage.create({
      user: game.user.id,
      speaker: ChatMessage.getSpeaker?.({actor}) ?? {alias: actor.name},
      content,
      style: CONST.CHAT_MESSAGE_STYLES.OTHER,
      flags: {[SYSTEM_ID]: {automation: {combatLifecycle: state}}}
    });
  }

  static async _process(combat, actor, timing, uniqueKey) {
    if (!actor) return false;
    const key = `${combat?.uuid ?? "encounter"}:${uniqueKey}:${actor.uuid}:${timing}`;
    if (processed.has(key)) return false;
    const expiring = this.expiring(actor, timing);
    processed.add(key);
    if (!expiring.paths.length && !expiring.effects.length) return false;
    try {
      if (this.mode === "automatic" || ["nextAttack", "nextTest"].includes(timing)) {
        return await this.expire(actor, {timing, paths: expiring.paths, effectUuids: expiring.effects.map(effect => effect.uuid)});
      }
      return await this._remind(combat, actor, expiring);
    } catch (error) {
      processed.delete(key);
      throw error;
    }
  }

  static async onUpdateCombat(combat) {
    if (!this.enabled || !game.user?.isGM || game.user.id !== responsibleGM() || combat?.started === false) return false;
    const combatKey = combat.uuid ?? combat.id ?? "combat";
    const previous = combatState.get(combatKey);
    const current = snapshot(combat);
    const tasks = [];

    if (previous && previous.actorUuid && previous.actorUuid !== current.actorUuid) {
      tasks.push(resolveActor(previous.actorUuid).then(actor => this._process(combat, actor, "endOfTurn", previous.turnKey)));
    }
    if (previous && current.round > previous.round) {
      const actors = Array.from(new Map(values(combat.combatants ?? combat.turns)
        .map(combatant => combatant?.actor)
        .filter(Boolean)
        .map(actor => [actor.uuid, actor])).values());
      for (const actor of actors) tasks.push(this._process(combat, actor, "endOfRound", `round:${previous.round}`));
    }
    const actor = actorFromCombat(combat);
    if (actor) {
      tasks.push(ConditionLifecycleService.onTurnStart(actor, combat));
      tasks.push(this._process(combat, actor, "startOfTurn", current.turnKey));
    }
    combatState.set(combatKey, current);
    const results = await Promise.all(tasks);
    return results.some(Boolean);
  }

  static async onActionCompleted(action, diagnostic) {
    if (!this.enabled || diagnostic?.status !== "success" || !action?.actorUuid) return false;
    const actor = await resolveActor(action.actorUuid);
    if (!actor) return false;
    const results = [];
    if (action.type === "roll.attack") results.push(await this._process(game.combat, actor, "nextAttack", action.id));
    if (String(action.type).startsWith("roll.")) results.push(await this._process(game.combat, actor, "nextTest", action.id));
    return results.some(Boolean);
  }

  static async expireFromMessage(messageOrId) {
    const message = typeof messageOrId === "string" ? game.messages?.get?.(messageOrId) : messageOrId;
    const state = message?.flags?.[SYSTEM_ID]?.automation?.combatLifecycle;
    if (!state || !this.enabled || !game.user?.isGM) return false;
    const actor = await resolveActor(state.actorUuid);
    if (!actor) return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.combatActorUnavailable"));
    return this.expire(actor, {timing: state.timing ?? "startOfTurn", paths: state.paths, effectUuids: state.effectUuids, reason: "reminder"});
  }

  static async onDeleteCombat(combat) {
    if (this.enabled && game.user?.isGM && game.user.id === responsibleGM()) {
      const actors = Array.from(new Map(values(combat?.combatants ?? combat?.turns)
        .map(combatant => combatant?.actor)
        .filter(Boolean)
        .map(actor => [actor.uuid, actor])).values());
      for (const actor of actors) await this._process(combat, actor, "endOfEncounter", `encounter:${combat?.id ?? "deleted"}`);
    }
    this.clearCombat(combat);
  }

  static clearCombat(combat) {
    const combatKey = combat?.uuid ?? combat?.id ?? "combat";
    combatState.delete(combatKey);
    for (const key of Array.from(processed)) if (key.startsWith(`${combatKey}:`)) processed.delete(key);
  }
}

export default CombatLifecycleService;
