import { writeFile } from "node:fs/promises";

import { checkRanks, formatRanksCsv, parseCountries, readKeywords } from "../ranks/itunes-search.js";

export async function ranksCheckCommand(command: {
  readonly appReference: string;
  readonly keywordsPath: string;
  readonly countries: string;
  readonly outPath?: string;
  readonly json: boolean;
}): Promise<number> {
  const keywords = await readKeywords(command.keywordsPath);
  const countries = parseCountries(command.countries);
  const rows = await checkRanks({
    appId: command.appReference,
    keywords,
    countries
  });

  if (command.json) {
    const body = `${JSON.stringify(rows, null, 2)}\n`;

    if (command.outPath) {
      await writeFile(command.outPath, body, "utf8");
    } else {
      process.stdout.write(body);
    }

    return 0;
  }

  const csv = formatRanksCsv(rows);

  if (command.outPath) {
    await writeFile(command.outPath, csv, "utf8");
    console.log(`Wrote ${rows.length} rank row(s) to ${command.outPath}`);
    return 0;
  }

  process.stdout.write(csv);
  return 0;
}
