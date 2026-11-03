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

### Objects crossing the Clip edge

Lines and shapes that are partly inside the Clip are kept whole
(`REDACT_LINE_ART_REMOVE_IF_COVERED`); the page box cuts them visually at the edge.
Removing everything that touches the outside (`REMOVE_IF_TOUCHED`) would delete grid
lines and bars crossing the Clip.

Text is removed glyph by glyph. Glyphs on the edge that are kept and stick out a
little are acceptable.

## Consequences

The file still contains the invisible remainder of crossing lines and shapes. That
reveals at most their extent, not readable schedule content. Accepted.
