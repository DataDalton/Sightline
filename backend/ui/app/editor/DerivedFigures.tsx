"use client";

import {
	transformLabels,
	type QueryTransform,
} from "../../lib/query/transform";
import { Select } from "../components/shared/Select";
import { CloseIcon, Hint, Section } from "./PanelSection";
import styles from "./Editor.module.css";

// Authoring the figures a visual works out for itself.
//
// Every field in a query resolves to something the semantic registry defines,
// which is what keeps the query layer safe and is also why share of total,
// running total, rank and a ratio between two measures all used to need a data
// engineer before anybody could see them. They are arithmetic over numbers the
// warehouse has already returned, so they are worked out after the answer
// arrives rather than asked for in SQL.
//
// Order matters and is the author's: each one can read a column the one above
// it produced, which is how a cumulative percentage is two steps rather than a
// special case.

const kindOptions = (
	Object.keys(transformLabels) as QueryTransform["kind"][]
).map((kind) => ({ value: kind, label: transformLabels[kind] }));

interface DerivedFiguresProps {
	transforms: QueryTransform[];
	// What the query already returns, in the order it returns it. A derived
	// figure can read any of these, and any figure declared above it.
	available: string[];
	onChange: (next: QueryTransform[]) => void;
}

// A name that does not collide with a field the source defines, so a visual
// asking for that field never quietly gets the derived column instead.
function suggestName(
	kind: QueryTransform["kind"],
	measure: string,
	taken: Set<string>,
): string {
	const base =
		kind === "percentOfTotal"
			? `${measure} share`
			: kind === "runningTotal"
				? `${measure} cumulative`
				: kind === "rank"
					? `${measure} rank`
					: kind === "indexTo"
						? `${measure} index`
						: `${measure} per unit`;

	if (!taken.has(base)) return base;
	// Numbered rather than refused, since an author adding a second share of
	// the same measure usually means it.
	for (let n = 2; n < 50; n++) {
		if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
	}
	return `${base} ${Date.now()}`;
}

export function DerivedFigures({
	transforms,
	available,
	onChange,
}: DerivedFiguresProps) {
	const update = (index: number, patch: Partial<QueryTransform>) =>
		onChange(
			transforms.map((t, i) =>
				i === index ? ({ ...t, ...patch } as QueryTransform) : t,
			),
		);

	const remove = (index: number) =>
		onChange(transforms.filter((_, i) => i !== index));

	const move = (index: number, delta: -1 | 1) => {
		const to = index + delta;
		if (to < 0 || to >= transforms.length) return;
		const next = [...transforms];
		const [moved] = next.splice(index, 1);
		next.splice(to, 0, moved);
		onChange(next);
	};

	// What each entry may read: the query's own fields, plus everything
	// declared above it. Below it is not offered, because the chain runs in
	// order and a figure cannot read one that has not been worked out yet.
	const readableAt = (index: number): string[] => [
		...available,
		...transforms.slice(0, index).map((t) => t.as),
	];

	const add = () => {
		const measure = available[0];
		if (!measure) return;
		const taken = new Set([...available, ...transforms.map((t) => t.as)]);
		onChange([
			...transforms,
			{
				kind: "percentOfTotal",
				measure,
				as: suggestName("percentOfTotal", measure, taken),
			},
		]);
	};

	return (
		<Section
			id="visual-derived"
			title="Derived figures"
			defaultOpen={false}
			count={transforms.length}
		>
			<Hint>
				Worked out from the answer rather than asked of the warehouse,
				so no modelling is needed upstream. Each one becomes a column
				the visual can encode, sort and export like any other.
			</Hint>

			{available.length === 0 && (
				<Hint>
					Choose the fields this visual reads first. A derived figure
					has to be worked out from something.
				</Hint>
			)}

			{transforms.map((transform, index) => {
				const readable = readableAt(index);
				return (
					<div
						key={`${transform.as}-${index}`}
						className={styles.ruleCard}
					>
						<div className={styles.ruleHeader}>
							<span className={styles.ruleNumber}>
								{index + 1}
							</span>
							<span className={styles.spacer} />
							{/* Order is what makes a chain work, so it has to
							    be changeable without deleting and rebuilding. */}
							<button
								type="button"
								className={styles.iconButton}
								onClick={() => move(index, -1)}
								disabled={index === 0}
								title="Move up"
								aria-label="Move up"
							>
								↑
							</button>
							<button
								type="button"
								className={styles.iconButton}
								onClick={() => move(index, 1)}
								disabled={index === transforms.length - 1}
								title="Move down"
								aria-label="Move down"
							>
								↓
							</button>
							<button
								type="button"
								className={styles.iconButton}
								onClick={() => remove(index)}
								title="Remove this figure"
								aria-label="Remove this figure"
							>
								<CloseIcon />
							</button>
						</div>

						<div className={styles.field}>
							<label className={styles.fieldLabel}>
								Work out
							</label>
							<Select
								value={transform.kind}
								onChange={(next) =>
									update(index, {
										kind: next as QueryTransform["kind"],
									})
								}
								options={kindOptions}
							/>
						</div>

						<div className={styles.field}>
							<label className={styles.fieldLabel}>Of</label>
							<Select
								value={transform.measure}
								onChange={(next) =>
									update(index, { measure: next })
								}
								options={readable.map((f) => ({
									value: f,
									label: f,
								}))}
							/>
						</div>

						{transform.kind === "ratio" && (
							<div className={styles.field}>
								<label className={styles.fieldLabel}>
									Divided by
								</label>
								<Select
									value={transform.denominator ?? readable[0]}
									onChange={(next) =>
										update(index, {
											denominator: next,
										} as Partial<QueryTransform>)
									}
									options={readable.map((f) => ({
										value: f,
										label: f,
									}))}
								/>
								<Hint>
									A row where the divisor is zero or missing
									is left empty rather than shown as a number.
								</Hint>
							</div>
						)}

						{transform.kind === "rank" && (
							<div className={styles.field}>
								<label className={styles.fieldLabel}>
									Counting from
								</label>
								<Select
									value={transform.direction ?? "desc"}
									onChange={(next) =>
										update(index, {
											direction: next as "asc" | "desc",
										} as Partial<QueryTransform>)
									}
									options={[
										{
											value: "desc",
											label: "The largest",
										},
										{
											value: "asc",
											label: "The smallest",
										},
									]}
								/>
							</div>
						)}

						<div className={styles.field}>
							<label className={styles.fieldLabel}>
								Column name
							</label>
							<input
								className={styles.input}
								value={transform.as}
								onChange={(e) =>
									update(index, { as: e.target.value })
								}
							/>
							<Hint>
								Cannot be the name of a field the source
								defines, or a visual asking for that field would
								get this instead.
							</Hint>
						</div>
					</div>
				);
			})}

			<button
				type="button"
				className={styles.addButton}
				onClick={add}
				disabled={available.length === 0}
			>
				Add a derived figure
			</button>
		</Section>
	);
}
