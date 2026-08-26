// Runs once per server process on startup.
//
// Nothing here throws. Next treats a throwing instrumentation hook as a server
// that failed to prepare, which answers every request with an Internal Server
// Error and leaves the reason in a log only an operator with console access can
// read, including the page that would explain it.
//
// Failing loudly is right; the place to fail is a request, where somebody can
// see it. Every route calls ensureReady, which retries this work and reports
// what is wrong, so the shell and the diagnostics endpoint stay reachable.
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;

	const { appIdentity, missingDeploymentConfig } =
		await import("@/lib/runtime");
	const { initPlatformSchema, sweepExpired } =
		await import("@/lib/platform/schema");
	const { bootstrapRoleAssignments, syncBuiltinRoles } =
		await import("@/lib/platform/roles");
	const { migrateExplorations } = await import("@/lib/platform/personal");
	const { loadSettings, startSettingsPolling } =
		await import("@/lib/settings");
	const { loadRegistry, startRegistryPolling } =
		await import("@/lib/semantic/registry");
	const { startTelemetryFlushing } = await import("@/lib/telemetry/usage");

	// Named before anything is attempted, because "LAKEBASE_INSTANCE is not
	// set" is a fixable sentence and a connection timeout is not.
	const missing = missingDeploymentConfig();
	if (missing.length > 0) {
		console.error(
			`${appIdentity.name} cannot reach its platform store. ` +
				`Missing: ${missing.join(", ")}. ` +
				"Declare these in app.yaml and bind a database resource. " +
				"Binding the resource supplies PGHOST; the database name, the " +
				"instance name and the schema are set explicitly, because the " +
				"instance name is what credentials are minted against and cannot " +
				"be derived from the host.",
		);
	}

	try {
		await initPlatformSchema();

		// The built-in roles are defined in code and re-asserted here, so the
		// capability set of a role everyone recognises by name cannot drift by
		// hand.
		await syncBuiltinRoles();

		await loadSettings();

		// After the settings, because a first install converts the configured
		// admin and editor groups into global assignments and needs to have
		// read them. Only when no assignment exists at all, so an administrator
		// who removes one does not find it back after a restart.
		await bootstrapRoleAssignments();

		await loadRegistry();

		// Saved questions predate personal pages and lived in a table only the
		// explore screen could read. Converted here, after the registry, because
		// a conversion checks the visual against the source it names. Finds
		// nothing on almost every start.
		await migrateExplorations();
	} catch (error) {
		// Reported, not rethrown. See the note at the top.
		console.error(
			"Platform store unavailable at startup. The app will keep trying on " +
				"each request and report the reason there:",
			error,
		);
	}

	startSettingsPolling();
	startRegistryPolling();
	startTelemetryFlushing();

	// Expired presence and cache rows accumulate otherwise. Every replica runs
	// this; the deletes are idempotent so overlap is harmless.
	const sweepTimer = setInterval(
		() => {
			void sweepExpired().catch(() => {});
		},
		5 * 60 * 1000,
	);
	sweepTimer.unref?.();

	console.log(`${appIdentity.name} started`);
}
