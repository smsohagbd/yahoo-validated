import path from 'node:path';
import { config } from './config.js';
import { logger, recentLogs } from './logger.js';
import { metrics } from './metrics.js';
import { proxyPool } from './proxy.js';
import { RateLimiter, clientIp } from './rateLimit.js';
import { checkDashboardLogin, clearSessionCookie, requireDashboard, sessionUser, setSessionCookie } from './session.js';
import { tokenStore } from './tokens.js';
import { runVerify, splitEmails } from './verify.js';

const loginLimit = new RateLimiter({ windowMs: 10 * 60 * 1000, max: 8 });
const BULK_MAX = 50;

export function setupDashboard(app, { pool, finish }) {
  const indexFile = path.join(config.publicDir, 'index.html');

  app.get(['/', '/dashboard', '/dashboard/'], (_req, res) => {
    res.sendFile(indexFile);
  });

  app.post('/dashboard/api/login', (req, res) => {
    const ip = clientIp(req);
    const gate = loginLimit.check(ip);
    if (!gate.allowed) {
      return res.status(200).json({ ok: false, error: 'rate_limited', message: 'Too many login attempts' });
    }
    const username = String(req.body?.username || '');
    const password = String(req.body?.password || '');
    if (!checkDashboardLogin(username, password)) {
      logger.warn('dashboard login failed', { ip });
      return res.status(200).json({ ok: false, error: 'unauthorized', message: 'Invalid username or password' });
    }
    setSessionCookie(res, config.dashboardUser);
    logger.info('dashboard login', { ip });
    return res.status(200).json({ ok: true, user: config.dashboardUser });
  });

  app.post('/dashboard/api/logout', (req, res) => {
    clearSessionCookie(res);
    return res.status(200).json({ ok: true });
  });

  app.get('/dashboard/api/me', (req, res) => {
    const user = sessionUser(req);
    if (!user) return res.status(200).json({ ok: false, user: null });
    return res.status(200).json({ ok: true, user });
  });

  app.get('/dashboard/api/overview', requireDashboard, (_req, res) => {
    const host = config.serverIp || '127.0.0.1';
    const snap = metrics.snapshot();
    res.json({
      ok: true,
      metrics: snap,
      pool: pool.stats(),
      proxies: proxyPool.stats(),
      public: {
        ip: host,
        verify: `http://${host}:${config.port}/verify`,
        dashboard: `http://${host}:${config.port}/dashboard`,
      },
      rateLimit: {
        max: config.rateLimitMax,
        windowMs: config.rateLimitWindowMs,
        proxyMinIntervalMs: config.proxyMinIntervalMs,
        proxyMaxPerMin: config.proxyMaxPerMin,
      },
    });
  });

  app.get('/dashboard/api/logs', requireDashboard, (req, res) => {
    const limit = Math.min(500, Number.parseInt(String(req.query.limit || '200'), 10) || 200);
    const level = String(req.query.level || 'all');
    res.json({ ok: true, logs: recentLogs(limit, level).reverse() });
  });

  app.post('/dashboard/api/test', requireDashboard, async (req, res) => {
    const email = req.body?.email || req.body?.address || '';
    const body = await runVerify(pool, email);
    finish(res, req, body);
  });

  app.post('/dashboard/api/test/bulk', requireDashboard, async (req, res) => {
    const emails = splitEmails(req.body?.emails || req.body?.lines || '').slice(0, BULK_MAX);
    if (!emails.length) {
      return res.json({ ok: false, message: 'No email addresses provided', results: [] });
    }
    const results = [];
    for (const email of emails) {
      const body = await runVerify(pool, email);
      metrics.record({ ...body, ip: clientIp(req) });
      if (body.fail) {
        logger.warn('verify fail', { error: body.error, email: body.email, source: 'dashboard-bulk' });
      } else {
        logger.info('verify ok', { email: body.email, validate: body.validate, source: 'dashboard-bulk' });
      }
      results.push(body);
    }
    res.json({ ok: true, count: results.length, results });
  });

  app.get('/dashboard/api/tokens', requireDashboard, (_req, res) => {
    res.json({ ok: true, items: tokenStore.list() });
  });

  app.post('/dashboard/api/tokens', requireDashboard, (req, res) => {
    const created = tokenStore.create(req.body?.name || 'api');
    res.json({
      ok: true,
      ...created,
      message: 'Copy this token now. It will not be shown again.',
      items: tokenStore.list(),
    });
  });

  app.delete('/dashboard/api/tokens/:id', requireDashboard, (req, res) => {
    const ok = tokenStore.revoke(req.params.id);
    res.json({
      ok,
      message: ok ? 'Token revoked' : 'Cannot revoke the setup token',
      items: tokenStore.list(),
    });
  });

  app.get('/dashboard/api/proxies', requireDashboard, (_req, res) => {
    res.json({ ok: true, rotation: proxyPool.rotation, items: proxyPool.list() });
  });

  app.post('/dashboard/api/proxies', requireDashboard, (req, res) => {
    const lines = req.body?.lines || req.body?.proxies || '';
    const rotational = Boolean(req.body?.rotational);
    const label = String(req.body?.label || '');
    const result = proxyPool.addMany(lines, { rotational, label });
    logger.info('proxies added', result);
    res.json({ ok: true, ...result, items: proxyPool.list() });
  });

  app.post('/dashboard/api/proxies/rotation', requireDashboard, (req, res) => {
    const rotation = String(req.body?.rotation || 'round_robin');
    proxyPool.setRotation(rotation);
    res.json({ ok: true, rotation: proxyPool.rotation });
  });

  app.post('/dashboard/api/proxies/:id', requireDashboard, (req, res) => {
    const ok = proxyPool.update(req.params.id, req.body || {});
    res.json({ ok, items: proxyPool.list() });
  });

  app.delete('/dashboard/api/proxies/:id', requireDashboard, (req, res) => {
    const ok = proxyPool.remove(req.params.id);
    res.json({ ok, items: proxyPool.list() });
  });
}
