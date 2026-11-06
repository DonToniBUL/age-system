import {canonicalClone, canonicalJson, digestCanonicalJson} from "../progression/canonical.js";
import {compileNpcStudioPlan, sameNpcStudioSources} from "./compiler.js";
import {
  AGE_NPC_STUDIO_ITEM_TYPES,
  assertNpcStudioSafeInput,
  assertNpcStudioDraftV1,
  npcStudioError,
} from "./contracts.js";
import {createNpcStudioDraft} from "./draft-factories.js";
import {AgeNpcStudioExecutor} from "./executor.js";
import {
  activeNpcStudioProfileId,
  npcStudioProfileCapabilities,
  npcStudioProfileSnapshot,
} from "./profile-adapter.js";
import {getNpcStudioReceipt} from "./receipts.js";
import {AgeNpcStudioSessionStore} from "./session-store.js";

const SYSTEM_ID = "age-system";
const ITEM_TYPES = new Set(AGE_NPC_STUDIO_ITEM_TYPES);
const CREATE_DRAFT_KEYS = new Set(["origin", "profileId", "text", "parserMode", "actorUuid"]);
const SHA256 = /^[0-9a-f]{64}$/u;

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePermission(environment) {
  const user = environment?.game?.user;
  let canCreate = false;
  try { canCreate = user?.can?.("ACTOR_CREATE") === true; } catch (_error) { /* Fail closed. */ }
  if (user?.isGM !== true || !canCreate) {
    throw npcStudioError("AGE_NPC_STUDIO_PERMISSION", "NPC Studio requires a Game Master with Actor creation permission.");
  }
  return user;
}

function defaultIdFactory(environment) {
  return () => {
    const id = environment?.foundry?.utils?.randomID?.(16)
      ?? environment?.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 16)
      ?? globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 16);
    if (!id) throw npcStudioError("AGE_NPC_STUDIO_ID", "NPC Studio could not allocate a stable id.");
    return id;
  };
}

function assertDraftOptions(options) {
  assertNpcStudioSafeInput(options);
  if (!plainObject(options)) throw npcStudioError("AGE_NPC_STUDIO_INPUT_OBJECT", "NPC Studio draft options must be an object.");
  for (const key of Object.keys(options)) {
    if (!CREATE_DRAFT_KEYS.has(key)) throw npcStudioError("AGE_NPC_STUDIO_FIELD_UNKNOWN", `NPC Studio draft option "${key}" is not accepted.`);
  }
}

function normalizeSearch(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").trim().toLowerCase();
}

function score(name, query) {
  const candidate = normalizeSearch(name);
  if (!query) return 1;
  if (candidate === query) return 100;
  if (candidate.startsWith(query)) return 80;
  if (candidate.includes(query)) return 60;
  const words = query.split(/\s+/u).filter(Boolean);
  return words.length && words.every(word => candidate.includes(word)) ? 40 + words.length : 0;
}

function boundedLimit(value) {
  return Math.max(1, Math.min(100, Math.trunc(Number(value) || 50)));
}

function packId(pack) {
  return pack?.collection ?? pack?.metadata?.id ?? null;
}

function packLabel(pack) {
  return pack?.metadata?.label ?? pack?.title ?? packId(pack) ?? "Compendium";
}

function itemProfiles(entry, pack) {
  const flags = entry?.flags ?? entry?._source?.flags;
  const value = flags?.[SYSTEM_ID]?.profile
    ?? flags?.[SYSTEM_ID]?.automation?.profile
    ?? pack?.metadata?.flags?.[SYSTEM_ID]?.profile;
  if (!value) return [];
  return (Array.isArray(value) ? value : String(value).split(/[;,]/u)).map(normalizeSearch).filter(Boolean);
}

function itemSubtype(entry) {
  if (String(entry?.type ?? "") !== "talent") return "";
  const system = entry?.system ?? entry?._source?.system ?? {};
  return String(system.type ?? "talent") === "spec" ? "spec" : "talent";
}

function itemUsage(entry) {
  const system = entry?.system ?? entry?._source?.system ?? {};
  const degree = Number(system.degree);
  const bonus = Number(system.initialValue);
  return {
    subtype: itemSubtype(entry),
    degree: Number.isInteger(degree) && degree >= 0 && degree <= 4 ? degree : 0,
    ability: String(system.useAbl ?? ""),
    bonus: Number.isFinite(bonus) ? bonus : 2,
  };
}

function profileMatches(profiles, profileId) {
  if (!profiles.length) return true;
  const selected = normalizeSearch(profileId);
  if (profiles.includes(selected)) return true;
  return profiles.includes(selected.split("-")[0]);
}

function rawNpcStudioReceipt(actorOrSource) {
  const source = actorOrSource?._source ?? actorOrSource;
  return source?.flags?.[SYSTEM_ID]?.npcStudio?.creationReceipt
    ?? actorOrSource?.flags?.[SYSTEM_ID]?.npcStudio?.creationReceipt
    ?? null;
}

async function packEntries(pack, fields) {
  if (pack?.visible === false || !(pack?.getIndex instanceof Function)) return {entries: [], projected: false};
  try { return {entries: values(await pack.getIndex({fields})), projected: true}; }
  catch (_fieldError) {
    // Some older/module-provided Compendium implementations reject requested
    // index fields even though their default index is usable. Retry that
    // supported path before treating the pack as unavailable.
    try { return {entries: values(await pack.getIndex()), projected: false}; }
    catch (_indexError) { return {entries: [], projected: false}; }
  }
}

async function hydratePackEntry(pack, entry, environment) {
  const id = entry?._id ?? entry?.id;
  if (!id) return null;
  if (pack?.getDocument instanceof Function) {
    try {
      const document = await pack.getDocument(id);
      if (document) return document;
    } catch (_error) { /* Fall through to UUID resolution. */ }
  }
  const collection = packId(pack);
  const uuids = [entry.uuid, `Compendium.${collection}.Item.${id}`, `Compendium.${collection}.${id}`].filter(Boolean);
  for (const uuid of uuids) {
    try {
      const document = await resolveUuid(uuid, environment);
      if (document) return document;
    } catch (_error) { /* Try the remaining compatible UUID shape. */ }
  }
  return null;
}

async function resolveUuid(uuid, environment) {
  const resolver = environment?.foundry?.utils?.fromUuid ?? environment?.fromUuid ?? globalThis.fromUuid;
  if (!(resolver instanceof Function)) throw npcStudioError("AGE_NPC_STUDIO_UUID_RESOLVER", "Foundry UUID resolution is unavailable.");
  return resolver.call(environment?.foundry?.utils ?? environment, uuid);
}

function npcStudioReview(draft, profile, plan) {
  const defense = (draft.abilities.dex?.value ?? 0) + draft.combat.defenseBase + draft.combat.defenseGameModeBonus;
  const speed = (draft.abilities.dex?.value ?? 0) + draft.combat.speedBase;
  const toughness = (draft.abilities.cons?.value ?? 0) + draft.combat.toughnessGameModeBonus;
  const draftItems = new Map(draft.items.map(item => [item.entryId, item]));
  const items = values(plan?.actorSource?.items).map(itemSource => {
    const binding = itemSource?.flags?.[SYSTEM_ID]?.npcStudio ?? {};
    const entry = draftItems.get(binding.entryId);
    const type = String(itemSource?.type ?? entry?.type ?? "");
    const system = itemSource?.system ?? {};
    return {
      entryId: binding.entryId ?? entry?.entryId ?? "",
      name: String(itemSource?.name ?? entry?.name ?? ""),
      type,
      origin: binding.origin ?? entry?.origin ?? "custom",
      img: itemSource?.img ?? entry?.img ?? null,
      sourceUuid: binding.sourceUuid ?? entry?.sourceUuid ?? null,
      damageFormula: type === "weapon" ? String(system.damageFormula ?? "") : null,
      damageInjury: type === "weapon" ? (system.damageInjury ?? null) : null,
      damageInjuryConfirmed: type === "weapon" && entry?.origin === "custom"
        ? entry.custom?.damageInjuryConfirmed === true
        : null,
      custom: entry?.custom ?? null,
      resolution: entry?.resolution ?? null,
    };
  });
  return canonicalClone({
    identity: draft.identity,
    abilities: profile.abilityIds.map(id => ({id, value: draft.abilities[id]?.value ?? 0, primary: draft.abilities[id]?.primary === true})),
    statistics: {
      defense,
      defenseBase: draft.combat.defenseBase,
      defenseGameModeBonus: draft.combat.defenseGameModeBonus,
      speed,
      speedBase: draft.combat.speedBase,
      healthCurrent: draft.combat.healthValue,
      healthMaximum: draft.combat.healthSet,
      toughness,
      toughnessGameModeBonus: draft.combat.toughnessGameModeBonus,
      impactArmor: draft.combat.impactArmor,
      ballisticArmor: draft.combat.ballisticArmor,
      initiativeModifier: draft.combat.initiativeMod,
      attackModifier: draft.combat.attackMod,
      testModifier: draft.combat.testMod,
      damageModifier: draft.combat.damageMod,
    },
    resources: draft.resources,
    token: draft.token,
    notes: draft.notes,
    items,
  });
}

export class AgeNpcStudioService {
  #environment;
  #clock;
  #idFactory;
  #Parser;
  #sessions;
  #executor;
  #receipts = new Map();

  constructor({environment = globalThis, clock = () => Date.now(), idFactory = null, Parser = null, sessionTtlMs} = {}) {
    this.#environment = environment;
    this.#clock = clock;
    this.#idFactory = idFactory ?? defaultIdFactory(environment);
    this.#Parser = Parser;
    const storeOptions = {clock, idFactory: prefix => this.#idFactory(prefix)};
    if (sessionTtlMs !== undefined) storeOptions.ttlMs = sessionTtlMs;
    this.#sessions = new AgeNpcStudioSessionStore(storeOptions);
    this.#executor = new AgeNpcStudioExecutor({environment, clock});
  }

  static createDraft(options) { return ageNpcStudioService.createDraft(options); }
  static preview(draft) { return ageNpcStudioService.preview(draft); }
  static searchActors(query, options) { return ageNpcStudioService.searchActors(query, options); }
  static searchItems(query, options) { return ageNpcStudioService.searchItems(query, options); }
  static commit(previewId, expected) { return ageNpcStudioService.commit(previewId, expected); }
  static cancel(previewId) { return ageNpcStudioService.cancel(previewId); }
  static receipt(receiptId) { return ageNpcStudioService.receipt(receiptId); }
  static previewUndo(receiptId) { return ageNpcStudioService.previewUndo(receiptId); }
  static undo(receiptId, options) { return ageNpcStudioService.undo(receiptId, options); }
  static getActiveProfile() { return ageNpcStudioService.getActiveProfile(); }
  static status() { return ageNpcStudioService.status(); }
  static capabilities() { return ageNpcStudioService.capabilities(); }

  get sessions() { return this.#sessions; }

  getActiveProfile() {
    requirePermission(this.#environment);
    return npcStudioProfileCapabilities(activeNpcStudioProfileId(this.#environment), {environment: this.#environment});
  }

  status() {
    requirePermission(this.#environment);
    let activeProfile = null;
    let available = true;
    let reason = null;
    try { activeProfile = activeNpcStudioProfileId(this.#environment); }
    catch (error) { available = false; reason = error.code ?? "AGE_NPC_STUDIO_PROFILE_UNSUPPORTED"; }
    return Object.freeze({available, activeProfile, reason, sessionTtlMs: this.#sessions.ttlMs, creationOnly: true});
  }

  capabilities() {
    requirePermission(this.#environment);
    return Object.freeze({
      version: 1,
      available: true,
      creationOnly: true,
      origins: Object.freeze(["blank", "paste", "clone"]),
      profiles: Object.freeze(["dage", "fage-1e", "fage-2e", "mage-core", "mage-mastery-injury"]),
      signedPreview: true,
      exactUndo: true,
      batch: false,
    });
  }

  async createDraft(options = {}) {
    requirePermission(this.#environment);
    assertDraftOptions(options);
    return createNpcStudioDraft(options, {
      environment: this.#environment,
      idFactory: prefix => this.#idFactory(prefix),
      Parser: this.#Parser,
    });
  }

  async searchActors(query = "", {limit = 50} = {}) {
    requirePermission(this.#environment);
    const needle = normalizeSearch(query);
    const results = values(this.#environment?.game?.actors)
      .filter(actor => actor.type === "char")
      .map(actor => ({uuid: actor.uuid, name: actor.name, type: actor.type, img: actor.img ?? null, sourceKind: "world", source: "World Actors"}));
    for (const pack of values(this.#environment?.game?.packs)) {
      if ((pack.documentName ?? pack.metadata?.type) !== "Actor") continue;
      const {entries} = await packEntries(pack, ["name", "type", "img"]);
      for (const entry of entries) {
        if ((entry.type ?? "char") !== "char") continue;
        const id = entry._id ?? entry.id;
        const collection = packId(pack);
        if (!id || !collection) continue;
        results.push({
          uuid: entry.uuid ?? `Compendium.${collection}.${id}`,
          name: entry.name,
          type: "char",
          img: entry.img ?? null,
          sourceKind: "compendium",
          source: packLabel(pack),
        });
      }
    }
    return results.map(entry => ({...entry, score: score(entry.name, needle)}))
      .filter(entry => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name) || left.uuid.localeCompare(right.uuid))
      .slice(0, boundedLimit(limit));
  }

  async searchItems(query = "", {profileId = null, type = null, limit = 50} = {}) {
    requirePermission(this.#environment);
    const profile = npcStudioProfileSnapshot(profileId, {environment: this.#environment});
    const selectedType = type == null || type === "" ? null : String(type);
    if (selectedType && !ITEM_TYPES.has(selectedType)) {
      throw npcStudioError("AGE_NPC_STUDIO_ITEM_TYPE", `Unsupported NPC Studio Item type: ${selectedType}.`);
    }
    const needle = normalizeSearch(query);
    const candidates = values(this.#environment?.game?.items)
      .filter(item => ITEM_TYPES.has(item.type))
      .map(item => ({entry: item, pack: null, projected: true, sourceKind: "world", source: "World Items"}));
    for (const pack of values(this.#environment?.game?.packs)) {
      if ((pack.documentName ?? pack.metadata?.type) !== "Item") continue;
      const {entries, projected} = await packEntries(pack, ["name", "type", "img", "system.type", "system.degree", "system.useAbl", "system.initialValue", `flags.${SYSTEM_ID}.profile`, `flags.${SYSTEM_ID}.automation.profile`]);
      for (const entry of entries) {
        if (!ITEM_TYPES.has(entry.type)) continue;
        const id = entry._id ?? entry.id;
        const collection = packId(pack);
        if (!id || !collection) continue;
        candidates.push({entry, pack, projected, sourceKind: "compendium", source: packLabel(pack)});
      }
    }
    const sorted = candidates
      .map(candidate => ({...candidate, score: score(candidate.entry?.name, needle)}))
      .filter(candidate => candidate.score > 0 && (!selectedType || candidate.entry?.type === selectedType))
      .sort((left, right) => right.score - left.score
        || String(left.entry?.name ?? "").localeCompare(String(right.entry?.name ?? ""))
        || String(left.entry?.uuid ?? left.entry?._id ?? "").localeCompare(String(right.entry?.uuid ?? right.entry?._id ?? "")));
    const results = [];
    for (const candidate of sorted) {
      let entry = candidate.entry;
      if (candidate.pack && !candidate.projected) {
        entry = await hydratePackEntry(candidate.pack, candidate.entry, this.#environment);
        if (!entry || String(entry.documentName ?? entry.constructor?.documentName ?? "") !== "Item") continue;
      }
      if (!ITEM_TYPES.has(entry.type) || (selectedType && entry.type !== selectedType)) continue;
      if (!profileMatches(itemProfiles(entry, candidate.pack), profile.profileId)) continue;
      const id = entry._id ?? entry.id ?? candidate.entry?._id ?? candidate.entry?.id;
      const collection = candidate.pack ? packId(candidate.pack) : "";
      const uuid = entry.uuid ?? candidate.entry?.uuid ?? (collection && id ? `Compendium.${collection}.${id}` : "");
      if (!uuid) continue;
      results.push({
        uuid,
        name: entry.name,
        type: entry.type,
        ...itemUsage(entry),
        img: entry.img ?? null,
        sourceKind: candidate.sourceKind,
        source: candidate.source,
        score: candidate.score,
      });
      if (results.length >= boundedLimit(limit)) break;
    }
    return results;
  }

  async preview(rawDraft) {
    const user = requirePermission(this.#environment);
    assertNpcStudioSafeInput(rawDraft);
    const profileSnapshot = npcStudioProfileSnapshot(rawDraft?.profileId, {environment: this.#environment});
    const draft = assertNpcStudioDraftV1(rawDraft, {abilityIds: profileSnapshot.abilityIds, talentDegrees: profileSnapshot.talentDegrees});
    const inputDigest = await digestCanonicalJson(draft);
    const targetActorId = String(this.#idFactory("actor")).slice(0, 16);
    if (!/^[A-Za-z0-9]{16}$/u.test(targetActorId)) throw npcStudioError("AGE_NPC_STUDIO_ACTOR_ID", "NPC Studio Actor ids must be 16 alphanumeric characters.");
    const plan = await compileNpcStudioPlan(draft, {
      environment: this.#environment,
      profile: profileSnapshot,
      actorId: targetActorId,
      userId: user.id,
      draftDigest: inputDigest,
    });
    const profileDigest = await digestCanonicalJson(profileSnapshot);
    const snapshotDigest = await digestCanonicalJson({profileSnapshot, sourceSnapshots: plan.sourceSnapshots});
    const review = npcStudioReview(draft, profileSnapshot, plan);
    const now = Number(this.#clock());
    const session = this.#sessions.put({
      schemaVersion: 1,
      userId: user.id,
      draft,
      inputDigest,
      profileSnapshot,
      profileDigest,
      sourceSnapshots: plan.sourceSnapshots,
      snapshotDigest,
      targetActorId,
      plan,
      planDigest: plan.planDigest,
      warnings: [],
      errors: [],
      createdAt: now,
    }, {kind: "create"});
    // presentSession needs no live environment data; capabilities are copied from the signed snapshot below.
    return canonicalClone({
      id: session.id,
      schemaVersion: session.schemaVersion,
      state: "preview",
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      inputDigest,
      snapshotDigest,
      planDigest: plan.planDigest,
      profileId: profileSnapshot.profileId,
      profile: {
        profileId: profileSnapshot.profileId,
        abilityIds: profileSnapshot.abilityIds,
        parserModes: profileSnapshot.parserModes,
        healthSystem: profileSnapshot.healthSystem,
        healthMode: profileSnapshot.healthMode,
        gameMode: profileSnapshot.gameMode,
        primaryAbilities: profileSnapshot.primaryAbilities,
        usePowerPoints: profileSnapshot.usePowerPoints,
        useConviction: profileSnapshot.useConviction,
        useFatigue: profileSnapshot.useFatigue,
        talentDegrees: profileSnapshot.talentDegrees,
      },
      draft,
      review,
      sourceCount: plan.sourceSnapshots.length,
      itemCount: draft.items.filter(item => item.include).length,
      summary: {
        name: draft.identity.name,
        defense: (draft.abilities.dex?.value ?? 0) + draft.combat.defenseBase + draft.combat.defenseGameModeBonus,
        speed: (draft.abilities.dex?.value ?? 0) + draft.combat.speedBase,
        health: draft.combat.healthSet,
        toughness: (draft.abilities.cons?.value ?? 0) + draft.combat.toughnessGameModeBonus,
        impactArmor: draft.combat.impactArmor,
        ballisticArmor: draft.combat.ballisticArmor,
      },
      warnings: [],
      errors: [],
      canCommit: true,
    });
  }

  cancel(previewId) {
    const user = requirePermission(this.#environment);
    return this.#sessions.cancel(previewId, {userId: user.id});
  }

  async commit(previewId, expected = {}) {
    const user = requirePermission(this.#environment);
    if (!plainObject(expected)) throw npcStudioError("AGE_NPC_STUDIO_DIGEST_REQUIRED", "NPC Studio commit requires expected digests.");
    for (const field of ["inputDigest", "snapshotDigest", "planDigest"]) {
      if (typeof expected[field] !== "string" || !SHA256.test(expected[field])) {
        throw npcStudioError("AGE_NPC_STUDIO_DIGEST_REQUIRED", `NPC Studio commit requires a valid ${field}.`);
      }
    }
    const reservation = this.#sessions.reserve(previewId, {userId: user.id, kind: "create"});
    const {session, token} = reservation;
    try {
      if (expected.inputDigest !== session.inputDigest) throw npcStudioError("AGE_NPC_STUDIO_INPUT_STALE", "NPC Studio draft changed after preview.");
      if (expected.snapshotDigest !== session.snapshotDigest) throw npcStudioError("AGE_NPC_STUDIO_SNAPSHOT_STALE", "NPC Studio profile or sources changed after preview.");
      if (expected.planDigest !== session.planDigest) throw npcStudioError("AGE_NPC_STUDIO_PLAN_STALE", "NPC Studio creation plan changed after preview.");
      const profileSnapshot = npcStudioProfileSnapshot(session.profileSnapshot.profileId, {environment: this.#environment});
      const profileDigest = await digestCanonicalJson(profileSnapshot);
      if (profileDigest !== session.profileDigest) throw npcStudioError("AGE_NPC_STUDIO_PROFILE_STALE", "The active AGE profile changed after preview.");
      const inputDigest = await digestCanonicalJson(session.draft);
      if (inputDigest !== session.inputDigest) throw npcStudioError("AGE_NPC_STUDIO_INPUT_STALE", "The stored NPC Studio draft no longer matches its digest.");
      const currentPlan = await compileNpcStudioPlan(session.draft, {
        environment: this.#environment,
        profile: profileSnapshot,
        actorId: session.targetActorId,
        userId: user.id,
        draftDigest: inputDigest,
      });
      if (!sameNpcStudioSources(currentPlan.sourceSnapshots, session.sourceSnapshots)) {
        throw npcStudioError("AGE_NPC_STUDIO_SOURCE_STALE", "An NPC Studio source changed after preview.");
      }
      const snapshotDigest = await digestCanonicalJson({profileSnapshot, sourceSnapshots: currentPlan.sourceSnapshots});
      if (snapshotDigest !== session.snapshotDigest) throw npcStudioError("AGE_NPC_STUDIO_SNAPSHOT_STALE", "NPC Studio profile or sources changed after preview.");
      if (currentPlan.planDigest !== session.planDigest || canonicalJson(currentPlan) !== canonicalJson(session.plan)) {
        throw npcStudioError("AGE_NPC_STUDIO_PLAN_STALE", "The compiled NPC Studio plan changed after preview.");
      }
      const result = await this.#executor.commit({session, plan: currentPlan, user});
      this.#receipts.set(result.receipt.id, result.receipt);
      this.#sessions.complete(previewId, token);
      return result;
    } catch (error) {
      if (error?.code === "AGE_NPC_STUDIO_ROLLBACK_FAILED") this.#sessions.complete(previewId, token);
      else this.#sessions.release(previewId, token);
      throw error;
    }
  }

  async #receiptContext(receiptId) {
    const id = String(receiptId ?? "");
    let receipt = this.#receipts.get(id) ?? null;
    let actor = null;
    if (receipt) actor = await resolveUuid(receipt.actorUuid, this.#environment);
    if (!receipt || !actor) {
      for (const candidate of values(this.#environment?.game?.actors)) {
        const rawEmbedded = rawNpcStudioReceipt(candidate);
        if (typeof rawEmbedded?.id !== "string" || rawEmbedded.id !== id) continue;
        const embedded = getNpcStudioReceipt(candidate);
        if (receipt && canonicalJson(receipt) !== canonicalJson(embedded)) throw npcStudioError("AGE_NPC_STUDIO_RECEIPT_DUPLICATE", `NPC Studio receipt "${id}" is inconsistent.`);
        receipt = embedded;
        actor = candidate;
      }
    }
    if (!receipt || !actor) throw npcStudioError("AGE_NPC_STUDIO_RECEIPT_MISSING", `NPC Studio receipt "${id}" is unavailable.`);
    if (actor.uuid !== receipt.actorUuid) throw npcStudioError("AGE_NPC_STUDIO_RECEIPT_BINDING", "NPC Studio receipt belongs to another Actor.");
    return {receipt, actor};
  }

  async receipt(receiptId) {
    requirePermission(this.#environment);
    const retained = this.#receipts.get(String(receiptId ?? "")) ?? null;
    if (retained) return retained;
    return (await this.#receiptContext(receiptId)).receipt;
  }

  async previewUndo(receiptId) {
    const user = requirePermission(this.#environment);
    const {receipt, actor} = await this.#receiptContext(receiptId);
    const verification = await this.#executor.verifyUndo(actor, receipt);
    if (!verification.allowed) {
      throw npcStudioError("AGE_NPC_STUDIO_UNSAFE_UNDO", `NPC Studio cannot undo this Actor safely: ${verification.reasons.join(", ")}.`, {verification});
    }
    const body = canonicalClone({receiptId: receipt.id, actorUuid: actor.uuid, currentDigest: verification.currentDigest, userId: user.id});
    const digest = await digestCanonicalJson(body);
    const session = this.#sessions.put({
      schemaVersion: 1,
      userId: user.id,
      receiptId: receipt.id,
      actorUuid: actor.uuid,
      receipt,
      currentDigest: verification.currentDigest,
      undoDigest: digest,
      createdAt: Number(this.#clock()),
    }, {kind: "undo"});
    return Object.freeze({id: session.id, receiptId: receipt.id, actorUuid: actor.uuid, digest, createdAt: session.createdAt, expiresAt: session.expiresAt, allowed: true});
  }

  async undo(receiptId, {confirmed = false, preview} = {}) {
    const user = requirePermission(this.#environment);
    if (confirmed !== true) {
      throw npcStudioError("AGE_NPC_STUDIO_CONFIRMATION_REQUIRED", "NPC Studio undo requires explicit confirmation.");
    }
    if (!plainObject(preview) || typeof preview.id !== "string" || typeof preview.digest !== "string") {
      throw npcStudioError("AGE_NPC_STUDIO_UNDO_PREVIEW_REQUIRED", "NPC Studio undo requires its signed preview.");
    }
    const reservation = this.#sessions.reserve(preview.id, {userId: user.id, kind: "undo"});
    const {session, token} = reservation;
    try {
      if (session.receiptId !== receiptId || session.undoDigest !== preview.digest) {
        throw npcStudioError("AGE_NPC_STUDIO_UNDO_STALE", "NPC Studio undo preview does not match this receipt.");
      }
      const {receipt, actor} = await this.#receiptContext(receiptId);
      const verification = await this.#executor.verifyUndo(actor, receipt);
      const body = canonicalClone({receiptId: receipt.id, actorUuid: actor.uuid, currentDigest: verification.currentDigest, userId: user.id});
      if (!verification.allowed || await digestCanonicalJson(body) !== session.undoDigest) {
        throw npcStudioError("AGE_NPC_STUDIO_UNSAFE_UNDO", "The created NPC changed after undo preview.", {verification});
      }
      const result = await this.#executor.undo(actor, receipt, {user});
      this.#receipts.set(receipt.id, result.receipt);
      this.#sessions.complete(preview.id, token);
      return result;
    } catch (error) {
      this.#sessions.release(preview.id, token);
      throw error;
    }
  }
}

export const ageNpcStudioService = new AgeNpcStudioService();
export default AgeNpcStudioService;
