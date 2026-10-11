import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  zip: { excludeSources: ['.artifacts/**'] },
  manifest: {
    name: '模块取图',
    description: '点击选择网页模块，提取图片链接、浏览缩略图并查看图片详情。',
    minimum_chrome_version: '116',
    permissions: ['activeTab', 'scripting', 'sidePanel', 'storage'],
    action: { default_title: '模块取图 · 选择网页模块' },
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    side_panel: { default_path: 'sidepanel.html' },
  },
});
