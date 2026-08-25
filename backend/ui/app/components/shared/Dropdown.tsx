"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import styles from "./Dropdown.module.css";

interface DropdownOption {
	value: string;
	label: string;
}

interface DropdownProps {
	options: DropdownOption[];
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	searchable?: boolean;
	disabled?: boolean;
}

export function Dropdown({
	options,
	value,
	onChange,
	placeholder = "Select...",
	searchable = false,
	disabled = false,
}: DropdownProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [highlightedIndex, setHighlightedIndex] = useState(-1);
	const containerRef = useRef<HTMLDivElement>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);

	const selectedOption = options.find((opt) => opt.value === value);

	const filteredOptions =
		searchable && search
			? options.filter((opt) =>
					opt.label.toLowerCase().includes(search.toLowerCase()),
				)
			: options;

	// Close dropdown when clicking outside
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			) {
				setIsOpen(false);
				setSearch("");
				setHighlightedIndex(-1);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () =>
			document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	// Focus search input when dropdown opens
	useEffect(() => {
		if (isOpen && searchable && searchInputRef.current) {
			searchInputRef.current.focus();
		}
	}, [isOpen, searchable]);

	// Reset highlight when filtered options change
	useEffect(() => {
		setHighlightedIndex(-1);
	}, [search]);

	const handleSelect = useCallback(
		(optionValue: string) => {
			onChange(optionValue);
			setIsOpen(false);
			setSearch("");
			setHighlightedIndex(-1);
		},
		[onChange],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (!isOpen) {
				if (
					e.key === "Enter" ||
					e.key === " " ||
					e.key === "ArrowDown"
				) {
					e.preventDefault();
					setIsOpen(true);
				}
				return;
			}

			switch (e.key) {
				case "ArrowDown":
					e.preventDefault();
					setHighlightedIndex((prev) =>
						prev < filteredOptions.length - 1 ? prev + 1 : 0,
					);
					break;
				case "ArrowUp":
					e.preventDefault();
					setHighlightedIndex((prev) =>
						prev > 0 ? prev - 1 : filteredOptions.length - 1,
					);
					break;
				case "Enter":
					e.preventDefault();
					if (
						highlightedIndex >= 0 &&
						highlightedIndex < filteredOptions.length
					) {
						handleSelect(filteredOptions[highlightedIndex].value);
					}
					break;
				case "Escape":
					e.preventDefault();
					setIsOpen(false);
					setSearch("");
					setHighlightedIndex(-1);
					break;
			}
		},
		[isOpen, filteredOptions, highlightedIndex, handleSelect],
	);

	const toggleOpen = () => {
		if (disabled) return;
		setIsOpen((prev) => !prev);
		if (isOpen) {
			setSearch("");
			setHighlightedIndex(-1);
		}
	};

	return (
		<div
			ref={containerRef}
			className={`${styles.dropdown} ${disabled ? styles.disabled : ""}`}
			onKeyDown={handleKeyDown}
			tabIndex={disabled ? -1 : 0}
		>
			<button
				type="button"
				className={`${styles.trigger} ${isOpen ? styles.open : ""}`}
				onClick={toggleOpen}
				disabled={disabled}
			>
				<span
					className={
						selectedOption
							? styles.selectedLabel
							: styles.placeholder
					}
				>
					{selectedOption ? selectedOption.label : placeholder}
				</span>
				<svg
					className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`}
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</button>

			{isOpen && (
				<div className={styles.panel}>
					{searchable && (
						<div className={styles.searchContainer}>
							<input
								ref={searchInputRef}
								type="text"
								className={styles.searchInput}
								placeholder="Search..."
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								onClick={(e) => e.stopPropagation()}
							/>
						</div>
					)}
					<div className={styles.optionsList}>
						{filteredOptions.length === 0 ? (
							<div className={styles.noResults}>
								No results found
							</div>
						) : (
							filteredOptions.map((opt, index) => (
								<button
									key={opt.value}
									type="button"
									className={`${styles.option} ${
										opt.value === value
											? styles.selected
											: ""
									} ${index === highlightedIndex ? styles.highlighted : ""}`}
									onClick={() => handleSelect(opt.value)}
									onMouseEnter={() =>
										setHighlightedIndex(index)
									}
								>
									{opt.label}
								</button>
							))
						)}
					</div>
				</div>
			)}
		</div>
	);
}
