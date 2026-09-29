// The service worker for the installed app.
//
// Three jobs. A page that cannot load because the device is offline shows a
// page saying so instead of the browser's error. Build assets, which never
// change once published, are kept so the app opens quickly. Pushes from the
// server are shown as notifications, and tapping one opens the page it names.
//
// Nothing else is cached. Every page and every answer is specific to the
// person signed in and to their access, so none of it is kept on the device.

const version = "2";
const shellCache = `sightline-shell-${version}`;
const assetCache = "sightline-assets";
const offlineUrl = "/offline.html";
// Build assets kept at most. Each release publishes a new set under new names,
// so without a ceiling the cache would hold every release ever opened.
const maxAssets = 400;

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(shellCache)
			.then((cache) =>
				cache.add(new Request(offlineUrl, { cache: "reload" })),
			)
			.catch(() => {}),
	);
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys().catch(() => []);
			for (const key of keys) {
				if (key.startsWith("sightline-shell-") && key !== shellCache) {
					await caches.delete(key).catch(() => {});
				}
			}
			if (self.registration.navigationPreload) {
				await self.registration.navigationPreload.enable();
			}
			await self.clients.claim();
		})(),
	);
});

async function trimAssets() {
	const cache = await caches.open(assetCache).catch(() => null);
	if (!cache) return;
	const keys = await cache.keys();
	for (const key of keys.slice(0, Math.max(0, keys.length - maxAssets))) {
		await cache.delete(key);
	}
}

// A cache that cannot be opened, which happens in a private window, on a full
// disk and on a damaged profile, must cost speed and nothing else. Every cache
// step falls back to the network rather than failing the request, because a
// stylesheet that fails here is a page with no styling.
async function fromAssetCache(request) {
	let cache = null;
	try {
		cache = await caches.open(assetCache);
		const hit = await cache.match(request);
		if (hit) return hit;
	} catch {
		cache = null;
	}
	const response = await fetch(request);
	const control = response.headers.get("cache-control") || "";
	if (cache && response.ok && control.includes("immutable")) {
		cache
			.put(request, response.clone())
			.then(trimAssets)
			.catch(() => {});
	}
	return response;
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	if (request.mode === "navigate") {
		event.respondWith(
			(async () => {
				try {
					const preloaded = await event.preloadResponse;
					return preloaded || (await fetch(request));
				} catch {
					const offline = await caches
						.match(offlineUrl)
						.catch(() => null);
					return offline || Response.error();
				}
			})(),
		);
		return;
	}

	// Only what the server marked as never changing. A development build
	// serves the same names with new contents, and says so by leaving the
	// mark off.
	if (url.pathname.startsWith("/_next/static/")) {
		event.respondWith(fromAssetCache(request));
	}
});

// --- Pushes ------------------------------------------------------------------

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = { title: event.data ? event.data.text() : "" };
	}
	const title = data.title || "New notification";

	// A message can be answered from the notification. A browser with a text
	// field on its actions sends what is typed. One without shows the button
	// alone, and pressing it opens the conversation.
	const actions =
		data.kind === "message"
			? [
					{
						action: "reply",
						type: "text",
						title: "Reply",
						placeholder: "Write a reply",
					},
					{ action: "open", title: "Open" },
				]
			: [];

	event.waitUntil(
		(async () => {
			await self.registration.showNotification(title, {
				body: data.body || "",
				// One notification per inbox entry, so a repeat replaces
				// rather than stacks.
				tag: data.id || undefined,
				icon: "/app-icon/icon-192.png",
				badge: "/app-icon/badge-96.png",
				data: {
					id: data.id,
					kind: data.kind,
					link: data.link || "/inbox/",
				},
				actions,
				timestamp: Date.now(),
			});
			// An open window refreshes its inbox count rather than waiting
			// for its next poll.
			const windows = await self.clients.matchAll({ type: "window" });
			for (const client of windows) {
				client.postMessage({
					type: "sightline:notification",
					id: data.id,
				});
			}
		})(),
	);
});

// Sends a reply typed into a message notification. The conversation is named
// in the notification's link, and the server checks the sender is in it, as
// it does for a reply written on the page. True when it was sent.
async function sendReply(target, text) {
	const threadId = target.searchParams.get("thread");
	if (!threadId || !text.trim()) return false;
	try {
		const response = await fetch(
			`/api/messages/${encodeURIComponent(threadId)}/`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body: text }),
			},
		);
		return response.ok;
	} catch {
		return false;
	}
}

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const { id, link } = event.notification.data || {};
	const target = new URL(link || "/inbox/", self.location.origin);
	// Only ever a page of this app, whatever the payload said.
	if (target.origin !== self.location.origin) return;

	// Answered in place. Anything that stops the reply going, a signed out
	// session or a browser with no text field, opens the conversation
	// instead so what was meant to be said is not lost.
	if (event.action === "reply" && event.reply) {
		const text = event.reply;
		event.waitUntil(
			(async () => {
				if (await sendReply(target, text)) {
					if (id) {
						await fetch("/api/notifications/", {
							method: "PATCH",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ ids: [id], read: true }),
						}).catch(() => {});
					}
					return;
				}
				await self.clients.openWindow(target.href);
			})(),
		);
		return;
	}

	event.waitUntil(
		(async () => {
			// Opening it is reading it.
			if (id && !String(id).startsWith("test-")) {
				await fetch("/api/notifications/", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ids: [id], read: true }),
				}).catch(() => {});
			}

			const windows = await self.clients.matchAll({
				type: "window",
				includeUncontrolled: true,
			});
			for (const client of windows) {
				if (new URL(client.url).origin === self.location.origin) {
					await client.focus();
					if ("navigate" in client) {
						return client.navigate(target.href).catch(() => {});
					}
					return;
				}
			}
			return self.clients.openWindow(target.href);
		})(),
	);
});

function keyBytes(base64url) {
	const padded = (base64url + "===".slice((base64url.length + 3) % 4))
		.replace(/-/g, "+")
		.replace(/_/g, "/");
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

// The push service replaced this browser's subscription, which happens when it
// rotates its own keys. Subscribed again and handed to the server, so pushes
// keep arriving without anybody turning them back on.
self.addEventListener("pushsubscriptionchange", (event) => {
	event.waitUntil(
		(async () => {
			const response = await fetch("/api/notifications/push/");
			if (!response.ok) return;
			const { publicKey } = await response.json();
			if (!publicKey) return;
			const subscription = await self.registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: keyBytes(publicKey),
			});
			await fetch("/api/notifications/push/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					subscription: subscription.toJSON(),
					device: "Renewed subscription",
				}),
			});
		})(),
	);
});
