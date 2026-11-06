import {AgeProgressionAdvancementExecutor} from "./advancement-executor.js";
import {AgeActorProgressionAdvancementExecutor} from "./actor-advancement-executor.js";

function routerError(message, code = "advancement-routing") {
  const error = new Error(message);
  error.name = "AgeProgressionAdvancementRouterError";
  error.code = code;
  return error;
}

function definitionTrackKind(definition) {
  const kind = definition?.trackBinding?.kind;
  if (kind !== "class-item" && kind !== "actor") throw routerError("Definition has no supported progression track binding.", "track-binding");
  return kind;
}

function executionKind(preview) {
  const execution = preview?.advancementBindings?.execution;
  if (execution !== "class-transaction-v1" && execution !== "actor-transaction-v1") {
    throw routerError("Signed advancement preview has no supported executor binding.", "preview-binding");
  }
  return execution;
}

/**
 * Provider-neutral dispatch between the unchanged Class transaction engine and
 * the dedicated Actor-track transaction engine. Selection is always made from
 * the signed DefinitionV1/PreviewV1 binding, never provider provenance.
 */
export class AgeProgressionAdvancementRouter {
  constructor({classExecutor = new AgeProgressionAdvancementExecutor(), actorExecutor = new AgeActorProgressionAdvancementExecutor()} = {}) {
    this.classExecutor = classExecutor;
    this.actorExecutor = actorExecutor;
  }

  get previewStore() { return this.classExecutor.previewStore ?? this.actorExecutor.previewStore; }

  prepareFormulaResolver(definition, resolveFormula) {
    return definitionTrackKind(definition) === "class-item"
      ? this.classExecutor.prepareFormulaResolver(definition, resolveFormula)
      : this.actorExecutor.prepareFormulaResolver(definition, resolveFormula);
  }

  acceptPreview(options = {}) {
    return definitionTrackKind(options.definition) === "class-item"
      ? this.classExecutor.acceptPreview(options)
      : this.actorExecutor.acceptPreview({...options, classItem: undefined});
  }

  commitPreview(options = {}) {
    return executionKind(options.preview) === "class-transaction-v1"
      ? this.classExecutor.commitPreview(options)
      : this.actorExecutor.commitPreview({...options, classItem: undefined});
  }

  previewUndo(options = {}) {
    const execution = options.receiptContext?.execution
      ?? (options.classItem ? "class-transaction-v1" : "actor-transaction-v1");
    return execution === "class-transaction-v1"
      ? this.classExecutor.previewUndo(options)
      : this.actorExecutor.previewUndo({...options, classItem: undefined});
  }

  undo(options = {}) {
    const execution = options.receiptContext?.execution
      ?? (options.classItem ? "class-transaction-v1" : "actor-transaction-v1");
    return execution === "class-transaction-v1"
      ? this.classExecutor.undo(options)
      : this.actorExecutor.undo({...options, classItem: undefined});
  }
}

