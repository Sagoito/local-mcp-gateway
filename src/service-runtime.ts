import { loadConfig } from './config.js';
import { createUpstreams } from './upstreams.js';
import type { GatewayConfig, ToolEntry, Upstreams } from './types.js';

type Sources = Upstreams & { getErrors(): Record<string, string> };

/** One connection pool shared by the dashboard and agent sessions. */
export async function createServiceRuntime(configPath: string) {
  let config = await loadConfig(configPath);
  let fingerprint = JSON.stringify(config);
  let catalog: ToolEntry[] | undefined;
  let checkedAt: number | null = null;
  const createSources = (settings: GatewayConfig): Sources => {
    const source = createUpstreams(settings, configPath);
    const wrapped: Sources = {
      ...source,
      async listTools() {
        const tools = await source.listTools();
        if (sources === wrapped) {
          catalog = tools;
          checkedAt = Date.now();
        }
        return tools;
      },
    };
    return wrapped;
  };
  let sources: Sources = createSources(config);
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  const reload = (force = false): Promise<Sources> =>
    serialize(async () => {
      if (closed) throw new Error('Service is closed');
      const next = await loadConfig(configPath);
      const nextFingerprint = JSON.stringify(next);
      if (force || nextFingerprint !== fingerprint) {
        const old = sources;
        config = next;
        fingerprint = nextFingerprint;
        catalog = undefined;
        checkedAt = null;
        sources = createSources(config);
        await old.close();
      }
      return sources;
    });
  return {
    get: () => reload(),
    config: () => config,
    status: () => ({ catalog, checkedAt, errors: sources.getErrors() }),
    refresh: async () => {
      const current = await reload(true);
      await current.listTools();
    },
    close: () =>
      serialize(async () => {
        if (closed) return;
        closed = true;
        await sources.close();
      }),
  };
}

export type ServiceRuntime = Awaited<ReturnType<typeof createServiceRuntime>>;
