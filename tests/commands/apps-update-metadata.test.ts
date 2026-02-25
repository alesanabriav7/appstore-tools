import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { updateMetadata, validateManifest, type MetadataUpdateInput } from "../../src/commands/apps-update-metadata.js";
import {
  DomainError,
  type AppStoreConnectClient,
  type HttpRequest,
  type HttpResponse
} from "../../src/api/client.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: vi.fn()
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn()
  };
});

vi.mock("../../src/api/types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/types.js")>();
  return {
    ...actual,
    executeUploadOperations: vi.fn().mockResolvedValue(undefined)
  };
});

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
      if (request.method === "GET" && request.path.includes("/appStoreVersionLocalizations") && !request.path.includes("/appScreenshotSets")) {
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

describe("validateManifest", () => {
  it("rejects an array as top-level value", () => {
    expect(() => validateManifest([{ "en-US": {} }])).toThrow(
      "Invalid manifest: top-level value must be a JSON object."
    );
  });

  it("rejects a locale value that is a string", () => {
    expect(() => validateManifest({ "en-US": "bad" })).toThrow(
      'Invalid manifest: locale "en-US" must be a JSON object.'
    );
  });

  it("rejects a text field that is a number", () => {
    expect(() => validateManifest({ "en-US": { description: 42 } })).toThrow(
      'Invalid manifest: locale "en-US" field "description" must be a string.'
    );
  });

  it("rejects screenshots as a string", () => {
    expect(() => validateManifest({ "en-US": { screenshots: "bad" } })).toThrow(
      'Invalid manifest: locale "en-US" field "screenshots" must be a JSON object.'
    );
  });

  it("rejects a screenshot display type mapped to a string", () => {
    expect(() =>
      validateManifest({ "en-US": { screenshots: { APP_IPHONE_67: "not-array" } } })
    ).toThrow(
      'Invalid manifest: locale "en-US" screenshots["APP_IPHONE_67"] must be an array of file paths.'
    );
  });

  it("rejects screenshot array containing non-strings", () => {
    expect(() =>
      validateManifest({ "en-US": { screenshots: { APP_IPHONE_67: [123] } } })
    ).toThrow(
      'Invalid manifest: locale "en-US" screenshots["APP_IPHONE_67"] must be an array of file paths.'
    );
  });

  it("accepts a valid manifest", () => {
    const manifest = validateManifest({
      "en-US": {
        description: "Hello",
        screenshots: { APP_IPHONE_67: ["./s1.png"] }
      }
    });

    expect(manifest).toEqual({
      "en-US": {
        description: "Hello",
        screenshots: { APP_IPHONE_67: ["./s1.png"] }
      }
    });
  });
});

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

  it("errors when both --text-only and --screenshots-only are provided", async () => {
    const { client } = createMockClient();

    await expect(
      updateMetadata(
        client,
        baseInput({
          apply: true,
          textOnly: true,
          screenshotsOnly: true,
          manifest: { "en-US": { description: "Test" } }
        })
      )
    ).rejects.toThrow("--text-only and --screenshots-only are mutually exclusive");
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

  it("screenshot upload flow deletes old, creates new, uploads, and commits", async () => {
    const { createReadStream } = await import("node:fs");
    const { stat } = await import("node:fs/promises");
    const mockedStat = vi.mocked(stat);
    const mockedCreateReadStream = vi.mocked(createReadStream);

    mockedStat.mockResolvedValue({ size: 12345 } as Awaited<ReturnType<typeof stat>>);

    mockedCreateReadStream.mockImplementation(() => {
      const stream = new Readable({
        read() {
          this.push(Buffer.from("fake-screenshot-data"));
          this.push(null);
        }
      });
      return stream as ReturnType<typeof createReadStream>;
    });

    const { client, requests } = createMockClient({
      screenshotSets: [
        {
          id: "set-iphone",
          screenshotDisplayType: "APP_IPHONE_67",
          screenshots: ["old-ss-1", "old-ss-2"]
        }
      ]
    });

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        screenshotsOnly: true,
        manifest: {
          "en-US": {
            screenshots: {
              APP_IPHONE_67: ["./screenshots/new1.png", "./screenshots/new2.png"]
            }
          }
        }
      })
    );

    expect(result.mode).toBe("applied");
    expect(result.screenshotSetsProcessed).toBe(1);
    expect(result.screenshotsUploaded).toBe(2);

    // Verify old screenshots were deleted
    const deleteRequests = requests.filter(
      (r) => r.method === "DELETE" && r.path.includes("/appScreenshots/")
    );
    expect(deleteRequests).toHaveLength(2);
    expect(deleteRequests.map((r) => r.path)).toContainEqual("/v1/appScreenshots/old-ss-1");
    expect(deleteRequests.map((r) => r.path)).toContainEqual("/v1/appScreenshots/old-ss-2");

    // Verify new screenshots were created (POST /v1/appScreenshots)
    const createRequests = requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/appScreenshots"
    );
    expect(createRequests).toHaveLength(2);

    // Verify screenshots were committed (PATCH /v1/appScreenshots/{id})
    const commitRequests = requests.filter(
      (r) => r.method === "PATCH" && r.path.includes("/appScreenshots/")
    );
    expect(commitRequests).toHaveLength(2);
    for (const req of commitRequests) {
      const body = req.body as { data: { attributes: { uploaded: boolean; sourceFileChecksum: string } } };
      expect(body.data.attributes.uploaded).toBe(true);
      expect(body.data.attributes.sourceFileChecksum).toBeTruthy();
    }

    // No text localization mutations
    const textPatches = requests.filter(
      (r) => r.method === "PATCH" && r.path.includes("/appStoreVersionLocalizations/")
    );
    expect(textPatches).toHaveLength(0);
  });

  it("creates new screenshot set when display type does not exist", async () => {
    const { createReadStream } = await import("node:fs");
    const { stat } = await import("node:fs/promises");
    const mockedStat = vi.mocked(stat);
    const mockedCreateReadStream = vi.mocked(createReadStream);

    mockedStat.mockResolvedValue({ size: 5000 } as Awaited<ReturnType<typeof stat>>);

    mockedCreateReadStream.mockImplementation(() => {
      const stream = new Readable({
        read() {
          this.push(Buffer.from("data"));
          this.push(null);
        }
      });
      return stream as ReturnType<typeof createReadStream>;
    });

    const { client, requests } = createMockClient({
      screenshotSets: []
    });

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        screenshotsOnly: true,
        manifest: {
          "en-US": {
            screenshots: {
              APP_IPAD_PRO_129: ["./ipad.png"]
            }
          }
        }
      })
    );

    expect(result.screenshotSetsProcessed).toBe(1);
    expect(result.screenshotsUploaded).toBe(1);

    // Verify new set was created
    const createSetRequests = requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/appScreenshotSets"
    );
    expect(createSetRequests).toHaveLength(1);

    // No deletes since set was new
    const deleteRequests = requests.filter(
      (r) => r.method === "DELETE" && r.path.includes("/appScreenshots/")
    );
    expect(deleteRequests).toHaveLength(0);
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
