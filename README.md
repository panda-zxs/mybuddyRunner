# mybuddyRunner

`mybuddyRunner` 是 MyBuddy 的 GitHub Actions 控制仓库。源码、任务计划、Core 依赖和构建制品全部通过 `mybuddyUpdateServer` 传输；工作流不保存 GitLab、OSS 地址或对应凭据。

## GitHub 配置

仓库只需要配置一个 Actions Secret：

- `MYBUDDY_BUILD_SECRET`：在 Update Server 管理台创建。明文只在创建响应中显示一次，可设置到期时间或永不过期。

另配置一个非敏感仓库变量 `MYBUDDY_UPDATE_SERVER_URL`，固定为 Update Server 的 HTTPS 根地址。工作流不接受可变服务器地址，避免构建密钥被发送到任意域名。

手工触发 `.github/workflows/build.yml` 时只输入管理台创建的 `bt_...` 任务 ID。

任务模式由 Update Server 决定：`core` 构建 `mybuddyCore`；`desktop` 构建 `mybuddy` 并使用任务绑定的已校验 Core 候选；`bundle` 先构建 Core，再将同一次运行的 Core 注入 Desktop。

支持 `darwin-arm64`、`darwin-x64`、`windows-x64`、`windows-arm64`、`linux-x64`、`linux-arm64`。每个矩阵任务把制品直接上传到 Update Server 的任务暂存区。

## 本地校验

```bash
npm test
```
