function escapeSelectedValue(value, escapeExpression) {
    return String(escapeExpression ? escapeExpression(value) : value ?? "");
}

/**
 * Compatibility implementation of Foundry's former {{#select}} helper.
 * AppV2 templates still use the established AGE markup while Foundry v14
 * exposes selectOptions instead of registering this legacy block helper.
 */
export function renderLegacySelect(selected, options, escapeExpression) {
    const selectedValues = new Set(
        (Array.isArray(selected) ? selected : [selected])
            .map(value => escapeSelectedValue(value, escapeExpression))
    );
    const markup = String(options.fn(this));

    return markup.replace(/<option\b[^>]*>/gi, option => {
        const value = option.match(/\bvalue\s*=\s*(["'])(.*?)\1/i)?.[2];
        if (value === undefined || !selectedValues.has(value)) return option;
        if (/\sselected(?:\s|=|>)/i.test(option)) return option;
        return option.replace(/>$/, " selected>");
    });
}

export function registerLegacySelectHelper(handlebars = globalThis.Handlebars) {
    if (!handlebars?.registerHelper) {
        throw new Error("AGE System | Handlebars is unavailable while registering the select helper.");
    }
    if (typeof handlebars.helpers?.select === "function") return false;
    handlebars.registerHelper("select", function(selected, options) {
        return renderLegacySelect.call(this, selected, options, handlebars.escapeExpression);
    });
    return true;
}
