// What this browser can do as an installed app, and the calls that turn
// pushes on and off for it.

export type PushSupport =
	// Pushes work here and the permission has not been refused.
	| "supported"
	// iOS only delivers pushes to an app added to the home screen.
	| "needs-install"
	// Refused for this site in the browser's settings. Only the person can
	// undo that, from there.
	| "denied"
	| "unsupported";

export function isStandalone(): boolean {
	if (typeof window === "undefined") return false;
	return (
		window.matchMedia?.("(display-mode: standalone)").matches ||
		// Safari's own flag, from before it supported the media query.
		(navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

export function isIos(): boolean {
	if (typeof navigator === "undefined") return false;
	return (
		/iphone|ipad|ipod/i.test(navigator.userAgent) ||
		// iPadOS reports itself as a Mac, and is the only Mac with touch.
		(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
	);
}

export function pushSupport(): PushSupport {
	if (typeof window === "undefined") return "unsupported";
	const capable =
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window;
	if (!capable)
		return isIos() && !isStandalone() ? "needs-install" : "unsupported";
	if (Notification.permission === "denied") return "denied";
	return "supported";
}

// A name for this device in the list of devices that receive pushes, so
// somebody can tell their phone from their laptop.
export function deviceLabel(): string {
	const ua = navigator.userAgent;
	const os = /iphone/i.test(ua)
		? "iPhone"
		: /ipad/i.test(ua) || (isIos() && !/iphone/i.test(ua))
			? "iPad"
			: /android/i.test(ua)
				? "Android"
				: /windows/i.test(ua)
					? "Windows"
					: /mac os/i.test(ua)
						? "Mac"
						: /linux/i.test(ua)
							? "Linux"
							: "Device";
	const browser = /edg\//i.test(ua)
		? "Edge"
		: /firefox|fxios/i.test(ua)
			? "Firefox"
			: /chrome|crios/i.test(ua)
				? "Chrome"
				: /safari/i.test(ua)
					? "Safari"
					: "Browser";
	return `${os} · ${browser}${isStandalone() ? " (app)" : ""}`;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
	const padded = (base64url + "===".slice((base64url.length + 3) % 4))
		.replace(/-/g, "+")
		.replace(/_/g, "/");
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function registration(): Promise<ServiceWorkerRegistration | null> {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		return null;
	}
	return (await navigator.serviceWorker.getRegistration("/")) ?? null;
}

export async function registerServiceWorker(): Promise<void> {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		return;
	}
	try {
		await navigator.serviceWorker.register("/sw.js", {
			scope: "/",
			// The worker file is checked on every navigation rather than
			// through the HTTP cache, so a release reaches installed apps on
			// their next open.
			updateViaCache: "none",
		});
	} catch (error) {
		console.warn("The service worker could not be registered:", error);
	}
}

// This browser's subscription, if it has one.
export async function currentSubscription(): Promise<PushSubscription | null> {
	const reg = await registration();
	return (await reg?.pushManager.getSubscription()) ?? null;
}

async function send(method: string, body: unknown): Promise<Response> {
	return fetch("/api/notifications/push", {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

export class PushError extends Error {}

// Asks for permission, subscribes, and hands the subscription to the server.
// Has to be called from a tap or a click: browsers refuse a permission prompt
// that was not.
export async function enablePush(publicKey: string): Promise<void> {
	if (pushSupport() === "needs-install") {
		throw new PushError(
			"On iPhone and iPad, add the app to your home screen first, then turn notifications on from inside it.",
		);
	}
	const permission = await Notification.requestPermission();
	if (permission !== "granted") {
		throw new PushError(
			permission === "denied"
				? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again."
				: "Notifications were not allowed.",
		);
	}

	await registerServiceWorker();
	const reg = await navigator.serviceWorker.ready;
	let subscription = await reg.pushManager.getSubscription();

	// A subscription made against a key the server no longer has is useless.
	const current = subscription?.options.applicationServerKey;
	if (subscription && current) {
		const held = new Uint8Array(current);
		const wanted = keyBytes(publicKey);
		const same =
			held.length === wanted.length &&
			held.every((b, i) => b === wanted[i]);
		if (!same) {
			await subscription.unsubscribe();
			subscription = null;
		}
	}

	subscription ??= await reg.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: keyBytes(publicKey),
	});

	const response = await send("POST", {
		subscription: subscription.toJSON(),
		device: deviceLabel(),
	});
	if (!response.ok) {
		const info = await response.json().catch(() => null);
		throw new PushError(
			info?.error ?? "The server did not accept this device.",
		);
	}
}

export async function disablePush(): Promise<void> {
	const subscription = await currentSubscription();
	if (!subscription) return;
	await send("DELETE", { endpoint: subscription.endpoint }).catch(() => {});
	await subscription.unsubscribe().catch(() => {});
}

// The event Chromium browsers fire when the app can be installed. Held so the
// install can be offered from the app's own button rather than only from the
// address bar.
export interface InstallPromptEvent extends Event {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
