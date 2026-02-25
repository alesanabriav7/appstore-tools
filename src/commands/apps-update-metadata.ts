import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve, dirname } from "node:path";

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
import { listApps, type AppSummary } from "./apps-list.js";

// ---------------------------------------------------------------------------
// API response types (inline)
// ---------------------------------------------------------------------------

interface AppStoreVersionsResponse {
  readonly data: readonly {
    readonly id: string;
    readonly attributes: {
      readonly versionString?: string;
      readonly appStoreState?: string;
      readonly platform?: string;
    };
  }[];
}

interface LocalizationData {
  readonly id: string;
  readonly attributes: {
    readonly locale?: string;
    readonly description?: string;
    readonly keywords?: string;
    readonly promotionalText?: string;
    readonly supportUrl?: string;
    readonly marketingUrl?: string;
  };
}

interface LocalizationsResponse {
  readonly data: readonly LocalizationData[];
}

interface ScreenshotSetData {
  readonly id: string;
  readonly attributes: {
    readonly screenshotDisplayType?: string;
  };
  readonly relationships?: {
    readonly appScreenshots?: {
      readonly data?: readonly { readonly id: string }[];
    };
  };
}

interface ScreenshotSetsResponse {
  readonly data: readonly ScreenshotSetData[];
}

interface ScreenshotResponse {
  readonly data: {
    readonly id: string;
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
// Public types
// ---------------------------------------------------------------------------

export interface MetadataLocale {
  readonly description?: string;
  readonly keywords?: string;
  readonly promotionalText?: string;
  readonly supportUrl?: string;
  readonly marketingUrl?: string;
  readonly screenshots?: Readonly<Record<string, readonly string[]>>;
}

export type MetadataManifest = Readonly<Record<string, MetadataLocale>>;

export interface MetadataUpdateInput {
  readonly appId: string;
  readonly platform: "IOS" | "MAC_OS";
  readonly version?: string | undefined;
  readonly manifest: MetadataManifest;
  readonly textOnly: boolean;
  readonly screenshotsOnly: boolean;
  readonly apply: boolean;
}

export interface MetadataUpdateResult {
  readonly mode: "dry-run" | "applied";
  readonly versionId: string;
  readonly versionString: string;
  readonly plannedOperations: readonly string[];
  readonly localizationsUpdated: number;
  readonly localizationsCreated: number;
  readonly screenshotSetsProcessed: number;
  readonly screenshotsUploaded: number;
}

// ---------------------------------------------------------------------------
// Editable version states
// ---------------------------------------------------------------------------

const EDITABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "WAITING_FOR_REVIEW"
]);

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function getAppStoreVersions(
  client: AppStoreConnectClient,
  appId: string,
  platform: "IOS" | "MAC_OS",
  version?: string
): Promise<AppStoreVersionsResponse> {
  const query: Record<string, string> = {
    "filter[platform]": platform,
    "fields[appStoreVersions]": "versionString,appStoreState,platform"
  };

  if (version) {
    query["filter[versionString]"] = version;
  }

  const response = await client.request<AppStoreVersionsResponse>({
    method: "GET",
    path: `/v1/apps/${appId}/appStoreVersions`,
    query
  });

  return response.data;
}

async function getVersionLocalizations(
  client: AppStoreConnectClient,
  versionId: string
): Promise<LocalizationsResponse> {
  const response = await client.request<LocalizationsResponse>({
    method: "GET",
    path: `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    query: {
      "fields[appStoreVersionLocalizations]":
        "locale,description,keywords,promotionalText,supportUrl,marketingUrl"
    }
  });

  return response.data;
}

async function updateLocalization(
  client: AppStoreConnectClient,
  localizationId: string,
  fields: Readonly<Record<string, string>>
): Promise<void> {
  await client.request<void>({
    method: "PATCH",
    path: `/v1/appStoreVersionLocalizations/${localizationId}`,
    body: {
      data: {
        type: "appStoreVersionLocalizations",
        id: localizationId,
        attributes: fields
      }
    }
  });
}

async function createLocalization(
  client: AppStoreConnectClient,
  versionId: string,
  locale: string,
  fields: Readonly<Record<string, string>>
): Promise<string> {
  const response = await client.request<{ readonly data: { readonly id: string } }>({
    method: "POST",
    path: "/v1/appStoreVersionLocalizations",
    body: {
      data: {
        type: "appStoreVersionLocalizations",
        attributes: {
          locale,
          ...fields
        },
        relationships: {
          appStoreVersion: {
            data: {
              type: "appStoreVersions",
              id: versionId
            }
          }
        }
      }
    }
  });

  return response.data.data.id;
}

async function getScreenshotSets(
  client: AppStoreConnectClient,
  localizationId: string
): Promise<ScreenshotSetsResponse> {
  const response = await client.request<ScreenshotSetsResponse>({
    method: "GET",
    path: `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`,
    query: {
      "fields[appScreenshotSets]": "screenshotDisplayType",
      include: "appScreenshots"
    }
  });

  return response.data;
}

async function createScreenshotSet(
  client: AppStoreConnectClient,
  localizationId: string,
  displayType: string
): Promise<string> {
  const response = await client.request<{ readonly data: { readonly id: string } }>({
    method: "POST",
    path: "/v1/appScreenshotSets",
    body: {
      data: {
        type: "appScreenshotSets",
        attributes: {
          screenshotDisplayType: displayType
        },
        relationships: {
          appStoreVersionLocalization: {
            data: {
              type: "appStoreVersionLocalizations",
              id: localizationId
            }
          }
        }
      }
    }
  });

  return response.data.data.id;
}

async function deleteScreenshot(
  client: AppStoreConnectClient,
  screenshotId: string
): Promise<void> {
  await client.request<void>({
    method: "DELETE",
    path: `/v1/appScreenshots/${screenshotId}`
  });
}

async function createScreenshot(
  client: AppStoreConnectClient,
  screenshotSetId: string,
  fileName: string,
  fileSize: number
): Promise<{ readonly id: string; readonly uploadOperations: readonly UploadOperation[] }> {
  const response = await client.request<ScreenshotResponse>({
    method: "POST",
    path: "/v1/appScreenshots",
    body: {
      data: {
        type: "appScreenshots",
        attributes: {
          fileName,
          fileSize
        },
        relationships: {
          appScreenshotSet: {
            data: {
              type: "appScreenshotSets",
              id: screenshotSetId
            }
          }
        }
      }
    }
  });

  const id = response.data.data.id;

  if (!id) {
    throw new InfrastructureError("Malformed screenshot payload: missing id.");
  }

  const operationsPayload = response.data.data.attributes?.uploadOperations ?? [];

  return {
    id,
    uploadOperations: parseUploadOperations(operationsPayload, "screenshot")
  };
}

async function commitScreenshot(
  client: AppStoreConnectClient,
  screenshotId: string,
  checksum: string
): Promise<void> {
  await client.request<void>({
    method: "PATCH",
    path: `/v1/appScreenshots/${screenshotId}`,
    body: {
      data: {
        type: "appScreenshots",
        id: screenshotId,
        attributes: {
          uploaded: true,
          sourceFileChecksum: checksum
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextFields(locale: MetadataLocale): Record<string, string> {
  const fields: Record<string, string> = {};

  if (locale.description !== undefined) fields.description = locale.description;
  if (locale.keywords !== undefined) fields.keywords = locale.keywords;
  if (locale.promotionalText !== undefined) fields.promotionalText = locale.promotionalText;
  if (locale.supportUrl !== undefined) fields.supportUrl = locale.supportUrl;
  if (locale.marketingUrl !== undefined) fields.marketingUrl = locale.marketingUrl;

  return fields;
}

function findEditableVersion(
  versions: AppStoreVersionsResponse
): { readonly id: string; readonly versionString: string } | null {
  for (const version of versions.data) {
    const state = version.attributes.appStoreState;

    if (state && EDITABLE_STATES.has(state)) {
      return {
        id: version.id,
        versionString: version.attributes.versionString ?? "unknown"
      };
    }
  }

  return null;
}

function computeMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function updateMetadata(
  client: AppStoreConnectClient,
  input: MetadataUpdateInput,
  options?: {
    readonly manifestBasePath?: string;
  }
): Promise<MetadataUpdateResult> {
  const manifestBasePath = options?.manifestBasePath ?? process.cwd();

  // 1. Find editable version
  const versions = await getAppStoreVersions(client, input.appId, input.platform, input.version);
  const editableVersion = findEditableVersion(versions);

  if (!editableVersion) {
    throw new DomainError(
      "No editable App Store version found. The version must be in one of these states: " +
        [...EDITABLE_STATES].join(", ") +
        "."
    );
  }

  // 2. Build planned operations
  const plannedOperations: string[] = [];
  const locales = Object.keys(input.manifest);

  // 3. Get existing localizations
  const existingLocalizations = await getVersionLocalizations(client, editableVersion.id);
  const localeToId = new Map<string, string>();

  for (const loc of existingLocalizations.data) {
    if (loc.attributes.locale) {
      localeToId.set(loc.attributes.locale, loc.id);
    }
  }

  // Plan text operations
  const shouldUpdateText = !input.screenshotsOnly;
  const shouldUpdateScreenshots = !input.textOnly;

  if (shouldUpdateText) {
    for (const locale of locales) {
      const localeData = input.manifest[locale];
      if (!localeData) continue;

      const fields = extractTextFields(localeData);

      if (Object.keys(fields).length === 0) continue;

      if (localeToId.has(locale)) {
        plannedOperations.push(`Update localization for ${locale} (${Object.keys(fields).join(", ")})`);
      } else {
        plannedOperations.push(`Create localization for ${locale} (${Object.keys(fields).join(", ")})`);
      }
    }
  }

  if (shouldUpdateScreenshots) {
    for (const locale of locales) {
      const localeData = input.manifest[locale];
      if (!localeData) continue;

      const screenshots = localeData.screenshots;

      if (!screenshots) continue;

      for (const [displayType, files] of Object.entries(screenshots)) {
        plannedOperations.push(
          `Upload ${files.length} screenshot(s) for ${locale} [${displayType}]`
        );
      }
    }
  }

  if (!input.apply) {
    return {
      mode: "dry-run",
      versionId: editableVersion.id,
      versionString: editableVersion.versionString,
      plannedOperations,
      localizationsUpdated: 0,
      localizationsCreated: 0,
      screenshotSetsProcessed: 0,
      screenshotsUploaded: 0
    };
  }

  // 4. Apply text metadata
  let localizationsUpdated = 0;
  let localizationsCreated = 0;

  if (shouldUpdateText) {
    for (const locale of locales) {
      const localeData = input.manifest[locale];
      if (!localeData) continue;

      const fields = extractTextFields(localeData);

      if (Object.keys(fields).length === 0) continue;

      const existingId = localeToId.get(locale);

      if (existingId) {
        await updateLocalization(client, existingId, fields);
        localizationsUpdated += 1;
      } else {
        const newId = await createLocalization(client, editableVersion.id, locale, fields);
        localeToId.set(locale, newId);
        localizationsCreated += 1;
      }
    }
  }

  // 5. Apply screenshots
  let screenshotSetsProcessed = 0;
  let screenshotsUploaded = 0;

  if (shouldUpdateScreenshots) {
    for (const locale of locales) {
      const localeData = input.manifest[locale];
      if (!localeData) continue;

      const screenshots = localeData.screenshots;

      if (!screenshots) continue;

      const localizationId = localeToId.get(locale);

      if (!localizationId) {
        throw new DomainError(
          `Cannot upload screenshots for locale "${locale}": no localization exists. ` +
            "Include text fields for this locale or create the localization first."
        );
      }

      const existingSets = await getScreenshotSets(client, localizationId);
      const displayTypeToSetId = new Map<string, string>();
      const displayTypeToScreenshots = new Map<string, readonly string[]>();

      for (const set of existingSets.data) {
        if (set.attributes.screenshotDisplayType) {
          displayTypeToSetId.set(set.attributes.screenshotDisplayType, set.id);
          const existingScreenshots =
            set.relationships?.appScreenshots?.data?.map((s) => s.id) ?? [];
          displayTypeToScreenshots.set(set.attributes.screenshotDisplayType, existingScreenshots);
        }
      }

      for (const [displayType, files] of Object.entries(screenshots)) {
        // Get or create the screenshot set
        let setId = displayTypeToSetId.get(displayType);

        if (!setId) {
          setId = await createScreenshotSet(client, localizationId, displayType);
        }

        // Delete existing screenshots in this set
        const existingScreenshots = displayTypeToScreenshots.get(displayType) ?? [];

        await Promise.all(
          existingScreenshots.map((screenshotId) => deleteScreenshot(client, screenshotId))
        );

        // Upload new screenshots
        await Promise.all(
          files.map(async (filePath) => {
            const resolvedPath = resolve(manifestBasePath, filePath);
            const fileStat = await stat(resolvedPath);
            const fileName = basename(resolvedPath);

            const screenshot = await createScreenshot(client, setId, fileName, fileStat.size);

            await executeUploadOperations(resolvedPath, screenshot.uploadOperations);

            const md5 = await computeMd5(resolvedPath);

            await commitScreenshot(client, screenshot.id, md5);
            screenshotsUploaded += 1;
          })
        );

        screenshotSetsProcessed += 1;
      }
    }
  }

  return {
    mode: "applied",
    versionId: editableVersion.id,
    versionString: editableVersion.versionString,
    plannedOperations,
    localizationsUpdated,
    localizationsCreated,
    screenshotSetsProcessed,
    screenshotsUploaded
  };
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

export async function appsUpdateMetadataCommand(
  client: AppStoreConnectClient,
  command: {
    readonly appReference: string;
    readonly metadataPath: string;
    readonly version?: string | undefined;
    readonly platform: "IOS" | "MAC_OS";
    readonly textOnly: boolean;
    readonly screenshotsOnly: boolean;
    readonly apply: boolean;
    readonly json: boolean;
  }
): Promise<number> {
  // Resolve app
  const apps = await listApps(client);
  const app = apps.find(
    (candidate) => candidate.id === command.appReference || candidate.bundleId === command.appReference
  );

  if (!app) {
    throw new InfrastructureError(`Could not resolve app reference "${command.appReference}".`);
  }

  // Load manifest
  let manifestContent: string;

  try {
    manifestContent = await readFile(command.metadataPath, "utf-8");
  } catch (error) {
    throw new InfrastructureError(
      `Failed to read metadata manifest at "${command.metadataPath}".`,
      error
    );
  }

  let manifest: MetadataManifest;

  try {
    manifest = JSON.parse(manifestContent) as MetadataManifest;
  } catch (error) {
    throw new DomainError(`Invalid JSON in metadata manifest: ${(error as Error).message}`);
  }

  const result = await updateMetadata(client, {
    appId: app.id,
    platform: command.platform,
    ...(command.version ? { version: command.version } : {}),
    manifest,
    textOnly: command.textOnly,
    screenshotsOnly: command.screenshotsOnly,
    apply: command.apply
  }, {
    manifestBasePath: dirname(resolve(command.metadataPath))
  });

  if (command.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  printMetadataUpdateResult(result, app);
  return 0;
}

function printMetadataUpdateResult(result: MetadataUpdateResult, app: AppSummary): void {
  console.log(`Mode: ${result.mode}`);
  console.log(`App: ${app.name} (${app.bundleId}) [${app.id}]`);
  console.log(`Version: ${result.versionString} [${result.versionId}]`);
  console.log("Planned operations:");

  for (const operation of result.plannedOperations) {
    console.log(`- ${operation}`);
  }

  if (result.mode === "dry-run") {
    console.log("Dry-run completed. No App Store Connect mutation requests were sent.");
  } else {
    console.log(`Localizations updated: ${result.localizationsUpdated}`);
    console.log(`Localizations created: ${result.localizationsCreated}`);
    console.log(`Screenshot sets processed: ${result.screenshotSetsProcessed}`);
    console.log(`Screenshots uploaded: ${result.screenshotsUploaded}`);
  }
}
