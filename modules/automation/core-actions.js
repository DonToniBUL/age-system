import {normalizeActiveEffectData} from "../compat.js";
import * as AgeChat from "../age-chat.js";
import {AgeActionService} from "./actions.js";
import {PowerResourceService} from "./power-resources.js";
import {PowerResistanceService} from "./power-resistance.js";
import {StuntAssistantService} from "./stunt-assistant.js";

const SYSTEM_ID = "age-system";

function clone(value) {
  return foundry.utils.deepClone(value);
}

async function resolveUuid(uuid) {
  if (!uuid) return null;
  const messageId = String(uuid).startsWith("ChatMessage.") ? String(uuid).split(".").pop() : uuid;
  return await foundry.utils.fromUuid(uuid) ?? game.messages?.get?.(messageId) ?? null;
}

async function requireDocument(uuid, label) {
  const document = await resolveUuid(uuid);
  if (!document) throw new Error(`AGE action ${label} is unavailable: ${uuid ?? "missing UUID"}`);
  return document;
}

async function requireActor(action) {
  const document = await requireDocument(action.actorUuid, "Actor");
  return document.actor ?? document;
}

async function requireItem(action, type = null) {
  const document = await requireDocument(action.itemUuid, "Item");
  const item = document.item ?? document;
  if (type && item.type !== type) throw new TypeError(`AGE action requires an owned ${type} Item.`);
  if (!item.actor) throw new TypeError("AGE roll actions require an owned Item.");
  return item;
}

async function requireMessage(action) {
  return requireDocument(action.messageUuid, "Chat Message");
}

function owns(document, user = game.user) {
  const subject = document?.actor ?? document;
  if (!user) return false;
  if (user.isGM) return true;
  if (user.id === game.user?.id && (document?.isOwner || subject?.isOwner)) return true;
  return Boolean(subject?.testUserPermission?.(user, "OWNER") || document?.testUserPermission?.(user, "OWNER"));
}

function requestUser(context = {}) {
  return context.requestUser ?? game.user;
}

async function authorizeActor(action, context) {
  return owns(await requireActor(action), requestUser(context));
}

async function authorizeItem(action, context) {
  return owns(await requireItem(action), requestUser(context));
}

async function authorizeMessage(action, context) {
  const message = await requireMessage(action);
  const authorId = message?.author?.id ?? message?.user?.id ?? message?.user;
  const user = requestUser(context);
  return Boolean(user?.isGM || authorId === user?.id || message?.testUserPermission?.(user, "OWNER"));
}

async function authorizeTargets(action, context) {
  const targets = await resolveTargets(action.targetUuids);
  const user = requestUser(context);
  return targets.length > 0 && targets.every(target => owns(target, user));
}

async function resolveTargets(uuids) {
  const targets = [];
  for (const uuid of uuids ?? []) {
    const document = await resolveUuid(uuid);
    if (!document) continue;
    targets.push(document.object ?? document);
  }
  return targets;
}

function rollEvent(payload = {}) {
  const event = payload.event ?? {};
  return {
    type: typeof event.type === "string" ? event.type : "ageaction",
    altKey: event.altKey === true,
    ctrlKey: event.ctrlKey === true,
    shiftKey: event.shiftKey === true,
    preventDefault() {}
  };
}

function resultId(result) {
  return result?.id ?? result?._id ?? result?.messageId ?? null;
}

function rollSummary(result) {
  return {messageId: resultId(result), created: Boolean(result)};
}

function mutationSummary(result) {
  return {
    changed: Boolean(result),
    operationId: result?.operationId ?? result?.transaction?.id ?? null
  };
}

function addActionProvenance(effect, action) {
  const data = clone(effect);
  delete data._id;
  data.flags = clone(data.flags ?? {});
  data.flags[SYSTEM_ID] = clone(data.flags[SYSTEM_ID] ?? {});
  data.flags[SYSTEM_ID].action = {schemaVersion: action.schemaVersion, id: action.id, type: action.type};
  return data;
}

const coreHandlers = {
  "roll.attack": {
    label: "Attack roll",
    category: "roll",
    supportsTargets: true,
    authorize: authorizeItem,
    preview: action => ({kind: "attack", itemUuid: action.itemUuid, targetCount: action.targetUuids.length, mutates: false}),
    async execute(action) {
      const item = await requireItem(action, "weapon");
      const targets = await resolveTargets(action.targetUuids);
      const rollType = action.payload.rollType ?? CONFIG.ageSystem.ROLL_TYPE.ATTACK;
      return item.roll(rollEvent(action.payload), rollType, action.payload.targetNumber ?? null, {ageAction: action, targets});
    },
    summarize: rollSummary
  },
  "roll.power": {
    label: "Power roll",
    category: "roll",
    supportsTargets: true,
    authorize: authorizeItem,
    preview: action => ({kind: "power", itemUuid: action.itemUuid, targetCount: action.targetUuids.length, mutates: true}),
    async execute(action) {
      const item = await requireItem(action, "power");
      const targets = await resolveTargets(action.targetUuids);
      const rollType = action.payload.rollType ?? CONFIG.ageSystem.ROLL_TYPE.POWER;
      return item.roll(rollEvent(action.payload), rollType, action.payload.targetNumber ?? null, {ageAction: action, targets});
    },
    summarize: rollSummary
  },
  "roll.resistance": {
    label: "Power resistance roll",
    category: "roll",
    supportsTargets: true,
    authorize: authorizeMessage,
    preview: action => ({kind: "resistance", messageUuid: action.messageUuid, all: action.payload.all === true, mutates: true}),
    async execute(action) {
      const message = await requireMessage(action);
      if (action.payload.all === true) return PowerResistanceService.rollAll(message, {ageAction: action});
      const key = String(action.payload.targetKey ?? "").trim();
      if (!key) throw new TypeError("A resistance target key is required.");
      return PowerResistanceService.rollTarget(message, key, {ageAction: action});
    },
    summarize: result => ({rolled: Array.isArray(result) ? result.length : Number(Boolean(result))})
  },
  "roll.damage": {
    label: "Damage roll",
    category: "roll",
    supportsTargets: true,
    authorize: authorizeItem,
    preview: action => ({kind: "damage", itemUuid: action.itemUuid, targetCount: action.targetUuids.length, mutates: false}),
    async execute(action) {
      const item = await requireItem(action);
      const targetResults = Array.isArray(action.payload.targetResults)
        ? clone(action.payload.targetResults)
        : action.targetUuids.map(uuid => ({tokenUuid: uuid, actorUuid: uuid, hit: true}));
      return item.rollDamage({
        ...clone(action.payload),
        event: rollEvent(action.payload),
        targetResults,
        targetResultsLocked: action.payload.targetResultsLocked === true || action.targetUuids.length > 0,
        ageAction: action
      });
    },
    summarize: rollSummary
  },
  "apply.damage": {
    label: "Apply damage",
    category: "apply",
    mutates: true,
    reversible: true,
    supportsTargets: true,
    authorize: (action, context) => {
      if (action.actorUuid) return authorizeActor(action, context);
      if (action.targetUuids.length) return authorizeTargets(action, context);
      return context?.delegated !== true && game.user?.isGM === true;
    },
    preview: action => ({kind: "damage", targetCount: action.targetUuids.length, opensConfirmation: true, mutates: true}),
    execute(action) {
      const damageData = clone(action.payload.damageData ?? action.payload);
      if (action.targetUuids.length && !Array.isArray(damageData.targetResults)) {
        damageData.targetResults = action.targetUuids.map(uuid => ({tokenUuid: uuid, actorUuid: uuid, hit: true}));
        damageData.targetResultsLocked = true;
      }
      return AgeChat.callApplyDamage(damageData);
    },
    summarize: result => ({opened: Boolean(result)})
  },
  "apply.healing": {
    label: "Apply healing",
    category: "apply",
    mutates: true,
    reversible: true,
    supportsTargets: true,
    authorize: authorizeTargets,
    preview: action => ({kind: "healing", amount: Number(action.payload.amount ?? 0), targetCount: action.targetUuids.length, mutates: true}),
    async execute(action) {
      const documents = await resolveTargets(action.targetUuids);
      const targets = documents.map(document => document?.actor ? document : {actor: document});
      return AgeChat.applyHealingToTargets(Number(action.payload.amount ?? 0), {ageAction: action, targets});
    },
    summarize: result => ({targets: Array.isArray(result) ? result.length : 0})
  },
  "resource.power-points": {
    label: "Spend Power Points",
    category: "resource",
    mutates: true,
    reversible: true,
    authorize: authorizeActor,
    preview: action => ({kind: "power-points", cost: Number(action.payload.cost ?? 0), mutates: true}),
    async execute(action) {
      const actor = await requireActor(action);
      const item = action.itemUuid ? await resolveUuid(action.itemUuid) : null;
      return PowerResourceService.spend({actor, item, cost: action.payload.cost, ageAction: action});
    },
    summarize: result => ({spent: Number(result?.spent ?? 0), requested: Number(result?.cost ?? 0)})
  },
  "stunt.spend": {
    label: "Spend Stunt Points",
    category: "stunt",
    mutates: true,
    reversible: true,
    authorize: authorizeMessage,
    preview: action => ({kind: "stunt", stuntUuid: action.payload.stuntUuid ?? null, cost: Number(action.payload.cost ?? 0), mutates: true}),
    async execute(action) {
      const message = await requireMessage(action);
      return StuntAssistantService.spend(message, {
        stuntUuid: action.payload.stuntUuid,
        cost: action.payload.cost,
        ageAction: action
      });
    },
    summarize: result => ({remaining: Number(result?.remaining ?? 0), spends: result?.spends?.length ?? 0})
  },
  "stunt.undo": {
    label: "Undo Stunt spend",
    category: "stunt",
    mutates: true,
    reversible: true,
    authorize: authorizeMessage,
    preview: action => ({kind: "stunt-undo", mutates: true}),
    async execute(action) {
      const message = await requireMessage(action);
      return StuntAssistantService.undoSpend(message, {ageAction: action});
    },
    summarize: result => ({remaining: Number(result?.remaining ?? 0), spends: result?.spends?.length ?? 0})
  },
  "effect.apply": {
    label: "Apply effect",
    category: "effect",
    mutates: true,
    authorize: authorizeActor,
    preview: action => ({kind: "effect-apply", count: Array.isArray(action.payload.effects) ? action.payload.effects.length : 1, mutates: true}),
    async execute(action) {
      const actor = await requireActor(action);
      if (typeof actor.createEmbeddedDocuments !== "function") throw new TypeError("The Actor cannot receive Active Effects.");
      const input = Array.isArray(action.payload.effects) ? action.payload.effects : [action.payload.effect];
      const effects = input.filter(Boolean).map(effect => addActionProvenance(
        normalizeActiveEffectData(effect, [...(CONFIG.ageSystem?.actorDerivedDataKey ?? []), ...(CONFIG.ageSystem?.charAblKey ?? [])]),
        action
      ));
      if (!effects.length) throw new TypeError("At least one Active Effect is required.");
      return actor.createEmbeddedDocuments("ActiveEffect", effects, {ageAutomation: true, ageActionId: action.id});
    },
    summarize: result => ({created: Array.isArray(result) ? result.length : Number(Boolean(result))})
  },
  "effect.remove": {
    label: "Remove effect",
    category: "effect",
    mutates: true,
    authorize: authorizeActor,
    preview: action => ({kind: "effect-remove", count: action.payload.effectIds?.length ?? 0, mutates: true}),
    async execute(action) {
      const actor = await requireActor(action);
      if (typeof actor.deleteEmbeddedDocuments !== "function") throw new TypeError("The Actor cannot remove Active Effects.");
      const ids = Array.from(new Set((action.payload.effectIds ?? []).map(String).filter(Boolean)));
      if (!ids.length) throw new TypeError("At least one Active Effect ID is required.");
      return actor.deleteEmbeddedDocuments("ActiveEffect", ids, {ageAutomation: true, ageActionId: action.id});
    },
    summarize: result => ({removed: Array.isArray(result) ? result.length : Number(Boolean(result))})
  }
};

const coreTemplates = {
  "attack.standard": {type: "roll.attack", payload: {}},
  "power.activate": {type: "roll.power", payload: {}},
  "resistance.single": {type: "roll.resistance", payload: {all: false}},
  "resistance.all": {type: "roll.resistance", payload: {all: true}},
  "damage.roll": {type: "roll.damage", payload: {}},
  "damage.apply": {type: "apply.damage", payload: {}},
  "healing.apply": {type: "apply.healing", payload: {amount: 0}},
  "power-points.spend": {type: "resource.power-points", payload: {cost: 0}},
  "stunt.spend": {type: "stunt.spend", payload: {}},
  "stunt.undo": {type: "stunt.undo", payload: {}},
  "effect.apply": {type: "effect.apply", payload: {}},
  "effect.remove": {type: "effect.remove", payload: {effectIds: []}}
};

export function registerCoreAgeActions() {
  for (const [type, handler] of Object.entries(coreHandlers)) {
    AgeActionService.register(type, handler, {replace: true});
  }
  for (const [id, action] of Object.entries(coreTemplates)) {
    AgeActionService.registerTemplate(id, action, {replace: true});
  }
  return {definitions: AgeActionService.definitions(), templates: AgeActionService.templates()};
}

export default registerCoreAgeActions;
