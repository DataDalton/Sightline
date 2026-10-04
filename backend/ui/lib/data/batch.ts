// Gathers the same question asked about different keys at about the same time
// and asks it once for all of them.
//
// Many reads are one row or a few per person: their stored policy, their
// favourites, their inbox. Each asked on its own takes a connection from the
// pool for a round trip, and when many people arrive together those round
// trips are what the pool runs out of. Asked together, the people arriving in
// one turn of the event loop share one statement. The busier the app, the more
// requests are waiting at once and the more each statement answers, so the
// connections taken per person fall as load rises. A quiet app pays one turn
// of the event loop.

// Most keys answered by one statement. A larger gathering is split.
const maxBatch = 500;

interface Waiting<K, V> {
	key: K;
	resolvers: {
		resolve: (value: V) => void;
		reject: (error: unknown) => void;
	}[];
}

// load answers the keys it is given, by each key's string form. A key the
// answer leaves out resolves to fallback. A failed load rejects every caller
// in that batch.
export function batchedRead<K, V>(
	load: (keys: K[]) => Promise<Map<string, V>>,
	keyOf: (key: K) => string,
	fallback: V,
): (key: K) => Promise<V> {
	let gathering = new Map<string, Waiting<K, V>>();
	let scheduled = false;

	const run = async (batch: Map<string, Waiting<K, V>>) => {
		try {
			const answers = await load([...batch.values()].map((w) => w.key));
			for (const [id, { resolvers }] of batch) {
				const value = answers.has(id)
					? (answers.get(id) as V)
					: fallback;
				for (const r of resolvers) r.resolve(value);
			}
		} catch (error) {
			for (const { resolvers } of batch.values()) {
				for (const r of resolvers) r.reject(error);
			}
		}
	};

	const flush = () => {
		scheduled = false;
		const gathered = gathering;
		gathering = new Map();
		let batch = new Map<string, Waiting<K, V>>();
		for (const [id, waiting] of gathered) {
			batch.set(id, waiting);
			if (batch.size >= maxBatch) {
				void run(batch);
				batch = new Map();
			}
		}
		if (batch.size > 0) void run(batch);
	};

	return (key: K) =>
		new Promise<V>((resolve, reject) => {
			const id = keyOf(key);
			const waiting = gathering.get(id);
			if (waiting) waiting.resolvers.push({ resolve, reject });
			else gathering.set(id, { key, resolvers: [{ resolve, reject }] });
			if (!scheduled) {
				scheduled = true;
				setImmediate(flush);
			}
		});
}
