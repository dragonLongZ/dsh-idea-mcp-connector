# dsh-idea-mcp-connector

DSH（DeepSeek Harness）的 JetBrains IDE MCP 连接器：把本机所有在跑的 IntelliJ IDEA / PyCharm / GoLand… 的 MCP 工具聚合成 `mcp__idea__*`，并在**每次调用时按当前会话的工作目录**路由到对应项目的 IDE 窗口。

## 为什么需要它

IDEA 的 MCP Server 插件有三个现实约束：

1. **端口随机且不可固定**：`mcpServer.xml` 只有启用开关，没有端口配置项；每次启动端口可能变化。
2. **没有可发现的锁文件**：不像 Claude Code 的 IDE 集成会写 `~/.claude/ide/<port>.lock`，MCP Server 不写任何映射文件。唯一稳定的线索是 `idea.log` 里的 `io.ktor.server.Application - Responding at http://127.0.0.1:<port>`。
3. **MCP 端点不等于项目**：一个 IDEA 进程可以打开多个项目，共用一个 MCP 端点；`dsh-mcp-client` 只能静态配置一个 URL，模型无法知道「这个会话该连哪个窗口」。

这个插件解决第 3 点：不靠「会话级连接」，而靠 **每次请求携带项目路径**。IDEA 的 MCP 服务支持两种携带方式：

- 每个工具 schema 上的隐式参数 `projectPath`：**严格模式**，路径必须对应已打开项目，否则返回 `doesn't correspond to any open project`；
- HTTP 请求头 `IJ_MCP_SERVER_PROJECT_PATH`：**软提示**，解析不到时会静默退回 IDE 的默认项目（实测 IDEA 2026.2 行为）。

连接器两种都发，但**以参数为准**——这是实测确认的唯一严格路由方式。于是：一个 IDE 进程多开项目也能正确分流；多个 IDE 进程/产品时，先探测哪个端点打开了该项目，再在该端点上发起严格调用。

## 能力

- **自动发现**：扫描各产品 `idea.log`（含 `idea.1.log` 等轮转文件）的 `Responding at` 行；日志里没有时按端口步长探测（默认 64342 起、步长 10）。
- **协议握手验证**：普通 Ktor 端口、已关闭的 IDE 会被 MCP `initialize` 过滤掉，不会污染工具列表。
- **工具透传**：IDE 工具以 `mcp__idea__<原工具名>` 注册，schema/description 原样保留；`projectPath` 参数对模型隐藏并由连接器注入。
- **按会话路由**：多端点时用只读工具探测项目归属，结果按 cwd 缓存；真实调用报「项目不存在」或连接断开时自动失效重试。
- **常驻排障工具**：`idea_status` / `idea_refresh` / `idea_call`，IDE 没开时也能用。
- **IDE 重启自愈**：周期性重扫（默认 30s），端口变化后自动恢复；也可以手动 `idea_refresh`。

## 安装

插件是纯 ESM、零第三方依赖的 DSH Host bundle，推荐用 `plugin_manager` 安装：

```text
plugin_manager action=install_bundle target=D:\plugins\dsh-idea-mcp-connector
```

或者手工把包 link 进 profile（与 `dsh-integration-env` 相同的方式）：

```bash
# 在 profile 目录（$DSH_HOME/profiles/web）执行
pnpm add link:D:/plugins/dsh-idea-mcp-connector
```

然后确认 profile 的 `cordis.patch.yml` 里出现了 bundle（`install_bundle` 会自动完成这一步；手工 link 时需要自己把 bundle 加进 `dsh.profile.bundles`）。

安装后重启 `dsh web`（或等 HMR）即可；插件行配置在 `cordis.patch.yml`：

```yaml
- insert:
    - id: idea-mcp-connector
      name: dsh-idea-mcp-connector
      config: {}
```

## 使用

1. 打开 JetBrains IDE，确认 `Settings → Tools → MCP Server` 已启用。
2. 在 DSH 里新建/继续会话，工作目录设为该项目（或项目子目录）。
3. 直接让模型使用 IDE 能力，例如「用 IDEA 列出当前项目模块」「检查这个文件的编译问题」——模型会调用 `mcp__idea__*`，连接器自动带上当前会话的项目路径。
4. IDE 刚启动或工具列表缺失时，让模型调用 `idea_status` 或 `idea_refresh`。

### 工具

| 工具 | 作用 |
| --- | --- |
| `mcp__idea__<tool>` | IDE 原生 MCP 工具（如 `get_project_modules`、`get_file_problems`、`build_project`…），按会话 cwd 路由 |
| `idea_status` | 查看端点、已注册工具、当前会话项目与路由缓存 |
| `idea_refresh` | 强制重新扫描端点、重新同步工具列表 |
| `idea_call` | 用原始工具名 + JSON 参数直接调用（`mcp__idea__*` 尚未注册或工具被过滤时的兜底） |

## 配置

全部字段可选；写在 bundle 行的 `config:` 下。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `serverName` | `idea` | 工具名前缀，`mcp__<serverName>__*`，需匹配 `[A-Za-z0-9_-]{1,32}` |
| `endpoint` | 空 | 显式指定一个端点（如 `http://127.0.0.1:64342/stream`）；设置后不再自动扫描 |
| `endpoints` | `[]` | 显式端点列表，元素可为 URL 字符串或 `{ url, product, token, projectPath }` |
| `projects` | `[]` | 手工映射 `{ path, url }`；最长路径前缀优先，命中后不再探测 |
| `logRoots` | `[]` | 额外的 JetBrains 日志根目录（默认按平台：`%LOCALAPPDATA%\JetBrains` 等） |
| `streamPath` | `/stream` | MCP Streamable HTTP 路径 |
| `portProbe` | `{ enabled: true, base: 64342, step: 10, count: 4 }` | 日志里没候选时的端口探测范围 |
| `connectTimeoutMs` | `1500` | 单个候选端点的握手超时 |
| `toolCallTimeoutMs` | `120000` | 单次 IDE 工具调用超时（构建类工具需要更长） |
| `refreshIntervalMs` | `30000` | 端点/工具自动重扫间隔，`0` 关闭 |
| `discoveryCacheMs` | `10000` | 发现结果缓存，避免每次调用都扫日志 |
| `toolListTtlMs` | `60000` | IDE 工具列表缓存时间；到期后重新 `tools/list`，IDE 新增/禁用工具会自动生效 |
| `mappingTtlMs` | `300000` | cwd → 端点的路由缓存有效期 |
| `includeTools` / `excludeTools` | `[]` | 工具名通配（`*`、`?`）过滤；include 非空时仅保留匹配项 |
| `probeTools` | `[get_project_modules, get_all_open_file_paths]` | 用于判断端点是否打开某项目的只读工具，按顺序取第一个可用的 |
| `projectPathArg` | `projectPath` | IDE 的隐式项目参数名（一般不用改） |
| `injectProjectPath` | `true` | 是否把项目路径写进工具参数（请求头始终会带） |
| `maxResultChars` | `120000` | 单次工具结果最大字符数 |
| `debug` | `false` | 输出发现/同步的调试日志 |

### 配置示例

只连一个项目、固定端点：

```yaml
config:
  endpoint: 'http://127.0.0.1:64342/stream'
  toolCallTimeoutMs: 180000
```

双开 IDE 且项目经常同时打开，直接固定映射（跳过探测）：

```yaml
config:
  endpoints:
    - { url: 'http://127.0.0.1:64342/stream', product: 'IntelliJ IDEA (ruoyi)' }
    - { url: 'http://127.0.0.1:64352/stream', product: 'IntelliJ IDEA (beicai)' }
  projects:
    - { path: 'D:/ideaProject/cyf-ruoyi-product2.0', url: 'http://127.0.0.1:64342/stream' }
    - { path: 'D:/ideaProject/cyf-smart-city-closed-parking-place-beicai', url: 'http://127.0.0.1:64352/stream' }
```

控制上下文开销，只暴露分析类工具：

```yaml
config:
  includeTools: ['get_project_*', 'get_file_problems', 'build_project', 'search_*']
```

## 工作原理

```text
idea.log ──Responding at :port──► 候选端点 ──MCP initialize──► 连接池
                                                              │
                 tools/list ──► mcp__idea__<tool> 注册（schema 去掉 projectPath）
                                                              │
会话 A cwd=D:/work/a ─┐                                       │
会话 B cwd=D:/work/b ─┴─► 选择端点（单端点直接用 / 多端点探测 / config.projects 固定）
                              │
                              ▼
                 tools/call + projectPath=<cwd>（严格，主路由）
                 + IJ_MCP_SERVER_PROJECT_PATH 头（软提示，辅助）
                              │
                              ▼
                     IDE 按路径路由到项目窗口
```

探测判定：带项目路径**参数**调用 `probeTools` 里的只读工具。返回「项目不存在」→ 该端点没打开项目；其他情况（包括工具自身的业务错误）→ 视为已打开。只带请求头探测是不够的：IDE 会退回默认项目，看起来「成功」但可能连错窗口。注意真实 IDE 把这类预期错误放在 **HTTP 200 + `result.isError=true`** 里，连接器会把它转成失败再参与判定。

### 超时与重试

- 单次工具调用的客户端超时（`toolCallTimeoutMs`）比 DSH 工具级超时早 5 秒触发，保证报错可诊断。
- 超时和用户取消都**不会重试**：IDE 可能已经执行了 `create_new_file` / `apply_patch` 这类非幂等操作，重发会造成重复生效。
- 只有确定「请求没送达」的连接类错误（如端口拒绝）才会标记端点断开、重新发现并重试一次。

### 日志

每个产品从最新的 `idea.log` 开始，最多回看 3 个轮转文件（`idea.1.log`…），并按日志内时间戳取最近一次启动；文件大小与 mtime 未变时复用上次解析结果，不会周期性重复读 4MB。

## 验证

已在 IntelliJ IDEA 2026.2.1（MCP Server 262.9437.185）上做过真机验证：

- 从 `idea.log` 自动发现端口 64342，MCP 握手协议 2025-06-18；
- 列出 52 个 IDE 工具，全部带 `projectPath` schema 参数；注册为 `mcp__idea__*` 后 schema 中该参数已隐藏；
- 以会话 cwd `D:\ideaProject\cyf-ruoyi-product2.0` 调用 `get_project_modules` 返回真实模块列表；
- 以未打开的项目路径调用时，IDE 返回 HTTP 200 + `result.isError`，连接器正确转成 `idea-project-not-found` 并给出可执行提示；
- 真实 IDEA 端点 + 假端点并存时，两个会话分别路由到各自端点，探测只把命中项目的端点当成候选。

日常验证步骤：

1. 安装后打开任一 IDE，`idea_status` 应列出端点与工具数量。
2. 两个项目各开一个会话，分别问「列出当前项目模块」，应得到不同结果。
3. 关掉 IDE 后调用工具，应收到明确的连接错误；重新打开后 `idea_refresh` 可恢复。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `idea_status` 显示 0 个端点 | 确认 IDE 已启动、MCP Server 已启用；看 `idea.log`（或轮转文件）是否有 `Responding at`；用 `idea_refresh` |
| 工具能列出但调用报「doesn't correspond to any open project」 | 提高会话工作目录的准确性，或在 IDEA 里打开该项目；多 IDE 时可用 `config.projects` 固定 |
| IDE 新增的工具没出现 | 等 `toolListTtlMs`（默认 60s）到期，或 `idea_refresh` |
| 某次 `tools/list` 失败后工具消失 | 当前实现会沿用上一份工具列表，不应消失；若持续失败，看 `idea_status` 的 warnings |
| 工具调用超时 | 调大 `toolCallTimeoutMs`；超时不会自动重试，避免非幂等工具重复执行 |
| 端口变了 | 等自动重扫（默认 30s）或 `idea_refresh`；显式配置的 `endpoint` 不会自动改端口 |
| 工具名冲突 / 注册失败 | 不要同时用 `dsh-mcp-client` 以同名 `serverName` 挂载 IDEA；改 `serverName` |

## 已知限制

- **只支持 Streamable HTTP**（`/stream`）。旧版纯 SSE 端点需要 `mcp-remote` 之类桥接。
- **严格路由依赖 `projectPath` 参数**：旧版 MCP Server 若工具 schema 未声明该参数，只能退回请求头软提示，多项目窗口下可能落到默认项目；此时可用 `config.projects` + 单端点配置，或在 IDE 里激活目标项目。
- **图片/音频结果**会以文字说明省略，不进入附件存储。
- **多端点探测是启发式**：两个 IDE 都打开同一项目时，只会选第一个，可用 `config.projects` 固定。
- **会话关闭**：真实 IDE 对 `DELETE /stream` 返回 404，连接器关闭时无法主动释放 IDE 侧 session；IDE 侧会随 IDE 退出回收。
- 不读取、不保存任何 IDE token；若 IDE 要求鉴权，可在 `endpoints[].token` 里显式提供（会作为 `IJ_MCP_AUTH_TOKEN` 请求头发送）。

## 开发

```bash
npm test          # node --test，含假 MCP 服务端到端用例
```

目录：

```text
index.js             插件入口（apply / inject / 系统提示 / 周期重扫）
lib/config.js        配置默认值与校验
lib/log-scan.js      idea.log 扫描与端口解析
lib/mcp-http.js      零依赖 MCP Streamable HTTP 客户端
lib/discovery.js     端点发现、握手、连接池、工具列表缓存
lib/router.js        按 cwd 选择端点 + projectPath 注入
lib/runtime.js       发现→同步→路由的编排与工具生命周期
lib/tools.js         元工具与 mcp__idea__* 代理工具构造
test/                假 MCP 服务、fake ctx、单元/集成测试
```

协议细节来自 IDEA `mcpserver.jar` 的实现（`McpServerService`、`McpProjectLocationInputs`、`Schema_utilKt`）与真实 `idea.log` 观测；修改协议相关逻辑前建议先跑 `npm test`。
