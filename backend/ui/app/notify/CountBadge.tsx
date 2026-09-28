import styles from "./Notify.module.css";

// The unread count on the inbox tab of a phone's tab bar.
export function CountBadge({ count }: { count: number }) {
	if (count <= 0) return null;
	return (
		<span className={styles.countBadge} aria-hidden="true">
			{count > 99 ? "99+" : count}
		</span>
	);
}
