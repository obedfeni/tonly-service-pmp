import { NextRequest, NextResponse } from "next/server";
import { createSession, SESSION_COOKIE, SESSION_MAX_AGE, verifyPassword } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const emailAllowlist = process.env.PLANNER_EMAIL?.trim().toLowerCase();
  const passwordHash = process.env.PLANNER_PASSWORD_HASH;
  if (!emailAllowlist || !passwordHash || !process.env.SESSION_SECRET) {
    return NextResponse.json({ error: "Planner authentication is not configured on the server." }, { status: 503 });
  }
  let body: { email?: unknown; password?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  if (email !== emailAllowlist || !password || password.length > 1024 || !verifyPassword(password, passwordHash)) {
    return NextResponse.json({ error: "Email or password is incorrect." }, { status: 401 });
  }
  try {
    const response = NextResponse.json({ signedIn: true, email });
    response.cookies.set(SESSION_COOKIE, createSession(email), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create planner session." }, { status: 503 });
  }
}
