import ApplyDamageDialog, { summaryToChat } from "./apply-damage.js";
import {ageSystem} from "./config.js";
import ConditionsWorkshop from "./conditions-workshop.js";
import { applyBreather } from "./breather.js";
import {normalizeDamageSource} from "./damage-utils.js";
import {AgeTransactionService} from "./automation/action-transactions.js";
import {MultiTargetService} from "./automation/multi-target.js";
import {PowerResistanceService} from "./automation/power-resistance.js";
import {StuntAssistantService} from "./automation/stunt-assistant.js";
import {AdvancedTestService} from "./automation/advanced-tests.js";
import {CombatLifecycleService} from "./automation/combat-lifecycle.js";
import {RequestedRollService} from "./automation/requested-rolls.js";
import {ConditionLifecycleService} from "./automation/condition-lifecycle.js";
import {AgeActionService} from "./automation/actions.js";

function messageFromEvent(event, fallback = null) {
    const id = event?.currentTarget?.closest?.(".chat-message")?.dataset?.messageId;
    return (id ? game.messages?.get?.(id) : null) ?? fallback;
}

function runAutomationChatAction(action) {
    Promise.resolve().then(action).catch(error => {
        console.error("AGE System | Automation chat action failed.", error);
        ui.notifications.error(game.i18n.format("age-system.AUTOMATION.chatActionFailed", {reason: error?.message ?? String(error)}));
    });
}

export function addChatListeners(message, html = null) {
    if (!html) {
        html = message;
        message = null;
    }
    MultiTargetService.decorate(message, html);
    PowerResistanceService.decorate(message, html);
    StuntAssistantService.decorate(message, html);
    AdvancedTestService.decorate(message, html);
    RequestedRollService.decorate(message, html);
    html.querySelectorAll('.roll-damage').forEach(el => el.addEventListener("click", chatDamageRoll));
    html.querySelectorAll('.roll-damage').forEach(el => el.addEventListener("contextmenu", chatDamageRoll));
    html.querySelectorAll('.roll-fatigue').forEach(el => el.addEventListener("click", chatFatigueRoll));
    html.querySelectorAll('.roll-fatigue').forEach(el => el.addEventListener("contextmenu", chatFatigueRoll));
    html.querySelectorAll('.roll-item').forEach(el => el.addEventListener("click", rollItemFromChat));
    html.querySelectorAll('.roll-item').forEach(el => el.addEventListener("contextmenu", rollItemFromChat));
    html.querySelectorAll('.apply-damage').forEach(el => el.addEventListener("click", applyDamageChat));
    html.querySelectorAll('.apply-damage').forEach(el => el.addEventListener("contextmenu", applyDamageChat));
    html.querySelectorAll('.roll-toughness-test').forEach(el => el.addEventListener("click", resistInjury));
    html.querySelectorAll('.apply-injury').forEach(el => el.addEventListener("click", inflictInjury));
    html.querySelectorAll('.age-open-stunt-assistant').forEach(el => el.addEventListener("click", event => runAutomationChatAction(() => StuntAssistantService.open(messageFromEvent(event, message)))));
    html.querySelectorAll('.age-roll-power-resistance').forEach(el => el.addEventListener("click", event => runAutomationChatAction(() => PowerResistanceService.rollTarget(messageFromEvent(event, message), event.currentTarget.dataset.targetKey))));
    html.querySelectorAll('.age-roll-all-power-resistance').forEach(el => el.addEventListener("click", event => runAutomationChatAction(() => PowerResistanceService.rollAll(messageFromEvent(event, message)))));
    html.querySelectorAll('.age-advanced-test-add').forEach(el => el.addEventListener("click", event => runAutomationChatAction(() => AdvancedTestService.recordMessage(messageFromEvent(event, message)))));
    html.querySelectorAll('.age-expire-turn-effects').forEach(el => el.addEventListener("click", event => runAutomationChatAction(() => CombatLifecycleService.expireFromMessage(messageFromEvent(event, message)))));
    html.querySelectorAll('.age-requested-roll').forEach(el => el.addEventListener("click", event => runAutomationChatAction(() => RequestedRollService.roll(messageFromEvent(event, message), event.currentTarget.dataset.actorUuid, event))));
    html.querySelectorAll('.age-resolve-condition-prompt').forEach(el => el.addEventListener("click", event => runAutomationChatAction(() => ConditionLifecycleService.resolvePrompt(messageFromEvent(event, message)))));
    // html.on('click', '.roll-damage', chatDamageRoll);
    // html.on('contextmenu', '.roll-damage', chatDamageRoll);
    // html.on('click', '.roll-fatigue', chatFatigueRoll);
    // html.on('contextmenu', '.roll-fatigue', chatFatigueRoll);
    // html.on('click', '.roll-item', rollItemFromChat);
    // html.on('contextmenu', '.roll-item', rollItemFromChat);
    // html.on('click', '.apply-damage', applyDamageChat);
    // html.on('click', '.roll-toughness-test', resistInjury);
    // html.on('click', '.apply-injury', inflictInjury);
};

/**
 * This function is used to hook into the Chat Log context menu to add additional options to each message
 * These options make it easy to conveniently apply damage to controlled tokens based on the value of a Roll
 * @param {HTMLElement} html    The Chat Message being rendered
 * @param {object[]} options    The Array of Context Menu options
 * @returns {object[]}          The extended options Array including new context choices
 */
export const addChatMessageContextOptions = function(html, options) {
    const messageElement = (event, target) => target?.closest?.(".chat-message") ?? target ?? event?.currentTarget;
    const canApply = (event, target) => {
        const element = messageElement(event, target);
        const message = game.messages.get(element?.dataset?.messageId);
        const hasTargets = ageSystem.useTargeted ? game.user.targets.size : (canvas.tokens?.controlled?.length ?? 0);
        return Boolean(message?.isRoll && message?.isContentVisible && hasTargets);
    };
    options.push(
    {
        label: game.i18n.localize("age-system.item.healing"),
        icon: '<i class="fa fa-heartbeat" aria-hidden="true"></i>',
        visible: canApply,
        onClick: (event, target) => applyChatCardDamage(messageElement(event, target), {isHealing: true, isNewHP: false})
    },
    {
        label: game.i18n.localize("age-system.applyDamage"),
        icon: '<i class="fa fa-crosshairs" aria-hidden="true"></i>',
        visible: canApply,
        onClick: (event, target) => applyChatCardDamage(messageElement(event, target), {isDamage: true})
    });
    return options;
};

/**
 * Apply rolled dice damage to the token or tokens which are currently controlled.
 * This allows for damage to be scaled by a multiplier to account for healing, critical hits, or resistance
 * @param {HTMLElement} li      The chat entry which contains the roll data
 * @param {object} options      Options containing card's damage or healing definitions
 */
function applyChatCardDamage(li, options) {
    const message = game.messages.get(li?.dataset?.messageId);
    if (!message) return false;
    const roll = message.rolls?.[0];
    const cardDamageData = message.flags?.["age-system"]?.damageData;
    const total = cardDamageData?.totalDamage ?? roll?.total ?? 0;
    if (options.isHealing) {
        return applyHealingToTargets(total);
    }
    if (options.isDamage) {
        const cardHealthSys = cardDamageData?.healthSys?.type;
        let damageData;
        if (cardHealthSys === ageSystem.healthSys.type) {
            damageData = cardDamageData
        } else {
            damageData = {
                healthSys: ageSystem.healthSys,
                totalDamage: cardDamageData?.totalDamage ?? total,
                dmgType: cardDamageData?.dmgType ?? 'wound',
                dmgSrc: normalizeDamageSource(cardDamageData?.dmgSrc, ageSystem.healthSys),
                isHealing: false,
                wGroupPenalty: false,
                targetResults: cardDamageData?.targetResults ?? null,
                targetResultsLocked: cardDamageData?.targetResultsLocked === true
            }
        }
        callApplyDamage(damageData);
    }
}

/**
 * Chat card listener to apply Injury to selected Actor when pressing specific button.
 * @param {Mouse Event} event   Chat card Mouse Click event
 * @returns {Promisse}          Promisse applying Injury to Actor
 */
export async function inflictInjury(event){
    event.preventDefault();
    const b = event.currentTarget;
    let degree;
    if (b.classList.contains('light')) degree = 'light'
    if (b.classList.contains('serious')) degree = 'serious'
    if (b.classList.contains('severe')) degree = 'severe'
    if (!degree) return
    const card = event.target.closest(".chat-message");
    const cardId = card.dataset.messageId;
    const cardData = await game.messages.get(cardId).flags["age-system"].ageroll.rollData;
    let actor = await foundry.utils.fromUuid(cardData.actorId);
    if (actor.documentName === "Token") actor = actor.actor;
    return actor.applyInjury(degree);
}

// Actor indicated by card will roll to resist Injury
export async function resistInjury(event) {
    event.preventDefault();
    const card = event.target.closest(".chat-message");
    const cardId = card.dataset.messageId;
    const cardData = await game.messages.get(cardId).flags["age-system"].toughnessTestCard;
    const actor = await foundry.utils.fromUuid(cardData.actorUuid);
    return actor.toughnessTest(foundry.utils.deepClone(cardData.injuryParts), cardData.rollTN, cardData.autoApply);
}

// Apply Damage button will send all selected Actors [Character type only] to Apply Damage dialog window
export async function applyDamageChat(event) {
    event.preventDefault();
    const card = event.target.closest(".chat-message");
    const cardId = card?.dataset?.messageId;
    const message = game.messages.get(cardId);
    const cardData = message?.flags?.["age-system"]?.damageData ?? message?.flags?.["age-system"]?.ageroll?.rollData; // Compatibility to Damage Chat Card before 1.1.6
    if (!cardData) return false;
    let damageData = foundry.utils.deepClone(cardData);
    
    // Check if this is a healing card and handle it directly
    if (damageData.isHealing) {
        const total = damageData.totalDamage;
        let targets = null;
        if (damageData.targetResultsLocked === true || (Array.isArray(damageData.targetResults) && damageData.targetResults.length)) {
            if (MultiTargetService.allMissed(damageData.targetResults)) {
                return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.noSuccessfulAttackTargets"));
            }
            targets = (await MultiTargetService.resolveDocuments(damageData.targetResults, {hitsOnly: true}))
                .filter(target => target?.actor?.type === "char" || target?.document?.actor?.type === "char");
            if (!targets.length) return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.lockedDamageTargetsUnavailable"));
        }
        return applyHealingToTargets(total, {targets});
    }
    
    const cardHealthSys = damageData.healthSys;
    if (!checkHealth(cardHealthSys, ageSystem.healthSys)) {
        damageData = {
            healthSys: ageSystem.healthSys,
            totalDamage: damageData.totalDamage,
            dmgType: damageData.dmgType ?? 'wound',
            dmgSrc: normalizeDamageSource(damageData.dmgSrc, ageSystem.healthSys),
            isHealing: false,
            wGroupPenalty: false,
            targetResults: damageData.targetResults ?? null,
            targetResultsLocked: damageData.targetResultsLocked === true
        }
        ui.notifications.warn(game.i18n.localize("age-system.WARNING.healthSysNotMatching"));
    };
    callApplyDamage(damageData);
}

export async function applyHealingToTargets(total, {ageAction = null, targets: suppliedTargets = null} = {}) {
    const targets = suppliedTargets ?? controlledTokenByType(['char']);
    if (!ageAction && AgeActionService.supports("apply.healing")) {
        const execution = await AgeActionService.execute({
            type: "apply.healing",
            targetUuids: targets.map(target => target?.document?.uuid ?? target?.uuid ?? target?.actor?.uuid).filter(Boolean),
            payload: {amount: total},
            metadata: {origin: "age-chat.applyHealingToTargets"}
        }, {
            executor: action => applyHealingToTargets(total, {ageAction: action, targets})
        });
        return execution.result;
    }
    const transaction = AgeTransactionService.begin({
        id: ageAction?.id ?? null,
        label: game.i18n.localize("age-system.item.healing"),
        type: ageAction?.type ?? "healing",
        metadata: {targets: targets.length, actionSchemaVersion: ageAction?.schemaVersion ?? null}
    });
    try {
        const settled = await Promise.allSettled(targets.map(t => {
            const actor = t.actor;
            return ageSystem.healthSys.useInjury
                ? actor.healMarks(total, {transaction})
                : actor.applyHPchange(total, {isHealing: true, isNewHP: false, transaction});
        }));
        const failure = settled.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
        const summary = settled.map(result => result.value);
        await transaction.commit();
        const validSummary = summary.filter(result => result && result !== true);
        if (validSummary.length > 0) await summaryToChat(validSummary, ageSystem.healthSys.useInjury, true);
        return summary;
    } catch (error) {
        try {
            await transaction.rollback({removeHistory: true});
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], game.i18n.localize("age-system.AUTOMATION.rollbackFailed"));
        }
        throw error;
    }
}

/**
 * Call Apply Damage data containing all applicable Actors selected
 * @param {object} damageData   All details from the damage to be applied to selected Actors
 * @returns {Application}       Apply Damage application is started to select damage details
 */
export async function callApplyDamage (damageData) {
    let targets;
    if (damageData?.targetResultsLocked === true || (Array.isArray(damageData?.targetResults) && damageData.targetResults.length)) {
        if (MultiTargetService.allMissed(damageData.targetResults)) {
            return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.noSuccessfulAttackTargets"));
        }
        targets = (await MultiTargetService.resolveDocuments(damageData.targetResults, {hitsOnly: true}))
            .filter(target => target?.actor?.type === "char" || target?.document?.actor?.type === "char");
    } else {
        targets = controlledTokenByType('char');
    }
    if (targets.length === 0) {
        const key = damageData?.targetResultsLocked === true
            ? "age-system.AUTOMATION.lockedDamageTargetsUnavailable"
            : "age-system.WARNING.noValidTokensSelected";
        return ui.notifications.warn(game.i18n.localize(key));
    }
    return new ApplyDamageDialog(targets, damageData, ageSystem.healthSys.useInjury).render(true);
}

/**
 * Filter the controlled actor types to match passed Type
 * @param {string|array} type Valid actor type to be selected
 * @returns {array}     Array with only the correct type of Actor
 */
export function controlledTokenByType(type) {
    if (!Array.isArray(type)) type = [type];
    let targets = []
    if (ageSystem.useTargeted) {
        const t = game.user.targets;
        for (let i of t.values()) targets.push(i)
    } else {
        targets = canvas.tokens.controlled;
    }
    const nonChar = []
    for (let t = 0; t < targets.length; t++) {
        const el = targets[t];
        const actorType = el.actor?.type;
        if (!type.includes(actorType)) nonChar.push(t);
    }
    for (let t = nonChar.length-1; t >= 0; t--) {
        targets.splice(nonChar[t],1)
    }
    return targets
}

/**
 * Check if actual Game Settings and clicked Card with Apply Damage button has compatible parameters
 * @param {string} card         Chat card damage parameters
 * @param {string} game         Current in-use Game Settings health parameters * 
 * @returns {boolean}           TRUE if compatible, FALSE if not compatible
 */
export function checkHealth(card, game) {
    if (!card || !game) return false;
    const attributes = ["useToughness", "useInjury", "useBallistic"];
    for (const att of attributes) {
        if (card[att] !== game[att]) return false;
    }
    return true;
}

/**
 * Roll damage from a chat card, taking into consideration card's Actor, Item and button selected
 */ 
export async function chatDamageRoll(event) {
    event.preventDefault();
    const message = event.type === "contextmenu" ? event.target.closest(".chat-message") : event.currentTarget.closest(".chat-message");
    const cardId = message.dataset.messageId;
    const chatMessage = game.messages.get(cardId);
    const cardData = chatMessage.flags["age-system"].ageroll.rollData;
    const classList = event.currentTarget.classList;
    const actorId = cardData.actorId
    let owner = null;
    if (actorId) owner = await foundry.utils.fromUuid(actorId);
    owner = owner?.actor ?? owner;
    if (!owner) return ui.notifications.warn(game.i18n.localize("age-system.WARNING.originTokenMissing"));
    const itemSource = owner.items.get(cardData.itemId);
    if (!itemSource) return ui.notifications.warn(game.i18n.localize("age-system.WARNING.originTokenMissing"));

    let stuntDie = null;
    let addFocus = false;
    let resistedDamage = false;
    if (classList.contains('add-stunt-damage')) stuntDie = cardData.ageRollSummary.stuntDie;
    if (classList.contains('add-focus-damage')) addFocus = true;
    if (classList.contains('resisted')) resistedDamage = true;

    const isHealing = Boolean(itemSource.hasHealing || itemSource.system?.hasHealing || itemSource.system?.causeHealing);
    const resistanceState = isHealing ? null : PowerResistanceService.state(chatMessage);
    const cardTargets = Array.isArray(cardData.targetResults) && cardData.targetResults.length
        ? foundry.utils.deepClone(cardData.targetResults)
        : [];
    const actionTargets = MultiTargetService.actionTargets(chatMessage);
    const fallbackTargets = cardTargets.length ? cardTargets : actionTargets;
    if (!resistanceState && MultiTargetService.allMissed(cardTargets)) {
        return ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.noSuccessfulAttackTargets"));
    }
    const targetResults = resistanceState
        ? PowerResistanceService.damageTargets(chatMessage, {resisted: resistedDamage, fallback: fallbackTargets})
        : fallbackTargets;
    const targetResultsLocked = Boolean(resistanceState?.targets?.length) || fallbackTargets.length > 0;

    const damageData = {
        event: event,
        stuntDie: stuntDie,
        dmgExtraDice: StuntAssistantService.pendingDamageDice(chatMessage) || null,
        addFocus: addFocus,
        atkDmgTradeOff: cardData.atkDmgTradeOff,
        resistedDmg: resistedDamage,
        targetResults,
        targetResultsLocked,
    };
    if (damageData.targetResultsLocked && (!Array.isArray(targetResults) || targetResults.length === 0)) {
        const key = resistedDamage
            ? "age-system.AUTOMATION.noResistedDamageTargets"
            : "age-system.AUTOMATION.noFullDamageTargets";
        return ui.notifications.warn(game.i18n.localize(key));
    }
    const damageMessage = await itemSource.rollDamage(damageData);
    if (damageMessage && damageData.dmgExtraDice) await StuntAssistantService.markDamageApplied(chatMessage);
    return damageMessage;
};

/**
 * Roll Fatigue from chat card according to card's Actor and Item
 */ 
export async function chatFatigueRoll(event) {
    const message = event.type === "contextmenu" ? event.target.closest(".chat-message") : event.currentTarget.closest(".chat-message");
    const cardId = message.dataset.messageId;
    const cardData = game.messages.get(cardId).flags["age-system"].ageroll.rollData;
    const actorId = cardData.actorId;
    let owner = null;
    owner = await foundry.utils.fromUuid(actorId)
    owner = owner?.actor ?? owner;
    if (!owner) return ui.notifications.warn(game.i18n.localize("age-system.WARNING.originTokenMissing"));
    const itemSource = owner.items.get(cardData.itemId);
    itemSource.roll(event, "fatigue");
};

// From and chat card, select to roll item's Attack or Damage
export async function rollItemFromChat(event) {
    const classList = event.currentTarget.classList;
    const message = event.type === "contextmenu" ? event.target.closest(".chat-message") : event.currentTarget.closest(".chat-message");
    const cardId = message.dataset.messageId;
    const cardData = game.messages.get(cardId).flags["age-system"].messageData;

    const itemId = cardData.itemId;
    let owner = await foundry.utils.fromUuid(cardData.ownerUuid);
    owner = owner?.actor ?? owner;
    const item = owner.items.get(itemId);
    if (classList.contains("damage")) item.rollDamage({event});
    if (classList.contains("attack")) item.roll(event);
}

/**
 * Set properties of elements inside cards rendered on chat
 * @param {object} chatCard         Chat card object containing the Message Data
 * @param {jQueryObject} html       jObject of the chat card being processed
 * @param {object} data             Data containing Message data
 */
export async function sortCustomAgeChatCards(chatCard, html, data) {
    // Add attribute type="button" to AGE buttons
    _buttonType(html.querySelectorAll(".age-system.item-chat-controls button"));
    _buttonType(html.querySelectorAll("button.age-button"));

    // Toggle chat card visibility of AGE Roll Cards 
    if (html.querySelectorAll(".base-age-roll").length > 0) _handleAgeRollVisibility(html, chatCard);

    // Check permission level to show and roll chat buttons when rolling item card
    if (html.querySelectorAll(".item-chat-controls").length > 0) _handleItemCardButton(html);
};

/**
 * Add attribute [type]="button" to chat buttons
 *
 * @param {HTMLelement} buttons     Array if all button elements inside the card
 */
function _buttonType(buttons) {
    for (let b = 0; b < buttons.length; b++) {
        const button = buttons[b];
        button.type = "button";
    }
}

/**
 * Set visibility properties for buttons and blind-roll segments (blind-roll segments currently not used)
 *
 * @param {HTML element} html       HTML element of the chat card being processed
 * @param {object} chatCard         Chat card object containing the Message Data
 */
function _handleAgeRollVisibility(html, chatCard){
    const flags = chatCard.flags?.["age-system"]?.ageroll;
    const elements = html.querySelectorAll(".age-system.base-age-roll .feature-controls");
    for (let es = 0; es < elements.length; es++) {
        const el = elements[es];
        let actorId = flags?.rollData?.actorId;
        if (!actorId && flags?.type === "damage") actorId = flags.damageData.attackerId; // Compatibility to Damage Chat Card before 1.1.6
        let actor = actorId ? foundry.utils.fromUuidSync(actorId) : null;
        actor = actor?.actor ?? actor;
        const isBlind = chatCard.blind;
        const whisperTo = chatCard.whisper ?? [];
        const author = chatCard.author?.id ?? chatCard.user?.id;
        const userId = game.user.id;
    
        if ((whisperTo.includes(userId) || whisperTo.length < 1 || author === userId) && !isBlind) {
            el.querySelector(".blind-roll-card")?.remove();
        } else {
            if (isBlind && whisperTo.includes(userId)) {
                el.querySelector(".blind-roll-card")?.remove();
            } else {
                el.querySelector(".regular-roll-card")?.remove();
                const hideField = userId === author ? ".other-user-roll" : ".user-roll";
                el.querySelector(`.blind-roll-card ${hideField}`)?.remove();
            }
        }
        _permCheck(actor?.permission, el.querySelector(`.age-chat-buttons-grid`)); // to be removed in the future
        _permCheck(actor?.permission, el.querySelector(`.age-chat-buttons.grid`));
        if (!game.user.isGM) el.querySelector(".gm-only")?.remove();
    }
}

// Check if user has permission to use card button
async function _handleItemCardButton(html){
    const sectionClass = `.item-chat-controls`
    const datum = html.querySelectorAll(sectionClass);
    for (const el of datum) {
        const actorId = el.dataset.ownerUuid;
        let actor;
        if (actorId) actor = await foundry.utils.fromUuid(actorId);
        actor = actor?.actor ?? actor;
        _permCheck(actor?.permission, el);
    }
}

/**
 * Set visibility properties for buttons and blind-roll segments (blind-roll segments currently not used)
 * @param {string} actorPerm        Permission the current user has for the Actor contained on a chat card
 * @param {HTMLelement} element     Chat card HTML element to be be removed if User is not Actor owner or Observer
 */
function _permCheck(actorPerm, element) {
    if (!element) return
    const validPerm = [CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER];
    if (game.settings.get("age-system", "observerRoll")) validPerm.push(CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER);
    if (!validPerm.includes(actorPerm)) element.remove();
}

/**
 * Listens to Chat Log commands and process all /a and /age commands
 * @param {object} chatLog                      Chat Log content
 * @param {string} content                      Text entry on chat textarea
 * @param {object|userId, speaker} userData     Identify message sender
 * @returns 
 */
export function ageCommand(chatLog, content, userData) {
    const message = content.split(" ").map(i => i.trim());
    
    if (['/age', '/a'].includes(message[0])) {
        const isGM = game.user.isGM;
        const gmFeats = ['conditions', 'workshop', 'cw'];
        const routine = message[1]
        if (!isGM && gmFeats.includes(routine)) {
            ui.notifications.error(`Only GMs can use the feature "${routine}"`);
            return false
        }
        if (ageSystem.healthSys.useInjury && [].includes(routine)) {
            ui.notifications.error(game.i18n.localize(`Health system not in use`));
            return false
        }
        if (!ageSystem.healthSys.useInjury && ['injure'].includes(routine)) {
            ui.notifications.error(game.i18n.localize(`Injury system not in use`));
            return false
        }

        switch (routine) {
            case 'help':
            case 'wiki':
                window.open(ageSystem.wiki, '_blank');
                break;
            case 'conditions':
            case 'workshop':
            case 'cw':
                new ConditionsWorkshop().render(true);
                break;
            case 'damage':
            case 'dmg':
                callApplyDamage({
                    healthSys: ageSystem.healthSys,
                    totalDamage: Number.isNaN(Number(message[2])) ? 0 : message[2],
                    dmgType: 'wound',
                    dmgSrc: normalizeDamageSource(null, ageSystem.healthSys),
                    isHealing: false,
                    wGroupPenalty: false
                });
                break;
            case 'heal':
                const newValue = Number(message[2]);
                if (!Number.isNaN(newValue)) {
                    const promises = controlledTokenByType(['char', 'organization']).map(t => {
                        const a = t.actor;
                        return ageSystem.healthSys.useInjury ? a.healMarks(newValue) : a.applyHPchange(newValue, {isHealing: true, isNewHP: false});
                    });
                    Promise.all(promises).then(summary => {
                        // Filter out any false returns and send summary to chat
                        const validSummary = summary.filter(s => s && s !== true);
                        if (validSummary.length > 0) {
                            summaryToChat(validSummary, ageSystem.healthSys.useInjury, true);
                        }
                    });
                }
                break;
            case 'injure':
            case 'inj':
                const degree = message[2];
                controlledTokenByType('char').map(t => t.actor.applyInjury(degree));
                break;
            case 'breather':
            case 'b':
                applyBreather('selfroll');
                break;
            default:
                ui.notifications.error(game.i18n.format("CHAT.InvalidCommand", {command: routine}));
                break;
        }
        return false
    }
}
