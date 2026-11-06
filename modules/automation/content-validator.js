import {classifyProgressionDefinition} from "../progression/definition-lifecycle.js";

const ACTOR_TYPES = Object.freeze(["char", "vehicle", "spaceship", "organization", "force"]);
const ITEM_TYPES = Object.freeze([
  "equipment",
  "focus",
  "weapon",
  "power",
  "talent",
  "stunts",
  "relationship",
  "honorifics",
  "membership",
  "shipfeatures",
  "class",
  "progression"
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function getProperty(object, path) {
  if (globalThis.foundry?.utils?.getProperty) return foundry.utils.getProperty(object, path);
  return String(path).split(".").reduce((value, key) => value?.[key], object);
}

function documentKind(document) {
  const name = document?.documentName ?? document?.constructor?.metadata?.name;
  if (name === "Actor" || name === "Item") return name;
  if (document?.items || ACTOR_TYPES.includes(document?.type)) return "Actor";
  return "Item";
}

function documentUuid(document) {
  return document?.uuid ?? document?._id ?? document?.id ?? null;
}

function sourceId(document) {
  return document?._stats?.compendiumSource
    ?? getProperty(document, "flags.core.sourceId")
    ?? getProperty(document, "flags.age-system.sourceId")
    ?? null;
}

function sourceScope(document) {
  return document?.parent?.uuid ?? document?.pack ?? "world";
}

function addIssue(issues, document, {severity = "warning", code, path = null, message, ...details}) {
  issues.push({
    severity,
    code,
    message,
    path,
    uuid: documentUuid(document),
    name: document?.name ?? "",
    documentType: documentKind(document),
    type: document?.type ?? null,
    ...details
  });
}

function checkFinite(issues, document, path, {minimum = null, maximum = null, required = false, invalidSeverity = "error"} = {}) {
  const raw = getProperty(document, path);
  if ((raw === null || raw === undefined || raw === "") && !required) return;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    addIssue(issues, document, {severity: invalidSeverity, code: "number.invalid", path, message: `${path} should be a finite number.`});
    return;
  }
  if (minimum !== null && value < minimum) {
    addIssue(issues, document, {severity: "error", code: "number.minimum", path, message: `${path} cannot be below ${minimum}.`});
  }
  if (maximum !== null && value > maximum) {
    addIssue(issues, document, {severity: "error", code: "number.maximum", path, message: `${path} cannot exceed ${maximum}.`});
  }
}

function checkResource(issues, document, basePath) {
  checkFinite(issues, document, `${basePath}.value`, {minimum: 0});
  checkFinite(issues, document, `${basePath}.max`, {minimum: 0});
  const value = Number(getProperty(document, `${basePath}.value`));
  const maximum = Number(getProperty(document, `${basePath}.max`));
  if (Number.isFinite(value) && Number.isFinite(maximum) && value > maximum) {
    addIssue(issues, document, {
      code: "resource.overMaximum",
      path: basePath,
      message: `${basePath} is above its configured maximum.`
    });
  }
}

function checkFormula(issues, document, path) {
  const formula = getProperty(document, path);
  if (formula === null || formula === undefined || formula === "") return;
  if (typeof formula !== "string") {
    addIssue(issues, document, {severity: "error", code: "formula.type", path, message: `${path} must be a string.`});
    return;
  }
  if (formula.length > 512 || /[`;\r\n]/.test(formula)) {
    addIssue(issues, document, {severity: "error", code: "formula.unsafe", path, message: `${path} contains unsupported characters or is too long.`});
    return;
  }
  const pairs = {"(": ")", "[": "]", "{": "}"};
  const stack = [];
  for (const character of formula) {
    if (pairs[character]) stack.push(pairs[character]);
    else if ([")", "]", "}"].includes(character) && stack.pop() !== character) {
      addIssue(issues, document, {severity: "error", code: "formula.brackets", path, message: `${path} has unbalanced brackets.`});
      return;
    }
  }
  if (stack.length) addIssue(issues, document, {severity: "error", code: "formula.brackets", path, message: `${path} has unbalanced brackets.`});
}

function validateActor(document, issues) {
  if (document.type === "char") {
    checkResource(issues, document, "system.health");
    checkFinite(issues, document, "system.powerPoints.value", {minimum: 0});
    checkFinite(issues, document, "system.powerPoints.set", {minimum: 0});
    checkFinite(issues, document, "system.defense.total");
    const abilities = getProperty(document, "system.abilities") ?? {};
    for (const key of Object.keys(abilities)) checkFinite(issues, document, `system.abilities.${key}.value`);
  } else if (document.type === "vehicle") {
    checkResource(issues, document, "system.partHealth");
    checkFinite(issues, document, "system.armorRating", {minimum: 0});
  } else if (document.type === "spaceship") {
    checkFinite(issues, document, "system.crew.min", {minimum: 0});
    checkFinite(issues, document, "system.crew.current", {minimum: 0});
  } else if (document.type === "organization") {
    checkFinite(issues, document, "system.combat.stability.value", {minimum: 0});
  } else if (document.type === "force") {
    checkResource(issues, document, "system.troops");
    checkFinite(issues, document, "system.primaryTroop.difficulty", {minimum: 1});
    checkFinite(issues, document, "system.battle.successThreshold", {minimum: 1});
  }
}

function validateItem(document, issues) {
  if (["equipment", "weapon"].includes(document.type)) {
    checkFinite(issues, document, "system.quantity", {minimum: 0});
  }
  if (["weapon", "power", "shipfeatures"].includes(document.type)) {
    checkFormula(issues, document, "system.damageFormula");
  }
  if (document.type === "weapon") {
    checkFinite(issues, document, "system.capacity", {minimum: 0, invalidSeverity: "warning"});
    checkFinite(issues, document, "system.range", {minimum: 0, invalidSeverity: "warning"});
    checkFinite(issues, document, "system.rangeMax", {minimum: 0, invalidSeverity: "warning"});
    const range = Number(getProperty(document, "system.range"));
    const rangeMax = Number(getProperty(document, "system.rangeMax"));
    if (Number.isFinite(range) && Number.isFinite(rangeMax) && rangeMax < range) {
      addIssue(issues, document, {severity: "error", code: "weapon.range", path: "system.rangeMax", message: "Maximum range cannot be below normal range."});
    }
  } else if (document.type === "power") {
    checkFinite(issues, document, "system.powerPointCost", {minimum: 0});
    checkFormula(issues, document, "system.damageResisted.damageFormula");
    if (getProperty(document, "system.hasTest")) {
      if (!getProperty(document, "system.testAbl")) {
        addIssue(issues, document, {severity: "error", code: "power.resistanceAbility", path: "system.testAbl", message: "A resisted Power requires a resistance ability."});
      }
    }
  } else if (document.type === "stunts") {
    checkFinite(issues, document, "system.stuntPoints", {minimum: 0});
    checkFinite(issues, document, "system.stuntPointsMax", {minimum: 0});
  } else if (document.type === "class") {
    checkFinite(issues, document, "system.level", {minimum: 0, maximum: 20});
  } else if (document.type === "progression") {
    const definition = getProperty(document, "system.definition");
    const lifecycle = classifyProgressionDefinition(definition, {enabled: getProperty(document, "system.enabled") !== false});
    if (lifecycle.state === "draft") {
      addIssue(issues, document, {
        severity: "warning",
        code: "progression.draft",
        path: "system.definition",
        message: lifecycle.issues[0].message,
      });
      return;
    }
    for (const finding of lifecycle.issues) {
      addIssue(issues, document, {
        severity: "error",
        code: `progression.${finding.code ?? "definition"}`,
        path: finding.path === "$" ? "system.definition" : `system.definition${String(finding.path).slice(1)}`,
        message: finding.message
      });
    }
    const digest = getProperty(document, "system.digest");
    if (lifecycle.valid && (typeof digest !== "string" || !SHA256_PATTERN.test(digest))) {
      addIssue(issues, document, {
        severity: "error",
        code: "progression.digest",
        path: "system.digest",
        message: "system.digest must be a lowercase SHA-256 digest."
      });
    }
  }
}

function normalizeDocuments(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (collection.contents) return Array.from(collection.contents);
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

export class AgeContentValidator {
  static actorTypes = ACTOR_TYPES;
  static itemTypes = ITEM_TYPES;

  static validateDocument(document) {
    const issues = [];
    if (!document || typeof document !== "object") {
      return {valid: false, issues: [{severity: "error", code: "document.invalid", message: "A document is required.", path: null, uuid: null}]};
    }

    const kind = documentKind(document);
    const allowedTypes = kind === "Actor" ? ACTOR_TYPES : ITEM_TYPES;
    if (!allowedTypes.includes(document.type)) {
      addIssue(issues, document, {severity: "error", code: "document.type", path: "type", message: `Unsupported ${kind} type: ${document.type ?? "<empty>"}.`});
    }
    if (typeof document.name !== "string" || !document.name.trim()) {
      addIssue(issues, document, {code: "document.name", path: "name", message: `${kind} has no display name.`});
    }

    if (kind === "Actor") validateActor(document, issues);
    else validateItem(document, issues);
    return {valid: !issues.some(issue => issue.severity === "error"), issues};
  }

  static validateDocuments(documents, {includeEmbedded = true} = {}) {
    const allDocuments = [];
    for (const document of normalizeDocuments(documents)) {
      allDocuments.push(document);
      if (includeEmbedded && documentKind(document) === "Actor") allDocuments.push(...normalizeDocuments(document.items));
    }

    const issues = [];
    const sources = new Map();
    for (const document of allDocuments) {
      issues.push(...this.validateDocument(document).issues);
      const id = sourceId(document);
      if (!id) continue;
      const key = `${sourceScope(document)}\u0000${id}`;
      const matching = sources.get(key) ?? [];
      matching.push(document);
      sources.set(key, matching);
    }

    for (const [key, matching] of sources) {
      if (matching.length < 2) continue;
      const id = key.slice(key.indexOf("\u0000") + 1);
      addIssue(issues, matching[0], {
        code: "source.duplicate",
        path: "_stats.compendiumSource",
        message: `Source ID is shared by ${matching.length} documents in the same scope: ${id}`,
        occurrences: matching.length,
        relatedUuids: matching.map(documentUuid)
      });
    }

    const errors = issues.filter(issue => issue.severity === "error");
    const warnings = issues.filter(issue => issue.severity !== "error");
    return {
      valid: errors.length === 0,
      documentCount: allDocuments.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      errors,
      warnings,
      issues
    };
  }

  static async validateWorld({includePacks = false} = {}) {
    const documents = [...normalizeDocuments(game.actors), ...normalizeDocuments(game.items)];
    const packErrors = [];
    if (includePacks) {
      for (const pack of normalizeDocuments(game.packs)) {
        if (!["Actor", "Item"].includes(pack.documentName)) continue;
        try {
          documents.push(...await pack.getDocuments());
        } catch (error) {
          packErrors.push({
            severity: "error",
            code: "pack.unavailable",
            message: `Could not validate ${pack.collection}: ${error?.message ?? error}`,
            path: null,
            uuid: pack.collection ?? null
          });
        }
      }
    }
    const result = this.validateDocuments(documents);
    if (!packErrors.length) return result;
    return {
      ...result,
      valid: false,
      errorCount: result.errorCount + packErrors.length,
      errors: [...result.errors, ...packErrors],
      issues: [...result.issues, ...packErrors]
    };
  }
}

export default AgeContentValidator;
