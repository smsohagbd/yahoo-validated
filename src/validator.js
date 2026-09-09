import { logger } from './logger.js';

const USER_ID_SELECTOR = [
  '#usernamereg-userId',
  'input[name="userId"]',
  'input[id*="userId" i]',
  'input[autocomplete="username"]',
].join(', ');

const TAKEN_TEXT = /email not available|this id is not available|username is not available|already been taken/i;
const INVALID_TEXT = /use only letters|letters, numbers|too short|invalid user|choose a valid/i;
const BLOCKED_TEXT = /not a robot|unusual activity|verify you are|captcha|try again later|temporarily blocked|access denied/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForSignupForm(page, timeout = 15000) {
  await page.waitForSelector(USER_ID_SELECTOR, { timeout, state: 'visible' });
}

export async function isBlocked(page) {
  const body = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 4000);
  if (BLOCKED_TEXT.test(body)) return true;
  if (await page.locator('iframe[src*="recaptcha"], iframe[title*="captcha" i], #captcha-recaptcha').count()) {
    return true;
  }
  return false;
}

async function usernameInput(page) {
  const labeled = page.getByLabel(/new (yahoo|aol) email/i);
  if (await labeled.count()) return labeled.first();
  return page.locator(USER_ID_SELECTOR).first();
}

async function takenVisible(page) {
  const byId = page.locator('#reg-error-userId, [id*="error-userId" i], .error-msg, [role="alert"]');
  const count = await byId.count();
  for (let i = 0; i < count; i += 1) {
    const text = (await byId.nth(i).innerText().catch(() => '')) || '';
    if (TAKEN_TEXT.test(text)) return true;
  }
  const byText = page.getByText(TAKEN_TEXT);
  return (await byText.count()) > 0 && (await byText.first().isVisible().catch(() => false));
}

async function invalidVisible(page) {
  const byId = page.locator('#reg-error-userId, [id*="error-userId" i], .error-msg, [role="alert"]');
  const count = await byId.count();
  for (let i = 0; i < count; i += 1) {
    const text = (await byId.nth(i).innerText().catch(() => '')) || '';
    if (INVALID_TEXT.test(text) && !TAKEN_TEXT.test(text)) return true;
  }
  return false;
}

async function clickEmptySpace(page) {
  await page.keyboard.press('Tab').catch(() => {});
  const heading = page.getByRole('heading').first();
  if (await heading.count()) {
    await heading.click({ timeout: 1500 }).catch(() => {});
    return;
  }
  await page.mouse.click(24, 180).catch(() => {});
}

export async function checkUsernameTaken(page, username) {
  if (await isBlocked(page)) {
    const err = new Error('blocked');
    err.code = 'blocked';
    throw err;
  }

  const input = await usernameInput(page);
  await input.waitFor({ state: 'visible', timeout: 8000 });
  await input.click({ timeout: 5000 });
  await input.fill('');
  await input.fill(username);
  await input.evaluate((el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }).catch(() => {});

  await sleep(1000);
  if (await takenVisible(page)) return { taken: true };
  if (await invalidVisible(page)) return { taken: false, invalid: true };

  await clickEmptySpace(page);
  await sleep(2500);
  if (await takenVisible(page)) return { taken: true };
  if (await invalidVisible(page)) return { taken: false, invalid: true };

  logger.debug('username not taken', { username });
  return { taken: false };
}

export async function resetUsernameField(page, { reload = false, url } = {}) {
  if (reload && url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitForSignupForm(page);
    return;
  }
  const input = await usernameInput(page);
  if (await input.count()) {
    await input.fill('').catch(() => {});
  }
}
