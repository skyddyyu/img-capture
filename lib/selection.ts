import { cssUrls, normalizeUrl } from './urls';

export interface RegionEstimate {
  imageElements: number;
  backgroundElements: number;
  pseudoElements: number;
  visited: number;
  partial: boolean;
  iframe: boolean;
  shadow: boolean;
}

export const ESTIMATE_LIMITS = { nodes: 1_000, time: 120, slice: 4 };

function imageSources(element: Element) {
  const valid = (raw: string) => !!normalizeUrl(raw, element.baseURI);
  const cssImage = (raw: string) => raw !== 'none' && cssUrls(raw).some(valid);
  const win = element.ownerDocument.defaultView!;
  const image =
    element.localName === 'img' &&
    [
      (element as HTMLImageElement).currentSrc || element.getAttribute('src') || '',
      ...['data-src', 'data-original', 'data-lazy-src'].map(
        (attribute) => element.getAttribute(attribute) || '',
      ),
    ].some(valid);
  const background = cssImage(win.getComputedStyle(element).backgroundImage);
  const pseudo = ['::before', '::after'].some((name) => {
    const style = win.getComputedStyle(element, name);
    return (
      style.content !== 'none' &&
      style.content !== 'normal' &&
      style.display !== 'none' &&
      cssImage(style.backgroundImage)
    );
  });
  return { image, background, pseudo };
}

/** Prefer a nearby image container without climbing to page-wide wrappers. */
export function recommendRegion(target: Element): Element {
  const started = performance.now();
  if (target.matches('img, picture, iframe, body, main, header, footer, nav') || target.shadowRoot)
    return target;
  const own = imageSources(target);
  if (own.image || own.background || own.pseudo) return target;
  const module = (element: Element) =>
    element.matches(
      'article, li, figure, ul, ol, [role="listitem"], [role="list"], [role="grid"]',
    ) ||
    (element.matches('div, section, a') &&
      /(?:^|[\s_-])(card|tile|product|gallery|grid|list|item)(?:$|[\s_-])/i.test(
        `${element.id} ${element.getAttribute('class') || ''}`,
      ));
  // A direct hit on a module already expresses an explicit scope.
  if (
    target.matches(
      'section, article, li, figure, ul, ol, [role="listitem"], [role="list"], [role="grid"]',
    ) ||
    (module(target) && target.querySelector('img, picture'))
  )
    return target;
  const win = target.ownerDocument.defaultView!;
  const viewportArea = win.innerWidth * win.innerHeight;
  let parent = target.parentElement;
  let remaining = 80;
  for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
    if (parent.matches('body, main, header, footer, nav') || parent.shadowRoot) break;
    const semantic = module(parent);
    if (!semantic && !(depth < 2 && parent.matches('div, a'))) continue;
    const rect = parent.getBoundingClientRect();
    if (
      !rect.width ||
      !rect.height ||
      rect.width * rect.height > viewportArea * (semantic ? 2 : 0.75)
    )
      continue;
    const walker = target.ownerDocument.createTreeWalker(parent, NodeFilter.SHOW_ELEMENT);
    let element: Element | null = parent;
    while (element && remaining-- > 0 && performance.now() - started < 8) {
      const sources = imageSources(element);
      if (sources.image || sources.background || sources.pseudo) return parent;
      element = walker.nextNode() as Element | null;
    }
    if (remaining <= 0 || performance.now() - started >= 8) break;
  }
  return target;
}

/** Counts source-bearing elements, not distinct URLs; does not load image resources. */
export async function estimateRegion(
  root: Element,
  signal: AbortSignal,
  limits = ESTIMATE_LIMITS,
): Promise<RegionEstimate> {
  const estimate: RegionEstimate = {
    imageElements: 0,
    backgroundElements: 0,
    pseudoElements: 0,
    visited: 0,
    partial: false,
    iframe: false,
    shadow: false,
  };
  const started = performance.now();
  let sliceStart = started;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) =>
      (node as Element).hasAttribute('data-module-image-picker')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let element: Element | null = root;
  while (element) {
    signal.throwIfAborted();
    if (estimate.visited >= limits.nodes || performance.now() - started >= limits.time) {
      estimate.partial = true;
      break;
    }
    estimate.visited++;
    if (element.localName === 'iframe') estimate.iframe = true;
    if (element.shadowRoot) estimate.shadow = true;
    const sources = imageSources(element);
    if (sources.image || sources.background || sources.pseudo) estimate.imageElements++;
    if (sources.background) estimate.backgroundElements++;
    if (sources.pseudo) estimate.pseudoElements++;
    element = walker.nextNode() as Element | null;
    if (element && performance.now() - sliceStart >= limits.slice) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      sliceStart = performance.now();
    }
  }
  signal.throwIfAborted();
  return estimate;
}

export function estimateLabel(estimate: RegionEstimate): string {
  if (!estimate.imageElements)
    return estimate.partial ? '尚未发现图片，预估未完成' : '未发现可提取的图片元素';
  return `${estimate.partial ? '至少 ' : ''}${estimate.imageElements} 个图片元素（预估）`;
}

export function boundaryHint(root: Element, estimate?: RegionEstimate): string {
  const iframe = root.localName === 'iframe' || estimate?.iframe;
  const shadow = !!root.shadowRoot || estimate?.shadow;
  if (!iframe && !shadow) return '';
  return `含 ${[iframe && 'iframe', shadow && 'Shadow DOM'].filter(Boolean).join(' / ')}，内部图片暂不支持提取`;
}
