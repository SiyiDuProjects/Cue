// Offline JSON-RPC process. Writes only in the fixture's temporary directory.
const fs = require("node:fs");
const readline = require("node:readline");
let sequence = 0, turn = null;
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ id, result });
const event = (method, params = {}) => send({ method, params: { threadId: "fixture-thread", turnId: turn, ...params } });
readline.createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") reply(m.id, {});
  else if (m.method === "account/read") reply(m.id, { requiresOpenaiAuth: true, account: { type: "chatgpt" } });
  else if (m.method === "thread/start") reply(m.id, { thread: { id: "fixture-thread" } });
  else if (m.method === "thread/resume") reply(m.id, { thread: { id: m.params.threadId, status: { type: "idle" } } });
  else if (m.method === "turn/start") {
    turn = `turn-${++sequence}`;
    reply(m.id, { turn: { id: turn } });
    event("turn/started", { turn: { id: turn } });
    if (m.params.input.some(x => x.text === "wait-for-stop")) return;
    const implement = m.params.input.some(x => x.text === "implement fixture");
    if (implement) {
      fs.writeFileSync("solution.py", "def solve():\n    return 42\n");
      event("item/completed", {item:{id:"file-"+turn,type:"fileChange",status:"completed",changes:[{path:"solution.py"}]}});
    }
    const text = implement ? "**代码区已更新。**" : "**普通聊天保留代码区。**";
    event("item/agentMessage/delta", { itemId: turn + "-m", delta: text });
    event("item/completed", { item: { id: turn + "-m", type: "agentMessage", text } });
    event("turn/completed", { turn: { id: turn, status: "completed" } });
  } else if (m.method === "turn/interrupt") {
    reply(m.id, {}); event("turn/completed", { turn: { id: turn, status: "interrupted" } });
  }
});
