"""
Initial TONLY usage-forecast pipeline.
This is a baseline feature/validation pipeline, not a failure prediction model.

Expected CSV columns (case-insensitive aliases are handled):
Date, Vehicle number, Kilometers
Optional columns: Start charging time, Total Electricity Consumption (KWH), Remark

Do not train or publish a model until flagged rows have been reviewed and maintenance
service intervals/history have been verified.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import pandas as pd
import numpy as np

ALIASES = {
    "date": ["date", "日期"],
    "truck_id": ["vehicle number", "vehicle", "truck", "truck id", "车辆编号"],
    "odometer_km": ["kilometers", "odometer", "odometer km", "公里数"],
    "start_time": ["start charging time", "start time", "开始充电时间"],
    "energy_kwh": ["total electricity consumption (kwh)", "electricity consumption (kwh)", "kwh", "总耗电（kwh)"],
    "remark": ["remark", "备注"],
}

@dataclass
class QualitySummary:
    total_rows: int
    clean_rows: int
    flagged_rows: int
    rejected_rows: int
    truck_count: int


def canonicalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Map known aliases to stable names, preferring exact matches over substrings."""
    normalized = {
        re.sub(r"\s+", " ", str(column).strip().lower().replace("\n", " ")): column
        for column in df.columns
    }
    rename: dict[object, str] = {}
    already_used: set[object] = set()
    for target, aliases in ALIASES.items():
        keys = [re.sub(r"\s+", " ", alias.strip().lower()) for alias in aliases]
        match = next((normalized[key] for key in keys if key in normalized and normalized[key] not in already_used), None)
        if match is None:
            # Substring fallback supports headers such as "Vehicle number (车辆编号)".
            candidates = sorted(
                ((len(key), original) for key, original in normalized.items()
                 if original not in already_used and any(alias in key for alias in keys)),
                reverse=True,
            )
            if candidates:
                match = candidates[0][1]
        if match is not None:
            rename[match] = target
            already_used.add(match)
    return df.rename(columns=rename)


def load_log(path: str | Path) -> pd.DataFrame:
    path = Path(path)
    # CSV export from Google Sheets is preferred. Excel exports can be read via pandas.read_excel.
    if path.suffix.lower() in {".xlsx", ".xls"}:
        raw = pd.read_excel(path)
    elif path.suffix.lower() == ".txt":
        # The supplied pasted log has a bilingual, multi-line header and padded TSV rows.
        # Parse data rows directly so embedded newlines in the header do not shift columns.
        import re
        rows = []
        for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            if re.match(r"^\s*\d+\s*\t\s*\d{1,2}/\d{1,2}/\d{4}\s*\t\s*ET\d+", line, re.I):
                cells = line.split("\t")
                rows.append({
                    "date": cells[1].strip(),
                    "truck_id": cells[2].strip(),
                    "start_time": cells[3].strip() if len(cells) > 3 else None,
                    "energy_kwh": cells[4].strip() if len(cells) > 4 else None,
                    "person_in_charge": cells[5].strip() if len(cells) > 5 else None,
                    "odometer_km": cells[6].strip() if len(cells) > 6 else None,
                    "remark": cells[7].strip() if len(cells) > 7 else None,
                })
        if not rows:
            raise ValueError("No TSV data rows found. Export the sheet as CSV or check the input layout.")
        raw = pd.DataFrame(rows)
    else:
        raw = pd.read_csv(path, sep=None, engine="python")
    df = canonicalize_columns(raw)
    required = {"date", "truck_id", "odometer_km"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing required columns: {sorted(missing)}")
    df["date"] = pd.to_datetime(df["date"], dayfirst=True, errors="coerce")
    df["truck_id"] = df["truck_id"].astype("string").str.strip().str.upper()
    # Blank cells must remain missing; pandas/numeric conversion must never turn them into 0 km.
    odometer_text = df["odometer_km"].astype("string").str.replace(",", "", regex=False).str.strip()
    df["odometer_km"] = pd.to_numeric(odometer_text.mask(odometer_text == ""), errors="coerce")
    df["quality_flags"] = [[] for _ in range(len(df))]
    df.loc[df["date"].isna(), "quality_flags"] = df.loc[df["date"].isna(), "quality_flags"].apply(lambda x: x + ["invalid_date"])
    df.loc[df["truck_id"].isna() | (df["truck_id"] == ""), "quality_flags"] = df.loc[df["truck_id"].isna() | (df["truck_id"] == ""), "quality_flags"].apply(lambda x: x + ["missing_truck_id"])
    df.loc[df["odometer_km"].isna() | (df["odometer_km"] < 0), "quality_flags"] = df.loc[df["odometer_km"].isna() | (df["odometer_km"] < 0), "quality_flags"].apply(lambda x: x + ["invalid_odometer"])
    suspicious_id = df["truck_id"].notna() & ~df["truck_id"].str.fullmatch(r"ET\d{3}", na=False)
    df.loc[suspicious_id, "quality_flags"] = df.loc[suspicious_id, "quality_flags"].apply(lambda x: x + ["truck_id_format_review"])
    future_date = df["date"].notna() & (df["date"] > (pd.Timestamp.now().normalize() + pd.Timedelta(days=2)))
    df.loc[future_date, "quality_flags"] = df.loc[future_date, "quality_flags"].apply(lambda x: x + ["future_date_review"])
    df["row_fingerprint"] = (
        df["date"].astype("string") + "|" + df["truck_id"].astype("string") + "|" +
        df["odometer_km"].astype("string") + "|" +
        (df["start_time"].astype("string") if "start_time" in df else "")
    )
    duplicate_mask = df.duplicated("row_fingerprint", keep="first")
    df.loc[duplicate_mask, "quality_flags"] = df.loc[duplicate_mask, "quality_flags"].apply(lambda x: x + ["duplicate_candidate"])

    # Flag backwards readings after chronological sorting; do not silently correct them.
    df = df.sort_values(["truck_id", "date", "odometer_km"], na_position="last").reset_index(drop=True)
    prior = df.groupby("truck_id", dropna=False)["odometer_km"].shift(1)
    backward = df["odometer_km"].notna() & prior.notna() & (df["odometer_km"] < prior)
    df.loc[backward, "quality_flags"] = df.loc[backward, "quality_flags"].apply(lambda x: x + ["odometer_decreased"])
    df["quality_status"] = np.where(
        df["quality_flags"].map(len) == 0, "good",
        np.where(df["quality_flags"].map(lambda x: any(f in x for f in ["invalid_date", "missing_truck_id", "invalid_odometer"])), "rejected", "review")
    )
    return df


def build_daily_features(df: pd.DataFrame) -> pd.DataFrame:
    """Create one odometer value per truck/day, keeping source anomalies visible."""
    # Only clean rows contribute to usage features. Review/rejected rows remain in the audit
    # output but cannot contaminate a forecast baseline before a planner resolves them.
    valid = df[df["quality_status"] == "good"].copy()
    valid["day"] = valid["date"].dt.floor("D")
    # Keep the last timestamp's reading per day where a timestamp exists; without a timestamp,
    # daily max is used only as a summary candidate and remains subject to review.
    daily = (valid.sort_values(["truck_id", "date"])
             .groupby(["truck_id", "day"], as_index=False)
             .agg(odometer_km=("odometer_km", "last"), reading_count=("odometer_km", "count"),
                  review_rows=("quality_status", lambda x: int((x != "good").sum()))))
    daily = daily.sort_values(["truck_id", "day"])
    daily["elapsed_days"] = daily.groupby("truck_id")["day"].diff().dt.days
    daily["delta_km"] = daily.groupby("truck_id")["odometer_km"].diff()
    # Gaps and negative deltas are explicitly marked; no fabricated daily mileage is inserted.
    daily["quality_flags"] = [[] for _ in range(len(daily))]
    daily.loc[daily["elapsed_days"].fillna(0) > 3, "quality_flags"] = daily.loc[daily["elapsed_days"].fillna(0) > 3, "quality_flags"].apply(lambda x: x + ["reading_gap_over_3_days"])
    daily.loc[daily["delta_km"] < 0, "quality_flags"] = daily.loc[daily["delta_km"] < 0, "quality_flags"].apply(lambda x: x + ["negative_delta_review"])
    daily.loc[daily["elapsed_days"].fillna(0) == 0, "quality_flags"] = daily.loc[daily["elapsed_days"].fillna(0) == 0, "quality_flags"].apply(lambda x: x + ["no_elapsed_days"])
    daily["km_per_day"] = np.where(
        (daily["elapsed_days"] > 0) & (daily["delta_km"] >= 0),
        daily["delta_km"] / daily["elapsed_days"], np.nan
    )
    daily["km_per_day_7obs"] = daily.groupby("truck_id")["km_per_day"].transform(lambda s: s.rolling(7, min_periods=3).median())
    daily["km_per_day_28obs"] = daily.groupby("truck_id")["km_per_day"].transform(lambda s: s.rolling(28, min_periods=5).median())
    daily["weekday"] = daily["day"].dt.dayofweek
    daily["month"] = daily["day"].dt.month
    return daily


def baseline_forecast(latest_odometer: float, avg_km_per_day: float, next_service_odometer: float,
                      today: pd.Timestamp | None = None) -> dict:
    """Transparent kilometre-threshold estimate; calendar interval is handled with service history."""
    today = (today or pd.Timestamp.now().normalize()).normalize()
    if (not np.isfinite(latest_odometer) or float(latest_odometer) < 0
            or not np.isfinite(next_service_odometer) or float(next_service_odometer) < 0):
        return {"remaining_km": None, "forecast_date": None, "status": "needs_odometer_baseline"}
    remaining = max(0.0, float(next_service_odometer) - float(latest_odometer))
    if not np.isfinite(avg_km_per_day) or avg_km_per_day <= 0:
        return {"remaining_km": remaining, "forecast_date": None, "status": "needs_usage_baseline"}
    days = int(np.ceil(remaining / avg_km_per_day))
    date = today + pd.Timedelta(days=days)
    return {
        "remaining_km": round(remaining, 1),
        "forecast_date": date.date().isoformat(),
        "days_to_km_threshold": days,
        "status": "provisional",
        "method": "usage-baseline",
    }


def summarize_quality(df: pd.DataFrame) -> QualitySummary:
    return QualitySummary(
        total_rows=len(df),
        clean_rows=int((df["quality_status"] == "good").sum()),
        flagged_rows=int((df["quality_status"] == "review").sum()),
        rejected_rows=int((df["quality_status"] == "rejected").sum()),
        truck_count=int(df["truck_id"].dropna().nunique()),
    )


if __name__ == "__main__":
    import argparse, json
    parser = argparse.ArgumentParser()
    parser.add_argument("file", help="CSV or Excel export of the charging log")
    parser.add_argument("--out", default="ml-output")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    raw = load_log(args.file)
    daily = build_daily_features(raw)
    raw.to_json(out / "quality-audit.json", orient="records", date_format="iso", indent=2)
    daily.to_csv(out / "daily-features.csv", index=False)
    print(json.dumps(summarize_quality(raw).__dict__, indent=2))
    print(f"Saved audit and daily features to {out.resolve()}")
