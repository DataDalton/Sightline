import { NextRequest, NextResponse } from "next/server";
import {
	closeItem,
	getItem,
	moveItem,
	reopenItem,
	setBlocked,
	signOff,
	updateItem,
} from "@/lib/work/store";
import {
	addComment,
	addLink,
	changeCriteria,
	editComment,
	react,
	removeLink,
	setMeToo,
	setWatching,
} from "@/lib/work/activity";
import { detach } from "@/lib/work/attachments";
import { WorkError } from "@/lib/work/access";
import { privateJson, readJson } from "../../notifications/guard";
import { failed, workCaller } from "../shared";

type Context = { params: Promise<{ key: string }> };

// One request, by key such as WR-142, with its whole timeline.
export async function GET(request: NextRequest, { params }: Context) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	try {
		return privateJson(await getItem(who.actor, (await params).key));
	} catch (error) {
		return failed(error);
	}
}

// Everything done to a request, by action:
//   update, with any of title, description, workType, priority, effort, layer,
//     domain, target, assignees, reviewer, approver, tags, visibility,
//     parentKey and releaseId
//   move { to }, close { as, reason, duplicateOf }, reopen
//   block { reason, by }, unblock, approve, securityReview
//   comment { body, replyTo }, editComment { commentId, body },
//     removeComment { commentId }, react { commentId, reaction }
//   link { kind, target, detail, label }, unlink { linkId }
//   criteria { add } or { criterionId, done } or { criterionId, remove }
//   meToo { on }, watch { on }, detach { attachmentId }
export async function POST(request: NextRequest, { params }: Context) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	const key = (await params).key;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const text = (name: string) =>
		typeof body[name] === "string" ? (body[name] as string) : "";
	try {
		switch (body.action) {
			case "update": {
				const { action: _action, ...patch } = body;
				await updateItem(who.actor, key, patch as never);
				break;
			}
			case "move":
				await moveItem(who.actor, key, text("to"));
				break;
			case "close":
				await closeItem(
					who.actor,
					key,
					body.as === "duplicate" ? "duplicate" : "declined",
					text("reason"),
					text("duplicateOf") || null,
				);
				break;
			case "reopen":
				await reopenItem(who.actor, key);
				break;
			case "block":
				await setBlocked(
					who.actor,
					key,
					true,
					text("reason"),
					text("by") || null,
				);
				break;
			case "unblock":
				await setBlocked(who.actor, key, false, "");
				break;
			case "approve":
				await signOff(who.actor, key, "approve");
				break;
			case "securityReview":
				await signOff(who.actor, key, "securityReview");
				break;
			case "comment":
				return privateJson(
					{
						commentId: await addComment(
							who.actor,
							key,
							text("body"),
							text("replyTo") || null,
						),
					},
					201,
				);
			case "editComment":
				await editComment(
					who.actor,
					key,
					text("commentId"),
					text("body"),
				);
				break;
			case "removeComment":
				await editComment(who.actor, key, text("commentId"), null);
				break;
			case "react":
				await react(
					who.actor,
					key,
					text("commentId"),
					text("reaction"),
				);
				break;
			case "link":
				await addLink(who.actor, key, {
					kind: text("kind"),
					target: text("target"),
					detail: text("detail") || null,
					label: text("label") || null,
				});
				break;
			case "unlink":
				await removeLink(who.actor, key, text("linkId"));
				break;
			case "criteria":
				await changeCriteria(
					who.actor,
					key,
					typeof body.add === "string"
						? { add: body.add }
						: body.remove === true
							? { criterionId: text("criterionId"), remove: true }
							: {
									criterionId: text("criterionId"),
									done: body.done === true,
								},
				);
				break;
			case "meToo":
				await setMeToo(who.actor, key, body.on !== false);
				break;
			case "watch":
				await setWatching(who.actor, key, body.on !== false);
				break;
			case "detach":
				await detach(who.actor, key, text("attachmentId"));
				break;
			default:
				throw new WorkError("Unknown action.");
		}
		return privateJson({ ok: true });
	} catch (error) {
		return failed(error);
	}
}
