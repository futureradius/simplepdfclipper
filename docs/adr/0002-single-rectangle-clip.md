# 2. One rectangular Clip per export

Status: superseded by ADR 0016 (2026-11-24): a Clip is now one or more Regions.

## Context

"Shortening" a schedule could mean a plain crop, or cutting out several regions and
stitching them together (e.g. task columns + one time window).

## Decision

v1 supports exactly one axis-aligned rectangular Clip. Cut-and-stitch is out of scope
for now.

One export is also always one page: for multi-page Documents the user picks the page
first (ADR 0014).

## Consequences

Simple UI and simple export. If stitching is needed later, the Clip model can grow
into a list of regions without changing the export pipeline's vector approach.
