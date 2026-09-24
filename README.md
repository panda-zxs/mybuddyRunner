# mybuddyRunner

`mybuddyRunner` 是 MyBuddy 的 GitHub Actions 控制仓库。MyBuddy 和 MyBuddy Core 源码，任务计划、Core 依赖和构建制品全部通过 `mybuddyUpdateServer` 传输；工作流不保存 GitLab、OSS 地址或对应凭据。

Windows 会把 GitLab ZIP 的单层根目录内容移动到短路径后再安装依赖，避免 Bun 的 `node_modules/.bun/...` 与 NSIS 模板路径超过传统 260 字符上限。该处理同时用于 Desktop 和 Core 源码。

## GitHub 配置

在 GitHub Environment `MYBUDDY` 中配置三个 Environment secrets：

- `MYBUDDY_BUILD_SECRET`：在 Update Server 管理台创建。明文只在创建响应中显示一次，可设置到期时间或永不过期。
- `MYBUDDY_UPDATE_SERVER_URL`：Update Server 的 HTTPS 域名根地址，例如 `https://mybuddy.mingya.com.cn`，不附加 `/releases`、`/admin` 或渠道路径。
- `MYBUDDY_UPDATE_PUBLIC_KEYS`：Desktop 内置的 Ed25519 公钥 JSON，格式为 `{"key-id":"-----BEGIN PUBLIC KEY-----\\n..."}`。

五个 job 都显式绑定 `MYBUDDY` Environment。工作流不接受 dispatch 输入的服务器地址，避免构建密钥被发送到任意域名；公钥和按任务渠道生成的更新地址只注入 Desktop 打包步骤。

手工触发 `.github/workflows/build.yml` 时只输入管理台创建的 `bt_...` 任务 ID。

任务模式由 Update Server 决定：`core` 构建 `mybuddyCore`；`desktop` 构建 `mybuddy` 并使用任务绑定的已校验 Core 候选；`bundle` 先准备 Core，再将任务绑定的 Core 注入 Desktop。所有平台的 Core 产物统一为 `mybuddy-core-{target}.zip`。Update Server 按 Core commit 和目标平台保存 Core 构建缓存；命中缓存时 workflow 跳过对应的 Rust 编译。Core 已将共用能力集成到自身，构建仅需 Core 和 Desktop 源码。

本 Runner 接受 schema 3 构建计划，要求 MyBuddyCore v0.2.2 或更新版本。部署时先升级 Update Server（生成新计划并移除退役源码配置），再切换 Runner；旧计划保持原摘要，不能交给新 Runner 重建。新建任务必须冻结包含本次改动的 Fork commit。Desktop 通过 `MYBUDDY_BACKEND_LOCAL_BUNDLE_DIR` 和 `MYBUDDY_BACKEND_VERSION` 接收任务绑定的 Core。

支持 `darwin-arm64`、`darwin-x64`、`windows-x64`、`windows-arm64`、`linux-x64`、`linux-arm64`。每个矩阵任务把制品直接上传到 Update Server 的任务暂存区。

## 构建执行与缓存

主工作流负责冻结计划、Core 验证和最终回传。每个目标调用 `platform.yml`，内部按该平台的 Core → Desktop 顺序执行；平台之间互不等待，仍由最终任务汇总判断全平台结果。已缓存 Core、已完成 Desktop 及单独构建模式都按平台决定是否跳过。

Desktop 的最终安装包版本由已冻结任务计划写入：UI 版本来自 GitLab Desktop tag，构建号由 Update Server 分配。源码根 `package.json` 的版本可能尚未随 tag 更新，Runner 在安装依赖后将其改为任务中的 `applicationVersion`；源码 commit 仍必须与任务计划一致。

- 验证成功记录绑定 Core commit、固定 Ubuntu 24.04、宿主系统/架构、工具链和验证脚本/配置/下载规则摘要。仅成功保存、仅精确命中；打包规则变化不再触发重复验证。缓存淘汰时重新验证。
- `core-verification.json` 管理工具链及编译配置；`verify-core.sh` 分别输出格式、Clippy、测试耗时，每分钟输出编译进程 CPU/内存摘要，失败立即退出。验证 job 限时 90 分钟，各平台 job 限时 120 分钟。
- Core 验证和发布的 Cargo 依赖缓存分别管理，源码使用稳定路径；测试失败也保留依赖缓存。Linux arm64 cross 只缓存宿主下载与工具，不缓存容器 target。
- Core 发布 ZIP 在平台校验后、上传前保存精确缓存；重试上传无需重新编译。键包含任务、Core commit、目标平台和 Runner 打包规则摘要。
- Desktop 整包缓存还绑定 Desktop/Core 来源、打包规则、应用版本与更新配置摘要，避免同任务修复打包逻辑后取回旧包。命中后跳过 Bun 安装和重新打包。
- Desktop 包下载（Bun/npm）与 Electron 工具下载分开缓存；按宿主系统、架构、目标和依赖版本隔离。仍执行 frozen-lockfile 安装，不缓存 node_modules。
- 源码/依赖下载最多尝试 4 次，每次最长 5 分钟、总体最多 10 分钟；计划请求每次 30 秒、总体 2 分钟。只重试暂时性网络/服务端故障，认证失败不重试；拒绝重定向，下载写入临时文件后再替换。摘要验证发生在重试之外，不重试校验失败。
- 不自动提高 Rust 编译并发；收集耗时和内存数据后再调整。首次缓存填充仍需冷编译，实际收益需后续 Actions 运行验证。

## 本地校验

```bash
npm test
```

Core 的格式、Clippy 和工作区测试由 `verify-core` job 执行，通过后才运行各平台发布构建。开发机不执行 Rust 编译或测试；正式构建任务均从 Update Server 创建和派发。
