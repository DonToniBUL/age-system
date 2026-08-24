import {normalizeActiveEffectData, statusEffectArray} from "../compat.js";

const SYSTEM_ID = "age-system";

export const AGE_DURATION_TIMINGS = Object.freeze([
  "startOfTurn",
  "endOfTurn",
  "endOfRound",
  "endOfEncounter",
  "nextAttack",
  "nextTest"
]);

const clone = value => foundry.utils.deepClone(value);

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

export function normalizeAgeDuration(value, fallback = null) {
  if (typeof value === "string") value = {timing: value};
  if (!value || typeof value !== "object") return fallback;
  const timing = String(value.timing ?? "").trim();
  if (!AGE_DURATION_TIMINGS.includes(timing)) return fallback;
  return {
    version: 1,
    timing,
    combatUuid: value.combatUuid ? String(value.combatUuid) : null,
    createdRound: Number.isFinite(Number(value.createdRound)) ? Number(value.createdRound) : null,
    createdTurn: Number.isFinite(Number(value.createdTurn)) ? Number(value.createdTurn) : null,
    sourceUuid: value.sourceUuid ? String(value.sourceUuid) : null,
    label: value.label ? String(value.label) : null
  };
}

export function ageEffectDuration(effect) {
  const explicit = foundry.utils.getProperty(effect, `flags.${SYSTEM_ID}.automation.duration`);
  const legacy = foundry.utils.getProperty(effect, `flags.${SYSTEM_ID}.automation.expires`);
  return normalizeAgeDuration(explicit ?? legacy);
}

function configuredStatus(statusId) {
  return statusEffectArray(CONFIG.statusEffects).find(effect => effect.id === statusId)
    ?? Object.values(CONFIG.statusEffects ?? {}).find(effect => effect?.id === statusId)
    ?? Object.values(CONFIG.ageSystem?.statusEffects ?? {}).flatMap(statusEffectArray).find(effect => effect.id === statusId)
    ?? null;
}

function effectStatuses(effect) {
  const statuses = effect?.statuses;
  if (statuses instanceof Set) return Array.from(statuses);
  return Array.isArray(statuses) ? statuses : [];
}

function actorIsAvailable(actor) {
  if (!actor || actor._destroyed === true) return false;
  if (actor.isToken) {
    const token = actor.token;
    if (!token || token._destroyed === true) return false;
    return typeof token.collection?.has !== "function" || token.collection.has(token.id);
  }
  if (!actor.pack && typeof game.actors?.has === "function") return game.actors.has(actor.id);
  return typeof actor.collection?.has !== "function" || actor.collection.has(actor.id);
}

export class ConditionLifecycleService {
  static duration(timing, {sourceUuid = null, label = null, combat = game.combat} = {}) {
    return normalizeAgeDuration({
      timing,
      sourceUuid,
      label,
      combatUuid: combat?.uuid ?? null,
      createdRound: combat?.round ?? null,
      createdTurn: combat?.turn ?? null
    });
  }

  static effects(actor, timing = null) {
    return values(actor?.effects).filter(effect => {
      if (effect?.disabled === true) return false;
      const duration = ageEffectDuration(effect);
      return duration && (!timing || duration.timing === timing);
    });
  }

  static statusEffect(actor, statusId) {
    return values(actor?.effects).find(effect => effectStatuses(effect).includes(statusId)
      || effect?.id === statusId
      || foundry.utils.getProperty(effect, `flags.${SYSTEM_ID}.statusId`) === statusId) ?? null;
  }

  static async applyStatus(actor, statusId, {duration = null, sourceUuid = null, label = null} = {}) {
    if (!actor?.createEmbeddedDocuments) throw new TypeError("The Actor cannot receive AGE conditions.");
    const existing = this.statusEffect(actor, statusId);
    const normalizedDuration = duration ? normalizeAgeDuration(duration) : null;
    if (existing?.update) {
      const update = {disabled: false};
      if (normalizedDuration) update[`flags.${SYSTEM_ID}.automation.duration`] = normalizedDuration;
      await existing.update(update);
      return existing;
    }

    const configured = configuredStatus(statusId);
    if (!configured) throw new Error(`Unknown AGE status: ${statusId}`);
    const data = normalizeActiveEffectData(clone(configured), [
      ...(CONFIG.ageSystem?.actorDerivedDataKey ?? []),
      ...(CONFIG.ageSystem?.charAblKey ?? [])
    ]);
    delete data._id;
    data.name = game.i18n.localize(data.name ?? statusId);
    data.statuses = Array.from(new Set([...(data.statuses ?? []), statusId]));
    data.flags = clone(data.flags ?? {});
    data.flags[SYSTEM_ID] = clone(data.flags[SYSTEM_ID] ?? {});
    data.flags[SYSTEM_ID].statusId = statusId;
    data.flags[SYSTEM_ID].automation = clone(data.flags[SYSTEM_ID].automation ?? {});
    if (normalizedDuration) data.flags[SYSTEM_ID].automation.duration = normalizedDuration;
    if (sourceUuid) data.flags[SYSTEM_ID].automation.sourceUuid = sourceUuid;
    if (label) data.flags[SYSTEM_ID].automation.label = label;
    const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [data], {ageAutomation: true});
    return created ?? null;
  }

  static async applyEffect(actor, {name, img = "icons/svg/aura.svg", changes = [], duration = null, sourceUuid = null} = {}) {
    if (!actor?.createEmbeddedDocuments) throw new TypeError("The Actor cannot receive AGE effects.");
    const data = normalizeActiveEffectData({
      name,
      img,
      changes,
      flags: {
        [SYSTEM_ID]: {
          automation: {
            ...(duration ? {duration: normalizeAgeDuration(duration)} : {}),
            ...(sourceUuid ? {sourceUuid} : {})
          }
        }
      }
    }, [...(CONFIG.ageSystem?.actorDerivedDataKey ?? []), ...(CONFIG.ageSystem?.charAblKey ?? [])]);
    const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [data], {ageAutomation: true});
    return created ?? null;
  }

  static async expireEffects(actor, timing, {effectUuids = null} = {}) {
    const requested = Array.isArray(effectUuids) ? new Set(effectUuids) : null;
    const effects = this.effects(actor, timing).filter(effect => !requested || requested.has(effect.uuid));
    for (const effect of effects) await effect.update({disabled: true}, {ageAutomation: true});
    return effects.map(effect => effect.uuid);
  }

  static async removeEffect(actor, effectUuid) {
    const effect = values(actor?.effects).find(entry => entry.uuid === effectUuid || entry.id === effectUuid);
    if (!effect) return false;
    if (effect.delete) await effect.delete({ageAutomation: true});
    else if (actor?.deleteEmbeddedDocuments) await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id], {ageAutomation: true});
    else return false;
    return true;
  }

  static async _conditionPrompt(actor, action) {
    const state = {version: 1, actorUuid: actor.uuid, statusId: "dying", action, createdAt: Date.now()};
    const key = action === "apply" ? "dyingPromptApply" : "dyingPromptRemove";
    const button = action === "apply" ? "applyDying" : "removeDying";
    return ChatMessage.create({
      user: game.user.id,
      speaker: ChatMessage.getSpeaker?.({actor}) ?? {alias: actor.name},
      content: `<section class="age-system"><p><strong>${Handlebars.escapeExpression(game.i18n.format(`age-system.AUTOMATION.${key}`, {actor: actor.name}))}</strong></p><p class="notes">${Handlebars.escapeExpression(game.i18n.localize("age-system.AUTOMATION.dyingPromptSafety"))}</p><div class="chat-buttons"><button type="button" class="age-button age-resolve-condition-prompt"><i class="fa-solid fa-heart-pulse"></i> ${Handlebars.escapeExpression(game.i18n.localize(`age-system.AUTOMATION.${button}`))}</button></div></section>`,
      style: CONST.CHAT_MESSAGE_STYLES.OTHER,
      flags: {[SYSTEM_ID]: {automation: {conditionPrompt: state}}}
    });
  }

  static async onActorUpdate(actor, changed, options = {}) {
    if (options.ageAutomation === true || actor?.type !== "char") return false;
    const healthBranch = foundry.utils.getProperty(changed, "system.health");
    const Operator = foundry.data?.operators?.DataFieldOperator;
    const health = typeof Operator?.get === "function"
      ? Operator.get(healthBranch)?.value
      : healthBranch?.value;
    if (!Number.isFinite(Number(health))) return false;
    await new Promise(resolve => globalThis.setTimeout(resolve, 75));
    if (!actorIsAvailable(actor)) return false;
    try {
      if (Number(actor.system?.health?.value) !== Number(health)) return false;
      const existingDying = this.statusEffect(actor, "dying");
      const dying = existingDying?.disabled === true ? null : existingDying;
      const promptPath = `flags.${SYSTEM_ID}.automation.lastHealthPrompt`;
      if (Number(health) <= 0 && !dying) {
        if (foundry.utils.getProperty(actor, promptPath) === 0) return false;
        await actor.update({[promptPath]: 0}, {ageAutomation: true});
        return this._conditionPrompt(actor, "apply");
      }
      if (Number(health) > 0 && dying) {
        await dying.update({disabled: true}, {ageAutomation: true});
        await actor.update({[`flags.${SYSTEM_ID}.automation.dying`]: null, [promptPath]: null}, {ageAutomation: true});
        return true;
      }
      if (Number(health) > 0 && foundry.utils.getProperty(actor, promptPath) !== null) {
        await actor.update({[promptPath]: null}, {ageAutomation: true});
      }
    } catch (error) {
      if (!actorIsAvailable(actor)) return false;
      throw error;
    }
    return false;
  }

  static async resolvePrompt(messageOrId) {
    const message = typeof messageOrId === "string" ? game.messages?.get?.(messageOrId) : messageOrId;
    const state = message?.flags?.[SYSTEM_ID]?.automation?.conditionPrompt;
    if (!state) return false;
    const actor = await foundry.utils.fromUuid(state.actorUuid);
    const resolved = actor?.actor ?? actor;
    if (!resolved || !(game.user?.isGM || resolved.isOwner)) return false;
    if (state.action === "apply") return this.applyStatus(resolved, state.statusId);
    const effect = this.statusEffect(resolved, state.statusId);
    if (!effect) return false;
    await effect.update({disabled: true}, {ageAutomation: true});
    return true;
  }

  static async onTurnStart(actor, combat) {
    const existingDying = this.statusEffect(actor, "dying");
    const dying = existingDying?.disabled === true ? null : existingDying;
    if (!dying || !game.user?.isGM) return false;
    const key = `${combat?.round ?? 0}:${combat?.turn ?? -1}`;
    const path = `flags.${SYSTEM_ID}.automation.dying`;
    const previous = foundry.utils.getProperty(actor, path) ?? {};
    if (previous.turnKey === key) return false;
    const rounds = Math.max(0, Number(previous.rounds ?? 0)) + 1;
    const constitution = Number(actor.system?.abilities?.cons?.total ?? actor.system?.abilities?.cons?.value ?? 0);
    const limit = Math.max(1, 2 + (Number.isFinite(constitution) ? constitution : 0));
    const gameMode = game.settings.get(SYSTEM_ID, "gameMode");
    const survivalTest = ["pulp", "cinematic"].includes(gameMode) && rounds >= limit;
    const due = rounds >= limit;
    await actor.update({[path]: {version: 1, rounds, limit, turnKey: key, gameMode}}, {ageAutomation: true});
    const detail = survivalTest
      ? game.i18n.format("age-system.AUTOMATION.dyingSurvivalDue", {rounds, limit})
      : (due ? game.i18n.format("age-system.AUTOMATION.dyingDeadlineDue", {rounds, limit}) : game.i18n.format("age-system.AUTOMATION.dyingRound", {rounds, limit}));
    await ChatMessage.create({
      user: game.user.id,
      speaker: ChatMessage.getSpeaker?.({actor}) ?? {alias: actor.name},
      content: `<section class="age-system"><p><strong>${Handlebars.escapeExpression(actor.name)} · ${Handlebars.escapeExpression(game.i18n.localize("age-system.conditions.dying"))}</strong></p><p>${Handlebars.escapeExpression(detail)}</p><p class="notes">${Handlebars.escapeExpression(game.i18n.localize("age-system.AUTOMATION.dyingNoAutoDeath"))}</p></section>`,
      style: CONST.CHAT_MESSAGE_STYLES.OTHER
    });
    return {rounds, limit, due, survivalTest};
  }
}

export default ConditionLifecycleService;
