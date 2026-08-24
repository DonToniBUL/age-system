import * as Dice from "../dice.js";
import {automationFeatureEnabled} from "./mode.js";

const SYSTEM_ID = "age-system";

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function owns(actor) {
  return Boolean(game.user?.isGM || actor?.isOwner || actor?.testUserPermission?.(game.user, "OWNER"));
}

function selectedActorUuids() {
  const tokens = [
    ...values(game.user?.targets),
    ...values(globalThis.canvas?.tokens?.controlled)
  ];
  return new Set(tokens.map(token => token?.actor?.uuid).filter(Boolean));
}

function abilityChoices() {
  const configured = CONFIG.ageSystem?.abilities ?? {};
  const keys = Array.isArray(configured) ? configured : Object.keys(configured);
  const fallback = ["acc", "comm", "cons", "dex", "fight", "int", "per", "str", "will", "magic", "cunn"];
  return (keys.length ? keys : fallback).map(value => ({
    value,
    label: game.i18n.localize(`age-system.${value}`)
  }));
}

export function normalizeRequestedRoll(value = {}) {
  const targetNumber = Number(value.targetNumber);
  return {
    version: 1,
    id: String(value.id ?? foundry.utils.randomID?.(16) ?? Date.now()),
    title: String(value.title ?? "").trim(),
    ability: String(value.ability ?? "").trim(),
    focus: String(value.focus ?? "").trim(),
    targetNumber: Number.isFinite(targetNumber) && targetNumber > 0 ? Math.trunc(targetNumber) : null,
    actorUuids: Array.from(new Set((value.actorUuids ?? []).map(String).filter(Boolean))),
    requestedBy: value.requestedBy ?? game.user?.id ?? null,
    createdAt: Number(value.createdAt ?? Date.now())
  };
}

export class RequestedRollService {
  static get enabled() {
    return automationFeatureEnabled("enableRequestedRolls");
  }

  static state(message) {
    const value = message?.flags?.[SYSTEM_ID]?.automation?.requestedRoll;
    return value ? normalizeRequestedRoll(value) : null;
  }

  static async create(data = {}) {
    if (!this.enabled || !game.user?.isGM) return false;
    const request = normalizeRequestedRoll(data);
    if (!request.ability) throw new TypeError(game.i18n.localize("age-system.AUTOMATION.requestAbilityRequired"));
    if (!request.actorUuids.length) throw new TypeError(game.i18n.localize("age-system.AUTOMATION.requestActorsRequired"));
    const actors = [];
    for (const uuid of request.actorUuids) {
      let actor = await foundry.utils.fromUuid(uuid);
      actor = actor?.actor ?? actor;
      if (actor?.type === "char") actors.push(actor);
    }
    if (!actors.length) throw new TypeError(game.i18n.localize("age-system.AUTOMATION.requestActorsUnavailable"));
    request.actorUuids = actors.map(actor => actor.uuid);
    const content = await foundry.applications.handlebars.renderTemplate(
      "systems/age-system/templates/automation/requested-roll-card.hbs",
      {request, actors}
    );
    return ChatMessage.create({
      user: game.user.id,
      speaker: {alias: game.user.name},
      content,
      style: CONST.CHAT_MESSAGE_STYLES.OTHER,
      flags: {[SYSTEM_ID]: {automation: {requestedRoll: request}}}
    });
  }

  static async roll(messageOrId, actorUuid, event = null) {
    const message = typeof messageOrId === "string" ? game.messages?.get?.(messageOrId) : messageOrId;
    const request = this.state(message);
    if (!request || !this.enabled || !request.actorUuids.includes(actorUuid)) return false;
    let actor = await foundry.utils.fromUuid(actorUuid);
    actor = actor?.actor ?? actor;
    if (!actor) return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.requestActorUnavailable"));
    if (!owns(actor)) return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.requestActorNotOwned"));
    const result = await Dice.ageRollCheck({
      event,
      actor,
      abl: request.ability,
      itemRolled: request.focus || null,
      rollTN: request.targetNumber,
      rollType: CONFIG.ageSystem.ROLL_TYPE.ABILITY,
      flavor2: request.title || game.i18n.localize("age-system.AUTOMATION.requestedRoll")
    });
    if (result?.update) {
      await result.update({[`flags.${SYSTEM_ID}.automation.requestedRollResult`]: {
        requestId: request.id,
        requestMessageUuid: message?.uuid ?? null,
        actorUuid,
        rolledBy: game.user.id,
        rolledAt: Date.now()
      }});
    }
    return result;
  }

  static decorate(message, html) {
    const request = this.state(message);
    if (!request || !this.enabled || !html?.querySelectorAll) return;
    html.querySelectorAll(".age-requested-roll").forEach(button => {
      const uuid = button.dataset.actorUuid;
      const actor = uuid ? values(game.actors).find(entry => entry.uuid === uuid) : null;
      if (actor && !owns(actor)) {
        button.disabled = true;
        button.title = game.i18n.localize("age-system.AUTOMATION.requestActorNotOwned");
      }
    });
  }

  static open() {
    if (!this.enabled || !game.user?.isGM) return false;
    return new RequestedRollBuilder().render(true);
  }
}

export class RequestedRollBuilder extends foundry.appv1.api.FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "age-requested-roll-builder",
      template: "systems/age-system/templates/automation/requested-roll-builder.hbs",
      classes: ["age-system", "dialog"],
      title: game.i18n.localize("age-system.AUTOMATION.requestedRolls"),
      width: 620,
      height: 640,
      resizable: true,
      minimizable: true,
      closeOnSubmit: false
    });
  }

  getData() {
    const selected = selectedActorUuids();
    const actors = values(game.actors).filter(actor => actor?.type === "char").map(actor => ({
      uuid: actor.uuid,
      name: actor.name,
      img: actor.img,
      selected: selected.has(actor.uuid),
      owners: values(game.users).filter(user => !user.isGM && actor.testUserPermission?.(user, "OWNER")).map(user => user.name).join(", ")
    })).sort((left, right) => left.name.localeCompare(right.name));
    return {...super.getData(), actors, abilities: abilityChoices()};
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".age-request-roll-form").on("submit", async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new foundry.applications.ux.FormDataExtended(form).object;
      const actorUuids = Array.from(form.querySelectorAll("input[name='actorUuid']:checked"), input => input.value);
      try {
        await RequestedRollService.create({...data, actorUuids});
        ui.notifications.info(game.i18n.localize("age-system.AUTOMATION.requestPosted"));
      } catch (error) {
        ui.notifications.warn(error.message);
      }
    });
    html.find(".age-request-select-all").on("click", () => html.find("input[name='actorUuid']").prop("checked", true));
    html.find(".age-request-select-none").on("click", () => html.find("input[name='actorUuid']").prop("checked", false));
  }

  _updateObject() {}
}

export default RequestedRollService;
