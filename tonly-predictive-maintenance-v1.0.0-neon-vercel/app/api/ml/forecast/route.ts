import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizePlanner } from "@/lib/auth/session";
import { queryRows } from "@/lib/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 10000;
const MAX_COLUMNS = 100;
function isoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y,m,d]=value.split("-").map(Number); const date=new Date(Date.UTC(y,m-1,d));
  return date.getUTCFullYear()===y && date.getUTCMonth()===m-1 && date.getUTCDate()===d;
}
export async function POST(request: NextRequest) {
  const auth = await authorizePlanner(); if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const secret = process.env.ML_API_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "ML_API_SECRET is missing. Configure it in Vercel Environment Variables." }, { status: 503 });
  try {
    const raw=await request.text(); if(Buffer.byteLength(raw,"utf8")>MAX_BODY_BYTES)return NextResponse.json({error:"The model request is too large. Reduce the import to fewer rows."},{status:413});
    let body:Record<string,unknown>; try{body=JSON.parse(raw) as Record<string,unknown>;}catch{return NextResponse.json({error:"Request body must be valid JSON."},{status:400});}
    const rows=body.rows, headers=body.headers, truckCode=String(body.truckId??"").trim().toUpperCase(), pmType=String(body.pmType??"").trim().toUpperCase();
    const pmMatch=/^PM(\d{1,2})$/.exec(pmType), sequence=pmMatch?Number(pmMatch[1]):NaN, thresholdKm=Number(body.thresholdKm);
    const serviceDate=String(body.serviceDate??""), serviceOdometer=Number(body.serviceOdometer), calendarIntervalDays=Number(body.calendarIntervalDays), latestOdometer=Number(body.latestOdometer), latestDate=String(body.latestDate??""), sourceName=String(body.sourceName??"current import preview").trim().slice(0,180);
    if(!Array.isArray(headers)||headers.length<3||headers.length>MAX_COLUMNS||headers.some(h=>typeof h!=="string"||!h.trim()))return NextResponse.json({error:`Provide 3–${MAX_COLUMNS} non-empty column headers.`},{status:400});
    if(!Array.isArray(rows)||rows.length<1||rows.length>MAX_ROWS||rows.some(row=>!row||typeof row!=="object"||Array.isArray(row)))return NextResponse.json({error:`Provide 1–${MAX_ROWS} source rows.`},{status:400});
    if(!/^ET\d{3}$/.test(truckCode)||!Number.isInteger(sequence)||sequence<1||sequence>10||thresholdKm!==5000+(sequence-1)*10000)return NextResponse.json({error:"Choose a canonical truck ID and a valid PM1–PM10 kilometre threshold."},{status:400});
    if(!isoDate(serviceDate)||!isoDate(latestDate)||!Number.isFinite(serviceOdometer)||serviceOdometer<0||!Number.isInteger(calendarIntervalDays)||calendarIntervalDays<1||calendarIntervalDays>3650)return NextResponse.json({error:"Enter a valid verified service date, service odometer and approved calendar interval."},{status:400});
    if(!Number.isFinite(latestOdometer)||latestOdometer<serviceOdometer||serviceDate>latestDate)return NextResponse.json({error:"The latest reading and last-service baseline are inconsistent."},{status:400});
    const computeUrl=new URL("/api/ml_compute",request.url);
    const computeResponse=await fetch(computeUrl,{method:"POST",headers:{"Content-Type":"application/json","x-ml-secret":secret},body:JSON.stringify({rows,headers,truckId:truckCode,pmType,thresholdKm,serviceDate,serviceOdometer,calendarIntervalDays,latestOdometer,latestDate,sourceName,today:new Date().toISOString().slice(0,10)}),cache:"no-store",signal:AbortSignal.timeout(50000)});
    const result=await computeResponse.json().catch(()=>({})) as Record<string,unknown>;
    if(!computeResponse.ok){const message=typeof result.error==="string"?result.error:`Model compute returned HTTP ${computeResponse.status}.`;return NextResponse.json({error:message},{status:computeResponse.status>=500?502:computeResponse.status});}
    const [truck]=await queryRows<{id:string}>("INSERT INTO trucks(truck_code,make,status,active) VALUES($1,'TONLY','unknown',true) ON CONFLICT(truck_code) DO UPDATE SET updated_at=now() RETURNING id",[truckCode]);
    if(!truck?.id)throw new Error("Could not resolve the canonical truck record.");
    const training=(result.training??{}) as Record<string,unknown>;
    const snapshot={truckCode,pmType,thresholdKm,latestOdometer:Number(result.latestOdometer),latestDate:String(result.latestDate??""),serviceDate,serviceOdometer,calendarIntervalDays,sourceName,rowCount:rows.length,headers,requestFingerprint:String(result.requestFingerprint??createHash("sha256").update(`${truckCode}|${pmType}|${rows.length}|${latestDate}|${latestOdometer}`).digest("hex"))};
    const [run]=await queryRows<{id:string;created_at:string}>("INSERT INTO ml_model_runs(truck_id,truck_code,pm_type,source_name,model_version,status,training_examples,validation_metrics,result,input_snapshot,created_by) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11) RETURNING id,created_at",[truck.id,truckCode,pmType,sourceName,String(result.modelVersion??"tonly-usage-rf-xgb-v1.0.0"),String(result.status??"unknown"),Number(training.trainingExamples??0),JSON.stringify({training,models:result.models??{}}),JSON.stringify(result),JSON.stringify(snapshot),auth.user.email]);
    if(!run?.id)throw new Error("Model run completed but the database did not return a model-run ID.");
    return NextResponse.json({...result,modelRunId:run.id,modelRunCreatedAt:run.created_at},{headers:{"Cache-Control":"no-store"}});
  }catch(error){const message=error instanceof Error?error.message:"ML comparison failed.";return NextResponse.json({error:message},{status:/timeout|aborted/i.test(message)?504:500});}
}
