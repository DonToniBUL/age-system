import {suggestInjuryDamageFromFormula} from "./injury-damage.js";
import {
  isExpectedNpcStudioRejection,
  npcStudioUiRejection,
  reportNpcStudioActionFailure,
} from "./npc-studio/error-reporting.js";

const SYSTEM_ID = "age-system";
const CUSTOM_ENTRY_LIMIT = 50;
const SELECTED_ITEM_LIMIT = 250;
const SEARCH_RESULT_LIMIT = 50;
const PASTE_CHARACTER_LIMIT = 250_000;
const LIBRARY_ITEM_TYPES = new Set([
  "focus", "weapon", "power", "talent", "stunts", "equipment",
  "relationship", "honorifics", "membership",
]);

function reportUnexpectedNpcStudioFailure(message, error) {
  if (!isExpectedNpcStudioRejection(error)) console.error(message, error);
}

export const NPC_STUDIO_STEPS = Object.freeze([
  "source", "identity", "statistics", "content", "review", "result"
]);

export const NPC_STUDIO_SOURCE_MODES = Object.freeze(["paste", "blank", "clone"]);

const PARSER_MODES = Object.freeze([
  Object.freeze({id: "mageL", label: "parserMajor"}),
  Object.freeze({id: "mageM", label: "parserMinor"}),
  Object.freeze({id: "fage", label: "parserFage"}),
  Object.freeze({id: "fage2e", label: "parserFage2"}),
  Object.freeze({id: "dage", label: "parserDage"})
]);

const EDITABLE_PATHS = new Set([
  "identity.name", "identity.kind", "identity.threat", "identity.level", "identity.ancestry",
  "identity.profession", "identity.background", "identity.img", "identity.compactSheet",
  "combat.defenseBase", "combat.defenseGameModeBonus", "combat.speedBase", "combat.healthValue",
  "combat.healthSet", "combat.toughnessGameModeBonus", "combat.impactArmor", "combat.ballisticArmor",
  "combat.initiativeMod", "combat.attackMod", "combat.testMod", "combat.damageMod",
  "resources.powerPointsValue", "resources.powerPointsSet", "resources.convictionValue",
  "resources.convictionSet", "resources.fatigueEntered",
  "token.actorLink", "token.disposition", "token.width", "token.height", "token.img",
  "notes.features", "notes.traits", "notes.goals", "notes.gmNotes"
]);

const EDITABLE_ITEM_FIELDS = new Set(["name", "include"]);
const EDITABLE_CUSTOM_FIELDS = new Set([
  "description", "ability", "bonus", "damageFormula", "damageInjury", "damageInjuryConfirmed", "damageSource", "focus",
  "targetNumber", "powerPointCost", "degree", "subtype", "stuntPoints", "equipped", "intensity", "rank"
]);
const MATCHED_OVERLAY_FIELDS = Object.freeze({
  focus: new Set(["ability", "bonus"]),
  talent: new Set(["degree"]),
  relationship: new Set(["intensity"]),
  membership: new Set(["rank"]),
});

const CUSTOM_KINDS = Object.freeze([
  Object.freeze({id: "attack", type: "weapon", label: "customAttack"}),
  Object.freeze({id: "focus", type: "focus", label: "customFocus"}),
  Object.freeze({id: "power", type: "power", label: "customPower"}),
  Object.freeze({id: "talent", type: "talent", label: "customTalent"}),
  Object.freeze({id: "specialization", type: "talent", label: "customSpecialization"}),
  Object.freeze({id: "stunt", type: "stunts", label: "customStunt"}),
  Object.freeze({id: "equipment", type: "equipment", label: "customEquipment"}),
  Object.freeze({id: "relationship", type: "relationship", label: "customRelationship"}),
  Object.freeze({id: "honorific", type: "honorifics", label: "customHonorific"}),
  Object.freeze({id: "membership", type: "membership", label: "customMembership"})
]);

function deepClone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  if (globalThis.structuredClone) return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function randomId(prefix = "entry") {
  const id = globalThis.foundry?.utils?.randomID?.(16)
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${id}`;
}

function localize(key, fallback, data = null) {
  try {
    const translated = data
      ? globalThis.game?.i18n?.format?.(key, data)
      : globalThis.game?.i18n?.localize?.(key);
    return translated && translated !== key ? translated : fallback;
  } catch (_error) {
    return fallback;
  }
}

function npcLabel(key, fallback, data = null) {
  return localize(`age-system.NPC_STUDIO.${key}`, fallback, data);
}

function stableValue(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("NPC Studio drafts must not contain circular values.");
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map(entry => stableValue(entry, seen))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key], seen)]));
  seen.delete(value);
  return result;
}

function draftFingerprint(draft) {
  return JSON.stringify(stableValue(draft ?? {}));
}

function integer(value, fallback = 0, minimum = -9999, maximum = 9999) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function coerceInput(target) {
  if (target?.type === "checkbox") return Boolean(target.checked);
  if (target?.dataset?.dtype === "Number") return Number.isFinite(Number(target.value)) ? Number(target.value) : 0;
  return target?.value ?? "";
}

function itemDragData(event) {
  const reader = globalThis.foundry?.applications?.ux?.TextEditor?.implementation?.getDragEventData;
  if (reader instanceof Function) {
    try {
      const data = reader(event);
      if (data && typeof data === "object") return data;
    } catch (_error) { /* Fall through to the bounded JSON payload. */ }
  }
  const raw = String(event?.dataTransfer?.getData?.("text/plain") ?? "");
  if (!raw || raw.length > 10_000) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch (_error) {
    return null;
  }
}

function itemUuidFromDrop(event) {
  const data = itemDragData(event);
  if (!data || (data.type && data.type !== "Item")) return "";
  if (typeof data.uuid === "string" && data.uuid.trim()) return data.uuid.trim();
  if (data.type === "Item" && typeof data.id === "string" && data.id.trim()) return `Item.${data.id.trim()}`;
  return "";
}

function documentName(document) {
  return String(document?.documentName ?? document?.constructor?.documentName ?? "");
}

function setPath(target, path, value) {
  const parts = String(path ?? "").split(".").filter(Boolean);
  if (!parts.length || parts.some(part => ["__proto__", "prototype", "constructor"].includes(part))) return false;
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor?.[part] || typeof cursor[part] !== "object") return false;
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
  return true;
}

function profileId(profile) {
  return String(profile?.id ?? profile?.profileId ?? "custom");
}

function usesInjuryDamage(profile) {
  return profileId(profile) === "mage-mastery-injury"
    || String(profile?.healthSystem ?? profile?.health?.system ?? "") === "mageInjury";
}

function profileAbilityIds(profile, draft = null) {
  const ids = profile?.abilityIds ?? profile?.ability?.ids ?? profile?.abilities?.ids ?? profile?.abilities;
  if (Array.isArray(ids) && ids.length) return [...new Set(ids.map(String))];
  const draftIds = Object.keys(draft?.abilities ?? {});
  if (draftIds.length) return draftIds;
  return ["acc", "comm", "cons", "dex", "fight", "int", "per", "str", "will"];
}

function defaultParserMode(profile) {
  if (Array.isArray(profile?.parserModes) && profile.parserModes.length) return profile.parserModes[0];
  const id = profileId(profile);
  if (id === "dage") return "dage";
  if (id === "fage-1e") return "fage";
  if (id === "fage-2e") return "fage2e";
  if (id.includes("expanse")) return "expanse";
  return "mageL";
}

function normalizedProfile(raw) {
  const profile = deepClone(raw ?? {});
  profile.id = profileId(profile);
  profile.profileId = profile.id;
  profile.abilityIds = profileAbilityIds(profile);
  profile.parserModes = Array.isArray(profile.parserModes) ? profile.parserModes.filter(id => PARSER_MODES.some(mode => mode.id === id)) : [];
  if (!Array.isArray(profile.talentDegrees) || !profile.talentDegrees.length) {
    const ids = profile.id.startsWith("mage") ? ["novice", "expert", "master"] : ["novice", "journeyman", "master"];
    profile.talentDegrees = ids.map((id, value) => ({id, value}));
  }
  const labels = {
    dage: ["profileDage", "Dragon AGE"],
    "fage-1e": ["profileFage1e", "Fantasy AGE 1e"],
    "fage-2e": ["profileFage2e", "Fantasy AGE 2e"],
    "mage-core": ["profileMageCore", "Modern AGE Core"],
    "mage-mastery-injury": ["profileMageMasteryInjury", "Modern AGE Mastery & Injury"]
  };
  const [labelKey, labelFallback] = labels[profile.id] ?? ["profileCustom", profile.label || profile.id];
  profile.localizedLabel = profile.localizedLabel
    ?? npcLabel(labelKey, labelFallback);
  profile.identity ??= {};
  profile.health ??= {};
  profile.resource ??= {};
  return profile;
}

function talentDegreeOptions(profile, selected = 0) {
  return (profile?.talentDegrees ?? []).map((degree, index) => {
    const value = integer(degree?.value ?? index, index, 0, 4);
    const id = String(degree?.id ?? value);
    return {
      value,
      label: localize(`age-system.${id}`, id),
      selected: value === integer(selected, 0, 0, 4),
    };
  });
}

function ensureDraft(raw, profile) {
  const draft = deepClone(raw?.draft ?? raw ?? {});
  draft.schemaVersion ??= 1;
  draft.draftId ??= randomId("draft");
  draft.profileId ??= profileId(profile);
  draft.origin ??= {kind: "blank", parserMode: null, sourceActorUuid: null};
  draft.identity ??= {};
  draft.identity.name ??= "";
  draft.identity.kind ??= "adversary";
  draft.identity.threat ??= "";
  draft.identity.level ??= 0;
  draft.identity.ancestry ??= "";
  draft.identity.profession ??= "";
  draft.identity.background ??= "";
  draft.identity.img ??= "icons/svg/mystery-man.svg";
  draft.identity.compactSheet ??= true;
  draft.abilities ??= {};
  for (const id of profileAbilityIds(profile, draft)) {
    const current = draft.abilities[id];
    draft.abilities[id] = current && typeof current === "object"
      ? {value: integer(current.value, 0, -5, 20), primary: Boolean(current.primary)}
      : {value: integer(current, 0, -5, 20), primary: false};
  }
  draft.combat ??= {};
  for (const [key, value] of Object.entries({
    defenseBase: 10, defenseGameModeBonus: 0, speedBase: 10, healthValue: 15, healthSet: 15,
    toughnessGameModeBonus: 0, impactArmor: 0, ballisticArmor: 0,
    initiativeMod: 0, attackMod: 0, testMod: 0, damageMod: 0
  })) draft.combat[key] ??= value;
  draft.resources ??= {powerPointsValue: 0, powerPointsSet: 0, convictionValue: 0, convictionSet: 0, fatigueEntered: 0};
  draft.token ??= {actorLink: false, disposition: -1, width: 1, height: 1, img: ""};
  draft.notes ??= {features: "", traits: "", goals: "", gmNotes: ""};
  draft.items = Array.isArray(draft.items) ? draft.items.slice(0, SELECTED_ITEM_LIMIT) : [];
  for (const item of draft.items) {
    if (!item?.custom) continue;
    if (!Object.hasOwn(item.custom, "damageInjury")) {
      item.custom.damageInjury = item.type === "weapon" && usesInjuryDamage(profile)
        ? suggestInjuryDamageFromFormula(item.custom.damageFormula)
        : null;
    }
    item.custom.damageInjuryConfirmed = item.custom.damageInjuryConfirmed === true;
  }
  return draft;
}

function sourceResult(entry) {
  return {
    uuid: String(entry?.uuid ?? entry?.id ?? ""),
    name: String(entry?.name ?? npcLabel("unnamedActor", "Unnamed Actor")),
    type: String(entry?.type ?? "char"),
    img: String(entry?.img ?? entry?.image ?? "icons/svg/mystery-man.svg"),
    source: String(entry?.source ?? entry?.packLabel ?? entry?.packageLabel ?? ""),
    selected: false
  };
}

function libraryResult(entry) {
  const type = String(entry?.type ?? "equipment");
  const subtype = String(entry?.subtype ?? "");
  return {
    uuid: String(entry?.uuid ?? entry?.id ?? ""),
    name: String(entry?.name ?? npcLabel("unnamedItem", "Unnamed Item")),
    type,
    displayType: type === "talent" && subtype === "spec" ? npcLabel("specialization", "Specialization") : type,
    img: String(entry?.img ?? entry?.image ?? "icons/svg/item-bag.svg"),
    source: String(entry?.source ?? entry?.packLabel ?? entry?.packageLabel ?? ""),
    sourceKind: String(entry?.sourceKind ?? ""),
    subtype,
    degree: entry?.degree,
    ability: String(entry?.ability ?? ""),
    bonus: entry?.bonus,
    selected: false
  };
}

function customEntry(kind, abilities, {injuryDamage = false} = {}) {
  const definition = CUSTOM_KINDS.find(entry => entry.id === kind) ?? CUSTOM_KINDS.at(-1);
  const ability = abilities[0] ?? "acc";
  const entry = {
    entryId: randomId(definition.id), origin: "custom", include: true, type: definition.type,
    name: npcLabel(definition.label, `New ${definition.id}`), img: "icons/svg/item-bag.svg", sourceUuid: null,
    custom: {
      description: "", ability: "", focus: "", bonus: 0, damageFormula: "1d6", damageSource: "impact",
      damageInjury: null,
      damageInjuryConfirmed: false,
      targetNumber: 10, powerPointCost: 0, degree: 0, subtype: definition.id === "specialization" ? "spec" : "talent",
      stuntPoints: 1, equipped: true, intensity: 1, rank: 1
    },
    resolution: {status: "manual", mode: "custom", sourceUuid: null, sourceName: "", sourceKind: "", sourceLabel: "", sourceSubtype: "", alternatives: []}
  };
  if (definition.id === "attack" && injuryDamage) {
    entry.custom.damageInjury = suggestInjuryDamageFromFormula(entry.custom.damageFormula);
  }
  if (definition.id === "focus") Object.assign(entry.custom, {ability, bonus: 2});
  if (definition.id === "power") Object.assign(entry.custom, {ability: "will", powerPointCost: 1});
  return entry;
}

function libraryUsageEntry(result, abilities, talentDegrees = []) {
  const entry = {
    entryId: randomId("source"), origin: "library", include: true, sourceUuid: result.uuid,
    name: result.name, type: result.type, img: result.img, custom: null, resolution: null
  };
  if (!["focus", "talent"].includes(result.type)) return entry;
  const sourceKind = result.sourceKind === "compendium" || String(result.uuid).startsWith("Compendium.")
    ? "compendium" : "world";
  const subtype = result.type === "talent" && result.subtype === "spec" ? "spec" : "talent";
  const focusAbility = abilities.includes(result.ability) ? result.ability : (abilities[0] || "acc");
  const maximumDegree = Math.max(0, Math.min(4, (Array.isArray(talentDegrees) && talentDegrees.length ? talentDegrees.length : 1) - 1));
  entry.custom = {
    description: "",
    ability: result.type === "focus" ? focusAbility : "",
    focus: "",
    bonus: result.type === "focus" ? integer(result.bonus, 2, -30, 30) : 0,
    damageFormula: "1d6",
    damageInjury: null,
    damageInjuryConfirmed: false,
    damageSource: "impact",
    targetNumber: 10,
    powerPointCost: 0,
    degree: result.type === "talent" ? integer(result.degree, 0, 0, maximumDegree) : 0,
    subtype,
    stuntPoints: 1,
    equipped: true,
    intensity: 1,
    rank: 1,
  };
  const source = {
    sourceUuid: result.uuid,
    sourceName: result.name,
    sourceKind,
    sourceLabel: result.source || (sourceKind === "world" ? npcLabel("worldItems", "World Items") : npcLabel("library", "Compendium")),
    sourceSubtype: result.type === "talent" ? subtype : "",
  };
  entry.resolution = {
    status: "matched",
    mode: "reuse",
    ...source,
    alternatives: [source],
  };
  return entry;
}

function boundSourceUuid(item) {
  return item?.sourceUuid ?? item?.resolution?.sourceUuid ?? null;
}

function issueModels(preview, severity) {
  const direct = severity === "error" ? preview?.blockers ?? preview?.errors : preview?.warnings;
  const issues = Array.isArray(direct) ? direct : [];
  const semantic = Array.isArray(preview?.issues)
    ? preview.issues.filter(issue => String(issue?.severity ?? "error") === severity)
    : [];
  return [...issues, ...semantic].map((issue, index) => ({
    id: String(issue?.id ?? issue?.code ?? `${severity}-${index}`),
    message: String(issue?.message ?? issue)
  }));
}

function previewChanges(preview) {
  const rows = preview?.changes ?? preview?.operations ?? preview?.summary?.changes ?? [];
  const normalized = (Array.isArray(rows) ? rows : []).map((row, index) => typeof row === "string"
    ? {id: `change-${index}`, label: row, before: "", after: ""}
    : {
        id: String(row?.id ?? `change-${index}`),
        label: String(row?.label ?? row?.name ?? row?.type ?? npcLabel("change", "Change")),
        before: row?.before == null ? "" : String(row.before),
        after: row?.after == null ? "" : String(row.after)
      });
  if (normalized.length || !preview?.summary || typeof preview.summary !== "object") return normalized;
  return Object.entries(preview.summary).map(([key, value]) => ({
    id: `summary-${key}`,
    label: npcLabel(`summary${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`, key),
    before: "",
    after: value == null ? "" : String(value)
  }));
}

function reviewDisplayValue(value, labels) {
  if (value === true) return labels.yes;
  if (value === false) return labels.no;
  if (value == null || value === "") return labels.empty;
  return String(value);
}

function reviewEntry(id, label, value, labels) {
  return {id, label, value: reviewDisplayValue(value, labels)};
}

function previewReviewSections(preview, profile, labels) {
  const review = preview?.review;
  if (!review || typeof review !== "object") return [];
  const identityLabels = {
    name: labels.name,
    kind: labels.kind,
    threat: labels.threat,
    level: labels.level,
    ancestry: profile.ancestryLabel,
    profession: profile.occupationLabel,
    background: labels.background,
    img: labels.portrait,
    compactSheet: labels.compactSheet,
  };
  const statisticLabels = {
    defense: labels.defense,
    defenseBase: labels.defenseBase,
    defenseGameModeBonus: labels.defenseModeBonus,
    speed: labels.speed,
    speedBase: labels.speedBase,
    healthCurrent: `${profile.healthLabel} · ${labels.current}`,
    healthMaximum: `${profile.healthLabel} · ${labels.maximum}`,
    toughness: labels.toughness,
    toughnessGameModeBonus: labels.toughnessModeBonus,
    impactArmor: labels.impactArmor,
    ballisticArmor: labels.ballisticArmor,
    initiativeModifier: labels.initiativeMod,
    attackModifier: labels.attackMod,
    testModifier: labels.testMod,
    damageModifier: labels.damageMod,
  };
  if (!profile.showToughness) {
    delete statisticLabels.toughness;
    delete statisticLabels.toughnessGameModeBonus;
  }
  if (!profile.showBallistic) delete statisticLabels.ballisticArmor;
  const resourceLabels = {};
  if (profile.showPowerPoints) {
    resourceLabels.powerPointsValue = `${profile.powerLabel} · ${labels.current}`;
    resourceLabels.powerPointsSet = `${profile.powerLabel} · ${labels.maximum}`;
  }
  if (profile.showConviction) {
    resourceLabels.convictionValue = `${labels.conviction} · ${labels.current}`;
    resourceLabels.convictionSet = `${labels.conviction} · ${labels.maximum}`;
  }
  if (profile.showFatigue) resourceLabels.fatigueEntered = labels.fatigue;
  const tokenLabels = {
    actorLink: labels.actorLink,
    disposition: labels.disposition,
    width: labels.tokenWidth,
    height: labels.tokenHeight,
    img: labels.tokenImage,
  };
  const noteLabels = {
    features: labels.features,
    traits: labels.traits,
    goals: labels.goals,
    gmNotes: labels.gmNotes,
  };
  const objectEntries = (prefix, object, names) => Object.entries(names).map(([key, label]) =>
    reviewEntry(`${prefix}-${key}`, label, object?.[key], labels));
  const abilities = (Array.isArray(review.abilities) ? review.abilities : []).map(ability => reviewEntry(
    `ability-${ability.id}`,
    localize(`age-system.${ability.id}`, String(ability.id ?? "").toLocaleUpperCase()),
    `${ability.value ?? 0}${ability.primary ? ` · ${labels.primary}` : ""}`,
    labels
  ));
  const items = (Array.isArray(review.items) ? review.items : []).map(item => {
    const details = [`${labels.itemType}: ${item.type}`, `${labels.reviewOrigin}: ${item.origin}`];
    if (item.resolution?.status === "matched") {
      const choice = item.resolution.mode === "reuse" ? labels.reuseExisting : labels.createCustomInstead;
      details.push(`${labels.resolutionChoice}: ${choice}`);
      if (item.resolution.sourceName) details.push(`${labels.matchedSource}: ${item.resolution.sourceName} · ${item.resolution.sourceLabel}`);
      if (item.resolution.alternatives?.length > 1) {
        details.push(`${labels.exactSources}: ${item.resolution.alternatives.map(source => `${source.sourceName} · ${source.sourceLabel}`).join(", ")}`);
      }
    } else if (item.resolution?.status === "unmatched") {
      details.push(`${labels.resolutionChoice}: ${labels.noExactMatch}`);
    }
    if (item.sourceUuid) details.push(item.sourceUuid);
    if (item.type === "weapon") {
      if (item.damageFormula) details.push(`${labels.damage}: ${item.damageFormula}`);
      if (profile.showInjuryDamage && item.damageInjury !== null && item.damageInjury !== undefined && item.damageInjury !== "") {
        details.push(`${labels.damageInjury}: ${item.damageInjury}`);
      }
      if (profile.showInjuryDamage && item.origin === "custom") {
        details.push(`${labels.injuryDamageConfirmed}: ${reviewDisplayValue(item.damageInjuryConfirmed === true, labels)}`);
      }
    }
    if (item.custom && typeof item.custom === "object") {
      for (const [key, value] of Object.entries(item.custom)) {
        if (value == null || value === "") continue;
        if (item.type === "weapon" && ["damageFormula", "damageInjury", "damageInjuryConfirmed"].includes(key)) continue;
        let display = reviewDisplayValue(value, labels);
        if (key === "degree" && item.type === "talent") {
          const degree = (profile.talentDegrees ?? []).find(entry => Number(entry.value) === Number(value));
          if (degree) display = localize(`age-system.${degree.id}`, degree.id);
        }
        if (key === "subtype" && item.type === "talent") display = value === "spec" ? labels.specialization : labels.talent;
        details.push(`${key}: ${display}`);
      }
    }
    return reviewEntry(`item-${item.entryId}`, item.name, details.join(" · "), labels);
  });
  const sections = [
    {id: "identity", label: labels.identityHeading, entries: objectEntries("identity", review.identity, identityLabels)},
    {id: "abilities", label: labels.abilities, entries: abilities},
    {id: "statistics", label: labels.derivedStatistics, entries: objectEntries("stat", review.statistics, statisticLabels)},
    {id: "resources", label: labels.profileResources, entries: objectEntries("resource", review.resources, resourceLabels)},
    {id: "token", label: labels.reviewToken, entries: objectEntries("token", review.token, tokenLabels)},
    {id: "notes", label: labels.notes, entries: objectEntries("notes", review.notes, noteLabels)},
    {id: "items", label: labels.selectedContent, entries: items},
  ];
  return sections.filter(section => section.entries.length > 0);
}

function receiptId(result) {
  return String(result?.receipt?.id ?? result?.receiptId ?? result?.summary?.receiptId ?? "");
}

function createdActor(result) {
  const actor = result?.actor ?? result?.document ?? result?.created?.find?.(entry => entry?.documentName === "Actor")
    ?? result?.created?.[0] ?? null;
  if (!actor) return null;
  return {
    uuid: String(actor.uuid ?? actor.id ?? ""),
    id: String(actor.id ?? actor._id ?? ""),
    name: String(actor.name ?? npcLabel("unnamedActor", "Unnamed Actor")),
    img: String(actor.img ?? actor.image ?? "icons/svg/mystery-man.svg"),
    document: actor
  };
}

export class AgeNpcStudioController {
  constructor({service, clock = () => Date.now()} = {}) {
    if (!service) throw new TypeError("NPC Studio requires an injected service.");
    for (const method of ["createDraft", "preview", "searchActors", "searchItems", "commit", "cancel", "previewUndo", "undo", "getActiveProfile"]) {
      if (!(service[method] instanceof Function)) throw new TypeError(`NPC Studio service is missing ${method}().`);
    }
    this.service = service;
    this.clock = clock;
    this.state = {
      initialized: false,
      busy: false,
      step: "source",
      sourceMode: "blank",
      pasteText: "",
      parserMode: "mageL",
      actorQuery: "",
      actorResults: [],
      selectedActor: null,
      itemQuery: "",
      itemType: "",
      itemResults: [],
      profile: null,
      draft: null,
      preview: null,
      previewFingerprint: "",
      result: null,
      undoPreview: null,
      error: "",
      announcement: "",
      updatedAt: this.clock()
    };
  }

  async initialize() {
    if (this.state.initialized) return this.context();
    this.state.profile = normalizedProfile(await this.service.getActiveProfile());
    this.state.parserMode = defaultParserMode(this.state.profile);
    this.state.initialized = true;
    this.state.announcement = npcLabel("ready", "NPC Studio is ready.");
    return this.context();
  }

  async initializeSource({origin = "", actorUuid = ""} = {}) {
    if (origin !== "clone" || !actorUuid) return this.context();
    this.selectSource("clone");
    this.state.actorQuery = String(actorUuid).slice(0, 256);
    try {
      await this.searchActors(this.state.actorQuery);
    } catch (error) {
      reportUnexpectedNpcStudioFailure("AGE System | NPC Studio could not resolve its initial clone source through search.", error);
    }
    const exact = this.state.actorResults.find(actor => actor.uuid === actorUuid)
      ?? (this.state.actorResults.length === 1 ? this.state.actorResults[0] : null);
    if (exact) this.selectActor(exact.uuid);
    else {
      this.state.selectedActor = sourceResult({uuid: actorUuid, name: npcLabel("selectedActor", "Selected Actor")});
      this.state.selectedActor.selected = true;
    }
    this.state.announcement = npcLabel("cloneReady", "The Actor is ready to copy into a new draft.");
    return this.context();
  }

  recordError(error) {
    this.state.error = String(error?.message ?? error ?? npcLabel("operationFailed", "The operation failed."));
    this.state.announcement = npcLabel("operationFailedWithReason", "NPC Studio action failed: {reason}", {reason: this.state.error});
    return this.state.error;
  }

  clearError() {
    this.state.error = "";
  }

  setBusy(busy) {
    this.state.busy = Boolean(busy);
  }

  selectSource(mode) {
    if (!NPC_STUDIO_SOURCE_MODES.includes(mode)) throw npcStudioUiRejection(`Unsupported NPC Studio source: ${mode}`);
    this.state.sourceMode = mode;
    this.state.error = "";
    return mode;
  }

  setSourceField(field, value) {
    if (field === "pasteText") {
      const text = String(value ?? "");
      if (text.length > PASTE_CHARACTER_LIMIT) throw npcStudioUiRejection(npcLabel("pasteTooLarge", "Pasted text is too large."));
      this.state.pasteText = text;
    } else if (field === "parserMode") {
      if (!PARSER_MODES.some(mode => mode.id === value)) throw npcStudioUiRejection(`Unsupported NPC parser mode: ${value}`);
      this.state.parserMode = value;
    } else if (field === "actorQuery") this.state.actorQuery = String(value ?? "").slice(0, 256);
    else if (field === "itemQuery") this.state.itemQuery = String(value ?? "").slice(0, 256);
    else if (field === "itemType") this.state.itemType = String(value ?? "").slice(0, 64);
    else throw npcStudioUiRejection(`Unsupported NPC Studio source field: ${field}`);
    this.state.error = "";
  }

  async searchActors(query = this.state.actorQuery) {
    this.state.actorQuery = String(query ?? "").slice(0, 256);
    const response = await this.service.searchActors(this.state.actorQuery, {limit: SEARCH_RESULT_LIMIT});
    const rows = response?.results ?? response ?? [];
    this.state.actorResults = (Array.isArray(rows) ? rows : []).slice(0, SEARCH_RESULT_LIMIT).map(sourceResult);
    for (const actor of this.state.actorResults) actor.selected = actor.uuid === this.state.selectedActor?.uuid;
    this.state.announcement = npcLabel("actorResults", "{count} Actor result(s).", {count: this.state.actorResults.length});
    return this.state.actorResults;
  }

  selectActor(uuid) {
    const actor = this.state.actorResults.find(entry => entry.uuid === uuid);
    if (!actor) throw npcStudioUiRejection(npcLabel("actorUnavailable", "The selected Actor is no longer available."));
    this.state.selectedActor = {...actor, selected: true};
    for (const entry of this.state.actorResults) entry.selected = entry.uuid === uuid;
    this.state.announcement = npcLabel("actorSelected", "Selected {name} as the copy source.", {name: actor.name});
    return this.state.selectedActor;
  }

  async prepareDraft() {
    await this.cancelPreview();
    const options = {origin: this.state.sourceMode, profileId: profileId(this.state.profile)};
    if (this.state.sourceMode === "paste") {
      if (!this.state.pasteText.trim()) throw npcStudioUiRejection(npcLabel("pasteRequired", "Paste an NPC stat block first."));
      Object.assign(options, {text: this.state.pasteText, parserMode: this.state.parserMode});
    }
    if (this.state.sourceMode === "clone") {
      if (!this.state.selectedActor?.uuid) throw npcStudioUiRejection(npcLabel("cloneRequired", "Select an Actor to copy first."));
      options.actorUuid = this.state.selectedActor.uuid;
    }
    const response = await this.service.createDraft(options);
    this.state.draft = ensureDraft(response, this.state.profile);
    this.state.preview = null;
    this.state.previewFingerprint = "";
    this.state.result = null;
    this.state.undoPreview = null;
    this.state.step = "identity";
    this.state.error = "";
    this.state.announcement = npcLabel("draftReady", "Draft ready. Review the identity details.");
    return this.state.draft;
  }

  async cancelPreview() {
    const id = this.state.preview?.id;
    this.state.preview = null;
    this.state.previewFingerprint = "";
    if (!id) return false;
    try { return await this.service.cancel(id); }
    catch (error) {
      reportUnexpectedNpcStudioFailure("AGE System | NPC Studio could not cancel its stale preview.", error);
      return false;
    }
  }

  async cancelUndoPreview() {
    const id = this.state.undoPreview?.id;
    this.state.undoPreview = null;
    if (!id) return false;
    try { return await this.service.cancel(id); }
    catch (error) {
      reportUnexpectedNpcStudioFailure("AGE System | NPC Studio could not cancel its unused undo preview.", error);
      return false;
    }
  }

  invalidatePreview() {
    const id = this.state.preview?.id;
    this.state.preview = null;
    this.state.previewFingerprint = "";
    this.state.updatedAt = this.clock();
    if (id) Promise.resolve(this.service.cancel(id)).catch(error => {
      reportUnexpectedNpcStudioFailure("AGE System | NPC Studio could not cancel its stale preview.", error);
    });
  }

  updateDraftField(path, value) {
    if (!this.state.draft) throw npcStudioUiRejection(npcLabel("draftMissing", "Choose a source before editing the draft."));
    const abilityMatch = String(path ?? "").match(/^abilities\.([a-z][a-z0-9-]*)\.(value|primary)$/u);
    const abilityId = abilityMatch?.[1];
    if (!EDITABLE_PATHS.has(path) && !(abilityMatch && profileAbilityIds(this.state.profile, this.state.draft).includes(abilityId))) {
      throw npcStudioUiRejection(`Unsupported NPC Studio draft field: ${path}`);
    }
    if (!setPath(this.state.draft, path, value)) throw npcStudioUiRejection(`NPC Studio could not update ${path}.`);
    this.invalidatePreview();
    return true;
  }

  validateStep(step = this.state.step) {
    const errors = [];
    if (step === "source") {
      if (this.state.sourceMode === "paste" && !this.state.pasteText.trim()) errors.push(npcLabel("pasteRequired", "Paste an NPC stat block first."));
      if (this.state.sourceMode === "clone" && !this.state.selectedActor?.uuid) errors.push(npcLabel("cloneRequired", "Select an Actor to copy first."));
    }
    if (["identity", "statistics", "content", "review"].includes(step)) {
      if (!this.state.draft) errors.push(npcLabel("draftMissing", "Choose a source before editing the draft."));
      else if (!String(this.state.draft.identity?.name ?? "").trim()) errors.push(npcLabel("nameRequired", "Enter an Actor name."));
    }
    if (["content", "review"].includes(step) && this.state.draft?.items?.some(item => item.resolution?.mode === "pending")) {
      errors.push(npcLabel("resolutionRequired", "Choose one verified source or explicit custom creation for every duplicate match."));
    }
    if (["content", "review"].includes(step) && usesInjuryDamage(this.state.profile)) {
      const incompleteAttack = this.state.draft?.items?.find(item => item.include && item.type === "weapon"
        && item.origin === "custom" && item.resolution?.mode !== "pending"
        && (!Number.isInteger(item.custom?.damageInjury) || item.custom.damageInjury < 1 || item.custom.damageInjury > 40));
      if (incompleteAttack) {
        errors.push(npcLabel(
          "injuryDamageRequired",
          "Review and enter Injury damage from 1 to 40 for {name}.",
          {name: incompleteAttack.name},
        ));
      }
      const unconfirmedAttack = this.state.draft?.items?.find(item => item.include && item.type === "weapon"
        && item.origin === "custom" && item.resolution?.mode !== "pending"
        && item.custom?.damageInjuryConfirmed !== true);
      if (unconfirmedAttack) {
        errors.push(npcLabel(
          "injuryDamageConfirmationRequired",
          "Confirm the reviewed Injury damage for {name}.",
          {name: unconfirmedAttack.name},
        ));
      }
    }
    return errors;
  }

  async goToStep(step) {
    if (!NPC_STUDIO_STEPS.includes(step)) throw npcStudioUiRejection(`Unsupported NPC Studio step: ${step}`);
    if (step === "result" && !this.state.result) return false;
    if (step !== "source" && !this.state.draft) {
      if (step === "identity") await this.prepareDraft();
      else throw npcStudioUiRejection(npcLabel("draftMissing", "Choose a source before continuing."));
    }
    const targetIndex = NPC_STUDIO_STEPS.indexOf(step);
    const currentIndex = NPC_STUDIO_STEPS.indexOf(this.state.step);
    if (targetIndex > currentIndex) {
      const errors = this.validateStep(this.state.step);
      if (errors.length) throw npcStudioUiRejection(errors[0]);
    }
    if (step === "review") await this.refreshPreview();
    else this.state.step = step;
    this.state.error = "";
    return true;
  }

  async next() {
    if (this.state.step === "source") {
      await this.prepareDraft();
      return true;
    }
    if (this.state.step === "identity") return this.goToStep("statistics");
    if (this.state.step === "statistics") return this.goToStep("content");
    if (this.state.step === "content") return this.goToStep("review");
    if (this.state.step === "review") return this.commit();
    return false;
  }

  async back() {
    const index = NPC_STUDIO_STEPS.indexOf(this.state.step);
    if (index <= 0 || this.state.step === "result") return false;
    return this.goToStep(NPC_STUDIO_STEPS[index - 1]);
  }

  async searchItems(query = this.state.itemQuery) {
    if (!this.state.draft) throw npcStudioUiRejection(npcLabel("draftMissing", "Choose a source before searching content."));
    this.state.itemQuery = String(query ?? "").slice(0, 256);
    const response = await this.service.searchItems(this.state.itemQuery, {
      profileId: profileId(this.state.profile), type: this.state.itemType, limit: SEARCH_RESULT_LIMIT
    });
    const rows = response?.results ?? response ?? [];
    this.state.itemResults = (Array.isArray(rows) ? rows : []).map(libraryResult)
      .filter(item => LIBRARY_ITEM_TYPES.has(item.type) && (!this.state.itemType || item.type === this.state.itemType))
      .slice(0, SEARCH_RESULT_LIMIT);
    const selected = new Set(this.state.draft.items.map(boundSourceUuid).filter(Boolean));
    for (const item of this.state.itemResults) item.selected = selected.has(item.uuid);
    this.state.announcement = npcLabel("itemResults", "{count} Item result(s).", {count: this.state.itemResults.length});
    return this.state.itemResults;
  }

  toggleLibraryItem(uuid) {
    if (!this.state.draft) throw npcStudioUiRejection(npcLabel("draftMissing", "Choose a source before selecting content."));
    const result = this.state.itemResults.find(entry => entry.uuid === uuid);
    if (!result) throw npcStudioUiRejection(npcLabel("itemUnavailable", "The selected Item is no longer available."));
    const index = this.state.draft.items.findIndex(item => boundSourceUuid(item) === uuid);
    if (index >= 0) this.state.draft.items.splice(index, 1);
    else {
      if (this.state.draft.items.length >= SELECTED_ITEM_LIMIT) throw npcStudioUiRejection(npcLabel("itemLimit", "The draft has reached its Item limit."));
      this.state.draft.items.push(libraryUsageEntry(
        result,
        profileAbilityIds(this.state.profile, this.state.draft),
        this.state.profile?.talentDegrees,
      ));
    }
    result.selected = index < 0;
    this.invalidatePreview();
    return result.selected;
  }

  attachLibraryItem(entry) {
    if (!this.state.draft) throw npcStudioUiRejection(npcLabel("draftMissing", "Choose a source before selecting content."));
    const result = libraryResult(entry);
    if (!result.uuid || !LIBRARY_ITEM_TYPES.has(result.type)) {
      throw npcStudioUiRejection(npcLabel("dropInvalid", "Drop a supported AGE Item from the Items directory or a visible compendium."));
    }
    let listed = this.state.itemResults.find(item => item.uuid === result.uuid);
    if (!listed) {
      listed = result;
      this.state.itemResults.unshift(listed);
      this.state.itemResults = this.state.itemResults.slice(0, SEARCH_RESULT_LIMIT);
    }
    const existing = this.state.draft.items.find(item => boundSourceUuid(item) === result.uuid);
    if (existing) {
      listed.selected = true;
      this.state.announcement = npcLabel("dropAlreadySelected", "{name} is already selected.", {name: result.name});
      return false;
    }
    if (this.state.draft.items.length >= SELECTED_ITEM_LIMIT) throw npcStudioUiRejection(npcLabel("itemLimit", "The draft has reached its Item limit."));
    this.state.draft.items.push(libraryUsageEntry(
      result,
      profileAbilityIds(this.state.profile, this.state.draft),
      this.state.profile?.talentDegrees,
    ));
    listed.selected = true;
    this.invalidatePreview();
    this.state.announcement = npcLabel("dropAdded", "Added {name} from the Item library.", {name: result.name});
    return true;
  }

  addCustomEntry(kind) {
    if (!this.state.draft) throw npcStudioUiRejection(npcLabel("draftMissing", "Choose a source before adding content."));
    const customCount = this.state.draft.items.filter(item => item.origin === "custom").length;
    if (customCount >= CUSTOM_ENTRY_LIMIT) throw npcStudioUiRejection(npcLabel("customLimit", "The draft has reached its custom-entry limit."));
    if (this.state.draft.items.length >= SELECTED_ITEM_LIMIT) throw npcStudioUiRejection(npcLabel("itemLimit", "The draft has reached its Item limit."));
    const entry = customEntry(kind, profileAbilityIds(this.state.profile, this.state.draft), {
      injuryDamage: usesInjuryDamage(this.state.profile),
    });
    this.state.draft.items.push(entry);
    this.invalidatePreview();
    return entry;
  }

  updateEntry(id, field, value) {
    const item = this.state.draft?.items?.find(entry => entry.entryId === id);
    if (!item) throw npcStudioUiRejection(npcLabel("itemUnavailable", "The selected Item is no longer available."));
    if (field === "resolutionMode" || field === "resolutionSource") {
      if (item.resolution?.status !== "matched" || !item.custom) {
        throw npcStudioUiRejection(npcLabel("itemUnavailable", "This Item has no verified library alternative."));
      }
      const requested = String(value ?? "");
      const selectedSource = requested === "reuse"
        ? item.resolution.alternatives?.find(source => source.sourceUuid === item.resolution.sourceUuid)
          ?? (item.resolution.alternatives?.length === 1 ? item.resolution.alternatives[0] : null)
        : item.resolution.alternatives?.find(source => source.sourceUuid === requested);
      if (selectedSource) {
        item.origin = "library";
        item.sourceUuid = selectedSource.sourceUuid;
        item.resolution.mode = "reuse";
        Object.assign(item.resolution, selectedSource);
        if (item.type === "talent") item.custom.subtype = item.resolution.sourceSubtype;
      } else if (requested === "custom") {
        item.origin = "custom";
        item.sourceUuid = null;
        item.resolution.mode = "custom";
        Object.assign(item.resolution, {sourceUuid: null, sourceName: "", sourceKind: "", sourceLabel: "", sourceSubtype: ""});
        if (item.type === "weapon" && usesInjuryDamage(this.state.profile) && !Number.isInteger(item.custom.damageInjury)) {
          item.custom.damageInjury = suggestInjuryDamageFromFormula(item.custom.damageFormula);
        }
        if (item.type === "weapon" && usesInjuryDamage(this.state.profile)) item.custom.damageInjuryConfirmed = false;
      } else throw npcStudioUiRejection(npcLabel("resolutionUnavailable", "Choose either the verified source or bounded custom creation."));
      this.invalidatePreview();
      return true;
    }
    if (!EDITABLE_ITEM_FIELDS.has(field) && !EDITABLE_CUSTOM_FIELDS.has(field)) throw npcStudioUiRejection(`Unsupported NPC Studio Item field: ${field}`);
    if (EDITABLE_CUSTOM_FIELDS.has(field)) {
      const overlayAllowed = item.resolution?.mode === "reuse" && MATCHED_OVERLAY_FIELDS[item.type]?.has(field);
      if ((item.origin !== "custom" && !overlayAllowed) || !item.custom) {
        throw npcStudioUiRejection(npcLabel("itemUnavailable", "Only custom or signed overlay fields are editable."));
      }
      item.custom[field] = value;
      if (field === "damageFormula" && item.type === "weapon" && usesInjuryDamage(this.state.profile)) {
        item.custom.damageInjury = suggestInjuryDamageFromFormula(value);
        item.custom.damageInjuryConfirmed = false;
      }
      if (field === "damageInjury" && item.type === "weapon" && usesInjuryDamage(this.state.profile)) {
        item.custom.damageInjuryConfirmed = false;
      }
    } else item[field] = value;
    this.invalidatePreview();
    return true;
  }

  removeEntry(id) {
    if (!this.state.draft) return false;
    const before = this.state.draft.items.length;
    this.state.draft.items = this.state.draft.items.filter(entry => entry.entryId !== id);
    if (this.state.draft.items.length === before) return false;
    for (const result of this.state.itemResults) result.selected = this.state.draft.items.some(entry => boundSourceUuid(entry) === result.uuid);
    this.invalidatePreview();
    return true;
  }

  async refreshPreview() {
    const errors = this.validateStep("content");
    if (errors.length) throw npcStudioUiRejection(errors[0]);
    await this.cancelPreview();
    const fingerprint = draftFingerprint(this.state.draft);
    const preview = await this.service.preview(deepClone(this.state.draft));
    if (!preview?.id) throw new Error(npcLabel("unsignedPreview", "The service did not return a signed preview."));
    this.state.preview = deepClone(preview);
    this.state.previewFingerprint = fingerprint;
    this.state.step = "review";
    this.state.result = null;
    this.state.error = "";
    this.state.announcement = npcLabel("previewReady", "Signed review ready.");
    return this.state.preview;
  }

  get previewFresh() {
    const expiresAt = Number(this.state.preview?.expiresAt);
    const unexpired = Number.isFinite(expiresAt) && expiresAt > this.clock();
    return Boolean(unexpired && this.state.preview?.id && this.state.previewFingerprint
      && this.state.previewFingerprint === draftFingerprint(this.state.draft));
  }

  get blockers() {
    return issueModels(this.state.preview, "error");
  }

  get commitReady() {
    if (this.state.step !== "review" || !this.previewFresh || this.blockers.length) return false;
    if (this.state.preview?.fresh === false || this.state.preview?.valid === false || this.state.preview?.canCommit === false) return false;
    return true;
  }

  get canCommit() {
    return !this.state.busy && this.commitReady;
  }

  async commit() {
    // The application action wrapper marks the controller busy before entering
    // this method. Keep that state in the button model, but do not let the
    // wrapper's own in-flight guard invalidate an otherwise eligible preview.
    if (!this.commitReady) throw npcStudioUiRejection(npcLabel("commitBlocked", "Refresh the signed review and resolve every blocker before creating the Actor."));
    const preview = this.state.preview;
    const result = await this.service.commit(preview.id, {
      inputDigest: preview.inputDigest,
      snapshotDigest: preview.snapshotDigest,
      planDigest: preview.planDigest
    });
    const actor = createdActor(result);
    if (!actor) throw new Error(npcLabel("actorMissing", "The service did not return the created Actor."));
    this.state.result = {actor, receiptId: receiptId(result), receipt: deepClone(result?.receipt ?? null), undone: false};
    this.state.preview = null;
    this.state.previewFingerprint = "";
    this.state.step = "result";
    this.state.undoPreview = null;
    let undoNotice = "";
    if (this.state.result.receiptId) {
      try { this.state.undoPreview = await this.service.previewUndo(this.state.result.receiptId); }
      catch (error) {
        reportUnexpectedNpcStudioFailure("AGE System | NPC Studio undo preview is unavailable.", error);
        undoNotice = npcLabel("undoPreviewUnavailable", "Safe undo is currently unavailable: {reason}", {
          reason: error?.message ?? String(error),
        });
      }
    }
    this.state.announcement = [npcLabel("actorCreated", "Created {name}.", {name: actor.name}), undoNotice].filter(Boolean).join(" ");
    return this.state.result;
  }

  async undo({confirmed = false} = {}) {
    const receipt = this.state.result?.receiptId;
    if (!receipt || !confirmed) throw npcStudioUiRejection(npcLabel("undoConfirmationRequired", "Confirm the safe undo before continuing."));
    const preview = this.state.undoPreview ?? await this.service.previewUndo(receipt);
    if (preview?.allowed === false || (Array.isArray(preview?.blockers) && preview.blockers.length)) {
      throw npcStudioUiRejection(preview?.reason ?? preview?.blockers?.[0]?.message ?? npcLabel("undoBlocked", "This Actor can no longer be safely undone."));
    }
    await this.service.undo(receipt, {confirmed: true, preview});
    this.state.result.undone = true;
    this.state.undoPreview = null;
    this.state.announcement = npcLabel("actorUndone", "The created Actor was safely removed.");
    return true;
  }

  async createAnother() {
    await this.cancelPreview();
    await this.cancelUndoPreview();
    this.state.step = "source";
    this.state.sourceMode = "blank";
    this.state.pasteText = "";
    this.state.actorQuery = "";
    this.state.actorResults = [];
    this.state.selectedActor = null;
    this.state.itemQuery = "";
    this.state.itemResults = [];
    this.state.draft = null;
    this.state.result = null;
    this.state.undoPreview = null;
    this.state.error = "";
    this.state.announcement = npcLabel("readyAnother", "Choose a source for another NPC.");
    return true;
  }

  async cancel() {
    await this.cancelPreview();
    await this.cancelUndoPreview();
    return true;
  }

  context() {
    const state = this.state;
    const profile = state.profile ?? normalizedProfile({});
    const abilities = profileAbilityIds(profile, state.draft).map(id => ({
      id,
      label: localize(`age-system.${id}`, id.toLocaleUpperCase()),
      value: state.draft?.abilities?.[id]?.value ?? 0,
      primary: Boolean(state.draft?.abilities?.[id]?.primary),
      supportsPrimary: Boolean(profile.primaryAbilities)
    }));
    const abilityOptions = abilities.map(({id, label}) => ({id, label}));
    const profileHealthSystem = String(profile.healthSystem ?? profile.health?.system ?? "");
    const isDage = profile.id === "dage";
    const isFage1 = profile.id === "fage-1e";
    const identityAncestry = isDage || isFage1 ? "race" : "ancestry";
    const identityOccupation = isDage || profile.id.startsWith("fage-") ? "class" : "profession";
    const labels = npcStudioLabels();
    const profileView = {
      ...profile,
      id: profileId(profile),
      label: profile.localizedLabel,
      ancestryLabel: npcLabel(identityAncestry, identityAncestry),
      occupationLabel: npcLabel(identityOccupation === "class" ? "classLabel" : identityOccupation, identityOccupation),
      healthLabel: profileHealthSystem === "mageInjury"
        ? npcLabel("healthBaseline", "Health baseline")
        : localize("age-system.health", "Health"),
      powerLabel: npcLabel(isDage ? "manaPoints" : profile.id.startsWith("fage-") ? "magicPoints" : "powerPoints", "Power Points"),
      showToughness: profileHealthSystem.includes("mage"),
      showBallistic: profileHealthSystem.includes("mage"),
      showInjuryDamage: usesInjuryDamage(profile),
      showPowerPoints: profile.usePowerPoints === true,
      showConviction: profile.useConviction === true,
      showFatigue: profile.useFatigue === true,
      showPrimary: profile.primaryAbilities === true
    };
    const blockers = this.blockers;
    const warnings = issueModels(state.preview, "warning");
    const selectedItems = (state.draft?.items ?? []).map(item => ({
      ...item,
      id: item.entryId,
      image: item.img,
      source: item.resolution?.status === "matched" && item.resolution.sourceName
        ? `${item.resolution.sourceName} · ${item.resolution.sourceLabel}`
        : item.origin === "custom" ? npcLabel("customSource", "Custom") : item.origin,
      isCustom: item.origin === "custom",
      isLibrary: item.origin === "library",
      hasMatch: item.resolution?.status === "matched",
      resolutionPending: item.resolution?.mode === "pending",
      resolutionAlternatives: (item.resolution?.alternatives ?? []).map(source => ({
        ...source,
        value: source.sourceUuid,
        label: `${source.sourceName} · ${source.sourceLabel}`,
        selected: item.resolution?.mode === "reuse" && item.resolution?.sourceUuid === source.sourceUuid,
      })),
      noMatch: item.resolution?.status === "unmatched",
      usesMatchedSource: item.resolution?.status === "matched" && item.resolution.mode === "reuse",
      usesCustomChoice: item.resolution?.status === "matched" && item.resolution.mode === "custom",
      isAttack: item.type === "weapon",
      showInjuryDamage: item.type === "weapon" && item.origin === "custom" && usesInjuryDamage(profile),
      isFocus: item.type === "focus",
      isPower: item.type === "power",
      isTalent: item.type === "talent",
      isSpecialization: item.type === "talent" && item.custom?.subtype === "spec",
      isStunt: item.type === "stunts",
      isEquipment: item.type === "equipment",
      isRelationship: item.type === "relationship",
      isMembership: item.type === "membership",
      isHonorific: item.type === "honorifics",
      custom: item.custom ?? {},
      abilityOptions: abilityOptions.map(option => ({...option, selected: option.id === item.custom?.ability})),
      degreeOptions: talentDegreeOptions(profile, item.custom?.degree),
    }));
    const activeIndex = NPC_STUDIO_STEPS.indexOf(state.step);
    const steps = NPC_STUDIO_STEPS.map((id, index) => ({
      id,
      number: index + 1,
      label: npcLabel(`step${id[0].toUpperCase()}${id.slice(1)}`, id),
      current: id === state.step,
      complete: index < activeIndex,
      available: index <= activeIndex || (id === "result" && Boolean(state.result))
    }));
    const customCount = selectedItems.filter(item => item.isCustom).length;
    const sourceModes = NPC_STUDIO_SOURCE_MODES.map(id => ({
      id,
      selected: state.sourceMode === id,
      label: npcLabel(`source${id[0].toUpperCase()}${id.slice(1)}`, id),
      hint: npcLabel(`source${id[0].toUpperCase()}${id.slice(1)}Hint`, "")
    }));
    const canContinue = this.validateStep(state.step).length === 0 && !state.busy;
    const undoAllowed = Boolean(state.result?.receiptId && !state.result?.undone
      && state.undoPreview && state.undoPreview.allowed !== false
      && !(state.undoPreview.blockers?.length));
    return {
      initialized: state.initialized,
      busy: state.busy,
      activeStep: state.step,
      sourceMode: state.sourceMode,
      sourcePaste: state.sourceMode === "paste",
      sourceBlank: state.sourceMode === "blank",
      sourceClone: state.sourceMode === "clone",
      stepSource: state.step === "source",
      stepIdentity: state.step === "identity",
      stepStatistics: state.step === "statistics",
      stepContent: state.step === "content",
      stepReview: state.step === "review",
      stepResult: state.step === "result",
      steps,
      sourceModes,
      parserModes: PARSER_MODES
        .filter(mode => !profile.parserModes?.length || profile.parserModes.includes(mode.id))
        .map(mode => ({...mode, label: npcLabel(mode.label, mode.id), selected: mode.id === state.parserMode})),
      pasteText: state.pasteText,
      pasteCharacters: state.pasteText.length,
      pasteCharacterLimit: PASTE_CHARACTER_LIMIT,
      actorQuery: state.actorQuery,
      actorResults: state.actorResults,
      hasActorResults: state.actorResults.length > 0,
      selectedActor: state.selectedActor,
      itemQuery: state.itemQuery,
      itemType: state.itemType,
      itemResults: state.itemResults,
      hasItemResults: state.itemResults.length > 0,
      draft: state.draft,
      hasDraft: Boolean(state.draft),
      profile: profileView,
      abilities,
      abilityOptions,
      selectedItems,
      hasSelectedItems: selectedItems.length > 0,
      customKinds: CUSTOM_KINDS.map(kind => ({...kind, label: npcLabel(kind.label, kind.id)})),
      customCount,
      customRemaining: Math.max(0, CUSTOM_ENTRY_LIMIT - customCount),
      itemRemaining: Math.max(0, SELECTED_ITEM_LIMIT - selectedItems.length),
      customLimitReached: customCount >= CUSTOM_ENTRY_LIMIT || selectedItems.length >= SELECTED_ITEM_LIMIT,
      preview: state.step === "review" ? state.preview : null,
      previewChanges: state.step === "review" ? previewChanges(state.preview) : [],
      reviewSections: state.step === "review" ? previewReviewSections(state.preview, profileView, labels) : [],
      previewFresh: this.previewFresh,
      blockers,
      warnings,
      hasBlockers: blockers.length > 0,
      hasWarnings: warnings.length > 0,
      canCommit: this.canCommit,
      canContinue,
      canBack: activeIndex > 0 && state.step !== "result" && !state.busy,
      result: state.result,
      undoPreview: state.undoPreview,
      undoAllowed,
      error: state.error,
      announcement: state.announcement,
      labels
    };
  }
}

function npcStudioLabels() {
  const values = {
    kicker: "Guided NPC creation", title: "NPC Studio", subtitle: "Create a new AGE Actor from pasted text, a blank draft, or a safe copy.",
    stepsAria: "NPC Studio steps", step: "Step",
    activeProfile: "Active profile", sourceHeading: "Choose a source", sourceIntro: "Nothing is written until you approve a signed review.",
    pasteLabel: "NPC stat block", pasteHint: "Paste one supported AGE stat block. PDF cleanup happens during draft creation.",
    parserHint: "Choose the layout that matches the source stat block.", blankHeading: "Start with a clean canonical draft", blankHint: "NPC Studio will add the active profile's ability and resource fields for you.",
    parserMode: "Parser format", actorSearch: "Search Actors", actorSearchHint: "Choose an Actor as a read-only source. The original will never be updated.",
    search: "Search", selectedSource: "Copy source", selectedActor: "Selected Actor", noActorResults: "No matching Actors.", actorResultsLabel: "Actor search results",
    identityHeading: "Identity", identityIntro: "Name the NPC and confirm its presentation.", name: "Actor name", kind: "Role",
    adversary: "Adversary", monster: "Monster", npc: "NPC", ally: "Ally", threat: "Threat or rank", level: "Level",
    ancestry: "Ancestry", race: "Race", profession: "Profession", classLabel: "Class", background: "Background", portrait: "Portrait path", compactSheet: "Use compact stat-block sheet", cloneNotice: "A new Actor will be created. The source Actor is never modified.",
    statisticsHeading: "Statistics", statisticsIntro: "Enter final totals; the service validates canonical AGE source fields.", abilities: "Abilities", derivedStatistics: "Derived statistics", profileResources: "Profile resources",
    primary: "Primary", current: "current", maximum: "maximum", healthCurrent: "Current Health", healthBaseline: "Health baseline", defense: "Defense", defenseBase: "Defense base", defenseModeBonus: "Defense mode bonus", speed: "Speed", speedBase: "Speed base", toughness: "Toughness", toughnessModeBonus: "Toughness mode bonus", impactArmor: "Impact armor", ballisticArmor: "Ballistic armor",
    initiativeMod: "Initiative modifier", attackMod: "All attacks", testMod: "All tests", damageMod: "All damage", resources: "Resources", conviction: "Conviction",
    contentHeading: "Content", contentIntro: "Attach verified library Items or add bounded custom entries.", itemSearch: "Search Items",
    libraryHint: "Search enabled AGE compendiums and world Items.", itemResultsLabel: "Item search results",
    dropItems: "Drop an Item here", dropItemsHint: "Drag a supported Item from the Items directory or a visible compendium.",
    itemType: "Item type", allItemTypes: "All Item types", focus: "Focus", weapon: "Weapon", power: "Power", talent: "Talent",
    stunts: "Stunt", equipment: "Equipment", specialization: "Specialization", relationship: "Relationship", membership: "Membership", honorific: "Honorific",
    noItemResults: "No matching Items.", selectedContent: "Selected content",
    customEntries: "Custom entries", customSource: "Custom", add: "Add", remove: "Remove", itemName: "Name", description: "Description", ability: "Ability",
    bonus: "Bonus", damage: "Damage formula", damageInjury: "Injury damage", damageSource: "Damage source", targetNumber: "Target number", powerPointCost: "Power Point cost",
    injuryDamageHint: "Suggested from the formula. Review and adjust it to match the printed stat block.", injuryDamageRequired: "Review and enter Injury damage from 1 to 40 for {name}.",
    injuryDamageConfirm: "I reviewed and confirm this Injury damage", injuryDamageConfirmed: "Injury damage confirmed", injuryDamageConfirmationRequired: "Confirm the reviewed Injury damage for {name}.",
    degree: "Degree", talentSubtype: "Talent kind", intensity: "Intensity", rank: "Rank", stuntCost: "SP cost", equipped: "Equipped", notes: "Stat-block notes", features: "Features / special qualities", libraryCopyHint: "This library Item will be copied into the new Actor.", noSelectedContent: "No content selected yet.",
    resolutionChoice: "Creation choice", reuseExisting: "Use verified existing Item", createCustomInstead: "Create bounded custom Item instead", chooseExactSource: "Choose one verified exact source", matchedSource: "Matched source", exactSources: "Verified exact sources", exactMatchFound: "Verified exact sources are listed world-first, then visible compendiums in stable order.", noExactMatch: "No exact visible library match; a bounded custom Item will be created.", resolutionRequired: "Choose one verified source or explicit custom creation for every duplicate match.", resolutionUnavailable: "That resolution choice is unavailable.",
    traits: "Traits / movement", goals: "Goals / motivation", gmNotes: "Secret GM notes", reviewHeading: "Signed review",
    reviewIntro: "This is the only step that requests a signed preview. Nothing has been created yet.", signed: "Signed preview", commitSafety: "Create is enabled only while this signed preview is fresh and has no blockers.",
    fresh: "Fresh", stale: "Stale", blockers: "Blockers", warnings: "Warnings", changes: "Planned changes", noChanges: "No change rows were returned.",
    before: "Before", after: "After", refreshReview: "Refresh review", createActor: "Create Actor", resultHeading: "Actor created",
    resultIntro: "The transaction completed successfully.", openActor: "Open Actor", createAnother: "Create another", undo: "Undo creation", undoAvailable: "Safe undo is available", undoHint: "Undo removes only this newly created Actor while its receipt remains conflict-free.",
    undone: "Creation safely undone", back: "Back", continue: "Continue", close: "Close", working: "Working…", status: "NPC Studio status",
    fatigue: "Fatigue", manaPoints: "Mana Points", magicPoints: "Magic Points",
    summaryName: "Actor name", summaryDefense: "Defense", summarySpeed: "Speed", summaryHealth: "Health", summaryToughness: "Toughness", summaryImpactArmor: "Impact armor", summaryBallisticArmor: "Ballistic armor",
    errorHeading: "NPC Studio needs attention", empty: "—", customRemaining: "Custom slots remaining", itemRemaining: "Item slots remaining",
    yes: "Yes", no: "No", actorLink: "Linked token", disposition: "Disposition", tokenWidth: "Token width", tokenHeight: "Token height", tokenImage: "Token image", reviewToken: "Prototype token", reviewOrigin: "Source"
  };
  return Object.fromEntries(Object.entries(values).map(([key, fallback]) => [key, npcLabel(key, fallback)]));
}

const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2 ?? class {};
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin ?? (Base => Base);
const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;

export class AgeNpcStudio extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "age-npc-studio",
    classes: ["age-system", "age-npc-studio"],
    position: {width: 980, height: 820},
    window: {title: "NPC Studio", resizable: true, minimizable: true}
  };

  static PARTS = {
    main: {
      template: "systems/age-system/templates/npc-studio.hbs",
      scrollable: [".age-npc-studio__scroll"]
    }
  };

  constructor(options = {}) {
    const {controller = null, service = null, origin = "", actorUuid = "", ...applicationOptions} = options;
    super(applicationOptions);
    this.controller = controller ?? new AgeNpcStudioController({service});
    this.initialSource = {origin, actorUuid};
    this._focusAfterRender = "";
    this._expiryTimer = null;
  }

  static async open(options = {}) {
    const app = new this(options);
    await app.controller.initialize();
    await app.controller.initializeSource(app.initialSource);
    await app.render({force: true});
    return app;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (!this.controller.state.initialized) await this.controller.initialize();
    return Object.assign(context, this.controller.context());
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.element?.addEventListener("click", event => this.#onClick(event));
    this.element?.addEventListener("change", event => this.#onChange(event));
    this.element?.addEventListener("input", event => this.#onInput(event));
    this.element?.addEventListener("keydown", event => this.#onKeydown(event));
    this.element?.addEventListener("dragover", event => this.#onDragOver(event));
    this.element?.addEventListener("dragleave", event => this.#onDragLeave(event));
    this.element?.addEventListener("drop", event => this.#onDrop(event));
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (this._expiryTimer) clearTimeout(this._expiryTimer);
    this._expiryTimer = null;
    const previewId = this.controller.state.preview?.id;
    const expiresAt = Number(this.controller.state.preview?.expiresAt);
    if (previewId && this.controller.previewFresh && Number.isFinite(expiresAt)) {
      const delay = Math.max(0, Math.min(2_147_483_000, expiresAt - this.controller.clock() + 25));
      this._expiryTimer = setTimeout(() => {
        this._expiryTimer = null;
        if (this.controller.state.preview?.id === previewId) this.render({force: true});
      }, delay);
    }
    const selector = this._focusAfterRender;
    this._focusAfterRender = "";
    if (!selector) return;
    const focus = () => this.element?.querySelector?.(selector)?.focus?.({preventScroll: false});
    if (globalThis.requestAnimationFrame) requestAnimationFrame(focus);
    else focus();
  }

  async _onClose(options) {
    if (this._expiryTimer) clearTimeout(this._expiryTimer);
    this._expiryTimer = null;
    await this.controller.cancel();
    if (super._onClose) await super._onClose(options);
  }

  async #perform(operation, {focusStep = ""} = {}) {
    if (this.controller.state.busy) return null;
    this.controller.setBusy(true);
    this.controller.clearError();
    await this.render({force: true});
    try {
      const result = await operation();
      if (focusStep) this._focusAfterRender = `[data-npc-studio-heading="${focusStep}"]`;
      return result;
    } catch (error) {
      this.controller.recordError(error);
      this._focusAfterRender = "[data-npc-studio-error]";
      reportNpcStudioActionFailure(error);
      return null;
    } finally {
      this.controller.setBusy(false);
      await this.render({force: true});
    }
  }

  #onInput(event) {
    const target = event.target;
    if (target?.dataset?.sourceField) {
      try { this.controller.setSourceField(target.dataset.sourceField, target.value); }
      catch (error) { this.controller.recordError(error); }
      return;
    }
    if (target?.dataset?.draftField) {
      try { this.controller.updateDraftField(target.dataset.draftField, coerceInput(target)); }
      catch (error) { this.controller.recordError(error); }
      return;
    }
    if (target?.dataset?.itemField) {
      try { this.controller.updateEntry(target.dataset.itemId, target.dataset.itemField, coerceInput(target)); }
      catch (error) { this.controller.recordError(error); }
    }
  }

  #onChange(event) {
    const target = event.target;
    if (target?.dataset?.sourceMode) {
      this.controller.selectSource(target.value);
      return this.render({force: true});
    }
    if (target?.dataset?.sourceField || target?.dataset?.draftField || target?.dataset?.itemField) {
      this.#onInput(event);
      return this.render({force: true});
    }
  }

  #onKeydown(event) {
    const source = event.target?.closest?.("[data-source-mode]");
    if (source && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const radios = Array.from(this.element?.querySelectorAll?.("[data-source-mode]") ?? []);
      let index = radios.indexOf(source);
      if (event.key === "Home") index = 0;
      else if (event.key === "End") index = radios.length - 1;
      else index = (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + radios.length) % radios.length;
      radios[index]?.focus?.();
      radios[index]?.click?.();
      return;
    }
    const step = event.target?.closest?.("[data-step]");
    if (step && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const steps = Array.from(this.element?.querySelectorAll?.("[data-step]:not(:disabled)") ?? []);
      let index = steps.indexOf(step);
      if (event.key === "Home") index = 0;
      else if (event.key === "End") index = steps.length - 1;
      else index = (index + (event.key === "ArrowRight" ? 1 : -1) + steps.length) % steps.length;
      steps[index]?.focus?.();
      return;
    }
    if (event.key === "Enter" && event.target?.matches?.("[data-source-field='actorQuery']")) {
      event.preventDefault();
      return this.#perform(() => this.controller.searchActors());
    }
    if (event.key === "Enter" && event.target?.matches?.("[data-source-field='itemQuery']")) {
      event.preventDefault();
      return this.#perform(() => this.controller.searchItems());
    }
  }

  #onDragOver(event) {
    const target = event.target?.closest?.("[data-npc-studio-item-drop]");
    if (!target || this.controller.state.busy) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    target.classList?.add?.("is-dragover");
  }

  #onDragLeave(event) {
    const target = event.target?.closest?.("[data-npc-studio-item-drop]");
    if (!target || target.contains?.(event.relatedTarget)) return;
    target.classList?.remove?.("is-dragover");
  }

  async #onDrop(event) {
    const target = event.target?.closest?.("[data-npc-studio-item-drop]");
    if (!target || this.controller.state.busy) return;
    event.preventDefault();
    target.classList?.remove?.("is-dragover");
    return this.#perform(async () => {
      const uuid = itemUuidFromDrop(event);
      if (!uuid) throw npcStudioUiRejection(npcLabel("dropInvalid", "Drop a supported AGE Item from the Items directory or a visible compendium."));
      const resolver = globalThis.foundry?.utils?.fromUuid ?? globalThis.fromUuid;
      if (!(resolver instanceof Function)) throw npcStudioUiRejection(npcLabel("dropUnavailable", "Foundry cannot resolve the dropped Item."));
      const item = await resolver(uuid);
      if (!item || documentName(item) !== "Item" || !LIBRARY_ITEM_TYPES.has(String(item.type ?? ""))) {
        throw npcStudioUiRejection(npcLabel("dropInvalid", "Drop a supported AGE Item from the Items directory or a visible compendium."));
      }
      const packId = item.pack ?? (String(item.uuid ?? uuid).startsWith("Compendium.")
        ? String(item.uuid ?? uuid).split(".").slice(1, 3).join(".") : "");
      const pack = packId ? globalThis.game?.packs?.get?.(packId) : null;
      if (pack?.visible === false) throw npcStudioUiRejection(npcLabel("dropUnavailable", "The dropped Item is not visible to this user."));
      const system = item.system ?? item._source?.system ?? {};
      this.controller.attachLibraryItem({
        uuid: String(item.uuid ?? uuid),
        name: String(item.name ?? npcLabel("unnamedItem", "Unnamed Item")),
        type: String(item.type),
        img: String(item.img ?? "icons/svg/item-bag.svg"),
        source: String(pack?.metadata?.label ?? pack?.title ?? (packId ? packId : npcLabel("worldItems", "World Items"))),
        sourceKind: packId ? "compendium" : "world",
        subtype: item.type === "talent" && system.type === "spec" ? "spec" : (item.type === "talent" ? "talent" : ""),
        degree: system.degree,
        ability: system.useAbl,
        bonus: system.initialValue,
      });
    });
  }

  async #onClick(event) {
    const button = event.target?.closest?.("[data-action]");
    if (!button || button.disabled) return;
    event.preventDefault();
    const action = button.dataset.action;
    if (action === "close") return this.close();
    if (action === "next") return this.#perform(() => this.controller.next(), {focusStep: NPC_STUDIO_STEPS[NPC_STUDIO_STEPS.indexOf(this.controller.state.step) + 1]});
    if (action === "back") return this.#perform(() => this.controller.back());
    if (action === "go-step") return this.#perform(() => this.controller.goToStep(button.dataset.step), {focusStep: button.dataset.step});
    if (action === "search-actors") return this.#perform(() => this.controller.searchActors());
    if (action === "select-actor") {
      this.controller.selectActor(button.dataset.uuid);
      return this.render({force: true});
    }
    if (action === "search-items") return this.#perform(() => this.controller.searchItems());
    if (action === "toggle-item") {
      this.controller.toggleLibraryItem(button.dataset.uuid);
      return this.render({force: true});
    }
    if (action === "add-custom") {
      this.controller.addCustomEntry(button.dataset.kind);
      return this.render({force: true});
    }
    if (action === "remove-entry") {
      this.controller.removeEntry(button.dataset.itemId);
      return this.render({force: true});
    }
    if (action === "refresh-preview") return this.#perform(() => this.controller.refreshPreview(), {focusStep: "review"});
    if (action === "commit") return this.#perform(() => this.controller.commit(), {focusStep: "result"});
    if (action === "open-actor") {
      const document = this.controller.state.result?.actor?.document
        ?? await (globalThis.fromUuid ?? globalThis.foundry?.utils?.fromUuid)?.(button.dataset.uuid);
      return document?.sheet?.render?.(true);
    }
    if (action === "create-another") return this.#perform(() => this.controller.createAnother(), {focusStep: "source"});
    if (action === "undo") {
      const confirmed = DialogV2?.confirm instanceof Function
        ? await DialogV2.confirm({
            window: {title: npcLabel("undoTitle", "Undo NPC creation")},
            content: `<p>${npcLabel("undoConfirm", "Remove the newly created Actor? This is allowed only while the signed receipt is still safe.")}</p>`,
            modal: true,
            rejectClose: false,
            yes: {label: npcLabel("undo", "Undo creation"), icon: "fa-solid fa-rotate-left"},
            no: {label: npcLabel("cancel", "Cancel"), icon: "fa-solid fa-xmark"}
          })
        : false;
      if (confirmed) return this.#perform(() => this.controller.undo({confirmed: true}), {focusStep: "result"});
    }
  }
}

export default AgeNpcStudio;
