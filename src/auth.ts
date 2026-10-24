import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "./db.js";
import { hashToken, isAdminEmail, newToken, parseCookies, safeEqual } from "./authUtils.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
}

const SESSION_COOKIE = "tw_session";
const STATE_COOKIE = "tw_oauth_state";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** The public address of this site, taken from ALLOWED_ORIGIN. */
function siteUrl(): string | null {
  const origin = process.env.ALLOWED_ORIGIN;
  if (!origin || origin === "*") return null;
  return origin.replace(/\/+$/, "");
}

function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: (siteUrl() ?? "").startsWith("https://"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeMs,
  };
}

function toAuthUser(row: { id: string; email: string; name: string | null }): AuthUser {
  return { id: row.id, email: row.email, name: row.name, isAdmin: isAdminEmail(row.email) };
}

function deny(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });
}

/** Rejects browser requests that come from another website. */
function originAllowed(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  const expected = siteUrl() ?? `${req.protocol}://${req.get("host") ?? ""}`;
  return origin === expected;
}

async function userFromSession(req: Request): Promise<AuthUser | null> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  return toAuthUser(session.user);
}

type KeyResult =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "no-owner" }
  | { status: "ok"; user: AuthUser };

/** The old shared API key now only opens the admin's own tasks. */
async function checkOwnerKey(req: Request): Promise<KeyResult> {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return { status: "absent" };
  const token = header.slice("Bearer ".length);
  const expected = process.env.TASKWISE_API_KEY;
  if (!expected || !token || !safeEqual(token, expected)) return { status: "invalid" };
  const adminEmail = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!adminEmail) return { status: "no-owner" };
  const row = await prisma.user.findUnique({ where: { email: adminEmail } });
  return row ? { status: "ok", user: toAuthUser(row) } : { status: "no-owner" };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionUser = await userFromSession(req);
    if (sessionUser) {
      if (!originAllowed(req)) {
        deny(res, 403, "Request origin not allowed.");
        return;
      }
      res.locals.user = sessionUser;
      res.locals.via = "session";
      next();
      return;
    }
    const key = await checkOwnerKey(req);
    if (key.status === "ok") {
      res.locals.user = key.user;
      res.locals.via = "key";
      next();
      return;
    }
    if (key.status === "no-owner") {
      deny(res, 401, "Sign in with Google once to create the owner account, then this key will work.");
      return;
    }
    deny(res, 401, key.status === "invalid" ? "Invalid API key." : "Not signed in.");
  } catch (err) {
    console.error("Auth check failed:", err instanceof Error ? err.message : "unknown error");
    deny(res, 500, "Server error while checking sign-in.");
  }
}

export function getAuthUser(res: Response): AuthUser {
  const user = res.locals.user as AuthUser | undefined;
  if (!user) throw new Error("No authenticated user.");
  return user;
}

/** Plain-language list of missing sign-in settings, for the startup log. */
export function authConfigWarnings(): string[] {
  const missing: string[] = [];
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET", "ADMIN_EMAIL"]) {
    if (!process.env[name]) missing.push(name);
  }
  const warnings: string[] = [];
  if (missing.length > 0) warnings.push(`Sign-in is not fully configured. Missing: ${missing.join(", ")}.`);
  if (!siteUrl()) warnings.push("ALLOWED_ORIGIN must be set to your site's address for Google sign-in to work.");
  return warnings;
}

// ---------- Google sign-in ----------
const tokenSchema = z.object({ access_token: z.string().min(1) });
const profileSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
});

async function fetchGoogleProfile(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
) {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    console.error("Google token exchange failed with status", tokenRes.status);
    return null;
  }
  const token = tokenSchema.safeParse(await tokenRes.json());
  if (!token.success) return null;

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.data.access_token}` },
  });
  if (!infoRes.ok) {
    console.error("Google userinfo failed with status", infoRes.status);
    return null;
  }
  const profile = profileSchema.safeParse(await infoRes.json());
  if (!profile.success || profile.data.email_verified !== true) return null;
  return profile.data;
}

export const authRouter = Router();

authRouter.get("/google", (_req: Request, res: Response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const base = siteUrl();
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET || !process.env.SESSION_SECRET || !base) {
    res.status(503).json({ error: "Google sign-in is not configured on this server." });
    return;
  }
  const state = newToken();
  res.cookie(STATE_COOKIE, state, cookieOptions(10 * 60 * 1000));
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${base}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

authRouter.get("/google/callback", async (req: Request, res: Response) => {
  const expected = parseCookies(req.headers.cookie)[STATE_COOKIE] ?? "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  res.clearCookie(STATE_COOKIE, { path: "/" });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const base = siteUrl();
  if (!expected || !state || !code || !safeEqual(state, expected) || !clientId || !clientSecret || !base) {
    res.redirect("/?auth=failed");
    return;
  }

  try {
    const profile = await fetchGoogleProfile(code, clientId, clientSecret, `${base}/auth/google/callback`);
    if (!profile) {
      res.redirect("/?auth=failed");
      return;
    }
    const email = profile.email.toLowerCase();
    const row = await prisma.user.upsert({
      where: { googleId: profile.sub },
      create: {
        googleId: profile.sub,
        email,
        name: profile.name ?? null,
        picture: profile.picture ?? null,
      },
      update: {
        email,
        name: profile.name ?? null,
        picture: profile.picture ?? null,
        lastLoginAt: new Date(),
      },
    });
    // Tasks created before accounts existed belong to the admin.
    if (isAdminEmail(email)) {
      await prisma.task.updateMany({ where: { userId: null }, data: { userId: row.id } });
    }
    await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const token = newToken();
    await prisma.session.create({
      data: { tokenHash: hashToken(token), userId: row.id, expiresAt: new Date(Date.now() + SESSION_MS) },
    });
    res.cookie(SESSION_COOKIE, token, cookieOptions(SESSION_MS));
    res.redirect("/");
  } catch (err) {
    console.error("Google sign-in failed:", err instanceof Error ? err.message : "unknown error");
    res.redirect("/?auth=failed");
  }
});

authRouter.post("/logout", async (req: Request, res: Response) => {
  if (!originAllowed(req)) {
    deny(res, 403, "Request origin not allowed.");
    return;
  }
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  } catch (err) {
    console.error("Logout cleanup failed:", err instanceof Error ? err.message : "unknown error");
  }
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// ---------- Signed-in account routes ----------
export const apiRouter = Router();
apiRouter.use(requireAuth);

apiRouter.get("/me", (_req: Request, res: Response) => {
  const user = getAuthUser(res);
  res.json({ email: user.email, name: user.name, isAdmin: user.isAdmin });
});

apiRouter.post("/account/delete", async (_req: Request, res: Response) => {
  if (res.locals.via !== "session") {
    deny(res, 403, "Sign in with Google to delete your account.");
    return;
  }
  try {
    const user = getAuthUser(res);
    await prisma.user.delete({ where: { id: user.id } });
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Account deletion failed:", err instanceof Error ? err.message : "unknown error");
    deny(res, 500, "Could not delete the account. Try again.");
  }
});