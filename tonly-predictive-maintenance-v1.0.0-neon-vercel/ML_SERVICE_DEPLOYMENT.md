# ML Compute Deployment (v1.0.0)

There is no separate ML service to deploy. Random Forest and XGBoost run through `api/ml_compute.py`, a Python Vercel Function in the same GitHub repository and Vercel project as the Next.js application.

The authenticated Next.js route `/api/ml/forecast` calls the Python function at `/api/ml_compute` using the server-only `ML_API_SECRET`. The Python function validates the request, fits/evaluates models from the submitted source rows, and returns the model comparison. The Next.js route stores the result and its input snapshot in Neon.

Set `ML_API_SECRET` in Vercel Environment Variables. Do not set `ML_API_URL`; do not deploy Render; do not configure Vercel Services or service bindings. Use `vercel dev` for local end-to-end testing because `next dev` alone does not run the Python function.
