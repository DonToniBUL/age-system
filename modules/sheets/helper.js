/**Prevent Items to be created on non campatible Actor types
 * @param actor actor document
 * @param itemType string containing Item type
 * @param itemName string with Item name
 */
export function newItemData(actor, itemData) {
    const actorType = actor.type;
    if (!Array.isArray(itemData)) itemData = [itemData];
    const warning = [];

    for (let i = 0; i < itemData.length; i++) {
        const item = itemData[i];
        
        const itemType = item.type;
        const itemName = item.name;

        // Warning about Class Item type not being ready yet for use - Remove when automation is completed
        // if (itemType == "class") warning.push({index: i, warn: "'Class' Item type is still a work in progress and can not be added to Characters. Complete features are expected in a future release."})
    
        switch (actorType) {
            case "vehicle":
                warning.push({index: i, warn: game.i18n.localize("age-system.WARNING.vehicleItem")});
                break;
            case "spaceship":
                if (itemType !== 'shipfeatures') {
                    warning.push({index: i, warn: game.i18n.localize("age-system.WARNING.nonShipPartsOnShip")});
                };
                break;
            case "char":
                if (itemType === 'shipfeatures') {
                    warning.push({index: i, warn: game.i18n.localize("age-system.WARNING.shipPartsOnChar")});
                };
                if (itemType === 'focus') {
                    const focusItems = actor.items.filter(f => f.type === "focus");
                    const hasFocus = focusItems.filter(f => f.name.toLowerCase() === itemName.toLowerCase());
                    if (item.system.isOrg) {
                        warning.push({index: i, warn: game.i18n.localize("age-system.WARNING.orgFocusToChar")});
                    } else if (hasFocus.length > 0) {
                        warning.push({index: i, warn: game.i18n.localize("age-system.WARNING.duplicatedFocus") + `"${itemName.toUpperCase()}"`});
                    }
                };
                if (itemType === 'class') {
                    const ownedClasses = actor.items.filter(f => f.type === "class");
                    const hasClass = ownedClasses ? ownedClasses.length : 0;
                    if (hasClass > 0) warning.push({index: i, warn: game.i18n.localize("age-system.WARNING.actorHasClass")});
                }
                break;
            case "organization":
                if (itemType !== 'focus') {
                    warning.push({index: i, warn: game.i18n.localize("age-system.WARNING.orgItem")});
                } else if (!item.system.isOrg) {
                    warning.push({index: i, warn: game.i18n.localize("age-system.WARNING.charFocusToOrg")});
                } else {
                    const hasFocus = actor.items.filter(f => f.name.toLowerCase() === itemName.toLowerCase());
                    if (hasFocus.length > 0) {
                        warning.push({index: i, warn: game.i18n.localize("age-system.WARNING.duplicatedFocus") + `"${itemName.toUpperCase()}"`});
                    };
                };
                break;
            default:
                break;
        };
    }

    if (warning.length) {
        for (let s = warning.length-1; s >= 0; s--) {
            const w = warning[s]
            ui.notifications.warn(w.warn)
            itemData.splice(w.index, 1);
        }
    }
    return itemData;
};

export async function dropChar(event, vehicle) {
    let dragData;
    try {
        dragData = JSON.parse(event.dataTransfer.getData("text/plain"));
    } catch (error) {
        return false;
    }
    if (!dragData?.uuid) return false;
    const document = await foundry.utils.fromUuid(dragData.uuid);
    const data = document?.documentName === "Token" ? document.actor : document;
    if (data?.documentName === "Actor") {
        if (data.type === "char") {
            const passengerData = {
                id : data.id,
                isToken : data.isToken
            };
            const passengerList = foundry.utils.deepClone(vehicle.system.passengers ?? []);
            let alreadyOnboard = false;
            passengerList.map( p => {
                if (p.id === passengerData.id) {
                    alreadyOnboard = true;
                    const parts = {name: p.name, id: p.id};
                    let warning = game.i18n.format("age-system.WARNING.alreadyOnboard", parts);
                    ui.notifications.warn(warning);
                }
            });

            if (!alreadyOnboard) {
                passengerList.push(passengerData);
                await vehicle.update({"system.passengers" : passengerList});
            }
        } else {
            const warning = game.i18n.localize("age-system.WARNING.vehicleIsNotPassenger");
            ui.notifications.warn(warning);
        }
    } else return false;
    return true;
}
export function normalizeFreeTextFields(html, actor) {
    const updates = {};
    const freeText = html.find("textarea.free-text");
    for (const area of freeText) {
        if (!area.name) continue;
        const normalized = area.value.replace(/^\s+|\s+$/gm, "");
        area.value = normalized;
        if (foundry.utils.getProperty(actor, area.name) !== normalized) updates[area.name] = normalized;
    }
    if (foundry.utils.isEmpty(updates)) return Promise.resolve(actor);
    return actor.update(updates).catch(error => {
        console.error("AGE System | Failed to normalize sheet text fields.", error);
        ui.notifications.error(game.i18n.localize("age-system.WARNING.sheetTextUpdateFailed"));
        return false;
    });
}
