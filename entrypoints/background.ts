import { browser } from 'wxt/browser';
import { isSupportedPage } from '../lib/urls';
import type { Message, Result, TabState } from '../lib/types';

const PREFIX = 'tab:';
const BUDGET = 5 * 1024 * 1024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const settledStatus = (result?: Result): TabState['status'] =>
  !result
    ? 'idle'
    : result.summary.partialReasons.length
      ? 'partial'
      : result.resources.length
        ? 'ready'
        : 'empty';

export default defineBackground(() => {
  const states = new Map<number, TabState>();
  let sequence: Promise<unknown> = Promise.resolve();
  const serialize = <T>(job: () => Promise<T>): Promise<T> => {
    const next = sequence.then(job, job);
    sequence = next.catch(() => undefined);
    return next;
  };
  const ready = (async () => {
    const saved = await browser.storage.session.get(null);
    for (const [key, value] of Object.entries(saved)) {
      if (!key.startsWith(PREFIX)) continue;
      const state = value as TabState;
      if (state.status === 'selecting' || state.status === 'scanning') {
        state.taskId = crypto.randomUUID();
        state.status = settledStatus(state.result);
        delete state.progress;
        state.error = '上次任务已中断，可重新选择或提取。';
        void browser.tabs
          .sendMessage(state.tabId, {
            type: 'CONTENT_COMMAND',
            command: 'CANCEL',
            taskId: state.taskId,
          })
          .catch(() => {});
      }
      states.set(state.tabId, state);
      await browser.storage.session.set({ [key]: state });
    }
  })();

  const get = (tabId: number): TabState =>
    states.get(tabId) ?? { tabId, taskId: '', status: 'idle', lastViewed: Date.now() };
  const save = async (state: TabState) => {
    states.set(state.tabId, state);
    let total = [...states.values()].reduce((sum, item) => sum + bytes(item), 0);
    const others = [...states.values()]
      .filter((item) => item.tabId !== state.tabId)
      .sort((a, b) => a.lastViewed - b.lastViewed);
    for (const other of others) {
      if (total <= BUDGET) break;
      total -= bytes(other);
      // Keep a lightweight notice so an evicted tab never looks as though it has not been used.
      const replacement: TabState = {
        tabId: other.tabId,
        taskId: crypto.randomUUID(),
        status: 'idle',
        lastViewed: other.lastViewed,
        notice: '会话空间已回收，请重新选择模块。',
      };
      states.set(other.tabId, replacement);
      total += bytes(replacement);
      await browser.storage.session.set({ [PREFIX + other.tabId]: replacement });
      void browser.tabs
        .sendMessage(other.tabId, {
          type: 'CONTENT_COMMAND',
          command: 'CANCEL',
          taskId: replacement.taskId,
        })
        .catch(() => {});
      state.notice = '已回收其他标签页的旧结果以释放会话空间。';
    }
    // Prefer releasing the single undo snapshot to truncating the current result.
    if (total > BUDGET && state.previousResult) {
      total -= bytes(state.previousResult);
      delete state.previousResult;
      state.notice = '会话空间不足，上次结果已释放；当前结果仍可查看。';
    }
    for (const result of [state.progress, state.result]) {
      if (!result) continue;
      const reason = '达到会话元数据容量上限，结果已截断';
      while (total > BUDGET && result.resources.length) {
        if (!result.summary.partialReasons.includes(reason))
          result.summary.partialReasons.push(reason);
        const available = Math.max(0, BUDGET - (total - bytes(result)));
        const remove = Math.max(
          1,
          Math.ceil(result.resources.length * (1 - available / bytes(result))),
        );
        result.resources.splice(-remove);
        result.summary.uniqueCount = result.resources.length;
        total = [...states.values()].reduce((sum, item) => sum + bytes(item), 0);
      }
    }
    if (state.status !== 'scanning' && state.status !== 'selecting' && state.result)
      state.status = settledStatus(state.result);
    await browser.storage.session.set({ [PREFIX + state.tabId]: state });
  };
  const content = async (tabId: number, command: string, taskId: string) => {
    return browser.tabs.sendMessage(tabId, { type: 'CONTENT_COMMAND', command, taskId });
  };
  const ensureContent = async (tabId: number) => {
    try {
      return await browser.tabs.sendMessage(tabId, { type: 'CONTENT_PING' });
    } catch {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ['/content-scripts/picker.js'],
      });
      return browser.tabs.sendMessage(tabId, { type: 'CONTENT_PING' });
    }
  };
  const runCommand = async (tabId: number, command: string) => {
    const state = get(tabId);
    if (command === 'RESTORE') {
      if (!state.previousResult) throw new Error('没有可恢复的上次结果。');
      const previousTask = state.taskId;
      state.taskId = crypto.randomUUID();
      state.result = state.previousResult;
      delete state.previousResult;
      delete state.progress;
      delete state.append;
      delete state.error;
      // The DOM selection still points at the new region. Require re-selection for scanning.
      state.stale = true;
      state.status = settledStatus(state.result);
      state.notice = '已恢复上次结果。继续采集时请重新选择范围。';
      await save(state);
      await content(tabId, 'CANCEL', previousTask).catch(() => {});
      return { ok: true };
    }
    if (command === 'CANCEL') {
      const previousTask = state.taskId;
      state.taskId = crypto.randomUUID();
      state.status = settledStatus(state.result);
      delete state.progress;
      delete state.append;
      delete state.error;
      await save(state);
      await content(tabId, command, previousTask).catch(() => {});
      return { ok: true };
    }
    const tab = await browser.tabs.get(tabId);
    if (!isSupportedPage(tab.url))
      throw new Error('当前页面无法读取。请在普通 HTTP/HTTPS 网页点击工具栏插件图标授权。');
    if (state.stale && command !== 'SELECT') throw new Error('页面已变化，请重新选择模块。');
    const connection = await ensureContent(tabId);
    const previousTask = state.taskId;
    state.taskId = crypto.randomUUID();
    state.documentToken = connection.documentToken;
    state.status = command === 'SELECT' ? 'selecting' : 'scanning';
    state.append = command === 'APPEND';
    delete state.error;
    delete state.progress;
    delete state.notice;
    await save(state);
    try {
      const reply = await content(tabId, command, state.taskId);
      if (reply?.error) throw new Error(reply.error);
      if (!reply?.ok) throw new Error('页面未响应，请重新点击工具栏图标。');
    } catch (error) {
      await content(tabId, 'CANCEL', previousTask).catch(() => {});
      throw error;
    }
    return { ok: true };
  };

  browser.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    // Must happen in the original user gesture, before any await.
    void browser.sidePanel.open({ tabId: tab.id }).catch(() => {});
    void serialize(async () => {
      await ready;
      try {
        if (!isSupportedPage(tab.url))
          throw new Error('当前页面不允许插件读取，请在普通 HTTP/HTTPS 网页使用。');
        await ensureContent(tab.id!);
        const state = get(tab.id!);
        delete state.error;
        await save(state);
      } catch (error) {
        const state = get(tab.id!);
        state.error = error instanceof Error ? error.message : '页面授权失败，请重试。';
        state.status = settledStatus(state.result);
        await save(state);
      }
    });
  });

  browser.runtime.onMessage.addListener((raw, sender) => {
    if (!raw || typeof raw.type !== 'string' || sender.id !== browser.runtime.id) return;
    const message = raw as Message;
    const extensionPage =
      sender.url?.split('?')[0] === new URL('sidepanel.html', browser.runtime.getURL('/')).href;
    if (message.type === 'GET_STATE' || message.type === 'COMMAND') {
      if (!extensionPage || !Number.isInteger(message.tabId)) return;
      return serialize(async () => {
        await ready;
        if (message.type === 'GET_STATE') {
          const state = get(message.tabId);
          state.lastViewed = Date.now();
          return structuredClone(state);
        }
        try {
          return await runCommand(message.tabId, message.command);
        } catch (error) {
          const state = get(message.tabId);
          state.status = settledStatus(state.result);
          state.taskId = crypto.randomUUID();
          delete state.progress;
          state.error = error instanceof Error ? error.message : '操作失败，请重新点击工具栏图标。';
          await save(state);
          return { ok: false, error: state.error };
        }
      });
    }
    if (sender.tab?.id === undefined || sender.frameId !== 0) return;
    const tabId = sender.tab.id;
    return serialize(async () => {
      await ready;
      const state = get(tabId);
      if (message.type === 'CONTENT_NAVIGATED') {
        if (state.documentToken && state.documentToken !== message.documentToken) return;
        state.stale = true;
        state.taskId = crypto.randomUUID();
        state.status = settledStatus(state.result);
        delete state.progress;
        await save(state);
        return;
      }
      if (!('taskId' in message) || message.taskId !== state.taskId) return;
      if (!('documentToken' in message) || typeof message.documentToken !== 'string') return;
      if (message.type === 'SCAN_START') {
        state.documentToken = message.documentToken;
        state.status = 'scanning';
        delete state.error;
      } else {
        if (state.documentToken && state.documentToken !== message.documentToken) return;
        if (message.type === 'SCAN_BATCH' || message.type === 'SCAN_DONE') {
          if (
            state.status !== 'scanning' ||
            message.result.taskId !== state.taskId ||
            message.result.resources.length > 100
          )
            return;
          const incoming = message.result;
          const merged = new Map((state.progress?.resources ?? []).map((item) => [item.url, item]));
          for (const resource of incoming.resources) {
            if (
              typeof resource.url !== 'string' ||
              !/^https?:\/\//.test(resource.url) ||
              resource.sources.length > 20
            )
              return;
            merged.set(resource.url, resource);
          }
          const reasons = [
            ...new Set([
              ...incoming.summary.partialReasons,
              ...(state.progress?.summary.partialReasons ?? []),
            ]),
          ];
          state.progress = {
            ...incoming,
            summary: { ...incoming.summary, partialReasons: reasons },
            resources: [...merged.values()].slice(0, 1000),
          };
          if (message.type === 'SCAN_DONE') {
            const previous = state.result;
            if (state.append && previous) {
              const combined = new Map(previous.resources.map((item) => [item.url, item]));
              for (const item of state.progress.resources) combined.set(item.url, item);
              state.progress.resources = [...combined.values()].slice(0, 1000);
              state.progress.summary.referenceCount = state.progress.resources.reduce(
                (total, item) => total + item.referenceCount,
                0,
              );
              if (combined.size > 1000)
                state.progress.summary.partialReasons.push('追加后达到 1000 张图片上限');
            }
            state.previousResult = previous;
            state.result = state.progress;
            state.result.summary.uniqueCount = state.result.resources.length;
            state.status = settledStatus(state.result);
            state.stale = false;
            delete state.progress;
            delete state.append;
          }
        } else if (message.type === 'CONTENT_ERROR') {
          state.status = settledStatus(state.result);
          state.error = message.error.slice(0, 500);
          delete state.progress;
        } else if (message.type === 'CONTENT_CANCEL') {
          state.status = settledStatus(state.result);
          delete state.progress;
        } else return;
      }
      await save(state);
      return { ok: true };
    });
  });

  browser.tabs.onActivated.addListener((info) => {
    void serialize(async () => {
      await ready;
      for (const state of states.values()) {
        if (state.tabId === info.tabId || !['selecting', 'scanning'].includes(state.status))
          continue;
        state.taskId = crypto.randomUUID();
        state.status = settledStatus(state.result);
        delete state.progress;
        await content(state.tabId, 'CANCEL', state.taskId).catch(() => {});
        await save(state);
      }
    });
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (!change.url && change.status !== 'loading') return;
    void serialize(async () => {
      await ready;
      if (!states.has(tabId)) return;
      const state = get(tabId);
      state.taskId = crypto.randomUUID();
      state.stale = true;
      state.status = settledStatus(state.result);
      delete state.progress;
      await content(tabId, 'CANCEL', state.taskId).catch(() => {});
      await save(state);
    });
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    void serialize(async () => {
      await ready;
      states.delete(tabId);
      await browser.storage.session.remove(PREFIX + tabId);
    });
  });
});
