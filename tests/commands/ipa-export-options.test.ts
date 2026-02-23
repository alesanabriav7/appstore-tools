import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InfrastructureError } from "../../src/api/client.js";
import { ipaExportOptionsCommand } from "../../src/commands/ipa-export-options.js";

describe("ipaExportOptionsCommand", () => {
  const createdPaths: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      createdPaths.splice(0).map((entryPath) => rm(entryPath, { recursive: true, force: true }))
    );
  });

  it("writes a production-ready template with defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-export-options-"));
    const outputPath = join(root, "ExportOptions.plist");
    createdPaths.push(root);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await ipaExportOptionsCommand({
      json: false,
      outputPlistPath: outputPath,
      force: false
    });

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalled();

    const contents = await readFile(outputPath, "utf8");
    expect(contents).toContain("<key>method</key>");
    expect(contents).toContain("<string>app-store-connect</string>");
    expect(contents).toContain("<key>signingStyle</key>");
    expect(contents).toContain("<string>automatic</string>");
    expect(contents).toContain("<key>uploadSymbols</key>");
  });

  it("includes teamID when provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-export-options-team-"));
    const outputPath = join(root, "ExportOptions.plist");
    createdPaths.push(root);

    await ipaExportOptionsCommand({
      json: true,
      outputPlistPath: outputPath,
      teamId: "ABCDE12345",
      signingStyle: "manual",
      force: false
    });

    const contents = await readFile(outputPath, "utf8");
    expect(contents).toContain("<key>teamID</key>");
    expect(contents).toContain("<string>ABCDE12345</string>");
    expect(contents).toContain("<string>manual</string>");
  });

  it("refuses to overwrite an existing file unless force is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-export-options-overwrite-"));
    const outputPath = join(root, "ExportOptions.plist");
    createdPaths.push(root);
    await writeFile(outputPath, "existing", "utf8");

    await expect(
      ipaExportOptionsCommand({
        json: false,
        outputPlistPath: outputPath,
        force: false
      })
    ).rejects.toThrow(InfrastructureError);
  });
});
