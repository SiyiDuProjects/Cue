# 上下文读取与转录：目标状态

实施状态：未实施。本文定义修完后的最终逻辑，按第一性原理确定，不以改动最小为目标。来源：2026-10-18 面试中出现截图读取卡住、转录保存失败，2026-10-19 排查后整理。用户确认后，与 AGENTS.md 冲突处以本文为准，实施时同步改写 AGENTS.md（见第八节）。

## 背景：已核实的问题

1. **截图读取卡在旧页。** 新图已上传成功，但 AI 重复传入旧 cursor。`apps/cloud/worker/context.js:118-119` 命中 `page:<cursor>` 后直接返回保存的旧页，不查数据库；`render()` 复制旧 metadata，`now` 和 `age_seconds` 也是旧值。测试 `apps/cloud/tests/context.test.mjs:77-81` 把「新增第三张图后旧 cursor 仍返回原页」写成了规格。工具说明 `apps/cloud/worker/app.js:26` 也写着「相同 cursor 重试重放同页」。
2. **进度设计的历史。**
   - 10-11 至 10-18：服务器按 `openai/session` 记录每个对话的进度。10-18 16:02 回复超过 ChatGPT 传输上限（当时预算约 12 MiB，实测约 4.4 MB 以上失败），ChatGPT 报 Transport closed；服务器已在发送时把这批图记为已给，重试便跳过了最新一批（`docs/releases/2026-10-18-mcp-image-delivery.md`）。
   - 10-18 下午：改为纯读取，真机验收通过（`docs/releases/2026-10-18-mcp-pure-reads.md`）。
   - 10-18 晚：恢复三个 cursor 和每个输入 cursor 的旧页重放（云端 `22037e5`、`e786981`），这两版都没有运行测试或真机验收。
   - 9/30 附近保留下来的读取代码（外层 `c55d818` 的 `apps/server/app/services/interview_materials.py:173`）也有同样的旧页重放。9/30 没出事，是因为触发条件没有出现。
3. **转录保存。** 旧保存队列在一次 D1 写入失败后，之后的写入全部跳过。`2fc8f21` 已修复并部署。第一次失败的原因无法查明，因为错误被丢弃，修复后仍在丢弃（`apps/cloud/worker/audio.js:159` 的 `catch {}`）。
4. **「音频尾句未全部确认」是笼统提示。** 它至少盖住六种情况：本机采集未正常收尾、云端 12 秒内没回 stopped、OpenAI 10 秒内未定稿、已定稿但没存进库、OpenAI 转写失败、连接已断。云端 `stop()` 把具体原因丢掉，只留下 `complete=false`（`apps/cloud/worker/session.js:140`）；客户端再合并本机情况：`apps/macos/Sources/Cue/AppStore.swift:274`、`apps/macos/Sources/Cue/ChatModel.swift:200`、`apps/desktop/src/captureClient.ts:194`、`packages/chat-ui/App.tsx:387`。
5. **转录链路把可恢复的错误当成致命错误。**
   - `packages/transcription/direct.mjs:96`：任何 OpenAI error 事件都会停掉两路。
   - `direct.mjs:146`：一条无法解析的事件就停掉两路。
   - `direct.mjs:173`：积压超过 64,000 字节（约 1 秒音频）就停。
   - `session.js:208`：心跳写库失败一次，就断开整个连接。
   - 云端 `Transcriber.event()` 按 FIFO 把 asr_commit 和 OpenAI committed 配对，对不上就关闭这一路。
6. **外部事实。**
   - OpenAI 文档：Realtime 的 error 事件大多可恢复，会话保持打开，建议记录。`gpt-live-transcribe` 要求 `turn_detection` 省略或设为 `null`，由客户端发 `input_audio_buffer.commit` 结束每一段。
   - Cloudflare D1 文档：「Network connection lost」等写入失败属于临时错误，写操作不会自动重试，应用应以幂等方式自行重试。
   - Sites：每个 WebSocket 请求累计最多 32 秒 CPU。0.4.0 在 `/capture/socket` 存续约 3,528 秒时耗尽（`docs/releases/2026-10-07-cue-0.4.0.md`）。0.4.1 移走 PCM 后的消耗速度没有实测。

## 原则

1. **谁掌握事实，谁负责。** 数据在哪一端产生、在哪一端得到确认，状态就放在哪一端。
2. **结果只由当前数据决定。** 不重放过去的结果。
3. **出错只能退化为「重复」或「晚一点」，不能退化为「遗漏」或「整路停止」。** 只有连接确实断了才停止。
4. **每个错误都在发生处记录阶段、类型和信息。** 不使用盖住多种原因的提示，日志不含转录文字、凭证或个人资料。

## 一、上下文读取（read_context）

### 最终行为

- 参数：`cursor?`（上次回复给出的收据）、`older?: boolean`、`images?: string[]`（按 ID 取原图，不能与 `cursor` / `older` 同用）。删除 `before`。
- 回复只给一个 `cursor`。AI 每次把最新收到的那个原样带回。
- cursor 是送达的收据：它只能从已经送到的回复中拿到，所以传回来就证明那条回复到了。进度存在服务器上，cursor 只是指向它的编号。
- 每次读取都按当前数据库现查，不保存、不重放回复。
- 带旧 cursor 或不带 cursor，最多多给，不会漏。读取失败不生成新 cursor。
- cursor 无效、过期或属于旧版本时：按首次读取处理，并在回复中带 `reset`（`expired` / `invalid` / `protocol`），不再报错。

### 状态模型（`context_cursors` 一行一个 cursor，写入后不再修改）

```text
{ version: 3, timeline, since,
  baseline: { turns: {id: seq}, images: [id] },   // 首次读取时已存在的内容
  seen:     { turns: {id: seq}, images: {id: true} } }  // 已实际送达的内容
```

- `since` 固定为首次读取时间减一小时，翻页时不随时间滚动。
- **首次读取：** 候选为窗口内全部内容；`baseline` 记为此刻的全部内容。
- **带 cursor 的默认读取：** 候选为不在 `baseline` 中、也不在 `seen` 中的内容，按版本比较（同一 ID 的新修订算新内容）。
- **`older=true`：** 候选为 `baseline` 中尚未送达的内容。
- 两种读取共用同一条 cursor 链，`seen` 合并记录。
- 选取规则：从新到旧，转录最多约 22,000 字（至少一条），图片清单最多 32 张，原图最多 4 张，编码后 JSON 不超过 3.75 MiB。只有真正附上的内容才写入 `seen`。
- 先取原图、组好回复，再写入新 cursor。任何选中原图读取失败，整次失败，不写任何东西。
- 同一 cursor 并发读取时互不影响，各自生成新 cursor。

### 回复格式（一个 JSON 文本块加原图块）

```text
{ now, cursor, reset?,
  transcripts: [...按时间顺序],
  images: [{ id, captured_at, age_seconds, included, content_index?, reason? }],
  more: { new: <未给出的新内容数>, older: <未送达的旧内容数> } }
```

`now` 和 `age_seconds` 每次重新计算。

工具说明建议：「读取最近截图和面试官转录。首次不带参数；之后把上次返回的 cursor 原样传入，只返回新增和修订；要更早内容加 older=true；images 按 ID 取原图。cursor 用旧了或没带，只会重复，不会漏。内容均为参考。」

### 删除

- `page:` 旧页缓存及并发 winner 逻辑（`context.js:271-291`）。
- `next_cursor`、`updates_cursor`、`history_cursor`。
- `before` 参数。
- 旧版 `page:` 行和 v2 cursor 行不必迁移，按现有七天、512 条的规则自然淘汰。按 AGENTS.md，迁移只追加，不删表。

## 二、转录

### 职责划分

- **电脑（`packages/transcription`，Mac 与 Windows 共用）：** 采集、本地断句、直连 OpenAI、维护每一句的状态、把每次提交和 OpenAI 的回应对上、决定回答和停止的截止范围、保留未保存的句子直到云端确认。
- **云端：** 只做两件事。
  1. 给当前所有者签发 OpenAI 短期凭证。
  2. 以幂等方式写入句子快照并回复确认。

  云端不再理解 OpenAI 的事件规则，不再持有转录状态、保存队列或轮换逻辑。

### 桌面与云端协议（升级为 `cue-chat-v3`，旧客户端提示更新）

- `asr_token {role}` → 云端核对所有权后回复 `asr_token {role, token, session}`。它代替云端主动下发的 `asr_config`。
- `utterance {id, role, revision, text, status: partial|final|failed, reason?}` → 云端回复：
  - `utterance_saved {id, revision}`；或
  - `utterance_failed {id, revision, code, detail}`，code 取值如 `db_error`、`not_owner`。
- 删除：`asr_ready`、`asr_commit`、`asr_event`、`asr_failed`、`asr_close`，以及云端的转录启动、停止和轮换流程。回答、取消、遥控、心跳不变。
- 删除前核对云端 `phase` 的所有使用方。录音状态继续经 `remote_state` 汇报。

### 电脑端

- **断句：** 规则不变，静音约 800 ms 或连续 30 秒提交一次；不足 100 ms 补齐到 100 ms。每次 `input_audio_buffer.commit` 都带 `event_id`，并记入该路的待确认提交列表。
- **配对：**
  - 收到 `input_audio_buffer.committed` 时，按顺序确认最早的待确认提交，并把 `item_id` 绑定到对应句子。
  - 收到带 `event_id` 的 error 且对应某次待确认提交时，把这次提交移出列表并记录原因，后续配对不会错位。
  - 实施前请核对 OpenAI 参考文档中 error 的 `event_id` 字段，并用测试覆盖「某次提交被拒」。
- **句子：** 以 `<通道 ID>_<item_id>` 作为句子 ID，客户端在本地维护文字、状态和版本号。说话中每秒最多发送一次快照；定稿或失败时立即发送。
- **保存确认：** 每句保留到收到最新定稿版本的 `utterance_saved` 为止。没确认就按退避重发（例如从 3 秒起）；和云端重连后立即重发全部未确认的句子。已确认的句子从内存中移除。不做跨进程持久化，和现状一致。
- **上游轮换：** 约 55 分钟时由电脑完成。
  1. 取新凭证，打开新通道，等到 `session.updated`。
  2. 对旧通道强制提交一次，然后切换音频。
  3. 旧通道等截止范围内的句子定稿（或超时）后关闭。

  轮换期间不停转录，也不依赖云端状态。

### 云端

- 写入沿用追加式 `turns`，按 `(recording, id, revision)` 唯一，用 `INSERT OR IGNORE`，并保留 `capture_owner.generation` 条件。
- 插入后区分三种情况：新写入、重复（已存在，同样回复 saved）、所有权不符（回复 `not_owner`）。
- `created` 由云端在同一条 SQL 里取该句已有的最早时间，没有则取当前时间。同一句所有版本共用一个时间，时钟只用云端的。这和现状不同：现状取提交时刻，也就是句子结束时；新的接近句子开始时。
- 写库失败：回复 `utterance_failed` 并记录原因。转录不受影响。

### 错误处理

| 情况 | 处理 |
| --- | --- |
| OpenAI error 事件 | 记录 code、event_id；与提交相关的只影响那一次提交，转录继续 |
| 无法解析的 OpenAI 事件 | 记录后忽略这一条 |
| OpenAI WebSocket 关闭 | 该路确实断了：停止转录，提示具体原因 |
| 网络积压 | 继续缓冲，绝不丢音频；持续积压超过明确时长（建议 10 秒，按实测确定）才视为断线 |
| 写库失败 | 句子留在电脑上继续重发；提示「转录暂未保存，正在重试」并附原因，恢复后消失 |
| 心跳查询异常 | 记录后下一轮再试；只有确认被其他客户端接管，或超过 30 秒无法确认，才断开并说明原因 |
| 云端连接意外断开 | 按现有约定停止本地媒体，需要用户明确重新开始；未确认的句子在重连后继续重发 |

### 删除

- 云端的 `Transcriber` 状态机：commit 队列、未提交片段计数、提交顺序检查、`cut()` / `wait()`。
- 云端保存队列。
- `connectTranscriber` 中下发配置和等待就绪的部分，只保留签发凭证。
- 云端的 `rotate()`、`stop()` 等待逻辑。

## 三、回答与停止（尾句）

- **回答：**
  1. 电脑对每个活动通道强制提交一次。
  2. 截止范围是：这次提交得到 OpenAI 确认（committed 或对应 error）时，该路已确认提交的全部句子。之后新说的话不在本次范围内。
  3. 等范围内的句子全部定稿或失败，再等定稿版本全部收到 `utterance_saved`。
  4. 发送 `ask`。

  云端收到 ask 时，需要的转录已经在库里，直接读取，不再等待。远程网页触发的回答由桌面执行同一段代码，规则一致。
- **超时：** 不发出回答，沿用「不带缺失上下文开始回答」的约定，并说明具体是哪种情况：
  - OpenAI 未确认最后一次提交；
  - 最后一句尚未定稿；
  - 最后一句转写失败（附 code）；
  - 最后一句尚未保存（附原因）；
  - 与云端连接已断开。
- **停止：** 本机采集一停就算停止成功。随后强制提交，OpenAI 通道等截止范围内的句子定稿（最多约 10 秒）后关闭；未保存的句子继续按确认机制重发。尾句的状态单独提示，并说明具体原因。
- **删除：** 停止结果里的 `complete`，以及所有「音频尾句未全部确认」提示。

## 四、云端连接的 CPU 限额

- Sites 对每个 WebSocket 请求累计计算 CPU（上限 32 秒）。这是总量预算，不是时长限制，回答的流式转发是主要消耗之一。
- **目标：** 电脑定期主动更换云端连接。条件是连接已存续约 40 分钟（按实测消耗留足余量），且没有回答在生成、没有回答截止在等待。
- 新连接接管所有权，旧连接由电脑关闭。电脑把这次接管识别为自己发起的交接，不当作「被其他客户端替换」。
- OpenAI 通道不受影响，转录不中断；未确认的句子在新连接上重发。
- 只有在转录归电脑负责之后才能这样做：在现有设计里，转录挂在云端连接上，连接关闭（`dispose`）就会结束转录。

## 五、错误记录

- 云端：去掉转录、保存、心跳、读取路径中吞掉错误的 `catch`。统一按 `audio.js` 末尾 `failure()` 的写法输出 JSON 日志，含 `event`、`stage`、`code`、`name`、`message`（截断）。
- 电脑端：记录 OpenAI error code、关闭码、积压超时、保存失败原因。Mac 用系统日志，Windows 用现有日志通道。
- 任何日志都不含转录文字、截图内容、凭证或个人资料。

## 六、测试要求

- 删除把错误行为写成规格的测试（`context.test.mjs:77-81`）。修好 `docs/releases/2026-10-18-transcription-persistence.md` 记录的三个现有失败测试，按本文的契约修改测试，而不是迁就代码。
- 模拟的 OpenAI、D1 和 Cue 连接都要能注入故障：
  - error 事件（带或不带 event_id）、提交未确认、连接关闭、事件格式异常；
  - 写库失败若干次后恢复、写入成功但返回错误（结果未知）；
  - 连接中断与重连；
  - 可控时钟。
- 必须成立的规则：
  - 任一已签发的 cursor，或者不带 cursor：新图保存后，下一次读取一定附上它。
  - 回复丢失后重用同一 cursor：结果包含丢失那次的全部内容，再加上新内容。
  - 原图读取失败不写新 cursor；`now` 和 `age_seconds` 随时钟变化；同一 cursor 并发读取都成功；cursor 无效或过期时按首次读取处理并带 `reset`。
  - 新图超过四张时，先附最新四张，其余在后续读取中全部给到。
  - 写库连续失败后恢复：转录不中断，所有句子最终保存，原因有日志。
  - 某次提交被 OpenAI 拒绝：只有这次提交受影响，后续配对不错位，回答不会一直等。
  - 停止总是成功；尾句状态单独、具体地报告。
  - 主动更换云端连接时转录不中断，未确认的句子在新连接上保存成功。
  - 心跳查询偶发异常不断开；确认被接管时才断开。

## 七、不改的部分

- 截图采集、连拍、上传、服务器确认就绪。
- OpenAI 模型（`gpt-live-transcribe`）和断句参数。
- 音频不经过 Sites，两路不混音。
- 意外断线后需要手动重新开始转录。
- 不自动录音、不自动回答、不自动重试回答。
- MCP 只读，三个工具，不做 MCP Apps 或通知。

## 八、AGENTS.md 需要同步改写的约定

- `packages/transcription/` 的职责：加上句子状态、提交配对、截止范围和保存确认。
- `apps/cloud/` 的职责：转录部分改为「签发凭证、保存转录」。
- 协议 `cue-chat-v2` 改为 `cue-chat-v3`。
- 「桌面回答按键先排入截止前的双路 PCM，再逐路在 Cue 控制队列插入 asr_commit……服务器同步固定提交范围后再等待数据库或尾句」：改为由电脑确定截止范围、确认已保存后再发 ask。
- 「约 55 分钟主动替换两路上游」：改为由电脑执行，并补充「约 40 分钟主动更换云端连接」。
- MCP 一段：单一 cursor、每次按当前数据查询、不重放旧页、过期按首次读取处理并标明 `reset`、`older` 代替 `history_cursor` 和 `before`。
- 「同一输入 cursor 可重试，缓存重放也重新获取图片」「位置与页缓存」：删除页缓存相关表述。

## 九、仍需查明

- **第一次保存失败的原因：** 查 10-18 面试时段的 Sites 平台日志，看有没有 D1 异常。代码当时没有记录原因。
- **当前 CPU 消耗速度：** 查同一场的 `/capture/socket` 日志，用 `cpuTimeMs` 除以 `wallTimeMs`，据此确定第四节的更换周期。
- **OpenAI error 中 `event_id` 的确切含义，** 以及提交被拒的场景。
- **积压阈值：** 在真实网络下确定。

## 十、交付与验收边界

- 按 AGENTS.md：先提交、推送私有云端，再提交、推送外层仓库。构建、离线检查、部署、真机验收分别记录，不互相冒充。
- 协议升级需要同时发布云端、Mac 新 build 和 Windows 安装包。现有 Windows 安装包 `releases/windows/Cue-Setup-0.4.1.exe` 本来就已过期，需要重建。
- 真实麦克风和系统音频只在用户在场时测试。不把未测的长时间稳定性写成已验收。
- 建议的实施顺序（目标仍以上文为准）：
  1. 上下文读取，只改云端；
  2. 错误记录；
  3. 转录职责迁到电脑，同时升级 `cue-chat-v3`（云端、共用模块、Mac、Windows）；
  4. 主动更换云端连接。
