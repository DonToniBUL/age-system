import {automationFeatureEnabled} from "./mode.js";

const ATTACK_ROLL_TYPES = new Set(["attack", "meleeAttack", "rangedAttack", "stuntAttack"]);

function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function targetDocument(target) {
  return target?.document ?? target;
}

function targetActor(target) {
  return target?.actor ?? target?.document?.actor ?? null;
}

function configuredMaximum(item) {
  const raw = foundry.utils.getProperty(item, "flags.age-system.automation.maxTargets")
    ?? foundry.utils.getProperty(item, "system.maxTargets");
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function escape(value) {
  return Handlebars.escapeExpression(String(value ?? ""));
}

function hasAttackResolution(result) {
  return typeof result?.hit === "boolean"
    && Number.isFinite(Number(result?.targetNumber))
    && Number.isFinite(Number(result?.margin));
}

export class MultiTargetService {
  static get enabled() {
    return automationFeatureEnabled("enableMultiTargetAttacks");
  }

  static isAttackRoll(rollType) {
    return ATTACK_ROLL_TYPES.has(rollType);
  }

  static supportsItem(item) {
    return item?.type === "weapon"
      || (item?.type === "power" && (item.system?.hasTest || item.system?.causeDamage || item.system?.hasDamage));
  }

  static collect(targets = game.user?.targets) {
    const seen = new Set();
    const collected = [];
    for (const target of collectionValues(targets)) {
      const actor = targetActor(target);
      const document = targetDocument(target);
      if (!actor) continue;
      const tokenUuid = document?.documentName === "Token" ? document.uuid : target?.document?.uuid ?? null;
      const actorUuid = actor.uuid ?? null;
      const key = tokenUuid ?? actorUuid ?? target?.id ?? actor.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      collected.push({
        key,
        tokenUuid,
        actorUuid,
        tokenId: target?.id ?? document?.id ?? null,
        name: target?.name ?? document?.name ?? actor.name,
        img: document?.texture?.src ?? target?.texture?.src ?? actor.img ?? null,
        defense: finite(actor.system?.defense?.total, 0)
      });
    }
    return collected;
  }

  static attackTargets(targets = game.user?.targets) {
    if (!this.enabled) return [];
    return this.collect(targets);
  }

  static resolve(total, targets = []) {
    const rolled = finite(total, 0);
    return targets.map(target => {
      const targetNumber = finite(target.defense, 0);
      return {
        ...foundry.utils.deepClone(target),
        targetNumber,
        total: rolled,
        margin: rolled - targetNumber,
        hit: rolled >= targetNumber
      };
    });
  }

  static hitResults(results = []) {
    return results.filter(result => result?.hit === true);
  }

  static allMissed(results = []) {
    return Array.isArray(results)
      && results.length > 0
      && results.every(result => result?.hit === false);
  }

  static actionTargets(message) {
    const action = message?.flags?.["age-system"]?.automation?.action;
    const snapshots = action?.payload?.targetSnapshots;
    if (Array.isArray(snapshots) && snapshots.length) {
      const seen = new Set();
      return snapshots.flatMap(snapshot => {
        const key = snapshot?.key ?? snapshot?.tokenUuid ?? snapshot?.actorUuid;
        if (!key || seen.has(key)) return [];
        seen.add(key);
        return [{...foundry.utils.deepClone(snapshot), key, hit: true}];
      });
    }
    const uuids = action?.targetUuids;
    if (!Array.isArray(uuids)) return [];
    return Array.from(new Set(uuids.filter(uuid => typeof uuid === "string" && uuid.trim())))
      .map(uuid => ({
        key: uuid,
        tokenUuid: uuid.includes(".Token.") ? uuid : null,
        actorUuid: uuid.startsWith("Actor.") ? uuid : null,
        name: null,
        hit: true
      }));
  }

  static argonTargetCount(item) {
    if (!this.supportsItem(item)) return 0;
    if (!this.enabled) return 1;
    return configuredMaximum(item) ?? 1;
  }

  static shouldBypassArgonTargetPicker(item, targets = game.user?.targets) {
    return this.enabled && this.supportsItem(item) && collectionValues(targets).length > 1;
  }

  static async resolveDocuments(results = [], {hitsOnly = true} = {}) {
    const entries = hitsOnly ? this.hitResults(results) : results;
    const resolved = [];
    const seen = new Set();
    for (const entry of entries) {
      const key = entry.tokenUuid ?? entry.actorUuid;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      let document = entry.tokenUuid ? await foundry.utils.fromUuid(entry.tokenUuid) : null;
      if (document?.documentName === "Token" || document?.actor) {
        resolved.push(document.object ?? document);
        continue;
      }
      const actor = entry.actorUuid ? await foundry.utils.fromUuid(entry.actorUuid) : document;
      if (!actor) continue;
      resolved.push({
        actor,
        document: {
          actor,
          actorLink: true,
          uuid: actor.uuid,
          texture: {src: entry.img ?? actor.prototypeToken?.texture?.src ?? actor.img}
        }
      });
    }
    return resolved;
  }

  static decorate(message, html) {
    const results = message?.flags?.["age-system"]?.ageroll?.rollData?.targetResults;
    if (!this.enabled || !Array.isArray(results) || !results.length || !html?.querySelector) return;
    const root = html.querySelector(".age-system.age-roll-card, .age-roll-card, .base-age-roll");
    if (!root || root.querySelector(".age-multi-target-results")) return;
    const section = document.createElement("section");
    section.className = "age-multi-target-results";
    section.style.cssText = "margin:.35rem 0;padding:.35rem;border-top:1px solid rgba(0,0,0,.25);border-bottom:1px solid rgba(0,0,0,.25)";
    const rows = results.map(result => {
      if (!hasAttackResolution(result)) {
        return `<div class="flexrow" style="align-items:center;gap:.35rem"><span style="flex:1 1 auto"><i class="fa-solid fa-bullseye"></i> ${escape(result.name)}</span></div>`;
      }
      const key = result.hit ? "hit" : "miss";
      const icon = result.hit ? "fa-bullseye" : "fa-xmark";
      return `<div class="flexrow" style="align-items:center;gap:.35rem"><span style="flex:1 1 auto"><i class="fa-solid ${icon}"></i> ${escape(result.name)}</span><span class="notes">${escape(game.i18n.format("age-system.AUTOMATION.targetResult", {defense: result.targetNumber, result: game.i18n.localize(`age-system.${key}`), margin: result.margin >= 0 ? `+${result.margin}` : result.margin}))}</span></div>`;
    }).join("");
    section.innerHTML = `<strong>${escape(game.i18n.localize("age-system.AUTOMATION.multiTargetResults"))}</strong>${rows}`;
    const rollBody = root.querySelector(".roll-body");
    if (rollBody?.after) rollBody.after(section);
    else root.append(section);
  }
}

export default MultiTargetService;
