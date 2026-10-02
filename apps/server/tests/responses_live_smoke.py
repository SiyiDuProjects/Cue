"""Explicit opt-in, one Luna connection request, synthetic text only, no retries."""
import asyncio
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if os.getenv("SAGE_ALLOW_LIVE_TEST") != "1":
    raise SystemExit("This test requires explicit user authorization and SAGE_ALLOW_LIVE_TEST=1.")
from app.config import get_settings
from app.services.openai_realtime import InterviewRuntime


async def main():
    settings = replace(get_settings(), openai_responses_model="gpt-6-luna", openai_responses_max_output_tokens=4096)
    if not settings.openai_api_key:
        raise SystemExit("No existing backend key configured.")
    rt = InterviewRuntime(interview_id="luna-api-connection", session_token="synthetic", capture_token="synthetic",
                          expires_at=datetime.now(timezone.utc)+timedelta(minutes=5))
    rt.operations["connection"] = {"operation_id": "connection", "kind": "chat_send", "status": "accepted"}
    started = time.monotonic()
    try:
        with patch("app.services.codex_chat.get_settings", return_value=settings), patch("app.services.responses_chat.get_settings", return_value=settings):
            await rt.chat.request("This is a synthetic connection check. Do not read any personal materials. Reply only: SAGE_RESPONSES_OK followed by the value of 17+25.",
                                  "connection", selected=[], provider="responses")
        record = {"model": "gpt-6-luna", "status": rt.operations["connection"]["status"],
                  "elapsed_ms": round((time.monotonic()-started)*1000), "first_text_ms": rt.metrics.get("chat_first_text_ms"),
                  "text": rt.response_buffers.get("chat:connection", ""), "detail": rt.response_details.get("chat:connection", ""),
                  "test_scope": "One explicitly authorized text-only connection request. No personal data or audio."}
        output = Path(__file__).resolve().parents[3] / "artifacts" / "responses-mcp" / "luna-connection.json"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(record, ensure_ascii=True))
        if record["status"] != "completed" or "42" not in record["text"]:
            raise SystemExit(1)
    finally:
        await rt.close()


asyncio.run(main())
