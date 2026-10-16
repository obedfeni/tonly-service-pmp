"""Regression tests for the TONLY charging-log quality pipeline."""
import pandas as pd

from pipeline import load_log, build_daily_features, summarize_quality, baseline_forecast


def test_load_log_flags_bad_rows_without_silent_correction(tmp_path):
    path = tmp_path / "charging.csv"
    pd.DataFrame([
        {"Date": "01/10/2026", "Vehicle number": "ET001", "Kilometers": 1000},
        {"Date": "02/10/2026", "Vehicle number": "ET001", "Kilometers": 900},
        {"Date": "bad-date", "Vehicle number": "ET001", "Kilometers": 1100},
        {"Date": "03/10/2026", "Vehicle number": "ET01", "Kilometers": 1200},
    ]).to_csv(path, index=False)

    result = load_log(path)
    assert len(result) == 4
    assert "odometer_decreased" in result.iloc[1]["quality_flags"] or any(
        "odometer_decreased" in flags for flags in result["quality_flags"]
    )
    assert any("invalid_date" in flags for flags in result["quality_flags"])
    assert any("truck_id_format_review" in flags for flags in result["quality_flags"])
    # Original numeric values are preserved; the lower reading is flagged, not repaired.
    assert 900 in result["odometer_km"].dropna().tolist()


def test_daily_features_do_not_invent_mileage():
    df = pd.DataFrame({
        "truck_id": ["ET001", "ET001", "ET001"],
        "date": pd.to_datetime(["2026-10-01", "2026-10-02", "2026-10-05"]),
        "odometer_km": [1000, 1100, 1400],
        "quality_status": ["good", "good", "good"],
    })
    daily = build_daily_features(df)
    assert daily.loc[1, "delta_km"] == 100
    assert daily.loc[2, "delta_km"] == 300
    assert daily.loc[2, "elapsed_days"] == 3
    assert daily.loc[2, "km_per_day"] == 100


def test_forecast_requires_positive_usage_baseline():
    result = baseline_forecast(1000, 0, 5000, today=pd.Timestamp("2026-10-15"))
    assert result["status"] == "needs_usage_baseline"
    assert result["forecast_date"] is None


def test_quality_summary_counts_statuses():
    df = pd.DataFrame({
        "quality_status": ["good", "review", "rejected", "good"],
        "truck_id": ["ET001", "ET001", "ET002", "ET003"],
    })
    summary = summarize_quality(df)
    assert (summary.total_rows, summary.clean_rows, summary.flagged_rows, summary.rejected_rows) == (4, 2, 1, 1)
    assert summary.truck_count == 3


def test_blank_odometer_is_rejected_not_zero(tmp_path):
    path = tmp_path / "blank-odo.csv"
    pd.DataFrame([
        {"Date": "01/10/2026", "Vehicle number": "ET001", "Kilometers": ""},
        {"Date": "02/10/2026", "Vehicle number": "ET001", "Kilometers": "1,250"},
    ]).to_csv(path, index=False)
    result = load_log(path)
    blank_row = result[result["date"].dt.day == 1].iloc[0]
    assert pd.isna(blank_row["odometer_km"])
    assert "invalid_odometer" in blank_row["quality_flags"]
    assert blank_row["quality_status"] == "rejected"


def test_unreviewed_rows_do_not_contribute_to_usage_features():
    df = pd.DataFrame({
        "truck_id": ["ET001", "ET001", "ET001"],
        "date": pd.to_datetime(["2026-10-01", "2026-10-02", "2026-10-03"]),
        "odometer_km": [1000, 9000, 1200],
        "quality_status": ["good", "review", "good"],
    })
    daily = build_daily_features(df)
    assert daily["odometer_km"].tolist() == [1000, 1200]
    assert daily["delta_km"].tolist()[1] == 200


def test_exact_date_column_wins_over_start_date_column():
    from pipeline import canonicalize_columns
    df = pd.DataFrame({
        "Start charging date": ["01/10/2026"],
        "Date": ["02/10/2026"],
        "Vehicle number": ["ET001"],
        "Kilometers": [1000],
    })
    result = canonicalize_columns(df)
    assert result.loc[0, "date"] == "02/10/2026"



def test_forecast_requires_valid_odometer_baseline():
    result = baseline_forecast(float("nan"), 100, 5000, today=pd.Timestamp("2026-10-15"))
    assert result["status"] == "needs_odometer_baseline"
    assert result["forecast_date"] is None


def test_impossible_calendar_date_is_rejected(tmp_path):
    path = tmp_path / "impossible-date.csv"
    pd.DataFrame([
        {"Date": "31/02/2026", "Vehicle number": "ET001", "Kilometers": 1000},
    ]).to_csv(path, index=False)
    result = load_log(path)
    assert pd.isna(result.loc[0, "date"])
    assert "invalid_date" in result.loc[0, "quality_flags"]
