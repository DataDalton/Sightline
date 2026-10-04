// Starts the built app with one server process for each core it may use.
//
// One Node process runs the app's code on a single thread, so one `next start`
// uses about one core however many the instance has. This process only starts
// the servers and starts again any that stop. Each server is an ordinary
// `next start`, given the arguments this script was given, and they share the
// listening port through node:cluster. Each holds its own caches and its own
// connection pool, as a replica does, and the change notices that keep
// replicas' caches current keep these current in the same way.
//
//   npm run start                  every core the instance may use
//
// The demo and the load test start one `next start` directly rather than
// through this, so measurements stay on one process.

import cluster from "node:cluster";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";

// Cores this process may use. A container can see every core of the machine
// while its processor quota allows fewer, and a server for each core it can
// see would leave them all competing for that quota. The quota is read from
// cgroup v2 where there is one.
function usableCores() {
	let cores = availableParallelism();
	try {
		const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8")
			.trim()
			.split(/\s+/);
		if (quota !== "max" && Number(period) > 0) {
			cores = Math.min(cores, Math.floor(Number(quota) / Number(period)));
		}
	} catch {
		// No cgroup v2 quota, as outside a container.
	}
	return Math.max(1, cores);
}

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const servers = usableCores();

cluster.setupPrimary({
	exec: nextBin,
	args: ["start", ...process.argv.slice(2)],
});

// A server that stops is started again, waiting longer each time one stops
// soon after starting, so a server that cannot start does not spin.
const quickExitMs = 10_000;
const maxWaitMs = 30_000;
let waitMs = 1000;
let stopping = false;
const startedAt = new Map();

function startServer() {
	const worker = cluster.fork();
	startedAt.set(worker.id, Date.now());
}

cluster.on("exit", (worker, code, signal) => {
	const ranMs = Date.now() - (startedAt.get(worker.id) ?? 0);
	startedAt.delete(worker.id);
	if (stopping) {
		if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
		return;
	}
	console.error(
		`Server process ${worker.process.pid} stopped (${signal ?? `code ${code}`}). Starting another.`,
	);
	waitMs = ranMs < quickExitMs ? Math.min(waitMs * 2, maxWaitMs) : 1000;
	setTimeout(startServer, waitMs);
});

function stopAll(signal) {
	if (stopping) return;
	stopping = true;
	const running = Object.values(cluster.workers ?? {});
	if (running.length === 0) process.exit(0);
	for (const worker of running) worker?.process.kill(signal);
}

process.on("SIGTERM", () => stopAll("SIGTERM"));
process.on("SIGINT", () => stopAll("SIGINT"));

console.log(`Starting ${servers} server process${servers === 1 ? "" : "es"}.`);
for (let i = 0; i < servers; i++) startServer();
