/**
 * Tabby MCP - Comprehensive Endpoint & MCP Protocol Test Script
 *
 * Tests all 34 MCP tools and HTTP endpoints across three protocols:
 *   1. HTTP REST (/api/tool/*)
 *   2. MCP Legacy SSE (GET /sse + POST /messages)
 *   3. MCP Streamable HTTP (POST/GET/DELETE /mcp)
 *
 * Also tests SFTP HTTP streaming (upload/download) and tab management lifecycle.
 *
 * Usage:
 *   npx ts-node test/test-endpoints.ts [baseUrl]
 *
 * Example:
 *   npx ts-node test/test-endpoints.ts http://10.20.35.182:13001
 *   npx ts-node test/test-endpoints.ts                            # defaults to http://localhost:3001
 */

import * as http from 'http';
import * as https from 'https';

const BASE_URL = process.argv[2] || 'http://localhost:3001';
const parsed = new URL(BASE_URL);
const isHttps = parsed.protocol === 'https:';
const HOST = parsed.hostname;
const PORT = parseInt(parsed.port || (isHttps ? '443' : '80'), 10);

// Test directory with timestamp to avoid collisions
const TEST_TIMESTAMP = Date.now();
const TEST_DIR = `/tmp/tabby-mcp-test-${TEST_TIMESTAMP}`;

// ─── Colors ──────────────────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
};

// ─── Stats ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const results: { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; ms: number; detail?: string }[] = [];

// ─── Shared State ────────────────────────────────────────────────────────────
let sshSessionId: string | undefined;
let allSessionIds: string[] = [];

// ─── HTTP Helper ─────────────────────────────────────────────────────────────
function request(
    method: string,
    path: string,
    body?: any,
    headers?: Record<string, string>,
    timeoutMs = 10000
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
        const opts: http.RequestOptions = {
            hostname: HOST,
            port: PORT,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers,
            },
            timeout: timeoutMs,
        };

        const mod = isHttps ? https : http;
        const req = mod.request(opts, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers as Record<string, string>,
                    body: Buffer.concat(chunks).toString('utf-8'),
                });
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Timeout after ${timeoutMs}ms`));
        });
        req.on('error', reject);

        if (body !== undefined) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

/** Send raw Buffer body (for octet-stream upload) */
function requestRaw(
    method: string,
    path: string,
    body: Buffer,
    headers: Record<string, string>,
    timeoutMs = 10000
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const opts: http.RequestOptions = {
            hostname: HOST,
            port: PORT,
            path,
            method,
            headers: {
                ...headers,
                'Content-Length': body.length.toString(),
            },
            timeout: timeoutMs,
        };

        const mod = isHttps ? https : http;
        const req = mod.request(opts, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers as Record<string, string>,
                    body: Buffer.concat(chunks),
                });
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Timeout after ${timeoutMs}ms`));
        });
        req.on('error', reject);

        req.write(body);
        req.end();
    });
}

/** GET request returning raw Buffer (for download) */
function requestGetRaw(
    path: string,
    headers?: Record<string, string>,
    timeoutMs = 10000
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const opts: http.RequestOptions = {
            hostname: HOST,
            port: PORT,
            path,
            method: 'GET',
            headers: headers || {},
            timeout: timeoutMs,
        };

        const mod = isHttps ? https : http;
        const req = mod.request(opts, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers as Record<string, string>,
                    body: Buffer.concat(chunks),
                });
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Timeout after ${timeoutMs}ms`));
        });
        req.on('error', reject);
        req.end();
    });
}

function parseJson(str: string): any {
    try {
        return JSON.parse(str);
    } catch {
        return null;
    }
}

// ─── SSE Helper ──────────────────────────────────────────────────────────────

/** Parse SSE events from raw text */
function parseSseEvents(raw: string): { event?: string; data?: string }[] {
    const events: { event?: string; data?: string }[] = [];
    let current: { event?: string; data?: string } = {};
    for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) {
            current.event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            current.data = (current.data || '') + line.slice(5).trim();
        } else if (line.trim() === '' && (current.event || current.data)) {
            events.push(current);
            current = {};
        }
    }
    if (current.event || current.data) events.push(current);
    return events;
}

/**
 * Open an SSE connection to GET /sse.
 * Returns the messagesUrl and a function to read SSE events, plus a close handle.
 */
function openSseConnection(timeoutMs = 10000): Promise<{
    sessionId: string;
    messagesUrl: string;
    /** Poll rawChunks for a message event matching `id`, resolve as soon as found or after timeoutMs */
    waitForMessage: (id: number, timeoutMs: number) => Promise<any>;
    close: () => void;
    rawChunks: string[];
}> {
    return new Promise((resolve, reject) => {
        const rawChunks: string[] = [];
        let chunkVersion = 0; // incremented on each new chunk for fast change detection
        const mod = isHttps ? https : http;
        const req = mod.request(
            {
                hostname: HOST,
                port: PORT,
                path: '/sse',
                method: 'GET',
                headers: { Accept: 'text/event-stream' },
                timeout: timeoutMs,
            },
            (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`SSE connection failed: status ${res.statusCode}`));
                    return;
                }

                let buffer = '';
                let resolved = false;

                res.on('data', (chunk: Buffer) => {
                    const text = chunk.toString('utf-8');
                    buffer += text;
                    rawChunks.push(text);
                    chunkVersion++;

                    if (!resolved && buffer.includes('endpoint')) {
                        const events = parseSseEvents(buffer);
                        const endpointEvent = events.find(
                            (e) => e.event === 'endpoint' || e.data?.includes('/messages')
                        );
                        if (endpointEvent?.data) {
                            resolved = true;
                            // Disable socket idle timeout — SSE is long-lived
                            req.setTimeout(0);
                            const messagesPath = endpointEvent.data.trim();
                            const url = new URL(messagesPath, BASE_URL);
                            const sessionId = url.searchParams.get('sessionId') || '';
                            resolve({
                                sessionId,
                                messagesUrl: messagesPath,
                                rawChunks,
                                waitForMessage: (id: number, waitTimeoutMs: number) =>
                                    new Promise((res2) => {
                                        const deadline = Date.now() + waitTimeoutMs;
                                        let lastVersion = -1;
                                        const poll = () => {
                                            // Only re-parse when new chunks arrived
                                            if (chunkVersion !== lastVersion) {
                                                lastVersion = chunkVersion;
                                                const events = parseSseEvents(rawChunks.join(''));
                                                for (let i = events.length - 1; i >= 0; i--) {
                                                    const evt = events[i];
                                                    if (evt.event === 'message' && evt.data) {
                                                        const json = parseJson(evt.data);
                                                        if (json?.id === id) {
                                                            res2(json);
                                                            return;
                                                        }
                                                    }
                                                }
                                            }
                                            if (Date.now() < deadline) {
                                                setTimeout(poll, 50);
                                            } else {
                                                // Timeout — return last message event or null
                                                const events = parseSseEvents(rawChunks.join(''));
                                                const msgs = events.filter((e) => e.event === 'message' && e.data);
                                                if (msgs.length > 0) {
                                                    res2(parseJson(msgs[msgs.length - 1].data!));
                                                } else {
                                                    res2(null);
                                                }
                                            }
                                        };
                                        poll();
                                    }),
                                close: () => {
                                    req.destroy();
                                },
                            });
                        }
                    }
                });

                res.on('error', (err) => {
                    if (!resolved) reject(err);
                });
            }
        );

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`SSE connection timeout after ${timeoutMs}ms`));
        });
        req.on('error', reject);
        req.end();
    });
}

/** Send a JSON-RPC message via POST /messages?sessionId=xxx and poll for matching SSE response */
async function sendMcpMessage(
    messagesUrl: string,
    message: any,
    waitForMessage: (id: number, timeoutMs: number) => Promise<any>,
    timeoutMs = 10000
): Promise<any> {
    const res = await request('POST', messagesUrl, message, undefined, 10000);
    if (res.status >= 300) {
        throw new Error(`POST ${messagesUrl} returned ${res.status}: ${res.body.substring(0, 200)}`);
    }

    if (message.id !== undefined) {
        return waitForMessage(message.id, timeoutMs);
    }
    return null;
}

// ─── Streamable HTTP Helper ──────────────────────────────────────────────────

/** Send a POST to /mcp and read the SSE stream until we get a message event */
function mcpStreamableRequest(
    body: any,
    headers?: Record<string, string>,
    timeoutMs = 15000
): Promise<{ sessionId?: string; json: any }> {
    return new Promise((resolve, reject) => {
        const mod = isHttps ? https : http;
        const req = mod.request(
            {
                hostname: HOST,
                port: PORT,
                path: '/mcp',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    ...headers,
                },
                timeout: timeoutMs,
            },
            (res) => {
                if (res.statusCode && res.statusCode >= 300) {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => {
                        reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
                    });
                    return;
                }

                const sessionId = res.headers['mcp-session-id'] as string | undefined;
                let buffer = '';

                res.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString('utf-8');
                    const events = parseSseEvents(buffer);
                    const msgEvent = events.find((e) => e.event === 'message' && e.data);
                    if (msgEvent?.data) {
                        const json = parseJson(msgEvent.data);
                        if (json && (json.id !== undefined || json.result || json.error)) {
                            req.destroy();
                            resolve({ sessionId, json });
                        }
                    }
                });

                res.on('end', () => {
                    const events = parseSseEvents(buffer);
                    const msgEvent = events.find((e) => e.event === 'message' && e.data);
                    if (msgEvent?.data) {
                        resolve({ sessionId, json: parseJson(msgEvent.data) });
                    } else {
                        const json = parseJson(buffer);
                        if (json) {
                            resolve({ sessionId, json });
                        } else {
                            reject(new Error(`No message event in response: ${buffer.substring(0, 200)}`));
                        }
                    }
                });
            }
        );

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Timeout after ${timeoutMs}ms`));
        });
        req.on('error', (err) => {
            if ((err as any).code !== 'ECONNRESET') reject(err);
        });

        req.write(JSON.stringify(body));
        req.end();
    });
}

// ─── Tool Call Helpers ───────────────────────────────────────────────────────

/** Call a tool via HTTP REST /api/tool/* and return parsed inner result */
async function callTool(toolName: string, params: any = {}, timeoutMs = 10000): Promise<any> {
    const res = await request('POST', `/api/tool/${toolName}`, params, undefined, timeoutMs);
    if (res.status !== 200) return null;
    const json = parseJson(res.body);
    const text = json?.content?.[0]?.text;
    return text ? parseJson(text) : null;
}

/** Call a tool via MCP SSE protocol */
async function callToolViaSse(
    messagesUrl: string,
    waitForMessage: (id: number, timeoutMs: number) => Promise<any>,
    toolName: string,
    args: any,
    id: number,
    timeoutMs = 10000
): Promise<any> {
    const res = await sendMcpMessage(
        messagesUrl,
        {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: toolName, arguments: args },
        },
        waitForMessage,
        timeoutMs
    );
    if (!res) return null;
    const text = res.result?.content?.[0]?.text;
    return text ? parseJson(text) : null;
}

/** Call a tool via MCP Streamable HTTP protocol */
async function callToolViaStreamable(
    sessionId: string,
    toolName: string,
    args: any,
    id: number,
    timeoutMs?: number
): Promise<any> {
    const { json } = await mcpStreamableRequest(
        {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: toolName, arguments: args },
        },
        { 'mcp-session-id': sessionId },
        timeoutMs
    );
    if (!json) return null;
    const text = json.result?.content?.[0]?.text;
    return text ? parseJson(text) : null;
}

// ─── ToolCaller Abstraction ─────────────────────────────────────────────────

type ToolCaller = (toolName: string, params?: any, timeoutMs?: number) => Promise<any>;

function createSseToolCaller(
    messagesUrl: string,
    waitForMessage: (id: number, timeoutMs: number) => Promise<any>,
    idCounter: { value: number }
): ToolCaller {
    return async (toolName, params = {}, timeoutMs = 10000) => {
        return callToolViaSse(messagesUrl, waitForMessage, toolName, params, idCounter.value++, timeoutMs);
    };
}

function createStreamableToolCaller(
    sessionId: string,
    idCounter: { value: number }
): ToolCaller {
    return async (toolName, params = {}, timeoutMs?) => {
        return callToolViaStreamable(sessionId, toolName, params, idCounter.value++, timeoutMs);
    };
}

// ─── Test Runner ─────────────────────────────────────────────────────────────
let _testOutput: string[] = [];

function testLog(msg: string) {
    _testOutput.push(msg);
}

async function runTest(name: string, fn: () => Promise<void>) {
    _testOutput = [];
    if (STEP_MODE) {
        console.log(`\n  ${C.cyan}▶${C.reset} next: ${name}`);
        await waitForKey();
    }
    const start = Date.now();
    try {
        await fn();
        const ms = Date.now() - start;
        passed++;
        results.push({ name, status: 'PASS', ms });
        console.log(`  ${C.green}✓${C.reset} ${name} ${C.dim}(${ms}ms)${C.reset}`);
        _testOutput.forEach((l) => console.log(l));
    } catch (e: any) {
        const ms = Date.now() - start;
        failed++;
        const detail = e.message || String(e);
        results.push({ name, status: 'FAIL', ms, detail });
        console.log(`  ${C.red}✗${C.reset} ${name} ${C.dim}(${ms}ms)${C.reset}`);
        _testOutput.forEach((l) => console.log(l));
        console.log(`    ${C.red}${detail}${C.reset}`);
    }
}

function skip(name: string, reason: string) {
    skipped++;
    results.push({ name, status: 'SKIP', ms: 0, detail: reason });
    console.log(`  ${C.yellow}○${C.reset} ${name} ${C.dim}(skipped: ${reason})${C.reset}`);
}

function assert(condition: boolean, msg: string) {
    if (!condition) throw new Error(msg);
}

/** Small delay helper */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for keypress (single-step mode) */
const STEP_MODE = process.argv.includes('--step');
function waitForKey(prompt = 'Press any key to continue...'): Promise<void> {
    if (!STEP_MODE) return Promise.resolve();
    return new Promise((resolve) => {
        process.stdout.write(`  ${C.yellow}⏸ ${prompt}${C.reset}`);
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once('data', () => {
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
            process.stdout.write('\n');
            resolve();
        });
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared Test Suites
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Terminal Tools Suite (~8 tests)
 * Updates global sshSessionId and allSessionIds.
 */
async function runTerminalToolsSuite(call: ToolCaller, prefix: string) {
    console.log(`\n${C.bold}  ── ${prefix} Terminal Tools ──${C.reset}\n`);

    // get_session_list — extract sshSessionId and all sessionIds
    await runTest(`${prefix} get_session_list`, async () => {
        const inner = await call('get_session_list');
        assert(inner !== null, 'No response');
        let sessions: any[] = [];
        if (Array.isArray(inner)) {
            sessions = inner;
        } else if (inner?.sessions) {
            sessions = inner.sessions;
        }
        allSessionIds = sessions.map((s: any) => s.sessionId).filter(Boolean);
        sshSessionId = undefined;
        for (const s of sessions) {
            testLog(`    ${C.dim}session: ${s.sessionId?.substring(0, 8)}.. title="${s.title}" type=${s.type}${C.reset}`);
            if (s.type === 'SSHTabComponent' && !sshSessionId) {
                sshSessionId = s.sessionId;
            }
        }
        assert(sessions.length > 0, 'No sessions found');
        testLog(`    ${C.dim}total: ${sessions.length}, sshSession: ${sshSessionId ? 'found' : 'none'}${C.reset}`);
    });

    const realSessionId = sshSessionId || allSessionIds[0];

    // get_terminal_buffer — real session
    if (realSessionId) {
        await runTest(`${prefix} get_terminal_buffer (real session)`, async () => {
            const inner = await call('get_terminal_buffer', { sessionId: realSessionId });
            assert(inner !== null, 'No response');
            assert(inner.success !== undefined, 'Missing success field');
            testLog(`    ${C.dim}success=${inner.success}, lines=${inner.lines || inner.buffer?.split?.('\n')?.length || '?'}${C.reset}`);
        });
    } else {
        skip(`${prefix} get_terminal_buffer (real session)`, 'No sessions available');
    }

    // get_terminal_buffer — invalid session
    await runTest(`${prefix} get_terminal_buffer (invalid session)`, async () => {
        const inner = await call('get_terminal_buffer', { sessionId: '__nonexistent__' });
        assert(inner !== null, 'No response');
        assert(inner.success === false, 'Expected failure for invalid session');
        testLog(`    ${C.dim}error="${inner.error}"${C.reset}`);
    });

    // get_command_status
    await runTest(`${prefix} get_command_status`, async () => {
        const inner = await call('get_command_status');
        assert(inner !== null, 'No response');
        testLog(`    ${C.dim}active commands: ${inner.count || 0}${C.reset}`);
    });

    // exec_command, send_input, abort_command, focus_pane — require real session
    if (realSessionId) {
        await runTest(`${prefix} exec_command (echo tabby-mcp-test)`, async () => {
            const inner = await call('exec_command', {
                command: 'echo tabby-mcp-test',
                sessionId: realSessionId,
                waitForOutput: true,
                timeout: 10000,
            }, 15000);
            assert(inner !== null, 'No response');
            testLog(`    ${C.dim}success=${inner.success}, exitCode=${inner.exitCode}${C.reset}`);
            if (inner.output) {
                const hasMarker = inner.output.includes('tabby-mcp-test');
                testLog(`    ${C.dim}output contains marker: ${hasMarker}${C.reset}`);
                assert(hasMarker, 'Output does not contain expected marker "tabby-mcp-test"');
            }
        });

        await runTest(`${prefix} send_input`, async () => {
            const inner = await call('send_input', { input: 'tail\n', sessionId: realSessionId });
            assert(inner !== null, 'No response');
            testLog(`    ${C.dim}success=${inner.success}${C.reset}`);
        });

        await runTest(`${prefix} abort_command`, async () => {
            const inner = await call('abort_command', { sessionId: realSessionId });
            assert(inner !== null, 'No response');
            testLog(`    ${C.dim}success=${inner.success}${C.reset}`);
        });

        await runTest(`${prefix} focus_pane`, async () => {
            const inner = await call('focus_pane', { sessionId: realSessionId });
            assert(inner !== null, 'No response');
            testLog(`    ${C.dim}success=${inner.success}${C.reset}`);
        });
    } else {
        skip(`${prefix} exec_command (echo tabby-mcp-test)`, 'No sessions available');
        skip(`${prefix} send_input`, 'No sessions available');
        skip(`${prefix} abort_command`, 'No sessions available');
        skip(`${prefix} focus_pane`, 'No sessions available');
    }
}

/**
 * SFTP Tools Suite (~12 tests)
 * Uses global sshSessionId. Each section uses a different sftpSubDir.
 */
async function runSftpToolsSuite(call: ToolCaller, prefix: string, sftpSubDir: string) {
    console.log(`\n${C.bold}  ── ${prefix} SFTP Tools ──${C.reset}\n`);

    if (!sshSessionId) {
        const sftpTests = [
            'sftp_mkdir', 'sftp_write_file (test.txt)', 'sftp_stat (test.txt)', 'sftp_read_file (test.txt)',
            'sftp_rename', 'sftp_stat (renamed)', 'sftp_list_files', 'sftp_write_file (upload-test.txt)',
            'sftp_list_transfers', 'sftp_get_transfer_status (fake id)', 'sftp_cancel_transfer (fake id)', 'sftp cleanup',
        ];
        for (const t of sftpTests) skip(`${prefix} ${t}`, 'No SSH session');
        return;
    }

    const subDir = `${TEST_DIR}/${sftpSubDir}`;
    const sid = sshSessionId;

    // sftp_mkdir — create test directory (parent + child)
    await runTest(`${prefix} sftp_mkdir (test dir)`, async () => {
        let inner = await call('sftp_mkdir', { sessionId: sid, path: TEST_DIR });
        assert(inner !== null, 'No response');
        testLog(`    ${C.dim}parent: success=${inner.success}${C.reset}`);
        inner = await call('sftp_mkdir', { sessionId: sid, path: subDir });
        assert(inner !== null, 'No response');
        assert(inner.success === true, `mkdir failed: ${inner.error}`);
        testLog(`    ${C.dim}child: success=${inner.success}, path=${subDir}${C.reset}`);
    });

    // sftp_write_file — write test.txt
    await runTest(`${prefix} sftp_write_file (test.txt)`, async () => {
        const inner = await call('sftp_write_file', {
            sessionId: sid,
            path: `${subDir}/test.txt`,
            content: 'Hello Tabby MCP\n',
        });
        assert(inner !== null, 'No response');
        assert(inner.success === true, `write failed: ${inner.error}`);
        testLog(`    ${C.dim}success=${inner.success}${C.reset}`);
    });

    // sftp_stat — verify file exists and size
    await runTest(`${prefix} sftp_stat (test.txt)`, async () => {
        const inner = await call('sftp_stat', { sessionId: sid, path: `${subDir}/test.txt` });
        assert(inner !== null, 'No response');
        assert(inner.success === true, `stat failed: ${inner.error}`);
        assert(inner.exists === true, 'File does not exist');
        testLog(`    ${C.dim}exists=${inner.exists}, size=${inner.size}, isFile=${inner.isFile}${C.reset}`);
    });

    // sftp_read_file — read back and verify content
    await runTest(`${prefix} sftp_read_file (test.txt)`, async () => {
        const inner = await call('sftp_read_file', { sessionId: sid, path: `${subDir}/test.txt` });
        assert(inner !== null, 'No response');
        assert(inner.success === true, `read failed: ${inner.error}`);
        assert(inner.content === 'Hello Tabby MCP\n', `Content mismatch: "${inner.content}"`);
        testLog(`    ${C.dim}content="${inner.content?.trim()}", size=${inner.size}${C.reset}`);
    });

    // sftp_rename — rename to test-renamed.txt
    await runTest(`${prefix} sftp_rename (test.txt -> test-renamed.txt)`, async () => {
        const inner = await call('sftp_rename', {
            sessionId: sid,
            sourcePath: `${subDir}/test.txt`,
            destPath: `${subDir}/test-renamed.txt`,
        });
        assert(inner !== null, 'No response');
        assert(inner.success === true, `rename failed: ${inner.error}`);
        testLog(`    ${C.dim}success=${inner.success}${C.reset}`);
    });

    // sftp_stat (renamed) — verify new path exists, old doesn't
    await runTest(`${prefix} sftp_stat (renamed file)`, async () => {
        const newStat = await call('sftp_stat', { sessionId: sid, path: `${subDir}/test-renamed.txt` });
        assert(newStat !== null, 'No response for new path');
        assert(newStat.success === true && newStat.exists === true, 'Renamed file not found');

        const oldStat = await call('sftp_stat', { sessionId: sid, path: `${subDir}/test.txt` });
        assert(oldStat !== null, 'No response for old path');
        assert(oldStat.exists === false, 'Old file still exists after rename');
        testLog(`    ${C.dim}new exists=${newStat.exists}, old exists=${oldStat.exists}${C.reset}`);
    });

    // sftp_list_files — verify test-renamed.txt in listing
    await runTest(`${prefix} sftp_list_files (${sftpSubDir} dir)`, async () => {
        const inner = await call('sftp_list_files', { sessionId: sid, path: subDir });
        assert(inner !== null, 'No response');
        assert(inner.success === true, `list failed: ${inner.error}`);
        const files: any[] = inner.files || [];
        const names = files.map((f: any) => f.name || f.filename);
        assert(names.includes('test-renamed.txt'), `test-renamed.txt not in listing: ${names.join(', ')}`);
        testLog(`    ${C.dim}files: ${names.join(', ')}${C.reset}`);
    });

    // sftp_write_file (upload-test)
    await runTest(`${prefix} sftp_write_file (upload-test.txt)`, async () => {
        const inner = await call('sftp_write_file', {
            sessionId: sid,
            path: `${subDir}/upload-test.txt`,
            content: 'Upload test content for HTTP streaming\n',
        });
        assert(inner !== null, 'No response');
        assert(inner.success === true, `write failed: ${inner.error}`);
        testLog(`    ${C.dim}success=${inner.success}${C.reset}`);
    });

    // sftp_list_transfers
    await runTest(`${prefix} sftp_list_transfers`, async () => {
        const inner = await call('sftp_list_transfers');
        assert(inner !== null, 'No response');
        testLog(`    ${C.dim}transfers: ${inner.count ?? inner.transfers?.length ?? 0}${C.reset}`);
    });

    // sftp_get_transfer_status — fake transferId
    await runTest(`${prefix} sftp_get_transfer_status (fake id)`, async () => {
        const inner = await call('sftp_get_transfer_status', { transferId: 'fake-transfer-id-000' });
        assert(inner !== null, 'No response');
        assert(inner.success === false, 'Expected failure for fake transferId');
        testLog(`    ${C.dim}error="${inner.error}"${C.reset}`);
    });

    // sftp_cancel_transfer — fake transferId
    await runTest(`${prefix} sftp_cancel_transfer (fake id)`, async () => {
        const inner = await call('sftp_cancel_transfer', { transferId: 'fake-transfer-id-000' });
        assert(inner !== null, 'No response');
        assert(inner.success === false, 'Expected failure for fake transferId');
        testLog(`    ${C.dim}error="${inner.error}"${C.reset}`);
    });

    // Cleanup: delete files and directory
    await runTest(`${prefix} sftp cleanup (${sftpSubDir} dir)`, async () => {
        let r = await call('sftp_delete', { sessionId: sid, path: `${subDir}/test-renamed.txt` });
        testLog(`    ${C.dim}delete test-renamed.txt: success=${r?.success}${C.reset}`);
        r = await call('sftp_delete', { sessionId: sid, path: `${subDir}/upload-test.txt` });
        testLog(`    ${C.dim}delete upload-test.txt: success=${r?.success}${C.reset}`);
        r = await call('sftp_delete', { sessionId: sid, path: subDir, isDirectory: true });
        testLog(`    ${C.dim}delete ${sftpSubDir} dir: success=${r?.success}${C.reset}`);
    });
}

/**
 * Tab Management Suite (~13 tests)
 * Updates global sshSessionId and allSessionIds after close_all_tabs + restore.
 */
async function runTabManagementSuite(call: ToolCaller, prefix: string) {
    console.log(`\n${C.bold}  ── ${prefix} Tab Management ──${C.reset}\n`);

    let initialTabCount = 0;
    let duplicatedTabId: string | undefined;

    // list_tabs — record initial count
    await runTest(`${prefix} list_tabs (initial)`, async () => {
        const inner = await call('list_tabs');
        assert(inner !== null, 'No response');
        const tabs = inner.tabs || [];
        initialTabCount = tabs.length;
        for (const t of tabs) {
            testLog(`    ${C.dim}tab: idx=${t.tabIndex} id=${t.tabId} title="${t.title}" active=${t.isActive}${C.reset}`);
        }
        assert(initialTabCount > 0, 'No tabs found');
        testLog(`    ${C.dim}initial tab count: ${initialTabCount}${C.reset}`);
    });

    // select_tab
    await runTest(`${prefix} select_tab`, async () => {
        const before = await call('list_tabs');
        const tabs = before?.tabs || [];
        const activeTab = tabs.find((t: any) => t.isActive);
        const activeIdx = activeTab?.tabIndex ?? 0;

        const targetIdx = tabs.length > 1 ? (activeIdx === 0 ? 1 : 0) : 0;
        const inner = await call('select_tab', { tabIndex: targetIdx });
        assert(inner !== null, 'No response');
        testLog(`    ${C.dim}selected tab ${targetIdx}: success=${inner.success}${C.reset}`);

        if (tabs.length > 1) {
            await sleep(500);
            const restore = await call('select_tab', { tabIndex: activeIdx });
            testLog(`    ${C.dim}restored tab ${activeIdx}: success=${restore?.success}${C.reset}`);
        }
    });

    // duplicate_tab — record tabs before, find new tab after
    let tabIdsBefore: string[] = [];
    await runTest(`${prefix} duplicate_tab`, async () => {
        const before = await call('list_tabs');
        tabIdsBefore = (before?.tabs || []).map((t: any) => t.tabId);

        const inner = await call('duplicate_tab', {});
        assert(inner !== null, 'No response');
        assert(inner.success === true, `duplicate failed: ${inner.error}`);
        testLog(`    ${C.dim}success=${inner.success}, newTabTitle="${inner.tabTitle || inner.title}"${C.reset}`);
        await sleep(500);
    });

    // list_tabs — verify count +1 and find the new tab by diff
    await runTest(`${prefix} list_tabs (after duplicate)`, async () => {
        const inner = await call('list_tabs');
        assert(inner !== null, 'No response');
        const tabs = inner.tabs || [];
        testLog(`    ${C.dim}tab count: ${tabs.length} (was ${initialTabCount})${C.reset}`);
        assert(tabs.length >= initialTabCount + 1, `Expected at least ${initialTabCount + 1} tabs, got ${tabs.length}`);
        const newTab = tabs.find((t: any) => !tabIdsBefore.includes(t.tabId));
        if (newTab) {
            duplicatedTabId = newTab.tabId;
            testLog(`    ${C.dim}duplicated tab: id=${duplicatedTabId}, title="${newTab.title}"${C.reset}`);
        } else if (tabs.length > 0) {
            duplicatedTabId = tabs[tabs.length - 1].tabId;
            testLog(`    ${C.dim}duplicated tab (fallback last): id=${duplicatedTabId}${C.reset}`);
        }
    });

    // split_tab
    await runTest(`${prefix} split_tab (right)`, async () => {
        const inner = await call('split_tab', { direction: 'right' });
        assert(inner !== null, 'No response');
        testLog(`    ${C.dim}success=${inner.success}${C.reset}`);
        await sleep(300);
    });

    // next_tab
    await runTest(`${prefix} next_tab`, async () => {
        const inner = await call('next_tab');
        assert(inner !== null, 'No response');
        testLog(`    ${C.dim}success=${inner.success}, currentTab="${inner.currentTab}"${C.reset}`);
    });

    // previous_tab
    await runTest(`${prefix} previous_tab`, async () => {
        const inner = await call('previous_tab');
        assert(inner !== null, 'No response');
        testLog(`    ${C.dim}success=${inner.success}, currentTab="${inner.currentTab}"${C.reset}`);
    });

    // move_tab_right
    await runTest(`${prefix} move_tab_right`, async () => {
        const inner = await call('move_tab_right');
        assert(inner !== null, 'No response');
        testLog(`    ${C.dim}success=${inner.success}, newIndex=${inner.newIndex}${C.reset}`);
    });

    // move_tab_left
    await runTest(`${prefix} move_tab_left`, async () => {
        const inner = await call('move_tab_left');
        assert(inner !== null, 'No response');
        testLog(`    ${C.dim}success=${inner.success}, newIndex=${inner.newIndex}${C.reset}`);
    });

    // close_tab — close the duplicated tab
    if (duplicatedTabId) {
        await runTest(`${prefix} close_tab (duplicated)`, async () => {
            const inner = await call('close_tab', { tabId: duplicatedTabId, force: true });
            assert(inner !== null, 'No response');
            testLog(`    ${C.dim}success=${inner.success}${C.reset}`);
            await sleep(300);
        });
    } else {
        skip(`${prefix} close_tab (duplicated)`, 'No duplicated tab id');
    }

    // reopen_last_tab
    let reopenedTabId: string | undefined;
    await runTest(`${prefix} reopen_last_tab`, async () => {
        const inner = await call('reopen_last_tab');
        assert(inner !== null, 'No response');
        testLog(`    ${C.dim}success=${inner.success}, tabTitle="${inner.tabTitle}"${C.reset}`);
        await sleep(500);
        const after = await call('list_tabs');
        const tabs = after?.tabs || [];
        if (tabs.length > 0) {
            const newest = tabs[tabs.length - 1];
            reopenedTabId = newest.tabId;
            testLog(`    ${C.dim}reopened tabId=${reopenedTabId}${C.reset}`);
        }
    });

    // close_tab — close the reopened tab
    if (reopenedTabId) {
        await runTest(`${prefix} close_tab (reopened)`, async () => {
            const inner = await call('close_tab', { tabId: reopenedTabId, force: true });
            assert(inner !== null, 'No response');
            testLog(`    ${C.dim}success=${inner.success}${C.reset}`);
            await sleep(300);
        });
    } else {
        skip(`${prefix} close_tab (reopened)`, 'No reopened tab id');
    }

    // close_all_tabs — LAST, then restore all tabs via reopen_last_tab
    await runTest(`${prefix} close_all_tabs + restore`, async () => {
        const tabsBefore = await call('list_tabs');
        const tabCountBefore = (tabsBefore?.tabs || []).length;
        const tabTitles = (tabsBefore?.tabs || []).map((t: any) => t.title);
        testLog(`    ${C.dim}tabs before close: ${tabCountBefore} [${tabTitles.join(', ')}]${C.reset}`);

        const inner = await call('close_all_tabs');
        assert(inner !== null, 'No response');
        testLog(`    ${C.dim}close_all: success=${JSON.stringify(inner.success)}${C.reset}`);

        await sleep(500);

        // Restore tabs
        let restoredCount = 0;
        for (let i = 0; i < tabCountBefore; i++) {
            const reopen = await call('reopen_last_tab');
            if (reopen?.success) {
                restoredCount++;
                testLog(`    ${C.dim}reopened: "${reopen.tabTitle}"${C.reset}`);
                await sleep(1000);
            } else {
                testLog(`    ${C.dim}reopen_last_tab failed: ${reopen?.error || 'no more tabs to reopen'}${C.reset}`);
                break;
            }
        }

        // Re-detect sshSessionId since close_all_tabs destroyed all sessions
        const refreshed = await call('get_session_list');
        let sessions: any[] = [];
        if (Array.isArray(refreshed)) sessions = refreshed;
        else if (refreshed?.sessions) sessions = refreshed.sessions;
        sshSessionId = undefined;
        allSessionIds = [];
        for (const s of sessions) {
            allSessionIds.push(s.sessionId);
            if (s.type === 'SSHTabComponent' && !sshSessionId) {
                sshSessionId = s.sessionId;
            }
        }
        testLog(`    ${C.dim}restored: ${restoredCount}/${tabCountBefore} tabs, sessions: ${sessions.length}, sshSession: ${sshSessionId ? sshSessionId.substring(0, 8) + '..' : 'none'}${C.reset}`);
    });
}

/**
 * Profile Management Suite (~9 tests)
 * Each section uses a unique testProfileName to avoid collisions.
 */
async function runProfileManagementSuite(call: ToolCaller, prefix: string) {
    console.log(`\n${C.bold}  ── ${prefix} Profile Management ──${C.reset}\n`);

    let firstProfileId: string | undefined;
    let firstProfileName: string | undefined;

    // list_profiles — get available profiles
    await runTest(`${prefix} list_profiles`, async () => {
        const inner = await call('list_profiles');
        assert(inner !== null, 'No response');
        const profiles = inner.profiles || [];
        if (profiles.length > 0) {
            firstProfileId = profiles[0].profileId || profiles[0].id;
            firstProfileName = profiles[0].name;
        }
        for (const p of profiles.slice(0, 5)) {
            testLog(`    ${C.dim}profile: id=${p.profileId || p.id} name="${p.name}" type=${p.type}${C.reset}`);
        }
        testLog(`    ${C.dim}total: ${profiles.length} profiles${C.reset}`);
    });

    // add_profile — create a test profile (unique per section)
    let testProfileId: string | undefined;
    const sectionTag = prefix.replace(':', '').toLowerCase();
    const testProfileName = `tabby-mcp-test-${sectionTag}-${TEST_TIMESTAMP}`;

    await runTest(`${prefix} add_profile (test profile)`, async () => {
        const inner = await call('add_profile', {
            name: testProfileName,
            type: 'ssh',
            group: 'MCP Test',
            options: { host: '192.0.2.99', port: 22, user: 'testuser' },
        });
        assert(inner !== null, 'No response');
        assert(inner.success === true, `add_profile failed: ${inner.error}`);
        testProfileId = inner.profileId;
        testLog(`    ${C.dim}created: id=${testProfileId}, name="${inner.profileName}", type=${inner.profileType}${C.reset}`);
    });

    // list_profiles — verify new profile appears
    await runTest(`${prefix} list_profiles (after add)`, async () => {
        const inner = await call('list_profiles');
        assert(inner !== null, 'No response');
        const profiles = inner.profiles || [];
        const found = profiles.find((p: any) => (p.profileId || p.id) === testProfileId || p.name === testProfileName);
        assert(found !== undefined, `Test profile "${testProfileName}" not found in list`);
        testLog(`    ${C.dim}found test profile: name="${found.name}", id=${found.profileId || found.id}${C.reset}`);
    });

    // del_profile — delete the test profile
    if (testProfileId) {
        await runTest(`${prefix} del_profile (test profile)`, async () => {
            const inner = await call('del_profile', { profileId: testProfileId });
            assert(inner !== null, 'No response');
            assert(inner.success === true, `del_profile failed: ${inner.error}`);
            testLog(`    ${C.dim}deleted: id=${inner.profileId}, name="${inner.profileName}"${C.reset}`);
        });

        // list_profiles — verify profile is gone
        await runTest(`${prefix} list_profiles (after del)`, async () => {
            const inner = await call('list_profiles');
            assert(inner !== null, 'No response');
            const profiles = inner.profiles || [];
            const found = profiles.find((p: any) => (p.profileId || p.id) === testProfileId);
            assert(found === undefined, `Test profile still exists after deletion`);
            testLog(`    ${C.dim}confirmed: test profile no longer in list (${profiles.length} profiles)${C.reset}`);
        });
    } else {
        skip(`${prefix} del_profile (test profile)`, 'No test profile created');
        skip(`${prefix} list_profiles (after del)`, 'No test profile created');
    }

    // show_profile_selector — unregistered, skip
    skip(`${prefix} show_profile_selector`, 'Tool unregistered');

    // dismiss_dialog — unregistered, skip
    skip(`${prefix} dismiss_dialog`, 'Tool unregistered');

    // open_profile + close cleanup
    if (firstProfileId || firstProfileName) {
        await runTest(`${prefix} open_profile + close`, async () => {
            const before = await call('list_tabs');
            const tabIdsBefore = (before?.tabs || []).map((t: any) => t.tabId);

            const params: any = {};
            if (firstProfileId) params.profileId = firstProfileId;
            else params.profileName = firstProfileName;
            params.waitForReady = false;

            const inner = await call('open_profile', params, 15000);
            assert(inner !== null, 'No response');
            assert(inner.success === true, `open_profile failed: ${inner.error}`);
            testLog(`    ${C.dim}opened: success=${inner.success}, sessionId=${inner.sessionId?.substring(0, 8)}..${C.reset}`);

            await sleep(1000);
            const after = await call('list_tabs');
            const tabsAfter = (after?.tabs || []) as any[];
            const newTab = tabsAfter.find((t: any) => !tabIdsBefore.includes(t.tabId));
            if (newTab) {
                await call('close_tab', { tabId: newTab.tabId, force: true });
                testLog(`    ${C.dim}closed new tab: ${newTab.tabId}${C.reset}`);
            } else {
                await call('close_tab', { force: true });
                testLog(`    ${C.dim}closed active tab${C.reset}`);
            }
            await sleep(500);
        });
    } else {
        skip(`${prefix} open_profile + close`, 'No profiles available');
    }

    // quick_connect — check if tab opens
    await runTest(`${prefix} quick_connect (fake address)`, async () => {
        const before = await call('list_tabs');
        const tabsBefore = (before?.tabs || []) as any[];
        const tabIdsBefore = tabsBefore.map((t: any) => t.tabId);
        testLog(`    ${C.dim}tabs before: ${tabsBefore.length} [${tabsBefore.map((t: any) => t.title).join(', ')}]${C.reset}`);

        const inner = await call('quick_connect', { query: 'testuser@192.0.2.1:22' }, 15000);
        assert(inner !== null, 'No response');
        testLog(`    ${C.dim}result: success=${inner.success}, error="${inner.error || 'none'}", profile="${inner.profile || 'none'}"${C.reset}`);

        await sleep(1500);

        const after = await call('list_tabs');
        const tabsAfter = (after?.tabs || []) as any[];
        testLog(`    ${C.dim}tabs after: ${tabsAfter.length} [${tabsAfter.map((t: any) => t.title).join(', ')}]${C.reset}`);

        const newTab = tabsAfter.find((t: any) => !tabIdsBefore.includes(t.tabId));
        if (newTab) {
            testLog(`    ${C.dim}new tab found: id=${newTab.tabId}, title="${newTab.title}"${C.reset}`);
            await call('close_tab', { tabId: newTab.tabId, force: true });
            testLog(`    ${C.dim}closed new tab${C.reset}`);
            await sleep(500);
        } else {
            testLog(`    ${C.dim}no new tab created by quick_connect${C.reset}`);
        }
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 1: HTTP Restful
// ═════════════════════════════════════════════════════════════════════════════

async function testSection1_HttpRestful() {
    console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════════════${C.reset}`);
    console.log(`${C.bold}${C.cyan}  Section 1: HTTP Restful${C.reset}`);
    console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════════════${C.reset}`);

    // ── HTTP Endpoints ──
    console.log(`\n${C.bold}  ── HTTP Endpoints ──${C.reset}\n`);

    await runTest('GET /health', async () => {
        const res = await request('GET', '/health');
        assert(res.status === 200, `Expected 200, got ${res.status}`);
        const json = parseJson(res.body);
        assert(json !== null, 'Response is not valid JSON');
        assert(json.status === 'ok', `Expected status "ok", got "${json.status}"`);
        assert(typeof json.version === 'string' && json.version.length > 0, 'Missing version');
        testLog(`    ${C.dim}version=${json.version}, uptime=${json.uptime?.toFixed(1)}s${C.reset}`);
    });

    await runTest('GET /info', async () => {
        const res = await request('GET', '/info');
        assert(res.status === 200, `Expected 200, got ${res.status}`);
        const json = parseJson(res.body);
        assert(json !== null, 'Response is not valid JSON');
        assert(json.name === 'Tabby MCP', `Expected name "Tabby MCP", got "${json.name}"`);
        assert(json.protocolVersion === '2025-03-26', `Unexpected protocolVersion: ${json.protocolVersion}`);
        assert(Array.isArray(json.transports), 'Missing transports array');
        assert(Array.isArray(json.tools), 'Missing tools array');
        testLog(`    ${C.dim}version=${json.version}, tools=${json.tools.length}, transports=${json.transports.join(',')}${C.reset}`);
    });

    await runTest('GET /tools', async () => {
        const res = await request('GET', '/tools');
        assert(res.status === 200, `Expected 200, got ${res.status}`);
        const json = parseJson(res.body);
        assert(json !== null, 'Response is not valid JSON');
        assert(typeof json.count === 'number', 'Missing count');
        assert(Array.isArray(json.categories), 'Missing categories');
        const toolNames = json.categories.flatMap((c: any) => c.tools);
        testLog(`    ${C.dim}count=${json.count}, categories=${json.categories.map((c: any) => c.name).join(',')}${C.reset}`);
        testLog(`    ${C.dim}tools: ${toolNames.join(', ')}${C.reset}`);
    });

    // ── Shared Suites via REST ──
    await runTerminalToolsSuite(callTool, 'REST:');
    await runSftpToolsSuite(callTool, 'REST:', 'rest');

    // ── SFTP HTTP Streaming (REST-only) ──
    console.log(`\n${C.bold}  ── SFTP HTTP Streaming ──${C.reset}\n`);

    if (!sshSessionId) {
        skip('POST /api/sftp/upload (octet-stream)', 'No SSH session');
        skip('GET /api/sftp/download', 'No SSH session');
        skip('GET /api/sftp/download (no params -> error)', 'No SSH session');
        skip('POST /api/sftp/upload (no params -> error)', 'No SSH session');
        skip('sftp http streaming cleanup', 'No SSH session');
    } else {
        const httpDir = `${TEST_DIR}/http`;
        const sid = sshSessionId;
        const uploadContent = Buffer.from('Hello from HTTP streaming test!\n');
        const remotePath = `${httpDir}/http-upload.txt`;

        // Create directory first
        await callTool('sftp_mkdir', { sessionId: sid, path: TEST_DIR });
        await callTool('sftp_mkdir', { sessionId: sid, path: httpDir });

        await runTest('POST /api/sftp/upload (octet-stream)', async () => {
            const res = await requestRaw('POST', '/api/sftp/upload', uploadContent, {
                'Content-Type': 'application/octet-stream',
                'x-remote-path': remotePath,
                'x-session-id': sid,
            });
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            const json = parseJson(res.body.toString('utf-8'));
            assert(json !== null, 'Response is not valid JSON');
            assert(json.success === true, `Upload failed: ${json.error}`);
            testLog(`    ${C.dim}success=${json.success}, bytes=${json.bytesTransferred}, path=${json.remotePath}${C.reset}`);
        });

        await runTest('GET /api/sftp/download', async () => {
            const encodedPath = encodeURIComponent(remotePath);
            const res = await requestGetRaw(
                `/api/sftp/download?remotePath=${encodedPath}&sessionId=${sid}`
            );
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            const downloaded = res.body;
            assert(
                downloaded.equals(uploadContent),
                `Content mismatch: got "${downloaded.toString()}" expected "${uploadContent.toString()}"`
            );
            testLog(`    ${C.dim}downloaded ${downloaded.length} bytes, content matches${C.reset}`);
        });

        await runTest('GET /api/sftp/download (no params -> error)', async () => {
            const res = await request('GET', '/api/sftp/download');
            assert(res.status !== 404, 'Endpoint not registered (404)');
            testLog(`    ${C.dim}status=${res.status}, body=${res.body.substring(0, 150)}${C.reset}`);
        });

        await runTest('POST /api/sftp/upload (no params -> error)', async () => {
            const res = await request('POST', '/api/sftp/upload');
            assert(res.status !== 404, 'Endpoint not registered (404)');
            testLog(`    ${C.dim}status=${res.status}, body=${res.body.substring(0, 150)}${C.reset}`);
        });

        await runTest('sftp http streaming cleanup', async () => {
            let r = await callTool('sftp_delete', { sessionId: sid, path: remotePath });
            testLog(`    ${C.dim}delete http-upload.txt: success=${r?.success}${C.reset}`);
            r = await callTool('sftp_delete', { sessionId: sid, path: httpDir, isDirectory: true });
            testLog(`    ${C.dim}delete http dir: success=${r?.success}${C.reset}`);
        });
    }

    // ── Shared Suites via REST (continued) ──
    await runTabManagementSuite(callTool, 'REST:');
    await runProfileManagementSuite(callTool, 'REST:');
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 2: MCP Legacy SSE
// ═════════════════════════════════════════════════════════════════════════════

async function testSection2_McpLegacySse() {
    console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════════════${C.reset}`);
    console.log(`${C.bold}${C.cyan}  Section 2: MCP Legacy SSE${C.reset}`);
    console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════════════${C.reset}`);

    // ── SSE Protocol ──
    console.log(`\n${C.bold}  ── SSE Protocol ──${C.reset}\n`);

    type SseConnection = Awaited<ReturnType<typeof openSseConnection>>;
    let sse: SseConnection | null = null;

    // Establish SSE connection
    await runTest('SSE: establish connection', async () => {
        sse = await openSseConnection(8000);
        assert(!!sse.sessionId, 'No sessionId in endpoint event');
        testLog(`    ${C.dim}sessionId=${sse.sessionId}${C.reset}`);
        testLog(`    ${C.dim}messagesUrl=${sse.messagesUrl}${C.reset}`);
    });

    if (!sse) {
        skip('SSE: initialize', 'No SSE connection');
        skip('SSE: notifications/initialized', 'No SSE connection');
        skip('SSE: tools/list', 'No SSE connection');
        console.log(`\n${C.yellow}  Skipping all SSE suites — no connection${C.reset}`);
        return;
    }

    const sseConn: SseConnection = sse;
    const sseIdCounter = { value: 1 };

    // initialize
    await runTest('SSE: initialize', async () => {
        const res = await sendMcpMessage(
            sseConn.messagesUrl,
            {
                jsonrpc: '2.0',
                id: sseIdCounter.value++,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'tabby-mcp-test-sse', version: '1.0.0' },
                },
            },
            sseConn.waitForMessage,
            5000
        );
        assert(res !== null, 'No initialize response received via SSE');
        assert(res.result?.protocolVersion, 'Missing protocolVersion in response');
        testLog(`    ${C.dim}protocolVersion=${res.result.protocolVersion}, server=${res.result.serverInfo?.name}${C.reset}`);
    });

    // notifications/initialized
    await runTest('SSE: notifications/initialized', async () => {
        const res = await request('POST', sseConn.messagesUrl, {
            jsonrpc: '2.0',
            method: 'notifications/initialized',
        });
        assert(res.status >= 200 && res.status < 300, `Expected 2xx, got ${res.status}`);
        testLog(`    ${C.dim}status=${res.status}${C.reset}`);
    });

    // tools/list
    await runTest('SSE: tools/list', async () => {
        const res = await sendMcpMessage(
            sseConn.messagesUrl,
            { jsonrpc: '2.0', id: sseIdCounter.value++, method: 'tools/list' },
            sseConn.waitForMessage,
            5000
        );
        assert(res !== null, 'No tools/list response');
        const tools = res.result?.tools || [];
        testLog(`    ${C.dim}tools count=${tools.length}${C.reset}`);
        if (tools.length > 0) {
            testLog(`    ${C.dim}names: ${tools.map((t: any) => t.name).join(', ')}${C.reset}`);
        }
    });

    // ── Shared Suites via SSE ──
    const sseCaller = createSseToolCaller(sseConn.messagesUrl, sseConn.waitForMessage, sseIdCounter);

    await runTerminalToolsSuite(sseCaller, 'SSE:');
    await runSftpToolsSuite(sseCaller, 'SSE:', 'sse');
    await runTabManagementSuite(sseCaller, 'SSE:');
    await runProfileManagementSuite(sseCaller, 'SSE:');

    // ── SSE Close ──
    console.log(`\n${C.bold}  ── SSE Close ──${C.reset}\n`);

    await runTest('SSE: close connection', async () => {
        sseConn.close();
        testLog(`    ${C.dim}SSE connection closed${C.reset}`);
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 3: MCP Streamable HTTP
// ═════════════════════════════════════════════════════════════════════════════

async function testSection3_McpStreamableHttp() {
    console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════════════${C.reset}`);
    console.log(`${C.bold}${C.cyan}  Section 3: MCP Streamable HTTP${C.reset}`);
    console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════════════${C.reset}`);

    // ── Streamable Protocol ──
    console.log(`\n${C.bold}  ── Streamable Protocol ──${C.reset}\n`);

    let sessionId: string | undefined;
    const stIdCounter = { value: 1 };

    // POST /mcp initialize
    await runTest('Streamable: initialize', async () => {
        const { sessionId: sid, json } = await mcpStreamableRequest({
            jsonrpc: '2.0',
            id: stIdCounter.value++,
            method: 'initialize',
            params: {
                protocolVersion: '2025-03-26',
                capabilities: {},
                clientInfo: { name: 'tabby-mcp-test-streamable', version: '1.0.0' },
            },
        });
        sessionId = sid;
        assert(json !== null, 'No response');
        assert(json.result?.protocolVersion, 'Missing protocolVersion');
        testLog(`    ${C.dim}sessionId=${sessionId}${C.reset}`);
        testLog(`    ${C.dim}protocolVersion=${json.result.protocolVersion}, server=${json.result.serverInfo?.name}${C.reset}`);
    });

    if (!sessionId) {
        skip('Streamable: notifications/initialized', 'No session from initialize');
        skip('Streamable: tools/list', 'No session from initialize');
        console.log(`\n${C.yellow}  Skipping all Streamable suites — no session${C.reset}`);
        return;
    }

    // notifications/initialized
    await runTest('Streamable: notifications/initialized', async () => {
        try {
            const res = await request(
                'POST', '/mcp',
                { jsonrpc: '2.0', method: 'notifications/initialized' },
                { 'mcp-session-id': sessionId!, Accept: 'application/json, text/event-stream' },
                3000
            );
            testLog(`    ${C.dim}status=${res.status}${C.reset}`);
        } catch {
            testLog(`    ${C.dim}notification sent (no response expected)${C.reset}`);
        }
    });

    // tools/list
    await runTest('Streamable: tools/list', async () => {
        const { json } = await mcpStreamableRequest(
            { jsonrpc: '2.0', id: stIdCounter.value++, method: 'tools/list' },
            { 'mcp-session-id': sessionId! }
        );
        assert(json !== null, 'No response');
        const tools = json.result?.tools || [];
        testLog(`    ${C.dim}tools count=${tools.length}${C.reset}`);
        if (tools.length > 0) {
            testLog(`    ${C.dim}names: ${tools.map((t: any) => t.name).join(', ')}${C.reset}`);
        }
    });

    // ── Shared Suites via Streamable ──
    const streamableCaller = createStreamableToolCaller(sessionId, stIdCounter);

    await runTerminalToolsSuite(streamableCaller, 'Streamable:');
    await runSftpToolsSuite(streamableCaller, 'Streamable:', 'streamable');
    await runTabManagementSuite(streamableCaller, 'Streamable:');
    await runProfileManagementSuite(streamableCaller, 'Streamable:');

    // ── Streamable Close ──
    console.log(`\n${C.bold}  ── Streamable Close ──${C.reset}\n`);

    await runTest('Streamable: DELETE /mcp', async () => {
        const res = await request(
            'DELETE', '/mcp', undefined,
            { 'mcp-session-id': sessionId!, Accept: 'application/json, text/event-stream' },
            5000
        );
        assert(res.status === 200, `Expected 200, got ${res.status}`);
        testLog(`    ${C.dim}session closed${C.reset}`);
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// Final Cleanup
// ═════════════════════════════════════════════════════════════════════════════

async function testFinalCleanup() {
    console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════════════${C.reset}`);
    console.log(`${C.bold}${C.cyan}  Final Cleanup${C.reset}`);
    console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════════════${C.reset}\n`);

    if (!sshSessionId) {
        skip('final cleanup', 'No SSH session — nothing to clean');
        return;
    }

    await runTest('final cleanup (remove test dir)', async () => {
        const subdirs = ['rest', 'http', 'sse', 'streamable'];
        for (const sub of subdirs) {
            const r = await callTool('sftp_delete', { sessionId: sshSessionId, path: `${TEST_DIR}/${sub}`, isDirectory: true });
            if (r?.success) {
                testLog(`    ${C.dim}deleted ${TEST_DIR}/${sub}${C.reset}`);
            }
        }
        const r = await callTool('sftp_delete', { sessionId: sshSessionId, path: TEST_DIR, isDirectory: true });
        testLog(`    ${C.dim}delete ${TEST_DIR}: success=${r?.success}${C.reset}`);
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log(`${C.bold}Tabby MCP Comprehensive Test${C.reset}`);
    console.log(`${C.dim}Target: ${BASE_URL}${C.reset}`);
    console.log(`${C.dim}Test dir: ${TEST_DIR}${C.reset}`);
    console.log(`${C.dim}Time: ${new Date().toISOString()}${C.reset}`);

    // Verify server is reachable
    try {
        await request('GET', '/health', undefined, undefined, 3000);
    } catch (e: any) {
        console.log(`\n${C.red}Server unreachable at ${BASE_URL}: ${e.message}${C.reset}`);
        process.exit(1);
    }

    // Execute sections in order
    await testSection1_HttpRestful();       // Section 1: HTTP Restful (all tools + HTTP-only endpoints)
    await testSection2_McpLegacySse();      // Section 2: MCP Legacy SSE (all tools via SSE)
    await testSection3_McpStreamableHttp(); // Section 3: MCP Streamable HTTP (all tools via Streamable)
    await testFinalCleanup();               // Final Cleanup

    // Summary
    console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════════════${C.reset}`);
    console.log(`${C.bold}${C.cyan}  Summary${C.reset}`);
    console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════════════${C.reset}\n`);
    console.log(`  ${C.green}Passed: ${passed}${C.reset}`);
    console.log(`  ${C.red}Failed: ${failed}${C.reset}`);
    console.log(`  ${C.yellow}Skipped: ${skipped}${C.reset}`);
    console.log(`  Total: ${passed + failed + skipped}`);

    if (failed > 0) {
        console.log(`\n${C.bold}${C.red}Failed tests:${C.reset}`);
        results
            .filter((r) => r.status === 'FAIL')
            .forEach((r) => {
                console.log(`  ${C.red}✗${C.reset} ${r.name}: ${r.detail}`);
            });
    }

    console.log('');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error(`Fatal: ${e.message}`);
    process.exit(1);
});
