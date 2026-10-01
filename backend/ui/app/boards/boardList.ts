import { mutate } from "swr";

// The list of boards a person can open, as every screen that shows it asks
// for it.
export const boardListKey = "/api/boards/";

// Reads the list again after a board is created, renamed, changed or deleted,
// so a screen already holding it shows the change without a reload.
export function refreshBoardList(): void {
	void mutate(boardListKey);
}
