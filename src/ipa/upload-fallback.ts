import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { InfrastructureError } from "../api/client.js";
import { defaultProcessRunner, type ProcessRunner } from "./artifact.js";

export type FallbackUploadMethod =
  | "xcrun altool"
  | "App Store Connect API";

export interface FallbackUploadCredentials {
  readonly keyId: string;
  readonly issuerId: string;
  readonly privateKeyPath?: string;
  readonly privateKey?: string;
}

export async function uploadWithXcrunAltool(
  ipaPath: string,
  options?: {
    readonly processRunner?: ProcessRunner;
    readonly credentials?: FallbackUploadCredentials;
    readonly env?: NodeJS.ProcessEnv;
    readonly waitForProcessing?: boolean;
  }
): Promise<{ readonly method: "xcrun altool"; readonly waitApplied: boolean }> {
  const processRunner = options?.processRunner ?? defaultProcessRunner;
  const credentials = resolveFallbackCredentials(options?.credentials, options?.env);
  const waitForProcessing = options?.waitForProcessing ?? false;
  const materializedCredentials = await materializeAltoolPrivateKey(credentials);
  let runError: unknown;

  try {
    const altoolArgs = createAltoolArgs(
      ipaPath,
      materializedCredentials.credentials,
      waitForProcessing
    );

    await processRunner.run("xcrun", altoolArgs);

    return {
      method: "xcrun altool",
      waitApplied: waitForProcessing
    };
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    try {
      await materializedCredentials.cleanup();
    } catch (cleanupError) {
      if (!runError) {
        throw new InfrastructureError(
          "Failed to clean up temporary private key file for altool upload.",
          cleanupError
        );
      }
    }
  }
}

function resolveFallbackCredentials(
  credentials: FallbackUploadCredentials | undefined,
  env: NodeJS.ProcessEnv | undefined
): FallbackUploadCredentials {
  const sourceEnv = env ?? process.env;
  const keyId = credentials?.keyId ?? sourceEnv.ASC_KEY_ID?.trim();
  const issuerId = credentials?.issuerId ?? sourceEnv.ASC_ISSUER_ID?.trim();
  const privateKeyPath =
    credentials?.privateKeyPath ??
    sourceEnv.ASC_PRIVATE_KEY_PATH?.trim() ??
    sourceEnv.ASC_KEY_PATH?.trim();
  const privateKey = credentials?.privateKey ?? sourceEnv.ASC_PRIVATE_KEY?.trim();

  if (!keyId || !issuerId) {
    throw new InfrastructureError(
      "Fallback upload requires ASC_KEY_ID and ASC_ISSUER_ID."
    );
  }

  return {
    keyId,
    issuerId,
    ...(privateKeyPath ? { privateKeyPath } : {}),
    ...(privateKey ? { privateKey } : {})
  };
}

function createAltoolArgs(
  ipaPath: string,
  credentials: FallbackUploadCredentials,
  waitForProcessing: boolean
): string[] {
  const args = [
    "altool",
    "--upload-app",
    "--type",
    "ios",
    "--file",
    ipaPath,
    "--api-key",
    credentials.keyId,
    "--api-issuer",
    credentials.issuerId
  ];

  if (credentials.privateKeyPath) {
    args.push("--p8-file-path", credentials.privateKeyPath);
  }

  if (waitForProcessing) {
    args.push("--wait");
  }

  return args;
}

async function materializeAltoolPrivateKey(
  credentials: FallbackUploadCredentials
): Promise<{
  readonly credentials: FallbackUploadCredentials;
  readonly cleanup: () => Promise<void>;
}> {
  if (credentials.privateKeyPath || !credentials.privateKey) {
    return {
      credentials,
      cleanup: async () => undefined
    };
  }

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "asc-altool-key-"));
  const tempPrivateKeyPath = path.join(tempDirectory, `AuthKey_${credentials.keyId}.p8`);
  const normalizedPrivateKey = normalizePrivateKey(credentials.privateKey);

  await writeFile(tempPrivateKeyPath, normalizedPrivateKey, {
    encoding: "utf8",
    mode: 0o600
  });

  return {
    credentials: {
      keyId: credentials.keyId,
      issuerId: credentials.issuerId,
      privateKeyPath: tempPrivateKeyPath
    },
    cleanup: async () => {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  };
}

function normalizePrivateKey(privateKey: string): string {
  const normalized = privateKey.includes("\\n")
    ? privateKey.replace(/\\n/g, "\n")
    : privateKey;

  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}
