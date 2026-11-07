// An installed Chrome or Edge, driven through its debugging protocol, so no
// browser package is added to the project. Set CHROME_PATH when neither is found
// where they usually install. Shared by the scripts that look at the running
// offline demo.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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

export async function reachable(base) {
	try {
		const response = await fetch(base, { redirect: "manual" });
		return response.status < 500;
	} catch {
		return false;
	}
}

export async function openBrowser(debugPort) {
	const profile = mkdtempSync(join(tmpdir(), "sightline-browser-"));
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

	return {
		// One debugging session with one page, spoken to over a websocket.
		// Events the page raises go to onEvent, by method name.
		async openPage(onEvent) {
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
						} else if (data.method) {
							onEvent?.(data.method, data.params);
						}
					};
					const send = (method, params = {}) =>
						new Promise((answer) => {
							const next = ++id;
							pending.set(next, answer);
							socket.send(
								JSON.stringify({ id: next, method, params }),
							);
						});
					return { send, close: () => socket.close() };
				} catch {
					await sleep(200);
				}
			}
			throw new Error("Chrome did not open its debugging port.");
		},
		async close() {
			browser.kill();
			await sleep(500);
			try {
				rmSync(profile, { recursive: true, force: true });
			} catch {
				// A browser still letting go of its profile leaves a temporary
				// folder behind, which is not worth failing a run over.
			}
		},
	};
}
