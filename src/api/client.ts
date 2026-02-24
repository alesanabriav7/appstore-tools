import { createSign } from "node:crypto";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export class InfrastructureError extends Error {
  public override readonly cause?: unknown;
  public readonly details:
    | {
        readonly statusCode?: number;
        readonly responseBody?: string;
        readonly responseJson?: unknown;
      }
    | undefined;

  public constructor(
    message: string,
    cause?: unknown,
    details?: {
      readonly statusCode?: number;
      readonly responseBody?: string;
      readonly responseJson?: unknown;
    }
  ) {
    super(message);
    this.name = "InfrastructureError";
    this.cause = cause;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// HTTP primitives
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type HttpQueryValue = string | number | boolean | undefined;

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, HttpQueryValue>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly data: T;
}

// ---------------------------------------------------------------------------
// Auth config
// ---------------------------------------------------------------------------

export interface AppStoreConnectAuthConfig {
  readonly issuerId: string;
  readonly keyId: string;
  readonly privateKey: string;
  readonly audience?: string;
  readonly scope?: readonly string[];
  readonly tokenTtlSeconds?: number;
}

// ---------------------------------------------------------------------------
// JWT internals
// ---------------------------------------------------------------------------

interface JwtHeader {
  readonly alg: "ES256";
  readonly kid: string;
  readonly typ: "JWT";
}

interface JwtPayload {
  readonly iss: string;
  readonly iat: number;
  readonly exp: number;
  readonly aud: string;
  readonly scope?: readonly string[];
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtEpochSeconds: number;
}

function encodeJsonAsBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const MAX_TOKEN_TTL_SECONDS = 1200;
const DEFAULT_TOKEN_TTL_SECONDS = 1200;
const REFRESH_WINDOW_SECONDS = 30;
const DEFAULT_AUDIENCE = "appstoreconnect-v1";
const DEFAULT_BASE_URL = "https://api.appstoreconnect.apple.com/";

// ---------------------------------------------------------------------------
// Clock (injectable for testing)
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

// ---------------------------------------------------------------------------
// AppStoreConnectClient
// ---------------------------------------------------------------------------

export type FetchLike = (
  input: URL | string,
  init?: RequestInit
) => Promise<Response>;

export class AppStoreConnectClient {
  private cachedToken: CachedToken | null = null;
  private readonly baseUrl: URL;
  private readonly clock: Clock;
  private readonly fetchLike: FetchLike;
  private readonly config: AppStoreConnectAuthConfig;

  public constructor(
    config: AppStoreConnectAuthConfig,
    options?: {
      readonly baseUrl?: string;
      readonly clock?: Clock;
      readonly fetchLike?: FetchLike;
    }
  ) {
    this.assertValidConfig(config);
    this.config = config;
    this.baseUrl = new URL(options?.baseUrl ?? DEFAULT_BASE_URL);
    this.clock = options?.clock ?? new SystemClock();
    this.fetchLike = options?.fetchLike ?? fetch;
  }

  public async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const token = await this.getToken();
    const url = this.buildUrl(request.path, request.query);

    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token}`);

    const hasBody = request.body !== undefined;
    if (hasBody && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const requestInit: RequestInit = {
      method: request.method,
      headers
    };

    if (hasBody) {
      requestInit.body = JSON.stringify(request.body);
    }

    const response = await this.fetchLike(url, requestInit);

    if (!response.ok) {
      const errorBody = await safeReadText(response);
      const parsedErrorBody = tryParseJson(errorBody);
      throw new InfrastructureError(
        `App Store Connect request failed (${response.status}): ${errorBody || response.statusText}`,
        undefined,
        {
          statusCode: response.status,
          ...(errorBody ? { responseBody: errorBody } : {}),
          ...(parsedErrorBody ? { responseJson: parsedErrorBody } : {})
        }
      );
    }

    if (response.status === 204) {
      return {
        status: response.status,
        headers: response.headers,
        data: undefined as T
      };
    }

    const textBody = await response.text();

    if (!textBody) {
      return {
        status: response.status,
        headers: response.headers,
        data: undefined as T
      };
    }

    try {
      return {
        status: response.status,
        headers: response.headers,
        data: JSON.parse(textBody) as T
      };
    } catch (error) {
      throw new InfrastructureError(
        "Received invalid JSON from App Store Connect.",
        error
      );
    }
  }

  public async getToken(): Promise<string> {
    const nowEpochSeconds = this.currentEpochSeconds();

    if (
      this.cachedToken &&
      nowEpochSeconds < this.cachedToken.expiresAtEpochSeconds - REFRESH_WINDOW_SECONDS
    ) {
      return this.cachedToken.token;
    }

    const payload = this.buildPayload(nowEpochSeconds);
    const header: JwtHeader = {
      alg: "ES256",
      kid: this.config.keyId,
      typ: "JWT"
    };

    const encodedHeader = encodeJsonAsBase64Url(header);
    const encodedPayload = encodeJsonAsBase64Url(payload);
    const signaturePayload = `${encodedHeader}.${encodedPayload}`;
    const signature = this.sign(signaturePayload);
    const token = `${signaturePayload}.${signature}`;

    this.cachedToken = {
      token,
      expiresAtEpochSeconds: payload.exp
    };

    return token;
  }

  private buildPayload(nowEpochSeconds: number): JwtPayload {
    const ttlSeconds = this.config.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;

    const payload: JwtPayload = {
      iss: this.config.issuerId,
      iat: nowEpochSeconds,
      exp: nowEpochSeconds + ttlSeconds,
      aud: this.config.audience ?? DEFAULT_AUDIENCE
    };

    if (this.config.scope && this.config.scope.length > 0) {
      return {
        ...payload,
        scope: this.config.scope
      };
    }

    return payload;
  }

  private sign(payload: string): string {
    try {
      const signer = createSign("SHA256");
      signer.update(payload);
      signer.end();

      return signer
        .sign({ key: this.config.privateKey, dsaEncoding: "ieee-p1363" })
        .toString("base64url");
    } catch (error) {
      throw new InfrastructureError(
        "Failed to sign App Store Connect JWT token.",
        error
      );
    }
  }

  private currentEpochSeconds(): number {
    return Math.floor(this.clock.now().getTime() / 1000);
  }

  private buildUrl(path: string, query?: Readonly<Record<string, HttpQueryValue>>): URL {
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    const url = new URL(normalizedPath, this.baseUrl);

    if (!query) {
      return url;
    }

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  private assertValidConfig(config: AppStoreConnectAuthConfig): void {
    if (!config.issuerId.trim()) {
      throw new InfrastructureError("issuerId is required.");
    }

    if (!config.keyId.trim()) {
      throw new InfrastructureError("keyId is required.");
    }

    if (!config.privateKey.trim()) {
      throw new InfrastructureError("privateKey is required.");
    }

    const ttl = config.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;

    if (ttl <= 0 || ttl > MAX_TOKEN_TTL_SECONDS) {
      throw new InfrastructureError(
        `tokenTtlSeconds must be between 1 and ${MAX_TOKEN_TTL_SECONDS}.`
      );
    }
  }
}

export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function tryParseJson(value: string): unknown {
  if (!value.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
