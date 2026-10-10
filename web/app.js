(() => {
  'use strict';
  let state = null;
  let loginTimer = null;
  let modalReturnFocus = null;
  const $ = (id) => document.getElementById(id);
  const root = $('modal-root');
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const button = (label, className, fn, aria) => {
    const b = el('button', className, label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', fn);
    return b;
  };
  const setNotice = (message, kind = 'info') => {
    const box = $('notice');
    box.className = `notice ${kind === 'info' ? '' : kind}`.trim();
    $('notice-text').textContent = message;
    box.hidden = !message;
  };
  const request = async (path, options = {}) => {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    headers.set('X-Weftly-Request', '1');
    if (options.sessionToken)
      headers.set('Authorization', `Bearer ${options.sessionToken}`);
    if (options.body !== undefined)
      headers.set('Content-Type', 'application/json');
    let response;
    const fetchOptions = { ...options };
    delete fetchOptions.sessionToken;
    try {
      response = await fetch(path, {
        ...fetchOptions,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      throw new Error(
        'Could not reach the local service. Check that it is running and try again.',
      );
    }
    let data = {};
    try {
      data = await response.json();
    } catch {
      /* an empty response is handled below */
    }
    if (!response.ok)
      throw new Error(
        typeof data.error === 'string'
          ? data.error
          : `Request failed (${response.status}).`,
      );
    return data;
  };
  const jsonBody = (value) => JSON.stringify(value);
  const setConnected = (yes) => {
    $('service-dot').classList.toggle('offline-dot', !yes);
    $('service-label').textContent = yes
      ? 'Service connected'
      : 'Service unavailable';
    $('service-label').parentElement.classList.toggle('offline', !yes);
  };
  const showModal = (title, subtitle, content, opts = {}) => {
    modalReturnFocus = document.activeElement;
    root.replaceChildren();
    const backdrop = el('div', 'modal-backdrop');
    const dialog = el('section', `dialog${opts.wide ? ' wide' : ''}`);
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'dialog-title');
    const head = el('div', 'dialog-header');
    const titleWrap = el('div');
    const h = el('h2', '', title);
    h.id = 'dialog-title';
    titleWrap.append(h);
    if (subtitle) titleWrap.append(el('p', '', subtitle));
    const close = button(
      '×',
      'icon-button dialog-close',
      closeModal,
      'Close dialog',
    );
    head.append(titleWrap, close);
    const body = el('div', 'dialog-body');
    body.append(content);
    dialog.append(head, body);
    if (opts.footer) {
      const footer = el('div', 'dialog-footer');
      opts.footer(footer);
      dialog.append(footer);
    }
    backdrop.append(dialog);
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop && !opts.lockBackdrop) closeModal();
    });
    root.append(backdrop);
    const focusTarget = dialog.querySelector(
      'input:not([type=hidden]),button,select,textarea,[tabindex="0"]',
    );
    if (focusTarget) focusTarget.focus();
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !opts.lockEscape) {
        event.preventDefault();
        closeModal();
      }
      if (event.key === 'Tab') {
        const items = [
          ...dialog.querySelectorAll(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]',
          ),
        ];
        if (!items.length) return;
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1).focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0].focus();
        }
      }
    });
    return { dialog, body, footer: dialog.querySelector('.dialog-footer') };
  };
  function closeModal() {
    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = null;
    root.replaceChildren();
    if (modalReturnFocus?.focus) modalReturnFocus.focus();
  }
  const field = (labelText, input, hint, full = false) => {
    const wrap = el('div', `field${full ? ' full' : ''}`);
    const label = el('label', '', labelText);
    if (input.id) label.htmlFor = input.id;
    wrap.append(label, input);
    if (hint) wrap.append(el('div', 'field-hint', hint));
    return wrap;
  };
  const textInput = (id, value = '', placeholder = '', type = 'text') => {
    const input = el('input', 'input');
    input.id = id;
    input.type = type;
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    return input;
  };
  const textarea = (id, value = '', placeholder = '', code = false) => {
    const input = el('textarea', `textarea${code ? ' code' : ''}`);
    input.id = id;
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    return input;
  };
  const checkbox = (id, labelText, checked = false) => {
    const wrap = el('label', 'toggle-row');
    const input = el('input');
    input.id = id;
    input.type = 'checkbox';
    input.checked = checked;
    wrap.append(input, el('span', '', labelText));
    return { wrap, input };
  };
  const detailsText = (server, type) => {
    const refs =
      type === 'env' ? server?.envReferences : server?.headerReferences;
    const keys = type === 'env' ? server?.envKeys : server?.headerKeys;
    const labels = keys || [];
    if (!labels.length) return 'No stored values';
    const references =
      refs && Object.keys(refs).length
        ? ` · References: ${Object.entries(refs)
            .map(([k, v]) => `${k} → ` + '${' + v + '}')
            .join(', ')}`
        : '';
    return `Stored keys: ${labels.join(', ')}${references}`;
  };
  const toMap = (raw, label) => {
    if (!raw.trim()) return undefined;
    const result = {};
    for (const [i, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      const pos = line.indexOf('=');
      if (pos < 1) throw new Error(`${label}, line ${i + 1}: use KEY=VALUE.`);
      const key = line.slice(0, pos).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key))
        throw new Error(`${label}, line ${i + 1}: invalid key.`);
      result[key] = line.slice(pos + 1);
    }
    return Object.keys(result).length ? result : undefined;
  };
  const parseArgs = (raw) => {
    if (!raw.trim()) return [];
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.some((x) => typeof x !== 'string'))
      throw new Error('Arguments must be a JSON array of strings.');
    return value;
  };
  const allowlistControls = (server) => {
    const allowAll = checkbox(
      'allow-all',
      'Allow all tools (no allowlist)',
      !Array.isArray(server?.allowedTools),
    );
    const denyAll = checkbox(
      'deny-all',
      'Deny all tools',
      Array.isArray(server?.allowedTools) && server.allowedTools.length === 0,
    );
    const list = textarea(
      'allowed-tools',
      Array.isArray(server?.allowedTools) ? server.allowedTools.join('\n') : '',
      'one tool name per line',
    );
    const update = () => {
      list.disabled = allowAll.input.checked || denyAll.input.checked;
    };
    allowAll.input.addEventListener('change', () => {
      if (allowAll.input.checked) denyAll.input.checked = false;
      update();
    });
    denyAll.input.addEventListener('change', () => {
      if (denyAll.input.checked) allowAll.input.checked = false;
      update();
    });
    update();
    return {
      wrap: [allowAll.wrap, denyAll.wrap, list],
      value: () => {
        if (
          allowAll.input.checked ||
          (!denyAll.input.checked && !list.value.trim())
        )
          return undefined;
        return denyAll.input.checked
          ? []
          : list.value
              .split(/\r?\n/)
              .map((x) => x.trim())
              .filter(Boolean);
      },
    };
  };
  const openServerEditor = (server = null) => {
    const editing = !!server;
    const type = server?.transport || 'stdio';
    const name = textInput(
      'server-name',
      server?.name || '',
      'e.g. filesystem',
    );
    name.readOnly = editing;
    const transport = el('select', 'select');
    transport.id = 'server-transport';
    for (const [v, text] of [
      ['stdio', 'Command (stdio)'],
      ['http', 'HTTP endpoint'],
    ]) {
      const option = el('option', '', text);
      option.value = v;
      option.selected = type === v;
      transport.append(option);
    }
    const disabled = checkbox(
      'server-disabled',
      'Keep this server disabled',
      server?.disabled === true,
    );
    const command = textInput('server-command', server?.command || '', 'npx');
    const args = textarea(
      'server-args',
      server?.args ? JSON.stringify(server.args, null, 2) : '',
      '["-y", "@example/server"]',
      true,
    );
    const cwd = textInput('server-cwd', server?.cwd || '', '/path/to/project');
    const env = textarea(
      'server-env',
      '',
      'API_KEY=your-secret\nMODE=local',
      true,
    );
    const url = textInput(
      'server-url',
      server?.url || '',
      'https://example.com/mcp',
      'url',
    );
    const headers = textarea(
      'server-headers',
      '',
      'Authorization=Bearer your-token',
      true,
    );
    const clearSecrets = checkbox(
      'clear-secrets',
      'Clear all stored environment/header values',
      false,
    );
    const oauth = checkbox(
      'server-oauth',
      'Use OAuth sign-in',
      server?.oauth !== false,
    );
    const clientId = textInput(
      'oauth-client-id',
      server?.oauth?.clientId || '',
      'OAuth client ID',
    );
    const secretEnv = textInput(
      'oauth-secret-env',
      server?.oauth?.clientSecretEnv || '',
      'OAUTH_CLIENT_SECRET',
    );
    const allow = allowlistControls(server);
    const form = el('form', 'form-grid');
    form.noValidate = true;
    form.append(
      field(
        'Server name',
        name,
        editing
          ? 'Server names stay fixed so tool selections remain attached.'
          : 'Letters, numbers, dots, hyphens, and underscores.',
      ),
      field('Connection type', transport),
    );
    const stdioFields = [
      field('Command', command, 'Executable available to the local service.'),
      field(
        'Working directory',
        cwd,
        'Optional path used when starting the command.',
      ),
      field(
        'Arguments',
        args,
        server?.argsContainSecrets
          ? 'Some argument values are hidden as [redacted]. Leave those placeholders unchanged to preserve saved values. To replace one, enter its complete new argument value.'
          : 'JSON array of command arguments.',
        true,
      ),
      field(
        'Environment values',
        env,
        'New values are written to the private server config.',
        true,
      ),
    ];
    const storedEnv = el('div', 'stored-keys');
    storedEnv.append(
      el('strong', '', 'Stored credentials · '),
      el('span', '', detailsText(server, 'env')),
    );
    stdioFields.push(
      field(
        'Saved environment keys',
        storedEnv,
        'Leave new values empty to preserve existing values.',
        true,
      ),
    );
    const httpFields = [
      field(
        'Endpoint URL',
        url,
        'Private query and fragment parts are kept when unchanged.',
        true,
      ),
      field(
        'Headers',
        headers,
        'New values are written to the private server config.',
        true,
      ),
    ];
    const storedHeaders = el('div', 'stored-keys');
    storedHeaders.append(
      el('strong', '', 'Stored credentials · '),
      el('span', '', detailsText(server, 'headers')),
    );
    httpFields.push(
      field(
        'Saved header keys',
        storedHeaders,
        'Leave new values empty to preserve existing values.',
        true,
      ),
    );
    const oauthLine = el('div', 'field full');
    oauthLine.append(oauth.wrap);
    httpFields.push(
      oauthLine,
      field(
        'OAuth client ID',
        clientId,
        'Optional, depending on the provider.',
      ),
      field(
        'Client secret environment key',
        secretEnv,
        'The value remains in the local environment.',
      ),
    );
    const secretLine = el('div', 'field full');
    secretLine.append(clearSecrets.wrap);
    const allowHead = el('div', 'divider-label', 'TOOL ACCESS');
    const disabledLine = el('div', 'field full');
    disabledLine.append(disabled.wrap);
    const allowHead2 = el('div', 'field full');
    allowHead2.append(...allow.wrap);
    const setTransport = () => {
      form.replaceChildren(
        field(
          'Server name',
          name,
          editing
            ? 'Server names stay fixed so tool selections remain attached.'
            : 'Letters, numbers, dots, hyphens, and underscores.',
        ),
        field('Connection type', transport),
      );
      form.append(...(transport.value === 'stdio' ? stdioFields : httpFields));
      form.append(secretLine, disabledLine, allowHead, allowHead2);
      const showOAuth = transport.value === 'http' && oauth.input.checked;
      clientId.closest('.field').hidden = !showOAuth;
      secretEnv.closest('.field').hidden = !showOAuth;
    };
    transport.addEventListener('change', setTransport);
    oauth.input.addEventListener('change', setTransport);
    setTransport();
    const error = el('div', 'dialog-notice');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    const content = el('div');
    content.append(form, error);
    showModal(
      editing ? 'Edit server' : 'Add a server',
      editing
        ? 'Update this connection and its tool access.'
        : 'Connect a local command or an MCP HTTP endpoint.',
      content,
      {
        wide: true,
        footer: (f) => {
          f.append(button('Cancel', 'button button-secondary', closeModal));
          const save = button(
            editing ? 'Save changes' : 'Add server',
            'button button-primary',
            async () => {
              save.disabled = true;
              error.hidden = true;
              try {
                const n = name.value.trim();
                if (!n) throw new Error('Enter a server name.');
                if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n))
                  throw new Error(
                    'Use 1–64 letters, numbers, dots, hyphens, or underscores for the server name.',
                  );
                const serverValue = { disabled: disabled.input.checked };
                const allowedTools = allow.value();
                if (allowedTools !== undefined)
                  serverValue.allowedTools = allowedTools;
                if (transport.value === 'stdio') {
                  if (!command.value.trim())
                    throw new Error('Enter the command to start this server.');
                  serverValue.command = command.value.trim();
                  serverValue.args = parseArgs(args.value);
                  if (cwd.value.trim()) serverValue.cwd = cwd.value.trim();
                  const map = clearSecrets.input.checked
                    ? {}
                    : toMap(env.value, 'Environment values');
                  if (map !== undefined) serverValue.env = map;
                } else {
                  if (!url.value.trim())
                    throw new Error('Enter the HTTP endpoint URL.');
                  if (
                    !editing ||
                    type !== 'http' ||
                    url.value.trim() !== server.url
                  )
                    serverValue.url = url.value.trim();
                  const map = clearSecrets.input.checked
                    ? {}
                    : toMap(headers.value, 'Headers');
                  if (map !== undefined) serverValue.headers = map;
                  serverValue.oauth = oauth.input.checked
                    ? {
                        ...(clientId.value.trim()
                          ? { clientId: clientId.value.trim() }
                          : {}),
                        ...(secretEnv.value.trim()
                          ? { clientSecretEnv: secretEnv.value.trim() }
                          : {}),
                      }
                    : false;
                }
                const next = await request('/api/servers', {
                  method: 'POST',
                  body: jsonBody({
                    revision: state.revision,
                    name: n,
                    server: serverValue,
                  }),
                });
                state = next;
                await loadState();
                closeModal();
                setNotice(
                  editing
                    ? 'Server settings saved.'
                    : 'Server added. Refresh connections to discover its tools.',
                );
              } catch (e) {
                error.textContent = e.message;
                error.hidden = false;
                if (e.message.includes('changed')) await loadState();
              } finally {
                save.disabled = false;
              }
            },
          );
          f.append(save);
        },
      },
    );
  };
  const confirmRemove = (server) => {
    const text = el(
      'p',
      '',
      `Remove “${server.name}” and its tool selections from this workspace?`,
    );
    text.className = 'remove-prompt';
    const message = el(
      'div',
      'dialog-notice',
      'This does not delete any files or packages installed on your computer.',
    );
    const content = el('div');
    content.append(text, message);
    showModal(
      'Remove server',
      'This action updates your local configuration.',
      content,
      {
        footer: (f) => {
          f.append(button('Cancel', 'button button-secondary', closeModal));
          const remove = button(
            'Remove server',
            'button button-primary',
            async () => {
              remove.disabled = true;
              try {
                state = await request(
                  `/api/servers/${encodeURIComponent(server.name)}`,
                  {
                    method: 'DELETE',
                    body: jsonBody({ revision: state.revision }),
                  },
                );
                await loadState();
                closeModal();
                setNotice(`${server.name} was removed.`);
              } catch (e) {
                message.textContent = e.message;
                if (e.message.includes('changed')) await loadState();
              } finally {
                remove.disabled = false;
              }
            },
          );
          remove.classList.add('danger-button');
          f.append(remove);
        },
      },
    );
  };
  const showTokenDialog = (
    message = 'Paste the startup administrator token to unlock this local workspace.',
  ) => {
    const input = textInput(
      'admin-token',
      '',
      'Administrator token',
      'password',
    );
    input.autocomplete = 'off';
    const hint = el(
      'div',
      'dialog-notice',
      'The token is sent once and discarded. The service keeps your browser session in a protected cookie; after the service restarts, enter the token again or use the local launch link.',
    );
    const error = el('div', 'dialog-notice');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    const content = el('div');
    content.append(
      el('p', '', message),
      field('Administrator token', input),
      hint,
      error,
    );
    showModal(
      'Unlock your workspace',
      'Local access is protected by your administrator token.',
      content,
      {
        lockBackdrop: true,
        lockEscape: true,
        footer: (f) => {
          const unlock = button(
            'Connect',
            'button button-primary',
            async () => {
              if (!input.value) {
                error.textContent = 'Enter the administrator token.';
                error.hidden = false;
                return;
              }
              unlock.disabled = true;
              try {
                await request('/api/session', {
                  method: 'POST',
                  sessionToken: input.value,
                });
                await loadState();
                closeModal();
              } catch (e) {
                error.textContent = e.message;
                error.hidden = false;
              } finally {
                unlock.disabled = false;
              }
            },
          );
          f.append(unlock);
        },
      },
    );
  };
  const openSettings = () => {
    const security = state?.config?.security || {};
    const allowCode = checkbox(
      'allow-code',
      'Allow code execution tools',
      security.allowCode === true,
    );
    const content = el('div');
    const intro = el(
      'p',
      '',
      'Code execution is disabled by default. Enabling it allows eligible tools to execute code within the configured gateway limits.',
    );
    intro.className = 'form-help';
    const notice = el(
      'div',
      'dialog-notice',
      'Policy changes apply to subsequent requests. Review which tools you trust before enabling code execution.',
    );
    const error = el('div', 'dialog-notice');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    content.append(intro, allowCode.wrap, notice, error);
    showModal(
      'Workspace settings',
      'Control the local gateway security policy.',
      content,
      {
        footer: (f) => {
          f.append(button('Cancel', 'button button-secondary', closeModal));
          const save = button(
            'Save policy',
            'button button-primary',
            async () => {
              save.disabled = true;
              try {
                state = await request('/api/policy', {
                  method: 'POST',
                  body: jsonBody({
                    revision: state.revision,
                    security: {
                      ...security,
                      allowCode: allowCode.input.checked,
                    },
                  }),
                });
                await loadState();
                closeModal();
                setNotice('Workspace security policy saved.');
              } catch (e) {
                error.textContent = e.message;
                error.hidden = false;
                if (e.message.includes('changed')) await loadState();
              } finally {
                save.disabled = false;
              }
            },
          );
          f.append(save);
        },
      },
    );
  };
  const openImport = () => {
    const source = textarea(
      'import-source',
      '',
      'Paste supported client JSON or JSONC here.',
      true,
    );
    source.rows = 9;
    const format = el('select', 'select');
    format.id = 'import-format';
    for (const [v, t] of [
      ['auto', 'Detect format'],
      ['mcpServers', 'mcpServers'],
      ['vscode', 'VS Code'],
      ['opencode', 'OpenCode'],
    ]) {
      const o = el('option', '', t);
      o.value = v;
      format.append(o);
    }
    const workspace = textInput(
      'import-workspace',
      '',
      'Optional workspace directory',
    );
    const content = el('div');
    const form = el('div', 'form-grid');
    form.append(
      field(
        'Configuration',
        source,
        'The source file is read as text and is never modified.',
        true,
      ),
      field('Format', format),
      field(
        'Workspace directory',
        workspace,
        'Used to resolve relative paths when applicable.',
      ),
    );
    content.append(form);
    const resultBox = el('div');
    content.append(resultBox);
    const runReview = async (apply) => {
      const payload = {
        revision: state.revision,
        text: source.value,
        format: format.value,
        workspaceDir: workspace.value.trim() || '.',
        apply,
      };
      const result = await request('/api/import', {
        method: 'POST',
        body: jsonBody(payload),
      });
      resultBox.replaceChildren();
      const summary = el(
        'div',
        'dialog-notice',
        `${result.format || format.value} · ${result.servers?.length || 0} server${result.servers?.length === 1 ? '' : 's'} found`,
      );
      resultBox.append(summary);
      const rows = el('div', 'server-review');
      for (const server of result.servers || []) {
        const row = el('div', 'review-row');
        row.append(el('strong', '', server.name));
        row.append(
          el(
            'span',
            'review-tag',
            server.transport === 'stdio' ? 'Command' : 'HTTP',
          ),
        );
        rows.append(row);
      }
      if (rows.childElementCount) resultBox.append(rows);
      const issues = [
        ...(result.issues || []).map(
          (x) => `${x.server ? `${x.server}: ` : ''}${x.message}`,
        ),
        ...(result.conflicts || []).map(
          (x) => `${x} already exists and will be left unchanged.`,
        ),
        ...(result.notices || []),
      ];
      if (issues.length) {
        const ul = el('ul', 'issue-list');
        for (const item of issues) ul.append(el('li', '', item));
        resultBox.append(ul);
      }
      const canApply =
        !!result.servers?.length &&
        !result.issues?.length &&
        !result.conflicts?.length;
      if (apply && canApply) {
        state = await request('/api/state');
        closeModal();
        renderState();
        setNotice(
          'Configuration imported. Refresh connections to discover tools.',
        );
      }
      return { result, canApply };
    };
    showModal(
      'Import configuration',
      'Review detected servers before adding them to this workspace.',
      content,
      {
        wide: true,
        footer: (f) => {
          f.append(button('Cancel', 'button button-secondary', closeModal));
          const review = button(
            'Review config',
            'button button-secondary',
            async () => {
              review.disabled = true;
              try {
                const r = await runReview(false);
                apply.disabled = !r.canApply;
                apply.hidden = !r.canApply;
              } catch (e) {
                resultBox.replaceChildren(el('div', 'notice error', e.message));
              } finally {
                review.disabled = false;
              }
            },
          );
          f.append(review);
          const apply = button(
            'Import servers',
            'button button-primary',
            async () => {
              apply.disabled = true;
              try {
                const r = await runReview(true);
                if (!r.canApply) {
                  apply.hidden = true;
                  resultBox.append(
                    el(
                      'div',
                      'dialog-notice',
                      'Review the updated results. Resolve any issues before importing.',
                    ),
                  );
                  apply.disabled = false;
                }
              } catch (e) {
                resultBox.replaceChildren(el('div', 'notice error', e.message));
                apply.disabled = false;
                if (e.message.includes('changed')) await loadState();
              }
            },
          );
          apply.hidden = true;
          f.append(apply);
        },
      },
    );
  };
  const openConnection = async (client = 'generic') => {
    try {
      const data = await request(
        `/api/connection?client=${encodeURIComponent(client)}`,
      );
      const entry = data.entry || data;
      const serialized = JSON.stringify(entry, null, 2);
      const content = el('div');
      content.append(
        el(
          'p',
          '',
          'Add this private service connection to the MCP client you want to use. The administrator credential is never included.',
        ),
      );
      const selector = el('select', 'select');
      for (const [v, t] of [
        ['generic', 'Generic MCP client'],
        ['copilot', 'GitHub Copilot'],
        ['vscode', 'VS Code'],
        ['opencode', 'OpenCode'],
      ]) {
        const o = el('option', '', t);
        o.value = v;
        o.selected = client === v;
        selector.append(o);
      }
      const pre = el('pre', '', serialized);
      const block = el('div', 'connection-block');
      block.append(pre);
      content.prepend(field('Client', selector));
      content.append(block);
      const endpoint = data.endpoint || data.url || '';
      if (endpoint)
        content.append(el('div', 'form-help', `Endpoint: ${endpoint}`));
      const copied = el('div', 'dialog-notice', '');
      copied.hidden = true;
      content.append(copied);
      selector.addEventListener('change', () => {
        closeModal();
        openConnection(selector.value);
      });
      showModal(
        'Connect an agent',
        'Copy the client configuration for this workspace.',
        content,
        {
          wide: true,
          footer: (f) => {
            f.append(button('Done', 'button button-secondary', closeModal));
            const copy = button(
              'Copy configuration',
              'button button-primary',
              async () => {
                try {
                  await navigator.clipboard.writeText(serialized);
                  copied.textContent = 'Configuration copied to clipboard.';
                  copied.hidden = false;
                } catch {
                  copied.textContent =
                    'Clipboard access is unavailable. Select and copy the configuration above.';
                  copied.hidden = false;
                }
              },
            );
            f.append(copy);
          },
        },
      );
    } catch (e) {
      setNotice(e.message, 'error');
    }
  };
  const runLogin = async (server) => {
    try {
      await request(`/api/login/${encodeURIComponent(server.name)}`, {
        method: 'POST',
        body: jsonBody({}),
      });
      const content = el('div');
      const message = el(
        'div',
        'dialog-notice',
        'Sign-in started. The authorization state will update here when the provider responds.',
      );
      content.append(message);
      const linkWrap = el('div');
      content.append(linkWrap);
      const { dialog } = showModal(
        `Sign in to ${server.name}`,
        'Complete OAuth authorization for this upstream.',
        content,
      );
      if (loginTimer) clearTimeout(loginTimer);
      const poll = async () => {
        if (!dialog.isConnected) return false;
        try {
          const data = await request('/api/logins');
          const entries = Array.isArray(data) ? data : [];
          const login = entries.find((x) => x.name === server.name);
          if (!login) return true;
          linkWrap.replaceChildren();
          if (login.authorizationUrl) {
            try {
              const authUrl = new URL(login.authorizationUrl);
              if (
                authUrl.protocol === 'https:' ||
                authUrl.protocol === 'http:'
              ) {
                const a = el('a', 'oauth-link', authUrl.href);
                a.href = authUrl.href;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                linkWrap.append(a);
              }
            } catch {
              /* Ignore malformed provider links. */
            }
          }
          if (login.state === 'success') {
            message.textContent =
              'Sign-in complete. Refresh connections to update available tools.';
            return false;
          } else if (login.state === 'error') {
            message.textContent =
              login.error || 'Sign-in could not be completed.';
            message.className = 'dialog-notice';
            return false;
          }
          message.textContent = 'Waiting for sign-in to complete…';
          return true;
        } catch (e) {
          message.textContent = e.message;
          return false;
        }
      };
      const schedulePoll = async () => {
        const pending = await poll();
        if (pending && dialog.isConnected)
          loginTimer = setTimeout(schedulePoll, 1800);
        else loginTimer = null;
      };
      await schedulePoll();
    } catch (e) {
      setNotice(e.message, 'error');
    }
  };
  const renderState = () => {
    const servers = state?.servers || [];
    $('nav-count').textContent = String(servers.length);
    $('server-count').textContent = String(servers.length);
    const connected = servers.filter((s) => s.state === 'ready').length;
    $('stat-connected').textContent = String(connected);
    const tools = servers.reduce(
      (sum, s) =>
        sum +
        (s.state === 'ready' && Number.isFinite(s.toolCount) ? s.toolCount : 0),
      0,
    );
    $('stat-tools').textContent = String(tools);
    const errors = servers.filter((s) => s.state === 'error').length;
    $('stat-status').textContent = errors
      ? `${errors} issue${errors === 1 ? '' : 's'}`
      : 'Ready';
    $('stat-status').classList.toggle('warning-text', !!errors);
    $('stat-subnote').textContent = errors
      ? 'Check affected connections'
      : connected || servers.length === 0
        ? 'Local service connection'
        : 'Refresh connections to check upstreams';
    const list = $('server-list');
    list.replaceChildren();
    if (!servers.length) {
      const empty = el('div', 'empty-card');
      empty.append(
        el('div', 'empty-graphic', '⌘'),
        el('h3', '', 'Your workspace is ready for its first server'),
        el(
          'p',
          '',
          'Add an MCP server or import a supported configuration to bring your tools together.',
        ),
        button('Add your first server', 'button button-primary', () =>
          openServerEditor(),
        ),
      );
      list.append(empty);
      return;
    }
    for (const server of servers) {
      const card = el('article', 'server-card');
      const identity = el('div', 'server-identity');
      identity.append(
        el('div', 'server-symbol', server.transport === 'http' ? '↔' : '⌘'),
      );
      const nameBox = el('div');
      nameBox.append(
        el('div', 'server-name', server.name),
        el(
          'div',
          'server-subtitle',
          server.transport === 'http'
            ? server.url || 'HTTP endpoint'
            : server.command || 'Command server',
        ),
      );
      identity.append(nameBox);
      const metrics = el('div', 'server-metrics');
      const stateLabel =
        server.state === 'ready'
          ? 'Connected'
          : server.state === 'error'
            ? 'Issue'
            : server.state === 'disabled' || server.disabled
              ? 'Disabled'
              : 'Not refreshed';
      const status = el(
        'span',
        `server-state${server.state !== 'ready' ? ' disabled' : ''}`,
      );
      status.append(el('span', 'status-dot'), el('span', '', stateLabel));
      metrics.append(
        status,
        el(
          'span',
          '',
          server.state === 'ready' && Number.isFinite(server.toolCount)
            ? `${server.toolCount} tools`
            : 'Tools not refreshed',
        ),
      );
      if (server.transport === 'http' && server.oauth !== false)
        metrics.append(el('span', '', 'OAuth'));
      if (server.hasPrivateUrlParts)
        metrics.append(el('span', '', 'Private URL parts saved'));
      if (server.error) metrics.append(el('span', '', server.error));
      const actions = el('div', 'server-actions');
      if (server.transport === 'http' && server.oauth !== false)
        actions.append(
          button('↗', 'icon-button', () => runLogin(server), 'Sign in'),
        );
      actions.append(
        button(
          '✎',
          'icon-button',
          () => openServerEditor(server),
          'Edit server',
        ),
      );
      actions.append(
        button(
          '⌫',
          'icon-button danger',
          () => confirmRemove(server),
          'Remove server',
        ),
      );
      card.append(identity, metrics, actions);
      list.append(card);
    }
  };
  const loadState = async () => {
    const next = await request('/api/state');
    state = next;
    setConnected(true);
    renderState();
  };
  const refreshServers = async () => {
    const b = $('refresh-servers');
    b.disabled = true;
    b.textContent = 'Refreshing…';
    try {
      await request('/api/refresh', { method: 'POST', body: jsonBody({}) });
      await loadState();
      setNotice('Connections refreshed. Tool counts are up to date.');
    } catch (e) {
      setNotice(e.message, 'error');
      setConnected(false);
    } finally {
      b.disabled = false;
      b.replaceChildren(document.createTextNode('↻ Refresh connections'));
    }
  };
  $('notice-close').addEventListener('click', () => setNotice(''));
  $('add-server').addEventListener('click', () => openServerEditor());
  $('import-open').addEventListener('click', openImport);
  $('nav-settings').addEventListener('click', openSettings);
  $('refresh-servers').addEventListener('click', refreshServers);
  $('connection-open').addEventListener('click', () => openConnection());
  $('connection-open-bottom').addEventListener('click', () => openConnection());
  window.addEventListener('hashchange', () => {
    if (location.hash === '#servers')
      $('servers').scrollIntoView({ behavior: 'smooth' });
  });
  const fragment = new URLSearchParams(location.hash.slice(1));
  const fragmentToken = fragment.get('token');
  if (location.hash)
    history.replaceState(null, '', location.pathname + location.search);
  (async () => {
    try {
      if (fragmentToken)
        await request('/api/session', {
          method: 'POST',
          body: jsonBody({}),
          sessionToken: fragmentToken,
        });
      await loadState();
    } catch (e) {
      setConnected(false);
      $('stat-status').textContent = 'Locked';
      $('stat-subnote').textContent = 'Administrator access required';
      if (fragmentToken) setNotice(e.message, 'error');
      showTokenDialog();
    }
  })();
})();
