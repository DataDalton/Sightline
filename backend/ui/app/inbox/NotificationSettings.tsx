"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import type { Device, PushPreferences } from "../../lib/notify/push";
import { ago } from "../admin/when";
import { Toggle } from "../components/shared/Toggle";
import { useNotify } from "../notify/NotifyContext";
import { currentSubscription } from "../notify/pwa";
import styles from "./Inbox.module.css";

// How somebody wants to be told: on this device or not, which kinds, and the
// devices already set up.

const pushKey = "/api/notifications/push";

const kinds: { kind: keyof PushPreferences; label: string; hint: string }[] = [
	{
		kind: "alert",
		label: "Alerts",
		hint: "When an alert you set fires.",
	},
	{
		kind: "share",
		label: "Shared pages",
		hint: "When somebody shares a page with you.",
	},
	{
		kind: "message",
		label: "Conversations",
		hint: "When somebody asks about a category you maintain, or replies to you.",
	},
	{
		kind: "delivery",
		label: "Scheduled pages",
		hint: "When a page you subscribed to arrives.",
	},
	{
		kind: "system",
		label: "Announcements",
		hint: "Notices from the people who run the app.",
	},
];

export function NotificationSettings() {
	const notify = useNotify();
	const { data, mutate } = useSWR<{
		publicKey: string | null;
		devices: Device[];
		preferences: PushPreferences;
	}>(pushKey);

	const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
	useEffect(() => {
		void currentSubscription().then((s) =>
			setThisEndpoint(s?.endpoint ?? null),
		);
	}, [notify.pushOn]);

	const [testState, setTestState] = useState<string | null>(null);

	const savePreference = async (kind: keyof PushPreferences, on: boolean) => {
		if (!data) return;
		const preferences = { ...data.preferences, [kind]: on };
		void mutate({ ...data, preferences }, false);
		await fetch(pushKey, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ preferences }),
		});
		void mutate();
	};

	const removeDevice = async (endpoint: string) => {
		await fetch(pushKey, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint }),
		});
		if (endpoint === thisEndpoint) await notify.turnOffPush();
		void mutate();
	};

	const sendTest = async () => {
		setTestState("Sending");
		const response = await fetch(`${pushKey}/test`, { method: "POST" });
		const outcome = (await response.json().catch(() => null)) as {
			sent: number;
			failed: number;
		} | null;
		setTestState(
			!outcome
				? "Could not send."
				: outcome.sent > 0
					? `Sent to ${outcome.sent} ${outcome.sent === 1 ? "device" : "devices"}.`
					: "No device accepted it. Turn notifications off and on again on the device.",
		);
		void mutate();
	};

	const available = Boolean(data?.publicKey);

	return (
		<div className={styles.settings}>
			<section className={styles.card}>
				<h2 className={styles.cardTitle}>This device</h2>

				{!data ? null : !available ? (
					<p className={styles.note}>
						Notifications on phones and computers are turned off for
						this app. Everything still arrives in this inbox. An
						administrator can turn them on under Administration,
						Notifications.
					</p>
				) : notify.support === "needs-install" ? (
					<div className={styles.stack}>
						<p className={styles.note}>
							On iPhone and iPad, notifications only reach apps on
							the home screen. Add this app to your home screen,
							open it from there, and turn notifications on here.
						</p>
						<button
							type="button"
							className={styles.primary}
							onClick={notify.install}
						>
							Show me how
						</button>
					</div>
				) : notify.support === "denied" ? (
					<p className={styles.note}>
						Notifications are blocked for this site. Allow them in
						the browser&apos;s site settings, then come back here.
					</p>
				) : notify.support === "unsupported" ? (
					<p className={styles.note}>
						This browser cannot receive notifications from websites.
						Everything still arrives in this inbox.
					</p>
				) : (
					<div className={styles.stack}>
						<div className={styles.settingRow}>
							<div>
								<div className={styles.settingLabel}>
									Notifications on this device
								</div>
								<div className={styles.settingHint}>
									{notify.pushOn
										? "This device shows your notifications, even when the app is closed."
										: "Off. Everything still arrives in this inbox."}
								</div>
							</div>
							<Toggle
								checked={Boolean(notify.pushOn)}
								disabled={
									notify.pushBusy || notify.pushOn === null
								}
								onChange={(on) =>
									void (
										on
											? notify.turnOnPush()
											: notify.turnOffPush()
									).then(() => mutate())
								}
								ariaLabel="Notifications on this device"
							/>
						</div>
						{notify.pushError && (
							<p className={styles.error}>{notify.pushError}</p>
						)}
						{notify.pushOn && (
							<div className={styles.inline}>
								<button
									type="button"
									className={styles.secondary}
									onClick={sendTest}
								>
									Send a test notification
								</button>
								{testState && (
									<span className={styles.settingHint}>
										{testState}
									</span>
								)}
							</div>
						)}
					</div>
				)}
			</section>

			<section className={styles.card}>
				<h2 className={styles.cardTitle}>Install the app</h2>
				{notify.standalone ? (
					<p className={styles.note}>
						You are using the installed app.
					</p>
				) : (
					<div className={styles.stack}>
						<p className={styles.note}>
							Installed, it opens in its own window from your home
							screen, dock or start menu, with the unread count on
							its icon.
						</p>
						<button
							type="button"
							className={styles.secondary}
							onClick={notify.install}
						>
							{notify.canInstall ? "Install" : "How to install"}
						</button>
					</div>
				)}
			</section>

			{available && data && (
				<section className={styles.card}>
					<h2 className={styles.cardTitle}>Send to my devices</h2>
					<p className={styles.note}>
						Everything arrives in the inbox. These decide what is
						also sent to your phone and computer.
					</p>
					<div className={styles.stack}>
						{kinds.map((k) => (
							<div key={k.kind} className={styles.settingRow}>
								<div>
									<div className={styles.settingLabel}>
										{k.label}
									</div>
									<div className={styles.settingHint}>
										{k.hint}
									</div>
								</div>
								<Toggle
									checked={data.preferences[k.kind]}
									onChange={(on) =>
										void savePreference(k.kind, on)
									}
									ariaLabel={k.label}
								/>
							</div>
						))}
					</div>
				</section>
			)}

			{available && data && data.devices.length > 0 && (
				<section className={styles.card}>
					<h2 className={styles.cardTitle}>Your devices</h2>
					<ul className={styles.devices}>
						{data.devices.map((d) => (
							<li key={d.endpoint} className={styles.device}>
								<span className={styles.deviceText}>
									<span className={styles.settingLabel}>
										{d.device || "Device"}
										{d.endpoint === thisEndpoint && (
											<span className={styles.thisDevice}>
												This device
											</span>
										)}
									</span>
									<span className={styles.settingHint}>
										Added {ago(d.createdOn)}
										{d.lastSentOn
											? `, last sent ${ago(d.lastSentOn)}`
											: ""}
										{d.failing ? ", not responding" : ""}
									</span>
								</span>
								<button
									type="button"
									className={styles.secondary}
									onClick={() =>
										void removeDevice(d.endpoint)
									}
								>
									Remove
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
