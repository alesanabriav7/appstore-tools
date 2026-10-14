import { DomainError } from "../api/client.js";
import {
  ANALYTICS_REPORTS,
  DIMENSION_HEADERS,
  formatIsoDate,
  isoDateDiff
} from "./constants.js";
import type { AnalyticsStoredRow } from "./store.js";
import { readCell, readMetric } from "./tsv.js";

export interface SourceBreakdown {
  readonly impressions: number;
  readonly productPageViews: number;
  readonly firstTimeDownloads: number;
  readonly redownloads: number;
}

export interface Completeness {
  readonly discovery: boolean;
  readonly downloads: boolean;
  readonly installs: boolean;
  readonly sessions: boolean;
  readonly crashes: boolean;
}

export interface DailyKpi {
  readonly date: string;
  readonly impressions: number;
  readonly productPageViews: number;
  readonly firstTimeDownloads: number;
  readonly redownloads: number;
  readonly conversionRate: number | null;
  readonly bySource: Readonly<Record<string, SourceBreakdown>>;
  readonly sessions: number;
  readonly crashes: number;
  readonly isComplete: Completeness;
  readonly thresholded: boolean;
}

interface MutableSource {
  impressions: number;
  productPageViews: number;
  firstTimeDownloads: number;
  redownloads: number;
}

export function summarizeDay(
  rows: readonly AnalyticsStoredRow[],
  date: string,
  today: string
): DailyKpi {
  const dayRows = rows.filter((row) => row.date === date);
  const sources = new Map<string, MutableSource>();
  let impressions = 0;
  let productPageViews = 0;
  let uniqueProductPageViews = 0;
  let sawUniquePageViewMetric = false;
  let firstTimeDownloads = 0;
  let redownloads = 0;
  let sessions = 0;
  let crashes = 0;
  let thresholded = false;

  for (const row of dayRows) {
    if (row.thresholded) {
      thresholded = true;
    }

    const touchSource = (): MutableSource => {
      const source = sourceName(row);
      const bucket = sources.get(source) ?? emptySource();
      sources.set(source, bucket);
      return bucket;
    };

    if (row.report === "discovery") {
      if (isImpression(row)) {
        const counts = metricOrZero(row, "Counts");
        impressions += counts;
        touchSource().impressions += counts;
      }

      if (isProductPageView(row)) {
        const counts = metricOrZero(row, "Counts");
        productPageViews += counts;
        touchSource().productPageViews += counts;
        const unique = readMetric(row, "Unique Counts");

        if (unique !== null) {
          sawUniquePageViewMetric = true;
          uniqueProductPageViews += unique;
        }
      }
    }

    if (row.report === "downloads") {
      const counts = metricOrZero(row, "Counts");
      const downloadType = readCell(row, DIMENSION_HEADERS.downloadType);

      if (/first[\s-]*time/i.test(downloadType)) {
        firstTimeDownloads += counts;
        touchSource().firstTimeDownloads += counts;
      } else if (/redownload/i.test(downloadType)) {
        redownloads += counts;
        touchSource().redownloads += counts;
      }
    }

    if (row.report === "sessions") {
      const sessionMetric = readMetric(row, "Sessions");
      sessions += sessionMetric ?? metricOrZero(row, "Counts");
    }

    if (row.report === "crashes") {
      const crashMetric = readMetric(row, "Crashes");
      crashes += crashMetric ?? metricOrZero(row, "Counts");
    }
  }

  const downloads = firstTimeDownloads + redownloads;
  const denominator = sawUniquePageViewMetric ? uniqueProductPageViews : productPageViews;
  const bySource: Record<string, SourceBreakdown> = {};

  for (const [source, bucket] of [...sources.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    bySource[source] = { ...bucket };
  }

  return {
    date,
    impressions,
    productPageViews,
    firstTimeDownloads,
    redownloads,
    conversionRate: denominator > 0 ? downloads / denominator : null,
    bySource,
    sessions,
    crashes,
    isComplete: completenessFor(date, today),
    thresholded
  };
}

export function latestStoredDate(rows: readonly AnalyticsStoredRow[]): string | null {
  let latest: string | null = null;

  for (const row of rows) {
    if (!latest || row.date > latest) {
      latest = row.date;
    }
  }

  return latest;
}

export function completenessFor(date: string, today: string): Completeness {
  const age = isoDateDiff(date, today);

  return {
    discovery: age >= ANALYTICS_REPORTS.discovery.completenessDays,
    downloads: age >= ANALYTICS_REPORTS.downloads.completenessDays,
    installs: age >= ANALYTICS_REPORTS.installs.completenessDays,
    sessions: age >= ANALYTICS_REPORTS.sessions.completenessDays,
    crashes: age >= ANALYTICS_REPORTS.crashes.completenessDays
  };
}

export function todayIso(now: Date = new Date()): string {
  return formatIsoDate(now);
}

export function assertSummaryDate(rows: readonly AnalyticsStoredRow[], date: string | undefined): string {
  if (date) {
    return date;
  }

  const latest = latestStoredDate(rows);

  if (!latest) {
    throw new DomainError("No analytics rows are stored for this app.");
  }

  return latest;
}

function emptySource(): MutableSource {
  return {
    impressions: 0,
    productPageViews: 0,
    firstTimeDownloads: 0,
    redownloads: 0
  };
}

function sourceName(row: AnalyticsStoredRow): string {
  const source = readCell(row, DIMENSION_HEADERS.sourceType).trim();
  return source || "Unknown";
}

function isImpression(row: AnalyticsStoredRow): boolean {
  return /impression/i.test(readCell(row, DIMENSION_HEADERS.event));
}

function isProductPageView(row: AnalyticsStoredRow): boolean {
  const event = readCell(row, DIMENSION_HEADERS.event);

  if (!/page view/i.test(event)) {
    return false;
  }

  const pageType = readCell(row, DIMENSION_HEADERS.pageType).trim();

  if (!pageType) {
    return true;
  }

  return /product page/i.test(pageType);
}

function metricOrZero(row: AnalyticsStoredRow, header: string): number {
  return readMetric(row, header) ?? 0;
}
