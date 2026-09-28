import { ImageResponse } from "next/og";

// The icons a phone or a desktop shows for the installed app.
//
// Drawn here rather than kept as image files, so each size is rendered from
// the same mark the header draws and there is nothing binary to keep in step
// with it. The colours are the chrome and the brand accent, which are the
// same in both themes.
//
// "maskable" leaves the margin Android crops into a circle or a squircle, and
// "apple" is drawn edge to edge because iOS rounds the corners itself.

const chrome = "#16181d";
const brand = "#ffb500";

interface Variant {
	size: number;
	// Share of the icon the mark fills.
	scale: number;
	// Rounded corners, for the plain icon a desktop shows as it is.
	rounded: boolean;
}

const variants: Record<string, Variant> = {
	"icon-32.png": { size: 32, scale: 0.8, rounded: true },
	"icon-192.png": { size: 192, scale: 0.66, rounded: true },
	"icon-512.png": { size: 512, scale: 0.66, rounded: true },
	"maskable-512.png": { size: 512, scale: 0.5, rounded: false },
	"apple-touch-icon.png": { size: 180, scale: 0.62, rounded: false },
	"badge-96.png": { size: 96, scale: 0.9, rounded: false },
};

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ file: string }> },
) {
	const { file } = await params;
	const variant = variants[file];
	if (!variant) return new Response("Not found", { status: 404 });

	const { size, scale, rounded } = variant;
	const mark = Math.round(size * scale);
	// The badge Android shows in the status bar is a silhouette: only its
	// alpha is used, so it is the mark alone on nothing.
	const badge = file.startsWith("badge");

	const response = new ImageResponse(
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: badge ? "transparent" : chrome,
				borderRadius: rounded ? size * 0.22 : 0,
			}}
		>
			<svg
				width={mark}
				height={mark}
				viewBox="0 0 32 32"
				fill="none"
				stroke={badge ? "#ffffff" : brand}
				strokeWidth={size <= 32 ? 3.2 : 2.6}
				strokeLinecap="round"
			>
				<path d="M6 22V13" />
				<path d="M16 22V6" />
				<path d="M26 22v-6" />
				<path d="M4 27h24" />
			</svg>
		</div>,
		{ width: size, height: size },
	);
	// The mark changes with a release, not between requests.
	response.headers.set("Cache-Control", "public, max-age=86400");
	return response;
}
