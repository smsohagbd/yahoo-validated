import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { setupDashboard } from './dashboard.js';
import { initLogs, logger } from './logger.js';
import { metrics } from './metrics.js';
import { BrowserPool } from './pool.js';
import { parseEmail } from './providers.js';
import { proxyPool } from './proxy.js';
import { RateLimiter, clientIp } from './rateLimit.js';
import { envelope, send } from './respond.js';

function tokensMatch(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const pool = new BrowserPool();
const startedAt = Date.now();
const apiLimit = new RateLimiter({ windowMs: config.rateLimitWindowMs, max: config.rateLimitMax });
setInterval(() => apiLimit.sweep(), 60000).unref();
setInterval(() => metrics.save(), 15000).unref();

function extractToken(req) {
  const header = req.headers.authorization || '';
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  return (
    bearer?.[1] ||
    req.headers['x-api-token'] ||
    req.query.token ||
    req.body?.token ||
    ''
  );
}

function finish(res, req, payload) {
  const body = envelope(payload);
  metrics.record({ ...body, ip: clientIp(req) });
  if (body.fail) {
    logger.warn('verify fail', {
      error: body.error,
      message: body.message,
      email: body.email,
      ip: clientIp(req),
    });
  } else {
    logger.info('verify ok', {
      email: body.email,
      validate: body.validate,
      ms: body.ms,
      proxy: body.proxy,
    });
  }
  return res.status(200).json(body);
}

function limitVerify(req, res, next) {
  const started = Date.now();
  const ip = clientIp(req);
  const gate = apiLimit.check(ip);
  res.setHeader('X-RateLimit-Limit', String(config.rateLimitMax));
  res.setHeader('X-RateLimit-Remaining', String(gate.remaining));
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return finish(res, req, {
      ok: false,
      fail: true,
      error: 'rate_limited',
      message: `Rate limit exceeded. Retry in ${gate.retryAfter}s.`,
      email: readEmail(req) || null,
      ms: Date.now() - started,
    });
  }
  return next();
}

function requireToken(req, res, next) {
  if (!config.apiToken) {
    return finish(res, req, { ok: false, fail: true, error: 'server_misconfigured' });
  }
  const token = String(extractToken(req));
  if (!token || !tokensMatch(token, config.apiToken)) {
    return finish(res, req, { ok: false, fail: true, error: 'unauthorized' });
  }
  return next();
}

function readEmail(req) {
  return req.body?.email || req.body?.address || req.query.email || req.query.address || '';
}

function failCode(err) {
  const code = err.code || 'check_failed';
  if (code === 'blocked') return 'blocked';
  if (code === 'queue_timeout') return 'queue_timeout';
  if (code === 'timeout') return 'timeout';
  if (code === 'proxy_failed') return 'proxy_failed';
  return 'check_failed';
}

async function handleVerify(req, res) {
  const started = Date.now();
  const parsed = parseEmail(readEmail(req));

  if (parsed.error === 'invalid_email') {
    return finish(res, req, { ok: false, fail: true, error: 'invalid_email', ms: Date.now() - started });
  }
  if (parsed.error === 'unsupported_provider') {
    return finish(res, req, {
      ok: false,
      fail: true,
      error: 'unsupported_provider',
      email: parsed.email,
      username: parsed.username,
      ms: Date.now() - started,
    });
  }
  if (parsed.error === 'invalid_username') {
    return finish(res, req, {
      ok: true,
      validate: false,
      error: 'invalid_username',
      email: parsed.email,
      username: parsed.username,
      provider: parsed.provider,
      ms: Date.now() - started,
    });
  }

  try {
    const result = await pool.verify({ username: parsed.username, provider: parsed.provider });
    return finish(res, req, {
      ok: true,
      validate: Boolean(result.taken),
      error: result.invalid ? 'invalid_username' : null,
      email: parsed.email,
      username: parsed.username,
      provider: parsed.provider,
      proxy: result.proxy || null,
      ms: Date.now() - started,
    });
  } catch (err) {
    const error = failCode(err);
    return finish(res, req, {
      ok: false,
      fail: true,
      error,
      message: error === 'check_failed' && err.message ? `Browser check failed: ${err.message}` : undefined,
      email: parsed.email,
      username: parsed.username,
      provider: parsed.provider,
      ms: Date.now() - started,
    });
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false, limit: '512kb' }));

setupDashboard(app, { pool });

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'yahoo_validated',
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    ...pool.stats(),
    proxies: proxyPool.stats(),
  });
});

app.all('/verify', limitVerify, requireToken, (req, res) => {
  handleVerify(req, res).catch((err) => {
    logger.error('unhandled verify error', { error: err.message });
    finish(res, req, { ok: false, fail: true, error: 'check_failed', message: err.message });
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/dashboard')) {
    return res.sendFile(path.join(config.publicDir, 'index.html'));
  }
  send(res, { ok: false, fail: true, error: 'not_found' });
});

let server;

async function shutdown(signal) {
  logger.info('shutting down', { signal });
  metrics.save();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await pool.stop();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { error: err.message });
});
process.on('unhandledRejection', (err) => {
  logger.error('unhandled rejection', { error: err?.message || String(err) });
});

async function main() {
  if (!config.apiToken) {
    logger.error('API_TOKEN is required');
    process.exit(1);
  }

  initLogs();
  metrics.load();
  proxyPool.load();
  proxyPool.onChange(() => {
    pool.recycleAll().catch((err) => logger.warn('recycle after proxy change failed', { error: err.message }));
  });

  await pool.start();
  server = app.listen(config.port, config.host, () => {
    logger.info('api listening', {
      verify: `http://${config.host}:${config.port}/verify`,
      dashboard: `http://${config.host}:${config.port}/dashboard`,
    });
  });
}

main().catch((err) => {
  logger.error('fatal start error', { error: err.message });
  process.exit(1);
});
