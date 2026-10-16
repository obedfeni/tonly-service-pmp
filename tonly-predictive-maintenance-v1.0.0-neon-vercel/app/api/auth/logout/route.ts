import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
export const runtime = "nodejs";
export async function POST() {
  const response = NextResponse.json({ signedIn: false });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
