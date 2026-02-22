import { rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildsUploadCommand
} from "../../src/commands/builds-upload.js";
import type {
  AppStoreConnectClient,
  HttpRequest,
  HttpResponse
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
      throw new Error(`Unexpected command in test: ${command}`);
    }
  };
}

describe("buildsUploadCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-detects app/version/build-number from the IPA when omitted", async () => {
    const ipaPath = path.join(os.tmpdir(), `upload-command-${Date.now()}.ipa`);
    await writeFile(ipaPath, "dummy ipa bytes");

    const requests: HttpRequest[] = [];
    const client = {
      request: async <T>(request: HttpRequest) => {
        requests.push(request);

        if (request.method === "GET" && request.path === "/v1/apps") {
          return {
            status: 200,
            headers: new Headers(),
            data: {
              data: [
                {
                  id: "app-1",
                  attributes: {
                    name: "Demo",
                    bundleId: "com.example.demo"
                  }
                }
              ]
            }
          } as HttpResponse<T>;
        }

        throw new Error(`Unexpected request: ${request.method} ${request.path}`);
      }
    } as unknown as AppStoreConnectClient;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const exitCode = await buildsUploadCommand(
        client,
        {
          waitProcessing: false,
          apply: false,
          json: true,
          ipaSource: {
            kind: "prebuilt",
            ipaPath
          }
        },
        {
          processRunner: createProcessRunner({
            CFBundleIdentifier: "com.example.demo",
            CFBundleShortVersionString: "1.0.0",
            CFBundleVersion: "42"
          })
        }
      );

      expect(exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "GET",
        path: "/v1/apps"
      });
      expect(logSpy).toHaveBeenCalled();
    } finally {
      await rm(ipaPath, { force: true });
    }
  });

  it("skips the extra metadata preflight when app/version/build-number are provided", async () => {
    const ipaPath = path.join(os.tmpdir(), `upload-command-explicit-${Date.now()}.ipa`);
    await writeFile(ipaPath, "dummy ipa bytes");

    const requests: HttpRequest[] = [];
    const client = {
      request: async <T>(request: HttpRequest) => {
        requests.push(request);

        if (request.method === "GET" && request.path === "/v1/apps") {
          return {
            status: 200,
            headers: new Headers(),
            data: {
              data: [
                {
                  id: "app-1",
                  attributes: {
                    name: "Demo",
                    bundleId: "com.example.demo"
                  }
                }
              ]
            }
          } as HttpResponse<T>;
        }

        throw new Error(`Unexpected request: ${request.method} ${request.path}`);
      }
    } as unknown as AppStoreConnectClient;

    let zipListCalls = 0;
    const processRunner: ProcessRunner = {
      run: async (command, args) => {
        if (command === "unzip" && args[0] === "-Z1") {
          zipListCalls += 1;
          return { stdout: "Payload/Demo.app/Info.plist\n", stderr: "" };
        }
        if (command === "unzip") {
          return { stdout: "", stderr: "" };
        }
        if (command === "plutil") {
          return {
            stdout: JSON.stringify({
              CFBundleIdentifier: "com.example.demo",
              CFBundleShortVersionString: "1.0.0",
              CFBundleVersion: "42"
            }),
            stderr: ""
          };
        }
        if (command === "codesign") {
          return { stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected command in test: ${command}`);
      }
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const exitCode = await buildsUploadCommand(
        client,
        {
          appReference: "com.example.demo",
          version: "1.0.0",
          buildNumber: "42",
          waitProcessing: false,
          apply: false,
          json: true,
          ipaSource: {
            kind: "prebuilt",
            ipaPath
          }
        },
        {
          processRunner
        }
      );

      expect(exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(zipListCalls).toBe(1);
      expect(logSpy).toHaveBeenCalled();
    } finally {
      await rm(ipaPath, { force: true });
    }
  });
});
