import { NextResponse } from "next/server";
import { queryRows } from "@/lib/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const checks = {
    neonConfigured: Boolean(process.env.DATABASE_URL?.trim()),
    plannerConfigured: Boolean(process.env.PLANNER_EMAIL?.trim() && process.env.PLANNER_PASSWORD_HASH && process.env.SESSION_SECRET),
    googleSheetsConfigured: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY),
    mlComputeConfigured: Boolean(process.env.ML_API_SECRET?.trim()),
  };
  let databaseReachable = false;
  if (checks.neonConfigured) { try { await queryRows("SELECT 1 AS ok"); databaseReachable = true; } catch { databaseReachable = false; } }
  const ready = checks.neonConfigured && databaseReachable && checks.plannerConfigured && checks.mlComputeConfigured;
  return NextResponse.json({ application: "TONLY Predictive Maintenance Intelligence", version: "1.0.0", status: ready ? "configured" : "configuration_required", checks: { ...checks, databaseReachable }, note: "This endpoint tests database connectivity and configuration presence; it does not assess model accuracy." }, { headers: { "Cache-Control": "no-store" } });
}
