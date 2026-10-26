import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Run the real worker with browser API boundaries replaced. Firefox exposes
// getContexts, but rejects OFFSCREEN_DOCUMENT before the scan can start.
function scannerHarness({ firefox = false, existingHost = false, failFirstCreate = false, failScanDelivery = false, ping } = {}) {
  const runtimeMessages = [];
  const tabMessages = [];
  const frames = [];
  let creates = 0;
  let ready = existingHost;
  const listeners = {};
  const event = name => ({ addListener(callback) { listeners[name] = callback; } });
  const chrome = {
    runtime: {
      onMessage: event('message'), onConnect: event('connect'),
      getURL: (file) => `moz-extension://test/${file}`,
      async getContexts(filter) {
        if (firefox) throw new Error('Invalid enumeration value "OFFSCREEN_DOCUMENT"');
        assert.deepEqual(Array.from(filter.contextTypes), ['OFFSCREEN_DOCUMENT']);
        return ready ? [{}] : [];
      },
      async sendMessage(message) {
        runtimeMessages.push(message);
        if (message.action === 'ping') return ping ? ping() : { ok: ready };
      },
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    webNavigation: { onCompleted: event('navigation') },
    scripting: { async executeScript() {} },
    storage: { sync: { async get(defaults) { return defaults; } } },
    tabs: {
      onRemoved: event(),
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, ...message });
        if (failScanDelivery && message.action === 'scan') throw new Error('Receiving end does not exist');
      },
    },
  };
  function create() {
    creates++;
    if (failFirstCreate && creates === 1) throw new Error('host creation failed');
    ready = true;
  }
  const document = firefox ? {
    getElementById: (id) => frames.find(frame => frame.id === id) || null,
    createElement(tag) { assert.equal(tag, 'iframe'); return {}; },
    body: { appendChild(frame) { create(); frames.push(frame); } },
  } : undefined;
  if (!firefox) chrome.offscreen = { async createDocument() { create(); } };
  const context = vm.createContext({ chrome, document, setTimeout });
  vm.runInContext(readFileSync(path.join(ROOT, 'extension/background/service-worker.js'), 'utf8'), context);
  return { context, frames, runtimeMessages, tabMessages, listeners, creates: () => creates };
}

describe('extension rule core startup', () => {
  it('scans in Firefox without calling its unsupported offscreen APIs', async () => {
    const h = scannerHarness({ firefox: true });
    await vm.runInContext('sendScanToTab(7)', h.context);
    assert.equal(h.tabMessages.length, 1, JSON.stringify(h.runtimeMessages));
    assert.equal(h.tabMessages[0].action, 'scan');
    assert.equal(h.frames.length, 1);
    assert.equal(h.frames[0].src, 'moz-extension://test/offscreen/offscreen.html');
    assert.equal(h.frames[0].hidden, true);
  });

  for (const firefox of [false, true]) {
    const browser = firefox ? 'Firefox' : 'Chrome';
    it(`shares one core host across concurrent and repeated ${browser} scans`, async () => {
      const h = scannerHarness({ firefox });
      await vm.runInContext('Promise.all([sendScanToTab(7), sendScanToTab(8)])', h.context);
      await vm.runInContext('sendScanToTab(7)', h.context);
      assert.equal(h.creates(), 1);
      assert.deepEqual(h.tabMessages.map(m => m.tabId), [7, 8, 7]);
    });

    it(`reports ${browser} host failures and retries on the next scan`, async () => {
      const h = scannerHarness({ firefox, failFirstCreate: true });
      await vm.runInContext('sendScanToTab(7)', h.context);
      assert.equal(h.tabMessages.length, 0);
      assert.match(h.runtimeMessages.find(m => m.action === 'scan-failed')?.message || '', /host creation failed/);
      await vm.runInContext('sendScanToTab(7)', h.context);
      assert.equal(h.tabMessages.length, 1);
      assert.equal(h.creates(), 2);
    });

    it(`waits for the ${browser} core to answer before scanning`, async () => {
      let answer;
      const h = scannerHarness({ firefox, ping: () => new Promise(resolve => { answer = resolve; }) });
      const scan = vm.runInContext('sendScanToTab(7)', h.context);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.tabMessages.length, 0);
      answer({ ok: true });
      await scan;
      assert.equal(h.tabMessages.length, 1);
    });

    it(`surfaces ${browser} WASM startup errors instead of reporting a clean page`, async () => {
      const h = scannerHarness({ firefox, ping: () => ({ ok: false, error: 'WASM failed to load' }) });
      await vm.runInContext('sendScanToTab(7)', h.context);
      assert.equal(h.tabMessages.length, 0);
      assert.match(h.runtimeMessages.find(m => m.action === 'scan-failed')?.message || '', /WASM failed to load/);
    });

    it(`retries while the ${browser} core message listener is not registered`, async () => {
      let pings = 0;
      const h = scannerHarness({ firefox, ping: () => {
        assert.equal(h.tabMessages.length, 0, 'scan must wait for a successful ping');
        if (++pings <= 2) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true };
      } });
      await vm.runInContext('sendScanToTab(7)', h.context);
      assert.equal(pings, 3);
      assert.equal(h.creates(), 1);
      assert.deepEqual(h.tabMessages.map(m => [m.tabId, m.action]), [[7, 'scan']]);
      assert.equal(h.runtimeMessages.filter(m => m.action === 'scan-failed').length, 0);
    });

    it(`reports exhausted ${browser} startup retries and recovers on the next scan`, async () => {
      let listenerReady = false;
      let pings = 0;
      const h = scannerHarness({ firefox, ping: () => {
        pings++;
        if (!listenerReady) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true };
      } });
      await vm.runInContext('sendScanToTab(7)', h.context);
      assert.equal(pings, 50);
      assert.equal(h.tabMessages.length, 0);
      const failures = h.runtimeMessages.filter(m => m.action === 'scan-failed');
      assert.equal(failures.length, 1);
      assert.equal(failures[0].tabId, 7);
      assert.match(failures[0].message, /rule core did not answer/);

      listenerReady = true;
      await vm.runInContext('sendScanToTab(7)', h.context);
      assert.equal(pings, 51, 'a failed startup must not leave a cached rejected promise');
      assert.equal(h.creates(), 1, 'reuse the existing core host');
      assert.deepEqual(h.tabMessages.map(m => [m.tabId, m.action]), [[7, 'scan']]);
      assert.equal(h.runtimeMessages.filter(m => m.action === 'scan-failed').length, 1);
      if (firefox) assert.equal(h.frames.length, 1, 'reuse the existing background iframe');
    });
  }

  it('reuses an existing Chrome offscreen document after worker restart', async () => {
    const h = scannerHarness({ existingHost: true });
    await vm.runInContext('sendScanToTab(7)', h.context);
    assert.equal(h.creates(), 0);
    assert.equal(h.tabMessages.length, 1);
  });
});

describe('extension DevTools packaging', () => {
  it('uses extension-root paths for DevTools panel pages', () => {
    const source = readFileSync(path.join(ROOT, 'extension/devtools/devtools.js'), 'utf-8');

    assert.match(
      source,
      /chrome\.devtools\.panels\.create\(\s*['"]Impeccable['"],\s*['"]\/icons\/icon-32\.png['"],\s*['"]\/devtools\/panel\.html['"]\s*\)/s,
      'Firefox resolves DevTools URLs relative to devtools.html unless they start at the extension root',
    );
    assert.match(source, /sidebar\.setPage\(['"]\/devtools\/sidebar\.html['"]\)/);
    assert.doesNotMatch(source, /['"]devtools\/(?:panel|sidebar)\.html['"]/);
    assert.doesNotMatch(source, /['"]icons\/icon-32\.png['"]/);
  });
});

describe('extension badge colors', () => {
  // Optional-call syntax on a method a browser does not implement returns
  // undefined, and .catch on undefined throws: updateBadge would abort before
  // it set the badge at all. Firefox's action API has no setBadgeTextColor,
  // so the call has to be guarded by an existence check, not by `?.`.
  it('guards setBadgeTextColor instead of chaining .catch onto an optional call', () => {
    const source = readFileSync(path.join(ROOT, 'extension/background/service-worker.js'), 'utf-8');

    assert.doesNotMatch(
      source,
      /setBadgeTextColor\?\.\([^)]*\)\s*\.catch/s,
      'setBadgeTextColor?.(...).catch(...) throws wherever the method is missing',
    );
    assert.match(
      source,
      /typeof chrome\.action\.setBadgeTextColor === 'function'/,
      'the call needs an existence check around it',
    );
    assert.match(
      source,
      /typeof pending\.catch === 'function'/,
      'the return value needs a promise check before .catch',
    );
  });

  it('paints the badge in kinpaku gold with ink text', () => {
    const source = readFileSync(path.join(ROOT, 'extension/background/service-worker.js'), 'utf-8');

    assert.match(source, /setBadgeBackgroundColor\(\{ color: '#ffba00'/);
    assert.match(source, /setBadgeTextColor\(\{ color: '#0b0903'/);
    assert.doesNotMatch(source, /#d6336c/, 'the magenta badge is retired');
  });
});


describe('extension popup scan state', () => {
  const url = 'https://example.test/scanned#card';
  function report(h, findings = [], scanComplete = true) {
    h.listeners.message({ action: 'findings', findings, scanComplete }, { url, tab: { id: 7 } }, () => {});
  }
  function state(h) {
    let result;
    h.listeners.message({ action: 'get-state', tabId: 7 }, {}, value => { result = value; });
    return result;
  }

  it('keeps partial scan reports incomplete until the final result', () => {
    const h = scannerHarness();
    report(h, [], false);
    assert.equal(state(h).scanComplete, false);
    assert.equal(h.runtimeMessages.at(-1).scanComplete, false);
    report(h);
    assert.equal(state(h).scanComplete, true);
    assert.equal(h.runtimeMessages.at(-1).scanComplete, true);
  });

  it('marks an empty scan complete and includes the source URL in popup broadcasts', () => {
    const h = scannerHarness();
    assert.equal(state(h).scanComplete, false);
    report(h);
    assert.equal(state(h).scanComplete, true);
    assert.equal(state(h).url, url);
    const message = h.runtimeMessages.find(message => message.action === 'findings-updated');
    assert.equal(message.url, url);
    assert.equal(message.tabId, 7);
    assert.equal(message.findings.length, 0);
  });

  it('invalidates cached copy data while scanning and after failure', async () => {
    const h = scannerHarness();
    report(h, [{ findings: [{ name: 'Old finding' }] }]);
    await vm.runInContext('sendScanToTab(7)', h.context);
    assert.equal(state(h).findings.length, 0);
    assert.equal(state(h).scanning, true);
    assert.equal(state(h).scanComplete, false);
    assert.ok(h.runtimeMessages.some(message => message.action === 'scan-started' && message.tabId === 7));
    report(h, [{ findings: [{ name: 'Old finding' }] }]);
    h.listeners.message({ action: 'detector-error', message: 'Snapshot failed' }, { tab: { id: 7 } }, () => {});
    assert.equal(state(h).scanComplete, false);
    assert.equal(state(h).findings.length, 0);
    assert.equal(state(h).scanning, false);
    assert.equal(state(h).scanError, 'Snapshot failed');
  });

  it('reports scan delivery failure and clears pending state for a reopened popup', async () => {
    const h = scannerHarness({ failScanDelivery: true });
    await vm.runInContext('sendScanToTab(7)', h.context);
    assert.equal(state(h).scanning, false);
    assert.equal(state(h).scanComplete, false);
    assert.match(state(h).scanError, /Receiving end does not exist/);
    assert.ok(h.runtimeMessages.some(message => message.action === 'scan-failed' && message.tabId === 7));
  });

  it('clears source URL and scan state on top-level navigation and notifies the popup', () => {
    const h = scannerHarness();
    report(h);
    h.listeners.navigation({ tabId: 7, frameId: 2 });
    assert.equal(state(h).scanComplete, true);
    h.listeners.navigation({ tabId: 7, frameId: 0 });
    assert.equal(state(h).scanComplete, false);
    assert.equal(state(h).url, '');
    assert.ok(h.runtimeMessages.some(message => message.action === 'navigated' && message.tabId === 7));
  });
});

// Exercise the real content script across the offscreen protocol, including a
// delayed image read. No generated detector code is replaced in production.
function contentScanHarness({ visual = true, fail = false } = {}) {
  const messages = [];
  let listener;
  let releaseImage;
  const image = new Promise(resolve => { releaseImage = resolve; });
  let step = 0;
  const initial = [{ selector: '#text', findings: [] }];
  const final = [{ selector: '#text', findings: [{ type: 'low-contrast' }] }];
  const overlay = { remove() {}, clearOverlays() {}, highlight() {}, setFirstScanDone() {}, showPageBanner() {} };
  const context = vm.createContext({
    window: {
      __impeccableSnapshot: {
        capture: () => ({ json: '{}', elements: {}, stats: { elements: 1, bytes: 2, ms: 0 } }),
        visualIO: () => ({ loadImage: () => image }),
      },
      __impeccableCreateOverlay: () => overlay,
      addEventListener() {},
    },
    document: { body: {}, documentElement: {}, addEventListener() {} },
    location: { href: 'https://example.test/' }, performance,
    setTimeout() {},
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(msg) {
        messages.push(msg);
        if (msg.action === 'antipatterns') return { antipatterns: [] };
        if (msg.action === 'scan-start') return { stage: 'findings', groups: [], serialized: initial };
        if (msg.action === 'scan-continue') {
          if (!visual) return { done: true };
          if (++step === 1) return { ask: { io: { kind: 'loadImage', src: '/slow.png' } } };
          if (fail) return { error: 'Image read failed' };
          if (step === 2) return { stage: 'visual', groups: [], added: [], serialized: final };
          return { done: true };
        }
      },
    } },
  });
  vm.runInContext(readFileSync(path.join(ROOT, 'extension/content/content-script.js'), 'utf8'), context);
  listener({ action: 'scan' }, {}, () => {});
  return { messages, releaseImage, listener };
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

describe('content script scan completion', () => {
  it('keeps delayed image findings partial and publishes a complete final report', async () => {
    const h = contentScanHarness();
    await nextTurn();
    let reports = h.messages.filter(m => m.action === 'findings');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].scanComplete, false);
    h.releaseImage({});
    await nextTurn();
    reports = h.messages.filter(m => m.action === 'findings');
    assert.deepEqual(reports.map(m => m.scanComplete), [false, false, true]);
    assert.equal(reports.at(-1).findings[0].findings[0].type, 'low-contrast');
  });

  it('completes when the core skips visual checks', async () => {
    const h = contentScanHarness({ visual: false });
    await nextTurn();
    assert.deepEqual(h.messages.filter(m => m.action === 'findings').map(m => m.scanComplete), [false, true]);
  });

  it('never marks a failed visual pass complete', async () => {
    const h = contentScanHarness({ fail: true });
    await nextTurn();
    h.releaseImage({});
    await nextTurn();
    assert.equal(h.messages.some(m => m.scanComplete), false);
    assert.equal(h.messages.find(m => m.action === 'detector-error').message, 'Image read failed');
  });

  it('does not complete a scan after the content script is removed', async () => {
    const h = contentScanHarness();
    await nextTurn();
    h.listener({ action: 'remove' }, {}, () => {});
    h.releaseImage({});
    await nextTurn();
    assert.equal(h.messages.filter(m => m.action === 'findings' && m.scanComplete).length, 0);
  });
});
