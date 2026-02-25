import { describe, expect, it } from "vitest";

import { updateMetadata, type MetadataUpdateInput } from "../../src/commands/apps-update-metadata.js";
import {
  DomainError,
  type AppStoreConnectClient,
  type HttpRequest,
  type HttpResponse
} from "../../src/api/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(options?: {
  readonly versions?: readonly {
    readonly id: string;
    readonly versionString: string;
    readonly appStoreState: string;
    readonly platform: string;
  }[];
  readonly localizations?: readonly {
    readonly id: string;
    readonly locale: string;
  }[];
  readonly screenshotSets?: readonly {
    readonly id: string;
    readonly screenshotDisplayType: string;
    readonly screenshots?: readonly string[];
  }[];
}): {
  client: AppStoreConnectClient;
  requests: HttpRequest[];
} {
  const requests: HttpRequest[] = [];

  const versions = options?.versions ?? [
    {
      id: "version-1",
      versionString: "1.0.0",
      appStoreState: "PREPARE_FOR_SUBMISSION",
      platform: "IOS"
    }
  ];

  const localizations = options?.localizations ?? [
    { id: "loc-en", locale: "en-US" }
  ];

  const screenshotSets = options?.screenshotSets ?? [];

  const client = {
    request: async <T>(request: HttpRequest) => {
      requests.push(request);

      // GET app store versions
      if (request.method === "GET" && request.path.includes("/appStoreVersions") && !request.path.includes("Localizations") && !request.path.includes("appScreenshotSets")) {
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

      // GET localizations
      if (request.method === "GET" && request.path.includes("/appStoreVersionLocalizations")) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: localizations.map((l) => ({
              id: l.id,
              attributes: { locale: l.locale }
            }))
          }
        } as HttpResponse<T>;
      }

      // PATCH localization
      if (request.method === "PATCH" && request.path.includes("/appStoreVersionLocalizations/")) {
        return { status: 200, headers: new Headers(), data: {} } as HttpResponse<T>;
      }

      // POST localization
      if (request.method === "POST" && request.path === "/v1/appStoreVersionLocalizations") {
        return {
          status: 201,
          headers: new Headers(),
          data: { data: { id: "loc-new" } }
        } as HttpResponse<T>;
      }

      // GET screenshot sets
      if (request.method === "GET" && request.path.includes("/appScreenshotSets")) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: screenshotSets.map((s) => ({
              id: s.id,
              attributes: { screenshotDisplayType: s.screenshotDisplayType },
              relationships: {
                appScreenshots: {
                  data: (s.screenshots ?? []).map((sid) => ({ id: sid }))
                }
              }
            }))
          }
        } as HttpResponse<T>;
      }

      // POST screenshot set
      if (request.method === "POST" && request.path === "/v1/appScreenshotSets") {
        return {
          status: 201,
          headers: new Headers(),
          data: { data: { id: "set-new" } }
        } as HttpResponse<T>;
      }

      // DELETE screenshot
      if (request.method === "DELETE" && request.path.includes("/appScreenshots/")) {
        return { status: 204, headers: new Headers(), data: {} } as HttpResponse<T>;
      }

      // POST screenshot (create reservation)
      if (request.method === "POST" && request.path === "/v1/appScreenshots") {
        return {
          status: 201,
          headers: new Headers(),
          data: {
            data: {
              id: "screenshot-new",
              attributes: { uploadOperations: [] }
            }
          }
        } as HttpResponse<T>;
      }

      // PATCH screenshot (commit)
      if (request.method === "PATCH" && request.path.includes("/appScreenshots/")) {
        return { status: 200, headers: new Headers(), data: {} } as HttpResponse<T>;
      }

      throw new Error(`Unexpected request: ${request.method} ${request.path}`);
    }
  } as AppStoreConnectClient;

  return { client, requests };
}

function baseInput(overrides?: Partial<MetadataUpdateInput>): MetadataUpdateInput {
  return {
    appId: "app-1",
    platform: "IOS",
    manifest: {
      "en-US": {
        description: "Updated description",
        keywords: "one, two"
      }
    },
    textOnly: false,
    screenshotsOnly: false,
    apply: false,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("updateMetadata", () => {
  it("dry-run returns planned operations without mutations", async () => {
    const { client, requests } = createMockClient();

    const result = await updateMetadata(client, baseInput());

    expect(result.mode).toBe("dry-run");
    expect(result.versionId).toBe("version-1");
    expect(result.versionString).toBe("1.0.0");
    expect(result.plannedOperations.length).toBeGreaterThan(0);
    expect(result.localizationsUpdated).toBe(0);
    expect(result.localizationsCreated).toBe(0);

    // Only GET requests in dry-run
    const mutationRequests = requests.filter(
      (r) => r.method === "POST" || r.method === "PATCH" || r.method === "DELETE"
    );
    expect(mutationRequests).toHaveLength(0);
  });

  it("updates existing localizations with text fields", async () => {
    const { client, requests } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({ apply: true })
    );

    expect(result.mode).toBe("applied");
    expect(result.localizationsUpdated).toBe(1);
    expect(result.localizationsCreated).toBe(0);

    const patchRequests = requests.filter(
      (r) => r.method === "PATCH" && r.path.includes("/appStoreVersionLocalizations/")
    );
    expect(patchRequests).toHaveLength(1);
    expect(patchRequests[0]!.path).toContain("loc-en");
  });

  it("creates new localizations for unknown locales", async () => {
    const { client, requests } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        manifest: {
          "es-MX": {
            description: "Descripción de la app",
            keywords: "palabra1, palabra2"
          }
        }
      })
    );

    expect(result.mode).toBe("applied");
    expect(result.localizationsUpdated).toBe(0);
    expect(result.localizationsCreated).toBe(1);

    const postRequests = requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/appStoreVersionLocalizations"
    );
    expect(postRequests).toHaveLength(1);
  });

  it("respects --text-only flag by skipping screenshots", async () => {
    const { client, requests } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        textOnly: true,
        manifest: {
          "en-US": {
            description: "Updated",
            screenshots: {
              APP_IPHONE_67: ["./screenshot.png"]
            }
          }
        }
      })
    );

    expect(result.localizationsUpdated).toBe(1);
    expect(result.screenshotsUploaded).toBe(0);

    // No screenshot-related requests
    const screenshotRequests = requests.filter(
      (r) => r.path.includes("appScreenshot")
    );
    expect(screenshotRequests).toHaveLength(0);
  });

  it("respects --screenshots-only flag by skipping text updates", async () => {
    const { client, requests } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        screenshotsOnly: true,
        manifest: {
          "en-US": {
            description: "Should be ignored",
            keywords: "also ignored"
          }
        }
      })
    );

    expect(result.localizationsUpdated).toBe(0);
    expect(result.localizationsCreated).toBe(0);

    const patchLocalizations = requests.filter(
      (r) => r.method === "PATCH" && r.path.includes("/appStoreVersionLocalizations/")
    );
    expect(patchLocalizations).toHaveLength(0);
  });

  it("errors on no editable version found", async () => {
    const { client } = createMockClient({
      versions: [
        {
          id: "version-1",
          versionString: "1.0.0",
          appStoreState: "READY_FOR_SALE",
          platform: "IOS"
        }
      ]
    });

    await expect(
      updateMetadata(client, baseInput({ apply: true }))
    ).rejects.toThrow(DomainError);

    await expect(
      updateMetadata(client, baseInput({ apply: true }))
    ).rejects.toThrow("No editable App Store version found");
  });

  it("handles multiple locales with mixed create and update", async () => {
    const { client } = createMockClient({
      localizations: [
        { id: "loc-en", locale: "en-US" }
      ]
    });

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        manifest: {
          "en-US": { description: "English description" },
          "es-MX": { description: "Descripción en español" },
          "fr-FR": { description: "Description en français" }
        }
      })
    );

    expect(result.localizationsUpdated).toBe(1);
    expect(result.localizationsCreated).toBe(2);
  });

  it("skips locales with no text fields in text mode", async () => {
    const { client } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        textOnly: true,
        manifest: {
          "en-US": {
            screenshots: { APP_IPHONE_67: ["./s.png"] }
          }
        }
      })
    );

    expect(result.localizationsUpdated).toBe(0);
    expect(result.localizationsCreated).toBe(0);
  });

  it("dry-run plans screenshot operations correctly", async () => {
    const { client } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        manifest: {
          "en-US": {
            description: "Test",
            screenshots: {
              APP_IPHONE_67: ["./s1.png", "./s2.png"],
              APP_IPAD_PRO_129: ["./ipad.png"]
            }
          }
        }
      })
    );

    expect(result.mode).toBe("dry-run");
    expect(result.plannedOperations).toContainEqual(
      expect.stringContaining("2 screenshot(s) for en-US [APP_IPHONE_67]")
    );
    expect(result.plannedOperations).toContainEqual(
      expect.stringContaining("1 screenshot(s) for en-US [APP_IPAD_PRO_129]")
    );
  });

  it("picks editable version from multiple versions", async () => {
    const { client } = createMockClient({
      versions: [
        {
          id: "version-released",
          versionString: "1.0.0",
          appStoreState: "READY_FOR_SALE",
          platform: "IOS"
        },
        {
          id: "version-editable",
          versionString: "2.0.0",
          appStoreState: "PREPARE_FOR_SUBMISSION",
          platform: "IOS"
        }
      ]
    });

    const result = await updateMetadata(client, baseInput());

    expect(result.versionId).toBe("version-editable");
    expect(result.versionString).toBe("2.0.0");
  });
});
