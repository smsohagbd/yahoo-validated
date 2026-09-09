import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = process.env.ENV_FILE || path.join(rootDir, '.env');

if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export { rootDir };

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: envInt('PORT', 6100),
  apiToken: process.env.API_TOKEN || '',
  minWorkers: Math.max(1, envInt('MIN_WORKERS', 2)),
  maxWorkers: Math.max(1, envInt('MAX_WORKERS', 5)),
  headless: envBool('HEADLESS', true),
  requestTimeoutMs: envInt('REQUEST_TIMEOUT_MS', 25000),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  dataDir: process.env.DATA_DIR || path.join(rootDir, 'data'),
  logsDir: process.env.LOGS_DIR || path.join(rootDir, 'logs'),
  publicDir: path.join(rootDir, 'public'),
  dashboardUser: process.env.DASHBOARD_USER || 'admin',
  dashboardPass: process.env.DASHBOARD_PASS || 'admin',
  sessionSecret: process.env.SESSION_SECRET || '',
  serverIp: process.env.SERVER_IP || '',
  rateLimitMax: envInt('RATE_LIMIT_MAX', 30),
  rateLimitWindowMs: envInt('RATE_LIMIT_WINDOW_MS', 60000),
  proxyMinIntervalMs: envInt('PROXY_MIN_INTERVAL_MS', 2000),
  proxyMaxPerMin: envInt('PROXY_MAX_PER_MIN', 20),
  proxyRotation: (process.env.PROXY_ROTATION || 'round_robin').toLowerCase(),
};

if (config.maxWorkers < config.minWorkers) {
  config.maxWorkers = config.minWorkers;
}
