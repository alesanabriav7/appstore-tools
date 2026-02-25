#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";

import { AppStoreConnectClient, InfrastructureError } from "./api/client.js";
import type { IpaSource } from "./ipa/artifact.js";
import { resolveAscKeyIdFromEnvironment } from "./asc/key-id.js";
import { appsListCommand } from "./commands/apps-list.js";
import { appsUpdateMetadataCommand } from "./commands/apps-update-metadata.js";
import { buildsUploadCommand } from "./commands/builds-upload.js";
import { certificatesCreateCommand } from "./commands/certificates-create.js";
import { ipaExportOptionsCommand } from "./commands/ipa-export-options.js";
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
  const keyId = await resolveAscKeyIdFromEnvironment(env);
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
  readonly outputIpaPath?: string;
  readonly ipaSource?: Exclude<IpaSource, { kind: "prebuilt" }>;
}

export interface IpaExportOptionsCliCommand {
  readonly kind: "ipa-export-options";
  readonly json: boolean;
  readonly outputPlistPath?: string;
  readonly teamId?: string;
  readonly signingStyle?: "automatic" | "manual";
  readonly force: boolean;
}

export interface BuildsUploadCliCommand {
  readonly kind: "builds-upload";
  readonly json: boolean;
  readonly apply: boolean;
  readonly waitProcessing: boolean;
  readonly appReference?: string;
  readonly version?: string;
  readonly buildNumber?: string;
  readonly ipaSource?: IpaSource;
}

export interface AppsUpdateMetadataCliCommand {
  readonly kind: "apps-update-metadata";
  readonly json: boolean;
  readonly apply: boolean;
  readonly appReference: string;
  readonly metadataPath: string;
  readonly version?: string;
  readonly platform: "IOS" | "MAC_OS";
  readonly textOnly: boolean;
  readonly screenshotsOnly: boolean;
}

export interface CertificatesCreateCliCommand {
  readonly kind: "certificates-create";
  readonly json: boolean;
  readonly skipInstall: boolean;
  readonly certificateType?: string;
  readonly commonName?: string;
  readonly outputDir?: string;
  readonly keychainPath?: string;
}

export interface HelpCliCommand {
  readonly kind: "help";
}

export type CliCommand =
  | AppsListCliCommand
  | AppsUpdateMetadataCliCommand
  | IpaGenerateCliCommand
  | IpaExportOptionsCliCommand
  | BuildsUploadCliCommand
  | CertificatesCreateCliCommand
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

  if (head === "apps" && next === "update-metadata") {
    const flags = parseFlags(rest);
    return parseAppsUpdateMetadataCommand(flags);
  }

  if (head === "builds" && next === "upload") {
    const flags = parseFlags(rest);
    return parseBuildsUploadCommand(flags);
  }

  if (head === "ipa" && next === "generate") {
    const flags = parseFlags(rest);
    return parseIpaGenerateCommand(flags);
  }

  if (head === "ipa" && next === "export-options") {
    const flags = parseFlags(rest);
    return parseIpaExportOptionsCommand(flags);
  }

  if (head === "certificates" && next === "create") {
    const flags = parseFlags(rest);
    return parseCertificatesCreateCommand(flags);
  }

  throw new InfrastructureError(`Unknown command: ${argv.join(" ")}`);
}

function parseBuildsUploadCommand(flags: ParsedFlags): BuildsUploadCliCommand {
  const appReference = normalizeOptionalFlag(flags.values.app);
  const version = normalizeOptionalFlag(flags.values.version);
  const buildNumber = normalizeOptionalFlag(flags.values["build-number"]);
  const ipaSource = parseIpaSource(flags, false, { allowNone: true });

  return {
    kind: "builds-upload",
    json: flags.booleans.has("json"),
    apply: flags.booleans.has("apply"),
    waitProcessing: flags.booleans.has("wait-processing"),
    ...(appReference ? { appReference } : {}),
    ...(version ? { version } : {}),
    ...(buildNumber ? { buildNumber } : {}),
    ...(ipaSource ? { ipaSource } : {})
  };
}

function parseIpaGenerateCommand(flags: ParsedFlags): IpaGenerateCliCommand {
  const outputIpaPath = normalizeOptionalFlag(flags.values["output-ipa"]);
  const ipaSource = parseIpaSource(flags, true, { allowNone: true });

  if (ipaSource?.kind === "prebuilt") {
    throw new InfrastructureError("ipa generate does not support --ipa prebuilt input.");
  }

  return {
    kind: "ipa-generate",
    json: flags.booleans.has("json"),
    ...(outputIpaPath ? { outputIpaPath } : {}),
    ...(ipaSource ? { ipaSource } : {})
  };
}

function parseIpaExportOptionsCommand(flags: ParsedFlags): IpaExportOptionsCliCommand {
  const outputPlistPath = normalizeOptionalFlag(flags.values["output-plist"]);
  const teamId = normalizeOptionalFlag(flags.values["team-id"]);
  const signingStyleRaw = normalizeOptionalFlag(flags.values["signing-style"]);
  const signingStyle = signingStyleRaw ?? "automatic";

  if (signingStyle !== "automatic" && signingStyle !== "manual") {
    throw new InfrastructureError(
      "Invalid --signing-style. Allowed values: automatic, manual."
    );
  }

  return {
    kind: "ipa-export-options",
    json: flags.booleans.has("json"),
    force: flags.booleans.has("force"),
    ...(outputPlistPath ? { outputPlistPath } : {}),
    ...(teamId ? { teamId } : {}),
    ...(signingStyleRaw ? { signingStyle } : {})
  };
}

function parseCertificatesCreateCommand(flags: ParsedFlags): CertificatesCreateCliCommand {
  const certificateType = normalizeOptionalFlag(flags.values.type);
  const commonName = normalizeOptionalFlag(flags.values["common-name"]);
  const outputDir = normalizeOptionalFlag(flags.values["output-dir"]);
  const keychainPath = normalizeOptionalFlag(flags.values.keychain);

  return {
    kind: "certificates-create",
    json: flags.booleans.has("json"),
    skipInstall: flags.booleans.has("skip-install"),
    ...(certificateType ? { certificateType } : {}),
    ...(commonName ? { commonName } : {}),
    ...(outputDir ? { outputDir } : {}),
    ...(keychainPath ? { keychainPath } : {})
  };
}

function parseAppsUpdateMetadataCommand(flags: ParsedFlags): AppsUpdateMetadataCliCommand {
  const metadataPath = requireFlag(flags, "metadata");
  const appReference = requireFlag(flags, "app");
  const version = normalizeOptionalFlag(flags.values.version);
  const platformRaw = normalizeOptionalFlag(flags.values.platform) ?? "IOS";

  if (platformRaw !== "IOS" && platformRaw !== "MAC_OS") {
    throw new InfrastructureError(
      "Invalid --platform. Allowed values: IOS, MAC_OS."
    );
  }

  return {
    kind: "apps-update-metadata",
    json: flags.booleans.has("json"),
    apply: flags.booleans.has("apply"),
    appReference,
    metadataPath,
    textOnly: flags.booleans.has("text-only"),
    screenshotsOnly: flags.booleans.has("screenshots-only"),
    ...(version ? { version } : {}),
    platform: platformRaw
  };
}

function parseIpaSource(
  flags: ParsedFlags,
  isGenerateCommand: boolean,
  options: { readonly allowNone?: boolean } = {}
): IpaSource | undefined {
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

  if (sourceModes === 0 && options.allowNone) {
    return undefined;
  }

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
    const outputIpaPath = isGenerateCommand ? normalizeOptionalFlag(flags.values["output-ipa"]) : null;

    return {
      kind: "customCommand",
      buildCommand,
      generatedIpaPath,
      ...(outputIpaPath ? { outputIpaPath } : {})
    };
  }

  const scheme = requireFlag(flags, "scheme");
  const exportOptionsPlist = normalizeOptionalFlag(flags.values["export-options-plist"]);

  if (hasWorkspacePath === hasProjectPath) {
    throw new InfrastructureError(
      "Exactly one of --workspace-path or --project-path is required for xcodebuild mode."
    );
  }

  const outputIpaPath = normalizeOptionalFlag(flags.values["output-ipa"]);

  return {
    kind: "xcodebuild",
    scheme,
    ...(exportOptionsPlist ? { exportOptionsPlist } : {}),
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

function normalizeOptionalFlag(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  appstore-tools ipa generate [--output-ipa <path>] [xcodebuild/custom options] [--json]
  appstore-tools ipa export-options [--output-plist <path>] [--team-id <id>] [--signing-style <automatic|manual>] [--force] [--json]
  appstore-tools apps update-metadata --metadata <path> --app <appId|bundleId> [--version <x.y.z>] [--platform <IOS|MAC_OS>] [--text-only] [--screenshots-only] [--json] [--apply]
  appstore-tools builds upload [--app <appId|bundleId>] [--version <x.y.z>] [--build-number <n>] [--ipa <path> | generation options] [--wait-processing] [--json] [--apply]
  appstore-tools certificates create [--type <certificateType>] [--common-name <name>] [--output-dir <path>] [--keychain <path>] [--skip-install] [--json]

Required environment variables (App Store Connect API commands):
  ASC_ISSUER_ID
  ASC_KEY_ID (or infer from AuthKey_<KEY_ID>.p8)
  ASC_PRIVATE_KEY or ASC_PRIVATE_KEY_PATH

Optional environment variables:
  ASC_BASE_URL (default: https://api.appstoreconnect.apple.com/)

Required environment variables (xcodebuild archive signing):
  ASC_ISSUER_ID
  ASC_KEY_ID (or infer from AuthKey_<KEY_ID>.p8)
  ASC_KEY_PATH or ASC_KEY_CONTENT (base64)

Optional environment variables (xcodebuild archive signing):
  ASC_TEAM_ID

Generation options (xcodebuild mode):
  --scheme <name> (--workspace-path <path> | --project-path <path>) [--export-options-plist <path>]
  [--configuration <Release>] [--archive-path <path>] [--derived-data-path <path>] [--output-ipa <path>]

Generation options (custom mode):
  --build-command "<shell command>" --generated-ipa-path <path> [--output-ipa <path>]

Export options template generation:
  ipa export-options writes a TestFlight/App Store template (method=app-store).
  Defaults: --output-plist ./ExportOptions.plist and --signing-style automatic.

builds upload auto-detection:
  If omitted, --app/--version/--build-number are inferred from IPA metadata.
  If no IPA source is provided, the CLI tries local .ipa files first, then xcodebuild project discovery.

ipa generate auto-detection:
  If no source options are provided, the CLI infers xcodebuild inputs from local project files.
  If no ExportOptions.plist is available, one is generated automatically.
  If --output-ipa is omitted, output defaults to ./dist/<scheme>.ipa.

certificates create:
  Generates a new RSA private key + CSR, creates certificate via /v1/certificates, saves .key/.csr/.cer to ./dist/certificates.
  Installs certificate + private key into login keychain by default (use --skip-install to disable).
  Default certificate type: IOS_DISTRIBUTION.
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

  if (command.kind === "ipa-export-options") {
    return ipaExportOptionsCommand(command);
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

  if (command.kind === "apps-update-metadata") {
    return appsUpdateMetadataCommand(client, command);
  }

  if (command.kind === "builds-upload") {
    return buildsUploadCommand(client, command);
  }

  if (command.kind === "certificates-create") {
    return certificatesCreateCommand(client, command);
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
  loadDotenv();
  const exitCode = await runCli(process.argv.slice(2), process.env);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
