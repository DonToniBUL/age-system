import {AGE_RULE_PROFILES} from "../automation/rule-profiles.js";
import {canonicalClone, digestCanonicalJson} from "../progression/canonical.js";
import {AGE_NPC_STUDIO_PROFILE_IDS, npcStudioError} from "./contracts.js";
import {npcStudioTalentDegrees} from "./item-resolution.js";

const SYSTEM_ID = "age-system";
const SUPPORTED = new Set(AGE_NPC_STUDIO_PROFILE_IDS);
const MAIN_ABILITIES = Object.freeze(["acc", "comm", "cons", "dex", "fight", "int", "per", "str", "will"]);
const DAGE_ABILITIES = Object.freeze(["comm", "cons", "cunn", "dex", "magic", "per", "str", "will"]);
const SNAPSHOT_SETTINGS = Object.freeze([
  "activeRuleProfile", "abilitySelection", "primaryAbl", "healthSys", "healthMode", "gameMode",
  "weaponGroups", "DegressChoice", "wealthType", "occupation", "ancestryOpt", "useConviction",
  "useFatigue", "usePowerPoints", "powerFlavor", "complication", "serendipity", "stuntAttack",
]);

function safeSetting(environment, key) {
  try { return environment?.game?.settings?.get?.(SYSTEM_ID, key); } catch (_error) { return undefined; }
}

export function activeNpcStudioProfileId(environment = globalThis) {
  const profileId = String(safeSetting(environment, "activeRuleProfile") ?? "");
  if (!SUPPORTED.has(profileId)) {
    throw npcStudioError(
      "AGE_NPC_STUDIO_PROFILE_UNSUPPORTED",
      `Active AGE profile "${profileId || "custom"}" is not supported by NPC Studio.`,
      {profileId}
    );
  }
  return profileId;
}

export function parserModesForNpcStudioProfile(profileId) {
  if (!SUPPORTED.has(profileId)) throw npcStudioError("AGE_NPC_STUDIO_PROFILE_UNSUPPORTED", `Unsupported NPC Studio profile: ${profileId}.`);
  if (profileId === "dage") return Object.freeze(["dage"]);
  if (profileId === "fage-1e") return Object.freeze(["fage"]);
  if (profileId === "fage-2e") return Object.freeze(["fage2e"]);
  return Object.freeze(["mageL", "mageM"]);
}

export function assertNpcStudioParserMode(profileId, parserMode) {
  if (parserMode === "expanse") {
    throw npcStudioError(
      "AGE_NPC_STUDIO_DIALECT_UNSUPPORTED",
      "The Expanse stat-block dialect is not supported by the available core NPC Studio profiles.",
      {profileId, parserMode}
    );
  }
  const allowed = parserModesForNpcStudioProfile(profileId);
  if (!allowed.includes(parserMode)) {
    throw npcStudioError(
      "AGE_NPC_STUDIO_DIALECT_PROFILE",
      `Parser dialect "${parserMode ?? "none"}" is not valid for AGE profile "${profileId}".`,
      {profileId, parserMode, allowed}
    );
  }
  return parserMode;
}

export function npcStudioProfileSnapshot(profileId = null, {environment = globalThis} = {}) {
  const activeProfileId = activeNpcStudioProfileId(environment);
  const resolved = profileId ?? activeProfileId;
  if (resolved !== activeProfileId) {
    throw npcStudioError(
      "AGE_NPC_STUDIO_PROFILE_INACTIVE",
      `NPC Studio profile "${resolved}" does not match the active AGE profile "${activeProfileId}".`,
      {profileId: resolved, activeProfileId}
    );
  }
  const profile = AGE_RULE_PROFILES[resolved];
  if (!profile) throw npcStudioError("AGE_NPC_STUDIO_PROFILE_UNSUPPORTED", `Unsupported NPC Studio profile: ${resolved}.`);
  const liveSettings = Object.fromEntries(SNAPSHOT_SETTINGS
    .map(key => [key, safeSetting(environment, key)])
    .filter(([, value]) => value !== undefined));
  const abilitySelection = String(liveSettings.abilitySelection ?? profile.settings.abilitySelection);
  const abilityIds = abilitySelection === "dage" ? DAGE_ABILITIES : abilitySelection === "main" ? MAIN_ABILITIES : null;
  if (!abilityIds) {
    throw npcStudioError("AGE_NPC_STUDIO_ABILITY_PROFILE", `AGE ability selection "${abilitySelection}" is unsupported.`);
  }
  const snapshot = {
    schemaVersion: 1,
    profileId: resolved,
    configuredSettings: profile.settings,
    liveSettings,
    abilitySelection,
    abilityIds,
    parserModes: parserModesForNpcStudioProfile(resolved),
    healthSystem: String(liveSettings.healthSys ?? profile.settings.healthSys),
    healthMode: String(liveSettings.healthMode ?? profile.settings.healthMode),
    gameMode: String(liveSettings.gameMode ?? profile.settings.gameMode),
    primaryAbilities: Boolean(liveSettings.primaryAbl ?? profile.settings.primaryAbl),
    usePowerPoints: Boolean(liveSettings.usePowerPoints ?? profile.settings.usePowerPoints),
    useConviction: Boolean(liveSettings.useConviction ?? profile.settings.useConviction),
    useFatigue: Boolean(liveSettings.useFatigue ?? profile.settings.useFatigue),
  };
  snapshot.talentDegrees = npcStudioTalentDegrees(snapshot);
  return canonicalClone(snapshot);
}

export async function npcStudioProfileDigest(profileId = null, options = {}) {
  return digestCanonicalJson(npcStudioProfileSnapshot(profileId, options));
}

export function npcStudioProfileCapabilities(profileId = null, {environment = globalThis} = {}) {
  const snapshot = npcStudioProfileSnapshot(profileId, {environment});
  return Object.freeze({
    profileId: snapshot.profileId,
    abilityIds: Object.freeze([...snapshot.abilityIds]),
    parserModes: Object.freeze([...snapshot.parserModes]),
    healthSystem: snapshot.healthSystem,
    healthMode: snapshot.healthMode,
    gameMode: snapshot.gameMode,
    primaryAbilities: snapshot.primaryAbilities,
    usePowerPoints: snapshot.usePowerPoints,
    useConviction: snapshot.useConviction,
    useFatigue: snapshot.useFatigue,
    talentDegrees: Object.freeze(snapshot.talentDegrees.map(degree => Object.freeze({...degree}))),
  });
}
