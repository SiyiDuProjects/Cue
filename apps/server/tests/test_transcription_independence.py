import asyncio
import os
import tempfile
import unittest
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from app.services.interview_materials import InterviewMaterials
from app.services.openai_realtime import InterviewRegistry, _record_screen


class IndependentTranscriptionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"OPENAI_API_KEY": "", "OPENAI_BASE_URL": "http://127.0.0.1:1/v1",
            "INTERVIEW_WORKSPACE_HISTORY_DIR": self.folder.name, "INTERVIEW_ACCESS_TOKEN": "owner"})
        self.env.start()
        self.registry = InterviewRegistry()

    async def asyncTearDown(self):
        await self.registry.clear()
        self.env.stop()
        self.folder.cleanup()

    async def test_live_switch_preserves_connections_and_late_final_and_restart(self):
        rt = await self.registry.create()
        first = rt.conversation_id
        await rt.update_transcript('interviewer', 'speech', 'partial', 'streaming')
        host, upstream = AsyncMock(), AsyncMock()
        rt._capture_clients['interviewer'] = host
        rt.main_upstream = upstream
        rt.active = True
        original_chat_host = rt.chat.host
        old_token = rt.capture_token
        with patch.object(rt, 'stop_transcription', AsyncMock()) as stopped:
            changed = await self.registry.switch(first, None)
            stopped.assert_not_called()
        self.assertIs(changed, rt)
        self.assertTrue(rt.active)
        self.assertIs(rt.main_upstream, upstream)
        self.assertIs(rt.chat.host, original_chat_host)
        self.assertEqual(rt.capture_token, old_token)
        await rt.update_transcript('interviewer', 'speech', 'final after switch', 'completed')
        await self.registry.switch(rt.conversation_id, first)
        self.assertEqual(rt.transcription.history.by_id['speech']['text'], 'final after switch')
        rt.main_upstream = None
        rt._capture_clients.clear()
        rt.active = False
        await self.registry.clear()
        self.registry = InterviewRegistry()
        restarted = await self.registry.create()
        self.assertEqual(restarted.transcription.history.by_id['speech']['text'], 'final after switch')
        self.assertFalse(restarted.active)

    async def test_default_hour_incremental_corrections_pagination_and_round_boundary(self):
        rt = await self.registry.create()
        await rt.update_transcript('interviewer', 'old', 'old private question', 'completed')
        rt.transcription.history.by_id['old']['created_at'] = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat().replace('+00:00', 'Z')
        await rt.update_transcript('candidate', 'now', 'current reply', 'completed')
        for n in range(5):
            await _record_screen(rt, None, str(n), 'data:image/png;base64,aGVsbG8=', '')
            rt.collected_screens.append(str(n))
        reader = InterviewMaterials(self.registry)
        first, images = await reader.read()
        self.assertEqual(len(images), 2)
        self.assertNotIn('old private question', json.dumps(first))
        next_page, _ = await reader.read(cursor=first['next_cursor'])
        replay, _ = await reader.read(cursor=first['next_cursor'])
        self.assertEqual(next_page['records'], replay['records'])
        while next_page['has_more']:
            next_page, _ = await reader.read(cursor=next_page['next_cursor'])
        cursor = next_page['next_cursor']
        await self.registry.switch(rt.conversation_id, None)
        await rt.update_transcript('candidate', 'now', 'corrected', 'completed', corrected=True)
        corrected, _ = await reader.read(cursor=cursor)
        self.assertEqual([r['text'] for r in corrected['records']], ['corrected'])
        full, _ = await reader.read(include_older=True)
        self.assertIn('old private question', json.dumps(full))
        identity = first['interview_id']
        await rt.new_transcription('reset')
        with self.assertRaisesRegex(ValueError, '游标'):
            await reader.read(cursor=corrected['next_cursor'])
        empty, _ = await reader.read()
        self.assertEqual(empty['records'], [])
        archived, _ = await reader.read(identity, include_older=True)
        self.assertIn('old private question', json.dumps(archived))

    async def test_new_provider_gets_recent_transcript_not_other_chat_text(self):
        rt = await self.registry.create()
        await rt.update_transcript('candidate', 'old', 'OUTSIDE_WINDOW', 'completed')
        rt.transcription.history.by_id['old']['created_at'] = '2000-01-01T00:00:00Z'
        await rt.update_transcript('candidate', 'new', 'RECENT_SPEECH', 'completed')
        rt.history.entries.append({'kind': 'chat_request', 'message_id': 'oldchat', 'response_id': 'a', 'text': 'OTHER_CHAT', 'screens': []})
        await self.registry.switch(rt.conversation_id, None)
        inputs, turns = rt.chat.input({})
        self.assertIn('RECENT_SPEECH', json.dumps(inputs))
        self.assertNotIn('OUTSIDE_WINDOW', json.dumps(inputs))
        self.assertNotIn('OTHER_CHAT', json.dumps(inputs))
        # Previously supplied turns continue receiving corrections beyond one hour.
        rt.transcription.history.by_id['new']['created_at'] = '2000-01-01T00:00:00Z'
        await rt.update_transcript('candidate', 'new', 'CORRECTION', 'completed', corrected=True)
        inputs, _ = rt.chat.input({}, sent_turns=turns)
        self.assertIn('CORRECTION', json.dumps(inputs))

    async def test_appshot_round_trip_keeps_original_and_text_for_mcp(self):
        rt = await self.registry.create()
        metadata = {"status": "available", "app_name": "Editor", "window_title": "题目", "text": "UNSENT_APP_TEXT"}
        image = 'data:image/png;base64,aGVsbG8='
        rt._screen_metadata['shot'] = {"appshot": metadata, "source_id": "window:42"}
        await _record_screen(rt, None, 'shot', image, '')
        rt.collected_screens.append('shot')
        reader = InterviewMaterials(self.registry)
        page, images = await reader.read()
        row = next(r for r in page['records'] if r['kind'] == 'image')
        self.assertEqual(row['appshot'], metadata)
        self.assertEqual(rt.history.by_id['screen:shot']['image_url'], image)
        self.assertNotIn('UNSENT_APP_TEXT', json.dumps(rt.chat.input({})))
        await self.registry.clear()
        self.registry = InterviewRegistry()
        restored = await self.registry.create()
        self.assertEqual(restored.transcription.history.by_id['screen:shot']['appshot'], metadata)
        self.assertEqual(restored.transcription.history.by_id['screen:shot']['image_url'], image)

    async def test_late_appshot_after_chat_switch_is_rejected(self):
        rt = await self.registry.create()
        previous = rt.conversation_id
        sent, ready = [], asyncio.Event()
        async def capture(_speaker, payload):
            sent.append(payload)
            ready.set()
            return True
        rt.send_to_capture = AsyncMock(side_effect=capture)
        await rt.start_operation({"type": "request_screen_capture", "collect_only": True,
            "operation_id": "pending-shot", "conversation_id": previous}, None)
        await asyncio.wait_for(ready.wait(), 1)
        request = sent[0]
        self.assertEqual(request['conversation_id'], previous)
        await self.registry.switch(previous, None)
        accepted = await rt.accept_screen_snapshot({"request_id": request['request_id'],
            "image_data": "data:image/png;base64,iVBORw0KGgo=", "appshot": {"status": "available", "text": "CANCELLED_AX_TEXT"}})
        self.assertFalse(accepted)
        self.assertNotIn(request['request_id'], rt.pending_screen_requests)
        self.assertNotIn(request['request_id'], rt._screen_metadata)
        self.assertEqual(rt.collected_screens, [])
        page, images = await InterviewMaterials(self.registry).read()
        self.assertEqual(images, [])
        self.assertNotIn('CANCELLED_AX_TEXT', json.dumps(page))
        self.assertNotIn('CANCELLED_AX_TEXT', json.dumps(rt.chat.input({})))

    async def test_removed_attachment_is_not_exposed_from_saved_page(self):
        rt = await self.registry.create()
        for n in range(3):
            await _record_screen(rt, None, str(n), 'data:image/png;base64,aGVsbG8=', '')
            rt.collected_screens.append(str(n))
        reader = InterviewMaterials(self.registry)
        first, images = await reader.read()
        self.assertEqual(len(images), 2)
        rt.transcription.visible_images.discard('0')
        page, images = await reader.read(cursor=first['next_cursor'])
        self.assertEqual(images, [])
        self.assertNotIn('screen:0', json.dumps(page))
        _, images = await reader.read(image_ids=['0'])
        self.assertEqual(len(images), 1)

    async def test_legacy_chat_cursor_explicitly_routes_to_live_followup(self):
        rt = await self.registry.create()
        reader = InterviewMaterials(self.registry)
        chat_id = rt.conversation_id
        await _record_screen(rt, None, 'question', 'data:image/png;base64,aGVsbG8=', '')
        rt.collected_screens.append('question')
        first, _ = await reader.read(chat_id)
        await rt.update_transcript('candidate', 'followup', '但是为什么要这样做呢？你的写法不错，能解释一下吗？', 'completed')
        # Stopping transcription does not remove the follow-up.
        await rt.stop_transcription()
        legacy, _ = await reader.read(chat_id, cursor=first['next_cursor'])
        self.assertFalse(legacy['contains_live_transcription'])
        self.assertEqual(legacy['live_transcription']['arguments'], {'interview_id': 'current'})
        self.assertIn('旧 cursor', legacy['warning'])
        self.assertEqual((await reader.list_interviews())['interviews'][0]['interview_id'], 'current')
        current, _ = await reader.read(**legacy['live_transcription']['arguments'])
        self.assertIn('能解释一下吗', json.dumps(current, ensure_ascii=False))
        self.assertEqual(current['material_scope'], 'live_transcription')

    async def test_silence_does_not_hide_followup_but_retractions_are_delivered(self):
        rt = await self.registry.create()
        reader = InterviewMaterials(self.registry)
        for n in range(60):
            await rt.update_transcript('candidate', f'silence-{n}', '', 'completed')
        await rt.update_transcript('candidate', 'spoken', 'Explain why', 'completed')
        first, _ = await reader.read()
        self.assertFalse(first['has_more'])
        self.assertEqual([r['text'] for r in first['records']], ['Explain why'])
        await rt.update_transcript('candidate', 'spoken', '', 'completed', corrected=True)
        correction, _ = await reader.read(cursor=first['next_cursor'])
        self.assertEqual([r['text'] for r in correction['records']], [''])
        self.assertEqual(correction['records'][0]['id'], first['records'][0]['id'])
