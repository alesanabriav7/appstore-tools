import { spawn } from "node:child_process";
import { access, constants, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { InfrastructureError } from "../api/client.js";
import {
  SigningError,
  resolveArchiveAuthenticationContext,
  resolveOrCreateExportOptionsPlist
} from "./signing.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrebuiltIpaSource {
  readonly kind: "prebuilt";
  readonly ipaPath: string;
}

export interface XcodebuildIpaSource {
  readonly kind: "xcodebuild";
  readonly scheme: string;
  readonly exportOptionsPlist?: string;
  readonly workspacePath?: string;
  readonly projectPath?: string;
  readonly configuration?: string;
  readonly archivePath?: string;
  readonly derivedDataPath?: string;
  readonly outputIpaPath?: string;
}

export interface CustomCommandIpaSource {
  readonly kind: "customCommand";
  readonly buildCommand: string;
  readonly generatedIpaPath: string;
  readonly outputIpaPath?: string;
}

export type IpaSource = PrebuiltIpaSource | XcodebuildIpaSource | CustomCommandIpaSource;

export interface IpaArtifact {
  readonly ipaPath: string;
  readonly dispose?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Process runner (inlined)
// ---------------------------------------------------------------------------

interface ProcessRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options?: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }
  ): Promise<ProcessRunResult>;
}

function createNodeProcessRunner(): ProcessRunner {
  return {
    run(command, args, options = {}) {
      return new Promise<ProcessRunResult>((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ["ignore", "pipe", "pipe"]
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutChunks.push(chunk);
        });

        child.stderr.on("data", (chunk: Buffer) => {
          stderrChunks.push(chunk);
        });

        child.on("error", (error) => {
          reject(
            new InfrastructureError(
              `Failed to run command: ${[command, ...args].join(" ")}`,
              error
            )
          );
        });

        child.on("close", (exitCode) => {
          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          const stderr = Buffer.concat(stderrChunks).toString("utf8");

          if (exitCode !== 0) {
            reject(
              new InfrastructureError(
                [
                  `Command exited with status ${String(exitCode)}.`,
                  `Command: ${[command, ...args].join(" ")}`,
                  stderr.trim() ? `stderr: ${stderr.trim()}` : "",
                  stdout.trim() ? `stdout: ${stdout.trim()}` : ""
                ]
                  .filter((line) => line.length > 0)
                  .join("\n")
              )
            );
            return;
          }

          resolve({ stdout, stderr });
        });
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const defaultProcessRunner: ProcessRunner = createNodeProcessRunner();

export async function resolveIpaArtifact(
  source: IpaSource,
  processRunner: ProcessRunner = defaultProcessRunner
): Promise<IpaArtifact> {
  switch (source.kind) {
    case "prebuilt":
      return resolvePrebuilt(source);
    case "xcodebuild":
      return resolveXcodebuild(source, processRunner);
    case "customCommand":
      return resolveCustomCommand(source, processRunner);
    default:
      throw new InfrastructureError(`Unsupported IPA source kind: ${String(source)}`);
  }
}

// ---------------------------------------------------------------------------
// Prebuilt
// ---------------------------------------------------------------------------

async function resolvePrebuilt(source: PrebuiltIpaSource): Promise<IpaArtifact> {
  const ipaPath = path.resolve(source.ipaPath);

  await access(ipaPath, constants.R_OK).catch((error: unknown) => {
    throw new InfrastructureError(`IPA file is not readable: ${ipaPath}`, error);
  });

  return { ipaPath };
}

// ---------------------------------------------------------------------------
// Xcodebuild
// ---------------------------------------------------------------------------

const DEFAULT_CONFIGURATION = "Release";

async function resolveXcodebuild(
  source: XcodebuildIpaSource,
  processRunner: ProcessRunner
): Promise<IpaArtifact> {
  if (!source.scheme.trim()) {
    throw new InfrastructureError("scheme is required for xcodebuild IPA source.");
  }

  const hasWorkspace = Boolean(source.workspacePath);
  const hasProject = Boolean(source.projectPath);

  if (hasWorkspace === hasProject) {
    throw new InfrastructureError(
      "Exactly one of workspacePath or projectPath must be provided."
    );
  }

  const createdTemporaryDirectories: string[] = [];
  const rootTemporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "asc-build-"));
  createdTemporaryDirectories.push(rootTemporaryDirectory);

  const archivePath = source.archivePath
    ? path.resolve(source.archivePath)
    : path.join(rootTemporaryDirectory, "archive.xcarchive");
  const exportDirectory = path.join(rootTemporaryDirectory, "export");
  let authContext:
    | Awaited<ReturnType<typeof resolveArchiveAuthenticationContext>>
    | undefined;
  let exportOptionsContext:
    | Awaited<ReturnType<typeof resolveOrCreateExportOptionsPlist>>
    | undefined;
  let keepBuildArtifacts = false;

  try {
    authContext = await resolveArchiveAuthenticationContext(process.env);
    exportOptionsContext = await resolveOrCreateExportOptionsPlist(
      source.exportOptionsPlist,
      rootTemporaryDirectory,
      process.env
    );

    const archiveArgs = createArchiveArgs(source, archivePath, authContext);
    await runSignedXcodebuild(processRunner, archiveArgs, "xcodebuild archive");

    await mkdir(exportDirectory, { recursive: true });

    const exportArgs = [
      "-exportArchive",
      "-archivePath",
      archivePath,
      "-exportOptionsPlist",
      exportOptionsContext.exportOptionsPlistPath,
      "-exportPath",
      exportDirectory
    ];
    await runSignedXcodebuild(processRunner, exportArgs, "xcodebuild -exportArchive");

    const exportedIpaPath = await findIpaInDirectory(exportDirectory);

    if (!source.outputIpaPath) {
      keepBuildArtifacts = true;

      return {
        ipaPath: exportedIpaPath,
        dispose: async () => {
          await cleanup(createdTemporaryDirectories);
        }
      };
    }

    const outputIpaPath = path.resolve(source.outputIpaPath);
    await mkdir(path.dirname(outputIpaPath), { recursive: true });
    await copyFile(exportedIpaPath, outputIpaPath);

    return { ipaPath: outputIpaPath };
  } finally {
    await authContext?.cleanup().catch(() => undefined);
    await exportOptionsContext?.cleanup().catch(() => undefined);

    if (!keepBuildArtifacts) {
      await cleanup(createdTemporaryDirectories).catch(() => undefined);
    }
  }
}

function createArchiveArgs(
  source: XcodebuildIpaSource,
  archivePath: string,
  authentication: {
    readonly authenticationKeyPath: string;
    readonly authenticationKeyID: string;
    readonly authenticationKeyIssuerID: string;
  }
): string[] {
  const args = [
    "archive",
    "-scheme",
    source.scheme,
    "-configuration",
    source.configuration ?? DEFAULT_CONFIGURATION,
    "-archivePath",
    archivePath,
    "-destination",
    "generic/platform=iOS",
    "-allowProvisioningUpdates",
    "-authenticationKeyPath",
    authentication.authenticationKeyPath,
    "-authenticationKeyID",
    authentication.authenticationKeyID,
    "-authenticationKeyIssuerID",
    authentication.authenticationKeyIssuerID
  ];

  if (source.workspacePath) {
    args.push("-workspace", path.resolve(source.workspacePath));
  }

  if (source.projectPath) {
    args.push("-project", path.resolve(source.projectPath));
  }

  if (source.derivedDataPath) {
    args.push("-derivedDataPath", path.resolve(source.derivedDataPath));
  }

  return args;
}

async function runSignedXcodebuild(
  processRunner: ProcessRunner,
  args: readonly string[],
  stepName: string
): Promise<void> {
  try {
    await processRunner.run("xcodebuild", args);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new SigningError(`${stepName} failed.\n${details}`, error);
  }
}

async function findIpaInDirectory(directoryPath: string): Promise<string> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const ipaEntry = entries.find((entry) => entry.isFile() && entry.name.endsWith(".ipa"));

  if (!ipaEntry) {
    throw new InfrastructureError(
      `xcodebuild export did not produce an .ipa file in: ${directoryPath}`
    );
  }

  return path.join(directoryPath, ipaEntry.name);
}

async function cleanup(paths: readonly string[]): Promise<void> {
  for (const pathToRemove of paths) {
    await rm(pathToRemove, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Custom command
// ---------------------------------------------------------------------------

async function resolveCustomCommand(
  source: CustomCommandIpaSource,
  processRunner: ProcessRunner
): Promise<IpaArtifact> {
  if (!source.buildCommand.trim()) {
    throw new InfrastructureError("buildCommand is required for custom command IPA source.");
  }

  await processRunner.run("zsh", ["-lc", source.buildCommand]);

  const generatedIpaPath = path.resolve(source.generatedIpaPath);
  await access(generatedIpaPath, constants.R_OK).catch((error: unknown) => {
    throw new InfrastructureError(
      `Generated IPA file is not readable: ${generatedIpaPath}`,
      error
    );
  });

  if (!source.outputIpaPath) {
    return { ipaPath: generatedIpaPath };
  }

  const outputIpaPath = path.resolve(source.outputIpaPath);
  await mkdir(path.dirname(outputIpaPath), { recursive: true });
  await copyFile(generatedIpaPath, outputIpaPath);

  return { ipaPath: outputIpaPath };
}
