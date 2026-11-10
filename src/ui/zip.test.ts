import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, zip } from "./zip";

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes an archive that a real unzipper extracts", async () => {
    const files = [
      { name: "plan_Ausschnitt_Kachel_A1.pdf", data: new TextEncoder().encode("%PDF-1.7 erste") },
      { name: "plan_Ausschnitt_Kachel_Ü2.pdf", data: new Uint8Array(70_000).map((_, i) => i % 251) },
    ];
    const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
    const path = join(dir, "t.zip");
    writeFileSync(path, new Uint8Array(await zip(files).arrayBuffer()));
    // bsdtar ships with Windows 10+ and macOS and reads ZIP files (Git Bash's GNU tar does not).
    const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    execFileSync(tar, ["-xf", path, "-C", dir]);
    for (const f of files) expect(new Uint8Array(readFileSync(join(dir, f.name)))).toEqual(f.data);
  });
});
