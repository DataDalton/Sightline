// One value for the whole process, whichever copy of a module asks for it.
//
// Next.js loads a module once for each part of the server that imports it.
// Background work, route handlers and page rendering each get a copy, and a
// value declared at the top of a module is a separate value in each. For a
// connection pool that meant a pool per copy, so one process opened several
// times the connections it was configured for, and one copy could have every
// connection busy with requests waiting while another held idle ones. For a
// cache it meant the same answer loaded and held once per copy.
//
// Kept on the process's global object under a fixed name, the value is made by
// the first copy to ask and found by the rest. Each replica is its own process
// and keeps its own.
export function perProcess<T>(name: string, create: () => T): T {
	const key = Symbol.for(`sightline.${name}`);
	const holder = globalThis as unknown as Record<symbol, T | undefined>;
	let value = holder[key];
	if (value === undefined) {
		value = create();
		holder[key] = value;
	}
	return value;
}
