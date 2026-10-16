const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "lib", "forecast-engine.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sandboxModule = { exports: {} };
vm.runInNewContext(compiled, { module: sandboxModule, exports: sandboxModule.exports, process: { env: {} }, URL, Date, Number, Math }, { filename: sourcePath });
const calculate = sandboxModule.exports.calculatePreventiveForecast;
const base = {
  latestOdometer: 24000,
  latestDate: "2026-10-14",
  averageKmPerDay: 100,
  intervalsUsed: 4,
  serviceDate: "2026-09-01",
  serviceOdometer: 23000,
  calendarIntervalDays: 60,
  pmType: "PM3",
  today: "2026-10-15",
};
function expect(condition, message) { if (!condition) throw new Error(message); }

let result = calculate(base);
expect(result.status === "ready" && result.trigger === "kilometre" && result.dueDate === "2026-10-25", "Kilometre-first estimate should be 2026-10-25.");
expect(result.remainingKm === 1000 && result.daysToKm === 10, "Kilometre-first remaining-distance metrics are incorrect.");

result = calculate({ ...base, averageKmPerDay: 50, serviceDate: "2026-10-01", calendarIntervalDays: 10 });
expect(result.status === "ready" && result.trigger === "calendar" && result.dueDate === "2026-10-11" && result.daysUntilDue === -4, "Past calendar deadline should be retained.");

result = calculate({ ...base, latestOdometer: 26000, serviceOdometer: 25000, calendarIntervalDays: 60 });
expect(result.status === "ready" && result.trigger === "already-due" && result.dueDate === "2026-10-15", "Already-reached threshold should be due today when calendar deadline is future.");

result = calculate({ ...base, latestOdometer: 26000, serviceOdometer: 25000, serviceDate: "2026-09-01", calendarIntervalDays: 30 });
expect(result.status === "ready" && result.trigger === "calendar" && result.dueDate === "2026-10-01", "Past calendar deadline should take precedence for an already-reached threshold.");

result = calculate({ ...base, latestOdometer: null });
expect(result.status === "needs-data", "Missing odometer must block a forecast.");
result = calculate({ ...base, serviceDate: "2026-02-31" });
expect(result.status === "needs-service-baseline", "Impossible service date must be rejected.");
result = calculate({ ...base, serviceOdometer: 26000 });
expect(result.status === "service-baseline-conflict", "Service odometer above latest odometer must be rejected.");
result = calculate({ ...base, averageKmPerDay: 0 });
expect(result.status === "needs-usage", "Non-positive usage must block a forecast.");
result = calculate({ ...base, pmType: "PM11" });
expect(result.status === "needs-service-baseline", "PM11 must be rejected.");

console.log("Forecast engine tests passed (9 scenarios). ");
