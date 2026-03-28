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

interface AppInfosResponse {
  readonly data: readonly {
    readonly id: string;
    readonly type: string;
  }[];
}

interface AppInfoLocalizationData {
  readonly id: string;
  readonly attributes: {
    readonly locale?: string;
    readonly subtitle?: string;
    readonly privacyPolicyUrl?: string;
  };
}

interface AppInfoLocalizationsResponse {
  readonly data: readonly AppInfoLocalizationData[];
}

interface AppStoreReviewDetailResponse {
  readonly data: {
    readonly id: string;
    readonly attributes: {
      readonly contactFirstName?: string;
      readonly contactLastName?: string;
      readonly contactPhone?: string;
      readonly contactEmail?: string;
    };
  };
}

interface AgeRatingDeclarationResponse {
  readonly data: {
    readonly id: string;
    readonly attributes: Record<string, unknown>;
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
  readonly subtitle?: string;
  readonly privacyPolicyUrl?: string;
  readonly screenshots?: Readonly<Record<string, readonly string[]>>;
}

export interface AgeRatingDeclaration {
  readonly gamblingAndContests?: boolean;
  readonly unrestrictedWebAccess?: boolean;
  readonly horrorOrFearThemes?: string;
  readonly matureOrSuggestiveThemes?: string;
  readonly violenceCartoonOrFantasy?: string;
  readonly violenceRealistic?: string;
  readonly medicalOrTreatmentInformation?: string;
}

export interface ReviewContact {
  readonly contactFirstName?: string;
  readonly contactLastName?: string;
  readonly contactPhone?: string;
  readonly contactEmail?: string;
}

export interface AppMetadata {
  readonly primaryCategory?: string;
  readonly copyright?: string;
  readonly ageRating?: AgeRatingDeclaration;
  readonly reviewContact?: ReviewContact;
}

export type MetadataManifest = Readonly<Record<string, MetadataLocale | AppMetadata>>;

export interface MetadataUpdateInput {
  readonly appId: string;
  readonly platform: "IOS" | "MAC_OS";
  readonly version?: string | undefined;
  readonly manifest: MetadataManifest;
  readonly appMetadata?: AppMetadata;
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
  readonly appInfoLocalizationsUpdated: number;
  readonly appInfoLocalizationsCreated: number;
  readonly copyrightUpdated: boolean;
  readonly categoryUpdated: boolean;
  readonly ageRatingUpdated: boolean;
  readonly reviewContactUpdated: boolean;
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
// API helpers – app info, age rating, review contact
// ---------------------------------------------------------------------------

async function getAppInfos(
  client: AppStoreConnectClient,
  appId: string
): Promise<AppInfosResponse> {
  const response = await client.request<AppInfosResponse>({
    method: "GET",
    path: `/v1/apps/${appId}/appInfos`
  });

  return response.data;
}

async function getAppInfoLocalizations(
  client: AppStoreConnectClient,
  appInfoId: string
): Promise<AppInfoLocalizationsResponse> {
  const response = await client.request<AppInfoLocalizationsResponse>({
    method: "GET",
    path: `/v1/appInfos/${appInfoId}/appInfoLocalizations`,
    query: {
      "fields[appInfoLocalizations]": "locale,subtitle,privacyPolicyUrl"
    }
  });

  return response.data;
}

async function updateAppInfoLocalization(
  client: AppStoreConnectClient,
  id: string,
  fields: Readonly<Record<string, string>>
): Promise<void> {
  await client.request<void>({
    method: "PATCH",
    path: `/v1/appInfoLocalizations/${id}`,
    body: {
      data: {
        type: "appInfoLocalizations",
        id,
        attributes: fields
      }
    }
  });
}

async function createAppInfoLocalization(
  client: AppStoreConnectClient,
  appInfoId: string,
  locale: string,
  fields: Readonly<Record<string, string>>
): Promise<string> {
  const response = await client.request<{ readonly data: { readonly id: string } }>({
    method: "POST",
    path: "/v1/appInfoLocalizations",
    body: {
      data: {
        type: "appInfoLocalizations",
        attributes: {
          locale,
          ...fields
        },
        relationships: {
          appInfo: {
            data: {
              type: "appInfos",
              id: appInfoId
            }
          }
        }
      }
    }
  });

  return response.data.data.id;
}

async function updateAppStoreVersion(
  client: AppStoreConnectClient,
  versionId: string,
  attrs: Readonly<Record<string, string>>
): Promise<void> {
  await client.request<void>({
    method: "PATCH",
    path: `/v1/appStoreVersions/${versionId}`,
    body: {
      data: {
        type: "appStoreVersions",
        id: versionId,
        attributes: attrs
      }
    }
  });
}

async function getAppStoreReviewDetail(
  client: AppStoreConnectClient,
  versionId: string
): Promise<AppStoreReviewDetailResponse | null> {
  try {
    const response = await client.request<AppStoreReviewDetailResponse>({
      method: "GET",
      path: `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`,
      query: {
        "fields[appStoreReviewDetails]":
          "contactFirstName,contactLastName,contactPhone,contactEmail"
      }
    });

    return response.data;
  } catch (error) {
    if (error instanceof InfrastructureError && error.details?.statusCode === 404) {
      return null;
    }

    throw error;
  }
}

async function createAppStoreReviewDetail(
  client: AppStoreConnectClient,
  versionId: string,
  fields: Readonly<Record<string, string>>
): Promise<string> {
  const response = await client.request<{ readonly data: { readonly id: string } }>({
    method: "POST",
    path: "/v1/appStoreReviewDetails",
    body: {
      data: {
        type: "appStoreReviewDetails",
        attributes: fields,
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

async function updateAppStoreReviewDetail(
  client: AppStoreConnectClient,
  id: string,
  fields: Readonly<Record<string, string>>
): Promise<void> {
  await client.request<void>({
    method: "PATCH",
    path: `/v1/appStoreReviewDetails/${id}`,
    body: {
      data: {
        type: "appStoreReviewDetails",
        id,
        attributes: fields
      }
    }
  });
}

async function getAgeRatingDeclaration(
  client: AppStoreConnectClient,
  appInfoId: string
): Promise<AgeRatingDeclarationResponse> {
  const response = await client.request<AgeRatingDeclarationResponse>({
    method: "GET",
    path: `/v1/appInfos/${appInfoId}/ageRatingDeclaration`
  });

  return response.data;
}

async function updateAgeRatingDeclaration(
  client: AppStoreConnectClient,
  id: string,
  fields: Readonly<Record<string, unknown>>
): Promise<void> {
  await client.request<void>({
    method: "PATCH",
    path: `/v1/ageRatingDeclarations/${id}`,
    body: {
      data: {
        type: "ageRatingDeclarations",
        id,
        attributes: fields
      }
    }
  });
}

async function updateAppInfoCategory(
  client: AppStoreConnectClient,
  appInfoId: string,
  category: string
): Promise<void> {
  await client.request<void>({
    method: "PATCH",
    path: `/v1/appInfos/${appInfoId}`,
    body: {
      data: {
        type: "appInfos",
        id: appInfoId,
        relationships: {
          primaryCategory: {
            data: {
              type: "appCategories",
              id: category
            }
          }
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEXT_FIELDS = ["description", "keywords", "promotionalText", "supportUrl", "marketingUrl"] as const;
const APP_INFO_FIELDS = ["subtitle", "privacyPolicyUrl"] as const;
const AGE_RATING_BOOLEAN_FIELDS = ["gamblingAndContests", "unrestrictedWebAccess"] as const;
const AGE_RATING_FREQUENCY_FIELDS = [
  "horrorOrFearThemes",
  "matureOrSuggestiveThemes",
  "violenceCartoonOrFantasy",
  "violenceRealistic",
  "medicalOrTreatmentInformation"
] as const;
const REVIEW_CONTACT_FIELDS = ["contactFirstName", "contactLastName", "contactPhone", "contactEmail"] as const;

const RESERVED_KEYS = new Set(["_app"]);

function validateAppMetadata(value: unknown): AppMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError('Invalid manifest: "_app" must be a JSON object.');
  }

  const obj = value as Record<string, unknown>;

  if ("primaryCategory" in obj && typeof obj.primaryCategory !== "string") {
    throw new DomainError('Invalid manifest: "_app.primaryCategory" must be a string.');
  }

  if ("copyright" in obj && typeof obj.copyright !== "string") {
    throw new DomainError('Invalid manifest: "_app.copyright" must be a string.');
  }

  if ("ageRating" in obj) {
    if (typeof obj.ageRating !== "object" || obj.ageRating === null || Array.isArray(obj.ageRating)) {
      throw new DomainError('Invalid manifest: "_app.ageRating" must be a JSON object.');
    }

    const ar = obj.ageRating as Record<string, unknown>;

    for (const field of AGE_RATING_BOOLEAN_FIELDS) {
      if (field in ar && typeof ar[field] !== "boolean") {
        throw new DomainError(`Invalid manifest: "_app.ageRating.${field}" must be a boolean.`);
      }
    }

    for (const field of AGE_RATING_FREQUENCY_FIELDS) {
      if (field in ar && typeof ar[field] !== "string") {
        throw new DomainError(`Invalid manifest: "_app.ageRating.${field}" must be a string.`);
      }
    }
  }

  if ("reviewContact" in obj) {
    if (typeof obj.reviewContact !== "object" || obj.reviewContact === null || Array.isArray(obj.reviewContact)) {
      throw new DomainError('Invalid manifest: "_app.reviewContact" must be a JSON object.');
    }

    const rc = obj.reviewContact as Record<string, unknown>;

    for (const field of REVIEW_CONTACT_FIELDS) {
      if (field in rc && typeof rc[field] !== "string") {
        throw new DomainError(`Invalid manifest: "_app.reviewContact.${field}" must be a string.`);
      }
    }
  }

  return value as AppMetadata;
}

export function validateManifest(value: unknown): MetadataManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("Invalid manifest: top-level value must be a JSON object.");
  }

  const obj = value as Record<string, unknown>;

  // Validate _app key if present
  if ("_app" in obj) {
    validateAppMetadata(obj._app);
  }

  for (const [locale, localeValue] of Object.entries(obj)) {
    if (RESERVED_KEYS.has(locale)) continue;

    if (typeof localeValue !== "object" || localeValue === null || Array.isArray(localeValue)) {
      throw new DomainError(`Invalid manifest: locale "${locale}" must be a JSON object.`);
    }

    const localeObj = localeValue as Record<string, unknown>;

    for (const field of TEXT_FIELDS) {
      if (field in localeObj && typeof localeObj[field] !== "string") {
        throw new DomainError(
          `Invalid manifest: locale "${locale}" field "${field}" must be a string.`
        );
      }
    }

    for (const field of APP_INFO_FIELDS) {
      if (field in localeObj && typeof localeObj[field] !== "string") {
        throw new DomainError(
          `Invalid manifest: locale "${locale}" field "${field}" must be a string.`
        );
      }
    }

    if ("screenshots" in localeObj) {
      const screenshots = localeObj.screenshots;

      if (typeof screenshots !== "object" || screenshots === null || Array.isArray(screenshots)) {
        throw new DomainError(
          `Invalid manifest: locale "${locale}" field "screenshots" must be a JSON object.`
        );
      }

      for (const [displayType, paths] of Object.entries(screenshots as Record<string, unknown>)) {
        if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) {
          throw new DomainError(
            `Invalid manifest: locale "${locale}" screenshots["${displayType}"] must be an array of file paths.`
          );
        }
      }
    }
  }

  return value as MetadataManifest;
}

function extractTextFields(locale: MetadataLocale): Record<string, string> {
  const fields: Record<string, string> = {};

  if (locale.description !== undefined) fields.description = locale.description;
  if (locale.keywords !== undefined) fields.keywords = locale.keywords;
  if (locale.promotionalText !== undefined) fields.promotionalText = locale.promotionalText;
  if (locale.supportUrl !== undefined) fields.supportUrl = locale.supportUrl;
  if (locale.marketingUrl !== undefined) fields.marketingUrl = locale.marketingUrl;

  return fields;
}

function extractAppInfoFields(locale: MetadataLocale): Record<string, string> {
  const fields: Record<string, string> = {};

  if (locale.subtitle !== undefined) fields.subtitle = locale.subtitle;
  if (locale.privacyPolicyUrl !== undefined) fields.privacyPolicyUrl = locale.privacyPolicyUrl;

  return fields;
}

function getLocaleKeys(manifest: MetadataManifest): string[] {
  return Object.keys(manifest).filter((k) => !RESERVED_KEYS.has(k));
}

function getAppMetadata(manifest: MetadataManifest): AppMetadata | undefined {
  return manifest._app as AppMetadata | undefined;
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
  const locales = getLocaleKeys(input.manifest);
  const appMeta = input.appMetadata ?? getAppMetadata(input.manifest);

  // 3. Get existing localizations
  const existingLocalizations = await getVersionLocalizations(client, editableVersion.id);
  const localeToId = new Map<string, string>();

  for (const loc of existingLocalizations.data) {
    if (loc.attributes.locale) {
      localeToId.set(loc.attributes.locale, loc.id);
    }
  }

  if (input.textOnly && input.screenshotsOnly) {
    throw new Error("--text-only and --screenshots-only are mutually exclusive");
  }

  // Plan text operations
  const shouldUpdateText = !input.screenshotsOnly;
  const shouldUpdateScreenshots = !input.textOnly;

  if (shouldUpdateText) {
    for (const locale of locales) {
      const localeData = input.manifest[locale] as MetadataLocale | undefined;
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
      const localeData = input.manifest[locale] as MetadataLocale | undefined;
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

  // Plan app-info localization operations (subtitle, privacyPolicyUrl)
  const hasAppInfoFields = locales.some((locale) => {
    const localeData = input.manifest[locale] as MetadataLocale | undefined;
    if (!localeData) return false;
    return Object.keys(extractAppInfoFields(localeData)).length > 0;
  });

  const needsAppInfoId =
    (hasAppInfoFields && shouldUpdateText) ||
    !!appMeta?.primaryCategory ||
    !!appMeta?.ageRating;

  let appInfoId: string | undefined;
  const appInfoLocaleToId = new Map<string, string>();

  if (needsAppInfoId) {
    const appInfos = await getAppInfos(client, input.appId);

    if (appInfos.data.length === 0) {
      throw new DomainError("No appInfo found for this app.");
    }

    appInfoId = appInfos.data[0]!.id;
  }

  if (hasAppInfoFields && shouldUpdateText && appInfoId) {
    const existingAppInfoLocs = await getAppInfoLocalizations(client, appInfoId);

    for (const loc of existingAppInfoLocs.data) {
      if (loc.attributes.locale) {
        appInfoLocaleToId.set(loc.attributes.locale, loc.id);
      }
    }

    for (const locale of locales) {
      const localeData = input.manifest[locale] as MetadataLocale | undefined;
      if (!localeData) continue;

      const fields = extractAppInfoFields(localeData);

      if (Object.keys(fields).length === 0) continue;

      if (appInfoLocaleToId.has(locale)) {
        plannedOperations.push(`Update app info localization for ${locale} (${Object.keys(fields).join(", ")})`);
      } else {
        plannedOperations.push(`Create app info localization for ${locale} (${Object.keys(fields).join(", ")})`);
      }
    }
  }

  // Plan app-level metadata operations
  if (appMeta) {
    if (appMeta.copyright) {
      plannedOperations.push("Update copyright");
    }

    if (appMeta.primaryCategory) {
      plannedOperations.push(`Update primary category to ${appMeta.primaryCategory}`);
    }

    if (appMeta.ageRating) {
      plannedOperations.push("Update age rating declaration");
    }

    if (appMeta.reviewContact) {
      plannedOperations.push("Update review contact information");
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
      screenshotsUploaded: 0,
      appInfoLocalizationsUpdated: 0,
      appInfoLocalizationsCreated: 0,
      copyrightUpdated: false,
      categoryUpdated: false,
      ageRatingUpdated: false,
      reviewContactUpdated: false
    };
  }

  // 4. Apply text metadata
  let localizationsUpdated = 0;
  let localizationsCreated = 0;

  if (shouldUpdateText) {
    for (const locale of locales) {
      const localeData = input.manifest[locale] as MetadataLocale | undefined;
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
      const localeData = input.manifest[locale] as MetadataLocale | undefined;
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

  // 6. Apply app-info localizations (subtitle, privacyPolicyUrl)
  let appInfoLocalizationsUpdated = 0;
  let appInfoLocalizationsCreated = 0;

  if (hasAppInfoFields && shouldUpdateText && appInfoId) {
    for (const locale of locales) {
      const localeData = input.manifest[locale] as MetadataLocale | undefined;
      if (!localeData) continue;

      const fields = extractAppInfoFields(localeData);

      if (Object.keys(fields).length === 0) continue;

      const existingId = appInfoLocaleToId.get(locale);

      if (existingId) {
        await updateAppInfoLocalization(client, existingId, fields);
        appInfoLocalizationsUpdated += 1;
      } else {
        const newId = await createAppInfoLocalization(client, appInfoId, locale, fields);
        appInfoLocaleToId.set(locale, newId);
        appInfoLocalizationsCreated += 1;
      }
    }
  }

  // 7. Apply app-level metadata
  let copyrightUpdated = false;
  let categoryUpdated = false;
  let ageRatingUpdated = false;
  let reviewContactUpdated = false;

  if (appMeta) {
    // Copyright — PATCH appStoreVersion
    if (appMeta.copyright) {
      await updateAppStoreVersion(client, editableVersion.id, { copyright: appMeta.copyright });
      copyrightUpdated = true;
    }

    // Category — PATCH appInfo with relationship
    if (appMeta.primaryCategory && appInfoId) {
      await updateAppInfoCategory(client, appInfoId, appMeta.primaryCategory);
      categoryUpdated = true;
    }

    // Age rating — GET declaration → PATCH
    if (appMeta.ageRating && appInfoId) {
      const ageRatingDecl = await getAgeRatingDeclaration(client, appInfoId);
      await updateAgeRatingDeclaration(client, ageRatingDecl.data.id, { ...appMeta.ageRating });
      ageRatingUpdated = true;
    }

    // Review contact — GET or POST, then PATCH
    if (appMeta.reviewContact) {
      const contactFields: Record<string, string> = {};

      for (const field of REVIEW_CONTACT_FIELDS) {
        const val = appMeta.reviewContact[field];

        if (val !== undefined) {
          contactFields[field] = val;
        }
      }

      const existingReviewDetail = await getAppStoreReviewDetail(client, editableVersion.id);

      if (existingReviewDetail) {
        await updateAppStoreReviewDetail(client, existingReviewDetail.data.id, contactFields);
      } else {
        await createAppStoreReviewDetail(client, editableVersion.id, contactFields);
      }

      reviewContactUpdated = true;
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
    screenshotsUploaded,
    appInfoLocalizationsUpdated,
    appInfoLocalizationsCreated,
    copyrightUpdated,
    categoryUpdated,
    ageRatingUpdated,
    reviewContactUpdated
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
    manifest = validateManifest(JSON.parse(manifestContent));
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
    console.log(`App info localizations updated: ${result.appInfoLocalizationsUpdated}`);
    console.log(`App info localizations created: ${result.appInfoLocalizationsCreated}`);
    if (result.copyrightUpdated) console.log("Copyright updated");
    if (result.categoryUpdated) console.log("Primary category updated");
    if (result.ageRatingUpdated) console.log("Age rating declaration updated");
    if (result.reviewContactUpdated) console.log("Review contact updated");
  }
}
