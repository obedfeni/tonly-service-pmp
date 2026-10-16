# v1.0.0 Deployment Checklist

## Neon
- [ ] Create a new Neon database.
- [ ] Apply `db/schema.sql` once to the empty database.
- [ ] Set `DATABASE_URL` in Vercel for Preview and Production.
- [ ] Confirm `/api/health` reports `databaseReachable: true`.

## Planner authentication
- [ ] Generate `PLANNER_PASSWORD_HASH` with `node scripts/create-password-hash.cjs`.
- [ ] Set `PLANNER_EMAIL`, `PLANNER_PASSWORD_HASH`, and a unique `SESSION_SECRET` in Vercel.
- [ ] Confirm the planner can sign in and sign out.
- [ ] Confirm unauthenticated requests to `/api/imports`, `/api/predictions`, and `/api/ml/forecast` return 401.

## ML compute
- [ ] Set a unique `ML_API_SECRET` in Vercel.
- [ ] Confirm the `api/ml_compute.py` function is included in the deployment logs.
- [ ] Confirm `/api/ml/forecast` invokes the Python function and saves an `ml_model_runs` record in Neon.
- [ ] Confirm Random Forest/XGBoost options remain disabled unless the model beats the median baseline on chronological holdout data.

## Vercel
- [ ] Framework is Next.js.
- [ ] Root Directory contains `package.json`, `app/`, `api/`, `python/`, and `db/`.
- [ ] Do not import as a Vercel multi-service project.
- [ ] Do not configure Render or `ML_API_URL`.
- [ ] Run GitHub Actions and review all failures before production promotion.

## Live acceptance
- [ ] `/api/health` returns expected configuration status.
- [ ] Planner login works.
- [ ] XLSX/CSV preview works.
- [ ] Source import creates a batch and source rows in Neon, still marked for review.
- [ ] Suspicious latest odometer readings block forecasting.
- [ ] RF/XGBoost comparison runs on the real uploaded dataset.
- [ ] A baseline forecast can be saved with evidence and approval confirmation.
- [ ] A non-baseline model forecast is rejected unless its saved model run is eligible and matches the input snapshot.
