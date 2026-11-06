const MAX_FORMULA_LENGTH = 64;
const MAX_DICE = 20;
const MAX_FLAT_BONUS = 60;
const MAX_INJURY_DAMAGE = 40;

/**
 * Suggest Modern AGE Injury damage from a conventional AGE damage formula.
 *
 * This helper deliberately does not use Roll, eval, or formula substitution.
 * Only a bounded sum of d3/d6 terms plus one optional non-negative flat bonus
 * is accepted. Anything requiring rules context or interpretation fails closed.
 *
 * Modern AGE converts every damage die (whether d3 or d6) to one Injury damage
 * and each started group of three points of flat damage to one further Injury
 * damage.
 *
 * @param {unknown} formula Ordinary AGE damage formula.
 * @returns {number|null} Suggested Injury damage, or null when unsupported.
 */
export function suggestInjuryDamageFromFormula(formula) {
  if (typeof formula !== "string" || !formula.trim() || formula.length > MAX_FORMULA_LENGTH) return null;
  const normalized = formula
    .normalize("NFKC")
    .replace(/[\u00a0\u2007\u202f]/gu, " ")
    .trim();
  if (!normalized || normalized.length > MAX_FORMULA_LENGTH) return null;

  const terms = normalized.split(/\s*\+\s*/u);
  if (terms.length === 0 || terms.some(term => !term)) return null;

  let dice = 0;
  let flatBonus = 0;
  let hasFlatBonus = false;
  for (const term of terms) {
    const diceMatch = term.match(/^(\d{0,2})\s*d\s*([36])$/iu);
    if (diceMatch) {
      const count = diceMatch[1] === "" ? 1 : Number(diceMatch[1]);
      if (!Number.isInteger(count) || count < 1 || count > MAX_DICE) return null;
      dice += count;
      if (dice > MAX_DICE) return null;
      continue;
    }

    if (!/^\d{1,2}$/u.test(term) || hasFlatBonus) return null;
    flatBonus = Number(term);
    hasFlatBonus = true;
  }

  if (!Number.isInteger(dice) || dice < 1 || dice > MAX_DICE) return null;
  if (!Number.isInteger(flatBonus) || flatBonus < 0 || flatBonus > MAX_FLAT_BONUS) return null;

  const injuryDamage = dice + Math.ceil(flatBonus / 3);
  return Number.isInteger(injuryDamage) && injuryDamage >= 1 && injuryDamage <= MAX_INJURY_DAMAGE
    ? injuryDamage
    : null;
}
