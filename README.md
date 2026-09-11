# mybuddyRunner

`mybuddyRunner` 是 MyBuddy 的 GitHub Actions 控制仓库。MyBuddy、MyBuddy Core、mybuddyRS 源码，任务计划、Core 依赖和构建制品全部通过 `mybuddyUpdateServer` 传输；工作流不保存 GitLab、OSS 地址或对应凭据。

## GitHub 配置

在 GitHub Environment `MYBUDDY` 中配置三个 Environment secrets：

- `MYBUDDY_BUILD_SECRET`：在 Update Server 管理台创建。明文只在创建响应中显示一次，可设置到期时间或永不过期。
- `MYBUDDY_UPDATE_SERVER_URL`：Update Server 的 HTTPS 域名根地址，例如 `https://mybuddy.mingya.com.cn`，不附加 `/releases`、`/admin` 或渠道路径。
- `MYBUDDY_UPDATE_PUBLIC_KEYS`：Desktop 内置的 Ed25519 公钥 JSON，格式为 `{"key-id":"-----BEGIN PUBLIC KEY-----\\n..."}`。

四个 job 都显式绑定 `MYBUDDY` Environment。工作流不接受 dispatch 输入的服务器地址，避免构建密钥被发送到任意域名；公钥和按任务渠道生成的更新地址只注入 Desktop 打包步骤。

手工触发 `.github/workflows/build.yml` 时只输入管理台创建的 `bt_...` 任务 ID。

任务模式由 Update Server 决定：`core` 构建 `mybuddyCore`；`desktop` 构建 `mybuddy` 并使用任务绑定的已校验 Core 候选；`bundle` 先准备 Core，再将任务绑定的 Core 注入 Desktop。Update Server 按 Core commit 和目标平台保存 Core 构建缓存；命中缓存时即使选择了 Core，workflow 也跳过对应的 Rust 编译。Core 和 bundle 任务同时冻结并下载 GitLab `supermyba/mybuddyRS` 的 `v0.2.11` 源码，Cargo 通过本地 patch 使用它，不在构建期间从 GitHub 拉取 aionrs。

支持 `darwin-arm64`、`darwin-x64`、`windows-x64`、`windows-arm64`、`linux-x64`、`linux-arm64`。每个矩阵任务把制品直接上传到 Update Server 的任务暂存区。

## 本地校验

```bash
npm test
```
