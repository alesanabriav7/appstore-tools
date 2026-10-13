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

  it("infers ASC_KEY_ID from ASC_PRIVATE_KEY_PATH when missing", async () => {
    const env = await resolveCliEnvironment({
      ASC_ISSUER_ID: "issuer",
      ASC_PRIVATE_KEY_PATH: keyFilePath
    });

    expect(env.keyId).toBe("TEST");
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

  it("parses certificates create command with defaults", () => {
    const command = parseCliCommand(["certificates", "create"]);

    expect(command).toEqual({
      kind: "certificates-create",
      json: false,
      skipInstall: false
    });
  });

  it("parses certificates create command with explicit options", () => {
    const command = parseCliCommand([
      "certificates",
      "create",
      "--type",
      "IOS_DEVELOPMENT",
      "--common-name",
      "CI Certificate",
      "--output-dir",
      "./certs",
      "--keychain",
      "~/Library/Keychains/login.keychain-db",
      "--skip-install",
      "--json"
    ]);

    expect(command).toEqual({
      kind: "certificates-create",
      certificateType: "IOS_DEVELOPMENT",
      commonName: "CI Certificate",
      outputDir: "./certs",
      keychainPath: "~/Library/Keychains/login.keychain-db",
      skipInstall: true,
      json: true
    });
  });

  it("parses apps read-metadata command with defaults", () => {
    const command = parseCliCommand([
      "apps",
      "read-metadata",
      "--app",
      "com.example.myapp"
    ]);

    expect(command).toEqual({
      kind: "apps-read-metadata",
      json: false,
      appReference: "com.example.myapp",
      outputPath: "./metadata.json",
      platform: "IOS"
    });
  });

  it("parses apps read-metadata command with all flags", () => {
    const command = parseCliCommand([
      "apps",
      "read-metadata",
      "--app",
      "com.example.myapp",
      "--output",
      "./out/meta.json",
      "--version",
      "2.0.0",
      "--platform",
      "MAC_OS",
      "--json"
    ]);

    expect(command).toEqual({
      kind: "apps-read-metadata",
      json: true,
      appReference: "com.example.myapp",
      outputPath: "./out/meta.json",
      version: "2.0.0",
      platform: "MAC_OS"
    });
  });

  it("throws when apps read-metadata is missing --app flag", () => {
    expect(() =>
      parseCliCommand(["apps", "read-metadata"])
    ).toThrowError(InfrastructureError);
  });

  it("parses apps create-version as a dry-run", () => {
    expect(
      parseCliCommand([
        "apps",
        "create-version",
        "--app",
        "6759523370",
        "--version",
        "1.2.3",
        "--platform",
        "IOS"
      ])
    ).toEqual({
      kind: "apps-create-version",
      json: false,
      apply: false,
      appReference: "6759523370",
      version: "1.2.3",
      platform: "IOS"
    });
  });

  it("parses analytics, sales, and ranks commands", () => {
    expect(
      parseCliCommand(["analytics", "setup", "--app", "6759523370", "--snapshot", "--apply"])
    ).toMatchObject({
      kind: "analytics-setup",
      snapshot: true,
      apply: true,
      appReference: "6759523370"
    });

    expect(
      parseCliCommand([
        "analytics",
        "fetch",
        "--app",
        "6759523370",
        "--from",
        "2026-10-01",
        "--to",
        "2026-10-10",
        "--reports",
        "discovery,downloads",
        "--format",
        "csv"
      ])
    ).toMatchObject({
      kind: "analytics-fetch",
      from: "2026-10-01",
      to: "2026-10-10",
      reports: "discovery,downloads",
      format: "csv",
      granularity: "DAILY",
      outDir: "data/"
    });

    expect(
      parseCliCommand(["sales", "fetch", "--date", "2026-10-12", "--vendor", "87654321"])
    ).toEqual({
      kind: "sales-fetch",
      date: "2026-10-12",
      vendorNumber: "87654321",
      format: "csv"
    });

    expect(
      parseCliCommand([
        "ranks",
        "check",
        "--app",
        "6759523370",
        "--keywords",
        "keywords.txt",
        "--country",
        "co,us",
        "--out",
        "ranks.csv"
      ])
    ).toEqual({
      kind: "ranks-check",
      json: false,
      appReference: "6759523370",
      keywordsPath: "keywords.txt",
      countries: "co,us",
      outPath: "ranks.csv"
    });
  });

  it("parses update-metadata --create-version", () => {
    expect(
      parseCliCommand([
        "apps",
        "update-metadata",
        "--app",
        "6759523370",
        "--metadata",
        "./metadata.json",
        "--version",
        "1.2.3",
        "--create-version"
      ])
    ).toMatchObject({
      kind: "apps-update-metadata",
      createVersion: true,
      apply: false,
      version: "1.2.3"
    });
  });

  it("throws when apps read-metadata has invalid platform", () => {
    expect(() =>
      parseCliCommand([
        "apps",
        "read-metadata",
        "--app",
        "com.example.myapp",
        "--platform",
        "TVOS"
      ])
    ).toThrowError(InfrastructureError);
  });
});
