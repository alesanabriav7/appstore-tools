import type { AppStoreConnectClient } from "../api/client.js";
import { fetchSalesReport, formatSalesReport } from "../sales/sales-report.js";

export async function salesFetchCommand(
  client: AppStoreConnectClient,
  command: {
    readonly date: string;
    readonly vendorNumber: string;
    readonly format: "csv" | "json";
  }
): Promise<number> {
  const report = await fetchSalesReport(client, {
    vendorNumber: command.vendorNumber,
    reportDate: command.date
  });

  process.stdout.write(formatSalesReport(report, command.format));
  return 0;
}
