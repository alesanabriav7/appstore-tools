import { gunzipSync } from "node:zlib";

import { InfrastructureError, type AppStoreConnectClient, type FetchLike } from "../api/client.js";
import {
  ANALYTICS_FIELD_VALUES,
  ANALYTICS_PAGE_LIMIT,
  ANALYTICS_QUERY,
  type AnalyticsGranularity
} from "./constants.js";
import { getAllPages } from "./requests.js";

export interface AnalyticsReportInstance {
  readonly id: string;
  readonly granularity: string;
  readonly processingDate: string;
}

export interface AnalyticsReportSegment {
  readonly id: string;
  readonly url: string;
  readonly checksum?: string;
  readonly sizeInBytes?: number;
}

export async function listAnalyticsInstances(
  client: AppStoreConnectClient,
  reportId: string,
  granularity: AnalyticsGranularity,
  processingDates: readonly string[] | undefined
): Promise<AnalyticsReportInstance[]> {
  const query: Record<string, string | number> = {
    [ANALYTICS_QUERY.instanceFields]: ANALYTICS_FIELD_VALUES.instance,
    [ANALYTICS_QUERY.instanceGranularity]: granularity,
    limit: ANALYTICS_PAGE_LIMIT
  };

  if (processingDates && processingDates.length > 0) {
    query[ANALYTICS_QUERY.instanceProcessingDate] = processingDates.join(",");
  }

  const resources = await getAllPages<{
    readonly id: string;
    readonly attributes?: {
      readonly granularity?: string;
      readonly processingDate?: string;
    };
  }>(client, {
    path: `/v1/analyticsReports/${reportId}/instances`,
    query
  });

  return resources.map((resource) => ({
    id: resource.id,
    granularity: resource.attributes?.granularity ?? granularity,
    processingDate: resource.attributes?.processingDate ?? ""
  }));
}

export async function listAnalyticsSegments(
  client: AppStoreConnectClient,
  instanceId: string
): Promise<AnalyticsReportSegment[]> {
  const resources = await getAllPages<{
    readonly id: string;
    readonly attributes?: {
      readonly url?: string;
      readonly checksum?: string;
      readonly sizeInBytes?: number;
    };
  }>(client, {
    path: `/v1/analyticsReportInstances/${instanceId}/segments`,
    query: {
      [ANALYTICS_QUERY.segmentFields]: ANALYTICS_FIELD_VALUES.segment,
      limit: ANALYTICS_PAGE_LIMIT
    }
  });

  return resources.flatMap((resource) => {
    const url = resource.attributes?.url;

    if (!url) {
      return [];
    }

    return [
      {
        id: resource.id,
        url,
        ...(resource.attributes?.checksum ? { checksum: resource.attributes.checksum } : {}),
        ...(resource.attributes?.sizeInBytes !== undefined
          ? { sizeInBytes: resource.attributes.sizeInBytes }
          : {})
      }
    ];
  });
}

/**
 * Presigned segment URLs are downloaded without the App Store Connect bearer
 * token. Apple documents these URLs as temporary file links.
 */
export async function downloadSegmentText(url: string, fetchLike: FetchLike): Promise<string> {
  const response = await fetchLike(url, {
    method: "GET",
    headers: new Headers()
  });

  if (!response.ok) {
    throw new InfrastructureError(
      `Analytics segment download failed (${response.status}).`
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return gunzipToText(bytes);
}

export function gunzipToText(bytes: Uint8Array): string {
  try {
    return gunzipSync(bytes).toString("utf8");
  } catch (error) {
    throw new InfrastructureError("Failed to gunzip analytics or sales payload.", error);
  }
}
