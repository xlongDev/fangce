# 贡献指南

## 1. 分支模型

```text
main        稳定分支，只接受来自 develop / fix/* 的合并
develop     集成分支，日常开发的目标分支
feature/*   新功能
fix/*       缺陷修复
refactor/*  重构
```

小改动可以直接在 `develop` 上提交；跨多个提交的功能另开 `feature/*`，完成后合并回 `develop`。

## 2. 提交规范

使用 Conventional Commits，前缀由 git hook 强制校验：

```text
<type>(<scope>): <subject>
```

`type` 取值范围：`feat` `fix` `refactor` `perf` `test` `docs` `chore` `build` `ci` `revert`。

```text
feat(reader): add paragraph index to the document model
fix(library): keep sort order after deleting a book
perf(search): batch FTS5 inserts inside one transaction
```

`subject` 用英文，祈使句，首字母小写，结尾不加句号。

## 3. 本地环境

```bash
pnpm install
pnpm hooks     # 挂载 .githooks（clone 后只需一次，用 core.hooksPath，不引入 husky）
```

`pre-commit` 会跑：`prettier --check` → `oxlint` → `tsc --noEmit` → `cargo fmt --check` → `cargo clippy -D warnings`。
`commit-msg` 会校验 Conventional Commits 前缀。

需要跳过钩子时先想清楚为什么；如果是因为钩子本身太慢，应该改钩子而不是绕过它。

## 4. 质量门禁

推送前必须全绿：

```bash
pnpm verify        # typecheck + lint + test + build
pnpm verify:rust   # rustfmt --check + clippy(-D warnings) + cargo test
pnpm verify:all    # 两者
```

通过标准：

- `oxlint`：**0 warning 0 error**。不允许为了通过而加白名单或降级规则；有问题就修代码。
- `tsc --noEmit`：0 error。**不允许新增 `any`**（`typescript/no-explicit-any` 是 error）。确实无法避免时，加一行注释说明原因。
- `cargo clippy -D warnings`：0 warning。
- `cargo test` / `vitest run`：全绿。

`pnpm build` 会附带输出构建产物体积，前端资源体积的回归要看这个数字。

### 改了 Rust 命令签名之后

`src/lib/bindings.ts` 是 `cargo test export_bindings` 生成的（`src-tauri/src/lib.rs` 的 `specta_bindings` 模块），committed 但不手写。生成器自己排版：**制表符缩进、不折行、jsdoc 行尾留空格**，和 prettier 的产物不是同一份字节 —— 所以 `cargo test` 跑过之后这个文件必然变脏，`pre-commit` 的 `prettier --check` 会红。顺序固定成：

```bash
cargo test --manifest-path src-tauri/Cargo.toml export_bindings
pnpm exec prettier --write src/lib/bindings.ts
```

反过来（先格式化再跑 cargo test）等于白做。`specta-typescript 0.0.12` 没有 formatter 选项，`Layout` 只管文件结构不管缩进，所以这件事只能靠这两步的顺序，别去改生成器。

### 关于 `react-perf` 规则

配置里**没有启用** `react-perf` 插件。它的三条主要规则（`jsx-no-new-object-as-prop`、`jsx-no-new-function-as-prop`、`jsx-no-jsx-as-prop`）只在子组件被 `memo` 包裹时才有意义，而这个项目的组件树刻意不手动 `memo` —— React 19 的渲染成本足够低，全面手动记忆化带来的复杂度和它省下的渲染相比不划算。什么时候重新启用：**当某个视图被 Profiler 证明存在渲染瓶颈时**，在该视图局部启用记忆化，而不是全局打开这组规则。

## 5. 代码规范

### TypeScript

- `strict: true`，另外开启了 `noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters`、`verbatimModuleSyntax`。
- 类型导入用 `import type`（`typescript/consistent-type-imports` 是 error）。
- 文件名 `PascalCase`（组件）或 `camelCase` / `kebab-case`（其他），由 `unicorn/filename-case` 强制。
- 只用函数组件与 Hooks，不写 class 组件。

### React

- 状态归属见 ARCHITECTURE.md 第 3 节：UI 状态进 Zustand，IPC 数据进 TanStack Query。
- 不要用 effect 去同步"可以由 props / key 推导出来的 state"。需要重置子组件状态时用 `key` 重挂载（见 `CommandPalette` 的 `session`）。
- 动画统一走 Motion，并且必须尊重 `prefers-reduced-motion`。动画要短、轻、自然，不做花哨动效。

### Rust

- `cargo fmt` 与 `cargo clippy -D warnings` 必须通过。
- 生产路径禁止 `unwrap()` / `expect()` / `panic!()`。用 `?` 把错误提升为 `AppError`。
- 日志用 `tracing`，不输出敏感数据（API Key、用户文件路径中的隐私片段、书籍正文）。

### 样式

- 只使用 `globals.css` 中定义的 Design Token，不在组件里写死颜色。
- 圆角使用 `--radius-*` 系列（最小 14px），不使用 4–8px 的传统后台圆角。
- 需要"玻璃"效果时用 `GlassSurface` 的 `elevation`，不要手写 `backdrop-filter`。嵌套在面板内部的元素选 elevation 1（无模糊），避免模糊层层叠加。

## 6. 新增一个 IPC 命令

1. Rust 侧：在 `src-tauri/src/commands/<domain>.rs` 定义命令，返回 `Result<T, AppError>`。
2. 在 `src-tauri/src/lib.rs` 的 `generate_handler!` 中注册。
3. 如果命令需要新的系统权限，在 `capabilities/default.json` 中**只加最小必需的权限**，并在 PR 描述里说明理由。
4. 前端：在 `src/types/ipc.ts` 镜像返回类型，在 `src/lib/ipc.ts` 中添加调用方法。
5. 用 TanStack Query 消费（`hooks/` 下新建 hook），不要直接把结果写进 Zustand。

## 7. 远程与推送

本机 GitHub 推送**必须走 SSH**：

```bash
git remote set-url origin git@github.com:<owner>/<repo>.git
```

原因：本机 `gh` 登录使用的是 fine-grained PAT，它对 git over HTTPS 的写操作一律返回 403（`Permission to <owner>/<repo> denied`），`gh auth setup-git` 也无效；SSH key 已注册且推送正常。HTTPS 只读不受影响。

## 8. 禁止事项

- 复制 ColorTxt 的源代码或照搬其目录结构。
- 用 mock 数据冒充真实功能，用 `console.log` 代替错误处理。
- 用 TODO 占位核心功能。
- 为了通过编译或 lint 而删除功能。
- 无理由新增依赖：能通过标准库、平台能力或已有依赖解决的，就不要装新包。
