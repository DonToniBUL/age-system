/**
 * Foundry VTT v14 dialog helpers.
 *
 * AGE templates historically include their own outer <form>. DialogV2 already
 * supplies the form which owns its action buttons, so strip that wrapper before
 * passing template content to DialogV2.
 */
export function unwrapDialogForm(content = "") {
  const html = String(content ?? "").trim();
  if (!/^<form(?:\s[^>]*)?>/i.test(html) || !/<\/form>$/i.test(html)) return html;
  return html
    .replace(/^<form(?:\s[^>]*)?>\s*/i, "")
    .replace(/\s*<\/form>$/i, "");
}

/** Resolve the form owned by a DialogV2 action button. */
export function getDialogForm(button, dialog) {
  const form = button?.form ?? dialog?.form ?? dialog?.element?.querySelector?.("form");
  if (!form) throw new Error("AGE System | Dialog form was not available.");
  return form;
}

/** Convert a DialogV2 form to Foundry's expanded form-data object. */
export function getDialogFormData(button, dialog) {
  const form = getDialogForm(button, dialog);
  return new foundry.applications.ux.FormDataExtended(form).object;
}

/**
 * Display a form dialog and resolve to its form data or {cancelled: true}.
 */
export async function showFormDialog({
  title,
  content,
  confirmLabel = game.i18n.localize("age-system.confirm"),
  cancelLabel = game.i18n.localize("age-system.cancel"),
  confirmIcon = "fa-solid fa-check",
  cancelIcon = "fa-solid fa-xmark",
  width = null,
  modal = true,
  transform = null,
} = {}) {
  const config = {
    window: {title},
    content: unwrapDialogForm(content),
    modal,
    rejectClose: false,
    buttons: [
      {
        action: "confirm",
        label: confirmLabel,
        icon: confirmIcon,
        default: true,
        callback: async (event, button, dialog) => {
          const data = getDialogFormData(button, dialog);
          return transform ? await transform(data, {event, button, dialog}) : data;
        },
      },
      {
        action: "cancel",
        label: cancelLabel,
        icon: cancelIcon,
        callback: async () => ({cancelled: true}),
      },
    ],
  };
  if (width) config.position = {width};
  const result = await foundry.applications.api.DialogV2.wait(config);
  return result ?? {cancelled: true};
}

/** Display a yes/no confirmation dialog. */
export async function showConfirmDialog({
  title,
  content,
  yesLabel = game.i18n.localize("age-system.confirm"),
  noLabel = game.i18n.localize("age-system.cancel"),
  defaultYes = false,
  modal = true,
} = {}) {
  const result = await foundry.applications.api.DialogV2.confirm({
    window: {title},
    content,
    modal,
    rejectClose: false,
    yes: {
      label: yesLabel,
      icon: "fa-solid fa-check",
      default: defaultYes,
    },
    no: {
      label: noLabel,
      icon: "fa-solid fa-xmark",
      default: !defaultYes,
    },
  });
  return result === true;
}

/**
 * Display Foundry's standard JSON file picker content in a v14 DialogV2.
 */
export async function showFileImportDialog({
  title,
  content,
  onImport,
  width = 400,
  importLabel = game.i18n.localize("age-system.import"),
  cancelLabel = game.i18n.localize("age-system.cancel"),
} = {}) {
  return foundry.applications.api.DialogV2.wait({
    window: {title},
    position: {width},
    content: unwrapDialogForm(content),
    modal: true,
    rejectClose: false,
    buttons: [
      {
        action: "import",
        label: importLabel,
        icon: "fa-solid fa-file-import",
        default: true,
        callback: async (event, button, dialog) => {
          const form = getDialogForm(button, dialog);
          const file = form.elements?.data?.files?.[0] ?? form.data?.files?.[0];
          if (!file) {
            ui.notifications.error("You did not upload a data file!");
            return false;
          }
          const json = await foundry.utils.readTextFromFile(file);
          await onImport(json);
          return true;
        },
      },
      {
        action: "cancel",
        label: cancelLabel,
        icon: "fa-solid fa-xmark",
      },
    ],
  });
}
