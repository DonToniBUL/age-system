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
    const value = escape(rawValue);
    const uuid = escape(hash.documentUUID);
    const enabled = hash.editable !== false;
    const enriched = String(enrichedValue ?? "").trim() || String(rawValue ?? "");
    const disabled = enabled ? "" : " disabled";
    return new Handlebars.SafeString(
        `<prose-mirror class="editor values" name="${name}" value="${value}" toggled data-document-uuid="${uuid}"${disabled}>${enriched}</prose-mirror>`
    );
}

export function registerNativeEditorHelper() {
    Handlebars.registerHelper("ageEditor", ageEditor);
}
