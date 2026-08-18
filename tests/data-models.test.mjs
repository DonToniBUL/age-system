import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../modules/data/models.js", import.meta.url), "utf8");
const fields = await readFile(new URL("../modules/data/model-fields.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../system.json", import.meta.url), "utf8"));

test("every official document type has a compatibility-first data model", () => {
  assert.match(source, /extends foundry\.abstract\.TypeDataModel/);
  assert.match(source, /CONFIG\.Actor\.dataModels/);
  assert.match(source, /CONFIG\.Item\.dataModels/);
  assert.match(source, /mode: "compatibility-first"/);
  assert.match(source, /mutatesDocuments: false/);
  assert.deepEqual(Object.keys(manifest.documentTypes.Actor).sort(), ["char", "organization", "spaceship", "vehicle"]);
  assert.deepEqual(Object.keys(manifest.documentTypes.Item).sort(), ["class", "equipment", "focus", "honorifics", "membership", "power", "relationship", "shipfeatures", "stunts", "talent", "weapon"]);
  assert.doesNotMatch(fields, /progression|classProgression|classBonuses/);
});

test("persisted and derived branches have distinct field semantics", () => {
  assert.match(source, /persisted: false/);
  assert.match(source, /serializable: false/);
  assert.match(source, /initial: templateInitial\(documentName, type, name\)/);
  assert.match(source, /prepareBaseData\(\) \{\s*isolateCompatibleModelSource\(this\)/);
  assert.match(source, /model\[name\] = value && typeof value === "object" \? cloneDefault\(value\) : value/);
});

test("the official Class model remains unchanged", () => {
  assert.match(fields, /class: \["description", "level", "primaryAbl", "wgroups", "advancements"\]/);
  assert.match(fields, /class: \["advArrIndex", "advPerLvl"\]/);
});

test("entrypoint registers models before document classes are configured", async () => {
  const entrypoint = await readFile(new URL("../age-system.js", import.meta.url), "utf8");
  assert.match(entrypoint, /registerAgeDataModels\(\)/);
  assert.ok(entrypoint.indexOf("registerAgeDataModels();") < entrypoint.indexOf("CONFIG.Actor.documentClass"));
  assert.match(entrypoint, /dataModels: AGE_DATA_MODEL_STATUS/);
});
