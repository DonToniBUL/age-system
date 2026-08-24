function objectBranch(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function dataFieldOperatorValue(value) {
    const Operator = foundry.data?.operators?.DataFieldOperator;
    return typeof Operator?.get === "function" ? Operator.get(value) : value;
}

function isDataFieldOperator(value) {
    return dataFieldOperatorValue(value) !== value;
}

function containsDataFieldOperator(value) {
    if (isDataFieldOperator(value)) return true;
    if (Array.isArray(value)) return value.some(entry => containsDataFieldOperator(entry));
    if (!objectBranch(value)) return false;
    return Object.values(value).some(entry => containsDataFieldOperator(entry));
}

function hasSystemChange(changed) {
    if (!changed || typeof changed !== "object") return false;
    return Object.prototype.hasOwnProperty.call(changed, "system")
        || Object.keys(changed).some(path => path.startsWith("system."));
}

/**
 * Rebuild partial AGE document system-object updates from raw source.
 *
 * AGE keeps its compatibility data in top-level AnyFields. Foundry correctly
 * treats those fields as atomic values, which means an ordinary dotted update
 * such as `system.health.value` is expanded to `{health: {value}}` and can
 * replace the complete persisted health object. Always merge a requested leaf
 * into the raw `_source` branch, then mark that complete branch as an explicit
 * replacement. Prepared `actor.system` is deliberately never used because it
 * contains derived values which must not be persisted.
 *
 * The same boundary protects Actor resources and Item collections such as
 * modifiers. An existing DataFieldOperator is preserved, giving migrations
 * and other deliberate callers an explicit way to request their own complete
 * branch replacement or deletion.
 */
export function normalizeAtomicSystemUpdate(changed, source, {recursive = true} = {}) {
    // Foundry's `recursive: false` option promotes root fields to forced
    // replacements. A partial AGE `system` request would therefore replace
    // the entire TypeDataModel before its AnyFields can be reconstructed.
    // Reject all system updates in that mode instead of silently changing the
    // caller's requested update semantics. AGE callers must use the normal
    // recursive mode even when they already hold a complete system value.
    if (recursive === false && hasSystemChange(changed)) {
        throw new Error("AGE System cannot safely apply partial system updates with recursive:false; use the default recursive update mode.");
    }

    const expanded = foundry.utils.expandObject(changed ?? {});
    let changedSystem = expanded?.system;
    const storedSystem = source?.system;
    if (!objectBranch(changedSystem) || !objectBranch(storedSystem)) return {...(changed ?? {})};
    if (isDataFieldOperator(changedSystem)) return expanded;

    // Be defensive about callers which mix nested and dotted updates. Foundry
    // normally provides one representation, but merge the two explicitly so a
    // later `system` key cannot overwrite an earlier `system.health.value`.
    if (objectBranch(changed?.system) && !isDataFieldOperator(changed.system)) {
        const nestedSystem = foundry.utils.expandObject({system: changed.system}).system;
        const dotted = {};
        for (const [path, value] of Object.entries(changed)) {
            if (path.startsWith("system.")) foundry.utils.setProperty(dotted, path, value);
        }
        if (objectBranch(dotted.system)) {
            foundry.utils.mergeObject(nestedSystem, dotted.system, {
                inplace: true,
                recursive: true,
                insertKeys: true,
                overwrite: true,
                applyOperators: false
            });
        }
        changedSystem = nestedSystem;
    }

    const normalized = {};
    for (const [field, value] of Object.entries(expanded)) {
        if (field !== "system") normalized[field] = value;
    }
    const normalizedSystem = {};
    const ForcedReplacement = foundry.data?.operators?.ForcedReplacement;
    if (typeof ForcedReplacement?.create !== "function") {
        throw new Error("AGE System requires Foundry's ForcedReplacement data operator for atomic document updates.");
    }

    for (const [field, submittedValue] of Object.entries(changedSystem)) {
        const path = `system.${field}`;
        if (isDataFieldOperator(submittedValue)) {
            normalizedSystem[field] = submittedValue;
            continue;
        }
        const storedValue = storedSystem[field];

        // Dotted edits to an array AnyField expand to an object with numeric
        // keys. Rebuild the complete persisted array exactly as we do for
        // object branches. Element deletion is deliberately rejected because
        // its splice-versus-sparse semantics are ambiguous; callers should
        // submit an intentional complete array replacement instead.
        if (Array.isArray(storedValue) && objectBranch(submittedValue)) {
            if (containsDataFieldOperator(submittedValue)) {
                throw new Error(`AGE System cannot apply data operators to an indexed atomic array edit at ${path}; submit the complete array instead.`);
            }
            const indices = Object.keys(submittedValue).map(key => Number(key));
            if (Object.keys(submittedValue).some(key => !/^(0|[1-9]\d*)$/.test(key))
                || indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= storedValue.length)) {
                throw new Error(`AGE System received an invalid indexed atomic array edit at ${path}.`);
            }
            const completeArray = foundry.utils.deepClone(storedValue);
            foundry.utils.mergeObject(completeArray, submittedValue, {
                inplace: true,
                recursive: true,
                insertKeys: true,
                overwrite: true,
                applyOperators: false
            });
            normalizedSystem[field] = ForcedReplacement.create(completeArray);
            continue;
        }

        if (!objectBranch(submittedValue) || !objectBranch(storedValue)) {
            normalizedSystem[field] = submittedValue;
            continue;
        }

        const completeValue = foundry.utils.deepClone(storedValue);
        foundry.utils.mergeObject(completeValue, submittedValue, {
            inplace: true,
            recursive: true,
            insertKeys: true,
            overwrite: true,
            applyOperators: true
        });
        normalizedSystem[field] = ForcedReplacement.create(completeValue);
    }
    normalized.system = normalizedSystem;
    return normalized;
}

/**
 * In-place variant for Document `_preUpdate` hooks. Foundry expects subclasses
 * to mutate the supplied changes object rather than replace its identity.
 */
export function mutateAtomicSystemUpdate(changed, source, options = {}) {
    const normalized = normalizeAtomicSystemUpdate(changed, source, options);
    for (const key of Object.keys(changed ?? {})) delete changed[key];
    Object.assign(changed, normalized);
    return changed;
}

// Compatibility aliases keep the intent clear at Character-specific callers
// while the same AnyField safety boundary is shared by every AGE document.
export const normalizeCharacterAtomicSystemUpdate = normalizeAtomicSystemUpdate;
export const mutateCharacterAtomicSystemUpdate = mutateAtomicSystemUpdate;

export default normalizeAtomicSystemUpdate;
