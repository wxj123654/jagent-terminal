//! 右键菜单项 → git CLI argv，以及「菜单项 → 下一步」的派发规则。
//!
//! 纯函数：不 spawn。危险操作（reset --hard / drop / 删分支）由 UI 二次确认后再执行。
//! 命令形状由本文件的测试锁定。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptKind {
    Branch,
    Tag,
    Rename,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GitMenuItem {
    pub id: &'static str,
    pub label: String,
    /// 交给 git 的 argv（不含 `git`）。prompt 项与「复制」类为 `None`。
    pub argv: Option<Vec<String>>,
    pub danger: bool,
    pub disabled: bool,
    pub checked: bool,
    /// 需要输入框（分支名 / 标签名）
    pub prompt: Option<PromptKind>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitMenuEntry {
    Item(GitMenuItem),
    Sep,
}

fn argv(parts: &[&str]) -> Option<Vec<String>> {
    Some(parts.iter().map(|s| (*s).to_owned()).collect())
}

fn item(id: &'static str, label: impl Into<String>, argv: Option<Vec<String>>) -> GitMenuItem {
    GitMenuItem {
        id,
        label: label.into(),
        argv,
        ..Default::default()
    }
}

fn entry(i: GitMenuItem) -> GitMenuEntry {
    GitMenuEntry::Item(i)
}

pub fn commit_menu_items(sha: &str, is_head: bool) -> Vec<GitMenuEntry> {
    use GitMenuEntry::Sep;
    vec![
        entry(GitMenuItem {
            disabled: is_head,
            ..item("checkout", "检出到此提交", argv(&["checkout", sha]))
        }),
        entry(item(
            "detach",
            "检出此提交（分离 HEAD）",
            argv(&["checkout", "--detach", sha]),
        )),
        Sep,
        entry(GitMenuItem {
            prompt: Some(PromptKind::Branch),
            ..item("branch-here", "从此提交创建分支…", None)
        }),
        entry(GitMenuItem {
            prompt: Some(PromptKind::Tag),
            ..item("tag-here", "从此提交创建标签…", None)
        }),
        entry(item("copy-sha", "复制提交哈希", None)),
        Sep,
        entry(item(
            "cherry-pick",
            "Cherry Pick 到当前分支",
            argv(&["cherry-pick", sha]),
        )),
        entry(item(
            "revert",
            "还原提交",
            argv(&["revert", "--no-edit", sha]),
        )),
        Sep,
        entry(item("merge", "合并进当前分支", argv(&["merge", sha]))),
        entry(item(
            "rebase",
            "将当前分支变基到此提交",
            argv(&["rebase", sha]),
        )),
        entry(item(
            "reset-soft",
            "重置当前分支到此提交（--soft）",
            argv(&["reset", "--soft", sha]),
        )),
        entry(item(
            "reset-mixed",
            "重置当前分支到此提交（--mixed）",
            argv(&["reset", "--mixed", sha]),
        )),
        entry(GitMenuItem {
            danger: true,
            ..item(
                "reset-hard",
                "重置当前分支到此提交（--hard）",
                argv(&["reset", "--hard", sha]),
            )
        }),
    ]
}

pub fn branch_menu_items(name: &str, is_current: bool) -> Vec<GitMenuEntry> {
    use GitMenuEntry::Sep;
    vec![
        entry(GitMenuItem {
            disabled: is_current,
            checked: is_current,
            ..item(
                "checkout",
                format!("检出 {name}"),
                argv(&["checkout", name]),
            )
        }),
        entry(item("pull", "拉取…", argv(&["pull", "origin", name]))),
        entry(item("push", "推送…", argv(&["push", "origin", name]))),
        Sep,
        entry(item("merge", "合并进当前分支", argv(&["merge", name]))),
        entry(item(
            "rebase",
            format!("变基当前分支到 {name}…"),
            argv(&["rebase", name]),
        )),
        Sep,
        entry(GitMenuItem {
            prompt: Some(PromptKind::Rename),
            ..item("rename", "重命名…", None)
        }),
        entry(GitMenuItem {
            danger: true,
            ..item("delete", "删除…", argv(&["branch", "-d", name]))
        }),
    ]
}

pub fn remote_menu_items(name: &str) -> Vec<GitMenuEntry> {
    use GitMenuEntry::Sep;
    let reference = if name.starts_with("origin/") {
        name.to_owned()
    } else {
        format!("origin/{name}")
    };
    let short = reference
        .strip_prefix("origin/")
        .unwrap_or(&reference)
        .to_owned();
    vec![
        entry(item(
            "checkout-remote",
            format!("检出为新分支 {short}"),
            argv(&["checkout", "-b", &short, &reference]),
        )),
        entry(item("pull", "拉取…", argv(&["pull", "origin", &short]))),
        Sep,
        entry(item(
            "merge",
            "合并进当前分支",
            argv(&["merge", &reference]),
        )),
        entry(GitMenuItem {
            danger: true,
            ..item(
                "delete-remote",
                "删除远程分支…",
                argv(&["push", "origin", "--delete", &short]),
            )
        }),
    ]
}

pub fn tag_menu_items(name: &str) -> Vec<GitMenuEntry> {
    use GitMenuEntry::Sep;
    vec![
        entry(item(
            "checkout-tag",
            "检出此标签（分离 HEAD）",
            argv(&["checkout", name]),
        )),
        Sep,
        entry(item(
            "push-tag",
            "推送标签…",
            argv(&["push", "origin", name]),
        )),
        entry(GitMenuItem {
            danger: true,
            ..item("delete-tag", "删除标签…", argv(&["tag", "-d", name]))
        }),
        entry(item("copy-tag", "复制标签名", None)),
    ]
}

/// prompt 项填入用户输入后生成 argv。`at` = 旧分支名（rename）或提交 sha（branch / tag）。
pub fn resolve_prompt(
    item: &GitMenuItem,
    value: &str,
    at: Option<&str>,
) -> Result<Vec<String>, String> {
    let v = value.trim();
    if v.is_empty() {
        return Err("名称为空".into());
    }
    let s = |x: &str| x.to_owned();
    match item.prompt {
        Some(PromptKind::Branch) => Ok(vec![s("branch"), s(v), s(at.unwrap_or("HEAD"))]),
        Some(PromptKind::Tag) => Ok([s("tag"), s(v)].into_iter().chain(at.map(s)).collect()),
        Some(PromptKind::Rename) => match at {
            Some(old) => Ok(vec![s("branch"), s("-m"), s(old), s(v)]),
            None => Err("缺少旧分支名".into()),
        },
        None => Err(format!("不是 prompt 项: {}", item.id)),
    }
}

/// 菜单选择后视图要做的下一步。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuPick {
    /// 视图开输入框
    Prompt {
        item: GitMenuItem,
        at: Option<String>,
    },
    /// 视图开二次确认
    Confirm { title: String, argv: Vec<String> },
    /// 已就地处理（复制 / 直接执行）或无操作
    None,
}

/// 菜单项选择：复制类 → 通知；prompt 项 → 开输入框；danger → 开二次确认；其余直接执行。
/// 执行与通知经闭包注入（视图 = toast / 后台任务，测试 = spy）。
pub fn pick(
    item: &GitMenuItem,
    at: Option<&str>,
    notify: &mut dyn FnMut(String),
    run: &mut dyn FnMut(Vec<String>),
) -> MenuPick {
    if item.id == "copy-sha"
        && let Some(at) = at
    {
        notify(format!("已复制 {}", at.chars().take(7).collect::<String>()));
        return MenuPick::None;
    }
    if item.id == "copy-tag"
        && let Some(at) = at
    {
        notify(format!("已复制 {at}"));
        return MenuPick::None;
    }
    if item.prompt.is_some() {
        return MenuPick::Prompt {
            item: item.clone(),
            at: at.map(str::to_owned),
        };
    }
    let Some(argv) = item.argv.clone() else {
        return MenuPick::None;
    };
    if item.danger {
        return MenuPick::Confirm {
            title: item.label.clone(),
            argv,
        };
    }
    run_git(&argv, notify, run);
    MenuPick::None
}

/// prompt 提交：解析 → 执行；校验失败通知并返回 `false`。
pub fn submit_prompt(
    item: &GitMenuItem,
    value: &str,
    at: Option<&str>,
    notify: &mut dyn FnMut(String),
    run: &mut dyn FnMut(Vec<String>),
) -> bool {
    match resolve_prompt(item, value, at) {
        Ok(argv) => {
            run_git(&argv, notify, run);
            true
        }
        Err(e) => {
            notify(e);
            false
        }
    }
}

/// 执行单点：回显命令 + 执行（fetch / 分支切换 / 确认执行共用）。
pub fn run_git(argv: &[String], notify: &mut dyn FnMut(String), run: &mut dyn FnMut(Vec<String>)) {
    notify(format!("$ git {}", argv.join(" ")));
    run(argv.to_vec());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(entries: Vec<GitMenuEntry>) -> Vec<GitMenuItem> {
        entries
            .into_iter()
            .filter_map(|e| {
                if let GitMenuEntry::Item(i) = e {
                    Some(i)
                } else {
                    None
                }
            })
            .collect()
    }
    fn find<'a>(all: &'a [GitMenuItem], id: &str) -> &'a GitMenuItem {
        all.iter()
            .find(|i| i.id == id)
            .unwrap_or_else(|| panic!("no {id}"))
    }
    fn v(a: &[&str]) -> Option<Vec<String>> {
        argv(a)
    }

    #[test]
    fn head_row_disables_checkout_and_argv_carries_the_sha() {
        let all = items(commit_menu_items("abc1234", true));
        assert!(find(&all, "checkout").disabled);
        assert_eq!(
            find(&all, "cherry-pick").argv,
            v(&["cherry-pick", "abc1234"])
        );
        assert!(find(&all, "reset-hard").danger);
        assert_eq!(find(&all, "copy-sha").argv, None);
        assert!(
            !items(commit_menu_items("x", false))
                .iter()
                .any(|i| i.id == "checkout" && i.disabled)
        );
    }

    #[test]
    fn only_reset_hard_is_dangerous_on_a_commit_menu() {
        let all = items(commit_menu_items("x", false));
        let danger: Vec<_> = all.iter().filter(|i| i.danger).map(|i| i.id).collect();
        assert_eq!(danger, ["reset-hard"]);
    }

    #[test]
    fn current_branch_is_checked_and_checkout_disabled() {
        let all = items(branch_menu_items("main", true));
        assert!(all[0].checked && all[0].disabled);
        assert!(find(&all, "delete").danger);
        assert_eq!(find(&all, "delete").argv, v(&["branch", "-d", "main"]));
        assert!(!items(branch_menu_items("dev", false))[0].disabled);
    }

    #[test]
    fn remote_menu_extracts_the_short_name_and_adds_origin_when_missing() {
        let all = items(remote_menu_items("origin/feat/ime"));
        assert_eq!(
            find(&all, "checkout-remote").argv,
            v(&["checkout", "-b", "feat/ime", "origin/feat/ime"])
        );
        assert_eq!(
            find(&all, "delete-remote").argv,
            v(&["push", "origin", "--delete", "feat/ime"])
        );
        let bare = items(remote_menu_items("feat"));
        assert_eq!(
            find(&bare, "checkout-remote").argv,
            v(&["checkout", "-b", "feat", "origin/feat"])
        );
    }

    #[test]
    fn tag_menu_shapes() {
        let all = items(tag_menu_items("v0.2.0"));
        assert_eq!(find(&all, "delete-tag").argv, v(&["tag", "-d", "v0.2.0"]));
        assert!(find(&all, "delete-tag").danger);
        assert_eq!(find(&all, "copy-tag").argv, None);
    }

    #[test]
    fn resolve_prompt_builds_argv_per_kind() {
        let branch = GitMenuItem {
            prompt: Some(PromptKind::Branch),
            ..item("b", "", None)
        };
        let tag = GitMenuItem {
            prompt: Some(PromptKind::Tag),
            ..item("t", "", None)
        };
        let rename = GitMenuItem {
            prompt: Some(PromptKind::Rename),
            ..item("r", "", None)
        };
        assert_eq!(
            resolve_prompt(&branch, " feat ", Some("abc")).unwrap(),
            ["branch", "feat", "abc"]
        );
        assert_eq!(
            resolve_prompt(&branch, "feat", None).unwrap(),
            ["branch", "feat", "HEAD"],
            "缺省 HEAD"
        );
        assert_eq!(
            resolve_prompt(&tag, "v1", Some("abc")).unwrap(),
            ["tag", "v1", "abc"]
        );
        assert_eq!(resolve_prompt(&tag, "v1", None).unwrap(), ["tag", "v1"]);
        assert_eq!(
            resolve_prompt(&rename, "new", Some("old")).unwrap(),
            ["branch", "-m", "old", "new"]
        );
    }

    #[test]
    fn resolve_prompt_rejects_blank_missing_old_name_and_non_prompt_items() {
        let rename = GitMenuItem {
            prompt: Some(PromptKind::Rename),
            ..item("r", "", None)
        };
        assert_eq!(
            resolve_prompt(&rename, "   ", Some("old")).unwrap_err(),
            "名称为空"
        );
        assert_eq!(
            resolve_prompt(&rename, "new", None).unwrap_err(),
            "缺少旧分支名"
        );
        let plain = item("merge", "", None);
        assert!(
            resolve_prompt(&plain, "x", None)
                .unwrap_err()
                .contains("不是 prompt 项")
        );
    }

    #[test]
    fn pick_copy_items_notify_and_do_nothing_else() {
        let all = items(commit_menu_items("abcdef123456", false));
        let mut notes = vec![];
        let mut runs: Vec<Vec<String>> = vec![];
        let p = pick(
            find(&all, "copy-sha"),
            Some("abcdef123456"),
            &mut |m| notes.push(m),
            &mut |a| runs.push(a),
        );
        assert_eq!(
            (p, notes.clone(), runs.len()),
            (MenuPick::None, vec!["已复制 abcdef1".to_owned()], 0)
        );

        let tags = items(tag_menu_items("v1"));
        notes.clear();
        pick(
            find(&tags, "copy-tag"),
            Some("v1"),
            &mut |m| notes.push(m),
            &mut |a| runs.push(a),
        );
        assert_eq!(notes, ["已复制 v1"]);
    }

    #[test]
    fn pick_prompt_items_return_a_prompt_and_run_nothing() {
        let all = items(commit_menu_items("abc", false));
        let (mut notes, mut runs): (Vec<String>, Vec<Vec<String>>) = (vec![], vec![]);
        let p = pick(
            find(&all, "branch-here"),
            Some("abc"),
            &mut |m| notes.push(m),
            &mut |a| runs.push(a),
        );
        assert!(matches!(p, MenuPick::Prompt { ref at, .. } if at.as_deref() == Some("abc")));
        assert!(notes.is_empty() && runs.is_empty());
    }

    #[test]
    fn pick_danger_items_require_confirmation_and_do_not_run() {
        let all = items(commit_menu_items("abc", false));
        let (mut notes, mut runs): (Vec<String>, Vec<Vec<String>>) = (vec![], vec![]);
        let p = pick(
            find(&all, "reset-hard"),
            Some("abc"),
            &mut |m| notes.push(m),
            &mut |a| runs.push(a),
        );
        assert_eq!(
            p,
            MenuPick::Confirm {
                title: "重置当前分支到此提交（--hard）".into(),
                argv: vec!["reset".into(), "--hard".into(), "abc".into()]
            }
        );
        assert!(runs.is_empty(), "未确认前绝不执行");
    }

    #[test]
    fn pick_plain_items_echo_the_command_then_run_it() {
        let all = items(commit_menu_items("abc", false));
        let (mut notes, mut runs): (Vec<String>, Vec<Vec<String>>) = (vec![], vec![]);
        let p = pick(
            find(&all, "cherry-pick"),
            Some("abc"),
            &mut |m| notes.push(m),
            &mut |a| runs.push(a),
        );
        assert_eq!(p, MenuPick::None);
        assert_eq!(notes, ["$ git cherry-pick abc"]);
        assert_eq!(runs, [vec!["cherry-pick".to_owned(), "abc".into()]]);
    }

    #[test]
    fn pick_an_item_without_argv_and_not_a_prompt_is_a_no_op() {
        let (mut notes, mut runs): (Vec<String>, Vec<Vec<String>>) = (vec![], vec![]);
        let p = pick(
            &item("copy-sha", "x", None),
            None,
            &mut |m| notes.push(m),
            &mut |a| runs.push(a),
        );
        assert_eq!(p, MenuPick::None, "copy-sha 缺 at：无操作");
        assert!(notes.is_empty() && runs.is_empty());
    }

    #[test]
    fn submit_prompt_runs_on_success_and_notifies_the_reason_on_failure() {
        let branch = GitMenuItem {
            prompt: Some(PromptKind::Branch),
            ..item("b", "", None)
        };
        let (mut notes, mut runs): (Vec<String>, Vec<Vec<String>>) = (vec![], vec![]);
        assert!(submit_prompt(
            &branch,
            "feat",
            Some("abc"),
            &mut |m| notes.push(m),
            &mut |a| runs.push(a)
        ));
        assert_eq!(notes, ["$ git branch feat abc"]);
        assert_eq!(runs.len(), 1);

        notes.clear();
        assert!(!submit_prompt(
            &branch,
            "  ",
            Some("abc"),
            &mut |m| notes.push(m),
            &mut |a| runs.push(a)
        ));
        assert_eq!(notes, ["名称为空"]);
        assert_eq!(runs.len(), 1, "失败不执行");
    }
}
