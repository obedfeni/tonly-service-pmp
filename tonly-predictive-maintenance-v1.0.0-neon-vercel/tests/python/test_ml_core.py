from datetime import date, timedelta

import numpy as np
import pytest
from fastapi import HTTPException

from ml_core import ForecastRequest, _extract_daily, _build_clean_intervals, _parse_date, build_training_data, forecast_payload


def make_rows(trucks: int = 4, days: int = 70):
    rows = []
    start = date(2026, 1, 1)
    for t in range(1, trucks + 1):
        odo = 10000.0 + t * 100
        for i in range(days):
            # Deterministic varying usage for testing only.
            odo += 40 + ((i * (t + 3)) % 75)
            rows.append({"Date": (start + timedelta(days=i)).isoformat(), "Vehicle number": f"ET{t:03d}", "Kilometres": odo})
    return rows


def test_date_parser_rejects_impossible_dates():
    assert _parse_date("31/02/2026") is None
    assert _parse_date("2026-02-28") == date(2026, 2, 28)


def test_daily_extraction_flags_invalid_and_noncanonical_rows():
    rows = [
        {"Date": "2026-01-01", "Vehicle number": "ET001", "Kilometres": 1000},
        {"Date": "2026-01-02", "Vehicle number": "ET001", "Kilometres": ""},
        {"Date": "2026-01-03", "Vehicle number": "ET01", "Kilometres": 1100},
    ]
    daily, quality = _extract_daily(rows, ["Date", "Vehicle number", "Kilometres"], date(2026, 1, 10))
    assert len(daily["ET001"]) == 1
    assert quality["invalidRows"] == 2
    assert quality["nonCanonicalIds"] == 1


def test_training_examples_are_chronologically_ordered():
    rows = make_rows(trucks=4, days=60)
    daily, _ = _extract_daily(rows, ["Date", "Vehicle number", "Kilometres"], date(2026, 4, 1))
    intervals, _, _ = _build_clean_intervals(daily)
    x, y, dates, _ = build_training_data(intervals)
    assert len(y) > 40
    assert x.shape == (len(y), 9)
    assert dates == sorted(dates)
    assert np.all(y >= 0)


def test_forecast_requires_recognizable_columns():
    payload = ForecastRequest(rows=[{"a": 1}], headers=["a", "b", "c"], truckId="ET001", thresholdKm=15000)
    with pytest.raises(HTTPException) as exc:
        forecast_payload(payload, today=date(2026, 4, 1))
    assert exc.value.status_code == 422


def test_forecast_returns_insufficient_data_without_faking_ml():
    rows = make_rows(trucks=1, days=8)
    payload = ForecastRequest(
        rows=rows,
        headers=["Date", "Vehicle number", "Kilometres"],
        truckId="ET001", thresholdKm=15000,
        serviceDate="2026-01-01", serviceOdometer=10100, calendarIntervalDays=90,
        today="2026-01-08",
    )
    result = forecast_payload(payload, today=date(2026, 1, 8))
    assert result["training"]["status"] == "insufficient_data"
    assert result["models"]["random_forest"]["available"] is False
    assert result["models"]["xgboost"]["available"] is False
    assert result["models"]["rule_based"]["available"] is True


def test_models_train_and_report_chronological_validation_metrics():
    rows = make_rows(trucks=5, days=90)
    payload = ForecastRequest(
        rows=rows,
        headers=["Date", "Vehicle number", "Kilometres"],
        truckId="ET001", pmType="PM3", thresholdKm=25000,
        serviceDate="2026-01-01", serviceOdometer=10100, calendarIntervalDays=120,
        today="2026-03-31",
    )
    result = forecast_payload(payload, today=date(2026, 3, 31))
    assert result["training"]["status"] == "trained"
    assert result["training"]["testExamples"] >= 8
    for key in ("random_forest", "xgboost"):
        assert result["models"][key]["available"] is True
        assert result["models"][key]["predictedKmPerDay"] >= 0
        assert result["models"][key]["validation"]["maeKmPerDay"] >= 0
        assert result["models"][key]["validation"]["testExamples"] >= 8
    assert result["models"]["rule_based"]["available"] is True


def test_ml_api_requires_shared_secret(monkeypatch):
    from fastapi.testclient import TestClient
    from ml_core import app

    monkeypatch.setenv("ML_API_SECRET", "test-secret-value")
    client = TestClient(app)
    payload = {
        "rows": make_rows(trucks=1, days=8),
        "headers": ["Date", "Vehicle number", "Kilometres"],
        "truckId": "ET001",
        "pmType": "PM3",
        "thresholdKm": 25000,
        "serviceDate": "2026-01-01",
        "serviceOdometer": 10100,
        "calendarIntervalDays": 90,
        "today": "2026-01-08",
    }
    response = client.post("/forecast", json=payload)
    assert response.status_code == 401
    response = client.post("/forecast", json=payload, headers={"Authorization": "Bearer test-secret-value"})
    assert response.status_code == 200
    assert response.json()["models"]["rule_based"]["available"] is True


def test_latest_implausible_odometer_jump_blocks_forecast():
    rows = make_rows(trucks=1, days=8)
    rows.extend([
        {"Date": "2026-01-09", "Vehicle number": "ET001", "Kilometres": 100000},
        {"Date": "2026-01-10", "Vehicle number": "ET001", "Kilometres": 100100},
    ])
    payload = ForecastRequest(
        rows=rows,
        headers=["Date", "Vehicle number", "Kilometres"],
        truckId="ET001", pmType="PM3", thresholdKm=25000,
        serviceDate="2026-01-01", serviceOdometer=10100, calendarIntervalDays=90,
        today="2026-01-10",
    )
    with pytest.raises(HTTPException) as exc:
        forecast_payload(payload, today=date(2026, 1, 10))
    assert exc.value.status_code == 422
    assert "implausible odometer-usage jump" in str(exc.value.detail)
