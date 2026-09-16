'use strict';
// Run with npm test. No production files or account data are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const artifacts = path.resolve(process.env.ARTIFACT_DIR || path.join(root, '.artifacts'));
fs.mkdirSync(artifacts, { recursive: true });
const profile = fs.mkdtempSync(path.join(artifacts, 'browser-'));
const key = 'ai-content-workflow-demo-v1';
const checks = [];
const errors = [];
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(root, 'index.html')));
  } else { res.writeHead(404); res.end(); }
});
let context;
function pass(name) { checks.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
async function start() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true, acceptDownloads: true, viewport: { width: 1440, height: 1100 },
    args: ['--disable-background-networking', '--no-first-run']
  });
  const page = context.pages()[0] || await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  return page;
}
async function inputFile(page, object, name = 'example.json') {
  const buffer = Buffer.isBuffer(object) ? object : Buffer.from(JSON.stringify(object));
  await page.locator('#json-file').setInputFiles({ name, mimeType: 'application/json', buffer });
  // File.text() is asynchronous; wait for the import handler's completion.
  await page.waitForFunction(() => document.getElementById('json-file').files.length === 0);
}
async function stateOf(page) { return page.evaluate(k => JSON.parse(localStorage.getItem(k)), key); }
async function exportFile(page, id, filename) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator(id).click()]);
  const target = path.join(artifacts, filename);
  await download.saveAs(target);
  return fs.readFileSync(target);
}
async function completeChecks(page) {
  for (const id of ['source-synthetic-data', 'source-demo-formula', 'source-original-art', 'human-review']) await page.locator('#' + id).check();
  await page.locator('#license-status').selectOption('original-confirmed');
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let page = await start();
  await page.goto(url);
  await page.locator('#restore-example').click();
  assert.equal(await page.locator('input[type=number]').count(), 16);
  assert.equal(await page.locator('#export-png').isEnabled(), true);
  await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
  pass('default example loads with sixteen editable dimensions');

  await page.locator('#score-shooting').fill('90');
  await page.locator('#panel-title').fill('验收测试 · 合成数据');
  assert.equal(await page.locator('#human-review').isChecked(), false);
  assert.equal(await page.locator('#export-png').isDisabled(), true);
  const values = await page.locator('input[type=number]').evaluateAll(items => items.map(item => Number(item.value)));
  assert.equal(await page.locator('#average-score').innerText(), (values.reduce((a, b) => a + b, 0) / 16).toFixed(1));
  pass('editing updates computed score and invalidates human review');

  await page.locator('#score-shooting').fill('101');
  assert.equal(await page.locator('#export-png').isDisabled(), true);
  assert.equal(await page.locator('#export-json').isDisabled(), true);
  await page.locator('#score-shooting').fill('90');
  await page.locator('#panel-title').fill('');
  assert.equal(await page.locator('#export-png').isDisabled(), true);
  await page.locator('#panel-title').fill('验收测试 · 合成数据');
  await completeChecks(page);
  pass('invalid score and empty title block output');

  await page.locator('#source-synthetic-data').uncheck();
  assert.equal(await page.locator('#export-png').isDisabled(), true);
  await page.locator('#source-synthetic-data').check();
  await page.locator('#simulate-missing-license').click();
  assert.equal(await page.locator('#export-png').isDisabled(), true);
  assert.match(await page.locator('#block-reasons').innerText(), /授权/);
  let blockedDownloads = 0;
  const downloadListener = () => blockedDownloads++;
  page.on('download', downloadListener);
  // Also check the handler guard, not just the disabled button's appearance.
  await page.locator('#export-png').evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForTimeout(150);
  page.off('download', downloadListener);
  assert.equal(blockedDownloads, 0);
  await page.locator('#license-status').selectOption('original-confirmed');
  pass('missing source and rights block PNG including handler invocation');

  const png = await exportFile(page, '#export-png', 'export.png');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1600);
  assert.equal(png.readUInt32BE(20), 900);
  const canvasBase64 = await page.locator('#panel-canvas').evaluate(el => el.toDataURL('image/png').split(',')[1]);
  assert.deepEqual(png, Buffer.from(canvasBase64, 'base64'));
  pass('PNG download matches current canvas at 1600x900');

  const exported = JSON.parse((await exportFile(page, '#export-json', 'export.json')).toString('utf8'));
  assert.equal(exported.dimensions[0].value, 90);
  assert.equal(exported.title, '验收测试 · 合成数据');
  await page.reload();
  assert.equal(await page.locator('#score-shooting').inputValue(), '90');
  assert.equal(await page.locator('#panel-title').inputValue(), exported.title);
  assert.equal(await page.locator('#export-png').isEnabled(), true);
  pass('JSON contains edited state and refresh restores it');

  await context.close();
  context = null;
  page = await start();
  await page.goto(url);
  assert.deepEqual(await stateOf(page), exported);
  assert.equal(await page.locator('#score-shooting').inputValue(), '90');
  pass('closing and reopening browser restores saved state');

  await page.locator('#restore-example').click();
  await inputFile(page, exported);
  const imported = await stateOf(page);
  assert.equal(imported.title, exported.title);
  assert.equal(imported.dimensions[0].value, 90);
  assert.equal(imported.review.confirmed, false);
  assert.equal(imported.license.status, 'pending');
  assert.equal(imported.sources.every(item => item.verified === false), true);
  assert.equal(await page.locator('#export-png').isDisabled(), true);
  pass('import restores data but revokes all confirmations');

  const invalidInputs = [
    ['out-of-range', { ...exported, dimensions: exported.dimensions.map((d, i) => i ? d : { ...d, value: 101 }) }],
    ['fractional-score', { ...exported, dimensions: exported.dimensions.map((d, i) => i ? d : { ...d, value: 0.5 }) }],
    ['incomplete-dimensions', { ...exported, dimensions: exported.dimensions.slice(1) }],
    ['additional-property', { ...exported, unexpected: true }],
    ['changed-subject', { ...exported, subject: 'Unverified real person' }],
    ['invalid-json', Buffer.from('{')],
    ['oversized-file', Buffer.alloc(65537, 32)]
  ];
  for (const [name, object] of invalidInputs) {
    const before = await stateOf(page);
    await inputFile(page, object);
    assert.match(await page.locator('#message').innerText(), /导入失败/);
    assert.deepEqual(await stateOf(page), before, name + ' changed stored state');
  }
  pass('seven malformed imports rejected without changing saved state');

  const htmlTitle = '<img src=x onerror=alert(1)>';
  await inputFile(page, { ...exported, title: htmlTitle });
  assert.equal(await page.locator('#panel-title').inputValue(), htmlTitle);
  assert.equal(await page.locator('img').count(), 0);
  pass('imported title is treated as text, not HTML');
  await page.locator('#restore-example').click();

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const layout = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(layout.scroll <= layout.width, `horizontal overflow at ${width}: ${layout.scroll}`);
    if (width === 390) await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
  }
  pass('no horizontal page overflow at 320,390,768,1440 pixels');

  await page.evaluate(k => localStorage.setItem(k, '{broken'), key);
  await page.reload();
  assert.match(await page.locator('#message').innerText(), /无法读取|格式不匹配/);
  assert.equal(await page.locator('#score-shooting').inputValue(), '79');
  pass('corrupted browser storage shows recovery notice');

  await page.addInitScript(() => { Storage.prototype.setItem = function () { throw new Error('storage unavailable'); }; });
  await page.reload();
  assert.match(await page.locator('#save-status').innerText(), /不可用/);
  await page.locator('#score-shooting').fill('80');
  assert.match(await page.locator('#save-status').innerText(), /不可用/);
  assert.equal(errors.length, 0, errors.join('\n'));
  pass('unavailable browser storage is reported without crashing');

  const report = {
    schemaVersion: 'demo-browser-verification-v1', testedAt: new Date().toISOString(),
    status: 'PASS', browser: await context.browser().version(),
    implementationSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'index.html'))).digest('hex'),
    checks, limitations: ['Synthetic demo only', 'Not a production transaction or permissions security boundary', 'Chrome tested; other browsers not independently tested']
  };
  fs.writeFileSync(path.join(artifacts, 'demo-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', checks: checks.length }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
});
