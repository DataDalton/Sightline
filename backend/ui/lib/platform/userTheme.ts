import { sql } from "../data/lakebase";
import { parseCustomThemes, type ReportTheme } from "../visuals/themes";

// The colours one person chose for the whole app.
//
// Either a theme the workspace already has, named by id, or a set of their own.
// It wins over every report's theme for that person. Exports and deliveries keep
// the report's theme, because those are read by other people.

export interface UserThemeChoice {
	// A built-in or workspace theme. Null when they use their own or none.
	themeId: string | null;
	// Their own colours. Null unless they made a set.
	own: ReportTheme | null;
}

export const noUserTheme: UserThemeChoice = { themeId: null, own: null };

// The id a person's own set carries, so it never collides with a workspace theme.
export const ownThemeId = "personal";

export class UserThemeError extends Error {}

export async function readUserTheme(
	ownerEmail: string,
): Promise<UserThemeChoice> {
	const rows = await sql<{ theme_id: string | null; own_theme: unknown }>(
		`SELECT theme_id, own_theme FROM user_themes WHERE owner_email = $1`,
		[ownerEmail.toLowerCase()],
	);
	const row = rows[0];
	if (!row) return noUserTheme;
	const own = row.own_theme
		? (parseCustomThemes(JSON.stringify([row.own_theme]))[0] ?? null)
		: null;
	return { themeId: row.theme_id, own };
}

// Checks what the browser sent. A malformed colour is refused rather than
// dropped, because the person is looking at the editor and can fix it.
export function readChoice(raw: unknown): UserThemeChoice {
	const body = (raw ?? {}) as Record<string, unknown>;
	if (body.own !== undefined && body.own !== null) {
		const given = body.own as Record<string, unknown>;
		const own = parseCustomThemes(
			JSON.stringify([
				{
					id: ownThemeId,
					name:
						typeof given.name === "string" && given.name.trim()
							? given.name.trim().slice(0, 60)
							: "My colours",
					accent: given.accent,
					chart: given.chart,
				},
			]),
		)[0];
		if (!own) {
			throw new UserThemeError(
				"Each colour has to be a six digit hex value, such as #2563eb.",
			);
		}
		return { themeId: null, own };
	}
	if (typeof body.themeId === "string" && body.themeId.trim()) {
		return { themeId: body.themeId.trim().slice(0, 100), own: null };
	}
	return noUserTheme;
}

export async function saveUserTheme(
	ownerEmail: string,
	choice: UserThemeChoice,
): Promise<UserThemeChoice> {
	const email = ownerEmail.toLowerCase();
	if (!choice.themeId && !choice.own) {
		await sql(`DELETE FROM user_themes WHERE owner_email = $1`, [email]);
		return noUserTheme;
	}
	await sql(
		`INSERT INTO user_themes (owner_email, theme_id, own_theme, modified_on)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (owner_email) DO UPDATE SET
		   theme_id = EXCLUDED.theme_id,
		   own_theme = EXCLUDED.own_theme,
		   modified_on = now()`,
		[email, choice.themeId, choice.own ? JSON.stringify(choice.own) : null],
	);
	return choice;
}
