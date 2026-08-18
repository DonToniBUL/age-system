import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {registerLegacySelectHelper, renderLegacySelect} from "../modules/handlebars-helpers.js";
import {sheetRootElement} from "../modules/setup.js";
import {COLOR_SCHEMES} from "../modules/color-scheme.js";

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

test("AppV2-only Handlebars partials are preloaded before sheet rendering", async () => {
  const entry = await readFile(path.join(repository, "age-system.js"), "utf8");
  const partials = [
    "char-block-column1.hbs",
    "char-persona.hbs"
  ];

  for (const partial of partials) {
    await assert.doesNotReject(
      readFile(path.join(repository, "templates/sheets/v2/parity/partials", partial)),
      `${partial} must be shipped`
    );
    assert.ok(
      entry.includes(`\${pathRedux}sheets/v2/parity/partials/${partial}`),
      `${partial} must be registered by preloadHandlebarsTemplates`
    );
  }
});

test("AppV2 Power labels resolve the selected localized terminology", async () => {
  const templates = [
    "actor-character.hbs",
    "partials/char-block-column1.hbs",
    "item-power.hbs"
  ];

  for (const template of templates) {
    const source = await readFile(path.join(repository, "templates/sheets/v2/parity", template), "utf8");
    const labels = [...source.matchAll(/{{([^}]*POWER_FLAVOR\.(?:points|index|force)[^}]*)}}/g)];
    assert.ok(labels.length > 0, `${template} must expose Power terminology`);
    for (const match of labels) {
      assert.match(match[1], /\blocalize\b/, `${template} must localize ${match[0]}`);
    }
  }
});

test("the insufficient-Power confirmation passes valid Dialog options", async () => {
  const dice = await readFile(path.join(repository, "modules/dice.js"), "utf8");
  assert.doesNotMatch(dice, /new\s+Dialog\s*\(\s*data\s*,\s*null\s*\)/);
  assert.match(dice, /new\s+Dialog\s*\(\s*data\s*\)\.render\(true\)/);
});

test("legacy select blocks remain available to every AppV2 sheet", async () => {
  const entry = await readFile(path.join(repository, "age-system.js"), "utf8");
  assert.match(entry, /registerLegacySelectHelper\(\)/);

  const markup = renderLegacySelect("minorAction", {
    fn: () => '<option value="noAction">None</option><option value="minorAction">Minor</option>'
  });
  assert.equal(
    markup,
    '<option value="noAction">None</option><option value="minorAction" selected>Minor</option>'
  );

  const registered = {};
  const handlebars = {
    helpers: {},
    escapeExpression: value => String(value).replaceAll("&", "&amp;"),
    registerHelper: (name, helper) => { registered[name] = helper; }
  };
  assert.equal(registerLegacySelectHelper(handlebars), true);
  assert.equal(
    registered.select("R&D", {fn: () => '<option value="R&amp;D">Research</option>'}),
    '<option value="R&amp;D" selected>Research</option>'
  );
});

test("shared sheet preparation accepts native AppV2 and legacy jQuery roots", () => {
  const application = {
    classList: {length: 0},
    style: {},
    closest: () => null
  };
  const content = {
    classList: {length: 0},
    style: {},
    closest: selector => selector === ".age-system.sheet" ? application : null
  };

  assert.equal(sheetRootElement(content), application);
  assert.equal(sheetRootElement({0: content, jquery: "3.7.1"}), application);
  assert.throws(() => sheetRootElement({}), /DOM root element/);
});

test("every AppV1 rich-text field has a visible native AppV2 editor", async () => {
  const templatePairs = [
    ["templates/sheets/vehicle-sheet.hbs", "templates/sheets/v2/parity/actor-vehicle.hbs"],
    ["templates/sheets/spaceship-sheet.hbs", "templates/sheets/v2/parity/actor-spaceship.hbs"],
    ["templates/sheets/organization-sheet.hbs", "templates/sheets/v2/parity/actor-organization.hbs"],
    ["templates/sheets/char/persona.hbs", "templates/sheets/v2/parity/partials/char-persona.hbs"],
    ["templates/sheets/char-block/column1.hbs", "templates/sheets/v2/parity/partials/char-block-column1.hbs"],
    ["templates/sheets/equipment-sheet.hbs", "templates/sheets/v2/parity/item-equipment.hbs"],
    ["templates/sheets/focus-sheet.hbs", "templates/sheets/v2/parity/item-focus.hbs"],
    ["templates/sheets/honorifics-sheet.hbs", "templates/sheets/v2/parity/item-honorifics.hbs"],
    ["templates/sheets/membership-sheet.hbs", "templates/sheets/v2/parity/item-membership.hbs"],
    ["templates/sheets/power-sheet.hbs", "templates/sheets/v2/parity/item-power.hbs"],
    ["templates/sheets/relationship-sheet.hbs", "templates/sheets/v2/parity/item-relationship.hbs"],
    ["templates/sheets/shipfeatures-sheet.hbs", "templates/sheets/v2/parity/item-shipfeatures.hbs"],
    ["templates/sheets/stunts-sheet.hbs", "templates/sheets/v2/parity/item-stunts.hbs"],
    ["templates/sheets/talent-sheet.hbs", "templates/sheets/v2/parity/item-talent.hbs"],
    ["templates/sheets/weapon-sheet.hbs", "templates/sheets/v2/parity/item-weapon.hbs"]
  ];
  const targets = (source, helper) => [...source.matchAll(
    helper === "editor"
      ? /{{editor\b[^}]*\btarget="([^"]+)"/g
      : /{{{ageEditor\b[^}]*\btarget="([^"]+)"[^}]*\bdocumentUUID=/g
  )].map(match => match[1]).sort();

  for (const [legacyPath, nativePath] of templatePairs) {
    const legacy = await readFile(path.join(repository, legacyPath), "utf8");
    const native = await readFile(path.join(repository, nativePath), "utf8");
    assert.deepEqual(targets(native, "ageEditor"), targets(legacy, "editor"), nativePath);
  }

  const helper = await readFile(path.join(repository, "modules/sheets/native-editor.js"), "utf8");
  assert.match(helper, /<prose-mirror[^>]*\btoggled="true"[^>]*\bdata-document-uuid=/);

  const styles = await readFile(path.join(repository, "styles/age-design-system.css"), "utf8");
  const sharedEditorRule = styles.match(/\.application\.age-system\.age-appv2-sheet prose-mirror\.editor\s*{([^}]*)}/)?.[1] ?? "";
  const itemEditorRule = styles.match(/\.application\.age-system\.age-appv2-sheet\.item \.sheet-main-content prose-mirror\.editor\s*{([^}]*)}/)?.[1] ?? "";
  assert.match(sharedEditorRule, /min-height:\s*(?!0(?:[;\s]|$))[^;]+;/);
  assert.match(itemEditorRule, /min-height:\s*6rem;/);
});

test("AppV2 editing surfaces and every AGE palette remain readable", async () => {
  const design = await readFile(path.join(repository, "styles/age-design-system.css"), "utf8");
  const legacy = await readFile(path.join(repository, "styles/age-system.css"), "utf8");

  assert.match(design, /prose-mirror\.editor\s*{[^}]*background:\s*var\(--age-editor-surface\)[^}]*border:\s*1px solid var\(--age-editor-line\)/s);
  assert.match(design, /prose-mirror\.editor\.inactive:not\(\[disabled\]\)\s*>\s*button\.toggle\s*{[^}]*display:\s*inline-grid/s);
  assert.match(design, /prose-mirror\.editor\.active\s*{[^}]*border-color:\s*var\(--age-editor-focus\)[^}]*outline:/s);
  assert.match(design, /prose-mirror\.editor \.ProseMirror\s*{[^}]*min-height:\s*4rem[^}]*border-top:/s);
  assert.match(design, /input:not\(\[type="checkbox"\]\)[^}]*select,[^}]*textarea[^}]*color:\s*var\(--age-editor-ink\)\s*!important/s);
  assert.match(design, /\.vehicle \.image-description prose-mirror\.editor,[^}]*\.spaceship \.image-description prose-mirror\.editor\s*{[^}]*min-height:\s*7rem/s);
  assert.match(design, /\.stat-block \.organization-sheet > prose-mirror\.editor\s*{[^}]*min-height:\s*10rem/s);

  const luminance = hex => {
    const channels = hex.match(/[0-9a-f]{2}/gi).map(channel => Number.parseInt(channel, 16) / 255);
    const linear = channels.map(channel => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
    return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
  };
  const contrast = (foreground, background) => {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };

  for (const scheme of COLOR_SCHEMES) {
    const palette = design.match(new RegExp(
      `age-appv2-sheet\\.colorset-${scheme}\\s*\\{\\s*--age-ink-first:\\s*(#[0-9a-f]{6});\\s*--age-ink-second:\\s*(#[0-9a-f]{6});\\s*--age-ink-third:\\s*(#[0-9a-f]{6});`,
      "i"
    ));
    assert.ok(palette, `${scheme} must define accessible AppV2 ink colours`);

    for (const [index, tier] of ["first", "second", "third"].entries()) {
      const surface = legacy.match(new RegExp(
        `\\.colorset-${scheme} \\.colorset-${tier}-tier\\s*\\{[^}]*background-color:\\s*(#[0-9a-f]{6});`,
        "i"
      ));
      assert.ok(surface, `${scheme} ${tier} surface must exist`);
      assert.ok(
        contrast(palette[index + 1], surface[1]) >= 4.5,
        `${scheme} ${tier} text must meet WCAG AA contrast`
      );
    }
  }
});

test("the full Character AppV2 sheet scrolls without changing the compact stat block", async () => {
  const controller = await readFile(path.join(repository, "modules/sheets/ageSystemSheetCharacterV2.js"), "utf8");
  const design = await readFile(path.join(repository, "styles/age-design-system.css"), "utf8");

  assert.match(controller, /class\s+ageSystemSheetCharacterV2[\s\S]*?scrollable:\s*\["\.sheet-main-content"\]/);
  const scrollRule = design.match(/\.application\.age-system\.age-appv2-sheet\.char-sheet-alt \.sheet-main-content\s*{([^}]*)}/)?.[1] ?? "";
  assert.match(scrollRule, /overflow-y:\s*auto;/);
  assert.match(scrollRule, /min-height:\s*0;/);
  assert.doesNotMatch(scrollRule, /stat-block/);
  assert.match(controller, /class\s+ageSystemSheetCharStatBlockV2[\s\S]*?scrollable:\s*\["\.stat-block-container"\]/);
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
