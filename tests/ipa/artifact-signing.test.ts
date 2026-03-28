import { access, constants, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InfrastructureError } from "../../src/api/client.js";
import { resolveIpaArtifact, type ProcessRunner } from "../../src/ipa/artifact.js";
import { SigningError } from "../../src/ipa/signing.js";

function createRunner(options: {
  readonly archiveFailureStderr?: string;
  readonly exportFailureStderr?: string;
  readonly onExportOptionsPath?: (plistPath: string) => Promise<void> | void;
} = {}): {
  runner: ProcessRunner;
  calls: string[][];
} {
  const calls: string[][] = [];

  const runner: ProcessRunner = {
    run: async (command, args) => {
      calls.push([command, ...args]);

      if (command !== "xcodebuild") {
        throw new InfrastructureError(`Unexpected command: ${command}`);
      }

      if (args[0] === "archive") {
        if (options.archiveFailureStderr) {
          throw new InfrastructureError(
            `Command exited with status 65.\nstderr: ${options.archiveFailureStderr}`
          );
        }

        return { stdout: "", stderr: "" };
      }

      if (args[0] === "-exportArchive") {
        const exportPath = args[args.indexOf("-exportPath") + 1];
        const exportOptionsPath = args[args.indexOf("-exportOptionsPlist") + 1];

        if (!exportPath || !exportOptionsPath) {
          throw new InfrastructureError("Missing export path arguments.");
        }

        if (options.exportFailureStderr) {
          throw new InfrastructureError(
            `Command exited with status 70.\nstderr: ${options.exportFailureStderr}`
          );
        }

        if (options.onExportOptionsPath) {
          await options.onExportOptionsPath(exportOptionsPath);
        }

        await mkdir(exportPath, { recursive: true });
        await writeFile(path.join(exportPath, "Demo.ipa"), "ipa");
        return { stdout: "", stderr: "" };
      }

      throw new InfrastructureError(`Unexpected xcodebuild args: ${args.join(" ")}`);
    }
  };

  return { runner, calls };
}

async function createXcodebuildSource(root: string, input: {
  readonly includeExportOptions?: boolean;
} = {}): Promise<{
  readonly source: {
    readonly kind: "xcodebuild";
    readonly scheme: string;
    readonly workspacePath: string;
    readonly outputIpaPath: string;
    readonly exportOptionsPlist?: string;
  };
  readonly exportOptionsPlistPath: string;
  readonly outputIpaPath: string;
}> {
  const workspacePath = path.join(root, "Demo.xcworkspace");
  const exportOptionsPlistPath = path.join(root, "ExportOptions.plist");
  const outputIpaPath = path.join(root, "dist", "Demo.ipa");

  await mkdir(workspacePath);

  if (input.includeExportOptions !== false) {
    await writeFile(exportOptionsPlistPath, "<plist></plist>");
  }

  return {
    source: {
      kind: "xcodebuild",
      scheme: "Demo",
      workspacePath,
      outputIpaPath,
      ...(input.includeExportOptions === false ? {} : { exportOptionsPlist: exportOptionsPlistPath })
    },
    exportOptionsPlistPath,
    outputIpaPath
  };
}

describe("resolveIpaArtifact (xcodebuild signing)", () => {
  const createdPaths: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      createdPaths.splice(0).map((entryPath) => rm(entryPath, { recursive: true, force: true }))
    );
  });

  it("uses ASC_KEY_PATH, infers ASC_KEY_ID from filename, and includes required archive signing flags", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asc-artifact-signing-path-"));
    createdPaths.push(root);

    const keyPath = path.join(root, "AuthKey_TEST.p8");
    await writeFile(keyPath, "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n");

    const { source, exportOptionsPlistPath, outputIpaPath } = await createXcodebuildSource(root);
    const { runner, calls } = createRunner();

    vi.stubEnv("ASC_ISSUER_ID", "ISSUER_PATH_MODE");
    vi.stubEnv("ASC_KEY_PATH", keyPath);

    const artifact = await resolveIpaArtifact(source, runner);
    expect(artifact.ipaPath).toBe(outputIpaPath);

    const archiveArgs = calls[0] ?? [];
    expect(archiveArgs).toContain("archive");
    expect(archiveArgs).toContain("-destination");
    expect(archiveArgs).toContain("generic/platform=iOS");
    expect(archiveArgs).toContain("-allowProvisioningUpdates");
    expect(archiveArgs).toContain("-authenticationKeyPath");
    expect(archiveArgs).toContain(path.resolve(keyPath));
    expect(archiveArgs).toContain("-authenticationKeyID");
    expect(archiveArgs).toContain("TEST");
    expect(archiveArgs).toContain("-authenticationKeyIssuerID");
    expect(archiveArgs).toContain("ISSUER_PATH_MODE");

    const exportArgs = calls[1] ?? [];
    expect(exportArgs).toContain("-exportArchive");
    expect(exportArgs).toContain("-exportOptionsPlist");
    expect(exportArgs).toContain(path.resolve(exportOptionsPlistPath));
    expect(exportArgs).toContain("-allowProvisioningUpdates");
    expect(exportArgs).toContain("-authenticationKeyPath");
    expect(exportArgs).toContain(path.resolve(keyPath));
    expect(exportArgs).toContain("-authenticationKeyID");
    expect(exportArgs).toContain("TEST");
    expect(exportArgs).toContain("-authenticationKeyIssuerID");
    expect(exportArgs).toContain("ISSUER_PATH_MODE");
  });

  it("uses ASC_KEY_CONTENT (base64), writes temp key, and cleans it up", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asc-artifact-signing-content-"));
    createdPaths.push(root);

    const { source } = await createXcodebuildSource(root);
    const { runner, calls } = createRunner();
    const keyId = "KEY_CONTENT_MODE";
    const tempKeyPath = path.join(tmpdir(), `AuthKey_${keyId}.p8`);

    vi.stubEnv("ASC_KEY_ID", keyId);
    vi.stubEnv("ASC_ISSUER_ID", "ISSUER_CONTENT_MODE");
    vi.stubEnv(
      "ASC_KEY_CONTENT",
      Buffer.from("-----BEGIN PRIVATE KEY-----\ncontent\n-----END PRIVATE KEY-----\n").toString("base64")
    );

    await resolveIpaArtifact(source, runner);

    const archiveArgs = calls[0] ?? [];
    expect(archiveArgs).toContain("-authenticationKeyPath");
    expect(archiveArgs).toContain(tempKeyPath);

    await expect(access(tempKeyPath, constants.F_OK)).rejects.toThrow();
  });

  it("throws when ASC_KEY_CONTENT is not valid base64", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asc-artifact-signing-b64-"));
    createdPaths.push(root);

    const { source } = await createXcodebuildSource(root);
    const { runner } = createRunner();

    vi.stubEnv("ASC_KEY_ID", "KEY_BAD_B64");
    vi.stubEnv("ASC_ISSUER_ID", "ISSUER_BAD_B64");
    vi.stubEnv("ASC_KEY_CONTENT", "not-base64***");

    await expect(resolveIpaArtifact(source, runner)).rejects.toThrow(SigningError);
  });

  it("throws when key source env is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asc-artifact-signing-missing-key-"));
    createdPaths.push(root);

    const { source } = await createXcodebuildSource(root);
    const { runner } = createRunner();

    vi.stubEnv("ASC_KEY_ID", "KEY_MISSING_SOURCE");
    vi.stubEnv("ASC_ISSUER_ID", "ISSUER_MISSING_SOURCE");

    await expect(resolveIpaArtifact(source, runner)).rejects.toThrow(SigningError);
  });

  it("throws when ASC_KEY_ID or ASC_ISSUER_ID is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asc-artifact-signing-missing-required-"));
    createdPaths.push(root);

    const { source } = await createXcodebuildSource(root);
    const { runner } = createRunner();
    vi.stubEnv("ASC_KEY_CONTENT", Buffer.from("key").toString("base64"));

    await expect(resolveIpaArtifact(source, runner)).rejects.toThrow(SigningError);
  });

  it("wraps archive failures as SigningError and keeps stderr details", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asc-artifact-signing-archive-fail-"));
    createdPaths.push(root);

    const { source } = await createXcodebuildSource(root);
    const { runner } = createRunner({ archiveFailureStderr: "archive failed because signing" });

    vi.stubEnv("ASC_KEY_ID", "KEY_ARCHIVE_FAIL");
    vi.stubEnv("ASC_ISSUER_ID", "ISSUER_ARCHIVE_FAIL");
    vi.stubEnv("ASC_KEY_CONTENT", Buffer.from("key").toString("base64"));

    await expect(resolveIpaArtifact(source, runner)).rejects.toThrowError(
      /xcodebuild archive failed[\s\S]*archive failed because signing/
    );
  });

  it("wraps export failures as SigningError and cleans temp key", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asc-artifact-signing-export-fail-"));
    createdPaths.push(root);

    const { source } = await createXcodebuildSource(root);
    const { runner } = createRunner({ exportFailureStderr: "export failed due to team mismatch" });
    const keyId = "KEY_EXPORT_FAIL";
    const tempKeyPath = path.join(tmpdir(), `AuthKey_${keyId}.p8`);

    vi.stubEnv("ASC_KEY_ID", keyId);
    vi.stubEnv("ASC_ISSUER_ID", "ISSUER_EXPORT_FAIL");
    vi.stubEnv("ASC_KEY_CONTENT", Buffer.from("key").toString("base64"));

    await expect(resolveIpaArtifact(source, runner)).rejects.toThrowError(
      /xcodebuild -exportArchive failed[\s\S]*team mismatch/
    );
    await expect(access(tempKeyPath, constants.F_OK)).rejects.toThrow();
  });

  it("generates ExportOptions.plist dynamically when missing and cleans it up", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asc-artifact-signing-dynamic-plist-"));
    createdPaths.push(root);

    const { source } = await createXcodebuildSource(root, { includeExportOptions: false });
    let generatedPlistPath: string | null = null;

    const { runner } = createRunner({
      onExportOptionsPath: async (plistPath) => {
        generatedPlistPath = plistPath;
        await access(plistPath, constants.R_OK);
      }
    });

    vi.stubEnv("ASC_KEY_ID", "KEY_DYNAMIC_PLIST");
    vi.stubEnv("ASC_ISSUER_ID", "ISSUER_DYNAMIC_PLIST");
    vi.stubEnv("ASC_KEY_CONTENT", Buffer.from("key").toString("base64"));
    vi.stubEnv("ASC_TEAM_ID", "ABCDE12345");

    await resolveIpaArtifact(source, runner);

    expect(generatedPlistPath).toBeTruthy();
    await expect(access(generatedPlistPath!, constants.F_OK)).rejects.toThrow();
  });

  it("fails when explicit export options plist path is unreadable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asc-artifact-signing-explicit-bad-plist-"));
    createdPaths.push(root);

    const { source } = await createXcodebuildSource(root, { includeExportOptions: false });
    const explicitMissingPlist = path.join(root, "missing", "ExportOptions.plist");
    const { runner, calls } = createRunner();

    vi.stubEnv("ASC_KEY_ID", "KEY_EXPLICIT_BAD_PLIST");
    vi.stubEnv("ASC_ISSUER_ID", "ISSUER_EXPLICIT_BAD_PLIST");
    vi.stubEnv("ASC_KEY_CONTENT", Buffer.from("key").toString("base64"));

    await expect(
      resolveIpaArtifact(
        {
          ...source,
          exportOptionsPlist: explicitMissingPlist
        },
        runner
      )
    ).rejects.toThrowError(`Export options plist is not readable: ${explicitMissingPlist}`);
    expect(calls).toHaveLength(0);
  });
});
