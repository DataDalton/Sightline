// What a reader is told when the model refuses a request.
//
// The endpoint's own answer is written for whoever configures it. It names
// status codes and token scopes a reader cannot act on, so it goes to the server
// log and the reader is told what happened and who can fix it.
//
// Pure, so every case can be tested without a model.
export function refusalMessage(status: number): string {
	if (status === 401 || status === 403) {
		return "You don't have access to the assistant's model yet. Ask an administrator to give you access. If you were just given it, sign out and back in.";
	}
	if (status === 404) {
		return "The assistant's model could not be found. Ask an administrator to check the assistant's settings.";
	}
	if (status === 429) {
		return "The assistant is busy right now. Try again in a minute.";
	}
	if (status === 408 || status === 504) {
		return "The assistant took too long to answer. Try again, or ask something narrower.";
	}
	if (status >= 500) {
		return "The assistant's model is having trouble right now. Try again in a few minutes.";
	}
	return "The assistant could not answer that. Try asking it another way.";
}
