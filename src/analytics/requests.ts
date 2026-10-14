import {
  DomainError,
  InfrastructureError,
  type AppStoreConnectClient
} from "../api/client.js";
import {
  ADMIN_KEY_NOTE,
  ANALYTICS_FIELD_VALUES,
  ANALYTICS_PAGE_LIMIT,
  ANALYTICS_QUERY
} from "./constants.js";

export type AnalyticsAccessType = "ONGOING" | "ONE_TIME_SNAPSHOT";

export interface AnalyticsReportRequest {
  readonly id: string;
  readonly accessType: AnalyticsAccessType | string;
  readonly stoppedDueToInactivity: boolean;
}

export interface AnalyticsSetupAction {
  readonly accessType: AnalyticsAccessType;
  readonly action: "create" | "reuse";
  readonly id: string;
  readonly stoppedDueToInactivity: boolean;
}

export interface AnalyticsSetupResult {
  readonly mode: "dry-run" | "applied";
  readonly appId: string;
  readonly adminKeyRequired: true;
  readonly note: string;
  readonly ongoing: AnalyticsSetupAction;
  readonly snapshot?: AnalyticsSetupAction;
}

interface RequestsResponse {
  readonly data: readonly {
    readonly id: string;
    readonly attributes?: {
      readonly accessType?: string;
      readonly stoppedDueToInactivity?: boolean;
    };
  }[];
  readonly links?: {
    readonly next?: string;
  };
}

export async function listAnalyticsReportRequests(
  client: AppStoreConnectClient,
  appId: string
): Promise<AnalyticsReportRequest[]> {
  const resources = await getAllPages<RequestsResponse["data"][number]>(client, {
    path: `/v1/apps/${appId}/analyticsReportRequests`,
    query: {
      [ANALYTICS_QUERY.requestFields]: ANALYTICS_FIELD_VALUES.request,
      limit: ANALYTICS_PAGE_LIMIT
    }
  });

  return resources.map((resource) => ({
    id: resource.id,
    accessType: resource.attributes?.accessType ?? "",
    stoppedDueToInactivity: resource.attributes?.stoppedDueToInactivity === true
  }));
}

export async function createAnalyticsReportRequest(
  client: AppStoreConnectClient,
  appId: string,
  accessType: AnalyticsAccessType
): Promise<AnalyticsReportRequest> {
  try {
    const response = await client.request<{
      readonly data: {
        readonly id: string;
        readonly attributes?: {
          readonly accessType?: string;
          readonly stoppedDueToInactivity?: boolean;
        };
      };
    }>({
      method: "POST",
      path: "/v1/analyticsReportRequests",
      body: {
        data: {
          type: "analyticsReportRequests",
          attributes: {
            accessType
          },
          relationships: {
            app: {
              data: {
                type: "apps",
                id: appId
              }
            }
          }
        }
      }
    });

    return {
      id: response.data.data.id,
      accessType: response.data.data.attributes?.accessType ?? accessType,
      stoppedDueToInactivity: response.data.data.attributes?.stoppedDueToInactivity === true
    };
  } catch (error) {
    if (error instanceof InfrastructureError && error.details?.statusCode === 409) {
      const existing = await listAnalyticsReportRequests(client, appId);
      const match = existing.find(
        (request) => request.accessType === accessType && !request.stoppedDueToInactivity
      );

      if (match) {
        return match;
      }
    }

    throw error;
  }
}

export async function setupAnalytics(
  client: AppStoreConnectClient,
  input: {
    readonly appId: string;
    readonly snapshot: boolean;
    readonly apply: boolean;
  }
): Promise<AnalyticsSetupResult> {
  const existing = await listAnalyticsReportRequests(client, input.appId);
  const ongoing = await ensureAccessType(client, input.appId, existing, "ONGOING", input.apply);
  const snapshot = input.snapshot
    ? await ensureAccessType(
        client,
        input.appId,
        existing,
        "ONE_TIME_SNAPSHOT",
        input.apply
      )
    : undefined;

  return {
    mode: input.apply ? "applied" : "dry-run",
    appId: input.appId,
    adminKeyRequired: true,
    note: ADMIN_KEY_NOTE,
    ongoing,
    ...(snapshot ? { snapshot } : {})
  };
}

async function ensureAccessType(
  client: AppStoreConnectClient,
  appId: string,
  existing: readonly AnalyticsReportRequest[],
  accessType: AnalyticsAccessType,
  apply: boolean
): Promise<AnalyticsSetupAction> {
  const active = existing.find(
    (request) => request.accessType === accessType && !request.stoppedDueToInactivity
  );

  if (active) {
    return {
      accessType,
      action: "reuse",
      id: active.id,
      stoppedDueToInactivity: false
    };
  }

  if (!apply) {
    return {
      accessType,
      action: "create",
      id: "",
      stoppedDueToInactivity: false
    };
  }

  const created = await createAnalyticsReportRequest(client, appId, accessType);

  return {
    accessType,
    action: "create",
    id: created.id,
    stoppedDueToInactivity: created.stoppedDueToInactivity
  };
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly links?: {
    readonly next?: string;
  };
}

export async function getAllPages<T>(
  client: AppStoreConnectClient,
  first: {
    readonly path: string;
    readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  }
): Promise<T[]> {
  const items: T[] = [];
  let path = first.path;
  let query = first.query;
  let pageCount = 0;

  for (;;) {
    pageCount += 1;

    if (pageCount > 50) {
      throw new DomainError("Analytics pagination exceeded 50 pages.");
    }

    const response = await client.request<PageResponse<T>>({
      method: "GET",
      path,
      ...(query ? { query } : {})
    });

    items.push(...response.data.data);

    const next = response.data.links?.next;

    if (!next) {
      return items;
    }

    path = next;
    query = undefined;
  }
}
