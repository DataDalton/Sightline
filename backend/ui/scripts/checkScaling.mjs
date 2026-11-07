// Looks at the running offline demo at several window sizes and says where the
// layout does not hold.
//
//   npm run dev2                  in one terminal
//   npm run check:scaling         in another
//
// Each page is opened at each size, then the window is resized without a reload,
// because a chart that draws correctly on arrival can still keep its old size
// when the window changes. A run fails when a page scrolls sideways, when
// something is cut off at the edge of the window, when a wide page leaves room
// unused at its side, when a chart is not the size of its box, or when the page
// throws. Pictures of each page at each size go to .demo/scaling, which git
// ignores.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openBrowser, reachable, sleep } from "./browserSession.mjs";

const base = process.env.DEMO_URL ?? "http://localhost:3001";
const outDir = resolve(".demo/scaling");
const debugPort = 9445;
const settleMs = 6000;
const resizeSettleMs = 1500;

const sizes = [
	{ name: "phone", width: 390, height: 844, mobile: true, scale: 3 },
	{ name: "tablet", width: 820, height: 1180, mobile: true, scale: 2 },
	{ name: "laptop", width: 1366, height: 768 },
	{ name: "hd", width: 1920, height: 1080 },
	{ name: "qhd", width: 2560, height: 1440 },
	{ name: "4k", width: 3840, height: 2160 },
];

const pages = [
	{ name: "home", path: "/" },
	{ name: "report", path: "/r/revenue-overview/" },
	{ name: "matrix", path: "/r/revenue-overview/?page=regionByChannel" },
	{ name: "category", path: "/c/sales/" },
	{ name: "dictionary", path: "/dictionary/" },
	{ name: "explore", path: "/explore/" },
	{ name: "sheets", path: "/sheets/" },
	{ name: "status", path: "/status/" },
	{ name: "editor", path: "/r/revenue-overview/?edit=1" },
];

// What is wrong with the page as drawn, measured inside it.
const measure = `(() => {
	const problems = [];
	const root = document.documentElement;
	const width = window.innerWidth;

	if (root.scrollWidth > root.clientWidth + 1) {
		problems.push("scrolls sideways by " + (root.scrollWidth - root.clientWidth) + "px");
	}

	// Inside something that scrolls is fine, since that is how a wide table is
	// read. Something past the edge with nothing to scroll it into view is cut off.
	const scrolls = (el) => {
		for (let at = el.parentElement; at && at !== document.body; at = at.parentElement) {
			const style = getComputedStyle(at);
			if (/(auto|scroll|hidden)/.test(style.overflowX)) return true;
		}
		return false;
	};
	const cut = new Set();
	for (const el of document.querySelectorAll("main *, header *, nav *, button, h1, h2, h3, input")) {
		const box = el.getBoundingClientRect();
		if (box.width === 0 || box.height === 0) continue;
		const style = getComputedStyle(el);
		if (style.visibility === "hidden" || style.position === "fixed") continue;
		if (box.left >= width || box.right <= 0) continue;
		if (box.right > width + 1 && !scrolls(el)) {
			cut.add((el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40));
		}
	}
	if (cut.size > 0) problems.push("cut off at the edge: " + [...cut].slice(0, 3).join(", "));

	// A page fills a wide monitor rather than sitting in a column.
	if (width >= 1366) {
		let right = 0;
		for (const el of document.querySelectorAll("main *")) {
			const box = el.getBoundingClientRect();
			if (box.width > 0 && box.height > 0 && box.right <= width + 1) {
				right = Math.max(right, box.right);
			}
		}
		const unused = width - right;
		if (right > 0 && unused > width * 0.08) {
			problems.push("leaves " + Math.round(unused) + "px unused at its side");
		}
	}

	// A chart that kept an old size no longer matches the box it is drawn in.
	let wrong = 0;
	for (const canvas of document.querySelectorAll("canvas")) {
		const box = canvas.getBoundingClientRect();
		const holder = canvas.parentElement?.getBoundingClientRect();
		if (!holder || holder.width === 0) continue;
		if (box.width === 0 || Math.abs(box.width - holder.width) > 2) wrong++;
	}
	if (wrong > 0) problems.push(wrong + " chart(s) not the size of their box");

	return problems;
})()`;

if (!(await reachable(base))) {
	console.error(
		`Nothing answers at ${base}. Start the demo with npm run dev2.`,
	);
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const browser = await openBrowser(debugPort);
const thrown = [];
let failures = 0;

const report = (where, problems) => {
	if (problems.length === 0) return;
	failures += problems.length;
	for (const problem of problems) console.log(`FAIL ${where}: ${problem}`);
};

try {
	const page = await browser.openPage((method, params) => {
		if (method === "Runtime.exceptionThrown") {
			thrown.push(
				params.exceptionDetails.exception?.description?.slice(0, 200) ??
					params.exceptionDetails.text,
			);
		}
	});
	await page.send("Runtime.enable");
	await page.send("Page.enable");
	await page.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value: "dark" }],
	});

	const setSize = (size) =>
		page.send("Emulation.setDeviceMetricsOverride", {
			width: size.width,
			height: size.height,
			deviceScaleFactor: size.scale ?? 1,
			mobile: Boolean(size.mobile),
		});
	const problemsNow = async () =>
		(
			await page.send("Runtime.evaluate", {
				expression: measure,
				returnByValue: true,
			})
		).result?.result?.value ?? ["could not be measured"];

	for (const target of pages) {
		// Opened fresh at each size.
		for (const size of sizes) {
			await setSize(size);
			thrown.length = 0;
			await page.send("Page.navigate", { url: `${base}${target.path}` });
			await sleep(settleMs);
			report(`${target.name} at ${size.name}`, await problemsNow());
			report(`${target.name} at ${size.name}`, [...thrown]);
			const picture = await page.send("Page.captureScreenshot", {
				format: "png",
			});
			writeFileSync(
				resolve(outDir, `${target.name}-${size.name}.png`),
				Buffer.from(picture.result.data, "base64"),
			);
		}

		// The same page resized in place, largest to smallest and back up. The
		// phone is left out, since a window does not become a phone.
		const desktop = sizes.filter((size) => !size.mobile);
		await setSize(desktop[0]);
		await page.send("Page.navigate", { url: `${base}${target.path}` });
		await sleep(settleMs);
		for (const size of [
			...desktop.slice(1),
			...desktop.slice(0, -1).reverse(),
		]) {
			await setSize(size);
			await sleep(resizeSettleMs);
			report(
				`${target.name} resized to ${size.name}`,
				await problemsNow(),
			);
		}
		console.log(`Checked ${target.name}`);
	}
	page.close();
} finally {
	await browser.close();
}

console.log(
	failures === 0
		? `Every page held at every size. Pictures are in ${outDir}.`
		: `${failures} problem(s). Pictures are in ${outDir}.`,
);
process.exit(failures === 0 ? 0 : 1);
