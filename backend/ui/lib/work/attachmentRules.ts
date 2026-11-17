// What a request will take as an attachment. Read by the server, which enforces
// it, and by the browser, which refuses a file before sending it rather than
// after the bytes have crossed the network.

// A ceiling on one file, so a single paste cannot swell the database. It is a
// bound on size, not on how many files anyone attaches.
export const maxAttachmentBytes = 10 * 1024 * 1024;

export const attachmentTypes = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/pdf",
	"text/plain",
	"text/csv",
] as const;

const allowed = new Set<string>(attachmentTypes);

export const tooLargeMessage = "Files up to 10 MB can be attached.";
export const wrongTypeMessage = "Images, PDFs and text files can be attached.";

// Why a file cannot be attached, or null when it can.
export function attachmentProblem(file: {
	size: number;
	type: string;
}): string | null {
	if (file.size === 0) return "The file is empty.";
	if (file.size > maxAttachmentBytes) return tooLargeMessage;
	const type = file.type.split(";")[0].trim().toLowerCase();
	if (!allowed.has(type)) return wrongTypeMessage;
	return null;
}
