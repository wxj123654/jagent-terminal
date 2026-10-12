//! 文件适配器：真盘（同目录 tmp + rename 原子写）与内存（测试，含失败注入）。

use std::cell::RefCell;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::rc::Rc;

pub trait FileAdapter {
    /// 文件不存在返回 `Ok(None)`；存在返回原文（坏 JSON 由调用方容错）。
    fn read(&self) -> std::io::Result<Option<String>>;
    /// Optional failure-injection seam; real filesystem adapters return `false`.
    fn fail_next_write(&self, _message: &str) -> bool {
        false
    }
    /// 原子写。
    fn write(&self, content: &str) -> std::io::Result<()>;
    /// 真盘路径（「在编辑器中打开」用）；内存适配器无。
    fn path(&self) -> Option<&Path> {
        None
    }
}

pub struct FsAdapter {
    path: PathBuf,
}

impl FsAdapter {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

impl FileAdapter for FsAdapter {
    fn read(&self) -> std::io::Result<Option<String>> {
        match std::fs::read_to_string(&self.path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn write(&self, content: &str) -> std::io::Result<()> {
        let dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        // 首次运行（如 ~/.j-agent/）目录可能不存在
        std::fs::create_dir_all(dir)?;
        // 同目录 tmp → 同卷 → rename 原子替换（Windows 上 std 的 rename 带 REPLACE_EXISTING 语义）
        let mut tmp = tempfile_in(dir)?;
        tmp.0.write_all(content.as_bytes())?;
        tmp.0.sync_all()?;
        std::fs::rename(&tmp.1, &self.path)?;
        tmp.2 = false; // 已改名，不再清理
        Ok(())
    }

    fn path(&self) -> Option<&Path> {
        Some(&self.path)
    }
}

/// 同目录临时文件；失败路径上 Drop 时清理（标志位 `.2` 为 true 才删）。
struct Tmp(std::fs::File, PathBuf, bool);

impl Drop for Tmp {
    fn drop(&mut self) {
        if self.2 {
            let _ = std::fs::remove_file(&self.1);
        }
    }
}

fn tempfile_in(dir: &Path) -> std::io::Result<Tmp> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let name = format!(".settings.tmp-{}-{n}", std::process::id());
    let path = dir.join(name);
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    Ok(Tmp(file, path, true))
}

#[derive(Default)]
struct MemState {
    data: Option<String>,
    writes: usize,
    fail: Option<String>,
}

/// 内存适配器（测试）：可注入写失败，可读回已落盘内容与写次数。可 Clone，克隆共享同一状态。
#[derive(Clone, Default)]
pub struct MemoryAdapter(Rc<RefCell<MemState>>);

impl MemoryAdapter {
    pub fn new(initial: Option<&str>) -> Self {
        Self(Rc::new(RefCell::new(MemState {
            data: initial.map(str::to_owned),
            ..Default::default()
        })))
    }
    /// 最后一次成功 write 的原文。
    pub fn snapshot(&self) -> Option<String> {
        self.0.borrow().data.clone()
    }
    pub fn writes(&self) -> usize {
        self.0.borrow().writes
    }
    /// 注入写失败；`None` 清除。
    pub fn set_fail_write(&self, message: Option<&str>) {
        self.0.borrow_mut().fail = message.map(str::to_owned);
    }
}

impl FileAdapter for MemoryAdapter {
    fn fail_next_write(&self, message: &str) -> bool {
        self.set_fail_write(Some(message));
        true
    }

    fn read(&self) -> std::io::Result<Option<String>> {
        Ok(self.0.borrow().data.clone())
    }
    fn write(&self, content: &str) -> std::io::Result<()> {
        let mut s = self.0.borrow_mut();
        if let Some(msg) = &s.fail {
            return Err(std::io::Error::other(msg.clone()));
        }
        s.data = Some(content.to_owned());
        s.writes += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fs_adapter_missing_file_is_none_and_write_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nested/deeper/settings.json");
        let a = FsAdapter::new(&p);
        assert_eq!(a.read().unwrap(), None);
        a.write("{\"a\":1}\n").unwrap();
        assert_eq!(a.read().unwrap().as_deref(), Some("{\"a\":1}\n"));
        assert_eq!(a.path(), Some(p.as_path()));
    }

    #[test]
    fn fs_adapter_overwrite_leaves_no_tmp_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        let a = FsAdapter::new(&p);
        a.write("one").unwrap();
        a.write("two").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "two");
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["settings.json"], "原子写不应留下 tmp 文件");
    }

    #[test]
    fn memory_adapter_injects_failures_and_counts_writes() {
        let m = MemoryAdapter::new(None);
        m.write("x").unwrap();
        assert_eq!((m.writes(), m.snapshot().as_deref()), (1, Some("x")));
        m.set_fail_write(Some("EACCES"));
        assert!(m.write("y").unwrap_err().to_string().contains("EACCES"));
        assert_eq!(
            (m.writes(), m.snapshot().as_deref()),
            (1, Some("x")),
            "失败不改内容"
        );
        m.set_fail_write(None);
        m.write("z").unwrap();
        assert_eq!(m.writes(), 2);
    }
}
