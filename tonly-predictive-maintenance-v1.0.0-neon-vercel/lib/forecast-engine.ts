export type ForecastStatus =
  | "ready"
  | "needs-data"
  | "needs-service-baseline"
  | "needs-usage"
  | "service-baseline-conflict";

export type ForecastTrigger = "kilometre" | "calendar" | "already-due";

export type PreventiveForecastInput = {
  latestOdometer: number | null;
  latestDate: string | null;
  averageKmPerDay: number | null;
  intervalsUsed: number;
  serviceDate: string;
  serviceOdometer: string | number;
  calendarIntervalDays: string | number;
  pmType: string;
  today?: string;
};

export type PreventiveForecast = {
  status: ForecastStatus;
  dueDate: string | null;
  trigger: ForecastTrigger | null;
  remainingKm: number | null;
  daysToKm: number | null;
  calendarDueDate: string | null;
  daysUntilDue: number | null;
  thresholdKm: number | null;
  explanation: string;
};

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDays(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

function blocked(status: ForecastStatus, explanation: string, thresholdKm: number | null = null): PreventiveForecast {
  return { status, dueDate: null, trigger: null, remainingKm: null, daysToKm: null, calendarDueDate: null, daysUntilDue: null, thresholdKm, explanation };
}

export function calculatePreventiveForecast(input: PreventiveForecastInput): PreventiveForecast {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  if (!isDateOnly(today)) return blocked("needs-data", "The calculation date is invalid.");
  if (input.latestOdometer === null || !Number.isFinite(input.latestOdometer) || input.latestOdometer < 0 || !isDateOnly(input.latestDate) || input.latestDate > today) {
    return blocked("needs-data", "Upload a charging log containing valid dates, canonical truck IDs and odometer readings for this truck.");
  }

  const serviceOdometer = input.serviceOdometer === "" ? NaN : Number(input.serviceOdometer);
  const interval = input.calendarIntervalDays === "" ? NaN : Number(input.calendarIntervalDays);
  if (!isDateOnly(input.serviceDate) || input.serviceDate > today || !Number.isFinite(serviceOdometer) || serviceOdometer < 0 ||
      !Number.isInteger(interval) || interval < 1 || interval > 3650) {
    return blocked("needs-service-baseline", "Enter a valid verified last-service date, last-service odometer and approved calendar interval (1–3,650 days). No interval is assumed.");
  }
  if (serviceOdometer > input.latestOdometer || input.serviceDate > input.latestDate) {
    return blocked("service-baseline-conflict", "The service baseline is inconsistent with the latest charging-log reading: the service odometer exceeds the latest reading or the service date is later than the latest log date. Verify the records before forecasting.");
  }
  if (!Number.isFinite(input.averageKmPerDay) || (input.averageKmPerDay ?? 0) <= 0 || !Number.isInteger(input.intervalsUsed) || input.intervalsUsed < 1) {
    return blocked("needs-usage", "There are not enough valid, increasing odometer readings to estimate recent daily usage. Add more history or verify the readings.");
  }

  const pmMatch = /^PM(\d{1,2})$/.exec(input.pmType);
  const pmSequence = pmMatch ? Number(pmMatch[1]) : NaN;
  if (!Number.isInteger(pmSequence) || pmSequence < 1 || pmSequence > 10) {
    return blocked("needs-service-baseline", "Select a valid PM type from PM1 through PM10.");
  }
  const thresholdKm = 5000 + (pmSequence - 1) * 10000;
  const rawRemaining = thresholdKm - input.latestOdometer;
  const remainingKm = Math.max(0, rawRemaining);
  const daysToKm = Math.max(0, Math.ceil(rawRemaining / input.averageKmPerDay!));
  const calendarDueDate = addDays(input.serviceDate, interval);
  const kmDueDate = addDays(today, daysToKm);

  let dueDate: string;
  let trigger: ForecastTrigger;
  if (rawRemaining <= 0 && calendarDueDate < today) {
    dueDate = calendarDueDate;
    trigger = "calendar";
  } else if (rawRemaining <= 0) {
    dueDate = today;
    trigger = "already-due";
  } else if (calendarDueDate <= kmDueDate) {
    dueDate = calendarDueDate;
    trigger = "calendar";
  } else {
    dueDate = kmDueDate;
    trigger = "kilometre";
  }

  const daysUntilDue = daysBetween(today, dueDate);
  const explanation = trigger === "already-due"
    ? `${input.pmType} threshold (${thresholdKm.toLocaleString()} km) has already been reached or exceeded. Confirm whether the service has been completed before taking action.`
    : trigger === "calendar"
      ? `The approved calendar deadline is earlier than the usage-based estimate. Current estimate: ${input.averageKmPerDay!.toFixed(1)} km/day from ${input.intervalsUsed} recent positive-usage intervals.`
      : `At the estimated ${input.averageKmPerDay!.toFixed(1)} km/day, the ${thresholdKm.toLocaleString()} km threshold is expected in about ${daysToKm} days.`;

  return { status: "ready", dueDate, trigger, remainingKm, daysToKm, calendarDueDate, daysUntilDue, thresholdKm, explanation };
}
