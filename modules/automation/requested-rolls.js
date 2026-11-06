import * as Dice from "../dice.js";
import {applyColorSchemeToElement, colorSchemeClass} from "../color-scheme.js";
import {automationFeatureEnabled} from "./mode.js";

const SYSTEM_ID = "age-system";
const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2
  ?? globalThis.foundry?.appv1?.api?.FormApplication
  ?? class {};
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin
  ?? (Base => Base);
const pendingResultRefreshes = new Map();

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

function requestedRollResult(message) {
  const value = message?.flags?.[SYSTEM_ID]?.automation?.requestedRollResult;
  if (!value || typeof value !== "object") return null;
  return {
    requestId: String(value.requestId ?? ""),
    requestMessageUuid: value.requestMessageUuid ?? null,
    actorUuid: String(value.actorUuid ?? ""),
    rolledBy: value.rolledBy ?? null,
    rolledAt: Number.isFinite(Number(value.rolledAt)) ? Number(value.rolledAt) : 0,
    messageUuid: message?.uuid ?? null
  };
}

function requestedRollResults(request, requestMessageUuid = null) {
  const results = new Map();
  for (const message of values(game.messages)) {
    const result = requestedRollResult(message);
    if (!result || result.requestId !== request.id || !request.actorUuids.includes(result.actorUuid)) continue;
    // Current results are bound to one exact request message. Only historical
    // result flags which genuinely predate requestMessageUuid use the id-only
    // compatibility path.
    if (result.requestMessageUuid && result.requestMessageUuid !== requestMessageUuid) continue;
    const current = results.get(result.actorUuid);
    if (!current || result.rolledAt >= current.rolledAt) results.set(result.actorUuid, result);
  }
  return results;
}

function requestMessageForResult(result) {
  if (!result) return null;
  const messages = values(game.messages);
  if (result.requestMessageUuid) {
    return messages.find(message => message?.uuid === result.requestMessageUuid) ?? null;
  }
  return messages.find(message => message?.flags?.[SYSTEM_ID]?.automation?.requestedRoll?.id === result.requestId) ?? null;
}

function recipientContext(actor, result = null) {
  const completed = Boolean(result);
  return {
    uuid: actor.uuid,
    name: actor.name,
    img: actor.img,
    completed,
    resultMessageUuid: result?.messageUuid ?? null,
    statusKey: completed ? "age-system.AUTOMATION.applied" : "age-system.AUTOMATION.notRolled"
  };
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

  static results(message) {
    const request = this.state(message);
    return request ? requestedRollResults(request, message?.uuid ?? null) : new Map();
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
      {
        request,
        actors: actors.map(actor => recipientContext(actor)),
        recipientCount: actors.length,
        colorScheme: colorSchemeClass()
      }
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
      this.refresh(message);
    }
    return result;
  }

  static decorate(message, html) {
    const request = this.state(message);
    if (!request) {
      const source = requestMessageForResult(requestedRollResult(message));
      if (source) this.refresh(source);
      return;
    }
    if (!this.enabled || !html?.querySelectorAll) return;
    const results = requestedRollResults(request, message?.uuid ?? null);
    const cards = [
      ...(html.matches?.(".age-requested-roll-card") ? [html] : []),
      ...html.querySelectorAll(".age-requested-roll-card")
    ];
    for (const card of cards) {
      card.dataset.requestState = results.size >= request.actorUuids.length ? "completed" : "pending";
      card.dataset.completedCount = String(results.size);
      card.classList?.toggle("is-complete", results.size >= request.actorUuids.length);
      const summary = card.querySelector?.("[data-requested-roll-summary]");
      if (summary) summary.textContent = `${results.size} / ${request.actorUuids.length}`;
    }
    html.querySelectorAll(".age-requested-roll").forEach(button => {
      const uuid = button.dataset.actorUuid;
      const result = results.get(uuid);
      const state = result ? "completed" : "pending";
      button.dataset.requestState = state;
      button.classList?.toggle("is-complete", Boolean(result));
      const recipient = button.closest?.("[data-requested-roll-recipient]");
      if (recipient?.dataset) recipient.dataset.requestState = state;
      recipient?.classList?.toggle("is-complete", Boolean(result));
      const status = recipient?.querySelector?.("[data-requested-roll-status]");
      if (status) {
        status.dataset.requestState = state;
        const statusLabel = status.querySelector?.("[data-requested-roll-status-label]");
        if (statusLabel) statusLabel.textContent = game.i18n.localize(
          result ? "age-system.AUTOMATION.applied" : "age-system.AUTOMATION.notRolled"
        );
        const icon = status.querySelector?.("i");
        if (icon) icon.className = result ? "fa-solid fa-circle-check" : "fa-regular fa-circle";
      }
      const actor = uuid ? values(game.actors).find(entry => entry.uuid === uuid) : null;
      if (actor && !owns(actor)) {
        button.disabled = true;
        button.title = game.i18n.localize("age-system.AUTOMATION.requestActorNotOwned");
      }
    });
  }

  static refresh(message) {
    if (!message?.id || !globalThis.document?.querySelectorAll) return false;
    let refreshed = false;
    for (const element of document.querySelectorAll(".chat-message")) {
      if (element?.dataset?.messageId !== message.id) continue;
      this.decorate(message, element);
      refreshed = true;
    }
    return refreshed;
  }

  /** Capture the current request before a result message is updated/deleted. */
  static captureResultRefresh(message) {
    const source = requestMessageForResult(requestedRollResult(message));
    if (!message?.id || !source?.id) return false;
    pendingResultRefreshes.set(message.id, source.id);
    return true;
  }

  /** Refresh both the old and new request cards after a result flag changes. */
  static refreshResultReferences(message) {
    const sourceIds = new Set();
    const previousId = message?.id ? pendingResultRefreshes.get(message.id) : null;
    if (previousId) sourceIds.add(previousId);
    const current = requestMessageForResult(requestedRollResult(message));
    if (current?.id) sourceIds.add(current.id);
    if (message?.id) pendingResultRefreshes.delete(message.id);
    if (!sourceIds.size) return false;
    const enqueue = globalThis.queueMicrotask ?? (callback => Promise.resolve().then(callback));
    enqueue(() => {
      for (const id of sourceIds) {
        const source = game.messages?.get?.(id);
        if (source) this.refresh(source);
      }
    });
    return true;
  }

  static open() {
    if (!this.enabled || !game.user?.isGM) return false;
    const application = new RequestedRollBuilder();
    const renderResult = application.render({force: true});
    if (renderResult?.then instanceof Function) {
      void renderResult.catch(error => console.error("AGE System | Requested Roll builder failed to open.", error));
    }
    return application;
  }
}

/**
 * Observe a result-message mutation without returning the service boolean.
 * Foundry interprets false from pre-document hooks as a cancellation veto.
 */
export function captureRequestedRollResultRefresh(message) {
  RequestedRollService.captureResultRefresh(message);
}

export class RequestedRollBuilder extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "age-requested-roll-builder",
    classes: ["age-system", "age-v5-parity-sheet", "age-roll-workflow", "age-requested-roll-builder-v2"],
    position: {width: 620, height: 640},
    window: {
      title: "age-system.AUTOMATION.requestedRolls",
      resizable: true,
      minimizable: true
    }
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/automation/requested-roll-builder.hbs",
      scrollable: [".age-roll-workflow__scroll"]
    }
  };

  render(options = {}) {
    if (typeof options === "boolean") options = {force: options};
    return super.render(options ?? {});
  }

  _buildContext() {
    const selected = selectedActorUuids();
    const actors = values(game.actors).filter(actor => actor?.type === "char").map(actor => ({
      uuid: actor.uuid,
      name: actor.name,
      img: actor.img,
      selected: selected.has(actor.uuid),
      owners: values(game.users).filter(user => !user.isGM && actor.testUserPermission?.(user, "OWNER")).map(user => user.name).join(", ")
    })).sort((left, right) => left.name.localeCompare(right.name));
    return {actors, abilities: abilityChoices(), colorScheme: colorSchemeClass()};
  }

  getData() {
    const base = typeof super.getData === "function" ? super.getData() : {};
    return {...base, ...this._buildContext()};
  }

  async _prepareContext(options) {
    const context = typeof super._prepareContext === "function"
      ? await super._prepareContext(options)
      : {};
    return Object.assign(context, this._buildContext());
  }

  async _onFirstRender(context, options) {
    if (typeof super._onFirstRender === "function") await super._onFirstRender(context, options);
    this.element?.addEventListener("submit", event => {
      if (!event.target?.matches?.(".age-request-roll-form")) return;
      void this._onRequestSubmit(event);
    });
    this.element?.addEventListener("click", event => this._onRequestAction(event));
  }

  async _onRender(context, options) {
    if (typeof super._onRender === "function") await super._onRender(context, options);
    applyColorSchemeToElement(this.element);
    applyColorSchemeToElement(this.element?.querySelector?.(".colorset-selection"));
  }

  async _onRequestSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget?.matches?.(".age-request-roll-form") ? event.currentTarget : event.target;
    try {
      const data = new foundry.applications.ux.FormDataExtended(form).object;
      const actorUuids = Array.from(form.querySelectorAll("input[name='actorUuid']:checked"), input => input.value);
      const created = await RequestedRollService.create({...data, actorUuids});
      if (created) ui.notifications.info(game.i18n.localize("age-system.AUTOMATION.requestPosted"));
      return created;
    } catch (error) {
      ui.notifications.warn(error?.message ?? String(error));
      return false;
    }
  }

  _onRequestAction(event) {
    const control = event.target?.closest?.("[data-requested-roll-action]");
    if (!control || !this.element?.contains?.(control)) return;
    const checked = control.dataset.requestedRollAction === "select-all";
    if (!checked && control.dataset.requestedRollAction !== "select-none") return;
    event.preventDefault();
    for (const input of this.element.querySelectorAll("input[name='actorUuid']")) input.checked = checked;
  }
}

export default RequestedRollService;
