import { NextRequest, NextResponse } from "next/server";
import { canDo, isAdmin } from "@/lib/platform/access";
import { loadConfig, saveConfig } from "@/lib/work/access";
import { withDefaults, type WorkConfig } from "@/lib/work/model";
import { privateJson, readJson } from "../../notifications/guard";
import { failed, workCaller } from "../shared";

// How the queue is set up: columns, the lists behind each field, domain and
// layer owners, and the rules. Read by anybody using the queue, changed by an
// administrator.
export async function GET(request: NextRequest) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	return privateJson({ config: await loadConfig() });
}

export async function POST(request: NextRequest) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	try {
		const admin =
			isAdmin(who.policy) ||
			(await canDo(who.policy, who.identity, "settings.manage"));
		if (!admin) return privateJson({ error: "Not found" }, 404);
		const body = ((await readJson(request)) ?? {}) as {
			config?: Partial<WorkConfig>;
		};
		const config = withDefaults(body.config ?? {});
		if (config.columns.length === 0) {
			return privateJson(
				{ error: "The board needs at least one column." },
				400,
			);
		}
		config.prefix =
			(config.prefix || "WR").replace(/[^A-Za-z0-9]/g, "").slice(0, 8) ||
			"WR";
		await saveConfig(who.actor, config);
		return privateJson({ config });
	} catch (error) {
		return failed(error);
	}
}
