import type { AppStoreConnectClient } from "../api/client.js";
import { DomainError } from "../api/client.js";
import {
  ANALYTICS_FIELD_VALUES,
  ANALYTICS_PAGE_LIMIT,
  ANALYTICS_QUERY,
  ANALYTICS_REPORTS,
  type AnalyticsReportAlias
} from "./constants.js";
import { getAllPages } from "./requests.js";

export interface AnalyticsReportResource {
  readonly id: string;
  readonly name: string;
  readonly category: string;
}

export interface SelectedAnalyticsReport {
  readonly alias: AnalyticsReportAlias;
  readonly id: string;
  readonly name: string;
  readonly category: string;
}

interface ReportResponseItem {
  readonly id: string;
  readonly attributes?: {
    readonly name?: string;
    readonly category?: string;
  };
}

export async function listAnalyticsReports(
  client: AppStoreConnectClient,
  requestId: string
): Promise<AnalyticsReportResource[]> {
  const resources = await getAllPages<ReportResponseItem>(client, {
    path: `/v1/analyticsReportRequests/${requestId}/reports`,
    query: {
      [ANALYTICS_QUERY.reportFields]: ANALYTICS_FIELD_VALUES.report,
      limit: ANALYTICS_PAGE_LIMIT
    }
  });

  return resources.map((resource) => ({
    id: resource.id,
    name: resource.attributes?.name ?? "",
    category: resource.attributes?.category ?? ""
  }));
}

export function selectAnalyticsReports(
  reports: readonly AnalyticsReportResource[],
  aliases: readonly AnalyticsReportAlias[]
): SelectedAnalyticsReport[] {
  return aliases.map((alias) => {
    const definition = ANALYTICS_REPORTS[alias];
    const match = definition.names
      .map((name) =>
        reports.find((report) => report.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)
      )
      .find((report) => report !== undefined);

    if (!match) {
      const available = reports
        .map((report) => report.name)
        .filter((name) => name.length > 0)
        .slice(0, 12);

      throw new DomainError(
        `Analytics report for "${alias}" was not found. ` +
          `Expected one of: ${definition.names.join(", ")}. ` +
          (available.length > 0 ? `Saw: ${available.join(", ")}.` : "The report request returned no reports yet.")
      );
    }

    return {
      alias,
      id: match.id,
      name: match.name,
      category: match.category
    };
  });
}
