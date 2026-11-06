# AGE System integration API

AGE System 5.3.0 exposes API 1.4.0. It retains the additive contracts for actions, chat metadata, transactions, read-only migration preview, and provider-neutral progression registration, signed creation/advancement previews, commits, receipts, and undo. API 1.4 adds a creation-only, preview-first NPC Studio namespace without changing the progression method surface. Existing `game.ageSystem` properties remain available, but integrations should use `game.ageSystem.api` for stable gameplay capabilities and feature-detect the contract they need.

## AGE 5 data contracts

`game.ageSystem.dataContracts` exposes pure, non-mutating validators for the AGE Action envelope and structured chat metadata. `game.ageSystem.structuredChat` creates and validates chat-card metadata and reports its schema version.

New AGE-authored messages may store a normalized card at `flags.age-system.structuredChat`. Schema v1 includes a card kind, title/subtitle, optional Actor/Item/action identity, stable target UUIDs, and a plain serializable data object. Integrations must preserve unknown fields and should feature-detect `schemaVersion` before consuming the flag.

The retained 5.0 compatibility layer registers compatibility-first Actor and Item TypeDataModels for every supported type. New documents receive cloned system-template defaults, source values remain permissive, and prepared runtime fields are non-persisted. No bulk migration executor is enabled in 5.2.2. AppV2 rich-text enrichment uses Foundry 14's namespaced TextEditor implementation. Display-only embedded Item descriptions are enriched relative to their owning Item and added only to detached render context; they are not submitted through the Actor form or written back to the Item.

## Availability

The API is created during the system `init` hook. Integrations may access it during `ready`, or subscribe during script loading:

```js
Hooks.once("ageSystemApiReady", api => {
  if (!api.hasCapability("transactions", 2)) return;
  // Register the integration.
});
```

`api.apiVersion` versions the integration contract. `api.systemVersion` reports the installed system release. Capability versions allow additive features to evolve independently.

## Transaction service

`api.transactions.execute()` preflights one or more updates, applies them as one operation, records a versioned undo entry, and restores already-applied documents if a later update fails.

```js
await game.ageSystem.api.transactions.execute({
  operationId: `my-module:${message.id}:damage`,
  label: "Apply damage",
  type: "damage",
  sourceUuid: item.uuid,
  metadata: {messageId: message.id},
  updates: targets.map(({actor, health}) => ({
    document: actor,
    update: {"system.health.value": health}
  }))
});
```

An `operationId` must contain 1 to 128 characters. Concurrent calls using the same ID share the same Promise, which prevents rapid duplicate execution. Update paths are checked before mutation. Deletion paths and prototype-related paths are rejected because they cannot be safely accepted from integrations.

The service stores only serializable metadata. Integrations should store UUIDs and primitive values rather than Document instances, DOM events, or functions.

## Content validation

The validator never mutates documents.

```js
const report = await game.ageSystem.api.content.validateWorld({includePacks: true});
console.table(report.issues);
```

Reports include error and warning counts, document identity, stable issue codes, and affected data paths. Errors identify structurally unsafe data. Warnings identify suspicious but potentially intentional content such as duplicate source IDs or resources above their configured maximum.

The migration preview is also read-only:

```js
const preview = await game.ageSystem.api.content.previewWorldMigration({includePacks: true});
console.table(preview.operations);
```

It reports missing defaults, safe coercions, persisted derived caches, ambiguous review values, and blockers. It never writes Actors, Items, or compendia.

Individual documents or prepared arrays can be checked with `validateDocument(document)` and `validateDocuments(documents)`.

## Progression API 1.4.0 / capability 2

`game.ageSystem.api.progression` is the frozen integration surface for DefinitionV1/DefinitionV2 validation, registration, and preview-first execution. Content modules are optional providers; the progression engine has no FAGE, DAGE, MAGE, or other content-module dependency.

```js
const progression = game.ageSystem.api.progression;
if (!game.ageSystem.api.hasCapability("progression", 2)) return; // DefinitionV2-aware

const progressionCapabilities = progression.capabilities();
if (!progressionCapabilities.definitionVersions?.includes(myDefinition.schemaVersion)) return;

const validation = progression.validateDefinition(myDefinition);
if (!validation.valid) {
  console.table(validation.issues);
  return;
}

if (progression.capabilities().operations.executabilityValidation) {
  const readiness = progression.validateExecutability(myDefinition, {trigger: "rank.advance"});
  if (!readiness.valid) console.table(readiness.issues);
}

progression.registerDefinition(myDefinition, {
  provider: {id: "my-module", kind: "module", label: "My progression module"}
});
```

The frozen surface includes:

- `validateDefinition(definition)`;
- feature-detectable `validateExecutability(definition, {trigger})`;
- `registerDefinition(definition, options)` and `unregisterDefinition(definitionId)`;
- `getDefinition(definitionId)`, `definitions(filters)`, `provider(definitionId)`, and `definitionRecord(definitionId)`;
- `previewCreation(options)` and `previewAdvancement(options)`;
- `commitCreation(previewId, planDigest)` and `commitAdvancement(previewId, planDigest)`;
- `receipt(receiptId)`, `receipts(filters)`, `previewUndo(receiptId)`, and `undo(receiptId, options)`;
- `status()` and `capabilities()`.

`validateDefinition()` dispatches by `schemaVersion` and answers whether data satisfies the corresponding portable contract. `validateExecutability()` additionally checks the trigger-filtered creation, Class-backed, or Actor-backed route against the effects and combinations the selected executor can safely perform. AGE System 5.3.0 advertises progression capability 2, latest `definitionVersion: 2`, and additive `definitionVersions: [1, 2]`; DefinitionV1 and the complete API 1.3 progression surface remain compatible inside API 1.4.

DefinitionV2 retains the closed DefinitionV1 model and adds typed `text`, `longText`, `integer`, and `select` inputs; authored milestone stages; conditional choice groups; input-backed identity/ability/language values; `ability.set`; `language.add`; expanded identity fields; normalized Resources/currency initialization; and per-ability/formula bounds. Definitions still cannot contain callbacks, arbitrary document paths, executable predicates, or implicit sourcebook interpretation.

A commit accepts only the server-held preview id and signed plan digest. Do not send Actor updates, Item operations, formulas, or replacement choices at commit time. A fresh preview is required when the definition, profile, source Item, Actor/base state, user binding, expiry, or plan digest changes. Formula results are resolved once and pinned in the preview.

Formula amounts remain `{kind: "formula", formula: "..."}` and may add an optional Foundry-safe `rollId`. Matching formula/`rollId` pairs share one resolved total across their semantic effects. Omitting `rollId` preserves independent formula resolution.

Character creation commits one complete Actor with preassigned embedded Item ids. Reversal requires a separate destructive undo preview, explicit confirmation by the UI, and an exact current-source digest match. Advancement uses its specialized Class transaction/rollback service and durable domain receipt; it is not wrapped in the generic update-only transaction service.

## NPC Studio API 1.4.0 / capability 1

`game.ageSystem.api.npcStudio` exposes the same creation boundary used by the core AppV2 NPC Studio. Feature-detect it before use:

```js
const api = game.ageSystem.api;
if (!api.hasCapability("npcStudio", 1)) return;

const studio = api.npcStudio;
const draft = await studio.createDraft({origin: "blank"});
const preview = await studio.preview(draft);

const result = await studio.commit(preview.id, {
  inputDigest: preview.inputDigest,
  snapshotDigest: preview.snapshotDigest,
  planDigest: preview.planDigest,
});
```

The frozen surface includes:

- `createDraft({origin, profileId, text, parserMode, actorUuid})` for `blank`, `paste`, or `clone`;
- `preview(draft)`;
- `searchActors(query, options)` and `searchItems(query, {profileId, type, limit})`, where `type` is an optional supported NPC Item type applied before the result limit;
- `commit(previewId, {inputDigest, snapshotDigest, planDigest})` and `cancel(previewId)`;
- `receipt(receiptId)`, `previewUndo(receiptId)`, and `undo(receiptId, options)`;
- `getActiveProfile()`, `status()`, and `capabilities()`.

Drafts are typed, bounded plain data. Callers cannot submit arbitrary Actor or Item source objects. Preview retains the canonical draft, active profile snapshot, source identities/digests, and complete compiled Actor plan in a user-bound in-memory session for fifteen minutes. Commit accepts only that preview id and its three digests, re-resolves every source, and creates one new Actor. Clone is always create-copy; API 1.4 has no update-existing operation.

Undo is deliberately separate from commit. `previewUndo(receiptId)` returns a short-lived exactness preview; `undo()` requires that preview, explicit confirmation, the same user, and an unchanged Actor whose authoritative source still matches its creation receipt. An edited Actor is never deleted.

```js
const undoPreview = await studio.previewUndo(result.receipt.id);
await studio.undo(result.receipt.id, {
  confirmed: true,
  preview: undoPreview,
});
```

### Persistent Progression Definition Items

World/compendium authoring and import/export are document-provider responsibilities exposed at `game.ageSystem.progressionDefinitions`. This namespace is intentionally separate from the frozen API 1.4.0 surface because it follows Foundry's GM document and compendium lifecycle. Feature-detect it before use.

```js
const documents = game.ageSystem.progressionDefinitions;
const created = await documents.createWorldDefinition(myDefinition, {
  name: "My progression",
  enabled: false,
  renderSheet: true
});

await documents.setDefinitionEnabled(created, true);
console.log(await documents.exportDefinition(created));
```

The provider reports `status()`, `records()`, and `issues()` and supports `refreshAll()`, `createWorldDefinition()`, `importDefinition()`, `updateDefinitionDocument()`, `setDefinitionEnabled()`, `deleteDefinitionDocument()`, and `exportDefinition()`. Mutating operations require a GM and a top-level Progression Definition Item; locked packs are readable provider sources but not editable. Owned Items, invalid definitions, checksum mismatches, disabled definitions, and ambiguous equal-version conflicts are excluded from execution.

Definitions supplied through module registration, world Items, readable Item compendia, JSON import, and the legacy Class adapter all enter the same schema-dispatching validator and registry. Provider origin grants no extra trust. The copyright-neutral FAGE/DAGE/MAGE files in the core test suite are **synthetic structural coverage**, not complete rules payloads. Full guided DAGE/FAGE1/FAGE2/MAGE creation data is delivered separately by AGE Progression Profiles 0.3.0; FAGE1 creation uses DefinitionV2 while its advancement route retains DefinitionV1/Class-v3 compatibility.

Creation definitions may use `resource.initialize`. DefinitionV1 permits `health`, `powerPoints`, or `conviction`; DefinitionV2 additionally permits normalized `currency` and `resources`. Its amount is a finite non-negative number or a formula amount, is valid only on a `character.create`-only milestone, resolves once using final preview-signed creation abilities, and replaces the resource's starting state before additive gains. It is deliberately unavailable to advancement definitions.

Providers must keep uncertain rules explicit. `summary.add` may record a manual-review requirement, but it is not an executable mutation. The compiler never guesses a missing Item, RollTable result, rule interpretation, or Actor path.

## AGE Actions v1

AGE Actions provide one serializable envelope for attacks, Powers, resistance, damage, healing, Power Point spending, Stunts, and Active Effects. The action schema is versioned independently from the public API.

```js
const api = game.ageSystem.api;
if (!api.hasCapability("actions", 1)) return;

const action = api.actions.create("attack.standard", {
  itemUuid: weapon.uuid,
  actorUuid: weapon.actor.uuid,
  targetUuids: Array.from(game.user.targets, token => token.document.uuid)
});

console.log(await api.actions.preview(action));
await api.actions.execute(action);
```

The public surface includes:

- `create(templateId, overrides)` to build and validate an action from a registered template.
- `validate(action)` and `preview(action)` for contract checks without mutation.
- `execute(action)` for an action the current client may perform.
- `request(action, options)` for permission-checked execution by the elected active GM when a player requires delegation.
- `supports(type)`, `definitions()`, `templates()`, and `status()` for feature detection and diagnostics.
- `history(options)` and `pending(id)` for the initiating user's bounded diagnostic history and duplicate-action visibility.

Core action types in schema v1 are `roll.attack`, `roll.power`, `roll.resistance`, `roll.damage`, `apply.damage`, `apply.healing`, `resource.power-points`, `stunt.spend`, `stunt.undo`, `effect.apply`, and `effect.remove`.

Action objects contain UUIDs, primitives, arrays, and plain objects only. They must not contain Foundry Documents, DOM events, functions, or secrets. Target UUIDs are snapshotted so later canvas selection cannot redirect an action. Calls sharing one action ID reuse the pending Promise instead of applying twice.

### GM delegation

In 5.4.1-rc.2, `resource.power-points` always uses the elected active GM, including requests by other GMs. Both `api.actions.execute(action)` and `api.actions.request(action)` route this resource action through that authority. The public `execute()` workflow retains `result.rollback()` and `result.transaction`: the executing GM can retain the local transaction object, while another client's wrapper constructs a local facade exposing the transaction id and an authenticated rollback callback. No live transaction object or callback crosses the socket. A spend payload accepts `cost` and an optional `operation: "spend"`. Normal public execution asks the caster to confirm insufficient funds; direct delegated requests may supply `allowInsufficient: true` only after the caller has explicitly chosen to spend the available balance and continue.

At the transport boundary, this action alone returns a plain payment receipt in delegated `result`: `{actorUuid, cost, spent, paymentId, transactionId}`. A caller using raw `request()` receives that serializable receipt for remote execution; the normal `execute()`/Power-resource wrapper hydrates its local callbacks. A rollback request uses the same action type and Actor UUID with `{operation: "rollback", paymentId}`. The executing GM rechecks ownership, original requester, payment age/session, and exact tracked resource state. The most recent 500 receipts are held for up to fifteen minutes in that GM session. A successful rollback is idempotent. Refunds after a conflicting balance change or GM-session change are refused; timed-out requests must be inspected before any manual retry. Payment transaction history is stored on the executing GM.

General Undo of a PP transaction acquires the same Actor queue as casting and receipt rollback, rechecks the latest history entry and authority after waiting, and marks its associated payment refunded. Within that authority session it serializes with queued casts and leaves the receipt ineligible for a second refund.

The system socket is used only for AGE Action requests. The GM validates the request against the user ID authenticated by Foundry's socket server, checks ownership for the requested action, rejects replays and rate bursts, and executes through the same action handler used locally. The client-supplied payload cannot impersonate another user. A request fails safely when no GM is active or the requester lacks permission.

Use `api.actions.delegation()` to inspect protocol version, initialization, active GMs, and pending request count. Integrations should show a useful error if delegation is unavailable rather than bypassing document ownership.

## Compatibility rules

- Feature-detect capabilities instead of comparing system-version strings.
- Call the public wrappers rather than private underscored methods.
- Supply stable operation IDs for chat-card and HUD actions.
- Do not modify the returned API or capability objects; they are frozen.
- Prefer a registered action template where one matches the workflow, and feature-detect any action type before use.
- Never send trusted user IDs, Document data, or pre-authorized mutations inside a delegated action.
