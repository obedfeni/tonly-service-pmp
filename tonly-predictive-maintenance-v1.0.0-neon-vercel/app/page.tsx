"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight,
  CalendarDays, ChevronDown, CircleHelp, Clock3, Download,
  Gauge, HardDrive, LayoutDashboard, Menu, Search, Settings2, ShieldCheck,
  Truck, Wrench, Zap, Languages, Database, BrainCircuit,
  FileText, MoreHorizontal, RefreshCw, CircleDot, ChevronRight
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";
import * as XLSX from "xlsx";
import { buildPrediction, type FleetTruck, type Prediction, type ServiceRule } from "@/lib/prediction";
import { calculatePreventiveForecast } from "@/lib/forecast-engine";

type Lang = "en" | "zh";
type PageKey = "overview" | "fleet" | "predictions" | "calendar" | "workorders" | "analytics" | "data" | "reports";
type EnrichedTruck = {
  id: string;
  latestOdometer: number | null;
  lastReadingDate: string | null;
  lastServiceOdometer: number | null;
  lastServiceDate: string | null;
  averageKmPerDay: number | null;
  dataQuality: "Review" | "Missing";
  status: "Unknown";
  prediction: Prediction;
};

const copy = {
  en: {
    overview: "Overview", fleet: "Fleet & assets", predictions: "Predictive intelligence",
    calendar: "Maintenance calendar", workorders: "Work orders", analytics: "Model performance",
    data: "Data quality", reports: "Reports & settings", fleetOps: "FLEET OPERATIONS",
    intelligence: "INTELLIGENCE", system: "SYSTEM", title: "Fleet overview",
    subtitle: "Maintenance intelligence for your electric mining fleet.",
    demo: "NO SOURCE DATA LOADED", refresh: "Refresh data",
    export: "Export view", fleetStatus: "Fleet status", dueSoon: "Due within 30 days",
    overdue: "Overdue / review", dataQuality: "Data quality flags", utilization: "Fleet utilization trend",
    utilizationSub: "Daily average distance recorded across the fleet",
    maintenanceOutlook: "Maintenance outlook", next30: "Next 30 days",
    priorityQueue: "Priority queue", viewAll: "View all", unit: "km",
    truck: "Truck", latestOdo: "Latest odometer", nextService: "Next service forecast",
    remaining: "Remaining", priority: "Priority", dataStatus: "Data status",
    alerts: "Attention required", alertSub: "Items to review before relying on forecasts",
    modelStatus: "Prediction engine", baseline: "Usage baseline active",
    baselineSub: "Forecasts are provisional until service rules and history are verified.",
    fleetSize: "Fleet size", active: "Available for planning", unavailable: "Status needs confirmation",
    days: "days", search: "Search truck, work order…", updated: "Last data sync",
    source: "Source", sourceValue: "Google Sheets · server-side connection",
    confidence: "Forecast confidence", provisional: "Provisional", good: "Validated",
    allTrucks: "All trucks", due: "Forecast due", risk: "Needs review", unknown: "Needs data",
    schedule: "Schedule maintenance", dueDate: "Forecast date", dateBasis: "Date basis",
    kmRule: "Kilometre interval", timeRule: "Calendar interval", both: "Whichever comes first",
    selectTruck: "Select a truck", configure: "Configure service rules",
    note: "Only records you upload or retrieve from your source are shown. Forecasts remain provisional until service history and approved rules are verified."
  },
  zh: {
    overview: "总览", fleet: "车队与资产", predictions: "预测智能", calendar: "维护日历",
    workorders: "工单", analytics: "模型表现", data: "数据质量", reports: "报告与设置",
    fleetOps: "车队运营", intelligence: "智能分析", system: "系统", title: "车队总览",
    subtitle: "电动矿用卡车维护智能管理。", demo: "尚未加载源数据",
    refresh: "刷新数据", export: "导出视图", fleetStatus: "车队状态", dueSoon: "未来30天到期",
    overdue: "逾期 / 待审核", dataQuality: "数据质量标记", utilization: "车队利用趋势",
    utilizationSub: "全车队每日平均记录里程", maintenanceOutlook: "维护展望", next30: "未来30天",
    priorityQueue: "优先处理列表", viewAll: "查看全部", unit: "公里", truck: "车辆",
    latestOdo: "最新里程表", nextService: "下次维护预测", remaining: "剩余里程",
    priority: "优先级", dataStatus: "数据状态", alerts: "需要关注", alertSub: "使用预测前需要审核的项目",
    modelStatus: "预测引擎", baseline: "里程基线模型已启用",
    baselineSub: "核实维护规则与历史记录前，预测结果均为暂定。",
    fleetSize: "车队规模", active: "可纳入计划", unavailable: "状态待确认",
    days: "天", search: "搜索车辆、工单…", updated: "上次同步",
    source: "数据源", sourceValue: "Google Sheets · 服务器端连接",
    confidence: "预测可信度", provisional: "暂定", good: "已验证",
    allTrucks: "全部车辆", due: "预测到期", risk: "需要审核", unknown: "需要数据",
    schedule: "安排维护", dueDate: "预测日期", dateBasis: "日期依据",
    kmRule: "里程间隔", timeRule: "日历间隔", both: "以先到者为准",
    selectTruck: "选择车辆", configure: "配置维护规则",
    note: "仅显示您上传或从数据源读取的记录。核实维护历史和批准规则之前，预测均为暂定结果。"
  }
} as const;

const nav: { key: PageKey; icon: typeof LayoutDashboard; group: "fleetOps" | "intelligence" | "system" }[] = [
  { key: "overview", icon: LayoutDashboard, group: "fleetOps" },
  { key: "fleet", icon: Truck, group: "fleetOps" },
  { key: "predictions", icon: BrainCircuit, group: "intelligence" },
  { key: "calendar", icon: CalendarDays, group: "intelligence" },
  { key: "workorders", icon: Wrench, group: "intelligence" },
  { key: "analytics", icon: Activity, group: "intelligence" },
  { key: "data", icon: Database, group: "system" },
  { key: "reports", icon: FileText, group: "system" },
];

const PM_TYPES = Array.from({ length: 10 }, (_, i) => ({
  code: `PM${i + 1}`,
  thresholdKm: 5000 + i * 10000,
}));
const ruleFor = (pmType: string): ServiceRule => ({
  kilometreInterval: 10000,
  kilometreThreshold: PM_TYPES.find(pm => pm.code === pmType)?.thresholdKm,
  // Zero deliberately blocks fleet-level forecasts until an approved calendar rule is configured.
  calendarIntervalDays: 0,
  ruleLabel: "Unconfigured — verified service baseline required",
});

type ImportAudit = {
  rowCount: number;
  truckIdCount: number;
  missingTruckId: number;
  invalidDate: number;
  invalidOdometer: number;
  duplicateCandidates: number;
  futureDates: number;
  nonCanonicalIds: number;
  decreasingOdometer: number;
};

function parseAuditDate(value: unknown): number {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : NaN;
  if (typeof value === "number" && value > 20000 && value < 80000) {
    const time = Date.UTC(1899, 11, 30) + value * 86400000;
    return Number.isFinite(time) ? time : NaN;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return NaN;
  const dmy = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (dmy) {
    const day = Number(dmy[1]), month = Number(dmy[2]), year = Number(dmy[3]);
    const time = Date.UTC(year, month - 1, day);
    const check = new Date(time);
    return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? time : NaN;
  }
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (iso) {
    const year = Number(iso[1]), month = Number(iso[2]), day = Number(iso[3]);
    const time = Date.UTC(year, month - 1, day);
    const check = new Date(time);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return NaN;
  }
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : NaN;
}

function auditImportRows(rows: Record<string, unknown>[], headers: string[]): ImportAudit {
  const findColumn = (pattern: RegExp) => headers.find(h => pattern.test(h));
  const idCol = findColumn(/vehicle number|vehicle|truck.?id|truck|车辆编号/i);
  const dateCol = findColumn(/^date(?:\s*\(.*\))?$|date.?time|observed.?at|日期/i);
  const odoCol = findColumn(/kilomet|odometer|公里数|里程/i);
  const timeCol = findColumn(/start.?charging.?time|start time|开始充电时间/i);
  const seen = new Set<string>();
  const latestByTruck = new Map<string, { date: number; odo: number }>();
  let missingTruckId = 0, invalidDate = 0, invalidOdometer = 0, duplicateCandidates = 0;
  let futureDates = 0, nonCanonicalIds = 0, decreasingOdometer = 0;
  const ids = new Set<string>();
  const now = Date.now() + 86400000;
  const parsed = rows.map(row => {
    const rawId = String(idCol ? row[idCol] ?? "" : "").trim().toUpperCase();
    const id = rawId.replace(/\s+/g, "");
    const date = parseAuditDate(dateCol ? row[dateCol] : undefined);
    const rawOdo = odoCol ? row[odoCol] : undefined;
    const odoText = String(rawOdo ?? "").replace(/,/g, "").trim();
    const odo = odoText === "" ? NaN : (typeof rawOdo === "number" ? rawOdo : Number(odoText));
    if (!id) missingTruckId++;
    else {
      ids.add(rawId);
      if (!/^ET\d{3}$/.test(id)) nonCanonicalIds++;
    }
    if (!Number.isFinite(date)) invalidDate++;
    else if (date > now) futureDates++;
    if (!Number.isFinite(odo) || odo < 0) invalidOdometer++;
    const startTime = String(timeCol ? row[timeCol] ?? "" : "").trim().toLowerCase();
    const fingerprint = `${id}|${Number.isFinite(date) ? Math.floor(date / 86400000) : "bad"}|${Number.isFinite(odo) ? odo : "bad"}|${startTime}`;
    if (seen.has(fingerprint)) duplicateCandidates++;
    seen.add(fingerprint);
    return { id, date, odo };
  }).sort((a,b) => a.id.localeCompare(b.id) || a.date - b.date);
  for (const row of parsed) {
    if (!row.id || !Number.isFinite(row.date) || !Number.isFinite(row.odo)) continue;
    const previous = latestByTruck.get(row.id);
    if (previous && row.date > previous.date && row.odo < previous.odo) decreasingOdometer++;
    if (!previous || row.date >= previous.date) latestByTruck.set(row.id, { date: row.date, odo: row.odo });
  }
  return { rowCount: rows.length, truckIdCount: ids.size, missingTruckId, invalidDate, invalidOdometer, duplicateCandidates, futureDates, nonCanonicalIds, decreasingOdometer };
}

function formatDate(date?: string | null) {
  if (!date) return "Needs service baseline";
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function compact(n: number) { return Number.isFinite(n) ? new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(n) : "—"; }

function buildUtilizationSeries(rows: Record<string, unknown>[], headers: string[]) {
  const idCol = getColumn(headers, [/^vehicle number$/i, /^truck.?id$/i, /^vehicle$/i, /vehicle number|truck.?id|truck|车辆编号/i]);
  const dateCol = getColumn(headers, [/^date$/i, /^date\s*\(.*\)$/i, /date.?time/i, /observed.?at/i, /日期/i]);
  const odoCol = getColumn(headers, [/^kilomet(?:er|re)s?$/i, /^odometer(?:_km)?$/i, /kilomet|odometer|公里数|里程/i]);
  if (!idCol || !dateCol || !odoCol) return [] as { day: string; km: number }[];
  const byTruck = new Map<string, { day: string; time: number; odo: number; sourceIndex: number }[]>();
  const now = new Date(); now.setHours(23, 59, 59, 999);
  rows.forEach((row, sourceIndex) => {
    const id = String(row[idCol] ?? "").trim().toUpperCase().replace(/\s+/g, "");
    const time = parseAuditDate(row[dateCol]);
    const rawOdo = row[odoCol];
    const rawText = String(rawOdo ?? "").replace(/,/g, "").trim();
    const odo = rawText === "" ? NaN : (typeof rawOdo === "number" ? rawOdo : Number(rawText));
    if (!/^ET\d{3}$/.test(id) || !Number.isFinite(time) || time > now.getTime() || !Number.isFinite(odo) || odo < 0) return;
    const day = new Date(time).toISOString().slice(0, 10);
    const list = byTruck.get(id) ?? [];
    list.push({ day, time, odo, sourceIndex });
    byTruck.set(id, list);
  });
  const perDay = new Map<string, number>();
  for (const readings of byTruck.values()) {
    readings.sort((a, b) => a.time - b.time || a.sourceIndex - b.sourceIndex);
    const daily = new Map<string, { time: number; odo: number }>();
    for (const reading of readings) daily.set(reading.day, { time: reading.time, odo: reading.odo });
    const ordered = [...daily.entries()].sort(([a], [b]) => a.localeCompare(b));
    let previous: { day: string; odo: number } | null = null;
    for (const [day, reading] of ordered) {
      if (previous) {
        const elapsed = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${previous.day}T12:00:00Z`)) / 86400000);
        const delta = reading.odo - previous.odo;
        if (elapsed > 0 && elapsed <= 35 && delta > 0) {
          const perDayRate = delta / elapsed;
          for (let offset = 1; offset <= elapsed; offset++) {
            const allocatedDay = new Date(Date.parse(`${previous.day}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
            perDay.set(allocatedDay, (perDay.get(allocatedDay) ?? 0) + perDayRate);
          }
        }
      }
      if (!previous || reading.odo >= previous.odo) previous = { day, odo: reading.odo };
    }
  }
  return [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-14).map(([day, km]) => ({
    day: new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }),
    km: Math.round(km * 10) / 10,
  }));
}

function needsBaselinePrediction(message: string): Prediction {
  return {
    forecastDate: null, earliestDate: null, latestDate: null, remainingKm: null, overdueKm: null,
    daysUntilDue: null, priority: "Unknown", explanation: message,
    method: "insufficient-data", status: "needs-baseline",
  };
}

function savedForecastDays(row?: Record<string, unknown>): number | null {
  if (!row || row.days_until_due === null || row.days_until_due === undefined || row.days_until_due === "") return null;
  const days = Number(row.days_until_due);
  return Number.isFinite(days) ? days : null;
}

type LiveUsage = {
  truckId: string;
  latestOdometer: number | null;
  latestDate: string | null;
  averageKmPerDay: number | null;
  intervalsUsed: number;
  validDailyReadings: number;
  usageRateOutliers: number;
  suspiciousLatestReading: boolean;
};

type MLForecastItem = {
  available: boolean;
  eligibleForSelection?: boolean;
  predictedKmPerDay: number | null;
  forecastDate: string | null;
  trigger: string | null;
  reason?: string | null;
  validation?: { maeKmPerDay?: number | null; baselineMaeKmPerDay?: number | null; testExamples?: number };
};
type MLComparisonResult = {
  status: string;
  modelVersion: string;
  truckId: string;
  thresholdKm: number;
  latestOdometer: number;
  latestDate: string;
  dataQuality: Record<string, number>;
  training: { status: string; trainingExamples: number; trainExamples: number; testExamples: number; validationStartDate?: string; validationMethod?: string; medianBaselineMaeKmPerDay?: number; reason?: string };
  models: { rule_based: MLForecastItem; random_forest: MLForecastItem; xgboost: MLForecastItem; hybrid: MLForecastItem };
  notes: string[];
  modelRunId?: string;
  modelRunCreatedAt?: string;
  requestFingerprint?: string;
};
type ForecastMethod = "rule_based" | "random_forest" | "xgboost" | "hybrid";



function getColumn(headers: string[], patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const exact = headers.find(h => pattern.test(h));
    if (exact) return exact;
  }
  return undefined;
}

function canonicalTruckIds(rows: Record<string, unknown>[], headers: string[]): string[] {
  const idCol = getColumn(headers, [/^vehicle number$/i, /^truck.?id$/i, /^vehicle$/i, /vehicle number|truck.?id|truck|车辆编号/i]);
  if (!idCol) return [];
  return [...new Set(rows.map(row => String(row[idCol] ?? "").trim().toUpperCase().replace(/\s+/g, ""))
    .filter(id => /^ET\d{3}$/.test(id)))].sort();
}

function estimateUsage(rows: Record<string, unknown>[], headers: string[], truckId: string): LiveUsage {
  const idCol = getColumn(headers, [/^vehicle number$/i, /^truck.?id$/i, /^vehicle$/i, /vehicle number|truck.?id|truck|车辆编号/i]);
  const dateCol = getColumn(headers, [/^date$/i, /^date\s*\(.*\)$/i, /date.?time/i, /observed.?at/i, /日期/i]);
  const odoCol = getColumn(headers, [/^kilomet(?:er|re)s?$/i, /^odometer(?:_km)?$/i, /kilomet|odometer|公里数|里程/i]);
  const empty: LiveUsage = { truckId, latestOdometer: null, latestDate: null, averageKmPerDay: null, intervalsUsed: 0, validDailyReadings: 0, usageRateOutliers: 0, suspiciousLatestReading: false };
  if (!idCol || !dateCol || !odoCol || !truckId) return empty;
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const parsed = rows.map((row, index) => {
    const id = String(row[idCol] ?? "").trim().toUpperCase().replace(/\s+/g, "");
    const timestamp = parseAuditDate(row[dateCol]);
    const rawOdo = row[odoCol];
    const textOdo = String(rawOdo ?? "").replace(/,/g, "").trim();
    const odo = textOdo === "" ? NaN : (typeof rawOdo === "number" ? rawOdo : Number(textOdo));
    return { id, timestamp, odo, index };
  }).filter(r => r.id === truckId && /^ET\d{3}$/.test(r.id) && Number.isFinite(r.timestamp)
      && r.timestamp <= todayEnd.getTime() && Number.isFinite(r.odo) && r.odo >= 0)
    .sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
  if (!parsed.length) return empty;

  // Reject backwards readings for calculation; never edit the imported source values.
  const accepted: typeof parsed = [];
  for (const row of parsed) {
    const previous = accepted[accepted.length - 1];
    if (previous && row.odo < previous.odo) continue;
    accepted.push(row);
  }
  const latestSourceCandidate = parsed[parsed.length - 1];
  const latestSourceCandidateRejected = Boolean(latestSourceCandidate && !accepted.some(row => row.index === latestSourceCandidate.index));
  // One reading per calendar day, using the last accepted reading on that day.
  const byDay = new Map<string, { day: string; timestamp: number; odo: number }>();
  for (const row of accepted) {
    const day = new Date(row.timestamp).toISOString().slice(0, 10);
    byDay.set(day, { day, timestamp: row.timestamp, odo: row.odo });
  }
  const daily = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  if (!daily.length) return empty;
  const rates: number[] = [];
  const acceptedDaily = [daily[0]];
  let usageRateOutliers = 0;
  let suspiciousLatestReading = latestSourceCandidateRejected;
  for (let i = 1; i < daily.length; i++) {
    const current = daily[i];
    const previous = acceptedDaily[acceptedDaily.length - 1];
    const elapsedDays = Math.round((Date.parse(`${current.day}T12:00:00Z`) - Date.parse(`${previous.day}T12:00:00Z`)) / 86400000);
    const delta = current.odo - previous.odo;
    if (elapsedDays <= 0 || delta < 0) continue;
    if (elapsedDays > 35) {
      acceptedDaily.push(current);
      continue;
    }
    const rate = delta / elapsedDays;
    const priorPositive = rates.filter(value => value > 0).slice(-14);
    if (priorPositive.length >= 5) {
      const sorted = [...priorPositive].sort((a, b) => a - b);
      const medianRate = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      const deviations = sorted.map(value => Math.abs(value - medianRate)).sort((a, b) => a - b);
      const mad = deviations.length % 2 ? deviations[(deviations.length - 1) / 2] : (deviations[deviations.length / 2 - 1] + deviations[deviations.length / 2]) / 2;
      const upper = medianRate + Math.max(4.5 * 1.4826 * mad, 2.5 * medianRate, 1);
      if (rate > upper) {
        usageRateOutliers++;
        if (i === daily.length - 1) suspiciousLatestReading = true;
        continue;
      }
    }
    acceptedDaily.push(current);
    rates.push(rate);
  }
  const recentRates = rates.filter(value => value > 0).slice(-14).sort((a, b) => a - b);
  const medianRate = recentRates.length ? (recentRates.length % 2
    ? recentRates[(recentRates.length - 1) / 2]
    : (recentRates[recentRates.length / 2 - 1] + recentRates[recentRates.length / 2]) / 2) : null;
  const latestAccepted = acceptedDaily[acceptedDaily.length - 1];
  return {
    truckId,
    latestOdometer: latestAccepted.odo,
    latestDate: latestAccepted.day,
    averageKmPerDay: medianRate && Number.isFinite(medianRate) && medianRate > 0 ? medianRate : null,
    intervalsUsed: recentRates.length,
    validDailyReadings: acceptedDaily.length,
    usageRateOutliers,
    suspiciousLatestReading,
  };
}


export default function Dashboard() {
  const [lang, setLang] = useState<Lang>("en");
  const [active, setActive] = useState<PageKey>("overview");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<EnrichedTruck | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [selectedPmType, setSelectedPmType] = useState("PM3");
  const [predictionTruckId, setPredictionTruckId] = useState("");
  const [lastServiceDateInput, setLastServiceDateInput] = useState("");
  const [lastServiceOdometerInput, setLastServiceOdometerInput] = useState("");
  const [calendarIntervalInput, setCalendarIntervalInput] = useState("");
  const [uploadName, setUploadName] = useState("");
  const [importRows, setImportRows] = useState<Record<string, unknown>[]>([]);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importAudit, setImportAudit] = useState<ImportAudit | null>(null);
  const [importMessage, setImportMessage] = useState("");
  const [sheetId, setSheetId] = useState("");
  const [sheetRange, setSheetRange] = useState("'Charging Log'!A1:Z5000");
  const [sheetLoading, setSheetLoading] = useState(false);
  const [importMode, setImportMode] = useState<"excel" | "sheets">("excel");
  const [plannerEmail, setPlannerEmail] = useState("");
  const [plannerPassword, setPlannerPassword] = useState("");
  const [plannerSignedIn, setPlannerSignedIn] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [importBatches, setImportBatches] = useState<Record<string, unknown>[]>([]);
  const [savedPredictions, setSavedPredictions] = useState<Record<string, unknown>[]>([]);
  const [ruleSourceReferenceInput, setRuleSourceReferenceInput] = useState("");
  const [serviceEvidenceReferenceInput, setServiceEvidenceReferenceInput] = useState("");
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const [forecastSaveLoading, setForecastSaveLoading] = useState(false);
  const [forecastSaveMessage, setForecastSaveMessage] = useState("");
  const [mlComparison, setMlComparison] = useState<MLComparisonResult | null>(null);
  const [mlLoading, setMlLoading] = useState(false);
  const [mlMessage, setMlMessage] = useState("");
  const [forecastMethod, setForecastMethod] = useState<ForecastMethod>("rule_based");
  const t = copy[lang];
  const activeRule = ruleFor(selectedPmType);
  const predictionTruckIds = useMemo(() => canonicalTruckIds(importRows, importHeaders), [importRows, importHeaders]);
  const effectivePredictionTruckId = predictionTruckId && predictionTruckIds.includes(predictionTruckId)
    ? predictionTruckId : (predictionTruckIds[0] ?? "");
  const liveUsage = useMemo(() => estimateUsage(importRows, importHeaders, effectivePredictionTruckId),
    [importRows, importHeaders, effectivePredictionTruckId]);
  const selectedUsageRate = useMemo(() => {
    if (forecastMethod === "rule_based") return liveUsage.averageKmPerDay;
    if (!mlComparison) return null;
    if (forecastMethod === "random_forest") return mlComparison.models.random_forest.eligibleForSelection ? mlComparison.models.random_forest.predictedKmPerDay : null;
    if (forecastMethod === "xgboost") return mlComparison.models.xgboost.eligibleForSelection ? mlComparison.models.xgboost.predictedKmPerDay : null;
    return mlComparison.models.hybrid.eligibleForSelection ? mlComparison.models.hybrid.predictedKmPerDay : null;
  }, [forecastMethod, liveUsage.averageKmPerDay, mlComparison]);
  const selectedForecast = useMemo(() => calculatePreventiveForecast({
    latestOdometer: liveUsage.suspiciousLatestReading ? null : liveUsage.latestOdometer,
    latestDate: liveUsage.latestDate,
    averageKmPerDay: selectedUsageRate,
    intervalsUsed: liveUsage.intervalsUsed,
    serviceDate: lastServiceDateInput,
    serviceOdometer: lastServiceOdometerInput,
    calendarIntervalDays: calendarIntervalInput,
    pmType: selectedPmType,
  }), [liveUsage, selectedUsageRate, lastServiceDateInput, lastServiceOdometerInput, calendarIntervalInput, selectedPmType]);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/session", { cache: "no-store" }).then(async response => {
      const session = await response.json();
      if (!alive) return;
      setPlannerSignedIn(Boolean(session.signedIn));
      if (session.signedIn) { void loadImportBatches(); void loadSavedPredictions(); }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const savedForecastByTruck = useMemo(() => {
    const result = new Map<string, Record<string, unknown>>();
    for (const row of savedPredictions) {
      const code = String(row.truck_code ?? "");
      if (code && !result.has(code)) result.set(code, row);
    }
    return result;
  }, [savedPredictions]);
  const fleetTruckIds = useMemo(() => [...new Set([
    ...predictionTruckIds,
    ...savedPredictions.map(row => String(row.truck_code ?? "").trim().toUpperCase()),
  ].filter(code => /^ET\d{3}$/.test(code)))].sort(), [predictionTruckIds, savedPredictions]);

  const trucks: EnrichedTruck[] = useMemo(() => fleetTruckIds.map(id => {
    const usage = estimateUsage(importRows, importHeaders, id);
    const sourceRecord: FleetTruck = {
      id,
      latestOdometer: usage.latestOdometer ?? Number.NaN,
      lastReadingDate: usage.latestDate ?? "",
      lastServiceOdometer: null,
      lastServiceDate: null,
      averageKmPerDay: usage.averageKmPerDay ?? Number.NaN,
      dataQuality: usage.latestOdometer === null ? "Missing" : "Review",
      status: "Unknown",
    };
    const saved = savedForecastByTruck.get(id);
    const savedDays = savedForecastDays(saved);
    const explanationValue = saved?.explanation;
    const explanation = explanationValue && typeof explanationValue === "object" && "text" in explanationValue
      ? String((explanationValue as { text?: unknown }).text ?? "Saved provisional forecast.")
      : "Saved provisional forecast; review the stored input snapshot before planning maintenance.";
    const prediction: Prediction = saved ? {
      forecastDate: saved.forecast_date ? String(saved.forecast_date) : null,
      earliestDate: null,
      latestDate: null,
      remainingKm: saved.remaining_km === null || saved.remaining_km === undefined ? null : Number(saved.remaining_km),
      overdueKm: null,
      daysUntilDue: savedDays,
      priority: savedDays === null ? "Unknown" : savedDays <= 7 ? "High" : savedDays <= 30 ? "Medium" : "Low",
      explanation,
      method: "usage-baseline",
      status: "provisional",
    } : buildPrediction(sourceRecord, activeRule);
    return {
      id,
      latestOdometer: usage.latestOdometer,
      lastReadingDate: usage.latestDate,
      lastServiceOdometer: null,
      lastServiceDate: null,
      averageKmPerDay: usage.averageKmPerDay,
      dataQuality: usage.latestOdometer === null ? "Missing" : "Review",
      status: "Unknown",
      prediction,
    };
  }), [fleetTruckIds, importRows, importHeaders, savedForecastByTruck, activeRule.kilometreThreshold, activeRule.calendarIntervalDays]);

  const utilizationSeries = useMemo(() => buildUtilizationSeries(importRows, importHeaders), [importRows, importHeaders]);
  const dashboardAlerts = useMemo(() => {
    if (!importAudit) return [{ level: "info", title: "No source data loaded", detail: "Upload a charging log or preview a Google Sheet to populate live fleet summaries." }];
    const items: { level: string; title: string; detail: string }[] = [];
    if (importAudit.invalidDate) items.push({ level: "danger", title: "Invalid dates", detail: `${importAudit.invalidDate} rows have dates that need correction or source verification.` });
    if (importAudit.invalidOdometer) items.push({ level: "danger", title: "Invalid odometers", detail: `${importAudit.invalidOdometer} rows have missing, negative or invalid odometer values.` });
    if (importAudit.nonCanonicalIds) items.push({ level: "warning", title: "Truck IDs need mapping", detail: `${importAudit.nonCanonicalIds} rows do not use the canonical ET### format.` });
    if (importAudit.decreasingOdometer) items.push({ level: "warning", title: "Odometer decreases", detail: `${importAudit.decreasingOdometer} chronological decreases need review.` });
    if (importAudit.futureDates) items.push({ level: "warning", title: "Future-dated readings", detail: `${importAudit.futureDates} rows are dated in the future.` });
    if (!items.length) items.push({ level: "info", title: "First-pass checks completed", detail: "No configured quality checks flagged this preview. This is not the same as approval for operational use." });
    return items;
  }, [importAudit]);

  const filteredTrucks = useMemo(() => trucks.filter(truck => {
    const matchesSearch = truck.id.toLowerCase().includes(search.toLowerCase());
    const p = truck.prediction;
    const matchesFilter = filter === "all" ||
      (filter === "due" && p.daysUntilDue !== null && p.daysUntilDue <= 30) ||
      (filter === "risk" && truck.dataQuality === "Review") ||
      (filter === "unknown" && (truck.dataQuality === "Missing" || p.daysUntilDue === null));
    return matchesSearch && matchesFilter;
  }), [trucks, search, filter]);

  const forecastCount = savedPredictions.length;
  const dueCount = new Set(savedPredictions.filter(row => { const days = savedForecastDays(row); return days !== null && days <= 30; }).map(row => String(row.truck_code ?? ""))).size;
  const highCount = new Set(savedPredictions.filter(row => { const days = savedForecastDays(row); return days !== null && days <= 7; }).map(row => String(row.truck_code ?? ""))).size;
  const outlookSeries = [
    { label: "Overdue", count: savedPredictions.filter(row => { const days = savedForecastDays(row); return days !== null && days < 0; }).length },
    { label: "1–7d", count: savedPredictions.filter(row => { const days = savedForecastDays(row); return days !== null && days >= 0 && days <= 7; }).length },
    { label: "8–14d", count: savedPredictions.filter(row => { const days = savedForecastDays(row); return days !== null && days > 7 && days <= 14; }).length },
    { label: "15–30d", count: savedPredictions.filter(row => { const days = savedForecastDays(row); return days !== null && days > 14 && days <= 30; }).length },
  ];
  const reviewCount = importAudit ? importAudit.missingTruckId + importAudit.invalidDate + importAudit.invalidOdometer + importAudit.duplicateCandidates + importAudit.futureDates + importAudit.nonCanonicalIds + importAudit.decreasingOdometer : 0;

  const pageTitle = active === "overview" ? t.title : t[active];
  const groupedNav = (group: "fleetOps" | "intelligence" | "system") => nav.filter(n => n.group === group);

  async function handleFileUpload(file?: File) {
    if (!file) return;
    clearMlComparison();
    setImportRows([]);
    setImportHeaders([]);
    setImportAudit(null);
    setUploadName(file.name);
    if (file.size > 15 * 1024 * 1024) {
      setImportMessage("This upload exceeds the 15 MB browser limit. Split the source file into smaller parts and try again.");
      return;
    }
    setImportMessage("Reading file and checking column structure…");
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
      if (!workbook.SheetNames.length) throw new Error("The selected workbook has no worksheets.");
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, { header: 1, defval: "", raw: true, blankrows: false });
      if (matrix.length < 2) throw new Error("The first worksheet needs a header row and at least one data row.");
      const headers = (matrix[0] ?? []).map(value => String(value ?? "").trim());
      if (!headers.length || headers.length > 100) throw new Error("The worksheet must contain between 1 and 100 columns.");
      if (headers.some(h => !h) || new Set(headers.map(h => h.toLowerCase())).size !== headers.length) {
        throw new Error("The source has blank or duplicate column headers. Rename them so every column has a unique, non-empty header.");
      }
      const rows = matrix.slice(1)
        .filter(cells => cells.some(value => String(value ?? "").trim() !== ""))
        .map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])) as Record<string, unknown>);
      if (!rows.length) throw new Error("The first worksheet has headers but no non-empty data rows.");
      if (rows.length > 10000) throw new Error("This version supports up to 10,000 rows per upload. Split the file and upload the parts separately.");
      clearMlComparison();
      setImportHeaders(headers);
      setImportRows(rows);
      const audit = auditImportRows(rows, headers);
      setImportAudit(audit);
      const idColumn = headers.find(h => /vehicle number|vehicle|truck.?id|truck|车辆编号/i.test(h));
      const dateColumn = headers.find(h => /^date(?:\s*\(.*\))?$|date.?time|observed.?at|日期/i.test(h));
      const odoColumn = headers.find(h => /kilomet|odometer|公里数|里程/i.test(h));
      const missingCore = [idColumn, dateColumn, odoColumn].filter(Boolean).length < 3;
      setImportMessage(`${audit.rowCount.toLocaleString()} rows read · ${audit.truckIdCount} distinct raw truck IDs · ${missingCore ? "Required columns need mapping" : "Core columns detected"}. Preview only; no records have been saved to the database.`);
    } catch (error) {
      setImportRows([]);
      setImportHeaders([]);
      setImportAudit(null);
      setImportMessage(error instanceof Error ? error.message : "Unable to read this file.");
    }
  }

  async function handleSheetPreview() {
    if (!sheetId.trim()) {
      setImportMessage("Enter the Google Sheets spreadsheet ID or URL first.");
      return;
    }
    clearMlComparison();
    setSheetLoading(true);
    setImportRows([]);
    setImportHeaders([]);
    setImportAudit(null);
    setUploadName("");
    setImportMessage("Connecting securely to Google Sheets…");
    try {
      const response = await fetch("/api/sheets/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spreadsheetId: sheetId.trim(), range: sheetRange.trim() || "A1:Z5000" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Google Sheets preview failed.");
      const values = (result.values ?? []) as unknown[][];
      if (values.length < 2) throw new Error("The selected Google Sheets range needs a header row and at least one data row.");
      const headers = (values[0] ?? []).map(value => String(value ?? "").trim());
      if (!headers.length || headers.length > 100 || headers.some(h => !h) || new Set(headers.map(h => h.toLowerCase())).size !== headers.length) {
        throw new Error("The selected Google Sheets range has blank or duplicate headers, or exceeds 100 columns. Correct the source headers and retry.");
      }
      const rows = values.slice(1).filter(row => row.some(value => String(value ?? "").trim() !== ""))
        .map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])));
      if (!rows.length || rows.length > 10000) throw new Error("The Google Sheets range must contain 1–10,000 non-empty data rows.");
      clearMlComparison();
      setImportHeaders(headers);
      setImportRows(rows);
      setImportAudit(auditImportRows(rows, headers));
      setUploadName("");
      setImportMessage(`${rows.length.toLocaleString()} rows retrieved from Google Sheets · preview only; no records have been saved to the database.`);
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : "Could not connect to Google Sheets.");
    } finally {
      setSheetLoading(false);
    }
  }

  async function signInPlanner() {
    setAuthLoading(true);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: plannerEmail.trim(), password: plannerPassword }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Planner sign-in failed.");
      setPlannerSignedIn(true);
      setPlannerPassword("");
      setImportMessage("Signed in. Server-side planner authorization is active.");
      await Promise.all([loadImportBatches(), loadSavedPredictions()]);
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : "Planner sign-in failed.");
    } finally { setAuthLoading(false); }
  }

  async function signOutPlanner() {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* Clear local UI state even if the request fails. */ }
    setPlannerSignedIn(false);
    setImportBatches([]);
    setSavedPredictions([]);
    setImportMessage("Signed out.");
  }

  async function loadImportBatches() {
    try {
      const response = await fetch("/api/imports", { cache: "no-store" });
      const result = await response.json();
      if (response.ok) setImportBatches((result.batches ?? []) as Record<string, unknown>[]);
    } catch { /* Import history is optional while configuration is incomplete. */ }
  }

  async function loadSavedPredictions() {
    try {
      const response = await fetch("/api/predictions", { cache: "no-store" });
      const result = await response.json();
      if (response.ok) setSavedPredictions((result.predictions ?? []) as Record<string, unknown>[]);
    } catch { /* Saved forecast history is unavailable until the planner session and database are configured. */ }
  }

  function clearMlComparison() {
    setMlComparison(null);
    setMlMessage("");
    setForecastMethod("rule_based");
  }

  async function runMlComparison() {
    if (!plannerSignedIn) {
      setMlMessage("Sign in with the authorized planner account on Data Quality before running ML models.");
      return;
    }
    if (!importRows.length || !importHeaders.length || !effectivePredictionTruckId) {
      setMlMessage("Load a charging log with valid ET### truck IDs first.");
      return;
    }
    if (!lastServiceDateInput || !lastServiceOdometerInput || !calendarIntervalInput) {
      setMlMessage("Enter the verified last-service date, last-service odometer and approved calendar interval before running the comparison.");
      return;
    }
    if (liveUsage.latestOdometer === null || !liveUsage.latestDate || liveUsage.suspiciousLatestReading) {
      setMlMessage(liveUsage.suspiciousLatestReading ? "The latest source reading appears to be an implausible odometer jump. Review the charging log before training or forecasting this truck." : "The selected truck has no valid current odometer/date baseline in the loaded charging log.");
      return;
    }
    setMlLoading(true);
    setMlMessage("Training and evaluating Random Forest and XGBoost against a chronological holdout…");
    setMlComparison(null);
    setForecastMethod("rule_based");
    try {
      const response = await fetch("/api/ml/forecast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: importRows,
          headers: importHeaders,
          truckId: effectivePredictionTruckId,
          pmType: selectedPmType,
          thresholdKm: PM_TYPES.find(pm => pm.code === selectedPmType)?.thresholdKm,
          serviceDate: lastServiceDateInput,
          serviceOdometer: Number(lastServiceOdometerInput),
          calendarIntervalDays: Number(calendarIntervalInput),
          latestOdometer: liveUsage.latestOdometer,
          latestDate: liveUsage.latestDate,
          sourceName: uploadName || (importMode === "sheets" ? `Google Sheets: ${sheetId.trim()}` : "Current source preview"),
          today: new Date().toISOString().slice(0, 10),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "ML comparison request failed.");
      setMlComparison(result as MLComparisonResult);
      const training = result.training as MLComparisonResult["training"];
      if (training?.status === "trained") {
        setMlMessage(`Training complete: ${training.trainingExamples} historical next-interval examples; ${training.testExamples} held-out examples evaluated. ${Number(result.dataQuality?.usageRateOutliers ?? 0)} implausible odometer-usage jumps were excluded. Only models that beat the median baseline can be selected.`);
      } else {
        setMlMessage(training?.reason || "Not enough valid historical examples to train the ML models. The rule-based estimate remains available.");
      }
    } catch (error) {
      setMlMessage(error instanceof Error ? error.message : "ML comparison failed. Check the service configuration and logs.");
    } finally {
      setMlLoading(false);
    }
  }

  async function saveForecast() {
    if (!plannerSignedIn) {
      setForecastSaveMessage("Sign in with the authorized planner account on Data Quality before saving forecasts.");
      return;
    }
    if (selectedForecast.status !== "ready" || liveUsage.latestOdometer === null || !liveUsage.latestDate || liveUsage.suspiciousLatestReading || selectedUsageRate === null || selectedUsageRate <= 0) {
      setForecastSaveMessage("The forecast inputs are incomplete. Resolve the validation message above before saving.");
      return;
    }
    if (forecastMethod !== "rule_based" && !mlComparison?.modelRunId) {
      setForecastSaveMessage("Run and save an ML comparison before saving an ML-based forecast.");
      return;
    }
    if (!ruleSourceReferenceInput.trim() || !serviceEvidenceReferenceInput.trim() || !approvalConfirmed) {
      setForecastSaveMessage("Enter both source references and confirm that the rule and service baseline have been verified.");
      return;
    }
    setForecastSaveLoading(true);
    setForecastSaveMessage("Saving the verified baseline and provisional forecast…");
    try {
      const response = await fetch("/api/predictions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          truckCode: effectivePredictionTruckId,
          pmType: selectedPmType,
          latestOdometer: liveUsage.latestOdometer,
          latestDate: liveUsage.latestDate,
          averageKmPerDay: selectedUsageRate,
          baselineAverageKmPerDay: liveUsage.averageKmPerDay,
          forecastMethod,
          modelRunId: mlComparison?.modelRunId ?? null,
          requestFingerprint: mlComparison?.requestFingerprint ?? null,
          sourceRowCount: importRows.length,
          intervalsUsed: liveUsage.intervalsUsed,
          serviceDate: lastServiceDateInput,
          serviceOdometer: Number(lastServiceOdometerInput),
          calendarIntervalDays: Number(calendarIntervalInput),
          ruleSourceReference: ruleSourceReferenceInput.trim(),
          serviceEvidenceReference: serviceEvidenceReferenceInput.trim(),
          approvalConfirmed,
          sourceName: uploadName || (importMode === "sheets" ? `Google Sheets: ${sheetId.trim()}` : "Current source preview"),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to save the forecast.");
      setForecastSaveMessage(`Saved provisional ${forecastMethod} forecast ${String(result.prediction?.id ?? "")} for ${effectivePredictionTruckId} (${selectedPmType}), due ${String(result.prediction?.forecast_date ?? "date unavailable")}.${result.warning ? ` Warning: ${String(result.warning)}` : ""}`);
      await loadSavedPredictions();
    } catch (error) {
      setForecastSaveMessage(error instanceof Error ? error.message : "Forecast save failed. Check the database and try again.");
    } finally {
      setForecastSaveLoading(false);
    }
  }

  async function saveImportBatch() {
    if (!importRows.length || !importHeaders.length) return;
    if (importRows.length > 10000) { setImportMessage("This version supports up to 10,000 rows per upload. Split the source file and upload the parts separately."); return; }
    setSaveLoading(true);
    setImportMessage("Saving source rows in bounded batches…");
    const chunkSize = 400;
    const totalParts = Math.ceil(importRows.length / chunkSize);
    const baseName = importMode === "sheets" ? `Google Sheets: ${sheetId.trim()}` : uploadName || "manual-upload";
    let savedRows = 0, flaggedRows = 0, rejectedRows = 0;
    const savedBatchIds: string[] = [];
    try {
      for (let offset = 0; offset < importRows.length; offset += chunkSize) {
        const chunk = importRows.slice(offset, offset + chunkSize);
        const part = Math.floor(offset / chunkSize) + 1;
        const partName = totalParts > 1 ? `${baseName} (part ${part}/${totalParts})` : baseName;
        const rangeLabel = importMode === "sheets" ? `${sheetRange.trim()} · data rows ${offset + 1}-${offset + chunk.length}` : `Source data rows ${offset + 1}-${offset + chunk.length}`;
        const response = await fetch("/api/imports", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceName: partName, sourceRange: rangeLabel, sourceRowOffset: offset, headers: importHeaders, rows: chunk }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(`Part ${part}/${totalParts} failed after ${savedRows.toLocaleString()} rows were saved: ${result.error || "Unable to save import batch."}`);
        savedRows += Number(result.rowCount ?? chunk.length);
        flaggedRows += Number(result.flaggedCount ?? 0);
        rejectedRows += Number(result.rejectedCount ?? 0);
        if (result.batchId) savedBatchIds.push(String(result.batchId));
        setImportMessage(`Saved part ${part} of ${totalParts} · ${savedRows.toLocaleString()} of ${importRows.length.toLocaleString()} rows saved for review…`);
      }
      setImportMessage(`Saved ${savedBatchIds.length} import batch(es) containing ${savedRows.toLocaleString()} source rows. ${flaggedRows.toLocaleString()} flagged and ${rejectedRows.toLocaleString()} rejected for review. No readings were accepted into operational history.`);
      await loadImportBatches();
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : `Import stopped after ${savedRows.toLocaleString()} rows. Check import history before retrying.`);
      await loadImportBatches();
    } finally { setSaveLoading(false); }
  }

  function exportDataReport() {
    if (!importRows.length || !importHeaders.length) {
      setImportMessage("Load a charging log in Data Quality before exporting a report.");
      setActive("data");
      return;
    }
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(importRows), "Source data");
    const summary = [
      ["TONLY Data Quality Report", "Value"],
      ["Generated at", new Date().toISOString()],
      ["Source file", uploadName || (importMode === "sheets" ? `Google Sheets: ${sheetId}` : "Current browser preview")],
      ["Rows inspected", importAudit?.rowCount ?? importRows.length],
      ["Distinct raw truck IDs", importAudit?.truckIdCount ?? ""],
      ["Missing truck IDs", importAudit?.missingTruckId ?? ""],
      ["Invalid dates", importAudit?.invalidDate ?? ""],
      ["Invalid odometers", importAudit?.invalidOdometer ?? ""],
      ["Duplicate candidates", importAudit?.duplicateCandidates ?? ""],
      ["Future dates", importAudit?.futureDates ?? ""],
      ["Non-canonical IDs", importAudit?.nonCanonicalIds ?? ""],
      ["Odometer decreases", importAudit?.decreasingOdometer ?? ""],
      ["Operational approval", "Not approved — manual review required"],
    ];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summary), "Audit summary");
    XLSX.writeFile(workbook, `tonly-data-quality-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function renderNav(group: "fleetOps" | "intelligence" | "system") {
    return (
      <div className="nav-group" key={group}>
        <div className="nav-label">{t[group]}</div>
        {groupedNav(group).map(item => {
          const Icon = item.icon;
          return <button key={item.key} className={`nav-item ${active === item.key ? "selected" : ""}`} onClick={() => { setActive(item.key); setMobileNav(false); }}>
            <Icon size={17} strokeWidth={1.8} /><span>{t[item.key]}</span>{item.key === "data" && reviewCount > 0 && <span className="nav-count">{reviewCount}</span>}
          </button>;
        })}
      </div>
    );
  }

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Zap size={20} fill="currentColor" /></div>
          <div><div className="brand-name">TONLY<span> / INTELLIGENCE</span></div><div className="brand-sub">PREDICTIVE MAINTENANCE</div></div>
        </div>
        <div className="site-selector"><div className="site-icon">AK</div><div className="site-text"><strong>Akyem Mine</strong><span>Electric truck fleet</span></div><ChevronDown size={15} /></div>
        {renderNav("fleetOps")}
        {renderNav("intelligence")}
        {renderNav("system")}
        <div className="sidebar-bottom">
          <div className="system-health"><span className="pulse-dot" /><div><strong>Application ready</strong><span>{importRows.length ? "Source preview loaded" : "Awaiting source data"}</span></div></div>
          <button className="nav-item" onClick={() => { setActive("reports"); setMobileNav(false); }}><Settings2 size={17} /><span>Reports & settings</span></button>
          <div className="user-profile"><div className="avatar">OF</div><div><strong>Maintenance Planner</strong><span>Planner access</span></div><MoreHorizontal size={17} /></div>
        </div>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation"><Menu size={19} /></button>
            <div className="breadcrumb">TONLY <ChevronRight size={13} /> <span>{pageTitle}</span></div>
          </div>
          <div className="topbar-actions">
            <div className="global-search"><Search size={15} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder={t.search} aria-label={t.search} /></div>
            <button className="language-switch" onClick={() => setLang(lang === "en" ? "zh" : "en")}><Languages size={16} /> {lang === "en" ? "中文" : "English"}</button>
            
            <div className="avatar top-avatar">OF</div>
          </div>
        </header>

        <div className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-dot" /> MAINTENANCE INTELLIGENCE</div>
              <h1>{pageTitle}</h1>
              <p>{active === "overview" ? t.subtitle : `TONLY electric fleet · ${pageTitle}`}</p>
            </div>
            <div className="heading-actions">
              <label className="pm-select-wrap"><span>PM type</span><select value={selectedPmType} onChange={e => { setSelectedPmType(e.target.value); clearMlComparison(); setApprovalConfirmed(false); setForecastSaveMessage(""); }} aria-label="Select PM type">{PM_TYPES.map(pm => <option key={pm.code} value={pm.code}>{pm.code} · {pm.thresholdKm.toLocaleString()} km</option>)}</select></label>
              <button className="button secondary" onClick={async () => { setSearch(""); setFilter("all"); if (plannerSignedIn) await loadImportBatches(); }}><RefreshCw size={15} /> {t.refresh}</button>
              <button className="button primary" onClick={() => setActive("calendar")}><CalendarDays size={15} /> {t.schedule}</button>
            </div>
          </div>

          <div className="source-status-banner"><AlertTriangle size={16} /><div><strong>{active === "predictions" ? (importRows.length > 0 ? "UPLOAD-DRIVEN ESTIMATE · PROVISIONAL" : "PREDICTION REQUIRES SOURCE DATA") : importRows.length > 0 ? "SOURCE DATA LOADED · REVIEW REQUIRED" : t.demo}</strong><span>{importRows.length > 0 ? "Fleet summaries and usage trends are derived from the current source preview. Source records remain unapproved until reviewed; service baselines and OEM intervals must be verified." : "No operational records are preloaded. Upload a charging log or connect an authorized Google Sheet to populate this workspace."}</span></div><span className="source-status-pill">{importRows.length > 0 ? "SOURCE DATA" : "AWAITING DATA"}</span></div>

          {active === "overview" && <>
            <div className="kpi-grid">
              <article className="kpi-card">
                <div className="kpi-top"><span>{t.fleetSize}</span><span className="kpi-icon blue"><Truck size={17} /></span></div>
                <div className="kpi-value">{predictionTruckIds.length} <span className="kpi-unit">trucks</span></div>
                <div className="kpi-foot"><span className="neutral-dot" /> Detected in current source preview</div>
              </article>
              <article className="kpi-card">
                <div className="kpi-top"><span>{t.dueSoon}</span><span className="kpi-icon amber"><CalendarDays size={17} /></span></div>
                <div className="kpi-value">{forecastCount ? dueCount.toString().padStart(2, "0") : "—"} <span className="kpi-unit">trucks</span></div>
                <div className="kpi-foot"><span className="amber-dot" /> {forecastCount ? "Based on generated estimates" : "No saved fleet forecasts"}</div>
              </article>
              <article className="kpi-card">
                <div className="kpi-top"><span>{t.overdue}</span><span className="kpi-icon red"><AlertTriangle size={17} /></span></div>
                <div className="kpi-value">{forecastCount ? highCount.toString().padStart(2, "0") : "—"} <span className="kpi-unit">trucks</span></div>
                <div className="kpi-foot"><span className="red-dot" /> {forecastCount ? "Requires planner review" : "Forecasts need service baselines"}</div>
              </article>
              <article className="kpi-card">
                <div className="kpi-top"><span>{t.dataQuality}</span><span className="kpi-icon violet"><ShieldCheck size={17} /></span></div>
                <div className="kpi-value">{importAudit ? reviewCount.toLocaleString() : "—"} <span className="kpi-unit">flags</span></div>
                <div className="kpi-foot"><span className="violet-dot" /> {importAudit ? "First-pass checks; counts may overlap" : "Load data to run quality checks"}</div>
              </article>
            </div>

            <div className="main-grid">
              <section className="panel utilization-panel">
                <div className="panel-header"><div><h2>{t.utilization}</h2><p>{t.utilizationSub}</p></div><span className="select-button" aria-label="Usage period: last 14 observed days">Last 14 observed days</span></div>
                <div className="chart-legend"><span className="legend-dot" /> Fleet average <span className="legend-note">km / day</span></div>
                <div className="chart-wrap">
                  {utilizationSeries.length > 0 ? <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={utilizationSeries} margin={{ top: 8, right: 10, left: -20, bottom: 0 }}>
                      <defs><linearGradient id="utilFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2f6fed" stopOpacity={0.20} /><stop offset="100%" stopColor="#2f6fed" stopOpacity={0.01} /></linearGradient></defs>
                      <CartesianGrid stroke="#edf0f5" vertical={false} />
                      <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fill: "#8b95a7", fontSize: 11 }} />
                      <YAxis tickLine={false} axisLine={false} tick={{ fill: "#8b95a7", fontSize: 11 }} />
                      <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #e5e9f0", fontSize: 12 }} />
                      <Area type="monotone" dataKey="km" stroke="#2f6fed" strokeWidth={2.5} fill="url(#utilFill)" />
                    </AreaChart>
                  </ResponsiveContainer> : <div className="empty-state">Upload a log with valid truck IDs, dates and odometers to calculate the usage trend.</div>}
                </div>
                <div className="chart-footer"><span><b>Source-derived estimate</b> · calculated from positive odometer deltas</span><span>{utilizationSeries.length ? `${utilizationSeries.length} observed days` : "No source series"}</span></div>
              </section>

              <section className="panel outlook-panel">
                <div className="panel-header"><div><h2>{t.maintenanceOutlook}</h2><p>{t.next30}</p></div><span className="muted-meta">Source preview</span></div>
                <div className="outlook-total"><strong>{forecastCount ? dueCount : "—"}</strong><span>{forecastCount ? "trucks with a generated estimate within 30 days" : "No saved forecasts"}</span></div>
                <div className="outlook-chart">
                  {forecastCount ? <div className="outlook-bins">{outlookSeries.map(item => <div className="outlook-bin" key={item.label}><div className="outlook-bin-track"><div className="outlook-bin-fill" style={{ height: `${Math.max(3, (item.count / Math.max(1, ...outlookSeries.map(x => x.count))) * 100)}%` }} /></div><strong>{item.count}</strong><span>{item.label}</span></div>)}</div> : <div className="empty-state">Save a provisional forecast with verified rule and service references to populate this outlook.</div>}
                </div>
                <div className="outlook-note"><Clock3 size={14} /> No placeholder intervals are applied</div>
              </section>
            </div>

            <section className="panel table-panel">
              <div className="panel-header table-heading"><div><h2>Truck data readiness</h2><p>Source trucks and saved forecast records, where available</p></div><button className="text-button" onClick={() => { setActive("fleet"); setFilter("all"); }}>{t.viewAll} <ArrowRight size={14} /></button></div>
              <div className="table-toolbar">
                <div className="filter-tabs">
                  {[["all", t.allTrucks], ["due", t.due], ["risk", t.risk], ["unknown", t.unknown]].map(([value, label]) => <button key={value} className={filter === value ? "filter-tab active" : "filter-tab"} onClick={() => setFilter(value)}>{label}</button>)}
                </div>
                <span className="muted-meta">Source preview only</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>{t.truck}</th><th>{t.latestOdo}</th><th>{t.nextService}</th><th>{t.remaining}</th><th>{t.priority}</th><th>{t.dataStatus}</th><th /></tr></thead>
                  <tbody>
                    {filteredTrucks.slice(0, 8).map(truck => {
                      const p = truck.prediction;
                      return <tr key={truck.id} onClick={() => setSelected(truck)} className="click-row">
                        <td><div className="truck-cell"><div className="truck-mini"><Truck size={16} /></div><div><strong>{truck.id}</strong><span>TONLY electric truck</span></div></div></td>
                        <td className="numeric">{truck.latestOdometer === null ? "—" : `${compact(truck.latestOdometer)} km`}</td>
                        <td><div className="date-cell"><strong>{formatDate(p.forecastDate ?? undefined)}</strong><span>{p.daysUntilDue === null ? "No saved forecast" : `${p.daysUntilDue} ${t.days}`}</span></div></td>
                        <td className="numeric">{p.remainingKm === null ? "—" : p.overdueKm && p.overdueKm > 0 ? `${compact(p.overdueKm)} km overdue` : `${compact(p.remainingKm)} km`}</td>
                        <td><span className={`priority-badge ${p.priority.toLowerCase()}`}>{p.priority}</span></td>
                        <td><span className={`quality-badge ${truck.dataQuality.toLowerCase()}`}><span />{truck.dataQuality}</span></td>
                        <td><ChevronRight size={16} className="row-chevron" /></td>
                      </tr>;
                    })}
                  </tbody>
                </table>
                {filteredTrucks.length === 0 && <div className="empty-state">No trucks match this filter.</div>}
              </div>
              <div className="table-footer"><span>Showing {Math.min(filteredTrucks.length, 8)} of {filteredTrucks.length} trucks</span><span>Source-derived readings · review required</span></div>
            </section>

            <div className="bottom-grid">
              <section className="panel alerts-panel">
                <div className="panel-header"><div><h2>{t.alerts}</h2><p>{t.alertSub}</p></div><span className="alert-count">{dashboardAlerts.length}</span></div>
                <div className="alert-list">
                  {dashboardAlerts.map((alert, i) => <div className="alert-row" key={i}><div className={`alert-icon ${alert.level}`}><AlertTriangle size={16} /></div><div className="alert-copy"><strong>{alert.title}</strong><span>{alert.detail}</span></div><button className="icon-button subtle" aria-label="Review data quality" onClick={() => setActive("data")}><ChevronRight size={16} /></button></div>)}
                </div>
              </section>
              <section className="panel model-panel">
                <div className="panel-header"><div><h2>{t.modelStatus}</h2><p>Forecast method and data readiness</p></div><BrainCircuit size={20} className="model-head-icon" /></div>
                <div className="model-status"><div className="model-symbol"><Gauge size={21} /></div><div><strong>Transparent usage baseline</strong><span>{importRows.length ? "Source-derived usage estimate available" : "Waiting for source data"}</span></div><span className="status-live">{importRows.length ? "READY" : "WAITING"}</span></div>
                <div className="model-metrics"><div><span>Latest forecasts by truck/rule</span><strong>{forecastCount}</strong></div><div><span>ML comparison</span><strong>Run RF + XGBoost on demand</strong></div></div>
                <p className="model-footnote"><CircleHelp size={14} /> {t.baselineSub}</p>
              </section>
            </div>
          </>}

          {active === "predictions" && <section className="prediction-workspace">
            <div className="prediction-intro panel">
              <div className="placeholder-icon"><BrainCircuit size={25} /></div>
              <div><div className="eyebrow">LIVE BASELINE FORECAST</div><h2>Generate a truck service estimate</h2>
                <p>This forecast uses the charging log currently loaded in Data Quality. No synthetic fleet records are used.</p></div>
            </div>
            {importRows.length === 0 ? <div className="prediction-empty panel">
              <Database size={28} /><h3>No charging log loaded</h3><p>Open Data Quality, upload your Excel/CSV charging log or preview your Google Sheet, then return here to calculate a forecast.</p>
              <button className="button primary" onClick={() => setActive("data")}>Go to Data Quality</button>
            </div> : <>
              <div className="prediction-form panel">
                <div className="panel-header"><div><h2>Forecast inputs</h2><p>Use verified service records and approved intervals only.</p></div><span className="quality-badge review"><span />Provisional baseline</span></div>
                <div className="prediction-form-grid">
                  <div className="form-field"><label htmlFor="prediction-truck">Truck ID</label><select id="prediction-truck" value={effectivePredictionTruckId} onChange={e => { setPredictionTruckId(e.target.value); clearMlComparison(); setApprovalConfirmed(false); setForecastSaveMessage(""); }}>
                    {predictionTruckIds.length === 0 ? <option value="">No canonical ET### IDs found</option> : predictionTruckIds.map(id => <option key={id} value={id}>{id}</option>)}
                  </select></div>
                  <div className="form-field"><label htmlFor="service-date">Verified last-service date</label><input id="service-date" type="date" value={lastServiceDateInput} max={new Date().toISOString().slice(0, 10)} onChange={e => { setLastServiceDateInput(e.target.value); clearMlComparison(); setApprovalConfirmed(false); setForecastSaveMessage(""); }} /></div>
                  <div className="form-field"><label htmlFor="service-odo">Odometer at last service (km)</label><input id="service-odo" inputMode="decimal" type="number" min="0" value={lastServiceOdometerInput} onChange={e => { setLastServiceOdometerInput(e.target.value); clearMlComparison(); setApprovalConfirmed(false); setForecastSaveMessage(""); }} placeholder="Enter verified value" /></div>
                  <div className="form-field"><label htmlFor="calendar-interval">Approved calendar interval (days)</label><input id="calendar-interval" type="number" min="1" step="1" value={calendarIntervalInput} onChange={e => { setCalendarIntervalInput(e.target.value); clearMlComparison(); setApprovalConfirmed(false); setForecastSaveMessage(""); }} placeholder="Enter approved interval" /></div>
                </div>
                <div className="prediction-data-strip">
                  <div><span>{liveUsage.suspiciousLatestReading ? "Last accepted odometer" : "Latest valid odometer"}</span><strong>{liveUsage.latestOdometer === null ? "—" : `${compact(liveUsage.latestOdometer)} km`}</strong></div>
                  <div><span>Latest reading date</span><strong>{liveUsage.latestDate ?? "—"}</strong></div>
                  <div><span>Estimated usage</span><strong>{liveUsage.averageKmPerDay === null ? "Not available" : `${Math.round(liveUsage.averageKmPerDay)} km/day`}</strong></div>
                  <div><span>Usage intervals</span><strong>{liveUsage.intervalsUsed}</strong></div>
                </div>
                <p className="prediction-method-note">Usage is the median of recent positive odometer increments per day. Decreasing readings and robustly detected usage-rate outliers are excluded, never corrected in the source. {liveUsage.usageRateOutliers} implausible interval(s) excluded for this truck.</p>{liveUsage.suspiciousLatestReading && <div className="import-message" role="alert"><AlertTriangle size={15} /><span>The latest source reading appears to be an implausible odometer jump. Forecasting is blocked until you review the source reading; the displayed odometer is the last accepted reading.</span></div>}
                <div className="forecast-evidence-grid">
                  <div className="form-field"><label htmlFor="rule-source-reference">Approved PM-rule source reference</label><input id="rule-source-reference" value={ruleSourceReferenceInput} onChange={e => { setRuleSourceReferenceInput(e.target.value); setApprovalConfirmed(false); setForecastSaveMessage(""); }} maxLength={500} placeholder="OEM manual, approved maintenance procedure, document/page" /></div>
                  <div className="form-field"><label htmlFor="service-evidence-reference">Last-service evidence reference</label><input id="service-evidence-reference" value={serviceEvidenceReferenceInput} onChange={e => { setServiceEvidenceReferenceInput(e.target.value); setApprovalConfirmed(false); setForecastSaveMessage(""); }} maxLength={500} placeholder="Completed work order or verified service record" /></div>
                </div>
                <label className="forecast-approval-row"><input type="checkbox" checked={approvalConfirmed} onChange={e => setApprovalConfirmed(e.target.checked)} /><span>I confirm the PM rule, calendar interval and last-service baseline match approved records.</span></label>
              </div>
              <div className="prediction-result panel">
                <div className="panel-header"><div><h2>Forecast result</h2><p>{effectivePredictionTruckId || "No truck selected"} · {selectedPmType} · {({rule_based: "Rule-based", random_forest: "Random Forest", xgboost: "XGBoost", hybrid: "Hybrid median"} as Record<ForecastMethod, string>)[forecastMethod]} · threshold {PM_TYPES.find(pm => pm.code === selectedPmType)?.thresholdKm.toLocaleString()} km</p></div>
                  <span className={`priority-badge ${selectedForecast.status === "ready" ? (selectedForecast.trigger === "already-due" ? "high" : "medium") : "unknown"}`}>{selectedForecast.status === "ready" ? (selectedForecast.trigger === "already-due" ? "Threshold reached" : "Estimate ready") : "Needs input"}</span></div>
                {selectedForecast.status === "ready" ? <div className="prediction-result-grid">
                  <div className="forecast-date-card"><span>Estimated service date</span><strong>{formatDate(selectedForecast.dueDate ?? undefined)}</strong><small>{selectedForecast.trigger === "calendar" ? "Calendar interval triggers first" : selectedForecast.trigger === "kilometre" ? "Kilometre threshold triggers first" : "Threshold already reached"}</small></div>
                  <div className="forecast-kpi"><span>Distance remaining</span><strong>{selectedForecast.remainingKm === null ? "—" : `${compact(selectedForecast.remainingKm)} km`}</strong></div>
                  <div className="forecast-kpi"><span>Days to kilometre threshold</span><strong>{selectedForecast.daysToKm === null ? "—" : selectedForecast.daysToKm}</strong></div>
                </div> : <div className="prediction-blocked"><AlertTriangle size={19} /><div><strong>Forecast not generated</strong><p>{selectedForecast.explanation}</p></div></div>}
                {selectedForecast.status === "ready" && <p className="prediction-explanation">{selectedForecast.explanation}</p>}
                <div className="prediction-safety-note"><ShieldCheck size={16} /><span>This is a scheduled-PM estimate. Random Forest and XGBoost estimate usage rate, not component failures. The save action records the verified service baseline, approved rule reference and immutable provisional forecast; it does not accept source odometer readings into operational history.</span></div>
                <div className="forecast-save-controls"><button className="button primary" onClick={saveForecast} disabled={!plannerSignedIn || selectedForecast.status !== "ready" || selectedUsageRate === null || selectedUsageRate <= 0 || (forecastMethod !== "rule_based" && !mlComparison?.modelRunId) || forecastSaveLoading || !ruleSourceReferenceInput.trim() || !serviceEvidenceReferenceInput.trim() || !approvalConfirmed}>{forecastSaveLoading ? <RefreshCw size={14} className="spin" /> : <Database size={14} />}{forecastSaveLoading ? "Saving forecast…" : "Save provisional forecast"}</button>{!plannerSignedIn && <span>Sign in on Data Quality to save a forecast.</span>}{forecastSaveMessage && <p role="status" aria-live="polite">{forecastSaveMessage}</p>}</div>
              </div>
              <section className="panel ml-comparison-panel">
                <div className="panel-header"><div><h2>Machine-learning comparison</h2><p>Train Random Forest and XGBoost on real historical odometer intervals; validate on later dates.</p></div><BrainCircuit size={20} className="model-head-icon" /></div>
                <p className="prediction-method-note">The models forecast future usage in km/day. They do not predict component failures. A chronological holdout is used to compare each model's MAE against a median-rate baseline.</p>
                <div className="ml-actions"><button className="button primary" onClick={runMlComparison} disabled={mlLoading || !plannerSignedIn || !importRows.length || !effectivePredictionTruckId}>{mlLoading ? <RefreshCw size={14} className="spin" /> : <BrainCircuit size={14} />}{mlLoading ? "Training models…" : "Run Random Forest + XGBoost"}</button>{!plannerSignedIn && <span>Sign in on Data Quality first.</span>}</div>
                {mlMessage && <div className="import-message" role="status" aria-live="polite"><CircleDot size={15} /><span>{mlMessage}</span></div>}
                {mlComparison && <>
                  <div className="model-metrics ml-training-metrics"><div><span>Training examples</span><strong>{mlComparison.training.trainingExamples}</strong></div><div><span>Train / test</span><strong>{mlComparison.training.trainExamples} / {mlComparison.training.testExamples}</strong></div><div><span>Validation starts</span><strong>{mlComparison.training.validationStartDate ?? "—"}</strong></div><div><span>Model version</span><strong>{mlComparison.modelVersion}</strong></div></div>
                  {mlComparison.training.reason && <p className="prediction-method-note">{mlComparison.training.reason}</p>}
                  <div className="table-scroll"><table><thead><tr><th>Method</th><th>Predicted usage</th><th>Validation MAE (km/day)</th><th>Median baseline MAE</th><th>Estimated PM date</th><th>Availability</th></tr></thead><tbody>
                    {([ ["rule_based", "Rule-based median"], ["random_forest", "Random Forest"], ["xgboost", "XGBoost"], ["hybrid", "Hybrid median"] ] as [keyof MLComparisonResult["models"], string][]).map(([key, label]) => { const model = mlComparison.models[key]; return <tr key={key}><td>{label}</td><td>{model.predictedKmPerDay === null ? "—" : `${model.predictedKmPerDay.toFixed(1)} km/day`}</td><td>{model.validation?.maeKmPerDay == null ? "—" : model.validation.maeKmPerDay.toFixed(3)}</td><td>{model.validation?.baselineMaeKmPerDay == null ? "—" : model.validation.baselineMaeKmPerDay.toFixed(3)}</td><td>{model.forecastDate ? formatDate(model.forecastDate) : "—"}</td><td>{model.eligibleForSelection ? <span className="quality-badge good"><span />Validated</span> : <span className="quality-badge review"><span />{model.available ? "Does not beat baseline" : model.reason || "Insufficient data"}</span>}</td></tr>; })}
                  </tbody></table></div>
                  <div className="form-field ml-method-select"><label htmlFor="forecast-method">Method used for the saved forecast</label><select id="forecast-method" value={forecastMethod} onChange={e => { setForecastMethod(e.target.value as ForecastMethod); setForecastSaveMessage(""); }}>
                    <option value="rule_based">Rule-based median (recommended baseline)</option>
                    <option value="random_forest" disabled={!mlComparison.models.random_forest.eligibleForSelection}>Random Forest</option>
                    <option value="xgboost" disabled={!mlComparison.models.xgboost.eligibleForSelection}>XGBoost</option>
                    <option value="hybrid" disabled={!mlComparison.models.hybrid.eligibleForSelection}>Hybrid median of available estimates</option>
                  </select><span className="field-hint">Only available models can be selected. The server rechecks the saved model run before accepting an ML-based forecast.</span></div>
                  <ul className="ml-notes">{mlComparison.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
                </>}
              </section>
            </>}
          </section>}

          {active === "data" && <section className="import-workspace">
            <div className="import-intro">
              <div className="placeholder-icon"><Database size={25} /></div>
              <div><div className="eyebrow">DATA FOUNDATION</div><h2>Import and validate fleet records</h2><p>Choose Excel/CSV upload or connect a Google Sheet. Both options feed the same review workflow.</p></div>
            </div>
            <div className="planner-auth-card">
              <div className="planner-auth-copy"><ShieldCheck size={18} /><div><strong>Planner access</strong><span>{plannerSignedIn ? "Signed in; server-side allowlist is checked on every import request." : "Sign in with the single authorized planner account to save import batches."}</span></div></div>
              {plannerSignedIn ? <button className="button secondary" onClick={signOutPlanner}>Sign out</button> : <div className="planner-auth-fields"><input type="email" autoComplete="username" value={plannerEmail} onChange={e => setPlannerEmail(e.target.value)} placeholder="Planner email" aria-label="Planner email" /><input type="password" autoComplete="current-password" value={plannerPassword} onChange={e => setPlannerPassword(e.target.value)} placeholder="Password" aria-label="Planner password" /><button className="button primary" disabled={authLoading || !plannerEmail.trim() || !plannerPassword} onClick={signInPlanner}>{authLoading ? "Signing in…" : "Sign in"}</button></div>}
            </div>
            <div className="import-tabs">
              <button className={importMode === "excel" ? "import-tab active" : "import-tab"} onClick={() => { setImportMode("excel"); clearMlComparison(); setImportRows([]); setImportHeaders([]); setImportAudit(null); setUploadName(""); setImportMessage(""); }}><HardDrive size={16} /> Excel / CSV upload</button>
              <button className={importMode === "sheets" ? "import-tab active" : "import-tab"} onClick={() => { setImportMode("sheets"); clearMlComparison(); setImportRows([]); setImportHeaders([]); setImportAudit(null); setUploadName(""); setImportMessage(""); }}><Database size={16} /> Google Sheets</button>
            </div>
            {importMode === "excel" ? <div className="import-card">
              <div className="upload-drop"><div className="upload-icon"><Download size={22} /></div><h3>Upload charging log</h3><p>Choose an .xlsx, .xls or .csv file. The first worksheet is used for the initial preview.</p><label className="button primary upload-button">Choose file<input type="file" accept=".xlsx,.xls,.csv" onChange={e => { const file = e.target.files?.[0]; if (file) void handleFileUpload(file); e.currentTarget.value = ""; }} /></label><span className="upload-filename">{uploadName || "No file selected"}</span></div>
            </div> : <div className="import-card sheets-form">
              <div className="form-field"><label>Spreadsheet ID or URL</label><input value={sheetId} onChange={e => setSheetId(e.target.value)} placeholder="Paste Google Sheets URL or spreadsheet ID" /></div>
              <div className="form-field"><label>Sheet tab and range</label><input value={sheetRange} onChange={e => setSheetRange(e.target.value)} placeholder="'Charging Log'!A1:Z5000" /></div>
              <div className="connection-note"><ShieldCheck size={16} /><span>Connection uses server-side credentials. Share the sheet with the configured service-account email; never paste credentials into this page.</span></div>
              <button className="button primary" disabled={sheetLoading} onClick={handleSheetPreview}>{sheetLoading ? <RefreshCw size={15} className="spin" /> : <Database size={15} />}{sheetLoading ? "Connecting…" : "Connect and preview"}</button>
            </div>}
            {importMessage && <div className="import-message"><CircleDot size={15} /><span>{importMessage}</span></div>}
            {importAudit && <div className="audit-summary">
              <div className="audit-summary-head"><div><h3>First-pass data-quality audit</h3><p>Flags are review candidates, not automatic corrections.</p></div><span className="quality-badge review"><span />Human review required</span></div>
              <div className="audit-metric-grid">
                <div><span>Rows inspected</span><strong>{importAudit.rowCount.toLocaleString()}</strong></div>
                <div><span>Raw truck IDs</span><strong>{importAudit.truckIdCount}</strong></div>
                <div><span>Missing truck IDs</span><strong>{importAudit.missingTruckId}</strong></div>
                <div><span>Invalid dates</span><strong>{importAudit.invalidDate}</strong></div>
                <div><span>Invalid odometers</span><strong>{importAudit.invalidOdometer}</strong></div>
                <div><span>Duplicate candidates</span><strong>{importAudit.duplicateCandidates}</strong></div>
                <div><span>Future dates</span><strong>{importAudit.futureDates}</strong></div>
                <div><span>Non-canonical ID formats</span><strong>{importAudit.nonCanonicalIds}</strong></div>
                <div><span>Odometer decreases</span><strong>{importAudit.decreasingOdometer}</strong></div>
              </div>
              <p className="audit-caution">Keep the original source values. Confirm truck-ID aliases and investigate every flagged reading before accepting records into the maintenance database.</p>
            </div>}
            {importRows.length > 0 && <div className="import-preview">
              <div className="panel-header"><div><h2>Source preview</h2><p>First 8 rows shown · original values preserved</p></div><span className="quality-badge review"><span />Needs validation</span></div>
              <div className="table-scroll"><table><thead><tr>{importHeaders.slice(0, 7).map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{importRows.slice(0, 8).map((row, i) => <tr key={i}>{importHeaders.slice(0, 7).map(h => <td key={h}>{String(row[h] ?? "")}</td>)}</tr>)}</tbody></table></div>
              <div className="import-actions"><span>Save preserves source rows for review only; it does not approve readings or update truck odometers.</span><div className="import-action-buttons"><button className="button secondary" onClick={() => { clearMlComparison(); setImportRows([]); setImportHeaders([]); setImportAudit(null); setImportMessage(""); setUploadName(""); }}>Clear preview</button><button className="button primary" disabled={!plannerSignedIn || saveLoading || importRows.length > 10000} onClick={saveImportBatch}>{saveLoading ? <RefreshCw size={14} className="spin" /> : <Database size={14} />}{saveLoading ? "Saving…" : "Save batch for review"}</button></div></div>
            </div>}
            <div className="import-history panel"><div className="panel-header"><div><h2>Recent import batches</h2><p>Persistent history is visible to the authorized planner only.</p></div><button className="button secondary" onClick={loadImportBatches} disabled={!plannerSignedIn}><RefreshCw size={14} /> Refresh</button></div>
              {!plannerSignedIn ? <p className="history-empty">Sign in to view saved import history.</p> : importBatches.length === 0 ? <p className="history-empty">No saved batches loaded yet. Save a reviewed preview to create the first batch.</p> : <div className="table-scroll"><table><thead><tr><th>Source</th><th>Started</th><th>Rows</th><th>Flagged</th><th>Rejected</th><th>Status</th></tr></thead><tbody>{importBatches.map((batch, i) => <tr key={String(batch.id ?? i)}><td>{String(batch.source_name ?? "—")}</td><td>{batch.started_at ? new Date(String(batch.started_at)).toLocaleString() : "—"}</td><td>{String(batch.row_count ?? 0)}</td><td>{String(batch.flagged_count ?? 0)}</td><td>{String(batch.rejected_count ?? 0)}</td><td><span className="quality-badge review"><span />{String(batch.status ?? "unknown")}</span></td></tr>)}</tbody></table></div>}
            </div>
            <div className="data-readiness">
              <div><strong>Authoritative fleet list</strong><span>30 IDs expected · mapping not yet approved</span></div>
              <div><strong>Service history</strong><span>Partial · last-service baseline required per truck</span></div>
              <div><strong>PM sequence</strong><span>PM1 = 5,000 km; each next PM adds 10,000 km</span></div>
              <div><strong>Calendar interval</strong><span>Due on whichever comes first: PM threshold or approved calendar limit</span></div>
            </div>
          </section>}

          {active !== "overview" && active !== "data" && active !== "predictions" && <section className="panel placeholder-page">
            <div className="placeholder-icon">{(() => { const Icon = nav.find(n => n.key === active)?.icon ?? LayoutDashboard; return <Icon size={28} />; })()}</div>
            <div className="eyebrow">{active === "fleet" ? "SOURCE-DERIVED FLEET REGISTER" : active === "reports" ? "SOURCE REPORTS" : active === "analytics" ? "DATA ANALYTICS" : "WORKSPACE STATUS"}</div>
            <h2>{pageTitle}</h2>
            {active === "fleet" && <>
              <p>Only canonical truck IDs found in the current uploaded or previewed source are listed. Imported IDs and odometers are not marked operationally approved.</p>
              {trucks.length ? <div className="module-list">{trucks.filter(truck => truck.id.toLowerCase().includes(search.toLowerCase())).map(truck => <button key={truck.id} onClick={() => setSelected(truck)}><Truck size={16} /><strong>{truck.id}</strong><span>{truck.latestOdometer === null ? "Odometer unavailable" : `${compact(truck.latestOdometer)} km`}</span><ChevronRight size={15} /></button>)}</div> : <div className="empty-state">No truck register is loaded. Upload a charging log in Data Quality to discover IDs from the source.</div>}
            </>}
            {active === "analytics" && <>
              <p>Metrics below are calculated from the current source preview only. They are not a trained model evaluation.</p>
              <div className="audit-metric-grid"><div><span>Rows in preview</span><strong>{importAudit?.rowCount.toLocaleString() ?? "—"}</strong></div><div><span>Raw truck IDs</span><strong>{importAudit?.truckIdCount ?? "—"}</strong></div><div><span>Invalid dates</span><strong>{importAudit?.invalidDate ?? "—"}</strong></div><div><span>Invalid odometers</span><strong>{importAudit?.invalidOdometer ?? "—"}</strong></div><div><span>Duplicate candidates</span><strong>{importAudit?.duplicateCandidates ?? "—"}</strong></div><div><span>Usage days derived</span><strong>{utilizationSeries.length}</strong></div></div>
            </>}
            {active === "reports" && <>
              <p>Export the current source preview and its first-pass quality summary. The report records the preview only; it does not certify the readings or service rules.</p>
              <button className="button primary" onClick={exportDataReport} disabled={!importRows.length}><Download size={15} /> Export source and audit report (.xlsx)</button>
              {!importRows.length && <div className="empty-state">Load a charging log in Data Quality to enable report export.</div>}
            </>}
            {(active === "calendar" || active === "workorders") && <>
              <p>This workspace is intentionally empty until approved maintenance records are connected. No appointments or work orders are fabricated.</p>
              <div className="empty-state">No {active === "calendar" ? "saved maintenance appointments" : "work orders"} are available yet. First establish the authoritative fleet register and verified maintenance history.</div>
              <button className="button secondary" onClick={() => setActive("data")}><Database size={15} /> Open Data Quality</button>
            </>}
          </section>}
          <footer className="page-footer"><span>TONLY Predictive Maintenance Intelligence <span className="footer-dot">•</span> Release v1.0.0</span><span>Source-derived data only; no fleet demo records are preloaded <span className="footer-dot">•</span> English / 中文</span></footer>
        </div>
      </section>

      {selected && <div className="modal-backdrop" onClick={() => setSelected(null)}>
        <section className="truck-drawer" onClick={e => e.stopPropagation()}>
          <div className="drawer-top"><div><span className="eyebrow">ASSET PROFILE</span><h2>{selected.id}</h2><p>TONLY electric mining truck</p></div><button className="icon-button" onClick={() => setSelected(null)}>×</button></div>
          <div className="drawer-status"><span className={`quality-badge ${selected.dataQuality.toLowerCase()}`}><span />{selected.dataQuality} data</span><span className={`priority-badge ${selected.prediction.priority.toLowerCase()}`}>{selected.prediction.priority} priority</span></div>
          <div className="drawer-kpis"><div><span>Latest odometer</span><strong>{selected.latestOdometer === null ? "—" : `${compact(selected.latestOdometer)} km`}</strong></div><div><span>{selected.prediction.overdueKm && selected.prediction.overdueKm > 0 ? "Past selected threshold" : "Remaining to threshold"}</span><strong>{selected.prediction.remainingKm === null ? "—" : selected.prediction.overdueKm && selected.prediction.overdueKm > 0 ? `${compact(selected.prediction.overdueKm)} km overdue` : `${compact(selected.prediction.remainingKm)} km`}</strong></div></div>
          <div className="drawer-section"><h3>Next service forecast</h3><div className="drawer-date">{formatDate(selected.prediction.forecastDate ?? undefined)}</div><p>{selected.prediction.explanation}</p></div>
          <div className="drawer-section"><h3>Prediction inputs</h3><div className="detail-line"><span>Selected PM type</span><strong>{selectedPmType}</strong></div><div className="detail-line"><span>Odometer threshold</span><strong>{activeRule.kilometreThreshold?.toLocaleString()} km</strong></div><div className="detail-line"><span>Calendar interval</span><strong>Not configured</strong></div><div className="detail-line"><span>Rule status</span><strong className="warning-text">Needs approved rule</strong></div><div className="detail-line"><span>Prediction method</span><strong>Usage baseline</strong></div><div className="detail-line"><span>Model confidence</span><strong>Not calibrated</strong></div></div>
          <div className="drawer-warning"><AlertTriangle size={16} /><span>Confirm the last completed service date and odometer, and verify the approved OEM interval before creating a maintenance appointment.</span></div>
          <button className="button primary full-button" onClick={() => { setSelected(null); setActive("calendar"); }}><CalendarDays size={16} /> Plan maintenance</button>
        </section>
      </div>}
    </main>
  );
}
