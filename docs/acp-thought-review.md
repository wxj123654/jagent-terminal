# ACP 思考内容审查

日期：2026-10-20。范围是未提交的 ACP `agent_thought_chunk` 展示，对照确认过的方案。不含同工作区里无关的 rustfmt diff。

## 方案

- `TurnCollector` 单独收集 `agent_thought_chunk`（只收 `content.type == text`），按 `messageId` 分段。`assemble_body()` 仍只产出回复正文。
- `AcpTurnUpdate.thought` 覆盖流式快照和 `prompt_structured` 定稿。旧 `prompt()` 仍只回字符串。`session/load` 经 `ReplayedMessage.thought` 还原。
- `ChatMessage.thought` 不并入 `text`。流式更新和定稿都写入该字段。
- 展示在角色头下、工具卡和正文上。生成中展开，定稿后默认折叠并显示首行摘要。没有思考则不渲染。「正在思考…」占位保持原样。
- 不做 `plan` / `usage`，不把 `thought_level` 和思考正文混在一起，不改权限、握手、prompt 参数。

## 结论

主体按方案落地。审查后补了一处失败定稿清掉思考的问题，见下方第 1 条。

## 发现

### 1. 失败定稿清掉已收到的思考（已修）

`finish_acp` 的错误分支原来走 `finish_send_with_tools`，而它把 `thought` 写成空串。流式阶段已经写入的思考会在连接或协议失败时消失。

现改为：错误定稿若没有新的思考正文，保留流式阶段已收到的 `thought`。回归：`failed_acp_finish_keeps_the_thought_already_streamed`。

### 2. 思考不进 state.json（沿用现状，未改）

方案写的是「持久化沿用现有 `ChatMessage` 序列化；旧记录缺字段按空字符串读」。`ChatMessage` 没有 serde，会话落盘时消息本来就是 `messages: vec![]`。正文和思考一样，重启后只靠 `session/load` 回来。这不是这次新丢的字段。

### 3. 正文分段多了一处行为变化

`messageId` 变化时，只有前面已经有内容才插入 `\n\n`。空段不再制造多余空行。思考和正文共用这套规则。

### 4. 测试还缺折叠块本身

收集器覆盖了拼接、分段、与正文隔离、只有思考没有正文。store 覆盖了流式写入、定稿保留、失败保留。视图只有摘要截断测试，没有「生成中展开、定稿后折叠」的渲染测试。

## 约定侧

无硬违规：未改 `.refs`，未引入依赖。

判断项，未改：

- `update_streaming_reply` → `_with_tools` → `_full` 三层包装，ACP 已直达 `_full`。
- `text + thought + tool_calls` 在 `AcpTurnUpdate`、`ReplayedMessage`、`ChatMessage`、`RenderedRow` 各铺一遍。
- 思考折叠键是 `thought:{id}`，和工具卡共用 `collapsed_traces`。
- `thought_block` 与 `tool_trace_card` 的点击折叠写法平行。
