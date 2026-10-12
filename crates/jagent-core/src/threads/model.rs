//! 会话数据模型（对应旧 `threads/store.ts` 类型 + `workspaces.ts` + `chat.ts` + `terminal.ts`）。
//!
//! 三类 thread 用 enum 表达判别联合；共用字段放进 [`ThreadCommon`]，避免三处重复
//! （旧 TS 靠交叉类型 `& SessionViews` 做同一件事）。

use serde::{Deserialize, Serialize};

/// 主面虚拟视图 id（不落 views 数组）。
pub const MAIN_VIEW_ID: &str = "main";
/// chat 默认标题：首条消息改写的哨兵值；rename 手改后不再改写。
pub const CHAT_DEFAULT_TITLE: &str = "Chat";

// ── 导航目标（旧 router 的 ActiveTarget；gpui 里就是一个枚举字段）────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActiveTarget {
    Thread(String),
    Workspace(String),
    Settings,
    /// 全局起始页（EmptyPresets）
    Home,
}

// ── 会话内视图 ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellView {
    /// `shell:${n}`（会话内递增）
    pub id: String,
    /// `Shell n` 兜底标题
    pub label: String,
    /// 独立 PTY（≠ thread 的 session id）；关闭时连带销毁
    pub session_id: u64,
    pub cwd: String,
    /// 视图 PTY 事件按 session_id 归属到本视图
    pub osc_title: Option<String>,
    /// 视图非前台时 BEL 落此；被展示时清除
    pub has_bell: bool,
    pub status: RunStatus,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionView {
    Git { id: String, label: String },
    File { id: String, label: String, path: String },
    Shell(ShellView),
}

impl SessionView {
    pub fn id(&self) -> &str {
        match self {
            Self::Git { id, .. } | Self::File { id, .. } => id,
            Self::Shell(v) => &v.id,
        }
    }

    /// 视图展示名（tab / 通知同一规则）：shell → oscTitle ?? label；其余 → label。
    pub fn title(&self) -> &str {
        match self {
            Self::Git { label, .. } | Self::File { label, .. } => label,
            Self::Shell(v) => v.osc_title.as_deref().unwrap_or(&v.label),
        }
    }
}

// ── 对话消息 ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageRole {
    User,
    /// `error = true`：agent 回复失败行
    Assistant { error: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    /// 仅需 thread 内唯一，store 侧自增分配
    pub id: String,
    pub role: MessageRole,
    pub text: String,
    pub at: i64,
}

impl ChatMessage {
    pub fn is_user(&self) -> bool {
        self.role == MessageRole::User
    }
    pub fn is_error(&self) -> bool {
        matches!(self.role, MessageRole::Assistant { error: true })
    }
}

// ── Thread ───────────────────────────────────────────────────────────

/// 三类 thread 共用字段。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ThreadCommon {
    /// 归属工作区
    pub workspace_id: Option<String>,
    /// 未读标记：加粗 + 状态点 + 排序加权；activate 清除，菜单可手动标回。不持久化。
    pub unread: bool,
    /// 置顶（组内排序首位）。不持久化。
    pub pin: bool,
    /// 副页签列表（git / file / shell；创建序）
    pub views: Vec<SessionView>,
    /// 当前视图 id；`None` / `"main"` = 主面
    pub active_view_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalThread {
    /// `t${session_id}`：事件里的 session id 可直接定位行
    pub id: String,
    pub session_id: u64,
    /// 对应 TerminalPreset.id
    pub preset: Option<String>,
    pub cwd: String,
    /// 兜底标题用
    pub init_command: Option<String>,
    /// 来自 SessionEvent.title
    pub osc_title: Option<String>,
    /// 手改后冻结（不再被 OSC 覆盖）
    pub custom_title: Option<String>,
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    /// activate 该 thread 时清除
    pub has_bell: bool,
    pub created_at: i64,
    pub common: ThreadCommon,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatThread {
    /// `c${uuid}`
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub messages: Vec<ChatMessage>,
    /// agent 回复进行中：composer 发送钮禁用 + 消息尾 thinking 占位
    pub pending_reply: bool,
    pub common: ThreadCommon,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpThread {
    /// `a${uuid}`
    pub id: String,
    pub title: String,
    pub created_at: i64,
    /// settings.acpAgents 的配置 id（连接按 thread 惰性建立）
    pub agent_id: String,
    pub messages: Vec<ChatMessage>,
    pub pending_reply: bool,
    /// title 未被手改 / 首条消息改写（首条 user 消息自动改写的哨兵；rename 置 false）
    pub auto_title: bool,
    pub common: ThreadCommon,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Thread {
    Terminal(TerminalThread),
    Chat(ChatThread),
    Acp(AcpThread),
}

impl Thread {
    pub fn id(&self) -> &str {
        match self {
            Self::Terminal(t) => &t.id,
            Self::Chat(t) => &t.id,
            Self::Acp(t) => &t.id,
        }
    }
    pub fn created_at(&self) -> i64 {
        match self {
            Self::Terminal(t) => t.created_at,
            Self::Chat(t) => t.created_at,
            Self::Acp(t) => t.created_at,
        }
    }
    pub fn common(&self) -> &ThreadCommon {
        match self {
            Self::Terminal(t) => &t.common,
            Self::Chat(t) => &t.common,
            Self::Acp(t) => &t.common,
        }
    }
    pub fn common_mut(&mut self) -> &mut ThreadCommon {
        match self {
            Self::Terminal(t) => &mut t.common,
            Self::Chat(t) => &mut t.common,
            Self::Acp(t) => &mut t.common,
        }
    }
    pub fn workspace_id(&self) -> Option<&str> {
        self.common().workspace_id.as_deref()
    }
    /// 会话标题（通知文案）：terminal → [`display_title`] 兜底链，chat / acp → title。
    pub fn title(&self) -> String {
        match self {
            Self::Terminal(t) => display_title(t),
            Self::Chat(t) => t.title.clone(),
            Self::Acp(t) => t.title.clone(),
        }
    }
    pub fn as_terminal(&self) -> Option<&TerminalThread> {
        if let Self::Terminal(t) = self { Some(t) } else { None }
    }
}

/// 展示标题四级兜底（布局契约，一字不改）：
/// `custom_title ?? osc_title ?? init_command ?? "Terminal"`。
/// custom_title 手改后冻结——不再被 OSC 覆盖（规则在 store 的 title 事件）。
pub fn display_title(t: &TerminalThread) -> String {
    t.custom_title
        .clone()
        .or_else(|| t.osc_title.clone())
        .or_else(|| t.init_command.clone())
        .unwrap_or_else(|| "Terminal".into())
}

// ── 通知中心 ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeTone {
    Ok,
    Warn,
    Err,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionNotice {
    /// `n${seq}`
    pub id: String,
    pub tone: NoticeTone,
    /// 主文案（如「build 等待注意」/「Shell 已退出」）
    pub text: String,
    /// 副文案（工作区名 · 原因；相对时间在 UI 层格式化）
    pub sub: String,
    pub at: i64,
    /// 来源会话（点击条目 → activate 跳转；会话已关闭则仅标已读）
    pub thread_id: String,
    pub read: bool,
    /// 来源会话内视图（shell PTY 事件）：open_notice 一并激活该视图
    pub view_id: Option<String>,
}

// ── 工作区 ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneTab {
    Home,
    Git,
}

/// 工作区 = 项目目录 + 会话分组。会话归属工作区（`workspace_id`），但**不嵌套持有**：
/// threads 保持平铺创建序（Ctrl-Tab 环形语义与事件定位不变），分组是派生视图。
/// 含运行时态（expanded / last_session），语义是「应用状态」而非「用户设置」，与 settings.json 分文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Workspace {
    /// `w${uuid}`
    pub id: String,
    /// 显示名；默认 = 目录 basename
    pub name: String,
    /// 项目目录（会话 cwd 继承源）
    pub path: String,
    /// 侧栏分组展开态（点击箭头仅切换此项，不激活工作区）
    pub expanded: bool,
    /// 上次打开的 thread id；close 该会话清空
    #[serde(rename = "lastSession")]
    pub last_session: Option<String>,
    /// 工作区内 tab：Home = 起始页 / 会话，Git = Git 图
    #[serde(rename = "paneTab")]
    pub pane_tab: PaneTab,
    /// 会话列表显示全部（false = 只显前 4 条优先项）
    #[serde(rename = "showAll")]
    pub show_all: bool,
    /// 置顶：pin 的工作区排在列表最前，创建序内稳定
    pub pin: bool,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

/// 目录显示名（basename 兜底：空 / 根路径原样返回）。
pub fn workspace_display_name(path: &str) -> String {
    path.split(['/', '\\']).rfind(|s| !s.is_empty()).map_or_else(|| path.to_owned(), str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(custom: Option<&str>, osc: Option<&str>, init: Option<&str>) -> TerminalThread {
        TerminalThread {
            id: "t1".into(),
            session_id: 1,
            preset: None,
            cwd: "/".into(),
            init_command: init.map(Into::into),
            osc_title: osc.map(Into::into),
            custom_title: custom.map(Into::into),
            status: RunStatus::Running,
            exit_code: None,
            has_bell: false,
            created_at: 0,
            common: ThreadCommon::default(),
        }
    }

    #[test]
    fn display_title_four_level_fallback() {
        assert_eq!(display_title(&term(Some("c"), Some("o"), Some("i"))), "c");
        assert_eq!(display_title(&term(None, Some("o"), Some("i"))), "o");
        assert_eq!(display_title(&term(None, None, Some("i"))), "i");
        assert_eq!(display_title(&term(None, None, None)), "Terminal");
    }

    #[test]
    fn workspace_display_name_is_basename_with_fallbacks() {
        assert_eq!(workspace_display_name("/Users/wxj/dotfiles"), "dotfiles");
        assert_eq!(workspace_display_name("D:\\proj\\app\\"), "app");
        assert_eq!(workspace_display_name("/"), "/");
        assert_eq!(workspace_display_name(""), "");
    }

    #[test]
    fn session_view_title_prefers_osc_title_for_shell() {
        let mut v = ShellView {
            id: "shell:1".into(),
            label: "Shell 1".into(),
            session_id: 9,
            cwd: "/".into(),
            osc_title: None,
            has_bell: false,
            status: RunStatus::Running,
            exit_code: None,
        };
        assert_eq!(SessionView::Shell(v.clone()).title(), "Shell 1");
        v.osc_title = Some("vim".into());
        assert_eq!(SessionView::Shell(v).title(), "vim");
        assert_eq!(SessionView::Git { id: "git".into(), label: "Git 图".into() }.title(), "Git 图");
    }
}
