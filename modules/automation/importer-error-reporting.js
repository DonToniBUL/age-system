const EXPECTED_IMPORTER_REJECTION_CODES = new Set([
  "AGE_IMPORT_ALREADY_CREATED",
  "AGE_IMPORT_AMBIGUOUS_SELECTION",
  "AGE_IMPORT_ASSISTANCE_REQUIRED",
  "AGE_IMPORT_COMMIT_IN_FLIGHT",
  "AGE_IMPORT_DOCUMENT_MISSING",
  "AGE_IMPORT_DROP_EMBEDDED",
  "AGE_IMPORT_DROP_HIDDEN",
  "AGE_IMPORT_DROP_INVALID",
  "AGE_IMPORT_DROP_PROFILE",
  "AGE_IMPORT_DROP_SUBTYPE",
  "AGE_IMPORT_DROP_TYPE",
  "AGE_IMPORT_INJURY_CONFIRMATION_REQUIRED",
  "AGE_IMPORT_INJURY_DAMAGE_REQUIRED",
  "AGE_IMPORT_INJURY_FORMULA_STALE",
  "AGE_IMPORT_INJURY_NOT_APPLICABLE",
  "AGE_IMPORT_INJURY_SOURCE_INVALID",
  "AGE_IMPORT_INJURY_SOURCE_LOCKED",
  "AGE_IMPORT_INPUT_STALE",
  "AGE_IMPORT_INPUT_TOO_LARGE",
  "AGE_IMPORT_ITEM_TYPE_UNSUPPORTED",
  "AGE_IMPORT_MATCH_STALE",
  "AGE_IMPORT_NO_TEXT",
  "AGE_IMPORT_PARSED_STALE",
  "AGE_IMPORT_PERMISSION",
  "AGE_IMPORT_PLAN_STALE",
  "AGE_IMPORT_PREVIEW_BLOCKED",
  "AGE_IMPORT_PREVIEW_EXPIRED",
  "AGE_IMPORT_PREVIEW_INVALID",
  "AGE_IMPORT_SELECTION_STALE",
  "AGE_IMPORT_SELECTION_UNVERIFIED",
  "AGE_IMPORT_SESSION_OWNER",
  "AGE_IMPORT_SETTINGS_STALE",
  "AGE_IMPORT_SOURCE_STALE",
  "AGE_IMPORT_TALENT_DEGREE_RANGE",
  "AGE_IMPORT_TOO_MANY_BLOCKS",
]);

export function importerUiError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function isExpectedImporterRejection(error) {
  return EXPECTED_IMPORTER_REJECTION_CODES.has(String(error?.code ?? ""));
}

export function reportImporterActionFailure(error, {
  consoleObject = globalThis.console,
  notifications = globalThis.ui?.notifications,
  unexpectedMessage = null,
} = {}) {
  const message = error?.message ?? String(error);
  const expected = isExpectedImporterRejection(error);
  if (expected) notifications?.warn?.(message);
  else {
    consoleObject?.error?.("AGE System | Importer action failed.", error);
    notifications?.error?.(unexpectedMessage ?? message, {permanent: true});
  }
  return expected;
}

