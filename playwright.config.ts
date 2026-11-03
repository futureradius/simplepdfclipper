import { defineConfig } from "@playwright/test";

// E2E tests run against the built single file (dist/index.html) opened via
// file:// in the locally installed Microsoft Edge, exactly like users open it.
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: { channel: "msedge", headless: true },
});
