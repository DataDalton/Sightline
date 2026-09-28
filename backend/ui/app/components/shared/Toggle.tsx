"use client";

import { memo } from "react";
import styles from "./Toggle.module.css";

interface ToggleProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label?: string;
	// Names the switch without printing text beside it, for a row that
	// already says what it is.
	ariaLabel?: string;
	disabled?: boolean;
}

export const Toggle = memo(function Toggle({
	checked,
	onChange,
	label,
	ariaLabel,
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
				aria-label={ariaLabel}
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
