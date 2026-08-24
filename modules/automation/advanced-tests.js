import {showConfirmDialog, showFormDialog} from "../dialogs.js";
import {automationFeatureEnabled} from "./mode.js";

const SYSTEM_ID = "age-system";
const SETTING_KEY = "advancedTestState";
const TRACKER_TYPES = ["advanced", "opposed", "breaching", "chase", "investigation", "social", "exploration", "custom"];
let settingQueue = Promise.resolve();
let activeTrackerWindow = null;

const clone = value => foundry.utils.deepClone(value);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback = 1) {
  if (value === null || value === undefined || value === "") return Math.max(1, Math.trunc(finite(fallback, 1)));
  return Math.max(1, Math.trunc(finite(value, fallback)));
}

function randomId() {
  return foundry.utils.randomID?.(16) ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function escape(value) {
  return Handlebars.escapeExpression(String(value ?? ""));
}

function normalizeState(value) {
  const trackers = Array.isArray(value?.trackers) ? value.trackers : [];
  return {
    version: 1,
    revision: Math.max(0, Math.trunc(finite(value?.revision, 0))),
    trackers: trackers.map(tracker => ({
      id: tracker.id || randomId(),
      name: String(tracker.name || game.i18n.localize("age-system.AUTOMATION.advancedTest")),
      type: TRACKER_TYPES.includes(tracker.type) ? tracker.type : "custom",
      threshold: positiveInteger(tracker.threshold, 10),
      oppositionThreshold: positiveInteger(tracker.oppositionThreshold, tracker.threshold || 10),
      progress: Math.max(0, finite(tracker.progress, 0)),
      oppositionProgress: Math.max(0, finite(tracker.oppositionProgress, 0)),
      status: tracker.status === "closed" ? "closed" : "active",
      createdAt: finite(tracker.createdAt, Date.now()),
      updatedAt: finite(tracker.updatedAt, Date.now()),
      history: Array.isArray(tracker.history) ? tracker.history.slice(-50) : []
    }))
  };
}

function withSettingLock(callback) {
  const task = settingQueue.then(callback, callback);
  settingQueue = task.then(() => undefined, () => undefined);
  return task;
}

function trackerLabel(tracker) {
  return game.i18n.format("age-system.AUTOMATION.trackerOption", {
    name: tracker.name,
    progress: tracker.progress,
    threshold: tracker.threshold
  });
}

function refreshAdvancedTestInterfaces() {
  // Tracker activation changes whether controls belong on already-rendered
  // chat cards. Progress added from chat must also refresh the open tracker.
  globalThis.ui?.chat?.render?.(true);
  if (activeTrackerWindow?.rendered) activeTrackerWindow.render(false);
}

export class AdvancedTestService {
  static get enabled() {
    return automationFeatureEnabled("enableAdvancedTests");
  }

  static state() {
    if (!this.enabled) return normalizeState(null);
    return normalizeState(game.settings.get(SYSTEM_ID, SETTING_KEY));
  }

  static activeTrackers() {
    return this.state().trackers.filter(tracker => tracker.status === "active");
  }

  static async _save(state) {
    state.revision = Math.max(0, finite(state.revision, 0)) + 1;
    await game.settings.set(SYSTEM_ID, SETTING_KEY, normalizeState(state));
    refreshAdvancedTestInterfaces();
    return clone(state);
  }

  static async create({name, type = "advanced", threshold = 10, oppositionThreshold = null} = {}) {
    if (!this.enabled || !game.user?.isGM) return false;
    return withSettingLock(async () => {
      const state = this.state();
      const now = Date.now();
      const tracker = {
        id: randomId(),
        name: String(name || game.i18n.localize("age-system.AUTOMATION.advancedTest")).trim(),
        type: TRACKER_TYPES.includes(type) ? type : "custom",
        threshold: positiveInteger(threshold, 10),
        oppositionThreshold: positiveInteger(oppositionThreshold, threshold || 10),
        progress: 0,
        oppositionProgress: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
        history: []
      };
      state.trackers.push(tracker);
      await this._save(state);
      return clone(tracker);
    });
  }

  static async advance(id, {amount = 1, side = "party", source = null} = {}) {
    if (!this.enabled || !game.user?.isGM) return false;
    return withSettingLock(async () => {
      const state = this.state();
      const tracker = state.trackers.find(entry => entry.id === id);
      if (!tracker || tracker.status !== "active") return false;
      const field = side === "opposition" ? "oppositionProgress" : "progress";
      const delta = Math.trunc(finite(amount, 0));
      if (!delta) return clone(tracker);
      tracker.history.push({
        id: randomId(),
        field,
        before: tracker[field],
        after: Math.max(0, tracker[field] + delta),
        delta,
        source: clone(source),
        userId: game.user.id,
        timestamp: Date.now()
      });
      tracker.history = tracker.history.slice(-50);
      tracker[field] = Math.max(0, tracker[field] + delta);
      tracker.updatedAt = Date.now();
      await this._save(state);
      return clone(tracker);
    });
  }

  static async undo(id) {
    if (!this.enabled || !game.user?.isGM) return false;
    return withSettingLock(async () => {
      const state = this.state();
      const tracker = state.trackers.find(entry => entry.id === id);
      const entry = tracker?.history?.pop();
      if (!tracker || !entry) return false;
      tracker[entry.field] = Math.max(0, finite(entry.before, 0));
      tracker.updatedAt = Date.now();
      await this._save(state);
      return clone(tracker);
    });
  }

  static async close(id) {
    if (!this.enabled || !game.user?.isGM) return false;
    return withSettingLock(async () => {
      const state = this.state();
      const tracker = state.trackers.find(entry => entry.id === id);
      if (!tracker) return false;
      tracker.status = "closed";
      tracker.updatedAt = Date.now();
      await this._save(state);
      return true;
    });
  }

  static async remove(id) {
    if (!this.enabled || !game.user?.isGM) return false;
    return withSettingLock(async () => {
      const state = this.state();
      const before = state.trackers.length;
      state.trackers = state.trackers.filter(entry => entry.id !== id);
      if (state.trackers.length === before) return false;
      await this._save(state);
      return true;
    });
  }

  static suggestedProgress(message) {
    const rollData = message?.flags?.[SYSTEM_ID]?.ageroll?.rollData;
    if (!rollData || rollData.rollType === "damage" || rollData.isSuccess === false) return 0;
    return positiveInteger(rollData.ageRollSummary?.stuntDie, 1);
  }

  static async _chooseTracker(trackers) {
    if (trackers.length === 1) return trackers[0];
    const options = trackers.map(tracker => `<option value="${escape(tracker.id)}">${escape(trackerLabel(tracker))}</option>`).join("");
    const result = await showFormDialog({
      title: game.i18n.localize("age-system.AUTOMATION.addToAdvancedTest"),
      content: `<div class="form-group"><label>${escape(game.i18n.localize("age-system.AUTOMATION.advancedTest"))}</label><select name="trackerId">${options}</select></div>`,
      confirmLabel: game.i18n.localize("age-system.AUTOMATION.addProgress")
    });
    if (result.cancelled) return null;
    return trackers.find(tracker => tracker.id === result.trackerId) ?? null;
  }

  static async recordMessage(messageOrId) {
    const message = typeof messageOrId === "string" ? game.messages?.get?.(messageOrId) : messageOrId;
    if (!message || !this.enabled || !game.user?.isGM) return false;
    const amount = this.suggestedProgress(message);
    if (!amount) return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.failedRollHasNoProgress"));
    const trackers = this.activeTrackers();
    if (!trackers.length) return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.noActiveAdvancedTests"));
    const tracker = await this._chooseTracker(trackers);
    if (!tracker) return false;
    return this.advance(tracker.id, {
      amount,
      source: {
        messageId: message.id ?? message._id,
        actorUuid: message.flags?.[SYSTEM_ID]?.ageroll?.rollData?.actorId ?? null,
        label: message.flavor ?? message.speaker?.alias ?? null
      }
    });
  }

  static open() {
    if (!this.enabled) return false;
    return new AdvancedTestTracker().render(true);
  }

  static decorate(message, html) {
    if (!this.enabled || !game.user?.isGM || !this.activeTrackers().length || !this.suggestedProgress(message) || !html?.querySelector) return;
    const root = html.querySelector(".age-system.age-roll-card, .age-roll-card, .base-age-roll");
    if (!root || root.querySelector(".age-advanced-test-add")) return;
    const section = document.createElement("section");
    section.className = "chat-buttons age-advanced-test-controls";
    section.style.cssText = "margin-top:.35rem;padding-top:.35rem;border-top:1px solid rgba(0,0,0,.25)";
    section.innerHTML = `<button type="button" class="age-button age-advanced-test-add"><i class="fa-solid fa-bars-progress"></i> ${escape(game.i18n.format("age-system.AUTOMATION.addProgressAmount", {amount: this.suggestedProgress(message)}))}</button>`;
    root.append(section);
  }
}

export class AdvancedTestTracker extends foundry.appv1.api.FormApplication {
  constructor(...args) {
    super(...args);
    activeTrackerWindow = this;
  }

  async close(options = {}) {
    if (activeTrackerWindow === this) activeTrackerWindow = null;
    return super.close(options);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "age-advanced-test-tracker",
      template: "systems/age-system/templates/automation/advanced-test-tracker.hbs",
      classes: ["age-system", "dialog"],
      title: game.i18n.localize("age-system.AUTOMATION.advancedTests"),
      width: 760,
      height: 640,
      resizable: true,
      minimizable: true,
      closeOnSubmit: false
    });
  }

  getData() {
    const state = AdvancedTestService.state();
    return {
      ...super.getData(),
      enabled: AdvancedTestService.enabled,
      isGM: game.user?.isGM,
      trackers: state.trackers.map(tracker => ({
        ...tracker,
        typeLabel: game.i18n.localize(`age-system.AUTOMATION.advancedType.${tracker.type}`),
        partyPercent: Math.min(100, Math.round(100 * tracker.progress / tracker.threshold)),
        oppositionPercent: Math.min(100, Math.round(100 * tracker.oppositionProgress / tracker.oppositionThreshold)),
        hasHistory: tracker.history.length > 0,
        isActive: tracker.status === "active",
        opposed: tracker.type === "opposed" || tracker.oppositionProgress > 0
      })),
      types: TRACKER_TYPES.map(value => ({value, label: game.i18n.localize(`age-system.AUTOMATION.advancedType.${value}`)}))
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".age-advanced-create").on("submit", async event => {
      event.preventDefault();
      const data = new foundry.applications.ux.FormDataExtended(event.currentTarget).object;
      await AdvancedTestService.create(data);
      event.currentTarget.reset();
      this.render(false);
    });
    html.find(".age-advanced-adjust").on("click", async event => {
      const row = event.currentTarget.closest("[data-tracker-id]");
      const amount = row?.querySelector("input[name='amount']")?.value ?? 1;
      await AdvancedTestService.advance(row?.dataset?.trackerId, {amount: event.currentTarget.dataset.direction === "minus" ? -finite(amount, 1) : finite(amount, 1), side: event.currentTarget.dataset.side});
      this.render(false);
    });
    html.find(".age-advanced-undo").on("click", async event => {
      await AdvancedTestService.undo(event.currentTarget.closest("[data-tracker-id]")?.dataset?.trackerId);
      this.render(false);
    });
    html.find(".age-advanced-close").on("click", async event => {
      await AdvancedTestService.close(event.currentTarget.closest("[data-tracker-id]")?.dataset?.trackerId);
      this.render(false);
    });
    html.find(".age-advanced-remove").on("click", async event => {
      const id = event.currentTarget.closest("[data-tracker-id]")?.dataset?.trackerId;
      const confirmed = await showConfirmDialog({title: game.i18n.localize("age-system.AUTOMATION.removeAdvancedTest"), content: `<p>${escape(game.i18n.localize("age-system.AUTOMATION.removeAdvancedTestHint"))}</p>`});
      if (!confirmed) return;
      await AdvancedTestService.remove(id);
      this.render(false);
    });
  }

  _updateObject() {}
}

export default AdvancedTestService;
