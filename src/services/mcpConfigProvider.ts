import { Injectable } from '@angular/core';
import { ConfigProvider } from 'tabby-core';

/**
 * MCP Configuration Provider - Default settings for the plugin
 */
@Injectable()
export class McpConfigProvider extends ConfigProvider {
    defaults = {
        mcp: {
            port: 3001,
            host: 'http://localhost:3001',
            enableLogging: true,
            startOnBoot: true,
            logLevel: 'info',
            pairProgrammingMode: {
                enabled: true,
                showConfirmationDialog: true,
                autoFocusTerminal: true
            },
            // Timing configuration (in milliseconds)
            timing: {
                pollInterval: 100,          // How often to check for command output
                initialDelay: 0,            // Delay before starting to poll (0 = no delay)
                sessionStableChecks: 5,     // Number of stable checks for session ready detection
                sessionPollInterval: 200    // Interval for session ready polling
            }
        }
    };
}
