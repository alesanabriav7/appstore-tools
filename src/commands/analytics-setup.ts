import { InfrastructureError, type AppStoreConnectClient } from "../api/client.js";
import { setupAnalytics, type AnalyticsSetupResult } from "../analytics/requests.js";
import { listApps, type AppSummary } from "./apps-list.js";

export async function analyticsSetupCommand(
  client: AppStoreConnectClient,
  command: {
    readonly appReference: string;
    readonly snapshot: boolean;
    readonly apply: boolean;
    readonly json: boolean;
  }
): Promise<number> {
  const app = await resolveApp(client, command.appReference);
  const result = await setupAnalytics(client, {
    appId: app.id,
    snapshot: command.snapshot,
    apply: command.apply
  });

  if (command.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  printSetupResult(result, app);
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

function printSetupResult(result: AnalyticsSetupResult, app: AppSummary): void {
  console.log(`Mode: ${result.mode}`);
  console.log(`App: ${app.name} (${app.bundleId}) [${app.id}]`);
  console.log(result.note);
  console.log(
    `ONGOING: ${result.ongoing.action}${result.ongoing.id ? ` [${result.ongoing.id}]` : ""}`
  );

  if (result.snapshot) {
    console.log(
      `ONE_TIME_SNAPSHOT: ${result.snapshot.action}${result.snapshot.id ? ` [${result.snapshot.id}]` : ""}`
    );
  }

  if (result.mode === "dry-run") {
    console.log("Dry-run completed. No App Store Connect mutation requests were sent.");
    console.log("Re-run with --apply to create missing report requests.");
  }
}
