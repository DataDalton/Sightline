"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import type { WorkSummary } from "../../lib/work/store";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import styles from "./Work.module.css";

// The questions the work queue asks, as dialogs in the app.
//
// useAsk gives a function that opens a dialog with the fields named and
// resolves with what was entered, or null when it is closed. People, requests
// and datasets are chosen from lists, so nobody types an email or a key.

interface TextField {
	name: string;
	label: string;
	placeholder?: string;
	optional?: boolean;
}

export type AskField =
	| (TextField & { kind: "text" })
	| (TextField & { kind: "textarea" })
	| {
			name: string;
			label: string;
			kind: "person" | "request" | "dataset";
			optional?: boolean;
			// Left out of the list, such as the request being edited.
			exclude?: string[];
	  };

export interface AskSpec {
	title: string;
	fields: AskField[];
	submit: string;
	// Draws the submit button in the danger colour.
	danger?: boolean;
}

export interface ConfirmSpec {
	title: string;
	body: string;
	confirm?: string;
}

type Values = Record<string, string>;

export function useAsk(): {
	ask: (spec: AskSpec) => Promise<Values | null>;
	confirm: (spec: ConfirmSpec) => Promise<boolean>;
	dialog: ReactNode;
} {
	const [spec, setSpec] = useState<AskSpec | null>(null);
	const [confirming, setConfirming] = useState<ConfirmSpec | null>(null);
	const settle = useRef<((values: Values | null) => void) | null>(null);
	const settleConfirm = useRef<((yes: boolean) => void) | null>(null);

	const ask = useCallback(
		(next: AskSpec) =>
			new Promise<Values | null>((resolve) => {
				settle.current = resolve;
				setSpec(next);
			}),
		[],
	);
	const confirm = useCallback(
		(next: ConfirmSpec) =>
			new Promise<boolean>((resolve) => {
				settleConfirm.current = resolve;
				setConfirming(next);
			}),
		[],
	);

	const finish = (values: Values | null) => {
		settle.current?.(values);
		settle.current = null;
		setSpec(null);
	};
	const finishConfirm = (yes: boolean) => {
		settleConfirm.current?.(yes);
		settleConfirm.current = null;
		setConfirming(null);
	};

	const dialog = (
		<>
			{spec && (
				<AskDialog
					spec={spec}
					onCancel={() => finish(null)}
					onSubmit={finish}
				/>
			)}
			{confirming && (
				<ConfirmDialog
					title={confirming.title}
					body={confirming.body}
					confirmLabel={confirming.confirm}
					onConfirm={() => finishConfirm(true)}
					onCancel={() => finishConfirm(false)}
				/>
			)}
		</>
	);
	return { ask, confirm, dialog };
}

function AskDialog({
	spec,
	onCancel,
	onSubmit,
}: {
	spec: AskSpec;
	onCancel: () => void;
	onSubmit: (values: Values) => void;
}) {
	const [values, setValues] = useState<Values>({});
	const set = (name: string, value: string) =>
		setValues((held) => ({ ...held, [name]: value }));
	const ready = spec.fields.every(
		(field) => field.optional || (values[field.name] ?? "").trim(),
	);
	const send = () => {
		if (!ready) return;
		onSubmit(
			Object.fromEntries(
				spec.fields.map((field) => [
					field.name,
					(values[field.name] ?? "").trim(),
				]),
			),
		);
	};

	return (
		<Modal isOpen onClose={onCancel} title={spec.title} width="560px">
			<form
				className={styles.form}
				onSubmit={(event) => {
					event.preventDefault();
					send();
				}}
			>
				{spec.fields.map((field, index) => (
					<label key={field.name} className={styles.field}>
						<span>
							{field.label}
							{field.optional ? (
								<span className={styles.optional}>
									{" "}
									(optional)
								</span>
							) : null}
						</span>
						{field.kind === "text" || field.kind === "textarea" ? (
							field.kind === "textarea" ? (
								<textarea
									className={styles.input}
									rows={3}
									autoFocus={index === 0}
									placeholder={field.placeholder}
									value={values[field.name] ?? ""}
									onChange={(e) =>
										set(field.name, e.target.value)
									}
								/>
							) : (
								<input
									className={styles.input}
									autoFocus={index === 0}
									placeholder={field.placeholder}
									value={values[field.name] ?? ""}
									onChange={(e) =>
										set(field.name, e.target.value)
									}
								/>
							)
						) : (
							<Picker
								field={field}
								value={values[field.name] ?? ""}
								onChange={(value) => set(field.name, value)}
							/>
						)}
					</label>
				))}
				<div className={styles.formActions}>
					<button
						type="button"
						className={styles.secondary}
						onClick={onCancel}
					>
						Cancel
					</button>
					<button
						type="submit"
						className={
							spec.danger ? styles.dangerSolid : styles.primary
						}
						disabled={!ready}
					>
						{spec.submit}
					</button>
				</div>
			</form>
		</Modal>
	);
}

// A searchable list of people, requests or datasets.
function Picker({
	field,
	value,
	onChange,
}: {
	field: Extract<AskField, { kind: "person" | "request" | "dataset" }>;
	value: string;
	onChange: (value: string) => void;
}) {
	const { data: people } = useSWR<{
		people: { email: string; name: string }[];
	}>(field.kind === "person" ? "/api/changes?people=1" : null);
	const { data: queue } = useSWR<{ items: WorkSummary[] }>(
		field.kind === "request" ? "/api/work?closed=include&limit=500" : null,
	);
	const { data: choices } = useSWR<{
		sources: { key: string; title: string }[];
	}>(field.kind === "dataset" ? "/api/changes?choices=1" : null);
	const exclude = new Set(field.exclude ?? []);

	const options =
		field.kind === "person"
			? (people?.people ?? []).map((p) => ({
					value: p.email,
					label: p.name,
					note: p.email,
				}))
			: field.kind === "request"
				? (queue?.items ?? []).map((item) => ({
						value: item.key,
						label: `${item.key} ${item.title}`,
					}))
				: (choices?.sources ?? []).map((s) => ({
						value: s.key,
						label: s.title,
					}));

	return (
		<Select
			value={value}
			searchable
			ariaLabel={field.label}
			placeholder={
				field.kind === "person"
					? "Choose a person"
					: field.kind === "request"
						? "Choose a request"
						: "Choose a dataset"
			}
			onChange={onChange}
			options={[
				...(field.optional ? [{ value: "", label: "None" }] : []),
				...options.filter((option) => !exclude.has(option.value)),
			]}
		/>
	);
}
