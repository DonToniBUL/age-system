const FLAG_SCOPE = "age-system";
const FLAG_KEY = "sheetPositions";
const SAVE_DELAY_MS = 350;

const finiteNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function viewportSize() {
  return {
    width: Math.max(320, finiteNumber(globalThis.window?.innerWidth) ?? 1920),
    height: Math.max(240, finiteNumber(globalThis.window?.innerHeight) ?? 1080)
  };
}

function documentPositionKey(sheet) {
  const document = sheet.document ?? sheet.actor ?? sheet.object;
  const uuid = document?.uuid ?? document?.id ?? "unknown";
  return `${sheet._agePositionConfig.key}:${uuid}`;
}

function normalizePosition(position = {}, config, {stored = false} = {}) {
  const viewport = viewportSize();
  const maximumWidth = Math.max(config.minWidth, Math.min(config.maxWidth, viewport.width - 24));
  const maximumHeight = Math.max(config.minHeight, Math.min(config.maxHeight, viewport.height - 24));

  let width = finiteNumber(position.width);
  let height = finiteNumber(position.height);

  // v4.2.0/4.2.1 could persist a full-sheet or viewport-sized block window.
  // Reject those dimensions instead of merely clamping them to another large size.
  const extremeStoredWidth = stored && config.rejectOversize && width !== null && width > config.maxWidth;
  const extremeStoredHeight = stored && config.rejectOversize && height !== null && height > config.maxHeight;
  if (extremeStoredWidth) width = config.defaultWidth;
  if (extremeStoredHeight) height = config.defaultHeight;

  width = clamp(width ?? config.defaultWidth, Math.min(config.minWidth, maximumWidth), maximumWidth);
  height = clamp(height ?? config.defaultHeight, Math.min(config.minHeight, maximumHeight), maximumHeight);

  const normalized = {width, height};
  const left = finiteNumber(position.left);
  const top = finiteNumber(position.top);
  if (left !== null) normalized.left = clamp(left, 0, Math.max(0, viewport.width - Math.min(width, 120)));
  if (top !== null) normalized.top = clamp(top, 0, Math.max(0, viewport.height - 80));
  const scale = finiteNumber(position.scale);
  if (scale !== null && scale > 0) normalized.scale = scale;
  return normalized;
}

function getStoredPosition(sheet) {
  const positions = game.user?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
  if (!positions || typeof positions !== "object" || typeof positions.then === "function") return null;
  return positions[documentPositionKey(sheet)] ?? null;
}

function sheetIsMinimized(sheet) {
  return sheet?._minimized === true;
}

function sheetIsClosing(sheet) {
  const states = sheet?.constructor?.RENDER_STATES;
  return sheet?.closing === true || (states?.CLOSING !== undefined && sheet?._state === states.CLOSING);
}

/** Configure defaults and restore this user's saved dimensions for a sheet type/document pair. */
export function configurePersistentSheetPosition(sheet, options) {
  const config = {
    key: options.key,
    defaultWidth: options.defaultWidth,
    defaultHeight: options.defaultHeight,
    minWidth: options.minWidth ?? 360,
    minHeight: options.minHeight ?? 320,
    maxWidth: options.maxWidth ?? 1600,
    maxHeight: options.maxHeight ?? 1200,
    rejectOversize: options.rejectOversize ?? false
  };
  sheet._agePositionConfig = config;

  const stored = getStoredPosition(sheet);
  const target = normalizePosition(stored ?? {}, config, {stored: Boolean(stored)});
  sheet._ageInitialPosition = target;
  sheet._ageInitialPositionApplied = false;
  sheet._agePositionReadyToPersist = false;
  Object.assign(sheet.options, target);
  Object.assign(sheet.position, target);
  return target;
}

/** Ensure inherited render options cannot replace the saved compact/full size. */
export function persistentSheetRenderOptions(sheet, options = {}) {
  if (!sheet?._agePositionConfig || sheet._ageInitialPositionApplied) return options;
  return {...options, ...sheet._ageInitialPosition};
}

/**
 * Re-apply the requested position after ApplicationV1 has injected the window.
 * Foundry can refit a newly-rendered V1 sheet to its content, which previously
 * allowed long stat-block text to expand the outer window to the viewport.
 */
export function enforcePersistentSheetPosition(sheet) {
  if (!sheet?._agePositionConfig || sheet._ageInitialPositionApplied || sheetIsMinimized(sheet)) return;
  sheet._ageInitialPositionApplied = true;
  const target = normalizePosition(sheet._ageInitialPosition ?? {}, sheet._agePositionConfig);

  const apply = () => {
    if (sheetIsMinimized(sheet) || sheetIsClosing(sheet)) return;
    sheet._ageApplyingPersistentPosition = true;
    try {
      sheet.setPosition(target);
    } finally {
      sheet._ageApplyingPersistentPosition = false;
    }
  };

  apply();
  const raf = globalThis.requestAnimationFrame ?? (callback => setTimeout(callback, 0));
  raf(apply);
  sheet._agePositionReadyToPersist = true;
}

export async function savePersistentSheetPosition(sheet) {
  if (!sheet?._agePositionConfig || !game.user?.setFlag || sheetIsMinimized(sheet) || sheetIsClosing(sheet)) return false;
  const config = sheet._agePositionConfig;
  const position = normalizePosition(sheet.position ?? {}, config);
  const current = game.user.getFlag?.(FLAG_SCOPE, FLAG_KEY);
  const positions = current && typeof current === "object" && typeof current.then !== "function"
    ? foundry.utils.deepClone(current)
    : {};
  positions[documentPositionKey(sheet)] = position;
  await game.user.setFlag(FLAG_SCOPE, FLAG_KEY, positions);
  return true;
}

/** Debounce the normal ApplicationV1 setPosition stream from dragging/resizing. */
export function queuePersistentSheetPositionSave(sheet) {
  if (!sheet?._agePositionConfig || !sheet._agePositionReadyToPersist || sheet._ageApplyingPersistentPosition) return;
  clearTimeout(sheet._agePositionSaveTimer);
  sheet._agePositionSaveTimer = setTimeout(() => {
    if (sheetIsMinimized(sheet) || sheetIsClosing(sheet)) return;
    void savePersistentSheetPosition(sheet);
  }, SAVE_DELAY_MS);
}

/**
 * Kept as a small post-render hook for accessibility and old callers. Position
 * persistence itself is driven by the sheet's setPosition override, avoiding
 * pointer listeners on the header which interfered with double-click minimize.
 */
export function activatePersistentSheetPosition(sheet) {
  const wrapper = sheet.element?.[0] ?? sheet.element;
  if (!wrapper?.querySelector) return;
  const minimizeButton = wrapper.querySelector(".age-minimize-sheet");
  if (minimizeButton) {
    const label = game.i18n.localize("age-system.minimizeSheet");
    minimizeButton.title = label;
    minimizeButton.setAttribute("aria-label", label);
  }
}
