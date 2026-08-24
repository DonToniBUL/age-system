# Unofficial AGE System for FVTT
Unofficial implementation of AGE System (Green Ronin) for Foundry VTT. Character sheet designed to serve most of AGE System versions. Not all AGE installments are fully implemented. New features are expected to be added over time.

> This branch preserves the community-tested 5.0.7 automation build as a separate manual-install line. See [branch notes](BRANCH-NOTES.md) for its exact scope, installation steps, and the Active Effects handbook.

## Foundry VTT v14 compatibility
AGE System 5.0.7 targets Foundry VTT 14.365. It retains the Foundry-verified 4.5 gameplay automation, transaction safeguards, content validator, and Argon AGE 1.0.4 compatibility while promoting the full-parity AppV2 sheets tested through RC.3. AppV2 is now the default for every supported Actor and Item type. The verified AppV1 sheets remain clearly labelled, selectable fallbacks for v14 integrations and unusual legacy documents.

The first GM launch performs a one-time, settings-only default-sheet transition. It changes no Actor, Item, compendium, or chat data; explicit per-document and third-party sheet selections are preserved. Compatibility-first TypeDataModels and the read-only migration preview remain in place, but 5.0.7 intentionally does not run a bulk typed-data migration. Back up the world and test the stable candidate in a copied world before replacing an accepted installation.

5.0.7 retains the corrected AppV2 form boundary across every Actor and Item update route. Partial Health, Power Point, ability, modifier, advancement, and other compatibility-object edits are rebuilt from raw stored source and transported as explicit atomic replacements before Foundry can discard their siblings. This covers automation, damage and healing, Power consumption, transactions, macros, module calls, imports, and migrations as well as AppV2 sheets. Item modifier removal and toggling read the persisted raw modifier map, so validation-only metadata from prepared Item data cannot be written into surviving modifiers.

The retained 5.0.6 correction derives an omitted modifier's usable key from its authoritative map entry in prepared data without persisting that derived value. The selectable AppV1 Weapon and Power fallbacks preserve the exact raw damage-source, minimum-Strength, reload, and Power casting-time values represented through normalized legacy controls unless the user actually edits those controls; an absent legacy field remains absent. Version 5.0.7 applies the same exact-source rule to the default AppV2 Weapon and Power sheets. An unrelated capacity, requirement, description, or modifier edit can no longer canonicalize those stored values or change their types, while an explicit UI or programmatic edit to the protected field remains authoritative.

Power spending now preserves the complete Power Point branch, locks spending per Actor, and skips zero-cost writes. Damage, healing, and direct Health adjustments preserve Health minimum, set, maximum, and extension data. Transaction rollback uses the same document boundary, so restoring one historical leaf cannot erase newer sibling values.

The corrected candidate also reconstructs a submitted Character ability branch from the Actor's raw stored source before Foundry validates it. This closes the remaining 0.1.7 QA finding: hidden profile abilities and unrendered values such as `testMod` and `advances` survive the complete ability edit, Primary, and Last Advanced sequence.

The final persistence boundary captures only the native control which changed and verifies at Actor pre-update time that every other raw source path is byte-stable. Stored Health, Defense, and Toughness values are now authoritative; legacy game-mode records remain intact as presets/fallbacks instead of being silently written alongside an ordinary resource edit.

### 5.0 stable experience

- New and unconfigured documents use AppV2 automatically. Use Foundry's Sheet Configuration to select the compact Character sheet or a legacy AppV1 fallback per document.
- Character Full, Character Stat Block, Vehicle, Spaceship, and Organization retain their complete 4.5 fields and controls.
- Class, Weapon, Power, Focus, Talent, Stunt, Equipment, Ship Feature, Relationship, Honorific, and Membership retain their complete specialist authoring surfaces.
- New AGE chat messages receive a versioned `flags.age-system.structuredChat` contract while old message HTML and controls remain compatible.
- Run **AGE Toolbox -> Operations & Diagnostics -> Preview Data Migration** before promotion; preview never updates documents.
- Return to a clearly labelled **Legacy AppV1 Fallback** at any time. Explicit beta.1 Item-sheet selections are remapped only to their matching type-specific AppV2 sheet; no bulk data-migration executor ships in 5.0.7.

### 4.3 integration foundation
- `game.ageSystem.api` provides a frozen, capability-versioned surface for module and macro integrations while retaining the legacy 4.x namespace.
- Multi-document AGE transactions preflight every update, reject unsafe paths, deduplicate concurrent operation IDs, record schema and system versions, and restore already-applied documents if a later update fails.
- The content validator audits Actors, Items, owned Items, and optionally compendia without changing data. Run `await game.ageSystem.api.content.validateWorld({includePacks: true})` from the console and inspect its `issues` array.
- See `API.md` for the supported integration contract and examples.

### 4.4 AGE Actions candidate
- `game.ageSystem.api.actions` exposes schema-v1 creation, validation, preview, execution, GM requests, templates, handler definitions, pending state, and diagnostic history.
- Eleven core action types cover attack, Power, resistance and damage rolls; damage and healing application; Power Point and Stunt spending; and Active Effect application/removal.
- Player-to-GM requests use Foundry's authenticated socket sender, document ownership checks, replay suppression, deterministic GM election, rate limiting, and timeouts.
- **AGE Toolbox -> Operations & Diagnostics** shows action and transaction status, runs the read-only content audit, and exports one troubleshooting JSON file.
- The release channel remains Manual / Local: the manifest intentionally has no remote update or download URL.

### Safe automation
- **AGE Rule Profiles** preview and transactionally apply Dragon AGE, Fantasy AGE 1e, Fantasy AGE 2e, Modern AGE Core, or Modern AGE Mastery/Injury settings. The previous settings can be restored in one step, and conflicts stop restoration instead of overwriting later edits.
- **Reversible AGE actions** record supported Health, Injury, healing, Breather and Power Point changes per user. The AGE toolbox includes **Undo Last AGE Action**, with current-value conflict checks.
- **Unified AGE Library** searches enabled Actor, Item, Journal and Roll Table compendia. Explicit content flags take priority, with safe package-name detection for Dragon AGE, Fantasy AGE and Modern AGE modules.
- **AGE Importer v2** separates parsing from creation, previews errors and Item matches, supports explicit `---` batch separators, reuses exact world/compendium Items, and prevents duplicate Talent imports.
- **Power Point safeguards** enable configured consumption when a rule profile is explicitly applied, derive cost for sheet, macro, and HUD-triggered Power rolls, validate the final adjusted cost against the Actor's current value, block simultaneous duplicate spending, and roll spending back if chat creation fails.
- **Stunt Assistant** records generated Stunt Points on the roll message, searches owned and indexed compendium Stunts, validates fixed or variable costs, blocks overspending, and supports one-step spend reversal.
- **Multi-target attacks** make one attack roll against every selected target's Defense, display each hit/miss and margin on the chat card, and lock subsequent damage application to successful targets.
- **Power resistance** adds per-target resistance rolls to test-enabled Power cards and separates full-damage recipients from targets using the Power's resisted-damage formula.
- **Combat lifecycle** defaults to reminder-only start-of-turn expiration for Aim, Defend, Guard Up, All-Out Attack, and Active Effects explicitly flagged for expiration. A transactional automatic mode is optional.
- **Advanced Tests** provide GM-managed progress windows for Advanced, Opposed, Breaching, Chase, Investigation, Social, Exploration, and custom trackers, including history and undo.

The accepted 4.2.8.1 corrections remain intact: Rule Profiles and Unified AGE Library retain compact, window-safe layouts, the compact Character sheet does not inherit the Full sheet's absent tab controller, and sheet/macro/Argon Power activations deduct exactly one configured Power Point cost.

The master automation mode defaults to **Assist**. Switching it **Off** removes the new toolbox actions, indexing, action history, preview-first importer, and new profile application while preserving the 4.2.7 workflows and the ability to restore an already-applied profile. No rules-book text is embedded in the system.

See `SAFE-AUTOMATION.md` for usage, safeguards, profile details, and the Foundry acceptance checklist.

### Item Piles and currency
When Item Piles is active, AGE registers Character Actors, Equipment and Weapons, `system.quantity`, Item `system.cost`, and the current world wealth mode automatically. GP/SP/CP worlds use the same `system.gp`, `system.sp`, and `system.cp` values shown on Character sheets. Item prices may remain readable strings such as `1gp 25sp`; Dragon Age crafting/retail pairs such as `70sp/4gp` use the value after the final slash for merchant purchases. Single-currency worlds use `system.currency`. Test-based Resources and Income worlds can use loot piles and transfers, but do not expose a merchant currency.

### Class items
Class items are enabled with validated 20-level definitions, one-Class-per-Character attachment, transactional advancement, duplicate protection, conflict-safe rollback, and legacy baseline migration. See `V14-COMPATIBILITY.md` for the full workflow and validation details.

### Character sheet fixes
The full and compact Character sheets now keep separate per-user sizes and positions. The compact/stat-block sheet rejects inherited viewport-wide dimensions from 4.2.0. Colour schemes update live, and the compact sheet now uses the selected palette rather than a hard-coded black-and-white layout.

### Dialog compatibility
Breather, roll options, damage options, insufficient Power Point prompts, Class confirmations, and JSON import prompts now use Foundry v14 `DialogV2`. Legacy `Dialog` constructor calls have been removed from the runtime.

### Damage application compatibility
Apply Damage now snapshots the selected Actor's prepared system data directly, handles legacy Actors without persisted armor fields, waits for every Actor update, and labels single-armor AGE presets such as Dragon AGE as **Normal Damage** instead of exposing the Modern AGE internal `impact` value. Chat and sheet context menus use Foundry v14 entries.

<img src="https://i.imgur.com/BQNFklx.png" alt="AGE System sheets preview" />

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/vkdolea)

## Wiki
Take a look at [AGE System (unofficial) wiki](https://github.com/vkdolea/age-system/wiki) to understand how to use the game system

## Features
- [Dice so Nice](https://foundryvtt.com/packages/dice-so-nice) compatible
- Two possible Character sheet - one Complete and another condensed, ideal for NPCs and quick character overview
- Different color schemes
- Checkboxes to identify primary and secondary abilities
- Checkbox to select last ability leveled up
- Option to use the Dragon AGE specific ability set
- Support to Toughness, Impact/Ballistic Armor, and Stun/Wound damage
- Support to Income, Resources, Currency and GP/SP/CP wealth systems
- Native optional integration with Item Piles 3.3+ for loot piles, trading, and coin-based merchants
- AGE Actions v1, safe rule profiles, reversible core resource actions, Stunt Assistant, multi-target attacks, Power resistance, combat lifecycle reminders, Advanced Tests, unified compendium search, and preview-first imports
- Possibility to use a few optional rules (Fatigue, Conviction, Complication/Churn, Serendipity)
- Possibility to add Conditions on characters (effects must be set manually)
- Support to track Serendipity (MAGE Companion), Complication (MAGE Companion)
- Shift, Alt, Ctrl keys support to change check and damage rolls
- Drag and drop owned weapons and power to macro bar to create attack shortcuts
- Add Stunt Die or Focus (or both) to damage roll when rolling damage from chat
- Point mouse slightly above Tracker or Roller and a Drag Bar will appear. Click and drag to reposition. Right click Drag Bar to return to  original position!
- Supports Vehicles and Spaceships.
- Active Effects enabled.
- Item Damage roll and a few Modifiers accept e few [variables](https://github.com/vkdolea/age-system/wiki/Variables):
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

## Spaceship and Vehicle Controls
You can drag and drop Characters to Vehicles and Spaceships, so these passengers will be able to be selected for roles inside the vehicle/spaceship.

## Shortcuts
1. *Shift + Click* on Attack or Damage rolls trigger GM roll (only GM can see).
2. *CTRL + Click* on Damage rolls adds +1D6 to the total.
3. *CTRL + ALT + Click* on Damage rolls adds +2D6 to the total.
4. *ALT + Click* on Attack, Focus, Ability or Damage rolls to add Roll Options.
5. *Right Click* on Focus in the character sheet opens a context menu with options to roll it with another Ability, show on Chat, edit and delete.
6. *Drag and drop* a owned Weapon or owned Power to macrobar to create a macro.

## [Modifiers](https://github.com/vkdolea/age-system/wiki/Modifiers)
A few items have a "Modifiers" section. Modifiers will only apply when the item is equiped/activated (i.e., **shield icon** in character sheet without opacity).
The checkbox must be checked to have the mod active in the item.
Bonuses for maneuvers are on top of the normal bonuses granted by the maneuver.
Here the description of each one of the Modifiers:
1. **Damage (this item):** adds damage when using damage roll for tha particular item (useful only for Weapon and Power & Arcana).
2. **Damage (all):** adds the damage to all types of damage rolls.
3. **Tests (this item):** add a bonus to all use rolls for that item (using the dice icon to roll).
3. **Test (all):** general bonus adding to all tests, except for attack/damage rolls.
4. **Impact Armor:** adds to Impact Armor. *When Ballistic armor is not used, Impact Armor is the mod to use to add into Armor.*
5. **Ballistic Armor:** mod ading to Ballistic armor.
6. **Toughness:** value added to Toughness stats.
7. **Defend Maneuver:** the value here adds to the bonus granted by the Defend maneuver.
8. **Guard Up Maneuver:** this mod adds up to the Guard Up bonus.
9. **All-Out Attack:** bonus to damage caused by All-Out Attack.
10. **Max Health or Max Fortune:** added to character's maximum Health/Fortune.
11. **Max Conviction:** added to character's maximum Conviction.
12. **Max Power Points:** added to character's maximum Power Points.
13. **Power Force (this item):** added to item's Power Force. Only useful for Power & Arcana.
14. **Power Force (all):** added to Power Force from every single Power & Arcana.
15. **Power Force (Focus):** added to Power Force from every single Power & Arcana using the informed Focus.
16. **Aim:** extra bonus added to attack rolls when Aim maneuver is used, besides the standard value.
17. **Ability Names:** these bonuses apply to specific Ability.
17. **Ability Names (test only):** these are applied only to Ability tests (no impact on damage/derived calculation).
19. **Speed:** adds to Speed Mod field.
20. **Focus:** adds bonus to Focus maching the name, as long as the character has the given Focus on its character sheet.
21. **Attack Bonus:** adds to attack rolls.
22. **Defense:** value added to owners' Defense stats.
23. **Armor Strain:** this is the extra Power/Spell/Magic Points necessary to cast a spell when wearing the item bearing this mod.

## Credits
## Contributors
A few brave joined forces to improve this system code and this is the place where their names are registered never to be forgotten:

- [ForjaSalvaje](https://github.com/ForjaSalvaje)
- [Peter](https://github.com/architech99)
- [lipefl](https://github.com/lipefl)
- [p-arth](https://github.com/p-arth)
- [lozanoje](https://github.com/lozanoje)
- [Txus](https://github.com/Txus5012)
- [jaypoulz](https://github.com/jaypoulz)
- [BoltsJ](https://github.com/BoltsJ)

### Icons
Icons were used from [game-icons.net](https://game-icons.net). These icons were published under [CC BY 3.0](http://creativecommons.org/licenses/by/3.0/) license. Here is a list of all icons used:
- [Sensuousness](https://game-icons.net/1x1/lorc/sensuousness.html) (Character icon), by [Lorc](https://lorcblog.blogspot.com/).
- [Chariot](https://game-icons.net/1x1/cathelineau/chariot.html) (Vehicle icon), by [Cathelineau](his link reference is game-icons.net itself).
- [Rocket](https://game-icons.net/1x1/lorc/rocket.html) (Spaceship icon), by [Lorc](https://lorcblog.blogspot.com/).
- [Barracks Tent](https://game-icons.net/1x1/delapouite/barracks-tent.html) (Organization icon), by [Delapouite](https://delapouite.com/).
- [Split Cross](https://game-icons.net/1x1/lorc/split-cross.html) (Stunt icon), by [Lorc](https://lorcblog.blogspot.com/).
- [Embrace Energy](https://game-icons.net/1x1/lorc/embrassed-energy.html) (Power & Arcana icon), by [Lorc](https://lorcblog.blogspot.com/).
- [Gift of Knowledge](https://game-icons.net/1x1/lorc/gift-of-knowledge.html) (Focus icon), by [Lorc](https://lorcblog.blogspot.com/).
- [Backup](https://game-icons.net/1x1/lorc/backup.html) (Membership icon), by [Lorc](https://lorcblog.blogspot.com/).
- [Skills](https://game-icons.net/1x1/delapouite/skills.html) (Talent icon), by [Delapouite](https://delapouite.com/).
- [Player Next](https://game-icons.net/1x1/delapouite/player-next.html) (Relationship icon), by [Delapouite](https://delapouite.com/).
- [Briefcase](https://game-icons.net/1x1/delapouite/briefcase.html) (General Equipment icon), by [Delapouite](https://delapouite.com/).
- [Rank 3](https://game-icons.net/1x1/skoll/rank-3.html) (Honorifics icon), by [Skoll](https://game-icons.net) (his link reference is game-icons.net itself).
- [Fist](https://game-icons.net/1x1/skoll/fist.html) (Weapon icon), by [Skoll](https://game-icons.net) (his link reference is game-icons.net itself).
- [Processor](https://game-icons.net/1x1/lorc/processor.html) (Spaceship Features icon), by [Lorc](https://lorcblog.blogspot.com/).

### Token Stats Icons
Icons made by:
- [Delapouite](https://delapouite.com/), [DarkZaitev](http://darkzaitzev.deviantart.com/), [Lorc](https://lorcblog.blogspot.com/), [Skoll](https://game-icons.net),   from [game-icons.net](https://game-icons.net/).

### Localization
Do you want to help with localization? Take a look at [this wiki entry!](https://github.com/vkdolea/age-system/wiki/Localization)
- **French**: by Discord users *Imposator#8090* & *Abdanck#2003*.
- **Brazilian Portuguese**: by Discord user *Leandro_Soares#9067* and me.
- **Spanish**: by Discord user *ForjaSalvaje#2419*.

## [Change log](https://github.com/vkdolea/age-system/blob/main/RELEASENOTES.md)
