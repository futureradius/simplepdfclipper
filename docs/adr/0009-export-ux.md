# 9. Export behaviour

Status: accepted (2026-11-03)

## Decision

- **Priority:** SVG (for the whiteboard tool) is built first. PDF (for project documentation) second;
  both are required.
- **Size warning:** the export shows the resulting file size and SVG element count. The whiteboard tool recommends imports
  under 2 MB and rejects files over 45 MB. Above 2 MB the app warns; above 45 MB it
  warns severely and explains the whiteboard tool will reject the file. It **never refuses** to export.
- **Background:** the exported Clip has a white background. A white rectangle exactly
  the size of the Clip is placed at the very back. The Plan's own background is not
  specially detected or removed; it is clipped like everything else.
- **No text search** in the clipper.
- **No .svgz:** tested 2026-11-03, the whiteboard tool accepts the upload of a gzip-compressed SVG
  but the image silently disappears. The option was removed again.
- **Saving:** a "Save as" dialog (File System Access API) with the suggested name
  `<original>_Ausschnitt.<ext>`; falls back to a normal download if unavailable.
- **PDF provenance:** source file name, export date and Clip coordinates (mm) are
  written to the PDF's document properties (title/subject). Nothing is added to the
  page itself.

Amended by ADR 0013 (Tiled Export): cut marks and a Tile label are added, inside the Margin only.

Amended 2026-11-24 (issue #27): the "Save as" dialog opens **on the click, before** the
SVG or PDF is computed, as in the Tiled Export. Edge allows the dialog only ~5 s after
the click; a longer export used to fall back silently to a download, whose blob URL was
revoked after 10 s. With Edge set to ask where to save, typing a new name took longer
and the file was saved with 0 KB. Cancelling the dialog now exports nothing, and the
download fallback keeps its blob URL until the next download.
