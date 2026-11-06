# 5.4.1-rc.3 — V2 character sheet switch (2026-11-02)

Adds a title-bar button to switch between the Full and Stat Block V2 character sheets. The choice is saved for that Actor using Foundry's sheet selector; world defaults are unchanged. The button respects ownership, sheet locks and locked compendia, and waits for pending control and rich-text saves before switching.

# 5.4.1-rc.2 — Live-tested stabilization candidate (2026-11-01)

Preserves API 1.4.0 payment rollback and transaction access, routes owner/other-GM execution through the shared PP authority, and coordinates general PP Undo with spending and refunds. Includes the rc.1 safety fixes below.

37 offline regressions passed. Live Foundry 14.366 targeted checks passed; real player concurrency, non-owner secret filtering and no-GM refusal were verified. Full harness:54 pass,5 warning,1 unchanged System5.4.0 version-gate failure; zero functional failures and cleanup errors. Two verification races were corrected only in the isolated harness copy; installed harness and Foundry core were not changed.

# 5.4.1-rc.1 — Stabilization candidate (2026-11-01)

Prepared outside the installed Foundry system. Offline regression and package checks only; live Foundry 14.366 acceptance is pending. See the current README candidate notes for behavior changes and limits.

# AGE System 5.4.0 - Utility Workflow AppV2 Presentation

## Unified utility presentation

- Moves **Stunt Assistant**, **Recovery Assistant**, **Unified AGE Search**, **Combat Economy**, **Rule Profiles**, **Quick Settings**, **Advanced Settings**, **Breather Settings**, and **Conditions Workshop** onto native Foundry 14 `HandlebarsApplicationMixin(ApplicationV2)` windows.
- Gives all nine workflows the same responsive, palette-aware visual language used by the newer AGE sheets and roll workflows: clear headers, grouped surfaces, readable semantic colours, explicit controls, bounded internal scrolling, and narrow floating-window layouts.
- Exposes the application classes under `game.ageSystem.applications` for supported Harness and integration inspection without adding to or changing the frozen public gameplay API.

## Conditions Workshop

- Converts the GM-facing Conditions Workshop to native AppV2 while retaining its AGE Toolbox, scene-control, chat-command, import, export, and direct-construction entry points.
- Keeps source selection, custom conditions, icons, descriptions, ordering, and Active Effect changes in an in-memory draft. Opening, editing, importing, switching source, cancelling, or closing does not write world settings; only the explicit Save action does.
- Validates exactly one `dead` condition, unique non-empty IDs and images, and normalized Foundry 14 Active Effect changes before either setting is written.
- Saves `inUseConditions` and `customTokenEffects` as one recoverable operation. If a write fails, the prior settings and runtime `CONFIG` mirrors are restored and the workshop remains open.

## Corrected-candidate runtime hardening

- Uses Foundry 14's supported `foundry.utils.equals` helper for Rule Profile and setting-value comparisons, retaining a guarded compatibility fallback only for older environments.
- Filters registered settings by the AGE System namespace before reading them into Quick or Advanced Settings. Core and third-party settings are no longer read merely because their keys share a name.
- Test Harness 0.1.42 replaces the rejected 0.1.41 trial harness. It restores Requested Roll ownership with a complete non-recursive ownership-map update, cleans only still-live tracked chat messages, scopes the intentional stale-Actor refusal correctly, and applies the actual console-failure filter to utility-window trials.
- Harness Audit and Full coverage now includes Conditions Workshop as the ninth AppV2 utility window. The Full trial also performs a reversible live custom-draft probe and rejects any draft or setting drift.

## Compatibility boundary

- This release changes utility presentation and corrects compatibility/test instrumentation only. The established service calls, permissions, setting keys and values, stored schemas and flags, roll math, action behavior, search/profile semantics, and entry points are retained.
- Public API 1.4.0, progression capability 2, DefinitionV1/V2, Class v3, Profiles 0.3.0, Actor and Item data, and compendia remain unchanged.
- No data migration runs. The stable AppV2 document-sheet migration marker remains `5.3.2`, and the verified AppV1 Actor and Item fallback sheets remain registered and selectable.
- Genuine player/GM multi-client concurrency and permission hardening is outside this presentation milestone and is explicitly deferred to System 5.4.1.

## Verification boundary

- Test Harness 0.1.42 targets System 5.4.0 and accepted comparison baseline 5.3.3. Audit requires all nine retained services/application contracts and their native AppV2 templates.
- Full live UI coverage opens each workflow, checks palette and contrast, bounded scrolling and narrow-window reflow, closes it cleanly, and proves that every captured AGE System setting remains unchanged. Console cleanliness remains a release gate.
- The first installed 5.4.0 / Harness 0.1.41 copied-world trial is retained as a failed trial, not acceptance evidence. The corrected candidate requires freshly rebuilt artifacts and new Audit, Smoke, and Full reports before promotion.
- AGE System 5.3.3 remains accepted and 5.3.2 remains the sole System rollback until the exact 5.4.0 candidate passes copied-world Foundry 14.366 acceptance.

# AGE System 5.3.3 - Advanced Tests and Requested Rolls AppV2

## Roll-workflow presentation

- Replaces the legacy Advanced Test tracker and Requested Roll builder windows with native Foundry 14 `HandlebarsApplicationMixin(ApplicationV2)` applications.
- Uses one responsive Force-inspired visual language with clear headers and panels, bounded internal scrolling, accessible labels, explicit actions, and narrow-window layouts.
- Applies the current world's user palette to both windows. Newly posted Requested Roll cards carry the concrete palette active at creation so their foreground/background pairing remains readable later.
- Exposes the two application classes as `game.ageSystem.applications.AdvancedTestTracker` and `game.ageSystem.applications.RequestedRollBuilder` for supported integration and Harness inspection.

## Advanced Tests

- Shows party and opposition totals with native progress elements, explicit add/subtract actions, current status, and up to ten visible recent history entries.
- Adds a direct opposition-decrement action while retaining create, advance, chat-derived progress, last-change undo, close, and remove behavior.
- Keeps the existing `age-system.advancedTestState` version-1 setting, serialized tracker records, GM mutation gate, and automation service methods unchanged.

## Requested Rolls

- Presents title, ability, optional Focus/TN, recipient selection, owner names, target/controlled-token preselection, select-all/none, and posting in one scroll-safe builder.
- Posts a structured recipient card with test summary and completion count. Pending/completed presentation is derived from the existing attributed result-message flags; completed recipients may reroll as before.
- Retains the version-1 `flags.age-system.automation.requestedRoll` and `requestedRollResult` contracts, Character ownership and recipient membership checks, actual AGE roll path, and historical card/button selectors.
- Keeps Requested Roll result bookkeeping observational: its pre-update and pre-delete adapters never return the service boolean, so ordinary message updates and Foundry's Clear Chat workflow cannot be vetoed.

## Compatibility and verification

- This release changes presentation only. Public API 1.4.0, progression capability 2, DefinitionV1/V2, Profiles 0.3.0, roll math, Actors, Items, and compendia are unchanged.
- No data migration runs. The stable AppV2 document-sheet migration marker remains `5.3.2`.
- Test Harness 0.1.40 targets System 5.3.3. Audit checks both retained services, schemas, exported AppV2 classes, templates, and class contracts. Smoke isolates/restores Advanced Test state and exercises Requested Roll creation, ordinary chat update, explicit disposable bulk deletion, recipient/stale refusal, real result attribution, exact undo, source stability, cleanup, and console cleanliness. Full opens, inspects, scroll-checks, and closes both real AppV2 workflows.
- AGE System 5.3.2 remains the accepted release and 5.3.0 the retained rollback until the exact 5.3.3 candidate passes copied-world Foundry 14.366 acceptance.

# AGE System 5.3.2 - Mass Battle Forces and World-Isolated Palettes

## Mass Battle Force Actor

- Adds a dedicated `force` Actor and AppV2 sheet for Fantasy AGE 1e/2e and Dragon AGE mass battles. Organization Actors remain separate campaign entities rather than being repurposed as armies.
- Force description, player notes, and secret GM notes use always-visible native editors so an empty field can be clicked and edited immediately.
- Tracks current and starting troop strength as a Token-compatible resource, a primary troop test difficulty, specialists, an optional linked enemy Force, and an optional linked Character commander.
- Fantasy AGE command tests use Intelligence (Military Lore); Dragon AGE uses Cunning (Military Lore). Communication (Leadership) drives the Main Engagement, and the GM chooses the command ability used for Finishing Moves.
- Resolves Opening Moves, Main Engagement, and Finishing Moves as advanced-test stages. The sheet records progress, manual stage results, specialist and situational modifiers, and the rules' +5 Crisis Point contribution.
- Calculates the suggested stage threshold from combined force size: 5, 10, 15, 20, or 25. A linked opponent supplies its primary troop test TN; a visible fallback TN remains available without a link.

## Casualty safety

- Casualties are always rolled into a signed-in-practice preview stored against exact Force, enemy, troop, stage-result, specialist, TN, and modifier state before any troop strength changes.
- Changed state makes the preview stale and blocks application. Apply records a transaction and audit entry; Undo restores the exact prior troop strength only if no later troop edit conflicts with it.
- Successful casualty tests use the Stunt Die degree; failed tests use the failure margin. The result shows total casualties, the approximate one-third dead/two-thirds wounded split, and survivors before confirmation.
- Force stage tests, Crisis Points, previews, applications, and reversals post compact palette-aware chat cards.

## Palette isolation and contrast

- A user's selected AGE palette is now stored on that User inside the current world. Changing palette in one world no longer changes the same client's palette in every other world.
- GMs can set the default palette received by new users in each world. An existing client preference is imported once into the first world opened after this update so current users do not unexpectedly lose their chosen palette.
- The Force sheet and its persistent chat cards use the same semantic foreground/background pairs as all ten shipped AGE palettes.

## Verification boundary

- Test Harness 0.1.38 targets Foundry 14.366 and System 5.3.2. Audit adds the Force contracts; Smoke adds stage/Crisis/casualty/stale-preview/apply/exact-undo coverage; Full adds the complete Force AppV2 surface and ten-palette computed contrast coverage.
- API 1.4.0, DefinitionV1/DefinitionV2, progression capability 2, Profiles 0.3.0, and existing Character/Item data remain compatible.
- AGE System 5.3.0 remains accepted and 5.2.3 remains rollback until the exact checksummed 5.3.2 candidate passes copied-world Foundry acceptance.

# AGE System 5.3.1 - Importer and NPC Studio Hardening

## Modern AGE Injury damage

- Routes the `mage-mastery-injury` profile through the supported Modern AGE parser while preserving the separate Major/Minor NPC layout choice.
- Removes the fixed imported `damageInjury` placeholder. A bounded, non-evaluating helper suggests Injury damage only for conventional sums of `d3` and `d6` dice plus one optional non-negative flat bonus and fails closed for variables, other dice, subtraction, operators, prose, malformed, or excessive formulas.
- Carries the active rule profile into both signed service previews and parser-only previews so ordinary Modern AGE imports retain ordinary damage behavior.
- Signs each Importer attack's ordinary formula, Injury value, provenance, and confirmation; custom suggestions are editable but cannot commit until explicitly confirmed, and changing the value clears its prior confirmation.
- Signs each entry's canonical parsed output and checks it before the first write and again per parser. Source-backed weapons display the pasted formula separately from the exact source formula that will be copied.
- Preserves explicit reviewed world/compendium Injury values. Missing, zero/placeholder, non-integer, or out-of-range source values are not silently repaired.

## NPC Studio review contract

- Adds `custom.damageInjury` to the normalized draft, compiler, signed plan, review summary, and weapon source produced for Modern AGE Mastery/Injury.
- Shows formula-derived values as editable suggestions and requires explicit `custom.damageInjuryConfirmed` confirmation before a custom Injury weapon can enter signed Review.
- Clears confirmation when the ordinary formula or Injury value changes and blocks null, invalid, or unconfirmed values.
- Leaves reusable world/compendium and cloned source Item values authoritative and source-immutable.

## Importer lifecycle and drag-and-drop

- Exposes the supported Importer AppV2 class beside NPC Studio for integrations and the live Test Harness.
- Uses Foundry's document drop resolver for legacy/compendium payloads while retaining service-side permission, visibility, profile, type/subtype, and digest validation.
- Explains stale, expired, completed, assistance-disabled, and busy drop targets instead of silently ignoring them.
- Reports expected invalid/mismatched drops as bounded user warnings rather than unexpected console errors.
- Classifies expected preview, selection, stale-state, and confirmation refusals as visible user warnings while retaining strict console errors for unexpected parser, cleanup, rollback, or runtime faults.
- Cancels unused user-owned preview sessions when the window closes, including after Assist mode was switched off.

## Verification boundary

- Test Harness 0.1.37 targets Foundry 14.366, System 5.3.1, API 1.4.0, Profiles 0.3.0, and accepted comparison baseline 5.3.0.
- Adds live Audit/Smoke/Full checks for tool opening, source reuse, duplicates, drag-and-drop, creation, stale previews, NPC exact undo, Importer rollback/cleanup, Injury damage, and console cleanliness.
- API 1.4.0, DefinitionV1/DefinitionV2, progression capability 2, Profiles 0.3.0, and the world-data schema are unchanged. No migration runs.
- AGE System 5.3.0 remains accepted and 5.2.3 remains rollback until the exact checksummed 5.3.1 candidate passes copied-world Foundry acceptance.

# AGE System 5.3.0 - Core NPC Studio

## Blank, paste, and clone creation

- Adds a native AppV2 NPC Studio to AGE System; no companion module is required.
- Provides guided Blank NPC, Paste Stat Block, and Clone Actor routes for the five canonical DAGE, FAGE 1e, FAGE 2e, MAGE Core, and MAGE Mastery/Injury profiles.
- Keeps profile-specific abilities, identity vocabulary, combat fields, armor, and resources visible while hiding irrelevant game-line fields.
- Adds searchable visible Actor and Item sources plus bounded custom embedded content.
- Renders parser, custom Focus, and custom Power selections with native conditional option markup, avoiding a Foundry Handlebars helper collision when the Paste route opens.

## Corrected candidate behavior

- Prevents the Importer and NPC Studio AppV2 busy wrapper from blocking their own signed commit after the user confirms creation.
- Accepts both official score-first Fantasy AGE 2e ability lines such as `2 ACCURACY (Bite)` and name-first lines such as `Accuracy 2 (Bite)`, including comma-, semicolon-, newline-, and PDF-whitespace-separated layouts. Missing abilities now produce a clear blocker instead of silently becoming zero.
- Adds secure Item drag-and-drop to NPC Studio and unresolved Importer matches. Dropped documents are resolved through Foundry, permission/type checked, pinned to the signed preview, and revalidated immediately before creation.
- Retries readable compendium indexes without projected fields when an older or module-provided pack rejects Foundry's projected-index request, so Item search degrades safely instead of appearing empty.

## Reuse-first Character content

- Extends the Importer and NPC Studio reuse path across the safe Character Item set: Equipment, Focus, Weapon, Power, Talent, Stunt, Relationship, Honorific, and Membership.
- Prefers a sole compatible exact world match before visible profile-compatible compendium candidates. Duplicate exact matches require the GM to select an explicit source or **Create custom instead**; fuzzy suggestions never auto-select.
- Keeps parsed Focus ability/bonus and Talent degree as signed Actor-specific overlays on the embedded copy without modifying the world or compendium source. Talent degree is bounded by the active profile, and a Specialization remains a `talent` Item with subtype `spec`.
- Re-resolves every chosen source before creation and rechecks visibility, Item type/subtype, active-profile compatibility, signed source digest, and requested overlay data. A changed, hidden, missing, or cross-profile source makes the preview stale before any write.

## Bounded searchable-PDF tolerance

- Applies NFKC normalization, including compatibility ligatures, plus conservative spacing, invisible-character, soft-hyphen, dash, bullet, and word-wrap repairs without rewriting arbitrary prose.
- Repairs only known AGE headings, table labels, wrapped heading/value lines, and Talent or Specialization rank labels; every normalization remains visible for review.
- Recognizes exact Relationship(s), Membership(s), and Honorifics sections as native embedded Item types instead of generic Powers.
- Fails closed when a mandatory ability-score block remains malformed or incomplete after repair rather than supplying unseen zeroes.

## Signed creation and exact undo

- Drafting and preview create no documents and never accept arbitrary raw Actor or Item source from callers.
- Binds each short-lived preview to its user, active profile, normalized draft, source Actors/Items, compiled plan, and expiry.
- Creates one Actor with embedded Items, revalidates the persisted result, and removes an incomplete Actor after an injected post-write failure.
- Clone reads raw persisted source, excludes Class/Progression Items and operational data, and always creates a separate Actor.
- Stores a durable creation receipt and permits targeted undo only while the created Actor remains exactly unchanged.
- Deliberately omits update-original and delete-and-recreate editing.

## API and compatibility

- Adds API 1.4.0 capability `npcStudio` and the frozen `game.ageSystem.api.npcStudio` integration namespace.
- Preserves progression capability 2 and the existing DefinitionV1/DefinitionV2 progression method surface.
- Retains all AGE System 5.2.4 importer hardening and requires no world-data migration.
- Records adapted AGE Creature Forge concepts and their MIT license in `THIRD-PARTY-NOTICES.md`.

## Release boundary

- AGE System 5.3.0 was accepted on 2026-08-30 after the final 56-file root suite, freshly extracted source archive, package-safety gates, byte parity, checksums, and owner Foundry 14.366 confirmation passed.
- AGE System 5.2.3 is the rollback release, and AGE Progression Profiles 0.3.0 is reused unchanged.

# AGE System 5.2.4 - Guided Importer Hardening

## Clearer preview and source resolution

- Replaces the fixed legacy NPC/Talent importer window with a responsive AppV2 workflow for paste, review, and result stages.
- Normalizes common searchable-PDF clipboard artifacts before parsing and discloses every repair in preview.
- Shows each parsed document, proposed embedded/world Item, source, confidence, warning, and blocker before creating anything.
- Adds deterministic source search and explicit per-Item selection; ambiguous fuzzy suggestions are never accepted silently.

## Commit safety

- Binds short-lived previews to the initiating user, normalized input, parser mode, active rule profile, relevant settings, and source selections.
- Rejects expired, cancelled, stale, or source-changed previews and coalesces rapid duplicate commit activation.
- Revalidates every selected Item immediately before commit and removes candidate-created Actors or Items when a batch fails.
- Keeps existing parser exports and the AGE Toolbox entry compatible. No data-model, progression-contract, or migration change is introduced.

## Candidate boundary

- Foundry VTT 14.365 remains the minimum and 14.366 remains the target.
- AGE System 5.2.3 remains accepted until automated and copied-world manual acceptance completes.
- AGE Progression Profiles 0.3.0 is reused unchanged.

# AGE System 5.2.3 - Beginner Progression Handbook

## Beginner-facing documentation

- Adds the illustrated **AGE Character Creation and Advancement Handbook** for players and Game Masters who are completely new to Foundry VTT and AGE System.
- Explains Manual / Local installation, rule profiles, guided Character creation, rank advancement, conflict-aware undo, Classes, and Progression Definition authoring in plain language.
- Provides separate step-by-step walkthroughs for Dragon AGE, Fantasy AGE 1e, Fantasy AGE 2e, and Modern AGE, with screenshots of Character Builder, Advancement Center, signed review/apply, undo, and Definition Authoring Studio.
- Documents that the System, AGE Progression Profiles, and content libraries are separate packages. The System manifest must be directly at `Data/systems/age-system/system.json`; the Profiles manifest must be directly at `Data/modules/age-progression-profiles/module.json`.
- Clarifies that Manual / Local packages do not install or update one another and do not update automatically.

## Compatibility boundary

- This is a documentation-only System patch. It changes no runtime JavaScript, DefinitionV1 or DefinitionV2 schema, public API 1.3.0 contract, progression capability, preview signature, commit, receipt, undo, migration, or world data.
- AGE Progression Profiles remains at 0.3.0 and is not rebuilt.
- Foundry VTT 14.365 remains the minimum and 14.366 remains the verified target.

# AGE System 5.2.2 - AppV2 Usability Hardening

## Character and Vehicle usability

- Restores a bounded vertical scroll region to every Full Character tab while keeping the sheet header and tab navigation visible; AppV2's part lifecycle retains the active tab's scroll position.
- Renders Stat Block Power descriptions as permission-aware enriched display content relative to the actual embedded Item, without opening an editor, submitting an Item field through the Actor form, or mutating Item/source data.
- Adds explicit AppV2 palette foreground/background tokens for primary and secondary surfaces, controls, disabled values, rich text, and links across the bundled colour schemes.
- Makes the Vehicle description a larger, always-visible native editor so existing formatted descriptions are visible and editable.
- Keeps the Vehicle GM-notes textarea on the opaque AppV2 control surface so its text meets the same contrast contract instead of inheriting the legacy translucent background.

## Compatibility boundary

- This is the accepted System-only AppV2 usability release. AppV1 fallback sheets remain unchanged and selectable.
- DefinitionV1, DefinitionV2, public API 1.3.0, progression capability 2, Profiles 0.3.0, signed previews, commits, receipts, and conflict-aware undo remain unchanged.
- No data migration is required. Automated validation and copied-world Foundry 14.366 acceptance completed before promotion.

# AGE System 5.2.1 - Definition Authoring Studio Hardening

## Safer, clearer GM authoring

- Promotes the Progression Definition sheet into a guided Definition Authoring Studio with an always-visible schema badge and compact lifecycle, provider, and unsaved-draft status.
- Keeps locked-compendium and otherwise read-only definitions inspectable while offering an explicit **Create editable world copy** path; opening or browsing a source document never mutates it.
- Adds save preflight for stable definition identity, profile continuity, and semantic-version changes before a document write is attempted.
- Guards draft-replacing and close/navigation actions so an in-memory definition cannot be discarded without an explicit decision.
- Organizes the long authoring surface through keyboard-operable section navigation, connects validation findings to their corresponding controls, moves focus to the first actionable problem, and exposes status changes with accessible labels and live feedback.

## Compatibility boundary

- DefinitionV1, DefinitionV2, public API 1.3.0, progression capability 2, Profiles 0.3.0, signed previews, commits, receipts, and conflict-aware undo remain contract-compatible with 5.2.0.
- This is an unverified candidate scope. Automated and copied-world Foundry 14.366 acceptance must complete before promotion.

# AGE System 5.2.0 - Complete Guided Progression Contract

## Additive DefinitionV2

- Adds DefinitionV2 without removing or rewriting DefinitionV1. Generic validation, registration, compilation, preview, commit, receipts, and undo accept both schema versions; existing providers remain compatible, Fantasy AGE 1e guided creation uses DefinitionV2, and its advancement retains the DefinitionV1/Class-v3 route.
- Adds typed `text`, `longText`, `integer`, and `select` inputs; authored workflow stages; conditional choice groups; input-backed identity/ability/language values; `ability.set`; `language.add`; expanded identity fields; normalized Resources/currency initialization; and bounded ability/formula handling.
- Keeps the contract closed and provider-neutral. FAGE, DAGE, MAGE, modules, world Items, compendia, imports, and the legacy Class adapter are optional content sources, not dependencies or privileged execution paths.
- Keeps public API 1.3.0 while raising the progression capability to 2 and advertising latest schema 2 plus supported schemas `[1, 2]` for additive feature detection.

## Character Builder and Advancement Center

- Character Builder renders definition-authored stages and typed controls, applies starting abilities before dependent formulas, and compiles the selected path into one complete Character creation transaction.
- Advancement Center uses the same normalized definition data for Class-backed and Actor-backed ranks, with source/profile/track continuity and explicit readiness blockers.
- Creation and advancement remain preview-first. Formulas resolve once and are signed with inputs, choices, sources, Actor/base state, user, expiry, and plan digest. Commit accepts only the preview identity and digest.
- Failed commits roll back; successful commits store durable receipts. Creation reversal and advancement undo remain separate, previewed, exact/conflict-aware operations which refuse to overwrite later play.

## AGE Progression Profiles 0.3.0 integration

- Supports full guided Dragon AGE Mage/Rogue/Warrior creation and audited rank 1-20 Class advancement, full guided Fantasy AGE 1e Mage/Rogue/Warrior DefinitionV2 creation with retained DefinitionV1/Class-v3 advancement, full guided Fantasy AGE 2e Envoy/Mage/Rogue/Warrior creation with retained rank 1-20 Class routes, and full guided Modern AGE Gritty/Pulpy/Cinematic creation plus Actor-backed ranks through 20 for Core Health and Mastery/Injury.
- Keeps incomplete, ambiguous, prose-only, or unmapped Fantasy AGE 1e details within the same explicit manual-review boundary as the other game lines; DefinitionV2 creation does not turn those details into guessed automation.
- Automates only exact normalized mappings. Ambiguous, prose-only, incomplete, or unmapped source rules remain visible manual-review summaries in the signed preview; the system and provider do not guess rules, Items, RollTable results, or Actor paths.
- Foundry VTT 14.365 remains the minimum and 14.366 remains the verified target.

# AGE System 5.1.5 - Progression Hardening

## Executor-safe previews

- Separates portable DefinitionV1 validation from trigger-filtered execution readiness. Creation, Class-backed, and Actor-backed paths now fail closed before preview when they request unsupported resources, choices, Item traits, source ordering, duplicate initialization, or rank effects.
- Exposes the additive `validateExecutability(definition, {trigger})` operation and `executabilityValidation` capability while retaining DefinitionV1 schema 1 and public API 1.3.0.
- Creation Item advancement accepts the normalized plain traits used by the Class/Actor executors as well as the retained dotted creation aliases, eliminating a contract-valid but non-materializing Item path.
- Direct API preview calls run the same executor preflight before Actor/user/profile/base/source/formula resolvers, compiler work, preview IDs, or preview-store writes; module and macro callers cannot bypass the UI readiness gate.
- Actor-backed creation and advancement require exactly one matching `track.setRank` on every legal choice path. Conditional alternatives remain valid, while missing, optional, repeated, or multiple rank effects fail closed.
- Creation-time Item advancement uses prototype-safe trait dispatch, enforces Talent versus Specialization subtype, preserves normal numeric degree/maximum and Relationship intensity invariants, and requires one unambiguous preceding quantity-one acquisition.

## Builder and Advancement Center usability

- Disabled Create and Apply buttons now have visible, specific reasons, including unresolved module/compendium dependencies and incomplete required selections.
- Workflow stages are clickable and indicate current/completed state. Large choice groups add search, selected-only filtering, clear controls, and visible/selected counts.
- Advancement Center clears stale busy state after refresh and gives a clean no-next-rank state after rank 20.
- Character Builder coalesces concurrent Create and exact-reversal requests, preventing a rapid double click from producing a false failure or clearing busy state while the first transaction remains active.
- Dark workflow and technical-summary bars use explicit high-contrast light text and icons in both Builder and Center without changing their surrounding palette.

## Profiles 0.2.3 validation

- Adds a copy-on-read matrix across 16 advancement definitions and every rank from 2 through 20: 304 signed executor-bound previews, 304 exact apply/reverse checks, 2,687 resolved effects, 387 deterministic formula resolutions, 780 source bindings, and 24 owned-item target bindings.
- Source LevelDB packs remain byte-identical to accepted Profiles 0.2.2. Version 0.2.3 hardens validation and compatibility metadata; it does not silently rewrite progression content or change source-reference revisions.
- Foundry VTT 14.365 remains the minimum and 14.366 remains the verified target. AGE System 5.1.4 and Profiles 0.2.2 remain accepted while this candidate receives manual Foundry verification; 5.1.3 and Profiles 0.2.1 remain rollback artifacts.

# AGE System 5.1.4 - Progression Path Continuity

## Character creation and advancement

- Actor-backed character creation now persists the selected Definition id and rules profile on the signed Actor progression track. Classless MAGE-style Characters therefore continue through the same progression path in the Character sheet and Advancement Center instead of choosing again.
- Actor-track advancement rejects a different Definition attempting to reuse an already bound track. Existing pre-5.1.4 Actor transactions remain compatible through their signed definition/profile provenance, and undo restores the exact prior binding state.
- Class-backed FAGE/DAGE creation and advancement retain their established Class Item transaction path and Actor/Class rank synchronization.
- Formula amounts may carry an optional `rollId`. Effects sharing the same formula and `rollId` consume one signed preview result, so paired current/maximum Health or Power gains cannot diverge.
- Modern AGE Actor-backed ability allocation now exposes and accepts only abilities in the active profile even when module Definitions retain the legacy Class-adapter capability; harmless zero-valued dormant fields are discarded, while nonzero ineligible allocations still fail closed.
- Persisted creation and advancement receipts are hydrated into the new runtime immediately after reload, restoring visible recent-history and undo actions without a prior id lookup.
- Split Foundry Actor updates suppress the expected intermediate rank mismatch only during the active transaction; a persisted mismatch still fails closed.
- Legacy `icons/svg/skill.svg` acquisition sources use Foundry 14's available `icons/svg/book.svg` fallback without changing source-digest validation.

## Player-facing clarity

- Character Builder and Advancement Center now share one label resolver which prefers authored source names and selected option labels. Generated `grant:…` identifiers stay confined to collapsed technical diagnostics.
- Choice groups where every option sets the same identity field are automatically presented as Ancestry, Background, Social Class, or Class stages. This is provider-neutral presentation metadata; no FAGE, DAGE, or MAGE content dependency was added.
- Character creation receipts now show a readable result, Character name, creation path, status, and date while retaining the exact receipt id internally for audit and safe reversal.
- Level effects read as “Start at level” or “Advance to level,” and raw ability keys are no longer displayed beside normal Builder ability names.
- Unresolved semantic name inputs show a neutral placeholder instead of `[object Object]`, and Actor-backed summaries say “Character level” rather than “Class level.”

## Retained safety boundary

- DefinitionV1 remains schema version 1 and the public integration API remains 1.3.0. Preview signing, identifier-only commits, source/base/profile/user checks, durable receipts, partial-write recovery, and conflict-safe undo/reversal are unchanged.
- Foundry VTT 14.365 remains the minimum and 14.366 remains the verified target. AGE System 5.1.3 remains the accepted rollback-safe baseline while this candidate is tested.

# AGE System 5.1.3 - Guided Progression Usability

## Easier GM authoring

- Adds four guided Progression Definition starting points: Character creation, creation plus Actor ranks, Class-backed advancement, and classless Actor-backed advancement.
- Generates the selected rank timeline, track binding, milestone ids, triggers, rank effects, and capabilities as an unsaved preview-only draft. Existing persisted data is not changed until the GM validates and saves.
- Replaces the free-text rules-profile field with a localized profile selector and adds a plain-language readiness checklist.
- Keeps world/compendium Item search, drag-and-drop sources, full semantic editing, validation, import/export, and the advanced normalized JSON escape hatch intact.

## Easier player workflow

- Rewords Character Builder and Advancement Center around player choices and outcomes rather than contract internals.
- Adds a visible three-step guide to each application, keeps technical provenance/formula details collapsed by default, and presents a clear final change review before commit.
- Adds a prominent **Open Advancement Center** action to owned Class sheets in both AppV2 and the selectable AppV1 fallback.
- Retains the Character-sheet Advancement Center entry for Class-backed FAGE/DAGE paths and classless Actor-backed MAGE paths.

## Retained safety boundary

- Definition authoring, character creation, and advancement remain preview-first. Commit still receives only a signed preview id and plan digest.
- No DefinitionV1, API 1.3.0, transaction, receipt, undo, migration, gameplay, roll, socket, or persistence contract changes in this release.
- Foundry VTT 14.365 remains the minimum and 14.366 remains the verified target. AGE System 5.1.2 remains accepted until copied-world QA accepts this candidate.

# AGE System 5.1.2 - Foundry VTT 14.366 Compatibility

## Compatibility update

- Raises the manifest's verified Foundry version from 14.365 to 14.366 while retaining 14.365 as the minimum supported v14 build.
- Retains the accepted 5.1.1 progression lifecycle, Definition Item authoring, Character Builder, Advancement Center, AppV2 defaults, selectable AppV1 fallbacks, gameplay automation, and API 1.3.0 without a data migration or contract change.
- Re-audits AGE's complete raw-source `ForcedReplacement` update boundary against Foundry 14.366's corrected replacement diffing and synthetic-Actor propagation.
- Adds copied-world acceptance checks for synthetic-token updates and token resource-bar selection alongside Health, Power Points, damage/healing, modifier, Class-backed, Actor-backed, receipt, rollback, compendium, and AppV2 persistence paths.
- Confirms AGE templates do not use the `<file-picker>` or `<formula-input>` controls whose change-event target behavior changed in Foundry 14.366.

## Release boundary

- This is a temporary Manual / Local compatibility candidate until Audit, Smoke, Full, Operations & Diagnostics, and manual copied-world checks pass on Foundry 14.366.
- AGE System 5.1.1 remains the accepted release and 5.1.0 remains the rollback release during validation.
- DAGE, FAGE, the separate AGE Test Harness, and companion-module compatibility metadata are maintained in their own release tasks and are not changed by this System-only package.

# AGE System 5.1.1 - Progression Lifecycle and Usability Hardening

## Corrected and clarified

- Progression Definition Items now have explicit Draft, Valid/Disabled, Valid/Active, and Invalid lifecycle states. A blank new Item remains a safe non-runnable draft, produces one concise content-audit warning, and never enters the active registry.
- Definition validation suppresses derivative child errors beneath structurally invalid containers and delays digest diagnostics until DefinitionV1 itself is valid. Strict leaf, graph, source-reference, binding, and semantic-effect validation remains unchanged.
- The AppV2 Definition sheet now shows lifecycle, save state, concise validation severity, and clear launch gating. A generated starter definition remains in memory until the GM explicitly saves it.
- The Advancement Center keeps compatible but currently unavailable definitions visible, explains missing ranks, prerequisites, Class bindings, maximum rank, stale preview/source/profile states, and distinguishes provider origin in player-readable language.
- Preview effects, commit receipts, reload-safe recovery, and targeted undo are presented more clearly. Duplicate commit or undo gestures coalesce to one service operation.
- Full and compact AppV2 Character sheets now show progression availability/current-to-target rank and open the same Definition-driven Center for Class-backed FAGE/DAGE and Actor-backed MAGE tracks.
- Known validation and unavailable-progression responses use Foundry notifications without duplicating expected AGE domain errors into the console. Unexpected exceptions remain logged.
- Class-backed rollback now restores the complete pre-advancement summary array and the original nullable Class progression base level. Undo no longer leaves a serialized sparse-array `null` or converts an original `baseLevel: null` to `0`.
- Class rollback equality checks now use Foundry 14's supported `foundry.utils.equals` helper instead of the deprecated `objectsEqual` alias.

## Retained safety boundary

- Commit still accepts only `previewId` plus `planDigest`; definition/profile/source/base/user/expiry bindings are rechecked before mutation.
- Class and Actor track advancement retain durable receipts, reload hydration, conflict-safe latest undo, partial-write recovery, source preservation, and cross-client duplicate protection.
- No schema, socket, transaction, roll API, AppV1 fallback, gameplay, or third-party integration contract is redesigned by this maintenance candidate.

# AGE System 5.1.0 - Provider-neutral Creation and Advancement

## Added

- Added the normalized, closed DefinitionV1 progression contract with canonical digests, path-specific validation, provider provenance, profile adapters, source references, milestones, inputs, choices, evaluations, semantic effects, and explicit Class bindings.
- Added one shared progression registry for system/module registrations, world-created Progression Definition Items, readable Item compendia, JSON imports, and the legacy Class-v3 adapter. Provider origin grants no execution trust.
- Added a GM-only AppV2 Progression Definition sheet. Its semantic editor supports identity/profile/version/coverage/rank/capabilities, Class binding, source references, milestones, triggers, inputs, choice groups/options, evaluations, and effects; source Items can be found through world/compendium search or drag-and-drop, while raw normalized JSON remains an advanced validated escape hatch.
- Added Character Builder and Advancement Center AppV2 applications powered by the same definition, compiler, preview, receipt, and executor contracts.
- Added API 1.3.0 progression registration, validation, discovery, signed creation/advancement preview, commit, receipt lookup, undo preview, undo, status, and capability methods.
- Added persistent receipt journaling and hydration so committed creation and advancement receipts remain available after reload.
- Added progression Item model, icon, sheet registration, content-audit validation, world/compendium scanning, provider reconciliation hooks, import/export, enable/disable, duplication, and GM/top-level mutation guards.
- Extended the AGE System 5 guided tour and documentation for core-only authoring, Character Builder, Advancement Center, provider integration, migration boundaries, and copied-world acceptance.

## Safety and execution boundary

- Corrected the Foundry v14 startup boundary: init registration is fully synchronous, template loading is captured without suspending init, and the progression runtime/API are constructed during setup after the current User and world Actor collection exist. This prevents one slow template/font request from cascading into missing settings, helpers, or ready-state data.
- Corrected progression Definition Item lifecycle authorization for Foundry v14, whose `_preCreate`, `_preUpdate`, and `_preDelete` methods pass the initiating `User` object rather than a user-id string. Real GMs can now create and maintain definitions while non-GM and embedded-Item mutations remain blocked.
- Restored Foundry Token resource selection for compatibility-first Actor models by explicitly declaring per-type trackable attributes. Character Health, Power Points, and Conviction; Vehicle Part Health; and useful Spaceship/Organization numeric tracks are selectable without migrating or rewriting Actor source.
- Creation and advancement are preview-first. A preview binds the canonical definition/profile/source/base/user/Actor state, resolved choices and semantic inputs, one-time formula results, expiry, and plan digest.
- Commit accepts only the preview id and plan digest. It never accepts client-supplied document update paths or a replacement plan.
- Character creation uses one complete Actor creation call with preassigned embedded Item ids. Reversal requires a separate destructive undo preview, explicit confirmation, and an exact current-source digest match.
- Advancement retains the specialized Class transaction/rollback boundary, duplicate/concurrent protection, latest-safe rollback, and conflict refusal for later edits.
- Invalid, disabled, checksum-mismatched, stale, or ambiguous definitions fail closed at execution. Embedded definitions are excluded and locked packs are read-only. Draft validation, cancellation, failed preview, and failed commit leave no temporary documents.
- Corrected the first 5.1.0 candidate's Foundry-only persistence edges: Definition creation now gives Foundry a mutable source clone; creation receipts bind the authoritative cleaned Actor source; Actor-track level updates preserve simultaneous flag operators; exact recovery removes an otherwise empty system flag namespace; and receipt/source pinning reads raw persisted data.
- Weapon and Power full-form preservation now includes the configured attack ability (`useAbl`), so unrelated AppV1 or AppV2 edits cannot normalize it from `acc` to `no-abl`.
- Runtime replacement/deletion updates invoke Foundry v14 data-field operator factories with their required constructor binding. Progression commit, rollback, and lock cleanup therefore avoid both deprecated legacy deletion syntax and the detached-factory `this is not a constructor` failure.
- Explicit atomic system-branch operator proxies survive Actor pre-update normalization by identity. Class advancement also verifies the persisted Actor journal and Class marker before returning success, preventing a rejected Class transaction from being recorded as committed.
- Actor-backed advancement journals encode managed snapshot paths with Foundry-safe keys. Foundry can no longer reinterpret keys such as `system.level` while cleaning flag data, so classless level/resource transactions persist, reload, and undo through the same signed registry as non-level tracks.
- Progression Definition Item drag-and-drop now reads Foundry's namespaced TextEditor implementation and emits no deprecated global-TextEditor warning.

## Content-provider boundary

- The core system supports fully user-authored progression without a content module. FAGE, DAGE, MAGE, and other modules are optional DefinitionV1 content providers, not dependencies of the engine, Builder, or Center.
- The shipped FAGE/DAGE/MAGE validation fixtures are copyright-neutral **synthetic structural coverage**. They prove the normalized contract and profile adapters can represent the required shapes; they are not complete rules payloads and do not imply that the existing modules already deliver DefinitionV1 content.
- Complete module-specific progression definitions remain separate provider-content deliverables and must pass the same contract as world, compendium, and imported definitions.

## Interface cleanup

- Removed the AGE Toolbox's redundant generic dice shortcuts. It no longer exposes 1d6, 2d6, 3d6, d66, or d666 actions; Foundry's normal dice roller and the underlying AGE dice/roll APIs remain unchanged.
- Requested Rolls, recovery, Advanced Tests, Operations & Diagnostics, Character Builder, and every other Toolbox workflow remain available.

## Compatibility

- Retains the accepted 5.0.7 AppV2 atomic-source corrections, AppV2 defaults, selectable legacy AppV1 fallbacks, gameplay automation, Argon/Ammo Belt integration boundaries, content validator, and preview-only typed-data migration.
- Targets Foundry VTT 14.365. No bulk typed Actor/Item migration executor is introduced in 5.1.0.
- The accepted 5.0.7 release and 5.0.0-rc.3 rollback artifacts remain historical recovery points; this section does not alter them.

## Validation

- Startup regressions assert that init contains no await, progression cannot initialize before the Actor collection exists, setup constructs progression before `ageSystemApiReady`, and ready observes the captured template promise.
- Contract tests cover canonical stability, closed-graph validation, semantic authoring, document persistence/security, provider arbitration, source and base staleness, formula pinning, creation/advancement planning, commits, receipt hydration, conflict-safe undo/reversal, and legacy Class adaptation.
- Synthetic DAGE, FAGE 1e/2e, and MAGE Core/Mastery fixtures provide structural profile coverage without embedding published advancement content.
- Release checks cover constructor-bound data operators, explicit branch-operator identity, Class journal postconditions, namespaced drag-data parsing, mutable Foundry document creation inputs, cleaned-source receipt binding, Actor-track mixed system/flag updates, exact namespace recovery, provider-neutral capability reporting, searchable/drop-enabled source authoring, the progression Item in content validation, AppV2 applications and templates, API 1.3.0, guided-tour content, documentation, and absence of the five generic Toolbox shortcuts while retaining the AGE roll engine.

# AGE System 5.0.7 - AppV2 Item Canonical-field Preservation

## Corrected

- Default AppV2 Weapon and Power sheets now preserve untouched raw canonical fields when `submitOnChange` serializes the complete form for an unrelated edit.
- Weapon damage source, minimum Strength, and reload plus Power damage source and casting time retain their exact stored values, types, and absence unless that specific control was intentionally changed.
- Native UI changes and explicit flat or nested programmatic updates to a protected field remain authoritative and pass through normal Foundry validation.

## Verification boundary

- Focused tests cover unrelated full-form edits, exact raw values and types, missing-source fields, explicit UI/programmatic edits, and source immutability for Weapon and Power Items.
- The copied-world Full report must treat any nonempty AppV2 Item `unauthorizedDiffPaths` list as a failure; Harness ownership and changes remain in its separate task.
- Gameplay automation, Actor persistence, AppV1 fallback preservation, migrations, companions, the accepted 5.0.0-rc.3 recovery point, and the 4.5.0 rollback are unchanged.

# AGE System 5.0.6 - AppV1 Power Casting-time Preservation

## Corrected

- Selectable AppV1 Power fallbacks now preserve an untouched raw `castTime` value exactly when their normalized full form submits or closes.
- Explicit casting-time edits from the legacy UI and flat or nested programmatic submissions remain authoritative.
- The correction extends the existing raw-source preservation boundary without changing AppV2 Powers, Power Point consumption, rolls, damage, healing, or resistance automation.

## Verification boundary

- Focused tests cover untouched `minor` source values rendered through the legacy `noAction`/`minorAction` surface, explicit UI and programmatic edits, absent-source handling in the preservation helper, and source immutability.
- The accepted 5.0.0-rc.3 recovery point and 4.5.0 rollback remain untouched while 5.0.6 replaces only the temporary 5.0.5 candidate.

# AGE System 5.0.5 - Legacy Fallback and Modifier-key Correction

## Corrected

- Character Effects controls now derive a modifier's usable key from its authoritative modifier-map entry when older or third-party Item data omits the redundant inner `key` property. The key exists only in isolated prepared data and is not written into Item source.
- Selectable AppV1 Weapon and Power fallbacks preserve the exact stored damage-source, minimum-Strength, and reload values represented by normalized legacy controls unless the user explicitly edits the corresponding control.
- A protected legacy field which was absent in raw source remains absent after an ordinary full-form submit or sheet close. Explicit UI edits and flat or nested programmatic updates remain authoritative.

## Verification boundary

- Focused tests cover raw modifier-key derivation, source immutability, Weapon and Power full-form submission, exact type preservation, explicit UI/programmatic edits, and exact absence preservation.
- AGE 5 automation, AppV2 sheets, transactions, resources, modifier removal, migration, and AppV1 fallback selection remain unchanged outside these narrow corrections.
- The accepted 5.0.0-rc.3 recovery point and 4.5.0 rollback remain untouched while 5.0.5 replaces only the temporary 5.0.4 candidate.

# AGE System 5.0.4 - Source-safe Item Modifier Correction

## Corrected

- Removing an Item modifier from either the AppV2 sheet or the selectable AppV1 fallback now rebuilds the authoritative modifier map from the Item's persisted raw source.
- Toggling a modifier now updates only its stored `isActive` leaf. Runtime validation metadata (`ftype`, `itemId`, `itemName`, and `valid`) can no longer be copied from prepared Item data into otherwise untouched modifiers.
- The correction applies to owned and world Items without changing modifier formulas, conditions, extension fields, or unrelated Item data.

## Verification boundary

- Dedicated regressions inject prepared-only metadata before remove and toggle actions, reopen the Item, and prove the surviving raw modifier data remains byte-identical apart from the authorized change.
- Existing Character resource, automation, transaction, migration, AppV2 parity, and AppV1 fallback coverage remains intact.
- The accepted 5.0.0-rc.3 recovery point and 4.5.0 rollback remain untouched while 5.0.4 replaces only the temporary 5.0.3 candidate.

# AGE System 5.0.3 - Atomic Automation and Resource Correction

## Corrected

- Power casting now decreases only current Power Points. The complete raw Power Point branch is preserved, so minimum, set/maximum, custom extension values, and unrelated Character data survive the cast and a sheet reopen.
- Power Point spending is serialized per Actor instead of per Power, preventing two different Powers from racing over the same resource. A zero-point payment is a true no-op.
- Damage, healing, recovery, direct Health adjustments, transaction rollback, macros, and module calls now preserve the complete raw Health branch while changing only the requested leaf.
- Every Actor and Item update passes through a shared raw-source boundary. Partial top-level compatibility objects are rebuilt from `_source` and carried through Foundry 14 as explicit `ForcedReplacement` values; prepared-only derived fields are never persisted.
- Transaction undo and rollback retain leaf-level conflict semantics while the document boundary reconstructs the latest complete raw branch, preserving sibling edits made after the original action.
- Indexed edits to array-backed compatibility fields preserve every existing record. Ambiguous indexed deletions and unsafe `recursive: false` system updates are rejected in favor of an intentional complete replacement.
- AppV1 and AppV2 modifier removal now declare an authoritative complete modifier map, so the removed modifier stays removed while every remaining modifier survives.
- Character and Item creation rebuild partial compatibility data against the declared system template. NPC import now creates a complete Health branch instead of a value-only object.
- Owned-Item migration preserves complete Item compatibility branches even when embedded migration runs inside an Actor update. Synthetic-token Item overrides are materialized over base Items before migration, and no Foundry data operator can leak into stored Scene delta data.
- Condition and combat-economy update listeners understand explicit Foundry data operators without changing their existing automation behavior.

## Data-safety boundary

- No bulk world migration is added. AppV1 fallback sheets remain registered and selectable.
- The correction prevents new sibling loss. It cannot infer a value already removed by an earlier candidate; restore such values from backup, compendium source, or manual entry.
- The accepted 5.0.0-rc.3 recovery point and 4.5.0 rollback remain untouched while 5.0.3 replaces only the temporary candidate.

## Verification

- Dedicated regressions cover nonzero Power Point spending and rollback, damage and Health rollback, direct atomic Actor/Item updates, explicit deletion, modifier removal, array-backed fields, creation/import defaults, owned-Item migration, and synthetic-token Scene deltas.
- Production JavaScript, Handlebars, document/source guards, automation contracts, sheet parity, release structure, and fresh-extraction validation are repeated for the packaged candidate.

# AGE System 5.0.2 - AppV2 Atomic Transport Correction

## Corrected

- Complete Character compatibility branches now use Foundry 14's `ForcedReplacement` operator. The browser, socket layer, schema-unaware server, and receiving browser all retain the same complete AnyField value instead of returning a recursively minimized partial branch.
- The Actor pre-update source guard models top-level AnyField replacement semantics and unwraps Foundry data operators before comparison. Partial branches, omitted hidden abilities, dropped resource siblings, and removed legacy extension keys are rejected before persistence.
- Both native single-control changes and the full/programmatic AppV2 submit route carry the same authorized-path guard metadata.

- Character AppV2 native changes now bypass whole-form serialization entirely. Each change captures one typed control delta, queues it, rebuilds only that source-complete top-level compatibility branch, and rejects the update if any unrelated raw source path would change.
- Direct Character Health, Defense, and Toughness fields are authoritative once stored. Legacy game-mode profile records remain available as presets and as fallbacks for genuinely missing fields, but an ordinary native control edit no longer persists a second hidden profile branch or reverts after preparation.
- Character AppV2 now keeps its change-only delta separate from Foundry's pre-update validation result. Validation may clean a source-complete preview, but injected compatibility defaults cannot enter the queued database update.
- Character ability, Health, Power Point, rules-profile, Primary, and Last Advanced edits persist as complete dotted top-level source branches rebuilt from the latest Actor source. Editing one control no longer resets omitted sibling controls to zero or blank.
- Character ability forms now rebuild the submitted `system.abilities` branch from the Actor's raw stored source before Foundry validation, preserving hidden rules-profile abilities plus unrendered `testMod` and `advances` values found by QA Harness 0.1.7.
- Only the genuinely editable ability fields (`value`, `primary`, and `lastUp`) may enter that reconstructed branch. Disabled prepared controls can no longer submit `mod`, `total`, or a transient `NaN` back into Actor source.
- AppV2 Item forms convert Foundry's validated expanded form object back to leaf-level document updates before saving. Character forms instead rebuild complete source-preserving object branches and commit them as one serialized transaction, matching Foundry's atomic `AnyField` update semantics.
- Character ability changes preserve abilities hidden by the active AGE rules profile and all unrelated persistent ability fields; calculated modifiers and totals remain derived in memory.
- Primary and last-advanced checkboxes save both checked and unchecked states without replacing `system.abilities`.
- Blank legacy numeric controls use Foundry 14's supported `deleteProperty` utility instead of the nonexistent `unsetProperty` call.
- Character preparation restores missing ability shells in memory, normalizes non-finite derived inputs, and roll-data preparation safely falls back through total, value, and zero, preventing one damaged Actor from cascading failures through its owned Focus, Power, and Weapon Items.
- Compatibility data models now detach every persisted object branch from `_source` before Actor or Item preparation. Legacy AGE calculations can continue to populate derived nested values without changing the raw document source, and repeated preparation starts from the same persisted values.

## Data-recovery boundary

- This correction prevents further partial-object replacement and allows affected Actors to open and roll.
- It cannot infer an original ability value that the 5.0.0 candidate already persisted as blank or removed. Restore such values from a backup or the original compendium entry, or re-enter them manually.
- No automatic bulk data migration is added; AppV1 fallbacks remain available.

## Verification

- 122 executable AGE checks pass, 75 production JavaScript files pass syntax validation, and all 92 Handlebars templates compile. No template or style file changed from the accepted RC.3 surface whose 32 AppV2 normal/narrow viewport contracts already passed.
- Adds executable regressions for hidden ability preservation, validation-default isolation, dotted atomic branch updates, derived-field exclusion, raw-source isolation, unchecked boxes, blank numeric controls, and the shared Actor/Item AppV2 update boundary.
- The 5.0.0-rc.3 accepted release and 4.5.0 rollback remain untouched while 5.0.2 replaces 5.0.1 in the temporary candidate slot.

# AGE System 5.0.0 - Stable AppV2 Experience

## Stable promotion

- Promotes the full-parity AppV2 Character, Character Stat Block, Vehicle, Spaceship, Organization, and eleven Item sheets verified through RC.3.
- Makes AppV2 the registered default for every supported Actor and Item type.
- Runs a one-time, GM-only transition of Foundry's `core.sheetClasses` world setting for empty and recognized AGE legacy defaults.
- Preserves explicit per-document sheet selections, already selected AppV2 variants, and third-party world defaults.
- Keeps all verified AppV1 sheets registered and clearly labelled as legacy fallbacks; no legacy template, style, field, or control is removed.

## Data and compatibility boundary

- Changing the default sheet does not rewrite an Actor, Item, compendium, or chat message.
- Compatibility-first TypeDataModels remain permissive for existing content, and the migration preview remains read-only. Stable 5.0.0 does not execute a bulk typed-data migration.
- Existing AGE Actions, Stunts, multi-target attacks, Power resistance and damage routing, recovery, conditions, combat economy, requested rolls, Advanced Tests, transactions, diagnostics, Ammo Belt hooks, and Argon integration remain intact.
- The release channel remains Manual / Local with no placeholder update or download URL.

## Verification baseline

- RC.3 passed Foundry 14.365 Audit (5 pass / 3 expected warnings / 0 fail), Smoke (10 / 3 / 0), and Full (11 / 3 / 0) with complete fixture cleanup.
- Stable-specific validation adds deterministic tests for default migration, third-party preservation, one-time execution, GM ownership, and fallback persistence.

# AGE System 5.0.0-rc.3 - Console and Lifecycle Cleanup

## Corrected

- AppV2 rich-text enrichment now uses Foundry 14's namespaced `foundry.applications.ux.TextEditor.implementation` API instead of the deprecated global `TextEditor` alias.
- Delayed condition assistance now confirms its world, compendium, or synthetic-token Actor is still available before follow-up work.
- If an Actor is deleted during the follow-up update itself, condition assistance exits quietly; unrelated database and automation failures still propagate for diagnosis.

## Validation scope

- RC.2's Foundry Audit, Smoke, and Full QA reports all completed with zero failures and Migration Preview reported zero blockers.
- RC.3 is deliberately limited to the two console findings from that pass. Legacy fallback sheets remain unchanged and may still produce Foundry's expected AppV1 deprecation warning when deliberately opened.
- The accepted 4.5.0 release and 4.5.0-rc.1 rollback remain untouched. RC.3 replaces RC.2 only in the single temporary candidate slot.

# AGE System 5.0.0-rc.2 - Blank-Document and Migration Review Hardening

## Corrected

- Compatibility-first TypeDataModels now clone their `template.json` defaults into newly created Actors and Items, preventing blank Character, Vehicle, and Spaceship preparation errors.
- New Characters begin at the active game mode's prepared maximum health when no explicit health value was supplied.
- Passenger preparation tolerates missing legacy arrays, and Character game-mode preparation exits safely when legacy mode data is incomplete.
- Restored the canonical `system.gameMode.override` source key used by both legacy and AppV2 sheet controls.
- Added the two AppV2 Character partials to startup preloading and retained serializable boolean injury marks from the live RC correction.

## Migration classification

- Null, blank, hyphen, and dash placeholders in numeric slots are now explicit `legacy-empty-number` review items.
- Recognizable legacy dice or ability formulas stored in numeric slots are now explicit `legacy-number-expression` review items.
- Neither class is silently coerced or executed. Unrecognized malformed values, incompatible shapes, unsupported types, and undeclared source fields remain blockers.

## QA boundary

- AGE System Test Harness 0.1.3 now fails the disposable lifecycle check unless every blank Actor type completes preparation with its required source structures.
- Migration review items produce a warning; only unresolved blockers fail the migration check.
- The accepted 4.5.0 release and 4.5.0-rc.1 rollback remain untouched. RC.2 replaces RC.1 only in the single temporary candidate slot.

# AGE System 5.0.0-rc.1 - Native AppV2 and Data-Safety Gate

## Added

- Registered compatibility-first Foundry V14 `TypeDataModel` classes for all four Actor and eleven Item types.
- Added a read-only migration preview to Operations & Diagnostics and API 1.2.0. It reports safe defaults/coercions, review items, and blockers without updating documents.
- Added a five-step AGE System 5 guided tour, compatibility matrix, migration guide, and RC acceptance checklist.
- Added rendered-browser contracts for all five Actor-sheet surfaces and eleven Item sheets at normal and narrow widths.

## Hardened

- Replaced AppV1 prototype borrowing in AppV2 controllers with shared native context and action services.
- Replaced post-render editor replacement with template-time Foundry V14 ProseMirror controls.
- Modifier removal now submits the complete remaining modifier object, avoiding deletion-operator edge cases on compatibility-first typed fields.
- Declared all source fields observed in the copied test world, including height, weight, reloadability, legacy activation aliases, and Class modifier data.
- Declared runtime-only prepared fields as non-persisted so Foundry does not prune them or write cached values back to source.
- Kept every legacy sheet registered as the default and every AppV2 sheet explicitly opt-in.

## RC boundary

- This candidate never runs a data migration automatically and does not include a migration executor.
- The accepted 4.5.0 and rollback 4.5.0-rc.1 archives remain protected until copied-world acceptance is complete.

# AGE System 5.0.0-beta.6 - AppV2 Editor and Modifier Correction

## Corrected

- Replaced legacy forced-deletion update syntax with Foundry V14's native `ForcedDeletion` operator when an Item modifier is removed.
- Scoped Spaceship feature controls so their generic toggle/edit/remove listeners cannot intercept native ProseMirror editor controls.
- Made native AppV2 rich text use the stored document value whenever a legacy display shell is empty, preserving populated Vehicle and Spaceship descriptions.
- Passed Foundry V14's supported `disabled` editor option and retained palette-aware color inheritance on the `prose-mirror` element itself.
- Doubled the readable measure of Spaceship Damage Control numeric and threshold fields without changing their stored paths or rules.

## Verification boundary

- The accepted 4.5.0 sheets remain the defaults and their protected templates, styles, fonts, icons, and resources are unchanged.
- Beta.6 replaces beta.5 in the single temporary candidate slot only after both beta.6 archives pass fresh-extraction validation.
- No world migration, Actor rewrite, Item rewrite, gameplay routing change, or companion-module update is required.

# AGE System 5.0.0-beta.5 - AppV2 Legibility Correction

## Corrected

- Vertically centered Character and Item tab labels inside their shared navigation buttons.
- Restored palette-aware rich-text color inheritance so Vehicle and Spaceship descriptions remain visible on their light description panels.
- Preserved the existing Actor description data, native AppV2 editor bridge, and all legacy-sheet presentation.

## Verification boundary

- The accepted 4.5.0 sheets remain the defaults and their protected templates, styles, fonts, icons, and resources are unchanged.
- Beta.5 replaces beta.4 in the single temporary candidate slot; no world migration or Actor data rewrite is required.
- The correction is isolated to the AppV2 design stylesheet, sheet labels, and its presentation contract test. Gameplay handlers and automation routing are unchanged.

# AGE System 5.0.0-beta.4 - AppV2 Presentation Polish

## Refined

- Tightened Character and Item banner, tab, and title spacing without changing the accepted controls or color themes.
- Kept Organization abilities, derived ratings, and description at a readable measure when its window is widened.
- Added local scrolling and adaptive wrapping to Vehicle and Spaceship sheets so their complete authoring surfaces remain usable at narrow and wide sizes.
- Reduced oversized Vehicle and Spaceship section headings and corrected the Vehicle passenger-capacity alignment.
- Restored theme-aware text contrast and resilient wrapping in native AppV2 rich-text surfaces.

## Verification boundary

- The accepted 4.5.0 sheets remain the defaults and their protected templates, styles, fonts, icons, and resources are unchanged.
- Beta.4 replaces beta.3 in the single temporary candidate slot; no world migration is required.
- The polish is isolated to the AppV2 design stylesheet and sheet labels. Gameplay handlers, sheet markup, and automation routing are unchanged.

# AGE System 5.0.0-beta.3 - AppV2 Shell and Editor Repair

## Corrected

- Restored top-aligned, full-height content for all five Actor and eleven Item AppV2 parity sheets under Foundry 14's shared flex layout.
- Replaced inert AppV1 `{{editor}}` controls in AppV2 sheets with Foundry 14's native form-associated ProseMirror element while preserving raw data, enriched links, ownership, and document context.
- Scoped rich-text enrichment to the sheet being rendered so opening one document cannot rewrite editor content in another open window.
- Restored editable rich-text fields on the Character Stat Block instead of hiding their edit controls.

## Verification boundary

- The accepted 4.5.0 sheets remain the defaults and are unchanged.
- Beta.3 replaces beta.2 in the single temporary candidate slot; no world migration is required.
- The stopped-world beta.2 chat audit found nine structurally valid test messages covering Powers, abilities, attacks, and matching damage rolls.

# AGE System 5.0.0-beta.2 - Full Sheet Parity

## Beta scope

- Replaced the incomplete beta.1 previews with selectable, type-specific AppV2 parity sheets for all five Actor layouts and all eleven Item types.
- Preserved every accepted 4.5 field, tab, editor, authoring control, roll action, context action, and embedded-document control in AppV2-safe single-root templates.
- Retained the Foundry-verified 4.5.0 sheets as defaults; every beta.2 sheet remains explicitly opt-in.
- Added versioned, validated AGE Action and structured-chat data contracts at the automation boundary.
- Added structured metadata to new AGE chat messages without invalidating old messages or replacing their proven gameplay controls.
- Retained a scoped AGE 5 design-token layer while restoring the complete established AGE sheet presentation.

## AppV2 parity surface

- Actor sheets: Character Full, Character Stat Block, Vehicle, Spaceship, and Organization.
- Item sheets: Class, Equipment, Focus, Honorific, Membership, Power, Relationship, Ship Feature, Stunt, Talent, and Weapon.
- Uses native `ActorSheetV2` / `ItemSheetV2` document forms, native AppV2 tabs, and native Actor drag/drop while bridging the accepted AGE gameplay handlers.
- Preserves generic `renderActorSheet` and `renderItemSheet` compatibility hooks for Ammo Belt and other transition-period companions.
- Explicit beta.1 Item-sheet selections migrate once to their matching beta.2 per-type sheet; legacy/default selections and compendium content are untouched.

## Migration safety

- Beta.2 does not enforce strict Actor or Item TypeDataModels. The accepted content audit identified permissive legacy numeric values which require a previewable migration before schema enforcement is safe.
- Selecting any beta sheet remains reversible through Foundry's Sheet Configuration. Actor and Item data, compendia, and chat messages are not rewritten.

# AGE System 4.5.0 - Gameplay Automation

## Stable promotion

- Promoted the Foundry-verified 4.5.0-rc.1 implementation without gameplay-code changes.
- Retained the verified AGE Actions 1.1.0 contract, recovery, condition lifecycle, combat economy, requested rolls, executable Stunts, and Argon AGE 1.0.4 integration.
- Revalidated the release under Foundry 14.365 with the Manual / Local update channel.

## Added

- Added explicit Active Effect timings for start/end of turn, end of round, end of encounter, next attack, and next test.
- Added owner-aware GM Requested Roll cards with Ability, optional Focus, optional TN, and selected recipients.
- Added a profile-aware Recovery Assistant for one-per-encounter breathers and six-hour sleep, including Gritty and Cinematic confirmations.
- Added advisory major/minor/free action-economy tracking. It warns but never blocks a roll or maneuver.
- Added Dying-condition confirmation and round reminders. The system never kills a character automatically.
- Added conservative executable Stunts: Mighty Blow, Vicious Blow, Lethal Blow, Knock Prone, Stay Aware, Duck and Weave, and Defensive Stance. Other Stunts remain manual.

## Corrected

- Aim now applies only to an attack and is consumed only after that attack completes successfully.
- Defend and All-Out Attack expire at the next turn; Guard Up expires at the end of the round. Explicitly timed Active Effects use the same lifecycle service.
- Argon companion 1.0.4 tolerates the brief no-Actor state during HUD teardown or token changes instead of raising a Portrait Panel promise error.

## Safety

- Recovery, Stunt effects, and timed expiration retain explicit user decisions and transaction history where applicable.
- Modern AGE stun/wound ambiguity and NPC dying rules are never inferred from Health alone.
- Existing Actor/Item sheets, styles, and protected visual assets remain unchanged.

# AGE System 4.4.0-rc.3 - All-Miss Damage Feedback Repair

## Fixed

- Weapon attacks which miss every locked target now stop before creating an unusable damage card.
- Existing all-miss damage cards report that the attack has no successful recipients instead of claiming that their locked targets disappeared.
- Successful and mixed-hit attacks retain hit-only damage routing; genuinely deleted or unavailable locked targets retain their separate warning.

## Diagnosis

- The RC2 Foundry report contained successful Longbow and Dagger damage rolls, but their originating attacks rolled 10 and 9 against Defense 14 for both targets. The damage engine was working; the chat workflow failed to distinguish an all-miss result from missing target Documents.
- This correction replaces RC2 in the single candidate slot. Accepted 4.3.0.2 and rollback 4.3.0.1 remain unchanged.

# AGE System 4.4.0-rc.2 - Gameplay Routing Repair

## Fixed

- Prevented AGE Actions from re-entering an Ammo Belt tracked-weapon queue. Longbows and other tracked weapons now complete one sheet or Argon attack and consume ammunition once.
- Healing-only Powers no longer create resistance damage groups from their activation test.
- Empty Power target-result arrays no longer become locked empty damage groups.
- Healing rolls inherit the Power action's original target snapshots, and healing application retains those recipients even if canvas selection later changes.
- Creating or changing an Advanced Test refreshes existing chat cards; progress added from chat refreshes the open tracker immediately.

## Clarified

- If every target fails a Power resistance test, **no targets require resisted damage** is correct: all recipients remain in the full-damage group.
- This correction replaces RC1 in the single candidate slot. Accepted 4.3.0.2 remains unchanged.

# AGE System 4.4.0-rc.1 - AGE Actions Candidate

## Added

- Added AGE Actions schema v1 with immutable, serializable envelopes and reusable templates.
- Registered 11 core action types for attacks, Powers, resistance, damage, healing, Power Points, Stunts, and Active Effects.
- Added secure player-to-GM action delegation with authenticated sender identity, ownership checks, deterministic GM election, replay suppression, rate limits, and timeouts.
- Added an AppV2 Operations & Diagnostics window for action status, bounded outcomes, reversible transactions, content audits, and JSON export.

## Integrated

- Existing sheet, macro, chat-card, and compatible HUD attack/Power rolls now enter the common action layer without replacing their established interface.
- Resistance, damage roll/application, healing, Power Point spending, and Stunt spend/undo workflows record structured action provenance.
- Duplicate requests sharing an action ID reuse one pending Promise.

## Release policy

- This is an unconfirmed candidate. Accepted 4.3.0.2 remains the retained recovery package until Foundry acceptance.
- The Manual / Local channel remains selected. Remote manifest and download URLs are intentionally omitted.
- Socket support is enabled only for the tested AGE Action delegation protocol.

## Validation

- Added action contract, API, permission, authenticated delegation, replay boundary, and no-active-GM tests alongside the complete 4.3 regression suite.
- Protected sheet templates, styles, LESS sources, and visual assets remain unchanged from the accepted visual baseline.

# AGE System 4.3.0.2 - Locked Damage Group Retest Repair

## Fixed

- Completed resistance groups now disable full or resisted damage when that group has no locked recipients.
- Empty locked groups are blocked before rolling a misleading damage card.
- Damage cards whose previously locked Documents no longer resolve report that specific condition instead of asking the user to select tokens.
- The content validator aggregates duplicate source IDs into one issue per scope instead of repeating the same warning for every matching document.
- Legacy non-numeric weapon range representations are reported as content warnings rather than structural errors.

## Clarified

- Locked damage routing intentionally ignores the current controlled/targeted tokens. Recipients come from the original Power activation and recorded resistance outcomes.
- When every target fails resistance, all targets belong to full damage and none belong to resisted damage.
- Console commands must be pasted without surrounding Markdown backtick fences.

# AGE System 4.3.0.1 - Foundry Retest Hotfix

## Fixed

- Corrected the `ageSystemApiReady` setup hook referencing an initialization-local variable, which produced one startup error while leaving the API itself available.
- Replaced the deprecated Foundry 14 `foundry.utils.objectsEqual` call with `foundry.utils.equals`, retaining the old helper only as a pre-v14 fallback.
- Damage cards containing locked recipients without attack-resolution fields now show clean recipient rows instead of `Defense undefined` and `margin undefined`.

## Retained warnings

- Actor/Item sheets and the established custom application windows still use Foundry's backwards-compatible V1 framework. Foundry 14 reports deprecation warnings when those interfaces open; their coordinated AppV2 migration remains planned and is not safe to mix into this focused hotfix.

# AGE System 4.3.0 - Integration Foundation

## Added

- Introduced the frozen, versioned `game.ageSystem.api` integration surface and the `ageSystemApiReady` hook.
- Added capability detection for transactions and content validation. The future AGE Actions capability is explicitly reported as unavailable until its contract is complete.
- Added a read-only content validator for world Actors, Items, owned Items, and optional Actor/Item compendia.
- Added API integration documentation with safe multi-target update and content-audit examples.

## Improved

- AGE transactions now support preflighted multi-document execution as one operation.
- Concurrent calls with the same operation ID share the in-flight Promise, preventing rapid duplicate mutations.
- Transaction history entries now record schema version 2 and the originating system version.
- A failure after one or more document updates restores only the documents already changed.
- Undo now removes fields created by an action when those fields did not previously exist.
- Update preflight rejects deletion syntax, empty updates, invalid Documents, oversized operation IDs, and prototype-related paths.

## Compatibility

- All 4.2.9.1 gameplay workflows, legacy namespace properties, sheets, templates, styles, and assets are retained.
- No new world migration runs solely for 4.3.0.
- Socket support remains disabled until a permission-tested GM delegation protocol is implemented.
- External manifest/download URLs remain omitted until a verified release channel is available.

## Validation

- Added focused transaction, API contract, content validation, release structure, JSON, syntax, and import-resolution checks.
- Retained the 4.2.9.1 current and legacy Power resistance routing regression checks.

# AGE System 4.2.9.1 - Power Resistance Routing Repair

### Fixed
- Power resistance results now use an array-backed schema, preserving literal token and Actor UUIDs instead of allowing Foundry's dotted-path expansion to nest them.
- Full and resisted Power damage cards now retain their correct locked recipient groups through damage rolling and application.
- Existing 4.2.9 resistance chat cards remain readable, including cards whose result UUIDs were already expanded into nested objects.

### Validation
- Added focused current-schema and legacy-schema resistance split coverage, plus a persistence test proving dotted token UUIDs survive a resistance roll as literal values.

# AGE System 4.2.9 — Gameplay Assistance Checkpoint

### Added
- Stunt Assistant with owned/compendium search, roll-category recommendations, fixed and variable costs, remaining-SP validation, overspend prevention, spend history, and reversal.
- One-roll multi-target attacks. Every selected target is checked against its own Defense, hit/miss margins are added around the existing chat card, and Apply Damage receives only successful targets.
- Power resistance controls for each locked target, including GM/author permission guards, retry history, roll-all support, and separate full/resisted damage target groups.
- Reminder-first combat lifecycle handling for Aim, Defend, Guard Up, All-Out Attack, and Active Effects carrying `flags.age-system.automation.expires = "startOfTurn"`. An optional automatic mode uses reversible transactions.
- GM-managed Advanced Test trackers for Advanced, Opposed, Breaching, Chase, Investigation, Social, Exploration, and custom workflows. Successful roll cards can contribute their Stunt Die, and each tracker keeps bounded undo history.
- Argon Combat HUD AGE companion 1.0.3 integration for preserving several preselected canvas targets while retaining the normal single-target picker and older-system fallback.

### Safeguards
- All new gameplay features are independently switchable and remain gated by AGE Automation: Assist.
- Power Point final-cost validation, single-deduction locking, and chat-failure rollback from 4.2.8.1 remain authoritative for sheet, macro, and HUD Power calls.
- No sheet template, stylesheet, LESS source, font, logo, icon, or existing UI resource was changed; all 115 protected files remain byte-identical.
- Multi-target and resistance recipients are stored on chat messages so later canvas selection changes cannot silently redirect damage.

### Validation
- Foundry 14.365 import/lifecycle smoke, real one-roll/two-Defense resolution, damage-recipient routing, resistance split, Stunt Point overspend/undo, Advanced Test progress/undo, and combat reminder/automatic expiry coverage.
- Argon 1.0.3 static, lifecycle, behavioral, and release audits, including fallback behavior without the AGE 4.2.9 API.

# AGE System 4.2.8.1 — Copied-World Acceptance Repair

### Fixed
- Applying a Dragon AGE, Fantasy AGE, or Modern AGE rule profile now enables automatic Power Point consumption instead of silently disabling it.
- Sheet, macro, and Argon-style Power calls now derive the owned Power's live final cost when an external caller omits the sheet-generated cost object, with exactly one deduction.
- The compact Character sheet no longer inherits the Full sheet's Tabs controller, preventing Foundry v14's `Tabs.activateListeners` null-dataset error during Actor creation and embedded Item preparation.
- AGE Rule Profiles and Unified AGE Library now use compact, responsive layouts. Only their table/results region scrolls, thumbnails remain small, leading parser punctuation is cleaned for display, and exact compendium source IDs distinguish duplicate-looking entries.

### Validation
- All 115 protected v4.2.7 visual files remain byte-identical.
- Added direct HUD-style Power consumption, profile consumption, compact-sheet tab, punctuation-cleanup, and automation-window structure tests.
- Rendered both automation windows at normal and narrow widths; the application body remains fixed while only the intended table/results region scrolls.

# AGE System 4.2.8 — Safe Automation Checkpoint

### Added
- Transactional AGE rule profiles for Dragon AGE, Fantasy AGE 1e, Fantasy AGE 2e, Modern AGE Core, and Modern AGE Mastery/Injury.
- Per-user reversible action history for Health, Injury, healing, Breather, and Power Point changes, with conflict-safe undo from the AGE toolbox.
- Profile-aware unified search across enabled Actor, Item, Journal, and Roll Table compendia.
- Importer v2 validation preview, explicit batch separators, exact Item matching, compendium reuse, and duplicate Talent prevention.
- Final-cost Power Point validation using the Actor's live resource value, duplicate-action locking, and failure rollback.
- A build gate that verifies all 115 protected stylesheets, LESS sources, sheet templates, fonts, logos, icons, and existing UI resources remain byte-identical to v4.2.7.

### Compatibility
- Foundry VTT minimum and verified version remain 14.365.
- Full and Block Character sheets remain on their accepted v4.2.7 implementation.
- Existing colour schemes, sheet dimensions/positions, Argon entry points, Ammo Belt compatibility, Item Piles integration, and native Item roll methods are unchanged.
- New automation defaults to Assist or explicit user action; no automatic rule profile is applied to an existing world.

### Validation
- 2,500+ static, syntax, JSON, template, localization, import-graph, compatibility, and protected-resource checks.
- Mocked init/setup/ready lifecycle plus transaction, undo, profile apply/revert, compendium search, Importer v2 preview/commit/deduplication, and Power Point rollback tests.

# AGE System 4.2.7

### Added
- Native optional Item Piles integration for Character Actors, Equipment, Weapons, Item quantities, and AGE wealth modes.
- Safe GP/SP/CP price parsing for existing Item text, localized denomination aliases, and Dragon Age crafting/retail price pairs.

### Fixed
- Single-currency Character sheets now edit `system.currency`, matching the Actor schema and Item Piles integration, instead of reusing test-based `system.resources.base`.
- Existing single-currency values migrate forward without deleting the prior Resources field.
- New physical Items initialize `system.cost` as text, matching the Item sheet and existing compendia.

### Compatibility
- GP/SP/CP merchants use the same `system.gp`, `system.sp`, and `system.cp` balances shown on Character sheets.
- Single-currency merchants use `system.currency`.
- Resources and Income worlds retain Item Piles loot/transfer support without treating a Purchase TN as spendable money.

# AGE System 4.2.6

### Fixed
- Damage, healing, Breather, vehicle/spaceship damage, settings, and ChatMessage workflows now return or await their asynchronous Foundry operations before reporting success or closing dialogs.
- Apply Damage handles Actor and Token UUIDs safely, prevents duplicate submissions, preserves errors for retry, and posts summaries only after document updates complete.
- Compact Character sheet data now awaits its parent context; malformed compact, chat-card, Character, and Spaceship markup has been repaired.
- World migration is marked complete only after every document, compendium, setting, scene, and chat update succeeds. Failed runs remain retryable and compendium lock state is always restored.
- Obsolete Item modifier keys no longer abort Actor preparation or migration. Disabled and invalid Focus modifiers are no longer applied.
- Built-in and saved Active Effects targeting unused maneuver fields migrate to the fields used by runtime calculations.
- Light Injury results are reachable again, world Actors can receive injuries without Token image errors, and severe-Injury mark removal no longer uses an assignment in its condition.
- The AGE Tracker is now an independently positioned overlay with working drag/reset persistence and corrupt-value guards, so it no longer pushes the hotbar sideways.
- Generated Item macros safely quote Item names and replace hotbar assignments without removing Macro documents or assuming an occupied slot.
- Full, compact, vehicle, and spaceship sheets no longer write unchanged textarea values on every render; stale passengers and operators are handled safely.
- AGE NPC and Talent imports await document creation, validate malformed or partial input, support localized headings, and report failures without unhandled rejections.
- Normal rolls inherit Foundry's core public/self/GM/blind visibility, while explicit Shift shortcuts remain blind GM rolls.
- Vehicle defaults and migrated Actors use the valid `velStandard` velocity key.
- English, French, Spanish, and Brazilian Portuguese now have complete key parity for the shipped interface.

### Validation
- Expanded static validation to 2,000+ checks across JavaScript, JSON, imports, assets, templates, localization, v14 API guards, migration gates, and release metadata.
- Mocked Foundry lifecycle coverage includes init/setup/ready, all Actor and Item types, dialogs, damage and Breather operations, migration helpers, sheets, and transactional Class advancement.
- Rebuilt LESS and verified the final installable archive structure and integrity.

# AGE System 4.2.5

- Fixed Breather rolls on Foundry v14 by replacing synchronous dice evaluation with awaited asynchronous evaluation.
- Awaited Breather dice evaluation and chat creation before applying recovery.
- Added safe event normalization for sheet, macro, and Argon-triggered ability, item, resource, vehicle-damage, and item-damage rolls.
- Programmatic rolls no longer crash when no browser MouseEvent is supplied.

# AGE System 4.2.4

### Fixed
- Fixed Apply Damage failing on Foundry v14 when the selected Actor snapshot did not contain a prepared `system.armor` object.
- Damage targets now snapshot `actor.system` directly and safely reconstruct legacy Health, Armor, Toughness, Injury, and test-modifier values when fields are absent.
- Damage and healing updates are awaited before the Apply Damage window closes or posts its summary.
- Dragon AGE, Fantasy AGE, and other single-Armor presets now normalize old `impact` values to **Normal Damage** while retaining Penetrating Damage.
- Existing Weapon and Power items with the legacy `impact` default display and roll as Normal Damage without destructive world migration.
- Old damage chat cards without complete health-system metadata now open safely under the current world's health preset.
- Migrated chat, Character, Organization, and Class-advancement context menus to Foundry v14 `label`, `visible`, and `onClick` entries with native HTML targets.

### Validation
- Added legacy Actor damage tests with missing persisted armor data.
- Added Normal versus Penetrating Damage tests for Dragon AGE-style single-Armor rules.
- Added release checks for awaited damage updates and the Foundry v14 context-menu contract.
- Retained the complete dialog, Class advancement, sheet preparation, migration, and archive-integrity regression gates.

# AGE System 4.2.3

### Fixed
- Rebuilt the Breather settings prompt on Foundry v14 `DialogV2`, fixing the `mergeObject` / “One of original or other are not Objects” crash.
- Made Injury-mark healing await its Actor update so Breather completes only after the recovery is stored.
- Migrated AGE roll options and damage options from the deprecated AppV1 `Dialog` constructor.
- Migrated the insufficient Power Point prompt, Class rollback confirmation, and Class advancement-deletion confirmation to `DialogV2`.
- Migrated Roll20 JSON import and custom Active Effect JSON import prompts to `DialogV2`.
- Corrected the insufficient Power Point prompt so it always uses the rolled Item name instead of an invalid module-level `this.name` reference.

### Validation
- Added direct tests for DialogV2 form submission, cancellation, confirmation, file import, and missing-file handling.
- Added full Breather workflow tests for both standard Health and Injury/Vitality modes.
- Added AGE roll-options and damage-options workflow tests.
- Added construction and data-preparation checks for the remaining custom AppV1 application windows.
- Added a release gate which rejects any reintroduced `foundry.appv1.api.Dialog`, `new Dialog`, or `Dialog.confirm` runtime calls.

# AGE System 4.2.2

- Enforced compact/stat-block dimensions after Foundry's post-render content refit.
- Added a second layout-frame guard against viewport-wide expansion.
- Restored native minimize/maximize behavior and prevented minimized dimensions from replacing saved sheet dimensions.
- Capped compact-sheet width and forced long stat-block content to wrap.

# AGE System 4.2.1

- Fixed the compact/stat-block Character sheet opening at inherited or viewport-wide dimensions.
- Added per-user, per-Actor position and size persistence for both full and compact Character sheets.
- Added safeguards which discard oversized compact-sheet dimensions left by the previous build.
- Repaired live colour-scheme switching and made the client setting authoritative over stale user flags.
- Applied colour schemes to the compact stat block instead of its previous hard-coded black/white palette.

# Change Log
## 4.1.0 [2026-08-02]
### Added
- Foundry VTT v14 compatibility layer, targeting the v14.365 Stable release.
- Automated static audit and mocked Foundry lifecycle smoke test.
- World migration for v14 Active Effect changes, status-effect configuration, and legacy chat roll arrays.

### Changed
- Migrated removed or renamed globals to the v14 namespaces for documents, sheets, applications, templates, utilities, file handling, and UUID lookup.
- Updated scene controls to the v14 keyed record format and chat rendering to the native `renderChatMessageHTML` hook.
- Updated chat visibility from legacy roll modes to v14 message modes (`public`, `self`, `gm`, and `blind`).
- Updated Active Effect changes from numeric `mode` to string `type`, explicit `phase`, and priority.
- Updated token status effects to the v14 keyed record format using `name` and `img`.
- Replaced the removed Handlebars `select` helper.
- Actor and Item preparation now call the Foundry base lifecycle methods.

### Class item status
- The incomplete class advancement subsystem is intentionally not enabled.
- Existing class data is preserved and can be viewed read-only.
- New class creation, actor attachment, level changes, and advancement editing are blocked.
- The unfinished advancement runtime is not loaded.

### Fixed
- Private and blind rolls no longer fall back to public messages.
- Active Effect condition editing now creates valid v14 changes and recalculates priorities.
- Several migration defects, including empty chat updates, synthetic token guards, talent requirement handling, and compendium document identification.
- Invalid multi-value JavaScript switch cases in roll-card flavor handling.
- Incorrect armor-penalty Active Effect path.
- Broken item-sheet markup and missing optional-document guards.
- Damage application subtracting the wrong signed value and increasing Health.
- Missing vehicle-operator warnings referencing an undefined passenger variable.
- Creation of status effects which do not define AGE-specific flags.
- Removal of multiple invalid passengers skipping entries because of index shifting.
- Chat-card visibility reading the removed v13 render-context message shape.

## 4.0.3 [2025-07-31]
### Fixed
- AGE Importer: cases when texts with negative abilities failed to generate Actors.
- AGE Importer: added support to capture text for attacks with special damage instead of silent failing Actor generation.
- Fixed bug preventing correct parsing on item controls on character block sheet.
- Character block sheet input fields now have proper background color.
- Toughness Test chat card now showing correct data.

## 4.0.2 [2025-07-26]
### Changed
- Buttons on chat cards restyled to ensure main focus on chat cards is summary and not the button section.

### Fixed
- Fixed a bug preventing Fatigue Text button to pop-up on selected Power rolls.
- Incorrect or no chat cards poping up on Apply Damage interface and chat cards.
- Injure damage system now has correct style and buttons on damage chat cards.
- Removed placeholder text from roll cards template.

## 4.0.1 [2025-07-26]
### Fixed
- Small changes on manifest file.
- Bug preventing zoom control using mouse wheel in certain areas when AGE Tracker is active. Thanks [BoltsJ](https://github.com/BoltsJ)!

## 4.0.0 [2025-07-25]
### Added
- Compatibility to Foundry VTT v13.
- Our friend [p-arth](https://github.com/p-arth) expanded AGE Importer, so now it can import NPC sheets from Fantasy AGE 2ed AND talents from most of AGE System published books. Thanks again, [p-arth](https://github.com/p-arth)!

### Changed
- AGE Roller is now a Canvas Control buttom.
- New position for AGE Tracker for Churn/Complication and Serendepity/Daring.

### Fixed
- Bug causing Plot Damage (Organizations) and Vehicle collision to return error.

## 3.0.3 [2024-08-11]
### Added
- Active Effects can now be dragged to another character sheet to copy, just like regular Items.

### Fixed
- Updated manifest to match v12 grid definition.
- Removed invalid Ability option when editing Focus sheet.
- Bug preventing the correct Item Sheet to be rendered when opening Focus, Weapon or Power owned by an Actor.
- Updated Dice so Nice integration to match v5.
- Actor and Item `prepareData()` updated according to lateste FVTT v12 definitions.

## 3.0.2 [2024-07-03]
### Fixed
- Typo on manifest preventing system update.

## 3.0.1 [2024-07-03]
### Added
- Function updated to restart Foundry when certain System Settings are changed.

### Fixed
- Roll Total is now displaying the expected value instead of omitting total figures.
- Advanced AGE Settings will now remember the value used on drop-down menus.
- Error when trying to attack targeted token.

## 3.0.0 [2024-06-16]
### Added
- Compatibility to FoundryVTT 12. Not compatible to previous versions. Few deprecated messagens are still poping-up, but they will be removed over the new versions.

### Fixed
- Talent degree not showing consistently on stat block view.
- Added relative path on advancement.js to fix issues related to hosted servers.

## 2.0.5 [2024-03-26]
### Fixed
- Bug preventing Modifiers to be added to characters.

## 2.0.4 [2024-03-24]
### Added
- New macro to enable users to roll `ageRoll` method. This function can be accessed using `game.ageSystem.roll`.

### Changed
- Resizing handler on sheet's right-hand bottom corner is now invisible until hovering sheet corner with mouse.
- Removed lines of code and files related to the old Character Sheet.
- When using the Apply Damage feature to apply Penetrating damage, the option "Ignore Armor" will be selected.

### Fixed
- Weapon features "Ranged" and "Reloadable" on Options tab now have localization strings.
- Case causing character sheet to break after using Token Effects / Conditions.
- Removed Font override preventing users and modules to change Font.

## 2.0.3 [2023-09-07]
### Added
- Merged [Pull Request #118](https://github.com/vkdolea/age-system/pull/118) made by [Peter](https://github.com/architech99) to add Peril flavor (FAGE 2) to Complication rolls and adding extra option to select a user created Roll Table instead of the standard 1D6 roll to check for outcome.
- Another contribution from [Peter](https://github.com/architech99), [Pull Request #120](https://github.com/vkdolea/age-system/pull/120), adding flexibility to change maximum Health and Mana on character block sheet.

### Fixed
- Added workaround to ensure correct Item Sheet is opened when opening Owned Items.
- "Current" label for actual values of Health and Power Points is not hardcoded anymore.
- Portuguese localization fixes.
- Better color contrast on dropboxes on Item Sheets.

## 2.0.2 [2023-08-27]
### Added
- When rolling a Power with power points cost using expanded options, user will be able to change power cost before rolling it.
- Block sheet now has a field to display Power Points (max value is locked for edition).
- Migration of custom token effectss to comply to new FVTT v11 API.

### Fixed
- Added a 36px offset on AGE Roller icon to avoid overlapping new macro bar buttons.
- Bug causing Spaceship Actor image on sheet to overflow and make it impossible to interact with some sheet elements.
- Correct labels related to Power Points are now applyed on Item chat cards.
- Fixed bug preventing context menu from rendering correctly.
- Healing Actors from chat card will now correctly follow the System Setting "Use Targeted function to apply damage and healing".
- Power Points will consumed only after confirming roll using when using context menu.
- SVGs used on system edited to ensure Firefox compatibility. Thanks [Peter](https://github.com/architech99) for fixing this one!
- Scrolling text when healing, damaging or spending power points on tokens are now following the expected color codes (red for damage, green for healing and blue for power points).

## 2.0.1 [2023-06-18]
### Fixed
- Talent degree shows up correctly on character sheet Talent tab.
- Removed typos on Document types' localization.

## 2.0.0 [2023-06-04]
### Added
- FoundryVTT v10 and v11 compatible.
- System Setting added to select Flavor for Powers and Power Points.
- Added option to select Talent degrees as normal or expanded (as seem on Modern AGE Companion). Inclusion by [Txus](https://github.com/Txus5012). Thanks!

## 1.2.4 [2023-04-07]
### Fixed
- Header text on character/item sheet is now back with center alignment.
- Bug preventing changing Primary Ability and Weapon Group on Class sheet.

## 1.2.3 [2023-04-04]
### Fixed
- Sheets behave correctly when changing font size from Core Settings.
- When opening Damage Dialog with right-clicking damage button while pressing CTRL or CTRL + ALT will now populate "Extra Damage" field accordingly.
- "Coins" box on character sheet now have consistent style compared to other boxes on character sheet.

## 1.2.2 [2023-04-03]
### Changed
- Better contrast control for input fields.

## 1.2.1 [2023-04-03]
### Changed
- TinyMCE editor removed in benefit of ProseMirror on Actors and Item sheets.

### Fixed
- Issue preventing adding or removing weapon groups from Weapons.

## 1.2.0 [2023-04-02]
### Added
- New "Class" Item type to track character leveling. Currently, only creating the Item is possible. In the next release it will be possible to pass to a Character and use it to level up.

### Changed
- Text boxes from Character and Item sheets follow the same style and respond to window resizing.
- Changed icon of AGE Roller (the icon close to Macro Bar).

### Fixed
- Tests and damage rolled by an unlinked token will correctly display token name on chat card and not the name on character sheet.

## 1.1.12 [2023-01-27]
### Fixed
- Defense calculation corrected.

## 1.1.11 [2023-01-26]
### Fixed
- Corrected order to apply Active Effects.

## 1.1.10 [2023-01-22]
### Fixed
- Active Effects applied to final calculations (final Defense, final Test mods, etc) were not working correctly.

## 1.1.9 [2023-01-20]
### Fixed
- Some chat cards created in old versions rendering incorrectly.
- Problem selecting Game Mode when using Quick Settings.
- Token sheet will update color settings without needing to closing it and openning again.
- Data calculated based on Abilities has now the correct values when implementing Conditons or Active Effects.
- Healing a character will now heal up to maximum Health/Fortune plus mods.
- Shift + Left Click will now correctly trigger blind roll to GM.
- Fixed calculation when using qualities/flaws on Spaceship which modify Hull and Sensors.
- Fixed bug causing The Expanse quick setting to set properly Churn functionality.

## 1.1.8 [2022-10-06]
### Fixed
- Description now appears correctly on Organization sheet when not on text editor mode.
- Focus Item correctly checked on when drag and droped on Character and Organization sheets.

## 1.1.7 [2022-10-05]
### Changed
- Spaceship and Vehicle sheets are now resizable.

### Fixed
- Bug preventing a plot action damage when using Organization ability.
- Bug preventing damage formula on Spaceship Weapon.

## 1.1.6 [2022-09-25]
### Fixed
- Bug on damage chat cards showing wrong information about secret roll to GM.
- Standardized flag content for check and damage rolls.

## 1.1.5 [2022-09-25]
### Added
- AGE Importer support for Dragon AGE and Fantasy AGE.

### Fixed
- Attack chat cards from unlinked tokens were not show the button to roll damage from Weapons.

## 1.1.4 [2022-09-22]
### Changed
- Refactored chat card roll template.
- Added borders to Actor and Item icons.
- Changing color setting will refresh opened sheets instead of closing them.

### Fixed
- Removed an error on world start-up/refresh when attempting to load unexistant file.
- Added warning message when opening System Settings to indicate if Item compendia were created/delete since last refresh.
- Fixed a problem causing Items to reset to standard icon image.

## 1.1.3 [2022-09-11]
### Changed
- Added style to Journal entries.

### Fixed
- Fixed a problem when drag and dropping Item/Actor to character sheet and compendium the icon was reset to the standard.

## 1.1.2 [2022-09-10]
### Added
- AGE Importer now supports Major and Minor NPC stat blocks for Modern AGE.
- AGE Importar has now capacity to import **The Expanse** stat blocks.

### Fixed
- Items and Actors created with AGE Importer will have icons according to item types.

## 1.1.1 [2022-09-09]
### Fixed
- Fine tuning of AGE Importer to identify fields independent of letter case.

## 1.1.0 [2022-09-07]
### Added
- Conditons Workshop now has the ability to Export and Import you custom effects to a json file. This gives the ability to save effects from one world and migrate to a brand new world.

## 1.0.4 [2022-09-05]
- Fixed issue preventing Modifiers to be deleted from Items owned by Unlinked Actors.

## 1.0.3 [2022-09-04]
### Fixed
- Deprecation warning when using Dice so Nice module.
- Proportion of Item image on character sheet and chat cards.
- Passengers list is update correctly for Spacheship and Vehicles.
- Rolling maneuvers from Vehicles now return the expected data from Condutor.
- Removed extra "-" from dropdown menu to select Ability on Focus item sheet.

## 1.0.2 [2022-09-03]
### Fixed
- Focus Modifiers are now calculated correctly.

## 1.0.1 [2022-09-03]
### Fixed
- Bug preventing creating new modifiers on Items.

## 1.0.0 [2022-08-31]
### Added
- Experimental "AGE Importer", accessable by AGE Roller menu. Currently works only for Modern AGE stat blocks in English. A new Actor is created using the text pasted, including detected items. Fine tuning expected in the next versions.
- Support to core function to create macros to display item sheet if the particular Item doesn't have a roll feature.

### Changed
- Power item have now an option to indicate if it is "rollable" or not to cover for NPC characteristics without a dice requirement ("Special Features" or "Special Qualities" depending on the AGE setting used).
- New item chat cards for all items.
- Spaceship Features item sheet redesigned.
- System updated to run on Foundry VTT v10.
- *Removed compatibility to FoundryVTT 0.8.x and FoundryVTT v9.*
- *Removed support to Legacy character sheet.*

### Fixed
- Power description on Stat Block sheet now will show buttons for inline rolls and content links.
- Using a power with 0 base damage when using *Modern AGE (alternate damage: Injury)* won't output wrong calculation.
- *Quick AGE Settings* window restyled to fully show buttons; localized name on title; clicking *Save Settings* without selecting an option will close the window and won't return an error.
- Modifiers Test (All), Attack (All) and Damage (all) now have consistent evaluation when an Active Effect is also adding to these numbers.

## 0.12.5 [2022-06-11]
### Fixed
- Added a cleaner background on character/item sheets.
- Reduced border radius on boxes inside character sheet.
- Updated Dice so Nice compatibility.

## 0.12.4 [2022-04-16]
### Fixed
- Hull and Damage rolls from Spaceships now work as expected.
- Removed an extra "+" when rolling Vehicle damage with RAM.
- Error thrown when trying to roll Vehicle maneuver without a driver or Token selected.

## 0.12.3 [2022-03-29]
### Changed
- Buttons restyled to follow Foundry standard.

### Fixed
- Ability test mods now apply to Ability tests as expected.
- Error preventing to add Focus on character/organization sheet if another item type has the same name.

## 0.12.2 [2022-02-12]
### Added
- New mods added: Force Power (all), Force Power (Focus) and one for each Ability (test only).

### Changed
- A few mods now have a new name, so its behaviour is more clear tho users.

### Fixed
- Saving changes on Quick AGE Settings or Adavance AGE Settings window will no close them accordingly or reset the world, depending on settings changed.
- Stunt Points setting and check boxes now show up properly.
- Fixed localizations missing strings.
- Max Power Points bonuses were not correct added on character stats.

## 0.12.1 [2022-02-12]
### Added
- Quick AGE Settings menu created to set all Advanced AGE Settings to fit a specific game system.
- Created an Advanced AGE Settings for advanced users to customize how the system works.
- Added optional setting to apply damaged/healing on Targeted tokens instead of Controlled tokens.

### Changed
- System license is now Apache 2.0 instead of MIT.

### Fixed
- Defense MODE and Toughness MODE values on sidebar can now be changed correctly.
- When damage or to hit bonus of weapon/power was equal to Zero, nothing appeared on block sheet. Now *+0* will appear instead.
- Clicking an Item name on Block Sheet will now open item sheet.
- Injury bar has consistent proportion when using stat block sheet.

## 0.12.0 [2022-02-05]
### Added
- Support to store Max Health, Defense and Toughness for different game modes (Gritty, Pulp, Cinematic) when using Modern AGE rules.

### Changed
- Only players with Owner of a given token will be able to see floating numbers when receiving damage/healing. Other users will see floating question marks.
- Focuses are aligned to left margin on character sheet Main tab.

### Fixed
- French and Spanish translation issue on Focus sheet.

## 0.11.10 [2022-01-25]
### Fixed
- Modifier with Focus bonus wasn't applying correctly on Actor owned focus.
- Focus bonus wasn't added to Powerforce/Spellpower value.

## 0.11.9 [2022-01-23]
### Added
- Updated Character template to add future support to multiple Health values for different game modes and a Modifier to add penality for test using an Ability, but without reducing Ability total.

### Fixed
- Modifiers not showing up correctly on Item sheet when using Injury mode.
- Weapon/Power damage not showing correctly on Item/Block sheet when using Injury mode.

## 0.11.8 [2022-01-20]
### Fixed
- Hotfix on item preparation routines, FVTT v9.

## 0.11.7 [2022-01-20]
### Fixed
- Compatibility issue solved on Item preparation with FoundryVTT version 0.8.x. which prevented items from displaying correct data/rolls.
- Compatibility issue solved on formula preview evalulation with FoundryVTT version 0.8.x.

## 0.11.6 [2022-01-19]
### Fixed
- Remove damage component from weapon/arcana from previous damage setup.

## 0.11.5 [2022-01-19]
### Fixed
- Talent on Legacy sheet now show correctly Degree and changes color when it is flaged as Specialization.
- Modifiers fixed: item activation, actor damage, item damage.

## 0.11.4 [2022-01-18]
### Fixed
- Ability box (main tab) size deteriotes the bigger the "Quick Access" box get.
- When hovering "Reference" field with PDFoundry installed, cursor will change for a pointer.
- Fixed styling issue on Spaceship Features sheet.

## 0.11.3 [2022-01-17]
### Fixed
- If PDFoundry wasn't installed, Item sheets wouldn't open.
- Focus and Talent data was loged on console whenever sheet was rendered.

## 0.11.2 [2022-01-16]
### Added
- Talent Degrees were "lost" during migration. Added a second migration to try to identify Talent Degree and set it automatically. Also, old Degrees will be added on new "Requirements" field of each Talent.

## 0.11.1 [2022-01-16]
### Fixed
- Bug preventing PDFoundry to open PDFs on "Reference" field from Item sheets.

## 0.11.0 [2022-01-16]
### Added
- All items have a "Reference" field on sidebar. Here it is expected to add a page number configures on PDFoundry. Clicking on field's title will open your PDF on corresponding page, as long as [PDFoundry](https://foundryvtt.com/packages/pdfoundry) modules is installed.
- Talents: added option to flag it as Specialization, added different text fields for different levels.
- Stunts: added option to mark cost as fixed or variable.
- Weapons: damage is now a free form formula, option to indicate if weapon is ranged or not, reloadable or not.
- Powers and Arcana: damage is now a free form formula.
- Right click Age Roller d666 and d66 to make private rolls.

### Changed
- User interface on new character sheet: editable fields are are now highlighted when hovering, colors and contrast.
- All item sheets have new layout.
- Items can now have multiple instances of the same Modifier.
- Damage fields now accept formulas.
- Some Modifiers accept formulas (if formula is invalid, error message will be displayed).
- Formulas accept the following [variables](https://github.com/vkdolea/age-system/wiki/Variables):
    - @acc (Accuracy ability value)
    - @comm (Communication ability value)
    - @cons (Constitution ability value)
    - @cunn (Cunning ability value)
    - @dex (Dexterity ability value)
    - @fight (Fighting ability value)
    - @int (Intelligence ability value)
    - @magic (Magic ability value)
    - @per (Perception ability value)
    - @str (Strength ability value)
    - @will (Willpower ability value)
    - @level (character level)

### Fixed
- Error message on console log on players' client when rendering chat rolls.

## 0.10.2 [2021-12-21]
### Changed
- Buttons to select character sheet tabs have different colors to tell from active / inactive.

### Fixed
- Targeting a token to attack using weapon is working again as expected.

## 0.10.2 [2021-12-21]
### Fixed
- Issue preventing world from loading data on start up.

## 0.10.1 [2021-12-20]
### Added
- Final fix to update for v9.

## 0.10.0 [2021-12-19]
### Added
- FoundryVTT v9 and 0.8.5+ compatible.
- Added floating numbers over token to reflect damage and healing.
- "Expanded Blue" colorset included.

### Fixed
- Correct armor text displays when rolling Toughness Test from chat card.

## 0.9.2 [2021-12-17]
### Fixed
- Removed test code from character sheet

## 0.9.1 [2021-12-17]
### Added
- "Favourite Equipment" renamed as "Quick Access". Items are now sorted by item type. A header will indicate which item type is listed.

### Changed
- Attack to Damage Trade Off: the value informed is added to Attack roll (if negative, it is subtracted). The oposite operation goes to damage total.
- When changing tabs from character sheet, the selected tab will have bigger font size.
- Added silver shadows around tabs' names, to improve contrast.
- Updated Spanish and French translation.

### Fixed
- Health/Fortune labels were not display correctly on character sheet.

## 0.9.0 [2021-12-12]
### Added
- New Character sheet, totally overhauled. Old sheet can be acessed by accessing "Sheet" -> "This Sheet" -> "Legacy".
- Added option on Age Roller to roll d66 and d666.

### Changed
- When Item Modifier is added to an Item, the Modifier will be actived by default.
- Opacity from button to turn Modifiers on/off is increased to improve its visibility.
- Breather can now accept formulas

## 0.8.18 [2021-11-28]
### Added
- Styling changes on Apply Damage window to highlight applicable damage or toughness test
- On Roll Settings, an Option to indicate if Stunt Points from Stunt Attack maneuver stacks with Stunt Points generated by Doubles.
- Option to GMs to enable automatic deduction of Power Points when rolling a Power - and a warning message when using a Power without the necessary points.

### Fixed
- A few rolls from chat to working as expected
- Texts not showing properly on Roll Settings menu
- Extra Stunt Points from Roll Settings are now only summed to total SP from roll if the roll actually generates SPs

## 0.8.17 [2021-11-26]
### Added
- You have a Breahter button on character sheet, close to Health/Fortune/Marks.
- Hover AGE Roller to find the "Breather" option, so you can click it to send a Breather command to all of your selected tokens.
- GMs can access System Settings to configure how effect is a Breather.

### Fixed
- Bug preventing damage output from chat cards.

## 0.8.16 [2021-11-20]
### Added
- Stunt Attacks! When opening the Roll Dialog, and Option will appear to set the roll as a Stunt Attack and add bonus to generated Stunt Points if the test is successful.
- Game setting to indicate the amount of Stunt Points generated by Stunt Attack.
- Added an extra field for Relationship item type, to be the "maximum" Intensity, so it will be easier to track expenditure.
- Added buttons to increase/decrease Intensity directly from character sheet.

### Fixed
- Bug preventing edition of Membership item types after adding it to Actors.

## 0.8.15 [2021-11-19]
### Fixed
- Rules to apply damage reviewed for the different Modern AGE game modes.
- Better compatiblity with Dice so Nice (stunt die now has pins or number depending on user choice).

## 0.8.14 [2021-11-14]
### Fixed
- Copying Effects from "The Expanse" resulted in no effect being copied.

## 0.8.13 [2021-11-14]
### Fixed
- Damage Inputs on Apply Damage window were note responding correctly to all buttons or manual inputs.

## 0.8.12 [2021-11-13]
### Changed
- When applying damage using context menu from roll chat card, the system will identify if damage type is valid before calling the Apply Damage application.

## 0.8.11 [2021-11-13]
### Added
- Added context menu options on chats when right-clicking roll cards. Options added to Heal character and to Apply Damage to all selected tokens. This implementation will not be available if you are using Modern AGE (alternate damage: Injury). Note: you can also "heal" Organizations using this method, but damaging it is still not possible.

## 0.8.10 [2021-11-10]
### Fixed
- Organization image will fit sheet space and it will keep proportion.
- Organization abilities now show up properly in character sheet.
- Combat Ratings now fit evenly in the sheet.

## 0.8.9 [2021-11-10]
### Added
- Organization as Actor
- Context menu (right-click) to access all Item types on both Character sheets (delete and edit options are only accessible that way)

### Fixed
- Some unauthorized items were able to be created on different Actor types (more than 1 focus with the same name, Spaceship Features could be created on Characters).
- Fine tuning French translation.
- Issue preventing from rolling Focus correctly when using context menu to add roll modifiers.

## 0.8.8 [2021-10-30]
### Added
- Conditions Workshop, to create custom Conditions and Token Effect. Only GMs can access. To access Conditions Workshop, hover Age Roller icon and select the option in the right-hand side menu.

### Fixed
- Flavor incorrect on chat card when rolling Focus from stat block sheet.
- Correct damage deduction when applying damage using Ballistic damage.
- When performing migration, invalid tokens were created on scenes on to top left corner.

## 0.8.7 [2021-10-13]
### Added
- Link to system's wiki when hovering AGE Roller icon.

### Fixed
- Bug preventing rolling Toughness Test by clicking on whipered chat card.
- Sending damage card to chat when using Injury damage system, dice sound effect won't be played.

## 0.8.6 [2021-10-05]
### Fixed
- Issue causing tokens created from player-owner characters to be created without health bar.
- Income/Resources roll working again
- Tests without declared Target Number will no longer return MISS for every roll.
- French localization correction.

## 0.8.5 [2021-10-04]
### Fixed
- Wrong text on Apply Damage window.
- If armor was higher then damage taken, tokens were "healed" instead of just not taking damage.

## 0.8.4 [2021-10-04]
### Fixed
- Button on Apply Damage dialog displaying wrong text.

## 0.8.3 [2021-10-03]
### Added
- After using chat button to apply damage to tokens, a chat message with summary of all damage dealt will be sent privatelly to game master, for a quick review.
- Included automation to apply damage when using Injury system. The following options are available: (1) force selected tokens to roll for Toughness and evaluate their chat outputs and them apply Injuries using buttons inside each chat card; (2) Let all tokens roll for Toughness and then automatically apply Injuries on target (a message will be sent privately to GMs with summary); (3) Allow players to roll the Toughness Test for their owned tokens - each player will receive a whispered message from GM with a button to roll for the Toughness Test with all necessary modifiers already set; with GM opted for the "Inflict Injury" option, the message with the roll will inform the Injury taken. If the option was no selected, the user will be prompted to select with Injury to take in a failed roll.

### Fixed
- When applying more damage then the current total of Health or Fortune, final value for token will be zero (and not a negative number as before).

## 0.8.2 [2021-09-29]
### Added
- Modern AGE Companion alternate damage Injury is now a selectable option. Basic Toughness roll implemented, no automation (yet). Check [Injury Bar wiki](https://github.com/vkdolea/age-system/wiki/Injury-bar) for details on how it works.

### Fixed
- When applying damage, armor division (due to Piercing) is now rounded down.
- Half damage from attacks with untrained weapon (from Weapon Groups) is now rounded down.
- Armor values not showing up properly on block sheet when ballistic armore is used.

## 0.8.1 [2021-09-28]
### Fixed
- Item sheets not opening when Weapon Groups setting is in use.

## 0.8.0 [2021-09-27]
### Added
- Damage chat card now have "Apply Damage" button to automate damage to all selected tokens.
- When "Health Tracking" is selected as Modern AGE (or its variants) and "Game Mode" is set to "Pulp" or "Cinematic", all damages will be have 2 added.
### Changed
- "Use Toughness" and "Use Impact and Ballistic Armor" deprecated in favor of "Health System" setting. This simplication was necessary to enable damage automation.
### Fixed
- Focus bonus disappears if 2 or more items had a Focus bonus.
- CSS styling issue preventing some icons from different modules from being displayed.
- Changed styling of damage chat cards.

## 0.7.16 [2021-08-29]
### Fixed
- Bug preventing Mod to Aim to be taken into accound when rolling.

## 0.7.15 [2021-08-28]
### Added
- New chat card for weapon damage (in preparation for damage automation).
### Fixed
- Yet another bug causing some damages to be only half the value expected when using Weapon Groups.

## 0.7.14 [2021-08-27]
### Fixed
- Bug causing Weapon Groups to apply to Focus, Ability rolls, etc.

## 0.7.13 [2021-08-26]
### Fixed
- Bug causing games without Weapon Group settings to always penalize damage and attack rolls.

## 0.7.12 [2021-08-26]
### Fixed
- Bug prevent some item sheets from opening.

## 0.7.11 [2021-08-25]
### Added
- Weapon Group support for Fantasy AGE, Blue Rose and Dragon AGE.
### Fixed
- Bug causing errors when deploying tokens.

## 0.7.10 [2021-07-17]
### Added
- Added context menu for items on block sheets.
- Added aid bar to stat block sheet.

## 0.7.9 [2021-06-30]
### Added
- Stat block sheet implemented.
### Fixed
- Item template correction (Talent *activate* field added).

## 0.7.8 [2021-06-25]
### Fixed
- French translation correction.
- Talent degree is now showing up again in front of Talent name.
- Bug preventing Condition selection from character sheet.

## 0.7.7 [2021-06-24]
### Added
- Picture on Honorifics and Membership item sheets.
- System Setting option to indicate the Initiative focus (world specific).
- Added arrows up and down in front of Weapon and Item name (Main Tab) as a quantity counter for these item types.
- Quantities will always show up inside brackets.
- After rolling a weapon check with Aim box checked, it will be unchecked automatically.
### Fixed
- Styling issue causing bold characters to be blurred.
- Styling issue causing item names on Persona Tab to be convoluted if it is 3+ lines long.

## 0.7.6 [2021-06-20]
### Added
- Rolling items to chat will honor chat option selection. Shift+Click will override this option and submit a self roll.
- Armor Strain as Item Modifier.
### Fixed
- Chat card buttons restyled, so they will have coherent look based on other buttons in the system. Chat cards rolled previously will lose their buttons' styling, but clicking the name will still roll the test.
- Bug preventing damage options dialog box from being pre-filled in with options from a chat button when using Right Click.

## 0.7.5 [2021-06-17]
### Changed
- Left click on attack/damage buttons will roll directly.
- Right click on attack/damage buttons will open roll options.
- Only player owners (and GMs) will be able to see buttons from chat cards to roll damage, healing and fatigue.
### Added
- Game setting added to allow Observers to roll Abilities, attacks and Damage from Observed character sheet or chat cards.
- When rolling to chat weapon and arcana cards, buttons will show up to roll attack and damage. Only players with permission to control the actor/token will see and be able to interact with the buttons.
- When rolling an Item to Chat using Shift + Right click, the roll will be a Self Roll (i.e., whispered to self).

### Fixed
- Non breaking error when loading a world without Item compendia.
- Shift + RightClick on AGE Roller will know correctly blind roll 1d6 to GM.
- Rolls from chat were not using data form unlinked token, only from Actor.
- Bug preventing Power Force to be taken into account when calculating total.
- Fixed a bug which was preventing data migration from happening on newer releases.
- Fixed a bug preventing Item mods from older version from showing up automatically on item sheets.

## 0.7.4 [2021-06-08]
### Fixed
- Chat message hardcoded when other players roll blind.

## 0.7.3 [2021-06-08]
### Fixed
- Bug causing Dice so Nice animation to be played twice.

## 0.7.2 [2021-06-07]
### Added
- By default, clicking on "Roll Damage" button on chat card will bring the damage options menu.

### Fixed
- Issued preventing Spaceship Features deletion.
- Text fields on characters' Persona tab was adding extra white spaces when selecting another field.
- Text fields on GM Secret Notes on Spaceship and Vehicle sheets were unreadable when certain color schemes were used.
- Targeted attacks on token are working again.
- Dice rolls shall be consistent with method selected on chat command (Public Roll, Private GM Roll, Blind GM Roll, Self Roll).
- Changing multiple System Settings at once no longer cause some not being updated.
- Corrected Spanish and Portuguese (Brazilian) localization.

## 0.7.1 [2021-06-01]
### Fixed 
- Updated French localization.
- Corrected a few typos on Brazilian Portuguese localiztion.
- Addressed styling issue causing a text fileds to have the same color as background.

## 0.7.0 [2021-05-30]
### Added
- New fancy layout for Vehicle sheet.
- Added notes visible only by GM on each actor sheet (Character, Vehicle, Spaceship).
- New tabs for Character sheet: Main (game stats), Persona (character notes), Effects (effects applied to character).
- Main Tab: the usual rollable game stats.
- Persona Tab: Biography (AKA the old nameless field in the header), Distinctive Features, Languages, Goals and Player & GM Secret Notes (only GM and actor owner can see this field), GM Notes (notes visible only by GM).
- Effects Tab: a hub for all Conditions, Active Effects and bonuses granted from Items. Conditions, Active Effects and Item Modifiers are managed here. There is a link to open the item sheet granting a particular modifier.
- Vehicles: "Custom" is now an option for Velocity parameter, which will highlight the appropriate Damage table row.
- When creating a new token, Bar1 will be set to Health/Fortune and Bar2 will be set as Power (Magic) Points (if using this rule is on) or it will be set to Conditions (if this option is in use). If none is used, Bar2 will not be filled.
- When a token is created out of a Player Owned character/vehicle/spaceship, token's Disposition will be set to Friendly.
- Player Owned actors tokens will always be created with the Link Actor Data option checked. It can be changed afterwards.
- Conditions (The Expanse) are not optional anymore - they are always available.
- Conditions tooltip now pops up close to mouse pointer.
- Added new Item Modifiers: Focus, Attack Bonus, All Test. Look at [AGE System (unofficial) wiki](https://github.com/vkdolea/age-system/wiki) for more details.
### Fix
- Expanded "Range" field for weapons to accomodate bigger numbers.
- Issue causing modified Ability value to be hidden even when a Modifier was applied to it.
- Bug freezing Maximum Conviction to 3.
- Code cleanup.

## 0.6.5 [2021-05-01]
### Fix
- Bug causing spaceship description to disappear when sending to compendium.

## 0.6.4 [2021-04-26]
### Fix
- Breaking bug on French localization.

## 0.6.3 [2021-04-25]
### Added
- Brazilian Portuguese localization.

## 0.6.3 [2021-04-25]
### Added
- Brazilian Portugues localization.

## 0.6.2 [2021-04-24]
### Added
- Updated French localization
### Fix
- Tooltip fixed on "Test" button Power & Arcana sheet.
- Styling on Modifiers and Description tabs on Item sheets.

## 0.6.1 [2021-04-22]
### Added
- Tracker (Complication, Churn, Serendepity) and Roller can now be dragged, and new position will be memorized. Point mouse slightly above Tracker or Roller and a Drag Bar will appear. Click and drag to reposition. Right click Drag Bar to return to original position!
### Fix
- Serendipity tracker now set default value as Deactivated when new world is created.
- Characters can now be draged to Spaceships.
- Description field for spaceships now have correct line spaces between paragraphs.
- Fixed issued preventing Speed to assume values other than 10.

## 0.6.0 [2021-04-19]
### Added
- Serendipity tracker (Modern AGE Companion).
- Complication tracker (Modern AGE Companion).
- Churn tracker (The Expanse RPG).
- Right Clicking the Age Roller icon will roll 1d6 (use Left Click + Alt to modify the standard 3d6 roll).
- Added new color sets for character sheet.
- Added Spaceship as Actor.
- Added Spaceship Features item, to add Qualities, Flaws and Weapons to spaceships.
- Hindered/Exausted and Helpless/Restrained conditions now affect Speed parameter accordingly. Contributor: Discord user *schlosrat (he/him) #1091*.
### Fix
- Fixed bug preventing MCE editor to enter editing mode in some Item sheets.

## 0.5.1 [2021-03-25]
### Fix
- Fixed a bug causing Spanish localization to display French text.

## 0.5.0 [2021-03-25]
### Added
- Added an Age Roller close to hotbar. Click to roll 3d6 and check stunts. Right click to be prompet to add modifier and TN.
- Added to vehicle sheets: Armor Rating, Cover, Total Passengers Capacity and Custom Damage for Collision/Sideswipe.
- On vehicles damage table, line representing vehicle's Velocity Class will have **bold** characters.
- On Configure Settings it is now possible to configure the flavor text as Health and Fortune.
- Dice so Nice users can now can select their Stunt Die colorset option on System Settings.
### Fix
- Migration issue could cause Conditions not to be created properly on migrated Actors.
- Bug preventing rolling a Focus using a different Ability (or none).
- When an Actor is deleted from game/directory, it will also be removed from vehicles' passenger list the next time the sheet is updated.
- Fixed a bug causing the text field on character sheet header to be innacessible in some browsers.
- Application will not reload after changing colorsets on "Configure Settings".
- Color Scheme won't reset when Player changes browser or delete browser historic.
- "Use Power Points" and "Focus Compendium" settings are now accessible only for GMs.
- Empty fields in the constant part of damage builder will no longer return "null" on damage formula.

## 0.4.1 [2021-02-22]
### Added
- Vehicles as Actors - GM and trusted players may drag and drop Actors from directory to add as passengers. All players with Owner privilege of a Vehicle will be able to roll for Maneuvers and Damage.

## 0.4.0 [2021-02-05]
### Added
- Options to Add Focus to damage and an arbitraty number for Stunt Die now shows up When ALT + Click to roll damage.
- Powers now have option to roll as Damage or Healing.
- Added option to indicate a Power as resistable, and add which Ability (Focus) is used to resist.
- Damage/Healing Powers have a "Resisted Effect" to indicate the damage/healing roll when target resists.
- Added buttons on chat message to roll "resisted damage/healing" from applicable Powers.
- Ronin Green color scheme included.
- Player can select which Ability will be used to check Power's Fatigue - previously all Fatigue checks were based on Willpower.
- Fatigue chat message now will not show Damage/Fatigue buttons.
### Fixed
- Bug causing chat message causing damage/fatigue rolls from unliked tokens to roll from Actor.
- Bug preventing Talent degree to display on character sheet.
- Restyled chat message buttons.

## v0.3.1 [2021-01-26]
### Fixed
- Incorrect link on system.json preventing system to update automatically using FoundryVTT software.

## v0.3.0 [2021-01-25]
### Added
- Press Alt key when rolling a roll check to bring menu with options to set TN, add modifier and Attack to Damage trade off (this one only when rolling weapon attacks).
- When targeting a token and rolling an weapon attack, roll will be check versus target's Defense (attack selecting multiple tokens warns user to select only one token to attack).
- When attacking a token or when rolling versus a TN, chat card will show "Success" or "Miss" - if the check is a "Miss", stunt points will not be generated.
- Default macro (when dragging Power or Weapon to macro bar) behaviour is rolling the Item without prompting for a dialog box. Setting second argument to "true" after in the macro script it will prompt user for roll options (i.e., it will simulate the Click + Alt on character sheet roll).
- When rolling damage, use Alt + Click to open menu to input extra damage options (extra dice and flat bonus/penality).
- Added 4 and 12 hours option for casting time.
### Fixed
- Rolling Focus with another Ability from Focus' context menu now functional.
- Fixed labeling on Cost field of equipment should "Purchase TN" instead of "Cost".
- Styling on Power sheet causing PP cost field to disapear.
- Data migration issues when preventing Speed mod to be include to some items.

## v0.2.4 [2021-01-21]
### Added
- French localization by Discord user *Imposator#8090*.
### Fixed
- Version issue on 0.2.3 causing it to behave as 0.2.2.

## v0.2.3 [2021-01-20]
### Added
- When selecting a input field, the text will be focused for quick edit.
### Fixed
- Issue causing worlds created on versions 0.2.1 and earlier not compatible to version 0.2.2.

## v0.2.2 [2021-01-17]
### Added
- Added Speed Modificator.
- Added Settings option to include Conditions (actual rolls and characteristics modificators not included).
- When rolling damage from chat, added options to add Focus, Stunt Die or both to damage.
### Fixed
- Arcana/Power Fatigue rolls were previously based on Power's key Ability, no reverted to Willpower.
- Fixed "yards" abbreviation to "yd" on grid map.

## v0.2.1 [2021-01-10]
### Fixed
- Focus context menu (to edit, remove, show and roll with another Ability) is working again.

## v0.2.0 [2021-01-09]
### Added
- Header from chat cards when rolling items shows different text.
- Option to use GP / SP / CP as a wealth type.
- Support to drag Weapons and Powers to marcobar.
- Cost and Minimum STR fields now accepts text input.
- Extra field on weapon chards to input max/long range.
### Fixed
- Removed unnecessary arguments from ageRollCheck.
- When equip/activate icon is clicked on character sheet, only this element is updated on Item object and not the whole entity.

## v0.1.1 [2021-01-05]
### Fixed
- Minimum and compatible versions updated on system.json.

## v0.1.0
### Added
- Checkbox to indicate primary Abilities.
- Option to hide primary Abilities checkbox if not used.
- Option to use Impact and Ballistic armor or generic Armor.
- Added field in character sheet to track Threshold during Advanced Tests.
- Shield icon working to equip/activate items. Unequiped/unactive items do not add bonuses to character.
- Added custom icons for each item type and character, and users are allowed to change them as they please.
### Fixed
- Fixed an error causing Currency input to be disabled.
- Added missing Membership sheet template.
- Fixed styling issue causing all item name container to be slightly shorter than other sheet rows.

## 2020.12.31
- Included Ancestry/Race/Origin field with selection on Settings
- Added option to change label between Profession/Class
- Damage formula for items know support no Ability selected
- Added a horizontal line to

## 2020.12.29
- Added functional color schemes for Modern AGE, Fantasy AGE, Threefold and Dragon AGE books.
- Fixed bug causing Talent item to be reset when dragging it to character sheet.
- Fixed bug causing Ability values disappearing from character sheet.

## 2020.12.28
- Added damage type (stun, wound, impact, ballistic, penetrating) on damage roll char card.

## 2020.12.27
- Added Settings menu to swap setting specific data (Fatigue, Power Points, Fatigue, Conviction, Currency, Income, Resources, Toughness).
- Dragon AGE and Core AGE abilities are now supported, only select the desired at Settings.
- Added settings to change game mode (Gritty, Pulp, Cinematic), but no practical changes on the system.
- Added setrings to change color schemes, but not functional (current system scheme is the "Modern Blue").
