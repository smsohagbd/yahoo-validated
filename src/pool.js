import { chromium } from 'playwright';
import { config } from './config.js';
import { logger } from './logger.js';
import { PROVIDERS } from './providers.js';
import { proxyPool } from './proxy.js';
import { checkUsernameTaken, isBlocked, resetUsernameField, waitForSignupForm } from './validator.js';

const BLOCKED_RESOURCES = new Set(['image', 'media', 'font']);
const BLOCKED_URL = /google-analytics|googletagmanager|doubleclick|scorecardresearch|facebook\.net|hotjar|adservice|advertising\.yahoo|gemini\.yahoo/i;

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--use-mock-keychain',
  '--disable-blink-features=AutomationControlled',
];

let nextId = 1;

function providerUrl(id) {
  return PROVIDERS[id]?.createUrl;
}

function classifyError(err) {
  const msg = String(err.message || '');
  if (!err.code) {
    if (/ERR_PROXY|ERR_TUNNEL|proxy/i.test(msg)) err.code = 'proxy_failed';
    else if (/timeout/i.test(msg)) err.code = 'timeout';
    else err.code = 'check_failed';
  }
  return err;
}

export class BrowserPool {
  constructor() {
    this.browser = null;
    this.workers = [];
    this.queue = [];
    this.pumping = false;
    this.closed = false;
    this.lastJobAt = Date.now();
    this.scaleTimer = null;
  }

  async start() {
    logger.info('launching chromium', { headless: config.headless, min: config.minWorkers, max: config.maxWorkers });
    this.browser = await chromium.launch({
      headless: config.headless,
      args: LAUNCH_ARGS,
    });

    const warmup = ['yahoo', 'aol'];
    for (let i = 0; i < config.minWorkers; i += 1) {
      await this.spawnWorker(warmup[i % warmup.length]);
    }

    this.scaleTimer = setInterval(() => {
      this.scaleDownIdle().catch((err) => logger.warn('scale down failed', { error: err.message }));
    }, 30000);

    logger.info('browser pool ready', { workers: this.workers.length });
  }

  stats() {
    return {
      workers: this.workers.length,
      busy: this.workers.filter((w) => w.busy).length,
      queue: this.queue.length,
      byProvider: this.workers.reduce((acc, w) => {
        acc[w.provider] = (acc[w.provider] || 0) + 1;
        return acc;
      }, {}),
      proxies: this.workers.map((w) => ({ id: w.id, proxy: w.proxyDisplay, provider: w.provider, busy: w.busy })),
    };
  }

  async spawnWorker(preferredProvider = 'yahoo', assignment = null) {
    if (!this.browser || this.closed) throw new Error('pool closed');
    if (this.workers.length >= config.maxWorkers) return null;

    const picked = assignment || proxyPool.assignment();
    const contextOptions = {
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      javaScriptEnabled: true,
    };
    if (picked?.playwright) contextOptions.proxy = picked.playwright;

    const context = await this.browser.newContext(contextOptions);

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await context.route('**/*', (route) => {
      const req = route.request();
      if (BLOCKED_RESOURCES.has(req.resourceType()) || BLOCKED_URL.test(req.url())) {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const worker = {
      id: nextId++,
      context,
      page,
      provider: preferredProvider,
      busy: false,
      checks: 0,
      lastUsed: Date.now(),
      proxyId: picked?.id || null,
      proxyDisplay: picked?.display || 'direct',
      rotational: Boolean(picked?.rotational),
    };
    this.workers.push(worker);

    try {
      await this.ensureProvider(worker, preferredProvider);
    } catch (err) {
      logger.warn('worker warmup failed', { id: worker.id, error: err.message, proxy: worker.proxyDisplay });
      if (worker.proxyId) proxyPool.reportFail(worker.proxyId, err.message);
    }

    logger.info('worker spawned', {
      id: worker.id,
      provider: worker.provider,
      proxy: worker.proxyDisplay,
      total: this.workers.length,
    });
    return worker;
  }

  async ensureProvider(worker, provider) {
    const url = providerUrl(provider);
    if (!url) throw new Error('unknown provider');
    const already = worker.page.url().startsWith(url.split('?')[0]);
    if (already && worker.provider === provider) {
      const ready = await worker.page.locator('#usernamereg-userId, input[name="userId"]').count();
      if (ready) return;
    }
    await worker.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await waitForSignupForm(worker.page);
    if (await isBlocked(worker.page)) {
      const err = new Error('blocked');
      err.code = 'blocked';
      throw err;
    }
    worker.provider = provider;
  }

  async recycleWorker(worker, provider = worker.provider, { sameProxy = false } = {}) {
    logger.info('recycling worker', { id: worker.id, provider, proxy: worker.proxyDisplay, sameProxy });
    try {
      await worker.page.close({ runBeforeUnload: false }).catch(() => {});
      await worker.context.close().catch(() => {});
    } catch {
      // ignore
    }
    const idx = this.workers.indexOf(worker);
    if (idx >= 0) this.workers.splice(idx, 1);
    if (!this.closed) {
      const assignment = sameProxy && worker.proxyId ? proxyPool.assignmentFor(worker.proxyId) : proxyPool.assignment();
      await this.spawnWorker(provider, assignment);
    }
  }

  async recycleAll() {
    logger.info('recycling all workers after proxy change');
    const old = this.workers.splice(0);
    for (const w of old) {
      await w.page.close().catch(() => {});
      await w.context.close().catch(() => {});
    }
    if (this.closed) return;
    const warmup = ['yahoo', 'aol'];
    for (let i = 0; i < config.minWorkers; i += 1) {
      await this.spawnWorker(warmup[i % warmup.length]);
    }
  }

  pickWorker(provider) {
    const free = this.workers.filter((w) => !w.busy);
    const same = free.find((w) => w.provider === provider);
    return same || free[0] || null;
  }

  enqueue(task, timeoutMs = config.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, at: Date.now() };
      const timer = setTimeout(() => {
        const pos = this.queue.indexOf(item);
        if (pos >= 0) {
          this.queue.splice(pos, 1);
          reject(Object.assign(new Error('queue_timeout'), { code: 'timeout' }));
        }
      }, timeoutMs);
      item.timer = timer;
      this.queue.push(item);
      this.pump();
    });
  }

  async pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const provider = this.queue[0]?.task?.provider;
        let worker = this.pickWorker(provider);
        if (!worker && this.workers.length < config.maxWorkers) {
          try {
            await this.spawnWorker(provider || 'yahoo');
          } catch (err) {
            logger.error('spawn worker failed', { error: err.message });
            break;
          }
          worker = this.pickWorker(provider);
        }
        if (!worker) break;

        const item = this.queue.shift();
        if (!item) break;
        clearTimeout(item.timer);
        this.runJob(worker, item);
      }
    } finally {
      this.pumping = false;
    }
  }

  async runJob(worker, item) {
    worker.busy = true;
    worker.lastUsed = Date.now();
    this.lastJobAt = Date.now();
    try {
      const result = await item.task.run(worker);
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      worker.busy = false;
      worker.lastUsed = Date.now();
      this.pump();
    }
  }

  async verify({ username, provider }) {
    return this.enqueue({
      provider,
      run: async (worker) => {
        try {
          if (worker.proxyId) await proxyPool.waitTurn(worker.proxyId);
          await this.ensureProvider(worker, provider);
          const result = await checkUsernameTaken(worker.page, username);
          worker.checks += 1;
          if (worker.proxyId) proxyPool.reportSuccess(worker.proxyId);

          const shouldReload = result.taken || worker.checks >= 15 || worker.rotational;
          if (worker.rotational) {
            await this.recycleWorker(worker, provider, { sameProxy: true });
          } else if (shouldReload) {
            await resetUsernameField(worker.page, { reload: true, url: providerUrl(provider) }).catch(async (err) => {
              logger.warn('reload after check failed', { id: worker.id, error: err.message });
              await this.recycleWorker(worker, provider, { sameProxy: true });
            });
          } else {
            await resetUsernameField(worker.page).catch(() => {});
          }
          return { ...result, proxy: worker.proxyDisplay };
        } catch (err) {
          classifyError(err);
          logger.warn('verify job failed', {
            id: worker.id,
            error: err.message,
            code: err.code,
            proxy: worker.proxyDisplay,
          });
          if (worker.proxyId) proxyPool.reportFail(worker.proxyId, err.message);
          await this.recycleWorker(worker, provider, {
            sameProxy: err.code !== 'blocked' && err.code !== 'proxy_failed',
          }).catch(() => {});
          throw err;
        }
      },
    });
  }

  async scaleDownIdle() {
    if (this.closed || this.queue.length) return;
    const idleMs = Date.now() - this.lastJobAt;
    if (idleMs < 90000) return;
    while (this.workers.length > config.minWorkers) {
      const extra = this.workers.find((w) => !w.busy);
      if (!extra) break;
      logger.info('scaling down idle worker', { id: extra.id, remaining: this.workers.length - 1 });
      extra.busy = true;
      const idx = this.workers.indexOf(extra);
      if (idx >= 0) this.workers.splice(idx, 1);
      await extra.page.close().catch(() => {});
      await extra.context.close().catch(() => {});
    }
  }

  async stop() {
    this.closed = true;
    if (this.scaleTimer) clearInterval(this.scaleTimer);
    for (const item of this.queue.splice(0)) {
      clearTimeout(item.timer);
      item.reject(Object.assign(new Error('shutting_down'), { code: 'shutdown' }));
    }
    await Promise.all(
      this.workers.map(async (w) => {
        await w.page.close().catch(() => {});
        await w.context.close().catch(() => {});
      }),
    );
    this.workers = [];
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
