import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AppStoreConnectClient,
  InfrastructureError,
  type Clock
} from "../../src/api/client.js";

class MutableClock implements Clock {
  public constructor(private epochSeconds: number) {}

  public now(): Date {
    return new Date(this.epochSeconds * 1000);
  }

  public advanceBy(seconds: number): void {
    this.epochSeconds += seconds;
  }
}

function decodeJwtPart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

function splitJwtToken(token: string): [string, string, string] {
  const [headerPart, payloadPart, signaturePart] = token.split(".");

  if (!headerPart || !payloadPart || !signaturePart) {
    throw new Error("Invalid JWT format.");
  }

  return [headerPart, payloadPart, signaturePart];
}

describe("AppStoreConnectClient", () => {
  const privateKeyPem = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" }
  });

  describe("JWT token generation", () => {
    it("creates a valid ES256 JWT with expected claims", async () => {
      const clock = new MutableClock(1_700_000_000);
      const client = new AppStoreConnectClient(
        {
          issuerId: "issuer-id",
          keyId: "ABC123DEFG",
          privateKey: privateKeyPem.privateKey,
          audience: "appstoreconnect-v1",
          scope: ["GET /v1/apps"]
        },
        { clock }
      );

      const token = await client.getToken();
      const [headerPart, payloadPart, signaturePart] = splitJwtToken(token);

      const header = decodeJwtPart<{ alg: string; kid: string; typ: string }>(
        headerPart
      );
      const payload = decodeJwtPart<{
        iss: string;
        iat: number;
        exp: number;
        aud: string;
        scope?: string[];
      }>(payloadPart);

      expect(header).toEqual({
        alg: "ES256",
        kid: "ABC123DEFG",
        typ: "JWT"
      });
      expect(payload.iss).toBe("issuer-id");
      expect(payload.aud).toBe("appstoreconnect-v1");
      expect(payload.exp - payload.iat).toBe(1200);
      expect(payload.scope).toEqual(["GET /v1/apps"]);

      const verifier = createVerify("SHA256");
      verifier.update(`${headerPart}.${payloadPart}`);
      verifier.end();

      const isValidSignature = verifier.verify(
        {
          key: privateKeyPem.publicKey,
          dsaEncoding: "ieee-p1363"
        },
        Buffer.from(signaturePart, "base64url")
      );

      expect(isValidSignature).toBe(true);
    });

    it("returns cached token until refresh window", async () => {
      const clock = new MutableClock(1_000);
      const client = new AppStoreConnectClient(
        {
          issuerId: "issuer-id",
          keyId: "ABC123DEFG",
          privateKey: privateKeyPem.privateKey
        },
        { clock }
      );

      const firstToken = await client.getToken();

      clock.advanceBy(120);
      const secondToken = await client.getToken();

      clock.advanceBy(1_051);
      const thirdToken = await client.getToken();

      expect(secondToken).toBe(firstToken);
      expect(thirdToken).not.toBe(firstToken);
    });

    it("throws when token ttl is invalid", () => {
      expect(
        () =>
          new AppStoreConnectClient({
            issuerId: "issuer-id",
            keyId: "ABC123DEFG",
            privateKey: privateKeyPem.privateKey,
            tokenTtlSeconds: 1_201
          })
      ).toThrowError(InfrastructureError);
    });
  });

  describe("HTTP requests", () => {
    it("sends bearer token and query params", async () => {
      const calls: { input: URL | string; init: RequestInit | undefined }[] = [];

      const client = new AppStoreConnectClient(
        {
          issuerId: "issuer-id",
          keyId: "ABC123DEFG",
          privateKey: privateKeyPem.privateKey
        },
        {
          fetchLike: async (input, init) => {
            calls.push({ input, init });
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" }
            });
          }
        }
      );

      const response = await client.request<{ ok: boolean }>({
        method: "GET",
        path: "/v1/apps",
        query: { limit: 5 }
      });

      expect(response.data.ok).toBe(true);
      expect(calls).toHaveLength(1);

      const call = calls[0];
      expect(call?.input instanceof URL).toBe(true);
      expect((call?.input as URL).toString()).toBe(
        "https://api.appstoreconnect.apple.com/v1/apps?limit=5"
      );

      const requestHeaders = new Headers(call?.init?.headers);
      expect(requestHeaders.get("Authorization")).toMatch(/^Bearer /);
    });

    it("throws infrastructure error when response is not ok", async () => {
      const client = new AppStoreConnectClient(
        {
          issuerId: "issuer-id",
          keyId: "ABC123DEFG",
          privateKey: privateKeyPem.privateKey
        },
        {
          fetchLike: async () =>
            new Response(
              JSON.stringify({
                errors: [
                  {
                    status: "403",
                    source: { pointer: "/data/attributes/demo" }
                  }
                ]
              }),
              {
                status: 403,
                statusText: "Forbidden"
              }
            )
        }
      );

      await expect(
        client.request({
          method: "GET",
          path: "/v1/apps"
        })
      ).rejects.toMatchObject({
        name: "InfrastructureError",
        details: {
          statusCode: 403
        }
      });

      await client
        .request({
          method: "GET",
          path: "/v1/apps"
        })
        .then(() => {
          throw new Error("Expected request to fail.");
        })
        .catch((error) => {
          expect(error).toBeInstanceOf(InfrastructureError);
          const infrastructureError = error as InfrastructureError;
          expect(infrastructureError.details?.statusCode).toBe(403);
          expect(infrastructureError.details?.responseJson).toEqual({
            errors: [
              {
                status: "403",
                source: { pointer: "/data/attributes/demo" }
              }
            ]
          });
        });
    });
  });
});
