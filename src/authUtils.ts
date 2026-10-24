import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/** Reads a Cookie header into a name -> value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** A new random token (256 bits). */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Session tokens are stored hashed, so a database leak cannot be used to sign in. */
export function hashToken(token: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set.");
  return createHmac("sha256", secret).update(token).digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True only for the admin email set in ADMIN_EMAIL (case and spaces ignored). */
export function isAdminEmail(email: string): boolean {
  const admin = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  return admin.length > 0 && email.trim().toLowerCase() === admin;
}