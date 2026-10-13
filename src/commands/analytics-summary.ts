import { InfrastructureError, type AppStoreConnectClient } from "../api/client.js";
import { parseIsoDate } from "../analytics/constants.js";
import { assertSummaryDate, summarizeDay, todayIso, type DailyKpi } from "../analytics/metrics.js";
import { readLedger } from "../analytics/store.js";
import { listApps, type AppSummary } from "./apps-list.js";

export async function analyticsSummaryCommand(
  client: AppStoreConnectClient,
  command: {
    readonly appReference: string;
    readonly date?: string;
    readonly inDir: string;
    readonly json: boolean;
  },
  now: Date = new Date()
): Promise<number> {
  const app = await resolveApp(client, command.appReference);
  const rows = await readLedger(command.inDir, app.id);
  const date = assertSummaryDate(
    rows,
    command.date ? parseIsoDate(command.date, "--date") : undefined
  );
  const summary = summarizeDay(rows, date, todayIso(now));

  if (command.json) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  printSummary(summary, app);
  return 0;
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

function printSummary(summary: DailyKpi, app: AppSummary): void {
  console.log(`App: ${app.name} (${app.bundleId}) [${app.id}]`);
  console.log(`Date: ${summary.date}`);
  console.log(`Impressions: ${summary.impressions}`);
  console.log(`Product page views: ${summary.productPageViews}`);
  console.log(`First-time downloads: ${summary.firstTimeDownloads}`);
  console.log(`Redownloads: ${summary.redownloads}`);
  console.log(
    `Conversion rate: ${summary.conversionRate === null ? "n/a" : summary.conversionRate.toFixed(4)}`
  );
  console.log(`Sessions: ${summary.sessions}`);
  console.log(`Crashes: ${summary.crashes}`);
  console.log(
    `Complete: discovery=${summary.isComplete.discovery} downloads=${summary.isComplete.downloads} installs=${summary.isComplete.installs} sessions=${summary.isComplete.sessions} crashes=${summary.isComplete.crashes}`
  );
  console.log(`Thresholded: ${summary.thresholded}`);
  console.log("By source:");

  for (const [source, bucket] of Object.entries(summary.bySource)) {
    console.log(
      `- ${source}: impressions=${bucket.impressions} pageViews=${bucket.productPageViews} firstTime=${bucket.firstTimeDownloads} redownloads=${bucket.redownloads}`
    );
  }
}
