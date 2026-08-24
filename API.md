# AGE System integration API

AGE System 5.0 RC retains the additive, versioned API for modules and macros and adds typed boundary contracts for actions, chat metadata, and read-only migration preview. Existing `game.ageSystem` properties remain available, but integrations should use `game.ageSystem.api` for gameplay capabilities and feature-detect the contract they need.

## AGE 5 data contracts

`game.ageSystem.dataContracts` exposes pure, non-mutating validators for the AGE Action envelope and structured chat metadata. `game.ageSystem.structuredChat` creates and validates chat-card metadata and reports its schema version.

New AGE-authored messages may store a normalized card at `flags.age-system.structuredChat`. Schema v1 includes a card kind, title/subtitle, optional Actor/Item/action identity, stable target UUIDs, and a plain serializable data object. Integrations must preserve unknown fields and should feature-detect `schemaVersion` before consuming the flag.

RC.3 registers compatibility-first Actor and Item TypeDataModels for every supported type. New documents receive cloned system-template defaults, source values remain permissive, and prepared runtime fields are non-persisted. No migration executor is enabled. AppV2 rich-text enrichment uses Foundry 14's namespaced TextEditor implementation.

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

The system socket is used only for AGE Action requests. The GM validates the request against the user ID authenticated by Foundry's socket server, checks ownership for the requested action, rejects replays and rate bursts, and executes through the same action handler used locally. The client-supplied payload cannot impersonate another user. A request fails safely when no GM is active or the requester lacks permission.

Use `api.actions.delegation()` to inspect protocol version, initialization, active GMs, and pending request count. Integrations should show a useful error if delegation is unavailable rather than bypassing document ownership.

## Compatibility rules

- Feature-detect capabilities instead of comparing system-version strings.
- Call the public wrappers rather than private underscored methods.
- Supply stable operation IDs for chat-card and HUD actions.
- Do not modify the returned API or capability objects; they are frozen.
- Prefer a registered action template where one matches the workflow, and feature-detect any action type before use.
- Never send trusted user IDs, Document data, or pre-authorized mutations inside a delegated action.
