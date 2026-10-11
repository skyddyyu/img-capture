// Shipping-manifest check: no fixture host permissions. Requires a browser exposing Extensions CDP methods.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { startFixtureServer } from './fixture-server.mjs';
const root = path.resolve(import.meta.dirname, '..');
const target = process.env.E2E_TARGET === 'edge' ? 'edge' : 'chrome';
const extension = path.join(root, `.output/${target}-mv3`);
const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.host_permissions, undefined);
const server = await startFixtureServer();
let context;
try {
  context = await chromium.launchPersistentContext(
    path.join(root, `.artifacts/test-profile-native-${Date.now()}`),
    {
      channel: target === 'edge' ? 'msedge' : 'chrome',
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging'],
    },
  );
  const page = context.pages()[0];
  const cdp = await context.browser().newBrowserCDPSession();
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: extension });
  await page.goto('http://127.0.0.1:4173');
  const pageCdp = await context.newCDPSession(page);
  const info = await pageCdp.send('Target.getTargetInfo');
  const tabTargets = await cdp.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const tabTarget =
    tabTargets.targetInfos.find((item) => item.url === page.url()) ?? tabTargets.targetInfos[0];
  await cdp.send('Extensions.triggerAction', {
    id: loaded.id,
    targetId: tabTarget?.targetId ?? info.targetInfo.targetId,
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const tabs = await worker.evaluate(() =>
    chrome.tabs.query({ active: true, currentWindow: true }),
  );
  const tabId = tabs[0].id;
  const ping = await worker.evaluate(
    (id) => chrome.tabs.sendMessage(id, { type: 'CONTENT_PING' }),
    tabId,
  );
  assert.equal(ping.ok, true);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${loaded.id}/sidepanel.html`);
  await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
  await panel.getByRole('button', { name: '选择网页模块', exact: true }).click();
  await page.waitForTimeout(150);
  const rect = await page.locator('#first-image').boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page
    .getByRole('region', { name: '范围选取工具条' })
    .getByRole('button', { name: '提取', exact: true })
    .click();
  await panel.locator('.image-card').waitFor();
  const state = await worker.evaluate(
    async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`],
    tabId,
  );
  assert.equal(state.result.resources.length, 1);
  await fs.writeFile(
    path.join(root, `.artifacts/${target}-native-report.json`),
    JSON.stringify(
      {
        browser: context.browser().version(),
        manifestHostPermissions: 'none',
        toolbarAction: true,
        activeTabInjection: true,
        imageExtraction: true,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS shipping-manifest toolbar action, activeTab injection and single-image extraction',
  );
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
