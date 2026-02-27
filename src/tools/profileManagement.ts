import { Injectable, Inject, forwardRef } from '@angular/core';
import { AppService, ConfigService, ProfilesService } from 'tabby-core';
import { BaseTerminalTabComponent } from 'tabby-terminal';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { z } from 'zod';
import { BaseToolCategory } from './base-tool-category';
import { McpLoggerService } from '../services/mcpLogger.service';
import { McpTool } from '../types/types';
import { TerminalToolCategory } from './terminal';

/**
 * Profile Management Tools Category - Profile CRUD, quick connect, and dialog management
 */
@Injectable({ providedIn: 'root' })
export class ProfileManagementToolCategory extends BaseToolCategory {
    name = 'profile_management';

    constructor(
        private app: AppService,
        logger: McpLoggerService,
        private config: ConfigService,
        private profilesService: ProfilesService,
        private ngbModal: NgbModal,
        @Inject(forwardRef(() => TerminalToolCategory)) private terminalTools: TerminalToolCategory
    ) {
        super(logger);
        this.initializeTools();
    }

    private initializeTools(): void {
        this.registerTool(this.createListProfilesTool());
        this.registerTool(this.createOpenProfileTool());
        this.registerTool(this.createQuickConnectTool());
        this.registerTool(this.createAddProfileTool());
        this.registerTool(this.createDelProfileTool());

        this.logger.info('Profile management tools initialized');
    }

    // ============= Profile Query Operations =============

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
                    const formatted = profiles.map(p => ({
                        profileId: p.id,
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

    // ============= Profile Open/Connect Operations =============

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

Response state fields:
- tabReady: Tab/frontend initialized
- sshConnected: SSH connection established (SSH profiles only)
- ready: OVERALL ready state (for SSH: tabReady AND sshConnected)

For SSH profiles, waits until sshSession.open=true (real connection established).

NOTE: This opens a NEW tab. For existing connections, use get_session_list + exec_command.`,
            schema: z.object({
                profileId: z.string().optional().describe('profileId from list_profiles result'),
                profileName: z.string().optional().describe('Profile name (partial match, case-insensitive)'),
                waitForReady: z.boolean().optional().describe('Wait for connection (default: true for SSH, false for local)'),
                timeout: z.number().optional().describe('Timeout in ms when waiting (default: 30000)')
            }),
            handler: async (params: { profileId?: string; profileName?: string; waitForReady?: boolean; timeout?: number }) => {
                this.logger.info(`[open_profile] Received params: ${JSON.stringify(params)}`);

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
                        const tabIndex = this.app.tabs.indexOf(tab);
                        const isSSH = profile.type === 'ssh' || profile.type?.includes('ssh');

                        const waitForReady = params?.waitForReady ?? isSSH;

                        let sessionId: string | undefined;
                        if (tab instanceof BaseTerminalTabComponent) {
                            sessionId = this.terminalTools.getOrCreateSessionId(tab);
                            this.logger.debug(`[open_profile] SessionId assigned: ${sessionId}`);
                        }
                        if (!sessionId) {
                            sessionId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
                                const r = Math.random() * 16 | 0;
                                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                                return v.toString(16);
                            });
                            this.logger.warn(`[open_profile] Tab is not BaseTerminalTabComponent, generated fallback sessionId: ${sessionId}`);
                        }

                        if (waitForReady) {
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

                                const frontendReady = tabAny.frontend !== undefined;
                                const sessionReady = tabAny.sessionReady === true;
                                const sessionOpen = tabAny.session?.open === true;

                                if (isSSH) {
                                    const sshSession = tabAny.sshSession;
                                    if (sshSession && sshSession.open === true) {
                                        sshConnected = true;
                                        tabReady = true;
                                        this.logger.info(`[open_profile] SSH session connected: ${profile.name}`);
                                        break;
                                    }
                                } else {
                                    if (sessionOpen || (frontendReady && sessionReady)) {
                                        tabReady = true;
                                        break;
                                    }
                                }

                                let bufferLength = 0;
                                try {
                                    const xterm = tabAny.frontend?.xterm;
                                    if (xterm?.buffer?.active) {
                                        bufferLength = xterm.buffer.active.length;
                                    }
                                } catch (e) {
                                    // Ignore buffer access errors
                                }

                                if (!isSSH) {
                                    if (bufferLength > 0 && bufferLength === lastBufferLength) {
                                        stableCount++;
                                        if (stableCount >= sessionStableChecks) {
                                            tabReady = true;
                                            break;
                                        }
                                    } else {
                                        stableCount = 0;
                                        lastBufferLength = bufferLength;
                                    }
                                } else {
                                    if (bufferLength !== lastBufferLength) {
                                        lastBufferLength = bufferLength;
                                        this.logger.debug(`[open_profile] SSH buffer activity: ${bufferLength} chars`);
                                    }
                                }

                                await new Promise(resolve => setTimeout(resolve, sessionPollInterval));
                            }

                            const elapsed = Date.now() - startTime;
                            const ready = isSSH ? (tabReady && sshConnected) : tabReady;

                            this.logger.info(`[open_profile] Profile opened: ${profile.name} (tabReady=${tabReady}, sshConnected=${sshConnected}, ready=${ready}, elapsed=${elapsed}ms)`);

                            return {
                                content: [{
                                    type: 'text', text: JSON.stringify({
                                        success: true,
                                        sessionId,
                                        tabIndex,
                                        tabTitle: tab.title,
                                        profileName: profile.name,
                                        profileType: profile.type,
                                        tabReady,
                                        sshConnected: isSSH ? sshConnected : undefined,
                                        ready,
                                        elapsed: `${elapsed}ms`,
                                        message: ready
                                            ? `Profile ready: ${profile.name}`
                                            : tabReady && !sshConnected
                                                ? `Tab opened but SSH not connected: ${profile.name}`
                                                : `Profile opened but not fully ready: ${profile.name}`,
                                        hint: ready
                                            ? 'Use sessionId with exec_command, SFTP tools, etc.'
                                            : 'Session may not be fully connected. Check sshConnected status.'
                                    })
                                }]
                            };
                        }

                        this.logger.info(`[open_profile] Profile opened (no wait): ${profile.name}`);
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: true,
                                    sessionId,
                                    tabIndex,
                                    tabTitle: tab.title,
                                    profileName: profile.name,
                                    profileType: profile.type,
                                    tabReady: undefined,
                                    sshConnected: undefined,
                                    ready: false,
                                    message: `Opened profile: ${profile.name}`,
                                    note: 'Profile opened without waiting. Use get_session_list to check status.',
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
                    this.profilesService.showProfileSelector().then(profile => {
                        if (profile) {
                            this.logger.info(`User selected profile via dialog: ${profile.name}`);
                        } else {
                            this.logger.info('User cancelled profile selector dialog');
                        }
                    }).catch(err => {
                        this.logger.warn('Profile selector dialog closed:', err?.message || 'unknown');
                    });

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
                this.logger.debug(`quick_connect received params: ${JSON.stringify(params)}`);

                const query = params?.query;

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
                        const tab = await this.profilesService.openNewTabForProfile(profile);
                        if (tab) {
                            this.logger.info(`Quick connect tab opened: ${tab.title}`);
                            return {
                                content: [{ type: 'text', text: JSON.stringify({
                                    success: true,
                                    message: `Connected to: ${query}`,
                                    profile: profile.name,
                                    tabTitle: tab.title
                                }) }]
                            };
                        } else {
                            return {
                                content: [{ type: 'text', text: JSON.stringify({
                                    success: false,
                                    error: 'Profile created but failed to open tab',
                                    profile: profile.name
                                }) }]
                            };
                        }
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

    // ============= Profile CRUD Operations =============

    private createAddProfileTool(): McpTool {
        return {
            name: 'add_profile',
            description: `Create a new profile in Tabby configuration.
Supports SSH profiles (type: "ssh") and local profiles (type: "local").

For SSH: provide host, port (default 22), user, and optionally password or keyPath.
For local: provide shell command (optional).

Example SSH: add_profile(name="My Server", type="ssh", options={host:"192.168.1.1", port:22, user:"root"})
Example local: add_profile(name="Bash", type="local", options={command:"bash"})`,
            schema: z.object({
                name: z.string().describe('Profile display name'),
                type: z.string().describe('Profile type: "ssh" or "local"'),
                group: z.string().optional().describe('Profile group for organization'),
                options: z.record(z.any()).optional().describe('Profile options (host, port, user, password, keyPath for SSH; command for local)'),
                icon: z.string().optional().describe('Icon name'),
                color: z.string().optional().describe('Color hex code'),
            }),
            handler: async (params: { name: string; type: string; group?: string; options?: Record<string, any>; icon?: string; color?: string }) => {
                try {
                    const { name, type, group, options, icon, color } = params;

                    const id = `${type}:custom:` + 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
                        const r = Math.random() * 16 | 0;
                        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
                    });

                    const profile: any = {
                        id,
                        type,
                        name,
                        group: group || '',
                        options: options || {},
                        icon: icon || '',
                        color: color || '',
                        disableDynamicTitle: false,
                        weight: 0,
                        isBuiltin: false,
                        isTemplate: false,
                    };

                    if (!this.config.store.profiles) {
                        this.config.store.profiles = [];
                    }
                    this.config.store.profiles.push(profile);
                    await this.config.save();

                    this.logger.info(`Profile created: ${name} (${type}), id=${id}`);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({
                            success: true,
                            message: `Profile "${name}" created`,
                            profileId: id,
                            profileName: name,
                            profileType: type,
                        }) }]
                    };
                } catch (error: any) {
                    this.logger.error('Error creating profile:', error);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message || 'Unknown error' }) }]
                    };
                }
            }
        };
    }

    private createDelProfileTool(): McpTool {
        return {
            name: 'del_profile',
            description: `Delete a profile from Tabby configuration.
Use profileId (from list_profiles) or profileName (partial match, case-insensitive).
Built-in profiles cannot be deleted.`,
            schema: z.object({
                profileId: z.string().optional().describe('Profile ID to delete (from list_profiles)'),
                profileName: z.string().optional().describe('Profile name (partial match, case-insensitive)'),
            }),
            handler: async (params: { profileId?: string; profileName?: string }) => {
                try {
                    const { profileId, profileName } = params;

                    if (!profileId && !profileName) {
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Either profileId or profileName is required' }) }]
                        };
                    }

                    const profiles = await this.profilesService.getProfiles();
                    let target = profileId
                        ? profiles.find(p => p.id === profileId)
                        : profiles.find(p => p.name?.toLowerCase().includes(profileName!.toLowerCase()));

                    if (!target) {
                        return {
                            content: [{ type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'Profile not found',
                                hint: 'Use list_profiles to see available profiles',
                            }) }]
                        };
                    }

                    if (target.isBuiltin) {
                        return {
                            content: [{ type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'Cannot delete built-in profile',
                                profileName: target.name,
                            }) }]
                        };
                    }

                    // Always remove from config.store.profiles directly
                    // provider.deleteProfile() has an empty default implementation
                    // that doesn't actually remove the profile
                    if (this.config.store.profiles) {
                        this.config.store.profiles = this.config.store.profiles.filter(
                            (p: any) => p.id !== target!.id
                        );
                        await this.config.save();
                    }
                    this.logger.info(`Profile deleted: ${target.name} (${target.id})`);

                    return {
                        content: [{ type: 'text', text: JSON.stringify({
                            success: true,
                            message: `Profile "${target.name}" deleted`,
                            profileId: target.id,
                            profileName: target.name,
                        }) }]
                    };
                } catch (error: any) {
                    this.logger.error('Error deleting profile:', error);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message || 'Unknown error' }) }]
                    };
                }
            }
        };
    }

    // ============= Dialog Operations =============

    private createDismissDialogTool(): McpTool {
        return {
            name: 'dismiss_dialog',
            description: `Dismiss all currently open modal dialogs in Tabby.
Use this after show_profile_selector or any other dialog-opening action to programmatically close them.`,
            schema: z.object({}),
            handler: async () => {
                try {
                    const hasOpen = this.ngbModal.hasOpenModals();
                    if (hasOpen) {
                        this.ngbModal.dismissAll('dismissed by MCP');
                        this.logger.info('All open dialogs dismissed');
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'All dialogs dismissed' }) }]
                        };
                    } else {
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'No open dialogs to dismiss' }) }]
                        };
                    }
                } catch (error: any) {
                    this.logger.error('Error dismissing dialogs:', error);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message || 'Unknown error' }) }]
                    };
                }
            }
        };
    }
}
