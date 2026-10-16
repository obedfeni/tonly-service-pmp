from __future__ import annotations
import hashlib
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler
from typing import Any
from pydantic import ValidationError
from fastapi import HTTPException
from ml_core import ForecastRequest, forecast_payload

MAX_BODY_BYTES = 2 * 1024 * 1024

class handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self) -> None:
        expected = os.environ.get("ML_API_SECRET", "").strip()
        supplied = self.headers.get("x-ml-secret", "").strip()
        if not expected:
            self._send(503, {"error": "ML_API_SECRET is not configured."})
            return
        if not supplied or not hmac.compare_digest(supplied, expected):
            self._send(401, {"error": "Unauthorized model-compute request."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send(400, {"error": "Invalid Content-Length."})
            return
        if length < 1 or length > MAX_BODY_BYTES:
            self._send(413, {"error": "Request body must be between 1 byte and 2 MB."})
            return
        try:
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
            request = ForecastRequest.model_validate(payload)
            result = forecast_payload(request)
            canonical = json.dumps({"headers": request.headers, "rows": request.rows, "truckId": request.truckId, "pmType": request.pmType, "thresholdKm": request.thresholdKm}, sort_keys=True, separators=(",", ":"), default=str)
            result["requestFingerprint"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
            self._send(200, result)
        except ValidationError as exc:
            self._send(422, {"error": "Forecast request failed schema validation.", "fields": exc.errors(include_input=False)})
        except HTTPException as exc:
            self._send(exc.status_code, {"error": str(exc.detail)})
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send(400, {"error": "Request body must be valid UTF-8 JSON."})
        except Exception as exc:
            print(f"ML compute failed: {type(exc).__name__}")
            self._send(500, {"error": "ML computation failed. Check the Vercel function logs."})

    def log_message(self, format: str, *args: Any) -> None:
        # Avoid logging request payloads, which may contain source data.
        print(f"ML compute request: {format % args}")
