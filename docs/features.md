# Features

What readers and authors can do. Setup for each is in
[deployment](deployment.md), and the admin side in
[administration](administration.md).

- [Reports and saved views](#reports-and-saved-views)
- [Taking data out](#taking-data-out)
- [The dictionary](#the-dictionary)
- [Explore](#explore)
- [The data assistant](#the-data-assistant)
- [Sheets](#sheets)
- [Alerts and the inbox](#alerts-and-the-inbox)
- [Scheduled pages](#scheduled-pages)
- [Asking the maintainers](#asking-the-maintainers)
- [How a report is read](#how-a-report-is-read)
- [On a phone, and installed](#on-a-phone-and-installed)

## Reports and saved views

A report has one definition that a central group edits and publishes to
everyone, and each reader keeps an arrangement on top of it: their columns,
filters, sizes and sort. A saved view records the differences against the
report rather than a snapshot, so a measure an editor adds appears for
everyone, personalised or not. A reader only loses a column by hiding it.

Filters sit in a strip above the page. When an author builds a page from a
template, the rows its filters held on the grid are closed, so the first visual
starts at the top.

## Taking data out

Export runs behind the request. Asking for one records a job and returns. The
work streams rows from the warehouse in batches and writes them to Postgres as
it goes, so nothing holds the whole file, the reader can leave the page, and
any replica can hand over the result.

One export is capped at 50,000 rows, because an export is for a spreadsheet
somebody works with. A file that reaches the cap says so.

Every export writes an audit row naming who took what before the query runs,
so a failed attempt is still recorded. Administration > Audit > Export
audit lists them.

## The dictionary

Every field on every source a reader can see, with the definition written on
the source, its type and, for a metric view, the expression that calculates
it. Opening a field shows which reports use it and how, as a dimension,
measure, filter or sort. Read that before renaming or retiring anything. A
filter is the reference most easily missed. Fields no visual uses are listed
on their own.

Definitions come from the catalogue, so a comment edited on the view is what
the dictionary shows. Calculations are read under the reader's own token,
which needs the same `SELECT` the data does. Usage lists only reports the
reader can open.

## Explore

`/explore` is a table built from one search bar. Type a dataset, then the
columns wanted, then conditions.

| Typed | Means |
| --- | --- |
| `Category = Hardware` | Equals. Also `is`, `!=`, `>`, `>=`, `<`, `<=` |
| `Category in Hardware, Software` | Any of the values. `not in` for none of them |
| `Customer contains North` | Also `starts with` and `ends with` |
| `Region is empty` | Blank. Also `is not empty` |
| `not Status = DRAFT` | Every row the condition does not match, blanks included |
| `or Region = East` | Joins this condition to the last with OR |
| `(Category = Hardware` ... `or Category = Software)` | Groups conditions, nested as deep as needed |

Brackets are read first, then AND before OR. `A and B or C` is both A and B,
or C, while `A and (B or C)` is A with either B or C. Clicking a bracket
removes it and its pair.

Everything inside one OR, or under a NOT, must be the same kind of field,
because a dimension is tested per row before grouping and a totalled measure
after it. AND has no such limit, so `Region = West and (Revenue > 1000000 or
Units > 50)` works. Every field in the list also has a Filter button, and so
does the bar.

The table follows the bar through the same query endpoint reports use, so row
filters, caching and the export audit all apply. The exploration is kept in the
address, so a reload returns to it and the link can be shared. It can also be
kept by name as a saved view. A saved view holds the question, not the answer,
so it shows current data, and it is private to whoever saved it.

## The data assistant

Off unless a model endpoint is configured. When it is, an Ask button on
every page opens a panel, and `/assist` is the same conversation at full width.

It works like an analyst. It finds the dataset, reads the field definitions,
runs queries, reads the rows, runs more, then writes up what it found with
charts where they help. Each step is shown as it happens, with its time, row
count and first rows. It knows which report and page are open, and anything on
the page can be pointed at and added to the question. For a chart that hands
over the numbers it draws.

It is bounded by the same layer everything else uses:

- The model never writes SQL. It asks for a query in the same small shape a
  visual does, and every field name is checked against the source, by kind,
  before anything runs. An unknown name is refused, not guessed.
- Every query runs through the ordinary executor under the asker's token. It
  sees their rows only, and is told only about sources they can read.
- It is told to report figures as they came back and never to state a number
  it did not query.

The model sees field names and definitions, the rows its queries return, and
whatever was pointed at. Conversations are saved per person, and each person
can give it standing instructions and ask it to remember things. None of that
is visible to anyone else, administrators included.

## Sheets

A sheet is a live table from one dataset with the reader's own columns on top,
for work that used to go to a spreadsheet. Rows come from the same search bar
as Explore and are read again whenever the sheet opens. The dataset is never
changed.

- **Formula columns** use a small spreadsheet language. Columns by name in
  square brackets, arithmetic and comparison, `&` to join text, and functions
  such as `IF`, `ROUND`, `IFERROR` and `COALESCE`. `SHARE`, `RANK`, `PREVIOUS`,
  `RUNNING` and `TOTAL` read down the whole column. Formulas may read each
  other, and a loop shows `#CYCLE!` rather than hanging.
- **Notes columns** hold text typed beside a row, tied to the row's grouping
  values so a note stays with its row across refreshes.
- **Pivot** puts fields down the side, one across the top and measures in the
  cells. Every total is asked of the warehouse at its own grain rather than
  added from the cells, so an average's total is the average.
- The grid selects and copies ranges, moves with the keyboard, sorts, resizes,
  freezes columns, formats numbers and sums the selection.

Sheets are shared with named people to view or edit, and each person sees
their own rows under their own access. Notes are returned only for rows in that
person's answer and written only to a row they can see, so a note cannot reveal
a value their filter hides. Everyone with a sheet open sees who else has it and
which cell each has selected, and changes reach the others within seconds. A
change made from an out of date copy is refused and reloaded rather than
overwriting the newer one.

Downloading a sheet returns CSV with formulas worked out on the server, up to
the query ceiling, recorded in the export audit. A note starting with `=` is
written as text so a spreadsheet program does not run it.

## Alerts and the inbox

An alert watches one measure, as a total or per value of a field, narrowed by
the same conditions Explore writes. It fires when the value crosses a line,
rises or falls by more than a percentage since the last check, or changes at
all. A crossed line is reported once, not on every check it stays crossed, and
optionally again when it recovers. Several values crossing at once send one
message listing them.

Alerts are made from the Alerts page, or from Explore with the numbers on
screen, and the dialog shows the current value before saving. Checks run on
the hour, hourly, daily, on weekdays or weekly, in the owner's time zone, so an
idle warehouse is started once for every alert due that hour.

A check needs someone's authority to query, and a person's token only exists
while they are using the app.

- **A dataset that shows everyone the same rows**, with no row filter or column
  mask, is checked on schedule as the app. That is the owner's answer too, for
  the same reason the cache shares one answer for such a dataset. It runs only
  while the owner has been seen able to read the dataset within the last day,
  so a withdrawn grant stops their alerts no later than everything else.
- **A row-filtered dataset** is checked as the app, narrowed to what the owner
  can see. While they use the app, it records under their token every
  combination of the columns the filter decides on. The recording is retaken
  at most hourly and not used once a day old. A value appearing after it was
  taken is left out until the next one, which errs towards showing less.
- That needs every column the filter reads to be a field of the dataset, the
  filter on the table the dataset reads rather than a joined one, no column
  mask, and at most 500 combinations for the person. The filter walk works
  this out per dataset. Anything else is checked under the owner's token while
  they use the app, and the alert says so. Exposing a filter's columns as
  fields moves a dataset from one case to the other.

Everything anyone is told lands in their Inbox: alerts, scheduled pages, pages
shared with them, conversations and announcements. The Inbox entry in the
navigation carries the unread count. Entries can be marked read or unread and cleared, and each opens
the page it is about. An alert opens Explore on the numbers it read.

## Scheduled pages

Schedule on a report page sends that page to the reader every day, every
weekday or once a week, at an hour in their own time zone. What arrives is the
page's headline figures, its KPI tiles as the page shows them on opening, with
how each moved since the last one and a link to the page. It lands in the Inbox
and, with pushes on, on their phone or computer.

The figures are worked out under the reader's own access, by the same rules as
an alert. A dataset that shows everyone the same rows is worked out on
schedule, a row-filtered one narrowed to what the reader was recorded seeing,
and anything else the next time they are in the app. A page is sent at most
daily. Inbox > Scheduled pages lists what is scheduled, when each next comes
and whether the last one went, and sends one at once or stops it.

## Asking the maintainers

Whoever holds a category's editor role is who readers take questions to. The
category page shows them in a panel, and every report in it shows them as an
Ask button beside its title. Asking sends a message to all of them, or to
the one person or group pressed, through the application rather than email. It
lands in their inbox under Conversations, both sides reply there, and every
message is also a notification. Where the browser offers it, a message's push
notification carries a Reply box, and what is typed goes straight into the
conversation. When it cannot be sent there, the conversation opens instead.

A group is one conversation everyone in it shares. Membership is read when
each person looks, so someone who joins sees what was already asked, and
someone who leaves stops seeing it. Every member who has ever used the app is
notified, using the groups they were in when they last signed in. Someone who
has never used it is not.

Only the maintainers of a category the asker can open can be written to, one
person can start a limited number of conversations an hour, and nothing is
shown for a category with no editor.

## How a report is read

Whoever can edit a report has a Usage button on it, showing how it was read
over the last 7, 30 or 90 days. Opens and people, a bar for each day, who read
it and when they last did, how often each page was opened, and how often each
visual was expanded, had its figures shown, had its notes opened or was
clicked into. A page nobody opened, and a visual nobody did anything with, is
marked, since those are what to look at before rearranging or retiring
anything. Being on screen does not count as use. It names the people who read
the report, so it is shown only to those who maintain it.

## On a phone, and installed

Every page works at phone width. A tab bar carries Home, Explore, the
assistant, the inbox and the menu, dialogs rise from the bottom, tables become
cards, and an opened visual takes the screen. Visuals sized by their content,
such as figure rows, headings and text, are measured and fitted so nothing
overlaps.

The app can be installed from the browser's install button on desktop or
Android, or with "Add to Home Screen" on iPhone and iPad, where "Install on this
device" in the account menu shows the steps. Installed, it opens in its own
window with its unread count on the icon. A service worker keeps the build's
assets on the device so it opens quickly, and shows an offline page when there
is no connection. It stores nothing else, because every page and answer is
specific to the person and their access.

With push turned on by an administrator, anyone can have their inbox sent to
their phone or computer from Inbox > Settings, choosing which kinds and
managing the devices. On iPhone and iPad a push only reaches the installed app.
