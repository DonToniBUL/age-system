# AGE System 5.0.7 automation branch

This isolated branch preserves the community-tested AGE System 5.0.7 automation baseline for Foundry VTT 14.365 and 14.366. It is kept separate from the lean `codex/v14-foundation` branch and from the upstream creator repository.

## Included

- AppV2 Actor and Item sheets with selectable AppV1 fallbacks
- Transactional AGE Actions, previews, receipts, rollback, and undo safeguards
- Rule Profiles and the Unified AGE Library
- Multi-target attacks and Power resistance
- Power Point and Stunt spending safeguards
- Stunt Assistant, combat lifecycle assistance, and Advanced Tests
- Active Effect actions, conditions, timed expiration, and v14 normalization
- Preview-first AGE Importer v2 with clipboard cleanup, exact world/compendium matching, searchable suggestions, and editable preview
- Foundry v14 token resource-bar compatibility
- Operations, diagnostics, validation, and migration preview tools

This branch does not include the later 5.1 Definition-driven Character Builder and Advancement Center.

## Manual installation

1. Download this branch as a ZIP from GitHub.
2. Extract its inner folder into Foundry's `Data/systems` directory.
3. Rename the extracted folder to `age-system` if necessary.
4. Back up the world, restart Foundry, and test in a test world before using it with campaign data.

The manifest deliberately has no automatic update or download URL. Updating is manual so this retained branch cannot silently replace another AGE System line.

## Documentation

- [Active Effects Handbook](docs/AGE-System-5.0.7-Active-Effects-Handbook.pdf)
- [Safe Automation](SAFE-AUTOMATION.md)
- [Integration API](API.md)
- [Foundry v14 compatibility](V14-COMPATIBILITY.md)

## Lineage and license

The AGE System was created and is maintained upstream by VK Dolea. This retained branch preserves the original author attribution and license. See [the upstream repository](https://github.com/vkdolea/age-system) for the creator's official development line.

