import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizePlanner } from "@/lib/auth/session";
import { queryRows } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_ROWS = 10000;
const CHUNK_SIZE = 400;
type SourceRow = Record<string, unknown>;
function getColumn(headers: string[], regex: RegExp) { return headers.find((h) => regex.test(h)); }
function parseDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "number" && value > 20000 && value < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + value * 86400000); return Number.isFinite(d.getTime()) ? d : null; }
  const raw = String(value ?? "").trim(); if (!raw) return null;
  const dmy = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) { const day=Number(dmy[1]), month=Number(dmy[2]), year=Number(dmy[3]); const d=new Date(Date.UTC(year,month-1,day)); if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)return null; return d; }
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (iso) { const year=Number(iso[1]),month=Number(iso[2]),day=Number(iso[3]); const d=new Date(Date.UTC(year,month-1,day)); if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)return null; }
  const d = new Date(raw); return Number.isFinite(d.getTime()) ? d : null;
}
function parseOdometer(value: unknown): number | null { const raw=String(value??"").replace(/,/g,"").trim(); if(!raw)return null; const n=typeof value==="number"?value:Number(raw); return Number.isFinite(n)&&n>=0?n:null; }

export async function GET() {
  const auth = await authorizePlanner(); if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try { const batches = await queryRows("SELECT id,source_name,source_range,started_at,finished_at,row_count,accepted_count,flagged_count,rejected_count,status,error_summary,initiated_by FROM import_batches ORDER BY started_at DESC LIMIT 20"); return NextResponse.json({ batches }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load import history." }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  const auth = await authorizePlanner(); if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  let batchId: string | null = null;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 12 * 1024 * 1024) return NextResponse.json({ error: "Import request exceeds the 12 MB request limit. Split the file into smaller batches." }, { status: 413 });
    const rawBody = await request.text(); if (Buffer.byteLength(rawBody, "utf8") > 12 * 1024 * 1024) return NextResponse.json({ error: "Import request exceeds the 12 MB request limit." }, { status: 413 });
    let body: { sourceName?: string; sourceRange?: string; sourceRowOffset?: number; headers?: unknown; rows?: unknown };
    try { body = JSON.parse(rawBody) as typeof body; } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
    const sourceName = String(body.sourceName ?? "manual-upload").trim().slice(0,180), sourceRange=String(body.sourceRange??"").trim().slice(0,300);
    const headers = Array.isArray(body.headers) ? body.headers.map(h=>String(h).slice(0,180)) : [];
    const rows = Array.isArray(body.rows) ? body.rows as SourceRow[] : [];
    if (!headers.length || !rows.length) return NextResponse.json({ error: "A header row and at least one data row are required." }, { status: 400 });
    if (headers.length > 100 || rows.length > MAX_ROWS) return NextResponse.json({ error: `Import limits are 100 columns and ${MAX_ROWS.toLocaleString()} rows per batch.` }, { status: 413 });
    if (headers.some(h=>!h.trim()) || new Set(headers.map(h=>h.trim().toLowerCase())).size!==headers.length) return NextResponse.json({ error: "Column headers must be non-empty and unique (case-insensitive)." }, { status: 400 });
    if (rows.some(row=>!row || typeof row!=="object" || Array.isArray(row))) return NextResponse.json({ error: "Every data row must be an object keyed by source column names." }, { status: 400 });
    const idCol=getColumn(headers,/vehicle number|vehicle|truck.?id|truck|车辆编号/i), dateCol=getColumn(headers,/^date$|date.?time|observed.?at|日期/i), odoCol=getColumn(headers,/kilomet|odometer|公里数|里程/i), timeCol=getColumn(headers,/start.?charging.?time|start time|开始充电时间/i);
    const parsed=rows.map((raw,index)=>{
      const truckCode=String(idCol?raw[idCol]??"":"").trim(), date=dateCol?parseDate(raw[dateCol]):null, odo=odoCol?parseOdometer(raw[odoCol]):null, flags:string[]=[];
      if(!idCol||!truckCode)flags.push("missing_truck_id"); if(!date)flags.push("invalid_date"); else if(date.getTime()>Date.now()+86400000)flags.push("future_date");
      if(odo===null)flags.push("invalid_odometer"); if(truckCode&&!/^ET\d{3}$/i.test(truckCode.replace(/\s+/g,"")))flags.push("non_canonical_truck_id");
      return {index,raw,truckCode,date,odo,flags,fingerprint:createHash("sha256").update(JSON.stringify(raw)??"{}").digest("hex")};
    });
    const latest=new Map<string,{time:number;odo:number}>();
    for(const item of [...parsed].sort((a,b)=>(a.date?.getTime()??Infinity)-(b.date?.getTime()??Infinity))){if(!item.truckCode||!item.date||item.odo===null)continue;const key=item.truckCode.toUpperCase().replace(/\s+/g,"");const prev=latest.get(key);if(prev&&item.odo<prev.odo)item.flags.push("odometer_decrease");if(!prev||item.date.getTime()>=prev.time)latest.set(key,{time:item.date.getTime(),odo:item.odo});}
    const seen=new Set<string>();
    for(const item of parsed){const start=String(timeCol?item.raw[timeCol]??"":"").trim().toLowerCase(),id=item.truckCode.toUpperCase().replace(/\s+/g,"");const key=`${id}|${item.date?.toISOString().slice(0,10)??"bad-date"}|${item.odo??"bad-odo"}|${start}`;if(seen.has(key))item.flags.push("duplicate_candidate");else seen.add(key);if(!idCol||!dateCol||!odoCol)item.flags.push("required_column_not_detected");}
    const rejectedCount=parsed.filter(r=>r.flags.some(f=>["invalid_date","invalid_odometer","missing_truck_id"].includes(f))).length;
    const flaggedCount=parsed.filter(r=>r.flags.length>0).length;
    const [batch]=await queryRows<{id:string}>("INSERT INTO import_batches(source_name,source_range,row_count,accepted_count,flagged_count,rejected_count,status,initiated_by) VALUES($1,$2,$3,0,$4,$5,'saving_for_review',$6) RETURNING id",[sourceName||"manual-upload",sourceRange||null,rows.length,flaggedCount,rejectedCount,auth.user.email]);
    if(!batch?.id)throw new Error("Database did not return the import batch ID."); batchId=batch.id;
    for(let start=0;start<parsed.length;start+=CHUNK_SIZE){
      const chunk=parsed.slice(start,start+CHUNK_SIZE).map(item=>({source_row_number:Math.max(0,Number.isInteger(body.sourceRowOffset)?Number(body.sourceRowOffset):0)+item.index+2,source_fingerprint:item.fingerprint,raw_source_row:item.raw,mapped_truck_code:item.truckCode||null,observed_at:item.date?.toISOString()??null,odometer_km:item.odo,quality_status:item.flags.some(f=>["invalid_date","invalid_odometer","missing_truck_id"].includes(f))?"rejected":item.flags.length?"review":"good",quality_flags:item.flags,review_status:"pending"}));
      await queryRows("INSERT INTO import_rows(import_batch_id,source_row_number,source_fingerprint,raw_source_row,mapped_truck_code,observed_at,odometer_km,quality_status,quality_flags,review_status) SELECT $1::uuid,(r->>'source_row_number')::integer,r->>'source_fingerprint',r->'raw_source_row',NULLIF(r->>'mapped_truck_code',''),NULLIF(r->>'observed_at','')::timestamptz,NULLIF(r->>'odometer_km','')::numeric,(r->>'quality_status')::data_quality_status,r->'quality_flags',r->>'review_status' FROM jsonb_array_elements($2::jsonb) r",[batchId,JSON.stringify(chunk)]);
    }
    await queryRows("UPDATE import_batches SET finished_at=now(),status='saved_for_review' WHERE id=$1::uuid",[batchId]);
    await queryRows("INSERT INTO audit_log(actor,action,entity_type,entity_id,after_state) VALUES($1,'import_batch_saved_for_review','import_batch',$2::uuid,$3::jsonb)",[auth.user.email,batchId,JSON.stringify({source_name:sourceName,row_count:rows.length,flagged_count:flaggedCount,rejected_count:rejectedCount})]);
    return NextResponse.json({batchId,rowCount:rows.length,flaggedCount,rejectedCount,status:"saved_for_review"},{status:201});
  } catch(error) {
    const message=error instanceof Error?error.message:"Import save failed.";
    if(batchId)try{await queryRows("UPDATE import_batches SET finished_at=now(),status='partial_failure',error_summary=$2 WHERE id=$1::uuid",[batchId,message.slice(0,1000)]);}catch{}
    return NextResponse.json({error:message},{status:500});
  }
}
