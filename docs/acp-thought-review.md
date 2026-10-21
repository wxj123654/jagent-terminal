# ACP 思考内容审查

日期：2026-10-20。范围是未提交的 ACP `agent_thought_chunk` 展示，对照确认过的方案。不含同工作区里无关的 rustfmt diff。后续 2026-10-22 对标 Claude 补齐时长标签与展开指示，见文末。

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

收集器覆盖了拼接、分段、与正文隔离、只有思考没有正文。store 覆盖了流式写入、定稿保留、失败保留。视图只有摘要截断测试，没有「生成中展开、定稿后折叠」的渲染测试。（渲染测试需要离屏窗口，仍未补；时长格式化已补单测。）

## 2026-10-22 对标完善：Claude「Thought for N seconds」

对标 Claude Desktop / Claude Code 的思考折叠块（Zed 社区同款诉求 zed#49960）：

- **时长统计**：`TurnCollector` 记录首/末 `agent_thought_chunk` 的 `Instant`，输出 `thought_ms()`；经 `AcpTurnUpdate.thought_ms` → `update_streaming_reply_full`/`finish_send_full` → `ChatMessage.thought_ms` 全链路传递。流式期间每帧写「已思考时长」实时快照（标题秒数随 chunk 跳动，chunk 停止后冻结在末 chunk 时刻，语义与 Claude 一致），定稿写最终值，失败定稿与 thought 正文一同保留。`session/load` 回放无时间信息，恒为 0。
- **标题标签**：流式「正在思考… Ns」+ accent 呼吸圆点（复用 thinking 占位行同款）；定稿「思考了 Ns」；不足 1 秒或回放无时长退化「思考」。`format_thought_duration` 按 N 秒 / N 分 M 秒 / N 时 M 分分级。
- **展开指示**：折叠态右侧改为「首行摘要 + ChevronRight」，展开态 ChevronDown，替换原「收起」文字。
- **remeasure 粒度**：`row_content_changed` 不计入 `thought_ms`（标题文本变化不影响行高），避免秒数跳动触发逐帧重测。

新增测试：`thought_timer_starts_only_with_thought_chunks`、`thought_duration_formats_like_claude_labels`；store 既有用例补 thought_ms 流式/定稿/失败保留断言。

## 约定侧

无硬违规：未改 `.refs`，未引入依赖。

判断项，未改：

- `update_streaming_reply` → `_with_tools` → `_full` 三层包装，ACP 已直达 `_full`。
- `text + thought + tool_calls` 在 `AcpTurnUpdate`、`ReplayedMessage`、`ChatMessage`、`RenderedRow` 各铺一遍。
- 思考折叠键是 `thought:{id}`，和工具卡共用 `collapsed_traces`。
- `thought_block` 与 `tool_trace_card` 的点击折叠写法平行。
