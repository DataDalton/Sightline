"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.register = register;
// Runs once per server process on startup.
async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs")
        return;
    const { appIdentity, isDatabricksApp } = await import("@/lib/runtime");
    const { initPlatformSchema, sweepExpired } = await import("@/lib/platform/schema");
    const { loadSettings, startSettingsPolling } = await import("@/lib/settings");
    const { loadRegistry, startRegistryPolling } = await import("@/lib/semantic/registry");
    const { startTelemetryFlushing } = await import("@/lib/telemetry/usage");
    try {
        await initPlatformSchema();
        await loadSettings();
        await loadRegistry();
    }
    catch (error) {
        // Without the transactional store there is nowhere for state to live, so
        // a deployed app fails loudly. Locally it just means no Lakebase.
        if (isDatabricksApp)
            throw error;
        console.warn("Platform store unavailable, continuing locally:", error);
    }
    startSettingsPolling();
    startRegistryPolling();
    startTelemetryFlushing();
    // Expired presence and cache rows accumulate otherwise. Every replica runs
    // this; the deletes are idempotent so overlap is harmless.
    const sweepTimer = setInterval(() => {
        void sweepExpired().catch(() => { });
    }, 5 * 60 * 1000);
    sweepTimer.unref?.();
    console.log(`${appIdentity.name} started`);
}
