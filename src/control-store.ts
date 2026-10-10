import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { loadConfig, saveConfig, validateConfig } from './config.js';
import { importClientConfig } from './import.js';
import type { GatewayConfig, ServerConfig } from './types.js';

export class ControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

type View = {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  disabled: boolean;
  allowedTools?: string[];
  envKeys: string[];
  headerKeys: string[];
  envReferences?: Record<string, string>;
  headerReferences?: Record<string, string>;
  oauth?: false | { clientId?: string; clientSecretEnv?: string };
  hasPrivateUrlParts?: boolean;
  argsContainSecrets?: boolean;
};
type State = {
  revision: string;
  config: Pick<
    GatewayConfig,
    'security' | 'inlineTools' | 'nativeTools' | 'limits'
  >;
  servers: View[];
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const safeName = (s: unknown): s is string =>
  typeof s === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) &&
  !['__proto__', 'constructor', 'prototype'].includes(s);
const refs = (map?: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(map ?? {}).flatMap(([k, v]) => {
      const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
      return m ? [[k, m[1]]] : [];
    }),
  );
const fingerprint = (c: GatewayConfig) =>
  createHash('sha256').update(JSON.stringify(c)).digest('hex');

export function createControlStore(
  configPath: string,
  onChange: () => Promise<void>,
) {
  let queue = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const read = async () => {
    try {
      try {
        await access(configPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return {
            version: 1 as const,
            servers: {},
            security: { allowCode: false },
          };
        throw error;
      }
      return await loadConfig(configPath);
    } catch {
      throw new ControlError('Configuration could not be loaded', 500);
    }
  };
  const publicState = (c: GatewayConfig): State => {
    const secrets = new Set<string>();
    for (const s of Object.values(c.servers)) {
      const map = 'command' in s ? s.env : s.headers;
      for (const v of Object.values(map ?? {}))
        if (v.length >= 4 && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v))
          secrets.add(v);
    }
    const scrub = (s: string) => {
      for (const secret of secrets) s = s.split(secret).join('[redacted]');
      return s;
    };
    const servers = Object.entries(c.servers).map(([name, s]): View => {
      if ('command' in s)
        return {
          name,
          transport: 'stdio',
          command: scrub(s.command),
          ...(s.args
            ? {
                args: s.args.map(scrub),
                ...(s.args.some((arg) => scrub(arg) !== arg)
                  ? { argsContainSecrets: true }
                  : {}),
              }
            : {}),
          ...(s.cwd ? { cwd: scrub(s.cwd) } : {}),
          disabled: s.disabled === true,
          ...(s.allowedTools
            ? { allowedTools: s.allowedTools.map(scrub) }
            : {}),
          envKeys: Object.keys(s.env ?? {}),
          headerKeys: [],
          ...(Object.keys(refs(s.env)).length
            ? { envReferences: refs(s.env) }
            : {}),
        };
      let url = s.url,
        hasPrivateUrlParts = false;
      try {
        const parsed = new URL(url.replace(/\$\{[^}]+\}/g, 'placeholder'));
        hasPrivateUrlParts = !!(parsed.search || parsed.hash);
        parsed.search = '';
        parsed.hash = '';
        url = url.replace(/\?[^#]*/, '').replace(/#.*$/, '');
      } catch {
        /* config validation handles invalid URLs */
      }
      return {
        name,
        transport: 'http',
        url: scrub(url),
        hasPrivateUrlParts,
        disabled: s.disabled === true,
        ...(s.allowedTools ? { allowedTools: s.allowedTools.map(scrub) } : {}),
        envKeys: [],
        headerKeys: Object.keys(s.headers ?? {}),
        ...(Object.keys(refs(s.headers)).length
          ? { headerReferences: refs(s.headers) }
          : {}),
        ...(s.oauth !== undefined
          ? {
              oauth:
                s.oauth === false
                  ? false
                  : {
                      ...(s.oauth.clientId
                        ? { clientId: scrub(s.oauth.clientId) }
                        : {}),
                      ...(s.oauth.clientSecretEnv
                        ? { clientSecretEnv: s.oauth.clientSecretEnv }
                        : {}),
                    },
            }
          : {}),
      };
    });
    return {
      revision: fingerprint(c),
      config: {
        security: { allowCode: c.security?.allowCode !== false },
        ...(c.inlineTools ? { inlineTools: c.inlineTools } : {}),
        ...(c.nativeTools ? { nativeTools: c.nativeTools } : {}),
        ...(c.limits ? { limits: c.limits } : {}),
      },
      servers,
    };
  };
  const commit = async (c: GatewayConfig) => {
    try {
      await saveConfig(configPath, c);
    } catch {
      throw new ControlError('Configuration could not be saved', 500);
    }
    try {
      await onChange();
    } catch {
      /* saved configuration remains authoritative */
    }
    return publicState(c);
  };
  const requireRevision = (c: GatewayConfig, rev: unknown) => {
    if (typeof rev !== 'string' || rev !== fingerprint(c))
      throw new ControlError('Configuration changed; reload and retry', 409);
  };
  return {
    state: async () => publicState(await read()),
    upsert: (input: unknown) =>
      serialize(async () => {
        if (
          !object(input) ||
          Object.keys(input).some(
            (k) => !['revision', 'name', 'server'].includes(k),
          ) ||
          !safeName(input.name) ||
          !object(input.server)
        )
          throw new ControlError('Invalid server request', 400);
        const c = await read();
        requireRevision(c, input.revision);
        const prior = c.servers[input.name];
        const view = publicState(c).servers.find((s) => s.name === input.name);
        const raw = { ...input.server };
        if (prior && 'command' in prior && typeof raw.command === 'string') {
          if (!Object.hasOwn(raw, 'env')) raw.env = prior.env;
          if (raw.command === view?.command) raw.command = prior.command;
          if (raw.cwd === view?.cwd && Object.hasOwn(raw, 'cwd'))
            raw.cwd = prior.cwd;
          if (
            Array.isArray(raw.args) &&
            prior.args &&
            raw.args.length === prior.args.length
          ) {
            const supplied = raw.args as unknown[];
            raw.args = supplied.map((arg: unknown, i: number) =>
              arg === view?.args?.[i] ? prior.args![i] : arg,
            );
          }
        } else if (prior && 'url' in prior && raw.command === undefined) {
          // An omitted URL preserves the stored endpoint, including its private query/fragment.
          if (!Object.hasOwn(raw, 'url')) raw.url = prior.url;
          if (!Object.hasOwn(raw, 'headers')) raw.headers = prior.headers;
          if (!Object.hasOwn(raw, 'oauth')) raw.oauth = prior.oauth;
          if (
            object(raw.oauth) &&
            object(prior.oauth) &&
            view?.oauth &&
            raw.oauth.clientId === view.oauth.clientId
          )
            raw.oauth.clientId = prior.oauth.clientId;
        }
        if (
          prior?.allowedTools &&
          Array.isArray(raw.allowedTools) &&
          raw.allowedTools.length === prior.allowedTools.length
        ) {
          const supplied = raw.allowedTools as unknown[];
          raw.allowedTools = supplied.map((value, i) =>
            value === view?.allowedTools?.[i] ? prior.allowedTools![i] : value,
          );
        }
        c.servers[input.name] = raw as unknown as ServerConfig;
        let normalized: GatewayConfig;
        try {
          normalized = validateConfig(c);
        } catch {
          throw new ControlError('Invalid server configuration', 400);
        }
        return commit(normalized);
      }),
    remove: (name: string, input: unknown) =>
      serialize(async () => {
        if (
          !safeName(name) ||
          !object(input) ||
          Object.keys(input).some((k) => k !== 'revision')
        )
          throw new ControlError('Invalid remove request', 400);
        const c = await read();
        requireRevision(c, input.revision);
        if (!Object.hasOwn(c.servers, name))
          throw new ControlError('Server not found', 404);
        delete c.servers[name];
        c.inlineTools = c.inlineTools?.filter((x) => x.server !== name);
        c.nativeTools = c.nativeTools?.filter((x) => x.server !== name);
        return commit(validateConfig(c));
      }),
    policy: (input: unknown) =>
      serialize(async () => {
        if (
          !object(input) ||
          Object.keys(input).some(
            (k) => !['revision', 'security'].includes(k),
          ) ||
          !object(input.security)
        )
          throw new ControlError('Invalid policy request', 400);
        const c = await read();
        requireRevision(c, input.revision);
        const next = {
          ...c,
          security: input.security as GatewayConfig['security'],
        };
        let normalized: GatewayConfig;
        try {
          normalized = validateConfig(next);
        } catch {
          throw new ControlError('Invalid security policy', 400);
        }
        return commit(normalized);
      }),
    import: (input: unknown) =>
      serialize(async () => {
        if (
          !object(input) ||
          Object.keys(input).some(
            (k) =>
              ![
                'revision',
                'text',
                'format',
                'workspaceDir',
                'names',
                'apply',
              ].includes(k),
          ) ||
          typeof input.text !== 'string' ||
          typeof input.workspaceDir !== 'string' ||
          (input.format !== undefined &&
            (typeof input.format !== 'string' ||
              !['auto', 'mcpServers', 'vscode', 'opencode'].includes(
                input.format,
              ))) ||
          (input.names !== undefined &&
            (!Array.isArray(input.names) ||
              input.names.some((x) => typeof x !== 'string'))) ||
          typeof input.apply !== 'boolean'
        )
          throw new ControlError('Invalid import request', 400);
        const c = await read();
        requireRevision(c, input.revision);
        const result = importClientConfig(input.text, {
          format: input.format as never,
          workspaceDir: input.workspaceDir,
          names: input.names as string[] | undefined,
        });
        const conflicts = Object.keys(result.servers).filter((n) =>
          Object.hasOwn(c.servers, n),
        );
        const summary = {
          format: result.format,
          servers: Object.entries(result.servers).map(([name, s]) => ({
            name,
            transport: 'command' in s ? 'stdio' : 'http',
          })),
          issues: result.issues.map((x) => ({
            server: x.server,
            message: x.message,
          })),
          notices: result.notices,
          conflicts,
        };
        if (!input.apply) return summary;
        if (result.issues.length)
          throw new ControlError(
            'Import has issues and cannot be applied',
            400,
          );
        if (conflicts.length)
          throw new ControlError('Import conflicts with existing servers', 409);
        requireRevision(c, input.revision);
        const next = { ...c, servers: { ...c.servers, ...result.servers } };
        let normalized: GatewayConfig;
        try {
          normalized = validateConfig(next);
        } catch {
          throw new ControlError('Imported configuration is invalid', 400);
        }
        await commit(normalized);
        return summary;
      }),
  };
}
