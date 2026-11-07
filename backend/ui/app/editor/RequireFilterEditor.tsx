"use client";

import { MultiSelect } from "../components/shared/MultiSelect";
import { Hint } from "./PanelSection";
import styles from "./Editor.module.css";

// A short list of fields, chosen from one dropdown. Used for what a visual or page waits for
// (see lib/visuals/filterGate) and for the extra figures in a chart's tooltip.

export function RequireFilterEditor({
	value,
	fields,
	hint,
	placeholder = "Wait for a filter on",
	onChange,
}: {
	value: unknown;
	// Every dimension on the source, which is what a filter can be set on.
	fields: string[];
	hint: string;
	placeholder?: string;
	onChange: (next: string[] | undefined) => void;
}) {
	const chosen = Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];

	return (
		<div className={styles.field}>
			<label className={styles.fieldLabel}>{placeholder}</label>
			<MultiSelect
				options={fields}
				value={chosen}
				placeholder="Choose fields"
				ariaLabel={placeholder}
				searchable={fields.length > 12}
				onChange={(next) =>
					onChange(next.length > 0 ? next : undefined)
				}
			/>
			<Hint>{hint}</Hint>
		</div>
	);
}
