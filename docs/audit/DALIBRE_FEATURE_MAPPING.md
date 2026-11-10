# dalibre → 方册 能力映射

> 参考项目：<https://github.com/djyde/dalibre>
> 本轮核实范围：仓库 README 的 Layout 一节与 Compatibility 一节（`raw.githubusercontent.com/djyde/dalibre/main/README.md`）。
> **尚未读的**：`internal/calibre`、`internal/catalog`、`internal/plugin`、`internal/mcp` 的具体实现。下表中凡标「待读源码」的，都是这一轮**没有**逐行确认的，写方案前必须补读，不得凭印象实现。

## 0. 一句话差异

**dalibre 是 Calibre 的前端；方册是自成一体的阅读器。**

- dalibre：Go + MyGo 原生 UI（无 webview、无 cgo、单二进制）；新库直接用 calibre 自己的 `metadata.db` schema（user_version 28）；注册 calibre 触发器要调用的 SQL 函数（`title_sort`、`uuid4`…）；书籍目录与文件遵循 calibre 命名（`Author/Title (id)/Title - Author.ext`，转写为 ASCII），改标题或第一作者时移动文件；编辑会写 `metadata.opf` 并标记 `metadata_dirtied`。
- 方册：Tauri + React + SQLite 自己的 schema；书籍导入是 `fs::copy` 进书库目录；身份是 `content_hash`；**永不写用户原始文件**。

结论：**dalibre 的设计可以借，数据模型不能借。** 任何「把方册改造成 calibre 库」的方案都等于推倒重写，且会破坏方册已有的笔记/进度/标注引用关系。

## 1. 能力映射

| dalibre 能力               | dalibre 实现（已核实/待读）                                                                           | 方册当前状态                                                                           | 需要开发    | 方册实现方式                                                                         | 优先级         |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------ | -------------- |
| Calibre 书库读写           | `internal/calibre`：schema、触发器函数、命名规则、CRUD、OPF（已核实存在，待读细节）                   | **无**                                                                                 | 是          | 独立 `library/calibre/` 适配层，只读优先；绝不改 `metadata.db`                       | P3             |
| 元数据管理                 | `internal/ebookmeta`：从 EPUB / MOBI/AZW3 / 文件名取标题、作者、封面                                  | 有 `document/*` 解析器，导入时已提取 title/authors/language/publisher/identifier/cover | 部分        | 复用现有解析器，补「导入后再识别」与字段级来源                                       | P1             |
| 元数据来源插件             | `plugins/googlebooks`、`plugins/neodb` 内置（已核实存在）                                             | **无**                                                                                 | 是          | `MetadataProvider` trait + 内置 Google Books / Open Library 适配；插件化留到 Phase 4 | P1             |
| 书源插件                   | `plugins/gutenberg` 内置；`cmd/dalibre-plugin` CLI；`sdk/` 提供 `dalibre.d.ts` + `plugin.schema.json` | 有 JSON 书源规则（`library/io/source.rs` + `commands/source.rs`）                      | 部分        | **保留现有 JSON 规则不动**；新增 Provider trait 时把现有规则包成第一个实现           | P3             |
| 插件运行时                 | `internal/plugin`：manifest、沙箱 JS 运行时、consent、打包（已核实存在，待读细节）                    | **无**                                                                                 | 是          | 见 §2 的三层分级，先做配置型（已有），脚本型后置                                     | P4             |
| MCP Server                 | `internal/mcp`：tools、call log、stdio bridge（已核实存在，待读细节）                                 | **无**（全仓 grep `mcp` 只命中 `pnpm-lock.yaml`）                                      | 是          | `src-tauri/src/mcp/`：工具注册表 → 权限层 → 复用 `library/*`                         | **P1（最高）** |
| 书库搜索 / 筛选 / 侧栏计数 | `internal/catalog`：search、filters、sorting、sidebar counts（**无 UI**）                             | 本轮新增结构化筛选 + facets；搜索已有；分组已有                                        | 部分        | 继续沿 `BookQuery` + `repository::facets` 扩展                                       | P1             |
| 封面缩略图                 | `internal/thumbs`：磁盘上的封面缩略图                                                                 | 无缩略图，直接读原封面                                                                 | 否（YAGNI） | 几十本不需要；上千本再说                                                             | —              |
| 删除进系统回收站           | README 明确写 Removed books go to the system Recycle Bin                                              | 硬删除（删书库副本，不删原文件）                                                       | 是          | 方案见 §3                                                                            | P1             |

## 2. 插件运行时：三层分级，别一上来就 QuickJS

dalibre 用沙箱 JS 是因为它的书源插件需要写逻辑。方册已经有 **JSON 书源规则**这一层，能覆盖「搜索 / 详情 / 章节 / 正文」四件事的绝大多数站点。所以：

| 层  | 形态                             | 方册现状 | 何时做                                       |
| --- | -------------------------------- | -------- | -------------------------------------------- |
| 1   | 配置型（JSON 规则）              | **已有** | 现在就能用                                   |
| 2   | 受限脚本（元数据来源、复杂站点） | 无       | 等有真实插件需求、且 Provider trait 稳定之后 |
| 3   | 独立进程 / WASM（高隔离）        | 无       | 只有当第 2 层被证明不够时                    |

**不要为了对齐 dalibre 而引入 QuickJS。** 引入前要先量：依赖体积、启动开销、调试成本、跨平台（macOS 签名后能否加载）。

## 3. 回收站：跟 dalibre 的差别在哪

dalibre 直接进系统回收站，因为它操作的是用户的 calibre 书库（文件本来就属于用户）。方册删的是**自己复制进书库的那一份**，所以两种做法都合理：

- **A（推荐，改动小）**：数据库软删除 `books.deleted_at`，文件留在书库目录。恢复 = 清 `deleted_at`。彻底删除才 unlink。
- **B（跟 dalibre 一致）**：`osascript`/`gio`/Recycle Bin API 把文件挪进系统回收站，数据库行直接删。恢复依赖系统 UI，跨平台三套实现。

A 的问题是 `FROM books` 出现在 13 个文件里（书签、标注、同步、RAG、统计），漏一处就会让回收站里的书「复活」到某个列表里。**做法：加一个 `books_live` 视图（`WHERE deleted_at IS NULL`），把读路径全部改到视图上，写路径仍走 `books`。** 这样漏改会被测试抓到，而不是靠人记。

## 4. MCP：dalibre 能抄的和不能抄的

能抄的思路：

- 工具注册表与调用日志分离（`tools` + `call log`）。
- **stdio bridge**：外部 Agent 用 stdio 连，不需要端口、不需要 token、不需要防火墙例外。这是桌面应用最省事的一条路，也最适合方册（本仓现在一个监听端口都没有）。
- 元数据编辑是「先建议、后应用」，不是直接写。

不能抄的：

- dalibre 的 MCP 直接坐在 calibre 的 schema 上，工具几乎就是 SQL。方册的工具必须落在 `library/*` 之上，否则权限、审计、级联删除都会绕过去。
- dalibre 的插件与 MCP 共用一套「consent」模型；方册的插件层还没建，**MCP 的权限不能等插件系统**，要单独先做（§8.4 的 read/search/export/write/delete 分级）。

## 5. 需要补读的源码（写方案前）

- `internal/calibre/metadata_sqlite.sql` —— calibre 的 schema 到底长什么样（决定映射表）。
- `internal/catalog/*` —— 它的 filter 表达方式是 SQL 拼接还是结构体（决定方册 `BookQuery` 要不要上更一般的条件树）。
- `internal/plugin/manifest.go` + `plugin.schema.json` —— 权限字符串的粒度。
- `internal/mcp/tools.go` —— 工具命名与参数形状，能对齐就对齐，方便 Agent 通用。
