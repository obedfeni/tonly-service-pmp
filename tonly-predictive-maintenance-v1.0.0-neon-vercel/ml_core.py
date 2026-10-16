from __future__ import annotations

import hashlib
import heapq
import hmac
import json
import math
import os
import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from statistics import median, mean, pstdev
from typing import Any

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error
from xgboost import XGBRegressor

APP_VERSION = "1.0.0"
MODEL_VERSION = "tonly-usage-rf-xgb-v1.0.0"
FEATURE_NAMES = [
    "rate_current", "rate_lag_1", "rate_lag_2", "rate_median_7",
    "rate_mean_7", "rate_std_7", "elapsed_days", "weekday", "month",
]
MIN_TRAINING_EXAMPLES = 40
MIN_TRAIN_EXAMPLES = 30
MIN_TEST_EXAMPLES = 8
MAX_ROWS = 10000
MAX_COLUMNS = 100

app = FastAPI(
    title="TONLY Predictive Maintenance ML API",
    version=APP_VERSION,
    description="Usage-rate forecasting with Random Forest and XGBoost; approved PM rules remain authoritative.",
)


class ForecastRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rows: list[dict[str, Any]] = Field(min_length=1, max_length=MAX_ROWS)
    headers: list[str] = Field(min_length=3, max_length=MAX_COLUMNS)
    truckId: str = Field(pattern=r"^ET\d{3}$")
    pmType: str | None = Field(default=None, pattern=r"^PM([1-9]|10)$")
    thresholdKm: float = Field(gt=0, le=10_000_000)
    latestOdometer: float | None = Field(default=None, ge=0)
    latestDate: str | None = None
    serviceDate: str | None = None
    serviceOdometer: float | None = Field(default=None, ge=0)
    calendarIntervalDays: int | None = Field(default=None, ge=1, le=3650)
    today: str | None = None
    sourceName: str | None = Field(default=None, max_length=180)


class Observation:
    def __init__(self, truck_id: str, day: date, odometer: float, row_index: int):
        self.truck_id = truck_id
        self.day = day
        self.odometer = odometer
        self.row_index = row_index


def _normalise_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", str(value or "").lower())


def _find_header(headers: list[str], patterns: list[str]) -> str | None:
    normalized = [(header, _normalise_header(header)) for header in headers]
    for pattern in patterns:
        for original, key in normalized:
            if key == pattern:
                return original
    for pattern in patterns:
        for original, key in normalized:
            if pattern and pattern in key:
                return original
    return None


def _parse_date(value: Any) -> date | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        # Excel's 1900 date system; keep range bounded to plausible date serials.
        if 20000 <= float(value) <= 80000:
            return (datetime(1899, 12, 30) + timedelta(days=float(value))).date()
        return None
    raw = str(value).strip()
    if not raw:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(raw[:19], fmt).date()
        except ValueError:
            continue
    try:
        # ISO timestamp fallback only; no locale-ambiguous parsing.
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _parse_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        result = float(value)
    else:
        raw = str(value).strip().replace(",", "")
        if not raw:
            return None
        try:
            result = float(raw)
        except ValueError:
            return None
    return result if math.isfinite(result) and result >= 0 else None


def _extract_daily(rows: list[dict[str, Any]], headers: list[str], today: date) -> tuple[dict[str, list[Observation]], dict[str, int]]:
    truck_col = _find_header(headers, ["vehiclenumber", "truckid", "vehicle", "truck", "车辆编号"])
    date_col = _find_header(headers, ["date", "datetime", "observedat", "timestamp", "日期"])
    odo_col = _find_header(headers, ["odometerkm", "odometer", "kilometres", "kilometers", "kilometre", "kilometer", "mileage", "公里数", "里程"])
    if not truck_col or not date_col or not odo_col:
        raise HTTPException(status_code=422, detail="The source needs recognizable truck ID, date and odometer columns.")

    raw_by_truck: dict[str, list[Observation]] = defaultdict(list)
    stats = {"inputRows": len(rows), "invalidRows": 0, "futureRows": 0, "nonCanonicalIds": 0, "decreasingReadings": 0, "validDailyReadings": 0}
    for index, row in enumerate(rows):
        truck = re.sub(r"\s+", "", str(row.get(truck_col) or "").strip().upper())
        day = _parse_date(row.get(date_col))
        odo = _parse_number(row.get(odo_col))
        if not re.fullmatch(r"ET\d{3}", truck):
            stats["nonCanonicalIds"] += 1
            stats["invalidRows"] += 1
            continue
        if day is None or odo is None:
            stats["invalidRows"] += 1
            continue
        if day > today:
            stats["futureRows"] += 1
            continue
        raw_by_truck[truck].append(Observation(truck, day, odo, index))

    output: dict[str, list[Observation]] = {}
    for truck, source_points in raw_by_truck.items():
        accepted: list[Observation] = []
        for point in sorted(source_points, key=lambda item: (item.day, item.row_index)):
            if accepted and point.odometer < accepted[-1].odometer:
                stats["decreasingReadings"] += 1
                continue
            accepted.append(point)
        # After backwards readings are excluded, keep the last accepted source row per day.
        daily_by_day: dict[date, Observation] = {}
        for point in accepted:
            daily_by_day[point.day] = point
        daily_points = sorted(daily_by_day.values(), key=lambda item: item.day)
        if daily_points:
            output[truck] = daily_points
            stats["validDailyReadings"] += len(daily_points)
    return output, stats


def _robust_rate_upper(history: list[float]) -> float | None:
    positive = [float(rate) for rate in history if math.isfinite(float(rate)) and float(rate) > 0]
    if len(positive) < 5:
        return None
    center = float(median(positive[-14:]))
    deviations = [abs(value - center) for value in positive[-14:]]
    mad = float(median(deviations))
    # A past-only robust threshold. It adapts to each truck and falls back to fleet history.
    return center + max(4.5 * 1.4826 * mad, 2.5 * center, 1.0)


def _build_clean_intervals(points_by_truck: dict[str, list[Observation]]) -> tuple[dict[str, list[dict[str, Any]]], int, dict[str, Observation]]:
    """Create intervals while rejecting implausible odometer jumps using prior history only.

    If a point is flagged as a rate outlier, it is not used as the next odometer anchor. This
    prevents a single bad reading from contaminating all later usage-rate features. The source
    values remain untouched and the count is returned for the UI/audit trail.
    """
    intervals: dict[str, list[dict[str, Any]]] = {truck: [] for truck in points_by_truck}
    accepted_points: dict[str, Observation] = {}
    next_indices: dict[str, int] = {}
    per_truck_rates: dict[str, list[float]] = defaultdict(list)
    fleet_rates: list[float] = []
    queue: list[tuple[date, str, int]] = []
    for truck, points in points_by_truck.items():
        if not points:
            continue
        accepted_points[truck] = points[0]
        next_indices[truck] = 1
        if len(points) > 1:
            heapq.heappush(queue, (points[1].day, truck, 1))

    outlier_count = 0
    while queue:
        _, truck, index = heapq.heappop(queue)
        points = points_by_truck[truck]
        candidate = points[index]
        anchor = accepted_points[truck]
        elapsed = (candidate.day - anchor.day).days
        delta = candidate.odometer - anchor.odometer
        if elapsed <= 0 or delta < 0:
            outlier_count += 1
        elif elapsed > 35:
            # The reading is accepted as a new anchor, but the long gap is not a usage target.
            accepted_points[truck] = candidate
        else:
            rate = float(delta / elapsed)
            truck_upper = _robust_rate_upper(per_truck_rates[truck])
            fleet_upper = _robust_rate_upper(fleet_rates)
            upper = truck_upper if truck_upper is not None else fleet_upper
            if upper is not None and rate > upper:
                outlier_count += 1
                # Leave the anchor unchanged; next reading is checked against this accepted point.
            else:
                intervals[truck].append({
                    "end_date": candidate.day,
                    "rate": rate,
                    "elapsed_days": int(elapsed),
                    "odometer": float(candidate.odometer),
                })
                accepted_points[truck] = candidate
                per_truck_rates[truck].append(rate)
                if rate > 0:
                    fleet_rates.append(rate)
                    if len(fleet_rates) > 500:
                        del fleet_rates[:-500]
                if len(per_truck_rates[truck]) > 100:
                    del per_truck_rates[truck][:-100]
        next_index = index + 1
        if next_index < len(points):
            heapq.heappush(queue, (points[next_index].day, truck, next_index))

    return {truck: values for truck, values in intervals.items() if values}, outlier_count, accepted_points


def _feature_from_history(history: list[dict[str, Any]]) -> list[float] | None:
    if len(history) < 3:
        return None
    rates = [max(0.0, float(item["rate"])) for item in history]
    last7 = rates[-7:]
    latest = history[-1]
    return [
        rates[-1], rates[-2], rates[-3], float(median(last7)), float(mean(last7)),
        float(pstdev(last7)) if len(last7) > 1 else 0.0,
        float(latest["elapsed_days"]), float(latest["end_date"].weekday()), float(latest["end_date"].month),
    ]


def build_training_data(all_intervals: dict[str, list[dict[str, Any]]]) -> tuple[np.ndarray, np.ndarray, list[date], dict[str, list[dict[str, Any]]]]:
    features: list[list[float]] = []
    targets: list[float] = []
    target_dates: list[date] = []
    for intervals in all_intervals.values():
        # At time i, predict the next observed interval's usage rate using history up to i.
        for i in range(2, len(intervals) - 1):
            vector = _feature_from_history(intervals[: i + 1])
            if vector is None:
                continue
            target = float(intervals[i + 1]["rate"])
            if not math.isfinite(target) or target < 0:
                continue
            features.append(vector)
            targets.append(target)
            target_dates.append(intervals[i + 1]["end_date"])
    if not features:
        return np.empty((0, len(FEATURE_NAMES))), np.empty((0,)), [], all_intervals
    order = sorted(range(len(target_dates)), key=lambda idx: target_dates[idx])
    return np.asarray([features[i] for i in order], dtype=float), np.asarray([targets[i] for i in order], dtype=float), [target_dates[i] for i in order], all_intervals


def _calendar_add(start: date, days: int) -> date:
    return start + timedelta(days=days)


def _forecast_from_rate(rate: float | None, latest_odo: float, today: date, threshold: float,
                        service_date: date | None, calendar_days: int | None) -> dict[str, Any]:
    if rate is None or not math.isfinite(rate) or rate < 0:
        return {"predictedKmPerDay": None, "forecastDate": None, "trigger": None, "reason": "Not enough valid history to predict this truck's usage rate."}
    if service_date is None or calendar_days is None:
        return {"predictedKmPerDay": round(rate, 3), "forecastDate": None, "trigger": None, "reason": "Add the verified last-service date and approved calendar interval to calculate a service date."}
    remaining = max(0.0, threshold - latest_odo)
    if latest_odo >= threshold:
        km_date = today
        trigger = "already-due"
    elif rate <= 0:
        km_date = None
        trigger = None
    else:
        km_date = today + timedelta(days=math.ceil((threshold - latest_odo) / rate))
        trigger = "kilometre"
    calendar_date = _calendar_add(service_date, calendar_days)
    if km_date is None or calendar_date <= km_date:
        due = calendar_date
        trigger = "calendar"
    else:
        due = km_date
    return {
        "predictedKmPerDay": round(rate, 3),
        "remainingKm": round(remaining, 1),
        "forecastDate": due.isoformat(),
        "calendarDueDate": calendar_date.isoformat(),
        "trigger": trigger,
        "daysUntilDue": (due - today).days,
        "reason": "Estimated from historical odometer-usage intervals; confirm against the approved PM procedure.",
    }


def _new_models() -> dict[str, Any]:
    return {
        "random_forest": RandomForestRegressor(
            n_estimators=180, max_depth=12, min_samples_leaf=2, max_features=0.9,
            random_state=42, n_jobs=1,
        ),
        "xgboost": XGBRegressor(
            n_estimators=180, max_depth=3, learning_rate=0.04, subsample=0.85,
            colsample_bytree=0.85, reg_lambda=3.0, objective="reg:squarederror",
            random_state=42, n_jobs=1, tree_method="hist", verbosity=0,
        ),
    }


def _evaluate_and_fit(x: np.ndarray, y: np.ndarray, dates: list[date]) -> tuple[dict[str, Any], dict[str, Any], dict[str, int | str]]:
    count = len(y)
    if count < MIN_TRAINING_EXAMPLES:
        return {}, {}, {"status": "insufficient_data", "trainingExamples": count, "trainExamples": 0, "testExamples": 0,
                         "reason": f"At least {MIN_TRAINING_EXAMPLES} historical next-interval examples are required; found {count}."}
    split_index = max(MIN_TRAIN_EXAMPLES, int(count * 0.8))
    split_index = min(split_index, count - MIN_TEST_EXAMPLES)
    cutoff = dates[split_index]
    train_indices = [i for i, d in enumerate(dates) if d < cutoff]
    test_indices = [i for i, d in enumerate(dates) if d >= cutoff]
    if len(train_indices) < MIN_TRAIN_EXAMPLES or len(test_indices) < MIN_TEST_EXAMPLES:
        return {}, {}, {"status": "insufficient_data", "trainingExamples": count, "trainExamples": len(train_indices), "testExamples": len(test_indices),
                         "reason": "Not enough examples on both sides of the chronological validation split."}
    x_train, y_train = x[train_indices], y[train_indices]
    x_test, y_test = x[test_indices], y[test_indices]
    median_baseline = float(median(y_train.tolist()))
    baseline_mae = float(mean_absolute_error(y_test, np.full(len(y_test), median_baseline)))
    fitted: dict[str, Any] = {}
    metrics: dict[str, Any] = {}
    test_predictions: dict[str, np.ndarray] = {}
    for name, model in _new_models().items():
        model.fit(x_train, y_train)
        predicted = np.maximum(0.0, model.predict(x_test))
        test_predictions[name] = predicted
        metrics[name] = {
            "maeKmPerDay": round(float(mean_absolute_error(y_test, predicted)), 4),
            "baselineMaeKmPerDay": round(baseline_mae, 4),
            "testExamples": len(test_indices),
            "beatsMedianBaseline": bool(mean_absolute_error(y_test, predicted) < baseline_mae),
        }
        final_model = _new_models()[name]
        final_model.fit(x, y)
        fitted[name] = final_model
    if "random_forest" in test_predictions and "xgboost" in test_predictions:
        hybrid_test = np.median(np.column_stack([np.full(len(y_test), median_baseline), test_predictions["random_forest"], test_predictions["xgboost"]]), axis=1)
        hybrid_mae = float(mean_absolute_error(y_test, hybrid_test))
        metrics["hybrid"] = {
            "maeKmPerDay": round(hybrid_mae, 4),
            "baselineMaeKmPerDay": round(baseline_mae, 4),
            "testExamples": len(test_indices),
            "beatsMedianBaseline": bool(hybrid_mae < baseline_mae),
        }
    info = {
        "status": "trained",
        "trainingExamples": count,
        "trainExamples": len(train_indices),
        "testExamples": len(test_indices),
        "validationStartDate": cutoff.isoformat(),
        "validationMethod": "chronological holdout; future target intervals are held out",
        "medianBaselineMaeKmPerDay": round(baseline_mae, 4),
    }
    return fitted, metrics, info


def forecast_payload(payload: ForecastRequest, today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    if payload.today:
        try:
            today = date.fromisoformat(payload.today)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="today must be an ISO date (YYYY-MM-DD).") from exc
    if payload.serviceDate:
        try:
            service_date = date.fromisoformat(payload.serviceDate)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="serviceDate must be an ISO date (YYYY-MM-DD).") from exc
        if service_date > today:
            raise HTTPException(status_code=422, detail="serviceDate cannot be in the future.")
    else:
        service_date = None
    if payload.calendarIntervalDays is not None and service_date is None:
        raise HTTPException(status_code=422, detail="Provide serviceDate when calendarIntervalDays is supplied.")
    if payload.serviceOdometer is not None and payload.serviceOdometer < 0:
        raise HTTPException(status_code=422, detail="serviceOdometer cannot be negative.")

    all_points, data_quality = _extract_daily(payload.rows, payload.headers, today)
    if payload.truckId not in all_points or len(all_points[payload.truckId]) < 2:
        raise HTTPException(status_code=422, detail=f"No usable dated odometer history was found for {payload.truckId}.")
    all_intervals, usage_rate_outliers, accepted_anchors = _build_clean_intervals(all_points)
    data_quality["usageRateOutliers"] = usage_rate_outliers
    target_points = all_points[payload.truckId]
    target_intervals = all_intervals.get(payload.truckId, [])
    latest_source_point = target_points[-1]
    latest = accepted_anchors.get(payload.truckId, target_points[0])
    if latest_source_point.day > latest.day:
        raise HTTPException(status_code=422, detail="The latest source reading is an implausible odometer-usage jump relative to the prior accepted history. Review the truck's source records before forecasting.")
    latest_odo = latest.odometer
    latest_date = latest.day.isoformat()
    if payload.latestOdometer is not None and abs(float(payload.latestOdometer) - latest_odo) > 0.1:
        raise HTTPException(status_code=422, detail="The supplied latest odometer does not match the source rows. Refresh the source preview and retry.")
    if payload.latestDate and payload.latestDate != latest_date:
        raise HTTPException(status_code=422, detail="The supplied latest reading date does not match the source rows. Refresh the source preview and retry.")
    if payload.pmType:
        match = re.fullmatch(r"PM(\d{1,2})", payload.pmType)
        sequence = int(match.group(1)) if match else 0
        expected_threshold = 5000 + (sequence - 1) * 10000
        if sequence < 1 or sequence > 10 or abs(expected_threshold - payload.thresholdKm) > 0.1:
            raise HTTPException(status_code=422, detail="PM type and kilometre threshold do not match the approved PM sequence.")
    baseline_rates = [float(item["rate"]) for item in target_intervals if float(item["rate"]) > 0][-14:]
    baseline_rate = float(median(baseline_rates)) if baseline_rates else None

    x, y, target_dates, _ = build_training_data(all_intervals)
    models, metrics, training = _evaluate_and_fit(x, y, target_dates)
    current_features = _feature_from_history(target_intervals)
    forecasts: dict[str, Any] = {
        "rule_based": {
            **_forecast_from_rate(baseline_rate, latest_odo, today, payload.thresholdKm, service_date, payload.calendarIntervalDays),
            "available": baseline_rate is not None,
            "eligibleForSelection": baseline_rate is not None,
            "validation": {"maeKmPerDay": None, "baselineMaeKmPerDay": None, "testExamples": 0, "beatsMedianBaseline": True},
        }
    }
    for name in ("random_forest", "xgboost"):
        if name not in models or current_features is None:
            reason = training.get("reason", "This truck needs at least three valid odometer intervals before an ML usage estimate can be produced.")
            forecasts[name] = {"available": False, "predictedKmPerDay": None, "forecastDate": None, "trigger": None,
                               "reason": reason, "validation": metrics.get(name, {"maeKmPerDay": None, "baselineMaeKmPerDay": None, "testExamples": 0})}
            continue
        predicted_rate = max(0.0, float(models[name].predict(np.asarray([current_features], dtype=float))[0]))
        forecasts[name] = {
            **_forecast_from_rate(predicted_rate, latest_odo, today, payload.thresholdKm, service_date, payload.calendarIntervalDays),
            "available": True,
            "eligibleForSelection": bool(metrics[name].get("beatsMedianBaseline", False)),
            "validation": metrics[name],
        }
    usable_rates = [forecasts[key]["predictedKmPerDay"] for key in ("rule_based", "random_forest", "xgboost")
                    if forecasts[key].get("available") and forecasts[key].get("predictedKmPerDay") is not None]
    hybrid_rate = float(median(usable_rates)) if usable_rates else None
    forecasts["hybrid"] = {
        **_forecast_from_rate(hybrid_rate, latest_odo, today, payload.thresholdKm, service_date, payload.calendarIntervalDays),
        "available": hybrid_rate is not None and len(usable_rates) >= 2,
        "eligibleForSelection": bool(len(usable_rates) >= 2 and metrics.get("hybrid", {}).get("beatsMedianBaseline", False)),
        "validation": metrics.get("hybrid", {"maeKmPerDay": None, "baselineMaeKmPerDay": None, "testExamples": 0, "beatsMedianBaseline": False}),
        "reason": (None if len(usable_rates) >= 2 else "Hybrid needs at least two available estimates.") if metrics.get("hybrid", {}).get("beatsMedianBaseline", False) else "Hybrid did not outperform the median-rate baseline on the chronological holdout.",
    }
    return {
        "status": "ready" if forecasts["rule_based"].get("available") else "needs_usage_history",
        "modelVersion": MODEL_VERSION,
        "truckId": payload.truckId,
        "thresholdKm": payload.thresholdKm,
        "latestOdometer": round(latest_odo, 1),
        "latestDate": latest_date,
        "serviceDate": service_date.isoformat() if service_date else None,
        "serviceOdometer": payload.serviceOdometer,
        "calendarIntervalDays": payload.calendarIntervalDays,
        "dataQuality": data_quality,
        "training": training,
        "models": forecasts,
        "notes": [
            "Random Forest and XGBoost estimate future odometer usage, not component failures.",
            "Validation uses a chronological holdout and reports MAE in km/day; results must be compared with the median baseline.",
            "Approved PM kilometre and calendar rules remain authoritative. Forecasts are provisional.",
        ],
    }


def require_service_secret(authorization: str | None = Header(default=None)) -> None:
    expected = os.environ.get("ML_API_SECRET", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="ML_API_SECRET is not configured on the ML service.")
    supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Invalid ML service credentials.")


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "service": "tonly-predictive-maintenance-ml",
        "version": APP_VERSION,
        "status": "ok",
        "models": ["RandomForestRegressor", "XGBRegressor"],
        "secretConfigured": bool(os.environ.get("ML_API_SECRET", "").strip()),
    }


@app.post("/forecast", dependencies=[Depends(require_service_secret)])
def forecast(payload: ForecastRequest) -> dict[str, Any]:
    try:
        result = forecast_payload(payload)
        canonical = json.dumps({"headers": payload.headers, "rows": payload.rows, "truckId": payload.truckId, "pmType": payload.pmType, "thresholdKm": payload.thresholdKm}, sort_keys=True, separators=(",", ":"), default=str)
        result["requestFingerprint"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return result
    except HTTPException:
        raise
    except Exception as exc:  # Return safe error text; detailed trace stays in service logs.
        raise HTTPException(status_code=500, detail=f"ML forecast failed: {type(exc).__name__}. Check the ML service logs.") from exc
