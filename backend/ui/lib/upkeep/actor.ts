import type { Identity } from "../auth/identity";
import { isDatabricksApp } from "../runtime";

// Who the assistant is when it acts on its own.
//
// Its edits, notes and registrations are recorded under one name, so a report's
// history and an update's notes show it the way they show a person. It has no
// token of its own to forward: anything it reads runs as the application, and
// only to decide what to build. See lib/upkeep/runner.

export const assistantActor = "Assistant";

// An identity with no forwarded token, which makes catalogue reads run as the
// application. Used for registering a source the assistant found.
export function assistantIdentity(): Identity {
	return {
		email: assistantActor,
		name: assistantActor,
		initials: "AI",
		authenticated: true,
		userToken: null,
	};
}

// The application's own bearer token, for calling the model as the app. The
// SDK's default chain gives the injected service principal in a deployment and
// the developer's own profile on a workstation. Null when neither is there.
export async function applicationToken(): Promise<string | null> {
	try {
		const { WorkspaceClient } =
			await import("@databricks/sdk-experimental");
		const workspace = new WorkspaceClient({});
		const headers = new Headers();
		await workspace.config.authenticate(headers);
		const header = headers.get("Authorization") ?? "";
		return header.startsWith("Bearer ") ? header.slice(7) : null;
	} catch (error) {
		if (isDatabricksApp) {
			console.warn(
				"The assistant could not get the app's own token:",
				error,
			);
		}
		return null;
	}
}
