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
