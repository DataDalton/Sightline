import { deflateRawSync } from "node:zlib";

// A zip file, which is what a PowerPoint or Excel file is underneath. Written here so an
// export adds no package to the app.

const crcTable = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

export function crc32(data: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of data) {
		value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
	}
	return (value ^ 0xffffffff) >>> 0;
}

export function zip(files: { name: string; data: Buffer | string }[]): Buffer {
	const parts: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name, "utf-8");
		const raw =
			typeof file.data === "string"
				? Buffer.from(file.data, "utf-8")
				: file.data;
		const packed = deflateRawSync(raw);
		const crc = crc32(raw);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		// Names are UTF-8.
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		parts.push(local, name, packed);

		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(0x0800, 8);
		entry.writeUInt16LE(8, 10);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(packed.length, 20);
		entry.writeUInt32LE(raw.length, 24);
		entry.writeUInt16LE(name.length, 28);
		entry.writeUInt32LE(offset, 42);
		directory.push(entry, name);

		offset += local.length + name.length + packed.length;
	}
	const central = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, central, end]);
}
