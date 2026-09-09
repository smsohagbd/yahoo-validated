import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

function safeFile() {
  return path.join(config.dataDir, 'proxies.json');
}

export function parseProxyLine(rawLine) {
  let line = String(rawLine || '').trim();
  if (!line || line.startsWith('#')) return null;

  let rotational = false;
  if (/^(rotate|rotating|rotational):/i.test(line)) {
    rotational = true;
    line = line.replace(/^(rotate|rotating|rotational):/i, '').trim();
  }

  let typeHint = null;
  if (/^socks5h?:/i.test(line) && !line.includes('://')) {
    typeHint = 'socks5';
    line = line.replace(/^socks5h?:/i, '').replace(/^\/\//, '');
  } else if (/^https?:/i.test(line) && !line.includes('://')) {
    typeHint = 'http';
    line = line.replace(/^https?:/i, '').replace(/^\/\//, '');
  }

  let parsed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
    const u = new URL(line);
    const scheme = u.protocol.replace(':', '').toLowerCase();
    const type = scheme.startsWith('socks') ? 'socks5' : 'http';
    const port = u.port || (type === 'socks5' ? '1080' : scheme === 'https' ? '443' : '80');
    parsed = {
      type,
      server: `${type === 'socks5' ? 'socks5' : 'http'}://${u.hostname}:${port}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } else {
    const at = line.match(/^([^:@]+):([^@]+)@(\[[^\]]+\]|[^:]+):(\d+)$/);
    if (at) {
      parsed = {
        type: typeHint || 'http',
        server: `${(typeHint || 'http') === 'socks5' ? 'socks5' : 'http'}://${at[3]}:${at[4]}`,
        username: at[1],
        password: at[2],
      };
    } else {
      const parts = line.split(':');
      if (parts.length === 4) {
        const [host, port, username, password] = parts;
        parsed = {
          type: typeHint || 'http',
          server: `${(typeHint || 'http') === 'socks5' ? 'socks5' : 'http'}://${host}:${port}`,
          username,
          password,
        };
      } else if (parts.length === 2) {
        parsed = {
          type: typeHint || 'http',
          server: `${(typeHint || 'http') === 'socks5' ? 'socks5' : 'http'}://${parts[0]}:${parts[1]}`,
        };
      }
    }
  }

  if (!parsed?.server) {
    const err = new Error(`Unrecognized proxy format: ${rawLine}`);
    err.code = 'invalid_proxy';
    throw err;
  }

  return {
    raw: String(rawLine).trim(),
    rotational,
    type: parsed.type,
    server: parsed.server,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
  };
}

function toPlaywright(item) {
  const proxy = { server: item.server };
  if (item.username) proxy.username = item.username;
  if (item.password) proxy.password = item.password;
  return proxy;
}

function displayName(item) {
  try {
    const u = new URL(item.server);
    const auth = item.username ? `${item.username}:****@` : '';
    return `${item.type}://${auth}${u.hostname}:${u.port}`;
  } catch {
    return item.server;
  }
}

function loadInitialFromEnv() {
  const blob = process.env.PROXY_LIST || '';
  if (!blob.trim()) {
    if (!process.env.PROXY_SERVER) return [];
    try {
      const username = process.env.PROXY_USERNAME || '';
      const password = process.env.PROXY_PASSWORD || '';
      const server = process.env.PROXY_SERVER;
      const line = username
        ? server.replace('://', `://${encodeURIComponent(username)}:${encodeURIComponent(password)}@`)
        : server;
      const parsed = parseProxyLine(line);
      return parsed ? [{ ...emptyStats(), id: newId(), enabled: true, label: 'env', ...parsed }] : [];
    } catch {
      return [];
    }
  }
  const items = [];
  for (const line of blob.split(/[\n,]+/)) {
    try {
      const parsed = parseProxyLine(line);
      if (parsed) items.push({ ...emptyStats(), id: newId(), enabled: true, label: '', ...parsed });
    } catch (err) {
      logger.warn('skipping invalid PROXY_LIST entry', { error: err.message });
    }
  }
  return items;
}

function emptyStats() {
  return {
    success: 0,
    fail: 0,
    lastError: null,
    lastUsed: 0,
    cooldownUntil: 0,
    minuteHits: [],
  };
}

class ProxyPool {
  constructor() {
    this.rotation = config.proxyRotation === 'random' ? 'random' : 'round_robin';
    this.items = [];
    this.cursor = 0;
    this.listeners = [];
  }

  load() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const file = safeFile();
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.rotation = parsed.rotation === 'random' ? 'random' : 'round_robin';
        this.items = Array.isArray(parsed.items) ? parsed.items.map((item) => ({ ...emptyStats(), ...item })) : [];
      } catch (err) {
        logger.error('failed to read proxies.json', { error: err.message });
        this.items = [];
      }
    } else {
      this.items = loadInitialFromEnv();
      this.save();
    }
    logger.info('proxy pool loaded', { count: this.items.length, rotation: this.rotation });
  }

  save() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const dump = {
      rotation: this.rotation,
      items: this.items.map(({ minuteHits, ...rest }) => rest),
    };
    fs.writeFileSync(safeFile(), `${JSON.stringify(dump, null, 2)}\n`);
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  notify() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        logger.warn('proxy change listener failed', { error: err.message });
      }
    }
  }

  list() {
    return this.items.map((item) => ({
      id: item.id,
      label: item.label || '',
      enabled: item.enabled !== false,
      type: item.type,
      rotational: Boolean(item.rotational),
      display: displayName(item),
      success: item.success || 0,
      fail: item.fail || 0,
      lastError: item.lastError,
      lastUsed: item.lastUsed,
      cooldownUntil: item.cooldownUntil,
    }));
  }

  enabled() {
    const now = Date.now();
    return this.items.filter((item) => item.enabled !== false && (item.cooldownUntil || 0) <= now);
  }

  pick() {
    const ready = this.enabled();
    const pool = ready.length ? ready : this.items.filter((item) => item.enabled !== false);
    if (!pool.length) return null;
    if (this.rotation === 'random') {
      return pool[Math.floor(Math.random() * pool.length)];
    }
    this.cursor = this.cursor % pool.length;
    const item = pool[this.cursor];
    this.cursor += 1;
    return item;
  }

  assignment() {
    const item = this.pick();
    if (!item) return null;
    return this.toAssignment(item);
  }

  assignmentFor(id) {
    const item = this.get(id);
    if (!item) return this.assignment();
    return this.toAssignment(item);
  }

  toAssignment(item) {
    return {
      id: item.id,
      rotational: Boolean(item.rotational),
      display: displayName(item),
      playwright: toPlaywright(item),
    };
  }

  hasProxies() {
    return this.items.some((item) => item.enabled !== false);
  }

  get(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  async waitTurn(id) {
    const item = this.get(id);
    if (!item) return;
    const min = config.proxyMinIntervalMs;
    const gap = item.lastUsed ? item.lastUsed + min - Date.now() : 0;
    if (gap > 0) await sleep(gap);

    const windowMs = 60000;
    const now = Date.now();
    item.minuteHits = (item.minuteHits || []).filter((t) => now - t < windowMs);
    if (item.minuteHits.length >= config.proxyMaxPerMin) {
      const wait = windowMs - (now - item.minuteHits[0]) + 50;
      logger.warn('proxy per-minute cap, waiting', { id, wait });
      await sleep(wait);
      item.minuteHits = item.minuteHits.filter((t) => Date.now() - t < windowMs);
    }
    item.minuteHits.push(Date.now());
    item.lastUsed = Date.now();
  }

  reportSuccess(id) {
    const item = this.get(id);
    if (!item) return;
    item.success += 1;
    item.lastError = null;
    item.cooldownUntil = 0;
  }

  reportFail(id, message) {
    const item = this.get(id);
    if (!item) return;
    item.fail += 1;
    item.lastError = String(message || 'failed').slice(0, 200);
    if (item.fail > 0 && item.fail % 5 === 0) {
      item.cooldownUntil = Date.now() + 5 * 60 * 1000;
      logger.warn('proxy cooling down', { id, until: item.cooldownUntil });
    }
  }

  addMany(lines, { rotational = false, label = '' } = {}) {
    const added = [];
    const errors = [];
    for (const raw of String(lines || '').split(/\r?\n/)) {
      try {
        const parsed = parseProxyLine(raw);
        if (!parsed) continue;
        if (rotational) parsed.rotational = true;
        const dup = this.items.some(
          (item) => item.raw === parsed.raw || (item.server === parsed.server && item.username === parsed.username),
        );
        if (dup) {
          errors.push({ line: raw, error: 'duplicate' });
          continue;
        }
        const item = {
          ...emptyStats(),
          id: newId(),
          enabled: true,
          label,
          ...parsed,
        };
        this.items.push(item);
        added.push(item.id);
      } catch (err) {
        errors.push({ line: raw, error: err.message });
      }
    }
    if (added.length) {
      this.save();
      this.notify();
    }
    return { added: added.length, errors };
  }

  update(id, patch) {
    const item = this.get(id);
    if (!item) return false;
    if (patch.enabled != null) item.enabled = Boolean(patch.enabled);
    if (patch.rotational != null) item.rotational = Boolean(patch.rotational);
    if (patch.label != null) item.label = String(patch.label);
    this.save();
    this.notify();
    return true;
  }

  remove(id) {
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    this.save();
    this.notify();
    return true;
  }

  setRotation(mode) {
    this.rotation = mode === 'random' ? 'random' : 'round_robin';
    this.save();
  }

  stats() {
    return {
      total: this.items.length,
      enabled: this.items.filter((i) => i.enabled !== false).length,
      rotation: this.rotation,
    };
  }
}

export const proxyPool = new ProxyPool();
