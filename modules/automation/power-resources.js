import {showConfirmDialog} from "../dialogs.js";
import {AgeTransactionService} from "./action-transactions.js";
import {AgeActionDelegationService} from "./action-delegation.js";
import {isAuthoritativeGm} from "./authority.js";
import {normalizeCharacterAtomicSystemUpdate} from "../data/atomic-system-updates.js";

const queues = new Map();
const payments = new Map();
const PAYMENT_TTL = 15 * 60 * 1000;
const PAYMENT_LIMIT = 500;

function resourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

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

function withActorQueue(actor, callback) {
  const key = actor.uuid;
  const task = (queues.get(key) ?? Promise.resolve()).then(callback, callback);
  const tail = task.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return task;
}

function assertAuthority(actor, user) {
  if (!isAuthoritativeGm()) {
    throw resourceError("AGE_POWER_AUTHORITY", "Power Point changes require the elected active GM.");
  }
  if (!user?.active || !(user.isGM || actor.testUserPermission?.(user, "OWNER"))) {
    throw resourceError("AGE_ACTION_PERMISSION", "The requesting user does not own this Actor.");
  }
}

function rememberPayment(id, payment) {
  const now = Date.now();
  for (const [key, entry] of payments) {
    if (now - entry.createdAt > PAYMENT_TTL) payments.delete(key);
  }
  payments.set(id, payment);
  while (payments.size > PAYMENT_LIMIT) payments.delete(payments.keys().next().value);
}

export class PowerResourceService {
  static normalizeCost(value) {
    return numericCost(value);
  }

  /** Confirm on the caster's client; send all writes to the same active GM. */
  static async spend({actor, item = null, cost = 0} = {}) {
    if (!actor?.update || !actor.uuid) throw new TypeError("A persisted Actor is required to spend Power Points.");
    const finalCost = numericCost(cost);
    if (finalCost === 0) return {cost: 0, spent: 0, rollback: async () => true};
    const request = allowInsufficient => AgeActionDelegationService.request({
      type: "resource.power-points",
      actorUuid: actor.uuid,
      itemUuid: item?.uuid ?? null,
      sourceUuid: item?.uuid ?? null,
      payload: {operation: "spend", cost: finalCost, allowInsufficient},
      metadata: {origin: "power-resources.spend"}
    });
    let execution;
    try {
      execution = await request(false);
    } catch (error) {
      if (error?.code !== "AGE_POWER_INSUFFICIENT") throw error;
      const confirmed = await showConfirmDialog({
        title: game.i18n.localize("age-system.roll"),
        content: `<p>${Handlebars.escapeExpression(game.i18n.format("age-system.rollWithoutPP", {
          name: actor.name, item: item?.name ?? ""
        }))}</p>`,
        yesLabel: game.i18n.localize("age-system.roll"),
        noLabel: game.i18n.localize("age-system.cancel"),
        defaultYes: false
      });
      if (!confirmed) return false;
      execution = await request(true);
    }
    const receipt = execution.result;
    if (!receipt || receipt.actorUuid !== actor.uuid || receipt.cost !== finalCost
      || !Number.isFinite(receipt.spent) || receipt.spent < 0 || receipt.spent > finalCost
      || (receipt.spent > 0 && typeof receipt.paymentId !== "string")) {
      throw resourceError("AGE_POWER_RECEIPT", "The GM did not return a valid Power Point payment receipt.");
    }
    const rollback = async () => receipt.spent === 0
      || (await this.rollback({actor, paymentId: receipt.paymentId}))?.refunded === true;
    return {
      ...receipt,
      // A remote caller receives a transaction facade rather than a live GM
      // Document graph. Existing local integrations retain the real object.
      ...(receipt.spent > 0 ? {transaction: receipt.transaction ?? {
        id: receipt.transactionId, rollback
      }} : {}),
      rollback
    };
  }

  static async rollback({actor, paymentId} = {}) {
    if (!actor?.uuid) throw new TypeError("A persisted Actor is required.");
    const execution = await AgeActionDelegationService.request({
      type: "resource.power-points",
      actorUuid: actor.uuid,
      payload: {operation: "rollback", paymentId},
      metadata: {origin: "power-resources.rollback"}
    });
    return execution.result;
  }

  /** Coordinate the toolbox Undo with the same queue as paid casts/refunds. */
  static async coordinateUndo({entry, restore}) {
    const operations = entry?.operations;
    if (!Array.isArray(operations) || operations.length !== 1
      || operations[0].path !== "system.powerPoints.value") {
      throw new Error("This Power Point history entry requires manual GM review.");
    }
    const document = await foundry.utils.fromUuid(operations[0].uuid);
    const actor = document?.actor ?? document;
    if (!actor?.uuid || actor.uuid !== operations[0].uuid) {
      throw new Error("The Power Point Actor is unavailable for Undo.");
    }
    assertAuthority(actor, game.user);
    return withActorQueue(actor, async () => {
      assertAuthority(actor, game.user);
      const result = await restore(() => assertAuthority(actor, game.user));
      // A later refund of the same payment must remain idempotent even after
      // another cast returns the balance to the old numerical value.
      for (const payment of payments.values()) {
        if (payment.transaction.id === entry.id) payment.refunded = true;
      }
      return result;
    });
  }

  /** Called only by the authorized action handler on the elected GM. */
  static async executeAuthoritative({actor, item = null, cost = 0, operation = "spend",
    paymentId = null, allowInsufficient = false, action = null, user = game.user} = {}) {
    if (!actor?.uuid || !actor.update) throw new TypeError("A persisted Actor is required.");
    if (!["spend", "rollback"].includes(operation)) throw new TypeError("Unknown Power Point operation.");
    assertAuthority(actor, user);
    return withActorQueue(actor, async () => {
      // Permission and election may have changed while this request waited.
      assertAuthority(actor, user);
      if (operation === "rollback") {
        const payment = payments.get(paymentId);
        if (!payment || Date.now() - payment.createdAt > PAYMENT_TTL
          || payment.actorUuid !== actor.uuid || (payment.userId !== user.id && !user.isGM)) {
          throw resourceError("AGE_POWER_PAYMENT_UNAVAILABLE", "The Power Point payment cannot be refunded by this user or GM session.");
        }
        if (!payment.refunded) {
          await payment.transaction.rollback({removeHistory: true, strict: true});
          payment.refunded = true;
        }
        return {actorUuid: actor.uuid, paymentId, refunded: true};
      }
      if (item && item.actor?.uuid !== actor.uuid) throw new TypeError("The Power must belong to the selected Actor.");
      const finalCost = numericCost(cost);
      const available = currentPowerPoints(actor);
      if (finalCost > available && allowInsufficient !== true) {
        throw resourceError("AGE_POWER_INSUFFICIENT", "There are insufficient Power Points. The caster must explicitly confirm before continuing.");
      }
      const spent = Math.min(finalCost, available);
      if (spent === 0) return {actorUuid: actor.uuid, cost: finalCost, spent: 0,
        paymentId: null, rollback: async () => true};
      const transaction = AgeTransactionService.begin({
        id: action?.id ?? null,
        label: game.i18n.format("age-system.AUTOMATION.powerSpent", {
          actor: actor.name, item: item?.name ?? game.i18n.localize("age-system.power"), cost: spent
        }),
        type: "resource.power-points",
        sourceUuid: item?.uuid ?? null,
        metadata: {requestedCost: finalCost, spent, requestedBy: user.id, actionSchemaVersion: action?.schemaVersion ?? null}
      }).track(actor, "system.powerPoints.value");
      try {
        await actor.update(normalizeCharacterAtomicSystemUpdate(
          {"system.powerPoints.value": available - spent}, actor._source
        ), {value: -spent, type: "power", ageAutomation: true, ageSystemCharacterPaths: ["powerPoints.value"]});
        await transaction.commit();
      } catch (error) {
        try { await transaction.rollback({removeHistory: true, strict: true}); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Power Point payment recovery failed."); }
        throw error;
      }
      const id = foundry.utils.randomID(20);
      rememberPayment(id, {actorUuid: actor.uuid, userId: user.id, transaction, createdAt: Date.now(), refunded: false});
      return {
        actorUuid: actor.uuid, cost: finalCost, spent, paymentId: id,
        transactionId: transaction.id, transaction,
        rollback: async () => (await this.executeAuthoritative({
          actor, operation: "rollback", paymentId: id, user
        })).refunded === true
      };
    });
  }
}

export default PowerResourceService;
