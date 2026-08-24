import * as Dice from "../dice.js";
import {ageSystem} from "../config.js";
import {getCoreMessageMode, MESSAGE_MODES} from "../compat.js";
import {AdvancementAdd} from "../advancement.js";
import {showConfirmDialog} from "../dialogs.js";
import {characterGameModeProfileUpdate} from "../data/character-source.js";
import {removeItemModifierUpdate, toggleItemModifierUpdate} from "../data/item-modifier-updates.js";

function featureData(event) {
    return event.currentTarget.closest(".feature-controls")?.dataset ?? {};
}

function ownedItem(sheet, event) {
    return sheet.actor.items.get(featureData(event).itemId);
}

function rollAbility(sheet, event) {
    return Dice.ageRollCheck({
        event,
        actor: sheet.actor,
        abl: featureData(event).ablId,
        rollType: ageSystem.ROLL_TYPE.ABILITY
    });
}

function rollItem(sheet, event) {
    event.preventDefault();
    const data = featureData(event);
    const item = sheet.actor.items.get(data.itemId);
    if (item?.type === "focus" && event.button !== 0) return false;
    return item?.roll(event, data.rollType);
}

function removePassenger(sheet, event) {
    const data = featureData(event);
    const index = Number(data.passengerKey);
    const passengers = foundry.utils.deepClone(sheet.actor.system.passengers ?? []);
    if (!passengers[index]) return false;
    const update = passengers[index].isConductor ? {"system.conductor": ""} : {};
    passengers.splice(index, 1);
    return sheet.actor.update({...update, "system.passengers": passengers});
}

function resolvePassenger(id, name = "") {
    const actor = game.actors.tokens?.[id] ?? game.actors.get(id);
    if (actor) return actor;
    ui.notifications.warn(game.i18n.format("age-system.WARNING.userNotAvailable", {name, id}));
    return null;
}

function vehicleManeuver(sheet, event) {
    const vehicle = sheet.actor.system;
    let conductorId = event.currentTarget.classList.contains("is-synth") ? "synth-vehicle" : vehicle.conductor;
    if (!conductorId) return false;
    let conductorData;
    let actor;
    if (conductorId === "synth-vehicle") {
        const speaker = ChatMessage.getSpeaker();
        actor = game.actors.tokens?.[speaker.token] ?? game.actors.get(speaker.actor);
        if (actor?.type !== "char") return false;
        conductorData = actor;
    } else {
        conductorData = vehicle.passengers.find(passenger => passenger.id === conductorId || passenger.isConductor);
        if (!conductorData) return resolvePassenger(conductorId) ?? false;
        actor = resolvePassenger(conductorData.id, conductorData.name);
        if (!actor) return false;
    }
    const focus = actor.checkFocus(vehicle.handling.useFocus);
    return Dice.ageRollCheck({
        event,
        actor,
        abl: vehicle.handling.useAbl,
        flavor: actor.name,
        flavor2: game.i18n.format("age-system.chatCard.maneuversVehicle", {vehicle: sheet.actor.name}),
        vehicleHandling: vehicle.handling.mod,
        itemRolled: focus.id === null ? focus.focusName : focus.focusItem,
        rollType: ageSystem.ROLL_TYPE.VEHICLE_ACTION
    });
}

function spaceshipManeuver(sheet, event) {
    const ship = sheet.actor.system;
    const data = featureData(event);
    const systemBox = event.currentTarget.dataset.sysBox;
    const datum = systemBox
        ? {sysName: data.sysName, passengerId: ship.systems[data.sysName].operator}
        : {passengerId: data.passengerId, passengerName: data.passengerName, sysName: event.currentTarget.dataset.sysName};
    if (event.currentTarget.classList.contains("is-synth")) datum.passengerId = "crew";
    const shipSystem = ship.systems?.[datum.sysName];
    if (!shipSystem) return false;
    let actor;
    let passengerName;
    let rollData = {moreParts: []};
    if (datum.passengerId === "crew") {
        passengerName = game.i18n.localize("age-system.spaceship.crew");
        rollData.moreParts.push({value: ship.crew.competence, label: passengerName});
        rollData.event = event;
    } else {
        actor = resolvePassenger(datum.passengerId, datum.passengerName);
        if (!actor) return false;
        passengerName = actor.name;
        const focus = actor.checkFocus(shipSystem.useFocus);
        rollData = {...rollData, event, actor, abl: shipSystem.useAbl, itemRolled: focus.focusItem ?? focus.focusName};
    }
    const flavorKey = {
        command: "age-system.chatCard.commandsVehicle",
        sensors: "age-system.chatCard.operatesVehicle",
        damageControl: "age-system.chatCard.backupVehicle"
    }[datum.sysName] ?? "age-system.chatCard.maneuversVehicle";
    rollData.flavor = passengerName;
    rollData.flavor2 = game.i18n.format(flavorKey, {name: passengerName, vehicle: sheet.actor.name});
    rollData.rollType = ageSystem.ROLL_TYPE.VEHICLE_ACTION;
    rollData.moreParts.push({value: shipSystem.total, label: game.i18n.localize(`age-system.spaceship.systemName.${datum.sysName}`)});
    return Dice.ageRollCheck(rollData);
}

const actorActions = {
    _onAdjustHealth(sheet, event) {
        const mode = sheet.actor.system.gameMode.selected;
        return sheet.actor.update(characterGameModeProfileUpdate(
            mode,
            event.currentTarget.dataset.detail,
            event.currentTarget.value
        ));
    },
    _onLockGameMode(sheet) {
        return sheet.actor.update({"system.gameMode.override": !sheet.actor.system.gameMode.override});
    },
    _onRollBreather(sheet) { return sheet.actor.breather(false); },
    _onRollToughness(sheet) {
        return Dice.ageRollCheck({actor: sheet.actor, event: {type: "contextmenu"}, moreParts: [{
            label: game.i18n.localize("age-system.toughness"), value: sheet.actor.system.armor.toughness.total
        }], rollType: ageSystem.ROLL_TYPE.TOUGHNESS});
    },
    _onFullHeal(sheet) {
        return sheet.actor.update({
            "system.injury.degrees.light": 0, "system.injury.degrees.serious": 0,
            "system.injury.degrees.severe": 0, "system.injury.marks": 0
        });
    },
    _onRefreshMarks(sheet) { return sheet.actor.refreshMarks(); },
    _onChangeMark(sheet) { return sheet.actor.healMarks(1); },
    _onChangeInjury(sheet, event) {
        event.preventDefault();
        const data = sheet.actor.system;
        const group = event.currentTarget.closest(".arrow-control")?.classList;
        const parameter = group?.contains("light") ? "light" : group?.contains("serious") ? "serious" : group?.contains("severe") ? "severe" : null;
        if (!parameter) return false;
        const marks = parameter === "severe" ? data.injury.degrees.severeMult : 1;
        const quantity = data.injury.degrees[parameter];
        if (event.currentTarget.classList.contains("add")) {
            return sheet.actor.update({[`system.injury.degrees.${parameter}`]: quantity + 1, "system.injury.marks": data.injury.marks + marks});
        }
        if (event.currentTarget.classList.contains("remove") && quantity > 0) {
            const removed = Math.min(Math.max(Number(data.injury.marks), 0), marks);
            return sheet.actor.update({[`system.injury.degrees.${parameter}`]: quantity - 1, "system.injury.marks": Math.max(0, data.injury.marks - removed)});
        }
        return false;
    },
    _onTraitGroupToggle(sheet, event) {
        event.preventDefault();
        const data = featureData(event);
        const groups = foundry.utils.deepClone(sheet.actor.system[data.traitType] ?? []);
        const id = data.traitId.trim();
        groups.includes(id) ? groups.splice(groups.indexOf(id), 1) : groups.push(id);
        return sheet.actor.update({[`system.${data.traitType}`]: groups});
    },
    _onChangeQuantity(sheet, event) {
        event.preventDefault();
        const item = ownedItem(sheet, event);
        if (!item) return false;
        const action = event.currentTarget.dataset.action;
        if (item.type === "class") return item._levelChange(action);
        const path = item.type === "relationship" ? "system.intensity" : "system.quantity";
        const value = Number(item.type === "relationship" ? item.system.intensity : item.system.quantity);
        if (action === "remove" && value === 0) return null;
        if (!['add', 'remove'].includes(action)) return null;
        return item.update({[path]: value + (action === "add" ? 1 : -1)});
    },
    _onToggleItemMod(sheet, event) {
        const {itemId, key} = event.currentTarget.dataset;
        const item = sheet.actor.items.get(itemId);
        const update = toggleItemModifierUpdate(item, key);
        return update ? item.update(update) : false;
    },
    _onChangeCondition(sheet, event) { return sheet.actor.handleConditions(featureData(event).conditionId); },
    _onTooltipHover(_sheet, event) {
        const tooltip = event.currentTarget.querySelector(".container-tooltip-text");
        if (!tooltip) return;
        tooltip.style.top = `${event.clientY - tooltip.clientHeight - 5}px`;
        const overflow = event.view.innerWidth - (event.clientX + tooltip.clientWidth);
        tooltip.style.left = `${event.clientX + Math.min(0, overflow)}px`;
    },
    _onActiveEffect(sheet, event) {
        const effect = sheet.actor.effects.get(featureData(event).effectId);
        return effect?.update({disabled: !effect.disabled});
    },
    _onRemoveEffect(sheet, event) { return sheet.actor.effects.get(featureData(event).effectId)?.delete(); },
    _onItemActivate(sheet, event) {
        const item = sheet.actor.getEmbeddedDocument("Item", featureData(event).itemId);
        if (!item) return false;
        if (event.currentTarget.classList.contains("favorite")) return item.update({"system.favorite": !item.system.favorite});
        const path = ["power", "talent"].includes(item.type) ? "system.activate" : "system.equiped";
        const current = ["power", "talent"].includes(item.type) ? item.system.activate : item.system.equiped;
        return item.update({[path]: !current});
    },
    _onRollResources(sheet, event) { return Dice.ageRollCheck({event, actor: sheet.actor, rollType: ageSystem.ROLL_TYPE.RESOURCES}); },
    _onLastUpSelect(sheet, event) {
        const selected = featureData(event).ablId;
        const update = {};
        for (const key of Object.keys(sheet.actor.system.abilities)) {
            update[`system.abilities.${key}.lastUp`] = key === selected;
        }
        return sheet.actor.update(update);
    },
    _onDefendSelect(sheet, event) {
        if (featureData(event).guardupActive && !sheet.actor.system.defend.active) return sheet.actor.update({"system.guardUp.active": false});
    },
    _onGuardUpSelect(sheet, event) {
        if (!sheet.actor.system.guardUp.active && featureData(event).defendActive) return sheet.actor.update({"system.defend.active": false});
    },
    _onRollAbility: rollAbility,
    _onRollItem: rollItem,
    _onItemDelete(sheet, event) { event.preventDefault(); return ownedItem(sheet, event)?.delete(); },
    _onRollDamage(sheet, event) { event.preventDefault(); return ownedItem(sheet, event)?.rollDamage({event}); },
    _onRemovePassenger: removePassenger,
    _onRollManeuver(sheet, event) { return sheet.actor.type === "spaceship" ? spaceshipManeuver(sheet, event) : vehicleManeuver(sheet, event); },
    _onVehicleDamage(sheet, event) {
        event.preventDefault();
        const target = event.currentTarget;
        const data = featureData(event);
        const damageSource = target.closest(".feature-controls").classList.contains("collision") ? "collision" : "sideswipe";
        const operatorId = sheet.actor.system.conductor;
        const operatorData = operatorId ? sheet.actor.system.passengers.find(passenger => passenger.id === operatorId) : null;
        return sheet.actor.rollVehicleDamage({event, qtdDice: data.qtdDice, addRam: target.classList.contains("add-ram"), operatorData, damageSource});
    },
    async _onRollDice(sheet, event) {
        const data = featureData(event);
        const messageData = {flavor: sheet.actor.name};
        let formula;
        if (event.currentTarget.classList.contains("roll-damage")) {
            const item = sheet.actor.items.get(data.itemId);
            if (!item) return false;
            formula = item.system.damage;
            messageData.flavor += ` | ${item.name}`;
        } else if (event.currentTarget.classList.contains("roll-hull")) {
            formula = sheet.actor.system.hull.total;
            messageData.flavor += ` | ${game.i18n.localize("age-system.spaceship.hull")}`;
        }
        if (!formula) return false;
        if (event.ctrlKey) {
            const bonus = event.altKey ? 2 : 1;
            formula += ` + ${bonus}D6`;
            messageData.flavor += ` | +${bonus}D6`;
        }
        const roll = await new Roll(String(formula)).evaluate();
        return roll.toMessage(messageData, {messageMode: event.shiftKey ? MESSAGE_MODES.BLIND : getCoreMessageMode()});
    },
    _onRemoveFeature(sheet, event) { return ownedItem(sheet, event)?.delete(); },
    _onEquipChange(sheet, event) {
        const item = ownedItem(sheet, event);
        return item?.update({"system.isActive": !item.system.isActive});
    },
    _onChangeLoss(sheet, event) {
        const data = featureData(event);
        const clicked = Number(event.currentTarget.dataset.boxNumber) + 1;
        const current = sheet.actor.system.losses[data.lossSev][data.lossType].actual;
        return sheet.actor.update({[`system.losses.${data.lossSev}.${data.lossType}.actual`]: clicked > current ? clicked : clicked - 1});
    },
    _onRollPlot(sheet, event) {
        event.preventDefault();
        const type = event.currentTarget.dataset.rollType;
        if (type === CONFIG.ageSystem.ROLL_TYPE.PLOT_ACTION) return Dice.ageRollCheck({event, actor: sheet.actor, selectAbl: true, rollType: type});
        if (type === CONFIG.ageSystem.ROLL_TYPE.PLOT_DAMAGE) return Dice.plotDamage(sheet.actor);
        return false;
    }
};

export function runActorSheetAction(sheet, method, event) {
    const action = actorActions[method];
    if (!action) throw new Error(`AGE System | Missing native AppV2 Actor action ${method}.`);
    return action(sheet, event);
}

const itemActions = {
    _onAddAdvance(sheet) { return new AdvancementAdd(sheet.document.uuid).render(true); },
    _onOpenPDF(_sheet, event) {
        const reference = featureData(event).reference;
        if (!reference) return false;
        const parts = reference.match(/([0-9]+)|([a-zA-Z]+)/g);
        if (!parts?.length) return ui.notifications.warn(`Invalid PDF reference: ${reference}`);
        if (ui.PDFoundry) return ui.PDFoundry.openPDFByCode(parts[0], {page: Number(parts[1])});
        return ui.notifications.warn("PDFoundry must be installed to use source links.");
    },
    _onToggleFeature(sheet, event) {
        const feature = event.currentTarget.dataset.feature;
        const value = !sheet.item.system[feature];
        const update = {[`system.${feature}`]: value};
        if (value && feature === "causeHealing") update["system.causeDamage"] = false;
        if (value && feature === "causeDamage") update["system.causeHealing"] = false;
        return sheet.item.update(update);
    },
    _onAddModifier(sheet) { return sheet.item._newModifier(); },
    _onRemoveModifier(sheet, event) {
        const index = featureData(event).modIndex;
        if (!index) return false;
        const update = removeItemModifierUpdate(sheet.item, index);
        return update ? sheet.item.update(update) : false;
    },
    _onToggleModifier(sheet, event) {
        const index = featureData(event).modIndex;
        const update = toggleItemModifierUpdate(sheet.item, index);
        return update ? sheet.item.update(update) : false;
    },
    _onTraitGroupToggle(sheet, event) {
        event.preventDefault();
        const data = featureData(event);
        const groups = foundry.utils.deepClone(sheet.item.system[data.traitType] ?? []);
        const id = data.traitId.trim();
        groups.includes(id) ? groups.splice(groups.indexOf(id), 1) : groups.push(id);
        return sheet.item.update({[`system.${data.traitType}`]: groups});
    },
    _onOwnedFocusNameChange(sheet, event) {
        const typed = event.target.value;
        const duplicate = sheet.item.actor.itemTypes.focus.some(item => item.id !== sheet.item.id && item.system.nameLowerCase === typed.toLowerCase());
        if (duplicate) event.target.value = `*${typed}`;
    }
};

export function runItemSheetAction(sheet, method, event) {
    const action = itemActions[method];
    if (!action) throw new Error(`AGE System | Missing native AppV2 Item action ${method}.`);
    return action(sheet, event);
}

export function itemAdvancementContextMenu(sheet) {
    return [
        {label: game.i18n.localize("age-system.settings.edit"), icon: '<i class="fas fa-edit"></i>', onClick: (_event, target) => {
            const node = target?.closest?.(".advance") ?? target;
            return sheet.item._onChangeAdvancement(node?.dataset ?? {}, "edit");
        }},
        {label: game.i18n.localize("age-system.settings.delete"), icon: '<i class="fas fa-trash"></i>', onClick: async (_event, target) => {
            const node = target?.closest?.(".advance") ?? target;
            const confirmed = await showConfirmDialog({
                title: game.i18n.localize("age-system.CLASS.deleteAdvancementTitle"),
                content: `<p>${game.i18n.localize("age-system.CLASS.deleteAdvancementConfirm")}</p>`,
                defaultYes: false
            });
            if (confirmed) return sheet.item._onChangeAdvancement(node?.dataset ?? {}, "remove");
        }}
    ];
}
