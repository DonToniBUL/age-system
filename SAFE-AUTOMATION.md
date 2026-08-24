# AGE System 4.5.0 Safe Automation

This stable release promotes the Foundry-verified 4.5.0-rc.1 automation without replacing or restyling Actor or Item sheets.

## Integration safeguards

- New module and macro integrations should use the versioned `game.ageSystem.api` contract documented in `API.md`.
- Multi-document transactions preflight all requested paths before the first update and restore already-applied documents if a later update fails.
- Stable operation IDs suppress simultaneous duplicate execution while an action is pending.
- Content validation is read-only. It reports issues but never repairs or deletes world or compendium data.
- AGE Actions v1 uses immutable, serializable envelopes, one in-flight operation per action ID, bounded per-user diagnostics, and the same registered handlers for local and delegated execution.
- GM socket delegation trusts Foundry's authenticated sender identity, rechecks document ownership, rate-limits requests, suppresses replays, and fails closed when no active GM is available.

## AGE Actions and Operations

The established sheet, chat-card, macro, and companion entry points remain the user interface. They now create structured actions for attacks, Powers, resistance, damage, healing, Power Points, and Stunts. The originating action is also recorded on relevant chat cards and reversible transactions for troubleshooting.

Open **AGE Toolbox -> Operations & Diagnostics** to inspect the current API/schema versions, registered handlers and templates, pending actions, recent outcomes, and reversible transactions. **Run Content Audit** is read-only. **Export Diagnostics** downloads one JSON snapshot locally. **Clear Action Diagnostics** clears only the bounded action log and does not erase reversible transaction history.

## Defaults

- Automation mode: **Assist**
- Reversible AGE actions: **On**
- Importer v2 preview: **On**
- Unified compendium index: **On**
- Stunt Assistant: **On**
- Multi-target attacks: **On**
- Power resistance tests: **On**
- Combat turn lifecycle: **On**, **Remind only**
- Advanced Test tracker: **On**
- Requested Rolls: **On**
- Recovery Assistant: **On**
- Combat Economy: **On** (advisory only)
- Active rule profile: **Custom** (no world settings are changed automatically)

Setting **AGE Automation** to **Off** removes the Library and Undo toolbox actions, stops action-history recording and the compendium index, and returns the importer to its 4.2.7 workflow. Rule-profile restoration remains available so an already-applied profile can always be reversed. Core roll behavior, including configured Power Point consumption, remains active.

## AGE Rule Profiles

Open **Configure Settings → AGE Rule Profiles**. Selecting a profile only prepares a preview. The table shows the current value, proposed value, and which changes require a reload.

Applying a profile validates every setting before making changes. It also enables **Consume Power Points**, because applying a profile is an explicit opt-in to its automated gameplay defaults. If any write fails, completed writes are restored. **Restore Previous Settings** is also guarded: if a covered setting was manually changed after the profile was applied, restoration stops instead of overwriting it.

| Profile | Distinguishing configuration |
| --- | --- |
| Dragon AGE | Dragon AGE abilities, primary/secondary abilities, class/race terminology, coins, Mana, standard Health |
| Fantasy AGE 1e | Main AGE abilities, class/race terminology, coins, spell terminology, standard Health |
| Fantasy AGE 2e | Ancestry terminology, Peril and Daring enabled |
| Modern AGE Core | Pulp mode, Resources, standard Modern AGE Health |
| Modern AGE Mastery/Injury | Pulp mode, Resources, optional Injury Health system |

Weapon groups remain user-managed because their exact list depends on the enabled private content module and campaign rules.

## Reversible actions

Supported system actions record before/after values in the initiating user's AGE history:

- Damage and direct Health changes
- Healing
- Injury application and Injury-mark recovery
- Single- and multi-Actor Breathers
- Power Point spending
- Stunt Point ledger spends
- Automatic or confirmed combat-state expiration

Use **AGE Toolbox → Undo Last AGE Action**. Undo resolves every affected document and verifies that its current value still equals the recorded result. If another action changed that value, undo stops with a conflict instead of overwriting newer play.

The history is per user and retains the latest 20 actions by default. It is not a replacement for world backups.

## Unified AGE Library

Open **AGE Toolbox → Unified AGE Library** or **Configure Settings → Unified AGE Library**. The index includes enabled Actor, Item, Journal Entry, and Roll Table compendia.

Search is filtered by the active rule-profile family when content declares `flags.age-system.profile`. The index also recognizes the installed Dragon AGE, Fantasy AGE, and Modern AGE content-module package names. Unclassified generic AGE content remains searchable under every profile.

## Importer v2

The existing AGE Importer now has two explicit stages:

1. **Preview Import** parses without creating documents and reports valid blocks, errors, exact Item matches, and unresolved Items.
2. **Create Verified** creates only the successfully parsed blocks. Exact world Items are reused; exact compendium Items are copied; existing world Talents are not duplicated.

Place a line containing only `---`, `===`, or `***` between multiple NPC or Talent blocks. Changing the text or rules mode invalidates the previous preview.

## Power Point safeguards

Automatic Power Point spending now derives the owned Power's cost even when a macro or HUD calls the public roll service without a sheet-created cost object. It uses the final cost from the roll-options dialog and re-reads the Actor's current points immediately before spending. Concurrent duplicate activation is blocked. If the roll's Chat Message cannot be created, the resource change is rolled back when no conflicting later change exists.

## Stunt Assistant

When a successful AGE roll generates Stunt Points, its chat card receives a **Stunt Assistant** button. The separate window searches the rolling Actor's owned Stunts and, when enabled, indexed Stunt compendia. Roll-appropriate categories sort first without hiding other choices.

Fixed and variable costs are validated against the Item definition and the message's remaining points. A duplicate click cannot spend the same pool concurrently, overspending is rejected, and **Undo last spend** reverses the most recent ledger entry. Supported spends also enter reversible AGE action history.

Seven canonical Stunts have conservative execution descriptors. Mighty Blow, Vicious Blow, and Lethal Blow queue their extra damage dice for the originating attack's next damage roll. Knock Prone asks which successful target receives the condition. Stay Aware, Duck and Weave, and Defensive Stance create visible Defense effects which expire at the start of the Actor's next turn. Stunts whose movement, weapon choice, ally choice, or narrative outcome cannot be inferred remain ledger-only.

## Multi-target attacks and Argon

Select one or more canvas targets before rolling a Weapon attack. AGE snapshots each target and its prepared Defense, rolls once, then records an independent result and margin for every target. The existing roll card is not replaced; the target summary is inserted around it at render time.

Damage rolled from that card is locked to hits from the original attack. A complete miss therefore cannot fall back to newly selected canvas tokens. The Apply Damage window still permits individual targets to be ignored before committing changes.

When every locked target is missed, the chat-card damage action stops before creating an unusable damage card and explains that there are no successful recipients. Mixed-hit attacks and successful attacks retain their original hit-only routing. Older all-miss damage cards show the same explicit explanation if their Apply Damage button is used.

Argon companion 1.0.4 preserves multiple targets that were selected before clicking a HUD Weapon. A normal one-target action retains Argon's target picker, and the module falls back to its pre-4.2.9 behavior when the AGE multi-target API is unavailable. Its Portrait Panel also tolerates the transient no-Actor state during HUD teardown and token changes.

## Power resistance

An owned Power with **Has Test** enabled records its Force, resistance Ability/Focus, and selected targets on the activation message. The message author or a GM can roll one eligible target, reroll it, or roll all eligible targets. AGE uses the target Actor's native Ability/Focus roll against the recorded Force and retains the attempt history.

The existing **Roll Full Damage** path is routed to failed or not-yet-rolled targets. **Roll resisted damage** uses the Power's configured resisted-damage fields and is routed to successful resistance targets. If the Power was activated without a target, current targets are locked when resistance is first rolled.

## Conditions and timed lifecycle

Aim is consumed by the next completed attack. Defend and All-Out Attack expire at the start of the Actor's next turn. Guard Up expires at the end of the round. Active Effects can declare one of the explicit timings under `flags.age-system.automation.duration.timing`: `startOfTurn`, `endOfTurn`, `endOfRound`, `endOfEncounter`, `nextAttack`, or `nextTest`. The legacy `automation.expires` string remains readable.

The default **Remind only** mode posts an actionable chat card before temporal states are disabled. **Expire automatically** performs that same transaction without the reminder. Next-attack and next-test effects are consumed by the completed action that used them. AGE never infers a duration from Effect names, icons, or prose.

At 0 Health, AGE posts a confirmation for the Dying condition because Modern AGE stun damage and minor-NPC rules cannot be safely inferred. Confirmed Dying Actors receive round/deadline reminders; Pulpy and Cinematic profiles identify survival-test timing. No character is killed automatically.

## Requested Rolls, recovery, and combat economy

**AGE Toolbox -> Requested Rolls** lets a GM post one Ability, optional Focus, optional TN, and specific Character recipients. Each roll button is available only to an owning user or GM and produces a normal AGE roll with request provenance.

**AGE Toolbox -> Recovery Assistant** applies `5 + Constitution + Level` after a breather and standard `10 + Constitution + Level` sleep recovery. Deleted combats record whether each Character ended at 0 Health and whether the encounter's one breather was used. Gritty wound damage and Cinematic stun-only sleep require explicit confirmation.

**AGE Toolbox -> Combat Economy** records major, minor, and free actions for the current turn. Weapon attacks, Power activations, and sheet maneuvers enter the ledger automatically; movement and unusual granted actions can be marked manually. Exceeding one major plus one minor or two minors shows a reminder but never blocks play.

## Advanced Tests

Open **AGE Toolbox → Advanced Tests**. GMs can create Advanced, Opposed, Breaching, Chase, Investigation, Social, Exploration, or custom trackers with separate party and opposition thresholds. Each adjustment stores bounded history and can be undone from the tracker window.

While at least one tracker is active, an eligible successful AGE roll shows **Add progress to Advanced Test** for the GM. The suggested contribution is that roll's Stunt Die. With several active trackers, AGE asks which tracker should receive it.

## Protected visual layer

The build gate hashes and verifies all files under:

- `styles/`
- `less/`
- `templates/sheets/`
- `resources/`

All 115 protected files must remain byte-identical to the accepted 4.2.7 baseline.

## Foundry acceptance test

Use a copied world on Foundry 14.365.

1. Open Full and Block Character sheets; verify tabs, buttons, minimization, dimensions, positions, and colour switching.
2. Open AGE Rule Profiles, preview each profile, apply one, reload when prompted, and restore the prior settings.
3. Spend Power Points normally, with an adjusted cost, and while short on points; verify cancel and proceed paths.
4. Apply damage/healing to one Actor and to several Actors; use Undo Last AGE Action and verify all affected values restore together.
5. Run a Breather on several selected Characters and undo it.
6. Search the Unified AGE Library for one Actor, Item, Journal, and Roll Table from the enabled private modules.
7. Preview one valid and one malformed import block separated by `---`; create the valid block only.
8. Import the same Talent twice and confirm the second import reuses the existing Item.
9. Roll from Full sheet, Block sheet, macros, Argon Combat HUD, and Ammo Belt; verify one resource deduction and no console errors.
10. Exercise Item Piles transfer and purchase flows and confirm existing currency behavior is unchanged.
11. Select targets with different Defenses, roll one Weapon attack from a sheet and from Argon 1.0.3, and verify separate hit/miss margins plus hit-only damage recipients.
12. Activate a test-enabled damaging Power against two targets, roll one successful and one failed resistance, then verify full and resisted damage open with the correct recipients.
13. Generate Stunt Points, spend fixed and variable-cost Stunts, attempt to overspend, undo the last spend, and reopen the originating card to confirm its ledger persisted.
14. In combat, leave each supported maneuver active across a round. Verify the default reminder and its button, then test automatic mode and Undo Last AGE Action. Confirm unflagged Active Effects are untouched.
15. Create Advanced and Opposed trackers, add manual progress, undo it, add a successful roll's Stunt Die from chat, close the tracker, and remove it.
16. Open Operations & Diagnostics and confirm API 1.1.0, action schema 1, 11 handlers, 12 templates, and no pending actions after rolls settle.
17. Run the content audit, export diagnostics, and verify the window produces no new AppV1 deprecation warning.
18. With one GM and one player connected, request an owned action and verify it completes; request an action against an unowned Actor and verify the GM refuses it.
