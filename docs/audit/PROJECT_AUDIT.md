# 方册 · 项目审计（Phase 0）

> 审计对象：`~/Documents/Project/ColorReader`（产品名 **方册 / fangce**），分支 `main`，HEAD `1a81857`，工作区在本轮改动前干净。
> 审计方式：读真实代码，不采信 README 与既有架构描述。所有结论后面都跟着文件路径。
> 审计日期：2026-11-10。

## 0. 结论摘要

**方册已经是一个成熟产品，不是一个待搭骨架的 demo。** 阅读、检索、RAG、知识图谱、AI 助手、TTS、词典、书源、同步、导入导出全部有真实实现和测试（637 个 Rust 测试块、119 个前端测试文件、50 个 e2e 规格）。

**本次迭代要的五件事，现状是：**

| 目标           | 现状                                                            | 结论                                    |
| -------------- | --------------------------------------------------------------- | --------------------------------------- |
| 高级书库管理   | 四个书架 + 标签栏 + 搜索 + 排序 + 分组 + 批量（收藏/标签/删除） | **有底子，缺结构化筛选与统计**          |
| 高级元数据管理 | 单一编辑表单（标题/副标题/作者/简介/语言/出版社/封面）          | **缺 Provider、缺候选对比、缺来源追踪** |
| Calibre 兼容   | 无                                                              | **完全没有**                            |
| MCP / Agent    | 无（全仓 grep `mcp` 只命中 `pnpm-lock.yaml`）                   | **完全没有**                            |
| 插件系统       | 有 JSON 书源规则，无插件运行时                                  | **只有第一层「配置型」**                |

**最重要的审计发现（会改变实施顺序）：**

1. **方册不是 Calibre 客户端，dalibre 是。** dalibre 直接读写 calibre 的 `metadata.db`（user_version 28）并复刻它的命名规则；方册有自己的 schema、自己的书库目录、自己的 `content_hash` 去重。所以 Calibre 兼容只能是**适配层**，不能是「改造成 Calibre 库」。这条决定了 Phase 5 的成本远高于 Phase 1/3。
2. **AI 工具全是「书内」的。** `ai/tools.rs` 注册了 5 个工具：`search_book` / `read_chapter` / `character` / `mindmap` / `wordcloud`，全部绑定 `book_id`。**没有任何书库级工具**（列书、按作者筛、跨书问答）。RAG 已有（`retrieval/rag.rs`），但没有暴露给工具层。
3. **删除曾经是硬删除，删除的是书库副本。** `library/mod.rs::delete_book` 删行 + unlink；`io/import.rs:279` 用 `fs::copy` 把书复制进书库目录，所以删的从来不是用户的原文件——这一点是对的。**2026-11-10 已改为两步删除**（`deleted_at` + `books_live` 视图，见 `IMPLEMENTATION_PLAN.md` §0），回收站之外不再有任何不可逆的删除。
4. **检索是扫描不是索引。** migration 18 删掉了 `chapters_fts`，`retrieval/search.rs` 直接 `LIKE` 扫 `chapters`。这是刻意的性能取舍（索引曾占整库 78%），MCP 的 `search_book_content` 必须复用这条路径，**不要重新引入 FTS**。
5. **没有统一的任务层。** 长任务靠事件上报进度（`book://import-progress`、`book://delete-progress`、`rag://library-progress`），没有 task id、没有状态查询、没有取消。MCP 的 `get_task_status` / `cancel_task` 需要先把这层建出来。

## 1. 事实基线

| 项       | 值                                                                                      |
| -------- | --------------------------------------------------------------------------------------- |
| 桌面框架 | Tauri 2（`tray-icon` / `image-png` / `macos-private-api`）                              |
| Rust     | edition 2024，`rust-version = 1.90`，crate 名 `fangce` / lib `fangce_lib`               |
| 前端     | React 19.3 + Vite 8 + Tailwind 4.3 + zustand 5 + TanStack Query 5 + motion 14 + Radix   |
| 类型桥   | `tauri-specta 2.0.0-rc.25` → `src/lib/bindings.ts`（`cargo test export_bindings` 生成） |
| 数据库   | rusqlite 0.40（bundled），`user_version` 迁移，21 个版本，事务内 bump                   |
| 网络     | reqwest 0.13（rustls，system-proxy），无 OpenSSL                                        |
| 凭据     | `keyring` 4（macOS keychain）+ AES-256-GCM，`src/secrets.rs`                            |
| 规模     | Rust 108 文件 / ≈36.6k 行；前端 385 文件 / ≈76.2k 行                                    |
| IPC      | 118 个 `#[tauri::command]`，分布在 26 个 `commands/*.rs`                                |
| 测试     | Rust 637 个 `#[test]`；前端 119 个测试文件；e2e 50 个 spec                              |

## 2. 前端审计

**结构**：`src/app`（路由）、`src/features/<domain>`（library / reader / search / notes / graph / settings / source / stats / command）、`src/components/glass`（设计系统）、`src/hooks`（数据层）、`src/stores`（zustand）、`src/lib/local`（浏览器端 IndexedDB 后端）。

**做得好的**

- **同一套 hook 跑两端**：`lib/ipc.ts` 的 `LOCAL_COMMANDS` 把 40 个命令换成 IndexedDB 实现，桌面与浏览器共用 query key 与缓存。新增命令必须两边都实现，否则 web 构建静默失效。
- **纯逻辑抽得干净**：`shelfQuery.ts` / `group.ts` / `migrate.ts` / `neighbors.ts` 都是可测的纯函数，组件只负责渲染。本轮的筛选逻辑就顺着这条线加。
- **大组件已被主动拆分**：`LibraryPage` 712 行但全是编排；`ShelfToolbar` / `ShelfBatchBar` / `ShelfGrid` / `BookCard` 各自独立。
- **动效克制且有理由**：`SPRING`/`DURATION` 常量统一，`useReducedMotion` 全局上闸。

**缺口**

- `useBooks` 一次取全量（`book_list` 返回 `Vec<BookSummary>`，无分页）。39 本无感，几千本时首屏和分组都会变慢。
- 书架维度是 `filter`（all/recent/favorites/tags）这一个枚举，没有可组合条件。
- 没有「作者 / 出版社 / 系列」入口：作者只能靠搜索框命中，或靠 `group.ts` 分组。
- 没有操作历史，批量改元数据后无法回看改了什么。

## 3. Rust 审计

**分层**：`commands/*`（薄，转发到 `library/*`）→ `library/{shelf,io,marks,retrieval,lookup,assist,transfer}`（业务）→ `db`（连接与迁移）→ `document/*`（格式解析）→ `ai/*`（模型调用与工具）。

**做得好的**

- **命令层确实很薄**：`book_list` 就是一行 `state.library.with(...)`。业务在 `library` 里，可被将来的 MCP 复用——这是本次迭代最有利的既有条件。
- **错误类型统一**：`AppError`（thiserror），`NotFound` / `InvalidArgument` / `Message` 等，前端能显示可读中文。
- **文件 IO 有阻塞隔离**：导入、删除走 `spawn_blocking`；阅读走 HTTP Range 流式。
- **解析器是自研且分格式**：`document/{epub,pdf,mobi,fb2,cbz,plain,html}.rs`，MOBI 拆成 6 个子模块（palmdoc / pdb / index / exth / text / markup）。

**缺口**

- **业务与 Tauri 状态耦合**：函数签名普遍是 `&Connection` 或 `&Library`，`State<AppState>` 只在 commands 里出现——好在耦合点在命令层，抽服务层成本低。
- **没有任务注册表**：见摘要第 5 条。
- **没有审计日志表**：任何写操作都没有「谁、什么时候、改了什么」的记录。
- **元数据只有一个写入口** `repository::update_metadata`，接受整份 `BookMetadataPatch`（全量覆盖，不是 patch）。批量改元数据需要先有「字段级差异」概念。

## 4. 数据库审计

**表（21 个迁移后的实际形态）**

`books`（id, title, sort_title, subtitle, description, language, publisher, identifier, format, content_hash UNIQUE, file_path, file_size, cover_path, added_at, updated_at, last_read_at, progress, favorite, location, chapters_pending）、`authors` / `book_authors`、`tags` / `book_tags`、`chapters`、`annotations`（含 cfi/color/style/note/updated_at）、`bookmarks`、`annotation_tombstones` / `bookmark_tombstones`、`reading_sessions`、`settings`、`chunks`（含 model/dims）、`entities` / `entity_relations`、`sources`、`ai_conversations` / `ai_messages`、`chapter_summaries`。

**判断**

| 问题（来自迭代要求 §4.3） | 现状                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 一本书能否对应多个格式    | **不能**。`content_hash` 是主身份，一种格式一行。`migrate.rs` 用「同书不同版」的启发式迁移，但不是数据模型层面的多格式 |
| 元数据来源是否可追踪      | 不能。`identifier` 是 EPUB 里抄来的，没有来源字段                                                                      |
| 标签/分类能否批量         | 标签能（`tags::assign` 是集合差）；分类概念不存在                                                                      |
| 系列 / 出版社 / 语言      | 出版社、语言有；**系列没有**                                                                                           |
| 元数据修改历史            | 没有                                                                                                                   |
| 外部 Agent 操作记录       | 没有                                                                                                                   |
| 插件与权限                | 没有                                                                                                                   |
| 操作撤销                  | 没有                                                                                                                   |

**迁移机制**是可靠的：`MIGRATIONS` 数组 + `user_version` + 事务内 bump，注释里写明「已发布的条目永不修改」。新增一律 append，版本 22 起。

## 5. 安全审计

**已有的**

- 凭据在 keyring（主密钥 32 字节 + AES-256-GCM 封字段），`SECRET_FIELDS` 是唯一清单，备份脱敏也读它。
- 备份导出会脱敏。
- 前端不直接读文件系统，一切经命令。
- 没有本地监听端口——**所以 MCP 引入的是本项目第一个网络/进程间入口**，必须按 §8.4 全套做（localhost only、token、权限分级、审计）。

**风险**

- 导入是 `fs::copy`，不移动原文件——正确。
- 删除已改为两步（回收站），但 `book_empty_trash` 只有后端与测试，UI 走的是「全选 → 彻底删除」。
- 书源规则是用户可导入的 JSON，走 `library/io/source.rs`；如果将来允许插件执行代码，这是第一个需要沙箱的入口。

## 6. 测试审计

- Rust：637 个测试块，覆盖迁移、解析器、检索、AI 工具、同步、加密包。风格是「一个行为一个测试 + 中文断言消息说明为什么」。
- 前端：119 个文件，纯函数几乎全覆盖；组件测试集中在对话框与卡片。
- e2e：50 个 spec，跑 `vite preview`（**改完源码必须先 build**）。
- 缺口：**没有针对 `book_list` 之外的查询组合的集成测试**（本轮补了 9 个）；没有 MCP/插件/Calibre 相关的任何测试（因为功能不存在）。

## 7. 与目标能力的差距矩阵

| 能力              | 现状                                                     | 差距                             | 优先级                       |
| ----------------- | -------------------------------------------------------- | -------------------------------- | ---------------------------- |
| 结构化筛选        | 本轮新增（格式/语言/出版社/状态/封面 + facets）          | 无保存视图、无作者/系列/日期区间 | P1（已起步）                 |
| 分页              | 无                                                       | `book_list` 全量返回             | P2（几千本才痛）             |
| 元数据 Provider   | 无                                                       | 全新模块                         | P1                           |
| 元数据候选对比 UI | 无                                                       | 全新                             | P1                           |
| 重复检测          | 只有 SHA256（导入时拒绝）                                | 缺 ISBN/标题+作者相似度、缺合并  | P2                           |
| 回收站            | 已实现：`deleted_at` + `books_live` 视图 + `/trash` 书架 | 缺删除时间显示、自动清理         | 已完成                       |
| 操作日志          | 无                                                       | 新表 + 写入点                    | P2                           |
| MCP               | 无                                                       | 全新，最高价值                   | P1（改动全加法，零回归风险） |
| 插件              | JSON 书源                                                | 缺 manifest / 权限 / 运行时      | P3                           |
| Calibre           | 无                                                       | 适配层，成本最高                 | P3                           |
| AI 书库工作流     | 书内工具 5 个                                            | 缺书库级工具 + 预览确认          | P2（依赖 MCP 的工具层）      |

## 8. 不要做的事（从代码里读出来的硬约束）

1. **不要把 FTS 装回来**（migration 18 删过，索引曾占 78%）。
2. **不要绕过 `library/*` 在 MCP 里直接写 SQL**——业务都在这一层，绕过去就等于第二套规则。
3. **不要把 Calibre 的 book id 当主键**，也不要改用户原始书库。
4. **不要给 `ensure`（只承诺索引）加整本正文抽取**，会把「正在打开…」卡住。
5. **不要用前端全量遍历算 facets**——本轮实现是 SQL `GROUP BY`，web 端才在内存里算（本来就只有几十本）。
6. **不要在 Tauri setup 里用 objc2 改 NSApp**（会让 dev 启动即 SIGABRT，已回退过）。
