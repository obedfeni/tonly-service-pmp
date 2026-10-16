import { NextResponse } from "next/server";
import { getPlannerSession } from "@/lib/auth/session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try { const session = await getPlannerSession(); return NextResponse.json({ signedIn: Boolean(session), email: session?.email ?? null }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ signedIn: false, email: null }, { headers: { "Cache-Control": "no-store" } }); }
}
