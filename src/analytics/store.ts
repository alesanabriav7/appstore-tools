import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { METRIC_HEADERS } from "./constants.js";

export interface AnalyticsStoredRow {
  readonly report: string;
  readonly date: string;
  readonly processingDate: string;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly metrics: Readonly<Record<string, number | null>>;
  readonly thresholded: boolean;
}

const METRIC_HEADER_SET = new Set<string>(METRIC_HEADERS.map((header) => header.toLowerCase()));
const META_COLUMNS = ["report", "date", "processingDate", "thresholded"] as const;

export function ledgerPath(outDir: string, appId: string, format: "jsonl" | "csv"): string {
  const extension = format === "csv" ? "csv" : "jsonl";
  return join(outDir, appId, `analytics.${extension}`);
}

export async function readLedger(
  outDir: string,
  appId: string
): Promise<AnalyticsStoredRow[]> {
  const jsonlPath = ledgerPath(outDir, appId, "jsonl");
  const csvPath = ledgerPath(outDir, appId, "csv");
  const jsonlRows = await readIfExists(jsonlPath, parseJsonl);
  const csvRows = await readIfExists(csvPath, parseCsvLedger);

  return upsertRows(jsonlRows, csvRows);
}

export async function writeLedger(
  outDir: string,
  appId: string,
  rows: readonly AnalyticsStoredRow[],
  format: "jsonl" | "csv"
): Promise<string> {
  const path = ledgerPath(outDir, appId, format);
  await mkdir(dirname(path), { recursive: true });
  const body = format === "csv" ? toCsv(rows) : toJsonl(rows);
  await writeFile(path, body, "utf8");
  return path;
}

/**
 * Latest processingDate wins for each (report, date).
 * A newer instance replaces the whole date partition so restated files do not
 * leave stale dimension rows behind. Within one processingDate, rows are keyed
 * by dimensions.
 */
export function upsertRows(
  existing: readonly AnalyticsStoredRow[],
  incoming: readonly AnalyticsStoredRow[]
): AnalyticsStoredRow[] {
  const reducedIncoming = keepLatestPartitions(incoming);
  const incomingProcessingDate = new Map<string, string>();

  for (const row of reducedIncoming) {
    incomingProcessingDate.set(partitionKey(row), row.processingDate);
  }

  const keptExisting = existing.filter((row) => {
    const incomingDate = incomingProcessingDate.get(partitionKey(row));

    if (!incomingDate) {
      return true;
    }

    return incomingDate < row.processingDate;
  });

  const existingWins = new Set(
    keptExisting
      .filter((row) => incomingProcessingDate.has(partitionKey(row)))
      .map((row) => partitionKey(row))
  );

  const acceptedIncoming = reducedIncoming.filter((row) => !existingWins.has(partitionKey(row)));

  return [...keptExisting, ...acceptedIncoming].sort(compareRows);
}

export function keepLatestPartitions(
  rows: readonly AnalyticsStoredRow[]
): AnalyticsStoredRow[] {
  const latestProcessingDate = new Map<string, string>();

  for (const row of rows) {
    const key = partitionKey(row);
    const current = latestProcessingDate.get(key);

    if (!current || row.processingDate > current) {
      latestProcessingDate.set(key, row.processingDate);
    }
  }

  const byDimension = new Map<string, AnalyticsStoredRow>();

  for (const row of rows) {
    if (latestProcessingDate.get(partitionKey(row)) !== row.processingDate) {
      continue;
    }

    byDimension.set(`${partitionKey(row)}\0${dimensionKey(row.dimensions)}`, row);
  }

  return [...byDimension.values()];
}

export function dimensionKey(dimensions: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.keys(dimensions)
      .sort()
      .map((key) => [key, dimensions[key] ?? ""])
  );
}

function partitionKey(row: Pick<AnalyticsStoredRow, "report" | "date">): string {
  return `${row.report}\0${row.date}`;
}

function compareRows(left: AnalyticsStoredRow, right: AnalyticsStoredRow): number {
  return (
    left.report.localeCompare(right.report) ||
    left.date.localeCompare(right.date) ||
    left.processingDate.localeCompare(right.processingDate) ||
    dimensionKey(left.dimensions).localeCompare(dimensionKey(right.dimensions))
  );
}

async function readIfExists(
  path: string,
  parse: (text: string) => AnalyticsStoredRow[]
): Promise<AnalyticsStoredRow[]> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }

    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function parseJsonl(text: string): AnalyticsStoredRow[] {
  const rows: AnalyticsStoredRow[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    rows.push(normalizeStoredRow(JSON.parse(trimmed) as Partial<AnalyticsStoredRow>));
  }

  return rows;
}

function normalizeStoredRow(value: Partial<AnalyticsStoredRow>): AnalyticsStoredRow {
  const dimensions: Record<string, string> = {};
  const metrics: Record<string, number | null> = {};

  for (const [key, cell] of Object.entries(value.dimensions ?? {})) {
    dimensions[key] = cell ?? "";
  }

  for (const [key, cell] of Object.entries(value.metrics ?? {})) {
    metrics[key] = typeof cell === "number" ? cell : null;
  }

  return {
    report: value.report ?? "",
    date: value.date ?? "",
    processingDate: value.processingDate ?? "",
    dimensions,
    metrics,
    thresholded: Boolean(value.thresholded)
  };
}

function toJsonl(rows: readonly AnalyticsStoredRow[]): string {
  if (rows.length === 0) {
    return "";
  }

  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function toCsv(rows: readonly AnalyticsStoredRow[]): string {
  const dimensionHeaders = new Set<string>();
  const metricHeaders = new Set<string>();

  for (const row of rows) {
    for (const header of Object.keys(row.dimensions)) {
      dimensionHeaders.add(header);
    }

    for (const header of Object.keys(row.metrics)) {
      metricHeaders.add(header);
    }
  }

  const headers = [
    ...META_COLUMNS,
    ...[...dimensionHeaders].sort(),
    ...[...metricHeaders].sort()
  ];
  const lines = [headers.join(",")];

  for (const row of rows) {
    const cells = headers.map((header) => csvCell(csvValue(row, header)));
    lines.push(cells.join(","));
  }

  return `${lines.join("\n")}\n`;
}

function csvValue(row: AnalyticsStoredRow, header: string): string {
  if (header === "report") return row.report;
  if (header === "date") return row.date;
  if (header === "processingDate") return row.processingDate;
  if (header === "thresholded") return row.thresholded ? "true" : "false";

  if (METRIC_HEADER_SET.has(header.toLowerCase()) || header in row.metrics) {
    const metric = metricByName(row.metrics, header);
    return metric === null || metric === undefined ? "" : String(metric);
  }

  return row.dimensions[header] ?? "";
}

function metricByName(
  metrics: Readonly<Record<string, number | null>>,
  header: string
): number | null | undefined {
  if (header in metrics) {
    return metrics[header];
  }

  const match = Object.entries(metrics).find(([key]) => key.toLowerCase() === header.toLowerCase());
  return match ? match[1] : undefined;
}

function parseCsvLedger(text: string): AnalyticsStoredRow[] {
  const records = parseCsvRecords(text);
  const headers = records[0];

  if (!headers || headers.length === 0) {
    return [];
  }

  return records.slice(1).map((cells) => {
    const record = new Map<string, string>();

    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];

      if (header) {
        record.set(header, cells[index] ?? "");
      }
    }

    const dimensions: Record<string, string> = {};
    const metrics: Record<string, number | null> = {};

    for (const [header, value] of record) {
      if ((META_COLUMNS as readonly string[]).includes(header)) {
        continue;
      }

      if (METRIC_HEADER_SET.has(header.toLowerCase())) {
        metrics[header] = value.trim() ? Number(value) : null;
        continue;
      }

      dimensions[header] = value;
    }

    return {
      report: record.get("report") ?? "",
      date: record.get("date") ?? "",
      processingDate: record.get("processingDate") ?? "",
      dimensions,
      metrics,
      thresholded: (record.get("thresholded") ?? "").toLowerCase() === "true"
    };
  });
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += character;
      }

      continue;
    }

    if (character === '"') {
      inQuotes = true;
      continue;
    }

    if (character === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }

      row.push(cell);
      cell = "";

      if (row.some((value) => value.length > 0)) {
        records.push(row);
      }

      row = [];
      continue;
    }

    cell += character ?? "";
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) {
      records.push(row);
    }
  }

  return records;
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}
