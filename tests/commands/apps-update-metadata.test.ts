import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { updateMetadata, validateManifest, type MetadataUpdateInput } from "../../src/commands/apps-update-metadata.js";
import {
  DomainError,
  InfrastructureError,
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
  readonly appInfos?: readonly {
    readonly id: string;
  }[];
  readonly appInfoLocalizations?: readonly {
    readonly id: string;
    readonly locale: string;
  }[];
  readonly hasReviewDetail?: boolean;
  readonly ageRatingDeclarationId?: string;
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
  const appInfos = options?.appInfos ?? [{ id: "appinfo-1" }];
  const appInfoLocalizations = options?.appInfoLocalizations ?? [
    { id: "appinfoloc-en", locale: "en-US" }
  ];
  const hasReviewDetail = options?.hasReviewDetail ?? false;
  const ageRatingDeclarationId = options?.ageRatingDeclarationId ?? "agerate-1";

  const client = {
    request: async <T>(request: HttpRequest) => {
      requests.push(request);

      // GET app store versions
      if (request.method === "GET" && request.path.includes("/appStoreVersions") && !request.path.includes("Localizations") && !request.path.includes("appScreenshotSets") && !request.path.includes("appStoreReviewDetail")) {
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

      // PATCH version localization
      if (request.method === "PATCH" && request.path.includes("/appStoreVersionLocalizations/")) {
        return { status: 200, headers: new Headers(), data: {} } as HttpResponse<T>;
      }

      // POST version localization
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

      // GET appInfos
      if (request.method === "GET" && request.path.includes("/appInfos") && !request.path.includes("/appInfoLocalizations") && !request.path.includes("/ageRatingDeclaration")) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: appInfos.map((ai) => ({ id: ai.id, type: "appInfos" }))
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
              attributes: { locale: l.locale }
            }))
          }
        } as HttpResponse<T>;
      }

      // PATCH appInfoLocalization
      if (request.method === "PATCH" && request.path.includes("/appInfoLocalizations/")) {
        return { status: 200, headers: new Headers(), data: {} } as HttpResponse<T>;
      }

      // POST appInfoLocalization
      if (request.method === "POST" && request.path === "/v1/appInfoLocalizations") {
        return {
          status: 201,
          headers: new Headers(),
          data: { data: { id: "appinfoloc-new" } }
        } as HttpResponse<T>;
      }

      // PATCH appStoreVersion (copyright)
      if (request.method === "PATCH" && request.path.includes("/appStoreVersions/")) {
        return { status: 200, headers: new Headers(), data: {} } as HttpResponse<T>;
      }

      // PATCH appInfos (category)
      if (request.method === "PATCH" && request.path.includes("/appInfos/")) {
        return { status: 200, headers: new Headers(), data: {} } as HttpResponse<T>;
      }

      // GET ageRatingDeclaration
      if (request.method === "GET" && request.path.includes("/ageRatingDeclaration")) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: { id: ageRatingDeclarationId, attributes: {} }
          }
        } as HttpResponse<T>;
      }

      // PATCH ageRatingDeclaration
      if (request.method === "PATCH" && request.path.includes("/ageRatingDeclarations/")) {
        return { status: 200, headers: new Headers(), data: {} } as HttpResponse<T>;
      }

      // GET appStoreReviewDetail
      if (request.method === "GET" && request.path.includes("/appStoreReviewDetail")) {
        if (hasReviewDetail) {
          return {
            status: 200,
            headers: new Headers(),
            data: {
              data: { id: "review-detail-1", attributes: {} }
            }
          } as HttpResponse<T>;
        }
        throw new InfrastructureError("Not found", undefined, { statusCode: 404 });
      }

      // POST appStoreReviewDetails
      if (request.method === "POST" && request.path === "/v1/appStoreReviewDetails") {
        return {
          status: 201,
          headers: new Headers(),
          data: { data: { id: "review-detail-new" } }
        } as HttpResponse<T>;
      }

      // PATCH appStoreReviewDetail
      if (request.method === "PATCH" && request.path.includes("/appStoreReviewDetails/")) {
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

  it("ignores _app key when processing locale text fields", async () => {
    const { client, requests } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        manifest: {
          _app: {
            copyright: "2026 Test"
          } as never,
          "en-US": {
            description: "Updated description"
          }
        }
      })
    );

    expect(result.localizationsUpdated).toBe(1);
    expect(result.copyrightUpdated).toBe(true);

    // _app should not produce a localization PATCH/POST
    const locPatches = requests.filter(
      (r) => r.method === "PATCH" && r.path.includes("/appStoreVersionLocalizations/")
    );
    expect(locPatches).toHaveLength(1);
  });

  it("dry-run plans app-info localization operations", async () => {
    const { client } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        manifest: {
          "en-US": {
            description: "Test",
            subtitle: "My Subtitle",
            privacyPolicyUrl: "https://example.com/privacy"
          }
        }
      })
    );

    expect(result.mode).toBe("dry-run");
    expect(result.plannedOperations).toContainEqual(
      expect.stringContaining("Update app info localization for en-US")
    );
  });

  it("dry-run plans app metadata operations", async () => {
    const { client } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        manifest: {
          _app: {
            copyright: "2026 Test",
            primaryCategory: "FINANCE",
            ageRating: { gamblingAndContests: false },
            reviewContact: { contactEmail: "test@test.com" }
          } as never,
          "en-US": { description: "Test" }
        }
      })
    );

    expect(result.mode).toBe("dry-run");
    expect(result.plannedOperations).toContainEqual("Update copyright");
    expect(result.plannedOperations).toContainEqual("Update primary category to FINANCE");
    expect(result.plannedOperations).toContainEqual("Update age rating declaration");
    expect(result.plannedOperations).toContainEqual("Update review contact information");
  });

  it("applies subtitle and privacyPolicyUrl via app info localizations", async () => {
    const { client, requests } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        manifest: {
          "en-US": {
            description: "Test",
            subtitle: "My Subtitle",
            privacyPolicyUrl: "https://example.com/privacy"
          }
        }
      })
    );

    expect(result.appInfoLocalizationsUpdated).toBe(1);
    expect(result.appInfoLocalizationsCreated).toBe(0);

    const appInfoLocPatches = requests.filter(
      (r) => r.method === "PATCH" && r.path.includes("/appInfoLocalizations/")
    );
    expect(appInfoLocPatches).toHaveLength(1);
    expect(appInfoLocPatches[0]!.path).toContain("appinfoloc-en");
  });

  it("creates app info localization for new locale", async () => {
    const { client, requests } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        manifest: {
          "es-MX": {
            description: "Descripción",
            subtitle: "Subtítulo"
          }
        }
      })
    );

    expect(result.appInfoLocalizationsCreated).toBe(1);

    const appInfoLocPosts = requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/appInfoLocalizations"
    );
    expect(appInfoLocPosts).toHaveLength(1);
  });

  it("applies copyright to app store version", async () => {
    const { client, requests } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        manifest: {
          _app: { copyright: "2026 Test Corp" } as never,
          "en-US": { description: "Test" }
        }
      })
    );

    expect(result.copyrightUpdated).toBe(true);

    const versionPatches = requests.filter(
      (r) => r.method === "PATCH" && r.path.includes("/appStoreVersions/")
    );
    expect(versionPatches).toHaveLength(1);
    const body = versionPatches[0]!.body as { data: { attributes: { copyright: string } } };
    expect(body.data.attributes.copyright).toBe("2026 Test Corp");
  });

  it("applies primary category", async () => {
    const { client, requests } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        manifest: {
          _app: { primaryCategory: "FINANCE" } as never,
          "en-US": { description: "Test" }
        }
      })
    );

    expect(result.categoryUpdated).toBe(true);

    const appInfoPatches = requests.filter(
      (r) => r.method === "PATCH" && r.path.includes("/appInfos/")
    );
    expect(appInfoPatches).toHaveLength(1);
    const body = appInfoPatches[0]!.body as {
      data: { relationships: { primaryCategory: { data: { id: string } } } };
    };
    expect(body.data.relationships.primaryCategory.data.id).toBe("FINANCE");
  });

  it("applies age rating declaration", async () => {
    const { client, requests } = createMockClient();

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        manifest: {
          _app: {
            ageRating: {
              gamblingAndContests: false,
              horrorOrFearThemes: "NONE"
            }
          } as never,
          "en-US": { description: "Test" }
        }
      })
    );

    expect(result.ageRatingUpdated).toBe(true);

    const ageRatingPatches = requests.filter(
      (r) => r.method === "PATCH" && r.path.includes("/ageRatingDeclarations/")
    );
    expect(ageRatingPatches).toHaveLength(1);
    expect(ageRatingPatches[0]!.path).toContain("agerate-1");
  });

  it("creates review contact when none exists", async () => {
    const { client, requests } = createMockClient({ hasReviewDetail: false });

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        manifest: {
          _app: {
            reviewContact: {
              contactFirstName: "Test",
              contactEmail: "test@test.com"
            }
          } as never,
          "en-US": { description: "Test" }
        }
      })
    );

    expect(result.reviewContactUpdated).toBe(true);

    const reviewPosts = requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/appStoreReviewDetails"
    );
    expect(reviewPosts).toHaveLength(1);
  });

  it("updates review contact when one already exists", async () => {
    const { client, requests } = createMockClient({ hasReviewDetail: true });

    const result = await updateMetadata(
      client,
      baseInput({
        apply: true,
        manifest: {
          _app: {
            reviewContact: {
              contactFirstName: "Updated",
              contactEmail: "updated@test.com"
            }
          } as never,
          "en-US": { description: "Test" }
        }
      })
    );

    expect(result.reviewContactUpdated).toBe(true);

    const reviewPatches = requests.filter(
      (r) => r.method === "PATCH" && r.path.includes("/appStoreReviewDetails/")
    );
    expect(reviewPatches).toHaveLength(1);
    expect(reviewPatches[0]!.path).toContain("review-detail-1");
  });
});

describe("validateManifest – _app key", () => {
  it("accepts a valid _app key", () => {
    const manifest = validateManifest({
      _app: {
        copyright: "2026 Test",
        primaryCategory: "FINANCE",
        ageRating: {
          gamblingAndContests: false,
          horrorOrFearThemes: "NONE"
        },
        reviewContact: {
          contactFirstName: "Test",
          contactEmail: "test@test.com"
        }
      },
      "en-US": { description: "Hello" }
    });

    expect(manifest._app).toBeDefined();
    expect(manifest["en-US"]).toBeDefined();
  });

  it("rejects _app when it is not an object", () => {
    expect(() => validateManifest({ _app: "bad" })).toThrow(
      '"_app" must be a JSON object'
    );
  });

  it("rejects _app.primaryCategory when not a string", () => {
    expect(() => validateManifest({ _app: { primaryCategory: 123 } })).toThrow(
      '"_app.primaryCategory" must be a string'
    );
  });

  it("rejects _app.copyright when not a string", () => {
    expect(() => validateManifest({ _app: { copyright: false } })).toThrow(
      '"_app.copyright" must be a string'
    );
  });

  it("rejects _app.ageRating when not an object", () => {
    expect(() => validateManifest({ _app: { ageRating: "bad" } })).toThrow(
      '"_app.ageRating" must be a JSON object'
    );
  });

  it("rejects _app.ageRating boolean field with wrong type", () => {
    expect(() =>
      validateManifest({ _app: { ageRating: { gamblingAndContests: "yes" } } })
    ).toThrow('"_app.ageRating.gamblingAndContests" must be a boolean');
  });

  it("rejects _app.ageRating frequency field with wrong type", () => {
    expect(() =>
      validateManifest({ _app: { ageRating: { horrorOrFearThemes: 42 } } })
    ).toThrow('"_app.ageRating.horrorOrFearThemes" must be a string');
  });

  it("rejects _app.reviewContact when not an object", () => {
    expect(() => validateManifest({ _app: { reviewContact: [] } })).toThrow(
      '"_app.reviewContact" must be a JSON object'
    );
  });

  it("rejects _app.reviewContact field with wrong type", () => {
    expect(() =>
      validateManifest({ _app: { reviewContact: { contactEmail: 123 } } })
    ).toThrow('"_app.reviewContact.contactEmail" must be a string');
  });
});

describe("validateManifest – locale app info fields", () => {
  it("accepts subtitle and privacyPolicyUrl as strings", () => {
    const manifest = validateManifest({
      "en-US": {
        subtitle: "My Subtitle",
        privacyPolicyUrl: "https://example.com/privacy"
      }
    });

    expect(manifest["en-US"]).toBeDefined();
  });

  it("rejects subtitle when not a string", () => {
    expect(() => validateManifest({ "en-US": { subtitle: 42 } })).toThrow(
      'locale "en-US" field "subtitle" must be a string'
    );
  });

  it("rejects privacyPolicyUrl when not a string", () => {
    expect(() => validateManifest({ "en-US": { privacyPolicyUrl: true } })).toThrow(
      'locale "en-US" field "privacyPolicyUrl" must be a string'
    );
  });
});
