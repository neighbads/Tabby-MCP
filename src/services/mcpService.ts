import { Injectable } from '@angular/core';
import { ConfigService } from 'tabby-core';
import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { IncomingMessage, ServerResponse } from 'http';
import * as http from 'http';
import { Socket } from 'net';
import { McpLoggerService } from './mcpLogger.service';
import { ToolCategory, McpTool } from '../types/types';
import { randomUUID } from 'crypto';
import { PLUGIN_VERSION } from '../version';

/**
 * MCP Server Service - Core MCP server with Streamable HTTP and SSE transport
 * 
 * Supports both:
 * - Streamable HTTP (new, recommended): Single /mcp endpoint
 * - Legacy SSE: GET /sse + POST /messages (backwards compatible)
 */
@Injectable({ providedIn: 'root' })
export class McpService {
    private legacyTransports: { [sessionId: string]: SSEServerTransport } = {};
    private streamableTransports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
    private app!: express.Application;
    private httpServer?: http.Server;
    private sockets = new Set<Socket>();
    private isRunning = false;
    private toolCategories: ToolCategory[] = [];
    private standaloneTools: McpTool[] = [];

    constructor(
        public config: ConfigService,
        private logger: McpLoggerService
    ) {
        this.configureExpress();
        this.logger.info('MCP Server initialized (Streamable HTTP + Legacy SSE)');
    }

    /**
     * Create a new McpServer instance with all registered tools.
     * Each connection gets its own server instance per MCP SDK requirements.
     */
    private createServer(): McpServer {
        const server = new McpServer({
            name: 'Tabby MCP',
            version: PLUGIN_VERSION
        });

        for (const category of this.toolCategories) {
            for (const tool of category.mcpTools) {
                const rawShape = tool.schema && typeof tool.schema === 'object' && 'shape' in tool.schema
                    ? (tool.schema as any).shape : tool.schema;
                (server.tool as any)(tool.name, tool.description, rawShape, tool.handler);
            }
        }

        for (const tool of this.standaloneTools) {
            const rawShape = tool.schema && typeof tool.schema === 'object' && 'shape' in tool.schema
                ? (tool.schema as any).shape : tool.schema;
            (server.tool as any)(tool.name, tool.description, rawShape, tool.handler);
        }

        return server;
    }

    /**
     * Register a tool category with the MCP server
     */
    public registerToolCategory(category: ToolCategory): void {
        this.toolCategories.push(category);

        category.mcpTools.forEach(tool => {
            this.logger.info(`Registered tool: ${tool.name}`);

            // Register HTTP API endpoint for direct tool access
            this.app.post(`/api/tool/${tool.name}`, async (req: Request, res: Response) => {
                try {
                    this.logger.info(`API call: ${tool.name}`, req.body);
                    const result = await tool.handler(req.body, {});
                    res.json(result);
                } catch (error: any) {
                    this.logger.error(`Tool ${tool.name} error:`, error);
                    res.status(500).json({ error: error.message });
                }
            });
        });
    }

    /**
     * Register a single tool
     */
    public registerTool(tool: McpTool): void {
        this.standaloneTools.push(tool);
        this.logger.info(`Registered tool: ${tool.name}`);
    }

    /**
     * Configure Express server with Streamable HTTP and SSE endpoints
     */
    private configureExpress(): void {
        this.app = express();

        // Parse JSON for all routes
        this.app.use(express.json());

        // Health check endpoint
        this.app.get('/health', (_, res) => {
            res.status(200).json({
                status: 'ok',
                server: 'Tabby MCP',
                version: PLUGIN_VERSION,
                transport: 'StreamableHTTP + SSE',
                uptime: process.uptime()
            });
        });

        // Server info endpoint
        this.app.get('/info', (_, res) => {
            res.status(200).json({
                name: 'Tabby MCP',
                version: PLUGIN_VERSION,
                protocolVersion: '2025-03-26',
                transports: ['streamable-http', 'sse'],
                endpoints: {
                    streamableHttp: '/mcp',
                    legacySse: '/sse',
                    legacyMessages: '/messages'
                },
                tools: this.toolCategories.flatMap(c => c.mcpTools.map(t => ({
                    name: t.name,
                    description: t.description
                })))
            });
        });

        // Tools list endpoint (for debugging)
        this.app.get('/tools', (_, res) => {
            res.status(200).json({
                count: this.toolCategories.reduce((sum, c) => sum + c.mcpTools.length, 0),
                categories: this.toolCategories.map(c => ({
                    name: c.name,
                    tools: c.mcpTools.map(t => t.name)
                }))
            });
        });

        // ============================================================
        // STREAMABLE HTTP TRANSPORT (New, Recommended - Protocol 2025-03-26)
        // Single endpoint handling all MCP communication
        // ============================================================

        this.app.all('/mcp', async (req: Request, res: Response) => {
            // Validate Origin header for security (DNS rebinding protection)
            const origin = req.headers.origin;
            const host = req.headers.host;
            if (origin && !this.isValidOrigin(origin, host)) {
                this.logger.warn(`Rejected request with invalid origin: ${origin}`);
                res.status(403).json({ error: 'Invalid origin' });
                return;
            }

            try {
                // Check for existing session ID
                const sessionId = req.headers['mcp-session-id'] as string;
                let transport: StreamableHTTPServerTransport | undefined;

                if (sessionId && this.streamableTransports[sessionId]) {
                    // Reuse existing transport
                    transport = this.streamableTransports[sessionId];
                } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
                    // New initialization request — create new transport + server
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => randomUUID(),
                        onsessioninitialized: (sid) => {
                            this.logger.info(`Streamable HTTP: Session initialized: ${sid}`);
                            // Store transport only after session is initialized
                            this.streamableTransports[sid] = transport!;
                            this.initSessionMetadata(sid, 'streamable', req);
                        }
                    });

                    transport.onclose = () => {
                        const sid = transport!.sessionId;
                        if (sid && this.streamableTransports[sid]) {
                            this.logger.info(`Streamable HTTP: Transport closed (onclose): ${sid}`);
                            delete this.streamableTransports[sid];
                            this.sessionMetadata.delete(sid);
                        }
                    };

                    const server = this.createServer();
                    await server.connect(transport);

                    this.logger.info('Streamable HTTP: New session created');
                } else {
                    // Invalid request — no session ID and not an initialization request
                    res.status(400).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32000,
                            message: 'Bad Request: No valid session ID provided'
                        },
                        id: null
                    });
                    return;
                }

                // Track activity for POST requests
                if (req.method === 'POST' && req.body?.method) {
                    const sid = sessionId || transport.sessionId;
                    if (sid) {
                        let activity = req.body.method;
                        if (activity === 'tools/call' && req.body.params?.name) {
                            activity += `: ${req.body.params.name}`;
                        }
                        this.trackActivity(sid, activity);
                    }
                }

                // Delegate all methods (GET, POST, DELETE) to the transport
                await transport.handleRequest(req, res, req.body);
            } catch (error: any) {
                this.logger.error('Streamable HTTP: Error handling request:', error);
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: { code: -32603, message: error.message || 'Internal error' },
                        id: req.body?.id || null
                    });
                }
            }
        });

        // ============================================================
        // LEGACY SSE TRANSPORT (Backwards Compatible - Protocol 2024-11-05)
        // GET /sse for SSE stream, POST /messages for sending
        // ============================================================

        // SSE endpoint for legacy MCP clients
        this.app.get('/sse', async (req: Request, res: Response) => {
            this.logger.info('Legacy SSE: Establishing connection');

            // Set headers for SSE
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');

            try {
                const transport = new SSEServerTransport(
                    '/messages',
                    res as unknown as ServerResponse<IncomingMessage>
                );

                const sessionId = transport.sessionId;
                this.logger.info(`Legacy SSE: New connection sessionId=${sessionId}`);
                this.legacyTransports[sessionId] = transport;
                this.initSessionMetadata(sessionId, 'sse', req);

                // Set up heartbeat to keep connection alive
                const heartbeatInterval = setInterval(() => {
                    try {
                        if (!res.writableEnded) {
                            res.write(': heartbeat\n\n');
                        }
                    } catch (e) {
                        // Connection closed
                        clearInterval(heartbeatInterval);
                    }
                }, 15000);

                // Clean up heartbeat when response closes
                res.on('close', () => {
                    this.logger.info(`Legacy SSE: Connection closed sessionId=${sessionId}`);
                    clearInterval(heartbeatInterval);
                });

                res.on('error', (err) => {
                    this.logger.error(`Legacy SSE: Connection error sessionId=${sessionId}`, err);
                    clearInterval(heartbeatInterval);
                });

                // Transport onclose handles map cleanup
                transport.onclose = () => {
                    this.logger.info(`Legacy SSE: Transport closed (onclose) sessionId=${sessionId}`);
                    delete this.legacyTransports[sessionId];
                    this.sessionMetadata.delete(sessionId);
                };

                // Each SSE connection gets its own server instance
                const server = this.createServer();
                await server.connect(transport);
            } catch (error) {
                this.logger.error('Legacy SSE: Failed to establish connection:', error);
                if (!res.headersSent) {
                    res.status(500).send('Failed to establish SSE connection');
                }
            }
        });

        // POST /sse - Redirect to Streamable HTTP or inform about legacy mode
        this.app.post('/sse', (req: Request, res: Response) => {
            this.logger.debug('POST /sse received - redirecting to /mcp endpoint');
            // Redirect to the new Streamable HTTP endpoint
            res.redirect(307, '/mcp');
        });

        // Messages endpoint for legacy SSE transport
        this.app.post('/messages', async (req: Request, res: Response) => {
            const sessionId = req.query.sessionId as string;

            if (!sessionId) {
                res.status(400).json({ error: 'Missing sessionId parameter' });
                return;
            }

            const transport = this.legacyTransports[sessionId];
            if (!transport) {
                res.status(400).json({ error: `No transport found for sessionId ${sessionId}` });
                return;
            }

            // Track activity
            if (req.body?.method) {
                let activity = req.body.method;
                if (activity === 'tools/call' && req.body.params?.name) {
                    activity += `: ${req.body.params.name}`;
                }
                this.trackActivity(sessionId, activity);
            }

            this.logger.debug(`Legacy SSE: Message received for sessionId=${sessionId}`);
            await transport.handlePostMessage(req, res, req.body);
        });

    }

    /**
     * Validate origin header for security
     */
    private isValidOrigin(origin: string, host: string | undefined): boolean {
        // Allow requests from localhost
        const localhostPatterns = [
            'http://localhost',
            'http://127.0.0.1',
            'https://localhost',
            'https://127.0.0.1'
        ];

        for (const pattern of localhostPatterns) {
            if (origin.startsWith(pattern)) {
                return true;
            }
        }

        // Allow if origin matches host
        if (host) {
            try {
                const originHost = new URL(origin).host;
                if (originHost === host) {
                    return true;
                }
            } catch {
                // Invalid URL
            }
        }

        return false;
    }


    /**
     * Start the MCP server
     */
    public async startServer(port?: number): Promise<void> {
        if (this.isRunning) {
            this.logger.warn('MCP server is already running');
            return;
        }

        const serverPort = port || this.config.store.mcp?.port || 3001;

        return new Promise((resolve, reject) => {
            try {
                this.httpServer = http.createServer(this.app);

                this.httpServer.listen(serverPort, () => {
                    this.isRunning = true;
                    this.logger.info(`MCP server started on port ${serverPort}`);
                    this.logger.info(`  Streamable HTTP: http://localhost:${serverPort}/mcp`);
                    this.logger.info(`  Legacy SSE: http://localhost:${serverPort}/sse`);
                    resolve();
                });

                // Track active connections for graceful shutdown
                this.httpServer.on('connection', (socket: Socket) => {
                    this.sockets.add(socket);
                    socket.on('close', () => {
                        this.sockets.delete(socket);
                    });
                });

                this.httpServer.on('error', (err: any) => {
                    this.isRunning = false;
                    if (err.code === 'EADDRINUSE') {
                        this.logger.error(`Port ${serverPort} is already in use`);
                    } else {
                        this.logger.error('Server error:', err);
                    }
                    reject(err);
                });
            } catch (err) {
                this.logger.error('Failed to start MCP server:', err);
                this.isRunning = false;
                reject(err);
            }
        });
    }

    /**
     * Stop the MCP server
     */
    public async stopServer(): Promise<void> {
        if (!this.isRunning) {
            this.logger.info('MCP server is not running');
            return;
        }

        try {
            // Close all legacy transports
            Object.values(this.legacyTransports).forEach(transport => {
                try {
                    transport.close();
                } catch (e) {
                    // Ignore close errors
                }
            });
            this.legacyTransports = {};

            // Close all streamable transports
            for (const [sessionId, transport] of Object.entries(this.streamableTransports)) {
                try {
                    await transport.close();
                } catch (e) {
                    // Ignore close errors
                }
            }
            this.streamableTransports = {};

            // Force close all active connections
            if (this.sockets.size > 0) {
                this.logger.info(`Closing ${this.sockets.size} active connections`);
                for (const socket of this.sockets) {
                    socket.destroy();
                }
                this.sockets.clear();
            }

            // Close HTTP server
            if (this.httpServer) {
                await new Promise<void>((resolve) => {
                    this.httpServer!.close(() => resolve());
                });
                this.httpServer = undefined;
            }

            this.isRunning = false;
            this.logger.info('MCP server stopped');
        } catch (err) {
            this.logger.error('Error stopping MCP server:', err);
            throw err;
        }
    }

    /**
     * Restart the MCP server
     */
    public async restartServer(): Promise<void> {
        await this.stopServer();
        await this.startServer();
    }

    /**
     * Get the Express application instance for registering additional routes
     */
    public getExpressApp(): express.Application {
        return this.app;
    }

    /**
     * Get the configured server port
     */
    public getServerPort(): number {
        return this.config.store.mcp?.port || 3001;
    }

    /**
     * Check if server is running
     */
    public isServerRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Get active connections count
     */
    public getActiveConnections(): number {
        return Object.keys(this.legacyTransports).length + Object.keys(this.streamableTransports).length;
    }

    // ============================================================
    // CONNECTION MONITORING & MANAGEMENT
    // ============================================================

    private sessionMetadata = new Map<string, {
        id: string,
        type: 'sse' | 'streamable',
        userAgent?: string,
        startTime: number,
        lastActive: number,
        lastActivity: string,
        history: string[] // Last 10 activities
    }>();

    private trackActivity(sessionId: string, activity: string) {
        const meta = this.sessionMetadata.get(sessionId);
        if (meta) {
            meta.lastActive = Date.now();
            meta.lastActivity = activity;
            meta.history.unshift(`[${new Date().toLocaleTimeString()}] ${activity}`);
            if (meta.history.length > 10) meta.history.pop();
        }
    }

    private initSessionMetadata(sessionId: string, type: 'sse' | 'streamable', req: Request) {
        this.sessionMetadata.set(sessionId, {
            id: sessionId,
            type,
            userAgent: req.headers['user-agent'],
            startTime: Date.now(),
            lastActive: Date.now(),
            lastActivity: 'Connected',
            history: []
        });
    }

    public getSessions() {
        return Array.from(this.sessionMetadata.values()).sort((a, b) => b.lastActive - a.lastActive);
    }

    public async closeSession(sessionId: string): Promise<boolean> {
        this.logger.info(`Manually closing session: ${sessionId}`);

        let found = false;

        // Try closing streamable transport
        if (this.streamableTransports[sessionId]) {
            try {
                await this.streamableTransports[sessionId].close();
            } catch (e) { }
            delete this.streamableTransports[sessionId];
            found = true;
        }

        // Try closing legacy transport
        if (this.legacyTransports[sessionId]) {
            try {
                this.legacyTransports[sessionId].close();
            } catch (e) { }
            delete this.legacyTransports[sessionId];
            found = true;
        }

        this.sessionMetadata.delete(sessionId);
        return found;
    }
}

export * from '../types/types';
