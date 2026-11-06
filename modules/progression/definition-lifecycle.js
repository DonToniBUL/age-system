import {validateProgressionDefinition} from "./contracts.js";

export const AGE_PROGRESSION_DEFINITION_LIFECYCLE = Object.freeze({
  DRAFT: "draft",
  VALID: "valid",
  ACTIVE: "active",
  INVALID: "invalid",
});

const STRUCTURAL_CODES = new Set(["object", "array"]);

function normalizeIssue(entry) {
  return {
    path: typeof entry?.path === "string" && entry.path ? entry.path : "$",
    message: typeof entry?.message === "string" && entry.message ? entry.message : "is invalid",
    code: typeof entry?.code === "string" && entry.code ? entry.code : "invalid",
  };
}

function isDescendantPath(path, parent) {
  if (parent === "$") return path !== "$" && path.startsWith("$.");
  return path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`);
}

/**
 * Keep strict validation while avoiding cascades beneath a field which is not
 * even the required container type. Exact leaf findings remain unchanged.
 */
export function compactProgressionDefinitionIssues(entries = []) {
  const unique = [];
  const seen = new Set();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = normalizeIssue(raw);
    const key = `${entry.path}\u0000${entry.code}\u0000${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  const structural = unique.filter(entry => STRUCTURAL_CODES.has(entry.code));
  return Object.freeze(unique.filter(entry => !structural.some(parent => (
    parent !== entry && isDescendantPath(entry.path, parent.path)
  ))).map(entry => Object.freeze(entry)));
}

export function progressionDraftIssue() {
  return Object.freeze({
    path: "$",
    code: "definition-draft",
    message: "Draft is incomplete. Add progression data and save a valid definition before it can be used.",
  });
}

/** Classify DefinitionV1 semantics independently of their Foundry container. */
export function classifyProgressionDefinition(definition, {enabled = true} = {}) {
  if (definition === null || definition === undefined) {
    return Object.freeze({
      state: AGE_PROGRESSION_DEFINITION_LIFECYCLE.DRAFT,
      valid: false,
      active: false,
      runnable: false,
      issues: Object.freeze([progressionDraftIssue()]),
    });
  }
  const validation = validateProgressionDefinition(definition);
  const issues = compactProgressionDefinitionIssues(validation.issues);
  if (!validation.valid) {
    return Object.freeze({
      state: AGE_PROGRESSION_DEFINITION_LIFECYCLE.INVALID,
      valid: false,
      active: false,
      runnable: false,
      issues,
    });
  }
  const active = enabled === true;
  return Object.freeze({
    state: active ? AGE_PROGRESSION_DEFINITION_LIFECYCLE.ACTIVE : AGE_PROGRESSION_DEFINITION_LIFECYCLE.VALID,
    valid: true,
    active,
    runnable: active,
    issues: Object.freeze([]),
  });
}
