"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import form from "../authoring/Authoring.module.css";
import styles from "./Roles.module.css";

// Picking a table out of Unity Catalog and registering it.
//
// Three steps down: catalogue, schema, table. Each one is a query under the
// caller's own token, so the list is what they can see.

interface CatalogObject {
	name: string;
	kind: "metric_view" | "table";
	comment: string | null;
	registered: boolean;
}

interface Registered {
	sourceKey: string;
	dimensions: number;
	measures: number;
	warning: string | null;
}

export function AddSourceButton({
	onAdded,
	className,
}: {
	onAdded: () => void;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				className={className ?? form.openButton}
				onClick={() => setOpen(true)}
			>
				<span aria-hidden="true">+</span> Add a source
			</button>
			{open && (
				<AddSourceDialog
					onClose={() => setOpen(false)}
					onAdded={onAdded}
				/>
			)}
		</>
	);
}

function AddSourceDialog({
	onClose,
	onAdded,
}: {
	onClose: () => void;
	onAdded: () => void;
}) {
	const [catalog, setCatalog] = useState("");
	const [schema, setSchema] = useState("");
	const [object, setObject] = useState<CatalogObject | null>(null);
	const [title, setTitle] = useState("");
	const [hasRowFilter, setHasRowFilter] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [done, setDone] = useState<Registered | null>(null);

	const catalogs = useSWR<{ catalogs: string[]; error?: string }>(
		"/api/admin/sources",
	);
	const schemas = useSWR<{ schemas: string[]; error?: string }>(
		catalog
			? `/api/admin/sources?catalog=${encodeURIComponent(catalog)}`
			: null,
	);
	const objects = useSWR<{ objects: CatalogObject[]; error?: string }>(
		catalog && schema
			? `/api/admin/sources?catalog=${encodeURIComponent(
					catalog,
				)}&schema=${encodeURIComponent(schema)}`
			: null,
	);

	// The name defaults to the table's, which is right often enough that
	// clearing it would be busywork.
	useEffect(() => {
		if (object) setTitle(object.name.replace(/_/g, " "));
	}, [object]);

	const browseError =
		catalogs.data?.error ?? schemas.data?.error ?? objects.data?.error;

	const register = async () => {
		if (!object) return;
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch("/api/admin/sources", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					catalog,
					schema,
					object: object.name,
					kind: object.kind,
					title,
					description: object.comment,
					hasRowFilter,
				}),
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) {
				setFailure(body?.error ?? "Could not register that source.");
				return;
			}
			setDone(body as Registered);
			onAdded();
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "Could not register that source.",
			);
		} finally {
			setBusy(false);
		}
	};

	if (done) {
		return (
			<Modal isOpen onClose={onClose} title="Source added" width="520px">
				<div className={form.form}>
					<p>
						<strong>{title}</strong> is ready with {done.dimensions}{" "}
						field
						{done.dimensions === 1 ? "" : "s"} and {done.measures}{" "}
						figure
						{done.measures === 1 ? "" : "s"}.
					</p>
					{done.warning && (
						<div className={form.failure}>{done.warning}</div>
					)}
					<div className={form.actions}>
						<button
							type="button"
							className={form.primary}
							onClick={onClose}
						>
							Done
						</button>
					</div>
				</div>
			</Modal>
		);
	}

	return (
		<Modal isOpen onClose={onClose} title="Add a source" width="620px">
			<div className={form.form}>
				<div className={form.row}>
					<label className={form.field}>
						<span className={form.label}>Catalog</span>
						<Select
							value={catalog}
							onChange={(v) => {
								setCatalog(v);
								setSchema("");
								setObject(null);
							}}
							placeholder={
								catalogs.isLoading ? "Loading" : "Choose one"
							}
							searchable={
								(catalogs.data?.catalogs ?? []).length > 12
							}
							options={(catalogs.data?.catalogs ?? []).map(
								(c) => ({
									value: c,
									label: c,
								}),
							)}
						/>
					</label>

					<label className={form.field}>
						<span className={form.label}>Schema</span>
						<Select
							value={schema}
							onChange={(v) => {
								setSchema(v);
								setObject(null);
							}}
							disabled={!catalog}
							placeholder={
								schemas.isLoading ? "Loading" : "Choose one"
							}
							searchable={
								(schemas.data?.schemas ?? []).length > 12
							}
							options={(schemas.data?.schemas ?? []).map((s) => ({
								value: s,
								label: s,
							}))}
						/>
					</label>
				</div>

				<label className={form.field}>
					<span className={form.label}>Table or view</span>
					<Select
						value={object?.name ?? ""}
						onChange={(v) =>
							setObject(
								(objects.data?.objects ?? []).find(
									(o) => o.name === v,
								) ?? null,
							)
						}
						disabled={!schema}
						placeholder={
							objects.isLoading ? "Loading" : "Choose one"
						}
						searchable={(objects.data?.objects ?? []).length > 12}
						options={(objects.data?.objects ?? []).map((o) => ({
							value: o.name,
							label: o.name,
							note: o.registered
								? "already added"
								: o.kind === "metric_view"
									? "metric view"
									: undefined,
						}))}
					/>
				</label>

				{object && (
					<>
						<label className={form.field}>
							<span className={form.label}>Name</span>
							<input
								className={form.input}
								value={title}
								onChange={(e) => setTitle(e.target.value)}
							/>
						</label>

						<div className={form.field}>
							<button
								type="button"
								className={`${styles.capability} ${
									hasRowFilter ? styles.capabilityOn : ""
								}`}
								onClick={() => setHasRowFilter(!hasRowFilter)}
								aria-pressed={hasRowFilter}
							>
								<span
									className={`${styles.check} ${
										hasRowFilter ? styles.checkOn : ""
									}`}
									aria-hidden="true"
								>
									{hasRowFilter ? "✓" : ""}
								</span>
								<span className={styles.capabilityName}>
									Rows are filtered per reader
								</span>
							</button>
							<span className={form.hint}>
								Set this where the table has a row filter or
								column mask, so an answer is never shared
								between people who see different rows.
							</span>
						</div>
					</>
				)}

				{browseError && (
					<div className={form.failure}>{browseError}</div>
				)}
				{failure && <div className={form.failure}>{failure}</div>}

				<div className={form.actions}>
					<button
						type="button"
						className={form.secondary}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={form.primary}
						disabled={busy || !object || !title.trim()}
						onClick={register}
					>
						{busy ? "Adding" : "Add"}
					</button>
				</div>
			</div>
		</Modal>
	);
}
