"use client";

import type { ColorSpec, PaletteToken } from "../../lib/visuals/style";

// Resolves stored colour specs against the active theme.
//
// A visual stores a token name, not a hex value, so the same definition reads
// correctly in light and dark. Resolution happens at render time by reading the
// computed custom properties off the document, which means a chart and the
// chrome around it can never disagree about what "chart-1" is.

const tokenVariable: Record<PaletteToken, string> = {
	"chart-1": "--chart-1",
	"chart-2": "--chart-2",
	"chart-3": "--chart-3",
	"chart-4": "--chart-4",
	"chart-5": "--chart-5",
	"chart-6": "--chart-6",
	"chart-7": "--chart-7",
	"chart-8": "--chart-8",
	brand: "--brand",
	success: "--success",
	warning: "--warning",
	danger: "--danger",
	info: "--info",
};

const fallbacks: Record<PaletteToken, string> = {
	"chart-1": "#2563eb",
	"chart-2": "#0d9488",
	"chart-3": "#d97706",
	"chart-4": "#7c3aed",
	"chart-5": "#db2777",
	"chart-6": "#0891b2",
	"chart-7": "#65a30d",
	"chart-8": "#dc2626",
	brand: "#ffb500",
	success: "#1a7f45",
	warning: "#a76500",
	danger: "#c22b2b",
	info: "#0b5cd5",
};

export interface ThemeColors {
	series: string[];
	grid: string;
	axis: string;
	text: string;
	textMuted: string;
	surface: string;
	tooltipBg: string;
	tooltipText: string;
	positive: string;
	negative: string;
	resolve: (spec: ColorSpec | undefined, fallback: string) => string;
}

function readVariable(name: string, fallback: string): string {
	if (typeof window === "undefined") return fallback;
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim();
	return value || fallback;
}

export function readThemeColors(): ThemeColors {
	const token = (t: PaletteToken) =>
		readVariable(tokenVariable[t], fallbacks[t]);

	const resolve = (spec: ColorSpec | undefined, fallback: string): string => {
		if (!spec) return fallback;
		if ("hex" in spec) return spec.hex;
		return token(spec.token);
	};

	return {
		series: [
			token("chart-1"),
			token("chart-2"),
			token("chart-3"),
			token("chart-4"),
			token("chart-5"),
			token("chart-6"),
			token("chart-7"),
			token("chart-8"),
		],
		grid: readVariable("--chart-grid", "#e5e8ec"),
		axis: readVariable("--chart-axis", "#767d87"),
		text: readVariable("--text-secondary", "#4a5059"),
		textMuted: readVariable("--text-muted", "#767d87"),
		surface: readVariable("--surface-raised", "#ffffff"),
		tooltipBg: readVariable("--chart-tooltip-bg", "#16181d"),
		tooltipText: readVariable("--chart-tooltip-text", "#ffffff"),
		positive: readVariable("--delta-positive", "#1a7f45"),
		negative: readVariable("--delta-negative", "#c22b2b"),
		resolve,
	};
}

// Applies an alpha channel to a colour, whatever notation it arrives in.
//
// Theme tokens can resolve to hex, rgb() or oklch() depending on how they were
// authored, so this handles hex directly and falls back to color-mix for
// anything else rather than guessing at parsing.
export function withAlpha(color: string, alpha: number): string {
	const clamped = Math.max(0, Math.min(1, alpha));

	const hex = color.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `rgba(${r}, ${g}, ${b}, ${clamped})`;
	}
	if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
		const r = parseInt(hex[1] + hex[1], 16);
		const g = parseInt(hex[2] + hex[2], 16);
		const b = parseInt(hex[3] + hex[3], 16);
		return `rgba(${r}, ${g}, ${b}, ${clamped})`;
	}

	return `color-mix(in srgb, ${color} ${Math.round(clamped * 100)}%, transparent)`;
}

// Blends two colours, used to place a value on a continuous scale.
export function mix(from: string, to: string, ratio: number): string {
	const clamped = Math.max(0, Math.min(1, ratio));
	const parse = (c: string): [number, number, number] | null => {
		const hex = c.trim();
		if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
			return [
				parseInt(hex.slice(1, 3), 16),
				parseInt(hex.slice(3, 5), 16),
				parseInt(hex.slice(5, 7), 16),
			];
		}
		return null;
	};

	const a = parse(from);
	const b = parse(to);
	if (!a || !b) {
		// Non-hex inputs go to the browser, which understands every notation
		// the theme might use.
		return `color-mix(in srgb, ${to} ${Math.round(clamped * 100)}%, ${from})`;
	}

	const channel = (i: number) => Math.round(a[i] + (b[i] - a[i]) * clamped);
	return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}
