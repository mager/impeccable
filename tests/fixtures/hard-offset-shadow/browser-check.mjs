// Opt-in integration check. Requires the bundled detector, Puppeteer Chrome, and Firefox.
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
await fs.mkdir('build/929', {recursive:true});
const html = await fs.readFile('tests/fixtures/antipatterns/hard-offset-shadow.html', 'utf8');
const bundle = await fs.readFile('dist/detect-antipatterns-browser.js');
const server = http.createServer((req,res) => {
  res.setHeader('content-type', req.url === '/detector.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/detector.js' ? bundle : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
server.unref();
const base = `http://127.0.0.1:${server.address().port}`;
const results = [];
for (const browserName of ['chrome', 'firefox']) {
  const browser = await puppeteer.launch({browser: browserName, headless: true,
    ...(browserName === 'firefox' ? {executablePath: process.env.FIREFOX_PATH || '/Applications/Firefox.app/Contents/MacOS/firefox'} : {})});
  try {
    const page = await browser.newPage();
    page.on("pageerror", e => console.log("PAGE ERROR", browserName, e.message));
    page.on("console", m => {if(m.type()==="error") console.log("CONSOLE", m.text());});
    await page.setViewport({width: 1280, height: 1800});
    await page.goto(base);
    await page.evaluate(() => {document.documentElement.dataset.impeccableExtension = 'true';});
    await page.addScriptTag({url:base+'/detector.js'});
    await page.waitForFunction(() => typeof window.impeccableDetect === 'function');
    const rows = await page.evaluate(() => window.impeccableDetect());
    const hits = rows.flatMap(g => g.findings || []).filter(f => (f.type || f.id) === 'hard-offset-shadow');
    if (hits.length !== 4) console.log(JSON.stringify(rows));
    assert.equal(hits.length, 4);
    assert.ok(hits.every(f => f.severity === 'advisory' && f.advisory === true));
    const repeat = await page.evaluate(() => window.impeccableDetect());
    assert.equal(repeat.flatMap(g => g.findings || []).filter(f => f.type === 'hard-offset-shadow').length, 4);
    await page.evaluate(() => {window.__IMPECCABLE_CONFIG__ = {disabledRules: ['hard-offset-shadow']};});
    const muted = await page.evaluate(() => window.impeccableDetect());
    assert.equal(muted.flatMap(g => g.findings || []).filter(f => (f.type || f.id) === 'hard-offset-shadow').length, 0);
    await page.evaluate(() => {window.__IMPECCABLE_CONFIG__ = {};});
    const restored = await page.evaluate(() => window.impeccableDetect());
    assert.equal(restored.flatMap(g => g.findings || []).filter(f => f.type === 'hard-offset-shadow').length, 4);
    await page.screenshot({path:`build/929/${browserName}-fixture.png`, fullPage:true});
    results.push({browser: await browser.version(), hardOffsetFindings:hits.length, disabledFindings:0, hits});
  } finally {await browser.close();}
}
await fs.writeFile('build/929/browser-results.json', JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
