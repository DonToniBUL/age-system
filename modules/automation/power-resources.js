import {showConfirmDialog} from "../dialogs.js";
import {AgeTransactionService} from "./action-transactions.js";
import {AgeActionService} from "./actions.js";
import {normalizeCharacterAtomicSystemUpdate} from "../data/atomic-system-updates.js";

const locks = new Map();

function numericCost(value) {
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost < 0) throw new TypeError("Power Point cost must be a finite, non-negative number.");
  return cost;
}

function currentPowerPoints(actor) {
  const value = Number(actor?.system?.powerPoints?.value);
  if (!Number.isFinite(value) || value < 0) throw new TypeError("The Actor has an invalid Power Point value.");
  return value;
}

export class PowerResourceService {
  static normalizeCost(value) {
    return numericCost(value);
  }

  static async spend({actor, item = null, cost = 0, ageAction = null} = {}) {
    if (!actor?.update) throw new TypeError("An Actor is required to spend Power Points.");
    if (!ageAction && AgeActionService.supports("resource.power-points")) {
      const execution = await AgeActionService.execute({
        type: "resource.power-points",
        actorUuid: actor.uuid ?? null,
        itemUuid: item?.uuid ?? null,
        sourceUuid: item?.uuid ?? null,
        payload: {cost},
        metadata: {origin: "power-resources.spend"}
      }, {
        executor: action => this.spend({actor, item, cost, ageAction: action})
      });
      return execution.result;
    }
    const finalCost = numericCost(cost);
    if (finalCost === 0) return {cost: 0, spent: 0, rollback: async () => true};

    // Power Points belong to the Actor, so all of its Powers share one lock.
    // An item-specific key allows two different Powers to overspend the same
    // source value concurrently.
    const key = `${actor.uuid ?? actor.id}:power-points`;
    if (locks.has(key)) {
      ui.notifications.warn(game.i18n.localize("age-system.AUTOMATION.powerActionPending"));
      return false;
    }

    locks.set(key, true);
    try {
      const available = currentPowerPoints(actor);
      if (finalCost > available) {
        const castAnyway = await showConfirmDialog({
          title: game.i18n.localize("age-system.roll"),
          content: `<p>${game.i18n.format("age-system.rollWithoutPP", {name: actor.name, item: item?.name ?? ""})}</p>`,
          yesLabel: game.i18n.localize("age-system.roll"),
          noLabel: game.i18n.localize("age-system.cancel"),
          defaultYes: false,
        });
        if (!castAnyway) return false;
      }

      const spent = Math.min(finalCost, available);
      if (spent === 0) return {cost: finalCost, spent: 0, rollback: async () => true};
      const transaction = AgeTransactionService.begin({
        id: ageAction?.id ?? null,
        label: game.i18n.format("age-system.AUTOMATION.powerSpent", {
          actor: actor.name,
          item: item?.name ?? game.i18n.localize("age-system.power"),
          cost: spent
        }),
        type: ageAction?.type ?? "power-points",
        sourceUuid: item?.uuid ?? null,
        metadata: {requestedCost: finalCost, spent, actionSchemaVersion: ageAction?.schemaVersion ?? null}
      }).track(actor, "system.powerPoints.value");

      try {
        const update = normalizeCharacterAtomicSystemUpdate(
          {"system.powerPoints.value": available - spent},
          actor._source
        );
        await actor.update(
          update,
          {
            value: -spent,
            type: "power",
            ageAutomation: true,
            ageSystemCharacterPaths: ["powerPoints.value"]
          }
        );
        await transaction.commit();
      } catch (error) {
        await transaction.rollback({removeHistory: true});
        throw error;
      }

      return {
        cost: finalCost,
        spent,
        transaction,
        rollback: () => transaction.rollback({removeHistory: true, strict: true})
      };
    } finally {
      locks.delete(key);
    }
  }
}

export default PowerResourceService;
