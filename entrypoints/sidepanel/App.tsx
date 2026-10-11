import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Command, ImageResource, Result, TabState } from '../../lib/types';
import { SOURCE_LABELS } from '../../lib/types';
import { retryPreview, subscribePreview, type PreviewState } from '../../lib/preview';
import {
  THUMBNAIL_LAYOUT,
  usePreferences,
  type ThumbnailSize,
  type ViewMode,
} from './usePreferences';

type IconName =
  | 'select'
  | 'image'
  | 'copy'
  | 'arrow'
  | 'back'
  | 'refresh'
  | 'external'
  | 'close'
  | 'check'
  | 'up'
  | 'down'
  | 'shield'
  | 'info'
  | 'settings'
  | 'minus'
  | 'plus';
const paths: Record<IconName, React.ReactNode> = {
  select: (
    <>
      <path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" />
      <path d="m9 9 4 11 2-5 5-2Z" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="m3 17 6-6 4 4 3-3 5 5" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
    </>
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  back: <path d="M20 12H4m6-6-6 6 6 6" />,
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 6a8 8 0 0 1 14 6M18 18A8 8 0 0 1 4 12" />
    </>
  ),
  external: (
    <>
      <path d="M14 3h7v7m0-7L10 14" />
      <path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  up: <path d="m6 15 6-6 6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v1" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" fill="currentColor" />
      <circle cx="15" cy="17" r="3" fill="currentColor" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  plus: <path d="M5 12h14M12 5v14" />,
};
function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
function usePreview(url: string, enabled = true) {
  const [state, setState] = useState<PreviewState>({ status: 'waiting', width: 0, height: 0 });
  useEffect(() => {
    setState({ status: 'waiting', width: 0, height: 0 });
    if (enabled) return subscribePreview(url, setState);
  }, [url, enabled]);
  return state;
}
const dimensions = (width = 0, height = 0) =>
  width > 0 && height > 0 ? `${width} × ${height}` : '尺寸未知';
function domain(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function ImageCard({
  image,
  onDetail,
  onCopy,
}: {
  image: ImageResource;
  onDetail: () => void;
  onCopy: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (items) => {
        if (items.some((item) => item.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '100px' },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const preview = usePreview(image.url, visible);
  const source = image.sources[0];
  const size = source?.naturalWidth
    ? dimensions(source.naturalWidth, source.naturalHeight)
    : dimensions(preview.width, preview.height);
  return (
    <article ref={ref} className="image-card" data-image-url={image.url}>
      <div className="thumbnail-wrap">
        <button
          className="thumbnail checker"
          onClick={onDetail}
          aria-label={`查看 ${image.displayName} 详情`}
        >
          {preview.status === 'ready' ? (
            <img
              src={image.url}
              referrerPolicy="no-referrer"
              alt={source?.alt || image.displayName}
              draggable={false}
            />
          ) : (
            <span
              className={`preview-placeholder ${preview.status === 'loading' ? 'loading' : ''}`}
            >
              <Icon name="image" size={26} />
              <span>
                {preview.status === 'failed'
                  ? '暂时无法预览'
                  : preview.status === 'loading'
                    ? '加载预览中'
                    : '等待预览'}
              </span>
            </span>
          )}
          <span className="format-badge">
            {image.formatHint === '未知' ? 'IMG' : image.formatHint}
          </span>
          {image.referenceCount > 1 && (
            <span className="count-badge">{image.referenceCount} 处引用</span>
          )}
        </button>
        {preview.status === 'failed' && (
          <div className="preview-recovery">
            <button onClick={() => retryPreview(image.url)}>重试</button>
            <button onClick={() => void browser.tabs.create({ url: image.url })}>打开链接</button>
          </div>
        )}
      </div>
      <div className="card-body">
        <button className="card-name" onClick={onDetail} title={image.displayName}>
          {image.displayName}
        </button>
        <div className="card-meta">
          <strong>{size}</strong>
          <span>{source ? SOURCE_LABELS[source.type] : '图片'}</span>
        </div>
        <input
          className="card-url"
          aria-label={`${image.displayName} 完整地址`}
          title={image.url}
          readOnly
          value={image.url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className="card-actions">
          <button onClick={onCopy}>
            <Icon name="copy" size={14} />
            复制链接
          </button>
          <button onClick={onDetail}>
            详情
            <Icon name="arrow" size={14} />
          </button>
        </div>
      </div>
    </article>
  );
}

function Gallery({
  result,
  scroller,
  onDetail,
  onCopy,
  scrollTop,
  view,
  thumbnailSize,
  focusUrl,
}: {
  result: Result;
  scroller: React.RefObject<HTMLElement | null>;
  onDetail: (index: number) => void;
  onCopy: (text: string) => void;
  scrollTop: number;
  view: ViewMode;
  thumbnailSize: ThumbnailSize;
  focusUrl?: string;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const focusedUrl = useRef<string | undefined>(undefined);
  const [layout, setLayout] = useState({ columns: 1, offset: 0, height: 800 });
  useLayoutEffect(() => {
    const measure = () => {
      if (!grid.current || !scroller.current) return;
      setLayout({
        columns:
          view === 'list'
            ? 1
            : thumbnailSize === 'large'
              ? grid.current.clientWidth >= 520
                ? 2
                : 1
              : thumbnailSize === 'small' && grid.current.clientWidth >= 420
                ? 3
                : grid.current.clientWidth >= 288
                  ? 2
                  : 1,
        offset:
          grid.current.getBoundingClientRect().top -
          scroller.current.getBoundingClientRect().top +
          scroller.current.scrollTop,
        height: scroller.current.clientHeight,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (grid.current) observer.observe(grid.current);
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [scroller, view, thumbnailSize]);
  const virtual = result.resources.length > 100;
  const metrics = THUMBNAIL_LAYOUT[thumbnailSize];
  const rowHeight = (view === 'list' ? metrics.listCard : metrics.gridCard) + 10;
  const rows = Math.ceil(result.resources.length / layout.columns);
  const startRow = virtual
    ? Math.max(0, Math.min(rows - 1, Math.floor((scrollTop - layout.offset) / rowHeight) - 2))
    : 0;
  const endRow = virtual
    ? Math.min(rows, startRow + Math.ceil(layout.height / rowHeight) + 5)
    : rows;
  const from = startRow * layout.columns;
  const images = result.resources.slice(from, endRow * layout.columns);
  useEffect(() => {
    if (!focusUrl || focusedUrl.current === focusUrl || !grid.current || !scroller.current) return;
    const card = Array.from(grid.current.querySelectorAll<HTMLElement>('[data-image-url]')).find(
      (node) => node.dataset.imageUrl === focusUrl,
    );
    if (card) {
      focusedUrl.current = focusUrl;
      card.querySelector<HTMLButtonElement>('.thumbnail')?.focus({ preventScroll: true });
      const bounds = card.getBoundingClientRect();
      const viewport = scroller.current.getBoundingClientRect();
      if (bounds.top < viewport.top || bounds.bottom > viewport.bottom)
        card.scrollIntoView({ block: 'nearest' });
    } else {
      const index = result.resources.findIndex((item) => item.url === focusUrl);
      if (index >= 0)
        scroller.current.scrollTop = layout.offset + Math.floor(index / layout.columns) * rowHeight;
    }
  }, [focusUrl, layout.columns, layout.offset, scrollTop, result, rowHeight, scroller]);
  return (
    <div
      ref={grid}
      className={`gallery-shell ${view}-view`}
      data-thumbnail-size={thumbnailSize}
      style={
        {
          '--thumbnail-height': `${metrics.thumbnail}px`,
          '--grid-card-height': `${metrics.gridCard}px`,
          '--list-card-height': `${metrics.listCard}px`,
          '--list-thumbnail-width': `${metrics.listWidth}px`,
        } as React.CSSProperties
      }
    >
      {virtual && <div style={{ height: startRow * rowHeight }} />}
      <div
        className="gallery"
        style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` }}
      >
        {images.map((image, index) => (
          <ImageCard
            key={image.url}
            image={image}
            onDetail={() => onDetail(from + index)}
            onCopy={() => onCopy(image.url)}
          />
        ))}
      </div>
      {virtual && <div style={{ height: Math.max(0, rows - endRow) * rowHeight }} />}
    </div>
  );
}

function Detail({
  result,
  index,
  setIndex,
  onBack,
  onCopy,
}: {
  result: Result;
  index: number;
  setIndex: (index: number) => void;
  onBack: () => void;
  onCopy: (text: string) => void;
}) {
  const image = result.resources[index]!;
  const preview = usePreview(image.url);
  const [zoom, setZoom] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const source = image.sources[0];
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setZoom(null);
    scroller.current?.scrollTo(0, 0);
    scroller.current?.closest('.app-main')?.scrollTo(0, 0);
  }, [image.url]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        document.querySelector('.modal-backdrop') ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onBack();
        return;
      }
      if (
        (event.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]')
      )
        return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        setIndex(
          Math.max(
            0,
            Math.min(result.resources.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)),
          ),
        );
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [index, result.resources.length, onBack, setIndex]);
  return (
    <section className="detail">
      <div className="detail-nav">
        <button autoFocus className="text-button" onClick={onBack}>
          <Icon name="back" />
          返回列表
        </button>
        <span>
          {index + 1} / {result.resources.length}
        </span>
        <div className="nav-arrows">
          <button
            className="icon-button"
            disabled={index === 0}
            aria-label="上一张"
            onClick={() => setIndex(index - 1)}
          >
            <Icon name="back" />
          </button>
          <button
            className="icon-button"
            disabled={index === result.resources.length - 1}
            aria-label="下一张"
            onClick={() => setIndex(index + 1)}
          >
            <Icon name="arrow" />
          </button>
        </div>
      </div>
      <div className="detail-summary">
        <h2 title={image.displayName}>{image.displayName}</h2>
        <div className="detail-facts" aria-live="polite">
          <strong>
            {dimensions(
              preview.width || source?.naturalWidth,
              preview.height || source?.naturalHeight,
            )}
          </strong>
          <span>
            {image.formatHint} ·{' '}
            {source?.isCandidate
              ? '懒加载候选版本'
              : source?.type === 'img'
                ? '网页当前使用版本'
                : '背景图片版本'}
          </span>
        </div>
        <p className="version-note">按网页提供的地址提取，不保证是最大尺寸原图。</p>
        <div className="detail-primary">
          <button className="primary" onClick={() => onCopy(image.url)}>
            <Icon name="copy" />
            复制链接
          </button>
          <button
            className="secondary"
            onClick={() => void browser.tabs.create({ url: image.url })}
          >
            <Icon name="external" />
            打开图片地址
          </button>
        </div>
      </div>
      <div
        ref={scroller}
        className={`detail-preview checker ${zoom === null ? 'fit' : ''} ${expanded ? 'expanded' : ''}`}
      >
        {preview.status === 'ready' ? (
          <img
            src={image.url}
            referrerPolicy="no-referrer"
            alt={source?.alt || image.displayName}
            style={
              zoom === null
                ? {}
                : {
                    width: `${(preview.width * zoom) / 100}px`,
                    maxWidth: 'none',
                    maxHeight: 'none',
                  }
            }
          />
        ) : (
          <div className="preview-placeholder">
            <Icon name="image" size={42} />
            <p>{preview.status === 'failed' ? '图片暂时无法预览' : '正在加载图片'}</p>
            {preview.status === 'failed' && (
              <>
                <p className="muted">你仍可以复制链接或打开图片地址。</p>
                <button className="secondary" onClick={() => retryPreview(image.url)}>
                  <Icon name="refresh" /> 重试预览
                </button>
                <button
                  className="text-button"
                  onClick={() => void browser.tabs.create({ url: image.url })}
                >
                  打开链接
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="zoom-bar">
        <button
          className="icon-button"
          disabled={preview.status !== 'ready' || zoom === 25}
          aria-label="缩小"
          onClick={() => setZoom(Math.max(25, (zoom ?? 100) - 25))}
        >
          <Icon name="minus" />
        </button>
        <button
          className="zoom-value"
          onClick={() => setZoom(100)}
          disabled={preview.status !== 'ready'}
        >
          {zoom === null ? '适应窗口' : `${zoom}%`}
        </button>
        <button
          className="icon-button"
          disabled={preview.status !== 'ready' || zoom === 400}
          aria-label="放大"
          onClick={() => setZoom(Math.min(400, (zoom ?? 100) + 25))}
        >
          <Icon name="plus" />
        </button>
        <span />
        <button className="text-button" onClick={() => setZoom(null)}>
          恢复适应
        </button>
        <button
          className="text-button"
          aria-pressed={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起预览' : '扩大预览'}
        </button>
      </div>
      <div className="detail-content">
        <label className="field-label" htmlFor="image-url">
          图片完整地址
        </label>
        <textarea
          id="image-url"
          className="url-field"
          readOnly
          value={image.url}
          rows={3}
          onFocus={(event) => event.currentTarget.select()}
        />
        <p className="muted detail-shortcuts">← / → 切换图片 · Esc 返回列表</p>
        <details className="technical-details">
          <summary>来源节点与技术信息</summary>
          <dl className="metadata">
            <div>
              <dt>固有尺寸 · 来源图片</dt>
              <dd>{dimensions(source?.naturalWidth, source?.naturalHeight)}</dd>
            </div>
            <div>
              <dt>固有尺寸 · 预览图片</dt>
              <dd>{dimensions(preview.width, preview.height)}</dd>
            </div>
            <div>
              <dt>
                {source?.type === 'img' || source?.type === 'lazy'
                  ? '页面显示尺寸'
                  : '承载元素尺寸'}
              </dt>
              <dd>{dimensions(source?.renderedWidth, source?.renderedHeight)}</dd>
            </div>
            <div>
              <dt>格式（按地址推测）</dt>
              <dd>{image.formatHint}</dd>
            </div>
            <div>
              <dt>图片说明 alt</dt>
              <dd>{source?.alt || '未提供'}</dd>
            </div>
            <div>
              <dt>来源类型</dt>
              <dd>
                {[...new Set(image.sources.map((item) => SOURCE_LABELS[item.type]))].join('、')}
              </dd>
            </div>
            <div>
              <dt>引用次数</dt>
              <dd>{image.referenceCount} 处</dd>
            </div>
            <div>
              <dt>来源状态</dt>
              <dd>
                {result.canParent || result.moduleSummary ? '提取时快照' : '未知'}
                {source?.isCandidate ? ' · 懒加载候选' : ''}
              </dd>
            </div>
          </dl>
          <h3 className="field-label">页面中的引用位置</h3>
          <div className="source-list">
            {image.sources.map((item, i) => (
              <div key={i}>
                <code>{item.elementSummary}</code>
                <span>
                  {SOURCE_LABELS[item.type]} · {item.visible ? '页面中显示' : '隐藏或无显示区域'}
                </span>
              </div>
            ))}
          </div>
          {image.referenceCount > image.sources.length && (
            <p className="muted">
              仅展示前 {image.sources.length} 处，全部引用共 {image.referenceCount} 处。
            </p>
          )}
          <div className="origin-note">
            <Icon name="info" />
            <div>
              <strong>{result.pageTitle || domain(result.pageUrl)}</strong>
              <p>{result.pageUrl}</p>
              <time>{new Date(result.extractedAt).toLocaleString('zh-CN')}</time>
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}

export default function App() {
  const [tabId, setTabId] = useState<number>();
  const [state, setState] = useState<TabState>();
  const [detail, setDetail] = useState<number | null>(null);
  const [toast, setToast] = useState('');
  const [manualCopy, setManualCopy] = useState<string>();
  const [privacy, setPrivacy] = useState(false);
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const {
    preferences,
    ready: preferencesReady,
    error: preferencesError,
    update: updatePreferences,
  } = usePreferences();
  const { view, thumbnailSize, onboardingCompleted } = preferences;
  const [focusUrl, setFocusUrl] = useState<string>();
  const scroller = useRef<HTMLElement>(null);
  const listScroll = useRef(0);
  const currentTab = useRef<number | undefined>(undefined);
  const readSequence = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dialogOpener = useRef<HTMLElement | null>(null);
  const openDialog = (kind: 'settings' | 'help') => {
    dialogOpener.current = document.activeElement as HTMLElement | null;
    if (kind === 'settings') setSettings(true);
    else setPrivacy(true);
  };
  const load = useCallback(async (id: number) => {
    const request = ++readSequence.current;
    try {
      const next = await browser.runtime.sendMessage({ type: 'GET_STATE', tabId: id });
      if (currentTab.current === id && request === readSequence.current) setState(next);
    } catch {
      if (currentTab.current === id)
        setState({
          tabId: id,
          status: 'error',
          taskId: '',
          lastViewed: Date.now(),
          error: '插件连接已中断，请关闭并重新打开侧边栏。',
        });
    }
  }, []);
  useEffect(() => {
    const activate = async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) return;
      if (currentTab.current !== tab.id) {
        currentTab.current = tab.id;
        setTabId(tab.id);
        setDetail(null);
        setState(undefined);
        listScroll.current = 0;
      }
      await load(tab.id);
    };
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (
        area === 'session' &&
        currentTab.current !== undefined &&
        `tab:${currentTab.current}` in changes
      )
        void load(currentTab.current);
    };
    const updated = (id: number) => {
      if (id === currentTab.current) void load(id);
    };
    void activate();
    browser.tabs.onActivated.addListener(activate);
    browser.tabs.onUpdated.addListener(updated);
    browser.storage.onChanged.addListener(changed);
    return () => {
      browser.tabs.onActivated.removeListener(activate);
      browser.tabs.onUpdated.removeListener(updated);
      browser.storage.onChanged.removeListener(changed);
      clearTimeout(toastTimer.current);
    };
  }, [load]);
  const result = state?.status === 'scanning' ? (state.progress ?? state.result) : state?.result;
  useEffect(() => {
    if (!privacy && !settings && manualCopy === undefined) return;
    const original = dialogOpener.current;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPrivacy(false);
        setSettings(false);
        setManualCopy(undefined);
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.modal button:not(:disabled), .modal textarea, .modal select:not(:disabled)',
        ),
      );
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      original?.focus();
    };
  }, [privacy, settings, manualCopy]);
  useEffect(() => {
    if (
      preferencesReady &&
      !onboardingCompleted &&
      state?.result &&
      ['ready', 'empty', 'partial'].includes(state.status)
    )
      updatePreferences({ onboardingCompleted: true });
  }, [preferencesReady, onboardingCompleted, state?.result, state?.status]);
  useEffect(() => {
    setDetail(null);
    setFocusUrl(undefined);
    listScroll.current = 0;
    scroller.current?.scrollTo(0, 0);
  }, [result?.taskId]);
  useLayoutEffect(() => {
    if (detail === null && scroller.current) scroller.current.scrollTop = listScroll.current;
  }, [detail]);
  const notify = (text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2600);
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify('链接已复制');
    } catch {
      dialogOpener.current = document.activeElement as HTMLElement | null;
      setManualCopy(text);
    }
  };
  const command = async (action: Command) => {
    if (tabId === undefined || busy) return;
    setBusy(true);
    setDetail(null);
    try {
      await browser.runtime.sendMessage({
        type: 'COMMAND',
        tabId,
        command: action,
        requestId: crypto.randomUUID(),
      });
      await load(tabId);
    } catch {
      notify('插件连接中断，请重新点击工具栏图标。');
    } finally {
      setBusy(false);
    }
  };
  const working = state?.status === 'selecting' || state?.status === 'scanning';
  const selectedImage = detail !== null && result?.resources[detail];
  const backToGallery = () => {
    if (selectedImage) setFocusUrl(selectedImage.url);
    setDetail(null);
  };
  return (
    <div className={`app ${state?.result || working || onboardingCompleted ? 'has-results' : ''}`}>
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <Icon name="select" size={21} />
          </div>
          <div>
            <strong>
              模块取图<span className="beta">BETA</span>
            </strong>
            <span className="brand-subtitle">MODULE IMAGE CAPTURE</span>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            title="显示设置"
            aria-label="显示设置"
            onClick={() => openDialog('settings')}
          >
            <Icon name="settings" size={19} />
          </button>
          <button
            className="icon-button"
            onClick={() => openDialog('help')}
            title="使用与隐私说明"
            aria-label="使用与隐私说明"
          >
            <Icon name="info" size={19} />
          </button>
        </div>
      </header>
      <main
        ref={scroller}
        className="app-main"
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
          if (detail === null) listScroll.current = event.currentTarget.scrollTop;
        }}
      >
        {state?.error && (
          <div className="notice error" role="alert">
            <Icon name="info" />
            <span>{state.error}</span>
            <button
              className="text-button"
              disabled={busy || working}
              onClick={() => void command('SELECT')}
            >
              重新选择
            </button>
          </div>
        )}
        {state?.notice && (
          <div className="notice">
            <Icon name="info" />
            <span>{state.notice}</span>
          </div>
        )}
        {state?.stale && state.result && (
          <div className="notice warning">
            <Icon name="info" />
            <span>当前为保存的结果。继续采集时请重新选择范围。</span>
          </div>
        )}
        {selectedImage && result ? (
          <Detail
            result={result}
            index={detail!}
            setIndex={setDetail}
            onBack={backToGallery}
            onCopy={(text) => void copy(text)}
          />
        ) : (
          <>
            {!state?.result && !working && preferencesReady && (
              <section className={`intro ${onboardingCompleted ? 'returning-intro' : ''}`}>
                {!onboardingCompleted && (
                  <span className="eyebrow">A LITTLE TOOL FOR YOUR WEB</span>
                )}
                <h1>
                  {onboardingCompleted ? (
                    '选择要提取的区域'
                  ) : (
                    <>
                      从网页中，
                      <br />
                      取出好图片。
                    </>
                  )}
                </h1>
                <p>选中一个网页模块，图片与链接一目了然。</p>
                <button
                  className="primary select-button"
                  disabled={busy || tabId === undefined || working}
                  onClick={() => void command('SELECT')}
                >
                  <Icon name="select" />
                  选择网页模块
                  <Icon name="arrow" />
                </button>
              </section>
            )}
            {!preferencesReady && (
              <p className="preferences-loading" role="status">
                正在加载偏好…
              </p>
            )}
            {(state?.result || working) && (
              <section className="result-toolbar" aria-label="采集工具栏">
                <div className="toolbar-primary">
                  <button
                    className="primary small"
                    disabled={busy || working || tabId === undefined}
                    onClick={() => void command('SELECT')}
                  >
                    <Icon name="select" size={15} />
                    {state?.result ? '重新选择模块' : '选择网页模块'}
                  </button>
                  {state?.previousResult && !working && (
                    <button
                      className="text-button undo-button"
                      disabled={busy}
                      onClick={() => void command('RESTORE')}
                    >
                      <Icon name="back" size={15} />
                      恢复上次结果
                    </button>
                  )}
                </div>
                {working ? (
                  <div className="selection-status" role="status">
                    <span className="pulse" />
                    <div>
                      <strong>
                        {state?.status === 'selecting' ? '在网页上选择图片区域' : '正在提取图片…'}
                      </strong>
                      <span>
                        {state?.status === 'selecting'
                          ? '使用选区旁工具条，或 ↑ / ↓ 调整、Enter 提取'
                          : '完成后可恢复上次结果。'}
                      </span>
                    </div>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void command('CANCEL')}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  state?.result && (
                    <>
                      <div className="module-actions">
                        <button
                          disabled={busy || state.stale || !state.result.canParent}
                          onClick={() => void command('PARENT')}
                        >
                          <Icon name="up" size={14} />
                          扩大范围
                        </button>
                        <button
                          disabled={busy || state.stale || !state.result.canChild}
                          onClick={() => void command('CHILD')}
                        >
                          <Icon name="down" size={14} />
                          缩小范围
                        </button>
                        <button
                          disabled={busy || state.stale}
                          onClick={() => void command('RESCAN')}
                          title="重新扫描当前模块"
                        >
                          <Icon name="refresh" size={14} />
                          重新提取
                        </button>
                      </div>
                      <details className="scope-details">
                        <summary>
                          {state.result.moduleLabel || '已选图片区域'} ·{' '}
                          {domain(state.result.pageUrl)}
                        </summary>
                        <code>{state.result.moduleSummary}</code>
                        <p>提取时的页面快照，选择器仅供检查。</p>
                      </details>
                    </>
                  )
                )}
              </section>
            )}
            {result ? (
              <section className="results-section">
                <div className="results-heading">
                  <div>
                    <h2>
                      <strong>{result.resources.length}</strong> 张图片
                    </h2>
                    <p>
                      {result.summary.referenceCount} 处引用 ·{' '}
                      {state?.status === 'scanning'
                        ? '扫描中'
                        : state?.status === 'partial'
                          ? '部分完成'
                          : '扫描完成'}
                    </p>
                  </div>
                  <button
                    className="secondary small"
                    disabled={!result.resources.length || working}
                    onClick={() => void copy(result.resources.map((image) => image.url).join('\n'))}
                  >
                    <Icon name="copy" size={15} />
                    复制全部
                  </button>
                </div>
                <div className="view-toolbar">
                  <div className="view-switch" role="group" aria-label="结果视图">
                    <button
                      aria-pressed={view === 'grid'}
                      onClick={() => {
                        updatePreferences({ view: 'grid' });
                        setFocusUrl(undefined);
                      }}
                    >
                      网格
                    </button>
                    <button
                      aria-pressed={view === 'list'}
                      onClick={() => {
                        updatePreferences({ view: 'list' });
                        setFocusUrl(undefined);
                      }}
                    >
                      列表
                    </button>
                  </div>
                  <button
                    className="text-button"
                    title="先滚动网页加载更多图片，再追加到当前结果"
                    disabled={busy || working || state?.stale}
                    onClick={() => void command('APPEND')}
                  >
                    <Icon name="plus" size={14} />
                    滚动后追加采集
                  </button>
                </div>
                {(result.summary.warnings.length > 0 ||
                  result.summary.partialReasons.length > 0 ||
                  result.summary.skippedCount > 0) && (
                  <div className="result-warnings">
                    {[...result.summary.partialReasons, ...result.summary.warnings].map((text) => (
                      <p key={text}>{text}</p>
                    ))}
                    {result.summary.skippedCount > 0 && (
                      <p>跳过 {result.summary.skippedCount} 处不支持、无效或过长的引用。</p>
                    )}
                    <div className="warning-actions">
                      {result.summary.partialReasons.length > 0 ? (
                        <>
                          <p>请缩小范围后继续采集，避免再次达到上限。</p>
                          <button
                            className="secondary small"
                            disabled={busy || working || state?.stale || !result.canChild}
                            onClick={() => void command('CHILD')}
                          >
                            缩小范围
                          </button>
                          <button
                            className="secondary small"
                            disabled={busy || working}
                            onClick={() => void command('SELECT')}
                          >
                            重新选择小范围
                          </button>
                        </>
                      ) : (
                        <>
                          <p>可换选包含普通图片的区域，或打开图片链接检查。</p>
                          <button
                            className="secondary small"
                            disabled={busy || working}
                            onClick={() => void command('SELECT')}
                          >
                            换个区域
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
                {result.resources.length ? (
                  <Gallery
                    result={result}
                    scroller={scroller}
                    scrollTop={scrollTop}
                    view={view}
                    thumbnailSize={thumbnailSize}
                    focusUrl={focusUrl}
                    onDetail={(index) => {
                      listScroll.current = scroller.current?.scrollTop ?? 0;
                      setFocusUrl(undefined);
                      setDetail(index);
                      scroller.current?.scrollTo(0, 0);
                    }}
                    onCopy={(text) => void copy(text)}
                  />
                ) : (
                  <div className="empty-result">
                    <Icon name="image" size={34} />
                    <h3>{working ? '正在寻找图片' : '这个模块还没有发现图片'}</h3>
                    <p>可扩大选取范围，或滚动网页加载图片后重新提取。</p>
                    {!working && (
                      <div className="empty-actions">
                        <button
                          className="primary small"
                          disabled={busy || state?.stale || !result.canParent}
                          onClick={() => void command('PARENT')}
                        >
                          扩大范围
                        </button>
                        <button
                          className="secondary small"
                          disabled={busy || state?.stale}
                          onClick={() => void command('APPEND')}
                        >
                          滚动后追加采集
                        </button>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => void command('SELECT')}
                        >
                          重新选择区域
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            ) : (
              !working &&
              preferencesReady &&
              !onboardingCompleted && (
                <section className="welcome">
                  <div className="illustration">
                    <div className="mini-window">
                      <i />
                      <i />
                      <i />
                      <div className="mini-layout">
                        <span />
                        <div className="mini-image">
                          <Icon name="image" size={46} />
                        </div>
                        <div className="mini-lines">
                          <span />
                          <span />
                        </div>
                      </div>
                    </div>
                    <div className="floating-image">
                      <Icon name="image" size={25} />
                      <span>图片已发现</span>
                      <Icon name="check" size={14} />
                    </div>
                    <div className="cursor-symbol">
                      <Icon name="select" size={31} />
                    </div>
                  </div>
                  <ol className="steps">
                    <li>
                      <span>01</span>
                      <div>
                        <strong>选中你想要的区域</strong>
                        <p>图片、卡片、整个模块，都可以。</p>
                      </div>
                    </li>
                    <li>
                      <span>02</span>
                      <div>
                        <strong>浏览图片和链接</strong>
                        <p>缩略预览，快速找到目标图片。</p>
                      </div>
                    </li>
                    <li>
                      <span>03</span>
                      <div>
                        <strong>查看详情，复制即用</strong>
                        <p>放大查看图片，保留完整资源地址。</p>
                      </div>
                    </li>
                  </ol>
                  <button
                    className="secondary dismiss-guide"
                    onClick={() => updatePreferences({ onboardingCompleted: true })}
                  >
                    收起引导
                  </button>
                </section>
              )
            )}
          </>
        )}
      </main>
      <footer className="app-footer">
        <Icon name="shield" size={14} />
        <span>本地提取 · 无需账号</span>
        <div className="footer-links">
          <button onClick={() => openDialog('help')}>快捷键与说明</button>
        </div>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" />
          {toast}
        </div>
      )}
      {(privacy || settings || manualCopy !== undefined) && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setPrivacy(false);
            setSettings(false);
            setManualCopy(undefined);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              autoFocus
              className="icon-button modal-close"
              aria-label="关闭对话框"
              onClick={() => {
                setPrivacy(false);
                setSettings(false);
                setManualCopy(undefined);
              }}
            >
              <Icon name="close" />
            </button>
            <span className="eyebrow">MODULE IMAGE CAPTURE</span>
            <h2 id="dialog-title">
              {settings ? '显示设置' : privacy ? '快捷键与使用说明' : '请手动复制链接'}
            </h2>
            {settings ? (
              <>
                <div className="preference-field">
                  <label htmlFor="preference-view">默认视图</label>
                  <select
                    id="preference-view"
                    disabled={!preferencesReady}
                    value={view}
                    onChange={(event) => {
                      updatePreferences({ view: event.target.value as ViewMode });
                      setFocusUrl(undefined);
                    }}
                  >
                    <option value="grid">网格</option>
                    <option value="list">列表</option>
                  </select>
                </div>
                <div className="preference-field">
                  <label htmlFor="preference-thumbnail-size">缩略图大小</label>
                  <select
                    id="preference-thumbnail-size"
                    disabled={!preferencesReady}
                    value={thumbnailSize}
                    onChange={(event) => {
                      updatePreferences({ thumbnailSize: event.target.value as ThumbnailSize });
                      setFocusUrl(undefined);
                    }}
                  >
                    <option value="small">小 · 浏览更多图片</option>
                    <option value="medium">中 · 均衡（默认）</option>
                    <option value="large">大 · 查看更多细节</option>
                  </select>
                </div>
                <p>
                  自动记住显示偏好，重新打开侧栏或浏览器后仍生效。大缩略图在较窄侧栏使用单列显示。
                </p>
                {preferencesError && (
                  <p role="alert" className="preference-error">
                    {preferencesError}
                  </p>
                )}
              </>
            ) : privacy ? (
              <>
                <dl className="shortcut-list">
                  <div>
                    <dt>
                      <kbd>↑</kbd> / <kbd>↓</kbd>
                    </dt>
                    <dd>选取时扩大 / 缩小范围</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>Enter</kbd>
                    </dt>
                    <dd>提取所选区域</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>Esc</kbd>
                    </dt>
                    <dd>取消选取 / 返回图片列表</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>←</kbd> / <kbd>→</kbd>
                    </dt>
                    <dd>详情页切换上一张 / 下一张</dd>
                  </div>
                </dl>
                <p>
                  先点击浏览器工具栏中的插件图标，再选择网页模块。悬停时用 ↑ 扩大到父级，↓
                  返回子级，单击开始提取。 也可用选区旁的工具条操作；Enter 提取，Esc 取消。
                </p>
                <p>
                  只读取你主动选择的页面区域。图片地址在本机处理，会话结果在浏览器重启后清除，不上传到我们的服务器。
                </p>
                <p>
                  加载预览会访问原图片服务器。部分图片因站点限制无法显示，仍可复制链接。首版不读取
                  iframe、Shadow DOM 内部、Canvas 或内联图片。
                </p>
                <p>
                  网页加载了新图片后，可点击“滚动后追加采集”保留已有图片并合并新链接。详情页用 ← / →
                  切换、Esc 返回列表。这里发现的是网页提供的地址，不保证是最大尺寸原文件。
                </p>
              </>
            ) : (
              <>
                <p>浏览器未允许自动复制。选中下面的文本后，使用 Ctrl+C 或系统复制操作。</p>
                <textarea
                  aria-label="待复制的链接"
                  className="url-field manual-copy"
                  readOnly
                  value={manualCopy}
                  onFocus={(event) => event.currentTarget.select()}
                  rows={8}
                />
              </>
            )}
            <button
              className="primary"
              onClick={() => {
                setPrivacy(false);
                setSettings(false);
                setManualCopy(undefined);
              }}
            >
              知道了
              <Icon name="check" />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
