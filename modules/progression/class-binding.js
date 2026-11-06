function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceSystem(classItem) {
  return classItem?._source?.system ?? classItem?.system ?? {};
}

function sourceFlags(classItem) {
  return classItem?._source?.flags ?? classItem?.flags ?? {};
}

/**
 * Collect provider-neutral identifiers carried by an owned Class Item.
 * World-authored Classes may expose system.progression.trackId, while copies
 * imported from a compendium retain their source UUID in core metadata.
 */
export function classTrackDescriptor(classItem) {
  const system = sourceSystem(classItem);
  const flags = sourceFlags(classItem);
  const trackIds = new Set([
    text(system?.progression?.trackId),
    text(flags?.["age-system"]?.progression?.trackId),
  ].filter(Boolean));
  const sourceUuids = new Set([
    text(classItem?.uuid),
    text(flags?.core?.sourceId),
    text(classItem?._source?._stats?.compendiumSource),
    text(classItem?._stats?.compendiumSource),
  ].filter(Boolean));
  return Object.freeze({
    trackIds: Object.freeze([...trackIds].sort()),
    sourceUuids: Object.freeze([...sourceUuids].sort()),
  });
}

/** Match a signed DefinitionV1 Class binding against one selected Class. */
export function classBindingMatches(definitionOrBinding, classItem) {
  const binding = definitionOrBinding?.trackBinding ?? definitionOrBinding;
  if (binding?.kind && binding.kind !== "class-item") return false;
  const trackId = text(binding?.trackId);
  if (!trackId || !classItem) return false;
  const descriptor = classTrackDescriptor(classItem);
  if (descriptor.trackIds.includes(trackId)) return true;
  const allowedSources = new Set(Array.isArray(binding?.sourceUuids) ? binding.sourceUuids.map(text).filter(Boolean) : []);
  return descriptor.sourceUuids.some(uuid => allowedSources.has(uuid));
}
