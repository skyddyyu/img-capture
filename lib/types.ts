export type SourceType = 'img' | 'background' | 'before' | 'after' | 'lazy';
export interface ImageSource {
  type: SourceType;
  rawValue: string;
  elementSummary: string;
  alt: string;
  renderedWidth: number;
  renderedHeight: number;
  naturalWidth: number;
  naturalHeight: number;
  visible: boolean;
  isCandidate: boolean;
}
export interface ImageResource {
  id: string;
  url: string;
  displayName: string;
  formatHint: string;
  referenceCount: number;
  sources: ImageSource[];
}
export interface Summary {
  uniqueCount: number;
  referenceCount: number;
  skippedCount: number;
  visitedNodeCount: number;
  durationMs: number;
  partialReasons: string[];
  warnings: string[];
}
export interface Result {
  taskId: string;
  documentToken: string;
  pageUrl: string;
  pageTitle: string;
  moduleSummary: string;
  moduleLabel?: string;
  extractedAt: number;
  resources: ImageResource[];
  summary: Summary;
  canParent: boolean;
  canChild: boolean;
}
export type Status = 'idle' | 'selecting' | 'scanning' | 'ready' | 'empty' | 'partial' | 'error';
export interface TabState {
  tabId: number;
  taskId: string;
  documentToken?: string;
  status: Status;
  result?: Result;
  previousResult?: Result;
  append?: boolean;
  progress?: Result;
  error?: string;
  stale?: boolean;
  lastViewed: number;
  notice?: string;
}
export type Command = 'SELECT' | 'RESCAN' | 'APPEND' | 'PARENT' | 'CHILD' | 'CANCEL' | 'RESTORE';
export type Message =
  | { type: 'GET_STATE'; tabId: number }
  | { type: 'COMMAND'; tabId: number; command: Command; requestId: string }
  | { type: 'CONTENT_PING' }
  | { type: 'CONTENT_COMMAND'; command: Command; taskId: string }
  | { type: 'SCAN_START'; taskId: string; documentToken: string }
  | { type: 'SCAN_BATCH'; taskId: string; documentToken: string; result: Result }
  | { type: 'SCAN_DONE'; taskId: string; documentToken: string; result: Result }
  | { type: 'CONTENT_ERROR'; taskId: string; documentToken: string; error: string }
  | { type: 'CONTENT_CANCEL'; taskId: string; documentToken: string }
  | { type: 'CONTENT_NAVIGATED'; documentToken: string };

export const SOURCE_LABELS: Record<SourceType, string> = {
  img: '图片标签',
  background: '背景图',
  before: '::before 背景',
  after: '::after 背景',
  lazy: '懒加载候选',
};
