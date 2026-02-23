import { writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { uploadBuild } from "../../src/commands/builds-upload.js";
import {
  DomainError,
  InfrastructureError,
  type AppStoreConnectClient,
  type HttpRequest,
  type HttpResponse
} from "../../src/api/client.js";
import type { ProcessRunner } from "../../src/ipa/artifact.js";

function createProcessRunner(plistJson: Readonly<Record<string, string>>): ProcessRunner {
  return {
    run: async (command, args) => {
      if (command === "unzip" && args[0] === "-Z1") {
        return { stdout: "Payload/Demo.app/Info.plist\n", stderr: "" };
      }
      if (command === "unzip") {
        return { stdout: "", stderr: "" };
      }
      if (command === "plutil") {
        return { stdout: JSON.stringify(plistJson), stderr: "" };
      }
      if (command === "codesign") {
        return { stdout: "", stderr: "" };
      }
      throw new InfrastructureError(`Unexpected command in test: ${command}`);
    }
  };
}

function createProcessRunnerWithXcrun(
  plistJson: Readonly<Record<string, string>>,
  xcrunHandler: (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>
): ProcessRunner {
  const baseRunner = createProcessRunner(plistJson);

  return {
    run: async (command, args) => {
      if (command === "xcrun") {
        return xcrunHandler(args);
      }

      return baseRunner.run(command, args);
    }
  };
}

function createMockClient(): {
  client: AppStoreConnectClient;
  requests: HttpRequest[];
} {
  const requests: HttpRequest[] = [];
  let getBuildUploadCalls = 0;

  const client = {
    request: async <T>(request: HttpRequest) => {
      requests.push(request);

      if (request.method === "POST" && request.path === "/v1/buildUploads") {
        return {
          status: 201,
          headers: new Headers(),
          data: {
            data: {
              id: "upload-1",
              attributes: {
                state: {
                  state: "AWAITING_UPLOAD",
                  errors: [],
                  warnings: [],
                  infos: []
                }
              }
            }
          }
        } as HttpResponse<T>;
      }

      if (request.method === "POST" && request.path === "/v1/buildUploadFiles") {
        return {
          status: 201,
          headers: new Headers(),
          data: {
            data: {
              id: "file-1",
              attributes: { uploadOperations: [] }
            }
          }
        } as HttpResponse<T>;
      }

      if (request.method === "PATCH" && request.path.startsWith("/v1/buildUploadFiles/")) {
        return { status: 200, headers: new Headers(), data: {} as T };
      }

      if (request.method === "GET" && request.path.startsWith("/v1/buildUploads/")) {
        getBuildUploadCalls += 1;
        return {
          status: 200,
          headers: new Headers(),
          data: {
            data: {
              id: "upload-1",
              attributes: {
                state: {
                  state: getBuildUploadCalls < 2 ? "PROCESSING" : "COMPLETE",
                  errors: [],
                  warnings: [],
                  infos: []
                }
              }
            }
          }
        } as HttpResponse<T>;
      }

      throw new Error(`Unexpected request: ${request.method} ${request.path}`);
    },
    getToken: async () => "test-token"
  } as unknown as AppStoreConnectClient;

  return { client, requests };
}

describe("uploadBuild", () => {
  it("returns dry-run result without mutations", async () => {
    const ipaPath = path.join(os.tmpdir(), `upload-dry-${Date.now()}.ipa`);
    await writeFile(ipaPath, "dummy ipa bytes");

    try {
      const { client, requests } = createMockClient();

      const result = await uploadBuild(
        client,
        {
          ipaSource: { kind: "prebuilt", ipaPath },
          appId: "app-1",
          expectedBundleId: "com.example.demo",
          expectedVersion: "1.0.0",
          expectedBuildNumber: "42",
          waitProcessing: false,
          apply: false
        },
        {
          processRunner: createProcessRunner({
            CFBundleIdentifier: "com.example.demo",
            CFBundleShortVersionString: "1.0.0",
            CFBundleVersion: "42"
          })
        }
      );

      expect(result.mode).toBe("dry-run");
      expect(result.buildUploadId).toBeNull();
      expect(result.finalBuildUploadState).toBeNull();
      const mutationRequests = requests.filter(
        (r) => r.method === "POST" && r.path.includes("buildUpload")
      );
      expect(mutationRequests).toHaveLength(0);
    } finally {
      await rm(ipaPath, { force: true });
    }
  });

  it("falls back to API upload flow and polls until complete when altool is unavailable", async () => {
    const ipaPath = path.join(os.tmpdir(), `upload-apply-${Date.now()}.ipa`);
    await writeFile(ipaPath, "dummy ipa bytes");

    try {
      const { client } = createMockClient();

      const result = await uploadBuild(
        client,
        {
          ipaSource: { kind: "prebuilt", ipaPath },
          appId: "app-1",
          expectedBundleId: "com.example.demo",
          expectedVersion: "1.0.0",
          expectedBuildNumber: "42",
          waitProcessing: true,
          apply: true
        },
        {
          sleep: async () => undefined,
          pollIntervalMs: 1,
          pollTimeoutMs: 100,
          processRunner: createProcessRunner({
            CFBundleIdentifier: "com.example.demo",
            CFBundleShortVersionString: "1.0.0",
            CFBundleVersion: "42"
          })
        }
      );

      expect(result.mode).toBe("applied");
      expect(result.buildUploadId).toBe("upload-1");
      expect(result.finalBuildUploadState).toBe("COMPLETE");
      expect(result.fallbackUploadMethod).toBe("App Store Connect API");
    } finally {
      await rm(ipaPath, { force: true });
    }
  });

  it("fails when preflight report contains errors", async () => {
    const ipaPath = path.join(os.tmpdir(), `upload-fail-${Date.now()}.ipa`);
    await writeFile(ipaPath, "dummy ipa bytes");

    try {
      const { client } = createMockClient();

      await expect(
        uploadBuild(
          client,
          {
            ipaSource: { kind: "prebuilt", ipaPath },
            appId: "app-1",
            expectedBundleId: "com.example.WRONG",
            expectedVersion: "1.0.0",
            expectedBuildNumber: "42",
            waitProcessing: false,
            apply: true
          },
          {
            processRunner: createProcessRunner({
              CFBundleIdentifier: "com.example.demo",
              CFBundleShortVersionString: "1.0.0",
              CFBundleVersion: "42"
            })
          }
        )
      ).rejects.toThrowError(DomainError);
    } finally {
      await rm(ipaPath, { force: true });
    }
  });

  it("uses xcrun altool as the primary upload path when available", async () => {
    const ipaPath = path.join(os.tmpdir(), `upload-primary-altool-${Date.now()}.ipa`);
    await writeFile(ipaPath, "dummy ipa bytes");

    const xcrunInvocations: string[][] = [];

    const client = {
      request: async () => {
        throw new Error("API fallback should not be used when altool succeeds.");
      }
    } as unknown as AppStoreConnectClient;

    const processRunner = createProcessRunnerWithXcrun(
      {
        CFBundleIdentifier: "com.example.demo",
        CFBundleShortVersionString: "1.0.0",
        CFBundleVersion: "42"
      },
      async (args) => {
        xcrunInvocations.push([...args]);
        if (args[0] === "altool") {
          return { stdout: "altool upload ok", stderr: "" };
        }
        throw new InfrastructureError("Unexpected xcrun fallback command.");
      }
    );

    try {
      const result = await uploadBuild(
        client,
        {
          ipaSource: { kind: "prebuilt", ipaPath },
          appId: "app-1",
          expectedBundleId: "com.example.demo",
          expectedVersion: "1.0.0",
          expectedBuildNumber: "42",
          waitProcessing: true,
          apply: true
        },
        {
          processRunner,
          fallbackEnv: {
            ...process.env,
            ASC_KEY_ID: "KEY1234567",
            ASC_ISSUER_ID: "issuer-123",
            ASC_PRIVATE_KEY:
              "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----"
          }
        }
      );

      expect(result.mode).toBe("applied");
      expect(result.buildUploadId).toBeNull();
      expect(result.finalBuildUploadState).toBe("ALTOOL_WAIT_COMPLETED");
      expect(result.fallbackUploadMethod).toBeUndefined();
      expect(xcrunInvocations).toHaveLength(1);
      expect(xcrunInvocations[0]).toContain("altool");
      expect(xcrunInvocations[0]).toContain("--auth-string");
      expect(xcrunInvocations[0]).toContain("--wait");
    } finally {
      await rm(ipaPath, { force: true });
    }
  });

  it("falls back to App Store Connect API when altool upload fails", async () => {
    const ipaPath = path.join(os.tmpdir(), `upload-fallback-api-${Date.now()}.ipa`);
    await writeFile(ipaPath, "dummy ipa bytes");

    const { client } = createMockClient();
    let altoolCalls = 0;
    const processRunner = createProcessRunnerWithXcrun(
      {
        CFBundleIdentifier: "com.example.demo",
        CFBundleShortVersionString: "1.0.0",
        CFBundleVersion: "42"
      },
      async (args) => {
        if (args[0] === "altool") {
          altoolCalls += 1;
          throw new InfrastructureError("altool failed");
        }
        throw new InfrastructureError(`Unexpected xcrun command: ${args.join(" ")}`);
      }
    );

    try {
      const result = await uploadBuild(
        client,
        {
          ipaSource: { kind: "prebuilt", ipaPath },
          appId: "app-1",
          expectedBundleId: "com.example.demo",
          expectedVersion: "1.0.0",
          expectedBuildNumber: "42",
          waitProcessing: true,
          apply: true
        },
        {
          sleep: async () => undefined,
          pollIntervalMs: 1,
          pollTimeoutMs: 100,
          processRunner,
          fallbackEnv: {
            ...process.env,
            ASC_KEY_ID: "KEY1234567",
            ASC_ISSUER_ID: "issuer-123",
            ASC_PRIVATE_KEY:
              "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----"
          }
        }
      );

      expect(result.buildUploadId).toBe("upload-1");
      expect(result.finalBuildUploadState).toBe("COMPLETE");
      expect(result.fallbackUploadMethod).toBe("App Store Connect API");
      expect(altoolCalls).toBe(1);
    } finally {
      await rm(ipaPath, { force: true });
    }
  });

  it("fails when API fallback rejects sourceFileChecksums", async () => {
    const ipaPath = path.join(os.tmpdir(), `upload-fallback-api-checksum-${Date.now()}.ipa`);
    await writeFile(ipaPath, "dummy ipa bytes");

    const client = {
      request: async <T>(request: HttpRequest) => {
        if (request.method === "POST" && request.path === "/v1/buildUploads") {
          return {
            status: 201,
            headers: new Headers(),
            data: {
              data: {
                id: "upload-1",
                attributes: {
                  state: { state: "AWAITING_UPLOAD", errors: [], warnings: [], infos: [] }
                }
              }
            }
          } as HttpResponse<T>;
        }

        if (request.method === "POST" && request.path === "/v1/buildUploadFiles") {
          return {
            status: 201,
            headers: new Headers(),
            data: { data: { id: "file-1", attributes: { uploadOperations: [] } } }
          } as HttpResponse<T>;
        }

        if (request.method === "PATCH" && request.path.startsWith("/v1/buildUploadFiles/")) {
          throw new InfrastructureError(
            "App Store Connect request failed (409): sourceFileChecksums is invalid",
            undefined,
            {
              statusCode: 409,
              responseJson: {
                errors: [
                  {
                    status: "409",
                    source: { pointer: "/data/attributes/sourceFileChecksums" }
                  }
                ]
              }
            }
          );
        }

        if (request.method === "GET" && request.path.startsWith("/v1/buildUploads/")) {
          throw new Error("Polling should not happen when checksum marking fails.");
        }

        throw new Error(`Unexpected request: ${request.method} ${request.path}`);
      }
    } as unknown as AppStoreConnectClient;

    const processRunner = createProcessRunnerWithXcrun(
      {
        CFBundleIdentifier: "com.example.demo",
        CFBundleShortVersionString: "1.0.0",
        CFBundleVersion: "42"
      },
      async (args) => {
        if (args[0] === "altool") {
          throw new InfrastructureError("altool failed");
        }
        throw new InfrastructureError(`Unexpected xcrun command: ${args.join(" ")}`);
      }
    );

    try {
      await expect(
        uploadBuild(
          client,
          {
            ipaSource: { kind: "prebuilt", ipaPath },
            appId: "app-1",
            expectedBundleId: "com.example.demo",
            expectedVersion: "1.0.0",
            expectedBuildNumber: "42",
            waitProcessing: false,
            apply: true
          },
          {
            processRunner,
            fallbackEnv: {
              ...process.env,
              ASC_KEY_ID: "KEY1234567",
              ASC_ISSUER_ID: "issuer-123",
              ASC_PRIVATE_KEY:
                "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----"
            }
          }
        )
      ).rejects.toThrowError(
        "App Store Connect API fallback rejected sourceFileChecksums while marking build upload file."
      );
    } finally {
      await rm(ipaPath, { force: true });
    }
  });
});
