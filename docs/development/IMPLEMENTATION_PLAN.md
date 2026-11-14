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

**出口验收 ✅（2026-11-13）**：用官方 `@modelcontextprotocol/sdk` 1.32.2 的 `Client` 连真实书库跑通握手 / `tools/list`（5 个，schema 合法）/ `search_books`（真实条目）/ `search_book_content`（`chapterIdx` + `offset`）/ 越权 `remove_books` 被拒。此前只有 `printf | --mcp` 自检——那不做握手、不校验 `protocolVersion`、不发 `notifications/initialized`，不算客户端。逐项结果与可复现脚本见 `docs/mcp/MCP_SETUP.md`。

**没做**：调用日志（3.1 的另一半）、`ask_library` / `export_notes`（3.3）、任务层（3.6）、设置页区块（3.7）。

### Phase 3.4 / 3.5 — 权限层与第一批写工具 ✅

| 层     | 位置                            | 内容                                                                                                                                                    |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 权限   | `mcp.rs::Permission` / `Grants` | 四档：`read` / `search` / `write_metadata` / `delete`；**按连接**从 `FANGCE_MCP_PERMISSIONS` 读，默认 `read,search`；`all` 是简写；未知名字记日志后忽略 |
| 暴露面 | `Server::catalogue`             | 未授予的工具**不出现在 `tools/list` 里**（能看见却调不动的工具，Agent 会一直去调）                                                                      |
| 越权   | `Server::call_tool`             | 返回 `isError` 结果而不是协议错误，正文写明缺哪一档、当前有哪些、配置该写什么（建议值包含缺的那一档）                                                   |
| 写工具 | `mcp.rs`                        | `update_metadata`（读—改—写，只覆盖给出的字段，空串=清空）、`manage_tags`（加/去）、`remove_books`（**移到回收站**，返回 `recoverable: true`）          |
| 审计   | `library::ops`                  | 每次写往 `operations` 表写一行（按书一行）；来源 `ui`/`mcp`；读不留痕。**已从 JSONL 改成数据库表**（见 1.6）                                            |

**为什么权限按连接而不是按应用**：读者可以给一个 Agent 只读、给另一个改元数据的权限，互不影响；而「当前这个连接能做什么」写在客户端配置里，是唯一能被看见的地方。应用级开关只会得到「我记得我关过」这类无法核对的记忆。

**为什么 `search` 和 `read` 分开**：搜一次要扫所有书的正文。「只让它看我点名的那本」和「让它 grep 我整个书库」不是同一个同意。

**证据**：Rust 663 passed（`mcp::` 17 个，新增：默认授予只列五个工具、越权调用给出可执行建议且不改库、单字段更新不动其它字段、空串清空、标签增删、`remove_books` 只进回收站、写留一行审计而读不留、grant 解析）。**真实二进制验证**：默认 `tools/list` 五个工具；`FANGCE_MCP_PERMISSIONS=all` 八个；越权调用真实库返回 `"read,search,delete"` 建议。

**没做**：`suggest_metadata`（依赖 Phase 2 的 Provider）、`import_books`（按路径导入是另一个信任问题：路径必须落在授权目录内）、`export` / `manage_library` 两档权限（随对应工具再加——没有工具支撑的权限名是空话）。

**后来修的一个生产级 bug**：`open_existing` 一开始无条件 `PRAGMA query_only = ON`，于是**所有写工具在生产里都返回 `attempt to write a readonly database`**，而单元测试用的是 `Library::open`（可写），全绿。修法是让句柄的可写性跟着授予走（`open_existing(dir, grants.may_write())`）：只读授予拿到只读句柄（纵深防御），写授予拿到可写句柄（仍不迁移、不 VACUUM）。测试改成**用生产路径开句柄**（`harness` 先 `Library::open` 播种、再用 `open_existing(.., true)` 打开），另加两条：只读句柄拒绝写入、只读授予的句柄在工具层放行时仍然写不进去。

教训：上一轮我验证了「越权被拒」，没验证「授权后能写」——**门锁和门后面的房间是两件事**。

### Phase 1.3 — 分页 ✅（含一次「测完发现不该做」）

| 层   | 位置                     | 内容                                                                                                     |
| ---- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| 查询 | `repository::BookQuery`  | `limit` / `offset`，`None` = 全量；`limit` 夹到 5000                                                     |
| 绑定 | `repository::conditions` | 绑定参数从 `Vec<String>` 改成 `Vec<Value>`——`LIMIT` 是数字，只装得下文本的绑定表会把它当片段格式化进 SQL |
| 计数 | `repository::count`      | 同一套 conditions 走 `COUNT(*)`；分页而不知道总数，等于「20 / 20」和「20 / 985」长得一样                 |
| 工具 | `mcp::search_books`      | 改成 SQL 分页 + 一次加锁里取 count 和 page；新增 `offset` 参数                                           |

**基准**（`bench::shelf_query_bench`，5000 本，release）：

```text
full shelf  (5000 rows): 58.1 ms, 1.41 MB of JSON
page of 20:                0.08 ms
count:                     0.15 ms
```

**结论：书架不分页，工具服务分页。** 旧的 `search_books` 每次要构建 5000 条 summary（含作者、标签两轮附加查询）才能回答 20 条，58 ms / 1.4 MB 全部白花；现在 0.08 ms。

书架则相反：`useShelfWindow` 的窗口、分组和滚动恢复**都按下标索引整份数组**，改成按页取等于给「我在哪」造第二个真相源，还要重写分组与恢复。5000 本 58 ms 在首屏预算里（985 本约 11 ms），所以保持全量，`limit`/`offset` 留在查询层备着——真到一万本，分页的入口已经在了。

**证据**：Rust 666 passed（新增：两页合起来正好覆盖书架不重不漏、count 忽略分页但认筛选、越过末尾是空页不是错误、工具服务的 total 不随页变）。

### Phase 1.4 — 批量元数据编辑 ✅

| 层   | 位置                                   | 内容                                                                                                        |
| ---- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 数据 | `repository::BookFieldsPatch`          | 只有 `publisher` / `language`；`null` = 不改，`""` = 清空                                                   |
| 写入 | `repository::update_fields_many`       | 逐本读—改—写（`update_metadata` 收整份记录），一个事务；`library::set_metadata_fields` 先 `ensure_existing` |
| 命令 | `book.setMetadataMany(ids, patch)`     | 返回写了几本                                                                                                |
| UI   | `BatchMetaDialog` + 批量栏「编辑信息」 | 两个输入框，留空即「不改」；主按钮在两项都空时禁用                                                          |
| 提示 | `useSetMetadataMany`                   | 成功后 toast「已改 N 本的出版社」——书架卡片不显示出版社，没有这句话，三十本的编辑看起来跟什么都没发生一样   |

**偏离计划的地方（有意）**：计划里写的是「作者 / 出版社 / 语言」，实际只做了后两个。作者的批量编辑是**整份覆盖**——给 50 本设成同一个作者，通常不是读者想要的，而误操作一次就是 50 本书的作者没了。要做得对，需要「追加/替换」两种语义 + 明确的确认文案，那是另一个功能。计划里的「改前预览影响范围」由弹窗标题里的「修改选中的 N 本书」承担：批量编辑的影响范围就是选中数量，不需要第二套预览。

**证据**：Rust 669 passed（新增 3：只改点名的字段、空串清空且不动别的、空 patch 报错而不是无声无息）；e2e `shelf-batch-meta` 在**浏览器端**（IndexedDB 实现是另一份代码）跑完整往返——填出版社 → 断言两本都改了且语言没被动 → 再只填语言 → 断言出版社没被抹掉。双引擎通过。前端 1180 passed。

### Phase 1.6 — 操作日志 ✅

| 层   | 位置                                | 内容                                                                                                                 |
| ---- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 数据 | 迁移 23 `operations`                | `at` / `source`（`ui`｜`mcp`）/ `action` / `book_id` / `book_title` / `summary` / `detail`；索引在 `at` 和 `book_id` |
| 写入 | `library::ops::record`              | **按书一行**；UI 侧 9 个写命令 + MCP 侧 3 个写工具                                                                   |
| 读取 | `ops.list(limit)` + `useOperations` | 设置 › 操作记录，最新在上，MCP 行带徽标                                                                              |

**三个刻意的决定：**

1. **不建外键。** 日志里最重要的一行是「《三体》被彻底删除」，级联会把它连书一起删掉。`book_title` 是抄下来的，purge 之后没有东西可以 join。
2. **按书一行，不是按调用一行。** 这张表要回答的是「这本书经历了什么」，一次调用存成一行就得先拆开才能回答。批量改三十本写三十行，它们共享同一个 `at` 和 `summary`，所以那次调用仍然看得出来是一次。
3. **审计从 JSONL 搬进了数据库。** 原来 MCP 往数据目录追加 `mcp-audit.jsonl`——应用读不到、join 不了书、也看不到是哪个 Agent。现在两侧写同一张表，设置页直接读。

**为什么是设置 › 操作记录**：它和「备份」「重置」是同一类东西——对书库本身做了什么。放到书架或统计页会让人以为它是阅读数据。

**证据**：Rust 676 passed（新增 4：一批两本写两行且共享时间戳、purge 的日志活得比书久、空批量不写、最新在上）。前端 1180 passed、tsc / oxlint / prettier / build 干净。截图核对过设置页那一栏（第一版正文没有 `px-5`，文字跑到卡片外面去了）。

### Phase 1.6b — 撤销 ✅

| 层   | 内容                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------- |
| 记录 | 元数据写入在 `detail` 里存 before 镜像（`publisher` / `language` 两个字段，不是整行拷贝）                |
| 分组 | 每次 `record` 生成一个 `call_id`；一批三十本是三十行、一个调用                                           |
| 撤销 | `ops.undo(call_id)`：把 before 写回，一个事务；写一行 `action='undo'` 的标记，列表据此不再提供第二次撤销 |
| UI   | 操作记录按 `call_id` 分组，一组一行；可撤销的才出现「撤销」按钮                                          |

**几个判断：**

- **before 只存能改的两个字段，不是整行拷贝。** 整行拷贝是第二份真相，迟早和第一份吵架。
- **`None` 与 `""` 的转换在撤销这一侧**：`BookFieldsPatch` 里 `None` = 不改，所以「原本没有出版社」必须还原成 `Some("")`（清空），否则撤销会把空字段留成原样。
- **一本书被彻底删掉时跳过而不是报错**：调用里其余的书仍然值得还原，返回 `{undone, skipped}` 让 UI 说清楚。
- **一组里只要有一本不可撤销，整组就不给撤销按钮**：半还原的批量比诚实地说明「这次撤不回」更糟。
- **撤销本身也写日志**（`action='undo'`，同 `call_id`），但**不进列表**——一个显示「撤销了一次撤销」的日志没人会读。

**证据**：Rust 681 passed（新增 5：撤销写回旧值、原本为空的字段撤销后仍为空、撤销过的调用不再可撤销、没有 before 的行不可撤销、书已被删时跳过不致命）；前端 1183 passed（新增 3：一组折叠成一行、不同调用不合并、一本不可撤销则整组不可撤销）。

### Phase 5.1 — Calibre 只读扫描 ✅（2026-11-13）

Phase 4/5/6 一直全空，这一刀开在提示词 Phase 5 的第 1 步。边界只有一句话：**Calibre 的 `metadata.db` 归 Calibre，方册一个字节都不写。**

| 层          | 文件                                  | 内容                                                                                                     |
| ----------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 服务        | `library/io/calibre.rs`               | `scan(root)` → 书列表（id / 标题 / 作者 / 格式 / 相对路径）+ `warnings`；只读打开，绝不设 `journal_mode` |
| schema 校验 | 同上                                  | `PRAGMA table_info` 只检查**实际要读的列**（四张表、九个列），不硬编码 Calibre 整张表                    |
| 命令        | `commands/calibre.rs` + `lib.rs` 两处 | `calibre.scan(path)`；`bindings.ts` 由 `export_bindings` 生成                                            |
| 异常        | 同上                                  | 目录不存在 / 没有 `metadata.db` / 不是 Calibre 库（点名缺哪张表哪列）/ 坏行，各自有可读结论              |

🔴 **只读是两道锁**：`SQLITE_OPEN_READ_ONLY` 管文件句柄，`PRAGMA query_only = ON` 管语句。`journal_mode` 刻意不设——设置它本身就是一次写。测试钉住三件事：句柄拒绝 INSERT、扫描前后目录文件集合不变（没有 `-wal` / `-shm` 冒出来）、`metadata.db` 长度不变。

🔴 **`books.path` 来自别人写的数据库，不是权限**：绝对路径 / `..` 越界一律清空并记 warning。5.1 从不把 path 拼进文件系统路径；5.2 真要读文件前必须重新校验。

**证据**：Rust **766 passed**（新增 7 条：识别、不写库、句柄拒写、无 `metadata.db`、非 Calibre 库点名缺表、坏行不中断、目录缺失）；clippy `-D warnings` / fmt / prettier / tsc / oxlint（458 文件 0 warning）/ vite build 全绿。

**明确未做（5.2 起）**：导入预览 UI、书籍导入、多格式与元数据映射、`data.name` 拼出文件真实路径、浏览器端入口（需要文件系统，按 `DuplicateDialog` 的先例只在桌面版可用）。**5.1 只有后端、暂时没有调用者**，这是刻意的切片边界，不是「只有接口没有实现」——它真的读了 SQLite。

⚠️ **验收缺口（不假装完成）**：本机没有 Calibre 书库，GitHub raw 在当前环境不通，所以夹具是**按 Calibre 常见四表结构手造的 `metadata.db`**，**没有拿 calibre 自己生成的真库验过**。提示词「能识别真实 Calibre 书库」这一条仍待读者拿真库点一次。schema 只校验用到的列，正是为了把版本差异变成明确错误而不是崩溃。

### Phase 5.2 — Calibre 预览入口 ✅（2026-11-13 下午）

5.1 的后端没有任何调用者，这一片把入口与只读报告接上：**选目录 → 扫描 → 看清识别结果**，仍然不导入。

| 层       | 文件                                                     | 内容                                                                                                        |
| -------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 对话框   | `features/library/CalibreDialog.tsx`                     | 目录选择 + `useQuery(["calibre-scan", root])` 调 `ipc.calibreScan`；展示书数、格式分布、warnings、前 100 本 |
| 入口     | `ShelfHeader.tsx` 图标按钮 + `LibraryPage.tsx` lazy 挂载 | 与「导入摘录 / 在线找书 / 导入书籍」同一组——回答的是「书从哪来」                                            |
| 浏览器端 | 同 `DuplicateDialog` 的先例                              | `enabled: open && isDesktopRuntime`；不返回空列表骗人，直接写「只在桌面版可用」                             |
| 边界     | 对话框描述 + 没有导入按钮                                | 明说「导入能力在下一步开放」；单测钉住没有导入动作                                                          |

🔴 **入口放在 `ShelfHeader` 而不是 `ShelfToolbar`**：工具栏是被 `shelf-reflow.spec.ts` 精确量过的七控件布局，加一个控件就得把所有宽度重新量一遍；标题栏的按钮组本来就是 `flex-wrap`，而且「从外部书库拿书」和「导入书籍」是同一个问题。这是保守选择，**不是**「放工具栏会坏」的结论。

🔴 **量 flex 行别按 `top` 分行**：工具栏是 `items-center`，同一行里不同高度的子元素 `top` 本来就不等。第一版 e2e 按 `getBoundingClientRect().top` 数行，把新按钮回退掉之后**仍然报三行**——是测量方法错了，不是布局坏了。垂直中心（`top + height / 2`）才是行标识。教训写在 `e2e/calibre-scan.spec.ts` 注释里。

**证据**：`CalibreDialog.test.tsx` 6 passed（浏览器闸门、扫描结果、无导入按钮、后端错误、取消选择、空库）；`e2e/calibre-scan.spec.ts` + `shelf-reflow.spec.ts` 双引擎 **8 passed**；prettier / tsc / oxlint（461 文件 0 warning）/ vite build 全绿。

⚠️ **真库验收缺口仍在**：本机没有 Calibre 库，GitHub raw 与 jsdelivr 在当前环境都不通（curl `HTTP 000` / WebFetch 失败），夹具仍是手造的 `metadata.db`。这个入口的真实用途之一就是让读者拿真库点一次；在点上之前，「能识别真实 Calibre 书库」不算过。

**明确未做（5.3 起）**：导入按钮与选择、拼出文件真实路径（`data.name`）、多格式映射、元数据映射、导出。

### Phase 5.3 — 书籍导入 ✅（2026-11-13 傍晚）

5.2 的报告能看不能导，这一片接上现成的 `book.import` 管线，**不新增导入命令**。

| 层       | 文件                                 | 内容                                                                                                         |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 文件发现 | `library/io/calibre.rs`              | 从书籍目录列真实文件，用 `BookFormat::from_path` 过滤，按 EPUB 优先排序；`CalibreBook.files` 返回绝对路径    |
| 路径安全 | 同上                                 | 字符串校验之外，目录与每个文件都 `canonicalize`，必须仍在 canonical root 内；`symlink_metadata` 拒绝符号链接 |
| 命令     | `commands/calibre.rs`                | 改 `async` + `spawn_blocking`：一本一次 `read_dir`，几千本不能压在 UI 线程                                   |
| 前端     | `features/library/CalibreDialog.tsx` | 勾选 → `useImportBooks()` → `bookImport(paths, null)`；结果汇总 + 失败逐条；成功后清选择，整批失败不静默     |
| 浏览器端 | 同前                                 | 不渲染目录选择，也不渲染导入按钮                                                                             |

🔴 **一本书只导一个文件**：Calibre 一本书常同时有 EPUB 和 AZW3，两个文件字节不同，`import_files` 的 hash 判重看不见，全导就会让同一本小说在书架上出现两次。Rust 按 `epub → pdf → azw3 → …` 排序，前端只取 `files[0]`，UI 里写明「另有 N 个格式」。这是明确的取舍，格式选择器以后再加。

🔴 **不用 `data.name` 猜文件名**：命名规则跨 Calibre 版本会变，而且数据库里的字符串不是文件系统事实。直接列目录、认扩展名、检查文件存在——存在的才是能导入的。

**证据**：Rust **769 passed**（Calibre 模块 10 条，新增：只认支持的格式 / EPUB 优先、符号链接目录越界被挡、符号链接文件不返回）；`CalibreDialog.test.tsx` **11 passed**（含「每本只传一个路径」「无真实文件不可选」「整批失败有提示」「成功后清选择」）；书库 vitest 子集 **116 passed**；双引擎 e2e **8 passed**；prettier / tsc / oxlint（461 文件 0 warning）/ vite build / clippy / fmt 全绿。

**明确未做**：格式选择器（想导 AZW3 而不是 EPUB）、列表仍只显示前 100 本且选择范围也只在这 100 本（大库要分批）、导入进度条（`book://import-progress` 事件已有但对话框没接）、元数据映射（作者 / 系列 / 标签 / 评分没跟着过来）、导出、增量同步。

### Phase 5.3b — 大库可用性：筛选 / 分页 / 进度 ✅（2026-11-13 傍晚）

5.3 把导入接通了，但列表和选择都卡在前 100 本，一千五百本的库只能分批点；导入时也没有进度。这一片补掉两个缺口，**仍在同一个对话框里，后端一行没动**。

| 层   | 内容                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 筛选 | 按书名 / 作者过滤，改变时把页码归零                                                                                           |
| 分页 | 每页 100 本，「上一页 / 下一页」+「第 X / Y 页 · 筛选结果 N 本」；控件放在滚动区外，翻页不会把它滚走                          |
| 选择 | `Set<number>` 跨页保留；「全选」作用于**当前筛选结果的全部**可导入书而不只是当前页；导入按钮始终写明选中的本数                |
| 进度 | 复用现成的 `onImportProgress` + `useTauriEvent`，显示 `done / total`；用 ref 闸住，只在自己这批导入在跑时计数（事件是全局的） |

🔴 **不搞虚拟列表**：一百行够读也够点，翻页比为 640px 弹窗引入窗口化 hook 便宜得多。`useShelfWindow` 是给书架网格的，不是给这个列表的。

**证据**：`CalibreDialog.test.tsx` **15 passed**（新增：筛选、分页与跨页保留、全选覆盖整个筛选结果、进度只在自己批次内计数）；书库 vitest 子集全绿；prettier / tsc / oxlint（461 文件 0 warning）/ vite build / 双引擎 e2e 8 passed。Rust 本轮没改，769 passed 是上一片的结果。

**仍未做**：格式选择器、元数据映射、导出、增量同步；**真库验收仍缺**。

### Phase 5.3c — 格式偏好 ✅（2026-11-13 傍晚）

5.3 把「一本书一个格式」固定成 EPUB 优先，读者想导 AZW3 就没办法。这一片加整批生效的优先格式，**后端一行没动**：Rust 的 `files` 本来就带格式且排好序。

| 层   | 内容                                                                                          |
| ---- | --------------------------------------------------------------------------------------------- |
| 下拉 | 选项从扫描结果里**实际出现的格式**聚合，不列库里没有的格式；默认「自动（EPUB 优先）」         |
| 解析 | `fileFor(book)` 先找偏好格式，找不到回退到 `files[0]`；导入路径与行内显示的格式都走这一个函数 |
| 回退 | 统计「可导入的书里有 N 本没有 X」，写在选择栏下方——不说这句，读者会以为整批都是 X             |
| 换库 | 重选目录时把偏好复位，免得上一个库的设置悄悄带到下一个                                        |

🔴 **不做逐本格式选择**：几百本逐个下拉没人会用，「整批偏好 + 少数回退」已经覆盖真实场景；等出现「就这一本要另一个格式」的需求再说。

**证据**：`CalibreDialog.test.tsx` **18 passed**（新增：只列实际存在的格式、切换偏好后导入路径改变、回退统计且回退到各自首个格式）；书库 vitest 子集 14 文件全绿；prettier / tsc / oxlint（461 文件 0 warning）/ vite build / 双引擎 e2e 8 passed。

**仍未做**：元数据映射、导出、增量同步；**真库验收仍缺**。

### Phase 5.4 — 扩展元数据：只读探测 ✅（2026-11-14）

5.3c 之后剩下的实质工作是元数据映射，但那是本轮**第一次把外部数据写进方册的库**。拿手造夹具猜字段语义再写进去不可靠，所以这一片只做不写库的一半：把 Calibre 的扩展字段读出来，并在预览里如实报告「这个库有哪些字段、读到什么值」——读者拿真库点一次时能同时验识别结果与字段覆盖。

| 层   | 内容                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust | `library/io/calibre.rs::read_optional()` **逐字段独立探测** ISBN / 出版日期 / 出版社 / 标签 / 系列 / 评分 / 语言 / 简介；每张可选表各自判断，缺表缺列只跳过，不让整个扫描失败 |
| 结果 | `CalibreBook.metadata`（8 个可选值）+ `CalibreScan.metadataFields`（这个库实际暴露的字段标签）；`comments.text` 截 200 字；INTEGER 评分按文本读，不因类型不符丢掉             |
| 前端 | 报告区显示「读到 X、没有 Y（表或列名不同，已跳过）」；书名 tooltip 带真实值（ISBN / 系列 / 评分 / 标签…），真库验收时能直接看数值对不对                                       |
| 边界 | 🔴 扫描本身只预览、**一个字节都不写进方册**；落库是随后独立的写入半（5.4d），由读者在导入时勾选                                                                               |

🔴 **不用固定 schema**：可选表跨版本会被裁剪，硬编码等于把夹具的假设当成事实；逐字段探测让版本差异变成一个能带回来的诊断结论，而不是扫描失败。

**证据**：Rust **772 passed**（新增 3 条：可选表齐全、完全没有可选表仍是有效库、`comments` 里塞 BLOB 只损失该字段）；`CalibreDialog.test.tsx` **21 passed**（新增 3 条）；clippy / fmt 干净。

### Phase 5.4b — 用 Calibre 官方 schema 校准 ✅（2026-11-14）

读者指出本轮借鉴的 [dalibre](https://github.com/djyde/dalibre) 可以直接参考。`git clone` 通了（此前只试 `curl` 拉 raw 文件，失败就误判「GitHub 不通」），仓库里 `internal/calibre/metadata_sqlite.sql` 是 **Calibre 自己的建库 SQL**（`user_version 28`，39 表 / 40 触发器 / 11 视图，GPL-3.0），`cmd/seed/` 还能生成示例库。我们自己的 `docs/audit/DALIBRE_FEATURE_MAPPING.md` 第 66 行早就点名了这个文件。

🔴 **查出并修掉一个真 bug**：真实 `books` 表**没有 `isbn` 列**，ISBN 在 `identifiers(book, type, val)`；5.4 的探针却查 `SELECT id, isbn FROM books`。手造夹具给 `books` 加了这列，把「真库上 ISBN 永远显示没有」掩盖了两轮。现改为 `SELECT book, val FROM identifiers WHERE lower(type) = 'isbn'`；夹具的 `books` 去掉臆造列、补上 `identifiers` / `languages`，其余 join（ratings / languages / publishers / tags / series / comments）与官方列名逐条对齐。另修一处显示：真实 `comments.text` 是 HTML，预览 tooltip 现在剥标签、折空白后再截 200 字。

**验证**（一次性、不进仓库）：用官方 SQL 在 `/tmp` 生成库（drop triggers——Calibre 的触发器依赖应用注册的 `title_sort` / `uuid4`），设 `user_version 28`，插入 2 本书与全套关联表，按 Calibre 命名规则建 `作者/书名 (id)/书名 - 作者.epub` 目录。挂临时探针调 `scan()`：**识别 2 本、8 个扩展字段全到**、ISBN `9787536692930`、评分 `8`、语言 `zho`、文件路径 EPUB 优先且滤掉 `cover.jpg` / `metadata.opf`、warnings 空；探针跑完删除。🔴 **SQL 文件没有搬进仓库**（AGPL 项目不引入 GPL 文件；校准只取列名），所以这一步不可回归——可回归的是对齐官方列名的 Rust 夹具。

**证据**：Rust **773 passed**（新增「非 ISBN 标识符不算 ISBN」；夹具改官方列名并断言 8 字段全到、简介去 HTML）/ clippy / fmt；`CalibreDialog.test.tsx` 21 passed；prettier / tsc / oxlint / vite build / 双引擎 e2e 8 passed。

**仍未做**：5.4 写入半、导出、增量同步；**Calibre 桌面应用生成的真库**仍待读者点一次（自定义列、OPF、真实数据分布是官方 schema 库没有的）。

### Phase 5.4c — 没有真库也能自验 ✅（2026-11-14）

读者手上没有 Calibre 书库。把「真库验收」从**阻塞前置**降级为**可选补充**：`scripts/generate-calibre-sample.py` 一键生成 Calibre 兼容库。

| 项     | 内容                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| schema | 运行时从 dalibre `git clone` 取 Calibre 自己的 `metadata_sqlite.sql`（`user_version 28`，39 表 / 40 触发器），缓存到 `~/.cache/fangce/`；无网络时用列名对齐的离线 DDL。🔴 GPL-3.0 的 SQL **不进仓库**（方册 AGPL） |
| 数据   | 5 本书：EPUB+AZW3、单 EPUB、PDF、越界 `path`、缺目录；多作者、大写 `ISBN` 标识符、HTML 简介、自定义列 `custom_column_1`、额外表                                                                                    |
| 文件   | 按 Calibre 命名规则建 `作者/书名 (id)/书名 - 作者.ext`；EPUB 是**最小合法 EPUB**（`zipfile` 生成），其余格式为占位字节（演示失败文案）；另有 `cover.jpg` 与 `metadata.opf`                                         |
| 使用   | `python3 scripts/generate-calibre-sample.py [输出目录]`，默认 `~/Downloads/fangce-calibre-sample`；目标非空则**拒绝覆盖**                                                                                          |

**实测**（临时探针调 `scan()`，跑完删除）：识别 5 本、8 个扩展字段全到；`三体` 2 个文件、`红楼梦` 多作者 `["曹雪芹","高鹗"]`、大写 `ISBN` 读到、HTML 简介剥成纯文本；3 条预期 warning（缺 `data` 记录 / path 越界 / 2 本找不到文件），**没有一条让扫描失败**。

**把真库才有的形状固化成可回归测试**：新增 `extra_tables_and_custom_columns_do_not_break_the_scan`（额外表与自定义列不打断）与 `identifier_type_case_does_not_hide_isbn`。

**证据**：Rust **775 passed**（+2）/ clippy / fmt；prettier / tsc / oxlint；`CalibreDialog.test.tsx` 21 passed；vite build / 双引擎 e2e 8 passed；脚本 `ast.parse` 通过。

**验收结论**：现在能说「按 Calibre 官方 schema 与目录规则生成的库，识别、字段、路径、可导入文件都已验证」。🔴 **自验不了的只剩两条**：Calibre 桌面应用正在运行时并发打开同一个库（只读句柄 + `busy_timeout=3000` + 明确报错），以及 GUI 产出的库里真实数据分布；都不是阻塞项。**EPUB 导入本身未实测**（脚本只保证文件结构合法）。5.4 写入半的前置已满足。

### Phase 5.4d — 扩展元数据：写入半 ✅（2026-11-14）

本轮**第一次把外部数据写进方册自己的库**。链路不碰 `metadata.db`：`book.import` 回一条带 `path` 的 outcome，前端按它把扫描结果里的 `CalibreBook` 配回新书 id，再调 `calibre.applyMetadata`；Rust 在**一个事务**里写字段与标签、留操作日志。

| 层     | 内容                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新模块 | `library/io/calibre_fill.rs`：`CalibreFill` / `CalibreApplyResult`、`apply(tx, fills)`、字段映射与三个纯函数                                                                                              |
| 命令   | `commands/calibre.rs::calibre_apply_metadata`（同步 `with_tx`，与 `metadata.apply` 同形）；注册到运行时与 `export_bindings`                                                                               |
| 映射   | `publisher` / `isbn` / `description` / `language` / `published_year` / `authors` / `tags` → 方册字段；`pubdate` 取前四位年份（挡掉 Calibre 的 `0101-01-01` 占位），`lang_code` 走 ISO 639-2 → 短码小表    |
| 策略   | 🔴 **只填空**：`update_metadata` 收整份记录，所以每个字段都从现有行 carry-through + `.or_else(calibre_value)`。读者改过的值、目录补全的评分、`Duplicate` 的书都不会被覆盖                                 |
| 标签   | `tags::assign` 只加不删；超 40 字的名字**先按同一个上限过滤并计数**，否则一个坏标签会让整批事务回滚                                                                                                       |
| 日志   | 字段写走 `ops::record_before`（带 before-image、可撤销）；标签走 `ops::record`（与手动 `book.setTags` 一致，**不可一键撤销**）。两条分开，是因为一条覆盖两者的 `record_before` 会给出撤不回标签的撤销按钮 |
| 前端   | 对话框加 opt-in 开关（默认开、可关）、按 outcome 配对、结果/错误单独展示、后置 invalidate `books` / `tags` / `operations`；tooltip 简介截到 200 字，**数据保持完整**                                      |

🔴 **顺带修的一个真 bug**：扫描原先 `comments.text` 截 200 字（给 tooltip 用），写入半若直接复用就会把 200 字残篇写进简介。现在扫描截到方册编辑表的上限 4000 字，截断只在 tooltip 做，并有测试钉住「传给后端的是完整值」。

🔴 **另一个真 bug**：`ops::Before` 原先不记 `authors`，而 `update_metadata` 是**整份替换作者列表**的 —— 写入半补作者后，「撤销」会还原九个字段却留下第十个，还说「撤销了 1 本」。给 before-image 加 `authors`（v3 的可选 key，老行缺 key 时保持当前列表），新增向后兼容测试。

**偏离路线图的地方（有意）**：§1 原来写「把作者 / **系列** / 标签 / **评分**带进方册」，实际只落作者与标签，另外补了出版社 / ISBN / 简介 / 语言 / 出版年。理由是语义，不是遗漏：方册没有 series 列，塞进 `subtitle` 或 `description` 是在撒谎；Calibre 的 `rating` 是读者自己的 0–10 星，方册的 `rating` 是带 `rating_source` / `rating_count` 的目录社区评分，写 `8` 进去会在 UI 写着「豆瓣评分」的位置显示一个来路不明的数字。两者仍留在扫描预览里可见。

**证据**：Rust **784 passed**（775 → 784，新增 9：只填空、二次导入不覆盖已有值、标签只加不删、超长标签只计数、不存在的书与空批次跳过、pubdate 解析、语言码透传、撤销把作者也还原、老 v3 行缺 `authors` 仍可撤销）/ clippy `-D warnings` / fmt；`CalibreDialog.test.tsx` **29 passed**（21 → 29，新增 8：按 path 配对、关开关不写、失败路径排除而 duplicate 照写、偏好格式的路径、写入失败仍报导入成功、结果与跳数、整批导入失败不写、tooltip 截断而数据完整）；书库 vitest 子集 **14 文件 135 passed**；prettier / `tsc --noEmit` / oxlint（461 文件 0 warning）/ `vite build --no-emptyOutDir` / 双引擎 e2e **8 passed**。

**真机往返 ✅（2026-11-14 17:06，桌面版实际点完）**：选 `~/Downloads/fangce-calibre-sample` → 全选 3 本 → 导入，界面报「3 本已导入 · 已补全 3 本 · 加了 2 本的标签」。只读核对生产库 `library.sqlite3`：三体拿到出版社 / ISBN / 出版年 2006 / 简介 / 两个标签；活着拿到 ISBN / 出版年 1993；红楼梦（7 字节占位 PDF，**文件内零元数据**）拿到出版年 1791 / 语言 `zh`（`zho` 映射生效）/ 简介 / 多作者 `["曹雪芹","高鹗"]` / 标签「古典」——**这一本身上每个字段都来自 Calibre**，是最干净的证据。`tagged=2` 是因为示例库只给 book 1 与 book 3 配了标签。操作日志正好是设计里的两条：3 行 `calibre_metadata` 带 before-image（可撤销）+ 2 行 `calibre_tags` 无 before-image（不可撤销），同一次调用。

🔴 **实测修正了一个预测**：曾以为占位 PDF 会导入失败，实际 3 本全成功。`document/pdf.rs::read_metadata` 对解析失败**静默降级**为 `BookMetadata::default()` 并用文件名当书名，导入器因此建了一本空书。这是既有设计（扫描版 PDF 常无 Info 字典），不是 5.4d 引入的；但「损坏 PDF 会静默进书架」值得单列评估，本轮不动。**两个最小 EPUB 导入实测通过**，此前「EPUB 导入未实测」的盲区已消除。

**仍未做**：全量 vitest（写下这段时只跑书库子集；5.5 阶段已补跑全量，见下一段）。

### Phase 5.5 — 书单导出 + 增量同步评估 ✅（2026-11-14）

总控提示词对第 6、7 步只写了「导出」「增量同步评估」两个词，没给格式与方向。**先把边界定死再动手**：

- 方册不是 Calibre 客户端。`docs/audit/DALIBRE_FEATURE_MAPPING.md` 的硬约束是绝不改用户原始书库；「把书导进 Calibre」要么走 `calibredb` / 复制书文件，要么写 `metadata.db`，后者直接违规，前者是另一条产品线（格式、目录布局、去重、封面、并发锁），不是一次「导出」能顺手带出来的。
- 因此这一刀只回答「应用不在了，我还能看到我有哪些书」：**导出方册自己的书单 CSV**，单向、纯文本、不复制书文件、不写 OPF、不碰任何外部库。它和整库备份不是一回事（备份能恢复，清单不能），设置页 hint 明说。

| 层       | 内容                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新模块   | `library/io/catalog.rs`：`export(&Library, &Path) -> usize` + 纯函数 `render`；只查 `books_live`（回收站不算在架），按书名字典序                                                                   |
| 命令     | `commands/export.rs::library_export_catalog`（`spawn_blocking` 写盘），运行时与 `export_bindings` 两处注册                                                                                         |
| 列       | 书名 / 作者 / 副标题 / ISBN / 出版社 / 出版年 / 语言 / 标签 / 格式 / 阅读进度(%) / 收藏 / 添加日期 / 最近阅读 / 书籍ID；BOM + UTF-8，作者与标签用「、」连接                                        |
| 前端     | 设置 › 备份区新增独立 `CatalogExportRow`（桌面版可见、保存面板选 `.csv`、显示导出本数），`hooks/useCatalogExport.ts`；浏览器构建没有这条命令，直接不渲染该行                                       |
| 安全     | 复用 `export::csv_field`，另在书单侧挡 CSV 公式注入（`=` `+` `-` `@`、tab/CR 开头前缀单引号）。🔴 **不把防护塞进 `csv_field`**：notes CSV 会被 `clippings::parse_csv` 读回，多一个字符就会改掉原文 |
| 有意不导 | `rating`（目录社区评分，与 Calibre 的读者星级语义不同，5.4d 也没写）、`description`（属于全文/笔记导出，不是书单）、绝对路径（不把用户目录结构外泄）                                               |

**增量同步评估结论：不做。** 四条理由：① `book.import` 已按 `content_hash` 判重，重复扫同一个库只会得到 `Duplicate`，「别重复导入」这个最实际的收益已经天然满足；② 真正的双向同步需要稳定的外部 id 映射、`updated_at` 对齐、删除传播和「谁赢」的冲突策略，这些规则总控提示词一个都没给，猜一套出来比不做更危险；③ `metadata.db` 是别人的库，「只读两道锁」是本轮全部能力的前提，增量写会推翻它；④ Calibre 桌面端可能正持有同一个库的写锁，并发语义没用真库验过。已有的 WebDAV `sync` 同步的是方册自己的进度 / 标注 / 书签，与此正交。将来若真要做，最小前置是「一张外部 id → 方册 id 的映射表 + 只增不删 + 显式冲突策略 + `metadata.db` 永远只读」，且必须先用真库验并发。

**范围之外（如实标注）**：这不是 Calibre 的导入文件，也不能把方册的书搬进 Calibre。「导出到 Calibre」若成为需求，是一个独立特性，不在 Phase 5 的最小切片里。

**证据**：Rust **793 passed**（784 → 793，新增 9：表头 / BOM、列顺序、空值不编造、CSV 转义、公式注入、进度钳制、空库、真实库一行且排除回收站、未知扩展名拒绝）/ clippy `-D warnings` / fmt；`CatalogExportRow.test.tsx` **8 passed**（桌面显示、浏览器不渲染、路径与过滤、0 本、取消、面板拒绝、写失败、pending 禁用）；prettier / `tsc --noEmit` / oxlint（464 文件 0 warning）/ `vite build --no-emptyOutDir`；全量 vitest 与 e2e 见 §4 的校验记录。

## 1. 路线图

顺序与迭代要求 §14 一致（书库 → 元数据 → MCP → 插件 → Calibre → AI 工作流），但**每阶段内部按「先数据安全、再能力」排**。

### Phase 1（续）— 书库管理收口

| #   | 切片                      | 为什么现在                                                           | 验收                                                                                                                             |
| --- | ------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1.2 | **回收站（软删除）** ✅   | 当前删除不可逆，笔记/标注/进度一起没。这是数据安全问题，不是功能问题 | 迁移 22 加 `deleted_at` + `books_live` 视图；读路径全走视图；恢复/彻底删除两个命令；e2e 覆盖「删→恢复→笔记还在」                 |
| 1.3 | **分页** **✅**           | `book_list` 返回全量，几千本时首屏和分组都会卡                       | `BookQuery` 加 `limit`/`offset` + `repository::count`；工具服务按页取；书架仍取全量（见 §0 的数字）                              |
| 1.4 | **批量元数据编辑** **✅** | 批量栏现在只能收藏/标签/删除                                         | `BookFieldsPatch`（出版社/语言，`null`=不改、`""`=清空）+ `update_fields_many` + 批量栏「编辑信息」；**作者不在批量里**（见 §0） |
| 1.5 | **重复检测** ✅           | SHA256 已在导入时拦住完全一致；剩下 ISBN / 标题精确相等              | 只读报告 + 放大镜跳回书架，**不做自动合并**；「切副标题」在真实库被证伪，见 §0                                                   |
| 1.6 | **操作日志** **✅**       | 1.4 的撤销依赖它                                                     | 迁移 23 `operations` 表（时间/来源/动作/书/一句话）；UI 与 MCP 两侧都写；设置 › 操作记录可读                                     |

**Phase 1 出口**：删书能撤回；批量改元数据能看改动；5000 本书首屏 < 300ms。

### Phase 2.1 — 一个元数据来源（**NeoDB**）✅

> 第一版接的是 Open Library，**换掉了**。原因见下，这是本轮最重要的一条。

| 层   | 位置                   | 内容                                                                                          |
| ---- | ---------------------- | --------------------------------------------------------------------------------------------- |
| 解析 | `library/metadata.rs`  | `parse` 纯函数：`/api/catalog/search` → `Candidate`；`similarity` 三元组重合度打分            |
| 请求 | 同上                   | `search(client, base, lookup)`；UA、12 s 超时、`category=book`                                |
| 命令 | `commands/metadata.rs` | `metadata.search(id)`——先读书再发请求，**不把数据库锁跨过 await**                             |
| UI   | `BookMetaDialog`       | 「从 NeoDB 查找」→ 候选列表（标题·作者·年份·出版社·匹配度）→ 点一条填进表单，**仍然要按保存** |

**为什么换来源（用户实测报的 bug）。** Open Library 的索引几乎只有英文书：《人类简史》《未来简史》《维特根斯坦》全部 `numFound: 0`。**一个看不见书架上这些书的来源，比没有来源更糟**——它会一本正经地回答「没找到」。我上一轮拿《三体》验证过就以为通了，样本量是一。

NeoDB 是 dalibre 用的那个联邦书目库，中文覆盖真实存在，而且**返回的是版次不是作品**——顺带解决了 Open Library 那个「出版社/语言是所有版次的并集」的坑。

**三个字段上的判断：**

1. **`query` 只放书名，不放作者。** NeoDB 的 `query` 是文本检索，作者拼写和 EPUB 里常不一样（`[以色列] 尤瓦尔·赫拉利` vs `尤瓦尔·赫拉利`），拼进去会把记录筛掉。作者只用来**排序**，那是这一侧能控制的比较。
2. **`publisher` / `language` 取数组第一个**——每条记录是一个版次，第一个就是这本书的值。
3. **失败不再吞成「没找到」**（`propose_failed`）：网络挂了和目录里没有是两件事，把前者报成后者会让人去换书名。

### Phase 2.1b — 字段扩展与「补全真的补全」✅

用户实测报的两件事：**补全只填了出版社和语言**（副标题、简介明明在响应里），**表里没有 ISBN / 出版年 / 添加日期**。

| 层      | 内容                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 迁移 24 | `books.isbn`、`books.published_year`——ISBN 单独一列，不复用 `identifier`（那一列是文件自己声称的标识，有时是 ISBN，有时是转换器编的 UUID） |
| 候选    | `Candidate` 增加 `subtitle` / `description`；`brief` 优先，回退 `description`                                                              |
| 补全    | `fills` 从 2 个字段扩到 6 个：副标题、出版社、语言、ISBN、出版年、简介（**顺序就是表单从上到下的顺序**）                                   |
| 简介    | 目录的简介动辄上千字（《人类简史》是一整页营销文案），按 4000 字上限、在换行处截断                                                         |
| 表单    | 出版年 / ISBN 两个可编辑字段；**添加日期只读**——它是「这本书什么时候进的库」，不是关于书的事实                                             |

**作者国家：没做，也不打算做成独立字段。** NeoDB 把国籍写在作者名里（`[以色列] 尤瓦尔·赫拉利`、`[印] 阿比吉特·班纳吉`），作者栏已经原样显示它。单开一列需要一个权威的国家来源，而现在只有这个方括号——按它拆分会把 `[美]` 这种标记从名字里切掉、再存进一个可能错的字段。**看得见的信息不该被复制成第二个可能不一致的字段。**

**证据**：Rust 698 passed（`metadata::` 17 个，新增：六个字段按表单顺序给出、长简介在换行处截断、短简介不动）；前端 1183 passed。截图核对过表单（第一版「添加于 1970/01/01」是演示数据 `addedAt: 0`，已改成真实日期）。

### Phase 2.1c — 评分与豆瓣链接 ✅

| 层      | 内容                                                                                         |
| ------- | -------------------------------------------------------------------------------------------- |
| 迁移 25 | `books.rating` / `rating_count` / `douban_url`                                               |
| 解析    | `rating`、`rating_count` 直接取；`douban_url` 从 `external_resources` 里找 `book.douban.com` |
| 展示    | 书籍信息底部：`添加于 … · NeoDB 9.2（995 人） · 豆瓣 ↗`；批量补全的每行也带一行              |
| 写入    | 跟补全一起写，**只在这本书还没有时**——所以行里显示的就是将要写进去的                         |

**评分不是豆瓣的，界面每次都写「NeoDB」。** 豆瓣 2019 年关了公开 API，抓 HTML 违反 ToS、按 IP 限流，而且**失败是静默的**（403 变成「没有评分」）。给链接、不给抓来的数字，是这个取舍的答案。见 §0 的讨论。

**为什么不是 `Fill`**：评分和链接不是读者编辑的字段，是「查询那一刻目录的说法」。它们跟着补全一起写，但不参与「勾选哪些字段」，也不该出现在 `评分 → 9.2` 这种补全项里。

**证据**：Rust 702 passed（`metadata::` 21 个，新增：候选带评分与豆瓣页且不把 goodreads 认错、没有豆瓣页时不瞎猜、提议带评分、已有评分的书不被覆盖）；前端 1186 passed；e2e 断言行里出现 `NeoDB 9.2` 与 `book.douban.com`。

**证据**：Rust 695 passed（`metadata::` 14 个）。真实响应用 WebFetch 取到并逐字段核对（沙箱代理连不上 neodb.social，`#[ignore]` 的联网测试在这里跑不了）。

### Phase 2.4 — 批量补全 ✅

| 层   | 位置                              | 内容                                                                                   |
| ---- | --------------------------------- | -------------------------------------------------------------------------------------- |
| 规则 | `metadata::fills` / `propose_for` | **只填空字段**；匹配度 < 0.6 不采用；没找到 / 字段都有 是两句不同的话                  |
| 命令 | `metadata.propose(ids)`           | 4 路并发（`buffer_unordered(4)`），一本失败不影响其余；结果按「能补几项」排序          |
| 命令 | `metadata.apply(items)`           | 一个事务、一条日志（带 before 镜像，可撤销）                                           |
| UI   | `BatchFillDialog`                 | 逐行预览 `出版社 → 重庆出版社`，默认全勾、可取消勾选；跳过的行**留在列表里**并写明原因 |

**为什么只填空字段。** 补全的卖点就是「不用逐本看」，而一个会覆盖读者自己填过的值的批量操作，读者没有别的办法发现它改错了。空字段是唯一一种「填了肯定比不填好」的情况。

**为什么跳过的行不折叠掉。** 一个默默少掉十二本的列表读起来像 bug，而原因（没找到 / 匹配度太低 / 字段都有）正是读者决定要不要换个书名再试的依据。

**没做进度条和取消**：两路并发、一批最多 40 本（NeoDB 是社区实例，不是商业 API，一次全选 985 本会把它当成攻击），几秒钟一个转圈就够；真正的取消需要 3.6 的任务层。**也没做多来源对比**——目前只有一个来源。

**证据**：Rust 694 passed（`metadata::` 13 个，新增 4：只补空字段、字段都已有、弱匹配带分数拒绝、没有候选与没东西可补是两句话）。前端 1183 passed、tsc / oxlint / prettier / build 干净。**联网路径在这里验不了**（沙箱代理连不上 openlibrary.org），解析与规则是纯函数、有测试；请求本身复用 2.1 那条已核对过响应形状的路径。

### Phase 2.5 — 不挂代理也能查（豆瓣 + NeoDB）✅

用户报的问题：**只有连上代理才查得到**。NeoDB 在内地不可达，而它是唯一的来源——于是整个补全功能在内地等于不存在。

| 层       | 内容                                                                                 |
| -------- | ------------------------------------------------------------------------------------ |
| 来源     | `Provider::{Douban, Neodb}`，`CHAIN` 固定先豆瓣后 NeoDB；先命中的赢                  |
| 豆瓣     | 两步：`/j/subject_suggest?q=` 拿 id（无需登录）→ `/rexxar/api/v2/book/{id}` 拿全字段 |
| 评分来源 | 迁移 26 `books.rating_source`；老数据回填 `neodb`（当时只有它）                      |
| 批量     | 4 路并发；一次运行内失败的来源不再重问（`Attempts`），否则每本外文书都要等 12 秒超时 |

**为什么是链而不是合并。** 两个目录对出版社不一致时会合出第三份谁也没选过的答案，而读者看不出自己看的是哪条记录。先命中的赢，来源名跟着数字走。

**豆瓣的两个入口都是「它自己的客户端在用的」**，不是公开 API：搜索页是 JS 渲染、搜索接口要登录，只有自动补全不要；详情接口**必须有 Referer**，否则回 HTTP 200 + `{"code":1287}`——一个伪装成成功的失败，所以判断依据是「有没有 title」，不是状态码。

**豆瓣没有 ISBN，也没硬凑。** 主题页 HTML 里有（120 KB 里一个正则），但那是最脆的一种解析，为一个读者能手填的字段不值。ISBN 仍由 NeoDB 提供（有代理时）。

**实测**（真实豆瓣，4 路并发，10 本真书）：**10/10 命中，1.7 s**，出版社/年份/评分都对——人类简史 中信 2014 9.1、三体 重庆 2008 8.9、活着 作家 2012 9.4。

**证据**：Rust 721 passed（`metadata::` 39 个，新增 20：suggest 命中、电影被排除、非数字 id 被拒、详情字段、`2018-3` 取年、错误体不是候选、伪造 host 被丢、merge 回退、豆瓣评分带 douban 来源、来源链五条、批量内失败不再重问）。联网测试标 `#[ignore]`，其中**豆瓣那条与「无代理整链」那条在本机真跑过**（沙箱恰好连不上 NeoDB，正是用户的处境）。

### Phase 2.5b — 三个使用中暴露的问题 ✅

用户实测报的三件事，都是上一轮没测到的：

**① 「很多书查不到」——`subject_suggest` 是前缀补全，不是检索。**
「索拉里斯星」返回 2 条，「索拉里斯星（修订版）」返回 **0**。书库里的书名带着目录没有的版次注、副标题、卷次，每一样都让匹配落空。现在 `queries_for` 依次尝试：原样 → 去掉尾部括注 → 去掉副标题 → 去掉卷次 → 取前 6 字，最多 4 次。`core_title` 同时用于**打分**，否则「索拉里斯星（修订版）」对记录「索拉里斯星」会被算成低匹配。

**② 「没有 ISBN」——在 3 KB 的 H5 页里。**
详情 JSON 的 55 个字段里没有 ISBN；桌面主题页有，但那是 118 KB。豆瓣自己的 H5 详情页（`info_url`，**3.2 KB**）有一张干净的表：`<td>ISBN</td><td>978…</td>`。只在书还没有 ISBN 时才抓，多一次请求换一个字段。

**③ 「为什么只有一个查找书目」——改成两个按钮。**
两个来源不是可互换的：豆瓣国内直连、中文版次全、没有 ISBN；NeoDB 有 ISBN 和外文书、需要代理。一个按钮偷偷替读者选，等于把这件事藏起来。单本查询现在**按来源分开**（`metadata.search(id, source)`），批量仍走链。

**顺带修掉一个真崩溃**：`rating.value !== null` 挡不住 `undefined`，而**浏览器端在迁移 26 之前写的行根本没有这个字段**——打开书籍信息整页崩成「这个界面出错了」。改成 `typeof === "number"`，并给演示夹具补齐所有字段（它之前用 `as unknown as BookSummary` 把缺字段藏起来了）。

**证据**：Rust 734 passed（`metadata::` 53 个，新增 14：版次注/副标题/卷次被剥、全数字书名不动、查询不超过 4 次、core 打分、ISBN 表格行、10 位带 X、无值跳过、弱匹配继续问、弱匹配兜底）。真实豆瓣实测五个难书名全部命中且带 ISBN（索拉里斯星（修订版）→ 索拉里斯星 译林 2021 ISBN 9787544782173）。前端 1187 passed。

### Phase 2.5c — 批量补全：说清楚「这本书已经有什么」✅

用户报：「批量补全时，对已有补全的书籍要有对应的提示」。查下去发现**同一张截图里还藏着一个 bug**。

🔴 **「只有评分可写」的行被当成了「没事可做」。** 行是否可勾用的是 `fills.length === 0`，而「六个字段都齐、只差豆瓣评分」的书 `fills` 是空的——于是它被渲染成灰行、勾不上、**而且没有原因**（后端只在真的没事可做时才写 `skipped`）。截图里 6 行是灰的、页脚说「另有 2 本」，差的 4 本就是这些。

| 层   | 内容                                                                       |
| ---- | -------------------------------------------------------------------------- |
| 判定 | `nothing = !hasSomething(proposal)`——有评分或有豆瓣链接就算有事可做        |
| 提议 | `Proposal.existing`：这本书**已经有的**可补字段，按表单顺序                |
| UI   | 摘要行末尾加一段 `已有 ISBN、出版年`（超过 3 项压成「已有 A、B 等 5 项」） |
| 明细 | 展开后补一行「评分」，否则只有评分的行展开是空的                           |
| 配色 | 简介框从 `surface-1`（58% 不透明）换成 `surface-3`——书封会透进正文里       |

**证据**：Rust 736 passed（新增 2：提议报告已有字段、字段全齐但有评分仍算有事可做）；前端 1193 passed（新增 6：`existingHint` 三条、`hasSomething` 三条）；e2e 断言行里出现「已有 ISBN、出版年」。

### Phase 2.6 — 整架补全 + 封面 ✅

书库实测：984 本里 **952 本没有副标题、924 本没有 ISBN、935 本没有评分**。一次 40 本 = **24 轮**「全选 → 补全 → 等 → 关」，这才是当时的瓶颈，不是数据源。

| 层   | 内容                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------- |
| 循环 | `stores/fillRun.ts`——按仓库既有做法（同 `ocrRun`），**循环住在 store 里**，所以关掉对话框不会中断 |
| 批量 | 每批 40（= 一次事务）；批间 500 ms，别把社区目录当压测目标                                        |
| 停止 | 在**两批之间**检查，不在批内——一批是一次事务，中途放弃会让计数说谎                                |
| 自停 | 一批里**一半失败**就停：那是目录不说话了，不是一批烂匹配，剩下几百本只会一个个超时                |
| 封面 | `Proposal.coverUrl` → 事务**外**下载（库只有一个连接）→ 写完字段再落文件；只补没有封面的书        |
| 单本 | `book.cover_from_url`，表单点保存时才下载，不在点候选时就写                                       |

**封面是文件不是字段。** 所以它不走 `Fill`，也不进事务：`metadata_apply` 先把图下完再开事务。豆瓣图片站**不带 `Referer` 回 418**，带上才 200；扩展名按**字节**判断（`jpg`/`png`），URL 必须是目录自己的图床——它来自别人的 JSON。

🔴 **连接超时 3 秒**。被墙的主机不是拒绝连接，是吞掉连接，所以每批都在 TCP 握手 上耗满 12 秒——950 本跑下来是五分钟的纯等待。同一个调用实测 **12.25 s → 4.47 s**。

**证据**：Rust 741 passed（`metadata::` 60 个，新增 5：扩展名按字节、非图床地址被拒、没封面才给、有封面不动、只有封面也算有事可做）；前端 1198 passed（新增 5 个 store 测试：分批计数、跳过不写、停止在两批之间、一半失败自停、不许并发两个 run）；新 e2e `shelf-whole-fill` 把 60 本跑到 60/60，双引擎过。真实下载封面 117 KB。

### Phase 2.7 — 撤销要跟得上它要撤销的东西 ✅

补全从 2 个字段长到 11 个（含封面），`before` 镜像**没跟着长**：日志里还是 `{"before":{"language":"zh","publisher":"…"}}`。于是设置页对每一条补全都亮着「撤销」，点了会说「已撤销 N 本」——**只还原两个字段，另外九个不动**。

实测证据（用户的库）：66 条 `fill_metadata`、25 条 `update_metadata`，`detail` 全是两个字段；4 条 `cover` 根本没有 `detail`。

| 层       | 内容                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| `Before` | 从 2 个字段扩成**这次写会碰到的全部字段** + 原封面路径                                                         |
| 记录     | `detail` 加 `"v": 2`；`snapshot(conn, book)` 是唯一出处，三个写路径都调它                                      |
| 撤销     | 用 `update_metadata` 还原整条记录；封面——原来有就写回旧路径，原来没有就清列 + 删文件（**只在 covers 目录内**） |
| 旧日志   | 只有两个字段的行**不再提供撤销**：还原它记得的那两个、留九个不动，然后说「已撤销」——那正是要修的东西           |

**为什么 `detail` 要版本号**：旧行没有 `subtitle` 之类的键，若按「缺就是 null」读，撤销会把九个字段**清空**。宁可不动。

**为什么不是整行快照**：`Before` 只装「这次会写的字段」，是一份改动清单，不是第二份真相。整行快照会还原这次根本没碰过的字段，那是另一种错。

**证据**：Rust 744 passed（`ops::` 12 个，新增 3：十一个字段全部还原、封面连同文件一起撤掉、旧格式行不给撤销也不改任何字段）；前端 1201 passed。

### Phase 1.5 / 1.6c / 2.8 — 书库整理收口 ✅（11-11 至 11-12）

11-12 的 12 笔提交把「补元数据 → 换封面 → 撤销 → 查重复」闭成一条线，Phase 1/2 到此收口。

| 切片          | 内容                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.5 疑似重复  | `library/duplicates.rs` 只读报告：ISBN 优先、标题**全字符归一化后精确相等**才成组，**绝不合并/删除**；组标题放大镜按 `searchTerm()` 跳回书架       |
| 2.8 封面      | 候选预览走 `data:` URL（CSP 只放行 `data:`，且豆瓣图床要 `Referer`）；已有封面默认不换；换之前 `move_aside` 留底；批量/整架可连已有封面一起换      |
| 1.6c 操作记录 | 一次保存 = 一条记录（`book.update` 收 `coverUrl`，`book_cover_from_url` 整个删掉）；按日折叠 + 类型 chips 筛选；`update_metadata_cover` 同时归两类 |
| 封面 URL      | `?v={updated_at}` 破 webview 缓存，**先有版本才敢加 `immutable`**——顺序反了会把旧图钉死一年                                                        |

🔴 **重复检测第一版「切副标题」是错的**：真实库 1537 本跑出 62 组 / 137 本，大半假阳性（`·` 是人名、`-` 是系列、`（）` 是卷次）。改成不截断的精确相等后 **28 组 / 58 本**。合成夹具没抓住，靠 Python 复现旧规则对上截图数字才定位。

🔴 **撤销换封面要真还原**：旧文件必须 `fs::rename` 到 `.prev.<ext>` 留底，不能删；新文件写失败要把备份 rename 回去。`detail` 升 **v3**（v2 行仍可撤销字段，只是还原不了封面）。修复前已发生的替换旧字节没了，撤不回来——如实说明。

**证据**：Rust 759 passed、前端 1218 passed；release 打包 + minisign 签名通过（2m51s）；**打包版真机 GUI 六项验证通过**（改名后第一次：封面出图、开书翻页、关于、换封面→撤销→还原、重复定位）。Apple 代码签名仍是 `adhoc`、无 Developer ID，对外分发会被 Gatekeeper 拦。

**明确未做的**：保存筛选视图、作者/系列/出版日期区间、批量改作者、字段级候选对比（2.3）、`series`/`translators`/ISBN-10 字段（2.5）、批量补全进度条与取消、`MetadataProvider` trait（两个来源仍是 `Provider` 枚举 + `CHAIN`，没到需要多态的时候）。

### Phase 2 — 元数据

| #   | 切片                                                                              | 验收                                         |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------- |
| 2.1 | **豆瓣 + NeoDB 两个来源，按序回退** **✅**（**没做 trait**，见 §0）               | 按书名查到候选；网络失败只影响这一次查询     |
| 2.2 | 候选结果 + 置信度                                                                 | 置信度是**内部匹配分**，UI 不许叫「概率」    |
| 2.3 | 字段级对比 UI（当前值 / 候选值 / 来源 / 是否应用）                                | 不确认不覆盖；用户改过的字段默认不勾         |
| 2.4 | **批量补全** **✅**（无进度/取消，见 §0）                                         | 只填空字段；每行可取消；来源挂了只影响那一本 |
| 2.5 | 字段扩展：`series`、`series_index`、`published_date`、`isbn_10/13`、`translators` | 迁移 23；老库全部可空                        |
| 2.6 | **无代理可用** **✅**                                                             | 内地不挂代理也能查；换源不再是一次重写       |

**注意**：Provider 的 API 条款要逐个核实（限流、是否需要 key、能否缓存封面与简介）。没核实完不许上线默认开启的来源。

### Phase 3 — MCP（最高价值，改动全加法）

**传输：先 stdio，不先 HTTP。** 理由：本仓目前零监听端口；stdio 天然只有启动它的那个 Agent 能连，省掉 token 分发、防火墙例外、端口冲突三件事。HTTP 留到「需要多个客户端同时连」时再说。

| #   | 切片                                                                                                        | 验收                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 3.1 | 服务骨架 + 工具注册表 ✅（**调用日志未做**）                                                                | 真实 MCP 客户端连上、`tools/list` 正确 —— 2026-11-13 用官方 SDK 客户端验过，见 `MCP_SETUP.md`        |
| 3.2 | 只读工具：`search_books` / `get_book` / `search_book_content` / `get_annotations` / `get_bookmarks` **✅**  | 返回可定位的原文证据（book_id + chapter_idx + 字符区间），复用 `retrieval/search.rs`，**不新建索引** |
| 3.3 | `ask_library`（RAG）+ `export_notes`                                                                        | 回答里区分原文引用与模型推理                                                                         |
| 3.4 | 权限层：`read` / `search` / `write_metadata` / `delete` **✅**                                              | 默认只读；按连接授予；越权返回可读错误（`export` / `manage_library` 随对应工具再加）                 |
| 3.5 | 写工具：`update_metadata` / `manage_tags` / `remove_books` **✅**；`suggest_metadata` / `import_books` 未做 | 删除走软删除；每次写留一行审计                                                                       |
| 3.6 | 任务层：`get_task_status` / `cancel_task`                                                                   | 依赖 3.1 的任务注册表（**Phase 1.6 之前先建**）                                                      |
| 3.7 | 设置页「开发者」区块                                                                                        | 开关、状态、已连接客户端、调用历史、重置                                                             |

**Phase 3 出口 ✅（2026-11-13）**：官方 SDK 客户端连上、查到真实书库、拿到带 `chapterIdx`/`offset` 的原文证据、越权被拒，四项全过。剩下的 3.3 / 3.6 / 3.7 是**能力扩展**，不是出口条件。

### Phase 4 — 插件（后置）

先只做 **配置型**（现有 JSON 书源包成 Provider 实现），再看有没有真实需求做脚本层。详见映射文档 §2。

### Phase 5 — Calibre（成本最高）

**5.1 只读扫描 ✅** → **5.2 预览入口 ✅** → **5.3 导入 ✅**（含 5.3b 大库 / 5.3c 格式偏好）→ **5.4 只读元数据探测 ✅** → **5.4b 官方 schema 校准 ✅** → **5.4c 无需真库的自验 ✅** → **5.4d 写入半 ✅** → **5.5 书单 CSV 导出 ✅ / 增量同步评估：不做 ✅**（见 §0）。Phase 5 提示词的七步到此收口。**永远不写用户的 `metadata.db`；写入只落在方册自己的库。**

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

## 4. 下一步（2026-11-14 复核，Phase 5 收口）

🔴 本节原来写的是 1.2 回收站与 3.1+3.2 MCP 只读，**两者都已完成**，留着会让接手的人走回头路。11-13 过了六项（Phase 3 出口验收见 `docs/mcp/MCP_SETUP.md`、5.1 扫描、5.2 预览、5.3 导入、5.3b 大库、5.3c 格式偏好），11-14 过了 **5.4 只读半 + 5.4b 官方 schema 校准 + 5.4c 无需真库的自验 + 5.4d 写入半 + 5.4d 真机往返 + 5.5 书单导出与增量同步评估**（见 §0）。§0 各段里的「仍未做」是写下那一刻的快照，**当前真实待办以本节为准**：

1. **Phase 4 配置型插件 / Phase 6 AI 工作流** —— 插件后置，AI 工作流依赖 Phase 3 工具层，最后做。
2. **（可选补充，不阻塞）** 桌面版设置页点一次「导出书单 CSV」（Rust 落盘与组件行为都有测试，按钮本身没在真机上点过）；真 Calibre 库并发打开时扫一次；评估 `document/pdf.rs::read_metadata` 对解析失败静默降级、让损坏 PDF 也能进书架这一既有行为。真机往返已用示例库走通，EPUB 导入已实测。

**5.5 校验记录（2026-11-14）**：`cargo fmt --all --check` / `cargo clippy --all-targets -- -D warnings` / `cargo test --lib` **793 passed（14 ignored）**；`prettier --check .` / `tsc --noEmit` / `oxlint .`（464 文件 0 warning）/ `vite build --no-emptyOutDir`；全量 `vitest run --maxWorkers=2` **127 个测试文件、退出码 0**（最终统计行随会话切换没留存；vitest 有失败会非 0，所以「全过」有据，具体条数不虚报）；e2e `settings-rail` + `backup` + `smoke` 双引擎 **18 passed**。

**有意不补的**：3.3 `ask_library` / `export_notes`（客户端本身就是模型，能自己 search + read；导出只是格式化）；3.6 任务层（当前没有后端长任务，为两个工具造任务注册表是 YAGNI）；3.7 设置页区块（等客户端真的连上再决定要展示什么）。理由见 §0 各段。

**文档分工**：`docs/audit/*` 是 11-10 的审计基线，不随功能更新；**本文件 §0 是进度的唯一出处**。
