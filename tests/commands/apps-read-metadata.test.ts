import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readMetadata, type AppsReadMetadataInput } from "../../src/commands/apps-read-metadata.js";
import { DomainError, type AppStoreConnectClient, type HttpRequest, type HttpResponse } from "../../src/api/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockOptions {
  readonly versions?: readonly {
    readonly id: string;
    readonly versionString: string;
    readonly appStoreState: string;
    readonly platform: string;
  }[];
  readonly versionLocalizations?: readonly {
    readonly id: string;
    readonly locale: string;
    readonly description?: string;
    readonly keywords?: string;
    readonly promotionalText?: string;
    readonly whatsNew?: string;
    readonly supportUrl?: string;
    readonly marketingUrl?: string;
  }[];
  readonly appInfos?: readonly { readonly id: string }[];
  readonly appInfoLocalizations?: readonly {
    readonly id: string;
    readonly locale: string;
    readonly name?: string;
    readonly subtitle?: string;
    readonly privacyPolicyUrl?: string;
  }[];
  readonly appInfoDetail?: {
    readonly primaryCategoryId?: string;
    readonly secondaryCategoryId?: string;
  };
}

function createMockClient(options?: MockOptions): {
  client: AppStoreConnectClient;
  requests: HttpRequest[];
} {
  const requests: HttpRequest[] = [];

  const versions = options?.versions ?? [
    { id: "version-1", versionString: "1.0.0", appStoreState: "READY_FOR_SALE", platform: "IOS" }
  ];

  const versionLocalizations = options?.versionLocalizations ?? [
    { id: "loc-en", locale: "en-US", description: "Great app", keywords: "finance, budget" }
  ];

  const appInfos = options?.appInfos ?? [{ id: "appinfo-1" }];

  const appInfoLocalizations = options?.appInfoLocalizations ?? [
    { id: "appinfoloc-en", locale: "en-US", name: "My App", subtitle: "Budget tracker" }
  ];

  const appInfoDetail = options?.appInfoDetail ?? { primaryCategoryId: "FINANCE" };

  const client = {
    request: async <T>(request: HttpRequest) => {
      requests.push(request);

      // GET appStoreVersions list
      if (
        request.method === "GET" &&
        request.path.includes("/appStoreVersions") &&
        !request.path.includes("Localizations")
      ) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: versions.map((v) => ({
              id: v.id,
              attributes: {
                versionString: v.versionString,
                appStoreState: v.appStoreState,
                platform: v.platform
              }
            }))
          }
        } as HttpResponse<T>;
      }

      // GET version localizations
      if (
        request.method === "GET" &&
        request.path.includes("/appStoreVersionLocalizations") &&
        !request.path.includes("/appScreenshotSets")
      ) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: versionLocalizations.map((l) => ({
              id: l.id,
              attributes: {
                locale: l.locale,
                description: l.description,
                keywords: l.keywords,
                promotionalText: l.promotionalText,
                whatsNew: l.whatsNew,
                supportUrl: l.supportUrl,
                marketingUrl: l.marketingUrl
              }
            }))
          }
        } as HttpResponse<T>;
      }

      // GET appInfos list
      if (
        request.method === "GET" &&
        request.path.match(/\/v1\/apps\/[^/]+\/appInfos$/)
      ) {
        return {
          status: 200,
          headers: new Headers(),
          data: { data: appInfos.map((ai) => ({ id: ai.id, type: "appInfos" })) }
        } as HttpResponse<T>;
      }

      // GET appInfo detail
      if (
        request.method === "GET" &&
        request.path.match(/\/v1\/appInfos\/[^/]+$/)
      ) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: {
              id: appInfos[0]!.id,
              attributes: {
                primaryCategory: appInfoDetail.primaryCategoryId
                  ? { id: appInfoDetail.primaryCategoryId }
                  : undefined,
                secondaryCategory: appInfoDetail.secondaryCategoryId
                  ? { id: appInfoDetail.secondaryCategoryId }
                  : undefined
              }
            }
          }
        } as HttpResponse<T>;
      }

      // GET appInfoLocalizations
      if (request.method === "GET" && request.path.includes("/appInfoLocalizations")) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: appInfoLocalizations.map((l) => ({
              id: l.id,
              attributes: {
                locale: l.locale,
                name: l.name,
                subtitle: l.subtitle,
                privacyPolicyUrl: l.privacyPolicyUrl
              }
            }))
          }
        } as HttpResponse<T>;
      }

      throw new Error(`Unexpected request: ${request.method} ${request.path}`);
    }
  } as AppStoreConnectClient;

  return { client, requests };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "asc-read-metadata-test-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true });
});

function outputPath(name: string): string {
  return join(tempDir, name);
}

describe("readMetadata", () => {
  it("writes manifest JSON to the output path", async () => {
    const { client } = createMockClient();
    const out = outputPath("basic.json");

    const result = await readMetadata(client, {
      appId: "app-1",
      platform: "IOS",
      outputPath: out
    });

    expect(result.versionId).toBe("version-1");
    expect(result.versionString).toBe("1.0.0");
    expect(result.appStoreState).toBe("READY_FOR_SALE");
    expect(result.outputPath).toBe(out);

    const written = JSON.parse(await readFile(out, "utf-8"));
    expect(written["en-US"]).toBeDefined();
    expect(written["en-US"].description).toBe("Great app");
    expect(written["en-US"].keywords).toBe("finance, budget");
  });

  it("merges version localization and app info localization per locale", async () => {
    const { client } = createMockClient();
    const out = outputPath("merged.json");

    const result = await readMetadata(client, {
      appId: "app-1",
      platform: "IOS",
      outputPath: out
    });

    const locale = result.manifest["en-US"] as Record<string, string>;
    expect(locale.description).toBe("Great app");
    expect(locale.name).toBe("My App");
    expect(locale.subtitle).toBe("Budget tracker");
  });

  it("includes _app block with primaryCategory when present", async () => {
    const { client } = createMockClient({
      appInfoDetail: { primaryCategoryId: "FINANCE" }
    });
    const out = outputPath("app-block.json");

    const result = await readMetadata(client, {
      appId: "app-1",
      platform: "IOS",
      outputPath: out
    });

    const app = result.manifest["_app"] as Record<string, string> | undefined;
    expect(app).toBeDefined();
    expect(app!.primaryCategory).toBe("FINANCE");
  });

  it("includes secondaryCategory in _app when present", async () => {
    const { client } = createMockClient({
      appInfoDetail: { primaryCategoryId: "FINANCE", secondaryCategoryId: "PRODUCTIVITY" }
    });
    const out = outputPath("secondary.json");

    const result = await readMetadata(client, {
      appId: "app-1",
      platform: "IOS",
      outputPath: out
    });

    const app = result.manifest["_app"] as Record<string, string> | undefined;
    expect(app!.primaryCategory).toBe("FINANCE");
    expect(app!.secondaryCategory).toBe("PRODUCTIVITY");
  });

  it("omits _app block when no category data", async () => {
    const { client } = createMockClient({
      appInfoDetail: {}
    });
    const out = outputPath("no-app.json");

    const result = await readMetadata(client, {
      appId: "app-1",
      platform: "IOS",
      outputPath: out
    });

    expect(result.manifest["_app"]).toBeUndefined();
  });

  it("includes whatsNewText in locale when present", async () => {
    const { client } = createMockClient({
      versionLocalizations: [
        {
          id: "loc-en",
          locale: "en-US",
          description: "Updated app",
          whatsNew: "Bug fixes and performance improvements."
        }
      ]
    });
    const out = outputPath("whatsnew.json");

    const result = await readMetadata(client, {
      appId: "app-1",
      platform: "IOS",
      outputPath: out
    });

    const locale = result.manifest["en-US"] as Record<string, string>;
    expect(locale.whatsNewText).toBe("Bug fixes and performance improvements.");
  });

  it("handles multiple locales", async () => {
    const { client } = createMockClient({
      versionLocalizations: [
        { id: "loc-en", locale: "en-US", description: "English" },
        { id: "loc-es", locale: "es-MX", description: "Español" }
      ],
      appInfoLocalizations: [
        { id: "appinfoloc-en", locale: "en-US", name: "My App" },
        { id: "appinfoloc-es", locale: "es-MX", name: "Mi App" }
      ]
    });
    const out = outputPath("multi.json");

    const result = await readMetadata(client, {
      appId: "app-1",
      platform: "IOS",
      outputPath: out
    });

    const en = result.manifest["en-US"] as Record<string, string>;
    const es = result.manifest["es-MX"] as Record<string, string>;

    expect(en.description).toBe("English");
    expect(en.name).toBe("My App");
    expect(es.description).toBe("Español");
    expect(es.name).toBe("Mi App");
  });

  it("omits empty locale fields", async () => {
    const { client } = createMockClient({
      versionLocalizations: [
        { id: "loc-en", locale: "en-US", description: "Hello" }
      ],
      appInfoLocalizations: [
        { id: "appinfoloc-en", locale: "en-US" }
      ]
    });
    const out = outputPath("omit-empty.json");

    const result = await readMetadata(client, {
      appId: "app-1",
      platform: "IOS",
      outputPath: out
    });

    const locale = result.manifest["en-US"] as Record<string, string>;
    expect(locale.description).toBe("Hello");
    expect(locale.name).toBeUndefined();
    expect(locale.subtitle).toBeUndefined();
    expect(locale.keywords).toBeUndefined();
  });

  it("throws DomainError when no versions are found", async () => {
    const { client } = createMockClient({ versions: [] });

    await expect(
      readMetadata(client, {
        appId: "app-1",
        platform: "IOS",
        outputPath: outputPath("no-version.json")
      })
    ).rejects.toThrow(DomainError);
  });

  it("throws DomainError with version string in message when version filter specified", async () => {
    const { client } = createMockClient({ versions: [] });

    await expect(
      readMetadata(client, {
        appId: "app-1",
        platform: "IOS",
        version: "9.9.9",
        outputPath: outputPath("no-version-filtered.json")
      })
    ).rejects.toThrow("9.9.9");
  });

  it("passes platform and version filters to the API query", async () => {
    const { client, requests } = createMockClient();
    const out = outputPath("filter-check.json");

    await readMetadata(client, {
      appId: "app-1",
      platform: "MAC_OS",
      version: "2.0.0",
      outputPath: out
    });

    const versionReq = requests.find(
      (r) => r.method === "GET" && r.path.includes("/appStoreVersions")
    );
    expect(versionReq?.query?.["filter[platform]"]).toBe("MAC_OS");
    expect(versionReq?.query?.["filter[versionString]"]).toBe("2.0.0");
  });

  it("written JSON is valid and round-trips correctly", async () => {
    const { client } = createMockClient();
    const out = outputPath("roundtrip.json");

    await readMetadata(client, {
      appId: "app-1",
      platform: "IOS",
      outputPath: out
    });

    const raw = await readFile(out, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed["en-US"].description).toBe("Great app");
    expect(parsed["_app"].primaryCategory).toBe("FINANCE");
  });
});
