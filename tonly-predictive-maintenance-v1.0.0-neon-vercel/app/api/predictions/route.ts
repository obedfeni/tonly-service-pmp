import { NextRequest, NextResponse } from "next/server";
import { authorizePlanner } from "@/lib/auth/session";
import { calculatePreventiveForecast } from "@/lib/forecast-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RECENT = 500;

type SavedPredictionRow = {
  id: string;
  truck_id: string;
  service_rule_id: string;
  generated_at: string;
  forecast_date: string | null;
  remaining_km: number | null;
  days_until_due: number | null;
  method: string;
  model_version: string;
  status: string;
  explanation: unknown;
};

type SavedMLModel = {
  available?: boolean;
  eligibleForSelection?: boolean;
  predictedKmPerDay?: number | null;
  validation?: Record<string, unknown> | null;
};
type SavedMLRun = {
  id: string;
  truck_code: string;
  pm_type: string;
  result: { models?: Record<string, SavedMLModel> };
  input_snapshot: Record<string, unknown>;
  model_version: string;
};

type ActiveServiceRule = {
  id: string;
  rule_code: string;
  target_odometer_km: number | string | null;
  calendar_interval_days: number | string | null;
  kilometre_interval: number | string | null;
  source_reference: string | null;
  verified_by: string | null;
  verified_at: string | null;
};

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}


export async function GET() {
  try {
    const auth = await authorizePlanner();
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const predictionsResult = await auth.db
      .from("predictions")
      .select("id,truck_id,service_rule_id,generated_at,forecast_date,remaining_km,days_until_due,method,model_version,status,explanation")
      .order("generated_at", { ascending: false })
      .limit(MAX_RECENT);
    if (predictionsResult.error) return NextResponse.json({ error: `Could not load saved forecasts: ${predictionsResult.error.message}` }, { status: 500 });
    const predictions = (predictionsResult.data ?? []) as SavedPredictionRow[];

    const truckIds = [...new Set(predictions.map((row: SavedPredictionRow) => row.truck_id).filter(Boolean))];
    const ruleIds = [...new Set(predictions.map((row: SavedPredictionRow) => row.service_rule_id).filter(Boolean))];
    let truckRows: { id: string; truck_code: string }[] = [];
    let ruleRows: { id: string; rule_code: string; service_name: string }[] = [];
    if (truckIds.length) {
      const trucksResult = await auth.db.from("trucks").select("id,truck_code").in("id", truckIds);
      if (trucksResult.error) return NextResponse.json({ error: `Could not resolve forecast trucks: ${trucksResult.error.message}` }, { status: 500 });
      truckRows = (trucksResult.data ?? []) as { id: string; truck_code: string }[];
    }
    if (ruleIds.length) {
      const rulesResult = await auth.db.from("service_rules").select("id,rule_code,service_name").in("id", ruleIds);
      if (rulesResult.error) return NextResponse.json({ error: `Could not resolve forecast rules: ${rulesResult.error.message}` }, { status: 500 });
      ruleRows = (rulesResult.data ?? []) as { id: string; rule_code: string; service_name: string }[];
    }

    const truckCodes = new Map(truckRows.map(row => [row.id, row.truck_code]));
    const ruleCodes = new Map(ruleRows.map(row => [row.id, { code: row.rule_code, name: row.service_name }]));
    const latestByTruckRule = new Map<string, Record<string, unknown>>();
    for (const row of predictions) {
      const key = `${row.truck_id}:${row.service_rule_id}`;
      if (!latestByTruckRule.has(key)) {
        latestByTruckRule.set(key, {
          ...row,
          days_until_due: row.forecast_date ? daysBetween(new Date().toISOString().slice(0, 10), String(row.forecast_date)) : row.days_until_due,
          truck_code: truckCodes.get(row.truck_id) ?? "Unknown truck",
          rule_code: ruleCodes.get(row.service_rule_id)?.code ?? "Unknown rule",
          service_name: ruleCodes.get(row.service_rule_id)?.name ?? "Unknown service",
        });
      }
    }
    return NextResponse.json({ predictions: [...latestByTruckRule.values()] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Saved forecast request failed." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePlanner();
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 64 * 1024) return NextResponse.json({ error: "Forecast request is unexpectedly large." }, { status: 413 });
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) return NextResponse.json({ error: "Forecast request is unexpectedly large." }, { status: 413 });
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw) as Record<string, unknown>; }
    catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }

    const truckCode = String(body.truckCode ?? "").trim().toUpperCase();
    const pmType = String(body.pmType ?? "").trim().toUpperCase();
    const pmMatch = pmType.match(/^PM(\d{1,2})$/);
    const pmSequence = pmMatch ? Number(pmMatch[1]) : NaN;
    if (!/^ET\d{3}$/.test(truckCode)) return NextResponse.json({ error: "Choose a canonical truck ID in ET### format before saving a forecast." }, { status: 400 });
    if (!Number.isInteger(pmSequence) || pmSequence < 1 || pmSequence > 10) return NextResponse.json({ error: "PM type must be PM1 through PM10." }, { status: 400 });

    const thresholdKm = 5000 + (pmSequence - 1) * 10000;
    const latestOdometer = Number(body.latestOdometer);
    const baselineAverageKmPerDay = Number(body.baselineAverageKmPerDay ?? body.averageKmPerDay);
    let averageKmPerDay = baselineAverageKmPerDay;
    const forecastMethod = String(body.forecastMethod ?? "rule_based").trim();
    const modelRunId = String(body.modelRunId ?? "").trim();
    const sourceRowCount = Number(body.sourceRowCount ?? 0);
    let modelRun: SavedMLRun | null = null;
    let selectedModelMetrics: Record<string, unknown> | null = null;
    const intervalsUsed = Number(body.intervalsUsed);
    const serviceOdometer = Number(body.serviceOdometer);
    const calendarIntervalDays = Number(body.calendarIntervalDays);
    const latestDate = body.latestDate;
    const serviceDate = body.serviceDate;
    const ruleSourceReference = String(body.ruleSourceReference ?? "").trim().slice(0, 500);
    const serviceEvidenceReference = String(body.serviceEvidenceReference ?? "").trim().slice(0, 500);
    const approvalConfirmed = body.approvalConfirmed === true;
    const sourceName = String(body.sourceName ?? "Current source preview").trim().slice(0, 180);
    const today = new Date().toISOString().slice(0, 10);

    if (!isDateOnly(latestDate) || latestDate > today) return NextResponse.json({ error: "The latest source-reading date is invalid or in the future." }, { status: 400 });
    if (!isDateOnly(serviceDate) || serviceDate > latestDate) return NextResponse.json({ error: "The verified last-service date must be valid and no later than the latest source-reading date." }, { status: 400 });
    if (!Number.isFinite(latestOdometer) || latestOdometer < 0 || !Number.isFinite(serviceOdometer) || serviceOdometer < 0 || serviceOdometer > latestOdometer) {
      return NextResponse.json({ error: "The current and last-service odometer values are invalid or inconsistent." }, { status: 400 });
    }
    if (!Number.isFinite(baselineAverageKmPerDay) || baselineAverageKmPerDay <= 0 || !Number.isInteger(intervalsUsed) || intervalsUsed < 1) {
      return NextResponse.json({ error: "At least one valid positive-usage interval is required before saving this estimate." }, { status: 400 });
    }
    if (!["rule_based", "random_forest", "xgboost", "hybrid"].includes(forecastMethod)) {
      return NextResponse.json({ error: "Choose Rule-based, Random Forest, XGBoost or Hybrid as the forecast method." }, { status: 400 });
    }
    if (!Number.isInteger(calendarIntervalDays) || calendarIntervalDays < 1 || calendarIntervalDays > 3650) {
      return NextResponse.json({ error: "Enter the approved calendar interval in whole days (1–3,650)." }, { status: 400 });
    }
    if (!ruleSourceReference || !serviceEvidenceReference) {
      return NextResponse.json({ error: "Provide both the approved PM-rule source and evidence for the last completed service." }, { status: 400 });
    }
    if (!approvalConfirmed) return NextResponse.json({ error: "Confirm that the PM rule and service baseline were verified against approved records before saving." }, { status: 400 });

    if (forecastMethod !== "rule_based") {
      if (!modelRunId) return NextResponse.json({ error: "Run the Random Forest/XGBoost comparison before saving an ML-based forecast." }, { status: 400 });
      const modelRunResult = await auth.db.from("ml_model_runs")
        .select("id,truck_code,pm_type,result,input_snapshot,model_version")
        .eq("id", modelRunId).eq("truck_code", truckCode).eq("pm_type", pmType).maybeSingle();
      if (modelRunResult.error) return NextResponse.json({ error: `Could not verify the saved ML model run. Apply db/schema.sql in Neon if the table is missing. ${modelRunResult.error.message}` }, { status: 500 });
      if (!modelRunResult.data) return NextResponse.json({ error: "The selected ML comparison run was not found for this truck and PM type. Run the comparison again." }, { status: 404 });
      const savedRun = modelRunResult.data as SavedMLRun;
      modelRun = savedRun;
      const snapshot = savedRun.input_snapshot ?? {};
      const sameNumber = (a: unknown, b: number) => Number.isFinite(Number(a)) && Math.abs(Number(a) - b) <= 0.1;
      if (snapshot.serviceDate !== serviceDate || snapshot.latestDate !== latestDate ||
          !sameNumber(snapshot.serviceOdometer, serviceOdometer) || !sameNumber(snapshot.latestOdometer, latestOdometer) ||
          !sameNumber(snapshot.thresholdKm, thresholdKm) || !sameNumber(snapshot.calendarIntervalDays, calendarIntervalDays) ||
          (sourceRowCount > 0 && !sameNumber(snapshot.rowCount, sourceRowCount)) ||
          (body.sourceName && String(snapshot.sourceName ?? "") !== String(body.sourceName)) ||
          String(snapshot.requestFingerprint ?? "") !== String(body.requestFingerprint ?? "")) {
        return NextResponse.json({ error: "Forecast inputs have changed since the ML comparison. Run the model comparison again before saving." }, { status: 409 });
      }
      const modelKey = forecastMethod === "random_forest" ? "random_forest" : forecastMethod === "xgboost" ? "xgboost" : "hybrid";
      const selectedModel = savedRun.result?.models?.[modelKey];
      if (!selectedModel || selectedModel.available !== true || selectedModel.eligibleForSelection !== true || !Number.isFinite(Number(selectedModel.predictedKmPerDay)) || Number(selectedModel.predictedKmPerDay) <= 0) {
        return NextResponse.json({ error: `The selected ${forecastMethod} estimate is unavailable for this truck. Use the rule-based estimate or resolve the ML data-quality message.` }, { status: 422 });
      }
      averageKmPerDay = Number(selectedModel.predictedKmPerDay);
      selectedModelMetrics = selectedModel.validation ?? null;
    }

    const activeRulesResult = await auth.db.from("service_rules")
      .select("id,rule_code,target_odometer_km,calendar_interval_days,kilometre_interval,source_reference,verified_by,verified_at")
      .eq("rule_code", pmType).eq("is_active", true).order("effective_from", { ascending: false }).limit(10);
    if (activeRulesResult.error) return NextResponse.json({ error: `Could not validate the active PM rule: ${activeRulesResult.error.message}` }, { status: 500 });
    const activeRules = (activeRulesResult.data ?? []) as ActiveServiceRule[];
    const matchingRule = activeRules.find((rule: ActiveServiceRule) =>
      Number(rule.target_odometer_km) === thresholdKm &&
      Number(rule.calendar_interval_days) === calendarIntervalDays &&
      String(rule.source_reference ?? "").trim() === ruleSourceReference &&
      Boolean(rule.verified_by) && Boolean(rule.verified_at)
    );
    if (activeRules.length && !matchingRule) {
      return NextResponse.json({ error: `An active ${pmType} rule already exists with a different threshold, calendar interval or source reference. Review/deactivate the old rule in Neon before creating a new approved version.` }, { status: 409 });
    }

    // Resolve or create the canonical fleet record. Imported odometer readings are not auto-accepted.
    let { data: truck, error: truckLookupError } = await auth.db.from("trucks").select("id,truck_code").eq("truck_code", truckCode).maybeSingle();
    if (truckLookupError) return NextResponse.json({ error: `Could not look up truck: ${truckLookupError.message}` }, { status: 500 });
    if (!truck) {
      const insertedTruck = await auth.db.from("trucks").insert({ truck_code: truckCode, make: "TONLY", status: "unknown", active: true }).select("id,truck_code").single();
      if (insertedTruck.error || !insertedTruck.data) {
        // Handle a concurrent request that created the same canonical truck.
        const retry = await auth.db.from("trucks").select("id,truck_code").eq("truck_code", truckCode).maybeSingle();
        if (retry.error || !retry.data) return NextResponse.json({ error: `Could not create truck record: ${insertedTruck.error?.message ?? "No row returned"}` }, { status: 500 });
        truck = retry.data;
      } else truck = insertedTruck.data;
    }

    let serviceRule = matchingRule;
    if (!serviceRule) {
      const now = new Date().toISOString();
      const insertedRule = await auth.db.from("service_rules").insert({
        rule_code: pmType,
        service_name: `Preventive maintenance ${pmType}`,
        pm_sequence: pmSequence,
        target_odometer_km: thresholdKm,
        kilometre_interval: pmSequence === 1 ? 5000 : 10000,
        calendar_interval_days: calendarIntervalDays,
        due_logic: "whichever_first",
        effective_from: today,
        source_reference: ruleSourceReference,
        verified_by: auth.user.email ?? auth.user.id,
        verified_at: now,
        is_active: true,
      }).select("id,rule_code,target_odometer_km,calendar_interval_days,kilometre_interval,source_reference,verified_by,verified_at").single();
      if (insertedRule.error || !insertedRule.data) return NextResponse.json({ error: `Could not save the approved PM rule: ${insertedRule.error?.message ?? "No row returned"}` }, { status: 500 });
      serviceRule = insertedRule.data;
    }
    if (!serviceRule) return NextResponse.json({ error: "No active or newly created service rule was returned." }, { status: 500 });

    const now = new Date().toISOString();
    const baseline = await auth.db.from("truck_service_baselines").upsert({
      truck_id: truck.id,
      service_rule_id: serviceRule.id,
      last_service_date: serviceDate,
      last_service_odometer_km: serviceOdometer,
      source_reference: serviceEvidenceReference,
      verified_by: auth.user.email ?? auth.user.id,
      verified_at: now,
      active: true,
      updated_at: now,
    }, { onConflict: "truck_id,service_rule_id" }).select("id").single();
    if (baseline.error || !baseline.data) return NextResponse.json({ error: `PM rule saved, but the service baseline could not be saved: ${baseline.error?.message ?? "No row returned"}. Retry after checking the database.` }, { status: 500 });

    const forecast = calculatePreventiveForecast({
      latestOdometer,
      latestDate,
      averageKmPerDay,
      intervalsUsed,
      serviceDate,
      serviceOdometer,
      calendarIntervalDays,
      pmType,
      today,
    });
    if (forecast.status !== "ready" || !forecast.dueDate || !forecast.trigger) {
      return NextResponse.json({ error: forecast.explanation }, { status: 400 });
    }
    const remainingKm = forecast.remainingKm ?? 0;
    const trigger = forecast.trigger;
    const forecastDate = forecast.dueDate;
    const daysUntilDue = forecast.daysUntilDue ?? 0;
    const explanation = forecast.explanation;
    const inputSnapshot = {
      source_name: sourceName,
      truck_code: truckCode,
      pm_type: pmType,
      target_odometer_km: thresholdKm,
      latest_odometer_km: latestOdometer,
      latest_reading_date: latestDate,
      average_km_per_day: averageKmPerDay,
      baseline_average_km_per_day: baselineAverageKmPerDay,
      forecast_method: forecastMethod,
      ml_model_run_id: modelRun?.id ?? null,
      ml_model_version: modelRun?.model_version ?? null,
      ml_validation_metrics: selectedModelMetrics,
      usage_intervals_used: intervalsUsed,
      last_service_date: serviceDate,
      last_service_odometer_km: serviceOdometer,
      calendar_interval_days: calendarIntervalDays,
      rule_source_reference: ruleSourceReference,
      service_evidence_reference: serviceEvidenceReference,
      trigger,
    };
    const predictionInsert = await auth.db.from("predictions").insert({
      truck_id: truck.id,
      service_rule_id: serviceRule.id,
      forecast_date: forecastDate,
      forecast_odometer_km: thresholdKm,
      remaining_km: remainingKm,
      days_until_due: daysUntilDue,
      method: forecastMethod === "rule_based" ? "usage-baseline" : "ml-usage-forecast",
      model_version: modelRun?.model_version ?? "baseline-v1.0.0",
      status: "provisional",
      confidence_score: null,
      explanation: { text: explanation, trigger, forecast_method: forecastMethod, model_run_id: modelRun?.id ?? null, validation_metrics: selectedModelMetrics },
      input_snapshot: inputSnapshot,
      created_by: auth.user.email ?? auth.user.id,
    }).select("id,generated_at,forecast_date,remaining_km,days_until_due,status,method").single();
    if (predictionInsert.error || !predictionInsert.data) return NextResponse.json({ error: `The service baseline was saved, but the forecast record could not be saved: ${predictionInsert.error?.message ?? "No row returned"}. Check the database before retrying.` }, { status: 500 });

    const auditResult = await auth.db.from("audit_log").insert({
      actor: auth.user.email ?? auth.user.id,
      action: "preventive_maintenance_forecast_saved",
      entity_type: "prediction",
      entity_id: predictionInsert.data.id,
      after_state: { ...inputSnapshot, forecast_date: forecastDate, trigger, status: "provisional" },
    });

    return NextResponse.json({
      prediction: {
        ...predictionInsert.data,
        truck_code: truckCode,
        rule_code: pmType,
        trigger,
        explanation,
      },
      message: `Forecast saved as provisional using ${forecastMethod}. Imported odometer readings were not accepted into operational history.`,
      warning: auditResult.error ? "Forecast saved, but the audit-log entry failed. Check Neon audit_log permissions and logs." : null,
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Forecast save failed." }, { status: 500 });
  }
}
