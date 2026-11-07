// Boundaries that cross the date line, cut where they cross.
//
// A country reaching across the date line jumps from one edge of the map to the other between
// two points. Drawn as written, that jump is a band of colour across the whole world. Each
// ring is cut at a jump and each piece stands alone, so the country is on both edges.
// Pure, so the page and a PDF draw the same map.

type Position = number[];
type Ring = Position[];

const jumpDegrees = 180;

// The pieces of one ring, each closed. A ring with no jump comes back unchanged.
export function cutAtDateLine(ring: Ring): Ring[] {
	const pieces: Ring[] = [];
	let piece: Ring = [];
	ring.forEach((point, index) => {
		const previous = ring[index - 1];
		if (previous && Math.abs(point[0] - previous[0]) > jumpDegrees) {
			pieces.push(piece);
			piece = [];
		}
		piece.push(point);
	});
	pieces.push(piece);
	if (pieces.length === 1) return [ring];

	// A ring ends where it began, so its last piece and its first are one piece.
	const last = pieces.pop() as Ring;
	pieces[0] = [...last, ...pieces[0].slice(1)];
	return pieces
		.filter((held) => held.length >= 3)
		.map((held) => {
			const first = held[0];
			const end = held[held.length - 1];
			if (first[0] === end[0] && first[1] === end[1]) return held;
			// A ring reaching all the way round the world, as Antarctica does, closes by way
			// of the pole rather than straight back across the map.
			if (Math.abs(first[0] - end[0]) <= jumpDegrees) {
				return [...held, first];
			}
			const pole = end[1] < 0 ? -90 : 90;
			return [...held, [end[0], pole], [first[0], pole], first];
		});
}

function polygonsOf(rings: Ring[]): Ring[][] {
	const pieces = cutAtDateLine(rings[0] ?? []);
	return pieces[0] === rings[0]
		? [rings]
		: // Holes do not survive a cut, and a country crossing the date line has none.
			pieces.map((piece) => [piece]);
}

interface Geometry {
	type?: string;
	coordinates?: unknown;
}

export function withoutDateLineJumps<
	T extends { features?: { geometry?: Geometry }[] },
>(geo: T): T {
	return {
		...geo,
		features: geo.features?.map((feature) => {
			const geometry = feature.geometry;
			if (geometry?.type === "Polygon") {
				return {
					...feature,
					geometry: {
						type: "MultiPolygon",
						coordinates: polygonsOf(geometry.coordinates as Ring[]),
					},
				};
			}
			if (geometry?.type === "MultiPolygon") {
				return {
					...feature,
					geometry: {
						type: "MultiPolygon",
						coordinates: (geometry.coordinates as Ring[][]).flatMap(
							polygonsOf,
						),
					},
				};
			}
			return feature;
		}),
	};
}
