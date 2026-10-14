import { gunzipSync } from "node:zlib";

import { DomainError, InfrastructureError, type AppStoreConnectClient } from "../api/client.js";
import { parseTsv } from "../analytics/tsv.js";

/**
 * Sales report query names verified against Apple's
 * GET /v1/salesReports OpenAPI parameters:
 * filter[reportType], filter[reportSubType], filter[frequency],
 * filter[reportDate], filter[vendorNumber], filter[version].
 *
 * Daily summary uses SALES / SUMMARY / DAILY / version 1_0.
 * The response body is gzip-compressed TSV, not JSON.
 */
export const SALES_QUERY = {
  reportType: "filter[reportType]",
  reportSubType: "filter[reportSubType]",
  frequency: "filter[frequency]",
  reportDate: "filter[reportDate]",
  vendorNumber: "filter[vendorNumber]",
  version: "filter[version]"
} as const;

export const SALES_DAILY_SUMMARY = {
  reportType: "SALES",
  reportSubType: "SUMMARY",
  frequency: "DAILY",
  version: "1_0"
} as const;

export interface SalesReport {
  readonly vendorNumber: string;
  readonly reportDate: string;
  readonly headers: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

export async function fetchSalesReport(
  client: AppStoreConnectClient,
  input: {
    readonly vendorNumber: string;
    readonly reportDate: string;
  }
): Promise<SalesReport> {
  const vendorNumber = input.vendorNumber.trim();

  if (!vendorNumber) {
    throw new DomainError(
      "Missing vendor number. Pass --vendor or set ASC_VENDOR_NUMBER."
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reportDate)) {
    throw new DomainError("--date must be YYYY-MM-DD.");
  }

  const response = await client.requestBinary({
    method: "GET",
    path: "/v1/salesReports",
    query: {
      [SALES_QUERY.reportType]: SALES_DAILY_SUMMARY.reportType,
      [SALES_QUERY.reportSubType]: SALES_DAILY_SUMMARY.reportSubType,
      [SALES_QUERY.frequency]: SALES_DAILY_SUMMARY.frequency,
      [SALES_QUERY.reportDate]: input.reportDate,
      [SALES_QUERY.vendorNumber]: vendorNumber,
      [SALES_QUERY.version]: SALES_DAILY_SUMMARY.version
    }
  });

  let text: string;

  try {
    text = gunzipSync(response.data).toString("utf8");
  } catch (error) {
    throw new InfrastructureError("Sales report payload was not valid gzip.", error);
  }

  const table = parseTsv(text);

  return {
    vendorNumber,
    reportDate: input.reportDate,
    headers: table.headers,
    rows: table.rows
  };
}

export function formatSalesReport(report: SalesReport, format: "csv" | "json"): string {
  if (format === "json") {
    return `${JSON.stringify(
      {
        vendorNumber: report.vendorNumber,
        reportDate: report.reportDate,
        rows: report.rows
      },
      null,
      2
    )}\n`;
  }

  const lines = [report.headers.join(",")];

  for (const row of report.rows) {
    lines.push(report.headers.map((header) => csvCell(row[header] ?? "")).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}
