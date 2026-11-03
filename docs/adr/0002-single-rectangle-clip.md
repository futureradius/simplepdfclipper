# 2. One rectangular Clip per export

Status: accepted (2026-11-03)

## Context

"Shortening" a schedule could mean a plain crop, or cutting out several regions and
stitching them together (e.g. task columns + one time window).

## Decision

v1 supports exactly one axis-aligned rectangular Clip. Cut-and-stitch is out of scope
for now.

## Consequences

Simple UI and simple export. If stitching is needed later, the Clip model can grow
into a list of regions without changing the export pipeline's vector approach.
