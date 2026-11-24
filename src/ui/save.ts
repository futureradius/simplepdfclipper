// Saving files: a "Save as" dialog via the File System Access API, falling back to
// a download (ADR 0009); for single Tile files a folder picker (ADR 0013).

interface Writable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  createWritable(): Promise<Writable>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type ShowSaveFilePicker = (options: SaveFilePickerOptions) => Promise<FileHandle>;

export interface DirectoryHandle {
  name: string;
  getFileHandle(name: string, options: { create: boolean }): Promise<FileHandle>;
}
type ShowDirectoryPicker = (options: { id?: string; mode: "readwrite" }) => Promise<DirectoryHandle>;

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

let lastDownloadUrl: string | undefined;

/**
 * Starts a download. The blob URL stays valid until the next download: with the
 * browser set to ask where to save, it is read only once the user confirms that
 * dialog, and revoking it earlier (it used to be after 10 s) saved 0 KB (#27).
 */
export function download(blob: Blob, name: string): void {
  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  const a = document.createElement("a");
  a.href = lastDownloadUrl = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

/**
 * Asks where to save *now*, and returns a function that writes the file there later.
 * Call it before any long work: the dialog needs the click that started the export,
 * and the browser allows that for about 5 s only, after which this would silently
 * fall back to a download (#27). Resolves to null if the user cancelled; falls back
 * to a download if no dialog is available.
 */
export async function chooseSaveTarget(suggestedName: string, description: string, mime: string, ext: string): Promise<((blob: Blob) => Promise<void>) | null> {
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName, types: [{ description, accept: { [mime]: [ext] } }] });
      return async (blob) => {
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
      };
    } catch (e) {
      if (isAbort(e)) return null;
      // anything else: fall through to a plain download
    }
  }
  return async (blob) => download(blob, suggestedName);
}

export async function saveFile(blob: Blob, suggestedName: string, description: string, mime: string, ext: string): Promise<void> {
  const write = await chooseSaveTarget(suggestedName, description, mime, ext);
  await write?.(blob);
}

/**
 * Lets the user pick a folder to write several files into. Resolves to the folder,
 * null if the user cancelled, or undefined if no folder picker is available (the
 * caller then falls back to a ZIP download).
 */
export async function chooseFolder(): Promise<DirectoryHandle | null | undefined> {
  const picker = (window as unknown as { showDirectoryPicker?: ShowDirectoryPicker }).showDirectoryPicker;
  if (!picker) return undefined;
  try {
    return await picker({ id: "kacheln", mode: "readwrite" });
  } catch (e) {
    return isAbort(e) ? null : undefined;
  }
}

export async function writeToFolder(dir: DirectoryHandle, name: string, blob: Blob): Promise<void> {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(blob);
  await w.close();
}
