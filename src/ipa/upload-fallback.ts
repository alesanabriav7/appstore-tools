import { InfrastructureError } from "../api/client.js";
import { defaultProcessRunner, type ProcessRunner } from "./artifact.js";

export type FallbackUploadMethod = "xcrun altool" | "xcrun iTMSTransporter";

export interface FallbackUploadCredentials {
  readonly keyId: string;
  readonly issuerId: string;
  readonly privateKeyPath?: string;
  readonly privateKey?: string;
}

export async function uploadWithXcrunFallback(
  ipaPath: string,
  options?: {
    readonly processRunner?: ProcessRunner;
    readonly credentials?: FallbackUploadCredentials;
    readonly env?: NodeJS.ProcessEnv;
  }
): Promise<FallbackUploadMethod> {
  const processRunner = options?.processRunner ?? defaultProcessRunner;
  const credentials = resolveFallbackCredentials(options?.credentials, options?.env);
  const altoolArgs = createAltoolArgs(ipaPath, credentials);

  try {
    await processRunner.run("xcrun", altoolArgs);
    return "xcrun altool";
  } catch (altoolError) {
    const transporterArgs = createTransporterArgs(ipaPath, credentials);

    try {
      await processRunner.run("xcrun", transporterArgs);
      return "xcrun iTMSTransporter";
    } catch (transporterError) {
      throw new InfrastructureError(
        [
          "Checksum marking failed and xcrun fallback upload was unsuccessful.",
          "Tried: xcrun altool, xcrun iTMSTransporter.",
          `altool error: ${toErrorMessage(altoolError)}`,
          `transporter error: ${toErrorMessage(transporterError)}`
        ].join("\n"),
        transporterError
      );
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

function createAltoolArgs(ipaPath: string, credentials: FallbackUploadCredentials): string[] {
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
    return args;
  }

  if (credentials.privateKey) {
    args.push("--auth-string", toAuthString(credentials.privateKey));
  }

  return args;
}

function createTransporterArgs(
  ipaPath: string,
  credentials: FallbackUploadCredentials
): string[] {
  return [
    "iTMSTransporter",
    "-m",
    "upload",
    "-assetFile",
    ipaPath,
    "-apiKey",
    credentials.keyId,
    "-apiIssuer",
    credentials.issuerId
  ];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function toAuthString(privateKey: string): string {
  return privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
}
