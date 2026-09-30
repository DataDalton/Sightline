// Running work on the way out.
//
// Held in its own module rather than written where it is used, because
// instrumentation is compiled for both runtimes. The guard at the top of it
// keeps this from running anywhere but Node, and a guard is a runtime decision:
// the bundler still reads the file whole and reports a Node API it finds there,
// whether or not the branch holding it can be reached. Everything else in that
// file is behind a dynamic import for the same reason, so this joins them.
//
// Signal handlers rather than an exit hook. Databricks Apps stops a container
// with SIGTERM, and an exit handler cannot await anything, which is the whole
// point here: the telemetry buffer has to be written before the pool it writes
// through is closed.

// The longest an exit is held for the work, so a stuck write cannot keep a
// container the platform has asked to stop.
const exitCeilingMs = 10 * 1000;

export function onShutdown(work: () => Promise<void>): void {
	let stopping = false;

	const run = () => {
		// Both signals can arrive, and a second one must not start the work
		// again while the first is still finishing it.
		if (stopping) return;
		stopping = true;
		const finished = work().catch((error) => {
			console.warn("Shutdown work failed:", error);
		});

		// Next listens for the same signals, closes its server and then calls
		// process.exit, without waiting for any other listener. On an idle
		// replica the server closes at once, which would end the process part
		// way through the work. An exit asked for while the work runs is held
		// until it finishes or the ceiling passes, then carried out as asked.
		const exit = process.exit.bind(process);
		let held = false;
		process.exit = ((code?: number) => {
			if (held) return;
			held = true;
			const ceiling = setTimeout(() => exit(code), exitCeilingMs);
			void finished.finally(() => {
				clearTimeout(ceiling);
				exit(code);
			});
		}) as typeof process.exit;
	};

	// once rather than on, so nothing accumulates if this is ever called twice,
	// and the process is left to exit on its own: the runtime owns that, and
	// exiting here would cut off whatever else is listening for the same
	// signal.
	process.once("SIGTERM", run);
	process.once("SIGINT", run);
}
