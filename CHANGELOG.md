# Changelog

All notable changes to Tabby-MCP will be documented in this file.

## [1.4.1] - 2026-02-27

### 🆕 Added
- **Profile Management tool category**: Extracted profile tools into standalone `ProfileManagementToolCategory`
  - New tools: `add_profile` (create profiles), `del_profile` (delete profiles)
  - Moved from TabManagement: `list_profiles`, `open_profile`, `quick_connect`
  - Removed `show_profile_selector` and `dismiss_dialog` from tool registration (code retained)
- **Comprehensive test script**: New `test/test-endpoints.ts` covering all 34 tools across 3 protocols
  - ToolCaller abstraction with shared test suites for HTTP REST, MCP Legacy SSE, and MCP Streamable HTTP
  - SSE polling model (50ms poll + chunkVersion change detection) replacing fixed-wait blocking

### 🔧 Fixed
- **del_profile**: `provider.deleteProfile()` has empty default implementation in tabby-core — now directly manipulates `config.store.profiles`
- **close_all_tabs**: Changed to close tabs individually via `app.closeTab()` to preserve reopen stack (previously `app.closeAllTabs()` bypassed it)
- **Terminal title**: `get_session_list` and `findByTitle` now prefer `parentTab.customTitle` for correct display

### ♻️ Changed
- **MCP connection architecture**: Replaced singleton McpServer with per-connection instances via `createServer()` factory
  - Streamable HTTP: Uses SDK `isInitializeRequest()`, SDK-generated sessionId, unified `transport.handleRequest()`
  - Legacy SSE: Per-connection server instances with `transport.onclose` cleanup
  - HTTP API endpoints registered inline in `registerToolCategory()` instead of separate `configureToolEndpoints()`
- **TabManagement simplified**: Removed profile tools and `ConfigService`/`ProfilesService`/`TerminalToolCategory` dependencies
- **mcpLogger**: `exportLogs()` output changed from JSON array to JSONL format (one JSON object per line)

---

## [1.4.0] - 2026-02-26

### 🆕 Added
- **HTTP streaming SFTP transfer**: New endpoints `POST /api/sftp/upload` and `GET /api/sftp/download` for cross-machine file transfer (A → B → C) without temp files on Tabby host
  - Supports `multipart/form-data` and `application/octet-stream` upload modes
  - Backpressure handling for upload (chunk queue with pause/resume) and download (`drain` event)
  - Transfer tasks visible in Tabby UI during HTTP transfers
- **Remote Call Address setting**: Auto-detects local IP, configurable in Settings → MCP
- **useHttpEndpoints option**: When enabled, `sftp_upload`/`sftp_download` return curl commands directly instead of performing local file operations, useful for cross-machine scenarios

### 🔧 Fixed
- HTTP upload premature cancel — `req.on('close')` was firing after body receipt, now uses `req.complete` guard
- Tab title not reflecting user customTitle — `get_session_list`, `list_tabs` and title matching now prefer `customTitle` over `title`
- Hardcoded version `1.1.3` in `/health` and `/info` endpoints — now uses `PLUGIN_VERSION` from package.json

---

## [1.3.0] - 2026-02-04

### 🔧 Fixed
- **Session disconnect detection**: Fixed false positive disconnection errors caused by incorrect type checking
  - `tab.destroyed` is a `Subject<void>` (RxJS Observable), NOT a boolean
  - Now correctly detecting disconnection via `session.open === false` only
  - Affects `exec_command`, `send_input`, and stream capture modes

### 🗑️ Removed
- **SFTP Advanced Tuning**: Removed non-functional "Chunk Size" and "Concurrency" settings
  - These settings had no effect with Tabby's `russh`-based SFTP implementation
  - Cleaned up UI, type definitions, and translations (zh-CN, en-US)
- **fastPut/fastGet detection code**: Removed obsolete detection logic for non-existent methods
  - Tabby's SFTP uses `russh` which doesn't support these optimizations

### ✏️ Changed
- **SFTP size descriptions**: Corrected default values in translations
  - Changed from "default: 10 MB" to "default: 10 GB" to match actual configuration
- **SFTP cancellation**: Added `cancelCallback` binding for proper transfer cancellation

### 🌐 i18n
- Updated both `zh-CN.json` and `en-US.json` with correct SFTP descriptions
- Removed 6 obsolete translation entries for Advanced Tuning section

---

## [1.2.0] - 2026-01-22

### Added
- i18n support (Chinese and English)
- `open_profile` now returns `sessionId` directly
- Enhanced SSH connection readiness detection

### Fixed
- SFTP upload/download schema validation
- MCP tool parameter passing issues

---

## [1.1.5] - 2026-01-20

### Added
- Comprehensive logging for all MCP operations
- SFTP file transfer tools (upload, download, list, read, write, etc.)

### Fixed
- Command output truncation issues
- Session tracking improvements

---

## [1.1.0] - Initial SFTP Release

### Added
- SFTP tool category (13 tools)
- Stable session IDs (UUID-based)
- Stream capture mode for long outputs
