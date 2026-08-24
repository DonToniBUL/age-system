const SYSTEM_ID = "age-system";

export function isAssistMode() {
  try {
    return game.settings.get(SYSTEM_ID, "automationMode") === "assist";
  } catch {
    return false;
  }
}

export function automationFeatureEnabled(settingKey) {
  if (!isAssistMode()) return false;
  if (!settingKey) return true;
  try {
    return game.settings.get(SYSTEM_ID, settingKey) !== false;
  } catch {
    return false;
  }
}

export function requireAssistMode() {
  if (isAssistMode()) return true;
  throw new Error(game.i18n.localize("age-system.AUTOMATION.disabled"));
}

export default isAssistMode;
