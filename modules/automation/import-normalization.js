const INVISIBLE_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/gu;
const COMBINING_MARKS = /[\u0300-\u036f]/gu;
const HORIZONTAL_SPACE = /[\t \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu;
const MAX_LABEL_REPAIR_LINE_LENGTH = 1_000;
const MAX_WRAPPED_LABEL_LINES = 3;

const KNOWN_IMPORT_LABELS = Object.freeze([
  "Weapon Attack Roll Damage", "Special Qualities", "Special Features", "Specializations",
  "Specialization", "Favored Stunts", "Armor Rating", "Prerequisites", "Prerequisite",
  "Requirements", "Requirement", "Journeyman", "Grandmaster", "Constitution",
  "Communication", "Intelligence", "Perception", "Dexterity", "Willpower", "Accuracy",
  "Fighting", "Influence", "Strength", "Abilities", "Relationships", "Relationship",
  "Memberships", "Membership", "Honorifics", "Honorific", "Equipment", "Weapons", "Weapon",
  "Talents", "Talent", "Powers", "Power", "Spells", "Spell", "Focuses", "Classes", "Class",
  "Attacks", "Stunts", "Novice", "Apprentice", "Expert",
  "Master", "Apex", "Speed", "Fortune", "Health", "Defense", "Toughness", "Armor",
  "Move", "Run", "Fatigue", "Focus"
]);

const WRAPPABLE_STRUCTURE = Object.freeze([
  /^(?:Special Qualities|Special Features|Favored Stunts|Armor Rating|Weapon Attack Roll Damage)\s*:?$/iu,
  /^(?:Abilities)\s*\(\s*(?:Focus|Focuses)\s*\)\s*:?$/iu,
  /^(?:Speed)\s+(?:Health|Fortune)\s+(?:Defense)(?:\s+(?:Armor(?:\s+Rating)?|Toughness|Move|Run|Fatigue))*\s*:?$/iu,
]);

const VALUE_LABEL = /^(?:Requirements?|Prerequisites?|Classes?|Threat|Equipment|Talents?|Specializations?|Favored Stunts|Relationships?|Memberships?|Honorifics)\s*:\s*$/iu;
const SECTION_OR_DEGREE_BOUNDARY = /^(?:(?:Special Qualities|Special Features|Abilities(?:\s*\(\s*Focus(?:es)?\s*\))?|Weapon Attack Roll Damage|Armor Rating)|(?:Requirements?|Prerequisites?|Classes?|Threat|Equipment|Weapons?|Talents?|Specializations?|Favored Stunts|Stunts|Powers?|Spells?|Attacks|Focus(?:es)?|Relationships?|Memberships?|Honorifics?)|(?:Novice|Apprentice|Journeyman|Expert|Master|Grandmaster|Apex))(?:\s*:\s*.*)?$/iu;
const STRUCTURAL_DECORATION = /^(?:[\u2022\u2023\u2043\u204C\u204D\u2219\u25A0-\u25AA\u25CF\u25E6\u25C6\u25C7*]+\s*|-{1,3}\s+)/u;
const TRAILING_HEADING_DASH = /\s+-{1,3}\s*$/u;

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function spacedLabelPattern(label) {
  return label.split(/\s+/u).map(word => Array.from(word).map(escapeRegExp).join("\\s*")).join("\\s+");
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

function structureCandidate(value, changes) {
  let candidate = String(value ?? "").replace(HORIZONTAL_SPACE, " ").trim();
  candidate = candidate.replace(STRUCTURAL_DECORATION, "").replace(TRAILING_HEADING_DASH, "").trim();
  return repairKnownLabels(candidate, changes);
}

function isKnownStructure(value, changes) {
  const candidate = structureCandidate(value, changes);
  return WRAPPABLE_STRUCTURE.some(pattern => pattern.test(candidate));
}

function isWrappedValueBoundary(value, changes) {
  const candidate = structureCandidate(value, changes);
  return SECTION_OR_DEGREE_BOUNDARY.test(candidate)
    || WRAPPABLE_STRUCTURE.some(pattern => pattern.test(candidate));
}

/**
 * Join only bounded, recognized headings which a PDF divided over two or three
 * physical lines. Arbitrary prose and unrecognized headings retain their line
 * breaks.
 */
function repairWrappedStructures(lines, changes) {
  const repaired = [...lines];
  for (let index = 0; index < repaired.length; index++) {
    if (!repaired[index]) continue;
    const maximum = Math.min(MAX_WRAPPED_LABEL_LINES, repaired.length - index);
    for (let size = maximum; size >= 2; size--) {
      const slice = repaired.slice(index, index + size);
      if (slice.some(line => !line)) continue;
      const combined = slice.join(" ");
      if (!isKnownStructure(combined, changes)) continue;
      repaired.splice(index, size, structureCandidate(combined, changes));
      changes.wrappedLabels = (changes.wrappedLabels ?? 0) + 1;
      break;
    }
  }
  return repaired;
}

function repairWrappedValues(lines, changes) {
  const repaired = [...lines];
  for (let index = 0; index < repaired.length - 1; index++) {
    const label = repaired[index];
    if (!VALUE_LABEL.test(structureCandidate(label, changes))) continue;
    const next = repaired[index + 1];
    if (!next || VALUE_LABEL.test(structureCandidate(next, changes)) || isWrappedValueBoundary(next, changes)) continue;
    repaired.splice(index, 2, `${label} ${next}`.trim());
    changes.wrappedValues = (changes.wrappedValues ?? 0) + 1;
  }
  return repaired;
}

/** Normalize common searchable-PDF clipboard damage without rewriting prose. */
export function normalizePdfClipboardText(value) {
  const original = String(value ?? "");
  const changes = {};
  let text = original;
  text = countChange(changes, "unicode", text, text.normalize("NFKC"));
  text = countChange(changes, "lineEndings", text, text.replace(/\r\n?/gu, "\n"));
  text = countChange(changes, "invisibleCharacters", text, text.replace(INVISIBLE_CHARACTERS, ""));
  text = countChange(changes, "softHyphens", text, text.replace(/\u00AD/gu, ""));
  text = countChange(changes, "dashCharacters", text, text.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/gu, "-"));
  text = countChange(changes, "bulletCharacters", text,
    text.replace(/[\u2023\u2043\u204C\u204D\u2219\u25A0-\u25AA\u25CF\u25E6\u25C6\u25C7]/gu, "\u2022"));
  // Requiring either the start of input or a non-letter prefix prevents the
  // leading word matcher from retrying at every character of a long line.
  text = countChange(changes, "lineBreakHyphens", text,
    text.replace(/(^|[^\p{L}])([\p{L}]{2,})-\s*\n\s*([\p{Ll}]{2,})/gu, "$1$2$3"));
  // All-cap headings and table cells often preserve upper case on both sides
  // of a PDF line-wrap. Requiring two all-cap fragments avoids joining ordinary
  // title-case compounds.
  text = countChange(changes, "lineBreakHyphens", text,
    text.replace(/(^|[^\p{L}])([\p{Lu}]{2,})-\s*\n\s*([\p{Lu}]{2,})(?!\p{Ll})/gu, "$1$2$3"));

  let lines = text.split("\n").map(line => {
    let normalized = line.replace(HORIZONTAL_SPACE, " ").trim();
    if (normalized.length <= MAX_LABEL_REPAIR_LINE_LENGTH) normalized = repairKnownLabels(normalized, changes);
    normalized = normalized.replace(/\s+([,.;)\]])/gu, "$1").replace(/([(\[])\s+/gu, "$1");
    if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)) {
      normalized = normalized.replace(/^([^:]{1,60})\s*:\s*/u, (_match, prefix) => `${prefix.trimEnd()}: `);
    }
    return normalized.trimEnd();
  });
  lines = repairWrappedStructures(lines, changes);
  lines = repairWrappedValues(lines, changes);
  text = lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  countChange(changes, "spacing", original, text);
  return Object.freeze({original, text, changed: original !== text, changes: Object.freeze({...changes})});
}

export function normalizeImportName(value) {
  return String(value ?? "").normalize("NFKD").replace(COMBINING_MARKS, "")
    .replace(/[\u2018\u2019\u201B`´]/gu, "'").replace(/&/gu, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase().replace(/\s+/gu, " ");
}

export function normalizeImportedTitle(value) {
  const cleaned = String(value ?? "").normalize("NFKC").replace(INVISIBLE_CHARACTERS, "")
    .replace(/^\s*(?:(?:[•\u2023\u2043\u204C\u204D\u2219\u25A0-\u25AA\u25CF\u25E6\u25C6\u25C7*#]+)|(?:-{1,3}(?=\s))|(?:\d+[.)]))\s*/u, "")
    .replace(/^[_*]+|[_*:]+$/gu, "")
    .replace(HORIZONTAL_SPACE, " ").trim();
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
    .replace(/\r\n?/gu, "\n")
    .split(/\s*(?:,|;|[•·\u2023\u2043\u204C\u204D\u2219\u25A0-\u25AA\u25CF\u25E6\u25C6\u25C7])\s*|\n\s*(?:[*#]+|-{1,3})\s+/u)
    .map(entry => entry.replace(/^\s*(?:[*#•·]+\s*|-{1,3}\s+)/u, "").trim())
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
      current[rightIndex] = Math.min(current[rightIndex - 1] + 1, previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1));
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
  const containment = left.includes(right) || right.includes(left) ? Math.min(left.length, right.length) / longest : 0;
  return Math.max(editScore * 0.9, tokenScore(left, right) * 0.94, containment * 0.88);
}

export function rankImportCandidates(query, candidates, {limit = 8, minimum = 0.58} = {}) {
  const maximum = Math.max(1, Math.min(Number(limit) || 8, 50));
  return Array.from(candidates ?? []).map(candidate => ({...candidate, confidence: scoreImportName(query, candidate?.name)}))
    .filter(candidate => candidate.confidence >= minimum)
    .sort((left, right) => right.confidence - left.confidence
      || String(left.name).localeCompare(String(right.name))
      || String(left.uuid ?? left.id ?? "").localeCompare(String(right.uuid ?? right.id ?? "")))
    .slice(0, maximum);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}

/** Produce a stable digest for a preview's immutable input and environment snapshot. */
export async function digestImportSnapshot(value) {
  const serialized = JSON.stringify(canonicalize(value));
  if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
    return `sha256:${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}
