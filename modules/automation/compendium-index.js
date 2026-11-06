import {automationFeatureEnabled} from "./mode.js";
import {normalizeImportName, rankImportCandidates} from "./import-normalization.js";
import {applyColorSchemeToElement} from "../color-scheme.js";

const SYSTEM_ID = "age-system";
const SUPPORTED_DOCUMENTS = new Set(["Actor", "Item", "JournalEntry", "RollTable"]);
const AGE_PROFILE_LABELS = Object.freeze({
  dage: "age-system.AUTOMATION.profileDage",
  "fage-1e": "age-system.AUTOMATION.profileFage1",
  "fage-2e": "age-system.AUTOMATION.profileFage2",
  "mage-core": "age-system.AUTOMATION.profileMageCore",
  "mage-mastery-injury": "age-system.AUTOMATION.profileMageInjury"
});
// Foundry v14 supplies the native AppV2 branch. The fallbacks keep isolated
// index/service tests able to evaluate this module without a browser runtime.
const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2
  ?? globalThis.foundry?.appv1?.api?.FormApplication
  ?? class {};
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin
  ?? (Base => Base);

const normalize = value => String(value ?? "")
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .trim()
  .toLowerCase();

const displayName = value => {
  const original = String(value ?? "").trim();
  const cleaned = original.replace(/^[\s,.;:]+/u, "").trim();
  return cleaned || original;
};

const collectionValues = collection => {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
};

export function declaredProfiles(entry, pack = null) {
  const value = foundry.utils.getProperty(entry, "flags.age-system.profile")
    ?? foundry.utils.getProperty(entry, "flags.age-system.automation.profile")
    ?? foundry.utils.getProperty(entry, "_source.flags.age-system.profile")
    ?? foundry.utils.getProperty(entry, "_source.flags.age-system.automation.profile")
    ?? foundry.utils.getProperty(pack, "metadata.flags.age-system.profile");
  if (value) return (Array.isArray(value) ? value : String(value).split(/[;,]/u)).map(normalize).filter(Boolean);

  const source = normalize([
    pack?.metadata?.packageName,
    pack?.metadata?.id,
    pack?.collection,
    pack?.metadata?.label
  ].filter(Boolean).join(" "));
  if (/dragon[ ._-]*age|(^|[ ._-])dage([ ._-]|$)/u.test(source)) return ["dage"];
  if (/fantasy[ ._-]*age|(^|[ ._-])fage([ ._-]|$)/u.test(source)) return ["fage", "fage-1e", "fage-2e"];
  if (/modern[ ._-]*age|(^|[ ._-])mage([ ._-]|$)/u.test(source)) return ["mage"];
  if (/(^|[ ._-])expanse([ ._-]|$)/u.test(source)) return ["expanse"];
  return [];
}

export function profileMatches(entry, profile) {
  const selected = normalize(profile);
  if (!selected || selected === "all" || selected === "custom") return true;
  const declared = entry.profiles ?? [];
  if (!declared.length) return true;
  if (declared.includes(selected)) return true;
  const family = selected.split("-")[0];
  return declared.includes(family);
}

function scoreResult(entry, query) {
  if (!query) return 1;
  const names = [entry.normalizedDisplayName, entry.normalizedName].filter(Boolean);
  if (names.some(name => name === query)) return 100;
  if (names.some(name => name.startsWith(query))) return 80;
  if (names.some(name => name.includes(query))) return 60;
  const words = query.split(/\s+/u).filter(Boolean);
  const haystack = entry.searchText;
  if (words.every(word => haystack.includes(word))) return 40 + words.length;
  return 0;
}

function indexedItemSubtype(document) {
  const value = foundry.utils.getProperty(document, "system.type") ?? document?.["system.type"];
  return ["talent", "spec"].includes(value) ? value : null;
}

export class AgeCompendiumIndex {
  constructor() {
    this.entries = [];
    this.lastBuiltAt = null;
    this.errors = [];
    this._building = null;
  }

  clear() {
    this.entries = [];
    this.errors = [];
    this.lastBuiltAt = null;
  }

  async rebuild() {
    if (!automationFeatureEnabled("enableCompendiumIndex")) {
      this.clear();
      return {count: 0, errors: []};
    }
    if (this._building) return this._building;
    this._building = this._rebuild();
    try {
      return await this._building;
    } finally {
      this._building = null;
    }
  }

  async _rebuild() {
    const entries = [];
    const errors = [];
    for (const pack of collectionValues(game.packs)) {
      // Never reveal the names or artwork of GM-only compendia to players.
      if (pack.visible === false) continue;
      const documentName = pack.documentName ?? pack.metadata?.type;
      if (!SUPPORTED_DOCUMENTS.has(documentName) || typeof pack.getIndex !== "function") continue;
      try {
        let index;
        try {
          index = await pack.getIndex({
            fields: ["name", "type", "img", "system.type", "flags.age-system.profile", "flags.age-system.automation.profile"]
          });
        } catch (_fieldError) {
          // Some older module packs reject requested index fields. Their basic
          // visible index remains useful; subtype is resolved from the full
          // Item before an importer match can be selected.
          index = await pack.getIndex();
        }
        for (const document of collectionValues(index)) {
          const id = document._id ?? document.id;
          if (!id || !document.name) continue;
          const collection = pack.collection ?? pack.metadata?.id;
          const uuid = document.uuid ?? (collection ? `Compendium.${collection}.${id}` : null);
          if (!uuid) continue;
          const packLabel = pack.metadata?.label ?? pack.title ?? collection;
          const entry = {
            id,
            uuid,
            name: document.name,
            displayName: displayName(document.name),
            type: document.type ?? documentName,
            subtype: document.type === "talent" ? indexedItemSubtype(document) : null,
            documentName,
            img: document.img ?? null,
            pack: collection,
            packLabel,
            packageName: pack.metadata?.packageName ?? pack.metadata?.package ?? null,
            profiles: declaredProfiles(document, pack)
          };
          entry.normalizedName = normalize(entry.name);
          entry.normalizedDisplayName = normalize(entry.displayName);
          entry.searchText = normalize(`${entry.displayName} ${entry.name} ${entry.type} ${entry.documentName} ${entry.packLabel} ${entry.packageName ?? ""}`);
          entries.push(entry);
        }
      } catch (error) {
        errors.push({pack: pack.collection ?? pack.metadata?.id ?? "unknown", message: error?.message ?? String(error)});
      }
    }
    this.entries = entries.sort((left, right) => left.name.localeCompare(right.name) || left.uuid.localeCompare(right.uuid));
    this.errors = errors;
    this.lastBuiltAt = Date.now();
    return {count: this.entries.length, errors: foundry.utils.deepClone(errors)};
  }

  async ensureBuilt() {
    if (this.lastBuiltAt === null) await this.rebuild();
    return this;
  }

  search(query = "", {documentName = null, type = null, profile = null, limit = 50} = {}) {
    if (!automationFeatureEnabled("enableCompendiumIndex")) return [];
    const needle = normalize(query);
    const maximum = Math.max(1, Math.min(Number(limit) || 50, 200));
    return this.entries
      .filter(entry => !documentName || entry.documentName === documentName)
      .filter(entry => !type || entry.type === type)
      .filter(entry => profileMatches(entry, profile))
      .map(entry => ({...entry, score: scoreResult(entry, needle)}))
      .filter(entry => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name) || left.uuid.localeCompare(right.uuid))
      .slice(0, maximum)
      .map(({normalizedName, normalizedDisplayName, searchText, score, ...entry}) => ({...entry, score}));
  }

  findExact(name, {documentName = "Item", type = null, profile = null} = {}) {
    const matches = this.findExactAll(name, {documentName, type, profile});
    return matches.length === 1 ? matches[0] : null;
  }

  findExactAll(name, {documentName = "Item", type = null, profile = null} = {}) {
    if (!automationFeatureEnabled("enableCompendiumIndex")) return [];
    const expected = normalizeImportName(name);
    return this.entries
      .filter(entry => !documentName || entry.documentName === documentName)
      .filter(entry => !type || entry.type === type)
      .filter(entry => profileMatches(entry, profile))
      .filter(entry => normalizeImportName(entry.name) === expected || normalizeImportName(entry.displayName) === expected)
      .sort((left, right) => left.name.localeCompare(right.name) || left.uuid.localeCompare(right.uuid))
      .map(({normalizedName, normalizedDisplayName, searchText, ...entry}) => entry);
  }

  suggest(name, {documentName = "Item", type = null, profile = null, limit = 8, minimum = 0.58} = {}) {
    if (!automationFeatureEnabled("enableCompendiumIndex")) return [];
    const candidates = this.entries
      .filter(entry => !documentName || entry.documentName === documentName)
      .filter(entry => !type || entry.type === type)
      .filter(entry => profileMatches(entry, profile));
    return rankImportCandidates(name, candidates, {limit, minimum})
      .map(({normalizedName, normalizedDisplayName, searchText, ...entry}) => entry);
  }

  async open(uuid) {
    const document = await foundry.utils.fromUuid(uuid);
    if (!document) throw new Error(`Compendium document not found: ${uuid}`);
    return document.sheet?.render(true) ?? document;
  }
}

export const ageCompendiumIndex = new AgeCompendiumIndex();

export class UnifiedAgeSearch extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "age-unified-library-search",
    classes: ["age-system", "dialog", "age-v5-parity-sheet", "age-utility-workflow", "age-compendium-search-v2"],
    position: {width: 720, height: 650},
    window: {
      title: "age-system.AUTOMATION.librarySearch",
      icon: "fa-solid fa-magnifying-glass",
      resizable: true,
      minimizable: true
    },
    actions: {
      search: UnifiedAgeSearch._search,
      openDocument: UnifiedAgeSearch._openDocument,
      rebuild: UnifiedAgeSearch._rebuild
    }
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/automation/compendium-search.hbs",
      scrollable: [".age-utility-workflow__scroll"]
    }
  };

  constructor(object = {}, options = undefined) {
    // AppV2 receives options as its first argument, while legacy callers may
    // still provide FormApplication's (object, options) pair.
    super((options ?? object) || {});
    this._legacyObject = options === undefined ? null : object;
    this.query = "";
    this.documentName = "";
    this.results = [];
    this._busy = false;
    this._operationError = "";
    this._listenerAbort = null;
  }

  /** Preserve the boolean render signature used by settings and Toolbox entry points. */
  render(options = {}) {
    if (typeof options === "boolean") options = {force: options};
    return super.render(options ?? {});
  }

  async _buildContext() {
    const automationEnabled = automationFeatureEnabled("enableCompendiumIndex");
    if (automationEnabled) await ageCompendiumIndex.ensureBuilt();
    const profile = game.settings.get(SYSTEM_ID, "activeRuleProfile");
    const configuredProfile = AGE_PROFILE_LABELS[profile];
    this.results = automationEnabled ? ageCompendiumIndex.search(this.query, {
      documentName: this.documentName || null,
      profile,
      limit: 100
    }) : [];
    return {
      automationEnabled,
      busy: this._busy,
      operationError: this._operationError,
      query: this.query,
      documentName: this.documentName,
      profile,
      profileLabel: configuredProfile
        ? game.i18n.localize(configuredProfile)
        : profile === "custom"
          ? game.i18n.localize("age-system.AUTOMATION.profileCustom")
          : profile,
      results: this.results,
      indexCount: ageCompendiumIndex.entries.length,
      indexErrors: ageCompendiumIndex.errors,
      isGM: game.user?.isGM === true
    };
  }

  /** Kept for integrations which inspected the former FormApplication data. */
  async getData(options = {}) {
    const base = typeof super.getData === "function" ? await super.getData(options) : {};
    return Object.assign(base ?? {}, await this._buildContext());
  }

  async _prepareContext(options) {
    const context = typeof super._prepareContext === "function"
      ? await super._prepareContext(options)
      : {};
    return Object.assign(context ?? {}, await this._buildContext());
  }

  async _onFirstRender(context, options) {
    if (typeof super._onFirstRender === "function") await super._onFirstRender(context, options);
    this._listenerAbort?.abort();
    this._listenerAbort = new AbortController();
    this.element?.addEventListener?.("submit", event => {
      const form = event.target?.closest?.(".age-library-toolbar");
      if (!form) return;
      void UnifiedAgeSearch._search.call(this, event, form);
    }, {signal: this._listenerAbort.signal});
  }

  async _onRender(context, options) {
    if (typeof super._onRender === "function") await super._onRender(context, options);
    applyColorSchemeToElement(this.element);
    applyColorSchemeToElement(this.element?.querySelector?.(".colorset-selection"));
  }

  async _onClose(options) {
    this._listenerAbort?.abort();
    this._listenerAbort = null;
    if (typeof super._onClose === "function") await super._onClose(options);
  }

  _readSearchForm(form) {
    const ExtendedFormData = globalThis.foundry?.applications?.ux?.FormDataExtended;
    if (ExtendedFormData && form) {
      try {
        return new ExtendedFormData(form).object ?? {};
      } catch (_error) { /* Fall through to the bounded field reader below. */ }
    }
    return {
      query: form?.querySelector?.("[name='query']")?.value ?? "",
      documentName: form?.querySelector?.("[name='documentName']")?.value ?? ""
    };
  }

  _setSearchState(formData = {}) {
    this.query = String(formData.query ?? "");
    this.documentName = String(formData.documentName ?? "");
  }

  async _renderSafely() {
    try {
      return await this.render({force: true});
    } catch (error) {
      console.error("AGE System | Unified library search failed to render.", error);
      globalThis.ui?.notifications?.error?.(error?.message ?? String(error));
      return null;
    }
  }

  async _perform(operation, {renderBusy = true, renderAfter = true} = {}) {
    if (this._busy) return null;
    this._busy = true;
    this._operationError = "";
    if (renderBusy) await this._renderSafely();
    let result = null;
    try {
      result = await operation();
    } catch (error) {
      this._operationError = error?.message ?? String(error);
      globalThis.ui?.notifications?.error?.(this._operationError);
    } finally {
      this._busy = false;
      if (renderAfter) await this._renderSafely();
    }
    return result;
  }

  static async _search(event, target) {
    event?.preventDefault?.();
    if (!automationFeatureEnabled("enableCompendiumIndex")) return false;
    const form = target?.closest?.(".age-library-toolbar")
      ?? this.element?.querySelector?.(".age-library-toolbar");
    this._setSearchState(this._readSearchForm(form));
    return this._perform(() => true, {renderBusy: false});
  }

  static async _openDocument(event, target) {
    event?.preventDefault?.();
    const uuid = target?.dataset?.uuid;
    if (!uuid) return false;
    return this._perform(() => ageCompendiumIndex.open(uuid));
  }

  static async _rebuild(event) {
    event?.preventDefault?.();
    if (!automationFeatureEnabled("enableCompendiumIndex")) return false;
    return this._perform(() => ageCompendiumIndex.rebuild());
  }

  _updateObject(_event, formData) {
    if (!automationFeatureEnabled("enableCompendiumIndex")) return false;
    this._setSearchState(formData);
    return this.render(false);
  }
}

export default ageCompendiumIndex;
