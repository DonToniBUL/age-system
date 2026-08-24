import {automationFeatureEnabled} from "./mode.js";
import {normalizeImportName, rankImportCandidates} from "./import-normalization.js";

const SYSTEM_ID = "age-system";
const SUPPORTED_DOCUMENTS = new Set(["Actor", "Item", "JournalEntry", "RollTable"]);
const AGE_PROFILE_LABELS = Object.freeze({
  dage: "age-system.AUTOMATION.profileDage",
  "fage-1e": "age-system.AUTOMATION.profileFage1",
  "fage-2e": "age-system.AUTOMATION.profileFage2",
  "mage-core": "age-system.AUTOMATION.profileMageCore",
  "mage-mastery-injury": "age-system.AUTOMATION.profileMageInjury"
});

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

function declaredProfiles(entry, pack) {
  const value = foundry.utils.getProperty(entry, "flags.age-system.profile")
    ?? foundry.utils.getProperty(entry, "flags.age-system.automation.profile")
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

function profileMatches(entry, profile) {
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
        const index = await pack.getIndex({
          fields: ["name", "type", "img", "flags.age-system.profile", "flags.age-system.automation.profile"]
        });
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
    this.entries = entries.sort((left, right) => left.name.localeCompare(right.name));
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
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .slice(0, maximum)
      .map(({normalizedName, normalizedDisplayName, searchText, score, ...entry}) => ({...entry, score}));
  }

  findExact(name, {documentName = "Item", type = null, profile = null} = {}) {
    if (!automationFeatureEnabled("enableCompendiumIndex")) return null;
    const expected = normalizeImportName(name);
    return this.entries
      .filter(entry => !documentName || entry.documentName === documentName)
      .filter(entry => !type || entry.type === type)
      .filter(entry => profileMatches(entry, profile))
      .find(entry => normalizeImportName(entry.name) === expected || normalizeImportName(entry.displayName) === expected) ?? null;
  }

  suggest(name, {documentName = "Item", type = null, profile = null, limit = 8, minimum = 0.58} = {}) {
    if (!automationFeatureEnabled("enableCompendiumIndex")) return [];
    const candidates = this.entries
      .filter(entry => !documentName || entry.documentName === documentName)
      .filter(entry => !type || entry.type === type)
      .filter(entry => profileMatches(entry, profile));
    return rankImportCandidates(name, candidates, {limit, minimum}).map(({normalizedName, normalizedDisplayName, searchText, ...entry}) => entry);
  }

  async open(uuid) {
    const document = await foundry.utils.fromUuid(uuid);
    if (!document) throw new Error(`Compendium document not found: ${uuid}`);
    return document.sheet?.render(true) ?? document;
  }
}

export const ageCompendiumIndex = new AgeCompendiumIndex();

export class UnifiedAgeSearch extends foundry.appv1.api.FormApplication {
  constructor(object = {}, options = {}) {
    super(object, options);
    this.query = "";
    this.documentName = "";
    this.results = [];
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "age-unified-library-search",
      template: "systems/age-system/templates/automation/compendium-search.hbs",
      classes: ["age-system", "dialog"],
      title: game.i18n.localize("age-system.AUTOMATION.librarySearch"),
      width: 720,
      height: 650,
      resizable: true,
      minimizable: true,
      closeOnSubmit: false,
      submitOnChange: false
    });
  }

  async getData() {
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
      ...super.getData(),
      automationEnabled,
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

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".age-library-open").on("click", async event => {
      const uuid = event.currentTarget.dataset.uuid;
      try {
        await ageCompendiumIndex.open(uuid);
      } catch (error) {
        ui.notifications.error(error.message);
      }
    });
    html.find(".age-library-rebuild").on("click", async event => {
      if (!automationFeatureEnabled("enableCompendiumIndex")) return;
      event.currentTarget.disabled = true;
      await ageCompendiumIndex.rebuild();
      this.render(false);
    });
  }

  _updateObject(_event, formData) {
    if (!automationFeatureEnabled("enableCompendiumIndex")) return;
    this.query = formData.query ?? "";
    this.documentName = formData.documentName ?? "";
    this.render(false);
  }
}

export default ageCompendiumIndex;
