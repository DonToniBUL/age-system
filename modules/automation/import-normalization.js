const INVISIBLE_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/gu;
const COMBINING_MARKS = /[\u0300-\u036f]/gu;
const HORIZONTAL_SPACE = /[\t \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu;

const KNOWN_IMPORT_LABELS = Object.freeze([
  "Special Qualities",
  "Special Features",
  "Favored Stunts",
  "Armor Rating",
  "Requirements",
  "Journeyman",
  "Constitution",
  "Communication",
  "Intelligence",
  "Perception",
  "Dexterity",
  "Willpower",
  "Accuracy",
  "Fighting",
  "Influence",
  "Strength",
  "Attacks",
  "Equipment",
  "Talents",
  "Stunts",
  "Novice",
  "Expert",
  "Master",
  "Speed",
  "Health",
  "Defense",
  "Toughness",
  "Armor",
  "Move",
  "Run",
  "Fatigue",
  "Focus"
]);

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function spacedLabelPattern(label) {
  return label
    .split(/\s+/u)
    .map(word => Array.from(word).map(escapeRegExp).join("\\s*"))
    .join("\\s+");
}

const SPACED_LABELS = KNOWN_IMPORT_LABELS.map(label => ({
  label,
  pattern: new RegExp(`\\b${spacedLabelPattern(label)}\\b`, "giu")
}));

function countChange(changes, key, before, after) {
  if (before !== after) changes[key] = (changes[key] ?? 0) + 1;
  return after;
}

function repairKnownLabels(line, changes) {
  let repaired = line;
  for (const {label, pattern} of SPACED_LABELS) {
    const next = repaired.replace(pattern, label);
    repaired = countChange(changes, "labels", repaired, next);
  }
  return repaired;
}

/**
 * Normalize text copied from a searchable PDF without rewriting prose or rules.
 * The original value is never mutated and all lossy repairs are deliberately
 * narrow enough to be shown in the importer preview.
 */
export function normalizePdfClipboardText(value) {
  const original = String(value ?? "");
  const changes = {};
  let text = original;

  text = countChange(changes, "unicode", text, text.normalize("NFKC"));
  text = countChange(changes, "lineEndings", text, text.replace(/\r\n?/gu, "\n"));
  text = countChange(changes, "invisibleCharacters", text, text.replace(INVISIBLE_CHARACTERS, ""));
  text = countChange(changes, "softHyphens", text, text.replace(/\u00AD/gu, ""));
  text = countChange(changes, "dashCharacters", text, text.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/gu, "-"));

  const dehyphenated = text.replace(/([\p{L}]{2,})-\s*\n\s*([\p{Ll}]{2,})/gu, "$1$2");
  text = countChange(changes, "lineBreakHyphens", text, dehyphenated);

  const lines = text.split("\n").map(line => {
    let normalized = line.replace(HORIZONTAL_SPACE, " ").trim();
    normalized = repairKnownLabels(normalized, changes);
    normalized = normalized.replace(/\s+([,.;)\]])/gu, "$1");
    normalized = normalized.replace(/([(\[])\s+/gu, "$1");
    if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)) {
      normalized = normalized.replace(/^([^:]{1,60})\s*:\s*/u, (_match, prefix) => `${prefix.trimEnd()}: `);
    }
    return normalized.trimEnd();
  });
  text = lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  countChange(changes, "spacing", original, text);

  return Object.freeze({
    original,
    text,
    changed: original !== text,
    changes: Object.freeze({...changes})
  });
}

export function normalizeImportName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(/[\u2018\u2019\u201B`´]/gu, "'")
    .replace(/&/gu, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

export function normalizeImportedTitle(value) {
  const cleaned = String(value ?? "")
    .normalize("NFKC")
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(/^\s*(?:(?:[•*#]+)|(?:\d+[.)]))\s*/u, "")
    .replace(/^[_*]+|[_*:]+$/gu, "")
    .replace(HORIZONTAL_SPACE, " ")
    .trim();
  return cleaned.split(" ").filter(Boolean).map(word => {
    const parts = word.split(/([-\u2019'])/u);
    return parts.map((part, index) => {
      if (/^[-\u2019']$/u.test(part)) return part;
      const followsApostrophe = index > 0 && /^[\u2019']$/u.test(parts[index - 1]);
      if (followsApostrophe && Array.from(part).length === 1) return part.toLowerCase();
      return part.substring(0, 1).toUpperCase() + part.substring(1).toLowerCase();
    }).join("");
  }).join(" ");
}

export function splitImportedList(value) {
  return String(value ?? "")
    .split(/\s*(?:,|;|[•·])\s*/u)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function editDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({length: right.length + 1}, (_value, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function tokenScore(left, right) {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = Array.from(leftTokens).filter(token => rightTokens.has(token)).length;
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

export function scoreImportName(query, candidate) {
  const left = normalizeImportName(query);
  const right = normalizeImportName(candidate);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.replace(/\s/gu, "") === right.replace(/\s/gu, "")) return 0.98;

  const longest = Math.max(left.length, right.length);
  const editScore = longest ? 1 - (editDistance(left, right) / longest) : 0;
  const words = tokenScore(left, right);
  const containment = left.includes(right) || right.includes(left)
    ? Math.min(left.length, right.length) / longest
    : 0;
  return Math.max(editScore * 0.9, words * 0.94, containment * 0.88);
}

export function rankImportCandidates(query, candidates, {limit = 8, minimum = 0.58} = {}) {
  const maximum = Math.max(1, Math.min(Number(limit) || 8, 50));
  return Array.from(candidates ?? [])
    .map(candidate => ({...candidate, confidence: scoreImportName(query, candidate?.name)}))
    .filter(candidate => candidate.confidence >= minimum)
    .sort((left, right) => right.confidence - left.confidence || String(left.name).localeCompare(String(right.name)))
    .slice(0, maximum);
}
