import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

class MockField { constructor(options = {}) { Object.assign(this, options); } }
const modelFoundry = {
  abstract: {TypeDataModel: class {}},
  data: {fields: {AnyField: MockField, HTMLField: MockField}},
  utils: {deepClone: value => structuredClone(value)}
};
globalThis.foundry = modelFoundry;
globalThis.CONFIG = {Actor: {dataModels: {}}, Item: {dataModels: {}}};
globalThis.game = {model: {
  Actor: {
    char: {gameMode: {override: false, specs: {none: {health: 10}}}, features: ""},
    vehicle: {passengers: [], description: ""},
    spaceship: {passengers: [], description: ""},
    organization: {description: ""}
  },
  Item: {
    equipment: {quantity: 1, longDesc: ""}, focus: {}, weapon: {}, power: {}, talent: {}, stunts: {},
    relationship: {}, honorifics: {}, membership: {}, shipfeatures: {}, class: {description: "", advancements: {}}
  }
}};

const {AGE_ACTOR_DATA_MODELS, AGE_ITEM_DATA_MODELS, isolateCompatibleModelSource} = await import("../modules/data/models.js");
const template = JSON.parse(await readFile(new URL("../template.json", import.meta.url), "utf8"));

test.beforeEach(() => { globalThis.foundry = modelFoundry; });

test("blank-document defaults are cloned rather than shared", () => {
  const schema = AGE_ACTOR_DATA_MODELS.char.defineSchema();
  const first = schema.gameMode.initial();
  const second = schema.gameMode.initial();
  assert.deepEqual(first, game.model.Actor.char.gameMode);
  assert.notEqual(first, second);
  first.specs.none.health = 99;
  assert.equal(second.specs.none.health, 10);
  assert.deepEqual(AGE_ACTOR_DATA_MODELS.vehicle.defineSchema().passengers.initial(), []);
  assert.equal(AGE_ITEM_DATA_MODELS.equipment.defineSchema().quantity.initial(), 1);
  assert.equal(AGE_ITEM_DATA_MODELS.class.defineSchema().description.initial(), "");
});

test("preparation clones persisted branches and cannot mutate source", () => {
  const source = {abilities: {acc: {value: 2}}, health: {value: 37, max: 43}, level: 3};
  const original = structuredClone(source);
  const model = {
    _source: source,
    schema: new Map([
      ["abilities", {persisted: true}], ["health", {persisted: true}], ["level", {persisted: true}],
      ["initiative", {persisted: false}]
    ]),
    abilities: {acc: {value: 99}}, health: {value: 0}, level: 99, initiative: 12
  };
  isolateCompatibleModelSource(model);
  assert.deepEqual(model.abilities, source.abilities);
  assert.notEqual(model.abilities, source.abilities);
  assert.equal(model.level, 3);
  assert.equal(model.initiative, 12);
  model.abilities.acc.total = 4;
  model.health.max = 50;
  assert.deepEqual(source, original);
});

test("persisted schemas exactly cover the official template fields", () => {
  for (const type of template.Actor.types) {
    const expected = Object.keys(template.Actor[type]).sort();
    const actual = Object.entries(AGE_ACTOR_DATA_MODELS[type].defineSchema())
      .filter(([, field]) => field.persisted !== false)
      .map(([name]) => name)
      .sort();
    assert.deepEqual(actual, expected, `Actor.${type}`);
  }

  for (const type of template.Item.types) {
    const direct = Object.keys(template.Item[type]).filter(key => key !== "templates");
    const inherited = (template.Item[type].templates ?? []).flatMap(name => Object.keys(template.Item.templates[name]));
    const expected = [...new Set([...direct, ...inherited])].sort();
    const actual = Object.entries(AGE_ITEM_DATA_MODELS[type].defineSchema())
      .filter(([, field]) => field.persisted !== false)
      .map(([name]) => name)
      .sort();
    assert.deepEqual(actual, expected, `Item.${type}`);
  }
});
