# AGE System 5.2 Progression Guide

AGE progression is a core-system, provider-neutral capability. The engine does not require Fantasy AGE, Dragon AGE, Modern AGE, AGE Progression Profiles, or another content module. A GM can author definitions with only AGE System installed, while modules, world Items, compendium Items, imports, and the legacy Class adapter can supply the same normalized DefinitionV1 or DefinitionV2 contract.

DefinitionV2 is additive. DefinitionV1 remains valid for existing providers and the retained Fantasy AGE 1e DefinitionV1/Class-v3 advancement route; Fantasy AGE 1e guided creation uses DefinitionV2. Version 2 adds typed inputs, authored workflow stages, conditional choice groups, starting ability values, additional identity/resource fields, explicit language grants, and bounded allocations/formulas; it does not introduce executable code or arbitrary document paths.

For a newcomer-focused installation guide and illustrated walkthroughs for Character creation, advancement, undo, Classes, and Progression Definitions across Dragon AGE, Fantasy AGE 1e, Fantasy AGE 2e, and Modern AGE, start with the [AGE Character Creation and Advancement Handbook](USER-GUIDE-PROGRESSION.md).

## GM authoring workflow

Every Progression Definition Item has one visible lifecycle state: **Draft** (unfinished or unsaved and never runnable), **Valid / Disabled** (saved and contract-valid but intentionally unavailable), **Valid / Active** (saved, enabled, and eligible for Builder/Center discovery), or **Invalid** (strict contract errors prevent save or execution). A newly created blank Item is a normal Draft and contributes one concise content-audit warning rather than a cascade of missing-field errors.

The 5.2.1 Definition Authoring Studio, retained unchanged in 5.2.2 and 5.2.3, keeps the schema, lifecycle, provider location, and unsaved state visible while the GM works. Its keyboard-operable navigator divides the contract into **Basics**, **Source Items**, **Timeline**, **Rules**, and **Advanced JSON**, while validation stays visible beside the active section. Validation findings link back to their semantic controls and focus the first actionable problem. Status feedback is labelled for assistive technology rather than relying on color alone. The accepted 5.2.2 AppV2 sheet usability work and the 5.2.3 documentation patch do not alter definition schemas, compiler behavior, preview signing, commit, receipts, or undo.

1. In the Item Directory, create a top-level Item and select **Progression Definition** as its type. A definition opened from a locked compendium or another read-only source remains inspectable; use **Create editable world copy** to duplicate it instead of changing the source.
2. Open the Item. Choose **Character creation**, **Creation + Actor ranks**, **Class-based advancement**, or **Classless advancement** under Guided setup. Select the readable rules profile and rank count; AGE generates a valid unsaved timeline for review. Expert authors may instead edit every semantic field directly. Replacing a dirty draft or closing with unsaved work requires an explicit discard decision.
3. Add source references for Items which the definition may grant or inspect. Search visible world/compendium Items or drag an Item onto the source area; the editor creates a stable internal id and captures its UUID. Manual UUID editing remains available under the source card's Advanced fields.
4. Add milestones. Each milestone selects a rank and trigger (`character.create` or `rank.advance`) and may contain inputs, choice groups, evaluations, and semantic effects. DefinitionV2 may organize inputs and groups into named stages which the Builder renders in authored order.
5. For advancement definitions, select a track binding. Use **Class Item** with a stable track id (and optional source UUIDs) for FAGE/DAGE-style progression, or **Actor** for classless MAGE-style progression.
6. Select **Validate draft**. Validation dispatches by schema version, reports exact normalized paths, avoids derivative child messages when a parent container is structurally invalid, and focuses the matching section/control when possible; a failing draft cannot be saved or executed.
7. Select **Save validated draft**, then enable the provider. Save preflight checks stable definition identity, profile continuity, and semantic-version changes before the document write. Changed semantics require a newer semantic version. Editing an existing Item cannot change its definition id or profile; use **Duplicate to world** for a new identity.
8. Use **Test in Builder** or **Test in Center** only after the draft is saved, valid, and enabled.

Normal authoring uses the semantic controls. **Advanced normalized JSON** is an expert escape hatch and import/export view, not a validation bypass. **Load JSON draft** changes only the in-memory draft until it is validated and saved. **Export JSON** exports the selected normalized contract rather than a trusted executable payload.

For starting Health, Power Points, or Conviction, use the creation-only `resource.initialize` effect. DefinitionV2 can also initialize normalized Currency or Resources. Its fixed number or formula replaces the blank Character's persisted starting state; it is not an offset from system-template defaults. Formula preview receives the final preview-signed creation ability values (for example `@cons` or `@magic`) after `ability.set` and selected allocations, resolves exactly once, and pins both the result and those ability values in the preview. Use `resource.gain` only for a genuinely additive grant. Duplicate initialization of the same resource and initialization on advancement milestones fail validation/compilation.

Use `summary.add` for a source rule which cannot be represented safely. A manual-review summary is signed and displayed with the preview but performs no mutation. Do not replace an uncertain prerequisite, random-table outcome, source Item, weapon-group label, or missing Character field with a guessed effect.

A formula amount may include an optional Foundry-safe `rollId`, for example `{kind: "formula", formula: "1d6 + @cons", rollId: "health:rank:2"}`. Every effect with the same formula and `rollId` consumes one shared signed result. Use this when one rules roll changes more than one semantic value, such as both current Health and its Class bonus. Reusing one `rollId` with different formulas fails compilation; formulas without a `rollId` remain independent.

Only a GM may create, import, update, enable, disable, or delete a Progression Definition Item. Definitions must be top-level Items. A locked compendium is read-only; duplicate its definition into the world or unlock an appropriate writable pack before editing. Disabled, invalid, digest-mismatched, embedded, or equally versioned conflicting definitions are excluded from execution.

## Character Builder

Open **AGE Toolbox -> Character Builder**. Select a definition whose profile and `character-builder` capability match the active rules profile, then complete its visible stages and refresh the review. DefinitionV2 renders authored text, long-text, integer, select, choice, and ability controls in the provider's declared order. DefinitionV1 keeps the compatible inferred Name and path, Choices and abilities, and Review and create flow. Technical source and formula details remain available in collapsed sections.

The preview pins the definition schema/digest, profile contract, source Item snapshots, base state, user, resolved choices, semantic inputs, creation ability values/allocations, formula inputs/results, manual-review summaries, expiry, and plan digest. Commit sends only the preview id and plan digest; it does not accept document update paths from the client. Character creation uses one complete Actor creation operation and preassigned embedded Item ids, so a failed commit cannot leave a partial Character.

Creation reversal is intentionally separate and destructive. It requires an undo preview, explicit confirmation, and an exact current-source digest match. If the Character changed after creation, reversal stops rather than deleting later play.

## Advancement Center

Owning players can open the Advancement Center directly from either AppV2 Character-sheet layout or the prominent action on an owned Class sheet; the AGE Toolbox and a Progression Definition's **Test in Center** action are additional entry points. Follow the Choose the path, Make rank choices, and Review and apply steps. Select the Character, compatible definition and, for Class Item tracks, the Class. Then select the target rank, choices, ability allocations, and any owned Item which an `item.advance` effect targets. Inspect the plain-language change review before committing; technical provenance and formula details remain available in collapsed sections.

Class Item advancement commits through the existing specialized Class transaction boundary. Classless progression commits through the dedicated Actor-track transaction boundary and stores rank/history in the signed Actor track rather than a dummy Class. Actor-backed character creation also stores the selected definition and profile on that track; later Character-sheet discovery and the Advancement Center follow the same path and reject a different definition bound to the same track. An Actor track explicitly named `level` mirrors its signed rank to the Character's visible Level field; other Actor tracks remain isolated in progression flags. Both execution paths block duplicate or concurrent advancement, roll back partial failure, store durable receipts, and preserve unrelated later resource or damage changes. Undo is latest-safe and conflict-aware; it refuses to overwrite a managed value which no longer matches the committed receipt.

## Provider and conflict rules

All providers become equivalent after validation:

- a module or system registration through `game.ageSystem.api.progression.registerDefinition()`;
- a world Progression Definition Item;
- a readable world or module Item compendium entry;
- an imported DefinitionV1 or DefinitionV2 JSON document;
- a legacy Class-v3 definition adapted when its advancement UI is opened.

Provider origin is provenance, not authority. The highest semantic version is selected only when definitions at that version share one canonical digest. An equal-version conflict is reported rather than selected silently. Source Items are resolved and snapshotted during preview; a changed or missing source invalidates commit.

`game.ageSystem.api.progression` is the frozen API 1.4.0 execution and registration surface. GM-facing persistent-document operations live on the provider namespace `game.ageSystem.progressionDefinitions`; it is intentionally not part of the frozen API contract. The provider exposes status/records/issues plus methods such as `createWorldDefinition`, `importDefinition`, `updateDefinitionDocument`, `setDefinitionEnabled`, `deleteDefinitionDocument`, `exportDefinition`, and `refreshAll`. Integrations should feature-detect any provider method they use.

## FAGE, DAGE, and MAGE boundary

The system repository includes copyright-neutral FAGE, DAGE, and MAGE fixtures as **synthetic structural coverage** for the normalized contracts and profile adapters. They prove contract shape and validation only; they do not contain complete published progression rules.

AGE Progression Profiles 0.3.0 is the separate provider release for full guided Dragon AGE, Fantasy AGE 1e, Fantasy AGE 2e, and Modern AGE creation plus rank 1-20 routing. Fantasy AGE 1e creation uses DefinitionV2, while its existing DefinitionV1/Class-v3 advancement routes remain compatible. When a module supplies definitions, it must register or package the same validated schema used by core-authored definitions. The progression engine, Character Builder, and Advancement Center remain fully usable with user-authored core content and never depend on those modules.

"Full guided" means every catalogued stage and rank is reachable through the shared workflow; it does not mean uncertain source rules are fabricated. Any incomplete, ambiguous, prose-only, or unmapped detail remains an explicit manual-review summary in the preview.

## Data-safety checklist

- Back up the world before installing a new system version.
- Keep important definitions versioned and export their JSON.
- Validate and save before enabling or testing.
- Inspect the entire preview; formula results are deliberately pinned and do not reroll at commit.
- Treat expiry or digest errors as a request for a fresh preview.
- Never work around a conflict by editing stored digests or receipt flags.
- Use the content audit and migration preview; both are read-only.
- Confirm undo/reversal separately and expect it to stop on later conflicting changes.
