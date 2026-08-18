import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
import path from "node:path";
import test from "node:test";

const modulePath = path.resolve("modules/data/character-source.js");
const {applyCharacterGameModeFallbacks, characterGameModeProfileUpdate} = await import(pathToFileURL(modulePath));

test("explicit legacy profile edits synchronize their authoritative source field", () => {
  assert.deepEqual(characterGameModeProfileUpdate("pulp", "health", "47"), {
    "system.gameMode.specs.pulp.health": 47,
    "system.health.set": 47
  });
  assert.deepEqual(characterGameModeProfileUpdate("pulp", "unknown", 2), {});
});

test("stored Character resources remain authoritative over game-mode presets", () => {
  const data = {
    health: {set: 43},
    defense: {gameModeBonus: 4},
    armor: {toughness: {gameModeBonus: 5}}
  };
  const stored = structuredClone(data);
  applyCharacterGameModeFallbacks(data, stored, {health: 20, defense: 1, toughness: 2});
  assert.deepEqual(data, stored);
});

test("legacy Characters missing direct resources can still use game-mode presets", () => {
  const data = {};
  applyCharacterGameModeFallbacks(data, {}, {health: 20, defense: 1, toughness: 2});
  assert.deepEqual(data, {
    health: {set: 20},
    defense: {gameModeBonus: 1},
    armor: {toughness: {gameModeBonus: 2}}
  });
});
