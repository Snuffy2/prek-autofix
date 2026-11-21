# Issue tracker

Issues and specs live in GitHub Issues for `Snuffy2/prek-autofix`.

- Prefer the PAT-backed GitHub MCP for supported operations. Use `gh` for gaps
  in MCP coverage and pass `--repo Snuffy2/prek-autofix` on issue commands.
- Publish to the tracker by creating a GitHub issue. Fetch a ticket by reading
  its body, labels, and comments. Filter issue lists by state and label.
- Apply labels using the mapping in `triage-labels.md`. When closing an issue,
  post the explanation as a comment before closing it.
- Use GitHub sub-issues for parent-child relationships. With `gh`, use
  `issue create --parent <parent>` or
  `issue edit <parent> --add-sub-issue <child>`. If sub-issues are unavailable,
  use `Part of #<parent>` in the child body.
- Use GitHub issue dependencies for blockers. With `gh`, use
  `issue create --blocked-by <blocker>` or
  `issue edit <child> --add-blocked-by <blocker>`. If dependencies are
  unavailable, use `Blocked by: #<blocker>` in the child body. A ticket is ready
  when all its blockers are closed.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When enabled, use the same triage labels and states for external pull requests.
Issues and pull requests share a number space. Resolve the item type before
applying changes.

## Wayfinding

Use an issue labeled `wayfinder:map` for the map. Link its tickets as sub-issues
and label each `wayfinder:<type>` (`research`, `prototype`, `grilling`, or
`task`). If sub-issues are unavailable, list the tickets in a task list on the
map issue and use `Part of #<map>` in each ticket.

Pick the first open, unassigned ticket in map order with no open blockers.
Assign it to yourself before starting. To resolve it, comment with the answer,
close the ticket, and add a summary and link to the map's Decisions-so-far.
