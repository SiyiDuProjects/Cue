import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock, Mock, patch

from app.services.candidate_audio import CandidateAudioBoundary
from app.services.interview_materials import InterviewMaterials
from app.services.openai_realtime import InterviewRegistry, _record_screen
from tests.test_realtime import make_runtime, FakeUpstream


class ReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {'OPENAI_API_KEY': '', 'OPENAI_BASE_URL': 'http://127.0.0.1:1/v1',
                                           'INTERVIEW_WORKSPACE_HISTORY_DIR': ''})
        self.env.start()
        self.registry = InterviewRegistry()

    async def asyncTearDown(self):
        await self.registry.clear()
        self.env.stop()

    async def test_stop_commits_tail_and_waits_for_final(self):
        runtime = make_runtime()
        runtime.active = True
        upstream = FakeUpstream()
        runtime.candidate_upstream = upstream
        boundary = CandidateAudioBoundary()
        boundary.vad = Mock()
        boundary.vad.is_speech.return_value = True
        runtime._candidate_boundary = boundary
        runtime._candidate_reader_task = asyncio.create_task(runtime._run_candidate_reader(upstream))
        await runtime.send_transcription_audio('candidate', upstream, bytes(960 * 5))
        stop = asyncio.create_task(runtime.stop_transcription())
        for _ in range(100):
            if any(m['type'] == 'input_audio_buffer.commit' for m in upstream.messages):
                break
            await asyncio.sleep(.001)
        self.assertTrue(any(m['type'] == 'input_audio_buffer.commit' for m in upstream.messages))
        self.assertFalse(upstream.closed)
        self.assertFalse(stop.done())
        upstream.queue.put_nowait(json.dumps({'type': 'input_audio_buffer.committed', 'item_id': 'tail'}))
        upstream.queue.put_nowait(json.dumps({'type': 'conversation.item.input_audio_transcription.completed',
                                             'item_id': 'tail', 'transcript': '最后一句完整保留'}))
        await asyncio.wait_for(stop, 1)
        self.assertTrue(upstream.closed)
        self.assertFalse(runtime.active)
        self.assertFalse(runtime.transcription_stopping)
        self.assertEqual(runtime.transcription.history.turns[-1]['text'], '最后一句完整保留')

    async def test_short_tail_padding_and_empty_tail(self):
        boundary = CandidateAudioBoundary()
        self.assertIsNone(boundary.finish())
        boundary.feed(bytes(960))
        self.assertEqual(len(boundary.finish()), 3840)
        self.assertIsNone(boundary.finish())

    async def test_upstream_loss_while_stopping_keeps_partial_and_reports_gap(self):
        runtime = make_runtime()
        runtime.active = True
        runtime.broadcast_to_clients = AsyncMock()
        upstream = FakeUpstream()
        runtime.candidate_upstream = upstream
        boundary = CandidateAudioBoundary()
        boundary.vad = Mock()
        boundary.vad.is_speech.return_value = True
        runtime._candidate_boundary = boundary
        runtime._candidate_reader_task = asyncio.create_task(runtime._run_candidate_reader(upstream))
        await runtime.send_transcription_audio('candidate', upstream, bytes(960 * 5))
        upstream.queue.put_nowait(json.dumps({'type': 'conversation.item.input_audio_transcription.delta',
                                             'item_id': 'partial', 'delta': '尚未完成的文字'}))
        stop = asyncio.create_task(runtime.stop_transcription())
        for _ in range(100):
            if any(m['type'] == 'input_audio_buffer.commit' for m in upstream.messages):
                break
            await asyncio.sleep(.001)
        await upstream.close()
        await asyncio.wait_for(stop, 1)
        self.assertEqual(runtime.transcription.history.turns[-1]['text'], '尚未完成的文字')
        self.assertEqual(runtime.transcription.history.turns[-1]['status'], 'interrupted')
        self.assertTrue(any(c.args[0].get('type') == 'error' for c in runtime.broadcast_to_clients.call_args_list))

    async def test_latest_first_followup_during_paging_and_retry(self):
        runtime = await self.registry.create()
        for i in range(300):
            await runtime.update_transcript('interviewer', str(i), 'Original ' + str(i), 'completed')
        await _record_screen(runtime, None, 'latest', 'data:image/png;base64,aGVsbG8=', '')
        runtime.collected_screens.append('latest')
        reader = InterviewMaterials(self.registry)
        first, pixels = await reader.read()
        self.assertEqual(len(pixels), 1)
        speech = [r['text'] for r in first['records'] if r['kind'] == 'transcript']
        self.assertEqual(speech[-1], 'Original 299')
        self.assertEqual(speech, sorted(speech, key=lambda text: int(text.split()[-1])))
        self.assertTrue(first['has_more'])
        await runtime.update_transcript('interviewer', '299', 'Corrected requirement', 'completed', corrected=True)
        await runtime.update_transcript('candidate', 'followup', 'Explain current code', 'completed')
        second, _ = await reader.read(cursor=first['next_cursor'])
        self.assertIn('Corrected requirement', json.dumps(second))
        self.assertIn('Explain current code', json.dumps(second))
        await runtime.update_transcript('candidate', 'next', 'Later speech', 'completed')
        retry, _ = await reader.read(cursor=first['next_cursor'])
        self.assertEqual(second, retry)
        page, _ = await reader.read(cursor=second['next_cursor'])
        self.assertIn('Later speech', json.dumps(page))
        seen = {r['id'] for p in (first, second, page) for r in p['records']}
        while page['has_more']:
            page, _ = await reader.read(cursor=page['next_cursor'])
            seen.update(r['id'] for r in page['records'])
        self.assertEqual(len(seen), 303)

    async def test_new_round_labels_history_and_drops_old_drafts_on_switch(self):
        runtime = await self.registry.create()
        first_chat = runtime.conversation_id
        await _record_screen(runtime, None, 'old', 'data:image/png;base64,aGVsbG8=', '')
        runtime.collected_screens.append('old')
        reader = InterviewMaterials(self.registry)
        before, _ = await reader.read()
        await self.registry.switch(first_chat, None)
        await runtime.new_transcription('reset')
        current, pixels = await reader.read()
        self.assertTrue(current['is_current'])
        self.assertEqual(pixels, [])
        history, pixels = await reader.read(before['interview_id'], include_older=True)
        self.assertFalse(history['is_current'])
        self.assertEqual(history['title'], '历史转录')
        self.assertEqual(history['live_transcription']['arguments'], {'interview_id': 'current'})
        self.assertEqual(len(pixels), 1)
        await self.registry.switch(runtime.conversation_id, first_chat)
        self.assertEqual(runtime.collected_screens, [])
        self.assertIn('screen:old', runtime.history.by_id)
