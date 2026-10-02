import base64
import json
import unittest
from unittest.mock import Mock

from app.services.candidate_audio import CandidateAudioBoundary
from tests.test_realtime import make_runtime, FakeUpstream


class CandidateAudioTests(unittest.TestCase):
    def test_real_vad_silence_and_bounded_buffer(self):
        boundary = CandidateAudioBoundary()
        for _ in range(1499):
            self.assertFalse(boundary.feed(bytes(960)))
        self.assertTrue(boundary.feed(bytes(960)))
        self.assertFalse(boundary.feed(bytes(960)))

    def test_pause_finalizes_once_without_filtering_or_losing_chunk_residuals(self):
        boundary = CandidateAudioBoundary()
        boundary.vad = Mock()
        boundary.vad.is_speech.return_value = True
        self.assertFalse(boundary.feed(bytes(475)))
        self.assertFalse(boundary.feed(bytes(485)))
        boundary.vad.is_speech.assert_called_once_with(bytes(320), 8000)
        boundary.vad.is_speech.return_value = False
        for _ in range(39):
            self.assertFalse(boundary.feed(bytes(960)))
        self.assertTrue(boundary.feed(bytes(961)))
        self.assertEqual(len(boundary.pending), 0)
        self.assertFalse(boundary.feed(bytes(960)))

    def test_speech_resumes_before_end_of_thinking_pause(self):
        boundary = CandidateAudioBoundary()
        boundary.vad = Mock()
        for voiced, frames in [(True, 4), (False, 20), (True, 2), (False, 39)]:
            boundary.vad.is_speech.return_value = voiced
            for _ in range(frames):
                self.assertFalse(boundary.feed(bytes(960)))
        self.assertTrue(boundary.feed(bytes(960)))


class CandidateAudioTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_original_audio_precedes_commit_without_response_or_main_audio(self):
        runtime = make_runtime()
        runtime.active = True
        socket, main = FakeUpstream(), FakeUpstream()
        runtime.candidate_upstream, runtime.main_upstream = socket, main
        runtime._candidate_boundary = Mock()
        runtime._candidate_boundary.feed.return_value = True
        data = bytes(range(256)) * 4
        await runtime.send_transcription_audio("candidate", socket, data)
        self.assertEqual([m['type'] for m in socket.messages], ['input_audio_buffer.append', 'input_audio_buffer.commit'])
        self.assertEqual(base64.b64decode(socket.messages[0]['audio']), data)
        self.assertEqual(main.messages, [])
        self.assertEqual(runtime.response_order, [])

    async def test_inactive_or_replaced_connection_never_receives_audio(self):
        runtime = make_runtime()
        current, old = FakeUpstream(), FakeUpstream()
        runtime.candidate_upstream = current
        runtime.active = False
        await runtime.send_transcription_audio("candidate", current, bytes(960))
        runtime.active = True
        await runtime.send_transcription_audio("candidate", old, bytes(960))
        self.assertEqual(current.messages, [])
        self.assertEqual(old.messages, [])
