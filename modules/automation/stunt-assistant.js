import {AgeTransactionService} from "./action-transactions.js";
import {AgeActionService} from "./actions.js";
import {ageCompendiumIndex} from "./compendium-index.js";
import {ConditionLifecycleService} from "./condition-lifecycle.js";
import {automationFeatureEnabled} from "./mode.js";
import {showFormDialog} from "../dialogs.js";
import {applyColorSchemeToElement} from "../color-scheme.js";

const SYSTEM_ID = "age-system";
const locks = new Set();
const metadataCache = new Map();
const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2
  ?? globalThis.foundry?.appv1?.api?.FormApplication
  ?? class {};
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin
  ?? (Base => Base);

function clone(value) {
  return foundry.utils.deepClone(value);
}

function normalize(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function finiteCost(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function costRange(document) {
  const system = document?.system ?? document?.stunt ?? {};
  const minimum = finiteCost(system.stuntPoints, 0);
  const maximum = system.costType === "variable"
    ? Math.max(minimum, finiteCost(system.stuntPointsMax, minimum))
    : minimum;
  const adjustment = finiteCost(foundry.utils.getProperty(document, "flags.age-system.automation.stuntCostModifier"), 0);
  return {
    minimum: Math.max(0, minimum - adjustment),
    maximum: Math.max(0, maximum - adjustment),
    variable: system.costType === "variable" || minimum !== maximum
  };
}

function categoryMatches(category, rollType) {
  const value = normalize(category);
  if (!value) return true;
  if (["attack", "meleeattack", "rangedattack", "stuntattack"].includes(normalize(rollType))) {
    return ["combat", "attack", "weapon", "melee", "ranged"].some(term => value.includes(term));
  }
  if (normalize(rollType) === "poweractivation") {
    return ["power", "spell", "magic", "arcana"].some(term => value.includes(term));
  }
  return true;
}

export function stuntExecutionFor(name) {
  const key = normalize(name).replace(/[^a-z0-9]+/g, " ").trim();
  const damageDice = new Map([
    ["mighty blow", 1],
    ["vicious blow", 1],
    ["lethal blow", 2]
  ]);
  if (damageDice.has(key)) return {kind: "damage", damageDice: damageDice.get(key)};
  if (key === "knock prone") return {kind: "condition", statusId: "prone", requiresHitTarget: true};
  const defense = new Map([
    ["duck and weave", 1],
    ["defensive stance", 2]
  ]);
  if (defense.has(key)) return {kind: "effect", defenseBonus: defense.get(key), timing: "startOfTurn"};
  return null;
}

function candidateFromDocument(document, {owned = false, sourceLabel = null} = {}) {
  if (!document || document.type !== "stunts") return null;
  const range = costRange(document);
  const execution = foundry.utils.getProperty(document, "flags.age-system.automation.execution")
    ?? stuntExecutionFor(document.name);
  return {
    uuid: document.uuid,
    id: document.id,
    name: document.name,
    img: document.img ?? null,
    category: String(document.system?.type ?? "").trim(),
    minimum: range.minimum,
    maximum: range.maximum,
    variable: range.variable,
    owned,
    sourceLabel: sourceLabel ?? (owned ? game.i18n.localize("age-system.AUTOMATION.ownedStunt") : ""),
    execution: execution ? clone(execution) : null,
    executable: Boolean(execution)
  };
}

function ledger(message) {
  return clone(message?.flags?.[SYSTEM_ID]?.automation?.stunts ?? null);
}

function messageDocument(messageOrId) {
  return typeof messageOrId === "string" ? game.messages?.get?.(messageOrId) : messageOrId;
}

function canUpdateMessage(message) {
  const authorId = message?.author?.id ?? message?.user?.id ?? message?.user;
  return Boolean(game.user?.isGM || message?.isOwner || authorId === game.user?.id);
}

function escape(value) {
  return Handlebars.escapeExpression(String(value ?? ""));
}

async function loadCompendiumCandidate(entry) {
  if (metadataCache.has(entry.uuid)) return clone(metadataCache.get(entry.uuid));
  try {
    const document = await foundry.utils.fromUuid(entry.uuid);
    const candidate = candidateFromDocument(document, {sourceLabel: entry.packLabel});
    metadataCache.set(entry.uuid, candidate);
    return clone(candidate);
  } catch {
    metadataCache.set(entry.uuid, null);
    return null;
  }
}

async function resolveActorForStunt(uuid) {
  const document = uuid ? await foundry.utils.fromUuid(uuid) : null;
  return document?.actor ?? document ?? null;
}

function effectSource(effect) {
  if (!effect) return null;
  const source = clone(effect._source ?? effect.toObject?.(true));
  if (!source || typeof source !== "object") throw new Error("The Stunt effect source is unavailable.");
  source._id ??= effect.id;
  return source;
}

function stableEffectSource(source) {
  const stable = clone(source);
  if (stable) delete stable._stats;
  return stable;
}

function equal(left, right) {
  return foundry.utils.equals(left, right);
}

async function captureStuntExecution(execution, {verify = false} = {}) {
  if (execution?.kind === "damage" && execution.status === "applied") {
    throw new Error(game.i18n.localize("age-system.AUTOMATION.stuntDamageAlreadyApplied"));
  }
  if ((!execution?.created && !execution?.reactivated) || !execution.effectUuid) return null;
  const actor = await resolveActorForStunt(execution.actorUuid);
  const effect = values(actor?.effects).find(entry => entry.uuid === execution.effectUuid);
  if (!effect) throw new Error(game.i18n.localize("age-system.AUTOMATION.stuntUndoConflict"));
  const source = effectSource(effect);
  if (verify && (!execution.effectSnapshot
    || !equal(stableEffectSource(source), stableEffectSource(execution.effectSnapshot)))) {
    throw new Error(game.i18n.localize("age-system.AUTOMATION.stuntUndoConflict"));
  }
  return {actor, effect, source};
}

async function restoreStuntExecution(snapshot) {
  if (!snapshot) return;
  const {actor, source} = snapshot;
  const existing = values(actor.effects).find(effect => effect.id === source._id);
  if (existing) {
    const current = effectSource(existing);
    if (equal(stableEffectSource(current), stableEffectSource(source))) return;
    // Reversing an existing disabled condition changes only this field.
    if (!equal(stableEffectSource({...current, disabled: source.disabled}), stableEffectSource(source))) {
      throw new Error(game.i18n.localize("age-system.AUTOMATION.stuntUndoConflict"));
    }
    await existing.update({disabled: source.disabled}, {ageAutomation: true});
  } else {
    await actor.createEmbeddedDocuments("ActiveEffect", [clone(source)], {keepId: true, ageAutomation: true});
  }
  const restored = values(actor.effects).find(effect => effect.id === source._id);
  if (!restored || !equal(stableEffectSource(effectSource(restored)), stableEffectSource(source))) {
    throw new Error("The Stunt effect could not be restored exactly.");
  }
}

async function recoverStuntLedger(transaction, message, before, attempted) {
  const current = ledger(message);
  if (!equal(current, before) && !equal(current, attempted)) {
    throw new Error(game.i18n.localize("age-system.AUTOMATION.stuntUndoConflict"));
  }
  await transaction.rollback({removeHistory: true, strict: true});
}

async function reverseStuntExecution(execution) {
  if ((!execution?.created && !execution?.reactivated) || !execution.effectUuid || !execution.actorUuid) return false;
  const actor = await resolveActorForStunt(execution.actorUuid);
  if (!actor) throw new Error(game.i18n.localize("age-system.AUTOMATION.stuntUndoConflict"));
  if (execution.created) return ConditionLifecycleService.removeEffect(actor, execution.effectUuid);
  const effect = values(actor.effects).find(entry => entry.uuid === execution.effectUuid || entry.id === execution.effectUuid);
  if (!effect?.update) throw new Error(game.i18n.localize("age-system.AUTOMATION.stuntUndoConflict"));
  await effect.update({disabled: true}, {ageAutomation: true});
  return true;
}

export class StuntAssistantService {
  static get enabled() {
    return automationFeatureEnabled("enableStuntAssistant");
  }

  static createLedger({actor, item = null, rollType = null, rollSummary = null} = {}) {
    const total = finiteCost(rollSummary?.stuntPoints, 0);
    if (!this.enabled || !actor || total <= 0) return null;
    return {
      version: 2,
      actorUuid: actor.uuid,
      actorName: actor.name,
      itemUuid: item?.uuid ?? null,
      itemName: item?.name ?? null,
      rollType,
      total,
      remaining: total,
      spends: [],
      createdAt: Date.now(),
      revision: 0
    };
  }

  static state(messageOrId) {
    return ledger(messageDocument(messageOrId));
  }

  static async candidates(actor, {rollType = null} = {}) {
    if (!this.enabled || !actor) return [];
    const owned = values(actor.items)
      .filter(item => item?.type === "stunts")
      .map(item => candidateFromDocument(item, {owned: true}))
      .filter(Boolean);

    let compendium = [];
    if (automationFeatureEnabled("enableCompendiumIndex")) {
      await ageCompendiumIndex.ensureBuilt();
      const profile = game.settings.get(SYSTEM_ID, "activeRuleProfile");
      const entries = ageCompendiumIndex.search("", {documentName: "Item", type: "stunts", profile, limit: 200});
      const loaded = await Promise.all(entries.map(loadCompendiumCandidate));
      compendium = loaded.filter(Boolean);
    }

    const seen = new Set();
    return [...owned, ...compendium]
      .filter(candidate => {
        const key = `${normalize(candidate.name)}\u0000${candidate.minimum}\u0000${candidate.maximum}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(candidate => ({...candidate, recommended: categoryMatches(candidate.category, rollType)}))
      .sort((left, right) => Number(right.owned) - Number(left.owned)
        || Number(right.recommended) - Number(left.recommended)
        || left.minimum - right.minimum
        || left.name.localeCompare(right.name));
  }

  static async _candidate(actor, uuid) {
    const owned = values(actor?.items).find(item => item.uuid === uuid || item.id === uuid);
    if (owned) return candidateFromDocument(owned, {owned: true});
    const document = await foundry.utils.fromUuid(uuid);
    return candidateFromDocument(document);
  }

  static _hitTargets(message) {
    const results = message?.flags?.[SYSTEM_ID]?.ageroll?.rollData?.targetResults;
    return Array.isArray(results) ? results.filter(result => result?.hit !== false) : [];
  }

  static async _chooseHitTarget(message) {
    const targets = this._hitTargets(message);
    if (!targets.length) throw new Error(game.i18n.localize("age-system.AUTOMATION.stuntNeedsHitTarget"));
    if (targets.length === 1) return targets[0];
    const options = targets.map((target, index) => `<option value="${index}">${escape(target.name ?? target.actorName ?? target.tokenName ?? `Target ${index + 1}`)}</option>`).join("");
    const result = await showFormDialog({
      title: game.i18n.localize("age-system.AUTOMATION.chooseStuntTarget"),
      content: `<div class="form-group"><label>${escape(game.i18n.localize("age-system.AUTOMATION.target"))}</label><select name="targetIndex">${options}</select></div>`,
      confirmLabel: game.i18n.localize("age-system.AUTOMATION.applyStunt")
    });
    if (result.cancelled) return null;
    return targets[Number(result.targetIndex)] ?? null;
  }

  static async _execute(message, state, candidate) {
    const descriptor = candidate.execution;
    if (!descriptor) return {kind: "manual", status: "manual"};
    if (descriptor.kind === "damage") {
      if (!["attack", "meleeattack", "rangedattack", "stuntattack"].includes(normalize(state.rollType))) {
        return {kind: "manual", status: "manual"};
      }
      return {kind: "damage", status: "queued", damageDice: finiteCost(descriptor.damageDice, 0)};
    }
    if (descriptor.kind === "condition") {
      const target = await this._chooseHitTarget(message);
      if (!target) return null;
      const actor = await resolveActorForStunt(target.tokenUuid ?? target.actorUuid);
      if (!actor) throw new Error(game.i18n.localize("age-system.AUTOMATION.stuntTargetUnavailable"));
      const existing = ConditionLifecycleService.statusEffect(actor, descriptor.statusId);
      const wasDisabled = existing?.disabled === true;
      const effect = await ConditionLifecycleService.applyStatus(actor, descriptor.statusId, {
        sourceUuid: candidate.uuid,
        label: candidate.name
      });
      return {
        kind: "condition",
        status: "applied",
        actorUuid: actor.uuid,
        effectUuid: effect?.uuid ?? null,
        created: !existing,
        reactivated: wasDisabled,
        effectSnapshot: effectSource(effect),
        statusId: descriptor.statusId
      };
    }
    if (descriptor.kind === "effect") {
      const actor = await resolveActorForStunt(state.actorUuid);
      if (!actor) throw new Error(game.i18n.localize("age-system.AUTOMATION.stuntTargetUnavailable"));
      const effect = await ConditionLifecycleService.applyEffect(actor, {
        name: candidate.name,
        img: candidate.img,
        sourceUuid: candidate.uuid,
        duration: ConditionLifecycleService.duration(descriptor.timing ?? "startOfTurn", {sourceUuid: candidate.uuid, label: candidate.name}),
        changes: [{key: "system.defense.total", type: "add", phase: "final", value: String(Number(descriptor.defenseBonus ?? 0))}]
      });
      return {
        kind: "effect",
        status: "applied",
        actorUuid: actor.uuid,
        effectUuid: effect?.uuid ?? null,
        created: true,
        effectSnapshot: effectSource(effect),
        timing: descriptor.timing ?? "startOfTurn"
      };
    }
    return {kind: "manual", status: "manual"};
  }

  static pendingDamageDice(messageOrId) {
    const state = ledger(messageDocument(messageOrId));
    return (state?.spends ?? []).reduce((total, entry) => total + (entry.execution?.kind === "damage" && entry.execution?.status === "queued"
      ? finiteCost(entry.execution.damageDice, 0)
      : 0), 0);
  }

  static async markDamageApplied(messageOrId) {
    const message = messageDocument(messageOrId);
    const state = ledger(message);
    if (!message?.update || !state) return false;
    let changed = false;
    for (const entry of state.spends ?? []) {
      if (entry.execution?.kind === "damage" && entry.execution?.status === "queued") {
        entry.execution.status = "applied";
        entry.execution.appliedAt = Date.now();
        changed = true;
      }
    }
    if (!changed) return false;
    state.revision = finiteCost(state.revision, 0) + 1;
    await message.update({[`flags.${SYSTEM_ID}.automation.stunts`]: state});
    return true;
  }

  static async spend(messageOrId, {stuntUuid, cost, ageAction = null} = {}) {
    const message = messageDocument(messageOrId);
    if (!message?.update || !this.enabled) return false;
    if (!ageAction && AgeActionService.supports("stunt.spend")) {
      const execution = await AgeActionService.execute({
        type: "stunt.spend",
        messageUuid: message.uuid ?? `ChatMessage.${message.id ?? message._id}`,
        sourceUuid: stuntUuid ?? null,
        payload: {stuntUuid, cost},
        metadata: {origin: "stunt-assistant.spend"}
      }, {
        executor: action => this.spend(message, {stuntUuid, cost, ageAction: action})
      });
      return execution.result;
    }
    if (!canUpdateMessage(message)) throw new Error(game.i18n.localize("age-system.AUTOMATION.cannotSpendStunts"));
    const lockKey = message.id ?? message._id;
    if (locks.has(lockKey)) return false;
    locks.add(lockKey);
    try {
      let state = ledger(message);
      if (!state) throw new Error(game.i18n.localize("age-system.AUTOMATION.noStuntLedger"));
      let actor = await foundry.utils.fromUuid(state.actorUuid);
      actor = actor?.actor ?? actor;
      const candidate = await this._candidate(actor, stuntUuid);
      if (!candidate) throw new Error(game.i18n.localize("age-system.AUTOMATION.stuntUnavailable"));
      const finalCost = finiteCost(cost, candidate.minimum);
      if (finalCost <= 0 || finalCost < candidate.minimum || finalCost > candidate.maximum) {
        throw new RangeError(game.i18n.format("age-system.AUTOMATION.invalidStuntCost", {minimum: candidate.minimum, maximum: candidate.maximum}));
      }
      state = ledger(message) ?? state;
      if (finalCost > state.remaining) {
        throw new RangeError(game.i18n.format("age-system.AUTOMATION.notEnoughStuntPoints", {remaining: state.remaining, cost: finalCost}));
      }

      const transaction = AgeTransactionService.begin({
        id: ageAction?.id ?? null,
        label: game.i18n.format("age-system.AUTOMATION.stuntSpent", {stunt: candidate.name, cost: finalCost}),
        type: ageAction?.type ?? "stunt-points",
        sourceUuid: stuntUuid,
        metadata: {messageId: message.id ?? message._id, cost: finalCost,
          undoPolicy: "stunt-assistant", actionSchemaVersion: ageAction?.schemaVersion ?? null}
      }).track(message, `flags.${SYSTEM_ID}.automation.stunts`);
      const before = clone(state);
      const appliedExecution = await this._execute(message, state, candidate);
      if (appliedExecution === null) return false;
      state.spends.push({
        id: foundry.utils.randomID?.(12) ?? `${Date.now()}`,
        stuntUuid,
        name: candidate.name,
        cost: finalCost,
        spentAt: Date.now(),
        spentBy: game.user?.id ?? null,
        execution: appliedExecution
      });
      state.remaining = Math.max(0, state.total - state.spends.reduce((sum, entry) => sum + finiteCost(entry.cost, 0), 0));
      state.revision = finiteCost(state.revision, 0) + 1;
      try {
        await message.update({[`flags.${SYSTEM_ID}.automation.stunts`]: state});
        await transaction.commit();
      } catch (error) {
        const failures = [error];
        try { await reverseStuntExecution(appliedExecution); } catch (recoveryError) { failures.push(recoveryError); }
        try { await recoverStuntLedger(transaction, message, before, state); } catch (recoveryError) { failures.push(recoveryError); }
        if (failures.length > 1) throw new AggregateError(failures, "Stunt spend recovery was incomplete.");
        throw error;
      }
      return clone(state);
    } finally {
      locks.delete(lockKey);
    }
  }

  static async undoSpend(messageOrId, {ageAction = null} = {}) {
    const message = messageDocument(messageOrId);
    if (!message?.update || !this.enabled) return false;
    if (!ageAction && AgeActionService.supports("stunt.undo")) {
      const execution = await AgeActionService.execute({
        type: "stunt.undo",
        messageUuid: message.uuid ?? `ChatMessage.${message.id ?? message._id}`,
        payload: {},
        metadata: {origin: "stunt-assistant.undo"}
      }, {
        executor: action => this.undoSpend(message, {ageAction: action})
      });
      return execution.result;
    }
    if (!canUpdateMessage(message)) throw new Error(game.i18n.localize("age-system.AUTOMATION.cannotSpendStunts"));
    const lockKey = message.id ?? message._id;
    if (locks.has(lockKey)) return false;
    locks.add(lockKey);
    try {
      const state = ledger(message);
      if (!state?.spends?.length) return false;
      const transaction = AgeTransactionService.begin({
        id: ageAction?.id ?? null,
        label: game.i18n.localize("age-system.AUTOMATION.undoStuntSpend"),
        type: ageAction?.type ?? "stunt-points",
        metadata: {messageId: message.id ?? message._id,
          undoPolicy: "stunt-assistant", actionSchemaVersion: ageAction?.schemaVersion ?? null}
      }).track(message, `flags.${SYSTEM_ID}.automation.stunts`);
      const before = clone(state);
      const removed = state.spends.pop();
      const effectSnapshot = await captureStuntExecution(removed?.execution, {verify: true});
      state.remaining = Math.max(0, state.total - state.spends.reduce((sum, entry) => sum + finiteCost(entry.cost, 0), 0));
      state.revision = finiteCost(state.revision, 0) + 1;
      try {
        await reverseStuntExecution(removed?.execution);
        await message.update({[`flags.${SYSTEM_ID}.automation.stunts`]: state});
        await transaction.commit();
      } catch (error) {
        const failures = [error];
        try { await recoverStuntLedger(transaction, message, before, state); } catch (recoveryError) { failures.push(recoveryError); }
        try { await restoreStuntExecution(effectSnapshot); } catch (recoveryError) { failures.push(recoveryError); }
        if (failures.length > 1) throw new AggregateError(failures, "Stunt undo recovery was incomplete.");
        throw error;
      }
      return clone(state);
    } finally {
      locks.delete(lockKey);
    }
  }

  static open(messageOrId) {
    const message = messageDocument(messageOrId);
    if (!message || !ledger(message) || !this.enabled) return false;
    const application = new StuntAssistant(message.id ?? message._id);
    try {
      const renderResult = application.render({force: true});
      if (renderResult?.then instanceof Function) {
        void renderResult.catch(error => console.error("AGE System | Stunt Assistant failed to open.", error));
      }
    } catch (error) {
      console.error("AGE System | Stunt Assistant failed to open.", error);
    }
    return application;
  }

  static decorate(message, html) {
    const state = ledger(message);
    if (!state || !this.enabled || !html?.querySelector) return;
    const root = html.querySelector(".age-system.age-roll-card, .age-roll-card, .base-age-roll");
    if (!root || root.querySelector(".age-stunt-ledger")) return;
    const spends = state.spends?.length
      ? `<div class="notes" style="margin-top:.2rem">${state.spends.map(entry => `${escape(entry.name)} (${entry.cost} SP)`).join(" · ")}</div>`
      : "";
    const section = document.createElement("section");
    section.className = "age-stunt-ledger chat-buttons flexcol";
    section.style.cssText = "margin-top:.35rem;padding:.35rem;border-top:1px solid rgba(0,0,0,.25)";
    section.innerHTML = `<button type="button" class="age-button age-open-stunt-assistant"><i class="fa-solid fa-wand-sparkles"></i> ${escape(game.i18n.format("age-system.AUTOMATION.openStuntAssistantWithPoints", {remaining: state.remaining, total: state.total}))}</button>${spends}`;
    const buttons = root.querySelector(".chat-buttons");
    (buttons ?? root).append(section);
  }
}

export class StuntAssistant extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "age-stunt-assistant",
    classes: ["age-system", "age-v5-parity-sheet", "age-utility-workflow", "age-stunt-assistant-v2"],
    position: {width: 720, height: 650},
    window: {
      title: "age-system.AUTOMATION.stuntAssistant",
      icon: "fa-solid fa-wand-sparkles",
      resizable: true,
      minimizable: true
    },
    actions: {
      spend: StuntAssistant._spend,
      openStunt: StuntAssistant._openStunt,
      undo: StuntAssistant._undo
    }
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/automation/stunt-assistant.hbs",
      scrollable: [".age-utility-workflow__scroll"]
    }
  };

  constructor(messageId, options = {}) {
    super(options);
    this.messageId = messageId;
    this.query = "";
    this.category = "";
    this.showUnaffordable = true;
  }

  /** Preserve the boolean render signature used by the automation service. */
  render(options = {}) {
    if (typeof options === "boolean") options = {force: options};
    return super.render(options ?? {});
  }

  async _buildContext() {
    const message = messageDocument(this.messageId);
    const state = ledger(message);
    let actor = state?.actorUuid ? await foundry.utils.fromUuid(state.actorUuid) : null;
    actor = actor?.actor ?? actor;
    const all = state && actor ? await StuntAssistantService.candidates(actor, {rollType: state.rollType}) : [];
    const categories = [...new Set(all.map(candidate => candidate.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const query = normalize(this.query);
    const candidates = all
      .filter(candidate => !query || normalize(`${candidate.name} ${candidate.category} ${candidate.sourceLabel}`).includes(query))
      .filter(candidate => !this.category || candidate.category === this.category)
      .map(candidate => ({
        ...candidate,
        affordable: candidate.minimum <= (state?.remaining ?? 0),
        spendLabel: game.i18n.localize(candidate.executable ? "age-system.AUTOMATION.spendAndApply" : "age-system.AUTOMATION.spend")
      }))
      .filter(candidate => this.showUnaffordable || candidate.affordable);
    return {
      enabled: StuntAssistantService.enabled,
      messageAvailable: Boolean(message && state),
      state,
      query: this.query,
      category: this.category,
      categories,
      showUnaffordable: this.showUnaffordable,
      candidates,
      canUndo: Boolean(state?.spends?.length)
    };
  }

  async getData() {
    const base = typeof super.getData === "function" ? await super.getData() : {};
    return {...base, ...await this._buildContext()};
  }

  async _prepareContext(options) {
    const context = typeof super._prepareContext === "function"
      ? await super._prepareContext(options)
      : {};
    return Object.assign(context, await this._buildContext());
  }

  async _onFirstRender(context, options) {
    if (typeof super._onFirstRender === "function") await super._onFirstRender(context, options);
    this.element?.addEventListener("submit", event => {
      if (!event.target?.matches?.(".age-stunt-filter")) return;
      void this._onFilterSubmit(event);
    });
  }

  async _onRender(context, options) {
    if (typeof super._onRender === "function") await super._onRender(context, options);
    applyColorSchemeToElement(this.element);
    applyColorSchemeToElement(this.element?.querySelector?.(".colorset-selection"));
  }

  async _onFilterSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget?.matches?.(".age-stunt-filter") ? event.currentTarget : event.target;
    const formData = new foundry.applications.ux.FormDataExtended(form).object;
    this.query = formData.query ?? "";
    this.category = formData.category ?? "";
    this.showUnaffordable = formData.showUnaffordable === true || formData.showUnaffordable === "true" || formData.showUnaffordable === "on";
    return this.render({force: true});
  }

  static async _spend(event, target) {
    event.preventDefault();
    const row = target?.closest?.("[data-stunt-uuid]");
    const cost = row?.querySelector?.("input[name='stuntCost']")?.value;
    if (!row) return false;
    target.disabled = true;
    try {
      const result = await StuntAssistantService.spend(this.messageId, {
        stuntUuid: row.dataset.stuntUuid,
        cost
      });
      await this.render({force: true});
      return result;
    } catch (error) {
      ui.notifications.warn(error?.message ?? String(error));
      target.disabled = false;
      return false;
    }
  }

  static async _openStunt(event, target) {
    event.preventDefault();
    const uuid = target?.closest?.("[data-stunt-uuid]")?.dataset?.stuntUuid;
    const document = uuid ? await foundry.utils.fromUuid(uuid) : null;
    return document?.sheet?.render?.(true) ?? false;
  }

  static async _undo(event, target) {
    event.preventDefault();
    target.disabled = true;
    try {
      const result = await StuntAssistantService.undoSpend(this.messageId);
      await this.render({force: true});
      return result;
    } catch (error) {
      ui.notifications.warn(error?.message ?? String(error));
      target.disabled = false;
      return false;
    }
  }
}

export default StuntAssistantService;
