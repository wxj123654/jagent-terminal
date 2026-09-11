# 嵌套滚动机制调研：输入序列锁定滚动目标

调研问题（用户观察）：**鼠标不动连续滚轮，内层滚到底后父滚动区域不动；鼠标移动后再滚，父区域会滚。**

结论：这是浏览器"**一串输入锁定一个滚动目标（scroll latching / wheel transaction）**"的正常表现，不是每个 wheel 事件重新选择滚动容器。

> 全部数值与函数名来自 Chromium `main` 与 Firefox `main` 源码（2026-09-10 联网核实）。
> **未做真实浏览器实测**；未穷尽 macOS 平台入口、iframe/OOPIF 与 scroll unification 全路径。`main` 是浮动主干，不等于用户当前二进制。

## 1. 机制分层

| 层 | 决定什么 | 关键事实 |
| --- | --- | --- |
| DOM 事件层 | wheel 事件派发给谁 | 首个 wheel 建立 transaction，target = 当时 **topmost** 元素；父节点收到冒泡 wheel ≠ 父容器滚动 |
| 滚动引擎层 | 谁真正消费位移 | 序列开始（GSB）沿祖先链选出"能消费该方向 delta"的节点并**锁定**；序列内更新只作用于锁定节点 |
| CSS 层 | 边界是否允许向祖先 chain | `overscroll-behavior: auto/contain/none`；规范明确不强制 chaining 实现方式 |
| 平台输入层 | 序列边界从哪来 | 触控板/精度触控板有原生 gesture phase；普通滚轮无 phase，由浏览器按**时间与指针位移**合成 |

两层最容易混淆：**允许 chain（找父容器）≠ 每个 tick 都会重新找。** 只有**新序列**重新找。

## 2. Chromium（main 分支）

### 2.1 序列划分：无 phase 输入由 `MouseWheelPhaseHandler` 合成

源码：`content/browser/renderer_host/input/mouse_wheel_phase_handler.{h,cc}`

| 条件 | 行为 |
| --- | --- |
| 常量 `kDefaultMouseWheelLatchingTransaction` | **500 ms** 空闲 → 合成零 delta 的 `PhaseEnded` |
| 常量 `kWheelLatchingSlopRegion` | **10.0**（widget 坐标单位） |
| 序列中（计时器在跑）每次 wheel | phase 置 `Changed`/`Stationary`，并 `Reset()` 计时器 → **持续续期** |
| 当前 wheel 位置与**本序列首个 wheel 位置**距离 ≥ 10 | `IsWithinSlopRegion()` 为 false → 结束旧序列、开启新序列 |
| 修饰键与首事件不同 | 同上级联分段 |
| 方向/轴变化 | 仅当首个 `GestureScrollUpdate` 的 ACK 已被记录为 **not consumed** 才分段（不是"反向即解锁"） |
| 有原生 phase 的设备 | 按 `Began/Ended/momentum` 处理；`PhaseEnded` 后最多等 **100 ms** momentum 开始；momentum 开始会丢弃待发送 end，惯性不中断 |

注意比较对象是**序列首个位置**，不是相邻两次移动，也不是鼠标路径累计长度。

### 2.2 目标选择与锁定：`cc/input/input_handler.cc`

- `InputHandler::ScrollBegin()` → `FindNodeToLatch()`：从命中节点沿 `parent` 向上，逐节点 `CanConsumeDelta()`（begin 阶段用 delta hint；沿链时跳过 `!user_scrollable_*` 且允许 chain 的节点）；命中 `overscroll-behavior` 非 auto 且不能传播的节点 → 锁死该节点并 `set_is_scroll_chain_cut(true)`。
- `InputHandler::ScrollUpdate()` → **只用** `CurrentlyScrollingNode()` → `ScrollLatchedScroller()`；**不重新命中、不重新沿链选择**。
- 到边界：`ScrollLatchedScroller` 内 `applied_delta = 0` 后直接 `return`（源码里还留着 `// If the layer wasn't able to move, try the next one in the hierarchy.` 的**过时注释**，实现并不向上尝试）；未消费 delta 记为 `overscroll_delta_for_main_thread_`，不交给父节点。
- `ScrollEnd()` 清除锁定；滚动动画、scroll snap、弹性 overscroll 可能延迟清除，`ScrollBegin` 也有继续锁住未结束动画节点的分支。
- `main_thread_hit_tested_reasons` 非空时（scroll unification 的主线程命中结果），`ScrollBegin` 会走 `FindNodeToLatch`；但 `ScrollUpdate` 依旧不重选。

### 2.3 完整时序

```
Wheel(无 phase) ──► 合成 Began/Changed ──► GSB ──► FindNodeToLatch（沿链选目标 + 锁定）
                                              │
                     GSU ──► ScrollLatchedScroller（只作用于锁定节点）
                                              │
                     到边界：未消费 delta 丢弃/overscroll，不换目标
                                              │
        停顿 500ms / 位移 ≥10 / modifier 变 ──► PhaseEnded ──► GSE ──► 清除锁定
                                              │
                     下一次 wheel ──► 新序列 ──► 由于内层已到底，FindNodeToLatch 选中父容器
```

## 3. Firefox（main 分支）

主线程 `WheelTransaction`（`dom/events/WheelHandlingHelper.cpp`）与 APZ `WheelBlockState`（`gfx/layers/apz/src/InputBlockState.cpp`）两级，规则与 Chromium **不同**。

偏好默认值（`modules/libpref/init/StaticPrefList.yaml`）：

- `mousewheel.transaction.timeout = 1500` (ms)
- `mousewheel.transaction.ignoremovedelay = 100` (ms)

主线程 `WheelTransaction`：

- 光标移出目标 frame 的屏幕矩形 → **立即** `EndTransaction()`。
- 在 frame 内移动 → 只清 `sEventTargetFrame`（DOM wheel target 重命中），**滚动事务保留**。
- 移动距离上次滚动 ≥ 100 ms 时记下 `sMouseMoved`；此后若再过 ≥ 100 ms 才来 wheel → 结束事务（移动后立即继续滚仍续期）。
- `UpdateTransaction()` 目标不能按该方向滚动时**不刷新事务状态**；`OnFailToScrollTarget()` 只有目标销毁才结束。

APZ `WheelBlockState`：

- `Update()`：`IsTargetConfirmed() && !apzc->CanScroll(event)` → **不更新 `mLastEventTime`**，源码注释明确说明"这样即使鼠标不动也能超时"。
- `OnMouseMove()`：移出目标 APZC 区域 → `EndTransaction()`；区域内移动记录 `mLastMouseMove`（同样受 100 ms 门槛）。
- `AllowScrollHandoff()`：`!IsTargetConfirmed() || !InTransaction()` → **事务内禁止 overscroll handoff**。

因此 Firefox 中"撞边后鼠标不动继续滚"最终（约 1.5 s）仍会开启新序列并滚父容器——**与 Chromium 的计时型续期不同，不能互相套用**。

## 4. 规范层

- **W3C Wheel Events**（`uievents/split/wheel-events.html` §wheel event transaction）：MUST 为第一个 wheel 建立 transaction，target 是首个 wheel 时 topmost 元素，时间窗为 implementation-specific。
  → 规范层面**没有**统一的毫秒数、位移阈值、方向反转或边界解锁规则。
- **CSS Overscroll Behavior**（`css-overscroll-1` §3）：`auto` 使用 UA 通常行为；原文 *"This specification does not mandate if and how scroll chaining or overscroll affordances be implemented."*
  → "未设 `contain` 却暂时不 chain"不违背规范。

## 5. 对观察的解释

| 观察 | 机制 |
| --- | --- |
| 鼠标不动一直滚，内层到底也不影响父 | 位置差恒为 0 且事件间隔 < 500 ms → 序列持续续期 → 锁定仍在内层；到边界后未消费 delta 只作 overscroll，`ScrollLatchedScroller` 不向上尝试 |
| 鼠标动了之后父开始滚 | 下一个 wheel 事件位置与序列首位置差 ≥ 10 → 旧序列结束 → 新序列 `ScrollBegin` → `FindNodeToLatch` 沿链查找，**内层已到底不能消费 → 选中父容器** |

关键点：**移动本身不是解锁动作**，它只是让**下一个 wheel 事件**开启新序列；新序列才会重新选目标。

推论（可验证）：鼠标不动但**停顿超过 500 ms** 再滚，也会滚父；移动不到 10 单位则不换序列；目标容器 `overscroll-behavior: contain` 时，新序列也不会 chain 到父。GPUIX 侧最后一条未实现，其余三条已在 `e2e/scroll-chain.e2e.test.tsx` 中覆盖。

## 6. 项目实现（本次落地）

`patches/gpuix-zed/0003-scroll-chain-and-range.patch` 现覆盖四个源文件：
`crates/gpui/src/window.rs`（新增序列状态与 API）、`elements/div.rs`、`elements/list.rs`、
`crates/gpui/src/taffy.rs`（滚动范围改为跟随子元素，见 §7）。

窗口级状态 `ScrollSequence`：

- `owner`：锁定容器的 `GlobalElementId` + 认领时的 `bounds`；
- `origin` / `modifiers`：序列首个 wheel 事件的位置与修饰键；
- `last_event`：上一次 wheel 的时刻。

`Window::claim_scroll_wheel(id, bounds, event, can_consume, cx) -> bool`：

| 规则 | 行为 |
| --- | --- |
| 距上次 wheel ≤ `SCROLL_SEQUENCE_IDLE_TIMEOUT`（500ms） | 算同一序列 |
| 指针与 `origin` 距离 < `SCROLL_SEQUENCE_POINTER_SLOP`（10px） | 算同一序列 |
| modifiers 与序列首事件相同 | 算同一序列 |
| 以上任一不满足 | 开启新序列（清 owner，重记 origin/modifiers） |
| 指针离开 owner 的 bounds | 结束序列（避免切换面板后仍锁在旧容器） |
| owner 为空且 `can_consume` | 认领并返回 true（到底的容器不认领，保留向祖先 chain 的机会） |
| owner 非空 | 仅 owner 返回 true，其余拒绝 |
| `TouchPhase::Ended` / `Cancelled` | 本次事件仍归 owner，处理完结束序列 |

调用侧（div / list）只在**确实能移动**时才调用 claim：先算出候选偏移（div 按 `scroll_max` clamp，list 用 prepaint 快照 + live offset 比对），认领成功才写入偏移、`cx.notify`、`cx.stop_propagation`。

时间源用 `cx.background_executor().now()`：生产环境是真实时钟，测试走 TestDispatcher 的 fake clock（`t.renderer.advanceTime(ms)` 可推进），所以 500ms 超时与 10px 位移规则能在 e2e 里确定性验证（`e2e/scroll-chain.e2e.test.tsx`）。

**未改**：textarea、终端 `on_scroll`（终端把滚轮转成 PTY 输入或 scrollback，不能用“偏移是否变化”判断消费）；未实现 CSS 风格 `contain`（永不 chain）的表达。

相对浏览器仍有的差距：

1. 累积位移用精确像素比较，Chromium 另有 `kScrollEpsilon` 保护；亚像素残留的极端场景未对齐。
2. 未实现 Chromium 的“方向变化且首个 GestureScrollUpdate 未被消费则断序列”启发式。
3. DOM/JS 层 `onScroll` 本质是 wheel 回调，锁定被拒绝时仍会触发（与浏览器里 wheel 事件照常派发一致，但不要用它当“已滚动”信号）。

## 7. 幽灵滚动量：padding 被重复计入 `content_size`（2026-09-10 定位，09-11 修复）

**现象**：Git 图提交详情右栏（`git-cdv-files`，`padding: 10`）内容只有一行路径、
完全不溢出，却能上下滚 20px（滚到底留一段空白）。带 padding 的滚动容器一律如此。

**根因**（gpui 的算法 + 本项目 automation 层的组合）：

1. gpui 用滚动容器**子节点的包围盒**算可滚动尺寸：
   `content_size = child_max - child_min`（`crates/gpui/src/elements/div.rs` 的 prepaint），
   再 `scroll_max = content_size + padding_size - bounds.size`（`Interactivity::scroll_max`）。
2. automation 层为了给每个宿主元素记录盒子，往元素里塞了一个
   `absolute().size_full()` 的 canvas 子节点（`packages/native/src/automation.rs` 的
   `bounds_tracker`）。全尺寸子节点把 `content_size` 钉在元素自身尺寸上。
3. 两条相加：内容不溢出时 `content_size == bounds.size`，于是
   `scroll_max == padding_size` —— padding 被算了两遍，凭空多出 padding 总量的
   可滚动范围；内容溢出时同样多报 padding 总量。

最小复现（修复前实测；容器 300×200 + `padding: 10` → 正确值应为 `max(0, 子内容高 - 180)`）：

| 子内容高 | 实测 `scroll_max.y` | 正确值 |
| --- | --- | --- |
| 20 / 50 / 180 | 20 | 0 |
| 200 | 20 | 20 |
| 300 | 120 | 120 |
| 500 | 320 | 320 |

`padding: 0` 时不出现（`scroll_max` 恰好为 0），`padding: 40` 时多出 80 —— 多出的量恒等于 padding 总和，
与内容无关，这是判断该 bug 的特征。

**修复两条腿**（2026-09-11）：

1. `patches/gpuix/0003-bounds-tracker-inset.patch`：`bounds_tracker` 从
   `absolute().size_full()` 改成 `absolute().inset(px(0.))`。辅助 canvas 只为记录坐标／
   文本选择起区，不需要超出元素自身盒；`inset: 0` 让记录盒回到元素自己的盒子（padding 只
   内缩子元素，不再整体偏移原点），`getElementBounds` 因此返回真实布局盒。
2. `patches/gpuix-zed/0003-scroll-chain-and-range.patch` 的范围算法：普通流子元素取最远
   右下边缘 + 末端 padding，`position: absolute` 子元素取自身边缘且**不**追加末端 padding，
   无子元素时回退旧的 `content_size + padding`；新增
   `TaffyLayoutEngine::position_is_absolute` 与 `Window::layout_position_is_absolute`
   （`&self` 只读）。absolute 辅助节点因此不再贡献幽灵范围。

两处都改是为了不依赖上游未合并 PR 的行为，并让 bounds 记录回到元素自身盒。

上游 **未移植** 的部分：该 PR 的 `overscroll-behavior`（`Style`／`Styled` 新 API）与
`Window::take_scroll_wheel`／`scroll_wheel_taken` 的逐事件滚动接力——后者与本补丁的
「序列内到边界不交接」直接冲突（上游测试要求同一串事件内层到底后父层接管）。上游该 PR
状态：closed、未合并。

**回归**：`e2e/scroll-chain.e2e.test.tsx` 两个用例——「padded scroll containers expose no
phantom scroll range」（把全尺寸子节点塞回去即红：实测 `-20`）与「a padded scroll container
that fits its content stays put」；`GitGraphView.test.tsx` 的 CDV 用例断言右栏无滚动范围。

## 8. 未验证事项与验证方法

- 未在真实浏览器实测；未确认用户环境（Chrome/Firefox 版本、鼠标或触控板、是否 smooth scroll / scroll snap / iframe、`preventDefault()`、`contain`）。
- 验证实验：同一嵌套 overflow 页面，在 Chrome/Firefox 记录 passive wheel 的 `target/clientX/clientY/delta/timeStamp` 与各容器 `scrollTop`；分别测：静止连滚、停顿 > 500 ms 后继续、位移 <10 与 ≥10 单位、移出子区域、反向滚、`auto/contain/none`。不要用 `dispatchEvent(new WheelEvent(...))` 合成事件推断默认滚动链。

## 9. 来源

- W3C Wheel Events：<https://w3c.github.io/uievents/split/wheel-events.html>
- CSS Overscroll Behavior：<https://drafts.csswg.org/css-overscroll-1/>
- Chromium `mouse_wheel_phase_handler.h` / `.cc`：`content/browser/renderer_host/input/`
- Chromium `input_handler.cc`（`ScrollBegin` / `ScrollUpdate` / `ScrollLatchedScroller` / `FindNodeToLatch` / `CanConsumeDelta`）：`cc/input/`
- Blink `mouse_wheel_event_manager.cc`、`components/input/mouse_wheel_event_queue.cc`
- Firefox `dom/events/WheelHandlingHelper.cpp`、`gfx/layers/apz/src/InputBlockState.cpp`、`gfx/layers/apz/src/InputQueue.cpp`、`modules/libpref/init/StaticPrefList.yaml`
- 项目内：`patches/gpuix-zed/0003-scroll-chain-and-range.patch`、`patches/gpuix/0003-bounds-tracker-inset.patch`、`e2e/scroll-chain.e2e.test.tsx`、`.refs/gpuix/zed/crates/gpui/src/gestures.rs`
