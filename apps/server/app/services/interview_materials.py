"""Read-only views, with independent replayable cursors; never mark material consumed."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import hashlib
import json
import secrets
import time
from datetime import datetime, timedelta, timezone

from app.services.conversation_store import snapshot


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class InterviewMaterials:
    def __init__(self, registry):
        self.registry = registry
        self.memory_cursors = {}
        self._read_lock = asyncio.Lock()

    async def list_interviews(self):
        # Old ChatGPT conversations may retain the original tool descriptions.
        # Keep live routing in tool results, not only in newly fetched schemas.
        return {"interviews": [{"interview_id": "current", "title": "当前实时转录与截图（最近一小时）",
                                "material_scope": "live_transcription", "independent_of_chat": True},
                               *[{**row, "material_scope": "archived_chat"}
                                 for row in await self.registry.conversations()]],
                "instructions": "回答当前问题或语音追问，请调用 read_interview(interview_id='current')。下面的聊天 UUID 只用于历史聊天，不包含解耦后新增的转录。"}

    @staticmethod
    def scope_metadata(timeline, is_current=False):
        route = {"tool": "read_interview", "arguments": {"interview_id": "current"}}
        if is_current:
            return {"material_scope": "live_transcription", "is_current": True,
                    "live_transcription": route,
                    "routing": "只有一条共享转录主路。当前问题始终使用 interview_id='current'；追问传 updates_cursor，补读历史才传 history_cursor。无需选择聊天或转录编号。"}
        return {"material_scope": "archived_transcription" if timeline else "archived_chat",
                "is_current": False, "contains_live_transcription": False,
                "live_transcription": {"tool": "read_interview", "arguments": {"interview_id": "current"}},
                "warning": "这是历史记录，不是当前实时转录。不能由这里的空转录或无新增判断用户没有说话。"
                           "回答当前问题或跟进语音时，必须另调 read_interview(interview_id='current')；首次不要带本聊天的旧 cursor，之后使用共用转录返回的 cursor。"}

    async def record(self, identity):
        if not isinstance(identity, str) or not identity or len(identity) > 100:
            raise ValueError("请先选择明确的 interview_id。")
        async with self.registry._lock:
            rt = self.registry._current
            if rt and rt.conversation_id == identity:
                return snapshot(rt)
            await self.registry._open_store()
            record = await asyncio.to_thread(self.registry._store.read, identity) if self.registry._store else deepcopy(self.registry._records.get(identity))
        if not record:
            raise ValueError("会话不存在；不会改读当前会话。")
        return record

    async def cursor(self, identity=None, value=None):
        store = self.registry._store
        now = time.time()
        if store:
            def access():
                with store.connect() as db:
                    db.execute("CREATE TABLE IF NOT EXISTS material_cursors (owner TEXT, id TEXT, expires REAL, body TEXT, PRIMARY KEY(owner,id))")
                    if value is None:
                        row = db.execute("SELECT body FROM material_cursors WHERE owner=? AND id=? AND expires>?", (store.owner, identity, now)).fetchone()
                        return json.loads(row[0]) if row else None
                    db.execute("DELETE FROM material_cursors WHERE owner=? AND expires<?", (store.owner, now))
                    db.execute("INSERT INTO material_cursors VALUES (?,?,?,?)", (store.owner, identity, now + 7*86400, json.dumps(value, ensure_ascii=False)))
                    # A bounded cursor cache may expire a very old consumer, never
                    # silently reset it or delete source material.
                    db.execute("DELETE FROM material_cursors WHERE owner=? AND id NOT IN (SELECT id FROM material_cursors WHERE owner=? ORDER BY expires DESC LIMIT 512)", (store.owner, store.owner))
            return await asyncio.to_thread(access)
        if value is None:
            item = self.memory_cursors.get(identity)
            return deepcopy(item[1]) if item and item[0] > now else None
        self.memory_cursors[identity] = (now + 7*86400, deepcopy(value))
        while len(self.memory_cursors) > 512:
            self.memory_cursors.pop(next(iter(self.memory_cursors)))

    def records(self, record, include_answers):
        visible_images = set(record.get("visible_images", record["screens"]))
        for e in record["entries"]:
            if e["kind"] == "chat_request":
                visible_images.update(s["request_id"] for s in e["screens"])
        rows = []
        for e in record["entries"]:
            kind = e["kind"]
            if kind == "transcript":
                row = {k: v for k, v in e.items() if k != "workspace_evidence"}
                row["id"] = "transcript:" + e["turn_id"]
            elif kind == "screen" and e["request_id"] in visible_images:
                row = {"id": "screen:" + e["request_id"], "kind": "image", "image_id": e["request_id"],
                       "captured_at": e["captured_at"], "created_at": e.get("created_at", e["captured_at"]),
                       "sent_to_sage": e["request_id"] not in record["screens"],
                       "image_revision": hashlib.sha256(e["image_url"].encode()).hexdigest()}
            elif kind == "chat_request":
                row = {"id": "message:" + e["message_id"], "kind": "sage_user_message", "text": e["text"], "created_at": e["created_at"]}
            elif kind == "answer" and include_answers:
                row = {"id": "answer:" + e["response_id"], "kind": "sage_assistant_answer", "text": record["answers"].get(e["response_id"], ""),
                       "status": record["answer_status"].get(e["response_id"], "unknown"), "meaning": "Generated suggestion, not candidate speech or implemented code."}
            else:
                continue
            text = row.get("text", "")
            chunks = [text[i:i+12000] for i in range(0, len(text), 12000)] or [""]
            for index, chunk in enumerate(chunks):
                part = deepcopy(row)
                if "text" in row:
                    part.update(text=chunk, record_id=row["id"], part=index, parts=len(chunks), id=row["id"] + f":{index}")
                part["revision"] = digest(part)
                rows.append(part)
        return rows

    async def read(self, interview_id="current", cursor=None, image_ids=None, include_answers=False, include_older=False):
        # A retry of the same cursor replays one page. A new cursor takes a new
        # snapshot, including corrections that arrived during pagination.
        async with self._read_lock:
            return await self._read(interview_id, cursor, image_ids, include_answers, include_older)

    async def _read(self, interview_id, cursor, image_ids, include_answers, include_older):
        timeline = interview_id == "current" or interview_id.startswith("transcription:")
        is_current = False
        read_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        if timeline:
            from app.services.transcription_buffer import TranscriptionBuffer
            async with self.registry._lock:
                rt = self.registry._current
                await self.registry._open_store()
                if rt and (interview_id == "current" or interview_id == "transcription:" + rt.transcription.identity):
                    buffer = rt.transcription
                else:
                    store = self.registry._store
                    value = (await asyncio.to_thread(store.read_transcription) if interview_id == "current" else
                             await asyncio.to_thread(store.read_transcription_by_id, interview_id.removeprefix("transcription:"))) if store else None
                    if not value and rt:
                        value = next((item for item in getattr(rt, "transcription_archives", [])
                                      if interview_id == "transcription:" + item["id"]), None)
                    if not value:
                        raise ValueError("没有可读取的转录，请先打开 Sage。")
                    buffer = TranscriptionBuffer(value)
                interview_id = "transcription:" + buffer.identity
                is_current = bool(rt and buffer.identity == rt.transcription.identity)
                if not rt and store:
                    latest = await asyncio.to_thread(store.read_transcription)
                    is_current = bool(latest and latest['id'] == buffer.identity)
                record = buffer.material_record()
                if not is_current:
                    record['title'] = '历史转录'
        else:
            record = await self.record(interview_id)
        images = {e["request_id"]: e for e in record["entries"] if e["kind"] == "screen"}
        if image_ids:
            if cursor or len(image_ids) > 3 or len(set(image_ids)) != len(image_ids):
                raise ValueError("回看图片每次指定最多 3 张，不与增量 cursor 混用。")
            if any(i not in images for i in image_ids):
                raise ValueError("图片不属于指定会话。")
            return {"interview_id": interview_id, "title": record["title"], **self.scope_metadata(timeline, is_current), "read_at": read_at, "records": [
                {"id": "screen:" + i, "kind": "image", "image_id": i, "captured_at": images[i]["captured_at"]} for i in image_ids],
                "next_cursor": None, "has_more": False}, [images[i]["image_url"] for i in image_ids]
        state = await self.cursor(cursor) if cursor else {"interview_id": interview_id, "include_answers": include_answers,
            "include_older": include_older, "seen": {}, "pending": [],
            "since": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat().replace("+00:00", "Z") if timeline and not include_older else ""}
        if not state:
            raise ValueError("读取游标已过期。请明确重新读取同一会话，并用记录 ID / revision 去重；没有删除原材料。")
        if state["interview_id"] != interview_id or state["include_answers"] != include_answers or state.get("include_older", False) != include_older:
            raise ValueError("游标不属于当前转录或读取范围。可能已开始新一场；请明确重新读取，不要混用旧场次。")
        seen = state["seen"].copy()
        # A saved pagination checkpoint must not expose an attachment removed
        # since the preceding page. Explicit image-ID review remains available.
        visible = {row["image_id"] for row in self.records(record, False) if row["kind"] == "image"}
        cached = await self.cursor('page:' + cursor) if cursor else None
        if cached:
            result = deepcopy(cached['result'])
            # Revoked attachments never reappear via a replayed page.
            result['records'] = [r for r in result['records'] if r['kind'] != 'image' or r['image_id'] in visible]
            result.update(self.scope_metadata(timeline, is_current), title=record['title'])
            return result, [images[r['image_id']]['image_url'] for r in result['records'] if r['kind'] == 'image']
        current = self.records(record, include_answers)
        current = [row for row in current if row["kind"] != "transcript"
                   or row.get("text", "").strip() or row["id"] in seen]
        if state.get("since"):
            current = [row for row in current if row.get("created_at", row.get("captured_at", "")) >= state["since"] or row["id"] in seen]
        current_ids = {row["id"] for row in current}
        # The baseline means observed at the initial read, NOT delivered/read.
        # It lets live followups skip unrequested history without losing history
        # pagination or a later correction to an older record.
        baseline = state.get('baseline', {row['id']: row['revision'] for row in current})
        updates_only = state.get('mode') == 'updates'
        known = {**baseline, **seen} if updates_only else seen
        pending = [row for row in current if known.get(row["id"]) != row["revision"]]
        if timeline:
            # Prioritize pictures and the newest spoken requirement. Parts of
            # one long record remain in ascending part order.
            order = {row.get('record_id', row['id']): i for i, row in enumerate(current)}
            pending.sort(key=lambda row: (row['kind'] == 'image', row['id'] in seen, order[row.get('record_id', row['id'])], -row.get('part', 0)), reverse=True)
        pending += [{"id": identity, "kind": "removed", "revision": "removed"} for identity in seen if identity not in current_ids and seen[identity] != "removed"]
        selected, pixels, text_bytes = [], [], 0
        remaining = []
        for row in pending:
            size = len(json.dumps(row, ensure_ascii=False))
            if len(selected) >= (128 if timeline else 24) or (selected and text_bytes + size > 48000) or (row['kind'] == 'image' and len(pixels) >= 2):
                remaining.append(row)
                continue
            selected.append(row); text_bytes += size; seen[row["id"]] = row["revision"]
            if row["kind"] == "image":
                pixels.append(images[row["image_id"]]["image_url"])
        if timeline:
            # Select recent/high-priority records first, then present the chosen
            # page in conversational order. Match image blocks to that order.
            selected.sort(key=lambda row: (order.get(row.get('record_id', row['id']), len(order)), row.get('part', 0)))
            pixels = [images[row['image_id']]['image_url'] for row in selected if row['kind'] == 'image']
        token = secrets.token_urlsafe(24)
        next_state = {**state, "seen": seen, "pending": [], 'baseline': baseline}
        await self.cursor(token, next_state)
        updates_token = token
        history_token = state.get('history_cursor') if updates_only else (token if remaining else None)
        if timeline and not updates_only:
            updates_token = secrets.token_urlsafe(24)
            await self.cursor(updates_token, {**next_state, 'mode': 'updates', 'history_cursor': history_token})
        result = {"interview_id": interview_id, "title": record["title"], **self.scope_metadata(timeline, is_current), "records": selected,
                "next_cursor": token, "has_more": bool(remaining), "read_at": read_at,
                'updates_cursor': updates_token, 'history_cursor': history_token,
                'read_mode': 'updates' if updates_only else 'latest_with_history',
                'record_order': 'chronological' if timeline else 'history',
                "since": state.get("since"), "independent_of_chat": timeline,
                "instructions": "当前内容始终使用 interview_id='current'。首次选择最新截图与语音，页内按时间顺序；能回答当前问题就先回答，不必读完历史。之后追问将 updates_cursor 作为 cursor，仅取新增和修正；updates 模式 has_more 表示新增尚未取完，用 next_cursor 继续。需要更早上下文才将 history_cursor 作为 cursor，历史分页用 next_cursor。保留两个游标；跳过的历史仍完整保留，不能声称已读。相同 cursor 重试重放同一页。同 ID 新 revision 替代旧版。read_at 是读取截止时间，生成中不会自动收到后来语音。"}
        if cursor:
            await self.cursor('page:' + cursor, {'result': result})
        return result, pixels

    async def background(self, interview_id, action, arguments):
        if interview_id != "current" and not interview_id.startswith("transcription:"):
            await self.record(interview_id)
        rt = await self.registry.current()
        if not rt:
            raise ValueError("请打开 Sage 电脑端以读取背景资料。")
        return await rt.chat.host.read_materials(action, arguments)
