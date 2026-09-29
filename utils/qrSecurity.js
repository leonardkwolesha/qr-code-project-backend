import crypto from "crypto";

/**
 * =====================================================================
 * QR SECURITY UTILITY
 * ---------------------------------------------------------------------
 * Signed QR payloads for exam hall-ticket verification.
 *
 * A signed token has the shape:   <base64url(payload)>.<hex(hmac)>
 * where hmac = HMAC-SHA256(base64url(payload), QR_SECRET).
 *
 * The scanner cannot forge a valid token without the server secret,
 * and the backend re-computes + constant-time compares the signature
 * before trusting the payload. This mirrors the standard
 * "payload | signature" scheme used by secure exam QR systems.
 * =====================================================================
 */

const getSecret = () => {
  const secret = process.env.QR_SECRET;
  if (!secret) {
    throw new Error(
      "QR_SECRET is not defined in the environment. Add QR_SECRET to your .env file."
    );
  }
  return secret;
};

const base64url = (input) =>
  Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromBase64url = (input) => {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(normalized, "base64").toString("utf8");
};

const hmac = (data) =>
  crypto.createHmac("sha256", getSecret()).update(data).digest("hex");

/**
 * Sign an object payload into a tamper-evident QR string.
 * @param {object} payload  e.g. { userId, qrToken, iat }
 * @returns {string} "<base64url>.<signature>"
 */
export const signPayload = (payload) => {
  const encoded = base64url(JSON.stringify(payload));
  const signature = hmac(encoded);
  return `${encoded}.${signature}`;
};

/**
 * Verify + decode a signed QR string.
 * Throws on malformed / tampered tokens.
 * @param {string} token
 * @returns {object} decoded payload
 */
export const verifyPayload = (token) => {
  if (typeof token !== "string" || !token.includes(".")) {
    throw new Error("Malformed QR token");
  }

  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) {
    throw new Error("Malformed QR token");
  }

  const expected = hmac(encoded);

  // Constant-time comparison to avoid timing attacks.
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    throw new Error("Invalid QR signature");
  }

  try {
    return JSON.parse(fromBase64url(encoded));
  } catch {
    throw new Error("Corrupt QR payload");
  }
};

/**
 * Generate a fresh opaque QR token (stored on the student record).
 * Regenerating this value instantly revokes any previously issued QR.
 */
export const generateQrToken = () => crypto.randomBytes(24).toString("hex");
