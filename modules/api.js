export const AGE_API_VERSION = "1.4.0";

const CAPABILITIES = Object.freeze({
  transactions: Object.freeze({
    version: 2,
    multiDocument: true,
    conflictAwareUndo: true,
    inFlightDeduplication: true
  }),
  contentValidation: Object.freeze({
    version: 2,
    world: true,
    compendia: true,
    mutatesDocuments: false,
    migrationPreview: true
  }),
  actions: Object.freeze({
    version: 1,
    available: true,
    schemaVersion: 1,
    diagnostics: true,
    templates: true,
    gmDelegation: true
  }),
  progression: Object.freeze({
    version: 2,
    available: true,
    definitionVersion: 2,
    definitionVersions: Object.freeze([1, 2]),
    previewVersion: 1,
    receiptVersion: 1,
    providerNeutral: true,
    contentModuleRequired: false,
    previewFirst: true,
    targetedUndo: true,
    characterBuilder: true,
    advancementCenter: true,
    authoringUi: true,
    executabilityValidation: true
  }),
  npcStudio: Object.freeze({
    version: 1,
    available: true,
    creationOnly: true,
    previewFirst: true,
    targetedUndo: true,
    origins: Object.freeze(["blank", "paste", "clone"])
  })
});

/**
 * Construct the stable, additive API intended for modules and macros. Legacy
 * game.ageSystem properties remain available during the 4.x compatibility
 * cycle, but new integrations should feature-detect this API instead.
 */
export function createAgeSystemApi({transactions, contentValidator, migrationPreview = null, actions, delegation, progression, npcStudio, systemVersion = null} = {}) {
  if (!transactions || !contentValidator || !actions || !delegation || !progression || !npcStudio) throw new TypeError("AGE API services are required.");
  if (!(progression.validateExecutability instanceof Function)) {
    throw new TypeError("AGE progression API requires executability validation support.");
  }

  const api = {
    apiVersion: AGE_API_VERSION,
    systemVersion,
    capabilities: CAPABILITIES,
    transactions: Object.freeze({
      begin: metadata => transactions.begin(metadata),
      execute: request => transactions.execute(request),
      history: () => transactions.history(),
      undoLast: () => transactions.undoLast(),
      pending: operationId => transactions.pending(operationId)
    }),
    content: Object.freeze({
      validateDocument: document => contentValidator.validateDocument(document),
      validateDocuments: (documents, options) => contentValidator.validateDocuments(documents, options),
      validateWorld: options => contentValidator.validateWorld(options),
      previewMigration: (documents, options) => migrationPreview?.previewDocuments(documents, options),
      previewWorldMigration: options => migrationPreview?.previewWorld(options)
    }),
    actions: Object.freeze({
      supports: type => actions.supports(type),
      validate: request => actions.validate(request),
      preview: request => actions.preview(request),
      execute: request => actions.execute(request),
      request: (request, options) => delegation.request(request, options),
      pending: id => actions.pending(id),
      status: () => actions.status(),
      delegation: () => delegation.status(),
      history: options => actions.history(options),
      definitions: () => actions.definitions(),
      templates: () => actions.templates(),
      create: (templateId, overrides) => actions.create(templateId, overrides)
    }),
    progression: Object.freeze({
      validateDefinition: definition => progression.validateDefinition(definition),
      validateExecutability: (definition, options) => progression.validateExecutability(definition, options),
      registerDefinition: (definition, options) => progression.registerDefinition(definition, options),
      unregisterDefinition: definitionId => progression.unregisterDefinition(definitionId),
      getDefinition: definitionId => progression.getDefinition(definitionId),
      definitions: filters => progression.listDefinitions(filters),
      provider: definitionId => progression.provider(definitionId),
      definitionRecord: definitionId => progression.definitionRecord(definitionId),
      previewCreation: options => progression.previewCreation(options),
      previewAdvancement: options => progression.previewAdvancement(options),
      commitCreation: (previewId, planDigest) => progression.commitCreation(previewId, planDigest),
      commitAdvancement: (previewId, planDigest) => progression.commitAdvancement(previewId, planDigest),
      receipt: receiptId => progression.lookupReceipt(receiptId),
      receipts: filters => progression.receipts(filters),
      previewUndo: receiptId => progression.previewUndo(receiptId),
      undo: (receiptId, options) => progression.undo(receiptId, options),
      status: () => progression.status(),
      capabilities: () => progression.capabilities()
    }),
    npcStudio: Object.freeze({
      createDraft: options => npcStudio.createDraft(options),
      preview: draft => npcStudio.preview(draft),
      searchActors: (query, options) => npcStudio.searchActors(query, options),
      searchItems: (query, options) => npcStudio.searchItems(query, options),
      commit: (previewId, digests) => npcStudio.commit(previewId, digests),
      cancel: previewId => npcStudio.cancel(previewId),
      previewUndo: receiptId => npcStudio.previewUndo(receiptId),
      undo: (receiptId, options) => npcStudio.undo(receiptId, options),
      receipt: receiptId => npcStudio.receipt(receiptId),
      getActiveProfile: () => npcStudio.getActiveProfile(),
      status: () => npcStudio.status(),
      capabilities: () => npcStudio.capabilities()
    }),
    hasCapability(name, minimumVersion = 1) {
      const capability = CAPABILITIES[name];
      return Boolean(capability?.available !== false && Number(capability?.version) >= Number(minimumVersion));
    }
  };
  return Object.freeze(api);
}

export default createAgeSystemApi;
