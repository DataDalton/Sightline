import { NextRequest, NextResponse } from "next/server";
import { deletePageAlert, updatePageAlert } from "@/lib/alerts/pageStore";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { privateJson } from "../../notifications/guard";
import { badBody, failed, pageAlertCaller, readBody } from "../respond";

// One page alert, changed or deleted by somebody who may edit its report.

type Context = { params: Promise<{ id: string }> };

// { definition }
export async function PUT(request: NextRequest, { params }: Context) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;
	const who = await pageAlertCaller(request);
	if (who instanceof NextResponse) return who;
	const { id } = await params;
	const body = await readBody(request);
	if (!body) return badBody();
	try {
		const alert = await updatePageAlert(
			who.identity,
			who.policy,
			id,
			body.definition,
		);
		return privateJson({ alert });
	} catch (error) {
		return failed(error, "save the alert");
	}
}

export async function DELETE(request: NextRequest, { params }: Context) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;
	const who = await pageAlertCaller(request);
	if (who instanceof NextResponse) return who;
	const { id } = await params;
	try {
		await deletePageAlert(who.identity, who.policy, id);
		return privateJson({ deleted: true });
	} catch (error) {
		return failed(error, "delete the alert");
	}
}
