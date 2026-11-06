import {
    getAgeItemPrice,
    parseAgeCoinPrice,
    parseAgeSingleCurrencyPrice,
} from "./currency.js";

export const AGE_ITEM_PILES_INTEGRATION_VERSION = "1.0.0";

const NON_INVENTORY_ITEM_TYPES = Object.freeze([
    "focus",
    "power",
    "talent",
    "stunts",
    "relationship",
    "honorifics",
    "membership",
    "shipfeatures",
    "class",
    "progression",
]);

function localizedCurrency(key, fallback) {
    const localized = game.i18n.localize(key);
    return localized === key ? fallback : localized;
}

function attributeCurrency({name, img, abbreviation, path, primary, exchangeRate}) {
    return {
        type: "attribute",
        name,
        img,
        abbreviation,
        data: {path},
        primary,
        exchangeRate,
    };
}

export function transformAgeItemPilesCost(item, wealthMode = game.settings.get("age-system", "wealthType")) {
    const price = getAgeItemPrice(item);
    if (wealthMode === "coins") return parseAgeCoinPrice(price);
    if (wealthMode === "currency") return parseAgeSingleCurrencyPrice(price);
    return 0;
}

export function buildAgeItemPilesIntegration(wealthMode = game.settings.get("age-system", "wealthType")) {
    const coins = wealthMode === "coins";
    const singleCurrency = wealthMode === "currency";
    const currencies = coins ? [
        attributeCurrency({
            name: localizedCurrency("age-system.itemPiles.gold", "Gold Pieces"),
            img: "icons/commodities/currency/coin-embossed-crown-gold.webp",
            abbreviation: `{#}${localizedCurrency("age-system.gp", "GP")}`,
            path: "system.gp",
            primary: true,
            exchangeRate: 1,
        }),
        attributeCurrency({
            name: localizedCurrency("age-system.itemPiles.silver", "Silver Pieces"),
            img: "icons/commodities/currency/coin-engraved-moon-silver.webp",
            abbreviation: `{#}${localizedCurrency("age-system.sp", "SP")}`,
            path: "system.sp",
            primary: false,
            exchangeRate: 0.01,
        }),
        attributeCurrency({
            name: localizedCurrency("age-system.itemPiles.copper", "Copper Pieces"),
            img: "icons/commodities/currency/coin-engraved-waves-copper.webp",
            abbreviation: `{#}${localizedCurrency("age-system.cp", "CP")}`,
            path: "system.cp",
            primary: false,
            exchangeRate: 0.0001,
        }),
    ] : singleCurrency ? [
        attributeCurrency({
            name: localizedCurrency("age-system.itemPiles.currency", "Currency"),
            img: "icons/commodities/currency/coin-inset-copper.webp",
            abbreviation: "{#}",
            path: "system.currency",
            primary: true,
            exchangeRate: 1,
        }),
    ] : [];

    return {
        VERSION: AGE_ITEM_PILES_INTEGRATION_VERSION,
        ACTOR_CLASS_TYPE: "char",
        ITEM_CLASS_LOOT_TYPE: "equipment",
        ITEM_CLASS_WEAPON_TYPE: "weapon",
        ITEM_CLASS_EQUIPMENT_TYPE: "equipment",
        ITEM_QUANTITY_ATTRIBUTE: "system.quantity",
        ITEM_PRICE_ATTRIBUTE: "system.cost",
        ITEM_FILTERS: [{path: "type", filters: NON_INVENTORY_ITEM_TYPES.join(",")}],
        ITEM_SIMILARITIES: ["name", "type"],
        UNSTACKABLE_ITEM_TYPES: [],
        // Read the live wealth setting when a price is requested so changing an
        // AGE preset cannot leave Item Piles with a stale cost interpretation.
        ITEM_COST_TRANSFORMER: item => transformAgeItemPilesCost(item),
        ITEM_PREVIEW_PERMISSION_LEVEL: 1,
        CURRENCIES: currencies,
        SECONDARY_CURRENCIES: [],
        CURRENCY_DECIMAL_DIGITS: coins ? 4 : 2,
    };
}

/** Keep Item Piles' currency list synchronized after AGE's wealth mode changes. */
export async function refreshAgeItemPilesCurrencies(wealthMode = game.settings.get("age-system", "wealthType")) {
    const api = game.itempiles?.API;
    if (!api) return false;
    const integration = buildAgeItemPilesIntegration(wealthMode);
    if (typeof api.setCurrencies === "function") await api.setCurrencies(integration.CURRENCIES);
    if (typeof api.setSecondaryCurrencies === "function") await api.setSecondaryCurrencies(integration.SECONDARY_CURRENCIES);
    if (typeof api.setCurrencyDecimalDigits === "function") await api.setCurrencyDecimalDigits(integration.CURRENCY_DECIMAL_DIGITS);
    if (game.ageSystem?.itemPiles) game.ageSystem.itemPiles.integration = integration;
    return integration;
}

/** Register AGE's optional Item Piles support without making the module mandatory. */
export async function registerAgeItemPilesIntegration() {
    const api = game.itempiles?.API;
    if (typeof api?.addSystemIntegration !== "function") return false;

    const integration = buildAgeItemPilesIntegration();
    await api.addSystemIntegration(integration, game.system.version);
    if (game.ageSystem) game.ageSystem.itemPiles = {active: true, integration};
    console.log(`AGE System | Item Piles integration ${AGE_ITEM_PILES_INTEGRATION_VERSION} registered.`);
    return integration;
}
