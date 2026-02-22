#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AppStoreConnectClient, InfrastructureError } from "./api/client.js";
import type { IpaSource } from "./ipa/artifact.js";
import { appsListCommand } from "./commands/apps-list.js";
import { buildsUploadCommand } from "./commands/builds-upload.js";
import { ipaGenerateCommand } from "./commands/ipa-generate.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

interface CliEnvironment {
  readonly issuerId: string;
  readonly keyId: string;
  readonly privateKey: string;
  readonly baseUrl: string;
}

const DEFAULT_BASE_URL = "https://api.appstoreconnect.apple.com/";

export async function resolveCliEnvironment(env: NodeJS.ProcessEnv): Promise<CliEnvironment> {
  const issuerId = env.ASC_ISSUER_ID?.trim();
  const keyId = env.ASC_KEY_ID?.trim();
  const privateKeyPath = env.ASC_PRIVATE_KEY_PATH?.trim();
  const privateKeyRaw = env.ASC_PRIVATE_KEY?.trim();
  const baseUrl = env.ASC_BASE_URL?.trim() || DEFAULT_BASE_URL;

  const missingKeys: string[] = [];

  if (!issuerId) {
    missingKeys.push("ASC_ISSUER_ID");
  }

  if (!keyId) {
    missingKeys.push("ASC_KEY_ID");
  }

  if (!privateKeyPath && !privateKeyRaw) {
    missingKeys.push("ASC_PRIVATE_KEY or ASC_PRIVATE_KEY_PATH");
  }

  if (missingKeys.length > 0) {
    throw new InfrastructureError(
      `Missing required environment variables: ${missingKeys.join(", ")}`
    );
  }

  const privateKey = privateKeyPath
    ? await readPrivateKeyFile(privateKeyPath)
    : normalizePrivateKey(privateKeyRaw!);

  return {
    issuerId: issuerId!,
    keyId: keyId!,
    privateKey,
    baseUrl
  };
}

async function readPrivateKeyFile(filePath: string): Promise<string> {
  try {
    return (await readFile(filePath, "utf-8")).trim();
  } catch (error) {
    throw new InfrastructureError(
      `Failed to read private key file at "${filePath}".`,
      error
    );
  }
}

function normalizePrivateKey(rawValue: string): string {
  return rawValue.includes("\\n") ? rawValue.replace(/\\n/g, "\n") : rawValue;
}

// ---------------------------------------------------------------------------
// Command parser
// ---------------------------------------------------------------------------

interface ParsedFlags {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly booleans: ReadonlySet<string>;
}

export interface AppsListCliCommand {
  readonly kind: "apps-list";
  readonly json: boolean;
}

export interface IpaGenerateCliCommand {
  readonly kind: "ipa-generate";
  readonly json: boolean;
  readonly outputIpaPath: string;
  readonly ipaSource: Exclude<IpaSource, { kind: "prebuilt" }>;
}

export interface BuildsUploadCliCommand {
  readonly kind: "builds-upload";
  readonly json: boolean;
  readonly apply: boolean;
  readonly waitProcessing: boolean;
  readonly appReference: string;
  readonly version: string;
  readonly buildNumber: string;
  readonly ipaSource: IpaSource;
}

export interface HelpCliCommand {
  readonly kind: "help";
}

export type CliCommand =
  | AppsListCliCommand
  | IpaGenerateCliCommand
  | BuildsUploadCliCommand
  | HelpCliCommand;

export function parseCliCommand(argv: readonly string[]): CliCommand {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }

  if (argv.length === 0) {
    return { kind: "apps-list", json: false };
  }

  const [head, next, ...rest] = argv;

  if (head === "apps" && next === "list") {
    const flags = parseFlags(rest);
    return { kind: "apps-list", json: flags.booleans.has("json") };
  }

  if (head === "builds" && next === "upload") {
    const flags = parseFlags(rest);
    return parseBuildsUploadCommand(flags);
  }

  if (head === "ipa" && next === "generate") {
    const flags = parseFlags(rest);
    return parseIpaGenerateCommand(flags);
  }

  throw new InfrastructureError(`Unknown command: ${argv.join(" ")}`);
}

function parseBuildsUploadCommand(flags: ParsedFlags): BuildsUploadCliCommand {
  const appReference = requireFlag(flags, "app");
  const version = requireFlag(flags, "version");
  const buildNumber = requireFlag(flags, "build-number");
  const ipaSource = parseIpaSource(flags, false);

  return {
    kind: "builds-upload",
    json: flags.booleans.has("json"),
    apply: flags.booleans.has("apply"),
    waitProcessing: flags.booleans.has("wait-processing"),
    appReference,
    version,
    buildNumber,
    ipaSource
  };
}

function parseIpaGenerateCommand(flags: ParsedFlags): IpaGenerateCliCommand {
  const outputIpaPath = requireFlag(flags, "output-ipa");
  const ipaSource = parseIpaSource(flags, true);

  if (ipaSource.kind === "prebuilt") {
    throw new InfrastructureError("ipa generate does not support --ipa prebuilt input.");
  }

  return {
    kind: "ipa-generate",
    json: flags.booleans.has("json"),
    outputIpaPath,
    ipaSource
  };
}

function parseIpaSource(flags: ParsedFlags, isGenerateCommand: boolean): IpaSource {
  const ipaPath = flags.values.ipa;
  const hasIpa = Boolean(ipaPath);

  const hasBuildCommand = Boolean(flags.values["build-command"]);
  const hasGeneratedIpaPath = Boolean(flags.values["generated-ipa-path"]);
  const hasCustomCommandInputs = hasBuildCommand || hasGeneratedIpaPath;

  const hasScheme = Boolean(flags.values.scheme);
  const hasExportOptionsPlist = Boolean(flags.values["export-options-plist"]);
  const hasWorkspacePath = Boolean(flags.values["workspace-path"]);
  const hasProjectPath = Boolean(flags.values["project-path"]);
  const hasXcodebuildInputs =
    hasScheme ||
    hasExportOptionsPlist ||
    hasWorkspacePath ||
    hasProjectPath ||
    Boolean(flags.values.configuration) ||
    Boolean(flags.values["archive-path"]) ||
    Boolean(flags.values["derived-data-path"]);

  const sourceModes = [hasIpa, hasCustomCommandInputs, hasXcodebuildInputs].filter(Boolean)
    .length;

  if (sourceModes !== 1) {
    throw new InfrastructureError(
      "Exactly one IPA source mode is required: --ipa, xcodebuild options, or custom command options."
    );
  }

  if (hasIpa) {
    if (hasCustomCommandInputs || hasXcodebuildInputs) {
      throw new InfrastructureError(
        "--ipa cannot be combined with generation options (--scheme/--build-command/etc)."
      );
    }

    return {
      kind: "prebuilt",
      ipaPath: ipaPath!
    };
  }

  if (hasCustomCommandInputs) {
    const buildCommand = requireFlag(flags, "build-command");
    const generatedIpaPath = requireFlag(flags, "generated-ipa-path");
    const outputIpaPath = isGenerateCommand ? requireFlag(flags, "output-ipa") : null;

    return {
      kind: "customCommand",
      buildCommand,
      generatedIpaPath,
      ...(outputIpaPath ? { outputIpaPath } : {})
    };
  }

  const scheme = requireFlag(flags, "scheme");
  const exportOptionsPlist = requireFlag(flags, "export-options-plist");

  if (hasWorkspacePath === hasProjectPath) {
    throw new InfrastructureError(
      "Exactly one of --workspace-path or --project-path is required for xcodebuild mode."
    );
  }

  const outputIpaPath = isGenerateCommand
    ? requireFlag(flags, "output-ipa")
    : flags.values["output-ipa"];

  return {
    kind: "xcodebuild",
    scheme,
    exportOptionsPlist,
    ...(flags.values["workspace-path"] ? { workspacePath: flags.values["workspace-path"] } : {}),
    ...(flags.values["project-path"] ? { projectPath: flags.values["project-path"] } : {}),
    ...(flags.values.configuration ? { configuration: flags.values.configuration } : {}),
    ...(flags.values["archive-path"] ? { archivePath: flags.values["archive-path"] } : {}),
    ...(flags.values["derived-data-path"]
      ? { derivedDataPath: flags.values["derived-data-path"] }
      : {}),
    ...(outputIpaPath ? { outputIpaPath } : {})
  };
}

function parseFlags(argv: readonly string[]): ParsedFlags {
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token) {
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const tokenWithoutPrefix = token.slice(2);
    const equalIndex = tokenWithoutPrefix.indexOf("=");
    const rawFlag =
      equalIndex >= 0
        ? tokenWithoutPrefix.slice(0, equalIndex)
        : tokenWithoutPrefix;
    const rawValue =
      equalIndex >= 0 ? tokenWithoutPrefix.slice(equalIndex + 1) : undefined;
    const flag = rawFlag.trim();

    if (!flag) {
      throw new InfrastructureError(`Invalid flag: ${token}`);
    }

    if (rawValue !== undefined) {
      values[flag] = rawValue;
      continue;
    }

    const nextToken = argv[index + 1];
    if (nextToken && !nextToken.startsWith("--")) {
      values[flag] = nextToken;
      index += 1;
      continue;
    }

    booleans.add(flag);
  }

  return { positionals, values, booleans };
}

function requireFlag(flags: ParsedFlags, name: string): string {
  const value = flags.values[name];

  if (!value || value.trim().length === 0) {
    throw new InfrastructureError(`Missing required option: --${name}`);
  }

  return value;
}

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`appstore-tools CLI

Usage:
  appstore-tools --help
  appstore-tools apps list [--json]
  appstore-tools ipa generate --output-ipa <path> [xcodebuild/custom options] [--json]
  appstore-tools builds upload --app <appId|bundleId> --version <x.y.z> --build-number <n> (--ipa <path> | [generation options]) [--wait-processing] [--json] [--apply]

Required environment variables:
  ASC_ISSUER_ID
  ASC_KEY_ID
  ASC_PRIVATE_KEY or ASC_PRIVATE_KEY_PATH

Optional environment variables:
  ASC_BASE_URL (default: https://api.appstoreconnect.apple.com/)

Generation options (xcodebuild mode):
  --scheme <name> --export-options-plist <path> (--workspace-path <path> | --project-path <path>)
  [--configuration <Release>] [--archive-path <path>] [--derived-data-path <path>] [--output-ipa <path>]

Generation options (custom mode):
  --build-command "<shell command>" --generated-ipa-path <path> [--output-ipa <path>]
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<number> {
  try {
    const command = parseCliCommand(argv);
    return handleCliCommand(command, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CLI error";
    console.error(message);
    return 1;
  }
}

async function handleCliCommand(
  command: CliCommand,
  env: NodeJS.ProcessEnv
): Promise<number> {
  if (command.kind === "help") {
    printHelp();
    return 0;
  }

  if (command.kind === "ipa-generate") {
    return ipaGenerateCommand(command);
  }

  const config = await resolveCliEnvironment(env);
  const client = new AppStoreConnectClient({
    issuerId: config.issuerId,
    keyId: config.keyId,
    privateKey: config.privateKey
  }, {
    baseUrl: config.baseUrl
  });

  if (command.kind === "apps-list") {
    return appsListCommand(client, { json: command.json });
  }

  if (command.kind === "builds-upload") {
    return buildsUploadCommand(client, command);
  }

  return assertNever(command);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported command payload: ${JSON.stringify(value)}`);
}

async function isExecutedAsScript(): Promise<boolean> {
  const executedPath = process.argv[1];

  if (!executedPath) {
    return false;
  }

  const resolvedPath = await realpath(executedPath);
  return import.meta.url === pathToFileURL(resolvedPath).href;
}

if (await isExecutedAsScript()) {
  const exitCode = await runCli(process.argv.slice(2), process.env);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
