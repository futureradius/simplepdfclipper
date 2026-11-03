# 5. Content outside the Clip is actually removed

Status: accepted (2026-11-03)

## Context

Most crop tools only change the PDF's MediaBox/CropBox. The full Plan is still in the
file and anyone with a PDF editor can recover it. Clips are shared with third parties.
Not leaking the rest of the Plan is the main reason this tool exists.

## Decision

The exported PDF contains no content that lies entirely outside the Clip. Removal is
done by redacting the area outside the Clip (MuPDF redaction, without black boxes),
then setting the page box to the Clip.

SVG export only ever contains content within the Clip.

## Consequences

Behaviour for objects that cross the Clip edge is decided separately (see round 3 of
the design interview / a follow-up ADR).
