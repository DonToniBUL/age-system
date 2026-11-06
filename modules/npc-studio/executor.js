import {canonicalClone, canonicalJson} from "../progression/canonical.js";
import {digestNpcStudioActor} from "./compiler.js";
import {npcStudioError} from "./contracts.js";
import {
  createNpcStudioReceipt,
  getNpcStudioReceipt,
  markNpcStudioReceiptUndone,
  npcStudioReceiptUpdate,
} from "./receipts.js";

function permissionAllowsCreation(user) {
  if (user?.isGM !== true) return false;
  try { return user.can?.("ACTOR_CREATE") === true; } catch (_error) { return false; }
}

function actorCollection(environment) {
  const collection = environment?.game?.actors;
  const documentClass = collection?.documentClass ?? environment?.CONFIG?.Actor?.documentClass ?? environment?.Actor;
  if (!(documentClass?.createDocuments instanceof Function)) {
    throw npcStudioError("AGE_NPC_STUDIO_ACTOR_COLLECTION", "Foundry Actor creation is unavailable.");
  }
  return {collection, documentClass};
}

function actorById(collection, id) {
  if (!collection || !id) return null;
  const direct = collection.get instanceof Function ? collection.get(id) : null;
  if (direct) return direct;
  const entries = Array.isArray(collection.contents) ? collection.contents : [];
  return entries.find(entry => String(entry?.id ?? entry?._id ?? "") === String(id)) ?? null;
}

function hasNpcStudioCreationBinding(actor, {session} = {}) {
  const source = actor?._source ?? (actor?.toObject instanceof Function ? actor.toObject(false) : actor);
  const binding = source?.flags?.["age-system"]?.npcStudio;
  return binding?.schemaVersion === 1
    && binding?.draftId === session?.draft?.draftId
    && binding?.profileId === session?.profileSnapshot?.profileId
    && binding?.kind === session?.draft?.identity?.kind
    && binding?.origin === session?.draft?.origin?.kind;
}

async function removeActor(actor, environment) {
  const id = actor?.id ?? actor?._id;
  const {documentClass} = actorCollection(environment);
  if (id && documentClass.deleteDocuments instanceof Function) {
    await documentClass.deleteDocuments([id]);
    return true;
  }
  if (actor?.delete instanceof Function) {
    await actor.delete();
    return true;
  }
  throw npcStudioError("AGE_NPC_STUDIO_ACTOR_COLLECTION", "Foundry Actor deletion is unavailable.");
}

async function validateCreatedActor(actor, environment) {
  const validate = environment?.game?.ageSystem?.api?.content?.validateDocument;
  if (!(validate instanceof Function)) return Object.freeze({valid: true, issues: []});
  let result;
  try { result = await validate(actor); }
  catch (error) {
    throw npcStudioError("AGE_NPC_STUDIO_CONTENT_VALIDATION", `AGE content validation failed: ${error?.message ?? error}`, {cause: error});
  }
  if (!result?.valid) {
    throw npcStudioError("AGE_NPC_STUDIO_CONTENT_INVALID", "The created NPC failed AGE content validation.", {issues: result?.issues ?? []});
  }
  return result;
}

export class AgeNpcStudioExecutor {
  #environment;
  #clock;

  constructor({environment = globalThis, clock = () => Date.now()} = {}) {
    this.#environment = environment;
    this.#clock = clock;
  }

  async commit({session, plan, user = this.#environment?.game?.user} = {}) {
    if (!permissionAllowsCreation(user)) throw npcStudioError("AGE_NPC_STUDIO_PERMISSION", "NPC Studio requires a Game Master with Actor creation permission.");
    if (!session || !plan || plan.planDigest !== session.planDigest) {
      throw npcStudioError("AGE_NPC_STUDIO_PLAN_STALE", "NPC Studio creation plan does not match its signed preview.");
    }
    const {collection, documentClass} = actorCollection(this.#environment);
    const source = canonicalClone(plan.actorSource);
    if (actorById(collection, plan.targetActorId)) {
      throw npcStudioError("AGE_NPC_STUDIO_ACTOR_ID_COLLISION", "The signed NPC Studio Actor id is already in use. Refresh the preview and try again.");
    }
    let actor = null;
    try {
      const created = await documentClass.createDocuments([source], {
        keepId: true,
        keepEmbeddedIds: true,
        renderSheet: false,
        ageNpcStudio: true,
        ageNpcStudioPreviewId: session.id,
      });
      if (!Array.isArray(created) || created.length !== 1) {
        throw npcStudioError("AGE_NPC_STUDIO_CREATE_RESULT", "Foundry did not return exactly one created NPC Actor.");
      }
      actor = created[0];
      const actorId = actor?.id ?? actor?._id;
      const actorUuid = actor?.uuid ?? (actorId ? `Actor.${actorId}` : null);
      if (String(actorId) !== String(plan.targetActorId) || actorUuid !== `Actor.${plan.targetActorId}`) {
        throw npcStudioError("AGE_NPC_STUDIO_CREATE_BINDING", "Created Actor id does not match the signed NPC Studio plan.");
      }
      const afterDigest = await digestNpcStudioActor(actor);
      const cloneBinding = session.draft.origin.kind === "clone"
        ? session.sourceSnapshots.find(binding => binding.uuid === session.draft.origin.sourceActorUuid)
        : null;
      const now = Number(this.#clock());
      const receipt = createNpcStudioReceipt({
        id: `npc-create:${session.id}`,
        previewId: session.id,
        inputDigest: session.inputDigest,
        snapshotDigest: session.snapshotDigest,
        planDigest: session.planDigest,
        profileId: session.profileSnapshot.profileId,
        actorUuid,
        afterDigest,
        sourceActorUuid: cloneBinding?.uuid ?? null,
        sourceDigest: cloneBinding?.digest ?? null,
        createdAt: session.createdAt,
        committedAt: now,
        committedBy: user.id,
      }, {now});
      if (!(actor.update instanceof Function)) throw npcStudioError("AGE_NPC_STUDIO_RECEIPT_WRITE", "Created Actor cannot persist its NPC Studio receipt.");
      try { await actor.update(npcStudioReceiptUpdate(receipt), {ageNpcStudioReceipt: true}); }
      catch (cause) {
        throw npcStudioError("AGE_NPC_STUDIO_RECEIPT_WRITE", "Created Actor could not persist its NPC Studio receipt.", {cause});
      }
      const persisted = getNpcStudioReceipt(actor);
      const verifiedDigest = await digestNpcStudioActor(actor);
      if (!persisted || canonicalJson(persisted) !== canonicalJson(receipt) || verifiedDigest !== receipt.afterDigest) {
        throw npcStudioError("AGE_NPC_STUDIO_RECEIPT_WRITE", "Created Actor did not preserve its signed NPC Studio receipt.");
      }
      const validation = await validateCreatedActor(actor, this.#environment);
      return Object.freeze({actor, actorId, actorUuid, receipt, validation, previewId: session.id, planDigest: session.planDigest});
    } catch (error) {
      const lookedUpActor = actorById(collection, plan.targetActorId);
      const cleanupActor = hasNpcStudioCreationBinding(actor, {session})
        ? actor
        : hasNpcStudioCreationBinding(lookedUpActor, {session}) ? lookedUpActor : null;
      if (!cleanupActor) throw error;
      try { await removeActor(cleanupActor, this.#environment); }
      catch (cleanupError) {
        throw npcStudioError(
          "AGE_NPC_STUDIO_ROLLBACK_FAILED",
          `NPC creation failed and the incomplete Actor could not be removed: ${cleanupError?.message ?? cleanupError}`,
          {cause: error, cleanupError}
        );
      }
      throw error;
    }
  }

  async verifyUndo(actor, receipt) {
    if (!actor || !receipt) return Object.freeze({allowed: false, reasons: Object.freeze(["missing-document"])});
    const reasons = [];
    const persisted = getNpcStudioReceipt(actor);
    if (!persisted || canonicalJson(persisted) !== canonicalJson(receipt)) reasons.push("receipt-mismatch");
    const actorId = actor.id ?? actor._id;
    if (receipt.actorUuid !== `Actor.${actorId}`) reasons.push("actor-mismatch");
    const currentDigest = await digestNpcStudioActor(actor);
    if (currentDigest !== receipt.afterDigest) reasons.push("actor-changed");
    if (receipt.state !== "committed" || receipt.reversible !== true) reasons.push("receipt-state");
    return Object.freeze({allowed: reasons.length === 0, reasons: Object.freeze(reasons), currentDigest, expectedDigest: receipt.afterDigest});
  }

  async undo(actor, receipt, {user = this.#environment?.game?.user} = {}) {
    if (!permissionAllowsCreation(user)) throw npcStudioError("AGE_NPC_STUDIO_PERMISSION", "NPC Studio requires a Game Master with Actor creation permission.");
    const verification = await this.verifyUndo(actor, receipt);
    if (!verification.allowed) {
      throw npcStudioError("AGE_NPC_STUDIO_UNSAFE_UNDO", `NPC Studio cannot undo this Actor safely: ${verification.reasons.join(", ")}.`, {verification});
    }
    await removeActor(actor, this.#environment);
    return Object.freeze({
      actorId: actor.id ?? actor._id,
      actorUuid: receipt.actorUuid,
      receipt: markNpcStudioReceiptUndone(receipt, {now: Number(this.#clock())}),
    });
  }
}
