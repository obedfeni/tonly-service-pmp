# Data Import Setup

1. Sign in under **Data Quality** using the single planner account configured in Vercel.
2. Upload an Excel/CSV charging log or use the optional Google Sheets preview integration.
3. Review detected columns, truck IDs, invalid/future dates, duplicate candidates, decreasing odometer values, and implausible usage-rate jumps.
4. Save a source batch for review. This stores the raw rows and flags in Neon; it does not approve them or automatically update the authoritative odometer history.
5. Use canonical truck IDs (`ET001` through `ET030`, as applicable to the real fleet) and resolve aliases only with evidence.
6. For forecasting, select a truck and PM sequence, enter the verified last-service date and odometer, enter the approved calendar interval, and record both PM-rule source and service-evidence references.
7. Run Random Forest/XGBoost comparison. Inspect chronological holdout metrics before selecting a method.

## Google Sheets

Optional environment variables: `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY`. Share the source spreadsheet with the service account as a viewer. The app requests read-only Sheets access. If these variables are not configured, file upload remains available.

Never put database credentials, session secrets, the ML shared secret, or Google service-account private keys in `NEXT_PUBLIC_` variables or commit them to GitHub.
