// Operational configuration, stored in a platform table rather than in the
// environment. Admins change cache budgets, refresh intervals, telemetry
// sampling and branding from inside the app, and the change takes effect
// across every replica within one refresh interval. No redeploy, no .env.
//
// Defaults below are what a fresh install runs on, so the platform starts
// correctly against an empty settings table.

export interface PlatformSettings {
	// Branding
	appName: string;
	appDescription: string;
	// The mark beside the name, as sanitised SVG markup.
	//
	// Held here rather than as a file because a Databricks App has no
	// persistent disk: anything written to the container is gone at the next
	// restart. Markup rather than a data URI because it is put into the
	// document, which is what lets it take its colour from the page.
	appLogo: string;
	// Whether the mark follows the theme.
	//
	// On, its colours are replaced with the colour of the text beside it, so
	// one file works in light and dark. Off, it keeps the colours it was drawn
	// in, which is what a mark with fixed brand colours needs.
	appLogoAdaptive: boolean;

	// Which warehouse runs the queries. Resolved per connection, so changing
	// it moves every reader to a different warehouse without a redeploy.
	//
	// The catalogue is deliberately not here. It belongs to each source rather
	// than to the platform: data_sources carries a catalog_name per row, and a
	// single global value would silently disagree with them.
	warehouseId: string;

	// Analytics cache. Budgets are deliberately conservative: the container
	// shares this memory with SSR and the Node heap.
	cacheMemoryLimitMb: number;
	cacheMaxDatasetMb: number;
	cacheThreads: number;

	// Query result cache
	resultTtlSeconds: number;
	resultMaxEntries: number;
	// Serve an expired entry immediately and refresh behind the request, so a
	// cold policy class costs one slow request rather than many.
	staleWhileRevalidate: boolean;

	// Dataset refresh
	refreshIntervalSeconds: number;
	refreshConcurrency: number;

	// Identity
	groupCacheTtlSeconds: number;
	// How long a cached policy class is still served while the membership
	// lookup itself is failing. Bounds how long a revoked grant keeps working.
	policyGraceSeconds: number;

	// Telemetry
	telemetryEnabled: boolean;
	telemetryFlushIntervalMs: number;
	telemetryMaxBatch: number;
	telemetryMaxBuffer: number;

	// Extra groups to evaluate when resolving a policy class.
	//
	// Most are found automatically: the platform reads the row filters on each
	// source and probes whatever groups they branch on, so the cache only ever
	// shares an answer between people who provably see the same rows. This is
	// for a group that discovery cannot see, such as a filter on a table the
	// app's identity may not read.
	//
	// Added to the discovered list, never substituted for it. Replacing would
	// make this a way to switch the safety off by accident.
	trackedGroups: string[];

	// Groups whose members may edit any report. A central editorial team keeps
	// one shared definition of every report, so their changes are published to
	// everyone rather than forked per person.
	editorGroups: string[];
	// Groups whose members administer the platform: access policy, settings,
	// and the semantic layer.
	adminGroups: string[];

	// Where reachability comes from.
	//
	// "catalog": a reader reaches a report when Unity Catalog lets them read
	// the source it is built on. A SELECT grant on the data is already the
	// statement that somebody should see what is built from it, so the platform
	// reads that statement rather than keeping a second copy of it. Explicit
	// grants still apply and can raise a permission above view.
	//
	// "grants": only what the access grants name is reachable. For a deployment
	// where reaching a report is a narrower decision than reading its data.
	accessModel: "catalog" | "grants";
}

export const defaultSettings: PlatformSettings = {
	appName: "Sightline",
	appDescription: "Analytics and reporting platform",
	appLogo: "",
	appLogoAdaptive: true,

	warehouseId: "",

	cacheMemoryLimitMb: 4096,
	cacheMaxDatasetMb: 3072,
	cacheThreads: 2,

	resultTtlSeconds: 300,
	resultMaxEntries: 2000,
	staleWhileRevalidate: true,

	refreshIntervalSeconds: 3600,
	refreshConcurrency: 2,

	groupCacheTtlSeconds: 300,
	policyGraceSeconds: 3600,

	telemetryEnabled: true,
	telemetryFlushIntervalMs: 15000,
	telemetryMaxBatch: 500,
	telemetryMaxBuffer: 10000,

	accessModel: "catalog",

	trackedGroups: [],
	// Databricks account group names. is_account_group_member is
	// case-sensitive, so these must match the account group exactly.
	//
	// Defaults for a fresh install: change them in the platform_settings table
	// and every replica picks the change up within a minute, no redeploy.
	// Empty until a deployment says otherwise. A group named in source would
	// be one installation's directory shipped to every other, and a wrong
	// name here fails silently: membership simply never matches and nobody can
	// edit or administer anything.
	//
	// A fresh install bootstraps from BOOTSTRAP_ADMIN_GROUPS, which is how the
	// first administrator gets in to set the real ones. After that the table
	// is the source of truth and the variable can go.
	editorGroups: [],
	adminGroups: [],
};

// Current values. Reads are synchronous because they sit on the request path;
// the table is polled in the background rather than queried per request.
let current: PlatformSettings = { ...defaultSettings };
let loadedAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// How often the settings table is re-read. A change propagates to every
// replica within this window.
const pollIntervalMs = 60000;

export function settings(): PlatformSettings {
	return current;
}

// Groups that administer a fresh install.
//
// Without this an empty settings table means nobody is an administrator, and
// the page that sets the administrators is itself administrator-only, so the
// first install could never be configured. Named separately from the stored
// setting so it is obvious it is a bootstrap rather than a second place
// permissions live: once the table names a group, this is ignored.
function bootstrapAdminGroups(): string[] {
	const raw = process.env.BOOTSTRAP_ADMIN_GROUPS ?? "";
	return raw
		.split(",")
		.map((g) => g.trim())
		.filter((g) => g.length > 0);
}

// The groups that actually hold administration, stored or bootstrapped.
export function effectiveAdminGroups(): string[] {
	const stored = current.adminGroups;
	return stored.length > 0 ? stored : bootstrapAdminGroups();
}

export function settingsLoadedAt(): number {
	return loadedAt;
}

// Coerces a stored string into the type the default declares, so the table can
// hold everything as text without the caller doing conversions.
function coerce(key: keyof PlatformSettings, raw: string): unknown {
	const fallback = defaultSettings[key];

	if (typeof fallback === "number") {
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? parsed : fallback;
	}
	if (typeof fallback === "boolean") {
		const normalized = raw.trim().toLowerCase();
		return (
			normalized === "1" || normalized === "true" || normalized === "yes"
		);
	}
	if (Array.isArray(fallback)) {
		return raw
			.split(",")
			.map((v) => v.trim())
			.filter((v) => v.length > 0);
	}
	// A value outside the set would leave reachability in a third state that
	// nothing implements, and the visible result would be an empty home page
	// for everyone.
	if (key === "accessModel") {
		return raw === "catalog" || raw === "grants" ? raw : fallback;
	}
	return raw;
}

export async function loadSettings(): Promise<PlatformSettings> {
	// Imported lazily so the settings module can be read by code paths that
	// never open a database connection.
	const { sql } = await import("./data/lakebase");

	try {
		const rows = await sql<{
			setting_key: string;
			setting_value: string | null;
		}>(`SELECT setting_key, setting_value FROM platform_settings`);

		const next: PlatformSettings = { ...defaultSettings };
		for (const row of rows) {
			const key = String(row.setting_key ?? "") as keyof PlatformSettings;
			if (!(key in defaultSettings)) continue;
			const raw = row.setting_value;
			if (raw === null || raw === undefined) continue;
			// Index assignment through a widened type: each value is coerced
			// to match the shape the default declares.
			(next as unknown as Record<string, unknown>)[key] = coerce(
				key,
				String(raw),
			);
		}

		current = next;
		loadedAt = Date.now();
	} catch (error) {
		// A settings table that cannot be read must not stop the app. Running
		// on defaults is a degraded but safe state, and the poll retries.
		console.warn(
			"Settings load failed, continuing on current values:",
			error,
		);
	}

	return current;
}

// The most a logo may weigh.
//
// A settings row is read by every replica on a timer and sent to every page,
// so weight here is paid for continuously rather than once. An SVG mark is
// normally a few kilobytes; anything approaching this is a traced photograph
// rather than a logo.
export const maxLogoBytes = 64 * 1024;

// Settings an admin may change from inside the app.
//
// Everything else in the table is either derived or belongs to the deployment.
// Listing the writable keys explicitly means a new setting is not accidentally
// exposed to the admin form by being added to the interface.
export const writableSettings = [
	"appName",
	"appDescription",
	"appLogo",
	"appLogoAdaptive",
	"warehouseId",
	"resultTtlSeconds",
	"resultMaxEntries",
	"staleWhileRevalidate",
	"refreshIntervalSeconds",
	"groupCacheTtlSeconds",
	"policyGraceSeconds",
	"telemetryEnabled",
	"editorGroups",
	"adminGroups",
	"accessModel",
] as const satisfies readonly (keyof PlatformSettings)[];

export type WritableSetting = (typeof writableSettings)[number];

// Writes a change and makes it live immediately for this replica. Other
// replicas pick it up on their next poll.
export async function saveSettings(
	changes: Partial<Record<WritableSetting, unknown>>,
	changedBy: string,
): Promise<PlatformSettings> {
	const { sql } = await import("./data/lakebase");

	for (const [key, value] of Object.entries(changes)) {
		if (!writableSettings.includes(key as WritableSetting)) continue;

		// Stored as text, coerced back on read, so the table stays one shape
		// whatever a setting happens to be.
		const stored = Array.isArray(value)
			? value.join(",")
			: value === null || value === undefined
				? ""
				: String(value);

		await sql(
			`INSERT INTO platform_settings (setting_key, setting_value, modified_by, modified_on)
			 VALUES ($1, $2, $3, now())
			 ON CONFLICT (setting_key) DO UPDATE SET
			   setting_value = EXCLUDED.setting_value,
			   modified_by = EXCLUDED.modified_by,
			   modified_on = now()`,
			[key, stored, changedBy],
		);
	}

	return loadSettings();
}

// Starts background polling. Called once from instrumentation at startup.
export function startSettingsPolling(): void {
	if (refreshTimer) return;
	refreshTimer = setInterval(() => {
		void loadSettings();
	}, pollIntervalMs);
	// Do not hold the process open for this timer.
	refreshTimer.unref?.();
}

export function stopSettingsPolling(): void {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
	}
}
