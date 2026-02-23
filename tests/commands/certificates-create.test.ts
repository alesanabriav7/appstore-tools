import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  certificatesCreateCommand
} from "../../src/commands/certificates-create.js";
import type {
  AppStoreConnectClient,
  HttpRequest,
  HttpResponse
} from "../../src/api/client.js";
import type { ProcessRunner } from "../../src/ipa/artifact.js";

interface CertificateCreateRequestBody {
  readonly data: {
    readonly attributes: {
      readonly csrContent: string;
      readonly certificateType: string;
    };
  };
}

describe("certificatesCreateCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates certificate artifacts and installs into keychain by default", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "cert-create-"));
    const keychainPath = path.join(outputDirectory, "login.keychain-db");
    const derCsrBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const createdCertificateBytes = Buffer.from("certificate-bytes", "utf8");
    const processCalls: { command: string; args: readonly string[] }[] = [];

    const processRunner: ProcessRunner = {
      run: async (command, args) => {
        processCalls.push({ command, args });

        if (
          command === "openssl" &&
          args[0] === "req" &&
          args.includes("-newkey")
        ) {
          const keyOutIndex = args.indexOf("-keyout");
          const csrOutIndex = args.indexOf("-out");
          const keyPath = keyOutIndex >= 0 ? args[keyOutIndex + 1] : undefined;
          const csrPath = csrOutIndex >= 0 ? args[csrOutIndex + 1] : undefined;

          if (!keyPath || !csrPath) {
            throw new Error("Missing expected openssl output args.");
          }

          await writeFile(keyPath, "PRIVATE KEY");
          await writeFile(csrPath, "CSR PEM");
          return { stdout: "", stderr: "" };
        }

        if (
          command === "openssl" &&
          args[0] === "req" &&
          args.includes("-outform")
        ) {
          const derOutIndex = args.indexOf("-out");
          const derPath = derOutIndex >= 0 ? args[derOutIndex + 1] : undefined;

          if (!derPath) {
            throw new Error("Missing expected DER output path.");
          }

          await writeFile(derPath, derCsrBytes);
          return { stdout: "", stderr: "" };
        }

        if (command === "security" && args[0] === "import") {
          return { stdout: "", stderr: "" };
        }

        throw new Error(`Unexpected process call: ${command} ${args.join(" ")}`);
      }
    };

    const requests: HttpRequest[] = [];
    const client = {
      request: async <T>(request: HttpRequest) => {
        requests.push(request);

        return {
          status: 201,
          headers: new Headers(),
          data: {
            data: {
              id: "cert-123",
              attributes: {
                certificateContent: createdCertificateBytes.toString("base64"),
                certificateType: "IOS_DISTRIBUTION",
                expirationDate: "2027-01-01T00:00:00Z"
              }
            }
          }
        } as HttpResponse<T>;
      }
    } as unknown as AppStoreConnectClient;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const exitCode = await certificatesCreateCommand(
        client,
        {
          json: true,
          certificateType: "IOS_DISTRIBUTION",
          commonName: "CLI Certificate",
          outputDir: outputDirectory,
          keychainPath,
          skipInstall: false
        },
        { processRunner }
      );

      expect(exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "POST",
        path: "/v1/certificates"
      });

      const requestBody = requests[0]?.body as CertificateCreateRequestBody;
      expect(requestBody.data.attributes.certificateType).toBe("IOS_DISTRIBUTION");
      expect(requestBody.data.attributes.csrContent).toBe(derCsrBytes.toString("base64"));

      const outputJson = logSpy.mock.calls[0]?.[0];
      expect(typeof outputJson).toBe("string");

      const payload = JSON.parse(outputJson as string) as {
        readonly keyPath: string;
        readonly csrPath: string;
        readonly certificatePath: string;
        readonly installed: boolean;
        readonly keychainPath: string | null;
      };

      expect(payload.installed).toBe(true);
      expect(payload.keychainPath).toBe(keychainPath);
      expect(await readFile(payload.keyPath, "utf8")).toBe("PRIVATE KEY");
      expect(await readFile(payload.csrPath, "utf8")).toBe("CSR PEM");
      expect(await readFile(payload.certificatePath)).toEqual(createdCertificateBytes);

      const securityCalls = processCalls.filter((call) => call.command === "security");
      expect(securityCalls).toHaveLength(2);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("skips keychain import when --skip-install is enabled", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "cert-create-skip-"));
    const processCalls: { command: string; args: readonly string[] }[] = [];

    const processRunner: ProcessRunner = {
      run: async (command, args) => {
        processCalls.push({ command, args });

        if (
          command === "openssl" &&
          args[0] === "req" &&
          args.includes("-newkey")
        ) {
          const keyOutIndex = args.indexOf("-keyout");
          const csrOutIndex = args.indexOf("-out");
          const keyPath = keyOutIndex >= 0 ? args[keyOutIndex + 1] : undefined;
          const csrPath = csrOutIndex >= 0 ? args[csrOutIndex + 1] : undefined;

          if (!keyPath || !csrPath) {
            throw new Error("Missing expected openssl output args.");
          }

          await writeFile(keyPath, "PRIVATE KEY");
          await writeFile(csrPath, "CSR PEM");
          return { stdout: "", stderr: "" };
        }

        if (
          command === "openssl" &&
          args[0] === "req" &&
          args.includes("-outform")
        ) {
          const derOutIndex = args.indexOf("-out");
          const derPath = derOutIndex >= 0 ? args[derOutIndex + 1] : undefined;

          if (!derPath) {
            throw new Error("Missing expected DER output path.");
          }

          await writeFile(derPath, Buffer.from([0x01]));
          return { stdout: "", stderr: "" };
        }

        if (command === "security" && args[0] === "import") {
          return { stdout: "", stderr: "" };
        }

        throw new Error(`Unexpected process call: ${command} ${args.join(" ")}`);
      }
    };

    const client = {
      request: async <T>() =>
        ({
          status: 201,
          headers: new Headers(),
          data: {
            data: {
              id: "cert-456",
              attributes: {
                certificateContent: Buffer.from("cert-2").toString("base64"),
                certificateType: "IOS_DEVELOPMENT"
              }
            }
          }
        }) as HttpResponse<T>
    } as unknown as AppStoreConnectClient;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const exitCode = await certificatesCreateCommand(
        client,
        {
          json: false,
          certificateType: "ios_development",
          outputDir: outputDirectory,
          skipInstall: true
        },
        { processRunner }
      );

      expect(exitCode).toBe(0);

      const securityCalls = processCalls.filter((call) => call.command === "security");
      expect(securityCalls).toHaveLength(0);
      expect(logSpy).toHaveBeenCalledWith("Installation skipped (--skip-install).");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
