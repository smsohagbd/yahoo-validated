import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function tokensMatch(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function hashesMatch(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function mask(prefix) {
  return `${prefix}…`;
}

class TokenStore {
  constructor() {
    this.items = [];
    this.file = null;
  }

  load() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.file = path.join(config.dataDir, 'tokens.json');
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.items = Array.isArray(parsed.items) ? parsed.items : [];
      } catch (err) {
        logger.error('failed to read tokens.json', { error: err.message });
        this.items = [];
      }
    }
    this.save();
  }

  save() {
    if (!this.file) return;
    fs.writeFileSync(this.file, `${JSON.stringify({ items: this.items }, null, 2)}\n`);
  }

  list() {
    const rows = this.items.map((item) => ({
      id: item.id,
      name: item.name,
      prefix: mask(item.prefix),
      enabled: item.enabled !== false,
      createdAt: item.createdAt,
      lastUsed: item.lastUsed || null,
    }));
    if (config.apiToken) {
      rows.unshift({
        id: 'setup',
        name: 'setup',
        prefix: mask(config.apiToken.slice(0, 8)),
        enabled: true,
        createdAt: null,
        lastUsed: null,
        locked: true,
      });
    }
    return rows;
  }

  create(name = 'api') {
    const token = crypto.randomBytes(32).toString('hex');
    const item = {
      id: newId(),
      name: String(name || 'api').slice(0, 40),
      prefix: token.slice(0, 8),
      hash: hashToken(token),
      enabled: true,
      createdAt: new Date().toISOString(),
      lastUsed: null,
    };
    this.items.push(item);
    this.save();
    logger.info('api token created', { id: item.id, name: item.name });
    return { id: item.id, name: item.name, token, prefix: mask(item.prefix) };
  }

  revoke(id) {
    if (id === 'setup') return false;
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    this.save();
    logger.info('api token revoked', { id });
    return true;
  }

  isValid(raw) {
    const token = String(raw || '');
    if (!token) return false;
    if (config.apiToken && tokensMatch(token, config.apiToken)) return true;
    const hashed = hashToken(token);
    return this.items.some((item) => item.enabled !== false && hashesMatch(item.hash, hashed));
  }

  touch(raw) {
    const hashed = hashToken(raw);
    const item = this.items.find((row) => hashesMatch(row.hash, hashed));
    if (!item) return;
    item.lastUsed = new Date().toISOString();
  }
}

export const tokenStore = new TokenStore();
