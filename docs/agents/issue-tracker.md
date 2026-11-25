# Issue tracker in local Markdown

Issues and specs live in `.scratch/`, with one directory per feature. Create the
feature directory when publishing its first spec or ticket.

- Write the spec to `.scratch/<feature>/spec.md`.
- Write one file per ticket at `.scratch/<feature>/issues/<NN>-<slug>.md`.
  Number tickets from `01` in dependency order. List each ticket's blockers by
  number on a `Blocked by:` line.
- Record triage state as `Status:` near the top of the spec or ticket. Use the
  values in [Triage labels](triage-labels.md).
- Append comments and conversation history under `## Comments` in the file.

To fetch a ticket, read its file by path or by number within its feature.

## Wayfinding

Write the map to `.scratch/<effort>/map.md` and put each ticket in
`.scratch/<effort>/issues/<NN>-<slug>.md`. Record its question in the body and
its `Type:` as `research`, `prototype`, `grilling`, or `task`.

Pick the lowest-numbered open, unclaimed ticket whose blockers are all
`resolved`. Set `Status: claimed` before starting. To resolve the ticket, add
the answer under `## Answer`, set `Status: resolved`, and add a summary and link
to the map's Decisions-so-far section.
