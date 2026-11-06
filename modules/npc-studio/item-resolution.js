import {AGE_NPC_STUDIO_ITEM_TYPES, npcStudioError} from "./contracts.js";

const SYSTEM_ID = "age-system";
const ITEM_TYPES = new Set(AGE_NPC_STUDIO_ITEM_TYPES);
const DEGREE_VOCABULARIES = Object.freeze({
  mage: Object.freeze(["novice", "expert", "master"]),
  fage: Object.freeze(["novice", "journeyman", "master"]),
  mageExtra: Object.freeze(["novice", "expert", "master", "grandmaster", "apex"]),
  fageExtra: Object.freeze(["novice", "journeyman", "master", "grandmaster", "apex"]),
});
const DEGREE_ALIASES = Object.freeze({
  novice: Object.freeze(["novice", "novice rank", "novice degree"]),
  journeyman: Object.freeze(["journeyman", "journey man", "journeyman rank", "journeyman degree"]),
  expert: Object.freeze(["expert", "expert rank", "expert degree"]),
  master: Object.freeze(["master", "master rank", "master degree"]),
  grandmaster: Object.freeze(["grandmaster", "grand master", "grandmaster rank", "grandmaster degree"]),
  apex: Object.freeze(["apex", "apex rank", "apex degree"]),
});

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function rawSource(document) {
  if (document?._source && typeof document._source === "object") return document._source;
  if (typeof document?.toObject === "function") return document.toObject(false);
  return document ?? {};
}

function documentName(document) {
  return String(document?.documentName ?? document?.constructor?.documentName ?? "");
}

function packId(pack) {
  return String(pack?.collection ?? pack?.metadata?.id ?? "");
}

function packLabel(pack) {
  return String(pack?.metadata?.label ?? pack?.title ?? packId(pack) ?? "Compendium");
}

function normalizeProfiles(entry, pack) {
  const flags = entry?.flags ?? entry?._source?.flags;
  const value = flags?.[SYSTEM_ID]?.profile
    ?? flags?.[SYSTEM_ID]?.automation?.profile
    ?? pack?.metadata?.flags?.[SYSTEM_ID]?.profile;
  if (!value) return [];
  return (Array.isArray(value) ? value : String(value).split(/[;,]/u))
    .map(normalizeNpcStudioItemName)
    .filter(Boolean);
}

function profileMatches(profiles, profileId) {
  if (!profiles.length) return true;
  const selected = normalizeNpcStudioItemName(profileId);
  return profiles.includes(selected) || profiles.includes(selected.split(" ")[0]) || profiles.includes(selected.split("-")[0]);
}

async function packEntries(pack) {
  if (pack?.visible === false || !(pack?.getIndex instanceof Function)) return [];
  const fields = [
    "name", "type", "img", "system.type", "system.degree",
    `flags.${SYSTEM_ID}.profile`, `flags.${SYSTEM_ID}.automation.profile`,
  ];
  try { return values(await pack.getIndex({fields})); }
  catch (_fieldError) {
    try { return values(await pack.getIndex()); }
    catch (_indexError) { return []; }
  }
}

async function resolveUuid(uuid, environment) {
  const resolver = environment?.foundry?.utils?.fromUuid ?? environment?.fromUuid ?? globalThis.fromUuid;
  if (!(resolver instanceof Function)) return null;
  try { return await resolver.call(environment?.foundry?.utils ?? environment, uuid); }
  catch (_error) { return null; }
}

function sourceSubtype(source) {
  if (String(source?.type ?? "") !== "talent") return "";
  return String(rawSource(source)?.system?.type ?? source?.system?.type ?? "talent") === "spec" ? "spec" : "talent";
}

async function resolveCandidate(candidate, environment) {
  if (candidate.document) return candidate.document;
  if (candidate.pack?.getDocument instanceof Function) {
    try {
      const document = await candidate.pack.getDocument(candidate.id);
      if (document) return document;
    } catch (_error) { /* Fall through to UUID resolution. */ }
  }
  const modernUuid = candidate.collection && candidate.id
    ? `Compendium.${candidate.collection}.Item.${candidate.id}`
    : candidate.uuid;
  return await resolveUuid(candidate.uuid, environment) ?? await resolveUuid(modernUuid, environment);
}

async function libraryCandidates(environment, profile) {
  const result = values(environment?.game?.items)
    .filter(item => ITEM_TYPES.has(String(item?.type ?? "")))
    .filter(item => profileMatches(normalizeProfiles(item, null), profile.profileId))
    .map(item => ({
      document: item,
      id: String(item.id ?? item._id ?? ""),
      uuid: String(item.uuid ?? ""),
      name: String(item.name ?? ""),
      type: String(item.type ?? ""),
      img: String(item.img ?? "icons/svg/item-bag.svg"),
      subtype: sourceSubtype(item),
      sourceKind: "world",
      sourceLabel: "World Items",
      priority: 0,
    }));
  for (const pack of values(environment?.game?.packs)) {
    if ((pack.documentName ?? pack.metadata?.type) !== "Item" || pack.visible === false) continue;
    const collection = packId(pack);
    if (!collection) continue;
    for (const entry of await packEntries(pack)) {
      if (!ITEM_TYPES.has(String(entry?.type ?? ""))) continue;
      if (!profileMatches(normalizeProfiles(entry, pack), profile.profileId)) continue;
      const id = String(entry._id ?? entry.id ?? "");
      if (!id) continue;
      result.push({
        document: null,
        pack,
        collection,
        id,
        uuid: String(entry.uuid ?? `Compendium.${collection}.${id}`),
        name: String(entry.name ?? ""),
        type: String(entry.type ?? ""),
        img: String(entry.img ?? "icons/svg/item-bag.svg"),
        subtype: String(entry?.system?.type ?? "") === "spec" ? "spec" : (entry.type === "talent" ? "talent" : ""),
        sourceKind: "compendium",
        sourceLabel: packLabel(pack),
        priority: 1,
      });
    }
  }
  return result;
}

/** Normalize punctuation, spacing, accents, and case for exact library matching. */
export function normalizeNpcStudioItemName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[’']/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

export function npcStudioTalentDegrees(profile = {}) {
  const setting = String(profile?.liveSettings?.DegressChoice
    ?? profile?.configuredSettings?.DegressChoice
    ?? (String(profile?.profileId ?? "").startsWith("mage") ? "mage" : "fage"));
  const vocabulary = DEGREE_VOCABULARIES[setting]
    ?? (setting.toLocaleLowerCase().includes("mage") ? DEGREE_VOCABULARIES.mage : DEGREE_VOCABULARIES.fage);
  return vocabulary.map((id, value) => Object.freeze({value, id}));
}

function degreeFromValue(value, degrees) {
  if (value !== "" && value !== null && value !== undefined && Number.isInteger(Number(value))) {
    const numeric = Number(value);
    if (numeric >= 0 && numeric < degrees.length) return numeric;
  }
  const normalized = normalizeNpcStudioItemName(value);
  if (!normalized) return null;
  for (const degree of degrees) {
    if ([degree.id, ...(DEGREE_ALIASES[degree.id] ?? [])].some(alias => normalizeNpcStudioItemName(alias) === normalized)) {
      return degree.value;
    }
  }
  return null;
}

/** Split a stat-block talent label such as "Command (Journeyman)" into its signed name/rank data. */
export function parseNpcStudioTalentLabel(name, degree, profile = {}) {
  const degrees = npcStudioTalentDegrees(profile);
  let cleanName = String(name ?? "").trim();
  let parsedDegree = degreeFromValue(degree, degrees);
  const suffix = cleanName.match(/^(.*?)\s*[\[(]\s*([^\])]+?)\s*[\])]\s*$/u);
  if (suffix) {
    const suffixDegree = degreeFromValue(suffix[2], degrees);
    if (suffixDegree !== null) {
      cleanName = suffix[1].trim();
      if (parsedDegree === null) parsedDegree = suffixDegree;
    }
  }
  return Object.freeze({name: cleanName || String(name ?? "").trim(), degree: parsedDegree ?? 0});
}

function comparableName(entry, profile) {
  if (entry.type !== "talent") return normalizeNpcStudioItemName(entry.name);
  return normalizeNpcStudioItemName(parseNpcStudioTalentLabel(entry.name, null, profile).name);
}

function emptyResolution(status = "unmatched") {
  return {
    status,
    mode: "custom",
    sourceUuid: null,
    sourceName: "",
    sourceKind: "",
    sourceLabel: "",
    sourceSubtype: "",
    alternatives: [],
  };
}

/**
 * Resolve parsed custom content against world Items and visible, profile-compatible
 * compendiums. Matching is exact after bounded name normalization and Item type;
 * Talent/Specialization subtype is also exact. World Items win deterministic ties.
 */
export async function resolveNpcStudioParsedItems(draft, {environment = globalThis, profile} = {}) {
  if (!profile?.profileId) throw npcStudioError("AGE_NPC_STUDIO_PROFILE_SNAPSHOT", "NPC Studio Item matching requires a profile snapshot.");
  const candidates = await libraryCandidates(environment, profile);
  for (const entry of draft.items ?? []) {
    if (entry.origin !== "custom" || !entry.custom) continue;
    const key = comparableName(entry, profile);
    const subtype = entry.type === "talent" ? (entry.custom.subtype === "spec" ? "spec" : "talent") : "";
    const matches = candidates
      .filter(candidate => candidate.type === entry.type && comparableName(candidate, profile) === key)
      .sort((left, right) => {
        const leftExact = normalizeNpcStudioItemName(left.name) === normalizeNpcStudioItemName(entry.name);
        const rightExact = normalizeNpcStudioItemName(right.name) === normalizeNpcStudioItemName(entry.name);
        return left.priority - right.priority
          || Number(rightExact) - Number(leftExact)
          || left.name.localeCompare(right.name)
          || left.uuid.localeCompare(right.uuid);
      });
    const compatible = [];
    const seen = new Set();
    for (const candidate of matches) {
      const resolved = await resolveCandidate(candidate, environment);
      if (!resolved || documentName(resolved) !== "Item" || String(resolved.type ?? "") !== entry.type) continue;
      if (!profileMatches(normalizeProfiles(resolved, candidate.pack ?? null), profile.profileId)) continue;
      if (comparableName(resolved, profile) !== key) continue;
      if (entry.type === "talent" && sourceSubtype(resolved) !== subtype) continue;
      const uuid = String(resolved.uuid ?? candidate.uuid ?? "");
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);
      compatible.push({
        document: resolved,
        sourceUuid: uuid,
        sourceName: String(resolved.name ?? candidate.name ?? entry.name),
        sourceKind: candidate.sourceKind,
        sourceLabel: candidate.sourceLabel,
        sourceSubtype: sourceSubtype(resolved),
      });
    }
    if (!compatible.length) {
      entry.resolution = emptyResolution("unmatched");
      continue;
    }
    const alternatives = compatible.map(({document, ...source}) => source);
    if (compatible.length > 1) {
      entry.origin = "custom";
      entry.sourceUuid = null;
      entry.resolution = {
        status: "matched",
        mode: "pending",
        sourceUuid: null,
        sourceName: "",
        sourceKind: "",
        sourceLabel: "",
        sourceSubtype: "",
        alternatives,
      };
      continue;
    }
    const [{document, ...source}] = compatible;
    entry.origin = "library";
    entry.sourceUuid = source.sourceUuid;
    entry.img = String(document.img ?? entry.img);
    entry.resolution = {
      status: "matched",
      mode: "reuse",
      ...source,
      alternatives,
    };
  }
  return draft;
}

export function manualNpcStudioResolution() {
  return emptyResolution("manual");
}
