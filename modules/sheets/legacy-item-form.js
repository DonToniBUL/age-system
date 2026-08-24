const LEGACY_WEAPON_CANONICAL_FIELDS = Object.freeze([
    "system.dmgSource",
    "system.minStr",
    "system.reload"
]);
const LEGACY_POWER_CANONICAL_FIELDS = Object.freeze([
    "system.dmgSource",
    "system.castTime"
]);

function clone(value) {
    if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function replaceSubmittedValue(submitData, path, value) {
    let replaced = false;
    if (Object.prototype.hasOwnProperty.call(submitData ?? {}, path)) {
        submitData[path] = clone(value);
        replaced = true;
    }

    const [root, field] = path.split(".");
    const branch = submitData?.[root];
    if (branch && typeof branch === "object" && Object.prototype.hasOwnProperty.call(branch, field)) {
        branch[field] = clone(value);
        replaced = true;
    }
    return replaced;
}

function removeSubmittedValue(submitData, path) {
    if (Object.prototype.hasOwnProperty.call(submitData ?? {}, path)) delete submitData[path];

    const [root, field] = path.split(".");
    const branch = submitData?.[root];
    if (branch && typeof branch === "object") delete branch[field];
}

export function itemCanonicalFieldsForItem(item) {
    const type = typeof item === "string" ? item : item?.type;
    if (type === "weapon") return LEGACY_WEAPON_CANONICAL_FIELDS;
    if (type === "power") return LEGACY_POWER_CANONICAL_FIELDS;
    return [];
}

// Compatibility alias retained for the selectable AppV1 sheets and modules
// which imported the original helper during the 5.0 transition.
export const legacyCanonicalFieldsForItem = itemCanonicalFieldsForItem;

/**
 * Identify canonical fields which were explicitly requested by the current
 * submission. Native submit-on-change events expose the changed control, while
 * manual ApplicationV2 submissions carry explicit flat or nested updateData.
 */
export function itemCanonicalEditPaths(item, eventTarget = null, updateData = null) {
    const protectedPaths = itemCanonicalFieldsForItem(item);
    const edited = new Set();
    const eventPath = String(eventTarget?.name ?? "").trim();
    if (protectedPaths.includes(eventPath)) edited.add(eventPath);

    for (const path of protectedPaths) {
        const field = path.slice("system.".length);
        if (Object.prototype.hasOwnProperty.call(updateData ?? {}, path)
            || Object.prototype.hasOwnProperty.call(updateData?.system ?? {}, field)) {
            edited.add(path);
        }
    }
    return edited;
}

/**
 * AGE Item sheets submit their entire form when one control changes. Preserve
 * raw Weapon and Power values which normalized controls only display through
 * a canonical representation unless the user explicitly changed that control.
 */
export function preserveItemCanonicalSubmitData(item, submitData, editedPaths = []) {
    if (!submitData || typeof submitData !== "object") return submitData;
    const protectedPaths = itemCanonicalFieldsForItem(item);
    if (!protectedPaths.length) return submitData;
    const edited = editedPaths instanceof Set ? editedPaths : new Set(editedPaths ?? []);
    const source = item?._source?.system ?? {};

    for (const path of protectedPaths) {
        if (edited.has(path)) continue;
        const field = path.slice("system.".length);
        if (!Object.prototype.hasOwnProperty.call(source, field)) {
            removeSubmittedValue(submitData, path);
            continue;
        }
        replaceSubmittedValue(submitData, path, source[field]);
    }
    return submitData;
}

// Compatibility alias retained for the accepted AppV1 fallback boundary.
export const preserveLegacyItemSubmitData = preserveItemCanonicalSubmitData;
