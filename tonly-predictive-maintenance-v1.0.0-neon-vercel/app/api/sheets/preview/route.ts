import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { authorizePlanner } from "@/lib/auth/session";

export const runtime = "nodejs";

function extractSpreadsheetId(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? trimmed;
}

export async function POST(request: NextRequest) {
  try {
    const planner = await authorizePlanner();
    if (!planner.ok) return NextResponse.json({ error: planner.error }, { status: planner.status });
    const body = await request.json() as { spreadsheetId?: string; range?: string };
    const rawId = body.spreadsheetId?.trim();
    const range = body.range?.trim() || "'Charging Log'!A1:Z5000";
    if (!rawId) return NextResponse.json({ error: "Spreadsheet ID or URL is required." }, { status: 400 });
    const endRowMatch = range.match(/:\$?[A-Z]+\$?(\d+)\s*$/i);
    const startRowMatch = range.match(/!?(?:'[^']+'|[^!]+)?!?\$?[A-Z]+\$?(\d+)\s*:/i);
    const endRow = endRowMatch ? Number(endRowMatch[1]) : NaN;
    const startRow = startRowMatch ? Number(startRowMatch[1]) : NaN;
    if (!Number.isFinite(startRow) || !Number.isFinite(endRow) || startRow < 1 || endRow < startRow || endRow - startRow + 1 > 10001) {
      return NextResponse.json({ error: "Use a bounded A1 range with a start and end row, for example 'Charging Log'!A1:Z5000. Maximum range height is 10,001 rows including headers." }, { status: 400 });
    }

    const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
    if (!clientEmail || !privateKey) {
      return NextResponse.json({
        error: "Google Sheets is not configured yet. Add GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY to the server environment, then share the sheet with that service account."
      }, { status: 503 });
    }

    const spreadsheetId = extractSpreadsheetId(rawId);
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(spreadsheetId)) return NextResponse.json({ error: "The spreadsheet ID or URL is not in a valid Google Sheets format." }, { status: 400 });
    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: clientEmail, private_key: privateKey },
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: "FORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = response.data.values ?? [];
    if (values.length > 10001) return NextResponse.json({ error: "Google Sheets returned more than 10,001 rows. Reduce the selected range." }, { status: 413 });
    return NextResponse.json({ values, rowCount: values.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google Sheets request failed.";
    const status = /not configured|configuration is incomplete/i.test(message) ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
