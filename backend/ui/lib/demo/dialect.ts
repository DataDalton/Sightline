// Rewrites the Databricks SQL the platform composes into Postgres, for the
// demonstration's local warehouse.
//
// Only the constructs the query builder, the value lists and the group probe
// actually produce are handled. Anything else passes through unchanged and
// fails in Postgres with its own message, which is the right outcome for SQL
// the demonstration was never meant to run.
//
// Handled here:
//   - backtick identifiers become double quoted ones
//   - :name parameter markers become $1, $2, with a repeated name reusing its
//     number
//   - a <=> b becomes a IS NOT DISTINCT FROM b
//   - explode(sequence(a, b)) becomes generate_series(a, b)
//
// Handled by objects the demonstration creates in Postgres instead, see
// lib/demo/seed:
//   - CAST(x AS STRING), through a domain named string
//   - approx_percentile(x, fraction, accuracy), through an aggregate
//   - is_member and is_account_group_member, through functions reading the
//     sample group memberships

export interface PostgresQuery {
	text: string;
	values: unknown[];
}

export function toPostgres(
	sql: string,
	params: Record<string, unknown> = {},
): PostgresQuery {
	const values: unknown[] = [];
	const numbers = new Map<string, number>();
	let out = "";
	let i = 0;

	while (i < sql.length) {
		const ch = sql[i];

		// String literals are copied as they are, including '' escapes.
		if (ch === "'") {
			const end = closing(sql, i, "'");
			out += sql.slice(i, end);
			i = end;
			continue;
		}

		if (ch === '"') {
			const end = closing(sql, i, '"');
			out += sql.slice(i, end);
			i = end;
			continue;
		}

		// A backtick identifier, where a doubled backtick is a literal one.
		if (ch === "`") {
			const end = closing(sql, i, "`");
			const name = sql.slice(i + 1, end - 1).replace(/``/g, "`");
			out += `"${name.replace(/"/g, '""')}"`;
			i = end;
			continue;
		}

		// A Postgres cast such as ::jsonb is not a parameter.
		if (ch === ":" && sql[i + 1] === ":") {
			out += "::";
			i += 2;
			continue;
		}

		if (ch === ":" && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
			const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1));
			const name = match ? match[0] : "";
			if (name in params) {
				let number = numbers.get(name);
				if (number === undefined) {
					values.push(params[name]);
					number = values.length;
					numbers.set(name, number);
				}
				out += `$${number}`;
				i += 1 + name.length;
				continue;
			}
		}

		out += ch;
		i++;
	}

	out = out
		.replace(/\s<=>\s/g, " IS NOT DISTINCT FROM ")
		.replace(
			/\bexplode\s*\(\s*sequence\s*\(([^()]*)\)\s*\)/gi,
			"generate_series($1)",
		);

	return { text: out, values };
}

// The index just past the quote that closes the one at start. A doubled quote
// inside is an escaped one and does not close it.
function closing(sql: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < sql.length) {
		if (sql[i] === quote) {
			if (sql[i + 1] === quote) {
				i += 2;
				continue;
			}
			return i + 1;
		}
		i++;
	}
	return sql.length;
}
