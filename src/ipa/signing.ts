import { access, chmod, constants, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { InfrastructureError } from "../api/client.js";

export class SigningError extends InfrastructureError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "SigningError";
  }
}

export type SigningStyle = "automatic" | "manual";

const EXIT_CLEANUP_PATHS = new Set<string>();
let cleanupHandlersRegistered = false;

function registerExitCleanupHandlers(): void {
  if (cleanupHandlersRegistered) {
    return;
  }

  cleanupHandlersRegistered = true;

  process.on("exit", () => {
    for (const filePath of EXIT_CLEANUP_PATHS) {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // Ignore cleanup failures during process shutdown.
      }
    }
  });
}

function registerExitCleanupPath(filePath: string): void {
  registerExitCleanupHandlers();
  EXIT_CLEANUP_PATHS.add(filePath);
}

function unregisterExitCleanupPath(filePath: string): void {
  EXIT_CLEANUP_PATHS.delete(filePath);
}

function normalizeRequiredEnvValue(
  env: NodeJS.ProcessEnv,
  key: "ASC_KEY_ID" | "ASC_ISSUER_ID"
): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new SigningError(`Missing required environment variable: ${key}`);
  }

  return value;
}

function decodeBase64Strict(base64Value: string): Buffer {
  const normalized = base64Value.trim().replace(/\s+/g, "");
  const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

  if (!normalized || !validBase64.test(normalized)) {
    throw new SigningError("ASC_KEY_CONTENT must be valid base64.");
  }

  return Buffer.from(normalized, "base64");
}

export interface ArchiveAuthenticationContext {
  readonly authenticationKeyPath: string;
  readonly authenticationKeyID: string;
  readonly authenticationKeyIssuerID: string;
  readonly cleanup: () => Promise<void>;
}

export async function resolveArchiveAuthenticationContext(
  env: NodeJS.ProcessEnv = process.env
): Promise<ArchiveAuthenticationContext> {
  const keyId = normalizeRequiredEnvValue(env, "ASC_KEY_ID");
  const issuerId = normalizeRequiredEnvValue(env, "ASC_ISSUER_ID");

  const keyPathFromEnv = env.ASC_KEY_PATH?.trim();

  if (keyPathFromEnv) {
    const resolvedPath = path.resolve(keyPathFromEnv);
    await access(resolvedPath, constants.R_OK).catch((error: unknown) => {
      throw new SigningError(`ASC_KEY_PATH is not readable: ${resolvedPath}`, error);
    });

    return {
      authenticationKeyPath: resolvedPath,
      authenticationKeyID: keyId,
      authenticationKeyIssuerID: issuerId,
      cleanup: async () => undefined
    };
  }

  const keyContent = env.ASC_KEY_CONTENT?.trim();

  if (!keyContent) {
    throw new SigningError(
      "Missing signing key source. Set ASC_KEY_PATH or ASC_KEY_CONTENT (base64)."
    );
  }

  const keyBytes = decodeBase64Strict(keyContent);
  const tempKeyPath = path.join(os.tmpdir(), `AuthKey_${keyId}.p8`);

  await writeFile(tempKeyPath, keyBytes);
  await chmod(tempKeyPath, 0o600);
  registerExitCleanupPath(tempKeyPath);

  return {
    authenticationKeyPath: tempKeyPath,
    authenticationKeyID: keyId,
    authenticationKeyIssuerID: issuerId,
    cleanup: async () => {
      unregisterExitCleanupPath(tempKeyPath);
      await rm(tempKeyPath, { force: true });
    }
  };
}

export function createExportOptionsPlist(input: {
  readonly signingStyle: SigningStyle;
  readonly teamId?: string;
}): string {
  const lines = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>method</key>",
    "  <string>app-store</string>",
    "  <key>destination</key>",
    "  <string>export</string>",
    "  <key>signingStyle</key>",
    `  <string>${input.signingStyle}</string>`,
    "  <key>uploadSymbols</key>",
    "  <true/>",
    "  <key>stripSwiftSymbols</key>",
    "  <true/>",
    "  <key>manageAppVersionAndBuildNumber</key>",
    "  <true/>"
  ];

  if (input.teamId) {
    lines.push("  <key>teamID</key>");
    lines.push(`  <string>${escapeXml(input.teamId)}</string>`);
  }

  lines.push("</dict>");
  lines.push("</plist>");
  lines.push("");

  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface ExportOptionsContext {
  readonly exportOptionsPlistPath: string;
  readonly cleanup: () => Promise<void>;
  readonly generated: boolean;
}

export async function resolveOrCreateExportOptionsPlist(
  providedPath: string | undefined,
  temporaryDirectory: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ExportOptionsContext> {
  const explicitPath = providedPath?.trim() ? path.resolve(providedPath) : undefined;

  if (explicitPath) {
    const readable = await access(explicitPath, constants.R_OK)
      .then(() => true)
      .catch(() => false);

    if (readable) {
      return {
        exportOptionsPlistPath: explicitPath,
        cleanup: async () => undefined,
        generated: false
      };
    }
  }

  const defaultPath = path.resolve(process.cwd(), "ExportOptions.plist");
  const hasDefault = await access(defaultPath, constants.R_OK)
    .then(() => true)
    .catch(() => false);

  if (!explicitPath && hasDefault) {
    return {
      exportOptionsPlistPath: defaultPath,
      cleanup: async () => undefined,
      generated: false
    };
  }

  const teamId = env.ASC_TEAM_ID?.trim();
  const generatedPath = path.join(temporaryDirectory, "ExportOptions.generated.plist");
  const plistContents = createExportOptionsPlist({
    signingStyle: "automatic",
    ...(teamId ? { teamId } : {})
  });

  await writeFile(generatedPath, plistContents, "utf8");

  return {
    exportOptionsPlistPath: generatedPath,
    cleanup: async () => {
      await rm(generatedPath, { force: true });
    },
    generated: true
  };
}
