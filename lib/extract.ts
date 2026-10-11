import { cssUrls, formatHint, imageName, normalizeUrl } from './urls';
import type { ImageResource, ImageSource, Result, SourceType } from './types';

export const LIMITS = { nodes: 20_000, resources: 1_000, time: 10_000, sources: 20 };

export function elementSummary(element: Element): string {
  const id = element.id ? `#${element.id.slice(0, 60)}` : '';
  const classes = Array.from(element.classList)
    .slice(0, 2)
    .map((name) => `.${name.slice(0, 40)}`)
    .join('');
  return `${element.localName}${id}${classes}`.slice(0, 180);
}

/** A conservative description of the selected region, separate from its CSS selector. */
export function regionLabel(element: Element): string {
  const label = element.getAttribute('aria-label')?.trim();
  if (label) return label.slice(0, 60);
  if (element === element.ownerDocument.body) return '整个页面';
  if (element.localName === 'img' || element.localName === 'picture') return '图片区域';
  const hint = `${element.id} ${element.className} ${element.getAttribute('role') ?? ''}`;
  if (/product|商品/i.test(hint)) return '商品区域';
  if (element.matches('ul, ol, [role="list"], [role="grid"]') || /grid|gallery|list/i.test(hint))
    return '图片列表区域';
  if (element.localName === 'article' || /card/i.test(hint)) return '内容卡片';
  if (element.querySelector('img, picture')) return '图片区域';
  return '网页区域';
}

export async function extractImages(
  root: Element,
  meta: Pick<Result, 'taskId' | 'documentToken' | 'canParent' | 'canChild'>,
  signal: AbortSignal,
  onBatch: (result: Result) => Promise<void>,
  limits = LIMITS,
): Promise<Result> {
  const started = performance.now();
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const result: Result = {
    ...meta,
    pageUrl: doc.location.href,
    pageTitle: doc.title.slice(0, 400),
    moduleSummary: elementSummary(root),
    moduleLabel: regionLabel(root),
    extractedAt: Date.now(),
    resources: [],
    summary: {
      uniqueCount: 0,
      referenceCount: 0,
      skippedCount: 0,
      visitedNodeCount: 0,
      durationMs: 0,
      partialReasons: [],
      warnings: [],
    },
  };
  const byUrl = new Map<string, ImageResource>();
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let current: Element | null = root;
  let sliceStart = performance.now();
  let lastBatch = performance.now();
  let lastCount = 0;
  const add = (
    raw: string,
    type: SourceType,
    element: Element,
    style: CSSStyleDeclaration,
    rect: DOMRect,
  ) => {
    const url = normalizeUrl(raw, element.baseURI);
    if (!url) {
      if (raw.trim()) result.summary.skippedCount++;
      return;
    }
    const source: ImageSource = {
      type,
      rawValue: raw.slice(0, 16384),
      elementSummary: elementSummary(element),
      alt: (element.getAttribute('alt') ?? '').slice(0, 400),
      renderedWidth: Math.round(rect.width),
      renderedHeight: Math.round(rect.height),
      naturalWidth:
        element instanceof HTMLImageElement && type === 'img' ? element.naturalWidth : 0,
      naturalHeight:
        element instanceof HTMLImageElement && type === 'img' ? element.naturalHeight : 0,
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden',
      isCandidate: type === 'lazy',
    };
    let resource = byUrl.get(url);
    if (!resource) {
      if (byUrl.size >= limits.resources) {
        result.summary.partialReasons.push(`达到 ${limits.resources} 张图片上限`);
        return;
      }
      resource = {
        id: `image-${byUrl.size}`,
        url,
        displayName: imageName(url, source.alt, byUrl.size + 1),
        formatHint: formatHint(url),
        referenceCount: 0,
        sources: [],
      };
      byUrl.set(url, resource);
      result.resources.push(resource);
    }
    resource.referenceCount++;
    if (resource.sources.length < limits.sources) resource.sources.push(source);
    result.summary.referenceCount++;
  };
  while (current) {
    signal.throwIfAborted();
    if (result.summary.visitedNodeCount >= limits.nodes) {
      result.summary.partialReasons.push(`达到 ${limits.nodes} 个元素上限`);
      break;
    }
    if (performance.now() - started > limits.time) {
      result.summary.partialReasons.push('扫描达到时间上限');
      break;
    }
    const element = current;
    result.summary.visitedNodeCount++;
    if (element.localName === 'iframe' || element.shadowRoot) {
      const warning = '首版不读取 iframe / Shadow DOM 内部内容';
      if (!result.summary.warnings.includes(warning)) result.summary.warnings.push(warning);
    }
    const style = win.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (element instanceof HTMLImageElement) {
      const raw = element.currentSrc || element.getAttribute('src') || '';
      if (raw) add(raw, 'img', element, style, rect);
      for (const attr of ['data-src', 'data-original', 'data-lazy-src']) {
        const candidate = element.getAttribute(attr);
        if (
          candidate &&
          (!normalizeUrl(candidate, element.baseURI) ||
            normalizeUrl(candidate, element.baseURI) !== normalizeUrl(raw, element.baseURI))
        )
          add(candidate, 'lazy', element, style, rect);
      }
    } else if (element.localName === 'canvas' || element.localName === 'svg') {
      const warning = 'Canvas 与内联 SVG 不在首版提取范围内';
      if (!result.summary.warnings.includes(warning)) result.summary.warnings.push(warning);
    }
    for (const url of new Set(cssUrls(style.backgroundImage)))
      add(url, 'background', element, style, rect);
    for (const pseudo of ['before', 'after'] as const) {
      const pseudoStyle = win.getComputedStyle(element, `::${pseudo}`);
      if (
        pseudoStyle.content !== 'none' &&
        pseudoStyle.content !== 'normal' &&
        pseudoStyle.display !== 'none'
      ) {
        for (const url of new Set(cssUrls(pseudoStyle.backgroundImage)))
          add(url, pseudo, element, style, rect);
      }
    }
    if (result.summary.partialReasons.length) break;
    current = walker.nextNode() as Element | null;
    result.summary.uniqueCount = byUrl.size;
    result.summary.durationMs = Math.round(performance.now() - started);
    if (
      result.resources.length - lastCount >= 100 ||
      (performance.now() - lastBatch > 300 && result.resources.length > lastCount)
    ) {
      await onBatch(structuredClone(result));
      lastBatch = performance.now();
      lastCount = result.resources.length;
    }
    if (performance.now() - sliceStart >= 8) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  signal.throwIfAborted();
  result.summary.uniqueCount = byUrl.size;
  result.summary.durationMs = Math.round(performance.now() - started);
  return result;
}
