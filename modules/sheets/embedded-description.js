/**
 * Enrich one persisted rich-text value with Foundry's V14 editor service.
 * Empty enrichment is authoritative: it may mean Foundry removed secrets.
 */
export async function enrichAgeRichText(rawValue, relativeTo) {
    const raw = String(rawValue ?? "");
    const textEditor = foundry.applications.ux.TextEditor.implementation;
    const html = await textEditor.enrichHTML(raw, {
        async: true,
        secrets: Boolean(relativeTo?.isOwner),
        relativeTo
    });
    return String(html ?? "");
}

/**
 * Attach display-only rich-text data to detached embedded Item sources used by
 * the Character Stat Block. This never mutates the owned Item documents.
 */
export async function enrichEmbeddedLongDescriptions(items, actor) {
    if (!Array.isArray(items)) return items;
    for (const item of items) {
        const document = actor?.items?.get?.(item?._id ?? item?.id);
        item.uuid = document?.uuid ?? "";
        item.ageEnrichedLongDesc = await enrichAgeRichText(
            item?.system?.longDesc,
            document ?? actor
        );
    }
    return items;
}
