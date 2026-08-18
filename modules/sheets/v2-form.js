/**
 * Preserve permissive legacy values which an HTML number input cannot display.
 * Blank numeric controls are omitted from the update instead of coercing an
 * unrelated save into an accidental zero/null migration.
 */
export function omitBlankNumericFields(submitData, form) {
    for (const input of form?.querySelectorAll?.('[data-dtype="Number"]') ?? []) {
        if (String(input.value ?? "").trim() !== "") continue;
        if (input.name) foundry.utils.deleteProperty(submitData, input.name);
    }
    return submitData;
}

/**
 * Rebuild a submitted legacy object branch from its stored source at the
 * Document update boundary.
 *
 * AGE's compatibility-first data models intentionally keep several legacy
 * structures as AnyFields. Foundry validates an expanded form object before
 * `_processSubmitData`, so a form which renders only part of one of those
 * structures can otherwise replace omitted source members with defaults.
 * Record branches may additionally whitelist their genuinely editable fields
 * and discard prepared-only values emitted by disabled controls.
 */
export function preserveAppV2SourceBranch(submitData, source, path, {
    recordFields = null,
    transientFields = []
} = {}) {
    const submitted = foundry.utils.getProperty(submitData, path);
    const stored = foundry.utils.getProperty(source, path);
    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) return submitData;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return submitData;
    const merged = foundry.utils.deepClone(stored);

    if (Array.isArray(recordFields)) {
        for (const record of Object.values(merged)) {
            if (!record || typeof record !== "object" || Array.isArray(record)) continue;
            for (const field of transientFields) delete record[field];
        }
        for (const [key, submittedRecord] of Object.entries(submitted)) {
            if (!submittedRecord || typeof submittedRecord !== "object" || Array.isArray(submittedRecord)) continue;
            const target = merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key])
                ? merged[key]
                : (merged[key] = {});
            for (const field of recordFields) {
                if (Object.hasOwn(submittedRecord, field)) target[field] = submittedRecord[field];
            }
        }
    } else {
        foundry.utils.mergeObject(merged, submitted, {inplace: true, recursive: true});
    }
    foundry.utils.setProperty(submitData, path, merged);
    return submitData;
}

/**
 * Rebuild every submitted top-level system object from document source.
 *
 * Compatibility models expose legacy object structures as AnyFields. Foundry
 * treats an update to one of those fields atomically, so the value sent to the
 * Document update boundary must contain source members which are not rendered
 * by the current sheet or rules profile.
 */
export function preserveAppV2TopLevelSourceBranches(submitData, source, {exclude = []} = {}) {
    const submittedSystem = submitData?.system;
    const storedSystem = source?.system;
    if (!submittedSystem || typeof submittedSystem !== "object" || Array.isArray(submittedSystem)) return submitData;
    if (!storedSystem || typeof storedSystem !== "object" || Array.isArray(storedSystem)) return submitData;
    const excluded = new Set(exclude);
    for (const [field, submitted] of Object.entries(submittedSystem)) {
        if (excluded.has(field) || !submitted || typeof submitted !== "object" || Array.isArray(submitted)) continue;
        const stored = storedSystem[field];
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) continue;
        preserveAppV2SourceBranch(submitData, source, `system.${field}`);
    }
    return submitData;
}

function formValuesEqual(submitted, prepared) {
    if (submitted === prepared) return true;
    const submittedNumeric = typeof submitted === "number"
        || (typeof submitted === "string" && submitted.trim() !== "" && Number.isFinite(Number(submitted)));
    const preparedNumeric = typeof prepared === "number"
        || (typeof prepared === "string" && prepared.trim() !== "" && Number.isFinite(Number(prepared)));
    if (submittedNumeric && preparedNumeric) return Number(submitted) === Number(prepared);
    if (submitted && prepared && typeof submitted === "object" && typeof prepared === "object") {
        const equals = foundry.utils.equals;
        if (typeof equals === "function") return equals(submitted, prepared);
        try {
            return JSON.stringify(submitted) === JSON.stringify(prepared);
        } catch (_error) {
            return false;
        }
    }
    return false;
}

/**
 * Reduce a Character submit-on-change payload to the control which actually
 * changed. DocumentSheetV2 serializes the complete form for every change, but
 * several AGE controls display prepared/default values rather than independent
 * source edits. Treating that complete form as an update allows one ability or
 * resource edit to overwrite every sibling control with a stale zero/blank.
 *
 * Native change events retain only their named origin. Programmatic/full-form
 * submissions (including QA) retain only values which differ from the Actor's
 * currently prepared data.
 */
export function retainCharacterAppV2Changes(submitData, actor, eventTarget = null) {
    const flattened = foundry.utils.flattenObject(submitData);
    const requestedPath = String(eventTarget?.name ?? "").trim();
    const retained = {};
    if (requestedPath) {
        if (Object.hasOwn(flattened, requestedPath)) {
            foundry.utils.setProperty(retained, requestedPath, flattened[requestedPath]);
        } else if (eventTarget?.type === "checkbox") {
            foundry.utils.setProperty(retained, requestedPath, false);
        }
        return retained;
    }
    for (const [path, value] of Object.entries(flattened)) {
        if (formValuesEqual(value, foundry.utils.getProperty(actor, path))) {
            continue;
        }
        foundry.utils.setProperty(retained, path, value);
    }
    return retained;
}

/**
 * Read one native Character AppV2 control without serializing the surrounding
 * form. Character sheets contain prepared and profile-dependent values which
 * must never become implicit updates merely because a sibling control changed.
 */
export function characterAppV2ControlDelta(control) {
    const name = String(control?.name ?? "").trim();
    if (!name || control?.disabled) return {};

    let value;
    const type = String(control.type ?? "").toLowerCase();
    const dtype = String(control.dataset?.dtype ?? "").toLowerCase();
    if (type === "checkbox") value = Boolean(control.checked);
    else if (control.multiple && control.selectedOptions) {
        value = Array.from(control.selectedOptions, option => option.value);
    } else if (type === "number" || type === "range" || dtype === "number") {
        if (String(control.value ?? "").trim() === "") return {};
        value = Number(control.value);
        if (!Number.isFinite(value)) return {};
    } else if (dtype === "boolean") {
        value = String(control.value).toLowerCase() === "true";
    } else value = control.value;

    const delta = {};
    foundry.utils.setProperty(delta, name, value);
    return delta;
}

/**
 * Convert a validated change-only Character payload into complete atomic
 * AnyField branches using the Actor source which exists when its queued update
 * actually runs. Deferring this merge prevents a later rapid edit from
 * rebuilding a branch from source captured before an earlier edit completed.
 */
export function buildCharacterAppV2AtomicUpdate(submitData, source) {
    const update = foundry.utils.deepClone(submitData);
    preserveAppV2SourceBranch(update, source, "system.abilities", {
        recordFields: ["value", "primary", "lastUp"]
    });
    preserveAppV2TopLevelSourceBranches(update, source, {exclude: ["abilities"]});
    return update;
}

/**
 * Keep each Character compatibility field atomic without submitting the whole
 * `system` object. AGE reconstructs these permissive legacy AnyFields from raw
 * source, then marks each branch as an explicit replacement. Foundry's server
 * does not load a world's system DataModel schema, so an ordinary object can be
 * recursively minimized there and returned to the browser as a destructive
 * partial AnyField. ForcedReplacement survives validation, socket transport,
 * and the server response and therefore preserves the complete raw branch.
 *
 * Dotted top-level compatibility paths still limit the transaction to the
 * branches which actually belong to the edited control.
 */
export function flattenCharacterAppV2AtomicBranches(submitData) {
    const update = {};
    const ForcedReplacement = foundry.data.operators.ForcedReplacement;
    for (const [field, value] of Object.entries(submitData ?? {})) {
        if (field !== "system" || !value || typeof value !== "object" || Array.isArray(value)) {
            update[field] = value;
            continue;
        }
        for (const [systemField, systemValue] of Object.entries(value)) {
            update[`system.${systemField}`] = ForcedReplacement.create(
                foundry.utils.deepClone(systemValue)
            );
        }
    }
    return update;
}

/**
 * Fold Character controls which represent one logical transaction into the
 * native AppV2 submission. This replaces parallel change listeners which used
 * to race the DocumentSheetV2 submit-on-change update.
 */
export function normalizeCharacterAppV2Submission(submitData, actor, eventTarget = null) {
    const submittedAbilities = submitData?.system?.abilities;
    if (submittedAbilities && typeof submittedAbilities === "object" && !Array.isArray(submittedAbilities)) {
        let selectedLastUp = null;
        const targetMatch = eventTarget?.name?.match(/^system\.abilities\.([^.]+)\.lastUp$/u);
        if (targetMatch && foundry.utils.getProperty(submitData, eventTarget.name) === true) {
            selectedLastUp = targetMatch[1];
        } else {
            for (const [key, record] of Object.entries(submittedAbilities)) {
                if (record?.lastUp === true && actor?.system?.abilities?.[key]?.lastUp !== true) {
                    selectedLastUp = key;
                    break;
                }
            }
        }
        if (selectedLastUp) {
            for (const key of Object.keys(actor?._source?.system?.abilities ?? actor?.system?.abilities ?? {})) {
                foundry.utils.setProperty(submitData, `system.abilities.${key}.lastUp`, key === selectedLastUp);
            }
        }
    }

    const selectedDefend = eventTarget?.name === "system.defend.active"
        && foundry.utils.getProperty(submitData, "system.defend.active") === true;
    const selectedGuard = eventTarget?.name === "system.guardUp.active"
        && foundry.utils.getProperty(submitData, "system.guardUp.active") === true;
    if (selectedDefend && actor?.system?.guardUp?.active) {
        foundry.utils.setProperty(submitData, "system.guardUp.active", false);
    }
    if (selectedGuard && actor?.system?.defend?.active) {
        foundry.utils.setProperty(submitData, "system.defend.active", false);
    }
    return submitData;
}

/**
 * DocumentSheetV2 expands dotted form names before validation. AGE keeps a
 * number of permissive legacy structures in AnyFields, so passing those
 * expanded branches to Document#update can replace an entire structure with
 * only the controls rendered for the active rules profile. Convert the
 * validated object back to leaf updates at the final update boundary.
 *
 * Empty plain objects are omitted. They are produced when every control in a
 * branch was an intentionally preserved blank numeric value and must not be
 * interpreted as a request to clear that branch.
 */
export function flattenAppV2DocumentUpdate(submitData) {
    const flattened = foundry.utils.flattenObject(submitData);
    return Object.fromEntries(Object.entries(flattened).filter(([, value]) => !(
        value
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value).length === 0
    )));
}
