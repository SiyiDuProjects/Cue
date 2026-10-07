"""Explicit desktop answer requests -> subscribed ChatGPT chats. No model calls."""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import secrets
import sqlite3
import time
import uuid

from app.services.event_webhook import CallbackError, body_bytes, callback_url, post_webhook, signed_headers, signing_key
from app.services.interview_materials import InterviewMaterials, digest

PROTOCOL = "2026-07-28"
EVENT = "answer.requested"
principal_context = ContextVar("sage_plugin_principal", default=None)
EVENT_DEFINITION = {
    "name": EVENT,
    "description": "Sage Mac 用户明确按下‘请 ChatGPT 回答’时发生。用 data.request_id 调用 read_interview 读取这一次固定的转录与选定截图；按用户订阅要求在本聊天回答。不会由新语音或截图自动触发。",
    "delivery": ["webhook"],
    "inputSchema": {"type": "object", "properties": {"channel": {"type": "string", "minLength": 1, "maxLength": 64,
        "default": "mac", "description": "在 Sage 中识别本订阅的名称，例如 mac 或 算法练习。"}}, "additionalProperties": False},
    "payloadSchema": {"type": "object", "properties": {
        "request_id": {"type": "string"}, "channel": {"type": "string"},
        "conversation_id": {"type": "string"}, "transcription_id": {"type": "string"},
        "requested_at": {"type": "string"}, "image_count": {"type": "integer"},
        "transcript_count": {"type": "integer"}},
        "required": ["request_id", "channel", "conversation_id", "transcription_id", "requested_at", "image_count", "transcript_count"],
        "additionalProperties": False},
}


def iso(value=None):
    return datetime.fromtimestamp(time.time() if value is None else value, timezone.utc).isoformat().replace("+00:00", "Z")


class EventError(ValueError):
    def __init__(self, message, code=-32602, reason=None):
        super().__init__(message)
        self.code, self.reason = code, reason


class PluginEvents:
    def __init__(self, registry, auth, sender=post_webhook):
        self.registry, self.auth, self.sender = registry, auth, sender
        self.materials = InterviewMaterials(registry)
        self.subscription_lock = asyncio.Lock()
        self.request_lock = asyncio.Lock()
        self.verified = {}
        self.wake = asyncio.Event()
        self.worker = None

    async def database(self, action):
        await self.registry._open_store()
        store = self.registry._store
        if not store:
            raise EventError("ChatGPT 订阅需要可用的持久化存储。", -32603)
        def run():
            with store.connect() as db:
                db.execute("CREATE TABLE IF NOT EXISTS plugin_subscriptions (owner TEXT, id TEXT, body TEXT, PRIMARY KEY(owner,id))")
                db.execute("CREATE TABLE IF NOT EXISTS plugin_event_requests (owner TEXT, id TEXT, subscription TEXT, "
                           "created REAL, status TEXT, attempts INTEGER, due REAL, fingerprint TEXT, event TEXT, body TEXT, "
                           "detail TEXT, PRIMARY KEY(owner,id))")
                db.execute("CREATE INDEX IF NOT EXISTS plugin_event_due ON plugin_event_requests(owner,status,due)")
                return action(db, store)
        return await asyncio.to_thread(run)

    @staticmethod
    def principal(value):
        return value["client_id"] + ":" + value["subject"]

    async def authorized(self, subscription):
        return (subscription["expires"] > time.time() and subscription["deadline"] > time.time()
                and not await self.auth.record("revoked", subscription["grant"]))

    @staticmethod
    def arguments(params):
        arguments = params.get("arguments", {})
        if not isinstance(arguments, dict) or set(arguments) - {"channel"}:
            raise EventError("无效事件筛选条件。")
        channel = arguments.get("channel", "mac")
        if not isinstance(channel, str) or not channel.strip() or len(channel) > 64 or any(ord(c) < 32 for c in channel):
            raise EventError("订阅名称需要 1–64 个字符。")
        return {"channel": channel}

    def identity(self, principal, params, *, subscribe):
        if params.get("name") != EVENT:
            raise EventError("未知事件。")
        arguments = self.arguments(params)
        delivery = params.get("delivery")
        if not isinstance(delivery, dict) or delivery.get("mode") != "webhook":
            raise EventError("仅支持 webhook 投递。")
        try:
            url = callback_url(delivery.get("url"))
            if subscribe:
                signing_key(delivery.get("secret"))
        except CallbackError as exc:
            raise EventError(str(exc), reason=exc.reason) from None
        identity = "sub_" + digest([self.principal(principal), url, EVENT, arguments])
        return identity, arguments, delivery

    async def subscribe(self, principal, params):
        identity, arguments, delivery = self.identity(principal, params, subscribe=True)
        if params.get("cursor") is not None:
            raise EventError("此手动请求事件不支持历史重放，请使用 cursor: null。")
        ttl = params.get("ttlMs", 86400000)
        if ttl is None:
            ttl = 86400000  # Grant a finite lifetime even when infinity is requested.
        if isinstance(ttl, bool) or not isinstance(ttl, int) or ttl <= 0:
            raise EventError("ttlMs 必须是正整数或 null。")
        now = time.time()
        expires = min(now + min(ttl / 1000, 86400), principal["deadline"])
        value = {"id": identity, "principal": self.principal(principal), "grant": principal["grant"],
                 "deadline": principal["deadline"], "arguments": arguments, "url": delivery["url"],
                 "secret": delivery["secret"], "expires": expires, "updated_at": iso(now)}
        async with self.subscription_lock:
            existing = await self.subscription(identity)
            count = await self.database(lambda db, s: db.execute("SELECT count(*) FROM plugin_subscriptions WHERE owner=?", (s.owner,)).fetchone()[0])
            if not existing and count >= 32:
                raise EventError("订阅已达上限，请先取消不用的订阅。")
            key = (value["principal"], value["url"], value["grant"])
            if self.verified.get(key, 0) <= now:
                challenge = secrets.token_urlsafe(32)
                body = body_bytes({"type": "verification", "challenge": challenge})
                event_id = "verify_" + uuid.uuid4().hex
                try:
                    status, response = await self.sender(value["url"], signed_headers(value, event_id, body), body)
                    echoed = json.loads(response).get("challenge")
                    if not 200 <= status < 300 or not isinstance(echoed, str) or not hmac.compare_digest(echoed.encode(), challenge.encode()):
                        raise CallbackError("challenge_failed")
                except (ValueError, AttributeError, UnicodeError) as exc:
                    raise EventError("ChatGPT 回调验证失败，订阅未启用。", -32015,
                                     exc.reason if isinstance(exc, CallbackError) else "challenge_failed") from None
                self.verified = {k: v for k, v in self.verified.items() if v > now}
                self.verified[key] = now + 300
            # Recheck revocation after network I/O and before persisting consent.
            if not await self.authorized(value):
                raise EventError("插件授权已失效，请重新连接。")
            if existing and existing["secret"] != value["secret"]:
                value.update(old_secret=existing["secret"], rotate_until=now + 300)
            elif existing and existing.get("rotate_until", 0) > now:
                value.update(old_secret=existing["old_secret"], rotate_until=existing["rotate_until"])
            await self.database(lambda db, s: db.execute("INSERT OR REPLACE INTO plugin_subscriptions VALUES (?,?,?)",
                                                        (s.owner, identity, json.dumps(value))))
        return {"id": identity, "refreshBefore": iso(expires), "cursor": None, "truncated": False}

    async def subscription(self, identity):
        def get(db, store):
            row = db.execute("SELECT body FROM plugin_subscriptions WHERE owner=? AND id=?", (store.owner, identity)).fetchone()
            return json.loads(row[0]) if row else None
        return await self.database(get)

    async def unsubscribe(self, principal, params):
        identity, _, _ = self.identity(principal, params, subscribe=False)
        async with self.subscription_lock:
            def remove(db, s):
                db.execute("DELETE FROM plugin_subscriptions WHERE owner=? AND id=?", (s.owner, identity))
                db.execute("UPDATE plugin_event_requests SET status='cancelled',detail=? WHERE owner=? AND subscription=? AND status='queued'",
                           ("订阅已取消。", s.owner, identity))
            await self.database(remove)
        return {}

    async def status(self):
        subscriptions = await self.database(lambda db, s: [json.loads(r[0]) for r in db.execute(
            "SELECT body FROM plugin_subscriptions WHERE owner=?", (s.owner,))])
        active = [{"id": s["id"], "channel": s["arguments"]["channel"], "expires_at": iso(s["expires"])}
                  for s in subscriptions if await self.authorized(s)]
        requests = await self.database(lambda db, s: [dict(zip(("id", "subscription_id", "status", "detail", "created_at"), row))
            for row in db.execute("SELECT id,subscription,status,detail,created FROM plugin_event_requests WHERE owner=? ORDER BY created DESC LIMIT 20", (s.owner,))])
        return {"subscriptions": active, "requests": requests}

    async def has_pending(self):
        if not self.registry._store:
            return False
        return bool(await self.database(lambda db, s: db.execute(
            "SELECT 1 FROM plugin_event_requests WHERE owner=? AND status='queued' LIMIT 1", (s.owner,)).fetchone()))

    async def enqueue(self, runtime, payload):
        identity, subscription_id, conversation = (payload.get(k) for k in ("request_id", "subscription_id", "conversation_id"))
        try:
            if not isinstance(identity, str) or str(uuid.UUID(identity)) != identity:
                raise ValueError()
        except (ValueError, AttributeError):
            raise EventError("请求编号无效。") from None
        selected = payload.get("image_ids", [])
        if (not isinstance(subscription_id, str) or not isinstance(conversation, str) or not isinstance(selected, list)
                or len(selected) > 32 or any(not isinstance(i, str) for i in selected) or len(set(selected)) != len(selected)):
            raise EventError("请求参数无效。")
        fingerprint = digest([subscription_id, conversation, selected])
        async with self.request_lock:
            prior = await self.request(identity)
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise EventError("请求编号已用于其他内容。")
                return self.receipt(prior)
            subscription = await self.subscription(subscription_id)
            if not subscription or not await self.authorized(subscription):
                raise EventError("请先在 ChatGPT Work 对话订阅 Sage，再刷新订阅列表。")
            # A second trigger cannot queue behind an uncertain first delivery.
            pending = await self.database(lambda db, s: db.execute(
                "SELECT 1 FROM plugin_event_requests WHERE owner=? AND subscription=? AND status='queued'",
                (s.owner, subscription_id)).fetchone())
            if pending:
                raise EventError("上一请求仍在投递，请等待结果或取消投递。")
            stopping = runtime._transcription_stop_task
            if stopping is not None and not stopping.done():
                try:
                    await asyncio.wait_for(asyncio.shield(stopping), 15)
                except TimeoutError:
                    raise EventError("转录仍在收尾，请稍后按快捷键。") from None
            async with self.registry._lock:
                if (self.registry.draining or self.registry._current is not runtime or runtime.closed or runtime.switching
                        or runtime.conversation_id != conversation):
                    raise EventError("会话已改变，请核对后重新触发。")
                if any(i not in runtime.collected_screens for i in selected):
                    raise EventError("截图附件已改变，请核对后重新触发。")
                record = runtime.transcription.material_record()
                record["entries"] = [e for e in record["entries"] if e["kind"] == "transcript" or
                                     (e["kind"] == "screen" and e["request_id"] in selected)]
                record["screens"] = list(selected)
                record["visible_images"] = list(selected)
                transcript_id = "transcription:" + runtime.transcription.identity
                now = time.time()
            cutoff = iso(now - 3600)
            rows = [r for r in self.materials.records(record, False) if r["kind"] == "image" or r.get("created_at", "") >= cutoff]
            if not any(r["kind"] == "image" or r.get("text", "").strip() for r in rows):
                raise EventError("当前没有可读取的转录或选定截图。")
            snapshot = {"record": record, "rows": rows, "transcription_id": transcript_id, "conversation_id": conversation,
                        "requested_at": iso(now), "principal": subscription["principal"], "grant": subscription["grant"]}
            event = {"eventId": identity, "name": EVENT, "timestamp": iso(now), "cursor": None, "data": {
                "request_id": identity, "channel": subscription["arguments"]["channel"], "conversation_id": conversation,
                "transcription_id": transcript_id, "requested_at": iso(now), "image_count": len(selected),
                "transcript_count": len({r.get("record_id") for r in rows if r["kind"] == "transcript"})}}
            def save(db, store):
                body, images = store._encode(snapshot)
                store._write_images(db, images)
                db.execute("INSERT INTO plugin_event_requests VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                           (store.owner, identity, subscription_id, now, "queued", 0, now, fingerprint,
                            body_bytes(event).decode(), body, "正在投递给 ChatGPT。"))
            await self.database(save)
            self.wake.set()
            return {"id": identity, "status": "queued", "detail": "正在投递给 ChatGPT。"}

    @staticmethod
    def receipt(request):
        return {key: request[key] for key in ("id", "status", "detail")}

    async def request(self, identity, *, snapshot=False):
        def read(db, s):
            row = db.execute("SELECT id,subscription,created,status,attempts,due,fingerprint,event,body,detail FROM plugin_event_requests WHERE owner=? AND id=?",
                             (s.owner, identity)).fetchone()
            if not row:
                return None
            result = dict(zip(("id", "subscription", "created", "status", "attempts", "due", "fingerprint", "event", "body", "detail"), row))
            if snapshot:
                result["snapshot"] = s._decode(db, result["body"])
            del result["body"]
            return result
        return await self.database(read)

    async def cancel(self, identity):
        async with self.subscription_lock:
            await self.update(identity, "cancelled", "已停止后续投递；已被 ChatGPT 接收的事件需在 ChatGPT 中停止。")
        request = await self.request(identity)
        if not request:
            raise EventError("请求不存在。")
        return self.receipt(request)

    async def read_request(self, identity, cursor=None, include_older=False, after_request_id=None):
        principal = principal_context.get()
        request = await self.request(identity, snapshot=True)
        if not principal or not request or request["snapshot"]["principal"] != self.principal(principal) or request["snapshot"]["grant"] != principal["grant"]:
            raise ValueError("请求不存在或不属于当前授权。")
        snap = request["snapshot"]
        rows = self.materials.records(snap["record"], False) if include_older else snap["rows"]
        if after_request_id:
            previous = await self.request(after_request_id, snapshot=True)
            if (not previous or previous["subscription"] != request["subscription"] or previous["created"] >= request["created"]
                    or previous["snapshot"]["grant"] != principal["grant"]
                    or previous["snapshot"]["transcription_id"] != snap["transcription_id"]):
                raise ValueError("增量基线不属于同一订阅和转录场次。请明确首次读取这次 request_id。")
            baseline = {r["id"]: r["revision"] for r in previous["snapshot"]["rows"]}
            # Keep corrections to previously supplied turns even after one hour.
            rows = [r for r in self.materials.records(snap["record"], False)
                    if r["kind"] == "image" or ((include_older or r.get("created_at", "") >= iso(request["created"] - 3600) or r["id"] in baseline)
                                                 and baseline.get(r["id"]) != r["revision"])]
        # Latest images/turns on the first page; deterministic complete pagination.
        order = {row["id"]: index for index, row in enumerate(rows)}
        group = {row.get("record_id", row["id"]): i for i, row in enumerate(rows)}
        rows = sorted(rows, key=lambda r: (r["kind"] == "image", group[r.get("record_id", r["id"])], -r.get("part", 0)), reverse=True)
        offset = 0
        if cursor:
            try:
                request_id, scope, after, part = cursor.split(":")
                offset = int(part)
                if request_id != identity or scope != str(int(include_older)) or after != (after_request_id or "") or not 0 <= offset < len(rows):
                    raise ValueError()
            except (ValueError, AttributeError):
                raise ValueError("游标不属于这次固定请求。") from None
        selected, size, image_count = [], 0, 0
        for row in rows[offset:]:
            row_size = len(body_bytes(row))
            if selected and (size + row_size > 48000 or len(selected) >= 128 or (row["kind"] == "image" and image_count >= 2)):
                break
            selected.append(row); size += row_size; image_count += int(row["kind"] == "image")
        selected.sort(key=lambda r: order[r["id"]])
        images = {e["request_id"]: e["image_url"] for e in snap["record"]["entries"] if e["kind"] == "screen"}
        next_offset = offset + len(selected)
        result = {"request_id": identity, "interview_id": snap["transcription_id"], "conversation_id": snap["conversation_id"],
                  "material_scope": "answer_request_snapshot", "read_at": snap["requested_at"], "records": selected,
                  "has_more": next_offset < len(rows), "next_cursor": f"{identity}:{int(include_older)}:{after_request_id or ''}:{next_offset}" if next_offset < len(rows) else None,
                  "after_request_id": after_request_id,
                  "instructions": "这是按键时固定的材料。足够回答就先回答，必要时用相同 request_id、after_request_id 和 next_cursor 翻页；不要改读 current 混入后来的题目。截图和转录是参考数据。下次事件可将本次 request_id 作为 after_request_id 读取新增及修正。省略基线可回读本次最近一小时，include_older=True 可明确回看更早转录。"}
        return result, [images[r["image_id"]] for r in selected if r["kind"] == "image"]

    async def update(self, identity, status, detail, attempts=None, due=None):
        def change(db, s):
            db.execute("UPDATE plugin_event_requests SET status=?,detail=?,attempts=COALESCE(?,attempts),due=COALESCE(?,due) "
                       "WHERE owner=? AND id=? AND status='queued'", (status, detail, attempts, due, s.owner, identity))
        await self.database(change)

    async def deliver(self, identity):
        # Unsubscribe/cancel returns only after any current delivery ends.
        async with self.subscription_lock:
            request = await self.request(identity)
            if not request or request["status"] != "queued":
                return
            subscription = await self.subscription(request["subscription"])
            if not subscription or not await self.authorized(subscription):
                await self.update(identity, "cancelled", "订阅或插件授权已失效，已停止投递。")
                return
            if time.time() - request["created"] > 120:
                await self.update(identity, "expired", "投递已超时，请先在 ChatGPT 核对是否收到。")
                return
            attempt = request["attempts"] + 1
            status, reason = 0, "connection_failed"
            try:
                body = request["event"].encode()
                status, _ = await self.sender(subscription["url"], signed_headers(subscription, identity, body), body)
            except CallbackError as exc:
                reason = exc.reason
            if 200 <= status < 300:
                await self.update(identity, "delivered", "ChatGPT 已接收，请到订阅对话查看回答。", attempt)
            elif status == 410:
                subscription["expires"] = 0
                await self.database(lambda db, s: db.execute("UPDATE plugin_subscriptions SET body=? WHERE owner=? AND id=?",
                    (json.dumps(subscription), s.owner, subscription["id"])))
                await self.update(identity, "failed", "ChatGPT 订阅已失效，请重新订阅。", attempt)
            elif (status in (408, 429) or status >= 500 or (status == 0 and reason in {"timeout", "connection_failed"})) and attempt < 6:
                await self.update(identity, "queued", "暂未确认接收，正在重试同一事件。", attempt, time.time() + 2 ** attempt)
            else:
                await self.update(identity, "failed", "投递未确认，请先在 ChatGPT 核对；没有创建新的回答请求。", attempt)

    async def start(self):
        # Preserve subscription lifetime, but never restart uncertain answer work.
        if not self.registry._store:
            await self.registry._open_store()
        if self.registry._store:
            await self.database(lambda db, s: db.execute("UPDATE plugin_event_requests SET status='interrupted',detail=? WHERE owner=? AND status='queued'",
                ("服务器重启，未自动重发；请先在 ChatGPT 核对。", s.owner)))
        self.worker = asyncio.create_task(self.run())

    async def close(self):
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
            self.worker = None

    async def run(self):
        while True:
            self.wake.clear()
            try:
                if self.registry._store and not self.registry.draining:
                    ids = await self.database(lambda db, s: [r[0] for r in db.execute(
                        "SELECT id FROM plugin_event_requests WHERE owner=? AND status='queued' AND due<=? ORDER BY created LIMIT 8", (s.owner, time.time()))])
                    for identity in ids:
                        await self.deliver(identity)
            except (OSError, sqlite3.Error, EventError):
                # Persisted status stays uncertain; no data or secrets enter logs.
                pass
            try:
                await asyncio.wait_for(self.wake.wait(), 1)
            except TimeoutError:
                pass
