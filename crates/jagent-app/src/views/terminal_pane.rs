//! 终端面：按会话 id 绑定 `jagent-terminal` 的 `TerminalView`（对应旧 `surfaces/TerminalSurface.tsx`）。
//!
//! 会话比视图活得久（retain 语义）：切走再切回来，会话在池里照跑，这里只是重新建一个视图去渲染它。

use gpui::{AppContext as _, Context, Entity, Window};
use jagent_terminal::{TerminalPool, TerminalView};

/// 为 `session_id` 建一个终端视图并聚焦。会话不在池里（已退出被销毁）返回 `None`。
pub fn view_for_session<T: 'static>(
    session_id: u64,
    window: &mut Window,
    cx: &mut Context<T>,
) -> Option<Entity<TerminalView>> {
    let model = cx.global::<TerminalPool>().get(session_id)?;
    let view = cx.new(|cx| TerminalView::new(model, cx));
    // 聚焦纪律（旧 perf-analysis 7.2）：只在没有别的焦点时抢焦点，别把刚点的输入框的焦点抢走。
    if window.focused(cx).is_none() {
        let handle = view.read(cx).focus_handle().clone();
        handle.focus(window, cx);
    }
    Some(view)
}
