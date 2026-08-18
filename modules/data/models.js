import {
    AGE_ACTOR_DERIVED_FIELDS,
    AGE_ACTOR_SOURCE_FIELDS,
    AGE_ITEM_DERIVED_FIELDS,
    AGE_ITEM_SOURCE_FIELDS
} from "./model-fields.js";

export {AGE_ACTOR_DERIVED_FIELDS, AGE_ACTOR_SOURCE_FIELDS, AGE_ITEM_DERIVED_FIELDS, AGE_ITEM_SOURCE_FIELDS};

const ACTOR_HTML = Object.freeze({
    char: ["features", "traits", "goals", "secretNote", "gmNotes"],
    vehicle: ["description", "gmNotes"],
    spaceship: ["description", "gmNotes"],
    organization: ["description", "notes", "gmNotes"]
});

const ITEM_HTML = Object.freeze({
    class: ["description"],
    talent: ["longDesc"],
    equipment: ["longDesc"], focus: ["longDesc"], weapon: ["longDesc"], power: ["longDesc"],
    stunts: ["longDesc"], relationship: ["longDesc"], honorifics: ["longDesc"], membership: ["longDesc"], shipfeatures: ["longDesc"]
});

function cloneDefault(value) {
    if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    return structuredClone(value);
}

function templateInitial(documentName, type, name, fallback = undefined) {
    const configured = globalThis.game?.model?.[documentName]?.[type]?.[name];
    const value = configured === undefined ? fallback : configured;
    return value === undefined ? undefined : () => cloneDefault(value);
}

/** Detach persisted compatibility branches before legacy preparation mutates derived values. */
export function isolateCompatibleModelSource(model) {
    const source = model?._source;
    const schema = model?.schema;
    if (!source || !schema?.entries) return model;

    for (const [name, field] of schema.entries()) {
        if (field?.persisted === false || !Object.hasOwn(source, name)) continue;
        const value = source[name];
        model[name] = value && typeof value === "object" ? cloneDefault(value) : value;
    }
    return model;
}

function compatibleModel(documentName, type, fields, htmlFields = [], derivedFields = []) {
    return class AGECompatibleTypeDataModel extends foundry.abstract.TypeDataModel {
        static defineSchema() {
            const schema = {};
            const html = new Set(htmlFields);
            for (const name of fields) {
                schema[name] = html.has(name)
                    ? new foundry.data.fields.HTMLField({required: false, blank: true, initial: templateInitial(documentName, type, name, "")})
                    : new foundry.data.fields.AnyField({required: false, nullable: true, serializable: true, initial: templateInitial(documentName, type, name)});
            }
            for (const name of derivedFields) {
                schema[name] = new foundry.data.fields.AnyField({
                    required: false,
                    nullable: true,
                    serializable: false,
                    persisted: false,
                    initial: null
                });
            }
            return schema;
        }

        prepareBaseData() {
            isolateCompatibleModelSource(this);
        }
    };
}

export const AGE_ACTOR_DATA_MODELS = Object.freeze(Object.fromEntries(
    Object.entries(AGE_ACTOR_SOURCE_FIELDS).map(([type, fields]) => [
        type,
        compatibleModel("Actor", type, fields, ACTOR_HTML[type], AGE_ACTOR_DERIVED_FIELDS[type])
    ])
));

export const AGE_ITEM_DATA_MODELS = Object.freeze(Object.fromEntries(
    Object.entries(AGE_ITEM_SOURCE_FIELDS).map(([type, fields]) => [
        type,
        compatibleModel("Item", type, fields, ITEM_HTML[type], AGE_ITEM_DERIVED_FIELDS[type])
    ])
));

export function registerAgeDataModels() {
    Object.assign(CONFIG.Actor.dataModels, AGE_ACTOR_DATA_MODELS);
    Object.assign(CONFIG.Item.dataModels, AGE_ITEM_DATA_MODELS);
    return {actors: Object.keys(AGE_ACTOR_DATA_MODELS), items: Object.keys(AGE_ITEM_DATA_MODELS)};
}

export const AGE_DATA_MODEL_STATUS = Object.freeze({
    version: 1,
    mode: "compatibility-first",
    mutatesDocuments: false,
    actorTypes: Object.keys(AGE_ACTOR_DATA_MODELS),
    itemTypes: Object.keys(AGE_ITEM_DATA_MODELS)
});
