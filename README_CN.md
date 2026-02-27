<div align="center">

# 🚀 Tabby-MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Tabby Plugin](https://img.shields.io/badge/Tabby-Plugin-purple.svg)](https://tabby.sh/)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol-orange.svg)](https://modelcontextprotocol.io/)
[![GitHub Release](https://img.shields.io/github/v/release/neighbads/Tabby-MCP?color=green)](https://github.com/neighbads/Tabby-MCP/releases)
[![AI Generated](https://img.shields.io/badge/AI%20生成-95%25-ff69b4.svg)](#-关于本项目)

**Tabby 终端的全功能 MCP 服务器插件**

*将 AI 助手连接到您的终端 — 35 个 MCP 工具，包含 SFTP 支持*

[English](README.md) | [中文](README_CN.md)

</div>

---

> 🚀 **Tabby-MCP** 是专为 [Tabby Terminal](https://github.com/eugeny/tabby) 打造的强力插件，旨在弥合 AI Agent 与终端环境之间的鸿沟。它提供了标准化的 MCP 接口，让 AI 能够安全地执行命令、管理标签页并处理文件操作。
>
> *让你的 AI 拥有操作终端的“双手”。*

<div align="center">
  <img src="assets/tabby-mcp-intro.gif" width="100%" alt="Tabby-MCP Intro">
</div>

---

## ✨ 功能特性

<table width="100%">
  <tr>
    <td width="50%" align="center" valign="top">
      <h3>🖥️ 终端控制</h3>
      <ul align="left">
        <li>执行命令并捕获输出</li>
        <li><b>稳定会话 ID</b> (v1.1+)</li>
        <li>读取终端缓冲区内容</li>
        <li>中止正在运行的命令</li>
        <li>发送交互式输入</li>
      </ul>
    </td>
    <td width="50%" align="center" valign="top">
      <h3>📑 标签页管理</h3>
      <ul align="left">
        <li>创建/关闭/复制标签页</li>
        <li><b>分割窗格</b>（水平/垂直）</li>
        <li>在标签页之间导航</li>
        <li>左右移动标签页</li>
        <li>重新打开已关闭的标签页</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <h3>🔗 配置文件管理</h3>
      <ul align="left">
        <li>列出所有终端配置文件</li>
        <li>使用配置文件打开新标签页</li>
        <li>SSH 快速连接</li>
        <li><b>新增/删除配置文件</b></li>
      </ul>
    </td>
    <td width="50%" align="center" valign="top">
      <h3>📁 SFTP 操作 (v1.1+)</h3>
      <ul align="left">
        <li>列出/读取/写入远程文件</li>
        <li>创建/删除目录</li>
        <li>重命名/移动文件</li>
        <li><b>HTTP 流式传输</b></li>
        <li><i>（需要 tabby-ssh）</i></li>
      </ul>
    </td>
  </tr>
</table>

<div align="center">
  <h3>🔒 安全特性</h3>
  <p>结对编程模式（命令确认对话框） • 完善的日志记录 • 安全的命令执行</p>
</div>

---

## 📦 安装

### 方法一：Tabby 插件管理器（最简单）

在 Tabby 内置插件管理器中搜索 `tabby-mcp-server`：

1. 打开 Tabby → **设置** → **插件**
2. 搜索 `tabby-mcp-server`
3. 点击 **安装**
4. 重启 Tabby

---

### 方法二：快速安装脚本

**无需 Node.js！** 从 GitHub 下载预构建版本。

<details open>
<summary><b>🍎 macOS / 🐧 Linux</b></summary>

```bash
curl -fsSL https://raw.githubusercontent.com/neighbads/Tabby-MCP/main/scripts/install.sh | bash
```

或下载后运行：
```bash
wget https://raw.githubusercontent.com/neighbads/Tabby-MCP/main/scripts/install.sh
bash install.sh
```

</details>

<details>
<summary><b>🪟 Windows (PowerShell)</b></summary>

```powershell
irm https://raw.githubusercontent.com/neighbads/Tabby-MCP/main/scripts/install.ps1 | iex
```

或下载后运行：
```powershell
Invoke-WebRequest -Uri https://raw.githubusercontent.com/neighbads/Tabby-MCP/main/scripts/install.ps1 -OutFile install.ps1
.\install.ps1
```

</details>

---

### 方法三：从源码构建

需要 **Node.js 18+**。

```bash
# 克隆仓库
git clone https://github.com/neighbads/Tabby-MCP.git
cd Tabby-MCP

# 构建并安装
bash scripts/build-and-install.sh
```

或手动操作：
```bash
npm install --legacy-peer-deps
npm run build
# 然后将 dist/ 和 package.json 复制到 Tabby 插件目录
```

---

### 🔄 安装后

1. **重启 Tabby**
2. 进入 **设置 → MCP**
3. 启动 MCP 服务器

---

## 🔌 连接 AI 客户端

### Cursor / Windsurf

添加到 `~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "Tabby MCP": {
      "type": "sse",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

### 其他客户端

| 端点 | URL | 协议版本 |
|------|-----|----------|
| Streamable HTTP | `http://localhost:3001/mcp` | 2025-03-26 (推荐) |
| Legacy SSE | `http://localhost:3001/sse` | 2024-11-05 |
| SFTP 上传 | `POST http://localhost:3001/api/sftp/upload` | HTTP 流式传输 |
| SFTP 下载 | `GET http://localhost:3001/api/sftp/download` | HTTP 流式传输 |
| 健康检查 | `http://localhost:3001/health` | - |
| 服务器信息 | `http://localhost:3001/info` | - |

---

## 🛠️ 可用工具

### 终端控制（7 个）

| 工具 | 说明 |
|------|------|
| `get_session_list` | 列出所有终端会话（**包含稳定 UUID**） |
| `exec_command` | 执行命令（支持多种定位方式） |
| `send_input` | 发送交互式输入 (Ctrl+C 等) |
| `get_terminal_buffer` | 读取终端缓冲区（默认使用活跃会话） |
| `abort_command` | 中止正在运行的命令 |
| `get_command_status` | 监控活动命令状态 |
| `focus_pane` | 聚焦分割视图中的特定窗格 |

> **v1.1 新功能**: 所有终端工具支持灵活定位：
> - `sessionId`（稳定 UUID，推荐）
> - `tabIndex`（传统方式，可能变化）
> - `title`（部分匹配）
> - `profileName`（部分匹配）
> - 无参数 = 使用活跃会话

### 标签页管理（11 个）

| 工具 | 说明 |
|------|------|
| `list_tabs` | 列出所有打开的标签页（**包含稳定 ID**） |
| `select_tab` | 选中指定标签页 |
| `close_tab` | 关闭标签页 |
| `close_all_tabs` | 关闭所有标签页 |
| `duplicate_tab` | 复制标签页 |
| `split_tab` | **分割窗格**（左/右/上/下） |
| `next_tab` / `previous_tab` | 导航标签页 |
| `move_tab_left` / `move_tab_right` | 移动标签页 |
| `reopen_last_tab` | 重新打开已关闭的标签页 |

### 配置文件管理（5 个）

| 工具 | 说明 |
|------|------|
| `list_profiles` | 列出终端配置文件 |
| `open_profile` | 使用配置文件打开标签页 |
| `quick_connect` | SSH 快速连接 |
| `add_profile` | 新增配置文件 |
| `del_profile` | 删除配置文件 |

### SFTP 操作（12 个）🆕

> 需要 `tabby-ssh` 插件。如未安装，SFTP 工具自动禁用。

**基础操作：**

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `sftp_list_files` | 列出远程目录 | `path` |
| `sftp_read_file` | 读取远程文件（文本） | `path` |
| `sftp_write_file` | 写入文本到远程文件 | `path`, `content` |
| `sftp_mkdir` | 创建远程目录 | `path` |
| `sftp_delete` | 删除远程文件/目录 | `path` |
| `sftp_rename` | 重命名/移动远程文件 | `sourcePath`, `destPath` |
| `sftp_stat` | 获取文件/目录信息 | `path` |

**文件传输（支持同步/异步）：**

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `sftp_upload` | 上传本地文件 → 远程 | `localPath`, `remotePath`, `sync` |
| `sftp_download` | 下载远程 → 本地文件 | `remotePath`, `localPath`, `sync` |
| `sftp_get_transfer_status` | 查询传输进度 | `transferId` |
| `sftp_list_transfers` | 列出所有传输 | `status`（过滤） |
| `sftp_cancel_transfer` | 取消活跃传输 | `transferId` |

> **传输模式**：`sync=true`（默认）等待完成。`sync=false` 立即返回 `transferId`。
>
> **大小限制**：可在设置 → MCP → SFTP 中配置。

### HTTP 流式传输

跨机器场景下（MCP 客户端在设备 A，Tabby 在设备 B，远程服务器 C），文件可通过 HTTP 直接流式传输，设备 B 上无需临时文件。

**上传** (A → B → C)：
```bash
# 原始二进制
curl -X POST "http://<tabby主机>:3001/api/sftp/upload?remotePath=/tmp/file.txt&sessionId=xxx" \
  --data-binary @/local/file.txt -H "Content-Type: application/octet-stream"

# Multipart 表单
curl -X POST "http://<tabby主机>:3001/api/sftp/upload?remotePath=/tmp/file.txt&sessionId=xxx" \
  -F "file=@/local/file.txt"
```

**下载** (C → B → A)：
```bash
curl -o file.txt "http://<tabby主机>:3001/api/sftp/download?remotePath=/tmp/file.txt&sessionId=xxx"
```

> **跨机器提示**：当 `sftp_upload` 检测到本地文件不存在（跨机器场景）时，会返回可直接使用的 curl 命令。`sftp_download` 的响应中包含 `httpDownloadUrl` 和 `httpDownloadCurl` 字段。
>
> **远程调用地址**：在设置 → MCP 中配置，用于生成上述提示中的 URL（自动检测本机 IP）。

---

## ⚙️ 配置选项

| 设置 | 说明 | 默认值 |
|------|------|--------|
| 端口 | MCP 服务器端口 | 3001 |
| 远程调用地址 | 跨机器访问时使用的 URL（自动检测本机 IP） | `http://<本机IP>:3001` |
| 启动时运行 | 自动启动服务器 | true |
| 结对编程模式 | 执行前确认 | true |
| 会话跟踪 | 使用稳定 UUID | true |
| 后台执行 | 无需聚焦执行 | false |
| SFTP 启用 | 启用 SFTP 工具 | true |

---

## 🔄 后台执行模式

启用此模式允许 MCP 命令在**不切换焦点**的情况下执行。您可以继续在其他标签页工作，同时 AI 在后台执行命令。

**设置 → MCP → 后台执行**

> ⚠️ **风险提示：**
> - 你将无法实时看到命令执行过程
> - 如果你在目标终端输入时 AI 也在执行命令，输入会混乱
> - 对于分割窗格，命令发送到 `sessionId` 指定的窗格，而非聚焦的窗格
> - 危险命令可能在你不知情的情况下执行

> ✅ **建议：** 保持"结对编程模式"开启并启用确认对话框以确保安全。

---

## 📄 许可证

MIT 许可证 - 见 [LICENSE](LICENSE)

---

<div align="center">

由 [neighbads](https://github.com/neighbads) 用 ❤️ 制作

⭐ **如果觉得有用，请给个 Star！**

</div>
