import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sheets = Object.freeze([
  {template: "actor-character.hbs", className: "ageSystemSheetCharacterV2"},
  {template: "actor-character-block.hbs", className: "ageSystemSheetCharStatBlockV2"},
  {template: "actor-vehicle.hbs", className: "ageSystemSheetVehicleV2"},
  {template: "actor-spaceship.hbs", className: "ageSystemSheetSpaceshipV2"},
  {template: "actor-organization.hbs", className: "ageSystemSheetOrgV2"},
  {template: "item-equipment.hbs", className: "ageSystemSheetEquipmentV2"},
  {template: "item-focus.hbs", className: "ageSystemSheetFocusV2"},
  {template: "item-honorifics.hbs", className: "ageSystemSheetHonorificsV2"},
  {template: "item-membership.hbs", className: "ageSystemSheetMembershipV2"},
  {template: "item-power.hbs", className: "ageSystemSheetPowerV2"},
  {template: "item-relationship.hbs", className: "ageSystemSheetRelationshipV2"},
  {template: "item-shipfeatures.hbs", className: "ageSystemSheetShipFeaturesV2"},
  {template: "item-stunts.hbs", className: "ageSystemSheetStuntsV2"},
  {template: "item-talent.hbs", className: "ageSystemSheetTalentV2"},
  {template: "item-weapon.hbs", className: "ageSystemSheetWeaponV2"}
]);

test("AppV2 controllers and templates cover every non-Class AGE document type", async () => {
  const actorController = await readFile(path.join(repository, "modules/sheets/ageSystemSheetCharacterV2.js"), "utf8");
  const itemController = await readFile(path.join(repository, "modules/sheets/ageSystemSheetItemV2.js"), "utf8");
  for (const sheet of sheets) {
    const controller = sheet.template.startsWith("actor-") ? actorController : itemController;
    assert.match(controller, new RegExp(`class\\s+${sheet.className}\\b`));
    const template = await readFile(path.join(repository, "templates/sheets/v2/parity", sheet.template), "utf8");
    assert.match(template, /<section\b/);
    assert.doesNotMatch(template, /<form\b/i);
  }
  assert.doesNotMatch(itemController, /ageSystemSheetClassV2|item-class\.hbs/);
});

test("AppV2 sheets are opt-in beside the official AppV1 defaults", async () => {
  const entry = await readFile(path.join(repository, "age-system.js"), "utf8");
  assert.match(entry, /Actors\.registerSheet\("age-system", sheetClass, \{types, makeDefault: false, label\}\)/);
  assert.match(entry, /Items\.registerSheet\("age-system", sheetClass, \{[\s\S]*?makeDefault: false/);
  assert.match(entry, /Actors\.registerSheet\("age-system", ageSystemSheetCharacter, \{[\s\S]*?makeDefault: true/);
  assert.match(entry, /Items\.registerSheet\("age-system", ageSystemSheetItem, \{[\s\S]*?makeDefault: true/);
});

test("the foundation branch contains no new progression workflow", async () => {
  const files = [
    "age-system.js",
    "modules/sheets/ageSystemSheetCharacterV2.js",
    "modules/sheets/ageSystemSheetItemV2.js",
    "modules/sheets/v2-actions.js",
    "modules/sheets/v2-context.js",
    "templates/sheets/v2/parity/actor-character.hbs",
    "templates/sheets/v2/parity/actor-character-block.hbs"
  ];
  for (const relative of files) {
    const source = await readFile(path.join(repository, relative), "utf8");
    assert.doesNotMatch(source, /modules\/progression|AgeProgression|Character Builder|Advancement Center|openActorAdvancementCenter/i, relative);
  }
});
