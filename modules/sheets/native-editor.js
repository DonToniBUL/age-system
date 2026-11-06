function escape(value) {
    return Handlebars.escapeExpression(String(value ?? ""));
}

/**
 * Render Foundry V14's native form-associated ProseMirror element directly in
 * an AppV2 template. This intentionally does not replace DOM after rendering.
 */
export function ageEditor(rawValue, enrichedValue, options) {
    const hash = options?.hash ?? {};
    const name = escape(hash.target);
    const uuid = escape(hash.documentUUID);
    const enabled = hash.editable !== false;
    // A disabled editor must remain in Foundry's enriched display mode even
    // when an editable sheet requests an always-open editing surface. Besides
    // preserving the read-only UX, this prevents secret-bearing raw HTML from
    // being copied into the DOM for a non-owner.
    const toggled = !enabled || hash.toggled !== false;
    const value = escape(enabled ? rawValue : "");
    const enrichedDisplay = String(enrichedValue ?? "");
    const enriched = enrichedDisplay.trim() || (enabled ? String(rawValue ?? "") : "");
    const disabled = enabled ? "" : " disabled";
    const toggleMode = toggled ? " toggled" : "";
    return new Handlebars.SafeString(
        `<prose-mirror class="editor values" name="${name}" value="${value}"${toggleMode} data-document-uuid="${uuid}"${disabled}>${enriched}</prose-mirror>`
    );
}

export function registerNativeEditorHelper() {
    Handlebars.registerHelper("ageEditor", ageEditor);
}
