# AindentPaper

**English** | [中文](#aindentpaper中文)

An enhancement plugin for [Obsidian](https://obsidian.md) that provides **paragraph first-line indentation**, a **paragraph splitter** and **paper texture backgrounds**, making your reading experience more comfortable and elegant.

## ✨ Features

### 1. Paragraph first-line indentation

Adds first-line indentation to text paragraphs in the preview view, following East Asian typesetting conventions.

- **Independent toggle** — enable or disable at any time
- **Paragraph spacing** — customize the spacing between paragraphs (1–10×)
- **Line height** — customize text line height (20–40 px)
- **Smart exclusion** — automatically excludes headings, lists, code blocks, quote blocks, tables and other non-body elements

### 2. Paragraph splitter

Automatically splits `<p>...<br>...</p>` in the preview view into multiple independent `<p>` paragraphs, so that paragraph spacing settings take effect.

- **Independent toggle** — works even when "paragraph first-line indentation" is disabled
- **High-performance implementation**:
  - TreeWalker-based traversal that automatically skips code blocks, tables and similar regions
  - Batched processing on `requestIdleCallback`, never blocking the main thread
  - Bulk replacement per parent container to minimize DOM reflows
  - Initial startup only scans the currently visible view — faster startup on long documents
- **Incremental processing** — a MutationObserver watches DOM changes and processes newly added content in real time

### 3. Paper texture backgrounds

Adds beautiful paper texture backgrounds to the editing and preview views for an immersive writing atmosphere.

#### Texture styles

| Style | Description |
|------|------|
| 🟫 Kraft paper | Warm brownish-yellow tone, classic kraft texture |
| 📄 Fine white paper | Fine, soft white paper for everyday writing |
| 📜 Aged / parchment | Vintage yellowed effect with a nostalgic feel |
| 📃 Rough-grain paper | Paper with visible fiber grain |
| 🔵 Blue-gray paper | Understated blue-gray tone, fresh and elegant |
| 🪟 Frosted glass | Translucent white base with a fine frosted grain |
| 📐 Grid background | Fully customizable grid-line background |
| ⬜ No texture | Plain background color, no texture |

#### Texture adjustment

- **Opacity** — adjustable from 0–100% to control texture intensity
- **Dark mode support** — automatically adapts to Obsidian's dark theme

#### Grid-specific settings

When the "Grid background" style is selected, you can further customize:

- **Grid line color** — separate colors for light and dark mode
- **Grid size** — adjustable from 10–50 px to control grid density
- **Grid line width** — adjustable from 0.5–3 px
- **Grid line style** — solid or dashed

#### Canvas backdrop texture

- Apply the paper texture to the entire Canvas backdrop
- Canvas cards keep a plain background in preview and show the grid background while editing
- Never interferes with the cards' own background color settings

## 📖 Usage

### Installation

#### From Obsidian community plugins (recommended)

1. Open Obsidian **Settings → Community plugins**
2. Turn off "Restricted mode"
3. Click "Browse" and search for **AindentPaper**
4. Click "Install", then "Enable"

#### Manual installation

1. Download the latest version from [GitHub Releases](https://github.com/louvlwu/obsidian-aindentpaper/releases)
2. Extract the folder into your vault's `.obsidian/plugins/` directory
3. Rename the folder to `obsidian-aindentpaper`
4. Enable the plugin in Obsidian settings

### Settings

Settings are organized into two feature groups, each with its own master toggle:

#### Paragraph first-line indentation

```
Enable paragraph first-line indentation [toggle]
  ├─ Paragraph first-line indent [toggle]
  ├─ Paragraph spacing [slider: 1–10]
  └─ Text line height [slider: 20–40 px]
```

#### Paper texture background

```
Enable paper texture background [toggle]
  ├─ Texture style [dropdown: kraft / fine white / aged / rough-grain / blue-gray / frosted glass / grid / none]
  ├─ Texture opacity [slider: 0–100%]
  └─ Canvas backdrop texture [toggle]
```

#### Grid background settings (shown when "Grid background" is selected)

```
Grid background settings
  ├─ Enable grid background [toggle]
  ├─ Grid line color (light mode) [color picker]
  ├─ Grid line color (dark mode) [color picker]
  └─ Content area shadow opacity [slider: 0–1]
```

#### Paragraph splitter

```
Paragraph splitter (independent toggle) [toggle]
```

### Commands

The following commands are available from the command palette (Ctrl/Cmd + P):

- **Rescan and split paragraphs** — manually re-run the paragraph splitter on the current document
- **Toggle paragraph splitter** — quickly enable/disable the paragraph splitter
- **Reset all settings** — restore every setting to its default value

## 🔧 Technical highlights

- **High performance** — TreeWalker traversal, `requestIdleCallback` batching and bulk DOM operations
- **Scoped styling** — every style rule is strictly limited to the note content area; sidebars, status bar etc. are untouched
- **Canvas-safe** — Canvas areas are automatically excluded and remain fully functional
- **Table-safe** — table elements are detected and excluded, table rendering is never broken
- **Dark mode** — fully adapted to Obsidian's dark theme
- **Responsive** — works on desktop and mobile

## 📋 Compatibility

- Minimum Obsidian version: 1.4.0
- Desktop and mobile supported
- Compatible with dark and light themes

## 🐛 Known issues

- The paragraph splitter only processes content in the preview (reading) view; the editing view is unaffected
- The dashed grid style may look less than ideal at very small grid sizes

## 📝 Changelog

### v2.0.1
- Fixed: first-line indentation persisted after disabling the plugin until Obsidian was restarted.
- Fixed: first-line indentation was lost when exporting notes to PDF.
- Improved: paragraph spacing was too large in preview view for Canvas card content, note text and PDF exports.
- Fixed: the fold icon before headings was not displayed.
- Improved: horizontal rules were not distinct enough in the editing view when the plugin was enabled.
- Background: in preview view, when scrolling a 100k+ character document with complex formatting (text, tables, lists, code blocks, …) at a fast pace, newly scrolled-in pages appeared blank first and the view stuttered until content rendered. A new **"Long-document scrolling performance optimization (experimental)"** setting addresses this; being experimental, it can be disabled if conflicts occur.

### v2.0.0
Previously the first-line indentation style leaked into Obsidian table content and quote blocks, causing visual inconsistencies between editing and preview.
- Indentation no longer applies to content inside native tables.
- Added Canvas backdrop paper texture support.
- Improved paragraph splitter startup performance: startup is deferred via `onLayoutReady`, and only the currently visible note is processed at launch — further reducing stutter on very long documents.
- Improved Canvas card background handling; the cards' own background color is preserved.
- Indentation no longer applies to content inside native quote blocks.
- Fixed: table cells showed the paper texture while editing table content.
- With "Enable paragraph first-line indentation" turned on, fixed:
  1. the native table drag handle shifting to the wrong column in editing view;
  2. a white underlay beneath tables and a horizontal scrollbar appearing at the bottom;
  3. unclear cell selection and color chaos across the whole table.
- Fixed table rendering interference.
- Various bug fixes and performance improvements.
- Added the grid background style with customizable color, size, line width and line style.

### v1.0.2

- Fixed paper texture appearing in table cells in the editing view
- Improved dark mode adaptation

## 📄 License

[MIT](LICENSE)

## 🙏 Acknowledgements

Thanks to the developers and users of the Obsidian community for their support.

---

If this plugin helps you, a Star ⭐ on GitHub is much appreciated!

---

# AindentPaper（中文）

[English](#aindentpaper) | **中文**

一款为 [Obsidian](https://obsidian.md) 设计的增强插件，提供**段落首行缩进**、**段落拆分器**和**纸质纹理背景**功能，让笔记阅读体验更加舒适美观。

## ✨ 功能特性

### 1. 段落首行缩进

为预览视图中的文本段落添加首行缩进效果，符合中文排版习惯。

- **独立开关**：可随时启用或关闭
- **段间距调节**：自定义段落之间的间距（1-10 倍）
- **行高调节**：自定义文本行高（20-40px）
- **智能排除**：自动排除标题、列表、代码块、引用块、表格等非正文元素

### 2. 段落拆分器

将预览视图中的 `<p>...<br>...</p>` 自动拆分为多个独立的 `<p>` 段落，使段落间距设置生效。

- **独立开关**：即使关闭了"段落首行缩进"，仍可独立控制是否拆分
- **高性能优化**：
  - 使用 TreeWalker 高效遍历，自动跳过代码块、表格等区域
  - 基于 `requestIdleCallback` 分批处理，不阻塞主线程
  - 按父容器批量替换，减少 DOM 重排次数
  - 初始启动仅扫描当前可见视图，长文本场景下启动更快
- **增量处理**：通过 MutationObserver 监听 DOM 变化，实时处理新增内容

### 3. 纸质纹理背景

为笔记编辑和预览视图添加精美的纸质纹理背景效果，营造沉浸式书写氛围。

#### 纹理样式

| 样式 | 说明 |
|------|------|
| 🟫 牛皮纸 | 温暖的棕黄色调，经典牛皮纸质感 |
| 📄 细腻白纸 | 细腻柔和的白色纸张，适合日常书写 |
| 📜 旧纸/羊皮纸 | 复古泛黄效果，营造怀旧氛围 |
| 📃 粗纹纸 | 带有明显纤维纹理的纸张 |
| 🔵 青灰纸 | 淡雅青灰色调，清新雅致 |
| 🪟 磨砂玻璃 | 半透明白色基底 + 细腻磨砂颗粒感 |
| 📐 网格背景 | 可自定义的网格线背景 |
| ⬜ 无纹理 | 纯背景色，无纹理效果 |

#### 纹理调节

- **透明度**：0-100% 可调，控制纹理的显示强度
- **深色模式适配**：自动适配 Obsidian 深色主题

#### 网格背景专属设置

选择"网格背景"样式时，可进一步自定义：

- **网格线颜色**：分别设置浅色/深色模式下的线条颜色
- **网格大小**：10-50px 可调，控制网格密度
- **网格线粗细**：0.5-3px 可调
- **网格线样式**：实线 / 虚线

#### 白板幕布纹理

- 可为白板的整个幕布背景应用纸质纹理效果
- 白板卡片在预览视图下保持纯色背景，编辑视图下显示网格背景
- 不影响白板卡片原本的背景色设置

## 📖 使用说明

### 安装

#### 从 Obsidian 社区插件安装（推荐）

1. 打开 Obsidian 设置 → 第三方插件
2. 关闭"安全模式"
3. 点击"浏览"，搜索 **AindentPaper**
4. 点击"安装"，然后"启用"

#### 手动安装

1. 从 [GitHub Releases](https://github.com/louvlwu/obsidian-aindentpaper/releases) 下载最新版本
2. 将解压后的文件夹放入你的 Obsidian 仓库的 `.obsidian/plugins/` 目录下
3. 重命名文件夹为 `obsidian-aindentpaper`
4. 在 Obsidian 设置中启用插件

### 设置

插件设置分为两大功能组，每组都有独立的启用开关：

#### 段落首行缩进

```
启用段落首行缩进 [开关]
  ├─ 段落首行缩进 [开关]
  ├─ 文本段间距 [滑块: 1-10]
  └─ 文本行高 [滑块: 20-40px]
```

#### 纸质纹理背景

```
启用纸质纹理背景 [开关]
  ├─ 纸质纹理样式 [下拉: 牛皮纸/细腻白纸/旧纸/羊皮纸/粗纹纸/青灰纸/磨砂玻璃/网格背景/无纹理]
  ├─ 纹理透明度 [滑块: 0-100%]
  └─ 白板幕布纸质纹理 [开关]
```

#### 网格背景设置（选择"网格背景"样式时显示）

```
网格背景设置
  ├─ 启用网格背景 [开关]
  ├─ 网格背景线颜色 (浅色模式) [颜色选择器]
  ├─ 网格背景线颜色 (深色模式) [颜色选择器]
  └─ 网格背景内容区域阴影透明度 [滑块: 0-1]
```

#### 段落拆分器

```
段落拆分器 (独立开关) [开关]
```

### 命令

插件提供以下命令，可在命令面板（Ctrl/Cmd + P）中调用：

- **重新扫描并拆分段落**：手动触发段落拆分器重新扫描当前文档
- **切换段落拆分器开关**：快速切换段落拆分器的启用/禁用状态
- **重置所有设置**：将所有设置恢复为默认值

## 🔧 技术特性

- **高性能**：使用 TreeWalker、requestIdleCallback、批量 DOM 操作等优化手段
- **作用域隔离**：所有样式规则严格限定在笔记内容区域，不影响侧边栏、状态栏等
- **白板兼容**：自动排除白板区域，不影响白板正常使用
- **表格安全**：智能识别并排除表格元素，不破坏表格渲染
- **深色模式**：完整适配 Obsidian 深色主题
- **响应式**：支持桌面端和移动端

## 📋 兼容性

- Obsidian 最低版本：1.4.0
- 支持桌面端和移动端
- 兼容深色/浅色主题

## 🐛 已知问题

- 段落拆分器仅处理预览视图（阅读模式）中的内容，编辑视图不受影响
- 网格背景的虚线样式在极小网格尺寸下可能显示不够理想

## 📝 更新日志

### v2.0.1
- 修复禁用插件后，文本首行缩进排版依然存在，需要重启 obsidian 才消失的问题。
- 修复文本内容导出到 PDF 时，段落首行缩进排版丢失的问题；
- 优化预览视图下，白板卡片内容、笔记文本内容段间距和 PDF 导出内容段间距太大的问题；
- 修复文本标题前折叠图标不显示的文体；
- 优化编辑视图下，插件启用后，分割线不够明显的体验问题；
- 背景：预览视图下，在打开一个 10 万+字的复杂格式（文本、表格、列表、代码块等等）的长文本时，在滚动阅读，并且速度稍快时，后面滚动上来的页面一开始是空白，这时开始卡顿，直到空白页面刷新出来内容后才能继续往下滚动，所以这就产生了阅读长文本卡顿严重的不好体验。所以，增加了"长文本滚动性能优化(实验性功能)"这个设置项，该项仅作为实验性功能，如果遇到冲突，可以禁用。

### v2.0.0
插件使用中，段落首行缩进样式会应用到 obsidian 表格内容和引用块中的内容上，这样会导致编辑和预览时出现视觉体验偏差。 
- 插件的缩进功能不再对原生表格中的内容生效。
- 新增白板幕布纸质纹理支持 。
- 优化段落拆分器启动性能，使用 `onLayoutReady` 延迟启动，obsidian 启动时，段落拆分器只处理当前可见的那个笔记，进一步优化超长文本因为段落拆分时引起的卡顿现象。 
- 优化白板卡片背景处理，保留卡片原本背景色。
- 插件的缩进功能不再对原生引用块中的内容生效。
- 修复 表格内容编辑时，单元格背景显示纸质纹理的问题。 
- 当开启插件"启用段落首行缩进"时，修复如下问题：
 ①、导致编辑视图下，原生表格的 拖拽手柄右移错列；
 ②、表格下层出现白底和底部出现横向滚动条；
 ③、表格内容选中不明确，全表色彩混乱现象。
- 修复表格渲染干扰问题 。
- 一些 BUG 修复和性能优化。 
- 新增网格背景样式，支持自定义颜色、大小、线宽、线型。

### v1.0.2

- 修复编辑视图表格单元格出现纸质纹理的问题
- 优化深色模式适配

## 📄 许可证

[MIT](LICENSE)

## 🙏 致谢

感谢 Obsidian 社区的开发者和用户们的支持。

---

如果这个插件对你有帮助，欢迎在 GitHub 上给个 Star ⭐！
