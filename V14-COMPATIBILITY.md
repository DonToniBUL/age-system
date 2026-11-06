> Local 5.4.1-rc.2 candidate: live Foundry 14.366 checks completed with 54 passes, five warnings, and the unchanged harness 5.4.0 version-gate failure only. The historical validation evidence below describes the earlier releases, not acceptance of this candidate. See README.md for changed PP authority and Stunt-undo behavior.

# AGE System 5.4.0 - Foundry VTT v14 Compatibility and Validation

## Supported baseline

- System candidate: **5.4.1-rc.2**
- Accepted System baseline: **5.3.3**
- Retained System rollback: **5.3.2**
- Manifest minimum: **Foundry VTT 14.365**
- Manifest verified: **Foundry VTT 14.366**
- Accepted AppV2/data-safety baseline: **5.0.7**
- Protected legacy visual baseline: **Foundry-verified 4.5.0**

The package is validated through static analysis, isolated progression/action/delegation and automation contract tests, Foundry 14.366 compatibility inspection, migration checks, protected legacy visual-resource verification, archive integrity, and dependency-graph validation. AppV2 remains the stable document-sheet default. Advanced Tests, Requested Rolls, and the Stunt, Recovery, Unified Search, Combat Economy, Rule Profile, Quick Settings, Advanced Settings, Breather Settings, and Conditions Workshop workflows use native AppV2 windows in 5.4.0. The accepted AppV1 document sheets remain registered as explicit fallbacks for their supported document types. Perform the first launch in a copied world before promoting this candidate.

## AppV2 compatibility boundary

- `foundry.applications.sheets.ActorSheetV2`, `ItemSheetV2`, `ApplicationV2`, and `HandlebarsApplicationMixin` provide the stable AppV2 sheet lifecycle.
- Advanced Tests and Requested Rolls use `HandlebarsApplicationMixin(ApplicationV2)`, bounded part scrolling, delegated/native application actions, and explicit palette hydration. Their existing service methods, `advancedTestState` setting, and Requested Roll/result flags remain compatible.
- Stunt Assistant, Recovery Assistant, Unified AGE Search, Combat Economy, Rule Profiles, Quick Settings, Advanced Settings, Breather Settings, and Conditions Workshop use the same native AppV2 lifecycle, palette hydration, responsive surfaces, and bounded part scrolling. Their established services, permissions, settings, stored records/flags, calculations, and entry points remain compatible.
- Conditions Workshop remains GM/configuration-permission gated and draft-first. Only explicit Save writes `inUseConditions` and `customTokenEffects`; a failed sequential write restores both settings and the corresponding runtime condition mirrors before reporting the failure.
- All five Actor and eleven established Item AppV2 surfaces remain registered per type; the main AppV2 controller for each established document type uses `makeDefault: true`.
- Progression Definition is a twelfth, AppV2-only Item type with a dedicated semantic authoring sheet.
- Every accepted AppV1 controller remains registered with `makeDefault: false` and a clearly labelled fallback name. A newly introduced Progression Definition has no legacy sheet to fall back to.
- On the first GM launch, a one-time settings migration updates only empty or recognized AGE legacy entries in Foundry's `core.sheetClasses` world setting. Per-document `core.sheetClass` flags and third-party defaults are preserved.
- The default DocumentSheetV2 form handler performs validated document updates. Actor drag/drop uses the Foundry ActorSheetV2 implementation.
- Character controls are merged into complete raw stored source branches before validation. Each final branch is sent through Foundry's `ForcedReplacement` operator so it remains atomic across client validation, socket serialization, the schema-unaware server, and the receiving client's AnyField commit. Blank legacy numeric fields are omitted with Foundry 14's supported `deleteProperty` utility.
- Actor and Item document pre-update hooks apply the same source-preserving rule to automation, transactions, damage, healing, resource spending, macro/module calls, advancement, imports, and migrations. Only raw `_source` data is cloned; prepared-only derived fields are never persisted.
- Prepared modifier data derives a missing redundant `key` from its authoritative map entry without writing that derived value to source. AppV1 Weapon and Power fallbacks preserve normalized legacy control values—including Power casting time—exactly unless the corresponding control was explicitly edited.
- AppV2 Weapon and Power full-form submissions identify the native control which changed and any explicit flat or nested programmatic update. Normalized damage-source, minimum-Strength, reload, and casting-time controls are restored from raw Item source when they were not the requested edit, including exact source types and field absence.
- Indexed edits to array-backed compatibility fields preserve all existing records. Ambiguous indexed deletions and `recursive: false` system updates are rejected and require an intentional complete replacement.
- Editable rich-text surfaces use Foundry 14's form-associated `HTMLProseMirrorElement`; its change events are handled by the same DocumentSheetV2 form and no AppV1 editor activation is required. The Vehicle description is intentionally always open and height-bounded so existing HTML is visible before editing.
- Display-only embedded Power descriptions on the Character Stat Block are enriched relative to the actual owned Item, permission-filtered, and attached only to the detached render context. They are not form-associated controls and cannot submit an Item field through the Actor sheet.
- Parity templates retain one AppV2-safe root and the accepted 4.5 field/control surface, with narrowly scoped AppV2 adaptations for native editors, advancement controls, scrolling, safe embedded rich text, responsive layout, and contrast.
- Compatibility-first Actor and Item TypeDataModels declare every supported source field, seed new documents from cloned system-template defaults, and declare runtime-only prepared fields used by existing gameplay code. A read-only preview identifies required normalization; no bulk typed-data migration executor runs in 5.4.0. The settings-only document-sheet marker remains `5.3.2` because this release adds no document sheet or default.
- AppV2 editor and display enrichment use the Foundry 14 namespaced TextEditor implementation, and delayed condition assistance treats a concurrently deleted Actor as a harmless lifecycle cancellation.
- Structured chat metadata is additive under `flags.age-system.structuredChat`; existing message content, flags, listeners, and historical messages remain valid.

## Before opening a world

1. Back up the target world.
2. Remove or rename the existing `Data/systems/age-system` directory.
3. Extract the installation archive under `Data/systems`.
4. Confirm `Data/systems/age-system/system.json` exists.
5. Start Foundry 14.366 as GM and allow migration to complete.

## v14 compatibility

The runtime uses the Foundry v14 namespaces for documents, AppV1 sheets, applications, Handlebars templates, TextEditor, file selection, UUID lookup, and utilities. Chat visibility uses v14 message modes; roll messages use `rolls`; scene controls use keyed controls/tools; token statuses are keyed records; and Active Effect changes use `type`, `phase`, and `priority`.

Rule Profile and setting-value comparisons prefer Foundry 14's supported `foundry.utils.equals` helper. Quick and Advanced Settings filter the registry by the AGE System namespace before reading values, so opening those windows does not touch unrelated Core or third-party settings or trigger their compatibility warnings.

Foundry 14.366 corrects forced-replacement diffing and synthetic-Actor propagation. AGE's Actor/Item pre-update boundary continues to rebuild complete raw-source compatibility branches and transport them with `ForcedReplacement`; copied-world acceptance must therefore repeat Health, Power Point, damage/healing, Item modifier, Class/Actor-track advancement, rollback, synthetic-token, and token-resource-bar checks. AGE templates do not use the changed `<file-picker>` or `<formula-input>` custom controls.


## Dialog compatibility

- Interactive prompts use `foundry.applications.api.DialogV2`.
- Breather, AGE roll options, damage options, insufficient Power Point prompts, Class confirmations, Roll20 JSON import, and custom Active Effect JSON import were migrated together.
- AGE templates with an outer `<form>` are unwrapped before being passed to DialogV2 so the dialog owns a single valid form and action buttons can read it through `FormDataExtended`.
- Closing or cancelling a form dialog resolves to an explicit cancelled result instead of continuing the roll or advancement workflow.
- Runtime code contains no remaining `foundry.appv1.api.Dialog`, `new Dialog`, or `Dialog.confirm` calls.
- The Operations & Diagnostics window uses `DialogV2`; opening it does not add an AppV1 deprecation warning. AppV2 sheets are the default while the accepted AppV1 Actor and Item sheets remain selectable fallbacks.

## AGE Actions and socket compatibility

- AGE Actions v1 is retained through API 1.4.0 with 11 registered handlers and 12 reusable templates.
- Action envelopes are immutable, JSON-serializable, schema-versioned, UUID-based records and are safe to persist on chat messages and transactions.
- Repeated execution of one action ID shares its pending Promise to prevent duplicate mutations.
- The system socket is enabled solely for the permission-tested AGE Action delegation protocol.
- Foundry supplies the authenticated socket sender ID separately from the request payload. The elected GM checks that identity, active-user state, ownership, action shape, rate limit, and replay key before execution.
- Local and GM-delegated actions use the same handler authorization and diagnostics path.
- The Manual / Local release policy intentionally omits remote `manifest` and `download` fields.

## Damage application compatibility

- Apply Damage snapshots prepared `actor.system` data rather than cloning the Actor document wrapper.
- Legacy Actors which do not persist derived `system.armor` or Toughness fields receive safe fallbacks from prepared modifiers and abilities.
- Single-Armor presets normalize non-penetrating legacy sources to `normalDamage`; ballistic presets retain Impact, Ballistic, and Penetrating sources.
- Actor changes are awaited before the dialog closes and damage summaries are posted.
- Chat and sheet context menus use the v14 `ContextMenuEntry` shape and native HTMLElement callback target.

## Class subsystem

- World and compendium Class definitions are editable at definition level 0.
- Class definitions support 20 advancement levels.
- Exactly one Class may be attached to a Character.
- Advancement supports resources, derived statistics, abilities, primary abilities, weapon groups, Item grants, and existing Item progression.
- Each applied level records a schema-v3 transaction.
- Duplicate and concurrent advancement are blocked.
- Failed advancement restores Actor, Class, created Items, progressed Items, and transaction state.
- Rollback is latest-level-first and preserves later damage or resource spending.
- Rollback stops on conflicting edits instead of overwriting player changes.
- Pre-4.2 Class levels are preserved as a non-rollback legacy baseline.

## Progression subsystem

- DefinitionV1 and additive DefinitionV2 are closed, plain-JSON semantic contracts. They allow known profile/rank/capability metadata, source references, milestones, inputs, choices, evaluations, and effects; they cannot contain callbacks, arbitrary update paths, executable predicates, or implicit RollTable resolution.
- DefinitionV2 adds typed inputs, authored stages, conditional groups, starting ability values, expanded identity/resources, explicit language grants, and bounded ability/formula handling. DefinitionV1 remains supported and is not migrated in place.
- Module/system registrations, world Progression Definition Items, readable Item compendia, JSON imports, and the legacy Class-v3 adapter use one validator and registry. Provider origin grants no additional trust.
- A GM can author definitions in the core system through the dedicated AppV2 sheet. Only top-level Items may be mutated; locked packs are read-only. Invalid, disabled, digest-mismatched, stale, or ambiguous definitions cannot execute.
- Character Builder and Advancement Center consume the same profile adapter and compiler. Both UIs reconcile DefinitionV2 group and option conditions before preview; creation keeps owned-Item/ability predicates visibly indeterminate until signed context resolves them, without false defaults or cardinality blockers. Advancement evaluates those requirements from the exact selected Character, clears inactive defaults, hides inactive groups, and fails closed on unstable cross-group choice cycles. Previews sign definition/profile/source/base/user/Actor state, pin formula results once, expire, and commit only by preview id plus plan digest.
- Schema-dispatched contract validation is followed by trigger-filtered executor readiness. Unsupported creation, Class-backed, or Actor-backed combinations are reported before a signed preview exists; public API 1.4.0 remains unchanged while progression capability 2 advertises supported schemas `[1, 2]`.
- Long choice lists provide search, selected-only filtering, clear controls, counts, and explicit disabled-action guidance without changing transaction semantics.
- Character creation is a single complete Actor create with preassigned embedded Item ids. Reversal requires a separate exact destructive preview and explicit confirmation.
- Advancement uses the specialized Class transaction boundary, persistent domain receipts, failure rollback, duplicate/concurrent protection, and conflict-aware latest-safe undo.
- The core has no FAGE/DAGE/MAGE content dependency. Core fixtures remain synthetic structural validation coverage. AGE Progression Profiles 0.3.0 separately provides full guided DAGE/FAGE1/FAGE2/MAGE creation and rank 1-20 routing; FAGE1 creation uses DefinitionV2 while its advancement preserves the DefinitionV1/Class-v3 path.
- Provider content automates only exact mappings. Ambiguous, prose-only, incomplete, or unmapped source rules remain signed manual-review summaries; no rule, Item, table result, or Actor path is guessed.
- Persistent document authoring is available at `game.ageSystem.progressionDefinitions`; the frozen API 1.4.0 execution/registration surface remains `game.ageSystem.api.progression`.

## Item Piles and canonical currency

- Item Piles support is optional and registers through its public `item-piles-ready` integration hook.
- Character coin balances use the same `system.gp`, `system.sp`, and `system.cp` attributes displayed on AGE sheets.
- Single-currency worlds use `system.currency`; 4.2.7 migrates the value previously displayed from `system.resources.base` without deleting the old Resources score.
- Equipment and Weapons use `system.quantity` and preserve the existing human-readable `system.cost` field.
- The price transformer accepts GP/SP/CP, bundled localized abbreviations, and Dragon Age craft/retail pairs. Retail is the final slash-separated value.
- Resources and Income remain test-based wealth modes. Loot transfers work, but merchant currency is intentionally disabled for those modes.

## AppV2 sheet position, scrolling, colour, and rich-text fixes

- Full and compact Character sheets store independent positions and dimensions per user and per Actor.
- The compact sheet has safe defaults and rejects oversized dimensions inherited from 4.2.0.
- First-render options cannot replace the saved compact size with a viewport-wide size.
- Position is saved after drag/resize completion and when the sheet closes.
- The client-scoped colour setting is authoritative; stale legacy colour flags no longer overwrite it during startup.
- Colour changes are applied immediately to open AGE windows.
- The compact stat block uses the active palette through CSS variables instead of fixed black/white colours.
- The Character Settings tab remains pinned and visible when other tabs wrap.
- The Full Character header and navigation remain stationary while the active tab owns a bounded vertical scroll region whose position is managed by the AppV2 part lifecycle.
- Every bundled palette supplies explicit primary, secondary, surface, disabled-control, editor, and link foreground/background pairs for AppV2 parity sheets.
- The compact Stat Block displays permission-aware, enriched Power descriptions without activating an editor or mutating the embedded Item.
- Vehicle descriptions use a large, always-visible AppV2-native editor and preserve existing stored HTML.
- The Progression Definition Studio gives Advanced JSON its own high-contrast code surface, labels evaluation IDs as local to their condition block, exposes DefinitionV2 choice-group conditions, and refuses composite conditions that would immediately reference themselves, including malformed repair drafts with duplicate local IDs.

## Automated validation

Run `npm test` from the source package. The installable ZIP intentionally contains only runtime files; the separate source package contains the test and LESS toolchain. The stable gate covers:

- JavaScript syntax, JSON parsing, manifest paths, imports, assets, templates, localization, and removed-v14 API checks.
- Mocked `init`, `setup`, and `ready` hooks.
- DialogV2 form submission, cancellation, confirmation, file import, standard-Health and Injury/Vitality Breather, roll-options, and damage-options workflows.
- Constructor and data-preparation checks for retained legacy application windows outside the 5.4.0 utility scope.
- Native AppV2 structure and live open/resize/scroll/close checks for Stunt Assistant, Recovery Assistant, Unified AGE Search, Combat Economy, Rule Profiles, Quick Settings, Advanced Settings, Breather Settings, and Conditions Workshop, including palette contrast, setting-source stability, and console cleanliness.
- All five Actor types, including Mass Battle Force, and all twelve Item types, including Progression Definition.
- Class definition, attachment, advancement, grants, progression, rollback, conflicts, failure recovery, and concurrency.
- DefinitionV1/DefinitionV2 canonical validation, semantic authoring, provider arbitration, world/compendium/import persistence, typed staged creation, condition-aware creation/advancement input reconciliation, preview and commit, receipt hydration, and conflict-safe reversal/undo.
- World-isolated User palette hydration, one-time legacy client preference adoption, and live palette-class replacement.
- Compact-sheet oversized-dimension rejection, first-render protection, persistence, and separation from the full sheet; Full-sheet tab scrolling, palette contrast, embedded Power-description isolation, and Vehicle editor visibility.
- Awaited Actor damage, batch Breather, ChatMessage, settings, and vehicle/spaceship roll contracts.
- Migration failure handling, stale modifier and Active Effect repair, legacy vehicle defaults, and compendium relocking.
- Currency parsing, Item Piles registration/configuration, exact Actor/Item paths, localized denomination aliases, retail-price selection, and single-currency migration.
- Importer null/malformed-input behavior and complete English/French/Spanish/Portuguese localization-key parity.
- Rule-profile preview/apply/revert, action transactions and conflict-safe undo, Power Point rollback, compendium indexing/search, and Importer v2 preview/commit/deduplication.
- One-roll multi-target hit resolution and locked damage recipients, Power resistance recipient splitting, Stunt Point validation/undo, Advanced Test progress/undo, and combat reminder/automatic lifecycle handling.
- AGE Action validation, serialization, immutable templates, pending-ID deduplication, outcome diagnostics, permission failures, and authenticated GM delegation refusal paths.
- Argon companion 1.0.4 target-picker fallback and multi-target API behavior are covered by its separate static, smoke, lifecycle, and release audits.
- A byte-identity lock over all protected legacy sheet templates, stylesheets, LESS sources, fonts, logos, icons, and existing UI resources, plus ZIP integrity.

## Recommended in-Foundry acceptance test

Before the retained gameplay checklist below, open each of the nine 5.4.0 utility workflows from its normal System Settings, AGE Toolbox, scene-control, or chat-command entry point. Confirm that the current AGE palette is readable, long content scrolls inside the window while its main controls remain reachable, and a roughly 480-pixel-wide window reflows without horizontal clipping. Exercise one harmless preview/search/selection where available, cancel rather than committing setting changes, close and reopen each window, and verify the browser console remains free of AGE errors. In Conditions Workshop, edit a custom draft and cancel once, then save a disposable valid change and restore the original set. Run the dedicated copied-world checklist in `AGE-System-5.4.0-Audit-and-Acceptance.md` before promotion.

1. Open a copied Character and run Breather with the options prompt; confirm both Roll and Cancel work without a console error.
2. Alt-click an AGE roll and a damage roll; verify their settings dialogs submit and cancel correctly.
3. Trigger an insufficient Power Point prompt and verify both choices.
4. Open Roll20 import and custom-effect import prompts and cancel each without an error.
5. Open one Character in Full view, resize/move it, close it, and reopen it.
6. Switch the same Character to Block view and confirm it opens around 540 × 740 rather than viewport-wide.
7. Resize/move the Block view, close it, and reopen it.
8. Switch back to Full view and confirm its previous Full dimensions are retained separately.
9. Change the colour scheme through System Settings and confirm both open sheets update immediately.
10. Create a Class definition, attach it to a copied Character, apply two levels, reopen the world, and rollback the latest level.
11. Verify public, self, GM, and blind roll visibility using one GM and one player account.
12. With Item Piles 3.3+ active, create a pile, transfer Equipment, and buy an Item priced `1gp 25sp`; confirm the Character sheet loses exactly 1 GP and 25 SP of value.
13. Run the focused 4.2.9 Stunt, multi-target, Power resistance, combat lifecycle, Advanced Test, and Argon checks in `SAFE-AUTOMATION.md`.
14. Create a core Progression Definition Item, author and validate one minimal DefinitionV1 and one staged/typed DefinitionV2 `character.create` milestone, save and enable them, export JSON, duplicate them as disabled, and confirm each canonical digest round-trips unchanged.
15. Open Character Builder from AGE Toolbox, preview and cancel once, then preview and commit. Reopen the Character, preview reversal, and confirm reversal refuses after any source change.
16. Create or adapt an advancement definition, open Advancement Center, preview and commit one copied Character level, reload, and undo it from its durable receipt. Confirm a later conflicting edit blocks undo.
17. Open Operations & Diagnostics, verify API 1.4.0, progression capability 2, supported definition schemas 1 and 2, and the registered counts; run the content audit and data-migration preview, then export its JSON snapshot.
18. Confirm AGE Toolbox has no generic 1d6, 2d6, 3d6, d66, or d666 action while Character Builder, requested rolls, recovery, Advanced Tests, and diagnostics remain available.
19. If a second client is available, test one permitted and one refused player-to-GM action request, and confirm a non-GM cannot mutate a Progression Definition Item.
20. With AGE Progression Profiles 0.3.0 and each relevant library active, create one DAGE, FAGE1, FAGE2, and MAGE Character, advance each at least once, undo the advancement, and confirm every manual-review notice remains visible rather than being auto-resolved. For FAGE1, confirm guided creation uses DefinitionV2 and advancement continues through the retained DefinitionV1/Class-v3 route.

## Forward compatibility

All Actor and Item types default to native AppV2 parity sheets. The system retains Foundry's legacy AppV1 sheet framework as an explicit v14 fallback; it is not removed because v14 still supports it and optional integrations require a conservative transition path.


## 4.2.7 asynchronous roll compatibility

Foundry v14 dice terms may require asynchronous evaluation. Breather uses `await Roll.evaluate()`, Actor changes and ChatMessage creation are returned or awaited, and programmatic roll entry points normalize omitted or wrapped click events before checking modifier keys. Normal rolls inherit Foundry's core message visibility; Shift still requests a blind GM roll.
