import { writeFile } from "node:fs/promises";

import { DomainError, type AppStoreConnectClient } from "../api/client.js";
import { listApps } from "./apps-list.js";
import {
  EDITABLE_STATES,
  selectEditableAppInfo,
  type AppInfoCandidate,
  type EditableVersion,
  type MetadataLocale,
  type MetadataManifest
} from "./apps-update-metadata.js";

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

interface VersionLocalizationData {
  readonly id: string;
  readonly attributes: {
    readonly locale?: string;
    readonly description?: string;
    readonly keywords?: string;
    readonly promotionalText?: string;
    readonly whatsNew?: string;
    readonly supportUrl?: string;
    readonly marketingUrl?: string;
  };
}

interface VersionLocalizationsResponse {
  readonly data: readonly VersionLocalizationData[];
}

interface CategoryLinkage {
  readonly data?: {
    readonly id?: string;
    readonly type?: string;
  } | null;
}

interface AppInfoResource {
  readonly id: string;
  readonly type?: string;
  readonly attributes?: {
    readonly appStoreState?: string;
    readonly state?: string;
    readonly primaryCategory?: { readonly id?: string };
    readonly secondaryCategory?: { readonly id?: string };
  };
  readonly relationships?: {
    readonly appStoreVersion?: {
      readonly data?: {
        readonly id?: string;
        readonly type?: string;
      };
    };
    readonly primaryCategory?: CategoryLinkage;
    readonly secondaryCategory?: CategoryLinkage;
  };
}

interface AppInfosResponse {
  readonly data: readonly AppInfoResource[];
}

interface AppInfoDetailResponse {
  readonly data?: AppInfoResource;
  readonly included?: readonly {
    readonly type?: string;
    readonly id?: string;
  }[];
}

interface AppInfoLocalizationData {
  readonly id: string;
  readonly attributes: {
    readonly locale?: string;
    readonly name?: string;
    readonly subtitle?: string;
    readonly privacyPolicyUrl?: string;
  };
}

interface AppInfoLocalizationsResponse {
  readonly data: readonly AppInfoLocalizationData[];
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AppsReadMetadataInput {
  readonly appId: string;
  readonly platform: "IOS" | "MAC_OS";
  readonly version?: string | undefined;
  readonly outputPath: string;
}

export interface AppsReadMetadataResult {
  readonly versionId: string;
  readonly versionString: string;
  readonly appStoreState: string;
  readonly outputPath: string;
  readonly manifest: MetadataManifest;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function getAppStoreVersions(
  client: AppStoreConnectClient,
  appId: string,
  platform: "IOS" | "MAC_OS",
  version?: string
): Promise<AppStoreVersionsResponse> {
  const query: Record<string, string | number> = {
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
): Promise<VersionLocalizationsResponse> {
  const response = await client.request<VersionLocalizationsResponse>({
    method: "GET",
    path: `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    query: {
      "fields[appStoreVersionLocalizations]":
        "locale,description,keywords,promotionalText,whatsNew,supportUrl,marketingUrl"
    }
  });

  return response.data;
}

async function getAppInfos(
  client: AppStoreConnectClient,
  appId: string
): Promise<AppInfosResponse> {
  const response = await client.request<AppInfosResponse>({
    method: "GET",
    path: `/v1/apps/${appId}/appInfos`,
    query: {
      "fields[appInfos]": "appStoreState,state,primaryCategory,secondaryCategory"
    }
  });

  return response.data;
}

async function getAppInfoDetail(
  client: AppStoreConnectClient,
  appInfoId: string
): Promise<AppInfoDetailResponse> {
  const response = await client.request<AppInfoDetailResponse>({
    method: "GET",
    path: `/v1/appInfos/${appInfoId}`,
    query: {
      "fields[appInfos]": "appStoreState,state,primaryCategory,secondaryCategory",
      include: "primaryCategory,secondaryCategory"
    }
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
      "fields[appInfoLocalizations]": "locale,name,subtitle,privacyPolicyUrl"
    }
  });

  return response.data;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function readMetadata(
  client: AppStoreConnectClient,
  input: AppsReadMetadataInput
): Promise<AppsReadMetadataResult> {
  // 1. Find version
  const versionsResponse = await getAppStoreVersions(
    client,
    input.appId,
    input.platform,
    input.version
  );

  if (versionsResponse.data.length === 0) {
    throw new DomainError(
      input.version
        ? `No App Store version found for version ${input.version} on platform ${input.platform}.`
        : `No App Store version found for platform ${input.platform}.`
    );
  }

  // Use the first version returned (latest when no filter, exact match when filtered)
  const version = versionsResponse.data[0]!;
  const versionId = version.id;
  const versionString = version.attributes?.versionString ?? "";
  const appStoreState = version.attributes?.appStoreState ?? "";

  // 2. Fetch version localizations
  const versionLocs = await getVersionLocalizations(client, versionId);

  // 3. Fetch appInfo
  const appInfosResponse = await getAppInfos(client, input.appId);

  if (appInfosResponse.data.length === 0) {
    throw new DomainError("No appInfo found for this app.");
  }

  const selectedAppInfo = selectAppInfoForRead(appInfosResponse.data, {
    id: versionId,
    appStoreState
  });
  const appInfoId = selectedAppInfo.id;

  // 4. Fetch appInfo localizations and detail in parallel
  const [appInfoLocs, appInfoDetail] = await Promise.all([
    getAppInfoLocalizations(client, appInfoId),
    getAppInfoDetail(client, appInfoId)
  ]);

  // 5. Build per-locale map
  const localeMap = new Map<string, Record<string, string>>();

  for (const loc of versionLocs.data) {
    const locale = loc.attributes?.locale;
    if (!locale) continue;

    const entry: Record<string, string> = {};

    if (loc.attributes.description) entry.description = loc.attributes.description;
    if (loc.attributes.keywords) entry.keywords = loc.attributes.keywords;
    if (loc.attributes.promotionalText) entry.promotionalText = loc.attributes.promotionalText;
    if (loc.attributes.whatsNew) entry.whatsNewText = loc.attributes.whatsNew;
    if (loc.attributes.supportUrl) entry.supportUrl = loc.attributes.supportUrl;
    if (loc.attributes.marketingUrl) entry.marketingUrl = loc.attributes.marketingUrl;

    localeMap.set(locale, entry);
  }

  for (const loc of appInfoLocs.data) {
    const locale = loc.attributes?.locale;
    if (!locale) continue;

    const entry = localeMap.get(locale) ?? {};

    if (loc.attributes.name) entry.name = loc.attributes.name;
    if (loc.attributes.subtitle) entry.subtitle = loc.attributes.subtitle;
    if (loc.attributes.privacyPolicyUrl) entry.privacyPolicyUrl = loc.attributes.privacyPolicyUrl;

    localeMap.set(locale, entry);
  }

  // 6. Build manifest
  const manifest: Record<string, MetadataLocale> = {};

  for (const [locale, fields] of localeMap.entries()) {
    if (Object.keys(fields).length > 0) {
      manifest[locale] = fields as MetadataLocale;
    }
  }

  // 7. Categories are relationships. `attributes` is absent when the sparse
  // fieldset only asks for primaryCategory/secondaryCategory.
  const detailResource = appInfoDetail.data;
  const primaryCategoryId =
    categoryId(detailResource, "primaryCategory") ??
    categoryId(selectedAppInfo, "primaryCategory");
  const secondaryCategoryId =
    categoryId(detailResource, "secondaryCategory") ??
    categoryId(selectedAppInfo, "secondaryCategory");

  if (primaryCategoryId || secondaryCategoryId) {
    const appBlock: Record<string, string> = {};
    if (primaryCategoryId) appBlock.primaryCategory = primaryCategoryId;
    if (secondaryCategoryId) appBlock.secondaryCategory = secondaryCategoryId;
    (manifest as Record<string, unknown>)["_app"] = appBlock;
  }

  const finalManifest = manifest as unknown as MetadataManifest;

  await writeFile(input.outputPath, JSON.stringify(finalManifest, null, 2), "utf-8");

  return {
    versionId,
    versionString,
    appStoreState,
    outputPath: input.outputPath,
    manifest: finalManifest
  };
}

function selectAppInfoForRead(
  appInfos: readonly AppInfoResource[],
  version: { readonly id: string; readonly appStoreState: string }
): AppInfoResource {
  const candidates = appInfos.map((resource) => toCandidate(resource));
  const editableVersion: EditableVersion | null = EDITABLE_STATES.has(version.appStoreState)
    ? {
        id: version.id,
        versionString: "",
        appStoreState: version.appStoreState
      }
    : null;

  let selected: AppInfoCandidate | undefined;

  if (editableVersion) {
    try {
      selected = selectEditableAppInfo(candidates, editableVersion);
    } catch (error) {
      if (!(error instanceof DomainError)) {
        throw error;
      }
    }
  } else {
    selected = candidates.find((info) =>
      [info.appStoreState, info.state].includes(version.appStoreState)
    );

    if (!selected) {
      try {
        selected = selectEditableAppInfo(candidates, null);
      } catch (error) {
        if (!(error instanceof DomainError)) {
          throw error;
        }
      }
    }
  }

  const selectedId = selected?.id ?? appInfos[0]?.id;
  const resource = appInfos.find((item) => item.id === selectedId);

  if (!resource) {
    throw new DomainError("No appInfo found for this app.");
  }

  return resource;
}

function toCandidate(resource: AppInfoResource): AppInfoCandidate {
  const linkedVersionId = resource.relationships?.appStoreVersion?.data?.id;

  return {
    id: resource.id,
    ...(resource.attributes?.appStoreState
      ? { appStoreState: resource.attributes.appStoreState }
      : {}),
    ...(resource.attributes?.state ? { state: resource.attributes.state } : {}),
    ...(linkedVersionId ? { linkedVersionId } : {})
  };
}

/**
 * Category ids live on relationships.primaryCategory.data.id (and the
 * secondaryCategory relationship). Older payloads sometimes nested the same
 * id under attributes; that shape is only a fallback.
 */
function categoryId(
  resource: AppInfoResource | undefined,
  name: "primaryCategory" | "secondaryCategory"
): string | undefined {
  if (!resource) {
    return undefined;
  }

  const fromRelationship = resource.relationships?.[name]?.data?.id;

  if (fromRelationship) {
    return fromRelationship;
  }

  return resource.attributes?.[name]?.id;
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

export async function appsReadMetadataCommand(
  client: AppStoreConnectClient,
  command: {
    readonly appReference: string;
    readonly outputPath: string;
    readonly version?: string | undefined;
    readonly platform: "IOS" | "MAC_OS";
    readonly json: boolean;
  }
): Promise<number> {
  const apps = await listApps(client);
  const app = apps.find(
    (a) => a.id === command.appReference || a.bundleId === command.appReference
  );

  if (!app) {
    console.error(`App not found: ${command.appReference}`);
    return 1;
  }

  const result = await readMetadata(client, {
    appId: app.id,
    platform: command.platform,
    outputPath: command.outputPath,
    ...(command.version ? { version: command.version } : {})
  });

  if (command.json) {
    console.log(
      JSON.stringify(
        {
          versionId: result.versionId,
          versionString: result.versionString,
          appStoreState: result.appStoreState,
          outputPath: result.outputPath
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(`App: ${app.name} (${app.bundleId}) [${app.id}]`);
  console.log(`Version: ${result.versionString} [${result.versionId}] (${result.appStoreState})`);
  console.log(`Metadata written to: ${result.outputPath}`);

  return 0;
}
