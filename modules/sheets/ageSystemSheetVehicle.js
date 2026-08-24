import * as Dice from "../dice.js";
import {ageSystem} from "../config.js";
import { sortObjArrayByName } from "../setup.js";
import {dropChar, newItemData, normalizeFreeTextFields} from "./helper.js";

export default class ageSystemVehicleSheet extends foundry.appv1.sheets.ActorSheet {
    get isSynth() {
        return (this.token && !this.token.actorLink);
    }  
    
    get observerRoll () {
        return game.settings.get("age-system", "observerRoll");
    }  

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            width: 680,
            height: 755,
            resizable: true,
            classes: ["age-system", "sheet", "vehicle"]
        });
    }
    
    get template() {
        return `systems/age-system/templates/sheets/${this.actor.type}-sheet.hbs`;
    }

    // Manage data when Actor is droped on Vehicle sheet
    async _onDrop(event) {
        return await dropChar(event, this.actor) ? null : super._onDrop(event);
    }

    getData() {
        // const data = super.getData();
        const isOwner = this.document.isOwner;
        const isEditable = this.isEditable;
    
        // Copy actor data to a safe copy
        const data = this.actor.toObject(false);

        data.config = CONFIG.ageSystem;
        data.passengers = sortObjArrayByName(data.system.passengers ?? [], "name");

        // return data;
        return {
            actor: this.object,
            cssClass: isEditable ? "editable" : "locked",
            data: data,
            effects: data.effects,
            items: data.items,
            limited: this.object.limited,
            options: this.options,
            owner: isOwner,
            title: this.title,
            isGM: game.user.isGM,
            system: data.system
        };
    };

    activateListeners(html) {
        if (this.isEditable) {
            void normalizeFreeTextFields(html, this.actor);
            // Enable field to be focused when selecting it
            const inputs = html.find("input");
            inputs.focus(ev => ev.currentTarget.select());
        };

        html.on("dragenter", ".passenger-container", ev => {
            ev.target.classList.add("dragover")
        })
        html.on("dragleave", ".passenger-container", ev => {
            ev.target.classList.remove("dragover")
        })
        
        // Actions by sheet owner and observers (if optional setting is TRUE)
        if (this.actor.isOwner || this.observerRoll) {

            html.find(".roll-vehicle-dmg")
                .click(this._onVehicleDamage.bind(this))
                .contextmenu(this._onVehicleDamage.bind(this));
            html.find(".roll-maneuver")
                .click(this._onRollManeuver.bind(this))
                .contextmenu(this._onRollManeuver.bind(this));

        };
        
        // Actions by Owner only
        if (this.actor.isOwner) {
            let handler = ev => this._onDragStart(ev);
            // Find all rollable items on the character sheet.
            let items = html.find(".item-box");
            for (let i = 0; i < items.length; i++) {
                const el = items[i];
                if (el.draggable) {
                    el.addEventListener("dragstart", handler, false);
                }   
            }
            html.find(".remove-passenger").click(this._onRemovePassenger.bind(this));
        }
        
        super.activateListeners(html);
    };

    _onDropItemCreate(itemData) {
        itemData = newItemData(this.actor, itemData);
        if (!itemData.length) return false
        return super._onDropItemCreate(itemData);
    }

    _onRemovePassenger(event) {
        let update = {};
        let passengerKey = event.currentTarget.closest(".feature-controls").dataset.passengerKey;
        passengerKey = Number(passengerKey);
        const crew = foundry.utils.deepClone(this.object.system.passengers ?? []);
        if (!crew[passengerKey]) return false;
        if (crew[passengerKey].isConductor) update = {"system.conductor": ""}
        crew.splice(passengerKey, 1);
        return this.actor.update({...update, "system.passengers": crew});
    };

    _onRollManeuver(event) {
        const vehicleData = this.actor.system;
        let conductorId;
        if (event.currentTarget.classList.contains("is-synth")) {
            conductorId = "synth-vehicle";
        } else {
            conductorId = vehicleData.conductor;
        }
        if (conductorId === "") return false;

        let conductorData; 
        let user;
        if (conductorId === "synth-vehicle") {
            const speaker = ChatMessage.getSpeaker();
            if (speaker.token) user = game.actors.tokens?.[speaker.token];
            if (!user) user = game.actors.get(speaker.actor);
            conductorData = user;
            if (user?.type !== "char") return false;
        } else {
            conductorData = vehicleData.passengers.find(p => p.id === conductorId || p.isConductor === true);
            if (!conductorData) {
                const parts = {name: "", id: conductorId};
                let warning = game.i18n.format("age-system.WARNING.userNotAvailable", parts);
                return ui.notifications.warn(warning);
            };
            if (conductorData.isToken) user = game.actors.tokens?.[conductorData.id];
            if (!conductorData.isToken) user = game.actors.get(conductorData.id);
            if (!user) {
                const parts = {name: conductorData.name ?? "", id: conductorData.id};
                return ui.notifications.warn(game.i18n.format("age-system.WARNING.userNotAvailable", parts));
            }
        }
        
        const handlingUseFocus = vehicleData.handling.useFocus;
        const handlingFocusItem = user.checkFocus(handlingUseFocus);
        const handlingUseAbl = vehicleData.handling.useAbl;
        const rollData = {
            event: event,
            actor: user,
            abl: handlingUseAbl,
            flavor: user.name,
            flavor2: game.i18n.format("age-system.chatCard.maneuversVehicle",{vehicle: this.actor.name}),
            vehicleHandling: vehicleData.handling.mod,
            itemRolled: handlingFocusItem.id === null ? handlingFocusItem.focusName : handlingFocusItem.focusItem,
            rollType: ageSystem.ROLL_TYPE.VEHICLE_ACTION
        }
        return Dice.ageRollCheck(rollData);
    };

    _onVehicleDamage(event) {
        event.preventDefault();
        const actorData = this.actor.system;
        const e = event.currentTarget;
        const addRam = e.classList.contains('add-ram') ? true : false;
        const isCollision = e.closest(".feature-controls").classList.contains('collision');
        const damageSource = isCollision ? 'collision' : 'sideswipe';
        const qtdDice = e.closest(".feature-controls").dataset.qtdDice;
        const operatorId = actorData.conductor;
        const operatorData = operatorId ? actorData.passengers.filter(p => p.id === operatorId)[0] : null;
        const damageData = {event: event, qtdDice, addRam, operatorData, damageSource};
        return this.actor.rollVehicleDamage(damageData);
    };
};
