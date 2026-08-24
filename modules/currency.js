/**
 * Currency helpers shared by AGE sheets and optional module integrations.
 *
 * AGE coin values are stored on Actors as GP, SP, and CP. Item prices remain
 * human-readable strings so existing worlds and compendia keep their source
 * notation (including crafting/retail pairs such as "70sp/4gp").
 */

export const AGE_COIN_EXCHANGE_RATES = Object.freeze({
    gp: 1,
    sp: 0.01,
    cp: 0.0001,
});

const COIN_ALIASES = Object.freeze({
    gp: "gp", g: "gp", po: "gp", mo: "gp",
    sp: "sp", s: "sp", pa: "sp", mp: "sp", pp: "sp",
    cp: "cp", c: "cp", pc: "cp", mc: "cp",
});

const COIN_TOKEN = /([+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+))\s*(gp|sp|cp|po|mo|pa|mp|pp|pc|mc|g|s|c)\b/gi;
const EMPTY_PRICE = /^(?:-|--|—|–|n\/?a)$/i;

/**
 * Select the merchant/retail half of a slash-separated price.
 * The Dragon Age compendium commonly records "crafting cost / retail cost".
 */
export function retailPriceSegment(value) {
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    const segments = String(value ?? "").split("/").map(segment => segment.trim());
    return segments.reverse().find(segment => segment && !EMPTY_PRICE.test(segment)) ?? "";
}

/**
 * Convert an AGE GP/SP/CP price to its numeric value in primary currency (GP).
 * Localized abbreviations used by the bundled sheets are accepted as aliases.
 */
export function parseAgeCoinPrice(value, {bareUnit = "gp"} = {}) {
    if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, value) : 0;

    const segment = retailPriceSegment(value);
    if (!segment) return 0;

    const bareNumber = segment.replace(",", ".");
    if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(bareNumber)) {
        const denomination = Object.hasOwn(AGE_COIN_EXCHANGE_RATES, bareUnit) ? bareUnit : "gp";
        const amount = Number(bareNumber) * AGE_COIN_EXCHANGE_RATES[denomination];
        return Number.isFinite(amount) ? Math.max(0, amount) : 0;
    }

    let total = 0;
    let matched = false;
    COIN_TOKEN.lastIndex = 0;
    for (const match of segment.matchAll(COIN_TOKEN)) {
        const amount = Number(match[1].replace(",", "."));
        const denomination = COIN_ALIASES[match[2].toLowerCase()];
        if (!Number.isFinite(amount) || !denomination) continue;
        total += amount * AGE_COIN_EXCHANGE_RATES[denomination];
        matched = true;
    }

    if (!matched || !Number.isFinite(total)) return 0;
    return Math.max(0, Number(total.toFixed(8)));
}

/** Convert a price used by the single-currency wealth mode to a number. */
export function parseAgeSingleCurrencyPrice(value) {
    if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, value) : 0;
    const amount = Number(retailPriceSegment(value).replace(",", "."));
    return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

/** Find system.cost on either an Item document, source object, or Item Piles wrapper. */
export function getAgeItemPrice(item) {
    return item?.system?.cost
        ?? item?.item?.system?.cost
        ?? item?.data?.system?.cost
        ?? item?._source?.system?.cost
        ?? item;
}
