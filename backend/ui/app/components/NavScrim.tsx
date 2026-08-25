"use client";

import { useShell } from "../context/ShellContext";
import styles from "../layout.module.css";

// Dims the page behind the navigation drawer and closes it on a tap outside.
// Rendered as a button so the dismiss target is reachable by keyboard as well
// as by pointer.
export default function NavScrim() {
	const { navOpen, closeNav } = useShell();
	if (!navOpen) return null;

	return (
		<button
			type="button"
			className={styles.scrim}
			onClick={closeNav}
			aria-label="Close navigation"
		/>
	);
}
