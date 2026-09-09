import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { setupDashboard } from './dashboard.js';
import { initLogs, logger } from './logger.js';
import { metrics } from './metrics.js';
import { BrowserPool } from './pool.js';
import { proxyPool } from './proxy.js';
import { RateLimiter, clientIp } from './rateLimit.js';
import { send } from './respond.js';
import { tokenStore } from './tokens.js';
import { runVerify } from './verify.js';

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

function publicHost() {
  return config.serverIp || '127.0.0.1';
}

function finish(res, req, body) {
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

function readEmail(req) {
  return req.body?.email || req.body?.address || req.query.email || req.query.address || '';
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
      validate: false,
      error: 'rate_limited',
      message: `Rate limit exceeded. Retry in ${gate.retryAfter}s.`,
      retryable: true,
      email: readEmail(req) || null,
      username: null,
      provider: null,
      proxy: null,
      ms: Date.now() - started,
    });
  }
  return next();
}

function requireToken(req, res, next) {
  if (!config.apiToken && tokenStore.list().length === 0) {
    return finish(res, req, {
      ok: false,
      fail: true,
      validate: false,
      error: 'server_misconfigured',
      message: 'API token is not configured on the server',
      retryable: false,
      email: null,
      username: null,
      provider: null,
      proxy: null,
      ms: 0,
    });
  }
  const token = String(extractToken(req));
  if (!tokenStore.isValid(token)) {
    return finish(res, req, {
      ok: false,
      fail: true,
      validate: false,
      error: 'unauthorized',
      message: 'Invalid or missing API token',
      retryable: false,
      email: null,
      username: null,
      provider: null,
      proxy: null,
      ms: 0,
    });
  }
  tokenStore.touch(token);
  return next();
}

async function handleVerify(req, res) {
  const body = await runVerify(pool, readEmail(req));
  return finish(res, req, body);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false, limit: '512kb' }));

setupDashboard(app, { pool, finish });

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'yahoo_validated',
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    ...pool.stats(),
    proxies: proxyPool.stats(),
    public: {
      ip: publicHost(),
      verify: `http://${publicHost()}:${config.port}/verify`,
      dashboard: `http://${publicHost()}:${config.port}/dashboard`,
    },
  });
});

app.all('/verify', limitVerify, requireToken, (req, res) => {
  handleVerify(req, res).catch((err) => {
    logger.error('unhandled verify error', { error: err.message });
    finish(res, req, {
      ok: false,
      fail: true,
      validate: false,
      error: 'check_failed',
      message: err.message,
      retryable: true,
      email: null,
      username: null,
      provider: null,
      proxy: null,
      ms: 0,
    });
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
  tokenStore.load();
  proxyPool.load();
  proxyPool.onChange(() => {
    pool.recycleAll().catch((err) => logger.warn('recycle after proxy change failed', { error: err.message }));
  });

  await pool.start();
  server = app.listen(config.port, config.host, () => {
    logger.info('api listening', {
      bind: `${config.host}:${config.port}`,
      verify: `http://${publicHost()}:${config.port}/verify`,
      dashboard: `http://${publicHost()}:${config.port}/dashboard`,
    });
  });
}

main().catch((err) => {
  logger.error('fatal start error', { error: err.message });
  process.exit(1);
});
