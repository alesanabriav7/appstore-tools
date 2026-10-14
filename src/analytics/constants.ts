import { DomainError } from "../api/client.js";

// ---------------------------------------------------------------------------
// Query parameter names
// ---------------------------------------------------------------------------

/**
 * Analytics Reports API query names.
 *
 * Verified against Apple's App Store Connect OpenAPI for:
 * - GET /v1/apps/{id}/analyticsReportRequests (`filter[accessType]`,
 *   `fields[analyticsReportRequests]=accessType,stoppedDueToInactivity`)
 * - GET /v1/analyticsReportRequests/{id}/reports (`filter[name]`,
 *   `filter[category]`, `fields[analyticsReports]=name,category`)
 * - GET /v1/analyticsReports/{id}/instances (`filter[granularity]`,
 *   `filter[processingDate]`, `fields[analyticsReportInstances]`)
 * - GET /v1/analyticsReportInstances/{id}/segments
 *   (`fields[analyticsReportSegments]=url,checksum,sizeInBytes`)
 *
 * `filter[granularity]` values are DAILY, WEEKLY, MONTHLY.
 * `filter[processingDate]` is a comma-separated list of YYYY-MM-DD dates
 * (OpenAPI array, style form, explode false).
 */
export const ANALYTICS_QUERY = {
  requestAccessType: "filter[accessType]",
  requestFields: "fields[analyticsReportRequests]",
  reportName: "filter[name]",
  reportCategory: "filter[category]",
  reportFields: "fields[analyticsReports]",
  instanceGranularity: "filter[granularity]",
  instanceProcessingDate: "filter[processingDate]",
  instanceFields: "fields[analyticsReportInstances]",
  segmentFields: "fields[analyticsReportSegments]"
} as const;

export const ANALYTICS_FIELD_VALUES = {
  request: "accessType,stoppedDueToInactivity",
  report: "name,category",
  instance: "granularity,processingDate",
  segment: "url,checksum,sizeInBytes"
} as const;

export const ANALYTICS_PAGE_LIMIT = 200;

/**
 * Apple generates a later instance to finalize an event date. The largest lag
 * we wait for is 5 days, so instance lookups extend this far past `--to`.
 * Lists longer than this are filtered locally instead of in the query string.
 */
export const MAX_COMPLETENESS_DAYS = 5;
export const PROCESSING_DATE_FILTER_LIMIT = 100;

// ---------------------------------------------------------------------------
// Report catalog
// ---------------------------------------------------------------------------

/**
 * Report `name` values are the strings Apple documents for the Analytics
 * Reports catalog. Standard is preferred where Apple publishes a
 * Standard/Detailed pair. "App Crashes" has no Standard suffix.
 *
 * Completeness lags for `analytics summary`:
 * - discovery: 3 days. Apple's Discovery and Engagement guide says
 *   "Completeness: Within three days."
 * - downloads: 2 days. Apple's Analytics Reports help says a reporting day
 *   is complete two days later.
 * - installs, sessions, crashes: 5 days. This is the product rule for this
 *   CLI. Apple's public field guides do not publish one 5-day figure for
 *   these three reports.
 */
export const ANALYTICS_REPORTS = {
  discovery: {
    category: "APP_STORE_ENGAGEMENT",
    names: [
      "App Store Discovery and Engagement Standard",
      "App Store Discovery and Engagement"
    ],
    completenessDays: 3
  },
  downloads: {
    category: "COMMERCE",
    names: ["App Downloads Standard", "App Downloads"],
    completenessDays: 2
  },
  installs: {
    category: "APP_USAGE",
    names: [
      "App Store Installation and Deletion Standard",
      "App Store Installation and Deletion",
      "App Store Installations and Deletions"
    ],
    completenessDays: 5
  },
  sessions: {
    category: "APP_USAGE",
    names: ["App Sessions Standard", "App Sessions"],
    completenessDays: 5
  },
  crashes: {
    category: "APP_USAGE",
    names: ["App Crashes"],
    completenessDays: 5
  }
} as const;

export type AnalyticsReportAlias = keyof typeof ANALYTICS_REPORTS;

export const DEFAULT_ANALYTICS_REPORTS: readonly AnalyticsReportAlias[] = [
  "discovery",
  "downloads",
  "installs",
  "sessions",
  "crashes"
];

export const ANALYTICS_GRANULARITIES = ["DAILY", "WEEKLY", "MONTHLY"] as const;

export type AnalyticsGranularity = (typeof ANALYTICS_GRANULARITIES)[number];

/**
 * Metric columns from Apple's report field tables. Every other column except
 * Date is treated as a dimension. Header spelling is Apple's title case.
 */
export const METRIC_HEADERS = [
  "Counts",
  "Unique Counts",
  "Unique Devices",
  "Sessions",
  "Total Session Duration",
  "Crashes"
] as const;

export const DATE_HEADER = "Date";

export const DIMENSION_HEADERS = {
  event: "Event",
  pageType: "Page Type",
  sourceType: "Source Type",
  downloadType: "Download Type"
} as const;

export const ADMIN_KEY_NOTE =
  "Creating an analytics report request requires an App Store Connect API key with the Admin role. " +
  "After the first request exists, Sales and Reports or Finance keys can download reports.";

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string, label: string): string {
  const match = ISO_DATE.exec(value.trim());

  if (!match) {
    throw new DomainError(`${label} must be YYYY-MM-DD.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new DomainError(`${label} is not a valid calendar date.`);
  }

  return formatIsoDate(date);
}

export function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addIsoDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return formatIsoDate(date);
}

export function isoDateDiff(earlier: string, later: string): number {
  const start = Date.parse(`${earlier}T00:00:00Z`);
  const end = Date.parse(`${later}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export function eachIsoDate(from: string, to: string): string[] {
  if (from > to) {
    throw new DomainError(`--from ${from} is after --to ${to}.`);
  }

  const dates: string[] = [];
  let cursor = from;

  while (cursor <= to) {
    dates.push(cursor);
    cursor = addIsoDays(cursor, 1);
  }

  return dates;
}

export function assertReportAlias(value: string): AnalyticsReportAlias {
  if (Object.prototype.hasOwnProperty.call(ANALYTICS_REPORTS, value)) {
    return value as AnalyticsReportAlias;
  }

  throw new DomainError(
    `Unknown analytics report "${value}". Expected one of: ${DEFAULT_ANALYTICS_REPORTS.join(", ")}.`
  );
}

export function assertGranularity(value: string): AnalyticsGranularity {
  if ((ANALYTICS_GRANULARITIES as readonly string[]).includes(value)) {
    return value as AnalyticsGranularity;
  }

  throw new DomainError(
    `Invalid --granularity. Allowed values: ${ANALYTICS_GRANULARITIES.join(", ")}.`
  );
}
