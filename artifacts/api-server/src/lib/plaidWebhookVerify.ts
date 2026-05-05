import crypto from "node:crypto";
import { plaid } from "./plaid";

// Plaid signs every webhook with a JWS (ES256) carried in the
// `Plaid-Verification` header. The JWT's payload contains a
// `request_body_sha256` claim which we cross-check against a SHA-256 of the
// raw request body to prove the body wasn't tampered with in transit. Plaid's
// docs: https://plaid.com/docs/api/webhooks/webhook-verification/
//
// We deliberately avoid pulling in `jose` or `jsonwebtoken`: Node's built-in
// `crypto.createPublicKey({ format: "jwk" })` + `crypto.verify(..., {
// dsaEncoding: "ieee-p1363" })` handles the EC P-256 case Plaid uses with
// no extra dependency.

type CachedJwk = {
  key: crypto.KeyObject;
  fetchedAt: number;
};

// JWKs are stable per `kid` (Plaid rotates by issuing new kids), so caching
// the parsed KeyObject avoids hitting `/webhook_verification_key/get` on
// every webhook. 24h is conservative — even if Plaid expires a key sooner,
// a verification miss just falls through to a fresh fetch on the next req.
const JWK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const jwkCache = new Map<string, CachedJwk>();

export function _resetJwkCacheForTests(): void {
  jwkCache.clear();
}

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

type JwtSegments = {
  header: { alg?: string; kid?: string; typ?: string };
  payloadJson: string;
  signature: Buffer;
  signedInput: string;
};

function decodeJwtSegments(token: string): JwtSegments {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("malformed JWT (expected 3 segments)");
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(base64UrlDecode(headerB64).toString("utf8")) as {
    alg?: string;
    kid?: string;
    typ?: string;
  };
  const payloadJson = base64UrlDecode(payloadB64).toString("utf8");
  const signature = base64UrlDecode(sigB64);
  return {
    header,
    payloadJson,
    signature,
    signedInput: `${headerB64}.${payloadB64}`,
  };
}

async function getVerificationKey(kid: string): Promise<crypto.KeyObject> {
  const cached = jwkCache.get(kid);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < JWK_CACHE_TTL_MS) {
    return cached.key;
  }
  const resp = await plaid().webhookVerificationKeyGet({ key_id: kid });
  const jwk = resp.data.key;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new Error(`unexpected JWK shape for kid ${kid}`);
  }
  // `crypto.createPublicKey` accepts a JWK directly when format: "jwk".
  // The JsonWebKeyInput shape isn't re-exported on the public crypto
  // namespace, so cast through `unknown` — the runtime accepts the plain
  // object.
  const key = crypto.createPublicKey({
    key: {
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
    },
    format: "jwk",
  } as unknown as Parameters<typeof crypto.createPublicKey>[0]);
  jwkCache.set(kid, { key, fetchedAt: now });
  return key;
}

export type WebhookVerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

export type VerifyOpts = {
  // Override "now" in seconds since epoch — used by tests so they don't have
  // to mock the system clock.
  nowSec?: number;
  // How old the JWT may be before we reject it. Plaid's docs require <=5 min.
  maxAgeSec?: number;
};

export async function verifyPlaidWebhook(
  rawBody: Buffer,
  jwtHeader: string | undefined,
  opts: VerifyOpts = {},
): Promise<WebhookVerifyResult> {
  if (!jwtHeader) {
    return { ok: false, reason: "missing Plaid-Verification header" };
  }
  let segments: JwtSegments;
  try {
    segments = decodeJwtSegments(jwtHeader.trim());
  } catch (e) {
    return {
      ok: false,
      reason: `could not decode JWT: ${(e as Error).message}`,
    };
  }
  if (segments.header.alg !== "ES256") {
    return {
      ok: false,
      reason: `unsupported alg "${segments.header.alg ?? "(none)"}"`,
    };
  }
  if (!segments.header.kid) {
    return { ok: false, reason: "JWT header missing kid" };
  }
  let key: crypto.KeyObject;
  try {
    key = await getVerificationKey(segments.header.kid);
  } catch (e) {
    return {
      ok: false,
      reason: `could not fetch verification key: ${(e as Error).message}`,
    };
  }
  // ES256 in JOSE uses raw R||S (64 bytes); Node's crypto expects DER unless
  // we ask for IEEE P1363 (== JOSE) encoding explicitly.
  const verified = crypto.verify(
    "sha256",
    Buffer.from(segments.signedInput, "utf8"),
    { key, dsaEncoding: "ieee-p1363" },
    segments.signature,
  );
  if (!verified) {
    return { ok: false, reason: "signature verification failed" };
  }
  let payload: { iat?: number; request_body_sha256?: string };
  try {
    payload = JSON.parse(segments.payloadJson) as typeof payload;
  } catch (e) {
    return {
      ok: false,
      reason: `could not parse JWT payload: ${(e as Error).message}`,
    };
  }
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAge = opts.maxAgeSec ?? 5 * 60;
  if (typeof payload.iat !== "number") {
    return { ok: false, reason: "JWT missing iat" };
  }
  if (now - payload.iat > maxAge) {
    return { ok: false, reason: "JWT too old" };
  }
  if (!payload.request_body_sha256) {
    return { ok: false, reason: "JWT missing request_body_sha256" };
  }
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const a = Buffer.from(payload.request_body_sha256, "utf8");
  const b = Buffer.from(bodyHash, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "request_body_sha256 mismatch" };
  }
  return { ok: true };
}
