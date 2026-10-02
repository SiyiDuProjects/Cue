"""Real server and browser pairing, synthetic desktop media, no provider calls."""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
CONTEXT = ROOT / "artifacts/device-connection/context"
CONTEXT.mkdir(parents=True, exist_ok=True)
os.environ.update(OPENAI_API_KEY="offline-placeholder", OPENAI_BASE_URL="http://127.0.0.1:1/v1",
                  INTERVIEW_ACCESS_TOKEN="device-audit", INTERVIEW_CONTEXT_DIR=str(CONTEXT))
sys.path.insert(0, str(ROOT / "apps/server"))
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from app.main import app as production_app
from app.services import openai_realtime as rt

async def no_provider(**kwargs):
    raise AssertionError("Provider calls are forbidden in device tests")
rt._connect_openai_realtime = no_provider
app = FastAPI()

@app.get("/__device/host")
async def host():
    html = (ROOT / "apps/desktop/dist/index.html").read_text(encoding="utf-8")
    fixture = (ROOT / "apps/desktop/tests/device-host-fixture.js").read_text(encoding="utf-8")
    return HTMLResponse(html.replace("<head>", '<head><base href="/"><script>' + fixture + '</script>'))

@app.get("/__device/state")
async def state():
    current = await rt.get_interview_registry().current()
    return {"connected": bool(current and current._capture_clients),
            "model_connections": int(bool(current and current.main_upstream)) + int(bool(current and current.candidate_upstream)),
            "active": bool(current and current.active)}

app.mount("/", production_app)
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ["AUDIT_PORT"]), log_level="warning")
