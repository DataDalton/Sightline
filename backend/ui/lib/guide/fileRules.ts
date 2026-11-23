// What a report guide can have attached. Shared by the upload form, which
// refuses a file before sending it, and the server, which refuses it again.

export const maxGuideFileBytes = 25 * 1024 * 1024;

// The types a guide keeps, each by the name a browser gives it.
export const guideFileTypes = new Set<string>([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/pdf",
	"text/plain",
	"text/markdown",
	"text/csv",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.ms-excel",
]);

// Browsers often send no type, or a generic one, for Markdown and Office
// files, so the extension decides for those.
const byExtension: Record<string, string> = {
	md: "text/markdown",
	markdown: "text/markdown",
	txt: "text/plain",
	csv: "text/csv",
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	xls: "application/vnd.ms-excel",
};

export function guideFileType(name: string, given: string): string {
	const type = given.split(";")[0].trim().toLowerCase();
	if (guideFileTypes.has(type) && type !== "text/plain") return type;
	const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
	return byExtension[extension] ?? type;
}

export const guideFileTooLarge = "Files up to 25 MB can be attached.";
export const guideFileWrongType =
	"Images, PDFs, text, Markdown, CSV and Office files can be attached.";

export function guideFileProblem(file: {
	size: number;
	type: string;
	name: string;
}): string | null {
	if (file.size === 0) return "The file is empty.";
	if (file.size > maxGuideFileBytes) return guideFileTooLarge;
	if (!guideFileTypes.has(guideFileType(file.name, file.type)))
		return guideFileWrongType;
	return null;
}
