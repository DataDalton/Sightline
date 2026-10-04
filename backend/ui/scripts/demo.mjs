// Runs Sightline as a self-contained demonstration, with no Databricks
// workspace.
//
//   npm run dev2                 start, keeping whatever the last run left
//   npm run dev2 -- --reset      start again from the sample data alone
//   npm run dev2 -- --production build once and serve the built app, as a
//                                deployment does, for measuring speed
//
// DEMO_WAREHOUSE_DELAY_MS, when set, holds every sample query for that long
// before it runs, so a query the caches do not answer costs about what a
// real warehouse query does. See lib/demo/warehouse.
//
// Starts a Postgres of its own and the development server against it. The
// Postgres holds the platform tables as usual, plus sample tables that stand
// in for the warehouse. See lib/demo for what is seeded and how queries are
// answered.
//
// Postgres comes from the embedded-postgres package, installed on first run
// into .demo/runtime rather than into this project, so the deployed app never
// downloads it. Everything the demonstration writes lives under .demo, which
// git ignores.
//
// Nothing from .env reaches the server. Every key it sets is blanked, so no
// workspace setting can leak into the demonstration.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const postgresPackage = "embedded-postgres@17.10.0-beta.17";
const postgresPort = 55432;
const appPort = 3001;
const database = "demo";
const credentials = { user: "sightline", password: "sightline" };
const signedInAs = "dalton.murray@example.com";
const adminGroup = "Platform Admins";

const root = resolve(".demo");
const runtimeDir = join(root, "runtime");
const dataDir = join(root, "data");

if (process.argv.includes("--reset")) {
	rmSync(dataDir, { recursive: true, force: true });
	console.log("Cleared the demo data. Starting from the sample data.");
}

function installRuntime() {
	if (existsSync(join(runtimeDir, "node_modules", "embedded-postgres"))) {
		return;
	}
	console.log("Installing Postgres for the demo. This happens once.");
	mkdirSync(runtimeDir, { recursive: true });
	if (!existsSync(join(runtimeDir, "package.json"))) {
		spawnSync(
			process.execPath,
			[
				"-e",
				`require("fs").writeFileSync("package.json", '{"name":"sightline-demo-runtime","private":true}')`,
			],
			{ cwd: runtimeDir },
		);
	}
	const result = spawnSync(
		"npm",
		["install", "--no-audit", "--no-fund", postgresPackage],
		{ cwd: runtimeDir, stdio: "inherit", shell: true },
	);
	if (result.status !== 0) {
		console.error("Postgres could not be installed for the demo.");
		process.exit(1);
	}
}

async function startPostgres() {
	const require = createRequire(join(runtimeDir, "package.json"));
	const entry = require.resolve("embedded-postgres");
	const { default: EmbeddedPostgres } = await import(
		pathToFileURL(entry).href
	);

	const postgres = new EmbeddedPostgres({
		databaseDir: dataDir,
		port: postgresPort,
		...credentials,
		persistent: true,
		// This one server stands in for both the platform store and the
		// warehouse, so it takes the connections of both: the platform pool
		// and the warehouse sessions a deployed process may hold, from
		// lib/data/warehouseSessions, with room for the change listener and the
		// load test's own client. Postgres's default allows fewer than the
		// warehouse sessions alone.
		postgresFlags: ["-c", "max_connections=300"],
		onLog: () => {},
		onError: () => {},
	});

	const fresh = !existsSync(join(dataDir, "PG_VERSION"));
	if (fresh) await postgres.initialise();

	// A run that was killed rather than stopped can leave its Postgres running,
	// or only its lock file behind. Either stops this one starting, so the old
	// server is asked to stop and a lock file nobody holds is removed.
	const lockFile = join(dataDir, "postmaster.pid");
	if (existsSync(lockFile)) {
		const platform =
			process.platform === "win32" ? "windows" : process.platform;
		const binaries = join(
			runtimeDir,
			"node_modules",
			"@embedded-postgres",
			`${platform}-${process.arch}`,
			"native",
			"bin",
		);
		spawnSync(
			join(binaries, "pg_ctl"),
			["stop", "-D", dataDir, "-m", "fast"],
			{
				stdio: "ignore",
			},
		);
		rmSync(lockFile, { force: true });
	}

	await postgres.start();
	if (fresh) await postgres.createDatabase(database);
	return postgres;
}

function serverEnv() {
	const env = { ...process.env };
	if (existsSync(".env")) {
		for (const key of Object.keys(parseEnv(readFileSync(".env", "utf8")))) {
			env[key] = "";
		}
	}
	return Object.assign(env, {
		DEMO_MODE: "1",
		NEXT_DIST_DIR: ".next-demo",
		DATABASE_URL: `postgres://${credentials.user}:${credentials.password}@localhost:${postgresPort}/${database}`,
		LOCAL_IDENTITY_EMAIL: signedInAs,
		BOOTSTRAP_ADMIN_GROUPS: adminGroup,
	});
}

installRuntime();
const postgres = await startPostgres();

let stopping = false;
async function stop(code) {
	if (stopping) return;
	stopping = true;
	await postgres.stop().catch(() => {});
	process.exit(code);
}

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");

// A production build is kept apart from the development server's output, and
// under .demo so git ignores it.
const production = process.argv.includes("--production");
const env = production
	? { ...serverEnv(), NEXT_DIST_DIR: ".demo/next-build" }
	: serverEnv();
if (production) {
	const build = spawnSync(process.execPath, [nextBin, "build"], {
		env,
		stdio: "inherit",
	});
	if (build.status !== 0) await stop(build.status ?? 1);
}

console.log(`Sightline demo at http://localhost:${appPort}`);
const server = spawn(
	process.execPath,
	[nextBin, production ? "start" : "dev", "-p", String(appPort)],
	{
		env,
		stdio: "inherit",
	},
);

// Postgres stops once Next has exited, so Next finishes writing its cache
// rather than being cut off halfway, which left it unreadable on the next run.
server.on("exit", (code) => void stop(code ?? 0));
process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGTERM"));
