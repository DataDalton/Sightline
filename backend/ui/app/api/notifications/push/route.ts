import { NextRequest, NextResponse } from "next/server";
import {
	listDevices,
	pushPreferences,
	pushPublicKey,
	PushSubscriptionError,
	removeSubscription,
	savePushPreferences,
	saveSubscription,
} from "@/lib/notify/push";
import { caller, privateJson, readJson } from "../guard";

// The caller's devices and what they want pushed to them.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;

	const [publicKey, devices, preferences] = await Promise.all([
		pushPublicKey(),
		listDevices(identity.email),
		pushPreferences(identity.email),
	]);
	return privateJson({ publicKey, devices, preferences });
}

// { subscription, device }: this browser now receives pushes.
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;

	if (!(await pushPublicKey())) {
		return privateJson(
			{ error: "Push notifications are turned off for this app." },
			409,
		);
	}
	const body = (await readJson(request)) as {
		subscription?: unknown;
		device?: unknown;
	} | null;
	try {
		await saveSubscription(
			identity.email,
			body?.subscription,
			typeof body?.device === "string" ? body.device : "",
		);
	} catch (error) {
		if (error instanceof PushSubscriptionError) {
			return privateJson({ error: error.message }, 400);
		}
		throw error;
	}
	return privateJson({ devices: await listDevices(identity.email) });
}

// { endpoint }: stop pushing to one device.
export async function DELETE(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;

	const body = (await readJson(request)) as { endpoint?: unknown } | null;
	if (typeof body?.endpoint === "string") {
		await removeSubscription(identity.email, body.endpoint);
	}
	return privateJson({ devices: await listDevices(identity.email) });
}

// { preferences: { alert: boolean, share: boolean, system: boolean } }
export async function PUT(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;

	const body = (await readJson(request)) as { preferences?: unknown } | null;
	return privateJson({
		preferences: await savePushPreferences(
			identity.email,
			body?.preferences,
		),
	});
}
