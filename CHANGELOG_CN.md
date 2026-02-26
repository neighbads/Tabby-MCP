# 更新日志

Tabby-MCP 的所有重要变更都将记录在此文件中。

## [1.4.0] - 2026-02-26

### 🆕 新增
- **HTTP 流式 SFTP 传输**：新增 `POST /api/sftp/upload` 和 `GET /api/sftp/download` 端点，支持跨机器文件传输（A → B → C），Tabby 主机上无需临时文件
  - 支持 `multipart/form-data` 和 `application/octet-stream` 两种上传模式
  - 上传（chunk 队列 + pause/resume）和下载（`drain` 事件）均支持背压控制
  - HTTP 传输任务在 Tabby UI 中可见
- **远程调用地址设置**：自动检测本机 IP，可在设置 → MCP 中配置
- **useHttpEndpoints 选项**：启用后，`sftp_upload`/`sftp_download` 直接返回 curl 命令，不再执行本地文件操作，适用于跨机器场景

### 🔧 修复
- 修复 HTTP 上传被提前取消的问题 — `req.on('close')` 在请求体接收完毕后就触发，现使用 `req.complete` 判断
- 修复标签标题未反映用户自定义标题的问题 — `get_session_list`、`list_tabs` 及标题匹配现优先使用 `customTitle`
- 修复 `/health` 和 `/info` 端点版本号硬编码为 `1.1.3` 的问题 — 现使用 package.json 中的 `PLUGIN_VERSION`

---

## [1.3.0] - 2026-02-04

### 🔧 修复
- **会话断开检测**：修复因类型检查错误导致的断开误报
  - `tab.destroyed` 是 `Subject<void>`（RxJS Observable），不是布尔值
  - 现在正确使用 `session.open === false` 检测断开
  - 影响 `exec_command`、`send_input` 和流捕获模式

### 🗑️ 移除
- **SFTP 高级调优**：移除无效的「分块大小」和「并发数」设置
  - 这些设置对 Tabby 基于 `russh` 的 SFTP 实现无效
  - 清理了 UI、类型定义和翻译文件（zh-CN、en-US）
- **fastPut/fastGet 检测代码**：移除针对不存在方法的过时检测逻辑
  - Tabby 的 SFTP 使用 `russh`，不支持这些优化

### ✏️ 变更
- **SFTP 大小描述**：修正翻译中的默认值
  - 从「默认：10 MB」修正为「默认：10 GB」以匹配实际配置
- **SFTP 取消**：添加 `cancelCallback` 绑定以支持正确的传输取消

### 🌐 国际化
- 更新 `zh-CN.json` 和 `en-US.json` 中的 SFTP 描述
- 移除 6 条高级调优相关的过时翻译条目

---

## [1.2.0] - 2026-01-22

### 新增
- 国际化支持（中文和英文）
- `open_profile` 现在直接返回 `sessionId`
- 增强 SSH 连接就绪检测

### 修复
- SFTP 上传/下载 schema 验证
- MCP 工具参数传递问题

---

## [1.1.5] - 2026-01-20

### 新增
- 所有 MCP 操作的完整日志记录
- SFTP 文件传输工具（上传、下载、列表、读取、写入等）

### 修复
- 命令输出截断问题
- 会话跟踪改进

---

## [1.1.0] - 首个 SFTP 版本

### 新增
- SFTP 工具类别（13 个工具）
- 稳定的会话 ID（基于 UUID）
- 长输出的流捕获模式
