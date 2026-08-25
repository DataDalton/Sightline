# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
so it can be fixed before it is described in public.

Use **GitHub's private vulnerability reporting**: go to the **Security** tab of
this repository and choose **Report a vulnerability**. That opens a private
thread with the maintainers and needs no other account or channel.

If that is unavailable, open a public issue saying only that you have a
security report and asking for a private channel. Do not include details.

Include in your report:

- What the issue is and what it lets someone do.
- Steps to reproduce, with the branch or commit.
- Any proof of concept, logs or screenshots that confirm it.

## What is in scope

This platform runs queries under each caller's own identity and caches the
results. The parts where a mistake matters most, and the ones worth looking
at hardest:

- **Cache partitioning.** A cached result may only be served to somebody who
  provably sees the same rows. Anything that lets two callers with different
  row visibility share a cache entry is a serious bug, not a performance
  issue.
- **On behalf of the user.** Every data query runs under the caller's
  forwarded token. Any path that reaches user-facing data with the service
  principal instead is in scope.
- **The SVG sanitiser.** An uploaded logo is placed in the page of every
  reader. Anything that survives `lib/visuals/svgSanitize.ts` and executes is
  in scope.
- **Query building.** A client sends field keys, never SQL. Anything that gets
  a client-supplied string into a query other than as a bound parameter is in
  scope.

## Response

Expect an acknowledgement within five business days. We will confirm the
report, agree a severity, and coordinate a fix and a disclosure timeline with
you.

## Supported versions

Fixes are applied to `main`. Older branches are not patched unless the README
says otherwise.
