"use client";

import styles from "./TextInput.module.css";

interface TextInputProps {
	value: string;
	onChange: (value: string) => void;
	label?: string;
	placeholder?: string;
	required?: boolean;
	disabled?: boolean;
	error?: string;
	maxLength?: number;
}

export function TextInput({
	value,
	onChange,
	label,
	placeholder = "",
	required = false,
	disabled = false,
	error,
	maxLength,
}: TextInputProps) {
	return (
		<div className={styles.field}>
			{label && (
				<label className={styles.label}>
					{label}
					{required && <span className={styles.required}>*</span>}
				</label>
			)}
			<input
				type="text"
				className={`${styles.input} ${error ? styles.inputError : ""}`}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				disabled={disabled}
				maxLength={maxLength}
			/>
			{error && <span className={styles.error}>{error}</span>}
		</div>
	);
}
