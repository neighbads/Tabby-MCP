import { Injectable } from '@angular/core';
import { AppService, BaseTabComponent, ConfigService, SplitTabComponent, ProfilesService } from 'tabby-core';
import { BaseTerminalTabComponent } from 'tabby-terminal';
import { z } from 'zod';
import { BaseToolCategory } from './base-tool-category';
import { McpLoggerService } from '../services/mcpLogger.service';
import { McpTool } from '../types/types';

/**
 * Tab Management Tools Category - Comprehensive tab and profile management
 */
@Injectable({ providedIn: 'root' })
export class TabManagementToolCategory extends BaseToolCategory {
    name = 'tab_management';

    constructor(
        private app: AppService,
        logger: McpLoggerService,
        private config: ConfigService,
        private profilesService: ProfilesService
    ) {
        super(logger);
        this.initializeTools();
    }

    private initializeTools(): void {
        // Tab operations
        this.registerTool(this.createListTabsTool());
        this.registerTool(this.createSelectTabTool());
        this.registerTool(this.createCloseTabTool());
        this.registerTool(this.createCloseAllTabsTool());
        this.registerTool(this.createDuplicateTabTool());
        this.registerTool(this.createNextTabTool());
        this.registerTool(this.createPreviousTabTool());
        this.registerTool(this.createMoveTabLeftTool());
        this.registerTool(this.createMoveTabRightTool());
        this.registerTool(this.createReopenLastTabTool());

        // Profile/Session operations
        this.registerTool(this.createListProfilesTool());
        this.registerTool(this.createOpenProfileTool());
        this.registerTool(this.createShowProfileSelectorTool());
        this.registerTool(this.createQuickConnectTool());

        // Split pane operations
        this.registerTool(this.createSplitTabTool());

        this.logger.info('Tab management tools initialized');
    }

    // Tab ID registry for stable IDs
    // Use both WeakMap (for tab -> id) and Map (for id -> tab) to support bidirectional lookup
    private tabToId = new WeakMap<BaseTabComponent, string>();
    private idToTab = new Map<string, BaseTabComponent>();

    // ============= Tab Operations =============

    /**
     * Get or create stable tab ID
     * Uses bidirectional mapping for reliable lookup
     */
    private getOrCreateTabId(tab: BaseTabComponent): string {
        let tabId = this.tabToId.get(tab);
        if (!tabId) {
            tabId = 'tab-' + 'xxxxxxxx'.replace(/[x]/g, () => {
                return (Math.random() * 16 | 0).toString(16);
            });
            this.tabToId.set(tab, tabId);
            this.idToTab.set(tabId, tab);
        }
        return tabId;
    }

    /**
     * Find tab by its stable ID
     * Uses reverse lookup map for efficiency
     */
    private findTabById(tabId: string): BaseTabComponent | null {
        // First try the reverse lookup map
        const tab = this.idToTab.get(tabId);
        if (tab) {
            // Verify the tab is still valid (exists in app.tabs)
            if (this.app.tabs.includes(tab)) {
                return tab;
            }
            // Clean up stale reference
            this.idToTab.delete(tabId);
        }
        // Fallback: scan all tabs (in case the map is out of sync)
        for (const t of this.app.tabs) {
            if (this.tabToId.get(t) === tabId) {
                // Re-register in reverse map
                this.idToTab.set(tabId, t);
                return t;
            }
        }
        return null;
    }

    /**
     * Find tab by flexible locator
     * Priority: tabId (stable) > tabIndex (legacy) > title (partial match)
     * If no locator is provided, returns the currently active/focused tab
     */
    private findTabByLocator(locator: { tabId?: string; tabIndex?: number; title?: string }): BaseTabComponent | null {
        this.logger.debug(`findTabByLocator called with: ${JSON.stringify(locator)}`);

        // If no locator parameters provided, return the currently active tab
        if (!locator.tabId && locator.tabIndex === undefined && !locator.title) {
            const activeTab = this.app.tabs.find(tab => tab.hasFocus);
            if (activeTab) {
                this.logger.debug('No locator provided, returning active/focused tab');
                return activeTab;
            }
            // If no focused tab, return the first tab
            if (this.app.tabs.length > 0) {
                this.logger.debug('No focused tab, returning first tab');
                return this.app.tabs[0];
            }
            return null;
        }

        // Priority 1: tabId (stable) - use optimized reverse lookup
        if (locator.tabId) {
            const found = this.findTabById(locator.tabId);
            if (found) {
                this.logger.debug(`Found tab by tabId: ${locator.tabId}`);
                return found;
            }
            this.logger.debug(`Tab not found by tabId: ${locator.tabId}`);
        }
        // Priority 2: tabIndex
        if (locator.tabIndex !== undefined && locator.tabIndex >= 0 && locator.tabIndex < this.app.tabs.length) {
            const found = this.app.tabs[locator.tabIndex];
            this.logger.debug(`Found tab by tabIndex: ${locator.tabIndex}`);
            return found;
        }
        // Priority 3: title (partial match, case-insensitive)
        if (locator.title) {
            const titleLower = locator.title.toLowerCase();
            const found = this.app.tabs.find(tab => tab.title?.toLowerCase().includes(titleLower));
            if (found) {
                this.logger.debug(`Found tab by title: ${locator.title}`);
                return found;
            }
            this.logger.debug(`Tab not found by title: ${locator.title}`);
        }
        this.logger.debug(`No tab found for locator: ${JSON.stringify(locator)}`);
        return null;
    }

    private createListTabsTool(): McpTool {
        return {
            name: 'list_tabs',
            description: `List all open tabs in Tabby with stable IDs and metadata.
Use tabId (stable) for reliable tab targeting; tabIndex may change if tabs are reordered.`,
            schema: z.object({}),
            handler: async () => {
                const tabs = this.app.tabs.map((tab, index) => {
                    const tabAny = tab as any;
                    const isTerminal = tab instanceof BaseTerminalTabComponent;
                    return {
                        tabId: this.getOrCreateTabId(tab),
                        tabIndex: index,
                        title: tab.title || `Tab ${index}`,
                        type: tab.constructor.name,
                        isActive: this.app.activeTab === tab,
                        hasFocus: tab.hasFocus,
                        color: tab.color,
                        isTerminal,
                        profile: tabAny.profile ? {
                            id: tabAny.profile.id,
                            name: tabAny.profile.name,
                            type: tabAny.profile.type
                        } : undefined
                    };
                });

                this.logger.info(`Listed ${tabs.length} tabs`);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ success: true, tabs, count: tabs.length }, null, 2) }]
                };
            }
        };
    }

    private createSelectTabTool(): McpTool {
        return {
            name: 'select_tab',
            description: `Select/focus a specific tab.
Tab targeting: tabId (stable, recommended) > tabIndex (legacy) > title (partial match)`,
            schema: z.object({
                tabId: z.string().optional().describe('Stable tab ID (recommended, from list_tabs)'),
                tabIndex: z.number().optional().describe('Tab index (legacy, may change)'),
                title: z.string().optional().describe('Match by title (partial, case-insensitive)')
            }),
            handler: async (params: { tabId?: string; tabIndex?: number; title?: string }) => {
                const tab = this.findTabByLocator(params);

                if (!tab) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching tab found',
                                hint: 'Use list_tabs to see available tabs with their tabIds'
                            })
                        }]
                    };
                }

                this.app.selectTab(tab);
                const tabId = this.getOrCreateTabId(tab);

                this.logger.info(`Selected tab: ${tab.title}`);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ success: true, tabId, message: `Selected tab: ${tab.title}` }) }]
                };
            }
        };
    }

    private createCloseTabTool(): McpTool {
        return {
            name: 'close_tab',
            description: `Close a specific tab. If no locator provided, closes the active tab.
Tab targeting: tabId (stable, recommended) > tabIndex (legacy) > title (partial match)`,
            schema: z.object({
                tabId: z.string().optional().describe('Stable tab ID (recommended)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                force: z.boolean().optional().describe('Force close without asking (default: false)')
            }),
            handler: async (params: { tabId?: string; tabIndex?: number; title?: string; force?: boolean }) => {
                const { tabId, tabIndex, title, force = false } = params;

                let tab: BaseTabComponent | null;
                // If any locator is provided, use findTabByLocator
                if (tabId || tabIndex !== undefined || title) {
                    tab = this.findTabByLocator({ tabId, tabIndex, title });
                } else {
                    // Default to active tab
                    tab = this.app.activeTab;
                }

                if (!tab) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No matching tab found' }) }]
                    };
                }

                const closedTitle = tab.title;
                const closedTabId = this.getOrCreateTabId(tab);
                await this.app.closeTab(tab, !force);

                this.logger.info(`Closed tab: ${closedTitle}`);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ success: true, tabId: closedTabId, message: `Closed tab: ${closedTitle}` }) }]
                };
            }
        };
    }

    private createCloseAllTabsTool(): McpTool {
        return {
            name: 'close_all_tabs',
            description: 'Close all open tabs',
            schema: z.object({}),
            handler: async () => {
                const count = this.app.tabs.length;
                const success = await this.app.closeAllTabs();

                if (success) {
                    this.logger.info(`Closed all ${count} tabs`);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Closed ${count} tabs` }) }]
                    };
                } else {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Some tabs blocked closure' }) }]
                    };
                }
            }
        };
    }

    private createDuplicateTabTool(): McpTool {
        return {
            name: 'duplicate_tab',
            description: 'Duplicate the active tab or a specific tab',
            schema: z.object({
                tabIndex: z.number().optional().describe('Index of the tab to duplicate (default: active tab)')
            }),
            handler: async (params: { tabIndex?: number }) => {
                const { tabIndex } = params;

                let tab: BaseTabComponent | null;
                if (tabIndex !== undefined) {
                    if (tabIndex < 0 || tabIndex >= this.app.tabs.length) {
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Invalid tab index: ${tabIndex}` }) }]
                        };
                    }
                    tab = this.app.tabs[tabIndex];
                } else {
                    tab = this.app.activeTab;
                }

                if (!tab) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No tab to duplicate' }) }]
                    };
                }

                const newTab = await this.app.duplicateTab(tab);

                if (newTab) {
                    this.logger.info(`Duplicated tab: ${tab.title}`);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Duplicated tab: ${tab.title}`, newTabIndex: this.app.tabs.indexOf(newTab) }) }]
                    };
                } else {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Failed to duplicate tab' }) }]
                    };
                }
            }
        };
    }

    private createNextTabTool(): McpTool {
        return {
            name: 'next_tab',
            description: 'Switch to the next tab',
            schema: z.object({}),
            handler: async () => {
                this.app.nextTab();
                const currentTab = this.app.activeTab;

                this.logger.info(`Switched to next tab: ${currentTab?.title}`);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ success: true, currentTab: currentTab?.title }) }]
                };
            }
        };
    }

    private createPreviousTabTool(): McpTool {
        return {
            name: 'previous_tab',
            description: 'Switch to the previous tab',
            schema: z.object({}),
            handler: async () => {
                this.app.previousTab();
                const currentTab = this.app.activeTab;

                this.logger.info(`Switched to previous tab: ${currentTab?.title}`);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ success: true, currentTab: currentTab?.title }) }]
                };
            }
        };
    }

    private createMoveTabLeftTool(): McpTool {
        return {
            name: 'move_tab_left',
            description: 'Move the active tab to the left',
            schema: z.object({}),
            handler: async () => {
                this.app.moveSelectedTabLeft();
                const currentTab = this.app.activeTab;
                const index = currentTab ? this.app.tabs.indexOf(currentTab) : -1;

                this.logger.info(`Moved tab left: ${currentTab?.title}`);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ success: true, tabTitle: currentTab?.title, newIndex: index }) }]
                };
            }
        };
    }

    private createMoveTabRightTool(): McpTool {
        return {
            name: 'move_tab_right',
            description: 'Move the active tab to the right',
            schema: z.object({}),
            handler: async () => {
                this.app.moveSelectedTabRight();
                const currentTab = this.app.activeTab;
                const index = currentTab ? this.app.tabs.indexOf(currentTab) : -1;

                this.logger.info(`Moved tab right: ${currentTab?.title}`);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ success: true, tabTitle: currentTab?.title, newIndex: index }) }]
                };
            }
        };
    }

    private createReopenLastTabTool(): McpTool {
        return {
            name: 'reopen_last_tab',
            description: 'Reopen the last closed tab',
            schema: z.object({}),
            handler: async () => {
                const tab = await this.app.reopenLastTab();

                if (tab) {
                    this.logger.info(`Reopened tab: ${tab.title}`);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: true, tabTitle: tab.title }) }]
                    };
                } else {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No tab to reopen' }) }]
                    };
                }
            }
        };
    }

    // ============= Profile/Session Operations =============

    private createListProfilesTool(): McpTool {
        return {
            name: 'list_profiles',
            description: `List all available terminal profiles (local shell, SSH connections, etc.).
Returns profileId which can be used directly with open_profile().

Workflow: list_profiles() -> find desired profile -> open_profile(profileId="...")`,
            schema: z.object({}),
            handler: async () => {
                try {
                    const profiles = await this.profilesService.getProfiles();
                    // Use 'profileId' to match open_profile parameter name
                    const formatted = profiles.map(p => ({
                        profileId: p.id,  // Field name matches open_profile's parameter
                        name: p.name,
                        type: p.type,
                        group: p.group,
                        icon: p.icon,
                        color: p.color
                    }));

                    this.logger.info(`Listed ${profiles.length} profiles`);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: true, profiles: formatted, count: profiles.length }, null, 2) }]
                    };
                } catch (error: any) {
                    this.logger.error('Error listing profiles:', error);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }]
                    };
                }
            }
        };
    }

    private createOpenProfileTool(): McpTool {
        return {
            name: 'open_profile',
            description: `Open a NEW terminal tab using a profile. Creates new connection.

Usage: list_profiles() -> open_profile(profileId="...from list_profiles result")

Parameters:
- profileId: Use 'profileId' field from list_profiles (recommended)
- profileName: Or match by name (partial, case-insensitive)
- waitForReady: Wait for terminal/SSH to fully connect (default: true)
- timeout: Timeout in ms when waiting (default: 30000)

Returns sessionId for immediate use with exec_command, SFTP tools, etc.
For SSH profiles, waits until sshSession.open=true (real connection established).

NOTE: This opens a NEW tab. For existing connections, use get_session_list + exec_command.`,
            schema: z.object({
                profileId: z.string().optional().describe('profileId from list_profiles result'),
                profileName: z.string().optional().describe('Profile name (partial match, case-insensitive)'),
                waitForReady: z.boolean().optional().describe('Wait for connection (default: true for SSH, false for local)'),
                timeout: z.number().optional().describe('Timeout in ms when waiting (default: 30000)')
            }),
            handler: async (params: { profileId?: string; profileName?: string; waitForReady?: boolean; timeout?: number }) => {
                // Debug: log received params to diagnose parameter passing issues
                this.logger.info(`[open_profile] Received params: ${JSON.stringify(params)}`);

                // Handle both direct params and potential nested structure
                const profileId = params?.profileId;
                const profileName = params?.profileName;
                const timeout = params?.timeout ?? 30000;

                this.logger.debug(`[open_profile] Parsed: profileId=${profileId}, profileName=${profileName}`);

                if (!profileId && !profileName) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: 'Either profileId or profileName must be provided',
                                receivedParams: Object.keys(params || {}),
                                hint: 'Use list_profiles to get available profile IDs and names'
                            })
                        }]
                    };
                }

                try {
                    const profiles = await this.profilesService.getProfiles();
                    let profile = profiles.find(p =>
                        (profileId && p.id === profileId) ||
                        (profileName && p.name.toLowerCase().includes(profileName.toLowerCase()))
                    );

                    if (!profile) {
                        this.logger.warn(`[open_profile] Profile not found: ${profileId || profileName}`);
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: false,
                                    error: `Profile not found: ${profileId || profileName}`,
                                    availableProfiles: profiles.map(p => ({ id: p.id, name: p.name }))
                                })
                            }]
                        };
                    }

                    this.logger.info(`[open_profile] Opening profile: ${profile.name} (type: ${profile.type})`);
                    const tab = await this.profilesService.openNewTabForProfile(profile);

                    if (tab) {
                        const tabId = this.getOrCreateTabId(tab);
                        const tabIndex = this.app.tabs.indexOf(tab);
                        const isSSH = profile.type === 'ssh' || profile.type?.includes('ssh');

                        // Determine default waitForReady based on profile type
                        const waitForReady = params?.waitForReady ?? isSSH;

                        // Generate sessionId for the new tab
                        // Use same UUID generation as TerminalToolCategory
                        let sessionId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
                            const r = Math.random() * 16 | 0;
                            const v = c === 'x' ? r : (r & 0x3 | 0x8);
                            return v.toString(16);
                        });

                        if (waitForReady) {
                            // Wait for the terminal session to be fully connected
                            const timing = this.config.store.mcp?.timing || {};
                            const sessionPollInterval = timing.sessionPollInterval ?? 200;
                            const sessionStableChecks = timing.sessionStableChecks ?? 5;

                            const startTime = Date.now();
                            let tabReady = false;
                            let sshConnected = false;
                            let lastBufferLength = 0;
                            let stableCount = 0;

                            this.logger.debug(`[open_profile] Waiting for ready (isSSH=${isSSH}, timeout=${timeout}ms)`);

                            while (Date.now() - startTime < timeout) {
                                const tabAny = tab as any;

                                // Check 1: Tab/Terminal Ready indicators
                                const frontendReady = tabAny.frontend !== undefined;
                                const sessionReady = tabAny.sessionReady === true;
                                const hasSession = tabAny.session !== undefined;
                                const sessionOpen = tabAny.session?.open === true;

                                // Check 2: SSH-specific indicators (only for SSH profiles)
                                if (isSSH) {
                                    const sshSession = tabAny.sshSession;
                                    if (sshSession && sshSession.open === true) {
                                        sshConnected = true;
                                        tabReady = true;
                                        this.logger.info(`[open_profile] SSH session connected: ${profile.name}`);
                                        break;
                                    }
                                } else {
                                    // For non-SSH, consider ready when session is open
                                    if (sessionOpen || (frontendReady && sessionReady)) {
                                        tabReady = true;
                                        break;
                                    }
                                }

                                // Check 3: Buffer stability (fallback indicator)
                                let bufferLength = 0;
                                try {
                                    const xterm = tabAny.frontend?.xterm;
                                    if (xterm?.buffer?.active) {
                                        bufferLength = xterm.buffer.active.length;
                                    }
                                } catch (e) {
                                    // Ignore buffer access errors
                                }

                                // Buffer has content and is stable = likely connected
                                if (bufferLength > 0 && bufferLength === lastBufferLength) {
                                    stableCount++;
                                    if (stableCount >= sessionStableChecks) {
                                        tabReady = true;
                                        if (isSSH) {
                                            // For SSH, check one more time if sshSession is available
                                            const sshSession = tabAny.sshSession;
                                            sshConnected = sshSession?.open === true;
                                        }
                                        break;
                                    }
                                } else {
                                    stableCount = 0;
                                    lastBufferLength = bufferLength;
                                }

                                await new Promise(resolve => setTimeout(resolve, sessionPollInterval));
                            }

                            const elapsed = Date.now() - startTime;
                            this.logger.info(`[open_profile] Profile opened: ${profile.name} (tabReady=${tabReady}, sshConnected=${sshConnected}, elapsed=${elapsed}ms)`);

                            return {
                                content: [{
                                    type: 'text', text: JSON.stringify({
                                        success: true,
                                        sessionId,
                                        tabId,
                                        tabIndex,
                                        tabTitle: tab.title,
                                        profileName: profile.name,
                                        profileType: profile.type,
                                        ready: tabReady,
                                        sshConnected: isSSH ? sshConnected : undefined,
                                        elapsed: `${elapsed}ms`,
                                        message: tabReady
                                            ? `Profile ready: ${profile.name}`
                                            : `Profile opened but may not be fully connected: ${profile.name}`,
                                        hint: 'Use sessionId with exec_command, SFTP tools, etc.'
                                    })
                                }]
                            };
                        }

                        // No waiting - return immediately
                        this.logger.info(`[open_profile] Profile opened (no wait): ${profile.name}`);
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: true,
                                    sessionId,
                                    tabId,
                                    tabIndex,
                                    tabTitle: tab.title,
                                    profileName: profile.name,
                                    profileType: profile.type,
                                    ready: false,
                                    message: `Opened profile: ${profile.name}`,
                                    note: 'Profile opened. SSH connections may take a moment to establish.',
                                    hint: 'Use sessionId with exec_command, SFTP tools, etc.'
                                })
                            }]
                        };
                    } else {
                        this.logger.error(`[open_profile] Failed to open profile: ${profile.name}`);
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Failed to open profile' }) }]
                        };
                    }
                } catch (error: any) {
                    this.logger.error('[open_profile] Error:', error);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }]
                    };
                }
            }
        };
    }

    private createShowProfileSelectorTool(): McpTool {
        return {
            name: 'show_profile_selector',
            description: `Show the profile selector dialog for the user to choose a profile.
This is a NON-BLOCKING operation - it immediately returns after opening the dialog.
The dialog will be shown to the user, but this tool does not wait for user selection.
Use list_profiles + open_profile for programmatic profile opening instead.`,
            schema: z.object({}),
            handler: async () => {
                try {
                    // Fire-and-forget: show the dialog but don't wait for result
                    // This prevents MCP from blocking indefinitely
                    this.profilesService.showProfileSelector().then(profile => {
                        if (profile) {
                            this.logger.info(`User selected profile via dialog: ${profile.name}`);
                        } else {
                            this.logger.info('User cancelled profile selector dialog');
                        }
                    }).catch(err => {
                        this.logger.warn('Profile selector dialog closed:', err?.message || 'unknown');
                    });

                    // Return immediately - don't wait for user action
                    this.logger.info('Profile selector dialog opened (non-blocking)');
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true,
                                message: 'Profile selector dialog opened',
                                note: 'This is non-blocking. Use list_profiles + open_profile for programmatic control.',
                                hint: 'The user can now select a profile from the dialog'
                            })
                        }]
                    };
                } catch (error: any) {
                    const errorMessage = error?.message || (typeof error === 'string' ? error : 'Unknown error showing profile selector');
                    this.logger.error('Error showing profile selector:', error);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: errorMessage }) }]
                    };
                }
            }
        };
    }

    private createQuickConnectTool(): McpTool {
        return {
            name: 'quick_connect',
            description: `Quick SSH connection - creates a NEW tab with temporary profile.

IMPORTANT: This creates a NEW connection and tab, does NOT reuse existing sessions.
- For new connections: Use this or open_profile
- For existing sessions: Use get_session_list to find sessions, then exec_command

Example: quick_connect(query="root@192.168.1.1") or quick_connect(query="user@host:2222")`,
            schema: z.object({
                query: z.string().describe('SSH string: "user@host" or "user@host:port"')
            }),
            handler: async (params: { query: string }) => {
                // Debug: log received params
                this.logger.debug(`quick_connect received params: ${JSON.stringify(params)}`);

                // Safely extract query with validation
                const query = params?.query;

                // Validate query parameter
                if (!query || typeof query !== 'string') {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: 'Connection query string is required',
                                hint: 'Provide a connection string like "user@host" or "user@host:port"',
                                receivedParams: Object.keys(params || {})
                            })
                        }]
                    };
                }

                // Validate query format (basic check)
                if (!query.includes('@')) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: 'Invalid connection string format',
                                hint: 'Use format "user@host" or "user@host:port"',
                                received: query
                            })
                        }]
                    };
                }

                try {
                    const profile = await this.profilesService.quickConnect(query);

                    if (profile) {
                        this.logger.info(`Quick connect to: ${query}`);
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Connected to: ${query}`, profile: profile.name }) }]
                        };
                    } else {
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Quick connect failed - no profile returned' }) }]
                        };
                    }
                } catch (error: any) {
                    this.logger.error('Error with quick connect:', error);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message || 'Unknown error during quick connect' }) }]
                    };
                }
            }
        };
    }

    // ============= Split Pane Operations =============

    private createSplitTabTool(): McpTool {
        return {
            name: 'split_tab',
            description: `Split the current terminal pane in a direction.
Creates a new pane with a copy of the current terminal.
Direction: 'right'/'left'/'top'/'bottom' (or shorthand 'r'/'l'/'t'/'b')
The active tab must be inside a SplitTabComponent, or be a terminal that can be wrapped.`,
            schema: z.object({
                direction: z.enum(['horizontal', 'vertical', 'right', 'left', 'top', 'bottom', 'r', 'l', 't', 'b'])
                    .describe('Split direction: right/left/top/bottom (or r/l/t/b), or horizontal/vertical'),
                ratio: z.number().optional().describe('Split ratio (0.1 to 0.9, default: 0.5) - not yet implemented')
            }),
            handler: async (params: { direction: string; ratio?: number }) => {
                const { direction } = params;

                // Map direction to SplitDirection ('t', 'r', 'b', 'l')
                let splitDir: 'r' | 'l' | 't' | 'b';
                let positionLabel: string;
                switch (direction) {
                    case 'right':
                    case 'r':
                    case 'horizontal':
                        splitDir = 'r';
                        positionLabel = 'right';
                        break;
                    case 'left':
                    case 'l':
                        splitDir = 'l';
                        positionLabel = 'left';
                        break;
                    case 'top':
                    case 't':
                        splitDir = 't';
                        positionLabel = 'top';
                        break;
                    case 'bottom':
                    case 'b':
                    case 'vertical':
                        splitDir = 'b';
                        positionLabel = 'bottom';
                        break;
                    default:
                        splitDir = 'r';
                        positionLabel = 'right';
                }

                const activeTab = this.app.activeTab;
                if (!activeTab) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No active tab' }) }]
                    };
                }

                try {
                    // Check if we're inside a SplitTabComponent
                    if (activeTab instanceof SplitTabComponent) {
                        // Active tab IS a SplitTabComponent - split the focused pane
                        const splitTab = activeTab as SplitTabComponent;
                        const focusedPane = splitTab.getFocusedTab();

                        if (focusedPane) {
                            const newTab = await (splitTab as any).splitTab(focusedPane, splitDir);
                            if (newTab) {
                                this.logger.info(`Split pane ${splitDir} in SplitTabComponent`);
                                return {
                                    content: [{
                                        type: 'text', text: JSON.stringify({
                                            success: true,
                                            direction: direction,
                                            message: `Created split pane to the ${positionLabel}`,
                                            paneCount: splitTab.getAllTabs().length
                                        })
                                    }]
                                };
                            }
                        }
                    }

                    // Check if the parent is a SplitTabComponent
                    const parent = this.app.getParentTab(activeTab);
                    if (parent && parent instanceof SplitTabComponent) {
                        const splitTab = parent as SplitTabComponent;
                        const newTab = await (splitTab as any).splitTab(activeTab, splitDir);
                        if (newTab) {
                            this.logger.info(`Split tab ${splitDir} (parent is SplitTabComponent)`);
                            return {
                                content: [{
                                    type: 'text', text: JSON.stringify({
                                        success: true,
                                        direction: direction,
                                        message: `Created split pane to the ${positionLabel}`,
                                        paneCount: splitTab.getAllTabs().length
                                    })
                                }]
                            };
                        }
                    }

                    // Current tab is not in a split - duplicate and explain
                    // This is the fallback for tabs that are not yet in a SplitTabComponent
                    const newTab = await this.app.duplicateTab(activeTab);
                    if (newTab) {
                        this.logger.info(`Created new tab (split not available for this tab type)`);
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: true,
                                    direction: direction,
                                    message: `Created new tab to the ${positionLabel} (split not available for this tab type)`,
                                    note: 'Use terminal tabs for true split pane functionality',
                                    fallback: true
                                })
                            }]
                        };
                    }

                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not create split' }) }]
                    };
                } catch (error: any) {
                    this.logger.error('Error splitting tab:', error);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }]
                    };
                }
            }
        };
    }
}
