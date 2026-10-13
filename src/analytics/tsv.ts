import { DATE_HEADER, METRIC_HEADERS } from "./constants.js";
import type { AnalyticsStoredRow } from "./store.js";

export interface ParsedTsv {
  readonly headers: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

const METRIC_HEADER_SET = new Set<string>(METRIC_HEADERS);

const THRESHOLD_VALUE = /^(?:<(?:=)?\s*\d+|threshold(?:ed)?|n\/a|—|–|-)$/i;

export function parseTsv(text: string): ParsedTsv {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = withoutBom.split(/\r?\n/).filter((line) => line.trim().length > 0);

  const headerLine = lines[0];

  if (!headerLine) {
    return { headers: [], rows: [] };
  }

  const headers = headerLine.split("\t").map((header) => header.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row: Record<string, string> = {};

    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];

      if (!header) {
        continue;
      }

      row[header] = (cells[index] ?? "").trim();
    }

    return row;
  });

  return { headers, rows };
}

export function tsvToStoredRows(
  report: string,
  processingDate: string,
  table: ParsedTsv
): AnalyticsStoredRow[] {
  const dateHeader = findHeader(table.headers, DATE_HEADER);

  return table.rows.map((row) => {
    const dimensions: Record<string, string> = {};
    const metrics: Record<string, number | null> = {};
    let thresholded = false;

    for (const header of table.headers) {
      if (!header || header === dateHeader) {
        continue;
      }

      const raw = row[header] ?? "";

      if (isMetricHeader(header)) {
        const parsed = parseMetric(raw);
        metrics[header] = parsed.value;

        if (parsed.thresholded) {
          thresholded = true;
        }

        continue;
      }

      dimensions[header] = raw;
    }

    const dateRaw = dateHeader ? (row[dateHeader] ?? "") : "";

    return {
      report,
      date: normalizeReportDate(dateRaw),
      processingDate,
      dimensions,
      metrics,
      thresholded
    };
  });
}

export function findHeader(
  headers: readonly string[],
  ...candidates: readonly string[]
): string | undefined {
  const wanted = new Set(candidates.map((candidate) => candidate.toLowerCase()));
  return headers.find((header) => wanted.has(header.toLowerCase()));
}

export function readCell(
  row: { readonly dimensions: Readonly<Record<string, string>> },
  ...candidates: readonly string[]
): string {
  const wanted = new Set(candidates.map((candidate) => candidate.toLowerCase()));

  for (const [header, value] of Object.entries(row.dimensions)) {
    if (wanted.has(header.toLowerCase())) {
      return value;
    }
  }

  return "";
}

export function readMetric(
  row: { readonly metrics: Readonly<Record<string, number | null>> },
  ...candidates: readonly string[]
): number | null {
  const wanted = new Set(candidates.map((candidate) => candidate.toLowerCase()));

  for (const [header, value] of Object.entries(row.metrics)) {
    if (wanted.has(header.toLowerCase())) {
      return value;
    }
  }

  return null;
}

function isMetricHeader(header: string): boolean {
  const normalized = header.toLowerCase();

  for (const metric of METRIC_HEADER_SET) {
    if (metric.toLowerCase() === normalized) {
      return true;
    }
  }

  return false;
}

function parseMetric(raw: string): { readonly value: number | null; readonly thresholded: boolean } {
  const trimmed = raw.trim();

  if (!trimmed || THRESHOLD_VALUE.test(trimmed)) {
    return { value: null, thresholded: true };
  }

  const value = Number(trimmed);

  if (!Number.isFinite(value)) {
    return { value: null, thresholded: false };
  }

  return { value, thresholded: false };
}

function normalizeReportDate(raw: string): string {
  const trimmed = raw.trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);

  if (!us) {
    return trimmed;
  }

  const month = us[1]!.padStart(2, "0");
  const day = us[2]!.padStart(2, "0");
  return `${us[3]}-${month}-${day}`;
}
