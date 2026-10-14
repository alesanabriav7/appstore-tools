import { DomainError, InfrastructureError, type AppStoreConnectClient } from "../api/client.js";
import { listApps, type AppSummary } from "./apps-list.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AppStorePlatform = "IOS" | "MAC_OS";

export interface CreateAppStoreVersionInput {
  readonly appId: string;
  readonly versionString: string;
  readonly platform: AppStorePlatform;
}

export interface CreatedAppStoreVersion {
  readonly id: string;
  readonly versionString: string;
  readonly platform: AppStorePlatform;
  readonly appStoreState: string;
}

export interface CreateVersionCommandResult {
  readonly mode: "dry-run" | "applied";
  readonly appId: string;
  readonly bundleId: string;
  readonly versionString: string;
  readonly platform: AppStorePlatform;
  readonly versionId: string;
  readonly appStoreState: string;
}

interface AppStoreVersionCreateResponse {
  readonly data: {
    readonly id: string;
    readonly attributes?: {
      readonly versionString?: string;
      readonly platform?: string;
      readonly appStoreState?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * POST /v1/appStoreVersions.
 * Body shape matches Apple's "Create an App Store Version" request:
 * attributes.platform, attributes.versionString, relationships.app.
 */
export async function createAppStoreVersion(
  client: AppStoreConnectClient,
  input: CreateAppStoreVersionInput
): Promise<CreatedAppStoreVersion> {
  const versionString = input.versionString.trim();

  if (!versionString) {
    throw new DomainError("Version string is required to create an App Store version.");
  }

  const response = await client.request<AppStoreVersionCreateResponse>({
    method: "POST",
    path: "/v1/appStoreVersions",
    body: {
      data: {
        type: "appStoreVersions",
        attributes: {
          platform: input.platform,
          versionString
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

  const created = response.data.data;

  if (!created?.id) {
    throw new DomainError("App Store Connect did not return an id for the created version.");
  }

  const platform = created.attributes?.platform;

  return {
    id: created.id,
    versionString: created.attributes?.versionString ?? versionString,
    platform: platform === "MAC_OS" ? "MAC_OS" : input.platform,
    appStoreState: created.attributes?.appStoreState ?? "PREPARE_FOR_SUBMISSION"
  };
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

export async function appsCreateVersionCommand(
  client: AppStoreConnectClient,
  command: {
    readonly appReference: string;
    readonly version: string;
    readonly platform: AppStorePlatform;
    readonly apply: boolean;
    readonly json: boolean;
  }
): Promise<number> {
  const apps = await listApps(client);
  const app = apps.find(
    (candidate) =>
      candidate.id === command.appReference || candidate.bundleId === command.appReference
  );

  if (!app) {
    throw new InfrastructureError(`Could not resolve app reference "${command.appReference}".`);
  }

  const result = command.apply
    ? await applyCreateVersion(client, app, command.version, command.platform)
    : dryRunCreateVersion(app, command.version, command.platform);

  if (command.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log(`Mode: ${result.mode}`);
  console.log(`App: ${app.name} (${app.bundleId}) [${app.id}]`);
  console.log(`Version: ${result.versionString} (${result.platform})`);

  if (result.mode === "dry-run") {
    console.log("Dry-run completed. No App Store Connect mutation requests were sent.");
    console.log("Re-run with --apply to create the version.");
  } else {
    console.log(`Created version [${result.versionId}] (${result.appStoreState})`);
  }

  return 0;
}

function dryRunCreateVersion(
  app: AppSummary,
  versionString: string,
  platform: AppStorePlatform
): CreateVersionCommandResult {
  return {
    mode: "dry-run",
    appId: app.id,
    bundleId: app.bundleId,
    versionString,
    platform,
    versionId: "",
    appStoreState: ""
  };
}

async function applyCreateVersion(
  client: AppStoreConnectClient,
  app: AppSummary,
  versionString: string,
  platform: AppStorePlatform
): Promise<CreateVersionCommandResult> {
  const created = await createAppStoreVersion(client, {
    appId: app.id,
    versionString,
    platform
  });

  return {
    mode: "applied",
    appId: app.id,
    bundleId: app.bundleId,
    versionString: created.versionString,
    platform: created.platform,
    versionId: created.id,
    appStoreState: created.appStoreState
  };
}
