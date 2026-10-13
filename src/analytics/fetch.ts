import { DomainError, type AppStoreConnectClient, type FetchLike } from "../api/client.js";
import {
  MAX_COMPLETENESS_DAYS,
  PROCESSING_DATE_FILTER_LIMIT,
  addIsoDays,
  eachIsoDate,
  type AnalyticsGranularity,
  type AnalyticsReportAlias
} from "./constants.js";
import { listAnalyticsReports, selectAnalyticsReports } from "./reports.js";
import { listAnalyticsReportRequests } from "./requests.js";
import {
  downloadSegmentText,
  listAnalyticsInstances,
  listAnalyticsSegments
} from "./segments.js";
import { readLedger, upsertRows, writeLedger, type AnalyticsStoredRow } from "./store.js";
import { parseTsv, tsvToStoredRows } from "./tsv.js";

export interface FetchAnalyticsInput {
  readonly appId: string;
  readonly from: string;
  readonly to: string;
  readonly reports: readonly AnalyticsReportAlias[];
  readonly granularity: AnalyticsGranularity;
  readonly outDir: string;
  readonly format: "jsonl" | "csv";
}

export interface FetchAnalyticsReportStat {
  readonly alias: AnalyticsReportAlias;
  readonly reportId: string;
  readonly reportName: string;
  readonly instances: number;
  readonly rows: number;
}

export interface FetchAnalyticsResult {
  readonly appId: string;
  readonly from: string;
  readonly to: string;
  readonly granularity: AnalyticsGranularity;
  readonly processingDateFrom: string;
  readonly processingDateTo: string;
  readonly requestId: string;
  readonly reports: readonly FetchAnalyticsReportStat[];
  readonly rowCount: number;
  readonly outputPath: string;
}

export async function fetchAnalytics(
  client: AppStoreConnectClient,
  input: FetchAnalyticsInput,
  options?: {
    readonly fetchLike?: FetchLike;
  }
): Promise<FetchAnalyticsResult> {
  const fetchLike = options?.fetchLike ?? fetch;
  const requestId = await resolveReportRequestId(client, input.appId);
  const catalog = await listAnalyticsReports(client, requestId);
  const selected = selectAnalyticsReports(catalog, input.reports);
  const processingDates = eachIsoDate(input.from, addIsoDays(input.to, MAX_COMPLETENESS_DAYS));
  const filterDates =
    processingDates.length <= PROCESSING_DATE_FILTER_LIMIT ? processingDates : undefined;
  const incoming: AnalyticsStoredRow[] = [];
  const stats: FetchAnalyticsReportStat[] = [];

  for (const report of selected) {
    const instances = await listAnalyticsInstances(
      client,
      report.id,
      input.granularity,
      filterDates
    );
    const inWindow = instances.filter(
      (instance) =>
        instance.processingDate >= processingDates[0]! &&
        instance.processingDate <= processingDates[processingDates.length - 1]!
    );
    let rowCount = 0;

    for (const instance of inWindow) {
      const segments = await listAnalyticsSegments(client, instance.id);

      for (const segment of segments) {
        const text = await downloadSegmentText(segment.url, fetchLike);
        const table = parseTsv(text);
        const rows = tsvToStoredRows(report.alias, instance.processingDate, table).filter(
          (row) => row.date >= input.from && row.date <= input.to
        );
        rowCount += rows.length;
        incoming.push(...rows);
      }
    }

    stats.push({
      alias: report.alias,
      reportId: report.id,
      reportName: report.name,
      instances: inWindow.length,
      rows: rowCount
    });
  }

  const existing = await readLedger(input.outDir, input.appId);
  const merged = upsertRows(existing, incoming);
  const outputPath = await writeLedger(input.outDir, input.appId, merged, input.format);

  return {
    appId: input.appId,
    from: input.from,
    to: input.to,
    granularity: input.granularity,
    processingDateFrom: processingDates[0]!,
    processingDateTo: processingDates[processingDates.length - 1]!,
    requestId,
    reports: stats,
    rowCount: merged.length,
    outputPath
  };
}

async function resolveReportRequestId(
  client: AppStoreConnectClient,
  appId: string
): Promise<string> {
  const requests = await listAnalyticsReportRequests(client, appId);
  const ongoing = requests.find(
    (request) => request.accessType === "ONGOING" && !request.stoppedDueToInactivity
  );

  if (ongoing) {
    return ongoing.id;
  }

  const snapshot = requests.find(
    (request) => request.accessType === "ONE_TIME_SNAPSHOT" && !request.stoppedDueToInactivity
  );

  if (snapshot) {
    return snapshot.id;
  }

  throw new DomainError(
    "No active analytics report request found. Run `analytics setup --app <id> --apply` " +
      "with an Admin API key, then wait for Apple to generate instances."
  );
}
