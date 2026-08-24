/**
 * Stable data contracts introduced for the AGE 5.x interface boundary.
 *
 * These validators deliberately do not replace Actor or Item TypeDataModels yet.
 * Existing AGE worlds contain permissive legacy values which need a dedicated,
 * previewable migration before Foundry may enforce strict document schemas.
 */

export const AGE_CONTRACT_VERSION = 1;
export const AGE_CHAT_CARD_SCHEMA_VERSION = 1;

export const AGE_CHAT_CARD_KINDS = Object.freeze([
    "ability",
    "attack",
    "damage",
    "healing",
    "item",
    "power",
    "requested-roll",
    "resistance",
    "system"
]);

function cleanString(value, fallback = "") {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function cleanUuid(value) {
    const uuid = cleanString(value);
    return uuid || null;
}

function normalizeTarget(target) {
    if (typeof target === "string") return {uuid: cleanUuid(target), name: "", outcome: null};
    if (!target || typeof target !== "object") return null;
    const uuid = cleanUuid(target.uuid ?? target.actorUuid ?? target.tokenUuid);
    if (!uuid) return null;
    return {
        uuid,
        name: cleanString(target.name ?? target.actorName ?? target.tokenName),
        outcome: cleanString(target.outcome ?? target.result) || null
    };
}

export function createStructuredChatCard(source = {}) {
    const requestedKind = cleanString(source.kind, "system");
    const kind = AGE_CHAT_CARD_KINDS.includes(requestedKind) ? requestedKind : "system";
    const targets = (Array.isArray(source.targets) ? source.targets : [])
        .map(normalizeTarget)
        .filter(Boolean);

    return {
        schemaVersion: AGE_CHAT_CARD_SCHEMA_VERSION,
        kind,
        title: cleanString(source.title, "AGE"),
        subtitle: cleanString(source.subtitle),
        actorUuid: cleanUuid(source.actorUuid),
        itemUuid: cleanUuid(source.itemUuid),
        actionId: cleanString(source.actionId) || null,
        targets,
        data: source.data && typeof source.data === "object" && !Array.isArray(source.data)
            ? {...source.data}
            : {}
    };
}

export function validateStructuredChatCard(card) {
    const errors = [];
    if (!card || typeof card !== "object" || Array.isArray(card)) {
        return {valid: false, errors: ["Card must be an object."]};
    }
    if (card.schemaVersion !== AGE_CHAT_CARD_SCHEMA_VERSION) errors.push("Unsupported schemaVersion.");
    if (!AGE_CHAT_CARD_KINDS.includes(card.kind)) errors.push("Unknown card kind.");
    if (typeof card.title !== "string" || !card.title.trim()) errors.push("title is required.");
    if (!Array.isArray(card.targets)) errors.push("targets must be an array.");
    if (!card.data || typeof card.data !== "object" || Array.isArray(card.data)) errors.push("data must be an object.");
    return {valid: errors.length === 0, errors};
}

export function validateAgeActionContract(action) {
    const errors = [];
    if (!action || typeof action !== "object" || Array.isArray(action)) {
        return {valid: false, errors: ["Action must be an object."]};
    }
    if (!Number.isInteger(action.schemaVersion) || action.schemaVersion < 1) errors.push("schemaVersion must be a positive integer.");
    if (typeof action.id !== "string" || !action.id.trim()) errors.push("id is required.");
    if (typeof action.type !== "string" || !action.type.trim()) errors.push("type is required.");
    if (!Array.isArray(action.targetUuids)) errors.push("targetUuids must be an array.");
    if (!action.payload || typeof action.payload !== "object" || Array.isArray(action.payload)) errors.push("payload must be an object.");
    if (!action.metadata || typeof action.metadata !== "object" || Array.isArray(action.metadata)) errors.push("metadata must be an object.");
    return {valid: errors.length === 0, errors};
}

export const AgeDataContracts = Object.freeze({
    version: AGE_CONTRACT_VERSION,
    chatCardSchemaVersion: AGE_CHAT_CARD_SCHEMA_VERSION,
    createStructuredChatCard,
    validateStructuredChatCard,
    validateAgeActionContract
});
