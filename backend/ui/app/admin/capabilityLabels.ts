// What each permission is called on screen, and the area it is listed under.

export const capabilityInfo: Record<string, { label: string; area: string }> = {
	"export.run": { label: "Export data", area: "Every reader" },
	"explore.use": { label: "Use Explore", area: "Every reader" },
	"assistant.use": { label: "Use the assistant", area: "Every reader" },
	"personal.create": { label: "Build personal pages", area: "Every reader" },
	"board.create": { label: "Create boards", area: "Every reader" },
	"sheet.create": { label: "Create sheets", area: "Every reader" },
	"alert.create": { label: "Create alerts", area: "Every reader" },
	"schedule.create": { label: "Schedule pages", area: "Every reader" },
	"note.write": { label: "Write notes", area: "Every reader" },

	"report.suggest": { label: "Suggest changes", area: "Reports" },
	"report.edit": { label: "Edit reports", area: "Reports" },
	"report.create": { label: "Build new reports", area: "Reports" },
	"page.create": { label: "Add pages", area: "Reports" },
	"report.makeOfficial": { label: "Make reports official", area: "Reports" },

	"report.review": { label: "Approve suggestions", area: "Looking after" },
	"report.delete": { label: "Delete reports", area: "Looking after" },
	"report.move": { label: "Move reports", area: "Looking after" },
	"note.moderate": { label: "Remove others' notes", area: "Looking after" },
	"access.delegate": { label: "Decide who edits", area: "Looking after" },
	"rule.manage": { label: "Manage data rules", area: "Looking after" },
	"report.editAny": {
		label: "Edit past Maintainers only",
		area: "Looking after",
	},

	"update.post": { label: "Post updates", area: "Administration" },
	"update.moderate": { label: "Look after updates", area: "Administration" },
	"page.protect": { label: "Lock and unlock", area: "Administration" },
	"block.manage": { label: "Manage shared blocks", area: "Administration" },
	"theme.manage": { label: "Create themes", area: "Administration" },
	"personal.viewAny": {
		label: "See other people's personal pages",
		area: "Administration",
	},
	"category.create": { label: "Create categories", area: "Administration" },
	"category.manage": { label: "Manage categories", area: "Administration" },
	"access.grant": { label: "Roles and access", area: "Administration" },
	"semantic.sync": { label: "Sources", area: "Administration" },
	"settings.manage": { label: "Platform settings", area: "Administration" },
	"audit.view": { label: "Audit and access review", area: "Administration" },
	"usage.view": { label: "Usage and cost", area: "Administration" },
};

export const areaOrder = [
	"Every reader",
	"Reports",
	"Looking after",
	"Administration",
];

export function capabilityLabel(capability: string): string {
	return capabilityInfo[capability]?.label ?? capability;
}
