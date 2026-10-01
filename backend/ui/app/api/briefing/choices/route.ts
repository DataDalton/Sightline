import { NextRequest, NextResponse } from "next/server";
import { orderPins, setChoice, type Choice } from "@/lib/briefing/choices";
import { isUuid } from "@/lib/alerts/store";
import { caller, privateJson, readJson } from "../../notifications/guard";

// Pins a figure to the caller's briefing, hides it, or clears either. A
// choice only shapes the caller's own briefing, which still offers only what
// they can open, so naming a report here grants nothing.

// { reportId, measure, choice: "pin" | "hide" | null }
export async function PUT(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = (await readJson(request)) as Record<string, unknown> | null;
	const reportId = typeof body?.reportId === "string" ? body.reportId : "";
	const measure =
		typeof body?.measure === "string"
			? body.measure.trim().slice(0, 300)
			: "";
	const raw = body?.choice;
	const choice: Choice | null | undefined =
		raw === "pin" || raw === "hide" ? raw : raw === null ? null : undefined;
	if (!isUuid(reportId) || !measure || choice === undefined) {
		return privateJson(
			{ error: "Expected a report, a measure and a choice." },
			400,
		);
	}
	try {
		await setChoice(identity.email, reportId, measure, choice);
		return privateJson({ ok: true });
	} catch (error) {
		console.error("A briefing choice could not be saved:", error);
		return privateJson({ error: "That could not be saved." }, 500);
	}
}

// { order: [{ reportId, measure }] }, the caller's pins in the order they
// want them shown.
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = (await readJson(request)) as Record<string, unknown> | null;
	const raw = Array.isArray(body?.order) ? body.order : null;
	const order = (raw ?? [])
		.map((entry) => entry as Record<string, unknown>)
		.filter(
			(entry) =>
				typeof entry?.reportId === "string" &&
				isUuid(entry.reportId) &&
				typeof entry.measure === "string" &&
				entry.measure.trim() !== "",
		)
		.map((entry) => ({
			reportId: String(entry.reportId),
			measure: String(entry.measure).trim().slice(0, 300),
		}));
	if (!raw || order.length !== raw.length) {
		return privateJson(
			{ error: "Expected a list of pinned figures." },
			400,
		);
	}
	try {
		await orderPins(identity.email, order);
		return privateJson({ ok: true });
	} catch (error) {
		console.error("The briefing order could not be saved:", error);
		return privateJson({ error: "That could not be saved." }, 500);
	}
}
