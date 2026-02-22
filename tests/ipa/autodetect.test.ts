import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { InfrastructureError } from "../../src/api/client.js";
import {
  autoDetectIpaGenerateSource,
  autoDetectIpaSource,
  createDefaultOutputIpaPath
} from "../../src/ipa/autodetect.js";
import type { ProcessRunner } from "../../src/ipa/artifact.js";

describe("autoDetectIpaSource", () => {
  it("prefers the newest prebuilt ipa when available", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-autodetect-ipa-"));

    try {
      const oldIpa = join(root, "old.ipa");
      const newIpa = join(root, "new.ipa");
      await writeFile(oldIpa, "old");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writeFile(newIpa, "new");

      const source = await autoDetectIpaSource({ cwd: root });

      expect(source).toEqual({
        kind: "prebuilt",
        ipaPath: newIpa
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects xcodebuild mode from workspace + export options + scheme", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-autodetect-xcode-"));

    try {
      const workspacePath = join(root, "Demo.xcworkspace");
      const exportOptionsPlist = join(root, "ExportOptions.plist");
      await mkdir(workspacePath);
      await writeFile(exportOptionsPlist, "<plist></plist>");

      const processRunner: ProcessRunner = {
        run: async (command, args) => {
          if (command === "xcodebuild" && args.join(" ") === `-list -json -workspace ${workspacePath}`) {
            return {
              stdout: JSON.stringify({
                workspace: { schemes: ["Demo"] }
              }),
              stderr: ""
            };
          }

          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        }
      };

      const source = await autoDetectIpaSource({
        cwd: root,
        processRunner
      });

      expect(source).toEqual({
        kind: "xcodebuild",
        scheme: "Demo",
        exportOptionsPlist,
        workspacePath
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when no ipa/project context is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-autodetect-empty-"));

    try {
      await expect(autoDetectIpaSource({ cwd: root })).rejects.toThrow(InfrastructureError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects generate source even when a prebuilt ipa exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "asc-autodetect-generate-"));

    try {
      const workspacePath = join(root, "Demo.xcworkspace");
      const exportOptionsPlist = join(root, "ExportOptions.plist");
      const prebuiltIpa = join(root, "Demo.ipa");
      await mkdir(workspacePath);
      await writeFile(exportOptionsPlist, "<plist></plist>");
      await writeFile(prebuiltIpa, "ipa");

      const processRunner: ProcessRunner = {
        run: async (command, args) => {
          if (command === "xcodebuild" && args.join(" ") === `-list -json -workspace ${workspacePath}`) {
            return {
              stdout: JSON.stringify({
                workspace: { schemes: ["Demo"] }
              }),
              stderr: ""
            };
          }

          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        }
      };

      const source = await autoDetectIpaGenerateSource({
        cwd: root,
        processRunner
      });

      expect(source).toEqual({
        kind: "xcodebuild",
        scheme: "Demo",
        exportOptionsPlist,
        workspacePath
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates default output path from scheme", () => {
    const output = createDefaultOutputIpaPath({
      kind: "xcodebuild",
      scheme: "My App",
      exportOptionsPlist: "/tmp/ExportOptions.plist",
      workspacePath: "/tmp/MyApp.xcworkspace"
    }, "/tmp/repo");

    expect(output).toBe("/tmp/repo/dist/My-App.ipa");
  });
});
