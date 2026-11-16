import { NextRequest, NextResponse } from "next/server";
import {
	readChoice,
	readUserTheme,
	saveUserTheme,
	UserThemeError,
} from "@/lib/platform/userTheme";
import { caller, privateJson, readJson } from "../../notifications/guard";

// The caller's own colours for the app.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	return privateJson(await readUserTheme(identity.email));
}

// { themeId } for a workspace or built-in theme, { own: { name, accent, chart } }
// for their own colours, or {} to go back to the app's colours.
export async function PUT(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;

	try {
		const choice = readChoice(await readJson(request));
		return privateJson(await saveUserTheme(identity.email, choice));
	} catch (error) {
		if (error instanceof UserThemeError) {
			return privateJson({ error: error.message }, 400);
		}
		throw error;
	}
}
