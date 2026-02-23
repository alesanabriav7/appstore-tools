import {
  DomainError,
  InfrastructureError,
  type AppStoreConnectClient
} from "../api/client.js";
import {
  executeUploadOperations,
  parseUploadOperations,
  type UploadOperation
} from "../api/types.js";
import { resolveIpaArtifact, type IpaSource, type ProcessRunner } from "../ipa/artifact.js";
import { autoDetectIpaSource } from "../ipa/autodetect.js";
import { verifyIpa } from "../ipa/preflight.js";
import {
  uploadWithXcrunFallback,
  type FallbackUploadCredentials,
  type FallbackUploadMethod
} from "../ipa/upload-fallback.js";
import { listApps, type AppSummary } from "./apps-list.js";

// ---------------------------------------------------------------------------
// API response types (inline)
// ---------------------------------------------------------------------------

interface BuildUploadStateDetail {
  readonly code?: string;
  readonly description?: string;
}

interface BuildUploadState {
  readonly state?: string;
  readonly errors?: readonly BuildUploadStateDetail[];
  readonly warnings?: readonly BuildUploadStateDetail[];
  readonly infos?: readonly BuildUploadStateDetail[];
}

interface BuildUploadResponse {
  readonly data: {
    readonly id?: string;
    readonly attributes?: {
      readonly state?: BuildUploadState;
    };
  };
}

interface BuildUploadFileResponse {
  readonly data: {
    readonly id?: string;
    readonly attributes?: {
      readonly uploadOperations?: readonly {
        readonly method?: string;
        readonly url?: string;
        readonly offset?: number;
        readonly length?: number;
        readonly requestHeaders?: readonly {
          readonly name?: string;
          readonly value?: string;
        }[];
      }[];
    };
  };
}

// ---------------------------------------------------------------------------
// Internal summary types
// ---------------------------------------------------------------------------

interface BuildUploadSummary {
  readonly id: string;
  readonly state: {
    readonly state: string;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
    readonly infos: readonly string[];
  };
}

interface BuildUploadFileSummary {
  readonly id: string;
  readonly uploadOperations: readonly UploadOperation[];
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function mapBuildUpload(response: BuildUploadResponse): BuildUploadSummary {
  const data = response.data;
  const id = data.id;

  if (!id) {
    throw new InfrastructureError("Malformed build upload payload: missing id.");
  }

  const stateValue = data.attributes?.state?.state;

  if (!stateValue) {
    throw new InfrastructureError("Malformed build upload payload: missing state.");
  }

  const stateObj = data.attributes?.state;

  return {
    id,
    state: {
      state: stateValue,
      errors: (stateObj?.errors ?? []).map((item) => item.description ?? "Unknown error"),
      warnings: (stateObj?.warnings ?? []).map((item) => item.description ?? "Unknown warning"),
      infos: (stateObj?.infos ?? []).map((item) => item.description ?? "Unknown info")
    }
  };
}

async function createBuildUpload(
  client: AppStoreConnectClient,
  input: {
    readonly appId: string;
    readonly versionString: string;
    readonly buildNumber: string;
    readonly platform: "IOS";
  }
): Promise<BuildUploadSummary> {
  const response = await client.request<BuildUploadResponse>({
    method: "POST",
    path: "/v1/buildUploads",
    body: {
      data: {
        type: "buildUploads",
        attributes: {
          cfBundleShortVersionString: input.versionString,
          cfBundleVersion: input.buildNumber,
          platform: input.platform
        },
        relationships: {
          app: {
            data: {
              type: "apps",
              id: input.appId
            }
          }
        }
      }
    }
  });

  return mapBuildUpload(response.data);
}

async function createBuildUploadFile(
  client: AppStoreConnectClient,
  input: {
    readonly buildUploadId: string;
    readonly fileName: string;
    readonly fileSize: number;
    readonly uti: "com.apple.ipa";
    readonly assetType: "ASSET";
  }
): Promise<BuildUploadFileSummary> {
  const response = await client.request<BuildUploadFileResponse>({
    method: "POST",
    path: "/v1/buildUploadFiles",
    body: {
      data: {
        type: "buildUploadFiles",
        attributes: {
          assetType: input.assetType,
          fileName: input.fileName,
          fileSize: input.fileSize,
          uti: input.uti
        },
        relationships: {
          buildUpload: {
            data: {
              type: "buildUploads",
              id: input.buildUploadId
            }
          }
        }
      }
    }
  });

  const id = response.data.data.id;
  const operationsPayload = response.data.data.attributes?.uploadOperations ?? [];

  if (!id) {
    throw new InfrastructureError("Malformed build upload file payload: missing id.");
  }

  return {
    id,
    uploadOperations: parseUploadOperations(operationsPayload, "build upload file")
  };
}

async function markBuildUploadFileUploaded(
  client: AppStoreConnectClient,
  input: {
    readonly buildUploadFileId: string;
    readonly sha256: string;
    readonly md5: string;
  }
): Promise<void> {
  await client.request<void>({
    method: "PATCH",
    path: `/v1/buildUploadFiles/${input.buildUploadFileId}`,
    body: {
      data: {
        type: "buildUploadFiles",
        id: input.buildUploadFileId,
        attributes: {
          sourceFileChecksums: {
            file: {
              hash: input.sha256,
              algorithm: "SHA_256"
            },
            composite: {
              hash: input.md5,
              algorithm: "MD5"
            }
          },
          uploaded: true
        }
      }
    }
  });
}

async function getBuildUpload(
  client: AppStoreConnectClient,
  buildUploadId: string
): Promise<BuildUploadSummary> {
  const response = await client.request<BuildUploadResponse>({
    method: "GET",
    path: `/v1/buildUploads/${buildUploadId}`,
    query: {
      "fields[buildUploads]": "state"
    }
  });

  return mapBuildUpload(response.data);
}

function isSourceFileChecksumsConflict(error: unknown): boolean {
  if (!(error instanceof InfrastructureError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("(409)") && message.includes("sourcefilechecksums");
}

// ---------------------------------------------------------------------------
// Upload orchestration
// ---------------------------------------------------------------------------

export interface BuildsUploadInput {
  readonly ipaSource: IpaSource;
  readonly appId: string;
  readonly expectedBundleId: string;
  readonly expectedVersion: string;
  readonly expectedBuildNumber: string;
  readonly waitProcessing: boolean;
  readonly apply: boolean;
}

export interface BuildsUploadResult {
  readonly mode: "dry-run" | "applied";
  readonly preflightReport: {
    readonly ipaPath: string;
    readonly bundleId: string | null;
    readonly version: string | null;
    readonly buildNumber: string | null;
    readonly sizeBytes: number;
    readonly sha256: string | null;
    readonly md5: string | null;
    readonly signingValidated: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  };
  readonly plannedOperations: readonly string[];
  readonly buildUploadId: string | null;
  readonly finalBuildUploadState: string | null;
  readonly fallbackUploadMethod?: FallbackUploadMethod;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1_000;

export async function uploadBuild(
  client: AppStoreConnectClient,
  input: BuildsUploadInput,
  options?: {
    readonly sleep?: (ms: number) => Promise<void>;
    readonly pollIntervalMs?: number;
    readonly pollTimeoutMs?: number;
    readonly processRunner?: ProcessRunner;
    readonly fallbackUploadCredentials?: FallbackUploadCredentials;
    readonly fallbackEnv?: NodeJS.ProcessEnv;
  }
): Promise<BuildsUploadResult> {
  const sleep =
    options?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options?.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

  const artifact = await resolveIpaArtifact(input.ipaSource, options?.processRunner);

  try {
    const preflightReport = await verifyIpa(
      {
        ipaPath: artifact.ipaPath,
        expectedBundleId: input.expectedBundleId,
        expectedVersion: input.expectedVersion,
        expectedBuildNumber: input.expectedBuildNumber
      },
      options?.processRunner
    );

    if (preflightReport.errors.length > 0) {
      throw new DomainError(
        `IPA preflight verification failed: ${preflightReport.errors.join(" | ")}`
      );
    }

    const plannedOperations = [
      `Create build upload for app ${input.appId}`,
      `Create build upload file for ${artifact.ipaPath}`,
      "Upload chunks using App Store Connect upload operations",
      "Mark build upload file as uploaded with checksums",
      "Fallback to xcrun altool/Transporter if checksum marking is rejected",
      input.waitProcessing
        ? "Poll build upload until terminal state"
        : "Fetch current build upload state once"
    ] as const;

    if (!input.apply) {
      return {
        mode: "dry-run",
        preflightReport,
        plannedOperations,
        buildUploadId: null,
        finalBuildUploadState: null
      };
    }

    const buildUpload = await createBuildUpload(client, {
      appId: input.appId,
      versionString: input.expectedVersion,
      buildNumber: input.expectedBuildNumber,
      platform: "IOS"
    });

    const fileName = artifact.ipaPath.split(/[\\/]/).at(-1) ?? "build.ipa";

    const buildUploadFile = await createBuildUploadFile(client, {
      buildUploadId: buildUpload.id,
      fileName,
      fileSize: preflightReport.sizeBytes,
      uti: "com.apple.ipa",
      assetType: "ASSET"
    });

    await executeUploadOperations(artifact.ipaPath, buildUploadFile.uploadOperations);

    const sha256 = preflightReport.sha256;
    const md5 = preflightReport.md5;

    if (!sha256 || !md5) {
      throw new DomainError(
        "Missing checksums in preflight report; cannot mark build upload file as uploaded."
      );
    }

    let fallbackUploadMethod: FallbackUploadMethod | undefined;

    try {
      await markBuildUploadFileUploaded(client, {
        buildUploadFileId: buildUploadFile.id,
        sha256,
        md5
      });
    } catch (error) {
      if (!isSourceFileChecksumsConflict(error)) {
        throw error;
      }

      fallbackUploadMethod = await uploadWithXcrunFallback(artifact.ipaPath, {
        ...(options?.processRunner ? { processRunner: options.processRunner } : {}),
        ...(options?.fallbackUploadCredentials
          ? { credentials: options.fallbackUploadCredentials }
          : {}),
        ...(options?.fallbackEnv ? { env: options.fallbackEnv } : {})
      });
    }

    const finalState = fallbackUploadMethod
      ? "FALLBACK_SUBMITTED"
      : input.waitProcessing
        ? await pollBuildUploadState(client, buildUpload.id, sleep, pollIntervalMs, pollTimeoutMs)
        : (await getBuildUpload(client, buildUpload.id)).state.state;

    if (!fallbackUploadMethod && finalState === "FAILED") {
      throw new DomainError("Build upload failed in App Store Connect.");
    }

    return {
      mode: "applied",
      preflightReport,
      plannedOperations,
      buildUploadId: fallbackUploadMethod ? null : buildUpload.id,
      finalBuildUploadState: finalState,
      ...(fallbackUploadMethod ? { fallbackUploadMethod } : {})
    };
  } finally {
    if (artifact.dispose) {
      await artifact.dispose();
    }
  }
}

async function pollBuildUploadState(
  client: AppStoreConnectClient,
  buildUploadId: string,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  pollTimeoutMs: number
): Promise<string> {
  const startedAt = Date.now();

  while (true) {
    const buildUpload = await getBuildUpload(client, buildUploadId);
    const state = buildUpload.state.state;

    if (state === "COMPLETE" || state === "FAILED") {
      return state;
    }

    if (Date.now() - startedAt > pollTimeoutMs) {
      throw new DomainError(
        `Timed out while waiting for build upload processing (${buildUploadId}).`
      );
    }

    await sleep(pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

export async function buildsUploadCommand(
  client: AppStoreConnectClient,
  command: {
    readonly appReference?: string;
    readonly version?: string;
    readonly buildNumber?: string;
    readonly ipaSource?: IpaSource;
    readonly waitProcessing: boolean;
    readonly apply: boolean;
    readonly json: boolean;
  },
  options?: {
    readonly cwd?: string;
    readonly processRunner?: ProcessRunner;
  }
): Promise<number> {
  const processRunner = options?.processRunner;
  const uploadOptions = processRunner ? { processRunner } : undefined;
  const ipaSource =
    command.ipaSource ??
    (await autoDetectIpaSource({
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      ...(processRunner ? { processRunner } : {})
    }));

  if (command.appReference && command.version && command.buildNumber) {
    const apps = await listApps(client);
    const app = resolveTargetApp(apps, command.appReference, null);

    const result = await uploadBuild(
      client,
      {
        ipaSource,
        appId: app.id,
        expectedBundleId: app.bundleId,
        expectedVersion: command.version,
        expectedBuildNumber: command.buildNumber,
        waitProcessing: command.waitProcessing,
        apply: command.apply
      },
      uploadOptions
    );

    return printBuildUploadCommandOutput(command.json, result, app);
  }

  const artifact = await resolveIpaArtifact(ipaSource, processRunner);

  try {
    const detectedIpaMetadata = await verifyIpa(
      { ipaPath: artifact.ipaPath },
      processRunner
    );

    if (detectedIpaMetadata.errors.length > 0) {
      throw new DomainError(
        `IPA preflight verification failed: ${detectedIpaMetadata.errors.join(" | ")}`
      );
    }

    const expectedVersion = command.version ?? detectedIpaMetadata.version;
    if (!expectedVersion) {
      throw new InfrastructureError(
        "Could not resolve app version. Provide --version or ensure IPA includes CFBundleShortVersionString."
      );
    }

    const expectedBuildNumber = command.buildNumber ?? detectedIpaMetadata.buildNumber;
    if (!expectedBuildNumber) {
      throw new InfrastructureError(
        "Could not resolve build number. Provide --build-number or ensure IPA includes CFBundleVersion."
      );
    }

    const apps = await listApps(client);
    const app = resolveTargetApp(apps, command.appReference, detectedIpaMetadata.bundleId);

    const result = await uploadBuild(
      client,
      {
        ipaSource: { kind: "prebuilt", ipaPath: artifact.ipaPath },
        appId: app.id,
        expectedBundleId: app.bundleId,
        expectedVersion,
        expectedBuildNumber,
        waitProcessing: command.waitProcessing,
        apply: command.apply
      },
      uploadOptions
    );
    return printBuildUploadCommandOutput(command.json, result, app);
  } finally {
    if (artifact.dispose) {
      await artifact.dispose();
    }
  }
}

function resolveTargetApp(
  apps: readonly AppSummary[],
  appReference: string | undefined,
  detectedBundleId: string | null
): AppSummary {
  if (appReference) {
    const app = apps.find((candidate) => {
      return candidate.id === appReference || candidate.bundleId === appReference;
    });

    if (!app) {
      throw new InfrastructureError(`Could not resolve app reference "${appReference}".`);
    }

    return app;
  }

  if (!detectedBundleId) {
    throw new InfrastructureError(
      "Could not resolve target app. Provide --app or ensure IPA includes CFBundleIdentifier."
    );
  }

  const app = apps.find((candidate) => candidate.bundleId === detectedBundleId);

  if (!app) {
    throw new InfrastructureError(
      `No App Store Connect app found for bundle identifier "${detectedBundleId}".`
    );
  }

  return app;
}

function printBuildUploadCommandOutput(
  json: boolean,
  result: BuildsUploadResult,
  app: AppSummary
): number {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  printBuildUploadResult(result, app);
  return 0;
}

function printBuildUploadResult(result: BuildsUploadResult, app: AppSummary): void {
  console.log(`Mode: ${result.mode}`);
  console.log(`App: ${app.name} (${app.bundleId}) [${app.id}]`);
  console.log(`IPA: ${result.preflightReport.ipaPath}`);
  console.log(`SHA-256: ${result.preflightReport.sha256 ?? "unavailable"}`);
  console.log(`Signing validated: ${result.preflightReport.signingValidated ? "yes" : "no"}`);
  console.log("Planned operations:");
  result.plannedOperations.forEach((operation) => {
    console.log(`- ${operation}`);
  });

  if (result.mode === "dry-run") {
    console.log("Dry-run completed. No App Store Connect mutation requests were sent.");
  } else {
    console.log(`Build upload id: ${result.buildUploadId}`);
    console.log(`Final state: ${result.finalBuildUploadState}`);
    if (result.fallbackUploadMethod) {
      console.log(`Fallback upload method: ${result.fallbackUploadMethod}`);
    }
  }
}
