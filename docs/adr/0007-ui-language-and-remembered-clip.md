# 7. German UI, English code; remember the last Clip

Status: accepted (2026-11-03)

## Decision

- UI text is German. Code, comments, identifiers and docs are English.
- The last Clip (in mm) is stored in the browser (localStorage). When a new version
  of the Plan is opened, the Clip is restored so the user only has to adjust it.
  If the stored Clip does not fit inside the new Plan, it is silently ignored.

## Consequences

No server state. The stored Clip is per browser profile.
