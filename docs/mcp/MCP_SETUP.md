# 让外部 Agent 读方册（MCP）

方册可以把自己变成一个 MCP 工具服务，供 Claude Code、Claude Desktop、Cursor 等支持 MCP 的客户端调用。读的是同一份书库（`library.sqlite3` + `books/`），不需要导出、不需要同步。

**默认只读**。写工具存在，但只有被显式授予权限的连接才看得见。

## 启动方式

同一个可执行文件，加 `--mcp`：

```sh
# 开发时
/Users/<你>/Documents/Project/ColorReader/src-tauri/target/debug/fangce --mcp

# 安装后（macOS）
/Applications/方册.app/Contents/MacOS/fangce --mcp
```

stdin / stdout 走 newline-delimited JSON-RPC 2.0，日志走 stderr。**没有端口、没有 token**：能连上它的只有启动它的那个进程，这就是全部的授权模型。

## 客户端配置

Claude Code / Cursor 的 `mcpServers` 配置：

```json
{
  "mcpServers": {
    "fangce": {
      "command": "/Applications/方册.app/Contents/MacOS/fangce",
      "args": ["--mcp"]
    }
  }
}
```

书库不在默认位置时（第二份书库、便携安装、测试库），加环境变量：

```json
{
  "mcpServers": {
    "fangce": {
      "command": "/Applications/方册.app/Contents/MacOS/fangce",
      "args": ["--mcp"],
      "env": { "FANGCE_DATA_DIR": "/path/to/data" }
    }
  }
}
```

默认位置就是方册自己的数据目录（macOS：`~/Library/Application Support/dev.xlong.fangce`）。

## 工具

| 工具                  | 作用                                   | 需要的权限       | 参数                                                                               |
| --------------------- | -------------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `search_books`        | 按书名/作者检索书架                    | `search`         | `query?`、`limit?`（默认 20，上限 100）                                            |
| `get_book`            | 一本书的元数据与阅读进度               | `read`           | `id`                                                                               |
| `search_book_content` | 正文检索，返回章节号 + 字符偏移 + 片段 | `search`         | `query`、`book_id?`、`limit?`                                                      |
| `get_annotations`     | 一本书里所有高亮与批注                 | `read`           | `book_id`                                                                          |
| `get_bookmarks`       | 一本书里的书签                         | `read`           | `book_id`                                                                          |
| `update_metadata`     | 改元数据，**只改你给的字段**           | `write_metadata` | `id`、`title?`、`subtitle?`、`description?`、`language?`、`publisher?`、`authors?` |
| `manage_tags`         | 加/去标签                              | `write_metadata` | `id`、`add?`、`remove?`                                                            |
| `remove_books`        | 移到回收站（可恢复）                   | `delete`         | `ids`                                                                              |

`search_book_content` 的 `chapterIdx` + `offset` 与阅读器自己的「跳回原文」是同一组参数——前端就是 `features/search/snippet.ts::readerPathForHit()` 用 `book` / `chapter` / `q` / `at` / `s` 拼出 `/reader?...` 的。Agent 引用的每一句原文都能按这套参数回到原位核对，不需要另做一套定位。

## 权限：默认只读，按连接授予

**默认授予 `read,search`**——只读的工具全在，写工具连列表里都不出现（能看见却调不动的工具，Agent 会一直去调）。

要放开，在客户端的 `mcpServers` 里加环境变量：

```json
{
  "mcpServers": {
    "fangce": {
      "command": "/Applications/方册.app/Contents/MacOS/fangce",
      "args": ["--mcp"],
      "env": { "FANGCE_MCP_PERMISSIONS": "read,search,write_metadata" }
    }
  }
}
```

| 权限             | 覆盖                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `read`           | 看一本书：元数据、高亮、书签                                                                                       |
| `search`         | 跨库检索。与 `read` 分开：搜一次要扫所有书的正文，「只让它看我点名的那本」和「让它 grep 我整个书库」不是同一个同意 |
| `write_metadata` | 改元数据、改标签                                                                                                   |
| `delete`         | 把书移到回收站（**不是彻底删除**，可以恢复）                                                                       |

`all` 是简写。写错的名字会被忽略并记一行日志——拼错不该让服务起不来，而「拼错就什么都没给」是安全的失败方向。

权限是**每个连接**的事，不是应用设置：可以给一个 Agent 只读、给另一个改元数据的权限，两者互不影响。改了要重连才生效。

越权调用返回的不是协议错误，而是一条模型能读懂的结果：缺哪个权限、当前给了哪些、配置该怎么写（`"read,search,delete"`——建议里包含缺的那个，不是把现状回显一遍）。

## 写操作的审计

每一次写（`update_metadata` / `manage_tags` / `remove_books`）都会在书库的 `operations` 表里留一行，**按书一行**：

| 列                       | 内容                                                     |
| ------------------------ | -------------------------------------------------------- |
| `at`                     | Unix 秒                                                  |
| `source`                 | `mcp` 或 `ui`                                            |
| `action`                 | 工具名                                                   |
| `book_id` / `book_title` | 哪本书（书名是抄下来的，书被彻底删除后这一行仍然读得出） |
| `summary`                | 一句话，例如「改了书籍信息（MCP）」                      |

在应用里是**设置 › 操作记录**。读操作不留痕——这张表记的是「谁改了什么」，不是「谁看了什么」。

**元数据的改动可以撤销**：记录里存了改之前的出版社与语言，设置页那一行有「撤销」。Agent 改错了不用手动改回来。

一次批量改三十本会写三十行，它们共享同一个 `at` 和 `summary`，所以那次调用仍然看得出来是一次。

## 边界（重要）

- **连接的可写性跟着权限走**：只读授予拿到的是一把 `PRAGMA query_only = ON` 的句柄，所以即使工具层出错，也改不动一行。给了 `write_metadata` / `delete` 才是可写句柄——但那也只是能写**数据**，schema 迁移和 VACUUM 仍然只归应用管。
- **写操作只走 `library::*` 的业务函数**，工具层没有自己的 SQL。
- **回收站里的书看不见**。工具走的是 `books_live` 视图，和书架同一个口径。
- **不开迁移**。服务端进程不会跑 schema 迁移、不会 VACUUM——那是应用的事。书库还没建立时会明确报错，让你先打开一次方册。
- **不重写 SQL**。每个工具调的都是 UI 调的同一个 `library::*` 函数；工具层没有自己的查询，否则「书库」就有了两个定义。

## 自检

不接客户端也能验证：

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| ./src-tauri/target/debug/fangce --mcp
```

默认应当看到五个工具；加 `FANGCE_MCP_PERMISSIONS=all` 是八个。在真实书库上跑过：985 本书，`search_books` 返回 `total: 985`，`search_book_content` 返回带 `offset` 的片段。
