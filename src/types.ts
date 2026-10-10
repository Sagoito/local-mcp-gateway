import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
export type ServerConfig = ({ command: string; args?: string[]; env?: Record<string,string>; disabled?: boolean; allowedTools?: string[] } | { url: string; headers?: Record<string,string>; oauth?: { clientId?: string; clientSecretEnv?: string }; disabled?: boolean; allowedTools?: string[] });
export interface GatewayConfig { version: 1; servers: Record<string,ServerConfig>; inlineTools?: Array<{ server: string; tool: string }>; nativeTools?: Array<{server: string; tool: string}>; security?: { allowCode?: boolean }; limits?: { maxTools?: number; maxCatalogBytes?: number; maxToolBytes?: number; maxPages?: number } }
export interface ToolEntry { server: string; name: string; description?: string; inputSchema: Record<string,unknown>; annotations?: ToolAnnotations }
export interface Upstreams {
 // Each listTools result is an immutable catalogue snapshot: return the same
 // array while its contents are unchanged, and a new array when tools change.
 // Consumers may retain indexes keyed by snapshot identity; never mutate one in place.
 listTools(): Promise<ToolEntry[]>;
 callTool(server: string, tool: string, args: Record<string,unknown>, signal?: AbortSignal): Promise<unknown>;
 getResult?(id: string): Promise<unknown>;
 close(): Promise<void>;
}
export interface SandboxOptions { timeoutMs?: number; memoryBytes?: number; maxCalls?: number; maxOutputBytes?: number; signal?: AbortSignal }
