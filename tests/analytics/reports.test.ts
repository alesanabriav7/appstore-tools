import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { InfrastructureError, type AppStoreConnectClient, type HttpRequest } from "../../src/api/client.js";
import { fetchAnalytics } from "../../src/analytics/fetch.js";
import { summarizeDay } from "../../src/analytics/metrics.js";
import { setupAnalytics } from "../../src/analytics/requests.js";
import { readLedger, upsertRows, writeLedger, type AnalyticsStoredRow } from "../../src/analytics/store.js";
import { parseTsv } from "../../src/analytics/tsv.js";
import { createAppStoreVersion } from "../../src/commands/apps-create-version.js";
import { fetchSalesReport, formatSalesReport, SALES_QUERY } from "../../src/sales/sales-report.js";
import { checkRanks, ITUNES_SEARCH_LIMIT } from "../../src/ranks/itunes-search.js";

describe("parseTsv", () => {
  it("parses a header row and cells by header name", () => {
    const table = parseTsv("\uFEFFDate\tCounts\r\n2026-10-01\t5\r\n\r\n");

    expect(table.headers).toEqual(["Date", "Counts"]);
    expect(table.rows).toEqual([{ Date: "2026-10-01", Counts: "5" }]);
  });
});

describe("upsertRows", () => {
  it("replaces an older processingDate partition for the same report and date", () => {
    const older: AnalyticsStoredRow = {
      report: "downloads",
      date: "2026-10-08",
      processingDate: "2026-10-09",
      dimensions: { Territory: "US", "Download Type": "Redownload" },
      metrics: { Counts: 3 },
      thresholded: false
    };
    const newer: AnalyticsStoredRow = {
      report: "downloads",
      date: "2026-10-08",
      processingDate: "2026-10-10",
      dimensions: { Territory: "US", "Download Type": "First-time download" },
      metrics: { Counts: 12 },
      thresholded: false
    };

    const merged = upsertRows([older], [newer]);

    expect(merged).toEqual([newer]);
  });

  it("keeps a stored row when its processingDate is newer", () => {
    const stored: AnalyticsStoredRow = {
      report: "downloads",
      date: "2026-10-08",
      processingDate: "2026-10-12",
      dimensions: { Territory: "US" },
      metrics: { Counts: 9 },
      thresholded: false
    };
    const incoming: AnalyticsStoredRow = {
      ...stored,
      processingDate: "2026-10-11",
      metrics: { Counts: 1 }
    };

    expect(upsertRows([stored], [incoming])).toEqual([stored]);
  });
});

describe("setupAnalytics", () => {
  it("does not post during dry-run when no request exists", async () => {
    const { client, requests } = analyticsClient({ requests: [] });
    const result = await setupAnalytics(client, {
      appId: "6759523370",
      snapshot: false,
      apply: false
    });

    expect(result.ongoing.action).toBe("create");
    expect(result.adminKeyRequired).toBe(true);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("posts ONGOING when missing or stopped, and reuses an active request", async () => {
    const stopped = analyticsClient({
      requests: [
        { id: "old", accessType: "ONGOING", stoppedDueToInactivity: true }
      ]
    });
    await setupAnalytics(stopped.client, { appId: "app", snapshot: false, apply: true });
    const post = stopped.requests.find((request) => request.method === "POST");
    expect(post?.body).toMatchObject({
      data: {
        type: "analyticsReportRequests",
        attributes: { accessType: "ONGOING" },
        relationships: { app: { data: { type: "apps", id: "app" } } }
      }
    });

    const active = analyticsClient({
      requests: [
        { id: "keep", accessType: "ONGOING", stoppedDueToInactivity: false }
      ]
    });
    const reused = await setupAnalytics(active.client, {
      appId: "app",
      snapshot: true,
      apply: true
    });
    expect(reused.ongoing).toMatchObject({ action: "reuse", id: "keep" });
    expect(reused.snapshot).toMatchObject({ action: "create" });
    const posts = active.requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({
      data: { attributes: { accessType: "ONE_TIME_SNAPSHOT" } }
    });
  });
});

describe("fetchAnalytics", () => {
  it("downloads segments without a bearer token and keeps the latest processingDate", async () => {
    const downloads: Array<{ url: string; authorization: string | null }> = [];
    const { client, requests } = analyticsClient({
      requests: [
        { id: "req-1", accessType: "ONGOING", stoppedDueToInactivity: false }
      ],
      reports: [
        { id: "report-downloads", name: "App Downloads Standard", category: "COMMERCE" }
      ]
    });
    const outDir = await mkdtemp(join(tmpdir(), "asc-analytics-"));

    const result = await fetchAnalytics(
      client,
      {
        appId: "6759523370",
        from: "2026-10-08",
        to: "2026-10-08",
        reports: ["downloads"],
        granularity: "DAILY",
        outDir,
        format: "jsonl"
      },
      {
        fetchLike: async (url, init) => {
          const headers = new Headers(init?.headers);
          downloads.push({
            url: String(url),
            authorization: headers.get("authorization")
          });
          const counts = String(url).includes("inst-new") ? "12" : "4";
          const extra = String(url).includes("inst-old")
            ? "2026-10-08\tRedownload\tWeb referrer\tUS\t3\n"
            : "";
          const tsv =
            "Date\tDownload Type\tSource Type\tTerritory\tCounts\n" +
            `2026-10-08\tFirst-time download\tApp Store search\tUS\t${counts}\n` +
            extra;
          return new Response(gzipSync(Buffer.from(tsv, "utf8")));
        }
      }
    );

    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads.every((download) => download.authorization === null)).toBe(true);

    const instanceRequest = requests.find((request) => request.path.includes("/instances"));
    expect(instanceRequest?.query?.["filter[granularity]"]).toBe("DAILY");
    expect(String(instanceRequest?.query?.["filter[processingDate]"])).toContain("2026-10-08");
    expect(String(instanceRequest?.query?.["filter[processingDate]"])).toContain("2026-10-13");

    const stored = JSON.parse(await readFile(result.outputPath, "utf8")) as AnalyticsStoredRow;
    expect(stored.processingDate).toBe("2026-10-10");
    expect(stored.metrics.Counts).toBe(12);
    expect(stored.dimensions["Download Type"]).toBe("First-time download");

    const ledger = await readLedger(outDir, "6759523370");
    expect(ledger.some((row) => row.dimensions["Download Type"] === "Redownload")).toBe(false);
  });
});

describe("summarizeDay", () => {
  it("computes daily KPIs, conversion, completeness, and thresholded rows", () => {
    const rows: AnalyticsStoredRow[] = [
      row("discovery", {
        Event: "Impression",
        "Page Type": "",
        "Source Type": "App Store search",
        Counts: 100,
        "Unique Counts": 80
      }),
      row("discovery", {
        Event: "Page view",
        "Page Type": "Product page",
        "Source Type": "App Store search",
        Counts: 40,
        "Unique Counts": 20
      }),
      row("discovery", {
        Event: "Page view",
        "Page Type": "In-App Event",
        "Source Type": "App Store browse",
        Counts: 5,
        "Unique Counts": 4
      }),
      row("downloads", {
        "Download Type": "First-time download",
        "Source Type": "App Store search",
        Counts: 10
      }),
      row("downloads", {
        "Download Type": "Redownload",
        "Source Type": "App Store search",
        Counts: 2
      }),
      row("downloads", {
        "Download Type": "Auto-update",
        "Source Type": "App Store search",
        Counts: 50
      }),
      row("sessions", { "Source Type": "App Store search", Sessions: 7 }),
      row("crashes", { "Source Type": "iPhone", Crashes: 1 }, true)
    ];

    const summary = summarizeDay(rows, "2026-10-08", "2026-10-13");

    expect(summary.impressions).toBe(100);
    expect(summary.productPageViews).toBe(40);
    expect(summary.firstTimeDownloads).toBe(10);
    expect(summary.redownloads).toBe(2);
    expect(summary.conversionRate).toBeCloseTo(0.6);
    expect(summary.sessions).toBe(7);
    expect(summary.crashes).toBe(1);
    expect(summary.thresholded).toBe(true);
    expect(summary.isComplete).toEqual({
      discovery: true,
      downloads: true,
      installs: true,
      sessions: true,
      crashes: true
    });
    expect(summary.bySource["App Store search"]).toEqual({
      impressions: 100,
      productPageViews: 40,
      firstTimeDownloads: 10,
      redownloads: 2
    });
    expect(summary.bySource["App Store browse"]).toBeUndefined();
  });

  it("marks discovery incomplete inside three days and downloads incomplete inside two", () => {
    const summary = summarizeDay([], "2026-10-11", "2026-10-13");

    expect(summary.isComplete.discovery).toBe(false);
    expect(summary.isComplete.downloads).toBe(true);
    expect(summary.isComplete.sessions).toBe(false);
  });
});

describe("ledger csv round trip", () => {
  it("writes and reads csv rows", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "asc-ledger-"));
    const original: AnalyticsStoredRow = {
      report: "sessions",
      date: "2026-10-01",
      processingDate: "2026-10-06",
      dimensions: { Territory: "CO" },
      metrics: { Sessions: 4 },
      thresholded: false
    };

    await writeLedger(outDir, "app", [original], "csv");
    const loaded = await readLedger(outDir, "app");

    expect(loaded).toEqual([original]);
  });
});

describe("fetchSalesReport", () => {
  it("requests the daily summary report and gunzips the TSV", async () => {
    const requests: HttpRequest[] = [];
    const client = {
      requestBinary: async (request: HttpRequest) => {
        requests.push(request);
        const tsv = "Provider\tUnits\nACME\t8\n";
        return {
          status: 200,
          headers: new Headers(),
          data: gzipSync(Buffer.from(tsv, "utf8"))
        };
      }
    } as unknown as AppStoreConnectClient;

    const report = await fetchSalesReport(client, {
      vendorNumber: "87654321",
      reportDate: "2026-10-12"
    });

    expect(requests[0]?.path).toBe("/v1/salesReports");
    expect(requests[0]?.query).toEqual({
      [SALES_QUERY.reportType]: "SALES",
      [SALES_QUERY.reportSubType]: "SUMMARY",
      [SALES_QUERY.frequency]: "DAILY",
      [SALES_QUERY.reportDate]: "2026-10-12",
      [SALES_QUERY.vendorNumber]: "87654321",
      [SALES_QUERY.version]: "1_0"
    });
    expect(report.rows).toEqual([{ Provider: "ACME", Units: "8" }]);
    expect(formatSalesReport(report, "json")).toContain("\"Units\": \"8\"");
  });
});

describe("createAppStoreVersion", () => {
  it("posts the version and does not call the network until invoked", async () => {
    const requests: HttpRequest[] = [];
    const client = {
      request: async (request: HttpRequest) => {
        requests.push(request);
        return {
          status: 201,
          headers: new Headers(),
          data: {
            data: {
              id: "ver-9",
              attributes: {
                versionString: "1.4.0",
                platform: "IOS",
                appStoreState: "PREPARE_FOR_SUBMISSION"
              }
            }
          }
        };
      }
    } as unknown as AppStoreConnectClient;

    const created = await createAppStoreVersion(client, {
      appId: "6759523370",
      versionString: "1.4.0",
      platform: "IOS"
    });

    expect(created.id).toBe("ver-9");
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/appStoreVersions"
    });
  });
});

describe("checkRanks", () => {
  it("returns the search position or >200 and throttles between calls", async () => {
    const sleeps: number[] = [];
    const urls: string[] = [];
    const rows = await checkRanks(
      {
        appId: "6759523370",
        keywords: ["cifro"],
        countries: ["co", "us"]
      },
      {
        minIntervalMs: 3000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        fetchLike: async (url) => {
          urls.push(String(url));
          const country = new URL(String(url)).searchParams.get("country");
          const results =
            country === "co"
              ? [
                  { trackId: 1, trackName: "Other" },
                  { trackId: 6759523370, trackName: "Cifro" }
                ]
              : [{ trackId: 99, trackName: "Else" }];

          return new Response(JSON.stringify({ resultCount: results.length, results }));
        }
      }
    );

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("entity=software");
    expect(urls[0]).toContain(`limit=${ITUNES_SEARCH_LIMIT}`);
    expect(rows[0]).toMatchObject({ country: "co", rank: 2, trackName: "Cifro" });
    expect(rows[1]).toMatchObject({ country: "us", rank: ">200" });
    expect(sleeps).toEqual([3000]);
  });

  it("throws when the search response is not ok", async () => {
    await expect(
      checkRanks(
        { appId: "1", keywords: ["a"], countries: ["us"] },
        {
          sleep: async () => undefined,
          fetchLike: async () => new Response("nope", { status: 500 })
        }
      )
    ).rejects.toBeInstanceOf(InfrastructureError);
  });
});

function row(
  report: string,
  cells: Readonly<Record<string, string | number>>,
  thresholded = false
): AnalyticsStoredRow {
  const dimensions: Record<string, string> = {};
  const metrics: Record<string, number | null> = {};

  for (const [key, value] of Object.entries(cells)) {
    if (typeof value === "number") {
      metrics[key] = value;
    } else {
      dimensions[key] = value;
    }
  }

  return {
    report,
    date: "2026-10-08",
    processingDate: "2026-10-13",
    dimensions,
    metrics,
    thresholded
  };
}

function analyticsClient(options: {
  readonly requests: readonly {
    readonly id: string;
    readonly accessType: string;
    readonly stoppedDueToInactivity: boolean;
  }[];
  readonly reports?: readonly {
    readonly id: string;
    readonly name: string;
    readonly category: string;
  }[];
}): { client: AppStoreConnectClient; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const reports = options.reports ?? [];

  const client = {
    request: async <T>(request: HttpRequest) => {
      requests.push(request);

      if (
        request.method === "GET" &&
        request.path.includes("/analyticsReportRequests") &&
        !request.path.includes("/reports")
      ) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: options.requests.map((item) => ({
              id: item.id,
              attributes: {
                accessType: item.accessType,
                stoppedDueToInactivity: item.stoppedDueToInactivity
              }
            }))
          }
        };
      }

      if (request.method === "POST" && request.path === "/v1/analyticsReportRequests") {
        const body = request.body as {
          data?: { attributes?: { accessType?: string } };
        };
        return {
          status: 201,
          headers: new Headers(),
          data: {
            data: {
              id: `created-${body.data?.attributes?.accessType ?? "x"}`,
              attributes: {
                accessType: body.data?.attributes?.accessType,
                stoppedDueToInactivity: false
              }
            }
          }
        };
      }

      if (request.method === "GET" && request.path.endsWith("/reports")) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: reports.map((report) => ({
              id: report.id,
              attributes: { name: report.name, category: report.category }
            }))
          }
        };
      }

      if (request.method === "GET" && request.path.endsWith("/instances")) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: [
              {
                id: "inst-old",
                attributes: { granularity: "DAILY", processingDate: "2026-10-09" }
              },
              {
                id: "inst-new",
                attributes: { granularity: "DAILY", processingDate: "2026-10-10" }
              }
            ]
          }
        };
      }

      if (request.method === "GET" && request.path.endsWith("/segments")) {
        const instanceId = request.path.split("/")[3];
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: [
              {
                id: `seg-${instanceId}`,
                attributes: { url: `https://downloads.example/${instanceId}.txt.gz` }
              }
            ]
          }
        };
      }

      throw new Error(`Unexpected request: ${request.method} ${request.path}`);
    }
  } as AppStoreConnectClient;

  return { client, requests };
}
