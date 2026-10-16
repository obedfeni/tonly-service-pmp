export type FleetTruck = {
  id: string;
  latestOdometer: number;
  lastReadingDate: string;
  lastServiceOdometer: number | null;
  lastServiceDate: string | null;
  averageKmPerDay: number;
  dataQuality: "Good" | "Review" | "Missing";
  status: "Available" | "Operating" | "Workshop" | "Unknown";
};

export type ServiceRule = {
  kilometreInterval: number;
  kilometreThreshold?: number;
  calendarIntervalDays: number;
  ruleLabel?: string;
};

export type Prediction = {
  forecastDate: string | null;
  earliestDate: string | null;
  latestDate: string | null;
  remainingKm: number | null;
  overdueKm: number | null;
  daysUntilDue: number | null;
  priority: "High" | "Medium" | "Low" | "Unknown";
  explanation: string;
  method: "usage-baseline" | "insufficient-data";
  status: "provisional" | "needs-baseline";
};

function addDays(dateString: string, days: number) {
  const d = new Date(`${dateString}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetween(from: string, to: string) {
  return Math.round((new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 86400000);
}

export function buildPrediction(truck: FleetTruck, rule: ServiceRule, today = new Date().toISOString().slice(0, 10)): Prediction {
  const validServiceDate = typeof truck.lastServiceDate === "string" && Number.isFinite(new Date(`${truck.lastServiceDate}T12:00:00`).getTime());
  const validToday = Number.isFinite(new Date(`${today}T12:00:00`).getTime());
  const validOdometers = Number.isFinite(truck.lastServiceOdometer) && truck.lastServiceOdometer! >= 0
    && Number.isFinite(truck.latestOdometer) && truck.latestOdometer >= 0;
  const validUsage = Number.isFinite(truck.averageKmPerDay) && truck.averageKmPerDay > 0;
  const validRule = Number.isFinite(rule.calendarIntervalDays) && rule.calendarIntervalDays > 0
    && Number.isFinite(rule.kilometreInterval) && rule.kilometreInterval > 0
    && (rule.kilometreThreshold === undefined || (Number.isFinite(rule.kilometreThreshold) && rule.kilometreThreshold > 0));
  if (!validServiceDate || !validToday || !validOdometers || !validUsage || !validRule) {
    return {
      forecastDate: null, earliestDate: null, latestDate: null, remainingKm: null, overdueKm: null,
      daysUntilDue: null, priority: "Unknown",
      explanation: "A verified last-service date and odometer are required to apply the kilometre-and-time rule.",
      method: "insufficient-data", status: "needs-baseline"
    };
  }

  // PM thresholds are absolute odometer milestones: PM1=5,000 km, PM2=15,000 km, etc.
  // When no explicit PM type is selected, fall back to last service odometer + interval.
  const nextKmThreshold = rule.kilometreThreshold ?? (truck.lastServiceOdometer! + rule.kilometreInterval);
  const rawRemainingKm = nextKmThreshold - truck.latestOdometer;
  const remainingKm = Math.max(0, rawRemainingKm);
  const overdueKm = Math.max(0, -rawRemainingKm);
  const daysToKm = Math.max(0, Math.ceil(rawRemainingKm / truck.averageKmPerDay));
  const nextCalendarDue = addDays(truck.lastServiceDate!, rule.calendarIntervalDays);
  const daysToCalendar = daysBetween(today, nextCalendarDue);
  const dueInDays = Math.min(daysToKm, daysToCalendar);
  const forecastDate = addDays(today, dueInDays);
  const priority: Prediction["priority"] = dueInDays <= 7 ? "High" : dueInDays <= 30 ? "Medium" : "Low";
  const reason = overdueKm > 0
    ? `The selected ${rule.ruleLabel ?? "PM"} odometer threshold has already been exceeded by ${Math.round(overdueKm)} km. Review the service record and maintenance status.`
    : daysToKm <= daysToCalendar
      ? `Kilometre interval is expected to be reached first, in about ${daysToKm} days at ${Math.round(truck.averageKmPerDay)} km/day.`
      : `Calendar interval arrives first on ${nextCalendarDue}; time-based service takes precedence in this estimate.`;

  return {
    forecastDate,
    earliestDate: addDays(forecastDate, -3),
    latestDate: addDays(forecastDate, 5),
    remainingKm,
    overdueKm,
    daysUntilDue: dueInDays,
    priority,
    explanation: reason,
    method: "usage-baseline",
    status: "provisional"
  };
}
