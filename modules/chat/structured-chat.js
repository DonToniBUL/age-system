import {
    AGE_CHAT_CARD_SCHEMA_VERSION,
    createStructuredChatCard,
    validateStructuredChatCard
} from "../data/contracts.js";

function flagsFrom(source) {
    return source?.flags?.["age-system"] ?? {};
}

function inferKind(flags) {
    const rollData = flags.ageroll?.rollData ?? {};
    const rollType = flags.ageroll?.rollType ?? rollData.rollType ?? "";
    const damage = flags.damageData ?? (rollType === "damage" ? rollData : null);
    if (flags.requestedRoll) return "requested-roll";
    if (flags.powerResistance) return "resistance";
    if (damage?.isHealing) return "healing";
    if (damage) return "damage";
    if (/attack/i.test(rollType)) return "attack";
    if (/power/i.test(rollType)) return "power";
    if (/ability|focus|talent/i.test(rollType)) return "ability";
    if (flags.itemCard) return "item";
    return "system";
}

function inferTargets(flags) {
    const candidates = flags.multiTarget?.targets
        ?? flags.ageroll?.rollData?.targetResults
        ?? flags.damageData?.targetResults
        ?? [];
    if (!Array.isArray(candidates)) return [];
    return candidates.map(target => ({
        uuid: target.uuid ?? target.actorUuid ?? target.tokenUuid,
        name: target.name ?? target.actorName ?? target.tokenName,
        outcome: target.outcome ?? (target.hit === true ? "hit" : target.hit === false ? "miss" : null)
    }));
}

function inferCard(source) {
    const flags = flagsFrom(source);
    const rollData = flags.ageroll?.rollData ?? flags.damageData ?? {};
    const action = flags.ageAction ?? flags.action ?? {};
    return createStructuredChatCard({
        kind: inferKind(flags),
        title: source?.flavor ?? rollData.itemName ?? rollData.name ?? rollData.attacker ?? "AGE",
        subtitle: rollData.rollType ?? flags.ageroll?.rollType ?? "",
        actorUuid: rollData.actorId ?? rollData.actorUuid ?? action.actorUuid,
        itemUuid: rollData.itemId ?? rollData.itemUuid ?? action.itemUuid,
        actionId: action.id,
        targets: inferTargets(flags),
        data: {
            rollType: flags.ageroll?.rollType ?? rollData.rollType ?? null,
            hasRoll: Array.isArray(source?.rolls) && source.rolls.length > 0
        }
    });
}

export class StructuredChatCardService {
    static get schemaVersion() {
        return AGE_CHAT_CARD_SCHEMA_VERSION;
    }

    static prepare(message, source) {
        const flags = flagsFrom(source);
        if (!Object.keys(flags).length || flags.structuredChat) return;
        const card = inferCard(source);
        const validation = validateStructuredChatCard(card);
        if (!validation.valid) {
            console.warn("AGE System | Structured chat metadata was not attached.", validation.errors);
            return;
        }
        message.updateSource({"flags.age-system.structuredChat": card});
    }

    static decorate(message, html) {
        const card = message?.flags?.["age-system"]?.structuredChat;
        if (!card || !html) return;
        const validation = validateStructuredChatCard(card);
        if (!validation.valid) return;
        const root = html.querySelector?.(".message-content") ?? html;
        root.classList?.add("age-v5-chat-card", `age-v5-chat-card--${card.kind}`);
        if (root.dataset) {
            root.dataset.ageChatSchema = String(card.schemaVersion);
            root.dataset.ageChatKind = card.kind;
        }
    }

    static create(source) {
        return createStructuredChatCard(source);
    }

    static validate(card) {
        return validateStructuredChatCard(card);
    }
}
