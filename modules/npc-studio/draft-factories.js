import {normalizePdfClipboardText} from "../automation/import-normalization.js";
import {suggestInjuryDamageFromFormula} from "../injury-damage.js";
import {
  AGE_NPC_STUDIO_DRAFT_VERSION,
  AGE_NPC_STUDIO_ITEM_TYPES,
  AGE_NPC_STUDIO_LIMITS,
  assertNpcStudioDraftV1,
  npcStudioError,
} from "./contracts.js";
import {
  manualNpcStudioResolution,
  parseNpcStudioTalentLabel,
  resolveNpcStudioParsedItems,
} from "./item-resolution.js";
import {assertNpcStudioParserMode, npcStudioProfileSnapshot} from "./profile-adapter.js";

const ITEM_TYPES = new Set(AGE_NPC_STUDIO_ITEM_TYPES);
const EXCLUDED_CLONE_ITEM_TYPES = new Set(["class", "progression"]);

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function idFrom(factory, prefix) {
  const id = factory?.(prefix);
  if (typeof id !== "string" || !id.trim()) throw npcStudioError("AGE_NPC_STUDIO_ID", `NPC Studio could not allocate a ${prefix} id.`);
  return id.trim().slice(0, 128);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsedInjuryDamage(formula, ...candidates) {
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value >= 1 && value <= 40) return value;
  }
  return suggestInjuryDamageFromFormula(formula);
}

function defaultAbilities(profile) {
  return Object.fromEntries(profile.abilityIds.map(id => [id, {value: 0, primary: false}]));
}

function baseDraft(profile, {draftId, origin, name = "New AGE Adversary"} = {}) {
  return {
    schemaVersion: AGE_NPC_STUDIO_DRAFT_VERSION,
    draftId,
    profileId: profile.profileId,
    origin,
    identity: {
      name,
      kind: "adversary",
      threat: "",
      level: 0,
      ancestry: "",
      profession: "",
      background: "",
      img: "icons/svg/mystery-man.svg",
      compactSheet: true,
    },
    abilities: defaultAbilities(profile),
    combat: {
      defenseBase: 10,
      defenseGameModeBonus: 0,
      speedBase: 10,
      healthValue: 15,
      healthSet: 15,
      toughnessGameModeBonus: 0,
      impactArmor: 0,
      ballisticArmor: 0,
      initiativeMod: 0,
      attackMod: 0,
      testMod: 0,
      damageMod: 0,
    },
    resources: {
      powerPointsValue: 0,
      powerPointsSet: 0,
      convictionValue: 0,
      convictionSet: 0,
      fatigueEntered: 0,
    },
    token: {actorLink: false, disposition: -1, width: 1, height: 1, img: ""},
    notes: {features: "", traits: "", goals: "", gmNotes: ""},
    items: [],
  };
}

function customItem({entryId, type, name, img = "icons/svg/item-bag.svg", custom = {}}) {
  return {
    entryId,
    origin: "custom",
    include: true,
    name: String(name ?? "").trim(),
    type,
    img: img || "icons/svg/item-bag.svg",
    sourceUuid: null,
    custom: {
      description: custom.description ?? "",
      ability: custom.ability ?? "",
      focus: custom.focus ?? "",
      bonus: custom.bonus ?? 0,
      damageFormula: custom.damageFormula ?? "1d6",
      damageInjury: custom.damageInjury ?? null,
      damageInjuryConfirmed: custom.damageInjuryConfirmed ?? false,
      damageSource: custom.damageSource ?? "impact",
      targetNumber: custom.targetNumber ?? 10,
      powerPointCost: custom.powerPointCost ?? 0,
      degree: custom.degree ?? 0,
      subtype: custom.subtype === "spec" ? "spec" : "talent",
      stuntPoints: custom.stuntPoints ?? 1,
      equipped: custom.equipped ?? true,
      intensity: custom.intensity ?? 1,
      rank: custom.rank ?? 1,
    },
    resolution: manualNpcStudioResolution(),
  };
}

function descriptionFromSystem(system = {}) {
  return String(system.longDesc ?? system.description ?? system.shortDesc ?? "");
}

function mappedParsedItems(parsed, idFactory, profile) {
  const items = [];
  for (const focus of parsed.focus ?? []) {
    items.push(customItem({
      entryId: idFrom(idFactory, "focus"),
      type: "focus",
      name: focus.name,
      img: focus.img,
      custom: {
        ability: focus.system?.useAbl ?? "",
        bonus: focus.system?.initialValue ?? 2,
        description: descriptionFromSystem(focus.system),
      },
    }));
  }
  for (const parsedItem of parsed.items ?? []) {
    const type = parsedItem.type;
    if (!new Set(["equipment", "focus", "weapon", "power", "talent", "stunts", "relationship", "honorifics", "membership"]).has(type)) continue;
    const system = parsedItem.system ?? {};
    const talent = type === "talent"
      ? parseNpcStudioTalentLabel(parsedItem.name, system.degree, profile)
      : {name: parsedItem.name, degree: 0};
    const damageFormula = system.damageFormula ?? "1d6";
    items.push(customItem({
      entryId: idFrom(idFactory, type),
      type,
      name: talent.name,
      img: parsedItem.img,
      custom: {
        description: descriptionFromSystem(system),
        ability: system.useAbl ?? "",
        focus: system.useFocus ?? "",
        bonus: system.initialValue ?? 0,
        damageFormula,
        damageInjury: type === "weapon" && profile.healthSystem === "mageInjury"
          ? parsedInjuryDamage(system.damageFormula, system.damageInjurySuggestion, system.damageInjury)
          : null,
        damageSource: system.dmgSource ?? "impact",
        targetNumber: system.targetNumber ?? 10,
        powerPointCost: system.powerPointCost ?? 0,
        degree: talent.degree,
        subtype: system.type === "spec" ? "spec" : "talent",
        stuntPoints: system.stuntPoints ?? 1,
        equipped: system.equiped ?? system.activate ?? true,
        intensity: system.intensity ?? 1,
        rank: system.rank ?? 1,
      },
    }));
  }
  for (const attack of parsed.attacks ?? []) {
    const damageFormula = attack.dmg ?? "1d6";
    items.push(customItem({
      entryId: idFrom(idFactory, "weapon"),
      type: "weapon",
      name: attack.name,
      custom: {
        description: attack.longDesc ?? "",
        bonus: Number.parseInt(String(attack.toHit ?? "0"), 10) || 0,
        damageFormula,
        damageInjury: profile.healthSystem === "mageInjury"
          ? parsedInjuryDamage(attack.dmg, attack.damageInjurySuggestion, attack.damageInjury)
          : null,
        damageSource: "impact",
        equipped: true,
      },
    }));
  }
  return items;
}

function selectedModeData(parsed, profile) {
  const specs = parsed.gameMode?.specs ?? {};
  return specs[profile.gameMode] ?? specs.none ?? Object.values(specs)[0] ?? {};
}

export function createBlankNpcStudioDraft({profileId = null, idFactory, environment = globalThis} = {}) {
  const profile = npcStudioProfileSnapshot(profileId, {environment});
  const draft = baseDraft(profile, {
    draftId: idFrom(idFactory, "draft"),
    origin: {kind: "blank", parserMode: null, sourceActorUuid: null},
  });
  return assertNpcStudioDraftV1(draft, {abilityIds: profile.abilityIds, talentDegrees: profile.talentDegrees});
}

export async function createPastedNpcStudioDraft({profileId = null, text, parserMode, idFactory, environment = globalThis, Parser = null} = {}) {
  const profile = npcStudioProfileSnapshot(profileId, {environment});
  assertNpcStudioParserMode(profile.profileId, parserMode);
  const rawText = String(text ?? "");
  if (rawText.length > AGE_NPC_STUDIO_LIMITS.pasteCharacters) {
    throw npcStudioError("AGE_NPC_STUDIO_INPUT_TOO_LARGE", `Pasted NPC text exceeds ${AGE_NPC_STUDIO_LIMITS.pasteCharacters.toLocaleString()} characters.`);
  }
  const normalized = normalizePdfClipboardText(rawText).text;
  if (!normalized) throw npcStudioError("AGE_NPC_STUDIO_NO_TEXT", "Paste one NPC stat block before creating a draft.");
  if (normalized.length > AGE_NPC_STUDIO_LIMITS.pasteCharacters) {
    throw npcStudioError("AGE_NPC_STUDIO_INPUT_TOO_LARGE", `Pasted NPC text exceeds ${AGE_NPC_STUDIO_LIMITS.pasteCharacters.toLocaleString()} characters.`);
  }
  const blocks = normalized.split(/^\s*(?:-{3,}|={3,}|\*{3,})\s*$/mu).map(block => block.trim()).filter(Boolean);
  if (blocks.length !== 1) throw npcStudioError("AGE_NPC_STUDIO_PASTE_COUNT", "NPC Studio accepts exactly one pasted stat block. Use AGE Importer for batches.");
  const ParserClass = Parser ?? (await import("../parsers/npc-parser.js")).NpcParser;
  const parser = new ParserClass(blocks[0], parserMode, {create: false});
  const parsed = await parser.ready;
  if (!parsed?.name || !parsed?.abilities) throw npcStudioError("AGE_NPC_STUDIO_PARSE_INVALID", "The NPC parser did not return a complete stat block.");

  const draft = baseDraft(profile, {
    draftId: idFrom(idFactory, "draft"),
    origin: {kind: "paste", parserMode, sourceActorUuid: null},
    name: parsed.name,
  });
  draft.identity.threat = parsed.threat ?? "";
  for (const id of profile.abilityIds) {
    draft.abilities[id].value = number(parsed.abilities?.[id]?.value, 0);
    draft.abilities[id].primary = Boolean(parsed.abilities?.[id]?.primary);
  }
  const modeData = selectedModeData(parsed, profile);
  draft.combat.defenseBase = 10;
  draft.combat.defenseGameModeBonus = number(modeData.defense, 0);
  draft.combat.speedBase = number(parsed.speed?.base, 10);
  draft.combat.healthSet = Math.max(1, number(modeData.health, number(parsed.health, 15)));
  draft.combat.healthValue = Math.max(0, number(modeData.healthCur, draft.combat.healthSet));
  draft.combat.toughnessGameModeBonus = number(modeData.toughness, 0);
  draft.combat.impactArmor = Math.max(0, number(parsed.armor?.impactArmor, 0));
  draft.combat.ballisticArmor = Math.max(0, number(parsed.armor?.ballisticArmor, 0));
  draft.notes.traits = parsed.traits ?? "";
  draft.items = mappedParsedItems(parsed, idFactory, profile);
  await resolveNpcStudioParsedItems(draft, {environment, profile});
  return assertNpcStudioDraftV1(draft, {
    abilityIds: profile.abilityIds,
    talentDegrees: profile.talentDegrees,
    allowPendingResolution: true,
    allowIncompleteInjuryDamage: true,
  });
}

function rawSource(document) {
  if (document?._source && typeof document._source === "object") return document._source;
  if (typeof document?.toObject === "function") return document.toObject(false);
  return document;
}

async function resolveUuid(uuid, environment) {
  const resolver = environment?.foundry?.utils?.fromUuid ?? environment?.fromUuid ?? globalThis.fromUuid;
  if (!(resolver instanceof Function)) throw npcStudioError("AGE_NPC_STUDIO_UUID_RESOLVER", "Foundry UUID resolution is unavailable.");
  return resolver.call(environment?.foundry?.utils ?? environment, uuid);
}

export async function createCloneNpcStudioDraft({profileId = null, actorUuid, idFactory, environment = globalThis} = {}) {
  const profile = npcStudioProfileSnapshot(profileId, {environment});
  const actor = await resolveUuid(String(actorUuid ?? ""), environment);
  if (!actor || (actor.documentName ?? actor.constructor?.documentName) !== "Actor" || actor.type !== "char") {
    throw npcStudioError("AGE_NPC_STUDIO_CLONE_SOURCE", "The selected clone source is not an AGE Character Actor.");
  }
  const source = rawSource(actor);
  const system = source?.system ?? {};
  const draft = baseDraft(profile, {
    draftId: idFrom(idFactory, "draft"),
    origin: {kind: "clone", parserMode: null, sourceActorUuid: actor.uuid},
    name: actor.name ?? source.name ?? "Cloned AGE Adversary",
  });
  draft.identity = {
    ...draft.identity,
    name: actor.name ?? source.name ?? draft.identity.name,
    threat: system.threat ?? "",
    level: number(system.level, 0),
    ancestry: system.ancestry ?? "",
    profession: system.profession ?? "",
    background: system.background ?? "",
    img: source.img ?? actor.img ?? draft.identity.img,
    compactSheet: system.statBlockView !== false,
  };
  for (const id of profile.abilityIds) {
    draft.abilities[id].value = number(system.abilities?.[id]?.value, 0);
    draft.abilities[id].primary = Boolean(system.abilities?.[id]?.primary);
  }
  // Prepared Health can include Item, Class, or mode bonuses which are applied again
  // after the selected embedded Items are copied. Keep the persisted base and clamp
  // current Health to that base so a clone cannot double-apply derived bonuses.
  const healthSet = Math.max(1, number(system.health?.set, system.health?.value ?? 15));
  const healthValue = Math.min(healthSet, Math.max(0, number(system.health?.value, healthSet)));
  Object.assign(draft.combat, {
    defenseBase: number(system.defense?.base, 10),
    defenseGameModeBonus: number(system.defense?.gameModeBonus, 0),
    speedBase: number(system.speed?.base, 10),
    healthValue,
    healthSet,
    toughnessGameModeBonus: number(system.armor?.toughness?.gameModeBonus, 0),
    impactArmor: number(system.armor?.impact, 0),
    ballisticArmor: number(system.armor?.ballistic, 0),
    initiativeMod: number(system.initiativeMod, 0),
    attackMod: number(system.attackMod, 0),
    testMod: number(system.testMod, 0),
    damageMod: number(system.dmgMod, 0),
  });
  Object.assign(draft.resources, {
    powerPointsValue: number(system.powerPoints?.value, system.powerPoints?.set ?? 0),
    powerPointsSet: number(system.powerPoints?.set, system.powerPoints?.value ?? 0),
    convictionValue: number(system.conviction?.value, system.conviction?.set ?? 0),
    convictionSet: number(system.conviction?.set, system.conviction?.value ?? 0),
    fatigueEntered: number(system.fatigue?.entered, 0),
  });
  const token = source.prototypeToken ?? actor.prototypeToken ?? {};
  Object.assign(draft.token, {
    actorLink: Boolean(token.actorLink),
    disposition: [-1, 0, 1].includes(Number(token.disposition)) ? Number(token.disposition) : -1,
    width: number(token.width, 1),
    height: number(token.height, 1),
    img: token.texture?.src ?? "",
  });
  Object.assign(draft.notes, {
    features: system.features ?? "",
    traits: system.traits ?? "",
    goals: system.goals ?? "",
    gmNotes: system.gmNotes ?? "",
  });
  draft.items = values(actor.items)
    .filter(item => ITEM_TYPES.has(item.type) && !EXCLUDED_CLONE_ITEM_TYPES.has(item.type))
    .slice(0, AGE_NPC_STUDIO_LIMITS.items)
    .map(item => ({
      entryId: idFrom(idFactory, "item"),
      origin: "clone",
      include: true,
      name: item.name,
      type: item.type,
      img: item.img ?? "icons/svg/item-bag.svg",
      sourceUuid: item.uuid,
      custom: null,
      resolution: null,
    }));
  return assertNpcStudioDraftV1(draft, {abilityIds: profile.abilityIds, talentDegrees: profile.talentDegrees});
}

export async function createNpcStudioDraft(options = {}, dependencies = {}) {
  const environment = dependencies.environment ?? globalThis;
  const idFactory = dependencies.idFactory;
  if (options.origin === "blank") return createBlankNpcStudioDraft({...options, environment, idFactory});
  if (options.origin === "paste") return createPastedNpcStudioDraft({...options, environment, idFactory, Parser: dependencies.Parser});
  if (options.origin === "clone") return createCloneNpcStudioDraft({...options, environment, idFactory});
  if (options.origin === "expanse") throw npcStudioError("AGE_NPC_STUDIO_PROFILE_UNSUPPORTED", "The Expanse has no supported core NPC Studio profile.");
  throw npcStudioError("AGE_NPC_STUDIO_ORIGIN_UNSUPPORTED", `Unsupported NPC Studio origin: ${options.origin ?? "none"}.`);
}
