import "server-only";
import { neon } from "@neondatabase/serverless";

let cached: ReturnType<typeof neon> | undefined;

export function getDb() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is not configured. Add the Neon connection string in Vercel Environment Variables.");
  if (!cached) cached = neon(connectionString);
  return cached;
}

export async function queryRows<T extends Record<string, unknown> = Record<string, unknown>>(
  statement: string,
  params: unknown[] = [],
): Promise<T[]> {
  const db = getDb();
  const result = await db.query(statement, params);
  return result as T[];
}

const JSON_COLUMNS = new Set(["raw_source_row", "quality_flags", "explanation", "input_snapshot", "validation_metrics", "result", "after_state", "before_state"]);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;
function ident(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Unsafe database identifier: ${value}`);
  return `"${value}"`;
}
function columns(value: string): string {
  if (value.trim() === "*") return "*";
  return value.split(",").map((part) => {
    const column = part.trim();
    if (!IDENTIFIER.test(column)) throw new Error(`Unsafe selected column: ${column}`);
    return ident(column);
  }).join(",");
}
export type DbResult<T = any> = { data: T | null; error: { message: string } | null };
class NeonQueryBuilder {
  private operation: "select" | "insert" | "update" | "upsert" = "select";
  private selected = "*";
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private conditions: { column: string; operator: "=" | "IN"; value: unknown }[] = [];
  private ordering: { column: string; ascending: boolean } | null = null;
  private rowLimit: number | null = null;
  private conflictColumns: string[] = [];
  private singleMode: "single" | "maybeSingle" | null = null;
  private returning = false;
  constructor(private readonly table: string) { ident(table); }
  select(value = "*") { this.selected = columns(value); this.returning = this.operation !== "select"; return this; }
  insert(value: Record<string, unknown> | Record<string, unknown>[]) { this.operation = "insert"; this.payload = value; return this; }
  update(value: Record<string, unknown>) { this.operation = "update"; this.payload = value; return this; }
  upsert(value: Record<string, unknown>, options?: { onConflict?: string }) { this.operation = "upsert"; this.payload = value; this.conflictColumns = (options?.onConflict ?? "").split(",").map(x=>x.trim()).filter(Boolean); return this; }
  eq(column: string, value: unknown) { if (!IDENTIFIER.test(column)) throw new Error("Invalid filter column."); this.conditions.push({column,operator:"=",value}); return this; }
  in(column: string, value: unknown[]) { if (!IDENTIFIER.test(column)) throw new Error("Invalid filter column."); this.conditions.push({column,operator:"IN",value}); return this; }
  order(column: string, options?: { ascending?: boolean }) { if (!IDENTIFIER.test(column)) throw new Error("Invalid order column."); this.ordering={column,ascending:options?.ascending??true}; return this; }
  limit(value: number) { if (!Number.isInteger(value)||value<0||value>10000) throw new Error("Invalid query limit."); this.rowLimit=value; return this; }
  single() { this.singleMode="single"; return this; }
  maybeSingle() { this.singleMode="maybeSingle"; return this; }
  private async execute(): Promise<DbResult<any>> {
    try {
      const params: unknown[]=[];
      const bind=(value: unknown, column?: string) => { params.push(value !== null && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value); const index=params.length; return `$${index}${column && JSON_COLUMNS.has(column) ? "::jsonb" : ""}`; };
      let statement = "";
      const where = () => this.conditions.map((condition) => {
        if (condition.operator === "IN") {
          const values = Array.isArray(condition.value) ? condition.value : [];
          if (!values.length) return "FALSE";
          return `${ident(condition.column)} IN (${values.map(v=>bind(v)).join(",")})`;
        }
        return `${ident(condition.column)} = ${bind(condition.value)}`;
      }).join(" AND ");
      if (this.operation === "select") {
        statement=`SELECT ${this.selected} FROM ${ident(this.table)}`;
        const filters=where(); if(filters) statement+=` WHERE ${filters}`;
        if(this.ordering)statement+=` ORDER BY ${ident(this.ordering.column)} ${this.ordering.ascending?"ASC":"DESC"}`;
        if(this.rowLimit!==null)statement+=` LIMIT ${this.rowLimit}`;
      } else if (this.operation === "insert") {
        const records=Array.isArray(this.payload)?this.payload:[this.payload as Record<string,unknown>];
        if(!records.length)throw new Error("Cannot insert an empty record list.");
        const keys=Object.keys(records[0]??{}); if(!keys.length)throw new Error("Cannot insert an empty record.");
        if(records.some(r=>Object.keys(r).join("\u0000")!==keys.join("\u0000")))throw new Error("Bulk insert records must have identical columns.");
        statement=`INSERT INTO ${ident(this.table)} (${keys.map(ident).join(",")}) VALUES ${records.map(record=>`(${keys.map(key=>bind(record[key],key)).join(",")})`).join(",")}`;
        if(this.returning)statement+=` RETURNING ${this.selected}`;
      } else if (this.operation === "update") {
        const record=this.payload as Record<string,unknown>; const keys=Object.keys(record); if(!keys.length)throw new Error("Cannot update an empty record.");
        statement=`UPDATE ${ident(this.table)} SET ${keys.map(key=>`${ident(key)}=${bind(record[key],key)}`).join(",")}`;
        const filters=where(); if(!filters)throw new Error("Refusing to run an UPDATE without a filter."); statement+=` WHERE ${filters}`;
        if(this.returning)statement+=` RETURNING ${this.selected}`;
      } else {
        const record=this.payload as Record<string,unknown>; const keys=Object.keys(record); if(!keys.length||!this.conflictColumns.length)throw new Error("Upsert requires values and onConflict columns.");
        statement=`INSERT INTO ${ident(this.table)} (${keys.map(ident).join(",")}) VALUES (${keys.map(key=>bind(record[key],key)).join(",")}) ON CONFLICT (${this.conflictColumns.map(ident).join(",")}) DO UPDATE SET ${keys.filter(k=>!this.conflictColumns.includes(k)).map(key=>`${ident(key)}=EXCLUDED.${ident(key)}`).join(",")}`;
        if(this.returning)statement+=` RETURNING ${this.selected}`;
      }
      const rows=await queryRows(statement,params);
      if(this.singleMode==="single") { if(rows.length!==1)return {data:null,error:{message:`Expected one row but received ${rows.length}.`}}; return {data:rows[0],error:null}; }
      if(this.singleMode==="maybeSingle") { if(rows.length>1)return {data:null,error:{message:`Expected at most one row but received ${rows.length}.`}}; return {data:rows[0]??null,error:null}; }
      return {data:rows.length?rows:null,error:null};
    } catch(error) { return {data:null,error:{message:error instanceof Error?error.message:"Database query failed."}}; }
  }
  then<TResult1 = DbResult<any>, TResult2 = never>(onfulfilled?: ((value: DbResult<any>) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}
export function createDatabaseCompatibilityClient() { return { from(table: string) { return new NeonQueryBuilder(table); } }; }
