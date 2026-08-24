import {NpcParser} from "../parsers/npc-parser.js";
import {TalentParser} from "../parsers/talent-parser.js";
import {ageCompendiumIndex} from "./compendium-index.js";
import {normalizeImportName, normalizePdfClipboardText, rankImportCandidates} from "./import-normalization.js";
import {requireAssistMode} from "./mode.js";

const SYSTEM_ID = "age-system";
const INITIAL_SUGGESTION_LIMIT = 6;

const values = collection => {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
};

const matchKey = (name, type) => `${type ?? ""}:${normalizeImportName(name)}`;
const displayConfidence = confidence => Math.round(Math.max(0, Math.min(1, Number(confidence) || 0)) * 100);

export function splitImportBlocks(text, {normalize = true} = {}) {
  const source = normalize ? normalizePdfClipboardText(text).text : String(text ?? "");
  return source
    .split(/^\s*(?:-{3,}|={3,}|\*{3,})\s*$/mu)
    .map(block => block.trim())
    .filter(Boolean);
}

export function sanitizeImportedDocumentData(source) {
  const data = source?.toObject ? source.toObject() : foundry.utils.deepClone(source ?? {});
  for (const key of ["_id", "id", "uuid", "_stats", "folder", "sort", "ownership", "pack"] ) delete data[key];
  return data;
}

function worldItemsOfType(type) {
  return values(game.items).filter(item => item.type === type);
}

function worldItemMatch(name, type) {
  const expected = normalizeImportName(name);
  return worldItemsOfType(type).find(item => normalizeImportName(item.name) === expected) ?? null;
}

function sourceLabelForWorld() {
  return game.i18n.localize("age-system.AUTOMATION.worldItems");
}

function worldOption(item, confidence = 1) {
  return {
    uuid: item.uuid,
    name: item.name,
    source: sourceLabelForWorld(),
    sourceKind: "world",
    confidence,
    confidencePercent: displayConfidence(confidence)
  };
}

function compendiumOption(entry) {
  return {
    uuid: entry.uuid,
    name: entry.name,
    source: entry.packLabel ?? entry.pack ?? "",
    sourceKind: "compendium",
    confidence: entry.confidence ?? 1,
    confidencePercent: displayConfidence(entry.confidence ?? 1)
  };
}

function uniqueOptions(options) {
  const seen = new Set();
  return options.filter(option => {
    if (!option?.uuid || seen.has(option.uuid)) return false;
    seen.add(option.uuid);
    return true;
  });
}

function worldSuggestions(name, type, {limit = INITIAL_SUGGESTION_LIMIT, minimum = 0.58} = {}) {
  const candidates = worldItemsOfType(type).map(item => ({uuid: item.uuid, name: item.name}));
  return rankImportCandidates(name, candidates, {limit, minimum}).map(item => worldOption(item, item.confidence));
}

function candidateItems(kind, data) {
  if (kind === "talent") {
    return (data.talents ?? []).map(talent => ({name: talent.name, type: "talent"}));
  }
  return [
    ...(data.focus ?? []).map(item => ({name: item.name, type: item.type ?? "focus"})),
    ...(data.items ?? []).map(item => ({name: item.name, type: item.type})),
    ...(data.attacks ?? []).map(item => ({name: item.name, type: "weapon"}))
  ].filter(item => item.name && item.type);
}

function presentMatch(match) {
  const options = (match.options ?? []).map(option => ({
    ...option,
    selected: option.uuid === match.selectedUuid,
    label: `${option.name} — ${option.source} (${option.confidencePercent}%)`
  }));
  return {
    ...match,
    createSelected: !match.selectedUuid,
    confidencePercent: displayConfidence(match.confidence),
    options
  };
}

export class AgeImporterService {
  static sessions = new Map();

  static parserClass(kind) {
    if (kind === "npc") return NpcParser;
    if (kind === "talent") return TalentParser;
    throw new Error(`Unsupported AGE importer kind: ${kind}`);
  }

  static async #candidateMatch(candidate, profile, matchIndex) {
    const world = worldItemMatch(candidate.name, candidate.type);
    const compendium = world ? null : ageCompendiumIndex.findExact(candidate.name, {
      documentName: "Item",
      type: candidate.type,
      profile
    });
    const suggestions = uniqueOptions([
      ...worldSuggestions(candidate.name, candidate.type),
      ...ageCompendiumIndex.suggest(candidate.name, {
        documentName: "Item",
        type: candidate.type,
        profile,
        limit: INITIAL_SUGGESTION_LIMIT
      }).map(compendiumOption)
    ]).slice(0, INITIAL_SUGGESTION_LIMIT);
    const exactOption = world ? worldOption(world) : compendium ? compendiumOption({...compendium, confidence: 1}) : null;
    const options = uniqueOptions([exactOption, ...suggestions].filter(Boolean));
    return {
      ...candidate,
      matchIndex,
      key: matchKey(candidate.name, candidate.type),
      status: world ? "world" : compendium ? "compendium" : options.length ? "suggested" : "unresolved",
      selectedUuid: exactOption?.uuid ?? null,
      uuid: exactOption?.uuid ?? null,
      source: exactOption?.source ?? "",
      confidence: exactOption?.confidence ?? options[0]?.confidence ?? 0,
      searchQuery: candidate.name,
      options
    };
  }

  static async preview({kind, text, mode} = {}) {
    requireAssistMode();
    const normalized = normalizePdfClipboardText(text);
    const blocks = splitImportBlocks(normalized.text, {normalize: false});
    if (!blocks.length) throw new Error(game.i18n.localize("age-system.AUTOMATION.noImportText"));
    await ageCompendiumIndex.ensureBuilt();
    const profile = game.settings.get(SYSTEM_ID, "activeRuleProfile");
    const Parser = this.parserClass(kind);
    const parsers = [];
    const entries = [];
    const errors = [];

    for (let index = 0; index < blocks.length; index++) {
      try {
        const parser = new Parser(blocks[index], mode, {create: false});
        const data = await parser.ready;
        const candidates = candidateItems(kind, data);
        const matches = [];
        for (let matchIndex = 0; matchIndex < candidates.length; matchIndex++) {
          matches.push(await this.#candidateMatch(candidates[matchIndex], profile, matchIndex));
        }
        const name = kind === "npc" ? data.name : data.talents?.[0]?.name;
        entries.push({
          index,
          name: name || `${kind} ${index + 1}`,
          itemCount: candidates.length,
          matchedCount: matches.filter(match => Boolean(match.selectedUuid)).length,
          unresolvedCount: matches.filter(match => !match.selectedUuid).length,
          matches
        });
        parsers.push({parser, entryIndex: index});
      } catch (error) {
        errors.push({index, name: `${kind} ${index + 1}`, message: error?.message ?? String(error)});
      }
    }

    const id = foundry.utils.randomID?.(16) ?? `${Date.now()}-${Math.random()}`;
    const session = {
      id,
      kind,
      mode,
      profile,
      parsers,
      entries,
      errors,
      created: false,
      timestamp: Date.now(),
      normalization: {changed: normalized.changed, changes: normalized.changes, text: normalized.text}
    };
    this.sessions.set(id, session);
    while (this.sessions.size > 10) this.sessions.delete(this.sessions.keys().next().value);
    return this.summary(session);
  }

  static #session(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(game.i18n.localize("age-system.AUTOMATION.importPreviewExpired"));
    if (session.created) throw new Error(game.i18n.localize("age-system.AUTOMATION.importAlreadyCreated"));
    return session;
  }

  static #match(session, entryIndex, matchIndex) {
    const entry = session.entries.find(candidate => candidate.index === Number(entryIndex));
    const match = entry?.matches?.find(candidate => candidate.matchIndex === Number(matchIndex));
    if (!entry || !match) throw new Error("The selected import candidate is no longer available.");
    return {entry, match};
  }

  static async searchMatch(sessionId, {entryIndex, matchIndex, query} = {}) {
    requireAssistMode();
    const session = this.#session(sessionId);
    const {match} = this.#match(session, entryIndex, matchIndex);
    const searchQuery = String(query ?? "").trim() || match.name;
    await ageCompendiumIndex.ensureBuilt();
    const options = uniqueOptions([
      ...worldSuggestions(searchQuery, match.type, {limit: 12, minimum: 0.35}),
      ...ageCompendiumIndex.suggest(searchQuery, {
        documentName: "Item",
        type: match.type,
        profile: session.profile,
        limit: 12,
        minimum: 0.35
      }).map(compendiumOption),
      ...(match.options ?? [])
    ]).slice(0, 12);
    match.searchQuery = searchQuery;
    match.options = options;
    if (match.selectedUuid && !options.some(option => option.uuid === match.selectedUuid)) match.selectedUuid = null;
    this.#refreshEntryCounts(session);
    return this.summary(session);
  }

  static async setMatchResolution(sessionId, {entryIndex, matchIndex, uuid = null} = {}) {
    requireAssistMode();
    const session = this.#session(sessionId);
    const {match} = this.#match(session, entryIndex, matchIndex);
    if (!uuid || uuid === "create") {
      match.selectedUuid = null;
      match.uuid = null;
      match.source = "";
      match.status = match.options.length ? "suggested" : "unresolved";
      this.#refreshEntryCounts(session);
      return this.summary(session);
    }
    const option = match.options.find(candidate => candidate.uuid === uuid);
    if (!option) throw new Error("Select an Item from the verified search results.");
    const document = await foundry.utils.fromUuid(uuid);
    if (!document || document.documentName !== "Item" || document.type !== match.type) {
      throw new Error(`The selected source is not a ${match.type} Item.`);
    }
    match.selectedUuid = option.uuid;
    match.uuid = option.uuid;
    match.source = option.source;
    match.confidence = option.confidence;
    match.status = option.sourceKind;
    this.#refreshEntryCounts(session);
    return this.summary(session);
  }

  static #refreshEntryCounts(session) {
    for (const entry of session.entries) {
      entry.matchedCount = entry.matches.filter(match => Boolean(match.selectedUuid)).length;
      entry.unresolvedCount = entry.matches.filter(match => !match.selectedUuid).length;
    }
  }

  static summary(session) {
    return foundry.utils.deepClone({
      id: session.id,
      kind: session.kind,
      mode: session.mode,
      profile: session.profile,
      normalization: session.normalization,
      entries: session.entries.map(entry => ({...entry, matches: entry.matches.map(presentMatch)})),
      errors: session.errors,
      validCount: session.parsers.length,
      errorCount: session.errors.length,
      created: session.created
    });
  }

  static async resolveItem(parsed, {destination = "actor"} = {}) {
    const world = worldItemMatch(parsed.name, parsed.type);
    if (world) {
      if (destination === "world") return {existing: world, uuid: world.uuid, source: "world"};
      return {data: sanitizeImportedDocumentData(world), uuid: world.uuid, source: "world"};
    }

    await ageCompendiumIndex.ensureBuilt();
    const profile = game.settings.get(SYSTEM_ID, "activeRuleProfile");
    const match = ageCompendiumIndex.findExact(parsed.name, {
      documentName: "Item",
      type: parsed.type,
      profile
    });
    if (!match) return null;
    return this.#resolvedDocument(match.uuid, destination, parsed.type);
  }

  static async #resolvedDocument(uuid, destination, expectedType = null) {
    const document = await foundry.utils.fromUuid(uuid);
    if (!document) return null;
    if (document.documentName !== "Item" || (expectedType && document.type !== expectedType)) return null;
    const isWorldItem = document.documentName === "Item" && !document.pack;
    if (destination === "world" && isWorldItem) return {existing: document, uuid, source: "world"};
    return {data: sanitizeImportedDocumentData(document), uuid, source: isWorldItem ? "world" : "compendium"};
  }

  static async #resolveSessionItem(session, parsed, {destination = "actor"} = {}, entryIndex = null) {
    const key = matchKey(parsed.name, parsed.type);
    const entries = entryIndex === null
      ? session.entries
      : session.entries.filter(entry => entry.index === Number(entryIndex));
    const match = entries.flatMap(entry => entry.matches).find(candidate => candidate.key === key);
    if (!match) return this.resolveItem(parsed, {destination});
    if (!match.selectedUuid) return null;
    return this.#resolvedDocument(match.selectedUuid, destination, parsed.type);
  }

  static async #validateSelections(session) {
    for (const match of session.entries.flatMap(entry => entry.matches)) {
      if (!match.selectedUuid) continue;
      const document = await foundry.utils.fromUuid(match.selectedUuid);
      if (!document || document.documentName !== "Item" || document.type !== match.type) {
        throw new Error(`The selected source for "${match.name}" is no longer an available ${match.type} Item. Review the preview again.`);
      }
    }
  }

  static async commit(sessionId) {
    requireAssistMode();
    const session = this.#session(sessionId);
    await this.#validateSelections(session);
    const created = [];
    for (const {parser, entryIndex} of session.parsers) {
      parser.options.resolveItem = (parsed, options) => this.#resolveSessionItem(session, parsed, options, entryIndex);
      parser.options.dedupe = true;
      const result = await parser.create();
      if (Array.isArray(result)) created.push(...result);
      else if (result) created.push(result);
    }
    session.created = true;
    session.createdDocuments = created.map(document => document?.uuid ?? document?.id).filter(Boolean);
    return {created, summary: this.summary(session)};
  }
}

export default AgeImporterService;
