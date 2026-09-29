# Administration

At `/admin`, for anyone in an administrator group. Panes are listed down the
side in five groups, and each has its own address so it can be linked.

| Group | What is there |
| --- | --- |
| Activity | Adoption, cost and failures over a window. Which reports are opened, by whom, and where warehouse time goes |
| Access | Roles and what they allow, who holds what, direct grants, an access review for one person and one report, and the groups that hold access before any role does |
| Audit | Every recorded change, every export, and cache partitioning |
| Content | Registered sources and the catalogue sync, categories, and personal pages |
| Platform | What this replica holds, where it is connected, branding, the warehouse, caching, the assistant endpoint, and notifications |

## Category editor roles

Every category has its own editor role, named after it, such as "Sales
Performance - Editor". Holders build and maintain the reports in that category
and nowhere else, with what the Editor role grants.

The platform manages these roles. Each is created with its category, renamed
with it and retired when it is removed, and none can be edited or deleted by
hand, so they cannot drift from each other or from the Editor role. They are
listed under Access > Roles with their holders, and an assignment of one
always applies in its own category whatever scope the request named. Scoped
assignments of other roles cover anything these do not.

Holders are also the category's maintainers, whom readers can message, and
they see how each report in the category is read. See
[asking the maintainers](features.md#asking-the-maintainers) and
[how a report is read](features.md#how-a-report-is-read).

## Sources and caching

Content > Sources lists every registered source, and whether each is watched
for changes or refreshed on a timer. Its edit dialog sets the title,
description, default time field, and how often to check for new data: live,
every 30 minutes, hourly, every 6, 12 or 24 hours, weekly, a custom interval,
or the platform default. The dialog also says when the source was last checked
and when its data last changed, or why it is on a timer.

Platform > Caching sets the default interval, how often live sources are
checked, the memory the result cache may hold, and whether an expired answer
is served while a fresh one is fetched. See
[how current an answer is](architecture.md#how-current-an-answer-is).

The catalogue sync refreshes what the platform knows about its sources and
walks the row filters again. It runs to completion on the server, so leaving
the page does not stop it, and the Sources pane shows when it last finished
and who ran it.

## Notifications

Platform > Notifications turns alerts, scheduled pages and pushes on or off, sets how many
alerts one person may keep, shows how many alerts and devices there are and
which alerts are failing and why, sends an announcement to everyone who used
the app in the last 90 days, and replaces the push keys.
