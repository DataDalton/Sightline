// Takes the pictures in the documentation from the running offline demo.
//
//   npm run dev2                  in one terminal
//   npm run screenshots           in another
//
// Drives an installed Chrome or Edge through its debugging protocol, so no
// browser package is added to the project. Set CHROME_PATH when neither is
// found where they usually install. Pictures are written to docs/images at 4K,
// a full HD window at twice the pixel density, so the interface is drawn at the
// size a reader sees it and stays sharp. The phone keeps a phone's shape, at the
// density a phone has.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openBrowser, reachable, sleep } from "./browserSession.mjs";

const base = process.env.DEMO_URL ?? "http://localhost:3001";
const outDir = resolve("../../docs/images");
const debugPort = 9444;
const scale = 2;
const phoneScale = 3;
const width = 1920;
const height = 1080;

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
// Board names a board by its title, found when the run starts.
const shots = [
	{ name: "home", path: "/", width, height },
	{ name: "report", path: "/r/revenue-overview/", width, height },
	{ name: "flow", path: "/r/warehouse-flow/", width, height },
	{ name: "category", path: "/c/sales/", width, height },
	{
		name: "conversations",
		path: "/inbox/?view=conversations",
		width,
		height,
		click: "[aria-label='Conversations'] button",
	},
	{
		name: "editor",
		path: "/r/revenue-overview/?edit=1",
		width,
		height,
	},
	{
		name: "dictionary",
		path: "/dictionary/",
		width,
		height,
		clickText: "Average Headcount",
	},
	{
		name: "explore",
		path: `/explore/?q=${exploration}`,
		width,
		height,
	},
	{
		name: "sheet",
		path: "/sheets/",
		width,
		height,
		clickText: "Regional margin",
	},
	{
		name: "usage",
		path: "/r/revenue-overview/",
		width,
		height,
		clickText: "Usage",
	},
	{
		name: "board",
		board: "Q3 revenue story",
		width,
		height,
		wait: 12000,
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

if (!(await reachable(base))) {
	console.error(
		`Nothing answers at ${base}. Start the demo with npm run dev2.`,
	);
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const browser = await openBrowser(debugPort);

try {
	const page = await browser.openPage();
	await page.send("Page.enable");
	await page.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value: "dark" }],
	});

	for (const shot of shots) {
		await page.send("Emulation.setDeviceMetricsOverride", {
			width: shot.width,
			height: shot.height,
			deviceScaleFactor: shot.mobile ? phoneScale : scale,
			mobile: Boolean(shot.mobile),
		});
		let path = shot.path;
		if (shot.board) {
			const { boards } = await (
				await fetch(`${base}/api/boards/`)
			).json();
			const found = boards.find((b) => b.title === shot.board);
			if (!found) {
				console.warn(
					`No board called ${shot.board}, so ${shot.name} is skipped.`,
				);
				continue;
			}
			path = `/boards/${found.id}/`;
		}
		await page.send("Page.navigate", { url: `${base}${path}` });
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
	await browser.close();
}
