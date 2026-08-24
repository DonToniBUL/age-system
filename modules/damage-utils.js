/**
 * Normalize AGE damage data across the different health-system presets.
 * Dragon AGE/Fantasy AGE use a single Armor Rating, while Modern AGE uses
 * impact/ballistic/penetrating sources.
 */

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback) || 0;
}

function modifierValue(modifier) {
  return finiteNumber(modifier?.formParts?.detValue ?? modifier?.detValue ?? modifier?.value, 0);
}

export function normalizeDamageSource(source, healthSys = {}) {
  if (healthSys?.useBallistic) {
    return ["impact", "ballistic", "penetrating"].includes(source) ? source : "impact";
  }
  return source === "penetrating" ? "penetrating" : "normalDamage";
}

export function buildDamageTargetData(actor) {
  const system = foundry.utils.deepClone(actor?.system ?? {});
  system.health ??= {};
  system.health.value = finiteNumber(system.health.value, 0);
  system.injury ??= {};
  system.injury.marks = finiteNumber(system.injury.marks, 0);
  system.injury.degrees ??= {};
  system.ownedMods ??= {};
  system.abilities ??= {};
  system.classBonuses ??= {};
  system.armor ??= {};
  system.armor.toughness ??= {};

  const impactFallback = modifierValue(system.ownedMods.impactArmor);
  const ballisticFallback = modifierValue(system.ownedMods.ballisticArmor);
  const toughnessModFallback = modifierValue(system.ownedMods.toughness);
  const constitution = finiteNumber(system.abilities?.cons?.total, system.abilities?.cons?.value);

  system.armor.impact = finiteNumber(system.armor.impact, impactFallback);
  system.armor.ballistic = finiteNumber(system.armor.ballistic, ballisticFallback);
  system.armor.toughness.mod = finiteNumber(system.armor.toughness.mod, toughnessModFallback);
  system.armor.toughness.gameModeBonus = finiteNumber(system.armor.toughness.gameModeBonus, 0);
  system.armor.toughness.total = finiteNumber(
    system.armor.toughness.total,
    constitution + system.armor.toughness.gameModeBonus + system.armor.toughness.mod + finiteNumber(system.classBonuses.toughness, 0)
  );
  system.testMod = finiteNumber(system.testMod, modifierValue(system.ownedMods.testMod));
  return {system, hasPlayerOwner: Boolean(actor?.hasPlayerOwner)};
}

export {finiteNumber};
