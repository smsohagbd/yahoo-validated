import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'yv_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function secret() {
  return config.sessionSecret || config.apiToken || 'dev-insecure-secret';
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function tokensMatch(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function checkDashboardLogin(username, password) {
  return tokensMatch(username, config.dashboardUser) && tokensMatch(password, config.dashboardPass);
}

export function sessionUser(req) {
  const token = parseCookies(req)[COOKIE];
  const payload = verify(token);
  return payload?.u || null;
}

export function setSessionCookie(res, username) {
  const token = sign({ u: username, exp: Date.now() + MAX_AGE_MS });
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  );
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function requireDashboard(req, res, next) {
  if (!sessionUser(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return next();
}
