import { sql } from "../data/lakebase";

// Background work that one replica does on behalf of all of them, claimed by
// name in the platform store.
//
// The claim is taken in one statement, so two replicas asking at once cannot
// both win. It holds for the given number of seconds from when it was taken,
// so a replica that stops part way through does not hold it for ever, and
// nobody else takes it again until that time has passed.
export async function claimRun(
	name: string,
	holdSeconds: number,
): Promise<boolean> {
	const rows = await sql(
		`INSERT INTO background_claims (name, claimed_on) VALUES ($1, now())
		 ON CONFLICT (name) DO UPDATE SET claimed_on = now()
		 WHERE background_claims.claimed_on
		       < now() - make_interval(secs => $2)
		 RETURNING 1`,
		[name, holdSeconds],
	);
	return rows.length > 0;
}
