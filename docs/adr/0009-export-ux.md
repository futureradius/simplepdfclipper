# 9. Export behaviour

Status: accepted (2026-11-03)

## Decision

- **Priority:** SVG (for the whiteboard tool) is built first. PDF (for project documentation) second;
  both are required.
- **Size warning:** the export shows the resulting file size. The whiteboard tool recommends imports
  under 2 MB and rejects files over 45 MB. Above 2 MB the app warns; above 45 MB it
  warns severely and explains the whiteboard tool will reject the file. It **never refuses** to export.
- **Background:** the exported Clip has a white background. A white rectangle exactly
  the size of the Clip is placed at the very back. The Plan's own background is not
  specially detected or removed; it is clipped like everything else.
- **No text search** in the clipper.
