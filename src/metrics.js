import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const RECENT_MAX = 250;

function empty() {
  return {
    total: 0,
    taken: 0,
    available: 0,
    failed: 0,
    rateLimited: 0,
    errors: {},
    recent: [],
    startedAt: Date.now(),
  };
}

class Metrics {
  constructor() {
    this.state = empty();
    this.file = null;
  }

  load() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.file = path.join(config.dataDir, 'metrics.json');
    if (!fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { ...empty(), ...parsed, recent: Array.isArray(parsed.recent) ? parsed.recent.slice(-RECENT_MAX) : [] };
    } catch {
      this.state = empty();
    }
  }

  save() {
    if (!this.file) return;
    const { recent, ...rest } = this.state;
    fs.writeFileSync(this.file, `${JSON.stringify({ ...rest, recent: recent.slice(-100) }, null, 2)}\n`);
  }

  record(entry) {
    this.state.total += 1;
    if (entry.fail) {
      this.state.failed += 1;
      const code = entry.error || 'check_failed';
      this.state.errors[code] = (this.state.errors[code] || 0) + 1;
      if (code === 'rate_limited') this.state.rateLimited += 1;
    } else if (entry.validate) {
      this.state.taken += 1;
    } else {
      this.state.available += 1;
    }
    this.state.recent.push({
      ts: new Date().toISOString(),
      email: entry.email,
      validate: Boolean(entry.validate),
      fail: Boolean(entry.fail),
      error: entry.error || null,
      message: entry.message || '',
      provider: entry.provider || null,
      proxy: entry.proxy || null,
      ms: entry.ms || 0,
      ip: entry.ip || null,
    });
    if (this.state.recent.length > RECENT_MAX) {
      this.state.recent.splice(0, this.state.recent.length - RECENT_MAX);
    }
  }

  snapshot() {
    return {
      total: this.state.total,
      taken: this.state.taken,
      available: this.state.available,
      failed: this.state.failed,
      rateLimited: this.state.rateLimited,
      errors: this.state.errors,
      recent: this.state.recent.slice().reverse(),
      startedAt: this.state.startedAt,
    };
  }
}

export const metrics = new Metrics();
