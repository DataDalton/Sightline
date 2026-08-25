"use client";

import { memo } from "react";
import styles from "./Toggle.module.css";

interface ToggleProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label?: string;
	disabled?: boolean;
}

export const Toggle = memo(function Toggle({
	checked,
	onChange,
	label,
	disabled = false,
}: ToggleProps) {
	return (
		<label
			className={`${styles.toggle} ${disabled ? styles.disabled : ""}`}
		>
			<button
				type="button"
				role="switch"
				aria-checked={checked}
				className={`${styles.track} ${checked ? styles.trackOn : ""}`}
				onClick={() => !disabled && onChange(!checked)}
				disabled={disabled}
			>
				<span
					className={`${styles.thumb} ${checked ? styles.thumbOn : ""}`}
				/>
			</button>
			{label && <span className={styles.label}>{label}</span>}
		</label>
	);
});
