"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import { useUser } from "../context/UserContext";
import form from "../authoring/Authoring.module.css";

// Starting a page from a report file exported elsewhere, or from a picture of an old
// dashboard, which the assistant rebuilds from real fields.

async function send(body: Record<string, unknown>) {
	const response = await fetch("/api/report-import", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		detail: await response.json().catch(() => null),
	};
}

function readAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () =>
			reject(new Error("That file could not be read."));
		reader.readAsDataURL(file);
	});
}

export function BringReportIn({ buttonClass }: { buttonClass: string }) {
	const router = useRouter();
	const { user } = useUser();
	const [mode, setMode] = useState<"file" | "picture" | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [missing, setMissing] = useState<string[] | null>(null);
	const [held, setHeld] = useState<unknown>(null);
	const [sourceKey, setSourceKey] = useState("");
	const { data: options } = useSWR<{
		sources: { sourceKey: string; title: string }[];
	}>(mode === "picture" ? "/api/authoring" : null);

	const finish = (slug: string) => {
		setMode(null);
		router.push(`/r/${slug}?edit=1`);
	};
	const importFile = async (pack: unknown, anyway: boolean) => {
		setBusy(true);
		setFailure(null);
		const { status, detail } = await send({ package: pack, anyway });
		setBusy(false);
		if (status === 409) {
			setHeld(pack);
			setMissing(detail.missing);
			return;
		}
		if (status !== 200) {
			setFailure(detail?.error ?? "That file could not be brought in.");
			return;
		}
		finish(detail.slug);
	};

	return (
		<>
			<button
				type="button"
				className={buttonClass}
				onClick={() => setMode("file")}
			>
				Import a report
			</button>
			{user?.assistant && (
				<button
					type="button"
					className={buttonClass}
					onClick={() => setMode("picture")}
				>
					From a picture
				</button>
			)}
			{mode && (
				<Modal
					isOpen
					onClose={() => setMode(null)}
					title={
						mode === "file"
							? "Import a report"
							: "Build from a picture"
					}
					width="560px"
				>
					<div className={form.form}>
						{mode === "picture" && (
							<label className={form.field}>
								<span className={form.label}>
									Which data to rebuild it on
								</span>
								<Select
									value={sourceKey}
									placeholder="Choose one"
									searchable
									onChange={setSourceKey}
									options={(options?.sources ?? []).map(
										(source) => ({
											value: source.sourceKey,
											label: source.title,
										}),
									)}
								/>
							</label>
						)}
						<label className={form.field}>
							<span className={form.label}>
								{mode === "file"
									? "A .report.json file"
									: "A screenshot or photo"}
							</span>
							<input
								type="file"
								className={form.input}
								disabled={
									busy || (mode === "picture" && !sourceKey)
								}
								accept={
									mode === "file"
										? ".json,application/json"
										: "image/*"
								}
								onChange={async (e) => {
									const file = e.target.files?.[0];
									if (!file) return;
									setFailure(null);
									try {
										if (mode === "file") {
											await importFile(
												JSON.parse(await file.text()),
												false,
											);
											return;
										}
										setBusy(true);
										const { status, detail } = await send({
											action: "picture",
											sourceKey,
											title: file.name.replace(
												/\.[^.]+$/,
												"",
											),
											image: await readAsDataUrl(file),
										});
										setBusy(false);
										if (status !== 200) {
											setFailure(
												detail?.error ??
													"That did not work.",
											);
											return;
										}
										finish(detail.slug);
									} catch (error) {
										setBusy(false);
										setFailure(
											error instanceof SyntaxError
												? "That is not a report file."
												: error instanceof Error
													? error.message
													: "That did not work.",
										);
									}
								}}
							/>
							<span className={form.hint}>
								{mode === "file"
									? "It arrives as your own page, for you to check and ask to publish."
									: "Only real fields are used, and no numbers are copied from the picture. It arrives as your own page to check."}
							</span>
						</label>
						{busy && (
							<span className={form.hint}>Working on it.</span>
						)}
						{missing && (
							<div className={form.failure}>
								<p>
									This report needs things that are not here:
								</p>
								<ul>
									{missing.map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
								<button
									type="button"
									className={form.secondary}
									disabled={busy}
									onClick={() => void importFile(held, true)}
								>
									Bring it in anyway
								</button>
							</div>
						)}
						{failure && (
							<div className={form.failure}>{failure}</div>
						)}
					</div>
				</Modal>
			)}
		</>
	);
}
