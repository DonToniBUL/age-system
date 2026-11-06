# AGE System community fork

This is DonToniBUL's community fork of [VK Dolea's AGE System](https://github.com/vkdolea/age-system), an unofficial implementation of Green Ronin's AGE games for Foundry VTT. It builds on the original project and keeps the existing `age-system` package identity, author attribution, and license.

**Current version: 5.4.1-rc.3**, a release candidate for Foundry VTT **14.366** (minimum 14.365). It supports Dragon AGE, Fantasy AGE, and Modern AGE workflows. Game-specific content libraries and **AGE Progression Profiles** are separate packages; available automation depends on the installed content and selected rules.

## Changes since the uploaded 5.0.7 version

| Change | What it means for you |
| --- | --- |
| Character Builder | Create a character step by step and review the result before saving. |
| Advancement Center | Review level-up choices and apply them together, with undo when later edits do not conflict. |
| Progression tools | GMs can create and edit the definitions used for character creation and advancement. |
| NPC Studio | Make an NPC from scratch, paste a stat block, or clone an existing character. |
| Improved importing | Review imported information, choose matching Items, and check Modern AGE Injury damage before creating documents. |
| Mass battles | Track armies, commanders, battle stages, and casualties on a dedicated Force sheet. |
| Clearer windows and colours | Updated tools fit smaller windows, and each world remembers your chosen colour palette. |
| Safer spending and undo | Power Point spending, refunds, and undo share the active GM's queue. Stunt undo and condition assistance gain extra checks. |
| Sheet switching | A title-bar button switches between Full and Stat Block V2 character sheets after saving pending edits. |
| Display and editing fixes | Secret-only descriptions stay hidden, and opening sheets preserves stored text. |

See [the short version-by-version notes](BRANCH-NOTES.md) or [the detailed release notes](RELEASENOTES.md).

## Install manually

1. Back up your Foundry world and stop Foundry before replacing the system.
2. Use **Code → Download ZIP** on this branch and extract the ZIP.
3. Put the extracted system folder in your Foundry user-data directory under `Data/systems/` and rename it to `age-system`. The manifest must be directly at `Data/systems/age-system/system.json`.
4. Install any required Profiles or content libraries separately under `Data/modules/`.
5. Restart Foundry and check the release candidate in a copied test world before using it for a campaign.

This branch uses manual updates. Its manifest has no automatic-update or download URL. The older 5.0.7 and v14 foundation branches remain available for reference.

## Guides

- [Character creation and advancement handbook](USER-GUIDE-PROGRESSION.md)
- [NPC Studio guide](NPC-STUDIO.md)
- [Safe automation guide](SAFE-AUTOMATION.md)
- [Progression definitions and integration](PROGRESSION.md)
- [Integration API](API.md)
- [Foundry v14 compatibility](V14-COMPATIBILITY.md)
- [Original project wiki](https://github.com/vkdolea/age-system/wiki)
- [Older 5.0.7 Active Effects handbook](docs/AGE-System-5.0.7-Active-Effects-Handbook.pdf)

Rules that have no supported mapping still require manual review; the system does not include the game books or their compendia.

## Release candidate checks

Recorded checks include **37 offline regression tests**, **nine focused live sheet-switch checks**, and player ownership and locked-compendium checks. The earlier full rc.2 harness recorded **54 passes, five warnings, and one outdated version-check failure**. It was not rerun in full for rc.3, so this remains a release candidate. Paid Power use requires an active GM; use Stunt Assistant for Stunt undo.

The repository update preserves the installed rc.3 runtime files. The README and branch notes explain the version published here.

## Project lineage and licenses

AGE System was created by **VK Dolea**. This community fork retains the [Apache 2.0 license](LICENSE), original credits, and [third-party notices](THIRD-PARTY-NOTICES.md), including the MIT notice for adapted NPC Studio work.

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
- [Chariot](https://game-icons.net/1x1/cathelineau/chariot.html) (Vehicle icon), by [Cathelineau](https://game-icons.net/).
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

## [Change log](RELEASENOTES.md)
