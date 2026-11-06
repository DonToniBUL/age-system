import {NpcParser} from "./parsers/npc-parser.js";
import {TalentParser} from "./parsers/talent-parser.js";
import {
  AgeImporterService,
  splitImportBlocks
} from "./automation/importer-service.js";
import {automationFeatureEnabled} from "./automation/mode.js";
import {importerUiError, reportImporterActionFailure} from "./automation/importer-error-reporting.js";

const SYSTEM_ID = "age-system";
const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

const NPC_MODES = Object.freeze({
  expanse: "The Expanse",
  mageL: "Modern AGE (Major NPC)",
  mageM: "Modern AGE (Minor NPC)",
  fage: "Fantasy AGE",
  fage2e: "Fantasy AGE 2e",
  dage: "Dragon AGE"
});

const TALENT_MODES = Object.freeze({
  dage: "Dragon AGE",
  fage: "Fantasy AGE",
  fage2e: "Fantasy AGE 2e",
  mage: "Modern AGE",
  expanse: "The Expanse"
});

const PROFILE_IMPORT_MODES = Object.freeze({
  dage: Object.freeze({npc: "dage", talent: "dage"}),
  "fage-1e": Object.freeze({npc: "fage", talent: "fage"}),
  "fage-2e": Object.freeze({npc: "fage2e", talent: "fage2e"}),
  "mage-core": Object.freeze({npc: "mageL", talent: "mage"}),
  "mage-mastery-injury": Object.freeze({npc: "mageL", talent: "mage"}),
});

const normalizedText = value => String(value ?? "")
  .replace(/\r\n?/gu, "\n")
  .replace(/[\u00a0\u2007\u202f]/gu, " ")
  .trim();

async function importerItemUuidFromDrop(event) {
  const reader = globalThis.foundry?.applications?.ux?.TextEditor?.implementation?.getDragEventData;
  let data = null;
  if (reader instanceof Function) {
    try { data = reader(event); } catch (_error) { data = null; }
  }
  if (!data) {
    const raw = String(event?.dataTransfer?.getData?.("text/plain") ?? "");
    if (!raw || raw.length > 10_000) return "";
    try { data = JSON.parse(raw); } catch (_error) { return ""; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || (data.type && data.type !== "Item")) return "";
  if (typeof data.uuid === "string" && data.uuid.trim()) return data.uuid.trim();
  const documentClass = globalThis.foundry?.utils?.getDocumentClass?.("Item") ?? globalThis.CONFIG?.Item?.documentClass;
  if (documentClass?.fromDropData instanceof Function) {
    try {
      const document = await documentClass.fromDropData(data);
      if (document?.documentName === "Item" && typeof document.uuid === "string" && document.uuid.trim()) {
        return document.uuid.trim();
      }
    } catch (_error) { /* The service reports a bounded, user-facing rejection below. */ }
  }
  if (data.type === "Item" && !data.pack && typeof data.id === "string" && data.id.trim()) return `Item.${data.id.trim()}`;
  return "";
}

const candidateItems = (kind, data = {}) => kind === "talent"
  ? (data.talents ?? []).map(talent => ({name: talent.name, type: "talent"}))
  : [
      ...(data.focus ?? []).map(item => ({name: item.name, type: item.type ?? "focus"})),
      ...(data.items ?? []).map(item => ({name: item.name, type: item.type})),
      ...(data.attacks ?? []).map(item => ({name: item.name, type: "weapon"}))
    ].filter(item => item.name && item.type);

const randomId = () => foundry.utils.randomID?.(16) ?? `${Date.now()}-${Math.random()}`;

/**
 * Guided, review-first importer for NPC stat blocks and Talent text.
 *
 * Preferred launch API: `await AgeImporter.open(options)`.
 * Legacy callers using `new AgeImporter(options).render(true)` remain supported.
 */
export default class AgeImporter extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "age-importer",
    classes: ["age-system", "age-importer-v2"],
    position: {width: 980, height: 800},
    window: {title: "AGE Importer", resizable: true, minimizable: true}
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/age-importer.hbs",
      scrollable: [".age-importer-v2__scroll"]
    }
  };

  constructor(options = {}) {
    const {
      kind = "npc",
      text = "",
      mode = null,
      packs = [],
      packList = packs,
      ...applicationOptions
    } = options;
    super(applicationOptions);

    this._packList = Array.isArray(packList) ? packList : [];
    this._importingAbilities = this._setting("abilitySelection", "");
    const profileModes = PROFILE_IMPORT_MODES[this._setting("activeRuleProfile", "")];
    this._npcImportingText = kind === "npc" ? String(text ?? "") : "";
    this._npcModeSelected = kind === "npc" && mode ? mode : (profileModes?.npc ?? "expanse");
    this._npcPreview = null;
    this._talentImportingText = kind === "talent" ? String(text ?? "") : "";
    this._talentModeSelected = kind === "talent" && mode ? mode : (profileModes?.talent ?? "dage");
    this._talentPreview = null;
    this._npcModeOptions = {...NPC_MODES};
    this._talentModeOptions = {...TALENT_MODES};

    this._activeKind = kind === "talent" ? "talent" : "npc";
    this._activeStep = "input";
    this._busy = false;
    this._announcement = "";
    this._operationError = "";
    this._focusAfterRender = "";
    this._previewMeta = {npc: null, talent: null};
    this._results = {npc: [], talent: []};
    this._localSessions = new Map();
    this._searches = new Map();
    this._expiryTimer = null;
  }

  /**
   * Open the importer and return its application instance.
   * @param {object} options AppV2 options plus kind, text, mode and packs/packList.
   * @returns {Promise<AgeImporter>}
   */
  static async open(options = {}) {
    const app = new this(options);
    await app.render({force: true});
    return app;
  }

  /** Normalize the AppV1 boolean render signature used by existing callers. */
  render(options = {}) {
    if (typeof options === "boolean") options = {force: options};
    return super.render(options ?? {});
  }

  /** Kept for integrations which inspected the former AppV1 context directly. */
  getData() {
    return this._buildContext();
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return Object.assign(context, this._buildContext());
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.element?.addEventListener("click", event => this._onClick(event));
    this.element?.addEventListener("change", event => this._onChange(event));
    this.element?.addEventListener("input", event => this._onInput(event));
    this.element?.addEventListener("keydown", event => this._onKeydown(event));
    this.element?.addEventListener("dragover", event => this._onDragOver(event));
    this.element?.addEventListener("dragleave", event => this._onDragLeave(event));
    this.element?.addEventListener("drop", event => this._onDrop(event));
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    globalThis.clearTimeout?.(this._expiryTimer);
    this._expiryTimer = null;
    const remainingMs = this._previewState(this._activeKind).remainingMs;
    if (remainingMs > 0) {
      this._expiryTimer = globalThis.setTimeout?.(() => this.updateUI(), Math.min(remainingMs + 25, 2_147_000_000));
    }
    const selector = this._focusAfterRender;
    this._focusAfterRender = "";
    if (!selector) return;
    const focus = () => this.element?.querySelector?.(selector)?.focus?.();
    if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(focus);
    else focus();
  }

  async _onClose(options) {
    globalThis.clearTimeout?.(this._expiryTimer);
    this._expiryTimer = null;
    for (const kind of ["npc", "talent"]) {
      const preview = this._previewFor(kind);
      const meta = this._previewMeta[kind];
      if (preview?.id && meta?.service && !preview.created) {
        try { AgeImporterService.cancel(preview.id); } catch (_error) { /* Already expired or unavailable. */ }
      }
    }
    this._localSessions.clear();
    await super._onClose(options);
  }

  updateUI() {
    return this.render({force: true});
  }

  _useImporterV2() {
    return automationFeatureEnabled("importerV2Enabled");
  }

  async _runButton(event, action) {
    if (event?.currentTarget) event.currentTarget.disabled = true;
    return this._perform(action);
  }

  _setting(key, fallback = "") {
    try {
      return game.settings.get(SYSTEM_ID, key) ?? fallback;
    } catch (_error) {
      return fallback;
    }
  }

  _t(key, fallback, data = null) {
    try {
      const translated = data ? game.i18n.format(key, data) : game.i18n.localize(key);
      return translated && translated !== key ? translated : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  _textFor(kind) {
    return kind === "talent" ? this._talentImportingText : this._npcImportingText;
  }

  _modeFor(kind) {
    return kind === "talent" ? this._talentModeSelected : this._npcModeSelected;
  }

  _previewFor(kind) {
    return kind === "talent" ? this._talentPreview : this._npcPreview;
  }

  _setPreview(kind, preview) {
    if (kind === "talent") this._talentPreview = preview;
    else this._npcPreview = preview;
  }

  _signature(kind) {
    const source = `${kind}\u0000${this._modeFor(kind)}\u0000${normalizedText(this._textFor(kind))}`;
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  _sessionFor(kind) {
    const preview = this._previewFor(kind);
    const meta = this._previewMeta[kind];
    if (!preview?.id || !meta) return null;
    return meta.service
      ? AgeImporterService.sessions.get(preview.id) ?? null
      : this._localSessions.get(preview.id) ?? null;
  }

  _markPreviewChanged(kind, {manual = false} = {}) {
    const meta = this._previewMeta[kind];
    if (meta && manual) meta.invalidated = true;
    if (!this._previewFor(kind)) return;
    this._announcement = this._t(
      "age-system.IMPORTER.previewStaleNotice",
      "The source or resolution changed. Refresh the review before creating anything."
    );
    this._syncCommitState();
  }

  _syncCommitState() {
    const state = this._previewState(this._activeKind);
    const commit = this.element?.querySelector?.("[data-action='commit']");
    if (commit) commit.disabled = !state.canCommit;
    const notice = this.element?.querySelector?.("[data-importer-live]");
    if (notice) notice.textContent = this._announcement || state.status;
    const freshness = this.element?.querySelector?.("[data-importer-freshness]");
    if (freshness) {
      freshness.textContent = state.status;
      freshness.className = `age-importer-v2__freshness ${state.statusClass}`;
    }
  }

  _onInput(event) {
    const target = event.target;
    const kind = target?.dataset?.importText;
    if (kind) {
      if (kind === "talent") this._talentImportingText = target.value;
      else this._npcImportingText = target.value;
      this._markPreviewChanged(kind);
      return;
    }
    const searchKey = target?.dataset?.resolutionSearch;
    if (searchKey) {
      const current = this._searches.get(searchKey) ?? {results: [], error: ""};
      current.query = target.value;
      this._searches.set(searchKey, current);
    }
  }

  async _onChange(event) {
    const target = event.target;
    if (target?.dataset?.injuryReview !== undefined) {
      const controls = target.closest?.("[data-injury-controls]");
      if (!controls) return null;
      const valueChanged = target?.dataset?.injuryValue !== undefined;
      const review = {
        entryIndex: Number(controls.dataset.entryIndex),
        matchIndex: Number(controls.dataset.matchIndex),
        damageInjury: controls.querySelector?.("[data-injury-value]")?.value ?? null,
        // A value edit must require a fresh, separate confirmation gesture even
        // when the checkbox was still checked from the preceding reviewed value.
        confirmed: valueChanged ? false : controls.querySelector?.("[data-injury-confirm]")?.checked === true,
      };
      return this._perform(() => this._setInjuryReview(review));
    }
    const kind = target?.dataset?.importMode;
    if (!kind) return;
    if (kind === "talent") this._talentModeSelected = target.value;
    else this._npcModeSelected = target.value;
    this._markPreviewChanged(kind);
    this.updateUI();
  }

  _onKeydown(event) {
    const tab = event.target?.closest?.("[role='tab'][data-kind]");
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = Array.from(this.element?.querySelectorAll?.("[role='tab'][data-kind]") ?? []);
    if (!tabs.length) return;
    let index = tabs.indexOf(tab);
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = tabs.length - 1;
    else index = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[index]?.click?.();
  }

  async _onClick(event) {
    const button = event.target?.closest?.("[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === "switch-kind") {
      this._activeKind = button.dataset.kind === "talent" ? "talent" : "npc";
      const preview = this._previewFor(this._activeKind);
      this._activeStep = preview?.created ? "result" : preview ? "review" : "input";
      this._focusAfterRender = `[data-kind='${this._activeKind}'][role='tab']`;
      await this.updateUI();
      return;
    }
    if (action === "go-input") return this._goToStep("input");
    if (action === "go-review") return this._goToStep("review");
    if (action === "go-result") return this._goToStep("result");
    if (action === "preview") return this._perform(() => this._preview());
    if (action === "commit") return this._perform(() => this._commit());
    if (action === "search") return this._perform(() => this._searchResolution(button));
    if (action === "select-candidate") return this._perform(() => this._setResolution(button.dataset.entryIndex, button.dataset.matchIndex, button.dataset.uuid));
    if (action === "create-from-parsed") return this._perform(() => this._setResolution(button.dataset.entryIndex, button.dataset.matchIndex, "create"));
    if (action === "open-document") return this._perform(() => this._openDocument(button.dataset.uuid));
    if (action === "open-settings") {
      game.settings?.sheet?.render?.(true);
      return;
    }
  }

  async _goToStep(step) {
    const preview = this._previewFor(this._activeKind);
    if (step === "review" && !preview) return;
    if (step === "result" && !preview?.created) return;
    this._activeStep = step;
    this._focusAfterRender = `[data-step-heading='${step}']`;
    await this.updateUI();
  }

  async _perform(action) {
    if (this._busy) return null;
    this._busy = true;
    this._operationError = "";
    await this.updateUI();
    try {
      return await action();
    } catch (error) {
      const reason = error?.message ?? String(error);
      this._operationError = reason;
      this._announcement = this._t("age-system.IMPORTER.operationFailed", `Import action failed: ${reason}`, {reason});
      reportImporterActionFailure(error, {
        unexpectedMessage: this._t("age-system.importFailed", `Import failed: ${reason}`, {reason}),
      });
      return null;
    } finally {
      this._busy = false;
      await this.updateUI();
    }
  }

  async _preview() {
    const kind = this._activeKind;
    const text = normalizedText(this._textFor(kind));
    if (!text) throw importerUiError("AGE_IMPORT_NO_TEXT",
      this._t("age-system.AUTOMATION.noImportText", "Paste at least one stat block before previewing."));

    const service = this._useImporterV2();
    const preview = service
      ? await AgeImporterService.preview({kind, text, mode: this._modeFor(kind)})
      : await this._localPreview({kind, text, mode: this._modeFor(kind)});
    this._setPreview(kind, preview);
    this._previewMeta[kind] = {
      signature: this._signature(kind),
      service,
      createdAt: Date.now(),
      invalidated: false
    };
    this._results[kind] = [];
    this._activeStep = "review";
    this._announcement = this._t(
      "age-system.IMPORTER.previewReady",
      `Review ready: ${preview.validCount ?? 0} valid entr${preview.validCount === 1 ? "y" : "ies"}.`,
      {count: preview.validCount ?? 0}
    );
    this._focusAfterRender = "[data-step-heading='review']";
  }

  async _commit() {
    const kind = this._activeKind;
    // `_perform` sets `_busy` before invoking this method. Ignore only that
    // wrapper-owned flag here; every signed-preview and blocker check remains.
    const state = this._previewState(kind, {ignoreBusy: true});
    if (!state.canCommit) throw importerUiError("AGE_IMPORT_PREVIEW_BLOCKED", state.status);
    const preview = this._previewFor(kind);
    const meta = this._previewMeta[kind];
    if (!meta.service) {
      throw importerUiError("AGE_IMPORT_ASSISTANCE_REQUIRED", this._t(
        "age-system.IMPORTER.assistanceRequired",
        "Enable Automation mode: Assist and the Importer V2 setting, then refresh the review before creating."
      ));
    }
    const result = await AgeImporterService.commit(preview.id, {
      inputDigest: preview.inputDigest,
      snapshotDigest: preview.snapshotDigest,
      planDigest: preview.planDigest
    });
    this._setPreview(kind, result.summary);
    this._results[kind] = this._createdModels(result.created);
    this._activeStep = "result";
    const count = result.created?.length ?? 0;
    this._announcement = this._t("age-system.AUTOMATION.importCreated", `Created ${count} document(s).`, {count});
    this._focusAfterRender = "[data-step-heading='result']";
    ui.notifications?.info?.(this._announcement);
  }

  async _localPreview({kind, text, mode}) {
    const blocks = splitImportBlocks(text);
    if (!blocks.length) throw importerUiError("AGE_IMPORT_NO_TEXT",
      this._t("age-system.AUTOMATION.noImportText", "No import text was found."));
    const Parser = kind === "npc" ? NpcParser : TalentParser;
    const parsers = [];
    const entries = [];
    const errors = [];
    for (let index = 0; index < blocks.length; index++) {
      try {
        const parser = new Parser(blocks[index], mode, {
          create: false,
          packs: this._packList,
          profileId: this._setting("activeRuleProfile", "")
        });
        const data = await parser.ready;
        const candidates = candidateItems(kind, data);
        const matches = candidates.map((candidate, matchIndex) => ({
          ...candidate,
          matchIndex,
          status: "unresolved",
          uuid: null,
          source: "",
          selectedUuid: null,
          pinned: true,
          selectionMode: "create",
          createSelected: true,
          confidence: 0,
          confidencePercent: 0,
          requiresResolution: false,
          searchQuery: candidate.name,
          options: []
        }));
        const name = kind === "npc" ? data.name : data.talents?.[0]?.name;
        entries.push({
          index,
          name: name || `${kind} ${index + 1}`,
          itemCount: candidates.length,
          parsed: data,
          matchedCount: 0,
          unresolvedCount: matches.length,
          matches
        });
        parsers.push(parser);
      } catch (error) {
        errors.push({index, name: `${kind} ${index + 1}`, message: error?.message ?? String(error)});
      }
    }
    const session = {id: randomId(), kind, mode, parsers, entries, errors, created: false, timestamp: Date.now()};
    this._localSessions.set(session.id, session);
    while (this._localSessions.size > 10) this._localSessions.delete(this._localSessions.keys().next().value);
    return this._localSummary(session);
  }

  _localSummary(session) {
    return foundry.utils.deepClone({
      id: session.id,
      kind: session.kind,
      mode: session.mode,
      entries: session.entries,
      errors: session.errors,
      validCount: session.parsers.length,
      errorCount: session.errors.length,
      created: session.created
    });
  }

  _previewState(kind, {ignoreBusy = false} = {}) {
    const preview = this._previewFor(kind);
    const meta = this._previewMeta[kind];
    const session = this._sessionFor(kind);
    const stale = Boolean(preview && meta && (meta.invalidated || meta.signature !== this._signature(kind)));
    const remainingMs = preview?.expiresAt ? Math.max(0, Number(preview.expiresAt) - Date.now()) : null;
    const expired = Boolean(preview && meta && (!session || remainingMs === 0));
    const assistanceDisabled = Boolean(preview && meta && (!meta.service || !this._useImporterV2()));
    const blockers = [];
    if (assistanceDisabled) {
      blockers.push(this._t(
        "age-system.IMPORTER.assistanceRequired",
        "Enable Automation mode: Assist and the Importer V2 setting, then refresh the review before creating."
      ));
    }
    for (const error of preview?.errors ?? []) blockers.push(error.message ?? String(error));
    for (const blocker of preview?.blockers ?? []) blockers.push(blocker.message ?? String(blocker));
    for (const entry of preview?.entries ?? []) {
      for (const blocker of entry.blockers ?? []) blockers.push(blocker.message ?? String(blocker));
      for (const match of entry.matches ?? []) {
        if (match.blocked || match.status === "blocked") blockers.push(match.message ?? `${match.name} cannot be resolved.`);
        if (match.requiresResolution === true) {
          blockers.push(this._t(
            "age-system.IMPORTER.ambiguousResolution",
            `Choose a verified source or explicitly create “${match.name}” from parsed text.`,
            {name: match.name}
          ));
        }
      }
    }
    const validCount = Number(preview?.validCount ?? preview?.entries?.length ?? 0);
    let status = this._t("age-system.IMPORTER.noPreview", "Preview required before creation.");
    let statusClass = "is-idle";
    if (preview?.created) {
      status = this._t("age-system.IMPORTER.previewCommitted", "This preview has already been created.");
      statusClass = "is-complete";
    } else if (expired) {
      status = this._t("age-system.AUTOMATION.importPreviewExpired", "The preview expired. Refresh it before creating.");
      statusClass = "is-error";
    } else if (stale) {
      status = this._t("age-system.IMPORTER.previewStale", "Preview is stale. Refresh it before creating.");
      statusClass = "is-warning";
    } else if (assistanceDisabled) {
      status = this._t(
        "age-system.IMPORTER.assistanceRequired",
        "Enable Automation mode: Assist and the Importer V2 setting, then refresh the review before creating."
      );
      statusClass = "is-error";
    } else if (blockers.length) {
      status = this._t("age-system.IMPORTER.blockersRemain", `${blockers.length} blocker(s) must be fixed.`, {count: blockers.length});
      statusClass = "is-error";
    } else if (preview && validCount < 1) {
      status = this._t("age-system.IMPORTER.noValidEntries", "The preview contains no valid entries.");
      statusClass = "is-error";
    } else if (preview) {
      status = this._t("age-system.IMPORTER.freshPreview", "Fresh preview ready to create.");
      statusClass = "is-ready";
    }
    const canCommit = Boolean(preview && meta?.service && session && !preview.created && !stale && !expired && !blockers.length && validCount > 0 && (ignoreBusy || !this._busy));
    return {
      preview,
      meta,
      session,
      stale,
      expired,
      assistanceDisabled,
      blockers,
      validCount,
      canCommit,
      status,
      statusClass,
      remainingMs,
      remainingSeconds: remainingMs === null ? null : Math.ceil(remainingMs / 1000)
    };
  }

  _resolutionKey(entryIndex, matchIndex) {
    return `${this._activeKind}:${entryIndex}:${matchIndex}`;
  }

  _rawMatch(entryIndex, matchIndex) {
    const entry = (this._previewFor(this._activeKind)?.entries ?? []).find(value => Number(value.index) === Number(entryIndex));
    return entry?.matches?.find(match => Number(match.matchIndex) === Number(matchIndex)) ?? null;
  }

  async _searchResolution(button) {
    const entryIndex = Number(button.dataset.entryIndex);
    const matchIndex = Number(button.dataset.matchIndex);
    const key = this._resolutionKey(entryIndex, matchIndex);
    const match = this._rawMatch(entryIndex, matchIndex);
    if (!match) throw importerUiError("AGE_IMPORT_MATCH_STALE", "The item resolution is no longer present in this preview.");
    const preview = this._previewFor(this._activeKind);
    const meta = this._previewMeta[this._activeKind];
    if (!meta?.service) throw importerUiError("AGE_IMPORT_ASSISTANCE_REQUIRED",
      this._t("age-system.IMPORTER.assistanceRequired", "Enable importer assistance and refresh the preview before searching."));
    const input = this.element?.querySelector?.(`[data-resolution-search='${key}']`);
    const query = String(input?.value ?? this._searches.get(key)?.query ?? match.name).trim() || match.name;
    const updated = await AgeImporterService.searchMatch(preview.id, {entryIndex, matchIndex, query});
    this._setPreview(this._activeKind, updated);
    this._searches.set(key, {query});
    const updatedMatch = this._rawMatch(entryIndex, matchIndex);
    const count = updatedMatch?.options?.length ?? 0;
    this._announcement = count
      ? this._t("age-system.IMPORTER.resolutionResults", `${count} verified candidate(s) found.`, {count})
      : this._t("age-system.IMPORTER.noResolutionResults", "No matching Items were found.");
  }

  async _setResolution(entryIndex, matchIndex, uuid) {
    const preview = this._previewFor(this._activeKind);
    const meta = this._previewMeta[this._activeKind];
    if (!meta?.service) throw importerUiError("AGE_IMPORT_ASSISTANCE_REQUIRED",
      this._t("age-system.IMPORTER.assistanceRequired", "Enable importer assistance and refresh the preview before changing resolutions."));
    const updated = await AgeImporterService.setMatchResolution(preview.id, {
      entryIndex: Number(entryIndex),
      matchIndex: Number(matchIndex),
      uuid
    });
    this._setPreview(this._activeKind, updated);
    this._announcement = uuid === "create"
      ? this._t("age-system.IMPORTER.createFromParsedSelected", "The importer will create this Item from parsed text during commit.")
      : this._t("age-system.IMPORTER.candidateSelected", "Verified source selected for this parsed Item.");
  }

  async _setDroppedResolution(entryIndex, matchIndex, uuid) {
    const preview = this._previewFor(this._activeKind);
    const meta = this._previewMeta[this._activeKind];
    if (!meta?.service) throw importerUiError("AGE_IMPORT_ASSISTANCE_REQUIRED",
      this._t("age-system.IMPORTER.assistanceRequired", "Enable importer assistance and refresh the preview before changing resolutions."));
    const updated = await AgeImporterService.setDroppedItemResolution(preview.id, {
      entryIndex: Number(entryIndex),
      matchIndex: Number(matchIndex),
      uuid,
    });
    this._setPreview(this._activeKind, updated);
    this._announcement = this._t("age-system.IMPORTER.dropSelected", "Verified dropped Item selected for this entry.");
  }

  async _setInjuryReview(review) {
    const preview = this._previewFor(this._activeKind);
    const meta = this._previewMeta[this._activeKind];
    if (!meta?.service) throw importerUiError("AGE_IMPORT_ASSISTANCE_REQUIRED",
      this._t("age-system.IMPORTER.assistanceRequired", "Enable importer assistance and refresh the preview before changing resolutions."));
    const updated = await AgeImporterService.setInjuryDamageResolution(preview.id, {
      entryIndex: review.entryIndex,
      matchIndex: review.matchIndex,
      damageInjury: review.damageInjury,
      confirmed: review.confirmed,
    });
    this._setPreview(this._activeKind, updated);
    this._announcement = review.confirmed === true
      ? this._t("age-system.IMPORTER.injuryReviewConfirmed", "The custom Injury damage is confirmed and signed into this review.")
      : this._t("age-system.IMPORTER.injuryReviewUpdated", "The custom Injury damage was updated; confirm it before creating.");
  }

  _onDragOver(event) {
    const target = event.target?.closest?.("[data-importer-item-drop]");
    if (!target) return;
    event.preventDefault();
    const disabled = target.getAttribute?.("aria-disabled") === "true" || this._busy;
    if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (disabled) return;
    target.classList?.add?.("is-dragover");
  }

  _onDragLeave(event) {
    const target = event.target?.closest?.("[data-importer-item-drop]");
    if (!target || target.contains?.(event.relatedTarget)) return;
    target.classList?.remove?.("is-dragover");
  }

  async _onDrop(event) {
    const target = event.target?.closest?.("[data-importer-item-drop]");
    if (!target) return;
    event.preventDefault();
    target.classList?.remove?.("is-dragover");
    if (target.getAttribute?.("aria-disabled") === "true" || this._busy) {
      const reason = target.dataset.disabledReason || this._t(
        "age-system.IMPORTER.dropUnavailable",
        "Refresh the review before dropping an Item here."
      );
      this._operationError = reason;
      this._announcement = reason;
      ui.notifications?.warn?.(reason);
      if (!this._busy) await this.updateUI();
      return null;
    }
    const uuid = await importerItemUuidFromDrop(event);
    if (!uuid) {
      return this._perform(async () => {
        throw importerUiError("AGE_IMPORT_DROP_INVALID",
          this._t("age-system.IMPORTER.dropInvalid", "Drop a valid Item from the Items directory or a visible compendium."));
      });
    }
    return this._perform(() => this._setDroppedResolution(target.dataset.entryIndex, target.dataset.matchIndex, uuid));
  }

  async _fromUuid(uuid) {
    if (!uuid) return null;
    if (typeof foundry.utils.fromUuid === "function") return foundry.utils.fromUuid(uuid);
    if (typeof globalThis.fromUuid === "function") return globalThis.fromUuid(uuid);
    return null;
  }

  async _openDocument(uuid) {
    const document = await this._fromUuid(uuid);
    if (!document) throw importerUiError("AGE_IMPORT_DOCUMENT_MISSING",
      this._t("age-system.IMPORTER.documentMissing", "The created document is no longer available."));
    document.sheet?.render?.(true);
    return document;
  }

  _createdModels(documents = []) {
    return documents.map((document, index) => ({
      uuid: document?.uuid ?? document?.id ?? "",
      name: document?.name ?? `${this._t("age-system.IMPORTER.createdDocument", "Created document")} ${index + 1}`,
      type: document?.documentName ?? document?.type ?? "Document",
      img: document?.img ?? "icons/svg/book.svg"
    }));
  }

  _talentDegreeLabel(degree) {
    const index = Number(degree);
    if (!Number.isInteger(index) || index < 0 || index > 4) return "";
    const configured = globalThis.CONFIG?.ageSystem?.talentDegrees?.inUse?.[index];
    if (typeof configured === "string" && configured.trim()) {
      return configured.startsWith("age-system.") ? this._t(configured, configured.split(".").at(-1)) : configured;
    }
    const modern = String(this._setting("DegressChoice", "mage")).startsWith("mage");
    const keys = modern
      ? ["novice", "expert", "master", "grandmaster", "apex"]
      : ["novice", "journeyman", "master", "grandmaster", "apex"];
    const fallbacks = modern
      ? ["Novice", "Expert", "Master", "Grandmaster", "Apex"]
      : ["Novice", "Journeyman", "Master", "Grandmaster", "Apex"];
    return this._t(`age-system.${keys[index]}`, fallbacks[index]);
  }

  _requestedUsageModel(match) {
    const usage = [];
    if (match.type === "talent") {
      if (match.requestedDegree !== null && match.requestedDegree !== undefined
          && Number.isInteger(Number(match.requestedDegree))) {
        usage.push({label: this._t("age-system.IMPORTER.requestedDegree", "Requested degree"),
          value: this._talentDegreeLabel(match.requestedDegree)});
      }
      if (match.requestedSubtype) {
        usage.push({label: this._t("age-system.IMPORTER.itemSubtype", "Parsed kind"), value: match.requestedSubtype === "spec"
          ? this._t("age-system.IMPORTER.specialization", "Specialization")
          : this._t("age-system.IMPORTER.talent", "Talent")});
      }
    } else if (match.type === "focus") {
      if (match.requestedAbility) {
        usage.push({label: this._t("age-system.IMPORTER.focusAbility", "Focus ability"),
          value: this._t(`age-system.${match.requestedAbility}`, match.requestedAbility)});
      }
      if (match.requestedFocusBonus !== null && match.requestedFocusBonus !== undefined
          && Number.isInteger(Number(match.requestedFocusBonus))) {
        const bonus = Number(match.requestedFocusBonus);
        usage.push({label: this._t("age-system.IMPORTER.focusBonus", "Focus bonus"), value: `${bonus >= 0 ? "+" : ""}${bonus}`});
      }
    }
    return usage;
  }

  _parsedSummary(kind, data, entry) {
    if (!data) return null;
    if (kind === "talent") {
      return {
        kind: "talent",
        talents: (data.talents ?? []).map(talent => ({
          name: talent.name,
          requirement: talent.requirement,
          classes: talent.classes,
          description: talent.generalDesc,
          degrees: Object.entries(talent.degrees ?? {})
            .filter(([, degree]) => degree?.desc)
            .map(([id, degree]) => ({id, description: degree.desc}))
        }))
      };
    }
    const abilities = Object.entries(data.abilities ?? {})
      .filter(([, ability]) => ability && typeof ability === "object" && Number.isFinite(Number(ability.value)))
      .map(([id, ability]) => ({
        id,
        name: this._t(`age-system.${id}`, id),
        value: Number(ability.value)
      }));
    const selectedMode = this._setting("gameMode", "none");
    const modeData = data.gameMode?.specs?.[selectedMode] ?? data.gameMode?.specs?.none ?? {};
    const derived = [
      {label: this._t("age-system.speed", "Speed base"), value: data.speed?.base},
      {label: this._t("age-system.health", "Health"), value: modeData.health},
      {label: this._t("age-system.defense", "Defense modifier"), value: modeData.defense},
      {label: this._t("age-system.toughness", "Toughness modifier"), value: modeData.toughness},
      {label: this._t("age-system.bonus.impactArmor", "Impact armor"), value: data.armor?.impactArmor},
      {label: this._t("age-system.bonus.ballisticArmor", "Ballistic armor"), value: data.armor?.ballisticArmor},
      {label: this._t("age-system.threat", "Threat"), value: data.threat}
    ].filter(stat => stat.value !== undefined && stat.value !== null && stat.value !== "");
    return {
      kind: "npc",
      name: data.name ?? entry.name,
      abilities,
      derived,
      attacks: (data.attacks ?? []).map(attack => ({
        name: attack.name,
        roll: attack.toHit,
        damage: attack.dmg,
        damageInjury: attack.damageInjury ?? attack.damageInjurySuggestion ?? null,
      })),
      features: (data.features ?? []).map(feature => ({name: feature.name, description: feature.desc})),
      foci: (data.focus ?? []).map(focus => focus.name).filter(Boolean)
    };
  }

  _entryModels(kind, state) {
    return (state.preview?.entries ?? []).map((entry, position) => {
      const parser = state.session?.parsers?.[position];
      const parsed = entry.parsedSummary ?? this._parsedSummary(kind, entry.parsed ?? parser?.parser?.data ?? parser?.data, entry);
      const matches = (entry.matches ?? []).map((match, positionIndex) => {
        const matchIndex = Number(match.matchIndex ?? positionIndex);
        const key = `${kind}:${entry.index}:${matchIndex}`;
        const search = this._searches.get(key) ?? {query: match.searchQuery ?? match.name};
        const confidenceValue = Number(match.confidencePercent ?? (Number(match.confidence ?? 0) * 100));
        const statusLabel = match.status === "world"
          ? this._t("age-system.IMPORTER.statusWorld", "World Item")
          : match.status === "compendium"
            ? this._t("age-system.IMPORTER.statusCompendium", "Compendium")
            : match.status === "ambiguous"
              ? this._t("age-system.IMPORTER.statusAmbiguous", "Choice required")
              : match.status === "suggested"
                ? this._t("age-system.IMPORTER.statusSuggested", "Suggestions available")
            : match.status === "blocked"
              ? this._t("age-system.IMPORTER.statusBlocked", "Blocked")
              : this._t("age-system.IMPORTER.statusUnresolved", "Create from parsed text");
        const options = (match.options ?? []).map(option => ({
          ...option,
          selected: option.uuid === match.selectedUuid,
          sourceLabel: option.source ?? this._t("age-system.IMPORTER.unknownSource", "Library"),
          confidence: `${Math.max(0, Math.min(100, Math.round(Number(option.confidencePercent ?? Number(option.confidence ?? 0) * 100))))}%`
        }));
        const requestedUsage = this._requestedUsageModel(match);
        const resolutionDisabledReason = !state.meta?.service || state.assistanceDisabled
          ? this._t("age-system.IMPORTER.assistanceRequired", "Enable importer assistance and refresh the preview before changing resolutions.")
          : state.expired
            ? this._t("age-system.AUTOMATION.importPreviewExpired", "The preview expired. Refresh it before changing resolutions.")
            : state.stale
              ? this._t("age-system.IMPORTER.previewStale", "Preview is stale. Refresh it before changing resolutions.")
              : state.preview?.created
                ? this._t("age-system.IMPORTER.previewCommitted", "This preview has already been created.")
                : this._busy
                  ? this._t("age-system.IMPORTER.operationInProgress", "Wait for the current import action to finish.")
                  : "";
        return {
          ...match,
          key,
          matchIndex,
          statusLabel,
          statusClass: `is-${match.status ?? "unresolved"}`,
          confidence: Number.isFinite(confidenceValue) ? `${Math.max(0, Math.min(100, Math.round(confidenceValue)))}%` : "—",
          sourceLabel: match.source || (match.createSelected
            ? this._t("age-system.IMPORTER.parserGenerated", "Generated from parsed text")
            : "—"),
          unresolved: !match.selectedUuid,
          ambiguous: match.requiresResolution === true,
          resolutionDisabled: Boolean(resolutionDisabledReason),
          resolutionDisabledReason,
          search: {
            query: search.query ?? match.searchQuery ?? match.name,
            hasResults: options.length > 0,
            results: options
          },
          createSelected: match.createSelected === true,
          injuryRequired: match.injuryRequired === true,
          injurySourceBacked: match.damageInjuryProvenance === "source",
          injuryCustom: match.injuryRequired === true && match.damageInjuryProvenance !== "source",
          parsedDamageFormula: match.parsedDamageFormula ?? match.damageFormula ?? "",
          sourceDamageFormula: match.sourceDamageFormula ?? "",
          damageFormula: match.damageFormula ?? "",
          damageInjury: match.damageInjury ?? "",
          damageInjuryConfirmed: match.damageInjuryConfirmed === true,
          injuryProvenanceLabel: match.damageInjuryProvenance === "source"
            ? this._t("age-system.IMPORTER.injuryProvenanceSource", "Exact value from signed source")
            : match.damageInjuryProvenance === "formula"
              ? this._t("age-system.IMPORTER.injuryProvenanceFormula", "Bounded formula suggestion")
              : this._t("age-system.IMPORTER.injuryProvenanceManual", "GM-reviewed manual value"),
          requestedUsage,
          hasRequestedUsage: requestedUsage.length > 0
        };
      });
      return {
        ...entry,
        number: Number(entry.index) + 1,
        parsed,
        matches,
        hasMatches: matches.length > 0,
        warnings: (entry.warnings ?? []).map(warning => warning.message ?? String(warning)),
        blockers: (entry.blockers ?? []).map(blocker => blocker.message ?? String(blocker))
      };
    });
  }

  _buildContext() {
    const kind = this._activeKind;
    const state = this._previewState(kind);
    const text = this._textFor(kind);
    const mode = this._modeFor(kind);
    const modes = kind === "talent" ? TALENT_MODES : NPC_MODES;
    const preview = state.preview;
    const errors = [
      ...(preview?.errors ?? []).map(error => ({...error, number: Number(error.index) + 1})),
      ...(this._operationError ? [{index: -1, number: "", name: "", message: this._operationError}] : [])
    ];
    const warnings = [
      ...(preview?.warnings ?? []).map(warning => warning.message ?? String(warning)),
      ...((preview?.entries ?? []).flatMap(entry => entry.warnings ?? []).map(warning => warning.message ?? String(warning)))
    ];
    const unresolvedCount = (preview?.entries ?? []).reduce((total, entry) => total + Number(entry.unresolvedCount ?? 0), 0);
    const normalizationChanges = Object.entries(preview?.normalization?.changes ?? {}).map(([name, count]) => ({name, count}));
    const activeInput = this._activeStep === "input";
    const activeReview = this._activeStep === "review";
    const activeResult = this._activeStep === "result";
    return {
      activeKind: kind,
      isNpc: kind === "npc",
      isTalent: kind === "talent",
      activeInput,
      activeReview,
      activeResult,
      busy: this._busy,
      importingText: text,
      selectedMode: mode,
      modes: Object.entries(modes).map(([value, label]) => ({value, label, selected: value === mode})),
      importingAbilities: this._importingAbilities,
      packList: this._packList,
      importerV2: this._useImporterV2(),
      automationUnavailable: !this._useImporterV2(),
      preview,
      hasPreview: Boolean(preview),
      hasResult: Boolean(preview?.created),
      entries: this._entryModels(kind, state),
      errors,
      hasErrors: errors.length > 0,
      warnings,
      hasWarnings: warnings.length > 0,
      blockerCount: state.blockers.length,
      unresolvedCount,
      normalizationChanged: preview?.normalization?.changed === true,
      normalizationChanges,
      hasNormalizationChanges: normalizationChanges.length > 0,
      state,
      canCommit: state.canCommit,
      resultDocuments: this._results[kind],
      hasResultDocuments: this._results[kind].length > 0,
      announcement: this._announcement || state.status,
      normalizedNotice: this._t(
        "age-system.IMPORTER.normalizationNotice",
        "Line endings, spacing and supported AGE headings are normalized for parsing. The pasted text is never changed in Foundry until you confirm a fresh review."
      ),
      labels: {
        title: this._t("age-system.ageImporter", "AGE Importer"),
        kicker: this._t("age-system.IMPORTER.kicker", "Guided AGE tools"),
        subtitle: this._t("age-system.IMPORTER.subtitle", "Paste a supported AGE stat block, inspect every result, then create it."),
        documentTabs: this._t("age-system.IMPORTER.documentTabs", "Import document type"),
        stepsAria: this._t("age-system.IMPORTER.stepsAria", "Import steps"),
        step: this._t("age-system.IMPORTER.step", "Step"),
        paste: this._t("age-system.IMPORTER.paste", "Paste"),
        configure: this._t("age-system.IMPORTER.configure", "Configure"),
        reviewTotals: this._t("age-system.IMPORTER.reviewTotals", "Review totals"),
        entry: this._t("age-system.IMPORTER.entry", "Entry"),
        previewExpires: this._t("age-system.IMPORTER.previewExpires", "Preview expires"),
        npcTab: this._t("age-system.npcImporter", "NPC importer"),
        talentTab: this._t("age-system.talentImporter", "Talent importer"),
        inputStep: this._t("age-system.IMPORTER.stepInput", "Paste & options"),
        reviewStep: this._t("age-system.IMPORTER.stepReview", "Review"),
        resultStep: this._t("age-system.IMPORTER.stepResult", "Result"),
        sourceText: this._t("age-system.IMPORTER.sourceText", "Source text"),
        sourceHelp: this._t("age-system.IMPORTER.sourceHelp", "Separate multiple entries with a line containing ---, ===, or ***."),
        options: this._t("age-system.settings.options", "Options"),
        gameSetting: this._t("age-system.selectGameSetting", "Game setting"),
        normalization: this._t("age-system.IMPORTER.normalization", "Normalization"),
        preview: this._t("age-system.AUTOMATION.previewImport", "Build review"),
        refresh: this._t("age-system.IMPORTER.refreshPreview", "Refresh review"),
        assistanceRequired: this._t("age-system.IMPORTER.assistanceRequired", "Enable Automation mode: Assist and the Importer V2 setting before creating. Parser-only review remains available."),
        openSettings: this._t("age-system.IMPORTER.openSettings", "Open settings"),
        back: this._t("age-system.IMPORTER.backToInput", "Back to paste & options"),
        parsedSummary: this._t("age-system.IMPORTER.parsedSummary", "Parsed summary"),
        batch: this._t("age-system.IMPORTER.batchEntries", "Batch entries"),
        resolutions: this._t("age-system.IMPORTER.itemResolutions", "Item resolutions"),
        parsedItem: this._t("age-system.IMPORTER.parsedItem", "Parsed Item"),
        status: this._t("age-system.IMPORTER.status", "Status"),
        confidence: this._t("age-system.IMPORTER.confidence", "Confidence"),
        source: this._t("age-system.IMPORTER.source", "Source"),
        search: this._t("age-system.IMPORTER.search", "Search"),
        find: this._t("age-system.IMPORTER.findCandidates", "Find candidates"),
        dropItem: this._t("age-system.IMPORTER.dropItem", "Drop an Item here"),
        dropItemHint: this._t("age-system.IMPORTER.dropItemHint", "The Item type must match this parsed entry."),
        select: this._t("age-system.IMPORTER.selectCandidate", "Select"),
        selected: this._t("age-system.IMPORTER.selectedCandidate", "Selected"),
        createFromParsed: this._t("age-system.IMPORTER.createFromParsed", "Create new from parsed text"),
        noItems: this._t("age-system.IMPORTER.noItems", "No linked Items were detected in this entry."),
        errors: this._t("age-system.IMPORTER.errors", "Errors and blockers"),
        warnings: this._t("age-system.IMPORTER.warnings", "Warnings"),
        unresolvedHelp: this._t("age-system.IMPORTER.unresolvedHelp", "Exact world and compendium Items are reused first. Review suggestions, or choose Create new from parsed text when you intentionally want a custom local Item."),
        commitNpc: this._t("age-system.IMPORTER.createNpc", "Create verified NPC(s)"),
        commitTalent: this._t("age-system.IMPORTER.createTalent", "Create verified Talent(s)"),
        resultTitle: this._t("age-system.IMPORTER.resultTitle", "Import complete"),
        resultHelp: this._t("age-system.IMPORTER.resultHelp", "The reviewed documents were created. Open them below to make any final edits."),
        open: this._t("age-system.IMPORTER.openDocument", "Open"),
        newImport: this._t("age-system.IMPORTER.newImport", "Start another import"),
        validEntries: this._t("age-system.IMPORTER.validEntries", "Valid entries"),
        unresolved: this._t("age-system.IMPORTER.unresolved", "Local fallbacks"),
        blockers: this._t("age-system.IMPORTER.blockers", "Blockers"),
        abilities: this._t("age-system.IMPORTER.abilities", "Abilities"),
        derived: this._t("age-system.IMPORTER.derivedStats", "Derived values"),
        attacks: this._t("age-system.IMPORTER.attacks", "Attacks"),
        features: this._t("age-system.IMPORTER.features", "Features"),
        foci: this._t("age-system.IMPORTER.foci", "Foci"),
        ordinaryDamage: this._t("age-system.IMPORTER.ordinaryDamage", "Ordinary damage"),
        parsedDamageFormula: this._t("age-system.IMPORTER.parsedDamageFormula", "Pasted damage formula"),
        sourceDamageFormula: this._t("age-system.IMPORTER.sourceDamageFormula", "Reused source damage formula"),
        injuryDamage: this._t("age-system.IMPORTER.injuryDamage", "Injury damage"),
        injuryProvenance: this._t("age-system.IMPORTER.injuryProvenance", "Injury source"),
        injuryReviewHint: this._t("age-system.IMPORTER.injuryReviewHint", "Review or replace the bounded suggestion, then explicitly confirm it."),
        injuryConfirm: this._t("age-system.IMPORTER.injuryConfirm", "I reviewed and confirm this Injury damage"),
        sourceInjuryLocked: this._t("age-system.IMPORTER.sourceInjuryLocked", "This exact signed source value will be preserved."),
        talents: this._t("age-system.IMPORTER.talents", "Talents"),
        requirement: this._t("age-system.IMPORTER.requirement", "Requirement"),
        classes: this._t("age-system.IMPORTER.classes", "Classes"),
        degrees: this._t("age-system.IMPORTER.degrees", "Degrees")
      }
    };
  }
}

// Parser exports are a public compatibility surface used by macros and modules.
export {NpcParser, TalentParser};
