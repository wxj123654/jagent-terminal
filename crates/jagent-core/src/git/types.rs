//! Git 域类型。store / graph / 视图消费这些形状，不依赖 `cli` 的进程边界。

/// git log 行解析后的提交（Zed 十字段格式；`%b` 正文选中时另拉）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphCommit {
    /// `%H` 全 sha（oid 键）
    pub sha: String,
    /// `%P` 按空白切
    pub parents: Vec<String>,
    /// `%D` 逗号+空格切；detached HEAD / 普通提交为空
    pub ref_names: Vec<String>,
    pub short_sha: String,
    pub author_name: String,
    pub author_email: String,
    /// `%at` 秒
    pub timestamp: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub subject: String,
}

/// 单提交 / 工作区的变更文件（numstat 行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    pub path: String,
    /// 二进制为 `None`
    pub added: Option<u32>,
    pub deleted: Option<u32>,
}

/// 本地分支（for-each-ref 行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeFileKind {
    /// 修改
    M,
    /// 新增（含 `??` 未跟踪与暂存新文件）
    A,
    /// 删除
    D,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeFile {
    pub path: String,
    pub status: WorktreeFileKind,
    pub added: Option<u32>,
    pub deleted: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeStatus {
    /// repo root（diff / preview 的 cwd 基准）
    pub root: String,
    /// 当前分支名；detached HEAD / 空 repo → `None`
    pub branch: Option<String>,
    pub files: Vec<WorktreeFile>,
}
