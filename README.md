# 模块取图

点击选中网页模块，提取该区域中的图片链接，在浏览器侧边栏浏览缩略图、放大图片和查看详情。

首版使用 **WXT + React + TypeScript + Manifest V3**，提供 Chrome 与 Microsoft Edge 构建。无需账号或后端。

## 安装本地构建

1. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
2. 开启“开发者模式”，点击“加载已解压的扩展程序”。
3. Chrome 选择本项目的 `.output/chrome-mv3`；Edge 选择 `.output/edge-mv3`。
4. 将“模块取图”固定到浏览器工具栏。
5. 打开普通网页，点击工具栏图标，然后在侧边栏点击“选择网页模块”。

ZIP 包用于分发或商店提交，**不能直接作为扩展安装**；请先解压再加载其中的目录。本项目尚未提交扩展商店。

## 使用

- 悬停高亮图片区域；使用选区旁的“扩大范围 / 缩小范围 / 提取 / 取消”工具条，或用 `↑` / `↓` 调整，单击或 `Enter` 开始提取。
- `Esc` 或侧边栏“取消”退出选择，恢复网页交互。
- 提取后介绍区收起为工具栏，图片成为主体。卡片优先展示缩略图、文件名和尺寸；可切换列表视图检查来源、选中完整地址。
- 详情首屏展示尺寸、图片版本、复制和打开操作；技术信息默认折叠。支持扩大预览、25%～400% 缩放、`←` / `→` 切换、`Esc` 返回并恢复卡片焦点。
- 支持复制单条或全部链接。剪贴板写入被浏览器拒绝时，提供手动复制文本。
- 网页滚动加载了新图片后，点击“滚动后追加采集”保留已有链接并合并新图片；“重新提取”刷新整个当前范围。模块被移除时重新选择。
- 新结果完成后可“恢复上次结果”，无须确认框；取消或失败保留当前结果。恢复的是结果快照，继续采集需重新选择范围。每个标签页最多保留一份撤销快照，空间不足时会释放并提示。
- 空结果可直接扩大范围或重新选择；达到上限可缩小范围；预览失败可重试或打开链接。
- 右上角“显示设置”可选择小、中、大缩略图，默认使用中号；网格/列表及缩略图大小自动在本机保存，重新打开侧栏或浏览器后仍生效，多个侧栏同步。
- 首次提取完成后自动收起引导，也可点击“收起引导”；底部“快捷键与说明”可随时查看操作方法。偏好与引导状态长期保存在本机，提取结果仍仅保存于浏览器会话。
- 切换标签页后结果独立；页面导航后旧结果会标记过期；浏览器重启后会话结果清除。

## 支持范围

支持当前模块中的 `img`、`picture` 当前选用图片、CSS `background-image` 与伪元素背景图，以及 `data-src` / `data-original` / `data-lazy-src` 候选。包含 DOM 中隐藏或离屏的图片；相同完整 URL 去重，保留签名参数与引用位置。

首版不深入 iframe 或 Shadow DOM，不导出 Canvas、内联 SVG、`data:`、`blob:`，不枚举全部 `srcset` 或 CSS `image-set()` 候选。不自动滚动、抓取整个网站、猜测高清地址或绕过网站鉴权。

预览会访问原图片服务器；站点防盗链、登录要求或浏览器限制可能造成预览失败，但链接仍可查看、复制。固有尺寸是浏览器返回的 CSS 像素尺寸，格式按 URL 扩展名推测。

单次最多扫描 20,000 个元素、1,000 个唯一地址或 10 秒；会话元数据总预算 5 MiB。达到限制时显示“部分完成”，不会声称已经发现所有图片。

## 开发

建议 Node.js 22.12+，使用仓库的 `package-lock.json` 固定依赖。

```powershell
npm ci
npm run dev
```

开发 Edge：`npm run dev:edge`。如 WXT 自动启动的浏览器不可用，手动加载 `.output/chrome-mv3-dev` 或 `.output/edge-mv3-dev`，以终端实际输出目录为准。开发构建允许热更新连接，分发时使用生产构建。

```powershell
npm run typecheck
npm test
npm run build
npm run build:edge
npm run zip
npm run zip:edge
```

本地验证页面：

```powershell
npm run fixtures
```

访问 `http://127.0.0.1:4173`，选择普通图片、背景、懒加载、空模块或嵌入区域进行验证。

浏览器自动化：

```powershell
npm run test:e2e
# 已安装 Microsoft Edge 时
$env:E2E_TARGET = 'edge'
npm run test:e2e
```

测试使用已安装的 Chrome 或 Edge、独立浏览器配置，不读取用户现有浏览器资料；通过浏览器测试协议触发实际工具栏操作，使用生产构建的权限，不添加测试域名权限。测试协议需要现代浏览器提供 `Extensions.loadUnpacked` / `Extensions.triggerAction`。浏览器报告和截图位于 `.artifacts/`；测试覆盖扩展入口与页面授权，原生侧边栏外壳的视觉效果仍需人工确认。

## 目录

```text
entrypoints/background.ts       授权入口、任务路由、标签页状态与会话保存
entrypoints/picker.content.ts   页面选择器与扫描任务
entrypoints/sidepanel/          React 侧边栏与图片详情
lib/extract.ts                 图片提取、来源与数量限制
lib/urls.ts                    URL 规范化和 CSS URL 解析
lib/preview.ts                 有限并发、超时、可取消的图片预览队列
lib/types.ts                   共享数据与消息类型
tests/                         关键规则测试、受控 HTML 页面
scripts/                       图标生成、测试服务器与浏览器测试
docs/PRD.md                    产品范围、交互与验收要求
docs/IMPLEMENTATION.md         工程设计和实现取舍
docs/PRIVACY.md                隐私说明
docs/VALIDATION.md             验证记录与人工验收清单
```

生产权限仅包含 `activeTab`、`scripting`、`sidePanel`、`storage`，无全站常驻访问权限，无远程代码或埋点。详细说明见 `docs/PRIVACY.md`。
