import { assertDeploymentConfigured } from "../runtime";
import { loadSettings, startSettingsPolling } from "../settings";
import { loadRegistry, startRegistryPolling } from "../semantic/registry";
import { startTelemetryFlushing } from "../telemetry/usage";

// One-time initialization, run from the request path rather than only from
// instrumentation.
//
// Next bundles instrumentation separately from route handlers, so module-level
// state written during startup is not visible to a request. Relying on
// instrumentation alone left the semantic registry empty and, worse, left the
// tracked group list empty in the module instance that actually serves
// requests, which silently resolved every caller to a policy class with no
// grants. Initializing lazily makes the first request in each module instance
// pay for its own setup, which is correct no matter how the bundler splits
// things.

let readyPromise: Promise<void> | null = null;
let readyAt = 0;

async function initialize(): Promise<void> {
	// A deployment missing its connection targets fails here, naming them,
	// rather than further in with something that reads as a network fault.
	// Here rather than at module scope, so a build that imports every route
	// does not trip a check about resources it never uses.
	assertDeploymentConfigured();

	// Settings first: the registry and the pollers read their intervals from
	// it, so loading in the other order would use defaults for one cycle.
	await loadSettings();
	await loadRegistry();

	startSettingsPolling();
	startRegistryPolling();
	startTelemetryFlushing();

	readyAt = Date.now();
}

// Resolves once the module instance is initialized. Concurrent callers share
// one initialization; a failure clears the memo so the next request retries
// rather than pinning the process to a broken state.
export function ensureReady(): Promise<void> {
	if (!readyPromise) {
		readyPromise = initialize().catch((error) => {
			readyPromise = null;
			throw error;
		});
	}
	return readyPromise;
}

// Initialization failures must not take the whole request down: the app shell
// and diagnostics stay useful even when the platform store is unreachable.
export async function ensureReadyOrDegrade(): Promise<boolean> {
	try {
		await ensureReady();
		return true;
	} catch (error) {
		console.error("Platform initialization failed:", error);
		return false;
	}
}

export function bootstrapReadyAt(): number {
	return readyAt;
}
