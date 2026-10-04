// How many warehouse sessions one process holds open at most, across everyone
// it is querying for. Kept apart from lib/data/userSession, which loads the
// warehouse driver, so the demo's stand-in warehouse is held to the same
// number without loading it.
export const maxWarehouseSessions = 200;
