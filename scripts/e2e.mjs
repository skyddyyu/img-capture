import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startFixtureServer } from './fixture-server.mjs';

const root = path.resolve(import.meta.dirname, '..');
const artifacts = path.join(root, '.artifacts');
const target = process.env.E2E_TARGET === 'edge' ? 'edge' : 'chrome';
const reportName = `${target}${process.env.E2E_FILTER ? '-filtered' : ''}-e2e-report.json`;
const extension = path.join(artifacts, `test-extension-${target}`);
await fs.mkdir(artifacts, { recursive: true });
await fs.cp(path.join(root, `.output/${target}-mv3`), extension, { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert.deepEqual(
  manifest.permissions.sort(),
  ['activeTab', 'scripting', 'sidePanel', 'storage'].sort(),
);
assert.equal(
  manifest.host_permissions,
  undefined,
  'Shipping extension must not have permanent host access',
);
assert.equal(manifest.content_scripts, undefined, 'Shipping extension must not run on every page');
// Test the shipping permissions. CDP triggers the real toolbar action and grants activeTab.
const fixturePort = target === 'edge' ? 4174 : 4173;
const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;
const server = await startFixtureServer(fixturePort);
const passed = [];
const errors = [];
let performanceReport;
const test = async (name, fn) => {
  if (process.env.E2E_FILTER && !new RegExp(process.env.E2E_FILTER).test(name)) return;
  await fn();
  passed.push(name);
  console.log(`PASS ${name}`);
};
let context;
try {
  context = await chromium.launchPersistentContext(
    path.join(artifacts, `test-profile-${target}-${Date.now()}`),
    {
      channel: target === 'edge' ? 'msedge' : 'chrome',
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging'],
      viewport: { width: 1100, height: 900 },
    },
  );
  const browserCdp = await context.browser().newBrowserCDPSession();
  const { id: extensionId } = await browserCdp.send('Extensions.loadUnpacked', { path: extension });
  const page = await context.newPage();
  await page.goto(fixtureOrigin);
  const grantAction = async () => {
    const targets = await browserCdp.send('Target.getTargets', {
      filter: [{ type: 'tab', exclude: false }],
    });
    const tab = targets.targetInfos.find((item) => item.url === page.url());
    assert.ok(tab, 'Fixture tab target must exist');
    await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
  };
  await grantAction();
  let worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 20000 }));
  const tabId = await worker.evaluate(
    async (origin) => (await chrome.tabs.query({ url: `${origin}/*` }))[0].id,
    fixtureOrigin,
  );
  const panel = await context.newPage();
  panel.on('pageerror', (error) => errors.push(error.message));
  await panel.setViewportSize({ width: 440, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const activate = async (id = tabId) => {
    await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), id);
  };
  await activate();
  const state = () =>
    worker.evaluate(
      async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`],
      tabId,
    );
  const waitState = async (predicate) => {
    for (let i = 0; i < 150; i++) {
      const current = await state();
      if (predicate(current)) return current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const current = await state();
    throw new Error(
      `State wait timed out: ${JSON.stringify({ status: current?.status, error: current?.error, notice: current?.notice, count: current?.result?.resources.length, progress: current?.progress?.resources.length, summary: current?.result?.summary })}`,
    );
  };
  const choose = async (selector) => {
    await panel.getByRole('button', { name: /^(选择网页模块|重新选择模块)$/ }).click();
    await waitState((value) => value?.status === 'selecting');
    await page.locator(selector).scrollIntoViewIfNeeded();
    const rect = await page.locator(selector).boundingBox();
    assert.ok(rect, `Missing fixture selector ${selector}`);
    const x = Math.max(2, rect.x + Math.min(5, rect.width / 2));
    const y = Math.max(2, rect.y + Math.min(5, rect.height / 2));
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await page
      .getByRole('region', { name: '范围选取工具条' })
      .getByRole('button', { name: '提取', exact: true })
      .click();
    return waitState((value) => ['ready', 'empty', 'partial'].includes(value?.status));
  };

  await test('welcome and responsive layout', async () => {
    await panel.getByRole('button', { name: '选择网页模块', exact: true }).waitFor();
    await panel.screenshot({ path: path.join(artifacts, `${target}-welcome.png`) });
    for (const width of [320, 440, 600]) {
      await panel.setViewportSize({ width, height: 900 });
      assert.equal(
        await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    }
    await panel.setViewportSize({ width: 440, height: 900 });
  });
  await test('invalid saved preferences fall back to usable defaults', async () => {
    await worker.evaluate(() =>
      chrome.storage.local.set({
        'preferences:view': 'invalid',
        'preferences:thumbnailSize': 999,
        'preferences:onboardingCompleted': 'true',
      }),
    );
    await panel.reload();
    await activate();
    await panel.locator('.welcome').waitFor();
    await panel.getByRole('button', { name: '显示设置', exact: true }).click();
    assert.equal(await panel.getByLabel('默认视图', { exact: true }).inputValue(), 'grid');
    assert.equal(await panel.getByLabel('缩略图大小', { exact: true }).inputValue(), 'medium');
    await panel.keyboard.press('Escape');
    await worker.evaluate(() => chrome.storage.local.clear());
  });
  await test('selection, ancestor navigation, click interception, scope and dedup', async () => {
    await panel.getByRole('button', { name: '选择网页模块', exact: true }).click();
    await waitState((value) => value?.status === 'selecting');
    const imageRect = await page.locator('#first-image').boundingBox();
    await page.mouse.move(imageRect.x + imageRect.width / 2, imageRect.y + imageRect.height / 2);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    const rect = await page.locator('#first-image').boundingBox();
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.screenshot({ path: path.join(artifacts, `${target}-selection.png`) });
    assert.equal((await state()).status, 'selecting');
    await page.keyboard.press('Enter');
    const current = await waitState((value) => value?.status === 'ready');
    assert.equal(current.result.moduleSummary, 'section#module.grid');
    assert.equal(current.result.resources.length, 10);
    assert.equal(current.result.summary.referenceCount, 11);
    assert.equal(
      current.result.resources.find((item) => item.url.endsWith('/green.svg')).referenceCount,
      2,
    );
    assert.ok(!current.result.resources.some((item) => item.url.includes('outside.svg')));
    assert.equal(await page.evaluate(() => window.pageClicks), 0);
    assert.equal(page.url(), `${fixtureOrigin}/`);
  });
  await test('background, pseudo, lazy candidates, hidden and currentSrc', async () => {
    const resources = (await state()).result.resources;
    for (const part of [
      'background.svg?color=a,b',
      'pseudo.svg',
      'wide.svg',
      'hidden.svg',
      'lazy.svg',
    ])
      assert.ok(
        resources.some((item) => item.url.includes(part)),
        part,
      );
    assert.ok(!resources.some((item) => item.url.endsWith('/small.svg')));
    assert.equal(
      resources.find((item) => item.url.endsWith('/lazy.svg')).sources[0].isCandidate,
      true,
    );
    assert.equal(
      resources.find((item) => item.url.endsWith('/hidden.svg')).sources[0].visible,
      false,
    );
    assert.equal(resources.filter((item) => item.url.includes('signed.svg')).length, 2);
  });
  await test('completed onboarding stays collapsed and shortcuts remain accessible', async () => {
    await panel.waitForFunction(
      async () =>
        (await chrome.storage.local.get('preferences:onboardingCompleted'))[
          'preferences:onboardingCompleted'
        ] === true,
    );
    const second = await context.newPage();
    await second.goto(`${fixtureOrigin}/preferences`);
    await second.bringToFront();
    const secondId = await worker.evaluate(
      async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
    );
    await activate(secondId);
    await panel.locator('.returning-intro').waitFor();
    assert.equal(await panel.locator('.welcome').count(), 0);
    await panel.getByRole('button', { name: '快捷键与说明', exact: true }).click();
    await panel.locator('.shortcut-list').waitFor();
    assert.ok((await panel.locator('.shortcut-list').innerText()).includes('Enter'));
    await panel.keyboard.press('Escape');
    assert.equal(
      await panel
        .getByRole('button', { name: '快捷键与说明', exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await worker.evaluate(() =>
      chrome.storage.local.set({ 'preferences:onboardingCompleted': false }),
    );
    await panel.getByRole('button', { name: '收起引导', exact: true }).click();
    await panel.locator('.returning-intro').waitFor();
    await panel.reload();
    await activate(secondId);
    await panel.locator('.returning-intro').waitFor();
    await panel.screenshot({ path: path.join(artifacts, `${target}-returning.png`) });
    await activate();
    await second.close();
  });
  await test('gallery, failing preview, detail, zoom and navigation', async () => {
    await panel.locator('.image-card').first().waitFor();
    assert.equal(await panel.locator('.image-card').count(), 10);
    await panel.locator('.thumbnail img').first().waitFor();
    await panel.screenshot({ path: path.join(artifacts, `${target}-gallery.png`) });
    await panel
      .locator('.image-card')
      .first()
      .getByRole('button', { name: '详情', exact: true })
      .click();
    await panel.locator('.detail-preview img').waitFor();
    await panel.getByRole('button', { name: '放大', exact: true }).click();
    assert.equal(await panel.locator('.zoom-value').innerText(), '125%');
    await panel.getByRole('button', { name: '下一张', exact: true }).click();
    await panel.locator('.detail-preview img').waitFor();
    await panel.screenshot({ path: path.join(artifacts, `${target}-detail.png`) });
    await panel.getByRole('button', { name: '返回列表', exact: true }).click();
    const failed = panel
      .locator('.image-card')
      .filter({ has: panel.locator('.card-name', { hasText: 'missing.png' }) });
    await failed.scrollIntoViewIfNeeded();
    await failed.getByText('暂时无法预览', { exact: true }).waitFor();
    await failed.getByRole('button', { name: '详情', exact: true }).click();
    await panel.getByRole('button', { name: '重试预览', exact: true }).click();
    await panel.getByRole('button', { name: '重试预览', exact: true }).waitFor();
    await panel.getByRole('button', { name: '重试预览', exact: true }).click();
    await panel.getByRole('button', { name: '重试预览', exact: true }).waitFor();
    await panel.getByRole('button', { name: '返回列表', exact: true }).click();
  });
  await test('compact results show two thumbnail rows at common sidebar sizes', async () => {
    assert.equal(await panel.locator('.intro').count(), 0);
    for (const width of [320, 360, 440]) {
      await panel.setViewportSize({ width, height: 720 });
      await panel.evaluate(() => document.querySelector('.app-main').scrollTo(0, 0));
      await panel.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('.gallery')).gridTemplateColumns.split(' ')
            .length === 2,
      );
      const geometry = await panel.evaluate(() => {
        const bottom = document.querySelector('.app-main').getBoundingClientRect().bottom;
        return [...document.querySelectorAll('.thumbnail')]
          .slice(0, 4)
          .map((node) => ({ bottom: node.getBoundingClientRect().bottom, visibleBottom: bottom }));
      });
      assert.equal(geometry.length, 4);
      assert.ok(
        geometry.every((item) => item.bottom <= item.visibleBottom),
        `${width}px panel must show two complete thumbnail rows`,
      );
      assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width === 360)
        await panel.screenshot({ path: path.join(artifacts, `${target}-compact-360.png`) });
    }
    assert.equal(await panel.locator('.scope-details').getAttribute('open'), null);
    await panel.setViewportSize({ width: 440, height: 900 });
  });
  await test('list view exposes selectable full URLs and readable text', async () => {
    await panel.getByRole('button', { name: '列表', exact: true }).click();
    await panel.locator('.list-view').waitFor();
    const signed = panel
      .locator('.image-card')
      .filter({ has: panel.locator('.card-name', { hasText: 'signed.svg' }) })
      .first();
    const input = signed.locator('.card-url');
    await input.focus();
    const selected = await input.evaluate((node) =>
      node.value.slice(node.selectionStart, node.selectionEnd),
    );
    assert.equal(selected, await input.inputValue());
    assert.ok(selected.includes('token=abc#one'));
    const fontSizes = await panel
      .locator('.card-name, .card-meta, .card-actions button, .card-url')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node.getClientRects().length)
          .map((node) => parseFloat(getComputedStyle(node).fontSize)),
      );
    assert.ok(fontSizes.every((size) => size >= 12));
    await panel.setViewportSize({ width: 320, height: 720 });
    assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await panel.screenshot({ path: path.join(artifacts, `${target}-list-320.png`) });
    await panel.setViewportSize({ width: 440, height: 900 });
    await panel.getByRole('button', { name: '网格', exact: true }).click();
  });
  await test('detail prioritizes facts, keyboard navigation and focus restoration', async () => {
    await panel.locator('.thumbnail').first().click();
    assert.equal(await panel.locator('.technical-details').getAttribute('open'), null);
    const facts = await panel.locator('.detail-summary').boundingBox();
    const preview = await panel.locator('.detail-preview').boundingBox();
    assert.ok(facts.y + facts.height <= preview.y);
    await panel.keyboard.press('ArrowRight');
    assert.ok((await panel.locator('.detail-nav').innerText()).includes('2 / 10'));
    await panel.locator('#image-url').focus();
    await panel.keyboard.press('ArrowLeft');
    assert.ok(
      (await panel.locator('.detail-nav').innerText()).includes('2 / 10'),
      'URL editing keys must not change images',
    );
    await panel.getByRole('button', { name: '扩大预览', exact: true }).click();
    assert.ok((await panel.locator('.detail-preview').boundingBox()).height > preview.height);
    await panel.keyboard.press('Escape');
    await panel.locator('.gallery').waitFor();
    assert.equal(
      await panel.evaluate(
        () => document.activeElement === document.querySelectorAll('.thumbnail')[1],
      ),
      true,
    );
  });
  await test('display preferences persist, synchronize and restore dialog focus', async () => {
    await panel.getByRole('button', { name: '显示设置', exact: true }).click();
    await panel.getByLabel('默认视图', { exact: true }).selectOption('list');
    await panel.getByLabel('缩略图大小', { exact: true }).selectOption('small');
    await panel.setViewportSize({ width: 320, height: 720 });
    assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await panel.screenshot({ path: path.join(artifacts, `${target}-preferences-320.png`) });
    await panel.getByRole('button', { name: '知道了', exact: true }).focus();
    await panel.keyboard.press('Tab');
    assert.equal(
      await panel
        .getByRole('button', { name: '关闭对话框', exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await panel.keyboard.press('Escape');
    assert.equal(
      await panel
        .getByRole('button', { name: '显示设置', exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await panel.waitForFunction(
      async () =>
        (await chrome.storage.local.get('preferences:thumbnailSize'))[
          'preferences:thumbnailSize'
        ] === 'small',
    );
    await panel.reload();
    await activate();
    await panel.locator('.list-view[data-thumbnail-size="small"]').waitFor();
    const peer = await context.newPage();
    peer.on('pageerror', (error) => errors.push(error.message));
    await peer.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await activate();
    await peer.locator('.list-view[data-thumbnail-size="small"]').waitFor();
    await peer.getByRole('button', { name: '显示设置', exact: true }).click();
    await peer.getByLabel('默认视图', { exact: true }).selectOption('grid');
    await peer.getByLabel('缩略图大小', { exact: true }).selectOption('large');
    await panel.locator('.grid-view[data-thumbnail-size="large"]').waitFor();
    await panel.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('.gallery')).gridTemplateColumns.split(' ')
          .length === 1,
    );
    await peer.close();
    await activate();
    await panel.getByRole('button', { name: '显示设置', exact: true }).click();
    await panel.getByLabel('缩略图大小', { exact: true }).selectOption('medium');
    await panel.keyboard.press('Escape');
    await panel.setViewportSize({ width: 440, height: 900 });
  });
  await test('failed preference writes keep this session usable and show a retryable error', async () => {
    await panel.waitForFunction(
      async () =>
        (await chrome.storage.local.get('preferences:thumbnailSize'))[
          'preferences:thumbnailSize'
        ] === 'medium',
    );
    await panel.evaluate(() => {
      const original = chrome.storage.local.set;
      window.restorePreferenceStorage = () => {
        chrome.storage.local.set = original;
      };
      chrome.storage.local.set = async () => {
        throw new Error('Simulated storage rejection');
      };
    });
    await panel.getByRole('button', { name: '显示设置', exact: true }).click();
    await panel.getByLabel('缩略图大小', { exact: true }).selectOption('large');
    await panel.getByRole('alert').filter({ hasText: '未能保存' }).waitFor();
    await panel.locator('.grid-view[data-thumbnail-size="large"]').waitFor();
    await panel.evaluate(() => {
      window.restorePreferenceStorage();
      delete window.restorePreferenceStorage;
    });
    await panel.getByLabel('缩略图大小', { exact: true }).selectOption('small');
    await panel.waitForFunction(() => !document.querySelector('.preference-error'));
    await panel.getByLabel('缩略图大小', { exact: true }).selectOption('medium');
    await panel.keyboard.press('Escape');
  });
  await test('manual clipboard fallback keeps every exact URL', async () => {
    await panel.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('Denied for test');
          },
        },
      }),
    );
    await panel.getByRole('button', { name: '复制全部', exact: true }).click();
    const text = await panel.getByRole('textbox', { name: '待复制的链接' }).inputValue();
    assert.deepEqual(
      text.split('\n'),
      (await state()).result.resources.map((item) => item.url),
    );
    await panel.getByRole('button', { name: '知道了', exact: true }).click();
  });
  await test('cancel preserves completed results and releases webpage events', async () => {
    const taskId = (await state()).result.taskId;
    await panel.getByRole('button', { name: '重新选择模块', exact: true }).click();
    await waitState((value) => value?.status === 'selecting');
    await page.keyboard.press('Escape');
    const current = await waitState((value) => value?.status === 'ready');
    assert.equal(current.result.taskId, taskId);
    await page.locator('h1').click();
    assert.equal(await page.evaluate(() => window.pageClicks), 1);
  });
  await test('selection toolbar adjusts scope, extracts and cancels without webpage clicks', async () => {
    const clicks = await page.evaluate(() => window.pageClicks);
    await panel.getByRole('button', { name: '重新选择模块', exact: true }).click();
    await waitState((value) => value?.status === 'selecting');
    await page.locator('#first-image').scrollIntoViewIfNeeded();
    const rect = await page.locator('#first-image').boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const toolbar = page.getByRole('region', { name: '范围选取工具条' });
    await toolbar.getByText('图片区域', { exact: false }).waitFor();
    assert.equal(
      await toolbar.getByRole('button', { name: '提取', exact: true }).isVisible(),
      false,
    );
    await page.screenshot({ path: path.join(artifacts, `${target}-selection-preview.png`) });
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    assert.equal((await state()).status, 'selecting', 'Click must lock without scanning');
    const lockedPosition = await toolbar.boundingBox();
    await page.mouse.move(1050, 20);
    await page.mouse.click(1050, 20);
    assert.equal(await toolbar.locator('.description').textContent(), '图片区域');
    const hierarchy = toolbar.getByRole('navigation', { name: '选区层级' });
    await hierarchy.getByRole('button', { name: '图片列表区域', exact: true }).click();
    await hierarchy.getByRole('button', { name: '图片区域', exact: true }).click();
    assert.equal(await hierarchy.locator('[aria-current="true"]').textContent(), '图片区域');
    await toolbar.getByRole('button', { name: '扩大范围', exact: true }).click();
    await toolbar.getByRole('button', { name: '缩小范围', exact: true }).click();
    await toolbar.getByRole('button', { name: '扩大范围', exact: true }).click();
    assert.deepEqual(
      await toolbar.boundingBox(),
      lockedPosition,
      'Scope changes must keep toolbar anchored',
    );
    await page.evaluate(() => scrollBy(0, 120));
    await page.waitForFunction(() => scrollY >= 120);
    assert.deepEqual(
      await toolbar.boundingBox(),
      lockedPosition,
      'Scrolling must keep toolbar anchored',
    );
    await page.setViewportSize({ width: 320, height: 480 });
    await page.waitForFunction(() => {
      const toolbar = document
        .querySelector('[style*="2147483647"]')
        ?.shadowRoot?.querySelector('.label');
      const bounds = toolbar?.getBoundingClientRect();
      return (
        bounds &&
        bounds.left >= 8 &&
        bounds.right <= innerWidth - 8 &&
        bounds.bottom <= innerHeight - 8
      );
    });
    await page.screenshot({ path: path.join(artifacts, `${target}-selection-narrow.png`) });
    await page.setViewportSize({ width: 1100, height: 900 });
    await toolbar.getByRole('button', { name: '重新选取', exact: true }).click();
    assert.equal(
      await toolbar.getByRole('button', { name: '提取', exact: true }).isVisible(),
      false,
    );
    await page.locator('#first-image').scrollIntoViewIfNeeded();
    const newRect = await page.locator('#first-image').boundingBox();
    await page.mouse.move(newRect.x + newRect.width / 2, newRect.y + newRect.height / 2);
    await page.keyboard.press('Enter');
    await hierarchy.getByRole('button', { name: '内容卡片', exact: true }).click();
    await page.screenshot({ path: path.join(artifacts, `${target}-selection-locked.png`) });
    await toolbar.getByRole('button', { name: '提取', exact: true }).click();
    const current = await waitState((value) => value?.status === 'ready');
    assert.equal(current.result.moduleSummary, 'article#first');
    assert.equal(current.result.resources.length, 1);
    assert.equal(await page.evaluate(() => window.pageClicks), clicks);
    await panel.getByRole('button', { name: '重新选择模块', exact: true }).click();
    await waitState((value) => value?.status === 'selecting');
    await page.keyboard.press('Escape');
    assert.equal(
      (await waitState((value) => value?.status === 'ready')).result.taskId,
      current.result.taskId,
    );
    await panel.getByRole('button', { name: '重新选择模块', exact: true }).click();
    await waitState((value) => value?.status === 'selecting');
    await page.locator('#first-image').scrollIntoViewIfNeeded();
    const fullRect = await page.locator('#first-image').boundingBox();
    await page.mouse.move(fullRect.x + fullRect.width / 2, fullRect.y + fullRect.height / 2);
    for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const toolbar = document
        .querySelector('[style*="2147483647"]')
        ?.shadowRoot?.querySelector('.label');
      const bounds = toolbar?.getBoundingClientRect();
      return (
        bounds &&
        Math.abs(bounds.right - (innerWidth - 8)) < 1 &&
        Math.abs(bounds.bottom - (innerHeight - 8)) < 1
      );
    });
    await toolbar.getByRole('button', { name: '取消', exact: true }).click();
    await waitState((value) => value?.status === 'ready');
  });
  await test('selection recommends image modules, estimates sources and previews boundaries', async () => {
    const toolbar = page.getByRole('region', { name: '范围选取工具条' });
    const preview = async (selector) => {
      if ((await state())?.status === 'selecting') {
        await page.keyboard.press('Escape');
        await waitState((value) => value?.status !== 'selecting');
      }
      await panel.getByRole('button', { name: /^(选择网页模块|重新选择模块)$/ }).click();
      await waitState((value) => value?.status === 'selecting');
      await page.locator(selector).scrollIntoViewIfNeeded();
      const rect = await page.locator(selector).boundingBox();
      await page.mouse.move(
        rect.x + Math.min(10, rect.width / 2),
        rect.y + Math.min(10, rect.height / 2),
      );
    };
    await page
      .locator('#first h3')
      .evaluate((element) => (element.className = 'product-card__title'));
    await preview('#first h3');
    await toolbar.locator('.description').getByText('内容卡片', { exact: true }).waitFor();
    await toolbar.locator('.estimate').getByText('1 个图片元素（预估）', { exact: true }).waitFor();
    const imageRect = await page.locator('#first-image').boundingBox();
    await page.mouse.move(imageRect.x + imageRect.width / 2, imageRect.y + imageRect.height / 2);
    await toolbar.locator('.description').getByText('图片区域', { exact: true }).waitFor();
    const titleRect = await page.locator('#first h3').boundingBox();
    await page.mouse.move(titleRect.x + 10, titleRect.y + 10);
    await toolbar.locator('.description').getByText('内容卡片', { exact: true }).waitFor();
    await page.keyboard.press('Enter');
    const hierarchy = toolbar.getByRole('navigation', { name: '选区层级' });
    assert.equal(
      await hierarchy.locator('[aria-current="true"]').getAttribute('title'),
      'article#first',
    );
    await page.keyboard.press('ArrowDown');
    await toolbar
      .locator('.estimate')
      .getByText('未发现可提取的图片元素', { exact: true })
      .waitFor();
    assert.equal(
      await hierarchy.locator('[aria-current="true"]').getAttribute('title'),
      'h3.product-card__title',
    );
    await hierarchy.getByRole('button', { name: '内容卡片', exact: true }).click();
    await toolbar.locator('.estimate').getByText('1 个图片元素（预估）', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, `${target}-selection-recommended.png`) });
    await toolbar.getByRole('button', { name: '提取', exact: true }).click();
    const result = await waitState((value) => value?.status === 'ready');
    assert.equal(result.result.moduleSummary, 'article#first');
    assert.equal(result.result.resources.length, 1);

    for (const selector of ['.background', '.pseudo', '#first-image']) {
      await preview(selector);
      await toolbar
        .locator('.estimate')
        .getByText('1 个图片元素（预估）', { exact: true })
        .waitFor();
      await page.keyboard.press('Enter');
      const expected = await page.locator(selector).evaluate((element) => element.localName);
      assert.ok(
        (await hierarchy.locator('[aria-current="true"]').getAttribute('title')).startsWith(
          expected,
        ),
      );
    }
    await preview('#module');
    await toolbar
      .locator('.estimate')
      .getByText('10 个图片元素（预估）', { exact: true })
      .waitFor();
    assert.equal(await toolbar.locator('.boundary').isVisible(), false);
    await preview('#lazy');
    await toolbar.locator('.estimate').getByText('3 个图片元素（预估）', { exact: true }).waitFor();
    await preview('#unsafe');
    await toolbar
      .locator('.estimate')
      .getByText('未发现可提取的图片元素', { exact: true })
      .waitFor();

    for (const [selector, boundary] of [
      ['#boundaries iframe', 'iframe'],
      ['#shadow-host', 'Shadow DOM'],
      ['#boundaries', 'iframe / Shadow DOM'],
    ]) {
      await preview(selector);
      if (selector === '#boundaries') await page.keyboard.press('ArrowUp');
      await toolbar
        .locator('.boundary')
        .getByText(`含 ${boundary}，内部图片暂不支持提取`, { exact: true })
        .waitFor();
      await toolbar
        .locator('.estimate')
        .getByText('未发现可提取的图片元素', { exact: true })
        .waitFor();
    }
    await page.keyboard.press('Enter');
    await page.screenshot({ path: path.join(artifacts, `${target}-selection-boundary.png`) });

    await page.evaluate(() => {
      const section = document.createElement('section');
      section.id = 'estimate-large';
      section.style.cssText = 'padding:32px;margin-top:20px';
      section.innerHTML = '<span>·</span>'.repeat(2000);
      document.body.append(section);
    });
    await preview('#estimate-large');
    await toolbar
      .locator('.estimate')
      .getByText('尚未发现图片，预估未完成', { exact: true })
      .waitFor();
    assert.equal((await state()).status, 'selecting');
    await page.keyboard.press('Escape');
    await waitState((value) => value?.status === 'ready');
    await page.evaluate(() => document.querySelector('#estimate-large').remove());
    await page.locator('#first h3').evaluate((element) => element.removeAttribute('class'));
  });
  await test('restore survives panel reload and stale task messages cannot overwrite it', async () => {
    const previous = (await state()).result;
    const obsolete = (await choose('#empty')).result;
    await panel.reload();
    await activate();
    await panel.getByRole('button', { name: '恢复上次结果', exact: true }).click();
    const current = await waitState((value) => value?.result.taskId === previous.taskId);
    assert.deepEqual(current.result.resources, previous.resources);
    assert.equal(current.previousResult, undefined);
    assert.equal(current.stale, true);
    await worker.evaluate(
      async ({ tabId, obsolete }) => {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: async (result) =>
            chrome.runtime.sendMessage({
              type: 'SCAN_DONE',
              taskId: result.taskId,
              documentToken: result.documentToken,
              result: { ...result, resources: [] },
            }),
          args: [obsolete],
        });
      },
      { tabId, obsolete },
    );
    assert.equal((await state()).result.taskId, previous.taskId);
    assert.equal(
      await panel.getByRole('button', { name: '重新提取', exact: true }).isDisabled(),
      true,
    );
    await choose('#module');
  });
  await test('append keeps old URLs, deduplicates and can be undone', async () => {
    const original = (await state()).result;
    await page.evaluate(() => {
      document.querySelector('#module').querySelector('img').remove();
      const image = document.createElement('img');
      image.src = '/assets/appended.svg?token=exact#version';
      document.querySelector('#module').append(image);
    });
    await panel.getByRole('button', { name: '滚动后追加采集', exact: true }).click();
    const appended = await waitState(
      (value) => value?.status === 'ready' && value.result.taskId !== original.taskId,
    );
    assert.equal(appended.result.resources.length, original.resources.length + 1);
    assert.ok(
      original.resources.every((image) =>
        appended.result.resources.some((item) => item.url === image.url),
      ),
    );
    assert.ok(
      appended.result.resources.some((image) =>
        image.url.endsWith('appended.svg?token=exact#version'),
      ),
    );
    await panel.getByRole('button', { name: '恢复上次结果', exact: true }).click();
    await waitState((value) => value?.result.taskId === original.taskId);
    await page.goto(fixtureOrigin);
    await choose('#module');
  });
  await test('empty state, parent/child adjustment, rescan and removed modules', async () => {
    const current = await choose('#empty');
    assert.equal(current.status, 'empty');
    await panel
      .locator('.empty-actions')
      .getByRole('button', { name: '扩大范围', exact: true })
      .click();
    await waitState((value) => value?.status === 'ready');
    await panel
      .locator('.module-actions')
      .getByRole('button', { name: '缩小范围', exact: true })
      .click();
    await waitState((value) => value?.status === 'empty');
    await page.evaluate(
      () => (document.querySelector('#empty').innerHTML = '<img src="added.svg">'),
    );
    await panel.getByRole('button', { name: '重新提取', exact: true }).click();
    assert.equal(
      (await waitState((value) => value?.status === 'ready')).result.resources.length,
      1,
    );
    await page.evaluate(() => document.querySelector('#empty').remove());
    await panel.getByRole('button', { name: '重新提取', exact: true }).click();
    await waitState((value) => value?.error?.includes('失效'));
  });
  await test('unsupported resources and embedded boundaries', async () => {
    let current = await choose('#unsafe');
    assert.equal(current.status, 'empty');
    assert.equal(current.result.summary.skippedCount, 2);
    assert.ok(current.result.summary.warnings.some((item) => item.includes('Canvas')));
    current = await choose('#boundaries');
    assert.equal(current.result.resources.length, 0);
    assert.ok(current.result.summary.warnings.some((item) => item.includes('iframe')));
  });
  await test('navigation makes old results stale and invalidates selection', async () => {
    await choose('#module');
    await page.evaluate(() => history.pushState({}, '', '/changed'));
    await waitState((value) => value?.stale === true);
    assert.equal(
      await panel.getByRole('button', { name: '重新提取', exact: true }).isDisabled(),
      true,
    );
    await page.goto(fixtureOrigin);
    await choose('#module');
  });
  await test('tab isolation and obsolete task messages', async () => {
    const original = await state();
    const second = await context.newPage();
    await second.goto(`${fixtureOrigin}/second`);
    await second.bringToFront();
    const secondId = await worker.evaluate(
      async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
    );
    await activate(secondId);
    await panel.getByRole('button', { name: '选择网页模块', exact: true }).waitFor();
    await panel.getByRole('button', { name: '选择网页模块', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: '工具栏' }).waitFor();
    await activate();
    await panel.getByRole('button', { name: '重新选择模块', exact: true }).waitFor();
    assert.equal((await state()).result.taskId, original.result.taskId);
    await second.close();
  });
  await test('completed results survive service worker restart', async () => {
    const original = (await state()).result.taskId;
    const cdp = await context.newCDPSession(panel);
    const targets = (await cdp.send('Target.getTargets')).targetInfos;
    const target = targets.find(
      (item) => item.type === 'service_worker' && item.url.includes(extensionId),
    );
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
    await panel.reload();
    worker =
      context.serviceWorkers().find((item) => item.url().includes(extensionId)) ??
      (await context.waitForEvent('serviceworker'));
    await activate();
    await panel.getByRole('button', { name: '重新选择模块', exact: true }).waitFor();
    assert.equal((await state()).result.taskId, original);
    await cdp.detach();
  });
  await test('restricted pages fail without entering selection mode', async () => {
    await page.goto(target === 'edge' ? 'edge://settings' : 'chrome://settings');
    await panel.getByRole('button', { name: '重新选择模块', exact: true }).click();
    await panel
      .getByRole('alert')
      .filter({ hasText: /无法读取|不允许/ })
      .waitFor();
    assert.notEqual((await state()).status, 'selecting');
    await page.goto(fixtureOrigin);
    await grantAction();
  });
  await test('5000-element performance, twenty scans and cancellation', async () => {
    await page.goto(`${fixtureOrigin}/perf?nodes=5000&images=200`);
    const initial = await choose('#performance');
    assert.equal(initial.result.resources.length, 200);
    const durations = [initial.result.summary.durationMs];
    for (let i = 1; i < 20; i++) {
      const previous = (await state()).result.taskId;
      await panel.getByRole('button', { name: '重新提取', exact: true }).click();
      const current = await waitState(
        (value) => value?.status === 'ready' && value?.result.taskId !== previous,
      );
      durations.push(current.result.summary.durationMs);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    performanceReport = {
      elements: 5001,
      uniqueImages: 200,
      samplesMs: durations,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      initialMs: durations[0],
    };
    assert.ok(performanceReport.p95Ms <= 2000, `Scan p95 was ${performanceReport.p95Ms}ms`);
    const previous = (await state()).result.taskId;
    // Cancel at the command boundary; a fast scan may finish before a visual click can reach Cancel.
    await panel.evaluate(async (id) => {
      await chrome.runtime.sendMessage({
        type: 'COMMAND',
        tabId: id,
        command: 'RESCAN',
        requestId: crypto.randomUUID(),
      });
      await chrome.runtime.sendMessage({
        type: 'COMMAND',
        tabId: id,
        command: 'CANCEL',
        requestId: crypto.randomUUID(),
      });
    }, tabId);
    const current = await waitState((value) => !['scanning', 'selecting'].includes(value?.status));
    assert.equal(current.result.taskId, previous);
  });
  await test('node traversal stops at configured limit', async () => {
    await page.goto(`${fixtureOrigin}/perf?nodes=21000&images=2`);
    const current = await choose('#performance');
    assert.equal(current.status, 'partial');
    assert.equal(current.result.summary.visitedNodeCount, 20000);
    assert.ok(current.result.summary.partialReasons.some((item) => item.includes('元素')));
  });
  await test('resource limit and virtualized gallery', async () => {
    await page.goto(`${fixtureOrigin}/perf?nodes=1200&images=1100`);
    const current = await choose('#performance');
    assert.equal(current.status, 'partial');
    assert.equal(current.result.resources.length, 1000);
    assert.ok(current.result.summary.partialReasons.some((item) => item.includes('上限')));
    assert.ok((await panel.locator('.image-card').count()) < 100);
    await panel
      .locator('.result-warnings')
      .getByRole('button', { name: '重新选择小范围', exact: true })
      .waitFor();
  });
  await test('virtualized focus restoration remains navigable in grid and list', async () => {
    const resources = (await state()).result.resources;
    await panel.locator('.thumbnail').first().click();
    for (let i = 0; i < 40; i++) await panel.keyboard.press('ArrowRight');
    await panel.keyboard.press('Escape');
    await panel.waitForFunction(
      (url) => document.activeElement?.closest('.image-card')?.dataset.imageUrl === url,
      resources[40].url,
    );
    assert.ok(await panel.locator('.app-main').evaluate((node) => node.scrollTop > 0));
    const scroll = await panel.locator('.app-main').evaluate(async (node) => {
      node.scrollTop = 0;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return node.scrollTop;
    });
    assert.equal(scroll, 0, 'Restored focus must not trap subsequent scrolling');
    await panel.getByRole('button', { name: '列表', exact: true }).click();
    await panel.locator('.list-view').waitFor();
    await panel.locator('.app-main').evaluate((node) => (node.scrollTop = node.scrollHeight));
    await panel.locator('.thumbnail').last().click();
    await panel.keyboard.press('ArrowLeft');
    const selected = await panel.locator('#image-url').inputValue();
    await panel.keyboard.press('Escape');
    await panel.waitForFunction(
      (url) => document.activeElement?.closest('.image-card')?.dataset.imageUrl === url,
      selected,
    );
    assert.ok((await panel.locator('.image-card').count()) < 100);
    await panel.locator('.app-main').evaluate((node) => (node.scrollTop = 0));
    await panel.getByRole('button', { name: '网格', exact: true }).click();
  });
  await test('all thumbnail sizes keep virtualized grids and lists reachable', async () => {
    const lastUrl = (await state()).result.resources.at(-1).url;
    const heights = [];
    for (const view of ['grid', 'list'])
      for (const size of ['small', 'medium', 'large']) {
        await panel.getByRole('button', { name: '显示设置', exact: true }).click();
        await panel.getByLabel('默认视图', { exact: true }).selectOption(view);
        await panel.getByLabel('缩略图大小', { exact: true }).selectOption(size);
        await panel.keyboard.press('Escape');
        await panel.locator(`.${view}-view[data-thumbnail-size="${size}"]`).waitFor();
        if (view === 'grid')
          heights.push((await panel.locator('.thumbnail').first().boundingBox()).height);
        await panel.locator('.app-main').evaluate((node) => (node.scrollTop = node.scrollHeight));
        await panel.waitForFunction(
          (url) => document.querySelector('.image-card:last-child')?.dataset.imageUrl === url,
          lastUrl,
        );
        assert.ok((await panel.locator('.image-card').count()) < 100);
        assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await panel.locator('.thumbnail').last().click();
        assert.equal(await panel.locator('#image-url').inputValue(), lastUrl);
        await panel.keyboard.press('Escape');
        await panel.waitForFunction(
          (url) => document.activeElement?.closest('.image-card')?.dataset.imageUrl === url,
          lastUrl,
        );
      }
    assert.ok(heights[0] < heights[1] && heights[1] < heights[2]);
    await panel.getByRole('button', { name: '显示设置', exact: true }).click();
    await panel.getByLabel('默认视图', { exact: true }).selectOption('grid');
    await panel.getByLabel('缩略图大小', { exact: true }).selectOption('medium');
    await panel.keyboard.press('Escape');
  });
  await test('metadata budget truncates with an explicit partial result', async () => {
    await page.goto(fixtureOrigin);
    await page.evaluate(() => {
      const section = document.createElement('section');
      section.id = 'large';
      section.style.padding = '24px';
      for (let i = 0; i < 25; i++)
        for (let j = 0; j < 20; j++) {
          const image = document.createElement('img');
          image.setAttribute('data-src', `/assets/large-${i}.svg?token=${'x'.repeat(12000)}`);
          section.append(image);
        }
      document.body.prepend(section);
    });
    const current = await choose('#large');
    assert.equal(current.status, 'partial');
    assert.ok(current.result.resources.length > 0 && current.result.resources.length < 25);
    assert.equal(current.result.summary.uniqueCount, current.result.resources.length);
    assert.ok(current.result.summary.partialReasons.some((item) => item.includes('容量')));
    const used = await worker.evaluate(() => chrome.storage.session.getBytesInUse(null));
    assert.ok(used < 6 * 1024 * 1024, `Storage usage ${used}`);
  });
  assert.deepEqual(errors, [], 'Side panel has no uncaught application errors');
  await fs.writeFile(
    path.join(artifacts, reportName),
    JSON.stringify(
      {
        browser: context.browser()?.version(),
        passed,
        errors,
        performance: performanceReport,
        fixtureHostPermission: 'none; real toolbar action via CDP',
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`Completed ${passed.length} browser checks (${target}).`);
} catch (error) {
  await fs.writeFile(
    path.join(artifacts, reportName),
    JSON.stringify(
      { passed, errors, performance: performanceReport, failure: String(error) },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
