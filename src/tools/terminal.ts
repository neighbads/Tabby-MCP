import { Injectable } from '@angular/core';
import { AppService, BaseTabComponent, ConfigService, SplitTabComponent } from 'tabby-core';
import { BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal';
import { SerializeAddon } from '@xterm/addon-serialize';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import { BaseToolCategory } from './base-tool-category';
import { McpLoggerService } from '../services/mcpLogger.service';
import { DialogService } from '../services/dialog.service';
import { McpTool, ActiveCommand, TerminalSession, CommandResult } from '../types/types';

/**
 * Terminal session with ID for tracking
 */
export interface TerminalSessionWithTab {
    id: number;
    tabParent: BaseTabComponent;
    tab: BaseTerminalTabComponent;
}

/**
 * Terminal Tools Category - Commands for terminal control
 */
@Injectable({ providedIn: 'root' })
export class TerminalToolCategory extends BaseToolCategory {
    name = 'terminal';

    private _activeCommands = new Map<number, ActiveCommand>();
    private _activeCommandsSubject = new BehaviorSubject<Map<number, ActiveCommand>>(new Map());

    public readonly activeCommands$ = this._activeCommandsSubject.asObservable();

    constructor(
        private app: AppService,
        logger: McpLoggerService,
        private config: ConfigService,
        private dialogService: DialogService
    ) {
        super(logger);
        this.initializeTools();
    }

    /**
     * Initialize all terminal tools
     */
    private initializeTools(): void {
        this.registerTool(this.createGetSessionListTool());
        this.registerTool(this.createExecCommandTool());
        this.registerTool(this.createSendInputTool());
        this.registerTool(this.createGetTerminalBufferTool());
        this.registerTool(this.createAbortCommandTool());
        this.registerTool(this.createGetCommandStatusTool());

        this.logger.info('Terminal tools initialized');
    }

    /**
     * Tool: Get list of terminal sessions
     */
    private createGetSessionListTool(): McpTool {
        return {
            name: 'get_session_list',
            description: 'Get list of all terminal sessions/tabs in Tabby with their status',
            schema: {},
            handler: async () => {
                const sessions = this.findTerminalSessions();
                const result: TerminalSession[] = sessions.map(s => ({
                    id: s.id,
                    title: s.tab.title || `Terminal ${s.id}`,
                    type: s.tab.constructor.name,
                    isActive: this.app.activeTab === s.tabParent,
                    hasActiveCommand: this._activeCommands.has(s.id)
                }));

                this.logger.info(`Found ${result.length} terminal sessions`);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
        };
    }

    /**
     * Tool: Execute command in terminal
     * Enhanced with better timeout handling and interactive command detection
     */
    private createExecCommandTool(): McpTool {
        return {
            name: 'exec_command',
            description: `Execute a command in a terminal session. 
For interactive/paging commands (less, vim, top, etc.), set waitForOutput=false.
For long-running commands, increase timeout or use waitForOutput=false and poll with get_terminal_buffer.`,
            schema: {
                command: z.string().describe('Command to execute'),
                tabId: z.number().optional().describe('Terminal tab ID (default: 0)'),
                waitForOutput: z.boolean().optional().describe('Wait for command completion (default: true). Set false for interactive commands.'),
                timeout: z.number().optional().describe('Timeout in ms (default: 30000, max: 300000)')
            },
            handler: async (params: { command: string; tabId?: number; waitForOutput?: boolean; timeout?: number }) => {
                const { command, tabId = 0, waitForOutput = true, timeout: rawTimeout = 30000 } = params;
                const timeout = Math.min(rawTimeout, 300000); // Max 5 minutes

                // Check pair programming mode
                if (this.config.store.mcp?.pairProgrammingMode?.enabled) {
                    if (this.config.store.mcp?.pairProgrammingMode?.showConfirmationDialog) {
                        const confirmed = await this.dialogService.showCommandConfirmation(command, tabId);
                        if (!confirmed) {
                            return {
                                content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Command rejected by user' }) }]
                            };
                        }
                    }
                }

                const sessions = this.findTerminalSessions();
                const session = sessions.find(s => s.id === tabId);

                if (!session) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: `No terminal found with tabId ${tabId}` }) }]
                    };
                }

                try {
                    // Focus terminal if configured
                    if (this.config.store.mcp?.pairProgrammingMode?.autoFocusTerminal) {
                        this.app.selectTab(session.tabParent);
                    }

                    // For non-waiting mode, just send the command
                    if (!waitForOutput) {
                        session.tab.sendInput(command + '\n');
                        this.logger.info(`Sent command (async): ${command} in tab ${tabId}`);
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: true,
                                    message: 'Command sent (not waiting for output)',
                                    hint: 'Use get_terminal_buffer to check output, or send_input for interactive commands'
                                })
                            }]
                        };
                    }

                    // Generate unique markers
                    const timestamp = Date.now();
                    const startMarker = `__MCP_START_${timestamp}__`;
                    const endMarker = `__MCP_END_${timestamp}__`;

                    // Track active command
                    let aborted = false;
                    const activeCommand: ActiveCommand = {
                        tabId,
                        command,
                        timestamp,
                        startMarker,
                        endMarker,
                        abort: () => { aborted = true; }
                    };
                    this._activeCommands.set(tabId, activeCommand);
                    this._activeCommandsSubject.next(new Map(this._activeCommands));

                    // Send command with markers
                    const wrappedCommand = `echo "${startMarker}" && ${command} ; echo "${endMarker} $?"`;
                    session.tab.sendInput(wrappedCommand + '\n');

                    this.logger.info(`Executing command: ${command} in tab ${tabId}`);

                    // Wait for output
                    const result = await this.waitForCommandOutput(session, startMarker, endMarker, timeout, () => aborted);

                    // Clean up active command
                    this._activeCommands.delete(tabId);
                    this._activeCommandsSubject.next(new Map(this._activeCommands));

                    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
                } catch (error: any) {
                    this._activeCommands.delete(tabId);
                    this._activeCommandsSubject.next(new Map(this._activeCommands));

                    this.logger.error('Command execution error:', error);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }]
                    };
                }
            }
        };
    }

    /**
     * Tool: Send raw input to terminal (for interactive commands)
     */
    private createSendInputTool(): McpTool {
        return {
            name: 'send_input',
            description: `Send raw input to a terminal. Use this for interactive commands like vim, less, top, etc.
Special keys: \\x03 (Ctrl+C), \\x04 (Ctrl+D), \\x1b (Escape), \\r (Enter)`,
            schema: {
                input: z.string().describe('Input to send (can include special characters like \\n, \\x03 for Ctrl+C)'),
                tabId: z.number().optional().describe('Terminal tab ID (default: 0)')
            },
            handler: async (params: { input: string; tabId?: number }) => {
                const { input, tabId = 0 } = params;

                const sessions = this.findTerminalSessions();
                const session = sessions.find(s => s.id === tabId);

                if (!session) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: `No terminal found with tabId ${tabId}` }) }]
                    };
                }

                // Process escape sequences
                const processedInput = input
                    .replace(/\\n/g, '\n')
                    .replace(/\\r/g, '\r')
                    .replace(/\\t/g, '\t')
                    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

                session.tab.sendInput(processedInput);
                this.logger.info(`Sent input to tab ${tabId}: ${input.substring(0, 50)}${input.length > 50 ? '...' : ''}`);

                return {
                    content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Input sent' }) }]
                };
            }
        };
    }

    /**
     * Tool: Get terminal buffer content
     */
    private createGetTerminalBufferTool(): McpTool {
        return {
            name: 'get_terminal_buffer',
            description: 'Get the content of a terminal buffer. Use this to check command output after using send_input or async exec_command.',
            schema: {
                tabId: z.number().optional().describe('Terminal tab ID (default: 0)'),
                lastNLines: z.number().optional().describe('Get only the last N lines (default: all)'),
                startLine: z.number().optional().describe('Start line (0-indexed)'),
                endLine: z.number().optional().describe('End line (exclusive)')
            },
            handler: async (params: { tabId?: number; lastNLines?: number; startLine?: number; endLine?: number }) => {
                const { tabId = 0, lastNLines, startLine, endLine } = params;

                const sessions = this.findTerminalSessions();
                const session = sessions.find(s => s.id === tabId);

                if (!session) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: `No terminal found with tabId ${tabId}` }) }]
                    };
                }

                const bufferContent = this.getTerminalBufferText(session);
                const lines = bufferContent.split('\n');

                let selectedLines: string[];
                if (lastNLines !== undefined) {
                    selectedLines = lines.slice(-lastNLines);
                } else {
                    const start = startLine ?? 0;
                    const end = endLine ?? lines.length;
                    selectedLines = lines.slice(start, end);
                }

                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            success: true,
                            tabId,
                            totalLines: lines.length,
                            returnedLines: selectedLines.length,
                            content: selectedLines.join('\n')
                        })
                    }]
                };
            }
        };
    }

    /**
     * Tool: Abort running command
     */
    private createAbortCommandTool(): McpTool {
        return {
            name: 'abort_command',
            description: 'Abort a running command by sending Ctrl+C',
            schema: {
                tabId: z.number().optional().describe('Terminal tab ID (default: 0)')
            },
            handler: async (params: { tabId?: number }) => {
                const { tabId = 0 } = params;

                const sessions = this.findTerminalSessions();
                const session = sessions.find(s => s.id === tabId);

                if (!session) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: `No terminal found with tabId ${tabId}` }) }]
                    };
                }

                const activeCommand = this._activeCommands.get(tabId);
                if (activeCommand) {
                    activeCommand.abort();
                    this._activeCommands.delete(tabId);
                    this._activeCommandsSubject.next(new Map(this._activeCommands));
                }

                // Send Ctrl+C
                session.tab.sendInput('\x03');

                this.logger.info(`Aborted command in tab ${tabId}`);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Ctrl+C sent' }) }] };
            }
        };
    }

    /**
     * Tool: Get status of active commands
     */
    private createGetCommandStatusTool(): McpTool {
        return {
            name: 'get_command_status',
            description: 'Get the status of active/running commands across all terminals',
            schema: {},
            handler: async () => {
                const activeCommands = Array.from(this._activeCommands.entries()).map(([tabId, cmd]) => ({
                    tabId,
                    command: cmd.command,
                    startedAt: new Date(cmd.timestamp).toISOString(),
                    runningFor: `${Math.round((Date.now() - cmd.timestamp) / 1000)}s`
                }));

                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            success: true,
                            activeCommands,
                            count: activeCommands.length
                        }, null, 2)
                    }]
                };
            }
        };
    }

    /**
     * Find all terminal sessions
     */
    public findTerminalSessions(): TerminalSessionWithTab[] {
        const sessions: TerminalSessionWithTab[] = [];
        let id = 0;

        this.app.tabs.forEach((tab: BaseTabComponent) => {
            if (tab instanceof BaseTerminalTabComponent) {
                sessions.push({
                    id: id++,
                    tabParent: tab,
                    tab: tab as BaseTerminalTabComponent
                });
            } else if (tab instanceof SplitTabComponent) {
                const childTabs = tab.getAllTabs().filter(
                    (childTab: BaseTabComponent) => childTab instanceof BaseTerminalTabComponent &&
                        (childTab as BaseTerminalTabComponent).frontend !== undefined
                );

                childTabs.forEach((childTab: BaseTabComponent) => {
                    sessions.push({
                        id: id++,
                        tabParent: tab,
                        tab: childTab as BaseTerminalTabComponent
                    });
                });
            }
        });

        return sessions;
    }

    /**
     * Get terminal buffer as text
     */
    private getTerminalBufferText(session: TerminalSessionWithTab): string {
        try {
            const frontend = session.tab.frontend as XTermFrontend;
            if (!frontend) {
                return '';
            }

            // Access xterm through type assertion since it may be private
            const xtermInstance = (frontend as any).xterm;
            if (!xtermInstance) {
                return '';
            }

            // Check if serialize addon is already registered
            let serializeAddon = (xtermInstance as any)._addonManager?._addons?.find(
                (addon: any) => addon.instance instanceof SerializeAddon
            )?.instance;

            if (!serializeAddon) {
                serializeAddon = new SerializeAddon();
                xtermInstance.loadAddon(serializeAddon);
            }

            return serializeAddon.serialize();
        } catch (err) {
            this.logger.error('Error getting terminal buffer:', err);
            return '';
        }
    }

    /**
     * Wait for command output between markers
     * Timing is configurable via Settings → MCP → Timing
     */
    private async waitForCommandOutput(
        session: TerminalSessionWithTab,
        startMarker: string,
        endMarker: string,
        timeout: number,
        isAborted: () => boolean
    ): Promise<CommandResult> {
        const startTime = Date.now();
        let lastBufferLength = 0;
        let stableCount = 0;

        // Get timing config (with fallback defaults)
        const timing = this.config.store.mcp?.timing || {};
        const pollInterval = timing.pollInterval ?? 100;
        const initialDelay = timing.initialDelay ?? 0;

        // Optional initial delay (configurable, default 0)
        if (initialDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, initialDelay));
        }

        while (Date.now() - startTime < timeout) {
            if (isAborted()) {
                return { success: false, output: '', error: 'Command aborted' };
            }

            const buffer = this.getTerminalBufferText(session);

            // Look for end marker with exit code pattern (complete marker)
            // End marker format: __MCP_END_<timestamp>__ <exit_code>
            const endPattern = new RegExp(`${endMarker}\\s+(\\d+)`, 'm');
            const endMatch = buffer.match(endPattern);

            if (endMatch) {
                // Found complete end marker with exit code
                const endIndex = buffer.indexOf(endMatch[0]);
                const startIndex = buffer.lastIndexOf(startMarker, endIndex);

                if (startIndex !== -1 && startIndex < endIndex) {
                    // Extract output between markers
                    let output = buffer.substring(startIndex + startMarker.length, endIndex).trim();

                    // Remove command echo (first line often contains the wrapped command)
                    // Look for the start marker echo line and skip it
                    const lines = output.split('\n');
                    if (lines.length > 0 && lines[0].includes(startMarker.slice(0, 10))) {
                        lines.shift();
                        output = lines.join('\n').trim();
                    }

                    const exitCode = parseInt(endMatch[1], 10);

                    return {
                        success: exitCode === 0,
                        output,
                        exitCode
                    };
                }
            }

            // Track buffer stability (helps detect when output is complete)
            if (buffer.length === lastBufferLength) {
                stableCount++;
            } else {
                stableCount = 0;
                lastBufferLength = buffer.length;
            }

            // Wait between checks (configurable via Settings → MCP → Timing)
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        // On timeout, return partial output if start marker found
        const buffer = this.getTerminalBufferText(session);
        const startIndex = buffer.lastIndexOf(startMarker);
        if (startIndex !== -1) {
            let partialOutput = buffer.substring(startIndex + startMarker.length).trim();

            // Clean up command echo
            const lines = partialOutput.split('\n');
            if (lines.length > 0 && lines[0].includes('&&')) {
                lines.shift();
                partialOutput = lines.join('\n').trim();
            }

            return {
                success: false,
                output: partialOutput,
                error: 'Command timeout (partial output captured)',
                exitCode: -1
            };
        }

        return { success: false, output: '', error: 'Command timeout' };
    }
}
