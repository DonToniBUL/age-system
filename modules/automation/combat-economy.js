import {automationFeatureEnabled} from "./mode.js";

const SYSTEM_ID = "age-system";
const ECONOMY_PATH = `flags.${SYSTEM_ID}.automation.economy`;

const clone = value => foundry.utils.deepClone(value);

export function normalizeEconomyState(value, turnKey = null) {
  return {
    version: 1,
    turnKey: turnKey ?? value?.turnKey ?? null,
    major: Math.max(0, Number(value?.major ?? 0)),
    minor: Math.max(0, Number(value?.minor ?? 0)),
    free: Math.max(0, Number(value?.free ?? 0)),
    history: Array.isArray(value?.history) ? value.history.slice(-20) : []
  };
}

export function evaluateEconomy(state) {
  const value = normalizeEconomyState(state);
  const legal = value.major <= 1 && value.minor <= 2 && !(value.major > 0 && value.minor > 1);
  return {
    legal,
    remainingMajor: Math.max(0, 1 - value.major),
    remainingMinor: Math.max(0, (value.major > 0 ? 1 : 2) - value.minor)
  };
}

function turnKey(combat) {
  return `${combat?.round ?? 0}:${combat?.turn ?? -1}:${combat?.combatant?.id ?? "none"}`;
}

function combatantFor(actor, combat = game.combat) {
  const combatants = Array.from(combat?.combatants?.values?.() ?? combat?.combatants ?? combat?.turns ?? []);
  return combatants.find(entry => entry?.actor?.uuid === actor?.uuid || entry?.actorId === actor?.id) ?? null;
}

function currentState(combatant, combat = game.combat) {
  const key = turnKey(combat);
  const stored = foundry.utils.getProperty(combatant, ECONOMY_PATH);
  return normalizeEconomyState(stored?.turnKey === key ? stored : null, key);
}

export class CombatEconomyService {
  static get enabled() {
    return automationFeatureEnabled("enableCombatEconomy");
  }

  static state(actor, combat = game.combat) {
    const combatant = combatantFor(actor, combat);
    return combatant ? currentState(combatant, combat) : null;
  }

  static async reset(combat = game.combat) {
    if (!this.enabled || !combat?.combatant?.update) return false;
    const state = normalizeEconomyState(null, turnKey(combat));
    await combat.combatant.update({[ECONOMY_PATH]: state}, {ageAutomation: true});
    return clone(state);
  }

  static async record(actor, type, {label = null, source = null} = {}) {
    if (!this.enabled || !["major", "minor", "free"].includes(type)) return false;
    const combat = game.combat;
    const combatant = combatantFor(actor, combat);
    if (!combat?.started || !combatant?.update) return false;
    const state = currentState(combatant, combat);
    state[type] += 1;
    state.history.push({
      id: foundry.utils.randomID?.(12) ?? `${Date.now()}`,
      type,
      label: label ?? type,
      source,
      offTurn: combat.combatant?.id !== combatant.id,
      timestamp: Date.now()
    });
    state.history = state.history.slice(-20);
    await combatant.update({[ECONOMY_PATH]: state}, {ageAutomation: true});
    const evaluation = evaluateEconomy(state);
    if (!evaluation.legal) ui.notifications.warn(game.i18n.format("age-system.AUTOMATION.actionEconomyWarning", {actor: actor.name}));
    return {...clone(state), evaluation};
  }

  static async undo(actor) {
    const combat = game.combat;
    const combatant = combatantFor(actor, combat);
    if (!this.enabled || !combatant?.update) return false;
    const state = currentState(combatant, combat);
    const entry = state.history.pop();
    if (!entry) return false;
    state[entry.type] = Math.max(0, state[entry.type] - 1);
    await combatant.update({[ECONOMY_PATH]: state}, {ageAutomation: true});
    return clone(state);
  }

  static async onUpdateCombat(combat) {
    if (!this.enabled || !combat?.started || !combat?.combatant) return false;
    const state = foundry.utils.getProperty(combat.combatant, ECONOMY_PATH);
    if (state?.turnKey === turnKey(combat)) return false;
    return this.reset(combat);
  }

  static async onActionCompleted(action, diagnostic) {
    if (!this.enabled || diagnostic?.status !== "success" || !action?.actorUuid) return false;
    const costs = {
      "roll.attack": "major",
      "roll.power": "major"
    };
    const type = costs[action.type];
    if (!type) return false;
    let actor = await foundry.utils.fromUuid(action.actorUuid);
    actor = actor?.actor ?? actor;
    if (!actor) return false;
    return this.record(actor, type, {label: diagnostic.type, source: action.id});
  }

  static async onActorUpdate(actor, changed, options = {}) {
    if (!this.enabled || options.ageAutomation === true) return false;
    const maneuvers = [
      ["aim", "minor"],
      ["guardUp", "minor"],
      ["defend", "major"],
      ["allOutAttack", "major"]
    ];
    for (const [name, type] of maneuvers) {
      const branch = foundry.utils.getProperty(changed, `system.${name}`);
      const Operator = foundry.data?.operators?.DataFieldOperator;
      const active = typeof Operator?.get === "function" ? Operator.get(branch)?.active : branch?.active;
      if (active === true) {
        return this.record(actor, type, {label: game.i18n.localize(`age-system.${name}`), source: `maneuver:${name}`});
      }
    }
    return false;
  }

  static open() {
    if (!this.enabled) return false;
    return new CombatEconomyTracker().render(true);
  }
}

export class CombatEconomyTracker extends foundry.appv1.api.FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "age-combat-economy",
      template: "systems/age-system/templates/automation/combat-economy.hbs",
      classes: ["age-system", "dialog"],
      title: game.i18n.localize("age-system.AUTOMATION.combatEconomy"),
      width: 560,
      height: "auto",
      resizable: true,
      minimizable: true
    });
  }

  getData() {
    const actor = game.combat?.combatant?.actor ?? null;
    const state = actor ? CombatEconomyService.state(actor) : null;
    return {
      ...super.getData(),
      actor,
      state,
      evaluation: state ? evaluateEconomy(state) : null,
      history: [...(state?.history ?? [])].reverse()
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-economy-type]").on("click", async event => {
      const actor = game.combat?.combatant?.actor;
      if (!actor) return;
      await CombatEconomyService.record(actor, event.currentTarget.dataset.economyType, {label: event.currentTarget.dataset.label});
      this.render(false);
    });
    html.find(".age-economy-undo").on("click", async () => {
      const actor = game.combat?.combatant?.actor;
      if (actor) await CombatEconomyService.undo(actor);
      this.render(false);
    });
  }

  _updateObject() {}
}

export default CombatEconomyService;
