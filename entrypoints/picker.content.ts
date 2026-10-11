import { browser } from 'wxt/browser';
import { elementSummary, extractImages, regionLabel } from '../lib/extract';
import { newId } from '../lib/id';
import type { Message, Result } from '../lib/types';

export default defineContentScript({
  // Injected through activeTab only; runtime matches would make WXT add permanent host permissions.
  matches: [],
  registration: 'runtime',
  main(ctx) {
    const global = globalThis as typeof globalThis & { __moduleImagePicker?: () => void };
    // Idempotent even if two injection requests race.
    global.__moduleImagePicker?.();
    const documentToken = newId();
    let taskId = '';
    let selected: Element | null = null;
    let candidate: Element | null = null;
    let hovered: Element | null = null;
    let childPath: Element[] = [];
    let selectedPath: Element[] = [];
    let controller: AbortController | undefined;
    let selecting = false;
    let host: HTMLDivElement | undefined;
    let box: HTMLDivElement | undefined;
    let label: HTMLDivElement | undefined;
    let description: HTMLDivElement | undefined;
    let selectorInfo: HTMLElement | undefined;
    let enlarge: HTMLButtonElement | undefined;
    let shrink: HTMLButtonElement | undefined;
    let extract: HTMLButtonElement | undefined;
    let frame = 0;
    let previousUrl = location.href;
    const send = (message: Message) => browser.runtime.sendMessage(message);
    const cancelScan = () => {
      controller?.abort();
      controller = undefined;
    };
    const draw = () => {
      frame = 0;
      if (!candidate?.isConnected || !box || !label) return;
      const rect = candidate.getBoundingClientRect();
      Object.assign(box.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      if (description)
        description.textContent = `${regionLabel(candidate)} · ${Math.round(rect.width)} × ${Math.round(rect.height)}`;
      if (selectorInfo) selectorInfo.textContent = elementSummary(candidate);
      if (enlarge) enlarge.disabled = candidate === document.body || !candidate.parentElement;
      if (shrink) shrink.disabled = !childPath.length;
      if (extract) extract.disabled = false;
      const toolbarHeight = label.offsetHeight;
      const toolbarWidth = label.offsetWidth;
      const above = rect.top - toolbarHeight - 8;
      Object.assign(label.style, {
        left: `${Math.min(Math.max(8, rect.left), Math.max(8, innerWidth - toolbarWidth - 8))}px`,
        top: `${Math.max(8, Math.min(innerHeight - toolbarHeight - 8, above >= 8 ? above : rect.bottom + 8))}px`,
        bottom: 'auto',
      });
    };
    const scheduleDraw = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const move = (event: MouseEvent) => {
      if (label && event.composedPath().includes(label)) return;
      // Keep the region stable while crossing the small gap to its toolbar.
      const toolbar = label?.getBoundingClientRect();
      if (
        toolbar &&
        candidate &&
        event.clientX >= toolbar.left - 12 &&
        event.clientX <= toolbar.right + 12 &&
        event.clientY >= toolbar.top - 12 &&
        event.clientY <= toolbar.bottom + 12
      )
        return;
      if (childPath.length && candidate) {
        const region = candidate.getBoundingClientRect();
        if (
          event.clientX >= region.left &&
          event.clientX <= region.right &&
          event.clientY >= region.top &&
          event.clientY <= region.bottom
        )
          return;
      }
      host?.style.setProperty('pointer-events', 'none', 'important');
      let target = document.elementFromPoint(event.clientX, event.clientY);
      host?.style.setProperty('pointer-events', 'auto', 'important');
      if (target === document.documentElement) target = document.body;
      if (!target || target === host) return;
      if (target !== hovered) {
        hovered = target;
        candidate = target;
        childPath = [];
      }
      scheduleDraw();
    };
    const stopSelection = () => {
      selecting = false;
      for (const name of [
        'pointerdown',
        'pointerup',
        'mousedown',
        'mouseup',
        'click',
        'dblclick',
        'auxclick',
        'contextmenu',
        'dragstart',
      ])
        window.removeEventListener(name, intercept, true);
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scheduleDraw, true);
      window.removeEventListener('resize', scheduleDraw, true);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      host?.remove();
      host = undefined;
      box = undefined;
      label = undefined;
      description = undefined;
      selectorInfo = undefined;
      enlarge = undefined;
      shrink = undefined;
      extract = undefined;
    };
    const batches = async (result: Result) => {
      for (let offset = 0; offset < result.resources.length; offset += 100) {
        await send({
          type: 'SCAN_BATCH',
          taskId: result.taskId,
          documentToken,
          result: { ...result, resources: result.resources.slice(offset, offset + 100) },
        });
      }
    };
    const scan = async () => {
      stopSelection();
      cancelScan();
      if (!selected?.isConnected) throw new Error('原模块已失效，请重新选择。');
      const root = selected;
      const scanTask = taskId;
      const currentController = new AbortController();
      controller = currentController;
      await send({ type: 'SCAN_START', taskId: scanTask, documentToken });
      try {
        const result = await extractImages(
          root,
          {
            taskId: scanTask,
            documentToken,
            canParent: root !== document.body && !!root.parentElement,
            canChild: selectedPath.length > 0,
          },
          currentController.signal,
          batches,
        );
        currentController.signal.throwIfAborted();
        await batches(result);
        currentController.signal.throwIfAborted();
        await send({
          type: 'SCAN_DONE',
          taskId: scanTask,
          documentToken,
          result: { ...result, resources: [] },
        });
      } catch (error) {
        if (!currentController.signal.aborted) {
          await send({
            type: 'CONTENT_ERROR',
            taskId: scanTask,
            documentToken,
            error: error instanceof Error ? error.message : '提取失败，请重试。',
          }).catch(() => {});
        }
      } finally {
        if (controller === currentController) controller = undefined;
      }
    };
    const intercept = (event: Event) => {
      if (!selecting) return;
      if (label && event.composedPath().includes(label)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'click' && candidate) {
        selected = candidate;
        selectedPath = [...childPath];
        void scan().catch((error) =>
          send({ type: 'CONTENT_ERROR', taskId, documentToken, error: String(error) }).catch(
            () => {},
          ),
        );
      }
    };
    const key = (event: KeyboardEvent) => {
      if (!selecting || !['Escape', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return;
      if (event.key === 'Enter' && label && event.composedPath().includes(label)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        stopSelection();
        void send({ type: 'CONTENT_CANCEL', taskId, documentToken }).catch(() => {});
      } else if (
        event.key === 'ArrowUp' &&
        candidate &&
        candidate !== document.body &&
        candidate.parentElement
      ) {
        childPath.push(candidate);
        candidate = candidate.parentElement;
        scheduleDraw();
      } else if (event.key === 'ArrowDown' && childPath.length) {
        candidate = childPath.pop()!;
        scheduleDraw();
      } else if (event.key === 'Enter' && candidate) {
        selected = candidate;
        selectedPath = [...childPath];
        void scan().catch(() => {});
      }
    };
    const start = () => {
      stopSelection();
      cancelScan();
      if (
        document.contentType !== 'text/html' ||
        document.querySelector('embed[type="application/pdf"]')
      )
        throw new Error('首版仅支持普通 HTML 网页。');
      selecting = true;
      candidate = null;
      hovered = null;
      childPath = [];
      host = document.createElement('div');
      // The glass layer also catches clicks over iframes, whose events never bubble to this document.
      host.style.cssText =
        'all:initial!important;position:fixed!important;inset:0!important;pointer-events:auto!important;cursor:crosshair!important;z-index:2147483647!important;';
      const shadow = host.attachShadow({ mode: 'open' });
      const css = document.createElement('style');
      css.textContent =
        ':host{pointer-events:none}*{box-sizing:border-box}.box{position:fixed;border:2px solid #18785c;background:#18785c15;border-radius:4px;pointer-events:none}.label{position:fixed;padding:10px 12px;width:340px;max-width:calc(100vw - 16px);font:13px/1.6 system-ui,sans-serif;color:white;background:#153c32;border-radius:8px;box-shadow:0 4px 18px #0003;pointer-events:auto;cursor:default}.description{font-weight:600}.selector{display:block;font:12px/1.5 monospace;color:#d0e3db;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}button{font:12px/1.5 system-ui,sans-serif;background:#fff;color:#153c32;border:0;border-radius:5px;padding:6px 8px;cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:3px solid #a8e4cb;outline-offset:2px}button[data-action="extract"]{background:#ace5c9}.hint{font-size:12px;color:#d0e3db}';
      box = document.createElement('div');
      box.className = 'box';
      label = document.createElement('div');
      label.className = 'label';
      label.setAttribute('role', 'region');
      label.setAttribute('aria-label', '范围选取工具条');
      description = document.createElement('div');
      description.className = 'description';
      description.textContent = '将鼠标移到商品列表或图片区域';
      const actions = document.createElement('div');
      actions.className = 'actions';
      const makeButton = (text: string, action: string, handler: () => void) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.dataset.action = action;
        button.addEventListener('click', handler);
        actions.append(button);
        return button;
      };
      enlarge = makeButton('扩大范围', 'enlarge', () => {
        if (!candidate || candidate === document.body || !candidate.parentElement) return;
        childPath.push(candidate);
        candidate = candidate.parentElement;
        scheduleDraw();
      });
      shrink = makeButton('缩小范围', 'shrink', () => {
        if (!childPath.length) return;
        candidate = childPath.pop()!;
        scheduleDraw();
      });
      extract = makeButton('提取', 'extract', () => {
        if (!candidate) return;
        selected = candidate;
        selectedPath = [...childPath];
        void scan().catch((error) =>
          send({ type: 'CONTENT_ERROR', taskId, documentToken, error: String(error) }).catch(
            () => {},
          ),
        );
      });
      makeButton('取消', 'cancel', () => {
        stopSelection();
        void send({ type: 'CONTENT_CANCEL', taskId, documentToken }).catch(() => {});
      });
      enlarge.disabled = shrink.disabled = extract.disabled = true;
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '↑ 扩大 · ↓ 缩小 · Enter 提取 · Esc 取消';
      selectorInfo = document.createElement('code');
      selectorInfo.className = 'selector';
      label.append(description, actions, hint, selectorInfo);
      for (const name of [
        'pointerdown',
        'pointerup',
        'mousedown',
        'mouseup',
        'click',
        'dblclick',
        'auxclick',
        'contextmenu',
        'dragstart',
      ])
        label.addEventListener(name, (event) => event.stopPropagation());
      label.style.cssText = 'left:16px;bottom:16px';
      shadow.append(css, box, label);
      document.documentElement.append(host);
      for (const name of [
        'pointerdown',
        'pointerup',
        'mousedown',
        'mouseup',
        'click',
        'dblclick',
        'auxclick',
        'contextmenu',
        'dragstart',
      ])
        window.addEventListener(name, intercept, { capture: true, passive: false });
      window.addEventListener('mousemove', move, true);
      window.addEventListener('keydown', key, true);
      window.addEventListener('scroll', scheduleDraw, true);
      window.addEventListener('resize', scheduleDraw, true);
    };
    const listener = (raw: unknown, sender: { id?: string }) => {
      if (sender.id !== browser.runtime.id || !raw || typeof raw !== 'object') return;
      const message = raw as Message;
      if (message.type === 'CONTENT_PING') return Promise.resolve({ ok: true, documentToken });
      if (message.type !== 'CONTENT_COMMAND') return;
      try {
        if (message.command === 'CANCEL') {
          stopSelection();
          cancelScan();
          return Promise.resolve({ ok: true });
        }
        taskId = message.taskId;
        if (message.command === 'SELECT') start();
        else {
          if (!selected?.isConnected) throw new Error('原模块已失效，请重新选择。');
          if (
            message.command === 'PARENT' &&
            selected !== document.body &&
            selected.parentElement
          ) {
            selectedPath.push(selected);
            selected = selected.parentElement;
          } else if (message.command === 'CHILD' && selectedPath.length)
            selected = selectedPath.pop()!;
          void scan().catch((error) =>
            send({ type: 'CONTENT_ERROR', taskId, documentToken, error: String(error) }).catch(
              () => {},
            ),
          );
        }
        return Promise.resolve({ ok: true });
      } catch (error) {
        return Promise.resolve({ error: error instanceof Error ? error.message : '选择失败' });
      }
    };
    browser.runtime.onMessage.addListener(listener);
    const checkUrl = () => {
      if (location.href !== previousUrl) {
        previousUrl = location.href;
        stopSelection();
        cancelScan();
        selected = null;
        selectedPath = [];
        void send({ type: 'CONTENT_NAVIGATED', documentToken }).catch(() => {});
      }
    };
    // Navigation API handles SPA history changes without persistent polling.
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    navigation?.addEventListener('navigatesuccess', checkUrl);
    window.addEventListener('popstate', checkUrl);
    window.addEventListener('hashchange', checkUrl);
    const cleanup = () => {
      stopSelection();
      cancelScan();
      browser.runtime.onMessage.removeListener(listener);
      navigation?.removeEventListener('navigatesuccess', checkUrl);
      window.removeEventListener('popstate', checkUrl);
      window.removeEventListener('hashchange', checkUrl);
    };
    global.__moduleImagePicker = cleanup;
    ctx.onInvalidated(cleanup);
    window.addEventListener(
      'pagehide',
      () => {
        stopSelection();
        cancelScan();
      },
      { once: true },
    );
  },
});
