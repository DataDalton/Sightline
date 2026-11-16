import { assistantConfigured, converse } from "../assistant/endpoint";
import { applicationToken } from "./actor";

// The model, asked as the application.
//
// Every other model call carries the signed-in person's own token. The assistant
// acting on its own has nobody signed in, so it calls with the application's
// token, which the workspace has granted the model service. What it sends is the
// source's field definitions and summaries read to decide what to build, never
// anything a person asked.

export class ModelUnavailable extends Error {}

// The model's reply as text, or ModelUnavailable when no model is configured or
// the app has no token to call it with.
export async function askAsApplication(
	system: string,
	user: unknown,
	maxTokens = 3000,
): Promise<string> {
	if (!assistantConfigured()) {
		throw new ModelUnavailable("No model endpoint is configured.");
	}
	const token = await applicationToken();
	const turn = await converse(
		token,
		[
			{ role: "system", content: system },
			{
				role: "user",
				content: typeof user === "string" ? user : JSON.stringify(user),
			},
		],
		[],
		{},
		maxTokens,
	).catch((error) => {
		throw new ModelUnavailable(
			error instanceof Error
				? error.message
				: "The model could not be reached.",
		);
	});
	return turn.content ?? "";
}
