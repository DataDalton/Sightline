// Measures how many people the offline demo serves before it slows down, so a
// change to the app can be judged by how far it moves that point.
//
//   npm run dev2 -- --production          in one terminal, ideally with
//                                         DEMO_WAREHOUSE_DELAY_MS set
//   npm run loadtest                      in another
//   npm run loadtest -- --stages 500,1000 --stage-seconds 90 --think 30-120
//
// A browser is driven once through a few visits (the home page, a report and
// a second page of it, a board, a sheet left open) and every request the
// page made to the app is recorded. Simulated people then replay those
// visits with pauses between them, each signed in as a different made-up
// person in a different mix of the demo's groups. The number of people is
// raised in stages, and each stage reports response times, failures, and the
// processing time and memory of the app and its Postgres.
//
// Results are written to the system's temporary folder and compared with the
// previous run, so the figures that matter are the changes between runs on
// the same machine rather than the figures themselves.
//
// It only runs against the demo. It refuses a server that is not on this
// machine and a database without the demo's membership table, and everything
// it adds is removed when it finishes.

import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { cpus, freemem, tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

// --- Settings ------------------------------------------------------------------

function option(name, fallback) {
	const at = process.argv.indexOf(`--${name}`);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const base = option("url", "http://localhost:3001");
const databaseUrl = option(
	"database",
	"postgres://sightline:sightline@localhost:55432/demo",
);
const stages = option("stages", "250,500,1000,2000,4000,8000")
	.split(",")
	.map(Number)
	.filter((n) => n > 0);
const stageSeconds = Number(option("stage-seconds", "120"));
// The pause between one visit and the next, in seconds, picked at random in
// this range for each pause. Somebody reads a page for a while before opening
// the next, and a pause much shorter than that would make every cache look
// better than it is, since the same person would be back before anything
// changed.
const [thinkLow, thinkHigh] = option("think", "30-120").split("-").map(Number);
// A stage counts as past the breaking point once the slowest twentieth of
// responses take longer than this, or this share of requests fail.
const slowMs = Number(option("slow-ms", "3000"));
const failShare = Number(option("fail-share", "0.02"));
// Stops before the machine runs short of memory, since the app, its database
// and this tool all share it.
const minFreeMb = Number(option("min-free-mb", "1500"));
const requestTimeoutMs = 30_000;
const outDir = join(tmpdir(), "sightline-loadtest");
const loadDomain = "loadtest.invalid";
const emailHeader = "X-Forwarded-Email";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const between = (low, high) => low + Math.random() * (high - low);

// --- Safety --------------------------------------------------------------------

const target = new URL(base);
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
	console.error(
		`Refusing ${base}. The load test only runs against this machine.`,
	);
	process.exit(1);
}
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
const isDemo = await db.query(
	`SELECT 1 FROM information_schema.tables WHERE table_name = 'demo_members'`,
);
if (isDemo.rows.length === 0) {
	console.error(
		"Refusing a database without demo_members. Only the demo is tested.",
	);
	process.exit(1);
}

// --- Recording -----------------------------------------------------------------

function findBrowser() {
	const candidates = [
		process.env.CHROME_PATH,
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
		"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
	].filter(Boolean);
	const found = candidates.find((path) => existsSync(path));
	if (!found) throw new Error("No Chrome or Edge found. Set CHROME_PATH.");
	return found;
}

async function openTarget(debugPort) {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			const response = await fetch(
				`http://127.0.0.1:${debugPort}/json/new?about:blank`,
				{ method: "PUT" },
			);
			const page = await response.json();
			const socket = new WebSocket(page.webSocketDebuggerUrl);
			await new Promise((ready) => (socket.onopen = ready));
			let id = 0;
			const pending = new Map();
			const listeners = [];
			socket.onmessage = (message) => {
				const data = JSON.parse(message.data);
				if (data.id && pending.has(data.id)) {
					pending.get(data.id)(data);
					pending.delete(data.id);
				} else if (data.method) {
					for (const listen of listeners) listen(data);
				}
			};
			const send = (method, params = {}) =>
				new Promise((answer) => {
					const next = ++id;
					pending.set(next, answer);
					socket.send(JSON.stringify({ id: next, method, params }));
				});
			return {
				send,
				on: (listen) => listeners.push(listen),
				close: () => socket.close(),
			};
		} catch {
			await sleep(200);
		}
	}
	throw new Error("The browser did not open its debugging port.");
}

// Requests worth replaying. Built files and images are served from the
// browser's own cache after the first visit, and streams that stay open for
// the whole visit are left out, since a replay would hold them until it
// timed out.
function worthReplaying(url, type, accept) {
	if (!url.startsWith(base)) return false;
	const path = new URL(url).pathname;
	if (path.startsWith("/_next/static") || path.startsWith("/_next/image"))
		return false;
	if (/\.(png|svg|ico|jpg|webp|woff2?|css|js|map|json)$/.test(path))
		return false;
	if ((accept ?? "").includes("text/event-stream")) return false;
	return ["Document", "Fetch", "XHR"].includes(type);
}

async function recordJourneys() {
	const boards = await (await fetch(`${base}/api/boards/`)).json();
	const sheets = await (await fetch(`${base}/api/sheets/`)).json();
	const board = boards.boards?.[0]?.id;
	const sheet = sheets.sheets?.[0]?.id;

	// What each visit does once its page has loaded.
	const visits = [
		{ name: "home", weight: 40, path: "/", wait: 8000 },
		{
			name: "report",
			weight: 35,
			path: "/r/revenue-overview/",
			wait: 7000,
			// Moves to the report's second page, as a reader usually does.
			then: `(() => { const a = [...document.querySelectorAll("a[href^='/r/revenue-overview/']")].find((a) => a.getAttribute("href") !== "/r/revenue-overview/"); a?.click(); return Boolean(a); })()`,
			thenWait: 6000,
		},
		...(board
			? [
					{
						name: "board",
						weight: 15,
						path: `/boards/${board}/`,
						wait: 8000,
					},
				]
			: []),
		...(sheet
			? [
					{
						name: "sheet",
						weight: 10,
						path: `/sheets/${sheet}/`,
						wait: 10000,
					},
				]
			: []),
	];

	const debugPort = 9470;
	const profile = mkdtempSync(join(tmpdir(), "sightline-loadtest-browser-"));
	const browser = spawn(
		findBrowser(),
		[
			"--headless=new",
			`--remote-debugging-port=${debugPort}`,
			`--user-data-dir=${profile}`,
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	const journeys = [];
	try {
		for (const visit of visits) {
			const page = await openTarget(debugPort);
			await page.send("Network.enable");
			await page.send("Page.enable");
			await page.send("Emulation.setDeviceMetricsOverride", {
				width: 1440,
				height: 900,
				deviceScaleFactor: 1,
				mobile: false,
			});
			const seen = [];
			let startedAt = null;
			page.on((event) => {
				if (event.method !== "Network.requestWillBeSent") return;
				const { request, type, timestamp, requestId } = event.params;
				if (!worthReplaying(request.url, type, request.headers?.Accept))
					return;
				startedAt ??= timestamp;
				seen.push({
					requestId,
					at: Math.round((timestamp - startedAt) * 1000),
					method: request.method,
					path: request.url.slice(base.length),
					body: request.postData ?? null,
					hasBody: Boolean(request.hasPostData),
					contentType: request.headers?.["Content-Type"] ?? null,
					accept: request.headers?.Accept ?? null,
					rsc: request.headers?.RSC ?? request.headers?.rsc ?? null,
					routerState:
						request.headers?.["Next-Router-State-Tree"] ?? null,
					nextUrl: request.headers?.["Next-Url"] ?? null,
				});
			});
			await page.send("Page.navigate", { url: base + visit.path });
			await sleep(visit.wait);
			if (visit.then) {
				await page.send("Runtime.evaluate", {
					expression: visit.then,
					returnByValue: true,
				});
				await sleep(visit.thenWait ?? 5000);
			}
			// Bodies the event did not carry are asked for separately.
			for (const request of seen) {
				if (request.body === null && request.hasBody) {
					const answer = await page.send(
						"Network.getRequestPostData",
						{
							requestId: request.requestId,
						},
					);
					request.body = answer.result?.postData ?? null;
				}
			}
			page.close();
			journeys.push({
				name: visit.name,
				weight: visit.weight,
				requests: seen.map(({ requestId, hasBody, ...rest }) => rest),
			});
			console.log(
				`Recorded ${visit.name}: ${seen.length} requests over ${Math.round((seen.at(-1)?.at ?? 0) / 1000)}s`,
			);
		}
	} finally {
		browser.kill();
		await sleep(500);
		rmSync(profile, { recursive: true, force: true });
	}
	return journeys;
}

// --- Simulated people ----------------------------------------------------------

// Each made-up person takes the group mix of one of the demo's people, in
// turn, so the access combinations are spread as the demo spreads them.
async function addPeople(count) {
	const mixes = (
		await db.query(
			`SELECT user_email, array_agg(group_name ORDER BY group_name) AS groups
			 FROM demo_members WHERE user_email NOT LIKE $1
			 GROUP BY user_email ORDER BY user_email`,
			[`%@${loadDomain}`],
		)
	).rows.map((r) => r.groups);
	const people = [];
	const emails = [];
	const groups = [];
	for (let i = 0; i < count; i++) {
		const email = `load-${String(i + 1).padStart(5, "0")}@${loadDomain}`;
		people.push(email);
		for (const group of mixes[i % mixes.length] ?? []) {
			emails.push(email);
			groups.push(group);
		}
	}
	await db.query(
		`INSERT INTO demo_members (user_email, group_name)
		 SELECT * FROM unnest($1::text[], $2::text[])
		 ON CONFLICT DO NOTHING`,
		[emails, groups],
	);
	return people;
}

// Removes every row the made-up people left, in any table with a column
// naming a person.
async function removePeople() {
	const columns = (
		await db.query(
			`SELECT table_schema, table_name, column_name
			 FROM information_schema.columns
			 WHERE column_name IN ('user_email', 'email', 'owner_email',
			                       'author_email', 'created_by', 'modified_by')
			   AND table_schema NOT IN ('pg_catalog', 'information_schema')
			   AND data_type IN ('text', 'character varying')`,
		)
	).rows;
	let removed = 0;
	for (const c of columns) {
		const result = await db
			.query(
				`DELETE FROM "${c.table_schema}"."${c.table_name}"
				 WHERE lower("${c.column_name}") LIKE $1`,
				[`%@${loadDomain}`],
			)
			.catch(() => ({ rowCount: 0 }));
		removed += result.rowCount ?? 0;
	}
	return removed;
}

// --- Measuring the machine -----------------------------------------------------

function serverProcessId() {
	const port = target.port || "80";
	try {
		const listing = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
		const line = listing
			.split(/\r?\n/)
			.find((l) => l.includes(`:${port} `) && l.includes("LISTENING"));
		return line ? Number(line.trim().split(/\s+/).at(-1)) : null;
	} catch {
		return null;
	}
}

// One long running PowerShell reads the app's and Postgres's processing time
// and memory every two seconds, so watching costs one process rather than
// one per reading.
function watchProcesses(serverPid) {
	const readings = [];
	if (process.platform !== "win32" || !serverPid)
		return { readings, stop() {} };
	const script = `
		while ($true) {
			$app = Get-Process -Id ${serverPid} -ErrorAction SilentlyContinue
			$db = Get-Process -Name postgres -ErrorAction SilentlyContinue
			$o = @{
				at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
				appCpu = if ($app) { $app.CPU } else { 0 }
				appMem = if ($app) { $app.WorkingSet64 } else { 0 }
				dbCpu = ($db | Measure-Object -Property CPU -Sum).Sum
				dbMem = ($db | Measure-Object -Property WorkingSet64 -Sum).Sum
			}
			$o | ConvertTo-Json -Compress
			Start-Sleep -Milliseconds 2000
		}`;
	const watcher = spawn("powershell", ["-NoProfile", "-Command", script], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	let buffer = "";
	watcher.stdout.on("data", (chunk) => {
		buffer += chunk;
		let end = buffer.indexOf("\n");
		while (end >= 0) {
			const line = buffer.slice(0, end).trim();
			buffer = buffer.slice(end + 1);
			if (line.startsWith("{")) {
				try {
					readings.push(JSON.parse(line));
				} catch {
					// A partial line is skipped.
				}
			}
			end = buffer.indexOf("\n");
		}
	});
	return { readings, stop: () => watcher.kill() };
}

async function databaseTotals() {
	const row = (
		await db.query(
			`SELECT sum(xact_commit + xact_rollback)::bigint AS transactions,
			        sum(tup_returned + tup_fetched)::bigint AS rows_read
			 FROM pg_stat_database WHERE datname = current_database()`,
		)
	).rows[0];
	const connections = (
		await db.query(
			`SELECT count(*)::int AS n FROM pg_stat_activity
			 WHERE datname = current_database()`,
		)
	).rows[0].n;
	return {
		transactions: Number(row.transactions),
		rowsRead: Number(row.rows_read),
		connections,
	};
}

// --- Replaying -----------------------------------------------------------------

const samples = [];

// Paths with ids in them are grouped, so a report's queries count as one kind
// of request whichever report was open.
function kindOf(method, path) {
	const clean = path
		.split("?")[0]
		.replace(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
			":id",
		)
		.replace(/\/r\/[^/]+\/[^/]+\/?$/, "/r/:report/:page")
		.replace(/\/r\/[^/]+\/?$/, "/r/:report");
	const rsc = path.includes("_rsc=") ? " (navigation)" : "";
	return `${method} ${clean}${rsc}`;
}

async function send(person, request) {
	const headers = { [emailHeader]: person };
	if (request.contentType) headers["Content-Type"] = request.contentType;
	if (request.accept) headers.Accept = request.accept;
	if (request.rsc) headers.RSC = request.rsc;
	if (request.routerState)
		headers["Next-Router-State-Tree"] = request.routerState;
	if (request.nextUrl) headers["Next-Url"] = request.nextUrl;
	if (request.method !== "GET") headers.Origin = base;
	const started = performance.now();
	const kind = kindOf(request.method, request.path);
	try {
		const response = await fetch(base + request.path, {
			method: request.method,
			headers,
			body:
				request.method === "GET"
					? undefined
					: (request.body ?? undefined),
			signal: AbortSignal.timeout(requestTimeoutMs),
		});
		// Read to the end, so a streamed answer is timed to its last line.
		await response.arrayBuffer();
		samples.push({
			at: Date.now(),
			kind,
			ms: performance.now() - started,
			ok: response.status < 500 && response.status !== 429,
			status: String(response.status),
		});
	} catch (error) {
		samples.push({
			at: Date.now(),
			kind,
			ms: performance.now() - started,
			ok: false,
			status: error?.name === "TimeoutError" ? "timed out" : "no answer",
		});
	}
}

// Sends a visit's requests at the moments the browser sent them, so requests
// the page made together go together.
async function replay(person, journey) {
	const started = performance.now();
	await Promise.all(
		journey.requests.map(async (request) => {
			const wait = request.at - (performance.now() - started);
			if (wait > 0) await sleep(wait);
			await send(person, request);
		}),
	);
}

function pickJourney(journeys) {
	const total = journeys.reduce((sum, j) => sum + j.weight, 0);
	let roll = Math.random() * total;
	for (const journey of journeys) {
		roll -= journey.weight;
		if (roll <= 0) return journey;
	}
	return journeys[0];
}

// --- Summaries -----------------------------------------------------------------

function percentile(values, share) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[
		Math.min(sorted.length - 1, Math.floor(share * sorted.length))
	];
}

function summarise(people, from, to, readings, before, after) {
	const window = samples.filter((s) => s.at >= from && s.at < to);
	const times = window.map((s) => s.ms);
	const failed = window.filter((s) => !s.ok).length;
	const seconds = (to - from) / 1000;
	const inside = readings.filter((r) => r.at >= from && r.at < to);
	const cores = cpus().length;
	const cpuShare = (key) => {
		if (inside.length < 2) return null;
		const used = inside.at(-1)[key] - inside[0][key];
		const span = (inside.at(-1).at - inside[0].at) / 1000;
		return span > 0 ? Math.round((used / span / cores) * 1000) / 10 : null;
	};
	const peak = (key) =>
		inside.length
			? Math.round(Math.max(...inside.map((r) => r[key] ?? 0)) / 1048576)
			: null;
	const byKind = new Map();
	for (const s of window) {
		const list = byKind.get(s.kind) ?? [];
		list.push(s.ms);
		byKind.set(s.kind, list);
	}
	const failures = new Map();
	for (const s of window) {
		if (s.ok) continue;
		const key = `${s.status} ${s.kind}`;
		failures.set(key, (failures.get(key) ?? 0) + 1);
	}
	return {
		people,
		requests: window.length,
		perSecond: Math.round((window.length / seconds) * 10) / 10,
		p50: Math.round(percentile(times, 0.5)),
		p95: Math.round(percentile(times, 0.95)),
		p99: Math.round(percentile(times, 0.99)),
		failedShare: window.length ? failed / window.length : 0,
		appCpuPercent: cpuShare("appCpu"),
		appMemoryMb: peak("appMem"),
		dbCpuPercent: cpuShare("dbCpu"),
		dbMemoryMb: peak("dbMem"),
		dbTransactionsPerSecond: Math.round(
			(after.transactions - before.transactions) / seconds,
		),
		dbRowsReadPerSecond: Math.round(
			(after.rowsRead - before.rowsRead) / seconds,
		),
		dbConnections: after.connections,
		slowest: [...byKind.entries()]
			.map(([kind, list]) => ({
				kind,
				count: list.length,
				p95: Math.round(percentile(list, 0.95)),
			}))
			.sort((a, b) => b.p95 - a.p95)
			.slice(0, 6),
		failures: [...failures.entries()]
			.map(([what, count]) => ({ what, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 6),
	};
}

function previousRun() {
	if (!existsSync(outDir)) return null;
	const files = readdirSync(outDir)
		.filter((f) => f.startsWith("run-") && f.endsWith(".json"))
		.sort();
	if (files.length === 0) return null;
	try {
		return JSON.parse(readFileSync(join(outDir, files.at(-1)), "utf8"));
	} catch {
		return null;
	}
}

function change(now, then) {
	if (then === null || then === undefined || then === 0 || now === null)
		return "";
	const percent = Math.round(((now - then) / then) * 100);
	return ` (${percent >= 0 ? "+" : ""}${percent}%)`;
}

// --- Run -----------------------------------------------------------------------

const earlier = previousRun();
console.log("Recording visits in a browser...");
const journeys = await recordJourneys();
const people = await addPeople(Math.max(...stages));
console.log(`Added ${people.length} made-up people in the demo's group mixes.`);

const serverPid = serverProcessId();
const watcher = watchProcesses(serverPid);
const results = [];
let active = 0;
let stopAt = Infinity;
const running = [];

// One simulated person, visiting until told to stop.
async function personLoop(index) {
	const person = people[index];
	// Arrivals are spread over one pause, as people arrive over a morning
	// rather than all at once.
	await sleep(Math.random() * thinkHigh * 1000);
	while (Date.now() < stopAt && index < active) {
		await replay(person, pickJourney(journeys));
		await sleep(between(thinkLow, thinkHigh) * 1000);
	}
}

let reason = "every stage held up";
try {
	for (const count of stages) {
		while (active < count) running.push(personLoop(active++));
		const before = await databaseTotals();
		const from = Date.now();
		console.log(`\nStage of ${count} people for ${stageSeconds}s...`);
		let short = false;
		while (Date.now() - from < stageSeconds * 1000) {
			await sleep(1000);
			if (freemem() / 1048576 < minFreeMb) {
				short = true;
				break;
			}
		}
		const to = Date.now();
		const after = await databaseTotals();
		const summary = summarise(
			count,
			from,
			to,
			watcher.readings,
			before,
			after,
		);
		results.push(summary);
		const was = earlier?.stages?.find((s) => s.people === count);
		console.log(
			`  ${summary.requests} requests, ${summary.perSecond}/s${change(summary.perSecond, was?.perSecond)}` +
				` | typical ${summary.p50}ms${change(summary.p50, was?.p50)}` +
				` | slowest 5% ${summary.p95}ms${change(summary.p95, was?.p95)}` +
				` | failed ${(summary.failedShare * 100).toFixed(1)}%`,
		);
		console.log(
			`  app ${summary.appCpuPercent ?? "?"}% of the machine, ${summary.appMemoryMb ?? "?"}MB` +
				` | database ${summary.dbCpuPercent ?? "?"}%, ${summary.dbMemoryMb ?? "?"}MB,` +
				` ${summary.dbTransactionsPerSecond} transactions/s, ${summary.dbConnections} connections`,
		);
		for (const s of summary.slowest)
			console.log(`    ${s.p95}ms  ${s.kind}  (${s.count})`);
		for (const f of summary.failures)
			console.log(`    failed ${f.count}x  ${f.what}`);
		if (short) {
			reason = `stopped at ${count} people, the machine ran short of memory`;
			break;
		}
		if (summary.p95 > slowMs || summary.failedShare > failShare) {
			reason = `past the breaking point at ${count} people`;
			break;
		}
	}
} finally {
	stopAt = 0;
	active = 0;
	console.log("\nWinding down...");
	await Promise.race([Promise.all(running), sleep(requestTimeoutMs + 5000)]);
	watcher.stop();
	const removed = await removePeople();
	console.log(`Removed ${removed} rows the made-up people left.`);
}

const held = results.filter(
	(r) => r.p95 <= slowMs && r.failedShare <= failShare,
);
const run = {
	finishedOn: new Date().toISOString(),
	settings: { stages, stageSeconds, thinkLow, thinkHigh, slowMs, failShare },
	warehouseDelayMs: Number(process.env.DEMO_WAREHOUSE_DELAY_MS) || null,
	journeys: journeys.map((j) => ({
		name: j.name,
		requests: j.requests.length,
	})),
	reason,
	mostPeopleHeld: held.at(-1)?.people ?? 0,
	stages: results,
};
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `run-${run.finishedOn.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(run, null, 2));

console.log(`\n${reason}.`);
console.log(
	`Most people held: ${run.mostPeopleHeld}` +
		(earlier ? ` (previous run ${earlier.mostPeopleHeld})` : ""),
);
console.log(`Results written to ${file}`);
await db.end();
process.exit(0);
