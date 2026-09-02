# j-agent 项目 Agent 规则

本文件对在此目录工作的所有 agent 生效。

## 依赖引入规则

1. **版本选择**：引入任何库（Rust crate / npm 包 / git 依赖）时，使用**较新的正式 release 版本**，禁止使用 beta / alpha / rc / preview / pre-release 版本。
2. **兼容性检查**：引入前必须确认新库与项目内已有库的**兼容性**（版本互相依赖关系、同一库的版本冲突、patch/替换关系），不能只看单个库能否编译。
3. **版本必须联网核实**：写任何版本号之前，**必须联网查询最新版本**（crates.io / npm registry / GitHub Releases / 仓库的 Cargo.toml 或 package.json），**禁止凭模型记忆填版本号**——模型记忆可能过时数月，宁可多查一次，不可凭空写。
4. 发现文档/记忆中的版本与联网查询结果不一致时，以联网结果为准，并在 TODOLIST.md 或相关文档中记录差异。
