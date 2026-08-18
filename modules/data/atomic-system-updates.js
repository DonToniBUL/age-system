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
    return Object.hasOwn(changed, "system") || Object.keys(changed).some(path => path.startsWith("system."));
}

/**
 * Rebuild partial updates to top-level system AnyFields from persisted source.
 * Foundry treats AnyFields atomically, so a dotted leaf update must become an
 * explicit replacement of the complete raw branch rather than a partial object.
 */
export function normalizeAtomicSystemUpdate(changed, source, {recursive = true} = {}) {
    if (recursive === false && hasSystemChange(changed)) {
        throw new Error("AGE System cannot safely apply partial system updates with recursive:false; use the default recursive update mode.");
    }

    if (isDataFieldOperator(changed?.system)) return {...(changed ?? {})};
    const explicitBranchOperators = new Map();
    if (objectBranch(changed?.system)) {
        for (const [field, value] of Object.entries(changed.system)) {
            if (isDataFieldOperator(value)) explicitBranchOperators.set(field, value);
        }
    }
    for (const [path, value] of Object.entries(changed ?? {})) {
        const match = /^system\.([^.]+)$/.exec(path);
        if (match && isDataFieldOperator(value)) explicitBranchOperators.set(match[1], value);
    }

    const expanded = foundry.utils.expandObject(changed ?? {});
    let changedSystem = expanded?.system;
    const storedSystem = source?.system;
    if (!objectBranch(changedSystem) || !objectBranch(storedSystem)) return {...(changed ?? {})};
    if (isDataFieldOperator(changedSystem)) return expanded;

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
    for (const [field, operator] of explicitBranchOperators) changedSystem[field] = operator;

    const normalized = {};
    for (const [field, value] of Object.entries(changed ?? {})) {
        if (field !== "system" && !field.startsWith("system.")) normalized[field] = value;
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

export function mutateAtomicSystemUpdate(changed, source, options = {}) {
    const normalized = normalizeAtomicSystemUpdate(changed, source, options);
    for (const key of Object.keys(changed ?? {})) delete changed[key];
    Object.assign(changed, normalized);
    return changed;
}

export const normalizeCharacterAtomicSystemUpdate = normalizeAtomicSystemUpdate;
export const mutateCharacterAtomicSystemUpdate = mutateAtomicSystemUpdate;

export default normalizeAtomicSystemUpdate;
