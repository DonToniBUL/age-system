import {
    AGE_ACTOR_DERIVED_FIELDS,
    AGE_ACTOR_SOURCE_FIELDS,
    AGE_ITEM_DERIVED_FIELDS,
    AGE_ITEM_SOURCE_FIELDS
} from "./model-fields.js";

const TEMPLATE_URL = "systems/age-system/template.json";
let templateCache = null;

function getProperty(object, path) {
    if (globalThis.foundry?.utils?.getProperty) return foundry.utils.getProperty(object, path);
    return String(path).split(".").reduce((value, key) => value?.[key], object);
}

function kindOf(document) {
    return document?.documentName === "Actor" || document?.items ? "Actor" : "Item";
}

function clone(value) {
    if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    return structuredClone(value);
}

function merge(target, source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return target;
    for (const [key, value] of Object.entries(source)) {
        if (key === "templates") continue;
        if (value && typeof value === "object" && !Array.isArray(value)) target[key] = merge(target[key] ?? {}, value);
        else target[key] = clone(value);
    }
    return target;
}

async function loadTemplate() {
    if (templateCache) return templateCache;
    const response = await fetch(foundry.utils.getRoute(TEMPLATE_URL));
    if (!response.ok) throw new Error(`AGE System | Could not load ${TEMPLATE_URL}: ${response.status}`);
    templateCache = await response.json();
    return templateCache;
}

function defaultsFor(template, kind, type) {
    const definition = template?.[kind]?.[type];
    if (!definition) return null;
    const defaults = {};
    if (kind === "Item") {
        for (const name of definition.templates ?? []) merge(defaults, template.Item.templates?.[name]);
    }
    return merge(defaults, definition);
}

function operation(document, path, before, after, reason, severity = "change") {
    return {
        uuid: document.uuid ?? document.id ?? null,
        documentType: kindOf(document),
        type: document.type,
        name: document.name ?? "",
        path: `system.${path}`,
        before,
        after,
        reason,
        severity
    };
}

function legacyEmptyNumber(value) {
    if (value === null) return true;
    if (typeof value !== "string") return false;
    return ["", "-", "–", "—"].includes(value.trim());
}

function legacyNumberExpression(value) {
    if (typeof value !== "string") return false;
    const compact = value.trim().replace(/\s+/g, "");
    if (!compact || !/\d/.test(compact)) return false;
    if (!/^(?:\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|@[A-Za-z_][A-Za-z0-9_.]*|[dD]|[+\-*/().])+$/u.test(compact)) return false;
    return /\d[dD]\d/u.test(compact)
        || /[+\-*/()]/u.test(compact)
        || /@[A-Za-z_]/u.test(compact);
}

function inspect(document, actual, expected, path, operations) {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        if (actual === undefined || actual === null) {
            operations.push(operation(document, path, actual, expected, "missing-default"));
            return;
        }
        if (typeof actual !== "object" || Array.isArray(actual)) {
            operations.push(operation(document, path, actual, expected, "object-shape-mismatch", "blocker"));
            return;
        }
        for (const [key, value] of Object.entries(expected)) inspect(document, actual[key], value, path ? `${path}.${key}` : key, operations);
        return;
    }
    if (actual === undefined) {
        operations.push(operation(document, path, actual, expected, "missing-default"));
        return;
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) operations.push(operation(document, path, actual, expected, "array-shape-mismatch", "blocker"));
        return;
    }
    if (typeof expected === "number" && typeof actual !== "number") {
        const converted = typeof actual === "string" && actual.trim() !== "" ? Number(actual) : NaN;
        if (Number.isFinite(converted)) operations.push(operation(document, path, actual, converted, "numeric-string"));
        else if (legacyEmptyNumber(actual)) operations.push(operation(document, path, actual, expected, "legacy-empty-number", "review"));
        else if (legacyNumberExpression(actual)) operations.push(operation(document, path, actual, expected, "legacy-number-expression", "review"));
        else operations.push(operation(document, path, actual, expected, "invalid-number", "blocker"));
    } else if (typeof expected === "boolean" && typeof actual !== "boolean") {
        const normalized = typeof actual === "string" ? actual.trim().toLowerCase() : actual;
        if (["true", "false", 0, 1].includes(normalized)) {
            operations.push(operation(document, path, actual, normalized === "true" || normalized === 1, "boolean-like"));
        } else operations.push(operation(document, path, actual, expected, "invalid-boolean", "blocker"));
    } else if (typeof expected === "string" && typeof actual !== "string") {
        operations.push(operation(document, path, actual, String(actual ?? ""), "string-coercion", "review"));
    }
}

function inspectUnknownTopLevel(document, actual, kind, operations) {
    const sourceFields = kind === "Actor" ? AGE_ACTOR_SOURCE_FIELDS : AGE_ITEM_SOURCE_FIELDS;
    const derivedFields = kind === "Actor" ? AGE_ACTOR_DERIVED_FIELDS : AGE_ITEM_DERIVED_FIELDS;
    const known = new Set(sourceFields[document.type] ?? []);
    const derived = new Set(derivedFields[document.type] ?? []);
    for (const [key, value] of Object.entries(actual ?? {})) {
        if (known.has(key)) continue;
        const isDerived = derived.has(key);
        operations.push(operation(
            document,
            key,
            value,
            undefined,
            isDerived ? "persisted-derived-field" : "undeclared-source-field",
            isDerived ? "review" : "blocker"
        ));
    }
}

function normalize(collection) {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (collection.contents) return Array.from(collection.contents);
    if (typeof collection.values === "function") return Array.from(collection.values());
    return Array.from(collection);
}

export class AgeMigrationPreview {
    static async previewDocument(document, {template = null} = {}) {
        const definitions = template ?? await loadTemplate();
        const kind = kindOf(document);
        const defaults = defaultsFor(definitions, kind, document.type);
        if (!defaults) return {
            valid: false,
            documentCount: 1,
            changeCount: 0,
            reviewCount: 0,
            blockerCount: 1,
            operations: [operation(document, "", null, null, "unsupported-document-type", "blocker")]
        };
        const source = document.toObject ? document.toObject(false) : document;
        const operations = [];
        inspect(document, source.system ?? {}, defaults, "", operations);
        inspectUnknownTopLevel(document, source.system ?? {}, kind, operations);
        const blockers = operations.filter(entry => entry.severity === "blocker");
        const review = operations.filter(entry => entry.severity === "review");
        return {
            valid: blockers.length === 0,
            documentCount: 1,
            changeCount: operations.length - blockers.length - review.length,
            reviewCount: review.length,
            blockerCount: blockers.length,
            operations,
            mutatesDocuments: false
        };
    }

    static async previewDocuments(documents, {includeEmbedded = true, template = null} = {}) {
        const definitions = template ?? await loadTemplate();
        const all = [];
        for (const document of normalize(documents)) {
            all.push(document);
            if (includeEmbedded && kindOf(document) === "Actor") all.push(...normalize(document.items));
        }
        const reports = await Promise.all(all.map(document => this.previewDocument(document, {template: definitions})));
        const operations = reports.flatMap(report => report.operations);
        return {
            valid: reports.every(report => report.valid),
            documentCount: all.length,
            changeCount: operations.filter(entry => entry.severity === "change").length,
            reviewCount: operations.filter(entry => entry.severity === "review").length,
            blockerCount: operations.filter(entry => entry.severity === "blocker").length,
            operations,
            mutatesDocuments: false
        };
    }

    static async previewWorld({includePacks = false} = {}) {
        const documents = [...normalize(game.actors), ...normalize(game.items)];
        if (includePacks) {
            for (const pack of normalize(game.packs)) {
                if (["Actor", "Item"].includes(pack.documentName)) documents.push(...await pack.getDocuments());
            }
        }
        return this.previewDocuments(documents);
    }
}

export default AgeMigrationPreview;
