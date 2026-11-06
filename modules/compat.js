/**
 * Foundry VTT v14 compatibility helpers.
 */

/** Foundry v14 ChatMessage visibility mode names. */
export const MESSAGE_MODES = Object.freeze({
    PUBLIC: "public",
    SELF: "self",
    GM: "gm",
    BLIND: "blind"
});

/**
 * Translate pre-v14 roll-mode names to v14 message-mode names.
 * Existing world settings and third-party callers may still pass legacy values.
 * @param {string|null|undefined} mode
 * @returns {string}
 */
export function normalizeMessageMode(mode) {
    switch (mode) {
        case "roll":
        case "publicroll":
        case "public":
        case null:
        case undefined:
            return MESSAGE_MODES.PUBLIC;
        case "selfroll":
        case "self":
            return MESSAGE_MODES.SELF;
        case "gmroll":
        case "private":
        case "gm":
            return MESSAGE_MODES.GM;
        case "blindroll":
        case "blind":
            return MESSAGE_MODES.BLIND;
        default:
            return CONFIG.ChatMessage?.modes?.[mode] ? mode : MESSAGE_MODES.PUBLIC;
    }
}

/** Read the Foundry core default chat visibility mode. */
export function getCoreMessageMode() {
    try {
        return normalizeMessageMode(game.settings.get("core", "messageMode"));
    } catch (error) {
        console.warn("AGE System | Unable to read core.messageMode; using public visibility.", error);
        return MESSAGE_MODES.PUBLIC;
    }
}

/**
 * Apply a v14 visibility mode to ChatMessage source data.
 * @param {object} chatData
 * @param {string|null|undefined} mode
 * @returns {object}
 */
export function applyMessageMode(chatData, mode) {
    return ChatMessage.applyMode(chatData, normalizeMessageMode(mode));
}


/**
 * Normalize status-effect configuration for v14 while accepting legacy arrays
 * and the deprecated `icon` field saved by older AGE versions.
 * @param {object[]|Record<string, object>|null|undefined} source
 * @returns {object[]}
 */
export function statusEffectArray(source = CONFIG.statusEffects) {
    const values = Array.isArray(source) ? source : Object.values(source ?? {});
    return values.filter(Boolean).map((effect) => {
        const normalized = foundry.utils.deepClone(effect);
        normalized.img = normalized.img ?? normalized.icon ?? "icons/svg/aura.svg";
        delete normalized.icon;
        return normalized;
    });
}

/**
 * Convert status-effect configuration to the keyed record required by v14.
 * @param {object[]|Record<string, object>|null|undefined} source
 * @returns {Record<string, object>}
 */
export function statusEffectRecord(source, finalKeys = []) {
    return Object.fromEntries(statusEffectArray(source)
        .filter((effect) => effect.id)
        .map((effect, order) => {
            const normalized = normalizeActiveEffectData(effect, finalKeys);
            return [normalized.id, {...normalized, order: normalized.order ?? order}];
        }));
}


const LEGACY_EFFECT_TYPES = Object.freeze({
    0: "custom",
    1: "multiply",
    2: "add",
    3: "downgrade",
    4: "upgrade",
    5: "override"
});

/** Convert a pre-v14 Active Effect change into the v14 schema. */
export function normalizeActiveEffectChange(change, finalKeys = []) {
    const normalized = foundry.utils.deepClone(change ?? {});
    const sourceType = normalized.type ?? normalized.mode;
    normalized.type = typeof sourceType === "number" ? (LEGACY_EFFECT_TYPES[sourceType] ?? "custom") : (sourceType ?? "custom");
    normalized.phase = normalized.phase ?? (finalKeys.includes(normalized.key) ? "final" : "initial");
    const changeType = CONFIG.ActiveEffect?.changeTypes?.[normalized.type];
    normalized.priority = normalized.priority ?? changeType?.priority ?? changeType?.defaultPriority ?? 0;
    delete normalized.mode;
    return normalized;
}

/** Normalize every change and image field in an Active Effect source object. */
export function normalizeActiveEffectData(effect, finalKeys = []) {
    const normalized = foundry.utils.deepClone(effect ?? {});
    normalized.img = normalized.img ?? normalized.icon ?? "icons/svg/aura.svg";
    delete normalized.icon;
    normalized.changes = (normalized.changes ?? []).map((change) => normalizeActiveEffectChange(change, finalKeys));
    return normalized;
}
