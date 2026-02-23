import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";

const AUTH_KEY_FILE_PATTERN = /^AuthKey_([^.\\/]+)\.p8$/i;

export function inferAscKeyIdFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }

  const trimmed = filePath.trim();
  if (!trimmed) {
    return undefined;
  }

  const fileName = path.basename(trimmed);
  const match = AUTH_KEY_FILE_PATTERN.exec(fileName);
  const inferredKeyId = match?.[1]?.trim();

  return inferredKeyId && inferredKeyId.length > 0 ? inferredKeyId : undefined;
}

export async function inferAscKeyIdFromCurrentDirectory(
  cwd: string = process.cwd()
): Promise<string | undefined> {
  let entries: Dirent[];

  try {
    entries = await readdir(cwd, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return undefined;
  }

  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => inferAscKeyIdFromPath(entry.name))
    .filter((value): value is string => Boolean(value));

  const uniqueCandidates = [...new Set(candidates)];
  return uniqueCandidates.length === 1 ? uniqueCandidates[0] : undefined;
}

export async function resolveAscKeyIdFromEnvironment(
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const explicitKeyId = env.ASC_KEY_ID?.trim();
  if (explicitKeyId) {
    return explicitKeyId;
  }

  return (
    inferAscKeyIdFromPath(env.ASC_PRIVATE_KEY_PATH) ??
    inferAscKeyIdFromPath(env.ASC_KEY_PATH) ??
    (await inferAscKeyIdFromCurrentDirectory())
  );
}
