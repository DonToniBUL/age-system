import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

class ForcedReplacement {
  constructor(value) { this.value = structuredClone(value); }
  static create(value) { return new this(value); }
}
globalThis.foundry = {
  data: {operators: {ForcedReplacement}},
  utils: {deepClone: value => structuredClone(value)}
};

const {
  itemCanonicalEditPaths,
  preserveItemCanonicalSubmitData
} = await import("../modules/sheets/legacy-item-form.js");
const {
  removeItemModifierUpdate,
  toggleItemModifierUpdate
} = await import("../modules/data/item-modifier-updates.js");
const {
  AGE_TOKEN_TRACKABLE_ATTRIBUTES,
  registerAgeTokenTrackableAttributes
} = await import("../modules/token-attributes.js");

test("full-form Item submissions preserve unedited raw canonical values and types", () => {
  const item = {
    type: "weapon",
    _source: {system: {dmgSource: "impact", minStr: 0, reload: "minor", useAbl: "fight"}}
  };
  const submit = {
    "system.dmgSource": "normalDamage",
    "system.minStr": "0",
    "system.reload": "noAction",
    "system.useAbl": "acc",
    "system.quantity": 3
  };
  preserveItemCanonicalSubmitData(item, submit);
  assert.deepEqual(submit, {
    "system.dmgSource": "impact",
    "system.minStr": 0,
    "system.reload": "minor",
    "system.useAbl": "fight",
    "system.quantity": 3
  });
  assert.deepEqual(item._source.system, {dmgSource: "impact", minStr: 0, reload: "minor", useAbl: "fight"});
});

test("explicit UI and programmatic canonical edits remain authoritative", () => {
  const item = {type: "power", _source: {system: {dmgSource: "impact", castTime: "minor", useAbl: "will"}}};
  const uiSubmit = {"system.dmgSource": "penetrating", "system.castTime": "noAction", "system.useAbl": "magic"};
  const uiEdits = itemCanonicalEditPaths(item, {name: "system.dmgSource"});
  preserveItemCanonicalSubmitData(item, uiSubmit, uiEdits);
  assert.deepEqual(uiSubmit, {"system.dmgSource": "penetrating", "system.castTime": "minor", "system.useAbl": "will"});

  const programmatic = {system: {castTime: "majorAction"}};
  const programmaticEdits = itemCanonicalEditPaths(item, null, programmatic);
  preserveItemCanonicalSubmitData(item, programmatic, programmaticEdits);
  assert.deepEqual(programmatic, {system: {castTime: "majorAction"}});
});

test("modifier removal and toggle are derived exclusively from raw Item source", () => {
  const item = {
    _source: {system: {modifiers: {
      keep: {formula: "1", isActive: true, custom: "raw"},
      remove: {formula: "2", isActive: false}
    }}},
    system: {modifiers: {
      keep: {formula: "1", isActive: false, valid: true, itemName: "derived"},
      remove: {formula: "2", isActive: false, valid: true}
    }}
  };
  const removal = removeItemModifierUpdate(item, "remove");
  assert.deepEqual(removal.system.modifiers.value, {keep: {formula: "1", isActive: true, custom: "raw"}});
  assert.deepEqual(toggleItemModifierUpdate(item, "keep"), {"system.modifiers.keep.isActive": false});
  assert.equal("valid" in removal.system.modifiers.value.keep, false);
});

test("Token configuration exposes usable bars for AGE resource AnyFields", () => {
  const environment = {CONFIG: {Actor: {}}};
  const registered = registerAgeTokenTrackableAttributes(environment);
  assert.deepEqual(registered.char.bar, ["health", "powerPoints", "conviction"]);
  assert.deepEqual(registered.vehicle.bar, ["partHealth"]);
  assert.ok(registered.spaceship.value.includes("crew.current"));
  registered.char.bar.push("changed");
  assert.equal(AGE_TOKEN_TRACKABLE_ATTRIBUTES.char.bar.includes("changed"), false);
});

test("both AppV1 sheet surfaces use the shared source-safe helpers", async () => {
  const itemSheet = await readFile(new URL("../modules/sheets/ageSystemSheetItem.js", import.meta.url), "utf8");
  const actorSheet = await readFile(new URL("../modules/sheets/ageSystemSheetCharacter.js", import.meta.url), "utf8");
  const entrypoint = await readFile(new URL("../age-system.js", import.meta.url), "utf8");
  assert.match(itemSheet, /removeItemModifierUpdate\(this\.item, i\)/);
  assert.match(itemSheet, /toggleItemModifierUpdate\(item, i\)/);
  assert.match(itemSheet, /preserveLegacyItemSubmitData/);
  assert.match(actorSheet, /toggleItemModifierUpdate\(item, key\)/);
  assert.match(entrypoint, /registerAgeTokenTrackableAttributes\(\)/);
});
