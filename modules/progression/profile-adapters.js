import {ageSystem} from "../config.js";
import {AGE_RULE_PROFILES} from "../automation/rule-profiles.js";
import {
  AGE_PROGRESSION_SUPPORTED_DEFINITION_VERSIONS,
  assertProgressionDefinition,
  validateProgressionDefinition,
} from "./contracts.js";
import {canonicalClone, canonicalJson, definitionDigest} from "./canonical.js";

/**
 * The profile adapter is deliberately descriptive.  It identifies the
 * vocabulary an installed rule profile exposes; it does not derive a class,
 * ancestry, grant, or level schedule from a pack, RollTable, or item name.
 */
export const AGE_PROGRESSION_PROFILE_ADAPTER_VERSION = 1;
export const AGE_PROGRESSION_PROFILE_SCHEMA_VERSION = 1;

const COVERAGE_VALUES = new Set(["synthetic", "partial", "complete"]);
const PROFILE_IDS = Object.freeze(Object.keys(AGE_RULE_PROFILES).sort());
export const AGE_PROGRESSION_PROFILE_IDS = PROFILE_IDS;

const clone = value => canonicalClone(value);
const freeze = value => Object.freeze(value);

function profileError(profileId) {
  return new Error(`Unsupported AGE progression profile "${profileId}". Select one of: ${PROFILE_IDS.join(", ")}.`);
}

function degreeVocabulary(settings) {
  const vocabulary = ageSystem.talentDegrees[settings.DegressChoice];
  if (!Array.isArray(vocabulary) || !vocabulary.length) {
    throw new Error(`AGE profile "${settings.DegressChoice}" has no configured talent-degree vocabulary.`);
  }
  return [...vocabulary];
}

function abilityIds(settings) {
  const abilities = ageSystem.abilitiesSettings[settings.abilitySelection];
  if (!abilities || typeof abilities !== "object") {
    throw new Error(`AGE profile references unknown ability selection "${settings.abilitySelection}".`);
  }
  return Object.keys(abilities);
}

function describeProfile(profile) {
  const settings = profile.settings;
  return {
    schemaVersion: AGE_PROGRESSION_PROFILE_SCHEMA_VERSION,
    adapterVersion: AGE_PROGRESSION_PROFILE_ADAPTER_VERSION,
    id: profile.id,
    label: profile.label,
    ability: {
      selection: settings.abilitySelection,
      ids: abilityIds(settings),
      primaryAbilityPolicy: settings.primaryAbl ? "enabled" : "disabled",
    },
    identity: {
      occupationLabel: settings.occupation,
      ancestryLabel: settings.ancestryOpt,
    },
    health: {
      mode: settings.healthMode,
      system: settings.healthSys,
    },
    resource: {
      powerPoints: settings.usePowerPoints === true,
      powerFlavor: settings.powerFlavor,
    },
    degrees: {
      vocabularyId: settings.DegressChoice,
      labels: degreeVocabulary(settings),
    },
    modernAge: {
      gameMode: settings.gameMode,
      injuryTracking: settings.healthSys === "mageInjury",
    },
  };
}

const ADAPTERS = freeze(Object.fromEntries(PROFILE_IDS.map(profileId => [
  profileId,
  freeze(describeProfile(AGE_RULE_PROFILES[profileId])),
])));

/** Return an immutable, plain-data description of the exact AGE rule profile. */
export function progressionProfileAdapter(profileId) {
  if (!PROFILE_IDS.includes(profileId)) throw profileError(profileId);
  return ADAPTERS[profileId];
}

/** A stable serialization suitable for preview/receipt fingerprint comparisons. */
export function progressionProfileFingerprint(profileId) {
  return canonicalJson(progressionProfileAdapter(profileId));
}

/** SHA-256 digest companion to the stable fingerprint. */
export async function progressionProfileDigest(profileId) {
  return definitionDigest(progressionProfileAdapter(profileId));
}

function profileIssue(path, message, code) {
  return Object.freeze({path, message, code});
}

/**
 * Validate a DefinitionV1 against its selected rule-profile vocabulary.
 * A `custom` profile is intentionally not accepted: a provider must first
 * register an explicit supported profile rather than letting the system guess.
 */
export function validateProgressionProfileDefinition(definition, {profileId = definition?.profileId} = {}) {
  const base = validateProgressionDefinition(definition);
  const issues = [...base.issues];
  if (!AGE_PROGRESSION_SUPPORTED_DEFINITION_VERSIONS.includes(definition?.schemaVersion)) {
    return freeze({valid: false, issues: freeze(issues)});
  }
  if (!PROFILE_IDS.includes(profileId)) {
    issues.push(profileIssue("$.profileId", `Unsupported AGE progression profile "${profileId}".`, "profile-unsupported"));
  }
  if (definition?.profileId !== profileId) {
    issues.push(profileIssue("$.profileId", `Definition profile "${definition?.profileId}" does not match selected profile "${profileId}".`, "profile-mismatch"));
  }
  if (definition?.rulesContentCoverage !== undefined && !COVERAGE_VALUES.has(definition.rulesContentCoverage)) {
    issues.push(profileIssue("$.rulesContentCoverage", "must be synthetic, partial, or complete", "content-coverage"));
  }
  return freeze({valid: issues.length === 0, issues: freeze(issues)});
}

export function assertProgressionProfileDefinition(definition, options = {}) {
  assertProgressionDefinition(definition);
  const validation = validateProgressionProfileDefinition(definition, options);
  if (!validation.valid) {
    const error = new Error(`Invalid AGE progression profile definition: ${validation.issues.map(issue => `${issue.path} ${issue.message}`).join("; ")}`);
    error.name = "AgeProgressionProfileValidationError";
    error.issues = validation.issues;
    throw error;
  }
  return definition;
}

/** Return a defensive clone for consumers that need to annotate a preview. */
export function cloneProgressionProfileAdapter(profileId) {
  return clone(progressionProfileAdapter(profileId));
}
