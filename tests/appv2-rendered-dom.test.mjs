import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templates = path.join(repository, "templates", "sheets", "v2", "parity");

const expected = Object.freeze({
  "actor-character.hbs": ["system.health.value", "system.powerPoints.value"],
  "actor-character-block.hbs": ["name"],
  "actor-vehicle.hbs": ["system.description", "system.capacity"],
  "actor-spaceship.hbs": ["system.description", "system.crew.current"],
  "actor-organization.hbs": ["system.description", "system.combat.stability.value"],
  "item-equipment.hbs": ["system.longDesc", "system.quantity"],
  "item-focus.hbs": ["system.longDesc", "system.useAbl"],
  "item-honorifics.hbs": ["system.longDesc", "system.reference"],
  "item-membership.hbs": ["system.longDesc", "system.rank"],
  "item-power.hbs": ["system.longDesc", "system.powerPointCost"],
  "item-relationship.hbs": ["system.longDesc", "system.intensity"],
  "item-shipfeatures.hbs": ["system.longDesc", "system.type"],
  "item-stunts.hbs": ["system.longDesc", "system.stuntPoints"],
  "item-talent.hbs": ["system.longDesc", "system.degree0.desc", "system.degree4.desc"],
  "item-weapon.hbs": ["system.longDesc", "system.damageFormula"]
});

function fields(source) {
  const result = new Set([...source.matchAll(/\bname=["']([^"']+)["']/g)].map(match => match[1]));
  for (const match of source.matchAll(/\{\{\{ageEditor\s+[\s\S]*?target=["']([^"']+)["']/g)) result.add(match[1]);
  return result;
}

test("every AppV2 template exposes its essential editable fields", async () => {
  for (const [name, required] of Object.entries(expected)) {
    const source = await readFile(path.join(templates, name), "utf8");
    const renderedFields = fields(source);
    for (const field of required) assert.ok(renderedFields.has(field), `${name} is missing ${field}`);
  }
});

test("AppV2 layout remains scoped and responsive", async () => {
  const css = await readFile(path.join(repository, "styles", "age-design-system.css"), "utf8");
  assert.match(css, /\.age-appv2-sheet/);
  assert.match(css, /@media\s*\(/);
});
