import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

import { InfrastructureError, type AppStoreConnectClient } from "../api/client.js";
import { defaultProcessRunner, type ProcessRunner } from "../ipa/artifact.js";

// ---------------------------------------------------------------------------
// API response types (inline)
// ---------------------------------------------------------------------------

interface CertificateCreateResponse {
  readonly data: {
    readonly id?: string;
    readonly attributes?: {
      readonly certificateContent?: string;
      readonly certificateType?: string;
      readonly expirationDate?: string;
      readonly serialNumber?: string;
      readonly name?: string;
    };
  };
}

interface CertificateSummary {
  readonly id: string;
  readonly certificateContent: string;
  readonly certificateType: string;
  readonly expirationDate?: string;
  readonly serialNumber?: string;
  readonly name?: string;
}

export interface CertificatesCreateCommandInput {
  readonly json: boolean;
  readonly certificateType?: string;
  readonly commonName?: string;
  readonly outputDir?: string;
  readonly keychainPath?: string;
  readonly skipInstall: boolean;
}

interface CertificatesCreateResult {
  readonly id: string;
  readonly certificateType: string;
  readonly expirationDate?: string;
  readonly serialNumber?: string;
  readonly name?: string;
  readonly keyPath: string;
  readonly csrPath: string;
  readonly certificatePath: string;
  readonly keychainPath: string | null;
  readonly installed: boolean;
}

const DEFAULT_CERTIFICATE_TYPE = "IOS_DISTRIBUTION";
const DEFAULT_COMMON_NAME = "CLI Certificate";
const DEFAULT_OUTPUT_DIR = "./dist/certificates";
const DEFAULT_LOGIN_KEYCHAIN_PATH = path.join(homedir(), "Library/Keychains/login.keychain-db");

export async function certificatesCreateCommand(
  client: AppStoreConnectClient,
  command: CertificatesCreateCommandInput,
  options?: {
    readonly processRunner?: ProcessRunner;
  }
): Promise<number> {
  const processRunner = options?.processRunner ?? defaultProcessRunner;
  const certificateType = normalizeCertificateType(command.certificateType);
  const commonName = normalizeCommonName(command.commonName);
  const outputDir = resolveUserPath(command.outputDir ?? DEFAULT_OUTPUT_DIR);
  const keychainPath = resolveUserPath(command.keychainPath ?? DEFAULT_LOGIN_KEYCHAIN_PATH);

  await mkdir(outputDir, { recursive: true });

  const filePrefix = `${sanitizeFileName(certificateType.toLowerCase())}-${Date.now()}`;
  const keyPath = path.join(outputDir, `${filePrefix}.key`);
  const csrPath = path.join(outputDir, `${filePrefix}.csr`);
  const certificatePath = path.join(outputDir, `${filePrefix}.cer`);

  const tempDirectory = await mkdtemp(path.join(tmpdir(), "asc-cert-"));
  const csrDerPath = path.join(tempDirectory, "certificate.csr.der");

  try {
    await processRunner.run("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      csrPath,
      "-subj",
      `/CN=${commonName}`
    ]);

    await processRunner.run("openssl", [
      "req",
      "-in",
      csrPath,
      "-outform",
      "DER",
      "-out",
      csrDerPath
    ]);

    const csrContent = (await readFile(csrDerPath)).toString("base64");
    const certificate = await createCertificate(client, {
      csrContent,
      certificateType
    });
    const certificateBytes = decodeBase64OrThrow(
      certificate.certificateContent,
      "certificate content"
    );

    await writeFile(certificatePath, certificateBytes);

    if (!command.skipInstall) {
      await processRunner.run("security", ["import", certificatePath, "-k", keychainPath]);
      await processRunner.run("security", ["import", keyPath, "-k", keychainPath]);
    }

    const result: CertificatesCreateResult = {
      id: certificate.id,
      certificateType: certificate.certificateType,
      keyPath,
      csrPath,
      certificatePath,
      keychainPath: command.skipInstall ? null : keychainPath,
      installed: !command.skipInstall,
      ...(certificate.expirationDate ? { expirationDate: certificate.expirationDate } : {}),
      ...(certificate.serialNumber ? { serialNumber: certificate.serialNumber } : {}),
      ...(certificate.name ? { name: certificate.name } : {})
    };

    if (command.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    console.log(`Created certificate: ${result.id}`);
    console.log(`Type: ${result.certificateType}`);
    console.log(`Expires: ${result.expirationDate ?? "unknown"}`);
    console.log(`Private key: ${result.keyPath}`);
    console.log(`CSR: ${result.csrPath}`);
    console.log(`Certificate: ${result.certificatePath}`);

    if (result.installed) {
      console.log(`Installed into keychain: ${result.keychainPath}`);
    } else {
      console.log("Installation skipped (--skip-install).");
    }

    return 0;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function createCertificate(
  client: AppStoreConnectClient,
  input: {
    readonly csrContent: string;
    readonly certificateType: string;
  }
): Promise<CertificateSummary> {
  const response = await client.request<CertificateCreateResponse>({
    method: "POST",
    path: "/v1/certificates",
    body: {
      data: {
        type: "certificates",
        attributes: {
          csrContent: input.csrContent,
          certificateType: input.certificateType
        }
      }
    }
  });

  const id = response.data.data.id;
  const attributes = response.data.data.attributes;
  const certificateContent = attributes?.certificateContent;

  if (!id || !certificateContent) {
    throw new InfrastructureError(
      "Malformed certificate create payload received from App Store Connect."
    );
  }

  return {
    id,
    certificateContent,
    certificateType: attributes.certificateType ?? input.certificateType,
    ...(attributes.expirationDate ? { expirationDate: attributes.expirationDate } : {}),
    ...(attributes.serialNumber ? { serialNumber: attributes.serialNumber } : {}),
    ...(attributes.name ? { name: attributes.name } : {})
  };
}

function normalizeCertificateType(value: string | undefined): string {
  const resolved = value?.trim() ?? DEFAULT_CERTIFICATE_TYPE;

  if (resolved.length === 0) {
    throw new InfrastructureError("Certificate type cannot be empty.");
  }

  return resolved.toUpperCase();
}

function normalizeCommonName(value: string | undefined): string {
  const resolved = value?.trim() ?? DEFAULT_COMMON_NAME;

  if (resolved.length === 0) {
    throw new InfrastructureError("Common name cannot be empty.");
  }

  return resolved;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-z0-9-_]+/gi, "-");
}

function resolveUserPath(inputPath: string): string {
  if (inputPath === "~") {
    return homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(homedir(), inputPath.slice(2));
  }

  return path.resolve(inputPath);
}

function decodeBase64OrThrow(value: string, context: string): Buffer {
  try {
    return Buffer.from(value, "base64");
  } catch (error) {
    throw new InfrastructureError(`Failed to decode ${context} as base64.`, error);
  }
}
