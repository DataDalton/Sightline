"use client";

import { useRef } from "react";
import { attachmentTypes } from "../../lib/work/attachmentRules";
import styles from "./Work.module.css";

// Sending a file to a request, and the button that picks one.
//
// Shared by the request page, where a file goes up the moment it is added, and
// the form that files a request, which holds files until the request exists.

// Uploads one file to a request and answers with the reference that shows it
// in a description or comment. Throws with the reason when it is refused.
// Pasted is true for a file going into a comment or the description, and false
// for one attached to the request on purpose.
export async function uploadAttachment(
	itemKey: string,
	file: File,
	pasted: boolean,
): Promise<string> {
	// The size in pixels, read from the file without changing it, so the page
	// can keep room for the image while it loads.
	let width: number | null = null;
	let height: number | null = null;
	if (file.type.startsWith("image/")) {
		const bitmap = await createImageBitmap(file).catch(() => null);
		width = bitmap?.width ?? null;
		height = bitmap?.height ?? null;
		bitmap?.close();
	}
	const response = await fetch(
		`/api/work/${encodeURIComponent(itemKey)}/attachments`,
		{
			method: "POST",
			headers: {
				"Content-Type": file.type || "application/octet-stream",
				"X-File-Name": encodeURIComponent(file.name || "pasted"),
				...(pasted ? { "X-Pasted": "1" } : {}),
				...(width ? { "X-Width": String(width) } : {}),
				...(height ? { "X-Height": String(height) } : {}),
			},
			body: file,
		},
	);
	const answer = (await response.json().catch(() => ({}))) as {
		attachment?: { hash: string; fileName: string };
		error?: string;
	};
	if (!response.ok || !answer.attachment)
		throw new Error(answer.error ?? "It could not be attached.");
	return `![${answer.attachment.fileName}](/api/work/files/${answer.attachment.hash})`;
}

// The files a paste or a drop carried, if any.
export function filesFrom(data: DataTransfer | null): File[] {
	return data ? [...data.files] : [];
}

// Opens the file chooser, limited to what a request takes.
export function AttachButton({
	onFiles,
	disabled,
}: {
	onFiles: (files: File[]) => void;
	disabled?: boolean;
}) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<input
				ref={input}
				type="file"
				multiple
				hidden
				accept={attachmentTypes.join(",")}
				onChange={(e) => {
					const files = [...(e.target.files ?? [])];
					// Cleared, so choosing the same file again still fires.
					e.target.value = "";
					if (files.length > 0) onFiles(files);
				}}
			/>
			<button
				type="button"
				className={styles.attachButton}
				disabled={disabled}
				onClick={() => input.current?.click()}
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
				</svg>
				Attach
			</button>
		</>
	);
}
