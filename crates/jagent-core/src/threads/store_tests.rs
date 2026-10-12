//! ThreadStore 规则测试：逐条对应旧 `packages/app/src/threads/__tests__/store.test.ts`。
//!
//! 夹具 [`Fake`] 实现 [`Effects`]，把副作用记录下来供断言；时钟 / id 都是确定性的。
//! 旧测试里靠 `await flush()` 等路由的地方，在这里是同步断言（导航是 store 的字段）。

use std::cell::RefCell;
use std::rc::Rc;

use super::*;
use crate::presets::{TerminalPreset, builtin_preset};

#[derive(Default)]
struct Log {
    destroyed: Vec<u64>,
    notified: Vec<String>,
    disposed: Vec<String>,
    close_on_exit: bool,
}

/// 可克隆的夹具：store 持有一份，测试持有另一份读取日志。
#[derive(Clone, Default)]
struct Fake {
    log: Rc<RefCell<Log>>,
    clock: Rc<RefCell<i64>>,
    ids: Rc<RefCell<u64>>,
}

impl Effects for Fake {
    fn destroy_session(&mut self, id: u64) {
        self.log.borrow_mut().destroyed.push(id);
    }
    fn notify(&mut self, t: &Thread) {
        self.log.borrow_mut().notified.push(t.id().to_owned());
    }
    fn close_on_exit(&self) -> bool {
        self.log.borrow().close_on_exit
    }
    fn dispose_acp(&mut self, id: &str) {
        self.log.borrow_mut().disposed.push(id.to_owned());
    }
    fn now(&self) -> i64 {
        let mut c = self.clock.borrow_mut();
        *c += 1;
        *c
    }
    fn new_id(&mut self) -> String {
        let mut n = self.ids.borrow_mut();
        *n += 1;
        format!("id{n}")
    }
    fn default_cwd(&self) -> String {
        "/proc/cwd".into()
    }
}

type Store = ThreadStore<Fake>;

fn store() -> (Store, Fake) {
    let fake = Fake::default();
    (ThreadStore::new(fake.clone(), vec![]), fake)
}

fn store_with(ws: Vec<Workspace>) -> (Store, Fake) {
    let fake = Fake::default();
    (ThreadStore::new(fake.clone(), ws), fake)
}

/// 旧测试里的 `await store.spawnFromPreset(id)`：两步合并成一个同步调用。
fn spawn(s: &mut Store, preset_id: &str, ws: Option<&str>, session_id: u64) -> String {
    let preset = builtin_preset(preset_id);
    let req = s.begin_spawn(preset.as_ref(), preset_id, ws).unwrap();
    s.finish_spawn(&req, session_id)
}

fn term<'a>(s: &'a Store, id: &str) -> &'a TerminalThread {
    s.thread(id).and_then(Thread::as_terminal).unwrap_or_else(|| panic!("no terminal {id}"))
}

fn chat<'a>(s: &'a Store, id: &str) -> &'a ChatThread {
    match s.thread(id) {
        Some(Thread::Chat(c)) => c,
        _ => panic!("no chat {id}"),
    }
}

fn acp<'a>(s: &'a Store, id: &str) -> &'a AcpThread {
    match s.thread(id) {
        Some(Thread::Acp(a)) => a,
        _ => panic!("no acp {id}"),
    }
}

fn ids(s: &Store) -> Vec<String> {
    s.threads.iter().map(|t| t.id().to_owned()).collect()
}

fn thread_target(id: &str) -> ActiveTarget {
    ActiveTarget::Thread(id.into())
}

fn ws(id: &str, path: &str, created: i64) -> Workspace {
    default_workspace(id.into(), path, created)
}

// ═════════════════════ spawnFromPreset ═════════════════════

#[test]
fn spawn_pushes_thread_sets_last_used_preset_and_activates() {
    let (mut s, _) = store();
    spawn(&mut s, "claude", None, 1);
    assert_eq!(s.threads.len(), 1);
    let t = term(&s, "t1");
    assert_eq!(t.preset.as_deref(), Some("claude"));
    assert_eq!(s.last_used_preset.as_deref(), Some("claude"));
    assert_eq!(s.active(), &thread_target("t1"));
}

#[test]
fn spawn_unknown_preset_errors_and_leaves_state_unchanged() {
    let (s, _) = store();
    let err = s.begin_spawn(None, "nope", None).unwrap_err();
    assert_eq!(err, StoreError::UnknownPreset("nope".into()));
    assert!(err.to_string().contains("unknown preset"));
    assert!(s.threads.is_empty());
}

#[test]
fn spawn_passes_preset_fields_and_cwd_falls_back_to_process_cwd() {
    let custom = TerminalPreset {
        id: "my".into(),
        label: "My".into(),
        description: None,
        builtin: false,
        program: Some("pwsh".into()),
        args: Some(vec!["-NoLogo".into()]),
        env: Some([("FOO".to_owned(), "1".to_owned())].into()),
        init_command: Some("echo hi".into()),
        cwd: None, // 故意不填
        category: None,
    };
    let (s, _) = store();
    let req = s.begin_spawn(Some(&custom), "my", None).unwrap();
    assert_eq!(req.cwd, "/proc/cwd");
    assert_eq!(req.preset.program.as_deref(), Some("pwsh"));
    assert_eq!(req.preset.args, Some(vec!["-NoLogo".into()]));
    assert_eq!(req.preset.init_command.as_deref(), Some("echo hi"));
}

// ═════════════════════ activate / bell ═════════════════════

#[test]
fn bell_on_background_sets_red_dot_and_notifies_activate_clears_and_active_bell_is_ignored() {
    let (mut s, f) = store();
    spawn(&mut s, "shell", None, 1);
    spawn(&mut s, "shell", None, 2); // t2 激活，t1 转后台
    s.activate(thread_target("t1"));

    s.on_session_event(SessionEvent::Bell { session_id: 2 });
    assert!(term(&s, "t2").has_bell);
    assert_eq!(f.log.borrow().notified, ["t2"]);

    s.activate(thread_target("t2")); // 清红点
    assert!(!term(&s, "t2").has_bell);

    s.on_session_event(SessionEvent::Bell { session_id: 2 }); // active 时不落红点也不通知
    assert!(!term(&s, "t2").has_bell);
    assert_eq!(f.log.borrow().notified, ["t2"]);
}

#[test]
fn activate_settings_and_home_leave_threads_untouched() {
    let (mut s, _) = store();
    spawn(&mut s, "shell", None, 1);
    let before = s.threads.clone();
    s.activate(ActiveTarget::Settings);
    assert_eq!(s.active(), &ActiveTarget::Settings);
    assert_eq!(s.threads, before);
    s.activate(ActiveTarget::Home);
    assert_eq!(s.active(), &ActiveTarget::Home);
    assert_eq!(s.threads, before);
}

// ═════════════════════ title / exit / closeOnExit ═════════════════════

#[test]
fn osc_title_updates_and_custom_title_freezes() {
    let (mut s, _) = store();
    spawn(&mut s, "shell", None, 1);
    s.on_session_event(SessionEvent::Title { session_id: 1, title: Some("vim".into()) });
    assert_eq!(term(&s, "t1").osc_title.as_deref(), Some("vim"));

    s.on_session_event(SessionEvent::Title { session_id: 1, title: Some(String::new()) }); // 空串忽略
    assert_eq!(term(&s, "t1").osc_title.as_deref(), Some("vim"));

    s.rename("t1", "我的会话");
    s.on_session_event(SessionEvent::Title { session_id: 1, title: Some("osc-after-rename".into()) });
    assert_eq!(term(&s, "t1").custom_title.as_deref(), Some("我的会话"));
    assert_eq!(term(&s, "t1").osc_title.as_deref(), Some("vim"), "未被覆盖");
}

#[test]
fn rename_blank_is_ignored() {
    let (mut s, _) = store();
    spawn(&mut s, "shell", None, 1);
    s.rename("t1", "   ");
    assert_eq!(term(&s, "t1").custom_title, None);
}

#[test]
fn exit_without_close_on_exit_keeps_a_grey_row() {
    let (mut s, _) = store();
    spawn(&mut s, "shell", None, 1);
    s.on_session_event(SessionEvent::Exit { session_id: 1, code: None });
    assert_eq!(term(&s, "t1").status, RunStatus::Exited);
    assert_eq!(s.threads.len(), 1, "不变量 3：exited 会话仍在池中");
}

#[test]
fn exit_code_flows_through_and_missing_code_is_none() {
    let (mut s, _) = store();
    spawn(&mut s, "shell", None, 1);
    spawn(&mut s, "shell", None, 2);
    s.on_session_event(SessionEvent::Exit { session_id: 1, code: Some(0) });
    s.on_session_event(SessionEvent::Exit { session_id: 2, code: None });
    assert_eq!(term(&s, "t1").exit_code, Some(0));
    assert_eq!(term(&s, "t2").exit_code, None);
}

#[test]
fn exit_with_close_on_exit_removes_the_row_and_navigates_away_first() {
    let (mut s, f) = store();
    f.log.borrow_mut().close_on_exit = true;
    spawn(&mut s, "shell", None, 1);
    s.on_session_event(SessionEvent::Exit { session_id: 1, code: None });
    assert!(s.threads.is_empty());
    assert_eq!(f.log.borrow().destroyed, [1]);
    assert_eq!(s.active(), &ActiveTarget::Home, "先导航离开");
}

// ═════════════════════ close ═════════════════════

#[test]
fn close_active_thread_navigates_away_then_removes_and_destroys() {
    let (mut s, f) = store();
    spawn(&mut s, "shell", None, 1);
    s.close("t1");
    assert!(s.threads.is_empty());
    assert_eq!(f.log.borrow().destroyed, [1]);
    assert_eq!(s.active(), &ActiveTarget::Home);
}

#[test]
fn close_background_thread_does_not_navigate() {
    let (mut s, f) = store();
    spawn(&mut s, "shell", None, 1);
    spawn(&mut s, "shell", None, 2); // t2 active
    s.close("t1");
    assert_eq!(ids(&s), ["t2"]);
    assert_eq!(f.log.borrow().destroyed, [1]);
    assert_eq!(s.active(), &thread_target("t2"));
}

#[test]
fn close_unknown_id_is_a_no_op() {
    let (mut s, f) = store();
    s.close("t404");
    assert!(f.log.borrow().destroyed.is_empty());
}

// ═════════════════════ cycle ═════════════════════

#[test]
fn cycle_wraps_in_both_directions() {
    let (mut s, _) = store();
    for i in 1..=3 {
        spawn(&mut s, "shell", None, i);
    } // t3 active
    s.cycle(1);
    assert_eq!(s.active_thread_id(), Some("t1"), "t3 → t1 回卷");
    s.cycle(-1);
    assert_eq!(s.active_thread_id(), Some("t3"), "t1 → t3 回卷");
    s.cycle(1);
    assert_eq!(s.active_thread_id(), Some("t1"));
}

#[test]
fn cycle_without_active_goes_first_forward_and_last_backward() {
    let (mut s, _) = store();
    spawn(&mut s, "shell", None, 1);
    spawn(&mut s, "shell", None, 2);
    s.activate(ActiveTarget::Settings);
    s.cycle(1);
    assert_eq!(s.active_thread_id(), Some("t1"));
    s.activate(ActiveTarget::Home);
    s.cycle(-1);
    assert_eq!(s.active_thread_id(), Some("t2"));
}

#[test]
fn cycle_on_empty_store_is_a_no_op() {
    let (mut s, _) = store();
    s.cycle(1);
    assert_eq!(s.active(), &ActiveTarget::Home);
}

// ═════════════════════ chat ═════════════════════

#[test]
fn create_chat_pushes_an_empty_default_titled_thread_and_activates() {
    let (mut s, _) = store();
    let id = s.create_chat(None).unwrap();
    let c = chat(&s, &id);
    assert_eq!((c.title.as_str(), c.messages.len(), c.pending_reply), ("Chat", 0, false));
    assert_eq!(s.active(), &thread_target(&id));
    assert!(id.starts_with('c'));
}

fn two_chats() -> (Store, Fake, String, String) {
    let (mut s, f) = store();
    let a = s.create_chat(None).unwrap();
    let b = s.create_chat(None).unwrap();
    (s, f, a, b)
}

#[test]
fn chat_send_appends_user_sets_pending_then_reply_clears_it() {
    let (mut s, _, id, _) = two_chats();
    let req = s.begin_send(&id, "第一条", ConversationKind::Chat).unwrap();
    assert_eq!(req.text, "第一条");
    let c = chat(&s, &id);
    assert_eq!(c.messages.len(), 1);
    assert!(c.messages[0].is_user() && c.messages[0].text == "第一条");
    assert!(c.pending_reply);

    s.finish_send(&id, ConversationKind::Chat, Ok("回复 A".into()));
    let c = chat(&s, &id);
    assert_eq!(c.messages.len(), 2);
    assert_eq!(c.messages[1].text, "回复 A");
    assert!(!c.messages[1].is_user() && !c.messages[1].is_error());
    assert!(!c.pending_reply);
}

#[test]
fn chat_first_message_renames_title_truncated_to_32_chars_and_second_does_not() {
    let (mut s, _, id, _) = two_chats();
    let long = "这段话特别长需要被截断处理因为它超过了三十二个字符的长度限制还要再长一点";
    assert!(long.chars().count() > 32);
    s.begin_send(&id, long, ConversationKind::Chat).unwrap();
    let expected = format!("{}…", long.chars().take(32).collect::<String>());
    assert_eq!(chat(&s, &id).title, expected);
    s.finish_send(&id, ConversationKind::Chat, Ok("r".into()));
    s.begin_send(&id, "第二条", ConversationKind::Chat).unwrap();
    assert_eq!(chat(&s, &id).title, expected);
}

#[test]
fn chat_ignores_blank_pending_and_unknown_ids() {
    let (mut s, _, id, _) = two_chats();
    assert!(s.begin_send(&id, "   ", ConversationKind::Chat).is_none());
    assert!(chat(&s, &id).messages.is_empty());
    assert!(s.begin_send(&id, "x", ConversationKind::Chat).is_some());
    assert!(s.begin_send(&id, "y", ConversationKind::Chat).is_none(), "pending 中再发忽略");
    assert_eq!(chat(&s, &id).messages.len(), 1);
    assert!(s.begin_send("t999", "z", ConversationKind::Chat).is_none(), "不存在的 thread");
}

#[test]
fn streaming_reply_updates_one_assistant_row_and_finish_replaces_it() {
    let (mut s, _, id, _) = two_chats();
    s.begin_send(&id, "hi", ConversationKind::Chat).unwrap();

    s.update_streaming_reply(&id, ConversationKind::Chat, "hel");
    s.update_streaming_reply(&id, ConversationKind::Chat, "hello");
    let c = chat(&s, &id);
    assert_eq!(c.messages.len(), 2, "两次增量复用同一条 assistant 行");
    assert_eq!(c.messages[1].text, "hello");
    assert!(c.pending_reply, "增量不结束 pending");

    // ACP 流式回复也共用该状态机：同一条 assistant 行最终替换。
    s.finish_send(&id, ConversationKind::Chat, Ok("hello world".into()));
    let c = chat(&s, &id);
    assert_eq!(c.messages.len(), 2, "定稿替换而不是追加第二条 assistant 行");
    assert_eq!(c.messages[1].text, "hello world");
    assert!(!c.pending_reply);
}

#[test]
fn chat_rejected_send_appends_an_error_row_and_resets_pending() {
    let (mut s, _, id, _) = two_chats();
    s.begin_send(&id, "hi", ConversationKind::Chat).unwrap();
    s.finish_send(&id, ConversationKind::Chat, Err("boom".into()));
    let c = chat(&s, &id);
    assert_eq!(c.messages.len(), 2);
    assert!(c.messages[1].is_error() && c.messages[1].text.contains("boom"));
    assert!(!c.pending_reply);
}

#[test]
fn reply_arriving_after_close_is_dropped_and_does_not_resurrect_the_row() {
    let (mut s, _, id, _) = two_chats();
    s.begin_send(&id, "hi", ConversationKind::Chat).unwrap();
    s.close(&id);
    s.finish_send(&id, ConversationKind::Chat, Ok("迟到的回复".into()));
    assert!(s.thread(&id).is_none());
}

#[test]
fn close_chat_navigates_away_only_when_it_is_the_active_row() {
    let (mut s, _, a, b) = two_chats(); // active = b
    s.close(&a);
    assert_eq!(s.active(), &thread_target(&b), "关非 active 行：路由不动");
    assert_eq!(s.threads.len(), 1);
    s.close(&b);
    assert_eq!(s.active(), &ActiveTarget::Home, "关 active 行：先导航离开再移除");
    assert!(s.threads.is_empty());
}

#[test]
fn chat_rename_edits_title_and_freezes_against_the_first_message() {
    let (mut s, _, id, _) = two_chats();
    s.rename(&id, "我的会话");
    assert_eq!(chat(&s, &id).title, "我的会话");
    s.begin_send(&id, "首条消息", ConversationKind::Chat).unwrap();
    assert_eq!(chat(&s, &id).title, "我的会话", "不被首条消息覆盖");
    s.rename(&id, "  ");
    assert_eq!(chat(&s, &id).title, "我的会话");
}

// ═════════════════════ acp ═════════════════════

#[test]
fn create_acp_thread_uses_the_given_label_with_auto_title() {
    let (mut s, _) = store();
    let id = s.create_acp_thread("acp-codex", "Codex (ACP)", None).unwrap();
    let a = acp(&s, &id);
    assert_eq!((a.agent_id.as_str(), a.title.as_str(), a.messages.len(), a.pending_reply, a.auto_title), ("acp-codex", "Codex (ACP)", 0, false, true));
    assert_eq!(s.active(), &thread_target(&id));
}

#[test]
fn acp_send_reports_the_agent_id_for_lazy_connection_and_runs_the_chat_state_machine() {
    let (mut s, _) = store();
    let id = s.create_acp_thread("acp-codex", "Codex (ACP)", None).unwrap();
    let req = s.begin_send(&id, "看下这个 bug", ConversationKind::Acp).unwrap();
    assert_eq!(req.agent_id.as_deref(), Some("acp-codex"), "调用方据此惰性建连");
    let a = acp(&s, &id);
    assert!(a.messages[0].is_user() && a.pending_reply);
    assert_eq!(a.title, "看下这个 bug", "首条消息改写 title");
    assert!(!a.auto_title);

    s.finish_send(&id, ConversationKind::Acp, Ok("修好了".into()));
    assert_eq!(acp(&s, &id).messages[1].text, "修好了");
    assert!(!acp(&s, &id).pending_reply);

    s.begin_send(&id, "再来", ConversationKind::Acp).unwrap();
    s.finish_send(&id, ConversationKind::Acp, Ok("ok".into()));
    assert_eq!(acp(&s, &id).messages.len(), 4);
}

#[test]
fn acp_rename_freezes_the_title_and_blank_is_ignored() {
    let (mut s, _) = store();
    let id = s.create_acp_thread("acp-codex", "Codex (ACP)", None).unwrap();
    s.rename(&id, "调参专用");
    assert_eq!(acp(&s, &id).title, "调参专用");
    assert!(!acp(&s, &id).auto_title);
    s.begin_send(&id, "第一条", ConversationKind::Acp).unwrap();
    assert_eq!(acp(&s, &id).title, "调参专用");
    s.rename(&id, " ");
    assert_eq!(acp(&s, &id).title, "调参专用");
}

#[test]
fn acp_connect_failure_leaves_an_error_row_and_does_not_stay_pending() {
    let (mut s, _) = store();
    let id = s.create_acp_thread("gone", "X", None).unwrap();
    s.begin_send(&id, "hi", ConversationKind::Acp).unwrap();
    s.fail_acp_connect(&id, "unknown agent");
    let a = acp(&s, &id);
    assert!(a.messages.last().unwrap().is_error());
    assert!(a.messages.last().unwrap().text.contains("无法建立 ACP 连接"));
    assert!(!a.pending_reply, "不置 pending");
}

#[test]
fn closing_an_acp_thread_disposes_the_connection_only_if_one_was_made() {
    let (mut s, f) = store();
    let connected = s.create_acp_thread("acp-codex", "A", None).unwrap();
    let never = s.create_acp_thread("acp-codex", "B", None).unwrap();
    s.begin_send(&connected, "hi", ConversationKind::Acp).unwrap();
    s.mark_acp_connected(&connected);

    s.close(&connected);
    assert_eq!(f.log.borrow().disposed, std::slice::from_ref(&connected));
    s.close(&never);
    assert_eq!(f.log.borrow().disposed, std::slice::from_ref(&connected), "建连前 close 无 dispose");
    assert_eq!(s.active(), &ActiveTarget::Home);
}

#[test]
fn acp_late_reply_after_close_is_dropped_and_rejection_becomes_an_error_row() {
    let (mut s, _) = store();
    let id = s.create_acp_thread("acp-codex", "A", None).unwrap();
    s.begin_send(&id, "hi", ConversationKind::Acp).unwrap();
    s.close(&id);
    s.finish_send(&id, ConversationKind::Acp, Ok("迟到".into()));
    assert!(s.thread(&id).is_none());

    let id2 = s.create_acp_thread("acp-codex", "B", None).unwrap();
    s.begin_send(&id2, "hi", ConversationKind::Acp).unwrap();
    s.finish_send(&id2, ConversationKind::Acp, Err("agent died".into()));
    assert!(acp(&s, &id2).messages[1].is_error());
}

#[test]
fn a_chat_reply_is_not_applied_to_an_acp_thread_with_the_same_id_space() {
    let (mut s, _) = store();
    let c = s.create_chat(None).unwrap();
    s.begin_send(&c, "hi", ConversationKind::Chat).unwrap();
    s.finish_send(&c, ConversationKind::Acp, Ok("错 kind".into()));
    assert_eq!(chat(&s, &c).messages.len(), 1, "kind 不匹配的回复被丢弃");
    assert!(chat(&s, &c).pending_reply);
}

// ═════════════════════ 工作区 CRUD 与持久化 ═════════════════════

#[test]
fn add_workspace_lists_it_marks_persist_and_blank_name_falls_back_to_basename() {
    let (mut s, _) = store();
    let a = s.add_workspace("项目 A", "/Users/u/proj-a");
    assert!(a.starts_with('w'));
    assert_eq!(s.workspace(&a).unwrap().name, "项目 A");
    assert!(s.take_workspaces_dirty());
    assert!(!s.take_workspaces_dirty(), "读取即清除");

    let b = s.add_workspace("   ", "/Users/u/dotfiles");
    assert_eq!(s.workspace(&b).unwrap().name, "dotfiles");
    assert!(s.workspace(&b).unwrap().expanded);
}

#[test]
fn rename_workspace_edits_ignores_blank_and_unknown_id_is_a_no_op() {
    let (mut s, _) = store_with(vec![ws("w1", "/a", 1)]);
    s.rename_workspace("w1", "  新名字 ");
    assert_eq!(s.workspace("w1").unwrap().name, "新名字");
    s.rename_workspace("w1", "   ");
    assert_eq!(s.workspace("w1").unwrap().name, "新名字");
    s.take_workspaces_dirty();
    s.rename_workspace("nope", "x");
    assert_eq!(s.workspaces.len(), 1);
}

#[test]
fn every_workspace_mutation_marks_dirty_with_the_change_included() {
    let (mut s, _) = store_with(vec![ws("w1", "/a", 1)]);
    assert!(!s.take_workspaces_dirty());
    s.toggle_workspace_expanded("w1");
    assert!(s.take_workspaces_dirty());
    assert!(!s.workspace("w1").unwrap().expanded, "快照含变更");
    s.set_workspace_show_all("w1", true);
    assert!(s.take_workspaces_dirty());
    s.set_workspace_pane_tab("w1", PaneTab::Git);
    assert!(s.take_workspaces_dirty());
}

#[test]
fn toggle_expanded_flips_without_navigating() {
    let (mut s, _) = store_with(vec![ws("w1", "/a", 1)]);
    let before = s.active().clone();
    s.toggle_workspace_expanded("w1");
    s.toggle_workspace_expanded("w1");
    assert!(s.workspace("w1").unwrap().expanded);
    assert_eq!(s.active(), &before);
}

// ═════════════════════ 会话归属与 cwd 继承 ═════════════════════

#[test]
fn spawn_inherits_workspace_path_attaches_the_thread_and_records_last_session() {
    let (mut s, _) = store_with(vec![ws("w1", "/work/proj", 1)]);
    spawn(&mut s, "shell", Some("w1"), 1);
    let t = term(&s, "t1");
    assert_eq!(t.cwd, "/work/proj");
    assert_eq!(t.common.workspace_id.as_deref(), Some("w1"));
    assert_eq!(s.workspace("w1").unwrap().last_session.as_deref(), Some("t1"));
    assert!(s.take_workspaces_dirty(), "last_session 变化 → persist");
}

#[test]
fn preset_cwd_wins_over_workspace_dir_and_no_workspace_falls_back_to_process_cwd() {
    let (s, _) = store_with(vec![ws("w1", "/work/proj", 1)]);
    let mut p = builtin_preset("shell").unwrap();
    p.cwd = Some("/preset/dir".into());
    assert_eq!(s.begin_spawn(Some(&p), "shell", Some("w1")).unwrap().cwd, "/preset/dir", "用户配置意图优先");
    p.cwd = None;
    assert_eq!(s.begin_spawn(Some(&p), "shell", Some("w1")).unwrap().cwd, "/work/proj");
    assert_eq!(s.begin_spawn(Some(&p), "shell", None).unwrap().cwd, "/proc/cwd");
}

#[test]
fn unknown_workspace_id_errors_for_spawn_chat_and_acp() {
    let (mut s, _) = store();
    let p = builtin_preset("shell");
    assert_eq!(s.begin_spawn(p.as_ref(), "shell", Some("w-nope")).unwrap_err(), StoreError::UnknownWorkspace("w-nope".into()));
    assert!(s.create_chat(Some("w-nope")).is_err());
    assert!(s.create_acp_thread("a", "A", Some("w-nope")).is_err());
    assert!(s.threads.is_empty());
}

#[test]
fn chat_and_acp_created_inside_a_workspace_record_it_and_update_last_session() {
    let (mut s, _) = store_with(vec![ws("w1", "/a", 1)]);
    let c = s.create_chat(Some("w1")).unwrap();
    assert_eq!(chat(&s, &c).common.workspace_id.as_deref(), Some("w1"));
    assert_eq!(s.workspace("w1").unwrap().last_session.as_deref(), Some(c.as_str()));
    let a = s.create_acp_thread("acp-x", "X", Some("w1")).unwrap();
    assert_eq!(s.workspace("w1").unwrap().last_session.as_deref(), Some(a.as_str()));
}

#[test]
fn activating_a_member_session_updates_last_session_and_repeats_do_not_re_persist() {
    let (mut s, _) = store_with(vec![ws("w1", "/a", 1)]);
    spawn(&mut s, "shell", Some("w1"), 1);
    spawn(&mut s, "shell", Some("w1"), 2);
    s.take_workspaces_dirty();

    s.activate(thread_target("t1"));
    assert_eq!(s.workspace("w1").unwrap().last_session.as_deref(), Some("t1"));
    assert!(s.take_workspaces_dirty());

    s.activate(thread_target("t1")); // 重复 activate
    assert!(!s.take_workspaces_dirty(), "同值不重复 persist");

    s.cycle(1); // t1 → t2（cycle 路径同样跟随）
    assert_eq!(s.workspace("w1").unwrap().last_session.as_deref(), Some("t2"));
}

// ═════════════════════ activateWorkspace / close / removeWorkspace ═════════════════════

#[test]
fn activate_workspace_restores_last_session_else_the_workspace_start_page() {
    let (mut s, _) = store_with(vec![ws("w1", "/a", 1)]);
    spawn(&mut s, "shell", Some("w1"), 1);
    spawn(&mut s, "shell", Some("w1"), 2);
    s.activate(thread_target("t1"));
    s.activate(ActiveTarget::Home);

    s.activate_workspace("w1");
    assert_eq!(s.active(), &thread_target("t1"), "恢复 last_session");

    // last_session 指向死 id → 起始页
    s.workspaces[0].last_session = Some("t-dead".into());
    s.activate_workspace("w1");
    assert_eq!(s.active(), &ActiveTarget::Workspace("w1".into()));

    s.workspaces[0].last_session = None;
    s.activate(ActiveTarget::Home);
    s.activate_workspace("w1");
    assert_eq!(s.active(), &ActiveTarget::Workspace("w1".into()));

    let before = s.workspace("w1").unwrap().expanded;
    s.activate_workspace("w1");
    assert_eq!(s.workspace("w1").unwrap().expanded, before, "不改 expanded");
    s.activate_workspace("nope"); // unknown no-op
}

#[test]
fn closing_the_last_session_clears_last_session_and_lands_on_the_workspace_start_page() {
    let (mut s, _) = store_with(vec![ws("w1", "/a", 1)]);
    spawn(&mut s, "shell", Some("w1"), 1);
    assert_eq!(s.workspace("w1").unwrap().last_session.as_deref(), Some("t1"));
    s.take_workspaces_dirty();
    s.close("t1");
    assert_eq!(s.workspace("w1").unwrap().last_session, None);
    assert_eq!(s.active(), &ActiveTarget::Workspace("w1".into()), "回工作区起始页");
    assert!(s.take_workspaces_dirty());
}

#[test]
fn remove_workspace_closes_its_sessions_destroys_ptys_navigates_and_drops_the_row() {
    let (mut s, f) = store_with(vec![ws("w1", "/a", 1), ws("w2", "/b", 2)]);
    spawn(&mut s, "shell", Some("w1"), 1);
    spawn(&mut s, "shell", Some("w1"), 2);
    spawn(&mut s, "shell", Some("w2"), 3);
    s.activate(thread_target("t1"));
    s.take_workspaces_dirty();

    s.remove_workspace("w1");
    assert_eq!(ids(&s), ["t3"], "只剩 w2 的会话");
    assert_eq!(f.log.borrow().destroyed, [1, 2]);
    assert_eq!(s.workspaces.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["w2"]);
    assert_eq!(s.active(), &ActiveTarget::Home, "路由不得停在已删工作区的起始页");
    assert!(s.take_workspaces_dirty());
}

#[test]
fn remove_workspace_without_sessions_just_drops_the_row_and_unknown_is_a_no_op() {
    let (mut s, f) = store_with(vec![ws("w1", "/a", 1)]);
    s.remove_workspace("nope");
    assert_eq!(s.workspaces.len(), 1);
    s.remove_workspace("w1");
    assert!(s.workspaces.is_empty());
    assert!(f.log.borrow().destroyed.is_empty());
}

#[test]
fn open_git_graph_without_a_session_switches_the_workspace_pane_tab_and_activates_it() {
    let (mut s, _) = store_with(vec![ws("w1", "/a", 1), ws("w2", "/b", 2)]);
    s.activate(ActiveTarget::Workspace("w2".into()));
    s.open_git_graph();
    assert_eq!(s.workspace("w2").unwrap().pane_tab, PaneTab::Git, "当前工作区");
    assert_eq!(s.active(), &ActiveTarget::Workspace("w2".into()));

    let (mut s, _) = store_with(vec![ws("w1", "/a", 1)]);
    s.open_git_graph(); // 无 active 工作区 → 首个
    assert_eq!(s.workspace("w1").unwrap().pane_tab, PaneTab::Git);

    let (mut s, _) = store();
    s.open_git_graph(); // 无工作区 no-op
    assert_eq!(s.active(), &ActiveTarget::Home);
}

// ═════════════════════ 会话内视图 ═════════════════════

fn with_session() -> (Store, Fake) {
    let (mut s, f) = store_with(vec![ws("w1", "/work", 1)]);
    spawn(&mut s, "shell", Some("w1"), 1);
    (s, f)
}

fn views(s: &Store, id: &str) -> Vec<String> {
    s.thread(id).unwrap().common().views.iter().map(|v| v.id().to_owned()).collect()
}

fn active_view(s: &Store, id: &str) -> Option<String> {
    s.thread(id).unwrap().common().active_view_id.clone()
}

fn shell_view<'a>(s: &'a Store, tid: &str, vid: &str) -> &'a ShellView {
    s.thread(tid).unwrap().common().views.iter().find_map(|v| match v {
        SessionView::Shell(x) if x.id == vid => Some(x),
        _ => None,
    }).unwrap()
}

fn add_shell(s: &mut Store, tid: &str, session_id: u64) {
    let cwd = s.begin_add_session_shell(tid).unwrap();
    s.finish_add_session_shell(tid, session_id, cwd);
}

#[test]
fn open_git_graph_on_a_member_session_adds_one_git_view_and_activates_it() {
    let (mut s, _) = with_session();
    s.open_git_graph();
    s.open_git_graph(); // 去重
    assert_eq!(views(&s, "t1"), ["git"]);
    assert_eq!(active_view(&s, "t1").as_deref(), Some("git"));
    assert_eq!(s.active(), &thread_target("t1"), "不切路由");
}

#[test]
fn open_session_file_dedupes_by_path_and_activate_session_view_returns_to_main() {
    let (mut s, _) = with_session();
    s.open_session_file("t1", "/a/b/readme.md");
    s.open_session_file("t1", "/a/b/readme.md");
    assert_eq!(views(&s, "t1"), ["file:/a/b/readme.md"]);
    match &s.thread("t1").unwrap().common().views[0] {
        SessionView::File { label, .. } => assert_eq!(label, "readme.md"),
        v => panic!("{v:?}"),
    }
    assert_eq!(active_view(&s, "t1").as_deref(), Some("file:/a/b/readme.md"));
    s.activate_session_view("t1", MAIN_VIEW_ID);
    assert_eq!(active_view(&s, "t1").as_deref(), Some(MAIN_VIEW_ID));
    s.activate_session_view("t1", "nope"); // 不存在 id 忽略
    assert_eq!(active_view(&s, "t1").as_deref(), Some(MAIN_VIEW_ID));
}

#[test]
fn add_session_shell_uses_the_session_cwd_numbers_views_and_activates() {
    let (mut s, _) = with_session();
    assert_eq!(s.begin_add_session_shell("t1").as_deref(), Some("/work"), "会话 cwd");
    add_shell(&mut s, "t1", 10);
    add_shell(&mut s, "t1", 11);
    assert_eq!(views(&s, "t1"), ["shell:1", "shell:2"]);
    assert_eq!(shell_view(&s, "t1", "shell:2").label, "Shell 2");
    assert_eq!(shell_view(&s, "t1", "shell:2").session_id, 11);
    assert_eq!(active_view(&s, "t1").as_deref(), Some("shell:2"));
    assert!(s.begin_add_session_shell("nope").is_none());
}

#[test]
fn add_session_shell_on_a_chat_falls_back_to_workspace_path_then_process_cwd() {
    let (mut s, _) = store_with(vec![ws("w1", "/work", 1)]);
    let c = s.create_chat(Some("w1")).unwrap();
    assert_eq!(s.begin_add_session_shell(&c).as_deref(), Some("/work"));
    let c2 = s.create_chat(None).unwrap();
    assert_eq!(s.begin_add_session_shell(&c2).as_deref(), Some("/proc/cwd"));
}

#[test]
fn close_session_view_destroys_the_shell_pty_and_falls_back_to_left_neighbour_or_main() {
    let (mut s, f) = with_session();
    add_shell(&mut s, "t1", 10); // shell:1
    add_shell(&mut s, "t1", 11); // shell:2（当前）
    s.close_session_view("t1", "shell:2");
    assert_eq!(f.log.borrow().destroyed, [11]);
    assert_eq!(active_view(&s, "t1").as_deref(), Some("shell:1"), "当前视图被关 → 左邻");
    s.close_session_view("t1", "shell:1");
    assert_eq!(active_view(&s, "t1").as_deref(), Some(MAIN_VIEW_ID), "无左邻 → 主面");
    s.close_session_view("t1", MAIN_VIEW_ID); // 主面不可关
    assert!(views(&s, "t1").is_empty());
}

#[test]
fn closing_a_non_active_view_does_not_move_the_active_view() {
    let (mut s, _) = with_session();
    add_shell(&mut s, "t1", 10);
    add_shell(&mut s, "t1", 11); // active = shell:2
    s.close_session_view("t1", "shell:1");
    assert_eq!(active_view(&s, "t1").as_deref(), Some("shell:2"));
}

#[test]
fn closing_a_session_destroys_its_shell_view_ptys_too() {
    let (mut s, f) = with_session();
    add_shell(&mut s, "t1", 10);
    add_shell(&mut s, "t1", 11);
    s.close("t1");
    let mut d = f.log.borrow().destroyed.clone();
    d.sort();
    assert_eq!(d, [1, 10, 11]);
}

#[test]
fn a_session_closed_while_the_shell_spawn_was_in_flight_recycles_the_orphan_pty() {
    let (mut s, f) = with_session();
    let cwd = s.begin_add_session_shell("t1").unwrap();
    s.close("t1"); // spawn 期间会话被关
    s.finish_add_session_shell("t1", 99, cwd);
    assert!(f.log.borrow().destroyed.contains(&99), "孤儿 PTY 回收");
    assert!(s.thread("t1").is_none(), "不落视图");
}

#[test]
fn view_pty_title_event_routes_to_the_view_ignores_blank_and_does_not_touch_the_main_session() {
    let (mut s, _) = with_session();
    add_shell(&mut s, "t1", 10);
    s.on_session_event(SessionEvent::Title { session_id: 10, title: Some("htop".into()) });
    assert_eq!(shell_view(&s, "t1", "shell:1").osc_title.as_deref(), Some("htop"));
    assert_eq!(term(&s, "t1").osc_title, None, "不误伤主会话");
    s.on_session_event(SessionEvent::Title { session_id: 10, title: Some(String::new()) });
    assert_eq!(shell_view(&s, "t1", "shell:1").osc_title.as_deref(), Some("htop"), "空串忽略");
}

#[test]
fn view_bell_has_three_levels_shown_other_view_and_background_session() {
    let (mut s, f) = with_session();
    add_shell(&mut s, "t1", 10); // shell:1
    add_shell(&mut s, "t1", 11); // shell:2（当前展示）

    // 1) 视图正显示（会话 active 且为活动视图）→ 丢弃
    s.on_session_event(SessionEvent::Bell { session_id: 11 });
    assert!(!shell_view(&s, "t1", "shell:2").has_bell);
    assert!(f.log.borrow().notified.is_empty());

    // 2) 同会话他视图 → view.has_bell，不触发会话级提醒
    s.on_session_event(SessionEvent::Bell { session_id: 10 });
    assert!(shell_view(&s, "t1", "shell:1").has_bell);
    assert!(!term(&s, "t1").has_bell);
    assert!(f.log.borrow().notified.is_empty());

    // 3) 会话在后台 → 会话级 + 通知 + notice
    s.activate(ActiveTarget::Settings);
    s.on_session_event(SessionEvent::Bell { session_id: 10 });
    assert!(term(&s, "t1").has_bell);
    assert_eq!(f.log.borrow().notified, ["t1"]);
    let n = s.notices.last().unwrap();
    assert_eq!(n.view_id.as_deref(), Some("shell:1"));
    assert_eq!(n.tone, NoticeTone::Warn);
    assert!(n.text.contains("Shell 1"), "{}", n.text);
    assert_eq!(n.sub, "work · BEL", "工作区名 = basename(/work)");
}

#[test]
fn view_has_bell_clears_via_activate_session_view_and_via_activate_landing_on_that_view() {
    let (mut s, _) = with_session();
    add_shell(&mut s, "t1", 10); // shell:1
    add_shell(&mut s, "t1", 11); // shell:2 当前
    s.on_session_event(SessionEvent::Bell { session_id: 10 });
    assert!(shell_view(&s, "t1", "shell:1").has_bell);

    s.activate_session_view("t1", "shell:1"); // 会话 active → 清
    assert!(!shell_view(&s, "t1", "shell:1").has_bell);

    // 后台调用不算「已看到」
    s.activate_session_view("t1", "shell:2");
    s.on_session_event(SessionEvent::Bell { session_id: 10 });
    s.activate(ActiveTarget::Settings);
    s.activate_session_view("t1", "shell:1");
    assert!(shell_view(&s, "t1", "shell:1").has_bell, "后台程序化调用不清");

    s.activate(thread_target("t1")); // 落在该视图 → 同清
    assert!(!shell_view(&s, "t1", "shell:1").has_bell);
}

#[test]
fn view_exit_without_close_on_exit_marks_exited_with_code_and_pushes_a_notice() {
    let (mut s, _) = with_session();
    add_shell(&mut s, "t1", 10);
    s.on_session_event(SessionEvent::Exit { session_id: 10, code: Some(2) });
    let v = shell_view(&s, "t1", "shell:1");
    assert_eq!((v.status, v.exit_code), (RunStatus::Exited, Some(2)));
    let n = s.notices.last().unwrap();
    assert_eq!((n.tone, n.view_id.as_deref()), (NoticeTone::Err, Some("shell:1")));
    assert!(n.text.contains("已退出"));
}

#[test]
fn view_exit_with_close_on_exit_removes_the_view_and_falls_back() {
    let (mut s, f) = with_session();
    f.log.borrow_mut().close_on_exit = true;
    add_shell(&mut s, "t1", 10);
    s.on_session_event(SessionEvent::Exit { session_id: 10, code: Some(0) });
    assert!(views(&s, "t1").is_empty());
    assert_eq!(active_view(&s, "t1").as_deref(), Some(MAIN_VIEW_ID));
    assert_eq!(s.notices.last().unwrap().tone, NoticeTone::Ok);
}

#[test]
fn a_shell_view_bell_on_a_background_chat_session_sets_unread_a_notice_and_notifies() {
    let (mut s, f) = store_with(vec![ws("w1", "/work", 1)]);
    let c = s.create_chat(Some("w1")).unwrap();
    add_shell(&mut s, &c, 10);
    s.activate(ActiveTarget::Settings);
    s.on_session_event(SessionEvent::Bell { session_id: 10 });
    assert!(s.thread(&c).unwrap().common().unread, "非 terminal 父级 → unread");
    assert_eq!(f.log.borrow().notified, std::slice::from_ref(&c));
    assert_eq!(s.notices.last().unwrap().thread_id, c);
}

#[test]
fn events_for_unknown_sessions_are_ignored() {
    let (mut s, f) = store();
    s.on_session_event(SessionEvent::Bell { session_id: 404 });
    s.on_session_event(SessionEvent::Exit { session_id: 404, code: None });
    assert!(s.notices.is_empty() && f.log.borrow().notified.is_empty());
}

// ═════════════════════ 方案 C：pin / unread ═════════════════════

#[test]
fn thread_pin_and_unread_flip_and_unknown_is_a_no_op() {
    let (mut s, _) = store();
    spawn(&mut s, "shell", None, 1);
    s.set_thread_pinned("t1", true);
    s.set_thread_unread("t1", true);
    assert!(s.thread("t1").unwrap().common().pin && s.thread("t1").unwrap().common().unread);
    s.set_thread_pinned("t1", false);
    assert!(!s.thread("t1").unwrap().common().pin);
    s.set_thread_pinned("nope", true);
    s.set_thread_unread("nope", true);
    assert_eq!(s.threads.len(), 1);
}

#[test]
fn activate_clears_unread_alongside_has_bell() {
    let (mut s, _) = store();
    spawn(&mut s, "shell", None, 1);
    spawn(&mut s, "shell", None, 2);
    s.set_thread_unread("t1", true);
    s.on_session_event(SessionEvent::Bell { session_id: 1 });
    assert!(term(&s, "t1").has_bell && s.thread("t1").unwrap().common().unread);
    s.activate(thread_target("t1"));
    assert!(!term(&s, "t1").has_bell && !s.thread("t1").unwrap().common().unread);
}

#[test]
fn workspace_pin_flips_marks_dirty_and_unknown_is_a_no_op() {
    let (mut s, _) = store_with(vec![ws("w1", "/a", 1)]);
    s.set_workspace_pinned("w1", true);
    assert!(s.workspace("w1").unwrap().pin);
    assert!(s.take_workspaces_dirty());
    s.set_workspace_pinned("nope", true);
    assert_eq!(s.workspaces.len(), 1);
}

// ═════════════════════ 通知中心 ═════════════════════

fn two_terminals_in_a_workspace() -> Store {
    let (mut s, _) = store_with(vec![Workspace { name: "dotfiles".into(), ..ws("w1", "/a", 1) }]);
    spawn(&mut s, "shell", Some("w1"), 1);
    spawn(&mut s, "shell", Some("w1"), 2);
    s.activate(ActiveTarget::Settings); // 两个都在后台
    s
}

#[test]
fn bell_and_exit_push_notices_with_thread_id_unread_and_activate_marks_that_sessions_read() {
    let mut s = two_terminals_in_a_workspace();
    s.on_session_event(SessionEvent::Bell { session_id: 1 });
    s.on_session_event(SessionEvent::Exit { session_id: 2, code: Some(1) });
    assert_eq!(s.notices.len(), 2);
    assert_eq!((s.notices[0].thread_id.as_str(), s.notices[0].read, s.notices[0].tone), ("t1", false, NoticeTone::Warn));
    assert_eq!(s.notices[0].sub, "dotfiles · BEL");
    assert_eq!((s.notices[1].tone, s.notices[1].sub.as_str()), (NoticeTone::Err, "dotfiles"));
    assert_eq!(s.unread_notice_count(), 2);

    s.activate(thread_target("t1"));
    assert!(s.notices[0].read);
    assert!(!s.notices[1].read, "只清目标会话的 notice，其他会话未读保留");
    assert_eq!(s.unread_notice_count(), 1);
}

#[test]
fn notice_without_a_workspace_says_unattached() {
    let (mut s, _) = store();
    spawn(&mut s, "shell", None, 1);
    s.activate(ActiveTarget::Settings);
    s.on_session_event(SessionEvent::Bell { session_id: 1 });
    assert_eq!(s.notices[0].sub, "未归属 · BEL");
}

#[test]
fn notices_are_capped_at_50_dropping_the_oldest() {
    let (mut s, _) = store();
    spawn(&mut s, "shell", None, 1);
    s.activate(ActiveTarget::Settings);
    for _ in 0..60 {
        s.on_session_event(SessionEvent::Bell { session_id: 1 });
    }
    assert_eq!(s.notices.len(), 50);
    assert_eq!(s.notices[0].id, "n11", "最旧的 10 条被丢弃");
    assert_eq!(s.notices[49].id, "n60");
}

#[test]
fn open_notice_marks_read_and_jumps_to_the_source_session_closed_sessions_only_mark_read() {
    let mut s = two_terminals_in_a_workspace();
    s.on_session_event(SessionEvent::Bell { session_id: 1 });
    s.on_session_event(SessionEvent::Bell { session_id: 2 });
    let (n1, n2) = (s.notices[0].id.clone(), s.notices[1].id.clone());

    s.open_notice(&n1);
    assert!(s.notices[0].read);
    assert_eq!(s.active(), &thread_target("t1"));

    s.close("t2");
    s.activate(ActiveTarget::Settings);
    s.open_notice(&n2); // 来源已关闭
    assert!(s.notices[1].read);
    assert_eq!(s.active(), &ActiveTarget::Settings, "路由不得指向不存在的行");
}

#[test]
fn open_notice_with_a_view_id_activates_that_view_too() {
    let (mut s, _) = with_session();
    add_shell(&mut s, "t1", 10);
    add_shell(&mut s, "t1", 11); // 当前 shell:2
    s.activate(ActiveTarget::Settings);
    s.on_session_event(SessionEvent::Bell { session_id: 10 });
    let id = s.notices.last().unwrap().id.clone();
    s.open_notice(&id);
    assert_eq!(s.active(), &thread_target("t1"));
    assert_eq!(active_view(&s, "t1").as_deref(), Some("shell:1"), "直达现场");
    assert!(!shell_view(&s, "t1", "shell:1").has_bell, "到达即已看到");
}

#[test]
fn mark_notices_read_keeps_the_entries_and_unknown_open_notice_is_a_no_op() {
    let mut s = two_terminals_in_a_workspace();
    s.on_session_event(SessionEvent::Bell { session_id: 1 });
    s.on_session_event(SessionEvent::Bell { session_id: 2 });
    s.mark_notices_read();
    assert_eq!(s.notices.len(), 2);
    assert_eq!(s.unread_notice_count(), 0);
    let before = s.active().clone();
    s.open_notice("n404");
    assert_eq!(s.active(), &before);
}
