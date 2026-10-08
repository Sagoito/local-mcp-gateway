export type ServerConfig = { command: string; args?: string[]; env?: Record<string,string>; disabled?: boolean } | { url: string; headers?: Record<string,string>; oauth?: { clientId?: string; clientSecretEnv?: string }; disabled?: boolean };
export interface GatewayConfig { version: 1; servers: Record<string,ServerConfig> }
export interface ToolEntry { server: string; name: string; description?: string; inputSchema: Record<string,unknown> }
export interface Upstreams {
 listTools(): Promise<ToolEntry[]>;
 callTool(server: string, tool: string, args: Record<string,unknown>, signal?: AbortSignal): Promise<unknown>;
 close(): Promise<void>;
}
export interface SandboxOptions { timeoutMs?: number; memoryBytes?: number; maxCalls?: number; maxOutputBytes?: number }
