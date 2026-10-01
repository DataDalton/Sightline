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
	const { bootstrapRoleAssignments, syncBuiltinRoles, syncCategoryRoles } =
		await import("@/lib/platform/roles");
	const { migrateExplorations } = await import("@/lib/platform/personal");
	const { loadSettings, startSettingsPolling, stopSettingsPolling } =
		await import("@/lib/settings");
	const { loadRegistry, startRegistryPolling, stopRegistryPolling } =
		await import("@/lib/semantic/registry");
	const { startTelemetryFlushing, stopTelemetryFlushing } =
		await import("@/lib/telemetry/usage");
	const { pruneOps } = await import("@/lib/platform/editing");
	const { rollupUsage } = await import("@/lib/telemetry/rollup");
	const { runDailyFieldSync } = await import("@/lib/semantic/fieldWatch");
	const { runRetention } = await import("@/lib/retention/pass");
	const { closePool, tryAdvisoryLock } = await import("@/lib/data/lakebase");
	// Identifies the sweep lock, so one replica sweeps at a time.
	const sweepLockKey = 8577411;
	const { closeAllUserSessions } = await import("@/lib/data/userSession");
	const { onShutdown } = await import("@/lib/platform/shutdown");
	const { runScheduledAlerts } = await import("@/lib/alerts/runner");
	const { runScheduledDeliveries } = await import("@/lib/deliveries/runner");
	const { runChecks } = await import("@/lib/freshness/checker");
	const { evaluateLateness } = await import("@/lib/freshness/lateness");
	const { startMarksPolling, stopMarksPolling } =
		await import("@/lib/freshness/marks");

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
		// And one editor role per category, named after it.
		await syncCategoryRoles();

		await loadSettings();

		// After the settings, because a first install converts the configured
		// admin and editor groups into global assignments and needs to have
		// read them. Only when no assignment exists at all, so an administrator
		// who removes one does not find it back after a restart.
		await bootstrapRoleAssignments();

		// The self-contained demonstration writes its sample data, sources
		// and reports, once the tables they go into exist. See lib/demo/seed.
		const { demoMode } = await import("@/lib/runtime");
		if (demoMode) {
			const { seedDemo } = await import("@/lib/demo/seed");
			await seedDemo();
			const { startDemoFeed } = await import("@/lib/demo/feed");
			startDemoFeed();
		}

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

	// Expired presence and cache rows accumulate otherwise. One replica at a
	// time runs it, and the rest skip that round.
	//
	// The op log goes with them. It is the live sync buffer rather than a
	// record: a version snapshot holds the history, so ops only have to cover
	// the window a disconnected session might have missed. It had no caller at
	// all, so a table that needs two days of rows was keeping every edit ever
	// made. Nothing else in here is pruned on purpose, because usage, activity
	// and versions are records and a deleted record cannot be reconstructed.
	const sweepTimer = setInterval(
		() => {
			void tryAdvisoryLock(sweepLockKey, async () => {
				await sweepExpired().catch(() => {});
				await pruneOps().catch(() => {});
			}).catch(() => {});
		},
		5 * 60 * 1000,
	);
	sweepTimer.unref?.();

	// Usage rolled into its daily shape.
	//
	// On its own schedule rather than the sweep's, because it is the one piece
	// of periodic work that costs real time as the events accumulate, and it is
	// not urgent: the administration screens read whole days, so nothing they
	// show changes between one run and the next.
	//
	// Every replica runs it and an advisory lock decides which one actually
	// does the work.
	const rollupTimer = setInterval(
		() => {
			void rollupUsage().catch((error) => {
				console.warn("Usage rollup failed:", error);
			});
		},
		10 * 60 * 1000,
	);
	rollupTimer.unref?.();

	// Once shortly after start, so a fresh deployment does not show empty
	// administration screens until the first interval comes round.
	const firstRollup = setTimeout(() => {
		void rollupUsage().catch(() => {});
	}, 30 * 1000);
	firstRollup.unref?.();

	// Each source's fields compared with the catalogue once a day, so a field
	// dropped or renamed upstream is noticed and its dependents told without
	// anybody running a sync. Each source is skipped until a day has passed,
	// so an hourly tick only does the work that is due. A due source waits for
	// the warehouse to be up on a reader's account, unless it is well past
	// due. See lib/semantic/fieldWatch.
	const fieldSyncTimer = setInterval(
		() => void runDailyFieldSync(),
		60 * 60 * 1000,
	);
	fieldSyncTimer.unref?.();

	// Personal items unused for the period set under Retention are warned
	// about, moved to their owner's bin, and deleted once the bin period is
	// over. Every replica asks on the hour and the claim in the pass lets one
	// of them run it once a day. Postgres only, so it never starts a stopped
	// warehouse. See lib/retention.
	const retentionTick = () =>
		void runRetention().catch((error) => {
			console.warn("Retention pass failed:", error);
		});
	const retentionTimer = setInterval(retentionTick, 60 * 60 * 1000);
	retentionTimer.unref?.();
	// Once shortly after start, so a deployment that restarts often still
	// gets its daily pass.
	const firstRetention = setTimeout(retentionTick, 5 * 60 * 1000);
	firstRetention.unref?.();

	// Alerts that can run while their owners are away.
	//
	// Every minute, though an alert is only ever due on the hour: an alert
	// that fell due while every replica was restarting is caught on the next
	// tick, and a batch too large for one tick finishes on the one after.
	// Every replica ticks, and the claim in the runner hands each alert to
	// exactly one of them.
	const alertTimer = setInterval(() => {
		void runScheduledAlerts().catch((error) => {
			console.warn("Scheduled alerts failed:", error);
		});
		// Scheduled pages share the tick and the rules alerts run under.
		void runScheduledDeliveries().catch((error) => {
			console.warn("Scheduled pages failed:", error);
		});
	}, 60 * 1000);
	alertTimer.unref?.();

	// Looks at the tables behind each source for new data. Every few seconds,
	// though each table is only looked at on its own interval, so live
	// sources can be followed closely. The claim in the checker hands each
	// table to one replica. See lib/freshness/checker.
	startMarksPolling();
	//
	// Whether a source is late moves with the clock as well as with each look,
	// so it is judged on the same tick, at most once a minute. See
	// lib/freshness/lateness.
	const checkTimer = setInterval(() => {
		void runChecks().catch((error) => {
			console.warn("Checking sources for new data failed:", error);
		});
		void evaluateLateness().catch((error) => {
			console.warn("Judging late data failed:", error);
		});
	}, 5_000);
	checkTimer.unref?.();

	// Shutting down.
	//
	// The teardown functions were all written and none was called, because
	// nothing listened for the signal. The telemetry flush is the one that
	// costs something: events buffer for fifteen seconds, so without a final
	// flush every replica drops up to that much usage on every deploy.
	onShutdown(async () => {
		clearInterval(checkTimer);
		stopMarksPolling();
		clearInterval(sweepTimer);
		clearInterval(rollupTimer);
		clearInterval(fieldSyncTimer);
		clearInterval(retentionTimer);
		clearTimeout(firstRetention);
		clearInterval(alertTimer);
		clearTimeout(firstRollup);
		stopSettingsPolling();
		stopRegistryPolling();
		// Awaited, and first among the closers, because it writes through the
		// pool the next line shuts.
		await stopTelemetryFlushing().catch(() => {});
		await closeAllUserSessions().catch(() => {});
		await closePool().catch(() => {});
	});

	console.log(`${appIdentity.name} started`);
}
