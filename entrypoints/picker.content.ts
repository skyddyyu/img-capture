import { browser } from 'wxt/browser';
import { elementSummary, extractImages, regionLabel } from '../lib/extract';
import { newId } from '../lib/id';
import {
  boundaryHint,
  estimateLabel,
  estimateRegion,
  recommendRegion,
  type RegionEstimate,
} from '../lib/selection';
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
    let scopeAdjusted = false;
    let childPath: Element[] = [];
    let selectedPath: Element[] = [];
    let controller: AbortController | undefined;
    let selecting = false;
    let locked = false;
    let hierarchy: Element[] = [];
    let toolbarPosition: { left: number; top: number } | undefined;
    let host: HTMLDivElement | undefined;
    let box: HTMLDivElement | undefined;
    let label: HTMLDivElement | undefined;
    let description: HTMLDivElement | undefined;
    let selectorInfo: HTMLElement | undefined;
    let breadcrumbs: HTMLElement | undefined;
    let hint: HTMLDivElement | undefined;
    let estimateInfo: HTMLDivElement | undefined;
    let boundaryInfo: HTMLDivElement | undefined;
    let estimateRoot: Element | null = null;
    let estimate: RegionEstimate | undefined;
    let estimateController: AbortController | undefined;
    let estimateTimer: ReturnType<typeof setTimeout> | undefined;
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
    const cancelEstimate = () => {
      clearTimeout(estimateTimer);
      estimateTimer = undefined;
      estimateController?.abort();
      estimateController = undefined;
      estimateRoot = null;
      estimate = undefined;
    };
    const startEstimate = () => {
      cancelEstimate();
      if (!candidate?.isConnected) return;
      const root = candidate;
      estimateRoot = root;
      const currentController = new AbortController();
      estimateController = currentController;
      estimateTimer = setTimeout(
        () => {
          estimateTimer = undefined;
          void estimateRegion(root, currentController.signal)
            .then((result) => {
              if (
                !selecting ||
                currentController.signal.aborted ||
                candidate !== root ||
                !root.isConnected
              )
                return;
              estimate = result;
              scheduleDraw();
            })
            .catch(() => {});
        },
        locked ? 0 : 180,
      );
    };
    const draw = () => {
      frame = 0;
      if (!box || !label) return;
      const connected = !!candidate?.isConnected;
      if (estimateRoot !== candidate) startEstimate();
      box.hidden = !connected;
      if (enlarge)
        enlarge.disabled = !connected || candidate === document.body || !candidate?.parentElement;
      if (shrink) shrink.disabled = !connected || !childPath.length;
      if (extract) extract.disabled = !connected || !locked;
      if (!connected) {
        if (description)
          description.textContent = locked
            ? '原区域已失效，请重新选取'
            : '将鼠标移到商品列表或图片区域';
      }
      const rect = connected ? candidate!.getBoundingClientRect() : undefined;
      if (rect) {
        Object.assign(box.style, {
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
        if (description) description.textContent = regionLabel(candidate!);
        if (selectorInfo)
          selectorInfo.textContent = `${elementSummary(candidate!)} · ${Math.round(rect.width)} × ${Math.round(rect.height)}`;
      }
      if (estimateInfo) {
        estimateInfo.textContent = connected
          ? estimate
            ? estimateLabel(estimate)
            : '正在预估图片元素…'
          : '';
        estimateInfo.title =
          '按包含图片来源的元素计数，含隐藏图片、背景和伪元素；未按图片地址去重，最终以提取结果为准。';
      }
      if (boundaryInfo) {
        boundaryInfo.textContent = connected ? boundaryHint(candidate!, estimate) : '';
        boundaryInfo.hidden = !boundaryInfo.textContent;
      }
      const toolbarHeight = label.offsetHeight;
      const toolbarWidth = label.offsetWidth;
      const maxLeft = Math.max(8, innerWidth - toolbarWidth - 8);
      const maxTop = Math.max(8, innerHeight - toolbarHeight - 8);
      if (locked && !toolbarPosition) {
        const above = rect ? rect.top - toolbarHeight - 8 : -1;
        const below = rect ? rect.bottom + 8 : innerHeight;
        // Choose an anchor once. Scope changes and scrolling must not move the controls.
        toolbarPosition =
          rect && above >= 8 && above <= maxTop
            ? { left: rect.left, top: above }
            : rect && below >= 8 && below <= maxTop
              ? { left: rect.left, top: below }
              : { left: maxLeft, top: maxTop };
      }
      const previewTop = rect
        ? rect.top >= toolbarHeight + 16
          ? rect.top - toolbarHeight - 8
          : rect.bottom + 8
        : maxTop;
      Object.assign(label.style, {
        left: `${Math.min(maxLeft, Math.max(8, toolbarPosition?.left ?? rect?.left ?? 16))}px`,
        top: `${Math.min(maxTop, Math.max(8, toolbarPosition?.top ?? previewTop))}px`,
        bottom: 'auto',
      });
    };
    const scheduleDraw = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const renderHierarchy = () => {
      if (!breadcrumbs) return;
      const focused = (breadcrumbs.getRootNode() as ShadowRoot).activeElement;
      const focusedIndex = Array.from(breadcrumbs.querySelectorAll('button')).findIndex(
        (button) => button === focused,
      );
      breadcrumbs.replaceChildren();
      hierarchy.forEach((element, index) => {
        if (index) {
          const separator = document.createElement('span');
          separator.textContent = '›';
          separator.setAttribute('aria-hidden', 'true');
          breadcrumbs!.append(separator);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent =
          element.localName === 'a'
            ? '链接容器'
            : regionLabel(element) === '网页区域'
              ? `${element.localName} 容器`
              : regionLabel(element);
        button.title = elementSummary(element);
        button.disabled = !element.isConnected;
        if (element === candidate) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => {
          if (!element.isConnected) return;
          candidate = element;
          scopeAdjusted = true;
          childPath = hierarchy.slice(index + 1).reverse();
          renderHierarchy();
          scheduleDraw();
        });
        breadcrumbs!.append(button);
      });
      if (focusedIndex >= 0)
        breadcrumbs.querySelectorAll('button')[focusedIndex]?.focus({ preventScroll: true });
    };
    const lockCandidate = () => {
      if (!candidate?.isConnected || locked || !label) return;
      locked = true;
      cancelEstimate();
      label.dataset.locked = 'true';
      host?.style.setProperty('cursor', 'default', 'important');
      if (hint) hint.textContent = '已锁定 · ↑ 扩大 · ↓ 返回子级 · Enter 提取 · Esc 取消';
      renderHierarchy();
      if (frame) cancelAnimationFrame(frame);
      draw();
      extract?.focus({ preventScroll: true });
    };
    const confirmSelection = () => {
      if (!locked) return;
      if (!candidate?.isConnected) {
        scheduleDraw();
        return;
      }
      selected = candidate;
      selectedPath = [...childPath];
      void scan().catch((error) =>
        send({ type: 'CONTENT_ERROR', taskId, documentToken, error: String(error) }).catch(
          () => {},
        ),
      );
    };
    const move = (event: MouseEvent) => {
      if (locked) return;
      if (label && event.composedPath().includes(label)) return;
      if (scopeAdjusted && childPath.length && candidate) {
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
        candidate = recommendRegion(target);
        scopeAdjusted = false;
        hierarchy = [];
        for (let element: Element | null = target; element; element = element.parentElement) {
          hierarchy.unshift(element);
          if (element === document.body) break;
        }
        childPath = hierarchy.slice(hierarchy.indexOf(candidate) + 1).reverse();
      }
      scheduleDraw();
    };
    const stopSelection = () => {
      selecting = false;
      cancelEstimate();
      locked = false;
      toolbarPosition = undefined;
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
      breadcrumbs = undefined;
      hint = undefined;
      estimateInfo = undefined;
      boundaryInfo = undefined;
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
      if (event.type === 'click' && !locked) {
        move(event as MouseEvent);
        lockCandidate();
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
        scopeAdjusted = true;
        renderHierarchy();
        scheduleDraw();
      } else if (event.key === 'ArrowDown' && childPath.length) {
        candidate = childPath.pop()!;
        scopeAdjusted = true;
        renderHierarchy();
        scheduleDraw();
      } else if (event.key === 'Enter' && candidate) {
        if (locked) confirmSelection();
        else lockCandidate();
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
      hierarchy = [];
      scopeAdjusted = false;
      host = document.createElement('div');
      host.setAttribute('data-module-image-picker', '');
      // The glass layer also catches clicks over iframes, whose events never bubble to this document.
      host.style.cssText =
        'all:initial!important;position:fixed!important;inset:0!important;pointer-events:auto!important;cursor:crosshair!important;z-index:2147483647!important;';
      const shadow = host.attachShadow({ mode: 'open' });
      const css = document.createElement('style');
      css.textContent =
        ':host{pointer-events:none}*{box-sizing:border-box}[hidden]{display:none!important}.box{position:fixed;border:2px solid #18785c;background:#18785c15;border-radius:4px;pointer-events:none}.label{position:fixed;padding:10px 12px;width:340px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;font:13px/1.6 system-ui,sans-serif;color:white;background:#153c32;border-radius:8px;box-shadow:0 4px 18px #0003;pointer-events:auto;cursor:default}.label[data-locked="false"]{width:max-content;pointer-events:none}.label[data-locked="false"] .details{display:none}.description{font-weight:600;overflow-wrap:anywhere}.selector{display:block;font:12px/1.5 monospace;color:#d0e3db;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}button{font:12px/1.5 system-ui,sans-serif;background:#fff;color:#153c32;border:0;border-radius:5px;padding:6px 8px;cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:3px solid #a8e4cb;outline-offset:2px}button[data-action="extract"]{background:#ace5c9}.hint,summary{font-size:12px;color:#d0e3db}.breadcrumbs{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-top:8px;max-height:112px;overflow:auto}.breadcrumbs button{padding:3px 6px;background:#ffffff18;color:#d0e3db;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.breadcrumbs button[aria-current]{background:#ace5c9;color:#153c32}summary{cursor:pointer;margin-top:8px}';
      css.textContent +=
        '.estimate{font-size:13px;line-height:20px;min-height:20px;color:#ace5c9;overflow-wrap:anywhere}.label[data-locked="true"] .estimate{min-height:40px}.estimate-note{font-size:12px;color:#d0e3db;margin-top:8px}.boundary{font-size:12px;color:#ffe2a8;margin:4px 0;max-width:316px;overflow-wrap:anywhere}';
      box = document.createElement('div');
      box.className = 'box';
      box.hidden = true;
      label = document.createElement('div');
      label.className = 'label';
      label.dataset.locked = 'false';
      label.setAttribute('role', 'region');
      label.setAttribute('aria-label', '范围选取工具条');
      description = document.createElement('div');
      description.className = 'description';
      description.textContent = '将鼠标移到商品列表或图片区域';
      estimateInfo = document.createElement('div');
      estimateInfo.className = 'estimate';
      boundaryInfo = document.createElement('div');
      boundaryInfo.className = 'boundary';
      boundaryInfo.hidden = true;
      const actions = document.createElement('div');
      actions.className = 'actions';
      const details = document.createElement('div');
      details.className = 'details';
      breadcrumbs = document.createElement('nav');
      breadcrumbs.className = 'breadcrumbs';
      breadcrumbs.setAttribute('aria-label', '选区层级');
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
        scopeAdjusted = true;
        renderHierarchy();
        scheduleDraw();
      });
      shrink = makeButton('缩小范围', 'shrink', () => {
        if (!childPath.length) return;
        candidate = childPath.pop()!;
        scopeAdjusted = true;
        renderHierarchy();
        scheduleDraw();
      });
      extract = makeButton('提取', 'extract', confirmSelection);
      makeButton('重新选取', 'reselect', () => {
        locked = false;
        candidate = hovered = null;
        childPath = [];
        hierarchy = [];
        scopeAdjusted = false;
        toolbarPosition = undefined;
        label!.dataset.locked = 'false';
        hint!.textContent = '单击或 Enter 锁定 · ↑ / ↓ 调整 · Esc 取消';
        host?.style.setProperty('cursor', 'crosshair', 'important');
        scheduleDraw();
      });
      makeButton('取消', 'cancel', () => {
        stopSelection();
        void send({ type: 'CONTENT_CANCEL', taskId, documentToken }).catch(() => {});
      });
      enlarge.disabled = shrink.disabled = extract.disabled = true;
      hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '单击或 Enter 锁定 · ↑ / ↓ 调整 · Esc 取消';
      selectorInfo = document.createElement('code');
      selectorInfo.className = 'selector';
      const technical = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '元素信息';
      technical.append(summary, selectorInfo);
      technical.addEventListener('toggle', scheduleDraw);
      details.append(breadcrumbs, actions, technical);
      const estimateNote = document.createElement('div');
      estimateNote.className = 'estimate-note';
      estimateNote.textContent = '含背景 / 伪元素，未按图片地址去重';
      details.append(estimateNote);
      label.append(description, estimateInfo, boundaryInfo, hint, details);
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
