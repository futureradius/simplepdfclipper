# 7. German UI, English code; remember the last Clip

Status: accepted (2026-11-03)

## Decision

- UI text is German. Code, comments, identifiers and docs are English.
- The last Clip (in mm) is stored in the browser (localStorage). When a new version
  of the Plan is opened, the Clip is restored so the user only has to adjust it.
  If the stored Clip does not fit inside the new Plan, it is silently ignored.
  The same rule applies when switching to another page of a multi-page Document
  (ADR 0014).
- The last export settings (Tiled Export, SVG options) are remembered the same way;
  named Presets come on top (ADR 0015).

## Consequences

No server state. The stored Clip is per browser profile.

## Stretch instead of ignore (decided 2026-11-24, #14; to be built in #38)

The remembered Clip is now all Regions with their Layout (ADR 0016), stored relative to
the Plan's size. On a Plan of a different size they are stretched by the width and
height ratios separately, the Layout by the same factors (touching Regions keep
touching), instead of being ignored. The same applies when a Clip preset is loaded
(ADR 0015). A yellow note in step 2 then says in which direction and by how much, e.g.
"Bereiche an die Plangröße angepasst: vertikal um +2,1 % gestreckt. Bitte prüfen.",
until it is closed or a Region is edited. A Plan of the same size restores exactly.
A schedule that grew at one end shifts Regions in the middle slightly; the user
corrects them. Accepted.

Since #36 all Regions with their Layout are remembered (in mm, key
`simplepdfclipper.lastRegions`); until #38 they are still ignored on a Plan they do not
fit.
