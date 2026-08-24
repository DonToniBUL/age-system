function normalizedSystemPath(path) {
    const value = String(path ?? "").trim();
    return value.startsWith("system.") ? value.slice(7) : value;
}

export function characterControlAuthorizedPaths(delta) {
    return Object.keys(foundry.utils.flattenObject(delta ?? {}))
        .filter(path => path.startsWith("system."))
        .map(normalizedSystemPath);
}

/**
 * Verify that a Character control update does not alter raw Actor source beyond
 * the paths explicitly produced by that control transaction.
 */
export function characterControlUpdatePreservesSource(changed, source, authorizedPaths = []) {
    // expandObject returns a new container and deliberately preserves advanced
    // values such as DataFieldOperator instances. Deep-cloning first would be
    // both unnecessary and unsafe in non-Foundry test/consumer environments
    // which do not implement Foundry's advanced-object clone semantics.
    const expanded = foundry.utils.expandObject(changed ?? {});
    if (!expanded.system || typeof expanded.system !== "object") return true;
    const storedSystem = source?.system;
    if (!storedSystem || typeof storedSystem !== "object") return false;

    const before = foundry.utils.deepClone(storedSystem);
    const after = foundry.utils.deepClone(storedSystem);
    // Character compatibility fields are top-level AnyFields. Their values are
    // replaced atomically by Foundry even though the containing `system`
    // TypeDataField is updated recursively. Model that exact boundary here: a
    // partial abilities/health/powerPoints object is unsafe and must not pass
    // merely because a recursive plain-object merge appears harmless.
    for (const [field, value] of Object.entries(expanded.system)) {
        const Operator = foundry.data?.operators?.DataFieldOperator;
        const rawValue = typeof Operator?.get === "function" ? Operator.get(value) : value;
        after[field] = foundry.utils.deepClone(rawValue);
    }
    for (const path of authorizedPaths.map(normalizedSystemPath).filter(Boolean)) {
        foundry.utils.deleteProperty(before, path);
        foundry.utils.deleteProperty(after, path);
    }
    return foundry.utils.equals(before, after);
}
