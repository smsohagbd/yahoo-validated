import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const current = LEVELS[config.logLevel] ?? LEVELS.info;
const RING_MAX = 800;
const FILE_MAX_BYTES = 5 * 1024 * 1024;

const ring = [];
let stream = null;
let logFile = null;

function rotateIfNeeded() {
  if (!logFile) return;
  try {
    const st = fs.statSync(logFile);
    if (st.size < FILE_MAX_BYTES) return;
  } catch {
    return;
  }
  try {
    stream?.end();
  } catch {
    // ignore
  }
  const rotated = `${logFile}.1`;
  try {
    if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
    fs.renameSync(logFile, rotated);
  } catch {
    // ignore
  }
  stream = fs.createWriteStream(logFile, { flags: 'a' });
}

export function initLogs() {
  fs.mkdirSync(config.logsDir, { recursive: true });
  logFile = path.join(config.logsDir, 'app.log');
  stream = fs.createWriteStream(logFile, { flags: 'a' });
}

function write(level, msg, extra) {
  if ((LEVELS[level] ?? 2) > current) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(extra && typeof extra === 'object' ? extra : extra != null ? { extra } : {}),
  };
  ring.push(line);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);

  const text = JSON.stringify(line);
  const out = level === 'error' ? console.error : console.log;
  out(text);
  if (stream) {
    rotateIfNeeded();
    stream.write(`${text}\n`);
  }
}

export function recentLogs(limit = 200, level) {
  const items = ring.slice(-Math.max(1, Math.min(limit, RING_MAX)));
  if (!level || level === 'all') return items;
  return items.filter((row) => row.level === level);
}

export const logger = {
  error: (msg, extra) => write('error', msg, extra),
  warn: (msg, extra) => write('warn', msg, extra),
  info: (msg, extra) => write('info', msg, extra),
  debug: (msg, extra) => write('debug', msg, extra),
};
