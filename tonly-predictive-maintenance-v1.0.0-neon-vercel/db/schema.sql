-- TONLY Predictive Maintenance v1.0.0 — Neon PostgreSQL schema.
-- Apply once to a new Neon database using the Neon SQL Editor.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE TYPE truck_status AS ENUM ('operating','available','workshop','down','unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE data_quality_status AS ENUM ('good','review','rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE prediction_status AS ENUM ('provisional','approved','superseded','evaluated'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE appointment_status AS ENUM ('draft','pending_approval','approved','published','completed','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS trucks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), truck_code text NOT NULL UNIQUE CHECK (truck_code ~ '^ET[0-9]{3}$'), make text NOT NULL DEFAULT 'TONLY', model text, commissioned_on date,
 status truck_status NOT NULL DEFAULT 'unknown', active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS service_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rule_code text NOT NULL, service_name text NOT NULL, pm_sequence integer CHECK (pm_sequence > 0), target_odometer_km numeric(12,1) CHECK (target_odometer_km > 0),
 kilometre_interval numeric(12,1) CHECK (kilometre_interval > 0), calendar_interval_days integer CHECK (calendar_interval_days > 0), due_logic text NOT NULL DEFAULT 'whichever_first' CHECK (due_logic = 'whichever_first'),
 effective_from date NOT NULL, effective_to date, source_reference text, verified_by text, verified_at timestamptz, is_active boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (target_odometer_km IS NOT NULL OR kilometre_interval IS NOT NULL OR calendar_interval_days IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS service_rules_active_idx ON service_rules(rule_code,is_active,effective_from DESC);
CREATE TABLE IF NOT EXISTS truck_service_baselines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), truck_id uuid NOT NULL REFERENCES trucks(id), service_rule_id uuid NOT NULL REFERENCES service_rules(id), last_service_date date NOT NULL,
 last_service_odometer_km numeric(12,1) NOT NULL CHECK(last_service_odometer_km>=0), source_reference text NOT NULL, verified_by text NOT NULL, verified_at timestamptz NOT NULL,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(truck_id,service_rule_id)
);
CREATE TABLE IF NOT EXISTS import_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_name text NOT NULL, source_range text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 row_count integer NOT NULL DEFAULT 0, accepted_count integer NOT NULL DEFAULT 0, flagged_count integer NOT NULL DEFAULT 0, rejected_count integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'started', error_summary text, initiated_by text
);
CREATE TABLE IF NOT EXISTS import_rows (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), import_batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE, source_row_number integer NOT NULL CHECK(source_row_number>0),
 source_fingerprint text NOT NULL, raw_source_row jsonb NOT NULL, mapped_truck_code text, resolved_truck_id uuid REFERENCES trucks(id), observed_at timestamptz,
 odometer_km numeric(12,1) CHECK(odometer_km IS NULL OR odometer_km>=0), quality_status data_quality_status NOT NULL DEFAULT 'review', quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
 review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','accepted','rejected')), reviewed_by text, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(import_batch_id,source_row_number), CHECK((review_status='accepted' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL) OR review_status<>'accepted')
);
CREATE INDEX IF NOT EXISTS import_rows_batch_status_idx ON import_rows(import_batch_id,review_status,quality_status);
CREATE TABLE IF NOT EXISTS ml_model_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), truck_id uuid REFERENCES trucks(id) ON DELETE SET NULL, truck_code text NOT NULL CHECK(truck_code ~ '^ET[0-9]{3}$'),
 pm_type text NOT NULL CHECK(pm_type ~ '^PM([1-9]|10)$'), source_name text, model_version text NOT NULL, status text NOT NULL, training_examples integer NOT NULL DEFAULT 0 CHECK(training_examples>=0),
 validation_metrics jsonb NOT NULL DEFAULT '{}'::jsonb, result jsonb NOT NULL, input_snapshot jsonb NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ml_model_runs_truck_created_idx ON ml_model_runs(truck_code,created_at DESC);
CREATE TABLE IF NOT EXISTS predictions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), truck_id uuid NOT NULL REFERENCES trucks(id), service_rule_id uuid NOT NULL REFERENCES service_rules(id), generated_at timestamptz NOT NULL DEFAULT now(),
 forecast_date date, earliest_date date, latest_date date, forecast_odometer_km numeric(12,1), remaining_km numeric(12,1), days_until_due integer, method text NOT NULL, model_version text NOT NULL,
 status prediction_status NOT NULL DEFAULT 'provisional', confidence_score numeric(5,4), explanation jsonb NOT NULL DEFAULT '{}'::jsonb, input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_by text, supersedes_prediction_id uuid REFERENCES predictions(id)
);
CREATE INDEX IF NOT EXISTS predictions_truck_generated_idx ON predictions(truck_id,generated_at DESC);
CREATE TABLE IF NOT EXISTS audit_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor text NOT NULL DEFAULT 'system', action text NOT NULL, entity_type text NOT NULL, entity_id uuid, before_state jsonb, after_state jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS odometer_readings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), truck_id uuid NOT NULL REFERENCES trucks(id), observed_at timestamptz NOT NULL, odometer_km numeric(12,1) NOT NULL CHECK(odometer_km>=0),
 source text NOT NULL DEFAULT 'google_sheets', source_row_key text, import_batch_id uuid REFERENCES import_batches(id), quality_status data_quality_status NOT NULL DEFAULT 'review',
 quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb, reviewed_by text, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(truck_id,observed_at,odometer_km)
);
CREATE TABLE IF NOT EXISTS maintenance_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), truck_id uuid NOT NULL REFERENCES trucks(id), service_rule_id uuid REFERENCES service_rules(id), completed_at timestamptz NOT NULL,
 odometer_km numeric(12,1) CHECK(odometer_km IS NULL OR odometer_km>=0), work_order_number text, work_description text, technician_hours numeric(8,2), source text NOT NULL DEFAULT 'manual',
 verified boolean NOT NULL DEFAULT false, notes text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS appointments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), truck_id uuid NOT NULL REFERENCES trucks(id), prediction_id uuid REFERENCES predictions(id), service_rule_id uuid NOT NULL REFERENCES service_rules(id),
 planned_start timestamptz NOT NULL, planned_end timestamptz, shift_name text, bay_code text, assigned_team text, estimated_technician_hours numeric(8,2), status appointment_status NOT NULL DEFAULT 'draft',
 approved_by text, approved_at timestamptz, published_at timestamptz, schedule_version integer NOT NULL DEFAULT 1, notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(planned_end IS NULL OR planned_end>planned_start)
);
CREATE TABLE IF NOT EXISTS work_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), appointment_id uuid REFERENCES appointments(id), truck_id uuid NOT NULL REFERENCES trucks(id), work_order_number text NOT NULL UNIQUE,
 job_description text NOT NULL, action_taken text, status text NOT NULL DEFAULT 'planned', estimated_hours numeric(8,2), actual_hours numeric(8,2), opened_at timestamptz, completed_at timestamptz,
 completion_odometer_km numeric(12,1), completed_by text, notes text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS prediction_evaluations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), prediction_id uuid NOT NULL REFERENCES predictions(id), actual_service_date date, actual_service_odometer_km numeric(12,1), date_error_days integer,
 odometer_error_km numeric(12,1), evaluated_at timestamptz NOT NULL DEFAULT now(), evaluation_notes text
);
