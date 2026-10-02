// Browser regression for #881. Run after cargo xtask bundle and the release build:
// IMPECCABLE_BIN=target/release/impeccable node --test tests/gradient-alpha-contrast.test.mjs
// Uses Playwright Chromium; PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH can select a local Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { findEngineBinary, ENGINE_MISSING_MESSAGE } from './lib/engine-bin.mjs';

const bin = findEngineBinary();
const fixture = readFileSync(new URL('./fixtures/antipatterns/gradient-alpha-contrast.html', import.meta.url));
const bundle = new URL('../crates/live/assets/detect-antipatterns-browser.js', import.meta.url);
const run = promisify(execFile);

test('gradient alpha: native and WASM retain four failures and clear five readable cases', {
  skip: bin ? false : ENGINE_MISSING_MESSAGE,
  timeout: 90000,
}, async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let stdout;
  try {
    ({ stdout } = await run(bin, ['detect', '--no-config', '--json', '--viewport', '1024x1200', url]));
  } catch (error) {
    assert.equal(error.code, 2, error.stderr);
    stdout = error.stdout;
  }
  const native = JSON.parse(stdout).filter(f => f.antipattern === 'low-contrast');
  assert.deepEqual(native.map(f => f.snippet).sort(), [
    '1.0:1 (need 4.5:1) — text #ffffff on #ffffff',
    '1.1:1 (need 4.5:1) — text #222222 on #181818',
    '1.4:1 (need 4.5:1) — text #dddddd on #ffffff',
    '2.5:1 (need 4.5:1) — text #a3a3a3 on #ffffff',
  ]);

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1024, height: 1200 } });
  await page.goto(url);
  await page.evaluate(() => { window.__IMPECCABLE_CONFIG__ = { autoScan: false }; });
  await page.addScriptTag({ content: readFileSync(bundle, 'utf8') });
  await page.waitForFunction(() => typeof window.impeccableDetectAsync === 'function');
  const findings = await page.evaluate(async () => {
    const groups = await window.impeccableDetectAsync({ serialize: false, visualContrast: true });
    return groups.filter(group => group.findings.some(f => f.type === 'low-contrast')).map(group => ({
      column: group.el.closest('[data-col]')?.dataset.col,
      text: group.el.textContent.trim(),
    }));
  });
  assert.equal(findings.length, 4, JSON.stringify(findings));
  assert.ok(findings.every(f => f.column === 'flag'), JSON.stringify(findings));
});
