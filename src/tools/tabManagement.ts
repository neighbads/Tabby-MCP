import { Injectable } from '@angular/core';
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core';
import { BaseTerminalTabComponent } from 'tabby-terminal';
import { z } from 'zod';
import { BaseToolCategory } from './base-tool-category';
import { McpLoggerService } from '../services/mcpLogger.service';
import { McpTool } from '../types/types';

/**
 * Tab Management Tools Category - Tab lifecycle and navigation
 */
@Injectable({ providedIn: 'root' })
export class TabManagementToolCategory extends BaseToolCategory {
    name = 'tab_management';

    constructor(
        private app: AppService,
        logger: McpLoggerService,
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
            const found = this.app.tabs.find(tab => tab.customTitle?.toLowerCase().includes(titleLower) || tab.title?.toLowerCase().includes(titleLower));
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
                        title: tab.customTitle || tab.title || `Tab ${index}`,
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
                // Close tabs one by one so each is pushed onto the reopen stack
                // (app.closeAllTabs() bypasses the reopen stack)
                const tabs = [...this.app.tabs];
                const count = tabs.length;
                let closed = 0;

                for (const tab of tabs) {
                    try {
                        await this.app.closeTab(tab, false);
                        closed++;
                    } catch {
                        // tab may already be destroyed
                    }
                }

                this.logger.info(`Closed all ${closed}/${count} tabs`);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Closed ${closed} tabs` }) }]
                };
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
