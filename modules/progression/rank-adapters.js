import {AGE_PROGRESSION_DEFINITION_VERSION, assertProgressionDefinitionV1} from "./contracts.js";

export const AGE_RANK_VOCABULARIES = Object.freeze({
  dage: Object.freeze({profileIds: Object.freeze(["dage"]), defaultProfileId: "dage", label: "Dragon Age", ranks: Object.freeze(["novice", "journeyman", "master"])}),
  fage: Object.freeze({profileIds: Object.freeze(["fage-1e", "fage-2e"]), defaultProfileId: "fage-2e", label: "Fantasy AGE", ranks: Object.freeze(["novice", "journeyman", "master"])}),
  mage: Object.freeze({profileIds: Object.freeze(["mage-core", "mage-mastery-injury"]), defaultProfileId: "mage-core", label: "Modern AGE", ranks: Object.freeze(["novice", "expert", "master"])})
});

const FORBIDDEN_AMBIGUOUS_KINDS = new Set(["specialization", "focus", "relationship", "membership"]);

function assertExplicit(value, path = "spec") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an explicit object`);
  for (const [key, entry] of Object.entries(value)) {
    if (["random", "rollTable", "table", "strategy", "query", "filter"].includes(key)) throw new TypeError(`${path}.${key} is not allowed; rank adapters require explicit selections`);
    if (["specialization", "focus", "relationship", "membership"].includes(key) && entry !== undefined) throw new TypeError(`${path}.${key} is ambiguous and must be modeled by a provider-specific explicit choice`);
  }
}

function acquireEffect(grant, index) {
  assertExplicit(grant, `grant[${index}]`);
  if (FORBIDDEN_AMBIGUOUS_KINDS.has(grant.kind)) throw new TypeError(`grant[${index}].kind "${grant.kind}" is ambiguous and cannot be adapted automatically`);
  if (grant.effect === "advance") {
    if (grant.allowAdvance !== true) throw new TypeError(`grant[${index}] must explicitly opt into item.advance`);
    return {id: grant.id ?? `advance-${index + 1}`, type: "item.advance", trait: grant.trait, ...(grant.sourceRefId ? {sourceRefId: grant.sourceRefId} : {})};
  }
  if (!grant.sourceRefId) throw new TypeError(`grant[${index}].sourceRefId is required for acquire-only grants`);
  return {id: grant.id ?? `acquire-${index + 1}`, type: "item.acquire", sourceRefId: grant.sourceRefId, ...(grant.quantity ? {quantity: grant.quantity} : {})};
}

/**
 * Convert a copyright-neutral, explicit provider rank spec into DefinitionV1.
 * Grants are item.acquire by default.  A provider must explicitly request and
 * justify item.advance; no adapter guesses a specialization/focus relationship.
 */
export function adaptRankSpec(vocabulary, spec) {
  const rules = AGE_RANK_VOCABULARIES[vocabulary];
  if (!rules) throw new Error(`Unknown AGE rank vocabulary "${vocabulary}".`);
  assertExplicit(spec);
  const profileId = spec.profileId ?? rules.defaultProfileId;
  if (!rules.profileIds.includes(profileId)) throw new Error(`The ${vocabulary} adapter only accepts profiles "${rules.profileIds.join("\", \"")}".`);
  if (!Array.isArray(spec.ranks) || !spec.ranks.length) throw new TypeError("spec.ranks must be a non-empty explicit array");
  const milestones = spec.ranks.map((entry, index) => {
    assertExplicit(entry, `spec.ranks[${index}]`);
    if (!rules.ranks.includes(entry.vocabularyRank)) throw new TypeError(`spec.ranks[${index}].vocabularyRank is not valid for ${vocabulary}`);
    if (!Number.isInteger(entry.rank)) throw new TypeError(`spec.ranks[${index}].rank must be an integer`);
    const grants = entry.grants ?? [];
    if (!Array.isArray(grants)) throw new TypeError(`spec.ranks[${index}].grants must be an array`);
    const effects = [...(entry.effects ?? []), ...grants.map(acquireEffect)];
    return {
      id: entry.id ?? `${vocabulary}-${entry.vocabularyRank}-${entry.rank}`,
      rank: entry.rank,
      triggers: entry.triggers ?? [entry.rank === spec.rank.minimum ? "character.create" : "rank.advance"],
      sourceRefIds: entry.sourceRefIds ?? [],
      choiceGroups: entry.choiceGroups ?? [],
      evaluations: entry.evaluations ?? [],
      effects
    };
  });
  const definition = {
    schemaVersion: AGE_PROGRESSION_DEFINITION_VERSION,
    id: spec.id,
    version: spec.version,
    profileId,
    capabilities: spec.capabilities ?? ["character-builder", "advancement"],
    sourceRefs: spec.sourceRefs ?? [],
    ...(spec.rulesContentCoverage ? {rulesContentCoverage: spec.rulesContentCoverage} : {}),
    rank: spec.rank,
    ...(spec.trackBinding ? {trackBinding: spec.trackBinding} : {}),
    milestones
  };
  if (milestones.some(milestone => milestone.triggers.includes("rank.advance")) && !spec.trackBinding) {
    throw new TypeError("spec.trackBinding is required when an explicit rank spec supports rank.advance");
  }
  return assertProgressionDefinitionV1(definition);
}

export const adaptDragonAgeRanks = spec => adaptRankSpec("dage", spec);
export const adaptFantasyAgeRanks = spec => adaptRankSpec("fage", spec);
export const adaptModernAgeRanks = spec => adaptRankSpec("mage", spec);
