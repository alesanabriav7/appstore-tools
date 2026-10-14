import { readFile } from "node:fs/promises";

import { InfrastructureError, type FetchLike } from "../api/client.js";

export const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";
export const ITUNES_SEARCH_LIMIT = 200;
export const ITUNES_MIN_INTERVAL_MS = 3000;

export interface RankRow {
  readonly keyword: string;
  readonly country: string;
  readonly rank: number | ">200";
  readonly trackId: string;
  readonly trackName: string;
}

interface ItunesSearchResponse {
  readonly resultCount?: number;
  readonly results?: readonly {
    readonly trackId?: number;
    readonly trackName?: string;
    readonly bundleId?: string;
  }[];
}

export async function readKeywords(filePath: string): Promise<string[]> {
  let text: string;

  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new InfrastructureError(`Failed to read keywords file at "${filePath}".`, error);
  }

  const keywords = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (keywords.length === 0) {
    throw new InfrastructureError(`Keywords file "${filePath}" has no keywords.`);
  }

  return keywords;
}

export function parseCountries(value: string): string[] {
  const countries = value
    .split(",")
    .map((country) => country.trim().toLowerCase())
    .filter((country) => country.length > 0);

  if (countries.length === 0) {
    throw new InfrastructureError("Missing required option: --country");
  }

  for (const country of countries) {
    if (!/^[a-z]{2}$/.test(country)) {
      throw new InfrastructureError(
        `Invalid country "${country}". Expected ISO country codes such as co,us.`
      );
    }
  }

  return countries;
}

export async function checkRanks(
  input: {
    readonly appId: string;
    readonly keywords: readonly string[];
    readonly countries: readonly string[];
  },
  options?: {
    readonly fetchLike?: FetchLike;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly minIntervalMs?: number;
  }
): Promise<RankRow[]> {
  const fetchLike = options?.fetchLike ?? fetch;
  const sleep = options?.sleep ?? delay;
  const minIntervalMs = options?.minIntervalMs ?? ITUNES_MIN_INTERVAL_MS;
  const rows: RankRow[] = [];
  let requestCount = 0;

  for (const keyword of input.keywords) {
    for (const country of input.countries) {
      if (requestCount > 0) {
        await sleep(minIntervalMs);
      }

      requestCount += 1;
      rows.push(await searchRank(fetchLike, input.appId, keyword, country));
    }
  }

  return rows;
}

export function formatRanksCsv(rows: readonly RankRow[]): string {
  const lines = ["keyword,country,rank,trackId,trackName"];

  for (const row of rows) {
    lines.push(
      [row.keyword, row.country, String(row.rank), row.trackId, row.trackName]
        .map(csvCell)
        .join(",")
    );
  }

  return `${lines.join("\n")}\n`;
}

async function searchRank(
  fetchLike: FetchLike,
  appId: string,
  keyword: string,
  country: string
): Promise<RankRow> {
  const url = new URL(ITUNES_SEARCH_URL);
  url.searchParams.set("term", keyword);
  url.searchParams.set("country", country);
  url.searchParams.set("entity", "software");
  url.searchParams.set("limit", String(ITUNES_SEARCH_LIMIT));

  const response = await fetchLike(url, { method: "GET" });

  if (!response.ok) {
    throw new InfrastructureError(
      `iTunes Search failed for "${keyword}" in ${country} (${response.status}).`
    );
  }

  let payload: ItunesSearchResponse;

  try {
    payload = (await response.json()) as ItunesSearchResponse;
  } catch (error) {
    throw new InfrastructureError("iTunes Search returned invalid JSON.", error);
  }

  const results = payload.results ?? [];
  const index = results.findIndex(
    (result) =>
      String(result.trackId ?? "") === appId || (result.bundleId ?? "") === appId
  );

  if (index < 0) {
    return {
      keyword,
      country,
      rank: ">200",
      trackId: "",
      trackName: ""
    };
  }

  const match = results[index]!;

  return {
    keyword,
    country,
    rank: index + 1,
    trackId: String(match.trackId ?? ""),
    trackName: match.trackName ?? ""
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}
