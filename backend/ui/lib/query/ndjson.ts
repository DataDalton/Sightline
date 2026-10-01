// Splits newline-delimited JSON as it arrives.
//
// A streamed body comes in chunks that cut lines at arbitrary points, so the
// text after the last newline is held until the next chunk completes it. Blank
// lines are skipped. Each complete line is handed over as text, and parsing it
// is left to the caller, which knows what a line should hold.
export interface LineReader {
	push(text: string): void;
	// Hands over whatever is left once the body has ended, which is a final
	// line written without a trailing newline.
	end(): void;
}

export function createLineReader(onLine: (line: string) => void): LineReader {
	let buffer = "";
	return {
		push(text) {
			buffer += text;
			let at = buffer.indexOf("\n");
			while (at >= 0) {
				const line = buffer.slice(0, at).trim();
				buffer = buffer.slice(at + 1);
				if (line) onLine(line);
				at = buffer.indexOf("\n");
			}
		},
		end() {
			const line = buffer.trim();
			buffer = "";
			if (line) onLine(line);
		},
	};
}
