import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InfrastructureError } from "../src/api/client.js";
import {
  parseCliCommand,
  resolveCliEnvironment
} from "../src/cli.js";

describe("resolveCliEnvironment", () => {
  let tempDir: string;
  let keyFilePath: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "asc-test-"));
    keyFilePath = join(tempDir, "AuthKey_TEST.p8");
    await writeFile(keyFilePath, "-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----\n");
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("resolves required variables and normalizes escaped newlines", async () => {
    const env = await resolveCliEnvironment({
      ASC_ISSUER_ID: "issuer",
      ASC_KEY_ID: "key",
      ASC_PRIVATE_KEY: "line-1\\nline-2"
    });

    expect(env.issuerId).toBe("issuer");
    expect(env.keyId).toBe("key");
    expect(env.privateKey).toBe("line-1\nline-2");
    expect(env.baseUrl).toBe("https://api.appstoreconnect.apple.com/");
  });

  it("reads private key from file when ASC_PRIVATE_KEY_PATH is set", async () => {
    const env = await resolveCliEnvironment({
      ASC_ISSUER_ID: "issuer",
      ASC_KEY_ID: "key",
      ASC_PRIVATE_KEY_PATH: keyFilePath
    });

    expect(env.privateKey).toBe("-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----");
  });

  it("prefers ASC_PRIVATE_KEY_PATH over ASC_PRIVATE_KEY", async () => {
    const env = await resolveCliEnvironment({
      ASC_ISSUER_ID: "issuer",
      ASC_KEY_ID: "key",
      ASC_PRIVATE_KEY_PATH: keyFilePath,
      ASC_PRIVATE_KEY: "inline-key"
    });

    expect(env.privateKey).toBe("-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----");
  });

  it("throws when the key file does not exist", async () => {
    await expect(
      resolveCliEnvironment({
        ASC_ISSUER_ID: "issuer",
        ASC_KEY_ID: "key",
        ASC_PRIVATE_KEY_PATH: "/nonexistent/AuthKey.p8"
      })
    ).rejects.toThrow(InfrastructureError);
  });

  it("throws when required values are missing", async () => {
    await expect(
      resolveCliEnvironment({
        ASC_ISSUER_ID: "issuer"
      })
    ).rejects.toThrow(InfrastructureError);
  });
});

describe("parseCliCommand", () => {
  it("parses builds upload command with prebuilt ipa source", () => {
    const command = parseCliCommand([
      "builds",
      "upload",
      "--app",
      "com.example.demo",
      "--version",
      "1.2.3",
      "--build-number",
      "45",
      "--ipa",
      "./Demo.ipa",
      "--wait-processing",
      "--json"
    ]);

    expect(command).toEqual({
      kind: "builds-upload",
      appReference: "com.example.demo",
      version: "1.2.3",
      buildNumber: "45",
      waitProcessing: true,
      apply: false,
      json: true,
      ipaSource: {
        kind: "prebuilt",
        ipaPath: "./Demo.ipa"
      }
    });
  });

  it("parses builds upload command with auto-detection enabled", () => {
    const command = parseCliCommand(["builds", "upload", "--apply"]);

    expect(command).toEqual({
      kind: "builds-upload",
      waitProcessing: false,
      apply: true,
      json: false
    });
  });

  it("throws when ipa and generation flags are mixed", () => {
    expect(() =>
      parseCliCommand([
        "builds",
        "upload",
        "--app",
        "com.example.demo",
        "--version",
        "1.2.3",
        "--build-number",
        "45",
        "--ipa",
        "./Demo.ipa",
        "--scheme",
        "Demo",
        "--export-options-plist",
        "./ExportOptions.plist",
        "--workspace-path",
        "./Demo.xcworkspace"
      ])
    ).toThrowError(InfrastructureError);
  });

  it("throws when both workspace and project are provided", () => {
    expect(() =>
      parseCliCommand([
        "builds",
        "upload",
        "--app",
        "com.example.demo",
        "--version",
        "1.2.3",
        "--build-number",
        "45",
        "--scheme",
        "Demo",
        "--export-options-plist",
        "./ExportOptions.plist",
        "--workspace-path",
        "./Demo.xcworkspace",
        "--project-path",
        "./Demo.xcodeproj"
      ])
    ).toThrowError(InfrastructureError);
  });

  it("parses ipa generate command with custom build command source", () => {
    const command = parseCliCommand([
      "ipa",
      "generate",
      "--output-ipa",
      "./dist/Demo.ipa",
      "--build-command",
      "make build-ipa",
      "--generated-ipa-path",
      "./build/Demo.ipa"
    ]);

    expect(command).toEqual({
      kind: "ipa-generate",
      json: false,
      outputIpaPath: "./dist/Demo.ipa",
      ipaSource: {
        kind: "customCommand",
        buildCommand: "make build-ipa",
        generatedIpaPath: "./build/Demo.ipa",
        outputIpaPath: "./dist/Demo.ipa"
      }
    });
  });

  it("parses ipa generate xcodebuild mode without explicit export options plist", () => {
    const command = parseCliCommand([
      "ipa",
      "generate",
      "--scheme",
      "Demo",
      "--workspace-path",
      "./Demo.xcworkspace"
    ]);

    expect(command).toEqual({
      kind: "ipa-generate",
      json: false,
      ipaSource: {
        kind: "xcodebuild",
        scheme: "Demo",
        workspacePath: "./Demo.xcworkspace"
      }
    });
  });

  it("parses ipa generate command with auto-detection enabled", () => {
    const command = parseCliCommand(["ipa", "generate"]);

    expect(command).toEqual({
      kind: "ipa-generate",
      json: false
    });
  });

  it("parses ipa export-options command with defaults", () => {
    const command = parseCliCommand(["ipa", "export-options"]);

    expect(command).toEqual({
      kind: "ipa-export-options",
      json: false,
      force: false
    });
  });

  it("parses ipa export-options command with explicit options", () => {
    const command = parseCliCommand([
      "ipa",
      "export-options",
      "--output-plist",
      "./config/ExportOptions.plist",
      "--team-id",
      "ABCDE12345",
      "--signing-style",
      "manual",
      "--force",
      "--json"
    ]);

    expect(command).toEqual({
      kind: "ipa-export-options",
      json: true,
      force: true,
      outputPlistPath: "./config/ExportOptions.plist",
      teamId: "ABCDE12345",
      signingStyle: "manual"
    });
  });

  it("throws when signing-style is invalid for ipa export-options", () => {
    expect(() =>
      parseCliCommand([
        "ipa",
        "export-options",
        "--signing-style",
        "invalid"
      ])
    ).toThrowError(InfrastructureError);
  });
});
