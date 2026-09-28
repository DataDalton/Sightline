import { NextRequest, NextResponse } from "next/server";
import { AlertDefinitionError } from "@/lib/alerts/rule";
import {
	alertEvents,
	deleteAlert,
	getAlert,
	isUuid,
	setAlertEnabled,
	updateAlert,
} from "@/lib/alerts/store";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { caller, privateJson, readJson } from "../../notifications/guard";

// One of the caller's alerts. Every statement is scoped to the owner, so an id
// belonging to somebody else reads as not found.

type Context = { params: Promise<{ id: string }> };

const notFound = () => privateJson({ error: "Alert not found" }, 404);

export async function GET(request: NextRequest, { params }: Context) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	if (!isUuid(id)) return notFound();

	const alert = await getAlert(identity.email, id);
	if (!alert) return notFound();
	return privateJson({
		alert,
		events: await alertEvents(identity.email, id),
	});
}

export async function PUT(request: NextRequest, { params }: Context) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	if (!isUuid(id)) return notFound();

	try {
		const alert = await updateAlert(identity, id, await readJson(request));
		return alert ? privateJson({ alert }) : notFound();
	} catch (error) {
		if (error instanceof AlertDefinitionError) {
			return privateJson({ error: error.message }, 400);
		}
		console.error("Alert update failed:", error);
		return privateJson({ error: "Could not save the alert" }, 500);
	}
}

// { enabled: boolean }
export async function PATCH(request: NextRequest, { params }: Context) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	if (!isUuid(id)) return notFound();

	const body = (await readJson(request)) as { enabled?: unknown } | null;
	if (typeof body?.enabled !== "boolean") {
		return privateJson({ error: "Say whether it is on or off" }, 400);
	}
	const alert = await setAlertEnabled(identity.email, id, body.enabled);
	return alert ? privateJson({ alert }) : notFound();
}

export async function DELETE(request: NextRequest, { params }: Context) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	if (!isUuid(id)) return notFound();

	return (await deleteAlert(identity.email, id))
		? privateJson({ deleted: true })
		: notFound();
}
