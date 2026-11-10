# 方册 · 迭代实施计划

> 依据：`docs/audit/PROJECT_AUDIT.md`（真实代码审计）+ `docs/audit/DALIBRE_FEATURE_MAPPING.md`。
> 原则：**垂直切片**，每个切片从迁移走到 UI 再走到测试；任何一片都不许「只有 UI 没有后端」。
> 提交纪律：**等确认再 commit / push**（用户明确要求，见 `CONTRIBUTING.md`）。

## 0. 已交付（本轮）

### Phase 1.1 — 结构化筛选 + Facets ✅

| 层       | 文件                                                                                                                                             | 内容                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据模型 | `src-tauri/src/library/shelf/repository.rs`                                                                                                      | `BookQuery` 增加 `formats` / `languages` / `publishers` / `status` / `hasCover`，全部 `#[serde(default)]`，旧调用方行为不变；新增 `ReadingStatus`、`Facet`、`LibraryFacets` |
| 查询     | 同上                                                                                                                                             | 把条件构建抽成 `conditions(query, skip)`；`list()` 改为复用；新增 `facets()`，**每个维度用「清掉自己这一维」的条件计数**                                                    |
| 命令     | `commands/book.rs` + `lib.rs`                                                                                                                    | `book_facets(query) → LibraryFacets`，同时注册到运行时与 `export_bindings`                                                                                                  |
| 浏览器端 | `lib/local/books.ts`、`lib/ipc.ts`                                                                                                               | `bookFacets` 在 IndexedDB 上聚合；`bookList` 的过滤谓词抽成 `matches(book, query, skip)` 与 facets 共用，两端规则一致                                                       |
| 前端状态 | `features/library/shelfQuery.ts`                                                                                                                 | `ShelfFilters`、`NO_FILTERS`、`activeFilterCount`、`toggleValue`；`buildBookQuery` 多一个可选参数（未筛时**不发任何新字段**）                                               |
| UI       | `features/library/ShelfFilterMenu.tsx`（新）、`ShelfToolbar.tsx`、`TagBar.tsx`（导出 chip 类）、`components/glass/menu.tsx`（新增 `widthClass`） | 工具栏「筛选」按钮 + 计数徽标；面板按维度分节，chip 带计数，计数为 0 的置灰不可点；`menuitemcheckbox` 语义                                                                  |

**证据**：Rust `shelf::repository` 33 passed（含新增 9 个：空查询等于旧行为、格式窄化、状态阈值与 `stats` 一致、语言精确匹配、封面双向、facet 只忽略自己那一维、无出版社不产生空桶、状态/封面三桶恒在）；前端 140 passed；`tsc --noEmit` 干净；`oxlint` 0 warning 0 error；`vite build` 通过。

**明确未做的**：保存筛选视图、作者/系列/出版日期区间、分页、筛选结果为空时的引导文案。

### Phase 1.2 — 回收站（软删除）✅

| 层             | 文件                                                                                                                                                                                                                                                         | 内容                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据库         | `db/migrations.rs`（version 22）                                                                                                                                                                                                                             | `books.deleted_at` + 部分索引 + **`books_live` 视图**（`WHERE deleted_at IS NULL`）                                                                                                                                                |
| 仓储           | `library/shelf/repository.rs`                                                                                                                                                                                                                                | `delete`/`delete_many` 拆成 **`trash`**（打时间戳）与 **`purge`**（删行）；新增 `restore` / `restore_many` / `empty_trash`；`BookQuery.trash` 让书架查询直接读回收站；`get` / `list` / `facets` / `stats` / 两个补章队列全部走视图 |
| 服务           | `library/mod.rs`                                                                                                                                                                                                                                             | `delete_book(s)` 只打时间戳、**不 unlink**；新增 `restore_books` / `purge_book(s)` / `empty_trash`（旧的 unlink 逻辑整体搬到这里）                                                                                                 |
| 导入           | `library/io/import.rs`                                                                                                                                                                                                                                       | 同一 `content_hash` 命中回收站里的书时**恢复它**并报「已在书架上」，而不是撞 UNIQUE 后失败                                                                                                                                         |
| 检索/同步/统计 | `retrieval/{search,rag}.rs`、`transfer/sync.rs`、`shelf/stats.rs`                                                                                                                                                                                            | 全部 `JOIN books_live`：回收站里的书不参与全文检索、RAG、跨设备进度推送和统计排行                                                                                                                                                  |
| 命令           | `commands/book.rs` + `lib.rs`                                                                                                                                                                                                                                | `book.restore` / `book.purge` / `book.purgeMany` / `book.emptyTrash`                                                                                                                                                               |
| 前端           | 新路由 `/trash` + `NavList` 末位「回收站」；`ShelfBatchBar` 增加 `mode="trash"`（只有 恢复 / 彻底删除）；`useShelfSelection` 增加 `alwaysManaging`（回收站里没有「打开」这件事）；`ShelfGrid` 增加可替换的空状态；`ShelfHeader` 的导入三键换成「清空回收站」 |                                                                                                                                                                                                                                    |
| 浏览器端       | `lib/local/{rows,books}.ts`                                                                                                                                                                                                                                  | `StoredBook.deletedAt`（只在行上，不进 `BookSummary`）；`bookList` / `bookFacets` / `bookStats` / `bookGet` 认这个字段；`bookRestore` / `bookPurge(M) ` / `bookEmptyTrash`                                                         |

**证据**：Rust 646 passed（新增：批量删除只打时间戳且文件还在、恢复后行与文件都在、purge 才删文件、空回收站不动书架上的书、回收站列表/搜索/facets 只数回收站、重复导入恢复原书）；前端 236 passed；e2e `shelf-batch-delete` 重写为**完整往返**（删除 → 行都还在 → 回收站 → 恢复 → 书架 → 再删 → 彻底删除 → 行清空 → 空回收站文案），双引擎通过。

**取舍**（有意为之，不是遗漏）：

- **不做「删除于 X 天前」**：那需要 `BookSummary` 多一个字段，会波及 `demoBooks`、`StoredBook` 和所有构造 `BookSummary` 的测试。回收站通常只有几本，收益不抵扩散。
- **`book.emptyTrash` 有后端和测试，UI 没接按钮**：回收站里「全选 → 彻底删除」已经等价，多一个按钮只是同一条路径的第二个入口。
- **视图用 `SELECT *`**：后续给 `books` 加列不会自动出现在视图里。这是刻意的——视图是读面，静默变宽是没人 review 过的 schema 变更。

### Phase 3.1 / 3.2 — MCP 只读服务（stdio）✅

| 层   | 文件                                          | 内容                                                                                                                                            |
| ---- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 传输 | `src-tauri/src/mcp.rs`                        | newline-delimited JSON-RPC 2.0 over stdin/stdout；`initialize` / `ping` / `tools/list` / `tools/call`；通知不回包；坏行回 `-32700` 且不中断会话 |
| 入口 | `main.rs` + `lib.rs::run_mcp`                 | `fangce --mcp` 走一条**不启动 Tauri** 的路径（无窗口、无 webview、无事件循环）；日志强制走 stderr，stdout 只留协议                              |
| 数据 | `db::Library::open_existing` + `db::data_dir` | 以 `PRAGMA query_only = ON` 打开已有库，**不迁移、不 VACUUM**；数据目录按 Tauri `app_data_dir` 的规则复刻，`FANGCE_DATA_DIR` 可覆盖             |
| 工具 | `mcp.rs::run`                                 | `search_books` / `get_book` / `search_book_content` / `get_annotations` / `get_bookmarks`，全部调 `library::*`，**工具层没有自己的 SQL**        |
| 文档 | `docs/mcp/MCP_SETUP.md`                       | 客户端配置、工具表、边界、自检命令                                                                                                              |

**为什么是 stdio 不是 HTTP**：本仓目前一个监听端口都没有；stdio 天然只有启动它的进程能连，省掉 token 分发、端口冲突、防火墙例外三件事。HTTP 留到「需要多个客户端同时连」。

**证据**：Rust 655 passed（`mcp::` 当时 9 个，加了 3.4/3.5 后共 17 个：握手、通知不回包、工具清单、检索不进回收站、正文检索带可定位偏移、标注/书签、缺书是 `isError` 而不是断连、未知工具是协议错误、坏行不中断）。**真实二进制跑过真实书库**：985 本书，`search_books` 返回 `total: 985`，`search_book_content("的")` 返回带 `chapterIdx` / `offset` / `chapterTitle` 的片段。

**没做**：调用日志（3.1 的另一半）、`ask_library` / `export_notes`（3.3）、任务层（3.6）、设置页区块（3.7）。

### Phase 3.4 / 3.5 — 权限层与第一批写工具 ✅

| 层     | 位置                            | 内容                                                                                                                                                    |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 权限   | `mcp.rs::Permission` / `Grants` | 四档：`read` / `search` / `write_metadata` / `delete`；**按连接**从 `FANGCE_MCP_PERMISSIONS` 读，默认 `read,search`；`all` 是简写；未知名字记日志后忽略 |
| 暴露面 | `Server::catalogue`             | 未授予的工具**不出现在 `tools/list` 里**（能看见却调不动的工具，Agent 会一直去调）                                                                      |
| 越权   | `Server::call_tool`             | 返回 `isError` 结果而不是协议错误，正文写明缺哪一档、当前有哪些、配置该写什么（建议值包含缺的那一档）                                                   |
| 写工具 | `mcp.rs`                        | `update_metadata`（读—改—写，只覆盖给出的字段，空串=清空）、`manage_tags`（加/去）、`remove_books`（**移到回收站**，返回 `recoverable: true`）          |
| 审计   | `mcp.rs::Server::record`        | 每次写追加一行 `mcp-audit.jsonl`（时间/工具/参数/结果）；读不留痕；写日志失败只记日志不报错                                                             |

**为什么权限按连接而不是按应用**：读者可以给一个 Agent 只读、给另一个改元数据的权限，互不影响；而「当前这个连接能做什么」写在客户端配置里，是唯一能被看见的地方。应用级开关只会得到「我记得我关过」这类无法核对的记忆。

**为什么 `search` 和 `read` 分开**：搜一次要扫所有书的正文。「只让它看我点名的那本」和「让它 grep 我整个书库」不是同一个同意。

**证据**：Rust 663 passed（`mcp::` 17 个，新增：默认授予只列五个工具、越权调用给出可执行建议且不改库、单字段更新不动其它字段、空串清空、标签增删、`remove_books` 只进回收站、写留一行审计而读不留、grant 解析）。**真实二进制验证**：默认 `tools/list` 五个工具；`FANGCE_MCP_PERMISSIONS=all` 八个；越权调用真实库返回 `"read,search,delete"` 建议。

**没做**：`suggest_metadata`（依赖 Phase 2 的 Provider）、`import_books`（按路径导入是另一个信任问题：路径必须落在授权目录内）、`export` / `manage_library` 两档权限（随对应工具再加——没有工具支撑的权限名是空话）。

## 1. 路线图

顺序与迭代要求 §14 一致（书库 → 元数据 → MCP → 插件 → Calibre → AI 工作流），但**每阶段内部按「先数据安全、再能力」排**。

### Phase 1（续）— 书库管理收口

| #   | 切片                 | 为什么现在                                                           | 验收                                                                                                             |
| --- | -------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1.2 | **回收站（软删除）** | 当前删除不可逆，笔记/标注/进度一起没。这是数据安全问题，不是功能问题 | 迁移 22 加 `deleted_at` + `books_live` 视图；读路径全走视图；恢复/彻底删除两个命令；e2e 覆盖「删→恢复→笔记还在」 |
| 1.3 | **分页**             | `book_list` 返回全量，几千本时首屏和分组都会卡                       | `BookQuery` 加 `limit`/`offset`，返回 `total`；书架用现有 `useShelfWindow` 做窗口化                              |
| 1.4 | **批量元数据编辑**   | 批量栏现在只能收藏/标签/删除                                         | `update_metadata` 拆出字段级 patch；批量栏加「作者 / 出版社 / 语言」；改前预览影响范围                           |
| 1.5 | **重复检测**         | SHA256 已在导入时拦住完全一致；剩下 ISBN / 标题+作者相似度           | 只出「疑似重复」列表 + 并排对比，**不做自动合并**                                                                |
| 1.6 | 操作日志             | 1.4 的撤销依赖它                                                     | `operations` 表：时间、来源（ui/mcp/plugin）、工具名、参数摘要、结果                                             |

**Phase 1 出口**：删书能撤回；批量改元数据能看改动；5000 本书首屏 < 300ms。

### Phase 2 — 元数据

| #   | 切片                                                                              | 验收                                       |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| 2.1 | `MetadataProvider` trait + Google Books / Open Library 两个实现                   | 单个 ISBN 能查到候选；网络失败只影响该来源 |
| 2.2 | 候选结果 + 置信度                                                                 | 置信度是**内部匹配分**，UI 不许叫「概率」  |
| 2.3 | 字段级对比 UI（当前值 / 候选值 / 来源 / 是否应用）                                | 不确认不覆盖；用户改过的字段默认不勾       |
| 2.4 | 批量补全 + 进度/取消/失败原因                                                     | 一个来源挂了不拖垮整批                     |
| 2.5 | 字段扩展：`series`、`series_index`、`published_date`、`isbn_10/13`、`translators` | 迁移 23；老库全部可空                      |

**注意**：Provider 的 API 条款要逐个核实（限流、是否需要 key、能否缓存封面与简介）。没核实完不许上线默认开启的来源。

### Phase 3 — MCP（最高价值，改动全加法）

**传输：先 stdio，不先 HTTP。** 理由：本仓目前零监听端口；stdio 天然只有启动它的那个 Agent 能连，省掉 token 分发、防火墙例外、端口冲突三件事。HTTP 留到「需要多个客户端同时连」时再说。

| #   | 切片                                                                                                        | 验收                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 3.1 | 服务骨架 + 工具注册表（**调用日志未做**）                                                                   | `fangce --mcp` 能被 Claude Code / Cursor 连上，`tools/list` 正确                                     |
| 3.2 | 只读工具：`search_books` / `get_book` / `search_book_content` / `get_annotations` / `get_bookmarks` **✅**  | 返回可定位的原文证据（book_id + chapter_idx + 字符区间），复用 `retrieval/search.rs`，**不新建索引** |
| 3.3 | `ask_library`（RAG）+ `export_notes`                                                                        | 回答里区分原文引用与模型推理                                                                         |
| 3.4 | 权限层：`read` / `search` / `write_metadata` / `delete` **✅**                                              | 默认只读；按连接授予；越权返回可读错误（`export` / `manage_library` 随对应工具再加）                 |
| 3.5 | 写工具：`update_metadata` / `manage_tags` / `remove_books` **✅**；`suggest_metadata` / `import_books` 未做 | 删除走软删除；每次写留一行审计                                                                       |
| 3.6 | 任务层：`get_task_status` / `cancel_task`                                                                   | 依赖 3.1 的任务注册表（**Phase 1.6 之前先建**）                                                      |
| 3.7 | 设置页「开发者」区块                                                                                        | 开关、状态、已连接客户端、调用历史、重置                                                             |

**Phase 3 出口**：至少一个真实 MCP 客户端连上、查到真实书库、拿到可跳转的原文证据、越权被拒。

### Phase 4 — 插件（后置）

先只做 **配置型**（现有 JSON 书源包成 Provider 实现），再看有没有真实需求做脚本层。详见映射文档 §2。

### Phase 5 — Calibre（成本最高）

只读扫描 → 导入预览 → 导入 → 多格式映射 → 元数据映射 → 导出。**永远不写用户的 `metadata.db`。**

### Phase 6 — AI 工作流

依赖 Phase 3 的工具层。核心是「先预览、再执行」：AI 出计划 → 展示影响范围 → 用户确认 → 执行 → 审计日志 → 报告。

## 2. 关于文档数量的一个决定

迭代要求 §4.4 / §16 列了 6 个审计文档 + 一堆架构文档。**本轮只写了 3 份**：

- `docs/audit/PROJECT_AUDIT.md`（前端 / Rust / 数据库 / 安全 / 测试**作为章节**，不是六个文件）
- `docs/audit/DALIBRE_FEATURE_MAPPING.md`
- `docs/development/IMPLEMENTATION_PLAN.md`（本文件）

理由：一个 3 万行的项目，把同一批事实抄进六个文件，第二天就开始互相矛盾。等某个章节长到读不下去再拆——那时拆是有依据的，现在拆是凭空造目录。

## 3. 风险清单

| 风险                                 | 触发条件                         | 缓解                                                                 |
| ------------------------------------ | -------------------------------- | -------------------------------------------------------------------- |
| 软删除漏改查询，回收站里的书「复活」 | 只改 `list()` 没改统计/书签/同步 | 用 `books_live` 视图，让漏改在测试里炸                               |
| Facets 与列表不一致                  | 两端各写一套过滤谓词             | 桌面与 web 都只有**一处**谓词（`conditions` / `matches`）            |
| MCP 绕开业务层                       | 图省事直接写 SQL                 | 工具只能调 `library/*`；review 时检查 `mcp/` 下有没有 `conn.execute` |
| MCP 变成任意文件读取                 | `import_books` 接受任意路径      | 路径必须落在用户授权目录内                                           |
| 元数据 Provider 违反条款             | 默认开启全部来源                 | 逐个核实 + 默认关闭 + 文档写明限制                                   |
| Calibre 适配破坏原库                 | 图省事复用 calibre 的 schema     | 只读优先；写只写方册自己的目录                                       |
| 大书库变慢                           | 一次取全量 + 每次筛选重算 facets | Phase 1.3 分页；facets 走 SQL `GROUP BY`                             |

## 4. 下一步（等你点头）

1. **Phase 1.2 回收站** —— 数据安全，且是唯一会「悄悄丢东西」的地方。
2. **Phase 3.1 + 3.2 MCP 只读** —— 改动全是加法，零回归风险，也是这次迭代的招牌能力。

两者不冲突，可以并行；但 1.2 涉及 13 个查询点，建议先做它，MCP 才有稳定的数据底座（否则 MCP 会先建在「硬删除」的假设上，回收站一上就得改一遍工具）。
