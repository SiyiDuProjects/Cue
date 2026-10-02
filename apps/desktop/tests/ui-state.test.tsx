import assert from "node:assert/strict";
import React from "react";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerMarkdown } from "../src/AnswerMarkdown";
import {
  applyChannelHealth,
  listeningStatus,
  mergeAnswerEvent,
  mergeOperation,
  mergeTranscriptTurn,
  transcriptForSpeaker,
  visibleAnswerOrder,
} from "../src/interviewUiState";
import { parseServerEvent, SessionClient } from "../src/sessionClient";
import type { AnswerRecord, AnswerStore, ServerEvent, TranscriptTurn } from "../src/types";

test("native candidate finals can arrive out of order without replacing newer speech", () => {
  const first: TranscriptTurn = { turn_id: "a", speaker: "candidate", text: "First partial", status: "streaming" };
  const second: TranscriptTurn = { turn_id: "b", speaker: "candidate", text: "Second partial", status: "streaming" };
  const original = [first, second];
  const revised = mergeTranscriptTurn(original, { ...first, text: "First final", status: "completed" });
  assert.deepEqual(transcriptForSpeaker(revised, "candidate"), { final: "First final", partial: "Second partial" });
  assert.equal(original[0].text, "First partial");
  let completed = mergeTranscriptTurn(original, { ...second, text: "Second final", status: "completed" });
  completed = mergeTranscriptTurn(completed, { ...first, text: "First final", status: "completed" });
  assert.deepEqual(completed.map((turn) => turn.turn_id), ["a", "b"]);
  assert.deepEqual(transcriptForSpeaker(completed, "candidate"), { final: "Second final", partial: "" });
  assert.equal(mergeTranscriptTurn(completed, first), completed);
});

test("candidate snapshot restores partial items and final correction can clear spurious text", () => {
  const snapshot: TranscriptTurn[] = [
    { turn_id: "a", speaker: "candidate", text: "Older", status: "completed" },
    { turn_id: "b", speaker: "candidate", text: "Still speaking", status: "streaming" },
  ];
  assert.deepEqual(transcriptForSpeaker(snapshot, "candidate"), { final: "Older", partial: "Still speaking" });
  const cleared = mergeTranscriptTurn(snapshot, { ...snapshot[1], text: "", status: "completed" });
  assert.deepEqual(transcriptForSpeaker(cleared, "candidate"), { final: "Older", partial: "" });
  const interrupted = mergeTranscriptTurn(snapshot, { ...snapshot[1], status: "interrupted" });
  assert.equal(interrupted[1].status, "interrupted");
  assert.equal(transcriptForSpeaker(interrupted, "candidate").partial, "");
});

const oldAnswer: AnswerRecord = {
  responseId: "answer-old", questionId: "question-old", text: "An earlier solution.", status: "completed",
};

function answerStore(...records: AnswerRecord[]): AnswerStore {
  return { order: records.map(answer => answer.responseId), byId: Object.fromEntries(records.map(answer => [answer.responseId, answer])) };
}

test("chat preserves answers across topics without filtering tool preambles", () => {
  const records = [oldAnswer,
    { ...oldAnswer, responseId: "continuation", status: "streaming" as const },
    { ...oldAnswer, responseId: "other", questionId: "other-topic" },
    { ...oldAnswer, responseId: "returning" }];
  assert.deepEqual(visibleAnswerOrder(answerStore(...records)), records.map(r => r.responseId));
});

test("late answer events cannot rewrite completed text, but snapshots restore it", () => {
  const late = mergeAnswerEvent(oldAnswer, { type: "answer_delta", delta: "late text" }, "streaming", false);
  assert.equal(late, oldAnswer);
  const base = { ...oldAnswer, text: "", status: "streaming" as const };
  const streaming = mergeAnswerEvent(base, { type: "answer_delta", delta: "第一段" }, "streaming", false);
  const continued = mergeAnswerEvent(streaming, { type: "answer_delta", delta: "\n\n工具后的说明" }, "streaming", false);
  const completed = mergeAnswerEvent(continued, { type: "answer_completed" }, "completed", false);
  assert.equal(completed.text, "第一段\n\n工具后的说明");
  const restored = mergeAnswerEvent(base, { type: "answer_snapshot", text: completed.text }, "completed", true);
  assert.deepEqual(restored, completed);
});


test("an active interview cannot appear to be listening while the client is disconnected", () => {
  const result = listeningStatus({ connected: false, reconnecting: true, active: true, deviceStatus: "ready",
    channels: { interviewer: { phase: "listening", message: "" }, candidate: { phase: "listening", message: "" } }, answering: false });
  assert.equal(result.live, false);
  assert.equal(result.label, "重新连接中");
  assert.match(result.detail, /等待恢复/);
});

test("muted and interrupted channels remain unhealthy despite a ready transport", () => {
  for (const phase of ["muted", "interrupted"] as const) {
    const interviewer = applyChannelHealth(true, "ready", true, { phase });
    assert.equal(interviewer.phase, phase);
    assert.equal(listeningStatus({ connected: true, reconnecting: false, active: true, deviceStatus: "ready",
      channels: { interviewer, candidate: { phase: "listening", message: "" } }, answering: false }).live, false);
  }
});

test("server channel_details preserves the specific channel failure", () => {
  const event = parseServerEvent(JSON.stringify({ type: "device_status", status: "error", channels: { interviewer: true, candidate: false }, channel_details: { candidate: { phase: "interrupted", detail: "Microphone disconnected" } } }));
  assert.ok(event);
  const candidate = applyChannelHealth(event.channels?.candidate === true, "error", true, event.channel_details?.candidate);
  assert.equal(candidate.phase, "interrupted");
  assert.equal(candidate.message, "Microphone disconnected");
});

test("ready audio is labelled transcription, not automatic answering", () => {
  const result = listeningStatus({ connected: true, reconnecting: false, active: true, deviceStatus: "ready",
    channels: { interviewer: { phase: "listening", message: "" }, candidate: { phase: "listening", message: "" } }, answering: false });
  assert.equal(result.label, "转录中");
  assert.match(result.detail, /发送消息时才回答/);
});

test("operation feedback only becomes complete after a terminal server event", () => {
  let operations = mergeOperation([], { operation_id: "op", kind: "chat_send", action: "send", status: "sent" });
  operations = mergeOperation(operations, { operation_id: "op", kind: "chat_send", status: "running" });
  assert.equal(operations[0].status, "running");
  operations = mergeOperation(operations, { operation_id: "op", kind: "chat_send", status: "completed" });
  assert.equal(mergeOperation(operations, { operation_id: "op", kind: "chat_send", status: "accepted" }), operations);
  assert.equal(operations[0].action, "send");
});

test("Markdown preserves code, lists and tables and offers code-only copy", () => {
  const markup = renderToStaticMarkup(<AnswerMarkdown text={'1. Check the boundary\n2. Return the result\n\n```python\ndef solve(x):\n    return x < 3\n```\n\n| Input | Output |\n| --- | --- |\n| 2 | true |'} />);
  assert.match(markup, /<ol>/);
  assert.match(markup, /<table>/);
  assert.match(markup, /return x &lt; 3/);
  assert.match(markup, /aria-label="复制代码"/);
});

test("Markdown never executes HTML, embeds remote images, or enables unsafe links", () => {
  const markup = renderToStaticMarkup(<AnswerMarkdown text={'<script>alert(1)</script>\n\n<img src="https://example.invalid/private">\n\n![tracking](https://example.invalid/tracker)\n\n[bad](javascript:alert(1)) [local](file:///secret.txt) [safe](https://example.com/docs)'} />);
  assert.doesNotMatch(markup, /<script|<img|href="(?:javascript:|file:)/);
  assert.match(markup, /href="https:\/\/example.com\/docs"/);
  assert.match(markup, /rel="noreferrer noopener"/);
});

test("event parsing rejects arrays and untyped objects", () => {
  assert.equal(parseServerEvent("[]"), null);
  assert.equal(parseServerEvent('{"text":"untyped"}'), null);
  assert.deepEqual(parseServerEvent('{"type":"question_state","question_id":"q"}'), { type: "question_state", question_id: "q" });
});

test("late messages from a stopped socket cannot revive the client or change answers", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const connections: FakeWebSocket[] = [];
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSING = 2;
    readyState = 0;
    listeners = new Map<string, Array<(event: any) => void>>();
    constructor(_url: string) { connections.push(this); }
    addEventListener(type: string, listener: (event: any) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }
    emit(type: string, event: any = {}) { this.listeners.get(type)?.forEach((listener) => listener(event)); }
    send(_payload: string) {}
    close(code = 1000) { this.readyState = 3; this.emit("close", { code }); }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, setInterval, clearInterval } });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
  const received: ServerEvent[] = [];
  const states: string[] = [];
  const client = new SessionClient("http://127.0.0.1:8000", { interview_id: "synthetic", session_token: "synthetic-token" }, {
    onEvent: (event) => received.push(event), onConnectionChange: (state) => states.push(state), onError: () => {}, onSessionUnavailable: () => {},
  });
  try {
    const ready = client.start();
    const socket = connections[0];
    socket.readyState = 1;
    socket.emit("open");
    socket.emit("message", { data: JSON.stringify({ type: "session_ready", realtime_protocol: "interview-chat-v12" }) });
    await ready;
    assert.equal(received.length, 1);
    assert.equal(received[0].type, "session_ready");
    client.stop();
    socket.emit("message", { data: JSON.stringify({ type: "session_ready", realtime_protocol: "interview-chat-v12" }) });
    socket.emit("message", { data: JSON.stringify({ type: "answer_delta", response_id: "stale", delta: "stale" }) });
    assert.equal(client.isReady(), false);
    assert.equal(received.length, 1);
    assert.equal(states.at(-1), "disconnected");
  } finally {
    client.stop();
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
    if (oldWebSocket) Object.defineProperty(globalThis, "WebSocket", oldWebSocket); else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});
