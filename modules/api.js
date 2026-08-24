export const AGE_API_VERSION = "1.2.0";

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
  })
});

/**
 * Construct the stable, additive API intended for modules and macros. Legacy
 * game.ageSystem properties remain available during the 4.x compatibility
 * cycle, but new integrations should feature-detect this API instead.
 */
export function createAgeSystemApi({transactions, contentValidator, migrationPreview = null, actions, delegation, systemVersion = null} = {}) {
  if (!transactions || !contentValidator || !actions || !delegation) throw new TypeError("AGE API services are required.");

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
    hasCapability(name, minimumVersion = 1) {
      const capability = CAPABILITIES[name];
      return Boolean(capability?.available !== false && Number(capability?.version) >= Number(minimumVersion));
    }
  };
  return Object.freeze(api);
}

export default createAgeSystemApi;
