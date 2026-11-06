# NPC Studio: a Game Master's Guide

NPC Studio creates adversaries and supporting characters for AGE games. It is part of AGE System and does not require AGE Creature Forge or another Foundry module.

Nothing is added to your world while you choose or review values. The Studio creates one new Actor only after you reach Review and select **Create NPC**.

## Before you begin

1. Open your Foundry world as a Game Master.
2. Open **Game Settings → Configure Settings → AGE System**.
3. Check the active rule profile. This controls the abilities, names, resources, armor fields, and compatible pasted-stat-block layout used by NPC Studio.
4. Back up an important world before installing or testing a new AGE System candidate.

Open **AGE Toolbox** from the scene controls, then select **NPC Studio**. You can also right-click a Character in the Actor Directory and select **Clone in NPC Studio**.

## The six stages

### 1. Choose a source

Choose one route:

- **Blank NPC** starts with a conservative empty draft for the active profile.
- **Paste stat block** reads compatible text copied from a searchable PDF or other text source. Review every parsed value; a parser cannot interpret page layout or ambiguous rules perfectly.
- **Clone Actor** starts from an existing visible Character. Clone always creates a separate Actor. It never updates or replaces the original.

Changing the source or profile invalidates an older review. This is expected: select **Refresh preview** after completing the new draft.

### 2. Identity

Enter the NPC's name and the identity fields relevant to the profile. Depending on the AGE game, these can be Race or Ancestry, Class or Profession, Background, role, level, or threat.

The compact AppV2 Character Stat Block is the default sheet because it is suited to adversaries. You may choose a different AGE Character sheet later through Foundry's normal Sheet Configuration.

### 3. Statistics

Enter ability ratings and combat or resource values. NPC Studio shows only fields relevant to the active profile.

- **Dragon AGE** uses the Dragon AGE ability set, Race/Class vocabulary, Health, Defense, Speed, Armor, and Mana where relevant.
- **Fantasy AGE 1e** uses the nine standard abilities, Race and Class vocabulary, Health, Defense, Speed, Armor, and Magic Points where relevant.
- **Fantasy AGE 2e** uses the same main ability family with Ancestry terminology and the configured second-edition profile options.
- **Modern AGE Core** uses Profession-oriented identity, Modern AGE defenses and armor, Health, and Power Points when enabled.
- **Modern AGE Mastery/Injury** keeps its injury-model distinctions and does not silently convert them to ordinary Health rules.

Values shown on a prepared Character sheet can include bonuses from embedded Items. Clone reads the Actor's stored raw values, then copies only the Items selected in the Studio. This prevents the same Item bonus from being counted twice. If prepared current Health is above the stored base because of derived bonuses, the clone draft keeps the stored base and clamps current Health to it; review and adjust that value before creation if the NPC should begin injured or receive a different base.

### 4. Content

Add the Foci, weapons, powers, talents, stunts, equipment, relationships, honorifics, memberships, or custom attacks/features the NPC needs.

Search results include visible world Items and readable compendia. Selecting a library Item copies its safe persisted source into the new Actor at commit time. The source is checked again immediately before creation. If it disappears or changes, the Studio asks for a fresh review instead of guessing.

For pasted stat blocks, NPC Studio first looks for an exact normalized name and Item-type match in compatible world Items, then in visible profile-compatible compendia in stable order. One exact candidate is selected for reuse by default. If two or more exact candidates have the same name and type, including a world/compendium pair, the Studio does not guess: choose one explicit source or **Create custom instead**. Fuzzy matches remain suggestions and are never selected automatically.

Parsed Focus ability/bonus and Talent or Specialization degree are kept as signed Actor-specific overlays on the embedded copy; the reusable world or compendium source is never modified. Talent degree is limited to the active profile's configured vocabulary. A Specialization remains a Foundry `talent` Item with subtype `spec`, so a same-name regular Talent cannot silently replace it.

You can also drag a supported Item from the Items Directory or a readable compendium onto the marked drop area. NPC Studio resolves the real Foundry document, checks its type and visibility, rejects duplicates, and then adds it to the same signed review path as a search result. The safe Character content set is Equipment, Focus, Weapon, Power, Talent, Stunt, Relationship, Honorific, and Membership.

Custom content remains embedded in the new Actor. NPC Studio does not create reusable top-level world Items while you are editing a draft.

Under **Modern AGE Mastery/Injury**, each custom weapon also needs an Injury damage value. NPC Studio may suggest one from a simple printed sum of `d3` and `d6` damage dice with one flat bonus, but the suggestion is only a starting point: compare it with the stat block, edit it if necessary, and select **Confirm Injury damage** before Review. Changing either damage field clears that confirmation. A reused world or compendium weapon keeps its stored Injury value; NPC Studio never rewrites the source or silently repairs a missing/placeholder source value.

Clone does not copy Class Items, Progression Definition Items, ownership, folders, usage statistics, progression receipts, operational module flags, or Active Effects automatically.

### 5. Review and create

Review lists the Actor fields and the resolved embedded Items in the signed creation plan, along with warnings and blockers. A library Item's current stored name and type are shown even if the earlier selection label was stale. Preview is short-lived and bound to:

- your Foundry user;
- the active AGE profile;
- the normalized draft;
- the source Actor and library Items;
- the complete creation plan.

Immediately before creation, NPC Studio re-resolves each selected document and rechecks its visibility, type/subtype, active-profile compatibility, and signed source digest. **Create NPC** remains disabled while blockers exist or the preview is stale. Refreshing preview does not create anything. A rapid double-click cannot create two Actors from the same preview.

### 6. Result and undo

After creation, use **Open Actor** to inspect the new NPC. The result also retains a creation receipt for audit and safe undo.

Undo has its own preview and confirmation. It removes the new Actor only if the Actor still matches the exact source recorded immediately after creation. If you edit the Actor, add an Item, change ownership, or another module changes its source, undo refuses to delete it. Delete or revise that Actor manually after checking the changes you want to preserve.

## Paste tips

- Copy one complete stat block without page headers, footers, or unrelated columns when possible.
- Select the parser layout offered for the active profile. Modern AGE layouts may require an explicit Major or Minor format choice.
- Paste normalization is deliberately bounded: NFKC also expands compatibility ligatures, while known spacing, invisible-character, soft-hyphen, dash, bullet, and word-wrap damage is repaired only around recognized AGE labels, headings, and Talent/Specialization ranks. Arbitrary narrative prose is not rewritten.
- Exact Relationship(s), Membership(s), and Honorifics headings create native Relationship, Membership, and Honorific Items. Ordinary prose using those words remains ordinary feature text.
- Fantasy AGE 2e accepts both score-first lines such as `2 ACCURACY (Bite)` and name-first lines such as `Accuracy 2 (Bite)`. Paste all nine abilities; a malformed or incomplete mandatory ability block is reported for correction instead of filling unseen scores with zero.
- Read normalization notes and compare the parsed abilities, defenses, attacks, and features with the source.
- Correct uncertain values in the editable Studio draft before Review.
- For Modern AGE Mastery/Injury attacks, compare the Injury suggestion with the printed attack and explicitly confirm it. Variables, dice other than `d3`/`d6`, subtraction, prose, and other ambiguous formulas are not guessed.
- Unsupported Expanse layouts remain blocked until AGE System has a matching active rule profile; the Studio does not substitute another game line.

## Troubleshooting

**Create NPC is disabled**  
Complete the fields named in the blocker summary, choose a source for unresolved content, and refresh the preview.

**The preview became stale**  
The profile, draft, source Actor, library Item, or signed plan changed. Refresh preview and review the differences.

**A compendium result is missing**  
Confirm the pack is enabled and readable by your user. Hidden or inaccessible documents are never exposed through search.

**A dropped Item is refused**  
Drop an Item rather than an Actor or folder, and use a supported content type from a visible world collection or readable compendium. Embedded Items from another Actor are not accepted as reusable library sources.

**An Injury weapon blocks Review**  
Enter an Injury value from 1 to 40 and explicitly confirm it. If a reused library weapon contains no valid Injury value, choose a corrected compatible source or **Create custom instead** and review the value yourself.

**Undo is refused**  
The Actor changed after creation, the receipt does not match, the preview expired, or a different user is attempting the undo. This safeguard prevents deletion of later work.

**The pasted block is not recognized**  
Check the active profile and parser layout, remove unrelated page text, and try again. If the source format is unsupported, begin with Blank NPC and enter the values manually.
