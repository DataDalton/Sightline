// Takes the pictures in the documentation from the running offline demo.
//
//   npm run dev2                  in one terminal
//   npm run screenshots           in another
//
// Drives an installed Chrome or Edge through its debugging protocol, so no
// browser package is added to the project. Set CHROME_PATH when neither is
// found where they usually install. Pictures are written to docs/images at
// twice the pixel density, so they stay sharp on a high density screen.

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const base = process.env.DEMO_URL ?? "http://localhost:3001";
const outDir = resolve("../../docs/images");
const debugPort = 9444;
const scale = 2;

// An exploration, written into the address the way the Explore page writes it.
const exploration = Buffer.from(
	JSON.stringify({
		sourceKey: "sales_orders",
		columns: ["Region", "Channel", "Revenue", "Gross Margin", "Orders"],
		conditions: [
			{
				field: "Product Category",
				op: "eq",
				values: ["Tents", "Backpacks"],
				negate: false,
				join: "and",
			},
		],
	}),
).toString("base64url");

// What is photographed. Wait covers the page's own queries and chart
// animations, which have no single event to wait on. Click names an element
// pressed once the page has loaded, such as the first conversation, and
// clickText presses the first button, link or table row showing that text.
const shots = [
	{ name: "home", path: "/", width: 1440, height: 900 },
	{ name: "report", path: "/r/revenue-overview/", width: 1440, height: 900 },
	{ name: "flow", path: "/r/warehouse-flow/", width: 1440, height: 900 },
	{ name: "category", path: "/c/sales/", width: 1440, height: 900 },
	{
		name: "conversations",
		path: "/inbox/?view=conversations",
		width: 1440,
		height: 900,
		click: "[aria-label='Conversations'] button",
	},
	{
		name: "editor",
		path: "/r/revenue-overview/?edit=1",
		width: 1440,
		height: 900,
	},
	{
		name: "dictionary",
		path: "/dictionary/",
		width: 1440,
		height: 900,
		clickText: "Average Headcount",
	},
	{
		name: "explore",
		path: `/explore/?q=${exploration}`,
		width: 1440,
		height: 900,
	},
	{
		name: "sheet",
		path: "/sheets/",
		width: 1440,
		height: 900,
		clickText: "Regional margin",
	},
	{
		name: "phone",
		path: "/r/support-overview/",
		width: 390,
		height: 844,
		mobile: true,
	},
];

// The development server's own badge, and the scrollbar a headless window
// draws, are not part of the product.
const hideChrome = `
	nextjs-portal { display: none !important; }
	::-webkit-scrollbar { display: none; }
`;

function findBrowser() {
	const candidates = [
		process.env.CHROME_PATH,
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	].filter(Boolean);
	const found = candidates.find((path) => existsSync(path));
	if (!found) {
		console.error("No Chrome or Edge found. Set CHROME_PATH to one.");
		process.exit(1);
	}
	return found;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function reachable() {
	try {
		const response = await fetch(base, { redirect: "manual" });
		return response.status < 500;
	} catch {
		return false;
	}
}

// One debugging session with one page, spoken to over a websocket.
async function openPage() {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			const response = await fetch(
				`http://127.0.0.1:${debugPort}/json/new?about:blank`,
				{ method: "PUT" },
			);
			const target = await response.json();
			const socket = new WebSocket(target.webSocketDebuggerUrl);
			await new Promise((ready) => (socket.onopen = ready));
			let id = 0;
			const pending = new Map();
			socket.onmessage = (message) => {
				const data = JSON.parse(message.data);
				if (data.id && pending.has(data.id)) {
					pending.get(data.id)(data);
					pending.delete(data.id);
				}
			};
			const send = (method, params = {}) =>
				new Promise((answer) => {
					const next = ++id;
					pending.set(next, answer);
					socket.send(JSON.stringify({ id: next, method, params }));
				});
			return { send, close: () => socket.close() };
		} catch {
			await sleep(200);
		}
	}
	throw new Error("Chrome did not open its debugging port.");
}

if (!(await reachable())) {
	console.error(
		`Nothing answers at ${base}. Start the demo with npm run dev2.`,
	);
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "sightline-shots-"));
const browser = spawn(
	findBrowser(),
	[
		"--headless=new",
		`--remote-debugging-port=${debugPort}`,
		`--user-data-dir=${profile}`,
		"--hide-scrollbars",
		"--force-color-profile=srgb",
		"about:blank",
	],
	{ stdio: "ignore" },
);

try {
	const page = await openPage();
	await page.send("Page.enable");
	await page.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value: "dark" }],
	});

	for (const shot of shots) {
		await page.send("Emulation.setDeviceMetricsOverride", {
			width: shot.width,
			height: shot.height,
			deviceScaleFactor: scale,
			mobile: Boolean(shot.mobile),
		});
		await page.send("Page.navigate", { url: `${base}${shot.path}` });
		await sleep(shot.wait ?? 9000);
		if (shot.click) {
			await page.send("Runtime.evaluate", {
				expression: `document.querySelector(${JSON.stringify(shot.click)})?.click()`,
			});
			await sleep(3000);
		}
		if (shot.clickText) {
			await page.send("Runtime.evaluate", {
				expression: `[...document.querySelectorAll("button, a, tr")]
					.find((el) => el.textContent.trim().startsWith(${JSON.stringify(shot.clickText)}))
					?.click()`,
			});
			await sleep(shot.after ?? 6000);
		}
		await page.send("Runtime.evaluate", {
			expression: `(() => {
				const style = document.createElement("style");
				style.textContent = ${JSON.stringify(hideChrome)};
				document.head.appendChild(style);
			})()`,
		});
		await sleep(300);
		const picture = await page.send("Page.captureScreenshot", {
			format: "png",
		});
		const file = join(outDir, `${shot.name}.png`);
		writeFileSync(file, Buffer.from(picture.result.data, "base64"));
		console.log(`Saved ${file}`);
	}
	page.close();
} finally {
	browser.kill();
	await sleep(500);
	rmSync(profile, { recursive: true, force: true });
}
