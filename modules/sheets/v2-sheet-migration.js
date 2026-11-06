export const BETA1_ITEM_SHEET_CLASS = "age-system.ageSystemSheetItemV2";

export const APPV2_ITEM_SHEET_CLASSES = Object.freeze({
    class: "age-system.ageSystemSheetClassV2",
    equipment: "age-system.ageSystemSheetEquipmentV2",
    focus: "age-system.ageSystemSheetFocusV2",
    honorifics: "age-system.ageSystemSheetHonorificsV2",
    membership: "age-system.ageSystemSheetMembershipV2",
    power: "age-system.ageSystemSheetPowerV2",
    relationship: "age-system.ageSystemSheetRelationshipV2",
    shipfeatures: "age-system.ageSystemSheetShipFeaturesV2",
    stunts: "age-system.ageSystemSheetStuntsV2",
    talent: "age-system.ageSystemSheetTalentV2",
    weapon: "age-system.ageSystemSheetWeaponV2"
});

export const STABLE_APPV2_DEFAULT_VERSION = "5.3.2";

export const STABLE_APPV2_SHEET_DEFAULTS = Object.freeze({
    Actor: Object.freeze({
        char: "age-system.ageSystemSheetCharacterV2",
        vehicle: "age-system.ageSystemSheetVehicleV2",
        spaceship: "age-system.ageSystemSheetSpaceshipV2",
        organization: "age-system.ageSystemSheetOrgV2",
        force: "age-system.ageSystemSheetForceV2"
    }),
    Item: APPV2_ITEM_SHEET_CLASSES
});

const LEGACY_DEFAULT_MAPPINGS = Object.freeze({
    Actor: Object.freeze({
        char: Object.freeze({
            "age-system.ageSystemSheetCharacter": STABLE_APPV2_SHEET_DEFAULTS.Actor.char,
            "age-system.ageSystemSheetCharStatBlock": "age-system.ageSystemSheetCharStatBlockV2"
        }),
        vehicle: Object.freeze({
            "age-system.ageSystemVehicleSheet": STABLE_APPV2_SHEET_DEFAULTS.Actor.vehicle
        }),
        spaceship: Object.freeze({
            "age-system.ageSpaceshipSheet": STABLE_APPV2_SHEET_DEFAULTS.Actor.spaceship
        }),
        organization: Object.freeze({
            "age-system.ageSystemSheetOrg": STABLE_APPV2_SHEET_DEFAULTS.Actor.organization
        })
    }),
    Item: Object.freeze(Object.fromEntries(Object.keys(APPV2_ITEM_SHEET_CLASSES).map(type => [
        type,
        Object.freeze({
            "age-system.ageSystemItemSheet": APPV2_ITEM_SHEET_CLASSES[type],
            [BETA1_ITEM_SHEET_CLASS]: APPV2_ITEM_SHEET_CLASSES[type]
        })
    ])))
});

function clone(value) {
    if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value ?? {});
    return structuredClone(value ?? {});
}

/**
 * Plan the one-time stable default-sheet transition without changing settings.
 * Empty and AGE legacy defaults move to their matching AppV2 controller. An
 * explicit AppV2 variant or third-party default is preserved.
 */
export function planStableAppV2SheetDefaults(current = {}) {
    const setting = clone(current);
    const changes = [];
    const preserved = [];

    for (const [documentName, defaults] of Object.entries(STABLE_APPV2_SHEET_DEFAULTS)) {
        setting[documentName] ??= {};
        for (const [type, appV2Default] of Object.entries(defaults)) {
            const selected = setting[documentName][type] ?? "";
            const mappedLegacy = LEGACY_DEFAULT_MAPPINGS[documentName]?.[type]?.[selected];
            const next = selected ? mappedLegacy : appV2Default;
            if (next) {
                setting[documentName][type] = next;
                changes.push({documentName, type, from: selected || null, to: next});
                continue;
            }
            if (selected !== appV2Default) preserved.push({documentName, type, selected});
        }
    }

    return {setting, changes, preserved};
}

/**
 * Make AppV2 the stable world default exactly once. This changes only Foundry's
 * core default-sheet setting; per-document core.sheetClass flags and document
 * data are deliberately untouched. A GM may select a legacy fallback later
 * without the system overriding that choice on the next start.
 */
export async function migrateStableAppV2SheetDefaults() {
    if (!game.user.isGM) return {updated: 0, preserved: [], skipped: "not-gm"};
    const applied = game.settings.get("age-system", "appV2DefaultMigrationVersion") || "0.0.0";
    if (!foundry.utils.isNewerVersion(STABLE_APPV2_DEFAULT_VERSION, applied)) {
        return {updated: 0, preserved: [], skipped: "already-applied"};
    }

    const current = game.settings.get("core", "sheetClasses") ?? {};
    const plan = planStableAppV2SheetDefaults(current);
    if (plan.changes.length) await game.settings.set("core", "sheetClasses", plan.setting);
    await game.settings.set("age-system", "appV2DefaultMigrationVersion", STABLE_APPV2_DEFAULT_VERSION);

    console.info(
        `AGE System | AppV2 is now the default for ${plan.changes.length} Actor/Item type(s); `
        + `${plan.preserved.length} explicit third-party or AppV2 choice(s) preserved. Legacy sheets remain selectable.`
    );
    return {updated: plan.changes.length, preserved: plan.preserved, skipped: null};
}

/** Move only explicit beta.1 Item-sheet selections to their current per-type
 * controller. Legacy/default selections and compendium content are untouched. */
export async function migrateBeta1ItemSheetSelections() {
    if (!game.user.isGM) return {updated: 0};
    const documents = [
        ...Array.from(game.items ?? []),
        ...Array.from(game.actors ?? []).flatMap(actor => Array.from(actor.items ?? []))
    ];
    let updated = 0;
    for (const item of documents) {
        if (item.getFlag("core", "sheetClass") !== BETA1_ITEM_SHEET_CLASS) continue;
        const sheetClass = APPV2_ITEM_SHEET_CLASSES[item.type];
        if (!sheetClass) continue;
        await item.setFlag("core", "sheetClass", sheetClass);
        updated += 1;
    }
    if (updated) console.info(`AGE System | Migrated ${updated} beta.1 Item sheet selection(s) to current AppV2 parity sheets.`);
    return {updated};
}
