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

### Phase 1.4 — 批量元数据编辑（2026-11-15 移除）

> **状态：已移除。** 补全信息（Phase 2.4）覆盖同样的出版社 / 语言且能自动取值，批量手输这两个字段的场景不成立；单本「编辑信息」是它的能力超集（可覆盖、可清空、字段更多）。整条链（弹窗 / hook / IPC 命令 / `BookFieldsPatch` / `update_fields_many` / 对应测试）已删除。下面是当时的实施记录，不是现状。

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
- **`None` 与 `""` 的转换在撤销这一侧**：写入侧 `None` = 不改，所以「原本没有出版社」必须还原成 `Some("")`（清空），否则撤销会把空字段留成原样。
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

### Phase 4.2–4.4 — 脚本层 / Provider trait / 插件页 ✅（11-20）

用户明确要求启动三条此前按「等真实需求」推迟的能力，按最小可用切片交付：

| 切片                | 位置                                                                                      | 内容                                                                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.2 脚本层          | `library/io/script.rs`（新）、`source.rs`、`fetch` 四个阶段钩子                           | `rquickjs`（静态链接，4 个新 crate / Cargo.lock +41 行）；`SourceDef.script: Option<SourceScript>` 带 `#[serde(default)]`，旧书源照常加载。每轮全新 Runtime、16MB 内存上限、2s 中断、只暴露 `log()`，无网络/文件 API；非 JSON 响应以原文交给脚本。脚本返回 JSON 后仍走原来的 JSON 规则 |
| 4.3 元数据 Provider | `library/metadata.rs`、`commands/metadata.rs`                                             | `enum Provider` + `CHAIN` → `MetadataProvider` trait + `Douban`/`Neodb` 实现 + `PROVIDERS` 注册表；泛型化的 async 用 boxed future（无 `async_trait` 依赖）。`CatalogueGate`/`Attempts` 按 `key()` 字符串分桶，DB 的 `rating_source` 与 TS 的来源字符串不变                             |
| 4.4 独立插件页      | `features/plugins/PluginsPage.tsx`（新）、`router.tsx`、`NavList.tsx`、`SourceDialog.tsx` | 新 `/plugins` 路由 + 侧栏/命令面板入口；分类（`SourceDef.category`，可选）、按名称/主机/分类搜索、多选批量删除（确认弹窗）、JSON 编辑器带分类输入。`SourceDialog` 只保留「在线找书」，管理与新建按钮导航到插件页                                                                       |

**安全边界**：脚本发起的二次请求仍是零——沙箱里没有 `fetch`，所有响应都先过 `fetch()` 里唯一的 `Hosts::check`。脚本代码 64KB 上限在保存时校验，输出 4MB 上限在执行后校验。

**实测开销**：`script apply` 309µs/次（debug 构建，100 次平均，`runtime_startup_cost` 忽略测试）；`libquickjs.a` 2.4MB（debug），静态链进产物、无额外 dylib，因此没有新的签名对象。

**明确未做的**：第 3 层（独立进程/WASM）隔离——第 2 层被证明不够时再做；脚本调试器（目前靠 `log()` + 异常里的阶段名与行号）；用户自定义元数据来源的持久化注册表当时未做，已在 4.5 交付。

**证据**：Rust 884 passed / 16 ignored（`script` +5、trait 可插拔 +1；`a_round_trip_restores_every_file_and_the_database` 全量里偶发一次，单跑与全量复跑均过，按已知 flake 处理）/ clippy `-D warnings` / fmt；prettier / `tsc --noEmit` / oxlint（497 文件 0 warning）/ `vite build --no-emptyOutDir`；全量 vitest 140 文件 1374 passed（插件页 +4）；e2e `smoke`（含新路由）+ `source-search-button` + `page-swap` + `palette` 双引擎 26 passed。改动留工作区，未提交。

### Phase 4.5 — 用户自定义元数据来源 ✅（11-20）

4.3 只把 provider 抽象成 trait，注册仍是编译期常量。这一步把注册也放出来：读者在插件页填一份 base URL + `{{query}}` 搜索路径 + JSONPath 字段映射，作为链尾 provider 参与单本查找与批量补全。

| 层     | 位置                                                                                       | 内容                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 持久化 | `db/migrations.rs` v28                                                                     | `metadata_sources(id, name, rules, created_at)`，rules 是单 JSON 列，沿用 `sources` 的形状；删除来源不影响书里已写的 `rating_source` 字符串                                         |
| 定义   | `library/custom_source.rs`                                                                 | `CustomSourceDef`：`searchUrl` 里的 `{{query}}` 换成百分号编码书名，搜索路径 / 结果列表 / 书名必填，其余字段可选；`validate()` 走 `Hosts::new(base_url, &[])`，只收 HTTPS base host |
| 运行   | `CustomProvider`                                                                           | 实现 `MetadataProvider`，`key()` 是行 id、`label()` 是用户名称；复用 `gate()`、JSONPath helpers 与评分函数。封面只接受 doubanio.com / neodb.social，避免「界面显示了但下载失败」    |
| 命令   | `commands/metadata.rs`                                                                     | `metadata_search` 在内置 key 未命中时按行 id 加载来源；`metadata_propose` 把自定义来源接在 `PROVIDERS` 之后；新增 list / save / delete 三命令                                       |
| 前端   | `MetadataSourcesPanel.tsx`、`BookMetaDialog.tsx`、`BatchFillDialog.tsx`、`lib/metadata.ts` | 插件页里新建 / 编辑 JSON / 删除来源；单本与批量查找的来源按钮在运行时合并自定义来源；`sourceLabel(source, customNames)` 显示用户名称                                                |

**有意不做**：自定义来源任意主机的封面下载（白名单不变）、跨主机搜索模板、来源定义的分享 / 导入导出。第一次落地只支持「base host 内的 JSON API + JSONPath 映射」，HTML 站点继续走书源脚本层。

**证据**：Rust **888 passed / 16 ignored**（884 → 888，新增 4 条在 `custom_source.rs`）/ clippy `-D warnings` / fmt；prettier / `tsc --noEmit` / oxlint（500 文件 0 warning）/ `vite build --no-emptyOutDir`；全量 vitest 142 文件 1379 passed（+2 文件、+5 用例）；e2e `smoke` + `book-meta` + `source-search-button` + `page-swap` + `palette` 双引擎 **24 passed**（`--workers=1`）。默认 5 worker 时 `palette` 的弹簧中间帧取样用例两次踩线失败（310.6 / 307.6，阈值 303.25），单跑与 `--workers=1` 均过，按已知负载 flake 处理，未改产品代码。改动留工作区，未提交。

### Phase 4.1 — 书源即插件：清单 + 主机权限 ✅（11-14）

Phase 4 的第一步只做「权限」这一件真事。现有 JSON 书源本来就是插件——定义由别人写、用读者的网络跑——所以先给它一个能收住的边界，而不是先造运行时。

| 层     | 位置                                | 内容                                                                                                          |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 清单   | `library/io/source.rs`              | `SourceDef.permissions: { hosts }`，`#[serde(default)]` 旧行照常加载；只收主机名，拒 `*` / `https://` / 路径  |
| 判定   | `net.rs::Hosts`                     | base 主机永远允许 + `permissions.hosts`；`check(url)` 同时要求 https（loopback 例外），错误点名主机并给出办法 |
| 重定向 | `commands/ai.rs::client_restricted` | 逐跳检查的 redirect policy：302 到名单外的主机直接失败，而不是「悄悄成功」                                    |
| UI     | `SourceDialog`                      | 管理列表每行显示它能访问的主机；编辑器写明这条规则；新书源带 `permissions.hosts: []`                          |

🔴 **顺带补掉一条记录在案的残留**：书源返回的绝对地址（章节链接 / CDN）以前原样采用，等于让第三方 JSON 决定读者的下一个请求发往哪里。现在它要过 `Hosts::check`。

**兼容性**：真实书源若把章节放在第二个域名，保存后第一次搜索/下载会报「这个书源不许访问 x.com」，按提示把 host 加进 `permissions.hosts` 即可。**没有迁移**：`permissions` 住在 `rules` JSON 里，不改表。

**明确未做的**：插件运行时（脚本层）、元数据 `Provider` trait、独立的插件管理页 —— 理由仍是映射文档 §2：配置型能覆盖的事不引 QuickJS；Provider 只有两个来源，`enum` + `CHAIN` 还没到需要多态。「插件异常不崩溃」在书源这一侧本来就有：一次调用 = 一条命令，失败只回一个错误。

**证据**：Rust 801 passed（`net` +5、`source` +3：base 主机放行、未声明主机被点名拒绝、声明后放行、数据里的明文地址被拒、声明项拒绝通配符与 URL、旧 JSON 无 `permissions` 仍加载）；clippy `-D warnings` / fmt / tsc / oxlint（464 文件 0 warning）/ `vite build` 全绿；前端 127 文件 1258 passed。

### Phase 6.1 — AI 书库整理：标签建议 ✅（11-14）

Phase 6 只做了一件真实的事：**让模型给还没有标签的书起标签**。元数据校正、重复检查、笔记整理今天都已有非 AI 的通路，先不叠一层模型上去。

| 层     | 位置                              | 内容                                                                                            |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| 提示词 | `library/assist/tagging.rs`       | 只要 JSON 数组；每本 2–4 个、每个 ≤6 字；看不出题材宁可少给                                     |
| 选书   | `tagging::untagged`               | **只碰没有标签的书**（读者手打的标签是他的判断）；已删的 id 跳过                                |
| 解析   | `tagging::parse`                  | 信任边界：剥代码块、id 必须在本批、去重、单标签 ≤12 字、每本 ≤4 个                              |
| 失败   | `tagging::suggest`                | 空回答 / 拒答 / 不是 JSON 是三句话；**一批坏掉不带走其他批**                                    |
| 写     | `tagging::apply`                  | 一个事务 + `tags::assign` + `ops::record_details`，与手写标签同一条路；日志带「这次加了哪些词」 |
| 命令   | `commands/tag.rs`                 | `tag.suggest`（只读）、`tag.suggestApply`；没配模型直接报「先到设置里填」                       |
| UI     | `AiTagDialog` + 批量栏「AI 标签」 | **不自动跑**（一次建议一次计费）；逐本可取消、逐标签可点掉；页脚写清将写多少本多少个            |

数字：一轮 60 本、每批 20 本（一次操作最多 3 次调用）；简介进提示词截 200 字；每本约 200 tokens，
确认框上写着这一批的上界（60 本 ≈ 1.2 万）。

**选中超过 60 本时分批：应用后自动看下一批，但写库永远要读者点头。** 自动的只有「花 token 取建议」，
不是「写」——每个批次都先落在预览列表里，按「应用」才进库。这是 Phase 6 唯一不能破的一条，
也是它和「整架补全」（`fillRun`，无人值守且会一直写下去）的分界。

三个刹车：切换/关闭对话框重置；一批**什么都没写**（读者全取消，或模型一个标签都没给）就停下，
不会拿同一批书反复问；出错也停下（端点挂了不重试，否则是在循环烧钱）。
读者想收手按「停在这里」，这一批看完就停，之后回到「继续下一批」。

确认页的估算写的是**整个选择**的上界（`ids.length × 200`），不是一批——300 本 ≈ 6 万 tokens 得让人看见。

🔴 **没有任何一条路径让模型直接改库**：建议回来只是 JSON，写库要读者按「应用」。这就是 Phase 6 出口「先预览、再执行」的最小实现，也是它敢存在的理由。

**明确未做的**：MCP 侧的工作流工具（客户端本身就是模型，它能自己 search + read）、把 AI 接进元数据补全（目录已经给出候选，模型只会多一层不确定）、自由文本的「整理整个书库」入口（那需要一个任务层，现在没有长任务）。

**证据**：Rust 814 passed（`tagging` 12 个：剥代码块与前后废话、编造的 id 被丢、去重/截断/上限、模型没提的书不动、垃圾输出不 panic、提示词带 id 与省略号、只挑没标签的书、**写入落标签且日志 source 是 `ai`**、空选择不留空记录、词表进提示词且同票按名字排、**撤销只删这次加的**；`migrations` 新增 1 个：27 号重建保留旧行且自增序列接着走）；前端 128 文件 1261 passed（`AiTagDialog` 3 个：不点不调模型、点掉标签就不写它、失败给原因和重试）；tsc / oxlint 0/0 / vite build / clippy `-D warnings` / fmt 全绿。

### Phase 6.1j — 标签页进 e2e，键盘能走完整条索引 ✅（11-15）

**这一页改了 8 轮，全靠在会话里临时写 Playwright 脚本验证，跑完就删** —— 49 个 e2e spec 里没有一个进过标签视图。
`e2e/tag-index.spec.ts`（7 个）把四件几何事实钉住，它们都是这 8 轮里真实反复出现的故障：

| 断言                                                     | 防的是什么                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| 左栏搜索框与工具栏搜索框 `top` / `height` 相等           | 上一轮「多一行『共 281 个』把整条撑高 15px」，看起来像顶边不齐 |
| 展开后行高不变                                           | `max-h` flex 列压缩子项，32px 变 24px                          |
| 展开后 `scrollHeight > clientHeight` 且 `scrollTop` 可写 | 「列表滚不动」                                                 |
| 玻璃层与选中行 rect 重合，滚动后仍重合                   | 高亮跟随 / 坐标算错                                            |
| 搜索时无分组标题                                         | 相关度顺序被频次分堆打散                                       |
| 键盘 ↓ 走焦点、Enter 才筛选                              | 见下                                                           |

全部是关系断言（相等、大于、前后一致），没有写死像素阈值。夹具靠 `?demo=1&books=84&tags=1`：
它正好产出「9 个 ≥8 本 + 11 个 2–7 本」，所以一带超两行要折、一带不折。

🔴 **它第一天就抓到一个真 bug，而且是只有第二个引擎才有的：**

`tiny-pinyin` 用「字符是否排在 U+9FFF 之前」判断「这是不是一个拼音字」。Chromium / Node 按拼音排，
中 在 鿿 之前 → 正常；**WebKit 把 中 排在 U+9FFF 之后** → 中 被判成「不是拼音字」，
于是「美国文学」的首字母是 `mgw`（少一个），「哲学」是空字符串 —— 读者按 `mgwx` 搜不到任何东西。

对照组（同一份 `dist/`）：

| 词       | Chromium | WebKit     |
| -------- | -------- | ---------- |
| 美国文学 | `mgwx`   | **`mgw`**  |
| 中国历史 | `zgls`   | **`gls`**  |
| 哲学     | `zx`     | **（空）** |

**修法**：字典放不下的汉字不再丢掉，退到**平台排序**本身问一个字母 —— 23 个哨兵
（阿/八/擦/搭/俄/…/匝），取「不排在它之后的最后一个哨兵」的字母。用 150 个常用字校准过：
只有「长」不同（多音字，字典取 chang、排序取 zhang），而它由字典处理、兜底不会触发。
代价是分不出声调，但那本来就不是首字母要回答的问题。

> 这也说明为什么这条 e2e 值得写：**它不是护栏，是探针**。上面的 bug 在 Chromium 里永远看不到。

**键盘导航**：整条索引**只有一个 Tab 站位**（当前行；未选中时是「全部」），↑/↓ 走行、Home/End 到首尾、
Enter/Space 才筛选。搜索框里按 ↓ 直接落到第一行。

- 🔴 **焦点走，选中不跟。** 每次选中都是一次筛选查询；按住 ↓ 连走二十行等于连问数据库二十次。
  代价是一次多余的 Enter，而那是一次读者本来就要按的键。
- 删除按钮 `tabIndex` 只在当前行是 0：`opacity-0` 的按钮如果能 Tab 到，焦点环就落在一片空白上。
- 监听挂在行按钮上而不是 `<ul>` 上：`ul` 是非交互元素（`jsx-a11y(no-noninteractive-element-interactions)`），
  而焦点只可能落在行按钮或那一行的删除按钮上，两者都带同一个 handler，不需要冒泡。

**证据**：前端 132 文件 1294 passed（`TagIndex` 15 个，新增「只有一个 Tab 站位」「方向键走焦点不改筛选」
「搜索框 ↓ 进列表」；`pinyin` 5 个，新增「字典放不下的字用排序兜底」）；
e2e `tag-index` 双引擎 **14 passed**；tsc / oxlint 475 文件 0/0 / vite build 全绿，主 chunk 413 kB。

### Phase 6.1i — 标签搜索：从「过滤」改成「打分」✅（11-15）

6.1h 给搜索加了首字母，规则还是「命中/不命中」。一旦允许模糊，就必须回答第二个问题：**命中得有多好**——
因为模糊必然带来噪音，而让噪音可忍受的唯一办法是把读者真正想要的那一条排到最前。

`labelSearch.ts`：每个词按证据强度打分，全部命中才算，分数相加后降序。

| 证据                               | 分                      |
| ---------------------------------- | ----------------------- |
| 完全相等                           | 100                     |
| 前缀                               | 85                      |
| 子串                               | 70                      |
| 拼音首字母相等 / 前缀 / 包含       | 65 / 58 / 45            |
| 全拼前缀 / 包含                    | 50 / 38                 |
| **子序列**（`中历` 找 `中国历史`） | 20 − 跳过的字数，最低 5 |

三条规则是刻意的：

1. **空格分词、AND：**「美国 文学」和「文学 美国」是同一个搜索——读者不该记住自己看到的是哪两个字在前。
2. **子序列只能打破平局**，永远压不过「真的包含你打的字」。281 个短标签里子序列几乎总能命中，它的价值是兜底而不是发现。
3. **搜索时不再分组。** 分组会把相关度顺序打散成「8 本以上 / 2–7 本 / 1 本」三堆，而读者此刻只在一个词。

分数相加而不是取最小值：两个词都命中的标签胜过一个词完美命中的。

**证据**：前端 132 文件 1290 passed（`labelSearch` 7 个：分词与顺序无关、完全>前缀>子串、子序列兜底、首字母与全拼、多词优先、空查询原样返回、无命中为空；
`TagIndex` 12 个，新增「搜索时不再显示分组标题」「空格分隔的多个词都要命中」）。
浏览器实测四种输入：`mgwx` / `meiguo wenxue` / `美 文` / `wen` 都落到「美国文学」。

### Phase 6.1h — 侧栏对齐同一套材质，标签可按拼音找 ✅（11-15）

**侧栏选中态**：`bg-accent-soft`（浅色下是 15% 的橙覆在玻璃上，几乎看不出）换成 `glass`——和标签索引那块
移动的玻璃同一个材质。`layoutId` 的滑动本来就在（`SPRING.layout`，阻尼比 0.85 自带一点回弹），只是换了什么在滑。

**拼音首字母**：读者知道标签叫什么，但那个输入框只吃 ASCII；两个字母胜过翻 114 行。

| 项   | 决定                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 库   | `tiny-pinyin`（41 kB 未压缩）而不是 `pinyin-pro`（**928 kB**）。这里只需要「这个字以哪个字母开头」                                                            |
| 判定 | 只有**纯字母**的查询才当首字母（`/^[a-z]+$/`）；带数字或中文的一律按原文匹配。否则每次搜索都顺带成了一次首字母搜索，`设计` 会命中一堆拼音里凑巧含 s、j 的标签 |
| 范围 | 首字母 `includes` 查询而非前缀：`cpxs` 找「长篇小说」，`xs` 也能找到它                                                                                        |
| 备忘 | 每个名字只解析一次（模块级 `Map`）；字典不认识的字**跳过**，不猜——错一个字母比少一个字母糟，因为它会悄悄指向另一个标签                                        |
| 体积 | 主 chunk 404 → **411 kB**（gzip 后 +2 kB 左右），仍在 500 预算内                                                                                              |

**证据**：前端 131 文件 1281 passed（新增 `pinyin.test.ts` 4 个 + `TagIndex` 的「拼音首字母也能找到标签」）；
tsc / oxlint 472 文件 0/0 / vite build 全绿；浏览器实测 `mgwx` → 「美国文学」。

### Phase 6.1g — 标签页改成目录式两栏 ✅（11-15）

6.1f 只把「一面墙」切成三面小墙：目录仍然压在书上，读者要点一个标签得先滚过目录本身。
而这张页叫「按标签浏览」——**标签是目录，书是内容**，目录不该占掉内容的版面。

| 层      | 改动                                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 布局    | `LibraryPage` 把「工具条 + 书架」收成一个 `shelfBody` 节点；标签视图下它进右栏，左栏是 `TagIndex`。其余视图仍是一列                                                                                                                                                                              |
| 断点    | 🔴 **容器查询（`@container` + `@min-[720px]`），不是 `lg:`**：窗口 1080 里侧栏与留白吃掉 250，内容区只剩 850，`lg`（1024）会把它误判成窄窗、白退化成上下堆叠                                                                                                                                     |
| 索引    | 平铺行（32px、无 `glass`）：名字 13px + 计数 11.5px `tabular-nums`，重标签的计数用 `text-text-1`、轻的用 `text-text-3`                                                                                                                                                                           |
| 命名    | 按**覆盖多少本书**分组：`8 本以上` / `2–7 本` / `1 本`。不用「常用 / 普通 / 只用过一次」—— 那是对读者自己词汇的评判，而不是事实（一本书的标签不低等，只是窄），而「普通」什么也没说                                                                                                              |
| 图标    | 分组标题右侧一个箭头（`CaretDown` + 展开时 `rotate-180`，200ms），不再写「展开 15 个 / 收起」：左边那个数字就是状态，右边只需要一个控件。措辞留给 `aria-label`                                                                                                                                   |
| 动效    | 玻璃层的 `translateY` 走 `--ease-spring`（420ms）——过冲再落在目标行上，这就是「果冻」。系数是量出来的：`1.26` 在 160px 位移上过冲 **3.5px** 后收住；`1.56` 是 5.5px（32px 的行上像晃），`1.2` 是 2px（已经不像弹簧）。首次测量用 `settled` 关掉过渡，避免从列表顶端滑进来；行 hover 只变色 150ms |
| 选中态  | **一块流动的玻璃**：`<ul>` 里一个绝对定位的 `glass` 层，测量选中行的位置后 `translateY` 过去，行自己**不涂任何底色**（涂了就把它盖住）。竖条是树形导航的语汇，而行是 24px 圆角的胶囊——直线压弧线看起来像缺口；底色则是「换了个颜色」，而移动的玻璃是「同一个东西换了地方」                       |
| 全部    | 「全部」行也有计数（`total` 传书架总数）并占位到与标签行同一列（`pr-8` 让出删除按钮的位置）。否则它是唯一「选中了却没有任何东西被强调」的行，看起来像坏了                                                                                                                                        |
| 折叠    | 一带一屏（10 行）就够，超过就折。**读者按过收起就以读者为准**（`overrides` 优先于「选中的带自动展开」）—— 上一版把后者写成硬规则，于是当前筛选项所在的那一带永远收不起来，恰恰是最想收的那一带                                                                                                   |
| 滚动    | 🔴 宽窗给**固定高度** `h-[calc(100vh-8.5rem)]` + 窄窗 `max-h-[42vh]`，列表 `flex-1 min-h-0 overflow-y-auto`。用 `max-height` 时，内容比上限少几像素的场合整列刚好放下、列表看起来「滚不动」——高度一旦确定，剩余空间必然分给列表                                                                  |
| 删除    | 行 hover 才出现（`group-hover` + `focus-visible`），确认对话框沿用                                                                                                                                                                                                                               |
| 窄窗    | 索引摞在书上，`max-h-[42vh]` 自己滚，不吃掉整屏                                                                                                                                                                                                                                                  |
| 对齐    | 头**只有一行**：搜索框就是那一行（`GlassInput` 默认 h-9），计数挪进输入框里（只在搜索时显示「匹配 N」）。原先多一行「共 281 个」，整条比工具栏高 15px，两栏内容起点错开                                                                                                                          |
| 🔴 压缩 | 这一列是**有 `max-h` 的 flex**：展开 114 行后总高超过上限，子项默认 `flex-shrink: 1`，32px 的行被按比例压成 24px，「越展开越瘪」。每个子项 `shrink-0`，滚动只发生在容器上                                                                                                                        |

🔴 **频次条撤掉了**：第一版按比例在名字下面画一条 2px 的线，想表达「50 本 vs 8 本」。
放大看就是一条文字下划线 —— 带下划线的标签看起来像**链接**。改成数字自己分档（≥8 本用 `text-text-1`，
其余 `text-text-3`），层次靠「排序 + 分带 + 数字亮度」三件事，不加装饰。

**测量**：视觉问题不再靠肉眼。`?demo=1&books=84&tags=1` 会按 `tagsOf` 给每本书挂标签、
`demoTags` 按真实分布统计（所以三个带、折叠、滚动都能在浏览器里出现），然后
`@playwright/test` 直连 `localhost:1420` 读 `getBoundingClientRect()`：
两框 `top 153.75 / height 36` 一致、列表起点 `205.75`（= 36 + 16）、展开后行高仍 `32`、
列表 `clientHeight 592 < scrollHeight 737` 说明在滚、滚完搜索框仍在 `153.75`（头是钉住的）。

**没做的**：右栏未选标签时的「概览」（Top 12 + 统计）。现在未选中就是整架，和「全部」这个词的意思一致；概览是设计稿里的加分项，不是缺口。

**证据**：前端 130 文件 1274 passed（`TagIndex` 7 个：分带折叠、展开再收起、搜索越过折叠、无匹配给计数、
选中项在折叠带里也可见、点行筛选与「全部」、删除先报影响面）；tsc / oxlint 469 文件 0/0 / vite build /
主包 404 kB（< 500 预算）全绿。`TagBar` 及其 6 个测试随之删除（`CHIP*` 常量挪到 `features/library/chip.ts`）。

### Phase 6.1f — 标签按频次分带 ✅（11-15）

上一版把 281 个 chip 按频次排序、默认显示前 40，问题只解决了一半：**40 个 chip 仍然是一块没有结构的板**，
长篇小说（50 本）和伦理学（1 本）长得一模一样，读者看不出哪些是自己的词汇。

改成分带，每带一个标题、一个计数，带内继续按频次排：

| 带         | 门槛   | 你库里的数量 |
| ---------- | ------ | ------------ |
| 常用       | ≥ 8 本 | **15**       |
| 普通       | 2–7 本 | **114**      |
| 只用过一次 | 1 本   | **152**      |

🔴 **门槛不是拍出来的，是量出来的。** 第一版定「≥8 / 2–7 / 1」三带只折最后一带，量完发现中带
**114 个**——两屏多，等于把墙从「一块」改成「两块」。所以改成**按规模折**：任何一带超过两行（24 个）
就默认折叠，标题右侧给「展开 N 个 / 收起」。同一个规则在别的库上也成立，不用再猜门槛。

排版的层次靠**材质**而不是颜色：只有常用带用 `glass`（抬起的面），其余两带是平底色 + hairline 边框。
这既是层级（长尾本来就该看起来更轻），也顺手把展开成本砍掉——`glass` 每个 chip 是五层 `box-shadow`，
152 个一起插入就是 760 个阴影。

**证据**：前端 130 文件 1273 passed（`TagBar` 6 个：分带与默认折叠、展开再收起、搜索越过折叠、无匹配、
选中的标签藏在折叠带里也可见、点击切换）；tsc / oxlint 468 文件 0/0 / vite build 全绿。

### Phase 6.1e — 标签页：先给用得最多的，其余靠搜 ✅（11-14）

273 个 chip 平铺两屏，而且排序是 `name COLLATE NOCASE` —— 对中文等于**码点序**（专 U+4E13 在
世 U+4E16 在 中 U+4E2D 之前），既不是读者认的顺序，也把只用过一次的标签和用了 50 次的放在一起。

| 层   | 改动                                                                                       |
| ---- | ------------------------------------------------------------------------------------------ |
| 后端 | `tags::list` 改成 `ORDER BY COUNT(...) DESC, name` —— 用得多的在前（第一屏就是自己的词汇） |
| UI   | 标签页加搜索框（输入即过滤，搜索时自动展开全部）；默认只显示前 40，末尾「还有 N 个…」展开  |
| UI   | 正在筛选的那个标签即使排在第 40 之后也**强制可见**，否则筛选栏看起来像没选中任何东西       |

**不做**：把标签并进「筛选」面板当第四个 facet。标签页本身就是「按标签浏览」的入口，并进去等于
删掉一个页面；而且 facet 是多选交集，标签更像单选导航。

**展开与收起**：展开后**顶部**有一个「收起」（连同箭头翻转 180°），折叠时同一位置写「展开全部 273 个」，
另外列表末尾保留「还有 N 个…」——一个在你翻开的那一端，一个在你回头的那一端。

🔴 **展开不做动画（试了三版，撤掉）。** 结论是**材质太贵**，不是实现写错：

| 事实             | 数字                                          |
| ---------------- | --------------------------------------------- |
| 每个 chip 的绘制 | `glass` = 5 层 `box-shadow` + 镜面渐变 + 边框 |
| 281 个 chip      | **约 1405 个阴影**，同一个 `flex-wrap` 盒子里 |
| 高度动画         | 每帧重绘这个盒子 → 十几帧 × 1405 个阴影       |

chip 里**没有 `backdrop-filter`**（材质阶梯里只有 `.glass-2` / `.glass-liquid` 有），所以不是「毛玻璃」，
是层数。中间还试过 `contain: layout paint`（想把重排关在盒子里）——它反而把整个盒子变成一个绘制层，
每次变更全量重绘，一起撤了。

**动画让位给材质**：材质是产品，动画不是。展开现在是瞬时的（150ms 的动画换一帧插入，视觉收益本来就不值）。
真要让展开有过渡，唯一可负担的路是**把 chip 按行虚拟化**（281 → 屏内约 40 个常驻节点），那是真项目，不是 CSS 调参。

**证据**：Rust 816 passed（`tags` 新增「按书数排序」）；前端 130 文件 1273 passed
（`TagBar` 新增 6 个：折叠到 40、搜索展开、无匹配提示、选中的可见、点击切换、**展开后能从顶部收起**）。

### Phase 6.1d — 词表给全，而不是逼它归类 ✅（11-14）

真实库：**273 个标签，176 个（64%）只用过一次**；前 40 个覆盖 48% 的打标。长尾里最刺眼的是
「日本文学 / 日本小说 / 美国文学」这类近义并存。

第一版措施是「词表取前 40 + 一堆新词上限」，被读者否掉了，而且否得对：**逼模型在词表里找最近的词，
等于用一个错误的合并换一个重复**——「伦理学」会被并进「哲学」。

查下去发现更直接的原因：**模型只看到 40 个词，而库里有 273 个**。它造「日本小说」不是因为想造，
是因为看不见「日本文学」。改成两件：

| 项   | 内容                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 词表 | 按**字符预算**给全（`VOCABULARY_CHARS = 1200`，约 280 个词、600 tokens），超预算时截掉用得最少的那头                                 |
| 措辞 | 「说的是同一件事就用原词；只是相近、不是同一件事的，照实另立新词 —— 不要为了对齐词表把两个概念合成一个（「伦理学」不同于「哲学」）」 |
| 不做 | 新词硬上限。它正是「强制归类」的实现方式                                                                                             |

**代价**：每批多约 600 tokens（占一次 60 本的 5%）。**换到的**：长尾不再因为「看不见」而生长。

同一轮还改了打标签面板（`TagDialog`）：**输入框兼作过滤器**（273 个词靠滚是找不到的），
已选标签在过滤时仍显示并置顶，无匹配时末尾出现「创建「xxx」」；回车命中已有标签是**选中它**，
不会造一个同名的。

**证据**：Rust 815 passed（`tagging` 13 个，新增「词表按预算截断」）；前端 129 文件 1267 passed
（`TagDialog` 新增 4 个：输入过滤、无匹配给创建入口、过滤时已选仍可见、回车命中已有即选中）。

### Phase 6.1c — 撤销，与「让它用你已有的词」✅（11-14）

真机第一次写入成功后暴露的两件事，都不是 bug，是缺的东西。

**① AI 标签当初撤不回来。** `ops` 的撤销只认「before 镜像」，而标签写的是「加了哪几个词」——
于是设置页那行没有「撤销」按钮，300 本一次写错只能手工删。这跟本仓库一贯的「删书能撤回、
改元数据能撤回」不一致。

做法：`ai_tags` 的 `detail` 存 `{"v":1,"tags":[…]}`，`ops::can_undo` 按 action 分支判断，
`undo` 走同一个 `tags::assign`（`remove` 方向）。**只删这次加的名字**——读者自己打的标签不动，
测试就钉这一条。

🔴 **已知边界**：撤销删的是「这次加过的名字」。读者若事后又手动加回同名标签，撤销会把它一起删掉——
日志里没有「你后来又改过」这层信息，要补得上给 `book_tags` 记时间戳。场景罕见，暂不做。

**② 模型不知道你库里已经有哪些标签。** 所以第二次跑会出现「科幻 / 科幻小说 / 科幻文学」并存，
按标签筛选就没意义了。做法：`tagging::vocabulary` 取用得最多的 40 个词塞进提示词，加一句
「能对上就原样用，不要另造一个近义的说法」。约 160 tokens/批。

**证据**：Rust 814 passed（`tagging` 12 个，新增：撤销只删这次加的、词表进提示词且同票按名字排）。

### Phase 6.1b — 真机跑出来的那个 CHECK ✅（11-14）

读者在真机上点了一次：模型**确实**按约定的 JSON 回答，5 本书 13 个标签，质量也站得住
（《大国大城》经济学·城市化·社会问题、《打开一颗心》医学·纪实文学、《从 0 到 1》商业·创业·创新）。
然后按「应用」—— 屏幕上报 `database error: CHECK constraint failed: source IN ('ui','mcp')`。

🔴 **根因**：`operations.source` 是一列带 CHECK 的 TEXT，`ops::Source` 加了 `Ai` 变体，schema 没跟上。
写这一片时我加了 `Source::Ai` 却**没有一条测试走过写入路径** —— 解析有 7 个测试，落库一个都没有。
一个类型和一个 CHECK 约束分居两处，只有真机能把它们撞在一起。

**迁移 27**：SQLite 不能改 CHECK，所以按标准重建（建新表 → 拷贝含 id → 删旧表 → 改名 → 重建三个索引）。
两样东西不能丢：行 id（`撤销` 按 `call_id`，设置页按 `id` 打印）和 `AUTOINCREMENT` 序列（丢了会重发 id）。

**补的测试**（就是本该有的那两个）：`migrations::the_operations_rebuild_keeps_old_rows_and_accepts_ai`
（从 v26 带 `ui`/`mcp` 行升上来，行不丢、`ai` 能写、序列接着走）和
`tagging::applying_writes_the_labels_and_one_ai_log_line`（真库写入：标签落库 + 日志 source = `ai`）。

**探针**：`the_live_model_answers_in_the_documented_shape`（`#[ignore]`）吃三个环境变量
（`FANGCE_LIVE_AI_BASE` / `_MODEL` / `_KEY`）—— 🔴 **测试进程按设计读不到真凭据**：
`secrets::master_key()` 在 `cfg(test)` 下返回固定 key，否则 CI 会卡在钥匙串权限弹窗上。

### Phase 6.2 — AI 补笔记 ✅（2026-11-15）

| 层   | 位置                                        | 内容                                                                                         |
| ---- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 形状 | `library/assist/note_draft.rs`              | 照 6.1 `tagging.rs`：PROMPT → `parse` 信任边界 → `suggest`（只读）→ `apply`（单事务 + 记账） |
| 命令 | `notes.draftSuggest` / `notes.draftApply`   | 分批 20 / 一轮 60 / `failedBatches` 不丢批；`AiNoteRun`                                      |
| 写入 | `annotations::set_note`                     | 只写 `note IS NULL` 的划线；**挑选中和落库前各查一次**，读者中途自己写了就跳过               |
| 记账 | `ops::record_details(Source::Ai, ai_notes)` | `can_undo` / `undo` 加一个分支：detail 带 `annotationId`，逆操作是 `set_note(id, None)`      |
| UI   | `AiNoteDialog` + 笔记页批量条「AI 补笔记」  | 不自动跑、逐行可取消、不确认不写；`?demo=1` 有 canned 草稿                                   |
| 夹具 | `demoNoteDrafts` / `demoNoteDraftApply`     | e2e `notes-draft.spec.ts` 双引擎走完整往返                                                   |

**为什么不是「AI 整理笔记」**：`annotations` 表没有标签 / 分类 / 主题列，唯一可写的是 `note`，
也就是读者自己的话。让模型「整理」就得覆盖它 —— 那是数据丢失，不是一个功能。改成**只补空值**
之后：零 schema 改动、零覆盖风险，撤销也只需要把草稿清空。

**证据**：Rust 821 passed（新增 8：代码块解析 / 批次外 id 丢弃 / 空与超长草稿 / prompt 带原文 /
只挑空笔记 / 写入 + `ai` 日志 + 撤销 / 不覆盖读者自己写的 / `AiNoteRun` 序列化）。

**追加（19:30）— 回顾也能保存**：读者要求「AI 整理的笔记也要保存」。
`notes.recapGet` / `notes.recapSave` 把「AI 整理成一段」的结果存进 `settings`
（key `notes-recap:<book_id>`，与导读缓存同一张表，**零迁移**）。流仍是预览，
只有读者点「保存」才写库并记一行 `Source::Ai` 审计（`notes_recap_save`，不可撤销：
文本是派生的，重新整理 + 保存即覆盖）；切页回来读回已保存版本。
`annotations.note` 始终只放读者自己的话。

## 1. 路线图

顺序与迭代要求 §14 一致（书库 → 元数据 → MCP → 插件 → Calibre → AI 工作流），但**每阶段内部按「先数据安全、再能力」排**。

### Phase 1（续）— 书库管理收口

| #   | 切片                         | 为什么现在                                                           | 验收                                                                                                             |
| --- | ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1.2 | **回收站（软删除）** ✅      | 当前删除不可逆，笔记/标注/进度一起没。这是数据安全问题，不是功能问题 | 迁移 22 加 `deleted_at` + `books_live` 视图；读路径全走视图；恢复/彻底删除两个命令；e2e 覆盖「删→恢复→笔记还在」 |
| 1.3 | **分页** **✅**              | `book_list` 返回全量，几千本时首屏和分组都会卡                       | `BookQuery` 加 `limit`/`offset` + `repository::count`；工具服务按页取；书架仍取全量（见 §0 的数字）              |
| 1.4 | **批量元数据编辑**（已移除） | 批量栏现在只能收藏/标签/删除                                         | 曾做过批量改出版社/语言；2026-11-15 移除，理由见 §0 Phase 1.4。补全信息与单本编辑已覆盖这两个字段                |
| 1.5 | **重复检测** ✅              | SHA256 已在导入时拦住完全一致；剩下 ISBN / 标题精确相等              | 只读报告 + 放大镜跳回书架，**不做自动合并**；「切副标题」在真实库被证伪，见 §0                                   |
| 1.6 | **操作日志** **✅**          | 1.4 的撤销依赖它                                                     | 迁移 23 `operations` 表（时间/来源/动作/书/一句话）；UI 与 MCP 两侧都写；设置 › 操作记录可读                     |

**Phase 1 出口**：删书能撤回；元数据改动能在操作记录里看到并撤销；5000 本书首屏 < 300ms。

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

### Phase 4 — 插件

**4.1 权限 ✅**（11-14，见 §0）。**4.2 脚本层 / 4.3 Provider trait / 4.4 独立插件页 ✅**（11-20，用户明确要求启动，见 §0）。

### Phase 5 — Calibre（成本最高）

**5.1 只读扫描 ✅** → **5.2 预览入口 ✅** → **5.3 导入 ✅**（含 5.3b 大库 / 5.3c 格式偏好）→ **5.4 只读元数据探测 ✅** → **5.4b 官方 schema 校准 ✅** → **5.4c 无需真库的自验 ✅** → **5.4d 写入半 ✅** → **5.5 书单 CSV 导出 ✅ / 增量同步评估：不做 ✅**（见 §0）。Phase 5 提示词的七步到此收口。**永远不写用户的 `metadata.db`；写入只落在方册自己的库。**

### Phase 6 — AI 工作流

依赖 Phase 3 的工具层。核心是「先预览、再执行」：AI 出计划 → 展示影响范围 → 用户确认 → 执行 → 审计日志 → 报告。

**6.1 标签建议 ✅**（11-14，见 §0）：第一个走通这条链的切片。其余（元数据校正、笔记整理、跨书研究）已有非 AI 通路，需要时再按同一形状加。

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

## 4. 下一步（2026-11-14 复核，Phase 6.1 收口）

🔴 本节原来写的是 1.2 回收站与 3.1+3.2 MCP 只读，**两者都已完成**，留着会让接手的人走回头路。11-13 过了六项（Phase 3 出口验收见 `docs/mcp/MCP_SETUP.md`、5.1 扫描、5.2 预览、5.3 导入、5.3b 大库、5.3c 格式偏好），11-14 过了 **5.4 只读半 + 5.4b 官方 schema 校准 + 5.4c 无需真库的自验 + 5.4d 写入半 + 5.4d 真机往返 + 5.5 书单导出与增量同步评估**，以及 **Phase 4.1 书源主机权限**（均见 §0）。§0 各段里的「仍未做」是写下那一刻的快照，**当前真实待办以本节为准**：

1. **Phase 6 余项（按需）** —— 6.1 标签建议走通「建议 → 预览 → 应用 → 记账」并沉淀成 `tagging.rs` 的形状；**6.2 AI 补笔记（2026-11-15）** 照同一形状给「划了线但没笔记」的标注补草稿，只填空值、可撤销，见 §0。再加新动作仍照这个形状，不新造机制。**没有真实需求前不主动加**（6.2 是用户点名启动 Phase 6 后做的第一个切片）。
2. **Phase 4 全部已交付**（4.1 权限、4.2 脚本层、4.3 Provider trait、4.4 插件页、4.5 自定义来源，见 §0）。余项只有第 3 层隔离，等第 2 层被证明不够时再动。
3. **（可选补充，不阻塞）** 桌面版设置页「导出书单 CSV」**真机已销账**（2026-11-17：2386 本 / 512 KB，落盘 Downloads；Rust 落盘与组件行为均有测试）；真 Calibre 库并发打开时扫一次；评估 `document/pdf.rs::read_metadata` 对解析失败静默降级、让损坏 PDF 也能进书架这一既有行为。真机往返已用示例库走通，EPUB 导入已实测。

**5.5 校验记录（2026-11-14）**：`cargo fmt --all --check` / `cargo clippy --all-targets -- -D warnings` / `cargo test --lib` **793 passed（14 ignored）**；`prettier --check .` / `tsc --noEmit` / `oxlint .`（464 文件 0 warning）/ `vite build --no-emptyOutDir`；全量 `vitest run --maxWorkers=2` **127 个测试文件、退出码 0**（最终统计行随会话切换没留存；vitest 有失败会非 0，所以「全过」有据，具体条数不虚报）；e2e `settings-rail` + `backup` + `smoke` 双引擎 **18 passed**。

**有意不补的**：3.3 `ask_library` / `export_notes`（客户端本身就是模型，能自己 search + read；导出只是格式化）；3.6 任务层（当前没有后端长任务，为两个工具造任务注册表是 YAGNI）；3.7 设置页区块（等客户端真的连上再决定要展示什么）。理由见 §0 各段。

**文档分工**：`docs/audit/*` 是 11-10 的审计基线，不随功能更新；**本文件 §0 是进度的唯一出处**。
