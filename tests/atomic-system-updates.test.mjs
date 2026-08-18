import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const clone = value => value === undefined ? undefined : structuredClone(value);

function setProperty(object, path, value) {
  const keys = String(path).split(".");
  const final = keys.pop();
  const parent = keys.reduce((current, key) => current[key] ??= {}, object);
  parent[final] = value;
  return true;
}

function expandObject(object) {
  const expanded = {};
  for (const [path, value] of Object.entries(object ?? {})) {
    if (path.includes(".")) setProperty(expanded, path, value);
    else expanded[path] = value;
  }
  return expanded;
}

class DataFieldOperator {
  constructor(value) { this.value = clone(value); }
  static get(value) { return value instanceof DataFieldOperator ? value.value : value; }
}
class ForcedReplacement extends DataFieldOperator {
  static create(value) { return new this(value); }
}
class ForcedDeletion extends DataFieldOperator {
  static create() { return new this(undefined); }
}

function mergeObject(original, other, {inplace = true, recursive = true, applyOperators = false} = {}) {
  const target = inplace ? original : clone(original);
  for (const [key, value] of Object.entries(other ?? {})) {
    if (applyOperators && value instanceof ForcedDeletion) {
      delete target[key];
      continue;
    }
    if (applyOperators && value instanceof DataFieldOperator) {
      target[key] = clone(DataFieldOperator.get(value));
      continue;
    }
    if (recursive && value && typeof value === "object" && !Array.isArray(value)
      && !(value instanceof DataFieldOperator)) {
      const existing = target[key];
      target[key] = mergeObject(
        existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {},
        value,
        {inplace: true, recursive, applyOperators}
      );
    } else target[key] = clone(value);
  }
  return target;
}

const atomicFoundry = {
  data: {operators: {DataFieldOperator, ForcedDeletion, ForcedReplacement}},
  utils: {deepClone: clone, expandObject, mergeObject, setProperty}
};
globalThis.foundry = atomicFoundry;

const {
  mutateAtomicSystemUpdate,
  normalizeAtomicSystemUpdate
} = await import("../modules/data/atomic-system-updates.js");

const unwrap = value => clone(DataFieldOperator.get(value));

test.beforeEach(() => { globalThis.foundry = atomicFoundry; });

test("dotted AnyField edits preserve every raw sibling and source immutability", () => {
  const source = {system: {health: {min: 0, value: 37, set: 43, max: 48, custom: "keep"}}};
  const before = clone(source);
  const normalized = normalizeAtomicSystemUpdate({"system.health.value": 31}, source);
  assert.deepEqual(unwrap(normalized.system.health), {min: 0, value: 31, set: 43, max: 48, custom: "keep"});
  assert.deepEqual(source, before);
  assert.equal("system.health" in normalized, false);
});

test("mixed nested and dotted updates use the dotted leaf deterministically", () => {
  const source = {system: {health: {value: 20, max: 30, custom: true}}};
  const normalized = normalizeAtomicSystemUpdate({
    system: {health: {value: 15}},
    "system.health.value": 12
  }, source);
  assert.deepEqual(unwrap(normalized.system.health), {value: 12, max: 30, custom: true});
});

test("indexed array edits preserve sibling entries", () => {
  const source = {system: {advancement: [{name: "first", value: 1}, {name: "second", value: 2}]}};
  const normalized = normalizeAtomicSystemUpdate({"system.advancement.0.value": 9}, source);
  assert.deepEqual(unwrap(normalized.system.advancement), [
    {name: "first", value: 9},
    {name: "second", value: 2}
  ]);
});

test("ambiguous indexed deletions and invalid indices fail closed", () => {
  const source = {system: {advancement: [{value: 1}]}};
  assert.throws(
    () => normalizeAtomicSystemUpdate({"system.advancement.0": ForcedDeletion.create()}, source),
    /complete array/
  );
  assert.throws(
    () => normalizeAtomicSystemUpdate({"system.advancement.3.value": 2}, source),
    /invalid indexed/
  );
});

test("explicit replacements remain authoritative and recursive:false is rejected", () => {
  const source = {system: {health: {value: 20, custom: "old"}}};
  const replacement = ForcedReplacement.create({value: 1});
  const normalized = normalizeAtomicSystemUpdate({"system.health": replacement}, source);
  assert.equal(normalized.system.health, replacement);
  assert.throws(
    () => normalizeAtomicSystemUpdate({"system.health.value": 2}, source, {recursive: false}),
    /recursive:false/
  );
});

test("the mutation helper preserves the update object identity", () => {
  const changed = {"system.health.value": 10, name: "Example"};
  const identity = changed;
  mutateAtomicSystemUpdate(changed, {system: {health: {value: 20, max: 30}}});
  assert.equal(changed, identity);
  assert.equal(changed.name, "Example");
  assert.deepEqual(unwrap(changed.system.health), {value: 10, max: 30});
});

test("Actor and Item lifecycle hooks share the source-safe boundary", async () => {
  const actor = await readFile(new URL("../modules/ageSystemActor.js", import.meta.url), "utf8");
  const item = await readFile(new URL("../modules/ageSystemItem.js", import.meta.url), "utf8");
  assert.match(actor, /mutateAtomicSystemUpdate\(changed, this\._source/);
  assert.match(item, /mutateAtomicSystemUpdate\(changed, this\._source/);
  assert.match(actor, /normalizeCharacterAtomicSystemUpdate/);
  assert.match(item, /normalizeAtomicSystemUpdate/);
  assert.doesNotMatch(item, /progression\/|ClassAdvancementService/);
});
