"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import Link from "../components/AppLink";
import useSWR, { useSWRConfig } from "swr";
import type { InboxItem } from "../../lib/notify/store";
import { useUser } from "../context/UserContext";
import { Modal } from "../components/shared/Modal";
import {
	currentSubscription,
	disablePush,
	enablePush,
	isIos,
	isStandalone,
	pushSupport,
	registerServiceWorker,
	type InstallPromptEvent,
	type PushSupport,
} from "./pwa";
import { KindIcon } from "./icons";
import styles from "./Notify.module.css";

// The inbox count, the install prompt and this device's push state, shared by
// every place that shows them: the bell in the header, the tab bar on a
// phone, the inbox page and the account menu.

export const summaryKey = "/api/notifications/summary";

interface Summary {
	unread: number;
	latest: InboxItem | null;
	pushKey: string | null;
	alerts: boolean;
}

interface NotifyState {
	unread: number;
	alertsEnabled: boolean;
	// Refreshes the count and every inbox list on screen.
	refresh: () => void;

	standalone: boolean;
	// An install the app itself can start, which only Chromium browsers
	// offer. iOS installs through the share sheet, so it gets instructions.
	canInstall: boolean;
	ios: boolean;
	install: () => void;

	pushAvailable: boolean;
	support: PushSupport;
	// Whether this browser is subscribed. Null until it has been asked.
	pushOn: boolean | null;
	pushBusy: boolean;
	pushError: string | null;
	turnOnPush: () => Promise<void>;
	turnOffPush: () => Promise<void>;
}

const NotifyContext = createContext<NotifyState | null>(null);

// How often the count is asked for while the app is open. A push, where
// there is one, refreshes it at once.
const pollMs = 60 * 1000;

export function NotifyProvider({ children }: { children: ReactNode }) {
	const { user } = useUser();
	const { mutate } = useSWRConfig();

	const { data } = useSWR<Summary>(user ? summaryKey : null, {
		refreshInterval: pollMs,
		revalidateOnFocus: true,
	});

	const refresh = useCallback(() => {
		void mutate(
			(key) =>
				typeof key === "string" && key.startsWith("/api/notifications"),
		);
	}, [mutate]);

	// --- The installed app ---------------------------------------------------

	const [standalone, setStandalone] = useState(false);
	const [ios, setIos] = useState(false);
	const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
	const [iosHelp, setIosHelp] = useState(false);

	useEffect(() => {
		setStandalone(isStandalone());
		setIos(isIos());
		void registerServiceWorker();

		const onPrompt = (e: Event) => {
			// Held rather than shown, so the offer comes from the app's own
			// button when somebody wants it.
			e.preventDefault();
			setPrompt(e as InstallPromptEvent);
		};
		const onInstalled = () => {
			setPrompt(null);
			setStandalone(true);
		};
		window.addEventListener("beforeinstallprompt", onPrompt);
		window.addEventListener("appinstalled", onInstalled);

		// A push arriving while the app is open refreshes the count now.
		const onMessage = (e: MessageEvent) => {
			if (e.data?.type === "sightline:notification") refresh();
		};
		navigator.serviceWorker?.addEventListener("message", onMessage);

		return () => {
			window.removeEventListener("beforeinstallprompt", onPrompt);
			window.removeEventListener("appinstalled", onInstalled);
			navigator.serviceWorker?.removeEventListener("message", onMessage);
		};
	}, [refresh]);

	const install = useCallback(() => {
		if (prompt) {
			void prompt.prompt();
			void prompt.userChoice.finally(() => setPrompt(null));
		} else {
			setIosHelp(true);
		}
	}, [prompt]);

	// --- Pushes on this device -----------------------------------------------

	const [support, setSupport] = useState<PushSupport>("unsupported");
	const [pushOn, setPushOn] = useState<boolean | null>(null);
	const [pushBusy, setPushBusy] = useState(false);
	const [pushError, setPushError] = useState<string | null>(null);

	useEffect(() => {
		setSupport(pushSupport());
		void currentSubscription()
			.then((s) => setPushOn(Boolean(s)))
			.catch(() => setPushOn(false));
	}, [standalone]);

	const pushKey = data?.pushKey ?? null;

	const turnOnPush = useCallback(async () => {
		if (!pushKey) return;
		setPushBusy(true);
		setPushError(null);
		try {
			await enablePush(pushKey);
			setPushOn(true);
			refresh();
		} catch (error) {
			setPushError(
				error instanceof Error
					? error.message
					: "Could not turn on notifications.",
			);
		} finally {
			setSupport(pushSupport());
			setPushBusy(false);
		}
	}, [pushKey, refresh]);

	const turnOffPush = useCallback(async () => {
		setPushBusy(true);
		setPushError(null);
		try {
			await disablePush();
			setPushOn(false);
			refresh();
		} finally {
			setPushBusy(false);
		}
	}, [refresh]);

	// --- The count on the app icon -------------------------------------------

	const unread = data?.unread ?? 0;
	useEffect(() => {
		const nav = navigator as Navigator & {
			setAppBadge?: (n?: number) => Promise<void>;
			clearAppBadge?: () => Promise<void>;
		};
		if (!nav.setAppBadge) return;
		if (unread > 0) void nav.setAppBadge(unread).catch(() => {});
		else void nav.clearAppBadge?.().catch(() => {});
	}, [unread]);

	// --- Saying so when something new arrives --------------------------------

	const [toast, setToast] = useState<InboxItem | null>(null);
	const seen = useRef<string | null | undefined>(undefined);
	useEffect(() => {
		const latest = data?.latest ?? null;
		if (data === undefined) return;
		// The first answer is what was already there, not news.
		if (seen.current === undefined) {
			seen.current = latest?.id ?? null;
			return;
		}
		if (latest && latest.id !== seen.current && !latest.readOn) {
			setToast(latest);
			refresh();
		}
		seen.current = latest?.id ?? null;
	}, [data, refresh]);

	useEffect(() => {
		if (!toast) return;
		const t = setTimeout(() => setToast(null), 7000);
		return () => clearTimeout(t);
	}, [toast]);

	const value = useMemo<NotifyState>(
		() => ({
			unread,
			alertsEnabled: data?.alerts ?? false,
			refresh,
			standalone,
			canInstall: !standalone && (prompt !== null || ios),
			ios,
			install,
			pushAvailable: Boolean(pushKey),
			support,
			pushOn,
			pushBusy,
			pushError,
			turnOnPush,
			turnOffPush,
		}),
		[
			unread,
			data?.alerts,
			refresh,
			standalone,
			prompt,
			ios,
			install,
			pushKey,
			support,
			pushOn,
			pushBusy,
			pushError,
			turnOnPush,
			turnOffPush,
		],
	);

	return (
		<NotifyContext.Provider value={value}>
			{children}

			{toast && (
				<div className={styles.toast} role="status">
					<span className={styles.toastIcon} aria-hidden="true">
						<KindIcon kind={toast.kind} />
					</span>
					<span className={styles.toastText}>
						<span className={styles.toastTitle}>{toast.title}</span>
						{toast.body && (
							<span className={styles.toastBody}>
								{toast.body.split("\n")[0]}
							</span>
						)}
					</span>
					<Link
						href={toast.link ?? "/inbox/"}
						className={styles.toastAction}
						onClick={() => setToast(null)}
					>
						View
					</Link>
					<button
						type="button"
						className={styles.toastClose}
						aria-label="Dismiss"
						onClick={() => setToast(null)}
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
						>
							<path d="M6 6l12 12M18 6L6 18" />
						</svg>
					</button>
				</div>
			)}

			<Modal
				isOpen={iosHelp}
				onClose={() => setIosHelp(false)}
				title="Install the app"
				width="420px"
			>
				<InstallSteps ios={ios} />
			</Modal>
		</NotifyContext.Provider>
	);
}

// What installing looks like where the browser offers no button of its own.
function InstallSteps({ ios }: { ios: boolean }) {
	if (ios) {
		return (
			<ol className={styles.steps}>
				<li>
					Tap the <b>Share</b> button in Safari
					<ShareIcon />
				</li>
				<li>
					Choose <b>Add to Home Screen</b>
				</li>
				<li>
					Open the app from your home screen. Turn notifications on
					from inside it: iOS only sends them to installed apps.
				</li>
			</ol>
		);
	}
	return (
		<ol className={styles.steps}>
			<li>
				Open the browser menu, or look for the install icon at the end
				of the address bar.
			</li>
			<li>
				Choose <b>Install app</b> or <b>Add to Home screen</b>.
			</li>
		</ol>
	);
}

function ShareIcon() {
	return (
		<svg
			className={styles.inlineIcon}
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
		</svg>
	);
}

export function useNotify(): NotifyState {
	const state = useContext(NotifyContext);
	if (!state) throw new Error("useNotify outside NotifyProvider");
	return state;
}
