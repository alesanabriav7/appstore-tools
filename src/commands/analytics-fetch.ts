import { InfrastructureError, type AppStoreConnectClient } from "../api/client.js";
import {
  assertGranularity,
  assertReportAlias,
  DEFAULT_ANALYTICS_REPORTS,
  parseIsoDate,
  type AnalyticsReportAlias
} from "../analytics/constants.js";
import { fetchAnalytics } from "../analytics/fetch.js";
import { listApps, type AppSummary } from "./apps-list.js";

export async function analyticsFetchCommand(
  client: AppStoreConnectClient,
  command: {
    readonly appReference: string;
    readonly from: string;
    readonly to: string;
    readonly reports?: string;
    readonly granularity: string;
    readonly outDir: string;
    readonly format: "jsonl" | "csv";
    readonly json: boolean;
  }
): Promise<number> {
  const app = await resolveApp(client, command.appReference);
  const reports = parseReports(command.reports);
  const result = await fetchAnalytics(client, {
    appId: app.id,
    from: parseIsoDate(command.from, "--from"),
    to: parseIsoDate(command.to, "--to"),
    reports,
    granularity: assertGranularity(command.granularity),
    outDir: command.outDir,
    format: command.format
  });

  if (command.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log(`App: ${app.name} (${app.bundleId}) [${app.id}]`);
  console.log(`Request: ${result.requestId}`);
  console.log(
    `Instances processingDate ${result.processingDateFrom}..${result.processingDateTo} (${result.granularity})`
  );

  for (const report of result.reports) {
    console.log(
      `- ${report.alias}: ${report.reportName} [${report.reportId}] instances=${report.instances} rows=${report.rows}`
    );
  }

  console.log(`Stored ${result.rowCount} row(s) at ${result.outputPath}`);
  return 0;
}

function parseReports(value: string | undefined): AnalyticsReportAlias[] {
  if (!value) {
    return [...DEFAULT_ANALYTICS_REPORTS];
  }

  const aliases = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (aliases.length === 0) {
    return [...DEFAULT_ANALYTICS_REPORTS];
  }

  return aliases.map((alias) => assertReportAlias(alias));
}

async function resolveApp(
  client: AppStoreConnectClient,
  appReference: string
): Promise<AppSummary> {
  const apps = await listApps(client);
  const app = apps.find(
    (candidate) => candidate.id === appReference || candidate.bundleId === appReference
  );

  if (!app) {
    throw new InfrastructureError(`Could not resolve app reference "${appReference}".`);
  }

  return app;
}
