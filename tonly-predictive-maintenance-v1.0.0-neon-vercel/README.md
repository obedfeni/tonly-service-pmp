# TONLY Predictive Maintenance Intelligence Platform v1.0.0

A single Next.js application for Vercel, a Neon PostgreSQL database, and a server-side Python model-compute function deployed as a Vercel Function in the same project. There is no Vercel multi-service configuration and no separate Render deployment.

## What is included

- Existing TONLY dashboard and data-preview UI retained from v0.9.0.
- Single-planner authentication using a server-side scrypt password hash and signed, HttpOnly session cookie.
- Neon PostgreSQL persistence for import batches, source rows, truck/service baselines, provisional forecasts, model runs, and audit events.
- XLSX/CSV file preview and controlled import batches. Imports are saved for review; they do not automatically become approved odometer history.
- Optional read-only Google Sheets preview using a service account.
- Python Random Forest and XGBoost usage-rate forecasting, with chronological holdout validation and comparison against the median-rate baseline.
- PM milestones: PM1 = 5,000 km, PM2 = 15,000 km, PM3 = 25,000 km, then +10,000 km per PM. Approved calendar intervals remain required and the earlier kilometre/calendar trigger wins.
- Guardrails: suspect odometer jumps block forecasting; ML methods cannot be selected unless validation beats the baseline; forecasts remain provisional.
- GitHub Actions for lint, TypeScript, JavaScript checks, Python tests, and production build.

## Architecture

```text
GitHub main branch
        |
        v
Vercel project (Next.js + Node.js API routes + Python function)
        |                              |
        |                              +-- Python RF/XGBoost compute function
        |
        +-- Neon PostgreSQL
```

Vercel supports Python functions in the root `api/` directory alongside a Next.js application. The `api/ml_compute.py` function is protected by `ML_API_SECRET`; the authenticated Next.js route calls it. The Python source module is stored under `python/` so it is not exposed as a second function. See Vercel's Python runtime documentation: https://vercel.com/docs/functions/runtimes/python

## Requirements

- GitHub repository connected to Vercel.
- Neon PostgreSQL project.
- Node.js 22 for local checks.
- Python 3.12 for model tests and local ML checks.
- Vercel CLI for local testing of the Python function (`vercel dev`).

## Deployment: simplest supported path

### 1. Create the Neon database

1. Create a Neon project and database.
2. Open the Neon SQL Editor.
3. Run the entire `db/schema.sql` file once against a new, empty database.
4. Copy the pooled connection string if offered, with TLS enabled. It must be a PostgreSQL URL, normally containing `sslmode=require`.

The application uses only server-side Neon credentials. Never expose `DATABASE_URL` in a `NEXT_PUBLIC_` variable.

### 2. Prepare the planner password

Use a terminal in the repository root:

```bash
node scripts/create-password-hash.cjs
```

Store the generated `salt:hash` output as `PLANNER_PASSWORD_HASH`. Do not put the actual planner password in GitHub or Vercel environment variables.

Generate two separate random secrets. For example, with OpenSSL:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

Use the first for `SESSION_SECRET` and the second for `ML_API_SECRET`. Do not reuse secrets.

### 3. Configure Vercel environment variables

In **Vercel → Project → Settings → Environment Variables**, set these for Preview and Production as appropriate:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Neon PostgreSQL connection string |
| `PLANNER_EMAIL` | Yes | One authorized planner email address |
| `PLANNER_PASSWORD_HASH` | Yes | Output of the password-hash command |
| `SESSION_SECRET` | Yes | Random secret, at least 32 bytes |
| `ML_API_SECRET` | Yes | Separate random secret shared only between the two server-side functions |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Optional | Google service-account email for Sheets preview |
| `GOOGLE_PRIVATE_KEY` | Optional | Corresponding private key; store server-side only |

Do not configure `ML_API_URL`, Supabase variables, or Render variables. Those are not part of v1.0.0.

### 4. Configure the Vercel project

- Framework Preset: **Next.js**
- Root Directory: the directory containing this README and `package.json` (normally `tonly-predictive-maintenance-v1.0.0` if the repository has the versioned project folder)
- Do **not** choose “Import multi-service project.”
- Do not add service bindings or rewrite rules.
- `vercel.json` configures the Python compute function duration; the frontend remains the normal Next.js application.

Commit and push the files to GitHub. Vercel will build the Next.js application and its `api/ml_compute.py` Python function in the same project.

### 5. Verify the deployment

After deployment, open `/api/health`. Confirm `neonConfigured`, `databaseReachable`, `plannerConfigured`, and `mlComputeConfigured` are true. This health endpoint verifies connectivity/configuration only; it does not certify model accuracy.

Then:
1. Sign in under **Data Quality** with the configured planner email and password.
2. Upload a real charging log or preview the authorized Google Sheet.
3. Review the quality flags and latest odometer before using the model comparison.
4. Enter the verified last-service date, odometer, approved calendar interval, PM-rule source, and service evidence reference.
5. Run the RF/XGBoost comparison and inspect chronological holdout MAE.
6. Save only an eligible forecast as provisional. Imported rows are not promoted to approved operational odometer readings automatically.

## Local checks

Install dependencies:

```bash
npm install
python -m pip install -r requirements.txt
python -m pip install -r tests/python/requirements-test.txt
```

Run checks:

```bash
npm run lint
npm run typecheck
npm run test:config
npm run test:forecast
python -m pytest tests/python -q
npm run build
```

For local end-to-end tests of the Python function, use the Vercel CLI rather than `next dev` alone:

```bash
npm install --global vercel
vercel dev
```

`next dev` is still suitable for frontend-only work, but it does not run the root Python function in the same way as Vercel.

## Model scope and validation policy

Random Forest and XGBoost estimate future odometer usage rate (km/day). They do **not** predict component failures. The application reports MAE on a chronological holdout and compares it to a median-rate baseline. A model that does not beat that baseline is not eligible for forecast selection. A high percentage accuracy target cannot be guaranteed in advance; accuracy must be measured against actual future outcomes over representative data and time windows.

The previously supplied charging log produced 191 usable training examples after filtering, with a 39-example chronological holdout. In that evaluation the median baseline MAE was about 101.07 km/day, Random Forest about 105.90 km/day, and XGBoost about 111.27 km/day. Those results are a warning that the models were not yet operationally superior on that dataset; the eligibility guardrail must remain enabled.

## Security and operational notes

- All database queries are server-side and parameterized.
- Planner session cookies are HttpOnly, SameSite=Lax, and Secure in production.
- Keep `.env.local` out of Git; `.gitignore` excludes local environment files.
- If any prior Supabase service-role credential was exposed in chat or committed, rotate it. v1.0.0 no longer requires Supabase credentials.
- Do not treat saved forecasts as approved work orders or use them as the sole safety decision for maintenance.
- A green CI run does not replace live end-to-end testing with the actual Neon database and Vercel deployment.
