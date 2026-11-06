import {ageSystem} from "./config.js";

export const COLOR_SCHEMES = Object.freeze([
  "modern-blue",
  "fantasy-blue",
  "dragon-red",
  "ronin-green",
  "expanded-blue",
  "folded-purple",
  "select-one",
  "the-grey",
  "red-warrior",
  "never-dead"
]);

export const COLOR_SCHEME_USER_FLAG = "colorScheme";
export const COLOR_SCHEME_WORLD_DEFAULT_SETTING = "worldColorScheme";
export const COLOR_SCHEME_CLIENT_MIGRATION_SETTING = "colorSchemePreferenceMigrated";

let synchronizingClientPreference = false;

const COLOR_CLASS_PREFIX = "colorset-";
const NON_SCHEME_COLOR_CLASSES = new Set([
  "colorset-selection",
  "colorset-first-tier",
  "colorset-second-tier",
  "colorset-third-tier"
]);

export function normalizeColorScheme(value) {
  return COLOR_SCHEMES.includes(value) ? value : "fantasy-blue";
}

export function isColorScheme(value) {
  return COLOR_SCHEMES.includes(value);
}

/**
 * Resolve one user's palette inside one world. Existing user flags win. The
 * first world opened after this change adopts the old client preference once;
 * later worlds begin from their GM's world default instead of inheriting the
 * most recently visited world's palette.
 */
export function resolveColorSchemePreference({
  userPreference,
  legacyClientPreference,
  worldDefault,
  clientPreferenceMigrated = false
} = {}) {
  if (isColorScheme(userPreference)) return {value: userPreference, source: "user"};
  if (!clientPreferenceMigrated && isColorScheme(legacyClientPreference)) {
    return {value: legacyClientPreference, source: "legacy-client"};
  }
  return {value: normalizeColorScheme(worldDefault), source: "world-default"};
}

export function colorSchemeClass(value = ageSystem.colorScheme) {
  return `${COLOR_CLASS_PREFIX}${normalizeColorScheme(value)}`;
}

export function removeColorSchemeClasses(element) {
  if (!element?.classList) return element;
  for (const className of [...element.classList]) {
    if (!className.startsWith(COLOR_CLASS_PREFIX)) continue;
    if (NON_SCHEME_COLOR_CLASSES.has(className)) continue;
    element.classList.remove(className);
  }
  return element;
}

export function applyColorSchemeToElement(element, value = ageSystem.colorScheme) {
  if (!element?.classList) return normalizeColorScheme(value);
  const normalized = normalizeColorScheme(value);
  removeColorSchemeClasses(element);
  element.classList.add(colorSchemeClass(normalized));
  return normalized;
}

/**
 * Apply the selected client colour scheme immediately to every open AGE window.
 * Sheets still receive the same class during their render hook, so newly opened
 * documents and existing windows stay in sync without requiring a reload.
 */
export function applyColorScheme(value, {root = globalThis.document} = {}) {
  const normalized = normalizeColorScheme(value);
  ageSystem.colorScheme = normalized;

  if (!root?.querySelectorAll) return normalized;
  const elements = new Set([
    ...root.querySelectorAll(".window-app.age-system, .application.age-system, .age-system.colorset-selection"),
    ...root.querySelectorAll(".window-app.age-system form, .application.age-system form, form.colorset-selection")
  ]);
  for (const element of elements) applyColorSchemeToElement(element, normalized);
  return normalized;
}

/** Persist a settings-panel palette change on the current world's User. */
export async function persistCurrentWorldColorScheme(value) {
  const normalized = applyColorScheme(value);
  if (synchronizingClientPreference || !globalThis.game?.user?.setFlag) return normalized;
  await game.user.setFlag("age-system", COLOR_SCHEME_USER_FLAG, normalized);
  return normalized;
}

/**
 * Hydrate the client-facing settings control from the current world's User
 * flag. This intentionally updates local storage so legacy callers of
 * game.settings.get("age-system", "colorScheme") continue to receive the
 * resolved concrete palette, while the world User flag remains authoritative.
 */
export async function initializeWorldColorSchemePreference() {
  const userPreference = game.user?.getFlag?.("age-system", COLOR_SCHEME_USER_FLAG);
  const legacyClientPreference = game.settings.get("age-system", "colorScheme");
  const worldDefault = game.settings.get("age-system", COLOR_SCHEME_WORLD_DEFAULT_SETTING);
  const clientPreferenceMigrated = game.settings.get("age-system", COLOR_SCHEME_CLIENT_MIGRATION_SETTING) === true;
  const resolved = resolveColorSchemePreference({
    userPreference,
    legacyClientPreference,
    worldDefault,
    clientPreferenceMigrated
  });

  if (!isColorScheme(userPreference)) {
    await game.user?.setFlag?.("age-system", COLOR_SCHEME_USER_FLAG, resolved.value);
  }
  if (!clientPreferenceMigrated) {
    await game.settings.set("age-system", COLOR_SCHEME_CLIENT_MIGRATION_SETTING, true);
  }
  if (legacyClientPreference !== resolved.value) {
    synchronizingClientPreference = true;
    try {
      await game.settings.set("age-system", "colorScheme", resolved.value);
    } finally {
      synchronizingClientPreference = false;
    }
  }
  applyColorScheme(resolved.value);
  return resolved;
}
