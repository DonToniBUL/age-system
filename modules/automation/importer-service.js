import {NpcParser} from "../parsers/npc-parser.js";
import {TalentParser} from "../parsers/talent-parser.js";
import {ageCompendiumIndex, declaredProfiles, profileMatches} from "./compendium-index.js";
import {digestImportSnapshot, normalizeImportName, normalizePdfClipboardText, rankImportCandidates, scoreImportName} from "./import-normalization.js";
import {requireAssistMode} from "./mode.js";

const SYSTEM_ID = "age-system";
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 10;
const INITIAL_SUGGESTION_LIMIT = 6;
const MAX_INPUT_CHARACTERS = 250_000;
const MAX_IMPORT_BLOCKS = 100;
export const IMPORTER_SUPPORTED_ITEM_TYPES = Object.freeze([
  "equipment", "focus", "weapon", "power", "talent", "stunts", "relationship", "honorifics", "membership"
]);
const SUPPORTED_ITEM_TYPES = new Set(IMPORTER_SUPPORTED_ITEM_TYPES);
const TALENT_SUBTYPES = new Set(["talent", "spec"]);
const MIN_TALENT_DEGREE = 0;
const ABSOLUTE_MAX_TALENT_DEGREE = 4;
const MIN_FOCUS_BONUS = -10;
const MAX_FOCUS_BONUS = 10;
const INJURY_PROFILE_ID = "mage-mastery-injury";
const MIN_INJURY_DAMAGE = 1;
const MAX_INJURY_DAMAGE = 40;
const SNAPSHOT_SETTINGS = Object.freeze([
  "activeRuleProfile", "automationMode", "importerV2Enabled", "enableCompendiumIndex",
  "abilitySelection", "primaryAbl", "healthSys", "healthMode", "gameMode", "weaponGroups",
  "DegressChoice", "wealthType", "occupation", "ancestryOpt", "useConviction", "useFatigue",
  "usePowerPoints", "powerFlavor"
]);

const values = collection => {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
};
const matchKey = (name, type) => `${type ?? ""}:${normalizeImportName(name)}`;
const displayConfidence = confidence => Math.round(Math.max(0, Math.min(1, Number(confidence) || 0)) * 100);
const currentUserId = () => String(game.user?.id ?? game.user?._id ?? "anonymous");

function requireImportPermission(kind) {
  const permission = kind === "talent" ? "ITEM_CREATE" : "ACTOR_CREATE";
  let allowed = game.user?.isGM === true;
  try { allowed ||= game.user?.can?.(permission) === true; } catch (_error) { /* Fail closed. */ }
  if (!allowed) throw importerError("AGE_IMPORT_PERMISSION", localized("age-system.IMPORTER.permissionRequired", "You need permission to create this document type."));
}

function importerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function localized(key, fallback) {
  const message = game.i18n?.localize?.(key);
  return typeof message === "string" && message && message !== key ? message : fallback;
}

function safeSetting(key) {
  try { return game.settings.get(SYSTEM_ID, key); } catch (_error) { return undefined; }
}

function settingsSnapshot() {
  return Object.fromEntries(SNAPSHOT_SETTINGS.map(key => [key, safeSetting(key)]).filter(([, value]) => value !== undefined));
}

export function splitImportBlocks(text, {normalize = true} = {}) {
  const source = normalize ? normalizePdfClipboardText(text).text : String(text ?? "");
  return source.split(/^\s*(?:-{3,}|={3,}|\*{3,})\s*$/mu).map(block => block.trim()).filter(Boolean);
}

export function sanitizeImportedDocumentData(source) {
  const data = source?.toObject ? source.toObject() : foundry.utils.deepClone(source ?? {});
  for (const key of ["_id", "id", "uuid", "_stats", "folder", "sort", "ownership", "pack"]) delete data[key];
  return data;
}

async function digestSourceDocument(document) {
  return digestImportSnapshot({documentName: "Item", data: sanitizeImportedDocumentData(document)});
}

function packIdFromUuid(uuid) {
  const parts = String(uuid ?? "").split(".");
  return parts[0] === "Compendium" && parts.length >= 4 ? parts.slice(1, 3).join(".") : "";
}
function sourcePack(document, uuid = document?.uuid) {
  const direct = typeof document?.pack === "string"
    ? document.pack
    : document?.pack?.collection ?? document?.pack?.metadata?.id ?? "";
  const packId = String(direct || packIdFromUuid(uuid));
  const pack = packId
    ? values(game.packs).find(candidate => (candidate.collection ?? candidate.metadata?.id) === packId) ?? null
    : null;
  return {packId, pack};
}
function documentMatchesProfile(document, profile, uuid = document?.uuid) {
  const {pack} = sourcePack(document, uuid);
  return profileMatches({profiles: declaredProfiles(document, pack)}, profile);
}
function worldItemsOfType(type, profile = null) {
  return values(game.items).filter(item => item.type === type && documentMatchesProfile(item, profile));
}
function worldExactMatches(name, type, profile = null) {
  const expected = normalizeImportName(name);
  return worldItemsOfType(type, profile).filter(item => normalizeImportName(item.name) === expected)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)) || String(left.uuid).localeCompare(String(right.uuid)));
}
function sourceLabelForWorld() { return game.i18n.localize("age-system.AUTOMATION.worldItems"); }
function knownTalentSubtype(value) { return TALENT_SUBTYPES.has(value) ? value : null; }
function configuredTalentDegreeMaximum() {
  const configured = globalThis.CONFIG?.ageSystem?.talentDegrees?.inUse;
  if (Array.isArray(configured) && configured.length) {
    return Math.max(MIN_TALENT_DEGREE, Math.min(ABSOLUTE_MAX_TALENT_DEGREE, configured.length - 1));
  }
  return /extra$/iu.test(String(safeSetting("DegressChoice") ?? "")) ? ABSOLUTE_MAX_TALENT_DEGREE : 2;
}
function boundedInteger(value, minimum, maximum) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}
function boundedAbility(value) {
  const ability = String(value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/u.test(ability) ? ability : null;
}
function usesInjuryDamage(profile) {
  return profile === INJURY_PROFILE_ID;
}
function boundedInjuryDamage(value) {
  return boundedInteger(value, MIN_INJURY_DAMAGE, MAX_INJURY_DAMAGE);
}
function injuryCandidate(item, profile) {
  const candidate = candidateItem(item);
  if (!usesInjuryDamage(profile) || candidate.type !== "weapon") return candidate;
  const suggestedDamageInjury = boundedInjuryDamage(item.damageInjurySuggestion ?? item.damageInjury
    ?? item.system?.damageInjury);
  const parsedDamageFormula = String(item.dmg ?? item.system?.damageFormula ?? "").trim();
  return {
    ...candidate,
    injuryRequired: true,
    parsedDamageFormula,
    sourceDamageFormula: null,
    damageFormula: parsedDamageFormula,
    suggestedDamageInjury,
    customDamageInjury: suggestedDamageInjury,
    customDamageInjuryConfirmed: false,
  };
}
function requestedUsage(item) {
  if (item?.type === "talent") {
    const rawDegree = item.system?.degree;
    const maximum = configuredTalentDegreeMaximum();
    const requestedDegree = boundedInteger(rawDegree, MIN_TALENT_DEGREE, maximum);
    if (rawDegree !== "" && rawDegree !== null && rawDegree !== undefined && requestedDegree === null) {
      throw importerError("AGE_IMPORT_TALENT_DEGREE_RANGE",
        `Talent degree must be between ${MIN_TALENT_DEGREE + 1} and ${maximum + 1} for the configured degree set.`);
    }
    return {
      requestedDegree,
      requestedSubtype: knownTalentSubtype(item.system?.type) ?? "talent"
    };
  }
  if (item?.type === "focus") {
    return {
      requestedAbility: boundedAbility(item.system?.useAbl),
      requestedFocusBonus: boundedInteger(item.system?.initialValue, MIN_FOCUS_BONUS, MAX_FOCUS_BONUS)
    };
  }
  return {};
}
function candidateItem(item) {
  return {name: item?.name, type: item?.type, ...requestedUsage(item)};
}
function worldOption(item, confidence = 1) {
  return {uuid: item.uuid, name: item.name, source: sourceLabelForWorld(), sourceKind: "world", confidence,
    subtype: item.type === "talent" ? knownTalentSubtype(item.system?.type) : null,
    confidencePercent: displayConfidence(confidence)};
}
function compendiumOption(entry, confidence = entry.confidence ?? 1) {
  return {uuid: entry.uuid, name: entry.name, source: entry.packLabel ?? entry.pack ?? "", sourceKind: "compendium",
    subtype: entry.type === "talent" ? knownTalentSubtype(entry.subtype) : null,
    confidence, confidencePercent: displayConfidence(confidence)};
}
function uniqueOptions(options) {
  const seen = new Set();
  return options.filter(option => {
    if (!option?.uuid || seen.has(option.uuid)) return false;
    seen.add(option.uuid);
    return true;
  });
}
function sortOptions(options) {
  return uniqueOptions(options).sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0)
    || (left.sourceKind === "world" ? 0 : 1) - (right.sourceKind === "world" ? 0 : 1)
    || String(left.name).localeCompare(String(right.name)) || String(left.uuid).localeCompare(String(right.uuid)));
}
function worldSuggestions(name, type, {profile = null, limit = INITIAL_SUGGESTION_LIMIT, minimum = 0.58} = {}) {
  return rankImportCandidates(name, worldItemsOfType(type, profile).map(item => ({
    uuid: item.uuid,
    name: item.name,
    type: item.type,
    system: {type: item.system?.type}
  })), {limit, minimum}).map(item => worldOption(item, item.confidence));
}
function candidateItems(kind, data, profile = null) {
  if (kind === "talent") return (data.talents ?? []).map(talent => ({name: talent.name, type: "talent",
    requestedSubtype: TALENT_SUBTYPES.has(talent.type) ? talent.type : "talent"}));
  const candidates = [...(data.focus ?? []).map(item => candidateItem({...item, type: item.type ?? "focus"})),
    ...(data.items ?? []).map(item => injuryCandidate(item, profile)),
    ...(data.attacks ?? []).map(item => injuryCandidate({...item, type: "weapon"}, profile))]
    .filter(item => item.name);
  const unsupported = [...new Set(candidates.filter(item => !SUPPORTED_ITEM_TYPES.has(item.type)).map(item => item.type || "unknown"))];
  if (unsupported.length) {
    throw importerError("AGE_IMPORT_ITEM_TYPE_UNSUPPORTED",
      `Parsed Item types are outside the importer's supported set: ${unsupported.join(", ")}.`);
  }
  return candidates;
}
function applyRequestedUsage(data, match, destination) {
  const copy = foundry.utils.deepClone(data);
  if (destination !== "actor") return copy;
  copy.system ??= {};
  if (match.type === "talent") {
    if (match.requestedDegree !== null && match.requestedDegree !== undefined) copy.system.degree = match.requestedDegree;
    if (TALENT_SUBTYPES.has(match.requestedSubtype)) copy.system.type = match.requestedSubtype;
  } else if (match.type === "focus") {
    if (match.requestedAbility) copy.system.useAbl = match.requestedAbility;
    if (match.requestedFocusBonus !== null && match.requestedFocusBonus !== undefined) {
      copy.system.initialValue = match.requestedFocusBonus;
    }
  } else if (match.type === "weapon" && match.injuryRequired === true
      && match.damageInjuryProvenance !== "source") {
    copy.system.damageInjury = match.damageInjury;
  }
  return copy;
}
function selectCustomInjury(match) {
  if (match.injuryRequired !== true) return;
  match.sourceDamageFormula = null;
  match.damageFormula = match.parsedDamageFormula;
  match.damageInjury = boundedInjuryDamage(match.customDamageInjury);
  match.damageInjuryConfirmed = match.customDamageInjuryConfirmed === true;
  match.damageInjuryProvenance = match.damageInjury === match.suggestedDamageInjury && match.damageInjury !== null
    ? "formula"
    : "manual";
}
function selectSourceInjury(match, option) {
  if (match.injuryRequired !== true) return;
  match.sourceDamageFormula = String(option?.sourceDamageFormula ?? "").trim();
  match.damageFormula = match.sourceDamageFormula;
  match.damageInjury = boundedInjuryDamage(option?.damageInjury);
  match.damageInjuryConfirmed = null;
  match.damageInjuryProvenance = "source";
}
function injuryBlockers(match) {
  if (match.injuryRequired !== true) return [];
  if (match.damageInjuryProvenance === "source") {
    return boundedInjuryDamage(match.damageInjury) === null
      ? [{code: "AGE_IMPORT_INJURY_SOURCE_INVALID", message: `The selected source for "${match.name}" does not provide Injury damage between ${MIN_INJURY_DAMAGE} and ${MAX_INJURY_DAMAGE}. Choose another source or create a reviewed custom weapon.`}]
      : [];
  }
  if (boundedInjuryDamage(match.damageInjury) === null) {
    return [{code: "AGE_IMPORT_INJURY_DAMAGE_REQUIRED", message: `Enter Injury damage between ${MIN_INJURY_DAMAGE} and ${MAX_INJURY_DAMAGE} for custom attack "${match.name}".`}];
  }
  if (match.damageInjuryConfirmed !== true) {
    return [{code: "AGE_IMPORT_INJURY_CONFIRMATION_REQUIRED", message: `Confirm the reviewed Injury damage for custom attack "${match.name}".`}];
  }
  return [];
}
function refreshEntryState(entry) {
  entry.matchedCount = entry.matches.filter(match => Boolean(match.selectedUuid)).length;
  entry.unresolvedCount = entry.matches.filter(match => !match.selectedUuid).length;
  entry.blockers = entry.matches.flatMap(injuryBlockers);
}
function presentMatch(match) {
  const requiresResolution = ["ambiguous", "suggested"].includes(match.status) && match.pinned !== true;
  const explicitCreate = match.pinned === true && match.selectionMode === "create";
  const automaticFallback = match.status === "unresolved" && !(match.options ?? []).length;
  return {...match, requiresResolution, createSelected: explicitCreate || automaticFallback,
    confidencePercent: displayConfidence(match.confidence),
    options: (match.options ?? []).map(option => ({...option, selected: option.uuid === match.selectedUuid,
      disabled: option.injuryDamageValid === false,
      label: `${option.name} — ${option.source} (${option.confidencePercent}%)`}))};
}
function documentIdentity(document) {
  return `${document?.documentName ?? document?.constructor?.documentName ?? "Document"}:${document?.uuid ?? document?.id ?? document?._id ?? ""}`;
}
function collectionHas(document) {
  const id = document?.id ?? document?._id;
  const collection = document?.documentName === "Actor" ? game.actors : document?.documentName === "Item" ? game.items : null;
  if (!collection || !id) return true;
  if (typeof collection.has === "function") return collection.has(id);
  if (typeof collection.get === "function") return Boolean(collection.get(id));
  return values(collection).some(candidate => (candidate.id ?? candidate._id) === id);
}

function planSnapshot(session) {
  return {
    kind: session.kind,
    mode: session.mode,
    profile: session.profile,
    settings: session.settingsSnapshot,
    inputDigest: session.inputDigest,
    parsedOutputs: session.entries.map(entry => ({entryIndex: entry.index, parsedDigest: entry.parsedDigest ?? null})),
    selections: session.entries.flatMap(entry => entry.matches.map(match => ({
      entryIndex: entry.index,
      matchIndex: match.matchIndex,
      key: match.key,
      type: match.type,
      selectedUuid: match.selectedUuid ?? null,
      selectionMode: match.selectionMode,
      status: match.status,
      pinned: match.pinned === true,
      searchQuery: match.searchQuery,
      requestedDegree: match.requestedDegree ?? null,
      requestedSubtype: match.requestedSubtype ?? null,
      requestedAbility: match.requestedAbility ?? null,
      requestedFocusBonus: match.requestedFocusBonus ?? null,
      selectedSourceDigest: match.selectedSourceDigest ?? null,
      injuryRequired: match.injuryRequired === true,
      parsedDamageFormula: match.parsedDamageFormula ?? null,
      sourceDamageFormula: match.sourceDamageFormula ?? null,
      damageFormula: match.damageFormula ?? null,
      suggestedDamageInjury: match.suggestedDamageInjury ?? null,
      customDamageInjury: match.customDamageInjury ?? null,
      customDamageInjuryConfirmed: match.customDamageInjuryConfirmed === true,
      damageInjury: match.damageInjury ?? null,
      damageInjuryConfirmed: match.damageInjuryConfirmed ?? null,
      damageInjuryProvenance: match.damageInjuryProvenance ?? null
    })))
  };
}

export class AgeImporterService {
  static sessions = new Map();

  static parserClass(kind) {
    if (kind === "npc") return NpcParser;
    if (kind === "talent") return TalentParser;
    throw importerError("AGE_IMPORT_KIND_UNSUPPORTED", `Unsupported AGE importer kind: ${kind}`);
  }

  static async #compatibleOptions(options, candidate, profile, {exact = false, minimum = null} = {}) {
    return (await Promise.all(uniqueOptions(options).map(async option => {
      try {
        const document = await foundry.utils.fromUuid(option.uuid);
        if (!document || document.documentName !== "Item" || document.type !== candidate.type) return null;
        const {packId, pack} = sourcePack(document, option.uuid);
        if (option.sourceKind === "world" && packId) return null;
        if (option.sourceKind === "compendium" && (!packId || !pack || pack.visible === false)) return null;
        if (!profileMatches({profiles: declaredProfiles(document, pack)}, profile)) return null;
        const resolvedSubtype = document.type === "talent" ? knownTalentSubtype(document.system?.type) : null;
        if (candidate.type === "talent" && candidate.requestedSubtype !== resolvedSubtype) return null;
        const confidence = scoreImportName(candidate.name, document.name);
        if (exact && confidence !== 1) return null;
        if (minimum !== null && confidence < minimum) return null;
        const damageInjury = candidate.injuryRequired === true
          ? boundedInjuryDamage(document.system?.damageInjury)
          : null;
        const sourceDamageFormula = candidate.injuryRequired === true
          ? String(document.system?.damageFormula ?? "").trim()
          : null;
        return {...option, name: String(document.name ?? option.name), subtype: resolvedSubtype, confidence,
          confidencePercent: displayConfidence(confidence), sourceDigest: await digestSourceDocument(document),
          ...(candidate.injuryRequired === true ? {
            damageInjury,
            sourceDamageFormula,
            injuryDamageValid: damageInjury !== null,
            injuryDamageReason: damageInjury === null
              ? `Source Injury damage must be an integer between ${MIN_INJURY_DAMAGE} and ${MAX_INJURY_DAMAGE}.`
              : "",
          } : {})};
      } catch (_error) {
        return null;
      }
    }))).filter(Boolean);
  }

  static async #candidateMatch(candidate, profile, matchIndex) {
    const exactOptions = sortOptions(await this.#compatibleOptions([
      ...worldExactMatches(candidate.name, candidate.type, profile).map(item => worldOption(item)),
      ...ageCompendiumIndex.findExactAll(candidate.name, {documentName: "Item", type: candidate.type, profile})
        .map(entry => compendiumOption(entry, 1))
    ], candidate, profile, {exact: true}));
    const suggestions = sortOptions(await this.#compatibleOptions([
      ...exactOptions,
      ...worldSuggestions(candidate.name, candidate.type, {profile, limit: 50}),
      ...ageCompendiumIndex.suggest(candidate.name, {documentName: "Item", type: candidate.type, profile,
        limit: 50}).map(compendiumOption)
    ], candidate, profile, {minimum: 0.58}))
      .slice(0, Math.min(50, Math.max(INITIAL_SUGGESTION_LIMIT, exactOptions.length)));
    const exact = exactOptions.length === 1 ? exactOptions[0] : null;
    const match = {...candidate, matchIndex, key: matchKey(candidate.name, candidate.type),
      status: exactOptions.length > 1 ? "ambiguous" : exact?.injuryDamageValid === false ? "blocked"
        : exact?.sourceKind ?? (suggestions.length ? "suggested" : "unresolved"),
      selectedUuid: exact?.uuid ?? null, uuid: exact?.uuid ?? null, source: exact?.source ?? "",
      selectedSourceDigest: exact?.sourceDigest ?? null,
      confidence: exact?.confidence ?? suggestions[0]?.confidence ?? 0, searchQuery: candidate.name,
      pinned: false, selectionMode: exact ? "exact" : "create", options: suggestions};
    if (exact) selectSourceInjury(match, exact);
    else selectCustomInjury(match);
    return match;
  }

  static async preview({kind, text, mode} = {}) {
    requireAssistMode();
    requireImportPermission(kind);
    this.expireSessions();
    const rawText = String(text ?? "");
    if (rawText.length > MAX_INPUT_CHARACTERS) {
      throw importerError("AGE_IMPORT_INPUT_TOO_LARGE", `Import text exceeds the ${MAX_INPUT_CHARACTERS.toLocaleString()} character limit.`);
    }
    const normalized = normalizePdfClipboardText(rawText);
    if (normalized.text.length > MAX_INPUT_CHARACTERS) {
      throw importerError("AGE_IMPORT_INPUT_TOO_LARGE", `Import text exceeds the ${MAX_INPUT_CHARACTERS.toLocaleString()} character limit.`);
    }
    const blocks = splitImportBlocks(normalized.text, {normalize: false});
    if (!blocks.length) throw importerError("AGE_IMPORT_NO_TEXT", localized("age-system.AUTOMATION.noImportText", "No import text was provided."));
    if (blocks.length > MAX_IMPORT_BLOCKS) {
      throw importerError("AGE_IMPORT_TOO_MANY_BLOCKS", `Import text contains more than ${MAX_IMPORT_BLOCKS} document blocks.`);
    }
    await ageCompendiumIndex.ensureBuilt();
    const profile = safeSetting("activeRuleProfile");
    const settings = settingsSnapshot();
    const Parser = this.parserClass(kind);
    const parsers = [];
    const entries = [];
    const errors = [];
    for (let index = 0; index < blocks.length; index++) {
      try {
        const parser = new Parser(blocks[index], mode, {create: false, profileId: profile});
        const data = await parser.ready;
        const candidates = candidateItems(kind, data, profile);
        const matches = [];
        for (let matchIndex = 0; matchIndex < candidates.length; matchIndex++) {
          matches.push(await this.#candidateMatch(candidates[matchIndex], profile, matchIndex));
        }
        const name = kind === "npc" ? data.name : data.talents?.[0]?.name;
        const parsedDigest = await digestImportSnapshot({kind, entryIndex: index, parsed: data});
        const entry = {index, name: name || `${kind} ${index + 1}`, parsed: data, parsedDigest, itemCount: candidates.length,
          matchedCount: 0, unresolvedCount: 0, matches, blockers: []};
        refreshEntryState(entry);
        entries.push(entry);
        parsers.push({parser, entryIndex: index});
      } catch (error) {
        errors.push({index, name: `${kind} ${index + 1}`, message: error?.message ?? String(error)});
      }
    }
    const now = Date.now();
    const id = foundry.utils.randomID?.(16) ?? `${now}-${Math.random()}`;
    const digestInput = {kind, mode, text: normalized.text};
    const inputDigest = await digestImportSnapshot(digestInput);
    const snapshotDigest = await digestImportSnapshot({...digestInput, profile, settings});
    const session = {id, kind, mode, profile, settingsSnapshot: settings, normalizedInput: normalized.text, blocks,
      inputDigest, snapshotDigest, parsers, entries, errors, created: false, committing: false, state: "preview",
      ownerUserId: currentUserId(), timestamp: now, expiresAt: now + SESSION_TTL_MS,
      normalization: {changed: normalized.changed, changes: normalized.changes, text: normalized.text}};
    session.planDigest = await digestImportSnapshot(planSnapshot(session));
    this.sessions.set(id, session);
    while (this.sessions.size > MAX_SESSIONS) {
      const removable = Array.from(this.sessions.values()).find(candidate => !candidate.committing);
      if (!removable) break;
      this.sessions.delete(removable.id);
    }
    return this.summary(session);
  }

  static #session(sessionId, {allowCreated = false} = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw importerError("AGE_IMPORT_PREVIEW_EXPIRED", localized("age-system.AUTOMATION.importPreviewExpired", "The import preview expired. Create a new preview."));
    if (session.ownerUserId !== currentUserId()) throw importerError("AGE_IMPORT_SESSION_OWNER", "This import preview belongs to another user.");
    if (Date.now() >= session.expiresAt) {
      this.sessions.delete(sessionId);
      throw importerError("AGE_IMPORT_PREVIEW_EXPIRED", localized("age-system.AUTOMATION.importPreviewExpired", "The import preview expired. Create a new preview."));
    }
    if (!allowCreated && session.created) throw importerError("AGE_IMPORT_ALREADY_CREATED", localized("age-system.AUTOMATION.importAlreadyCreated", "This import preview has already been committed."));
    return session;
  }

  static #match(session, entryIndex, matchIndex) {
    const entry = session.entries.find(candidate => candidate.index === Number(entryIndex));
    const match = entry?.matches?.find(candidate => candidate.matchIndex === Number(matchIndex));
    if (!entry || !match) throw importerError("AGE_IMPORT_MATCH_STALE", "The selected import candidate is no longer available.");
    return {entry, match};
  }

  static async searchMatch(sessionId, {entryIndex, matchIndex, query} = {}) {
    requireAssistMode();
    const session = this.#session(sessionId);
    requireImportPermission(session.kind);
    if (session.committing) throw importerError("AGE_IMPORT_COMMIT_IN_FLIGHT", "Import commit is already in progress.");
    const {match} = this.#match(session, entryIndex, matchIndex);
    const searchQuery = String(query ?? "").trim() || match.name;
    await ageCompendiumIndex.ensureBuilt();
    const selected = match.selectedUuid ? match.options.find(option => option.uuid === match.selectedUuid) : null;
    match.searchQuery = searchQuery;
    const searchCandidate = {...match, name: searchQuery};
    const ranked = sortOptions(await this.#compatibleOptions([
      ...worldSuggestions(searchQuery, match.type, {profile: session.profile, limit: 50, minimum: 0.35}),
      ...ageCompendiumIndex.suggest(searchQuery, {documentName: "Item", type: match.type, profile: session.profile,
        limit: 50, minimum: 0.35}).map(compendiumOption)
    ], searchCandidate, session.profile, {minimum: 0.35})).slice(0, 12);
    match.options = selected ? uniqueOptions([selected, ...ranked]).slice(0, 12) : ranked;
    if (!match.selectedUuid && match.options.length) match.status = "suggested";
    this.#refreshEntryCounts(session);
    session.planDigest = await digestImportSnapshot(planSnapshot(session));
    return this.summary(session);
  }

  static async setMatchResolution(sessionId, {entryIndex, matchIndex, uuid = null} = {}) {
    requireAssistMode();
    const session = this.#session(sessionId);
    requireImportPermission(session.kind);
    if (session.committing) throw importerError("AGE_IMPORT_COMMIT_IN_FLIGHT", "Import commit is already in progress.");
    const {match} = this.#match(session, entryIndex, matchIndex);
    if (!uuid || uuid === "create") {
      Object.assign(match, {selectedUuid: null, uuid: null, source: "", pinned: true, selectionMode: "create",
        selectedSourceDigest: null, status: match.options.length ? "suggested" : "unresolved"});
      selectCustomInjury(match);
    } else {
      const option = match.options.find(candidate => candidate.uuid === uuid);
      if (!option) throw importerError("AGE_IMPORT_SELECTION_UNVERIFIED", "Select an Item from the verified search results.");
      if (option.injuryDamageValid === false) {
        throw importerError("AGE_IMPORT_INJURY_SOURCE_INVALID", option.injuryDamageReason
          || `The selected source must provide Injury damage between ${MIN_INJURY_DAMAGE} and ${MAX_INJURY_DAMAGE}.`);
      }
      await this.#validateSelectedDocument(match, option.uuid, session.profile);
      Object.assign(match, {selectedUuid: option.uuid, uuid: option.uuid, source: option.source,
        selectedSourceDigest: option.sourceDigest, confidence: option.confidence, status: option.sourceKind,
        pinned: true, selectionMode: "source"});
      selectSourceInjury(match, option);
    }
    this.#refreshEntryCounts(session);
    session.planDigest = await digestImportSnapshot(planSnapshot(session));
    return this.summary(session);
  }

  static async setDroppedItemResolution(sessionId, {entryIndex, matchIndex, uuid} = {}) {
    requireAssistMode();
    const session = this.#session(sessionId);
    requireImportPermission(session.kind);
    if (session.committing) throw importerError("AGE_IMPORT_COMMIT_IN_FLIGHT", "Import commit is already in progress.");
    const {match} = this.#match(session, entryIndex, matchIndex);
    const sourceUuid = String(uuid ?? "").trim();
    if (!sourceUuid || sourceUuid.length > 1_024) throw importerError("AGE_IMPORT_DROP_INVALID", "Drop a valid Item from the Items directory or a visible compendium.");
    const document = await foundry.utils.fromUuid(sourceUuid);
    if (!document || document.documentName !== "Item" || document.type !== match.type) {
      throw importerError("AGE_IMPORT_DROP_TYPE", `Drop a ${match.type} Item for "${match.name}".`);
    }
    if (match.type === "talent" && match.requestedSubtype
        && knownTalentSubtype(document.system?.type) !== match.requestedSubtype) {
      throw importerError("AGE_IMPORT_DROP_SUBTYPE", `Drop a ${match.requestedSubtype === "spec" ? "Specialization" : "Talent"} Item for "${match.name}".`);
    }
    const {packId, pack} = sourcePack(document, sourceUuid);
    if (!packId && document.parent) {
      throw importerError("AGE_IMPORT_DROP_EMBEDDED", "Drop a world Item or compendium Item, not an Item embedded in another Actor.");
    }
    if (packId && (!pack || pack.visible === false)) {
      throw importerError("AGE_IMPORT_DROP_HIDDEN", "The dropped compendium Item is not visible to this user.");
    }
    if (!profileMatches({profiles: declaredProfiles(document, pack)}, session.profile)) {
      throw importerError("AGE_IMPORT_DROP_PROFILE", "The dropped Item declares a different AGE rules profile.");
    }
    const damageInjury = match.injuryRequired === true
      ? boundedInjuryDamage(document.system?.damageInjury)
      : null;
    const sourceDamageFormula = match.injuryRequired === true
      ? String(document.system?.damageFormula ?? "").trim()
      : null;
    if (match.injuryRequired === true && damageInjury === null) {
      throw importerError("AGE_IMPORT_INJURY_SOURCE_INVALID",
        `The dropped weapon must provide Injury damage between ${MIN_INJURY_DAMAGE} and ${MAX_INJURY_DAMAGE}.`);
    }
    const confidence = scoreImportName(match.name, document.name);
    const option = {
      uuid: String(document.uuid ?? sourceUuid),
      name: String(document.name ?? match.name),
      source: packId ? String(pack.metadata?.label ?? pack.title ?? packId) : sourceLabelForWorld(),
      sourceKind: packId ? "compendium" : "world",
      subtype: document.type === "talent" ? knownTalentSubtype(document.system?.type) : null,
      verifiedBy: "drop",
      confidence,
      confidencePercent: displayConfidence(confidence),
      sourceDigest: await digestSourceDocument(document),
      ...(match.injuryRequired === true ? {
        damageInjury,
        sourceDamageFormula,
        injuryDamageValid: true,
        injuryDamageReason: "",
      } : {}),
    };
    match.options = uniqueOptions([option, ...(match.options ?? [])]).slice(0, 50);
    Object.assign(match, {
      selectedUuid: option.uuid,
      uuid: option.uuid,
      source: option.source,
      selectedSourceDigest: option.sourceDigest,
      confidence: option.confidence,
      status: option.sourceKind,
      pinned: true,
      selectionMode: "source",
    });
    selectSourceInjury(match, option);
    this.#refreshEntryCounts(session);
    session.planDigest = await digestImportSnapshot(planSnapshot(session));
    return this.summary(session);
  }

  static async setInjuryDamageResolution(sessionId, {entryIndex, matchIndex, damageInjury, confirmed = false} = {}) {
    requireAssistMode();
    const session = this.#session(sessionId);
    requireImportPermission(session.kind);
    if (session.committing) throw importerError("AGE_IMPORT_COMMIT_IN_FLIGHT", "Import commit is already in progress.");
    const {match} = this.#match(session, entryIndex, matchIndex);
    if (match.injuryRequired !== true || match.type !== "weapon") {
      throw importerError("AGE_IMPORT_INJURY_NOT_APPLICABLE", "This parsed Item does not use Modern AGE Injury damage.");
    }
    if (match.selectedUuid || match.damageInjuryProvenance === "source") {
      throw importerError("AGE_IMPORT_INJURY_SOURCE_LOCKED", "A reused source keeps its signed Injury damage. Choose Create new from parsed text to enter a custom value.");
    }
    match.customDamageInjury = boundedInjuryDamage(damageInjury);
    match.customDamageInjuryConfirmed = confirmed === true && match.customDamageInjury !== null;
    selectCustomInjury(match);
    this.#refreshEntryCounts(session);
    session.planDigest = await digestImportSnapshot(planSnapshot(session));
    return this.summary(session);
  }

  static #refreshEntryCounts(session) {
    for (const entry of session.entries) refreshEntryState(entry);
  }

  static summary(session) {
    return foundry.utils.deepClone({id: session.id, kind: session.kind, mode: session.mode, profile: session.profile,
      settingsSnapshot: session.settingsSnapshot, inputDigest: session.inputDigest, snapshotDigest: session.snapshotDigest,
      planDigest: session.planDigest,
      expiresAt: session.expiresAt, committing: session.committing, state: session.state,
      normalization: session.normalization, entries: session.entries.map(entry => ({...entry, matches: entry.matches.map(presentMatch)})),
      errors: session.errors, validCount: session.parsers.length, errorCount: session.errors.length, created: session.created});
  }

  static expireSessions(now = Date.now()) {
    let expired = 0;
    for (const [id, session] of this.sessions) {
      if (!session.committing && now >= session.expiresAt) { this.sessions.delete(id); expired++; }
    }
    return expired;
  }

  static cancel(sessionId) {
    const session = this.#session(sessionId, {allowCreated: true});
    requireImportPermission(session.kind);
    if (session.committing) throw importerError("AGE_IMPORT_COMMIT_IN_FLIGHT", "Import commit is already in progress.");
    session.state = "cancelled";
    this.sessions.delete(sessionId);
    return true;
  }

  static async resolveItem(parsed, {destination = "actor"} = {}) {
    const candidate = candidateItem(parsed);
    const profile = safeSetting("activeRuleProfile");
    const world = await this.#compatibleOptions(
      worldExactMatches(parsed.name, parsed.type, profile).map(item => worldOption(item)), candidate, profile, {exact: true});
    await ageCompendiumIndex.ensureBuilt();
    const compendium = ageCompendiumIndex.findExactAll(parsed.name, {documentName: "Item", type: parsed.type, profile})
      .map(compendiumOption);
    const compatibleCompendium = await this.#compatibleOptions(compendium, candidate, profile, {exact: true});
    const matches = [...world, ...compatibleCompendium];
    if (matches.length !== 1) return null;
    const selected = {...candidate, selectedSourceDigest: matches[0].sourceDigest};
    return this.#resolvedDocument(matches[0].uuid, destination, selected, profile);
  }

  static async #resolvedDocument(uuid, destination, match = {}, profile = null) {
    const document = await foundry.utils.fromUuid(uuid);
    if (!document || document.documentName !== "Item" || (match.type && document.type !== match.type)) return null;
    if (!documentMatchesProfile(document, profile, uuid)) {
      throw importerError("AGE_IMPORT_SELECTION_STALE", `The selected source for "${match.name}" no longer matches the active AGE profile.`);
    }
    if (match.selectedSourceDigest && await digestSourceDocument(document) !== match.selectedSourceDigest) {
      throw importerError("AGE_IMPORT_SOURCE_STALE", `The selected source for "${match.name}" changed after review. Refresh the preview.`);
    }
    if (match.injuryRequired === true) {
      const sourceDamageInjury = boundedInjuryDamage(document.system?.damageInjury);
      const sourceDamageFormula = String(document.system?.damageFormula ?? "").trim();
      if (sourceDamageInjury === null || match.damageInjuryProvenance !== "source"
          || match.damageInjury !== sourceDamageInjury
          || match.sourceDamageFormula !== sourceDamageFormula
          || match.damageFormula !== sourceDamageFormula) {
        throw importerError("AGE_IMPORT_SOURCE_STALE",
          `The selected source Injury damage for "${match.name}" no longer matches the signed review.`);
      }
    }
    const isWorldItem = !sourcePack(document, uuid).packId;
    if (destination === "world" && isWorldItem) return {existing: document, uuid, source: "world"};
    return {data: applyRequestedUsage(sanitizeImportedDocumentData(document), match, destination), uuid,
      source: isWorldItem ? "world" : "compendium"};
  }

  static async #validateSelectedDocument(match, uuid, profile) {
    const option = match.options.find(candidate => candidate.uuid === uuid);
    if (!option) throw importerError("AGE_IMPORT_SELECTION_UNVERIFIED", `The selected source for "${match.name}" is not pinned to this preview.`);
    if (!option.sourceDigest || (match.selectedUuid === uuid && match.selectedSourceDigest !== option.sourceDigest)) {
      throw importerError("AGE_IMPORT_SELECTION_UNVERIFIED", `The selected source content for "${match.name}" is not pinned to this preview.`);
    }
    const document = await foundry.utils.fromUuid(uuid);
    if (!document || document.documentName !== "Item" || document.type !== match.type) {
      throw importerError("AGE_IMPORT_SELECTION_STALE", `The selected source for "${match.name}" is no longer an available ${match.type} Item. Review the preview again.`);
    }
    if (match.type === "talent" && match.requestedSubtype
        && knownTalentSubtype(document.system?.type) !== match.requestedSubtype) {
      throw importerError("AGE_IMPORT_SELECTION_STALE", `The selected source for "${match.name}" no longer has the requested Talent subtype.`);
    }
    const {packId, pack} = sourcePack(document, uuid);
    if (option.sourceKind === "world" && packId) throw importerError("AGE_IMPORT_SELECTION_STALE", `The selected world Item for "${match.name}" changed source.`);
    if (option.sourceKind === "compendium") {
      const indexed = option.verifiedBy === "drop"
        || ageCompendiumIndex.entries.some(entry => entry.uuid === uuid && entry.type === match.type);
      if (!indexed || !pack || pack.visible === false) throw importerError("AGE_IMPORT_SELECTION_STALE", `The selected compendium Item for "${match.name}" is no longer available.`);
    }
    if (!profileMatches({profiles: declaredProfiles(document, pack)}, profile)) {
      throw importerError("AGE_IMPORT_SELECTION_STALE", `The selected source for "${match.name}" no longer matches the active AGE profile.`);
    }
    if (match.injuryRequired === true) {
      const sourceDamageInjury = boundedInjuryDamage(document.system?.damageInjury);
      const sourceDamageFormula = String(document.system?.damageFormula ?? "").trim();
      if (sourceDamageInjury === null) {
        throw importerError("AGE_IMPORT_INJURY_SOURCE_INVALID",
          `The selected source for "${match.name}" must provide Injury damage between ${MIN_INJURY_DAMAGE} and ${MAX_INJURY_DAMAGE}.`);
      }
      if (match.selectedUuid === uuid
          && (match.damageInjuryProvenance !== "source" || match.damageInjury !== sourceDamageInjury
            || match.sourceDamageFormula !== sourceDamageFormula || match.damageFormula !== sourceDamageFormula)) {
        throw importerError("AGE_IMPORT_PLAN_STALE",
          `The signed Injury damage for reused source "${match.name}" no longer matches the reviewed source.`);
      }
    }
    if (await digestSourceDocument(document) !== option.sourceDigest) {
      throw importerError("AGE_IMPORT_SOURCE_STALE", `The selected source for "${match.name}" changed after review. Refresh the preview.`);
    }
    return document;
  }

  static async #validateSnapshot(session, expected = {}) {
    const inputDigest = await digestImportSnapshot({kind: session.kind, mode: session.mode, text: session.normalizedInput});
    if (inputDigest !== session.inputDigest || (expected.inputDigest && expected.inputDigest !== session.inputDigest)) {
      throw importerError("AGE_IMPORT_INPUT_STALE", "The import input changed after preview. Create a new preview.");
    }
    const currentSettings = settingsSnapshot();
    const profile = safeSetting("activeRuleProfile");
    const snapshotDigest = await digestImportSnapshot({kind: session.kind, mode: session.mode, text: session.normalizedInput,
      profile, settings: currentSettings});
    if (snapshotDigest !== session.snapshotDigest || (expected.snapshotDigest && expected.snapshotDigest !== session.snapshotDigest)) {
      throw importerError("AGE_IMPORT_SETTINGS_STALE", "AGE profile or settings changed after preview. Create a new preview.");
    }
    const planDigest = await digestImportSnapshot(planSnapshot(session));
    if (planDigest !== session.planDigest || (expected.planDigest && expected.planDigest !== session.planDigest)) {
      throw importerError("AGE_IMPORT_PLAN_STALE", "Import selections changed after preview. Review the import plan again.");
    }
  }

  static async #validateParsedOutput(session, parserRecord) {
    const entry = session.entries.find(candidate => candidate.index === Number(parserRecord?.entryIndex));
    if (!entry?.parsedDigest) {
      throw importerError("AGE_IMPORT_PARSED_STALE", "The signed parsed-output digest is missing. Create a new preview.");
    }
    const parser = parserRecord?.parser;
    const parserData = parser?.data ?? await parser?.ready;
    const [reviewDigest, parserDigest] = await Promise.all([
      digestImportSnapshot({kind: session.kind, entryIndex: entry.index, parsed: entry.parsed}),
      digestImportSnapshot({kind: session.kind, entryIndex: entry.index, parsed: parserData}),
    ]);
    if (reviewDigest !== entry.parsedDigest || parserDigest !== entry.parsedDigest) {
      throw importerError("AGE_IMPORT_PARSED_STALE",
        `Parsed output for entry ${entry.index + 1} changed after review. Create a new preview.`);
    }
  }

  static async #validateParsedOutputs(session) {
    for (const parserRecord of session.parsers) await this.#validateParsedOutput(session, parserRecord);
  }

  static async #validateSelections(session) {
    for (const match of session.entries.flatMap(entry => entry.matches)) {
      if (["ambiguous", "suggested"].includes(match.status) && !match.pinned) {
        throw importerError("AGE_IMPORT_AMBIGUOUS_SELECTION", `Choose a source or explicitly create "${match.name}" before committing.`);
      }
      if (match.selectedUuid) {
        await this.#validateSelectedDocument(match, match.selectedUuid, session.profile);
      } else if (match.injuryRequired === true) {
        if (boundedInjuryDamage(match.damageInjury) === null) {
          throw importerError("AGE_IMPORT_INJURY_DAMAGE_REQUIRED",
            `Enter Injury damage between ${MIN_INJURY_DAMAGE} and ${MAX_INJURY_DAMAGE} for custom attack "${match.name}".`);
        }
        if (match.damageInjuryConfirmed !== true) {
          throw importerError("AGE_IMPORT_INJURY_CONFIRMATION_REQUIRED",
            `Confirm the reviewed Injury damage for custom attack "${match.name}".`);
        }
        if (!match.damageFormula) {
          throw importerError("AGE_IMPORT_INJURY_FORMULA_STALE", `The reviewed damage formula for "${match.name}" is missing.`);
        }
      }
    }
  }

  static #sessionResolver(session, entryIndex) {
    const entry = session.entries.find(candidate => candidate.index === Number(entryIndex));
    const queues = new Map();
    for (const match of entry?.matches ?? []) {
      const queue = queues.get(match.key) ?? [];
      queue.push(match);
      queues.set(match.key, queue);
    }
    const cursors = new Map();
    return async (parsed, {destination = "actor"} = {}) => {
      const key = matchKey(parsed.name, parsed.type);
      const index = cursors.get(key) ?? 0;
      const match = queues.get(key)?.[index];
      cursors.set(key, index + 1);
      if (!match) throw importerError("AGE_IMPORT_INPUT_STALE", `Parsed Item "${parsed.name}" was not present in the signed preview.`);
      if (match.injuryRequired === true) {
        const currentFormula = String(parsed.system?.damageFormula ?? "").trim();
        if (currentFormula !== match.parsedDamageFormula) {
          throw importerError("AGE_IMPORT_INPUT_STALE",
            `The parsed damage formula for "${match.name}" changed after the signed review.`);
        }
      }
      if (!match.selectedUuid) return {data: applyRequestedUsage(parsed, match, destination), source: "parsed"};
      const resolved = await this.#resolvedDocument(match.selectedUuid, destination, match, session.profile);
      if (!resolved) throw importerError("AGE_IMPORT_SELECTION_STALE", `The selected source for "${match.name}" is no longer available.`);
      return resolved;
    };
  }

  static async #rollback(documents) {
    const failures = [];
    for (const document of [...documents].reverse()) {
      try {
        if (!collectionHas(document)) continue;
        if (typeof document.delete !== "function") throw new Error("Document does not expose delete().");
        await document.delete();
      } catch (error) { failures.push(`${documentIdentity(document)}: ${error?.message ?? String(error)}`); }
    }
    return failures;
  }

  static async commit(sessionId, expectedDigests = {}) {
    requireAssistMode();
    const session = this.#session(sessionId);
    requireImportPermission(session.kind);
    if (session.committing) throw importerError("AGE_IMPORT_COMMIT_IN_FLIGHT", "Import commit is already in progress.");
    if (session.errors.length || !session.parsers.length) {
      throw importerError("AGE_IMPORT_PREVIEW_INVALID", "The import preview contains errors or no valid entries. Correct the input and create a new preview.");
    }
    session.committing = true;
    session.state = "committing";
    const created = [];
    const tracked = new Map();
    const baseline = new Set([...values(game.actors), ...values(game.items)].map(documentIdentity));
    const track = document => {
      const identity = documentIdentity(document);
      if (document && !baseline.has(identity)) tracked.set(identity, document);
    };
    try {
      await this.#validateSnapshot(session, expectedDigests ?? {});
      await this.#validateSelections(session);
      await this.#validateParsedOutputs(session);
      for (const {parser, entryIndex} of session.parsers) {
        await this.#validateParsedOutput(session, {parser, entryIndex});
        parser.options.resolveItem = this.#sessionResolver(session, entryIndex);
        parser.options.onCreatedDocument = track;
        parser.options.onDeletedDocument = document => tracked.delete(documentIdentity(document));
        parser.options.dedupe = true;
        parser.options.strictResolution = true;
        const result = await parser.create();
        const documents = Array.isArray(result) ? result : result ? [result] : [];
        for (const document of documents) { created.push(document); track(document); }
      }
      session.created = true;
      session.committing = false;
      session.state = "created";
      session.createdDocuments = Array.from(tracked.keys());
      return {created, summary: this.summary(session)};
    } catch (error) {
      const rollbackFailures = await this.#rollback(Array.from(tracked.values()));
      session.committing = false;
      session.state = rollbackFailures.length ? "failed" : "preview";
      if (rollbackFailures.length) {
        const failure = importerError("AGE_IMPORT_ROLLBACK_FAILED", `Import failed and cleanup was incomplete: ${rollbackFailures.join("; ")}`);
        failure.cause = error;
        throw failure;
      }
      throw error;
    }
  }
}

export default AgeImporterService;
