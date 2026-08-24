import {ageSystem} from "../config.js";
import {AgeTransactionService} from "./action-transactions.js";
import {automationFeatureEnabled} from "./mode.js";

const SYSTEM_ID = "age-system";
const RECOVERY_PATH = `flags.${SYSTEM_ID}.automation.recovery`;

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function selectedActorUuids() {
  const tokens = [...values(game.user?.targets), ...values(globalThis.canvas?.tokens?.controlled)];
  return new Set(tokens.map(token => token?.actor?.uuid).filter(Boolean));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function recoveryFormula(actor, kind, {gameMode = "none", cinematicOnlyStun = false} = {}) {
  const constitution = finite(actor?.system?.abilities?.cons?.total ?? actor?.system?.abilities?.cons?.value, 0);
  const level = finite(actor?.system?.level, 0);
  if (kind === "sleep" && gameMode === "gritty") return {amount: Math.max(0, 5 + constitution), full: false};
  if (kind === "sleep") return {
    amount: Math.max(0, 10 + constitution + level),
    full: gameMode === "cinematic" && cinematicOnlyStun === true
  };
  return {amount: Math.max(0, 5 + constitution + level), full: false};
}

function encounterState(actor) {
  const value = foundry.utils.getProperty(actor, RECOVERY_PATH);
  return value && typeof value === "object" ? foundry.utils.deepClone(value) : null;
}

export class RecoveryService {
  static get enabled() {
    return automationFeatureEnabled("enableRecoveryAutomation");
  }

  static async recordEncounter(combat) {
    if (!this.enabled || !game.user?.isGM) return false;
    const id = combat?.uuid ?? combat?.id ?? `encounter-${Date.now()}`;
    const actors = Array.from(new Map(values(combat?.combatants ?? combat?.turns)
      .map(combatant => combatant?.actor)
      .filter(actor => actor?.type === "char")
      .map(actor => [actor.uuid, actor])).values());
    for (const actor of actors) {
      await actor.update({[RECOVERY_PATH]: {
        version: 1,
        encounterId: id,
        endedAt: Date.now(),
        endedAtZero: finite(actor.system?.health?.value, 0) <= 0,
        breatherTaken: false
      }}, {ageAutomation: true});
    }
    return actors.length;
  }

  static eligibility(actor, kind, {gameMode = game.settings.get(SYSTEM_ID, "gameMode"), grittyWoundDamage = false} = {}) {
    if (!actor || actor.type !== "char") return {eligible: false, reason: "notCharacter"};
    if (kind !== "breather") return {eligible: true, reason: null};
    const encounter = encounterState(actor);
    if (encounter?.endedAtZero) return {eligible: false, reason: "endedAtZero"};
    if (encounter?.breatherTaken) return {eligible: false, reason: "alreadyTaken"};
    if (gameMode === "gritty" && grittyWoundDamage) return {eligible: false, reason: "grittyWound"};
    return {eligible: true, reason: encounter ? null : "untrackedEncounter"};
  }

  static async recover(actor, kind, options = {}) {
    if (!this.enabled || !actor?.update) return false;
    const gameMode = options.gameMode ?? game.settings.get(SYSTEM_ID, "gameMode");
    const eligibility = this.eligibility(actor, kind, {...options, gameMode});
    if (!eligibility.eligible) return {actorUuid: actor.uuid, actorName: actor.name, applied: false, reason: eligibility.reason};
    const formula = recoveryFormula(actor, kind, {...options, gameMode});
    const current = finite(actor.system?.health?.value, 0);
    const maximum = finite(actor.system?.health?.max, current);
    const amount = formula.full ? Math.max(0, maximum - current) : formula.amount;
    const transaction = options.transaction ?? AgeTransactionService.begin({
      label: `${actor.name}: ${game.i18n.localize(`age-system.AUTOMATION.recovery.${kind}`)}`,
      type: `recovery-${kind}`,
      sourceUuid: actor.uuid
    });
    const ownTransaction = !options.transaction;
    const encounter = encounterState(actor);
    if (kind === "breather") transaction.track(actor, RECOVERY_PATH);
    try {
      const result = ageSystem.healthSys.useInjury
        ? await actor.healMarks(amount, {transaction})
        : await actor.applyHPchange(amount, {isHealing: true, isNewHP: false, transaction});
      if (kind === "breather") {
        await actor.update({[RECOVERY_PATH]: {
          version: 1,
          ...(encounter ?? {encounterId: null, endedAt: null, endedAtZero: false}),
          breatherTaken: true,
          takenAt: Date.now()
        }}, {ageAutomation: true});
      }
      if (ownTransaction) await transaction.commit();
      return {
        actorUuid: actor.uuid,
        actorName: actor.name,
        applied: true,
        amount,
        full: formula.full,
        untrackedEncounter: eligibility.reason === "untrackedEncounter",
        result
      };
    } catch (error) {
      if (ownTransaction) await transaction.rollback({removeHistory: true});
      throw error;
    }
  }

  static async recoverMany(actorUuids, kind, options = {}) {
    if (!this.enabled) return false;
    const actors = [];
    for (const uuid of actorUuids ?? []) {
      let actor = await foundry.utils.fromUuid(uuid);
      actor = actor?.actor ?? actor;
      if (actor?.type === "char") actors.push(actor);
    }
    const transaction = AgeTransactionService.begin({
      label: game.i18n.localize(`age-system.AUTOMATION.recovery.${kind}`),
      type: `recovery-${kind}`,
      metadata: {targets: actors.length}
    });
    try {
      const results = [];
      for (const actor of actors) results.push(await this.recover(actor, kind, {...options, transaction}));
      await transaction.commit();
      const rows = results.map(result => `<li><strong>${Handlebars.escapeExpression(result.actorName)}</strong>: ${result.applied ? game.i18n.format("age-system.AUTOMATION.recoveryApplied", {amount: result.amount}) : game.i18n.localize(`age-system.AUTOMATION.recoveryReason.${result.reason}`)}</li>`).join("");
      await ChatMessage.create({
        user: game.user.id,
        speaker: {alias: game.user.name},
        content: `<section class="age-system"><h3>${Handlebars.escapeExpression(game.i18n.localize(`age-system.AUTOMATION.recovery.${kind}`))}</h3><ul>${rows}</ul></section>`,
        style: CONST.CHAT_MESSAGE_STYLES.OTHER
      });
      return results;
    } catch (error) {
      await transaction.rollback({removeHistory: true});
      throw error;
    }
  }

  static open() {
    if (!this.enabled) return false;
    return new RecoveryAssistant().render(true);
  }
}

export class RecoveryAssistant extends foundry.appv1.api.FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "age-recovery-assistant",
      template: "systems/age-system/templates/automation/recovery-assistant.hbs",
      classes: ["age-system", "dialog"],
      title: game.i18n.localize("age-system.AUTOMATION.recoveryAssistant"),
      width: 620,
      height: 620,
      resizable: true,
      minimizable: true,
      closeOnSubmit: false
    });
  }

  getData() {
    const selected = selectedActorUuids();
    const gameMode = game.settings.get(SYSTEM_ID, "gameMode");
    return {
      ...super.getData(),
      gameMode,
      isGritty: gameMode === "gritty",
      isCinematic: gameMode === "cinematic",
      actors: values(game.actors).filter(actor => actor?.type === "char").map(actor => ({
        uuid: actor.uuid,
        name: actor.name,
        img: actor.img,
        selected: selected.has(actor.uuid),
        health: actor.system?.health?.value,
        maxHealth: actor.system?.health?.max
      })).sort((left, right) => left.name.localeCompare(right.name))
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".age-recovery-form").on("submit", async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new foundry.applications.ux.FormDataExtended(form).object;
      const actorUuids = Array.from(form.querySelectorAll("input[name='actorUuid']:checked"), input => input.value);
      if (!actorUuids.length) return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.requestActorsRequired"));
      await RecoveryService.recoverMany(actorUuids, data.kind, {
        grittyWoundDamage: data.grittyWoundDamage === true,
        cinematicOnlyStun: data.cinematicOnlyStun === true
      });
      this.render(false);
    });
  }

  _updateObject() {}
}

export default RecoveryService;
