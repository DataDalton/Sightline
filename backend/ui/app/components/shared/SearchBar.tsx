"use client";

import { useState, useEffect, useRef, useCallback, memo } from "react";
import styles from "./SearchBar.module.css";

interface SearchBarProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	debounceMs?: number;
	loading?: boolean;
}

export const SearchBar = memo(function SearchBar({
	value,
	onChange,
	placeholder = "Search...",
	debounceMs = 300,
	loading = false,
}: SearchBarProps) {
	const [localValue, setLocalValue] = useState(value);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Sync external value changes
	useEffect(() => {
		setLocalValue(value);
	}, [value]);

	const handleChange = useCallback(
		(newValue: string) => {
			setLocalValue(newValue);
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
			timerRef.current = setTimeout(() => {
				onChange(newValue);
			}, debounceMs);
		},
		[onChange, debounceMs],
	);

	// Cleanup timer on unmount
	useEffect(() => {
		return () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
		};
	}, []);

	const handleClear = useCallback(() => {
		setLocalValue("");
		if (timerRef.current) {
			clearTimeout(timerRef.current);
		}
		onChange("");
	}, [onChange]);

	return (
		<div className={styles.searchBar}>
			<svg
				className={styles.searchIcon}
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
			>
				<circle cx="11" cy="11" r="8" />
				<line x1="21" y1="21" x2="16.65" y2="16.65" />
			</svg>
			<input
				type="text"
				className={styles.input}
				value={localValue}
				onChange={(e) => handleChange(e.target.value)}
				placeholder={placeholder}
			/>
			{loading && <div className={styles.spinner} />}
			{localValue && !loading && (
				<button
					type="button"
					className={styles.clearButton}
					onClick={handleClear}
					title="Clear search"
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
					>
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			)}
		</div>
	);
});
