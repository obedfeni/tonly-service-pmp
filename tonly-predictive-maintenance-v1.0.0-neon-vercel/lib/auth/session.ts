import "server-only";
import { createHmac, timingSafeEqual, scryptSync } from "node:crypto";
import { cookies } from "next/headers";
import { createDatabaseCompatibilityClient } from "@/lib/db";

export const SESSION_COOKIE = "tonly_planner_session";
const SESSION_SECONDS = 60 * 60 * 12;
type SessionPayload = { email: string; exp: number; iss: "tonly-planner" };

function secret(): string {
  const value = process.env.SESSION_SECRET ?? "";
  if (Buffer.byteLength(value, "utf8") < 32) throw new Error("SESSION_SECRET must contain at least 32 bytes of random data.");
  return value;
}
function signature(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}
export function verifyPassword(password: string, encoded: string): boolean {
  const [salt, expectedHex, extra] = encoded.split(":");
  if (!salt || !expectedHex || extra || !/^[a-f0-9]{128}$/i.test(expectedHex)) return false;
  const actual = scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(actual, "hex"), b = Buffer.from(expectedHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
export function createSession(email: string): string {
  const payload: SessionPayload = { email: email.trim().toLowerCase(), exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, iss: "tonly-planner" };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}
export function verifySession(token: string | undefined): { email: string } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let supplied: Buffer;
  let expected: Buffer;
  try { supplied = Buffer.from(parts[1], "base64url"); expected = Buffer.from(signature(parts[0]), "base64url"); }
  catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as SessionPayload;
    const allowlisted = process.env.PLANNER_EMAIL?.trim().toLowerCase();
    if (payload.iss !== "tonly-planner" || !payload.email || payload.email !== allowlisted || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) return null;
    return { email: payload.email };
  } catch { return null; }
}
export async function getPlannerSession() {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}
export async function authorizePlanner() {
  const email = process.env.PLANNER_EMAIL?.trim().toLowerCase();
  if (!email || !process.env.PLANNER_PASSWORD_HASH || !process.env.SESSION_SECRET) {
    return { ok: false as const, status: 503, error: "Planner access is not configured. Set PLANNER_EMAIL, PLANNER_PASSWORD_HASH, and SESSION_SECRET." };
  }
  let session: { email: string } | null;
  try { session = await getPlannerSession(); }
  catch (error) { return { ok: false as const, status: 503, error: error instanceof Error ? error.message : "Session configuration error." }; }
  if (!session) return { ok: false as const, status: 401, error: "Sign in with the authorized planner account to continue." };
  return { ok: true as const, user: { email: session.email, id: session.email }, db: createDatabaseCompatibilityClient() };
}
export const SESSION_MAX_AGE = SESSION_SECONDS;
