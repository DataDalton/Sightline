// Reads a TrueType font far enough to embed the letters a PDF uses and measure them.
//
// A subset keeps every glyph's number and empties the ones not used, so a character's number
// in the file is its number in the font and nothing has to be renumbered.

const glyphFlags = {
	argsAreWords: 0x0001,
	haveScale: 0x0008,
	moreComponents: 0x0020,
	haveXYScale: 0x0040,
	haveTwoByTwo: 0x0080,
};

// What a reader needs to draw the outlines. The rest of a font is names and layout rules.
const keptTables = [
	"cvt ",
	"fpgm",
	"glyf",
	"head",
	"hhea",
	"hmtx",
	"loca",
	"maxp",
	"prep",
];

export class TrueTypeFont {
	private readonly tables = new Map<
		string,
		{ offset: number; length: number }
	>();
	private readonly glyphOfCode = new Map<number, number>();
	readonly unitsPerEm: number;
	readonly ascent: number;
	readonly descent: number;
	readonly box: [number, number, number, number];
	private readonly longLoca: boolean;
	private readonly advanceCount: number;
	private readonly glyphCount: number;

	constructor(private readonly data: Buffer) {
		const tableCount = data.readUInt16BE(4);
		for (let index = 0; index < tableCount; index += 1) {
			const entry = 12 + index * 16;
			this.tables.set(data.toString("latin1", entry, entry + 4), {
				offset: data.readUInt32BE(entry + 8),
				length: data.readUInt32BE(entry + 12),
			});
		}
		const head = this.offsetOf("head");
		this.unitsPerEm = data.readUInt16BE(head + 18);
		this.box = [
			data.readInt16BE(head + 36),
			data.readInt16BE(head + 38),
			data.readInt16BE(head + 40),
			data.readInt16BE(head + 42),
		];
		this.longLoca = data.readInt16BE(head + 50) === 1;
		const hhea = this.offsetOf("hhea");
		this.ascent = data.readInt16BE(hhea + 4);
		this.descent = data.readInt16BE(hhea + 6);
		this.advanceCount = data.readUInt16BE(hhea + 34);
		this.glyphCount = data.readUInt16BE(this.offsetOf("maxp") + 4);
		this.readCharacterMap();
	}

	private offsetOf(table: string): number {
		const held = this.tables.get(table);
		if (!held) throw new Error(`The font has no ${table} table.`);
		return held.offset;
	}

	// Prefers a table covering every character over one limited to the first 65536.
	private readCharacterMap(): void {
		const { data } = this;
		const cmap = this.offsetOf("cmap");
		const count = data.readUInt16BE(cmap + 2);
		let best: { offset: number; format: number } | null = null;
		for (let index = 0; index < count; index += 1) {
			const entry = cmap + 4 + index * 8;
			const platform = data.readUInt16BE(entry);
			const encoding = data.readUInt16BE(entry + 2);
			const unicode =
				platform === 0 ||
				(platform === 3 && (encoding === 1 || encoding === 10));
			if (!unicode) continue;
			const offset = cmap + data.readUInt32BE(entry + 4);
			const format = data.readUInt16BE(offset);
			if (format !== 4 && format !== 12) continue;
			if (!best || format > best.format) best = { offset, format };
		}
		if (!best) throw new Error("The font has no usable character map.");

		if (best.format === 12) {
			const groups = data.readUInt32BE(best.offset + 12);
			for (let group = 0; group < groups; group += 1) {
				const at = best.offset + 16 + group * 12;
				const start = data.readUInt32BE(at);
				const end = data.readUInt32BE(at + 4);
				const glyph = data.readUInt32BE(at + 8);
				for (let code = start; code <= end; code += 1) {
					this.glyphOfCode.set(code, glyph + code - start);
				}
			}
			return;
		}

		const segments = data.readUInt16BE(best.offset + 6) / 2;
		const ends = best.offset + 14;
		const starts = ends + segments * 2 + 2;
		const deltas = starts + segments * 2;
		const ranges = deltas + segments * 2;
		for (let segment = 0; segment < segments; segment += 1) {
			const end = data.readUInt16BE(ends + segment * 2);
			const start = data.readUInt16BE(starts + segment * 2);
			const delta = data.readInt16BE(deltas + segment * 2);
			const rangeAt = ranges + segment * 2;
			const range = data.readUInt16BE(rangeAt);
			for (let code = start; code <= end && code !== 0xffff; code += 1) {
				let glyph: number;
				if (range === 0) {
					glyph = (code + delta) & 0xffff;
				} else {
					const held = data.readUInt16BE(
						rangeAt + range + (code - start) * 2,
					);
					glyph = held === 0 ? 0 : (held + delta) & 0xffff;
				}
				if (glyph !== 0) this.glyphOfCode.set(code, glyph);
			}
		}
	}

	glyphFor(codePoint: number): number {
		return this.glyphOfCode.get(codePoint) ?? 0;
	}

	// In thousandths of the size, which is how a PDF states widths.
	advance(glyph: number): number {
		const at = Math.min(glyph, this.advanceCount - 1);
		const units = this.data.readUInt16BE(this.offsetOf("hmtx") + at * 4);
		return (units / this.unitsPerEm) * 1000;
	}

	private glyphRange(glyph: number): { start: number; end: number } {
		const loca = this.offsetOf("loca");
		if (this.longLoca) {
			return {
				start: this.data.readUInt32BE(loca + glyph * 4),
				end: this.data.readUInt32BE(loca + (glyph + 1) * 4),
			};
		}
		return {
			start: this.data.readUInt16BE(loca + glyph * 2) * 2,
			end: this.data.readUInt16BE(loca + (glyph + 1) * 2) * 2,
		};
	}

	// A glyph can be built from others, as an accented letter usually is, and those come too.
	private withParts(glyphs: Iterable<number>): Set<number> {
		const glyf = this.offsetOf("glyf");
		const out = new Set<number>([0]);
		const queue = [...glyphs];
		while (queue.length > 0) {
			const glyph = queue.pop() as number;
			if (glyph >= this.glyphCount) continue;
			if (out.has(glyph) && glyph !== 0) continue;
			out.add(glyph);
			const { start, end } = this.glyphRange(glyph);
			if (end <= start) continue;
			if (this.data.readInt16BE(glyf + start) >= 0) continue;
			let at = glyf + start + 10;
			for (;;) {
				const flags = this.data.readUInt16BE(at);
				queue.push(this.data.readUInt16BE(at + 2));
				at += 4 + (flags & glyphFlags.argsAreWords ? 4 : 2);
				if (flags & glyphFlags.haveScale) at += 2;
				else if (flags & glyphFlags.haveXYScale) at += 4;
				else if (flags & glyphFlags.haveTwoByTwo) at += 8;
				if (!(flags & glyphFlags.moreComponents)) break;
			}
		}
		return out;
	}

	subset(glyphs: Iterable<number>): Buffer {
		const used = this.withParts(glyphs);
		const glyf = this.offsetOf("glyf");

		const newLoca = Buffer.alloc((this.glyphCount + 1) * 4);
		const pieces: Buffer[] = [];
		let position = 0;
		for (let glyph = 0; glyph < this.glyphCount; glyph += 1) {
			newLoca.writeUInt32BE(position, glyph * 4);
			if (!used.has(glyph)) continue;
			const { start, end } = this.glyphRange(glyph);
			if (end <= start) continue;
			const piece = this.data.subarray(glyf + start, glyf + end);
			pieces.push(piece);
			position += piece.length;
			const padding = (4 - (piece.length % 4)) % 4;
			if (padding > 0) {
				pieces.push(Buffer.alloc(padding));
				position += padding;
			}
		}
		newLoca.writeUInt32BE(position, this.glyphCount * 4);

		const held = this.tables.get("head") as {
			offset: number;
			length: number;
		};
		const newHead = Buffer.from(
			this.data.subarray(held.offset, held.offset + held.length),
		);
		newHead.writeInt16BE(1, 50);
		newHead.writeUInt32BE(0, 8);

		const replaced = new Map<string, Buffer>([
			["glyf", Buffer.concat(pieces)],
			["loca", newLoca],
			["head", newHead],
		]);
		const present = keptTables.filter((name) => this.tables.has(name));
		const bodies = present.map((name) => {
			const original = this.tables.get(name) as {
				offset: number;
				length: number;
			};
			return (
				replaced.get(name) ??
				this.data.subarray(
					original.offset,
					original.offset + original.length,
				)
			);
		});

		const header = Buffer.alloc(12 + present.length * 16);
		header.writeUInt32BE(0x00010000, 0);
		header.writeUInt16BE(present.length, 4);
		const power = Math.floor(Math.log2(present.length));
		header.writeUInt16BE(2 ** power * 16, 6);
		header.writeUInt16BE(power, 8);
		header.writeUInt16BE((present.length - 2 ** power) * 16, 10);
		let offset = header.length;
		const parts: Buffer[] = [header];
		present.forEach((name, index) => {
			const body = bodies[index];
			const padded = Buffer.concat([
				body,
				Buffer.alloc((4 - (body.length % 4)) % 4),
			]);
			const entry = 12 + index * 16;
			header.write(name, entry, "latin1");
			header.writeUInt32BE(checksum(padded), entry + 4);
			header.writeUInt32BE(offset, entry + 8);
			header.writeUInt32BE(body.length, entry + 12);
			parts.push(padded);
			offset += padded.length;
		});
		return Buffer.concat(parts);
	}
}

function checksum(data: Buffer): number {
	let sum = 0;
	for (let at = 0; at + 4 <= data.length; at += 4) {
		sum = (sum + data.readUInt32BE(at)) >>> 0;
	}
	return sum;
}
