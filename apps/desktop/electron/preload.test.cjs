const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("production preload preserves the full Cue origin and delivers control events", async () => {
  const exposed = {}, calls = [], listeners = {}, events = [];
  vm.runInNewContext(fs.readFileSync(require.resolve("./preload.cjs"), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
      ipcRenderer: {
        invoke: async (...args) => { calls.push(args); },
        on: (name, callback) => { listeners[name] = callback; },
      },
    }),
    process: { argv: ["electron", "--cue-origin=https://cue.siyidu.com"] },
    window: { dispatchEvent: event => events.push(event.type) },
    Event: class { constructor(type) { this.type = type; } },
  });
  const bridge = exposed.cueCaptureHost;
  assert.equal(bridge.origin, "https://cue.siyidu.com");
  await bridge.connect();
  await bridge.screenshot();
  assert.deepEqual(calls, [["cue:connect"], ["cue:screenshot"]]);
  listeners["cue:answer-requested"]();
  assert.deepEqual(events, ["cue:answer-requested"]);
});
