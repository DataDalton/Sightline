// A concurrency gate. Held per process by its callers, see lib/perProcess.
//
// Work handed to a gate runs at most `limit` at a time, and the rest waits in
// arrival order. This bounds what one replica asks of a shared resource, such
// as a warehouse session or the Postgres pool, without limiting what any reader
// may ask for. Every task still runs, only later.

export interface Gate {
	// Runs the task once a slot is free.
	run<T>(task: () => Promise<T>): Promise<T>;
	// Runs the task like run, unless more than maxQueued tasks are already
	// waiting, in which case the task is not run and null is returned. For work
	// whose loss costs nothing but a repeat, such as a cache write.
	tryRun<T>(task: () => Promise<T>, maxQueued: number): Promise<T> | null;
	active(): number;
	queued(): number;
}

export function createGate(limit: number): Gate {
	const slots = Math.max(1, Math.floor(limit));
	let running = 0;
	const waiting: (() => void)[] = [];

	// Hands the freed slot straight to the next waiter, so the running count
	// never dips and a task arriving in between cannot jump the queue.
	const release = () => {
		const next = waiting.shift();
		if (next) next();
		else running--;
	};

	const run = <T>(task: () => Promise<T>): Promise<T> => {
		const start = (): Promise<T> => {
			let pending: Promise<T>;
			try {
				pending = task();
			} catch (error) {
				pending = Promise.reject(error);
			}
			return pending.finally(release);
		};
		if (running < slots) {
			running++;
			return start();
		}
		return new Promise<void>((resolve) => waiting.push(resolve)).then(
			start,
		);
	};

	return {
		run,
		tryRun: (task, maxQueued) => {
			if (running >= slots && waiting.length >= maxQueued) return null;
			return run(task);
		},
		active: () => running,
		queued: () => waiting.length,
	};
}
