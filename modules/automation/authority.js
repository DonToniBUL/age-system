/** One active GM processes automatic world mutations on every client. */
export function authoritativeGm() {
  const collection = globalThis.game?.users;
  const users = collection?.values instanceof Function
    ? Array.from(collection.values())
    : Array.from(collection ?? []);
  return users.filter(user => user?.active === true && user?.isGM === true)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

export function isAuthoritativeGm() {
  const current = globalThis.game?.user;
  return current?.isGM === true && authoritativeGm()?.id === current.id;
}
