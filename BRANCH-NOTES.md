# AGE System fork update notes

This branch updates DonToniBUL's existing fork from **5.0.7** to **5.4.1-rc.3**. It keeps the `age-system` package identity and credits VK Dolea's original AGE System. Foundry VTT 14.366 is the target; 14.365 is the minimum.

## Short descriptions of each update

| Version | Easy explanation |
| --- | --- |
| 5.1.0 | Adds guided character creation, level advancement, and GM-authored progression definitions. |
| 5.1.1 | Improves progression choices, workflow refresh, and definition lifecycle checks. |
| 5.1.2 | Updates progression compatibility for Foundry 14.366. |
| 5.1.3 | Makes progression stages and choices easier to navigate and author. |
| 5.1.4 | Checks that advancement follows the character's correct profile, track, and source. |
| 5.1.5 | Checks whether a progression can actually run before offering a preview; explains blocked choices. |
| 5.2.0 | Expands guided progression with typed questions, workflow stages, and DefinitionV2 support. |
| 5.2.1 | Makes the GM's progression editor clearer, with validation and protection for unsaved changes. |
| 5.2.2 | Improves sheet scrolling, Power descriptions, colour contrast, and the Vehicle description editor. |
| 5.2.3 | Adds an illustrated beginner's handbook for character creation and advancement. |
| 5.2.4 | Adds a guided importer with text cleanup, clearer previews, source choices, and checks before creation. |
| 5.3.0 | Adds NPC Studio for creating NPCs from a blank form, pasted stat block, or existing character. |
| 5.3.1 | Improves NPC/importer source matching and Modern AGE Injury damage review. |
| 5.3.2 | Adds Mass Battle Forces and keeps each user's colour choice separate for each world. |
| 5.3.3 | Refreshes Advanced Tests and Requested Rolls with clearer, responsive windows and chat cards. |
| 5.4.0 | Refreshes nine utility windows, including Stunt Assistant, recovery, settings, and Conditions Workshop. |
| 5.4.1-rc.1 and rc.2 | Fixes secret-content display, coordinates Power Point spending/refunds/undo, and strengthens Stunt undo, condition processing, and text preservation. |
| 5.4.1-rc.3 | Adds a title-bar switch between Full and Stat Block V2 character sheets; pending edits save first. |

Existing AGE Actions, Rule Profiles, library search, multi-target attacks, Power resistance, and selectable AppV1 fallback sheets are retained. The public integration API moves from 1.2.0 to 1.4.0, adding progression and NPC Studio capabilities.

## Compatibility and installation

The package ID remains `age-system`, so this is an update of the existing system. No new document migration is introduced by rc.3. Progression Profiles and game content libraries remain separate installations, and unmapped rules still need manual review. Follow the [manual installation steps](README.md#install-manually).

Paid Power use requires an active GM. Use Stunt Assistant for Stunt undo; changed effects or damage already used in a roll may require GM review.

## Validation status

This is a **release candidate**. Recorded verification includes 37 offline regression tests, nine focused live sheet-switch checks on Foundry 14.366, and player ownership and locked-compendium checks. The rc.2 full harness recorded 54 passes, five warnings, and one outdated System 5.4.0 version-check failure. The full harness was not rerun for rc.3; GM failover and every third-party module combination are not certified.

## Earlier versions and attribution

The 5.0.7 and v14 foundation branches remain available. The [older Active Effects handbook](docs/AGE-System-5.0.7-Active-Effects-Handbook.pdf) describes the retained 5.0.7 baseline. This fork preserves [VK Dolea's original project](https://github.com/vkdolea/age-system), [license](LICENSE), contributor credits, and [third-party notices](THIRD-PARTY-NOTICES.md).
