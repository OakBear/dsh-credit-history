# 验收测试台

针对「积分历史已迁入右侧边栏」这一改动的真实浏览器验收脚本。它驱动的是
**正在运行的 dsh GUI**（默认 `http://127.0.0.1:3080`），不是 mock。

```powershell
cd verify
node accept.mjs     # 10 项：Tab 存在/标题/面板/图表/无 NaN/控件/折叠 + 设置页已移除
node gear.mjs       #  7 项：Tab 启用态 + 齿轮「功能设置」里的采样开关与间隔
node capture.mjs    # 截图：总览 / 悬停读数 / 窄栏自适应
```

退出码非 0 表示有断言失败，失败项会打印 `evidence`。

## 认证

`dsh web` 的 `?token=` 一次性口令只在该进程内有效，**进程一重启就失效**
（拿旧 token 访问会得到 `401 dsh web authentication required`）。因此测试台改用
可长期复用的签名 cookie：从 `$DSH_HOME/.credentials.yaml` 的
`client-connection/browser-session` 记录读取密钥，按
`dsh-auth-<sha256(authority)> / v1.<payload>.<hmac>` 现场签名（见 `lib/auth.mjs`）。
所以脚本可以跨 dsh 重启反复运行，不需要手工登录，也不会去重启用户的进程。

## 前置条件

- dsh GUI 正在运行，且已安装本插件与 `dsh-better-sidebar`。
- Playwright 1.61.1（脚本按其在本机的安装路径解析）与已下载的 chromium。
- 不要为了跑测试而重启 dsh：`client.js` 由 `dsh-client-hmr` 每 500ms 轮询，
  重新构建后浏览器即热更新。

## 注意事项

- 侧边栏会**持久化已打开的 Tab**。因此「Tab 已存在」可能表现为 Tab 条上的
  标签而非引导列表项——`accept.mjs` 两种形态都接受。
- 设置 → 侧边卡片中，卡片主体按钮（`cardMain`）是**启用/停用开关**，
  齿轮（`cardSettings`）才是「功能设置」，且仅在启用时渲染。误点主体会把
  Tab 关掉；`gear.mjs` 会检测并自动修复这种状态。
- 截图输出在 `out/`：`accept-report.json` / `accept-guide.json` / `accept-cards.json`
  是断言证据，`final-1-overview.png`、`final-2-hover.png`、`final-3-narrow.png` 是面板
  总览／悬停读数／窄栏自适应，`gear-*.png|json` 是齿轮设置面板。
