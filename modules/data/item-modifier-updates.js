function rawModifiers(item) {
  return foundry.utils.deepClone(item?._source?.system?.modifiers ?? {});
}

/**
 * Build an authoritative modifier-map replacement from persisted Item source.
 * Prepared Item data contains validation metadata which must never be written
 * back merely because another modifier was removed.
 */
export function removeItemModifierUpdate(item, key) {
  const modifiers = rawModifiers(item);
  if (!Object.hasOwn(modifiers, key)) return null;
  delete modifiers[key];
  return {
    system: {
      modifiers: foundry.data.operators.ForcedReplacement.create(modifiers)
    }
  };
}

/**
 * Toggle only the persisted isActive leaf. The Item update boundary rebuilds
 * the complete AnyField from raw source, preserving every sibling byte-for-byte.
 */
export function toggleItemModifierUpdate(item, key) {
  const modifiers = item?._source?.system?.modifiers ?? {};
  if (!Object.hasOwn(modifiers, key)) return null;
  return {
    [`system.modifiers.${key}.isActive`]: !Boolean(modifiers[key]?.isActive)
  };
}
