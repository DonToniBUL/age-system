import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
import path from "node:path";
import test from "node:test";

function getProperty(object, key) {
  return key.split(".").reduce((value, part) => value?.[part], object);
}

class MockDataFieldOperator {
  constructor(value) { this.value = value; }
  static get(value) { return value instanceof MockDataFieldOperator ? value.value : value; }
}

class MockForcedReplacement extends MockDataFieldOperator {
  static create(value) { return new this(value); }
}

globalThis.foundry = {
data: {operators: {
  DataFieldOperator: MockDataFieldOperator,
  ForcedReplacement: MockForcedReplacement
}},
utils: {
  deepClone: structuredClone,
  flattenObject(object, prefix = "", flattened = {}) {
    for (const [key, value] of Object.entries(object)) {
      const field = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) this.flattenObject(value, field, flattened);
      else flattened[field] = value;
    }
    return flattened;
  },
  expandObject(object) {
    const expanded = {};
    for (const [key, value] of Object.entries(object)) this.setProperty(expanded, key, value);
    return expanded;
  },
  setProperty(object, key, value) {
    const parts = key.split(".");
    const leaf = parts.pop();
    const parent = parts.reduce((entry, part) => entry[part] ??= {}, object);
    parent[leaf] = value;
  },
  deleteProperty(object, key) {
    const parts = key.split(".");
    const leaf = parts.pop();
    const parent = parts.reduce((entry, part) => entry?.[part], object);
    if (parent) delete parent[leaf];
  },
  mergeObject(original, other) {
    for (const [key, value] of Object.entries(other)) {
      const nested = value && typeof value === "object" && !Array.isArray(value);
      original[key] = nested ? this.mergeObject(original[key] ?? {}, value) : value;
    }
    return original;
  },
  equals(left, right) { return JSON.stringify(left) === JSON.stringify(right); },
  getProperty
}};

const modulePath = path.resolve("modules/data/source-guard.js");
const {
  characterControlAuthorizedPaths,
  characterControlUpdatePreservesSource
} = await import(pathToFileURL(modulePath));

const source = {system: {
  abilities: {
    acc: {value: 1, primary: false, lastUp: false, testMod: 101, advances: 201},
    comm: {value: 2, primary: false, lastUp: false, testMod: 102, advances: 202},
    magic: {value: 3, primary: true, lastUp: true, testMod: 111, advances: 211},
    custom: {value: 7, primary: false, lastUp: false, legacyExtension: "keep-me"}
  },
  health: {min: 0, value: 37, set: 43, legacyExtension: "keep-health"},
  powerPoints: {min: 0, value: 19, set: 29, legacyExtension: "keep-pp"},
  defend: {active: false, defenseBonus: 2, mod: 0},
  guardUp: {active: true, defenseBonus: 1, mod: 0}
}};

test("Character source guard accepts an explicit source-preserving ability edit", () => {
  const delta = {system: {abilities: {acc: {value: 18}}}};
  const complete = structuredClone(source.system.abilities);
  complete.acc.value = 18;
  assert.deepEqual(characterControlAuthorizedPaths(delta), ["abilities.acc.value"]);
  assert.equal(characterControlUpdatePreservesSource(
    {system: {abilities: complete}},
    source,
    characterControlAuthorizedPaths(delta)
  ), true);
});

test("Character source guard unwraps an explicit atomic replacement", () => {
  const complete = structuredClone(source.system.abilities);
  complete.acc.value = 18;
  assert.equal(characterControlUpdatePreservesSource(
    {"system.abilities": MockForcedReplacement.create(complete)},
    source,
    ["abilities.acc.value"]
  ), true);

  const partial = {acc: {value: 18}};
  assert.equal(characterControlUpdatePreservesSource(
    {"system.abilities": MockForcedReplacement.create(partial)},
    source,
    ["abilities.acc.value"]
  ), false);
});

test("Character source guard rejects partial AnyField branches", () => {
  assert.equal(characterControlUpdatePreservesSource(
    {system: {abilities: {acc: {value: 18}}}},
    source,
    ["abilities.acc.value"]
  ), false);
  assert.equal(characterControlUpdatePreservesSource(
    {system: {health: {value: 40}}},
    source,
    ["health.value"]
  ), false);
  assert.equal(characterControlUpdatePreservesSource(
    {system: {powerPoints: {set: 35}}},
    source,
    ["powerPoints.set"]
  ), false);
});

test("Character source guard rejects sibling ability or resource corruption", () => {
  const complete = structuredClone(source.system.abilities);
  complete.acc.value = 18;
  complete.comm.value = 0;
  assert.equal(characterControlUpdatePreservesSource(
    {system: {abilities: complete}},
    source,
    ["system.abilities.acc.value"]
  ), false);
  assert.equal(characterControlUpdatePreservesSource(
    {system: {health: {value: 40}, powerPoints: {value: 0}}},
    source,
    ["system.health.value"]
  ), false);
  assert.equal(characterControlUpdatePreservesSource(
    {system: {
      health: {value: 40, set: 43},
      gameMode: {specs: {pulp: {healthCur: 40}}}
    }},
    source,
    ["system.health.value"]
  ), false);
});

test("Character source guard accepts complete resource and maneuver transactions", () => {
  const health = structuredClone(source.system.health);
  health.value = 40;
  const powerPoints = structuredClone(source.system.powerPoints);
  powerPoints.set = 35;
  assert.equal(characterControlUpdatePreservesSource(
    {
      "system.health": MockForcedReplacement.create(health),
      "system.powerPoints": MockForcedReplacement.create(powerPoints)
    },
    source,
    ["health.value", "powerPoints.set"]
  ), true);

  const defend = structuredClone(source.system.defend);
  const guardUp = structuredClone(source.system.guardUp);
  defend.active = true;
  guardUp.active = false;
  assert.equal(characterControlUpdatePreservesSource(
    {
      "system.defend": MockForcedReplacement.create(defend),
      "system.guardUp": MockForcedReplacement.create(guardUp)
    },
    source,
    ["defend.active", "guardUp.active"]
  ), true);
});

test("Character source guard rejects omitted hidden and legacy members", () => {
  const missingAbility = structuredClone(source.system.abilities);
  missingAbility.acc.value = 18;
  delete missingAbility.custom;
  assert.equal(characterControlUpdatePreservesSource(
    {"system.abilities": MockForcedReplacement.create(missingAbility)},
    source,
    ["abilities.acc.value"]
  ), false);

  const missingNestedSentinel = structuredClone(source.system.abilities);
  missingNestedSentinel.acc.value = 18;
  delete missingNestedSentinel.acc.testMod;
  assert.equal(characterControlUpdatePreservesSource(
    {"system.abilities": MockForcedReplacement.create(missingNestedSentinel)},
    source,
    ["abilities.acc.value"]
  ), false);

  const missingResourceExtension = structuredClone(source.system.health);
  missingResourceExtension.value = 40;
  delete missingResourceExtension.legacyExtension;
  assert.equal(characterControlUpdatePreservesSource(
    {"system.health": MockForcedReplacement.create(missingResourceExtension)},
    source,
    ["health.value"]
  ), false);
});
