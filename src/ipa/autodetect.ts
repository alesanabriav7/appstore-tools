import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";

import { InfrastructureError } from "../api/client.js";
import {
  defaultProcessRunner,
  type IpaSource,
  type ProcessRunner
} from "./artifact.js";

interface AutoDetectIpaSourceOptions {
  readonly cwd?: string;
  readonly processRunner?: ProcessRunner;
}

interface AutoDetectIpaGenerateSourceOptions {
  readonly cwd?: string;
  readonly processRunner?: ProcessRunner;
}

interface XcodeProjectContainer {
  readonly kind: "workspace" | "project";
  readonly path: string;
}

interface XcodeListJsonPayload {
  readonly workspace?: {
    readonly schemes?: readonly string[];
  };
  readonly project?: {
    readonly schemes?: readonly string[];
  };
}

const DEFAULT_SCAN_DEPTH = 3;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "DerivedData"
]);

export async function autoDetectIpaSource(
  options: AutoDetectIpaSourceOptions = {}
): Promise<IpaSource> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const processRunner = options.processRunner ?? defaultProcessRunner;

  const prebuiltIpa = await detectPrebuiltIpa(cwd);
  if (prebuiltIpa) {
    return { kind: "prebuilt", ipaPath: prebuiltIpa };
  }

  const container = await detectXcodeContainer(cwd);
  const exportOptionsPlist = await detectExportOptionsPlist(cwd, container.path);
  const scheme = await detectScheme(container, processRunner);

  return {
    kind: "xcodebuild",
    scheme,
    exportOptionsPlist,
    ...(container.kind === "workspace"
      ? { workspacePath: container.path }
      : { projectPath: container.path })
  };
}

export async function autoDetectIpaGenerateSource(
  options: AutoDetectIpaGenerateSourceOptions = {}
): Promise<Exclude<IpaSource, { kind: "prebuilt" }>> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const processRunner = options.processRunner ?? defaultProcessRunner;

  const container = await detectXcodeContainer(cwd).catch((error: unknown) => {
    throw new InfrastructureError(
      [
        "Could not auto-detect an IPA generation source.",
        "Provide xcodebuild options (--scheme, --export-options-plist, --workspace-path/--project-path) or custom command options (--build-command, --generated-ipa-path)."
      ].join(" "),
      error
    );
  });
  const exportOptionsPlist = await detectExportOptionsPlist(cwd, container.path);
  const scheme = await detectScheme(container, processRunner);

  return {
    kind: "xcodebuild",
    scheme,
    exportOptionsPlist,
    ...(container.kind === "workspace"
      ? { workspacePath: container.path }
      : { projectPath: container.path })
  };
}

export function createDefaultOutputIpaPath(
  source: Exclude<IpaSource, { kind: "prebuilt" }>,
  cwd: string = process.cwd()
): string {
  const baseName = source.kind === "xcodebuild" ? source.scheme : "generated";
  const sanitized = sanitizeFileSegment(baseName);
  return path.resolve(cwd, "dist", `${sanitized}.ipa`);
}

async function detectPrebuiltIpa(cwd: string): Promise<string | null> {
  const ipaFiles = await findPaths(cwd, {
    maxDepth: DEFAULT_SCAN_DEPTH,
    includePath: (entryPath) => entryPath.endsWith(".ipa")
  });

  if (ipaFiles.length === 0) {
    return null;
  }

  const withStats = (
    await Promise.all(
      ipaFiles.map(async (ipaPath) => {
        try {
          const details = await stat(ipaPath);
          if (!details.isFile()) {
            return null;
          }

          return {
            ipaPath,
            modifiedAt: details.mtimeMs
          };
        } catch {
          return null;
        }
      })
    )
  ).filter((entry): entry is { ipaPath: string; modifiedAt: number } => entry !== null);

  if (withStats.length === 0) {
    return null;
  }

  withStats.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return withStats[0]?.ipaPath ?? null;
}

async function detectXcodeContainer(cwd: string): Promise<XcodeProjectContainer> {
  const [workspaces, projects] = await Promise.all([
    findPaths(cwd, {
      maxDepth: DEFAULT_SCAN_DEPTH,
      includePath: (entryPath) => entryPath.endsWith(".xcworkspace")
    }),
    findPaths(cwd, {
      maxDepth: DEFAULT_SCAN_DEPTH,
      includePath: (entryPath) => entryPath.endsWith(".xcodeproj")
    })
  ]);

  if (workspaces.length > 0) {
    return {
      kind: "workspace",
      path: chooseBestPath(workspaces, cwd, "--workspace-path")
    };
  }

  if (projects.length > 0) {
    return {
      kind: "project",
      path: chooseBestPath(projects, cwd, "--project-path")
    };
  }

  throw new InfrastructureError(
    [
      "Could not auto-detect an IPA source.",
      "Provide --ipa <path> or xcodebuild options (--scheme, --export-options-plist, --workspace-path/--project-path)."
    ].join(" ")
  );
}

async function detectExportOptionsPlist(cwd: string, containerPath: string): Promise<string> {
  const plistPaths = await findPaths(cwd, {
    maxDepth: DEFAULT_SCAN_DEPTH,
    includePath: (entryPath) => /export[-_ ]?options\.plist$/i.test(path.basename(entryPath))
  });

  if (plistPaths.length === 0) {
    throw new InfrastructureError(
      "Could not auto-detect ExportOptions.plist. Provide --export-options-plist <path>."
    );
  }

  if (plistPaths.length === 1) {
    return plistPaths[0]!;
  }

  const containerDirectory = path.dirname(containerPath);
  const sortedByDistance = [...plistPaths].sort((left, right) => {
    return pathDistance(left, containerDirectory) - pathDistance(right, containerDirectory);
  });

  return sortedByDistance[0]!;
}

async function detectScheme(
  container: XcodeProjectContainer,
  processRunner: ProcessRunner
): Promise<string> {
  const args = container.kind === "workspace"
    ? ["-list", "-json", "-workspace", container.path]
    : ["-list", "-json", "-project", container.path];

  const output = await processRunner.run("xcodebuild", args);
  const payload = parseJsonPayload(output.stdout);
  const schemes = payload.workspace?.schemes ?? payload.project?.schemes ?? [];

  if (schemes.length === 0) {
    throw new InfrastructureError(
      `Could not auto-detect a scheme from ${container.path}. Provide --scheme <name>.`
    );
  }

  if (schemes.length === 1) {
    return schemes[0]!;
  }

  const baseName = path.basename(container.path, path.extname(container.path));

  const exactMatch = schemes.find((scheme) => scheme === baseName);
  if (exactMatch) {
    return exactMatch;
  }

  const caseInsensitiveMatch = schemes.find(
    (scheme) => scheme.toLowerCase() === baseName.toLowerCase()
  );
  if (caseInsensitiveMatch) {
    return caseInsensitiveMatch;
  }

  throw new InfrastructureError(
    [
      `Multiple schemes found for ${container.path}: ${schemes.join(", ")}.`,
      "Provide --scheme <name>."
    ].join(" ")
  );
}

function parseJsonPayload(stdout: string): XcodeListJsonPayload {
  const jsonStart = stdout.indexOf("{");
  const jsonEnd = stdout.lastIndexOf("}");

  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new InfrastructureError("Failed to parse xcodebuild -list -json output.");
  }

  const jsonCandidate = stdout.slice(jsonStart, jsonEnd + 1);

  try {
    return JSON.parse(jsonCandidate) as XcodeListJsonPayload;
  } catch (error) {
    throw new InfrastructureError("Failed to parse xcodebuild -list -json output.", error);
  }
}

function pathDistance(filePath: string, basePath: string): number {
  const relative = path.relative(basePath, filePath);
  return relative.split(path.sep).length;
}

function chooseBestPath(paths: readonly string[], cwd: string, flagName: string): string {
  if (paths.length === 1) {
    return paths[0]!;
  }

  const cwdBaseName = path.basename(cwd).toLowerCase();
  const byNameMatch = paths.find((entryPath) => {
    const entryBase = path.basename(entryPath, path.extname(entryPath)).toLowerCase();
    return entryBase === cwdBaseName;
  });

  if (byNameMatch) {
    return byNameMatch;
  }

  throw new InfrastructureError(
    [
      `Multiple ${flagName} candidates found:`,
      paths.join(", "),
      `Provide ${flagName} explicitly.`
    ].join(" ")
  );
}

function sanitizeFileSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
  return normalized.length > 0 ? normalized : "generated";
}

async function findPaths(
  rootPath: string,
  options: {
    readonly maxDepth: number;
    readonly includePath: (entryPath: string) => boolean;
  }
): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentPath: string, depth: number): Promise<void> {
    if (depth > options.maxDepth) {
      return;
    }

    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);

      if (options.includePath(entryPath)) {
        results.push(entryPath);
      }

      if (!entry.isDirectory()) {
        continue;
      }

      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      await walk(entryPath, depth + 1);
    }
  }

  await walk(rootPath, 0);
  return results.map((entryPath) => path.resolve(entryPath));
}
