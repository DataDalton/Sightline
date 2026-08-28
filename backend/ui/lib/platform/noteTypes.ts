// The shape of a note, and the one rule about it both sides need.
//
// Held apart from lib/platform/notes because that module opens a database
// connection, and the panel that draws notes runs in the browser. Importing a
// constant out of it would pull the whole pool into the client bundle: a type
// is erased at compile time, but a value is not.

export interface VisualNote {
	noteId: string;
	visualId: string;
	authorEmail: string;
	body: string;
	// The point the note is about, where it is about one. Null for a note about
	// the visual as a whole.
	anchoredOn: string | null;
	createdOn: string;
}

// The longest a note can be.
//
// Generous enough for a paragraph of explanation, short enough that this stays
// commentary rather than becoming a second place documents live. A page of
// prose about a chart belongs in the text panel a page can already carry.
//
// Enforced on the server. The input uses it too, so the limit is visible while
// somebody types rather than only once they press save.
export const maxNoteLength = 2000;
