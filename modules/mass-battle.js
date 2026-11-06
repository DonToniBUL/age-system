import {AgeTransactionService} from "./automation/action-transactions.js";
import {colorSchemeClass} from "./color-scheme.js";

export const MASS_BATTLE_ACTOR_TYPE = "force";
export const MASS_BATTLE_STAGES = Object.freeze(["opening", "engagement", "finishing"]);
export const MASS_BATTLE_PROFILES = Object.freeze({
  fage: Object.freeze({id: "fage", militaryAbility: "int", label: "Fantasy AGE"}),
  dage: Object.freeze({id: "dage", militaryAbility: "cunn", label: "Dragon AGE"})
});

const STAGE_RULES = Object.freeze({
  opening: Object.freeze({ability: "military", label: "age-system.MASS_BATTLE.openingMoves"}),
  engagement: Object.freeze({ability: "communication", label: "age-system.MASS_BATTLE.mainEngagement"}),
  finishing: Object.freeze({ability: "choice", label: "age-system.MASS_BATTLE.finishingMoves"})
});

function clone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return structuredClone(value);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function whole(value, fallback = 0) {
  return Math.trunc(finite(value, fallback));
}

function randomId() {
  return globalThis.foundry?.utils?.randomID?.(16) ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function equal(left, right) {
  if (globalThis.foundry?.utils?.equals) return foundry.utils.equals(left, right);
  if (globalThis.foundry?.utils?.objectsEqual) return foundry.utils.objectsEqual(left, right);
  return JSON.stringify(left) === JSON.stringify(right);
}

export function normalizeMassBattleProfile(value) {
  return MASS_BATTLE_PROFILES[value] ? value : "fage";
}

export function massBattleProfileRules(value) {
  return MASS_BATTLE_PROFILES[normalizeMassBattleProfile(value)];
}

export function massBattleSuccessThreshold(totalCombatants) {
  const total = Math.max(0, whole(totalCombatants));
  if (total <= 250) return 5;
  if (total <= 1000) return 10;
  if (total <= 5000) return 15;
  if (total <= 20000) return 20;
  return 25;
}

export function massBattleOutnumberedModifier(friendlyTroops, enemyTroops) {
  const friendly = Math.max(0, finite(friendlyTroops));
  const enemy = Math.max(0, finite(enemyTroops));
  if (!friendly || enemy < friendly * 2) return 0;
  if (enemy >= friendly * 4) return -3;
  if (enemy >= friendly * 3) return -2;
  return -1;
}

export function massBattleCasualtyModifier({
  stageWins = 0,
  stageLosses = 0,
  outnumberedModifier = 0,
  enemyHasFinishingSpecialists = false,
  customModifier = 0
} = {}) {
  return whole(stageWins) - whole(stageLosses)
    + whole(outnumberedModifier)
    - (enemyHasFinishingSpecialists ? 1 : 0)
    + whole(customModifier);
}

/** Pure implementation of the optional FAGE/DAGE casualty calculation. */
export function calculateMassBattleCasualties({troops, rollTotal, targetNumber, stuntDie} = {}) {
  const startingTroops = Math.max(0, whole(troops));
  const total = finite(rollTotal);
  const tn = Math.max(0, whole(targetNumber));
  const degree = Math.max(1, Math.min(6, whole(stuntDie, 1)));
  const success = total >= tn;
  const margin = success ? total - tn : tn - total;
  const rawRate = success ? 35 - (5 * degree) : 30 + (5 * margin);
  const rate = Math.max(0, Math.min(100, rawRate));
  const casualties = Math.min(startingTroops, Math.ceil(startingTroops * rate / 100));
  const dead = Math.round(casualties / 3);
  const wounded = casualties - dead;
  return {
    success,
    margin,
    degree: success ? degree : null,
    rawRate,
    rate,
    troops: startingTroops,
    casualties,
    dead,
    wounded,
    survivors: startingTroops - casualties
  };
}

function stageOutcomes(force) {
  const stages = force.system?.battle?.stages ?? {};
  return MASS_BATTLE_STAGES.reduce((result, id) => {
    const outcome = stages[id]?.result;
    if (outcome === "won") result.wins += 1;
    if (outcome === "lost") result.losses += 1;
    return result;
  }, {wins: 0, losses: 0});
}

function focusValue(actor, name) {
  if (!actor || !name) return 0;
  const checked = actor.checkFocus?.(name);
  if (Number.isFinite(Number(checked?.value))) return Number(checked.value);
  const items = actor.items?.contents ?? actor.items ?? [];
  const focus = Array.from(items).find(item => item.type === "focus"
    && String(item.name ?? "").localeCompare(name, undefined, {sensitivity: "accent"}) === 0);
  return finite(focus?.system?.finalValue, focus?.system?.improved ? 3 : (focus ? 2 : 0));
}

function abilityValue(actor, key) {
  const ability = actor?.system?.abilities?.[key];
  return finite(ability?.total, finite(ability?.value));
}

async function resolveUuid(uuid) {
  if (!uuid || !globalThis.foundry?.utils?.fromUuid) return null;
  try {
    return await foundry.utils.fromUuid(uuid);
  } catch (error) {
    console.warn(`AGE System | Mass Battle link ${uuid} could not be resolved.`, error);
    return null;
  }
}

function thirdDie(roll) {
  const die = roll?.dice?.find?.(term => Number(term.faces) === 6 && term.results?.length >= 3)
    ?? roll?.terms?.find?.(term => Number(term.faces) === 6 && term.results?.length >= 3);
  return Math.max(1, Math.min(6, whole(die?.results?.[2]?.result, 1)));
}

function forceStartingTroops(force) {
  return Math.max(0, whole(force?.system?.troops?.max, force?.system?.troops?.value));
}

function forceCurrentTroops(force) {
  return Math.max(0, whole(force?.system?.troops?.value));
}

function forceTestDifficulty(force) {
  return Math.max(1, whole(force?.system?.primaryTroop?.difficulty, 11));
}

function finishingSpecialists(force) {
  const finishing = force?.system?.specialists?.finishing;
  return Boolean(String(finishing?.description ?? "").trim() || whole(finishing?.bonus) > 0);
}

function stageSourceState(force) {
  return Object.fromEntries(MASS_BATTLE_STAGES.map(id => [id, force.system?.battle?.stages?.[id]?.result ?? "unresolved"]));
}

function casualtySourceState(force, opponent) {
  return {
    forceUuid: force.uuid,
    troopsValue: forceCurrentTroops(force),
    troopsMax: forceStartingTroops(force),
    opponentUuid: opponent?.uuid ?? force.system?.battle?.opponentUuid ?? null,
    opponentTroopsMax: forceStartingTroops(opponent),
    targetNumber: opponent ? forceTestDifficulty(opponent) : Math.max(1, whole(force.system?.battle?.testDifficulty, 11)),
    stageResults: stageSourceState(force),
    customModifier: whole(force.system?.battle?.casualties?.customModifier),
    enemyHasFinishingSpecialists: finishingSpecialists(opponent)
  };
}

export async function massBattleCommanderSummary(force) {
  const profile = massBattleProfileRules(force.system?.profile);
  const commanderData = force.system?.commander ?? {};
  const linked = commanderData.useLinked !== false ? await resolveUuid(commanderData.uuid) : null;
  const validLinked = linked?.documentName === "Actor" && linked.type === "char" ? linked : null;
  const communicationAbility = validLinked ? abilityValue(validLinked, "comm") : finite(commanderData.manual?.communication);
  const communicationFocus = validLinked ? focusValue(validLinked, "Leadership") : finite(commanderData.manual?.leadership);
  const militaryAbility = validLinked ? abilityValue(validLinked, profile.militaryAbility) : finite(commanderData.manual?.military);
  const militaryFocus = validLinked ? focusValue(validLinked, "Military Lore") : finite(commanderData.manual?.militaryLore);
  return {
    uuid: validLinked?.uuid ?? commanderData.uuid ?? null,
    name: validLinked?.name ?? commanderData.name ?? "",
    linked: Boolean(validLinked),
    communicationAbility,
    communicationFocus,
    communicationTotal: communicationAbility + communicationFocus,
    militaryAbility,
    militaryFocus,
    militaryTotal: militaryAbility + militaryFocus,
    militaryAbilityKey: profile.militaryAbility,
    profile: profile.id
  };
}

export async function prepareMassBattleContext(force) {
  const opponent = await resolveUuid(force.system?.battle?.opponentUuid);
  const validOpponent = opponent?.type === MASS_BATTLE_ACTOR_TYPE && opponent.uuid !== force.uuid ? opponent : null;
  const commander = await massBattleCommanderSummary(force);
  const combined = forceStartingTroops(force) + forceStartingTroops(validOpponent);
  const stages = MASS_BATTLE_STAGES.map((id, index) => ({
    id,
    number: index + 1,
    label: game.i18n.localize(STAGE_RULES[id].label),
    ability: id === "finishing"
      ? (force.system?.battle?.finishingAbility === "communication" ? "communication" : "military")
      : STAGE_RULES[id].ability,
    data: force.system?.battle?.stages?.[id] ?? {},
    specialist: force.system?.specialists?.[id] ?? {}
  }));
  const outcomes = stageOutcomes(force);
  return {
    commander,
    opponent: validOpponent ? {
      uuid: validOpponent.uuid,
      name: validOpponent.name,
      img: validOpponent.img,
      troops: forceCurrentTroops(validOpponent),
      maximumTroops: forceStartingTroops(validOpponent),
      testDifficulty: forceTestDifficulty(validOpponent)
    } : null,
    profileRules: massBattleProfileRules(force.system?.profile),
    profileOptions: Object.values(MASS_BATTLE_PROFILES),
    stages,
    outcomes,
    suggestedThreshold: massBattleSuccessThreshold(combined || forceStartingTroops(force)),
    currentThreshold: Math.max(1, whole(force.system?.battle?.successThreshold, massBattleSuccessThreshold(combined))),
    testDifficulty: validOpponent ? forceTestDifficulty(validOpponent) : Math.max(1, whole(force.system?.battle?.testDifficulty, 11)),
    latestHistory: [...(force.system?.battle?.casualtyHistory ?? [])].reverse().find(entry => !entry.undoneAt) ?? null
  };
}

async function postMassBattleCard(force, kind, data = {}, {rolls = []} = {}) {
  if (!globalThis.ChatMessage?.create) return null;
  const content = await foundry.applications.handlebars.renderTemplate(
    "systems/age-system/templates/rolls/mass-battle-card.hbs",
    {
      ...data,
      kind,
      force,
      colorScheme: colorSchemeClass(),
      canApply: force.isOwner === true,
      isStage: kind === "stage",
      isCrisis: kind === "crisis",
      isCasualtyPreview: kind === "casualty-preview",
      isCasualtyApplied: kind === "casualty-applied",
      isCasualtyUndone: kind === "casualty-undone",
      labels: {
        stage: data.stage ? game.i18n.localize(STAGE_RULES[data.stage]?.label) : null
      }
    }
  );
  return ChatMessage.create({
    user: game.user.id,
    speaker: ChatMessage.getSpeaker({actor: force}),
    content,
    rolls,
    style: globalThis.CONST?.CHAT_MESSAGE_STYLES?.OTHER,
    flags: {"age-system": {massBattle: {
      schemaVersion: 1,
      kind,
      forceUuid: force.uuid,
      previewId: data.preview?.id ?? null,
      historyId: data.history?.id ?? null
    }}}
  });
}

export class MassBattleService {
  static async _force(uuid) {
    const actor = await resolveUuid(uuid);
    return actor?.type === MASS_BATTLE_ACTOR_TYPE ? actor : null;
  }

  static async rollStage(force, stageId) {
    if (force?.type !== MASS_BATTLE_ACTOR_TYPE || !force.isOwner) return false;
    if (!MASS_BATTLE_STAGES.includes(stageId)) throw new Error("Unknown mass-battle stage.");
    const context = await prepareMassBattleContext(force);
    const stage = context.stages.find(entry => entry.id === stageId);
    const abilityTotal = stage.ability === "communication"
      ? context.commander.communicationTotal
      : context.commander.militaryTotal;
    const specialistBonus = whole(stage.specialist?.bonus);
    const situationalModifier = whole(stage.data?.modifier);
    const bonus = abilityTotal + specialistBonus + situationalModifier;
    const roll = await new Roll("3d6 + @bonus", {bonus}).evaluate();
    const die = thirdDie(roll);
    const success = Number(roll.total) >= context.testDifficulty;
    const before = Math.max(0, whole(stage.data?.progress));
    const after = Math.min(context.currentThreshold, before + (success ? die : 0));
    const history = [...(stage.data?.history ?? []), {
      id: randomId(),
      timestamp: Date.now(),
      total: Number(roll.total),
      targetNumber: context.testDifficulty,
      stuntDie: die,
      success,
      progressBefore: before,
      progressAfter: after,
      userId: game.user.id
    }].slice(-20);
    await force.update({
      [`system.battle.stages.${stageId}.progress`]: after,
      [`system.battle.stages.${stageId}.history`]: history
    });
    await postMassBattleCard(force, "stage", {
      stage: stageId,
      success,
      total: Number(roll.total),
      targetNumber: context.testDifficulty,
      stuntDie: die,
      progressBefore: before,
      progressAfter: after,
      threshold: context.currentThreshold,
      bonus,
      commander: context.commander
    }, {rolls: [roll]});
    return {success, total: Number(roll.total), stuntDie: die, progress: after, threshold: context.currentThreshold};
  }

  static async applyCrisisPoint(force, stageId, {amount = 5} = {}) {
    if (force?.type !== MASS_BATTLE_ACTOR_TYPE || !force.isOwner) return false;
    if (!MASS_BATTLE_STAGES.includes(stageId)) throw new Error("Unknown mass-battle stage.");
    const context = await prepareMassBattleContext(force);
    const stage = context.stages.find(entry => entry.id === stageId);
    const before = Math.max(0, whole(stage.data?.progress));
    const after = Math.min(context.currentThreshold, before + Math.max(0, whole(amount, 5)));
    await force.update({[`system.battle.stages.${stageId}.progress`]: after});
    await postMassBattleCard(force, "crisis", {
      stage: stageId,
      progressBefore: before,
      progressAfter: after,
      threshold: context.currentThreshold,
      amount: after - before
    });
    return after;
  }

  static async useSuggestedThreshold(force) {
    if (force?.type !== MASS_BATTLE_ACTOR_TYPE || !force.isOwner) return false;
    const context = await prepareMassBattleContext(force);
    await force.update({"system.battle.successThreshold": context.suggestedThreshold});
    return context.suggestedThreshold;
  }

  static async previewCasualties(force) {
    if (force?.type !== MASS_BATTLE_ACTOR_TYPE || !force.isOwner) return false;
    const opponent = await resolveUuid(force.system?.battle?.opponentUuid);
    const validOpponent = opponent?.type === MASS_BATTLE_ACTOR_TYPE ? opponent : null;
    const sourceState = casualtySourceState(force, validOpponent);
    const commander = await massBattleCommanderSummary(force);
    const outcomes = stageOutcomes(force);
    const outnumberedModifier = massBattleOutnumberedModifier(sourceState.troopsMax, sourceState.opponentTroopsMax);
    const testModifier = massBattleCasualtyModifier({
      stageWins: outcomes.wins,
      stageLosses: outcomes.losses,
      outnumberedModifier,
      enemyHasFinishingSpecialists: sourceState.enemyHasFinishingSpecialists,
      customModifier: sourceState.customModifier
    });
    const bonus = commander.militaryTotal + testModifier;
    const roll = await new Roll("3d6 + @bonus", {bonus}).evaluate();
    const outcome = calculateMassBattleCasualties({
      troops: sourceState.troopsValue,
      rollTotal: Number(roll.total),
      targetNumber: sourceState.targetNumber,
      stuntDie: thirdDie(roll)
    });
    const preview = {
      id: randomId(),
      createdAt: Date.now(),
      userId: game.user.id,
      sourceState,
      commander,
      stageWins: outcomes.wins,
      stageLosses: outcomes.losses,
      outnumberedModifier,
      testModifier,
      bonus,
      rollTotal: Number(roll.total),
      targetNumber: sourceState.targetNumber,
      stuntDie: thirdDie(roll),
      outcome
    };
    await force.update({"system.battle.casualtyPreview": preview});
    await postMassBattleCard(force, "casualty-preview", {preview}, {rolls: [roll]});
    return clone(preview);
  }

  static async applyCasualties(force, previewId = null) {
    if (force?.type !== MASS_BATTLE_ACTOR_TYPE || !force.isOwner) return false;
    const preview = clone(force.system?.battle?.casualtyPreview);
    if (!preview?.id || (previewId && preview.id !== previewId)) throw new Error("The casualty preview is no longer available.");
    const opponent = await resolveUuid(force.system?.battle?.opponentUuid);
    const validOpponent = opponent?.type === MASS_BATTLE_ACTOR_TYPE ? opponent : null;
    if (!equal(preview.sourceState, casualtySourceState(force, validOpponent))) {
      throw new Error("The Mass Battle Force changed after preview. Refresh casualties before applying them.");
    }
    const before = forceCurrentTroops(force);
    const after = Math.max(0, whole(preview.outcome?.survivors));
    const history = [...(force.system?.battle?.casualtyHistory ?? []), {
      id: preview.id,
      appliedAt: Date.now(),
      userId: game.user.id,
      before,
      after,
      preview,
      undoneAt: null,
      undoneBy: null
    }].slice(-20);
    await AgeTransactionService.execute({
      operationId: `mass-battle:${force.id}:${preview.id}`,
      label: `${force.name}: mass battle casualties`,
      type: "mass-battle-casualties",
      sourceUuid: force.uuid,
      metadata: {previewId: preview.id, casualties: before - after},
      updates: [{document: force, update: {
        "system.troops.value": after,
        "system.battle.casualtyHistory": history,
        "system.battle.casualtyPreview": null
      }}]
    });
    const applied = history.at(-1);
    await postMassBattleCard(force, "casualty-applied", {history: applied});
    return clone(applied);
  }

  static async undoLastCasualties(force, historyId = null) {
    if (force?.type !== MASS_BATTLE_ACTOR_TYPE || !force.isOwner) return false;
    const history = clone(force.system?.battle?.casualtyHistory ?? []);
    let index = -1;
    for (let cursor = history.length - 1; cursor >= 0; cursor -= 1) {
      if (!history[cursor].undoneAt && (!historyId || history[cursor].id === historyId)) {
        index = cursor;
        break;
      }
    }
    if (index < 0) throw new Error("There is no applied casualty result to undo.");
    const entry = history[index];
    if (forceCurrentTroops(force) !== whole(entry.after)) {
      throw new Error("Troop strength changed after these casualties were applied. Exact undo was blocked.");
    }
    history[index] = {...entry, undoneAt: Date.now(), undoneBy: game.user.id};
    await AgeTransactionService.execute({
      operationId: `mass-battle-undo:${force.id}:${entry.id}`,
      label: `${force.name}: undo mass battle casualties`,
      type: "mass-battle-casualties-undo",
      sourceUuid: force.uuid,
      metadata: {historyId: entry.id},
      updates: [{document: force, update: {
        "system.troops.value": whole(entry.before),
        "system.battle.casualtyHistory": history
      }}]
    });
    await postMassBattleCard(force, "casualty-undone", {history: history[index]});
    return clone(history[index]);
  }

  static async resetBattle(force) {
    if (force?.type !== MASS_BATTLE_ACTOR_TYPE || !force.isOwner) return false;
    const defaults = clone(game.model?.Actor?.force?.battle?.stages ?? {});
    await force.update({
      "system.battle.stages": defaults,
      "system.battle.casualtyPreview": null
    });
    return true;
  }

  static decorate(messageOrApp, html) {
    const message = messageOrApp?.document ?? messageOrApp;
    const metadata = message?.flags?.["age-system"]?.massBattle;
    if (!metadata || !html?.querySelectorAll) return;
    for (const button of html.querySelectorAll("[data-mass-battle-action]")) {
      button.addEventListener("click", async event => {
        event.preventDefault();
        const force = await this._force(metadata.forceUuid);
        if (!force?.isOwner) return ui.notifications.warn("You cannot change this Mass Battle Force.");
        button.disabled = true;
        try {
          if (button.dataset.massBattleAction === "apply") await this.applyCasualties(force, metadata.previewId);
          if (button.dataset.massBattleAction === "undo") await this.undoLastCasualties(force, metadata.historyId);
        } catch (error) {
          console.error("AGE System | Mass Battle chat action failed.", error);
          ui.notifications.error(error.message, {console: false});
        } finally {
          button.disabled = false;
        }
      });
    }
  }
}
