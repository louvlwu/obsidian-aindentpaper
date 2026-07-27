/**
 * Obsidian AindentPaper - 段落首行缩进与纸质纹理插件
 * ======================================================================
 * 主要功能：
 *   1. 启用段落首行缩进
 *   2. 段落拆分器（独立开关）：控制 <br> 自动拆分功能的总开关
 *      即使关闭了"段落首行缩进"，仍可独立控制是否拆分
 *   3. 纸质纹理背景：为笔记编辑和预览视图添加纸质纹理背景效果
 *
 * 设置存储：data.json
 * 应用机制：class-toggle 通过 body.classList 控制；变量通过 :root style 属性控制
 * ======================================================================
 */

'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView } = require('obsidian');

/* ===========================================================================
 * 工具函数
 * ======================================================================== */
/**
 * 将 HEX 颜色转换为 RGBA 字符串
 * @param {string} hex - HEX 颜色值（如 #000000 或 #000）
 * @param {number} alpha - 透明度（0-1）
 * @returns {string} rgba(r, g, b, alpha)
 */
function hexToRgba(hex, alpha) {
    if (!hex || hex[0] !== '#') return `rgba(0, 0, 0, ${alpha})`;
    const full = hex.length === 4
        ? '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
        : hex;
    const r = parseInt(full.slice(1, 3), 16);
    const g = parseInt(full.slice(3, 5), 16);
    const b = parseInt(full.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ===========================================================================
 * 段落拆分器：将预览视图中的 <p>...<br>...</p> 拆分为多个 <p>
 *
 * 性能优化要点（v4）：
 *   1. TreeWalker 替代 querySelectorAll：遇到跳过区域直接跳过整个子树
 *   2. shouldProcess 合并 closest 调用：2 次合并为 1 次向上遍历
 *   3. 快速判断 br 存在性：遍历 childNodes 提前退出
 *   4. requestIdleCallback + 分批处理：利用 deadline 让出主线程
 *   5. 处理期间断开 Observer：消除自触发循环
 *   6. 两阶段拆分：_createSplitNodes 只创建节点，不插入 DOM
 *   7. 按父容器批量替换：同一父容器内的所有拆分合并为一次 replaceChild
 *      减少 N 次 layout invalidation → 1 次
 *   8. CSS containment：配合 styles.css 中的 contain 属性限制重排范围
 * ======================================================================== */
class ParagraphSplitter {
    constructor() {
        this.skipTagNames = new Set([
            'PRE', 'CODE',
            'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
            'BLOCKQUOTE',
            'LI',
            'CANVAS',
        ]);
        this.skipClassSelectors = [
            '.math', '.math-block',
            '.callout',
            '.internal-embed',
            '.external-embed',
            '.cm-editor',
            '.canvas-node',
            '.canvas-wrapper',
            '.workspace-leaf-content[data-type="canvas"]',
        ];
        this.skipSelector = [
            ...Array.from(this.skipTagNames).map(t => t.toLowerCase()),
            ...this.skipClassSelectors,
        ].join(',');

        /* 白板卡片内的 .markdown-preview-view 也会被 .markdown-reading-view 匹配，
           因此 mustNotMatch 用于在 shouldProcess 中排除白板内的段落 */
        this.canvasSelector = '.canvas-node, .canvas-wrapper, .workspace-leaf-content[data-type="canvas"], .workspace-leaf[data-type="canvas"], .workspace-leaf[data-type="whiteboard"], .whiteboard-embed';
        this.markdownViewSelector = '.markdown-reading-view, .markdown-preview-view';

        this.observer = null;
        this._observerTargets = [];  // 缩小后的观察目标列表
        this.started = false;
        this.forceEnabled = true;
        this.splitCounter = 0;

        this._pendingNodes = new Set();
        this._scheduleId = null;
        this._flushing = false;
    }

    /**
     * 收集当前文档中所有需要监听的 .workspace-leaf-content 容器
     * 仅监听 markdown 类型的叶片，排除白板等无关区域
     * 大幅减少 MutationObserver 的回调触发次数
     */
    _collectObserverTargets() {
        const targets = [];
        const leaves = document.querySelectorAll('.workspace-leaf-content');
        for (const leaf of leaves) {
            // 跳过白板叶片
            if (leaf.getAttribute('data-type') === 'canvas') continue;
            targets.push(leaf);
        }
        return targets;
    }

    isEnabled() {
        return this.forceEnabled;
    }

    /**
     * 快速判断 <p> 是否包含 <br> 子元素
     */
    _hasBrChild(p) {
        for (const child of p.childNodes) {
            if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
                return true;
            }
        }
        return false;
    }

    /**
     * 判断 <p> 是否为"纯非文本段落"（仅含标签/链接/图片/嵌入等元素，无正文文本）
     * 判定逻辑与 MarkdownPostProcessor 的 data-no-indent 标记逻辑保持一致。
     * 用于拆分/合并时对产物即时补判：PostProcessor 只在渲染时执行一次，
     * 混合段落（文本+<br>+纯标签行）拆分后产生的纯元素行必须在此重新判定。
     * 仅遍历直接子节点，O(children)，只在拆分/合并动作时调用，无常驻开销。
     */
    _isNonTextParagraph(p) {
        let hasElement = false;
        for (const node of p.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                if (node.nodeValue.trim() !== '') return false;
                continue;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.matches('a.tag, a.internal-link, a.external-link, img, .internal-embed, .external-embed, br')) {
                hasElement = true;
                continue;
            }
            /* 其它元素（<strong>/<em>/<code> 等）→ 带格式的文本段落 */
            return false;
        }
        return hasElement;
    }

    /**
     * 判断一个 <p> 是否需要处理（优化版）
     * 合并 closest 向上遍历为单次
     */
    shouldProcess(p) {
        if (!p || p.tagName !== 'P') return false;
        if (p.hasAttribute('data-split-group')) return false;
        if (!this._hasBrChild(p)) return false;

        /* 白板卡片内的 <p> 不拆分 — 避免 canvas 预览视图出现空行 */
        if (p.closest(this.canvasSelector)) return false;

        let el = p;
        let inMarkdownView = false;
        while (el) {
            if (el.nodeType !== Node.ELEMENT_NODE) {
                el = el.parentElement;
                continue;
            }
            if (el.matches(this.markdownViewSelector)) {
                inMarkdownView = true;
                break;
            }
            if (el.matches(this.skipSelector)) {
                return false;
            }
            el = el.parentElement;
        }

        /* 排除白板内的 markdown 视图（如 canvas-node 内的 .markdown-preview-view） */
        if (inMarkdownView && el && el.closest(this.canvasSelector)) return false;

        return inMarkdownView;
    }

    /**
     * 两阶段拆分 - 第一阶段：创建拆分后的节点（不插入 DOM）
     * 
     * 返回值：
     *   null  - 不需要拆分
     *   Array - 拆分后的新 <p> 节点数组（尚未插入 DOM）
     * 
     * 好处：DOM 创建和 DOM 插入分离，允许按父容器批量插入
     */
    _createSplitNodes(p) {
        const segments = [];
        let current = [];
        let brCount = 0;

        for (const node of p.childNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
                segments.push(current);
                current = [];
                brCount++;
            } else {
                current.push(node);
            }
        }
        segments.push(current);

        if (brCount === 0) return null;

        this.splitCounter++;
        const groupId = 'sg' + this.splitCounter;

        const newParagraphs = [];
        for (const segNodes of segments) {
            const hasContent = segNodes.some(n => {
                if (n.nodeType === Node.TEXT_NODE) return n.nodeValue.trim() !== '';
                if (n.nodeType === Node.ELEMENT_NODE) return true;
                return false;
            });
            if (!hasContent) continue;

            const newP = document.createElement('p');
            if (p.className) newP.className = p.className;
            for (const attr of Array.from(p.attributes)) {
                if (attr.name === 'class') continue;
                newP.setAttribute(attr.name, attr.value);
            }
            newP.setAttribute('data-split-group', groupId);
            for (const n of segNodes) newP.appendChild(n);

            /* 拆分产物即时补判 data-no-indent：
               混合段落（有文本）不会被 PostProcessor 标记，但拆分出的
               纯标签/链接/图片行是独立 <p>，须排除首行缩进；
               反之移除从原段落复制来的过期标记 */
            if (this._isNonTextParagraph(newP)) {
                newP.setAttribute('data-no-indent', '');
            } else {
                newP.removeAttribute('data-no-indent');
            }

            newParagraphs.push(newP);
        }

        if (newParagraphs.length <= 1) {
            this.splitCounter--;
            return null;
        }

        return newParagraphs;
    }

    /**
     * 两阶段拆分 - 第二阶段：按父容器批量替换
     * 
     * 核心优化：将同一父容器内的多个 split 合并为一次 DOM 操作
     * 
     * 原来：3 个 <p> 需要拆分 → 3 次 replaceChild → 3 次 layout invalidation
     * 现在：3 个 <p> 需要拆分 → 构建完整子节点列表 → 1 次替换 → 1 次 layout invalidation
     * 
     * @param {Map<Element, {splitMap: Map<Element, {original, newNodes}>, originalSet: Set<Element>}>} batchData
     */
    _batchReplace(batchData) {
        for (const [parent, { splitMap, originalSet }] of batchData) {
            // 构建新的子节点列表：保持原有顺序，只替换需要拆分的 <p>
            const newChildren = document.createDocumentFragment();

            for (const child of Array.from(parent.childNodes)) {
                if (originalSet.has(child)) {
                    // 用拆分后的节点替换原始 <p> — O(1) Map 查找
                    const split = splitMap.get(child);
                    for (const newNode of split.newNodes) {
                        newChildren.appendChild(newNode);
                    }
                } else {
                    // 保持原有节点
                    newChildren.appendChild(child);
                }
            }

            // 一次性替换父容器的所有子节点
            parent.replaceChildren(newChildren);
        }
    }

    /**
     * 兼容的单段落拆分方法（用于只有1个段落需要处理的情况）
     */
    splitParagraph(p) {
        const parent = p.parentNode;
        if (!parent) return false;

        const newNodes = this._createSplitNodes(p);
        if (!newNodes) return false;

        const frag = document.createDocumentFragment();
        for (const n of newNodes) frag.appendChild(n);
        parent.replaceChild(frag, p);
        return true;
    }

    /**
     * 使用 TreeWalker 遍历节点，遇到跳过区域自动跳过整个子树
     */
    _collectProcessableParagraphs(root) {
        const results = [];
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT,
            {
                acceptNode: (node) => {
                    if (this.skipTagNames.has(node.tagName)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (node.matches(this.skipSelector)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (node.tagName !== 'P') {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    if (node.hasAttribute('data-split-group')) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (!this._hasBrChild(node)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        let node;
        while ((node = walker.nextNode())) {
            if (node.tagName === 'P') {
                results.push(node);
            }
        }
        return results;
    }

    /**
     * 批量处理段落拆分（核心优化方法）
     * 
     * 流程：
     *   1. 收集所有需要拆分的 <p>
     *   2. 对每个 <p> 执行 _createSplitNodes（只创建节点，不插入 DOM）
     *   3. 按父容器分组，每组执行一次 _batchReplace（一次性替换）
     * 
     * 这样 N 个段落的拆分只需 ceil(不同父容器数) 次 layout invalidation
     * 而非 N 次
     * 
     * 数据结构优化：使用 Map<original, splitData> 替代 Array<{original, newNodes}>
     * 将 _batchReplace 中的查找从 O(N) 降为 O(1)
     */
    _batchProcessParagraphs(paragraphs) {
        if (paragraphs.length === 0) return;

        // 只有一个段落时，直接用简单路径
        if (paragraphs.length === 1) {
            this.splitParagraph(paragraphs[0]);
            return;
        }

        // 第一阶段：创建所有拆分节点（不插入 DOM）
        // 使用 Map<Element, {original, newNodes}> 替代 Array，实现 O(1) 查找
        const parentDataMap = new Map(); // parent → { splitMap: Map<original, splitData>, originalSet: Set }

        for (const p of paragraphs) {
            const newNodes = this._createSplitNodes(p);
            if (!newNodes) continue;

            const parent = p.parentNode;
            if (!parent) continue;

            if (!parentDataMap.has(parent)) {
                parentDataMap.set(parent, {
                    splitMap: new Map(),
                    originalSet: new Set()
                });
            }
            const data = parentDataMap.get(parent);
            data.splitMap.set(p, { original: p, newNodes });
            data.originalSet.add(p);
        }

        // 第二阶段：按父容器批量替换（减少 layout invalidation）
        if (parentDataMap.size > 0) {
            this._batchReplace(parentDataMap);
        }
    }

    /**
     * 增量处理：仅处理指定节点内部的段落
     */
    processNode(node) {
        if (!this.isEnabled()) return;

        /* 白板卡片内的节点不处理 — 从源头阻断 */
        if (node.closest && node.closest(this.canvasSelector)) return;

        if (node.tagName === 'P') {
            if (this.shouldProcess(node)) {
                this.splitParagraph(node);
            }
            return;
        }

        if (!node.closest || !node.closest(this.markdownViewSelector)) return;

        const toProcess = this._collectProcessableParagraphs(node);
        // 使用批量处理替代逐个 splitParagraph
        this._batchProcessParagraphs(toProcess);
    }

    /**
     * 全量扫描容器（仅用于初始加载和手动重扫）
     */
    processContainer(root) {
        if (!this.isEnabled()) return;

        const scope = root || document.body;
        const views = scope.querySelectorAll(this.markdownViewSelector);
        for (const view of views) {
            /* 跳过白板卡片内的 markdown 视图 */
            if (view.closest(this.canvasSelector)) continue;

            const toProcess = this._collectProcessableParagraphs(view);
            // 使用批量处理替代逐个 splitParagraph
            this._batchProcessParagraphs(toProcess);
        }
    }

    /**
     * 调度处理：收集待处理节点，在浏览器空闲时统一执行
     */
    scheduleProcess(target) {
        if (target && target !== document.body) {
            this._pendingNodes.add(target);
        } else {
            this._pendingNodes.clear();
            this._pendingNodes.add(null);
        }

        this._ensureScheduled();
    }

    /**
     * 确保有一个调度任务排队
     */
    _ensureScheduled() {
        if (this._scheduleId !== null) return;

        if ('requestIdleCallback' in window) {
            this._scheduleId = requestIdleCallback((deadline) => {
                this._scheduleId = null;
                this._flushPendingNodes(deadline);
            }, { timeout: 500 });
        } else {
            this._scheduleId = setTimeout(() => {
                this._scheduleId = null;
                requestAnimationFrame(() => {
                    this._flushPendingNodes();
                });
            }, 200);
        }
    }

    /**
     * 执行待处理节点：断开 Observer → 分批处理 → 重连 Observer
     */
    _flushPendingNodes(deadline) {
        if (this._flushing) return;
        if (this._pendingNodes.size === 0) return;

        this._flushing = true;

        if (this.observer) this.observer.disconnect();

        try {
            const nodes = Array.from(this._pendingNodes);
            this._pendingNodes.clear();

            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];

                if (node === null) {
                    this.processContainer(document.body);
                } else {
                    this.processNode(node);
                }

                // 分批让出：检查是否还有剩余时间
                if (deadline && deadline.timeRemaining() <= 2) {
                    for (let j = i + 1; j < nodes.length; j++) {
                        this._pendingNodes.add(nodes[j]);
                    }
                    break;
                }
            }
        } catch (e) {
            console.error('[AindentPaper] 段落拆分失败:', e);
        } finally {
            this._flushing = false;

            if (this.observer && this.started) {
                this._reconnectObserver();
            }

            if (this._pendingNodes.size > 0) {
                this._ensureScheduled();
            }
        }
    }

    /**
     * 将 Observer 重新连接到当前所有 .workspace-leaf-content 容器
     * 作用域从 document.body 缩小到仅 markdown 叶片容器，
     * 避免监听侧边栏、状态栏、搜索面板等无关区域的 DOM 变更
     */
    _reconnectObserver() {
        if (!this.observer) return;
        this.observer.disconnect();
        this._observerTargets = this._collectObserverTargets();
        for (const target of this._observerTargets) {
            this.observer.observe(target, {
                childList: true,
                subtree: true
            });
        }
    }

    start(skipInitialScan = false) {
        if (this.started) return;
        this.started = true;

        if (!skipInitialScan) {
            this.scheduleProcess(document.body);
        }

        this.observer = new MutationObserver(mutations => {
            if (this._flushing) return;

            for (const m of mutations) {
                if (!m.addedNodes || !m.addedNodes.length) continue;

                /* 高频场景预过滤：先检查 mutation 的目标元素
                   如果 target 不在 markdown 视图内，跳过整个 mutation 的所有 addedNodes，
                   避免逐个检查 addedNodes 再做 closest() 向上遍历的开销。
                   典型场景：CodeMirror 滚动时每帧产生多个 mutation，
                   target 为 .cm-content / .cm-line 等编辑器内部元素 */
                const target = m.target;
                if (target.nodeType === Node.ELEMENT_NODE
                    && target.closest
                    && !target.closest(this.markdownViewSelector)
                    && !target.closest('.workspace-leaf-content')) {
                    continue;
                }

                for (const n of m.addedNodes) {
                    if (n.nodeType !== Node.ELEMENT_NODE) continue;
                    if (n.hasAttribute && n.hasAttribute('data-split-group')) continue;
                    if (!n.closest || !n.closest(this.markdownViewSelector)) continue;

                    /* 白板卡片内的 DOM 变化不触发段落拆分 */
                    if (n.closest(this.canvasSelector)) continue;

                    this.scheduleProcess(n);
                }
            }
        });

        /* 性能优化：不再观察 document.body，仅观察 markdown 叶片容器
           避免监听侧边栏、状态栏、搜索面板等无关区域的 DOM 变更 */
        this._reconnectObserver();

        console.log('[AindentPaper] 段落拆分器已启动');
    }

    stop() {
        if (this._scheduleId !== null) {
            if ('cancelIdleCallback' in window) {
                cancelIdleCallback(this._scheduleId);
            } else {
                clearTimeout(this._scheduleId);
            }
            this._scheduleId = null;
        }
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        this.started = false;
        this._pendingNodes.clear();
        this._flushing = false;
        console.log('[AindentPaper] 段落拆分器已停止');
    }

    setEnabled(enabled, skipInitialScan = false) {
        this.forceEnabled = !!enabled;
        if (this.forceEnabled) {
            this.start(skipInitialScan);
        } else {
            this.stop();
            this.restoreOriginalParagraphs();
        }
    }

    /**
     * 恢复被拆分的段落：将同组段落合并回原始 <p>，用 <br> 连接
     * 使用批量替换优化重排
     */
    restoreOriginalParagraphs() {
        const groups = new Map();
        const splitPs = document.querySelectorAll('[data-split-group]');

        for (const p of splitPs) {
            const groupId = p.getAttribute('data-split-group');
            if (!groups.has(groupId)) {
                groups.set(groupId, []);
            }
            groups.get(groupId).push(p);
        }

        // 按父容器分组，批量替换
        const parentSplits = new Map();

        for (const [groupId, ps] of groups) {
            if (ps.length <= 1) continue;

            const firstP = ps[0];
            const parent = firstP.parentNode;
            if (!parent) continue;

            const mergedP = document.createElement('p');

            /* data-no-indent 不随属性复制：首行可能是被标记的纯标签行，
               合并回混合段落后标记即过期，须按合并结果重新判定 */
            for (const attr of Array.from(firstP.attributes)) {
                if (attr.name !== 'data-split-group' && attr.name !== 'data-no-indent') {
                    mergedP.setAttribute(attr.name, attr.value);
                }
            }

            for (let i = 0; i < ps.length; i++) {
                const p = ps[i];
                for (const node of Array.from(p.childNodes)) {
                    mergedP.appendChild(node);
                }
                if (i < ps.length - 1) {
                    mergedP.appendChild(document.createElement('br'));
                }
            }

            /* 合并后重判：整段仍为纯非文本内容时恢复标记 */
            if (this._isNonTextParagraph(mergedP)) {
                mergedP.setAttribute('data-no-indent', '');
            }

            if (!parentSplits.has(parent)) {
                parentSplits.set(parent, []);
            }
            parentSplits.get(parent).push({ original: ps, merged: mergedP });
        }

        // 批量替换：构建完整子节点列表，一次性替换
        for (const [parent, splits] of parentSplits) {
            const frag = document.createDocumentFragment();
            const allOriginals = new Set();
            for (const split of splits) {
                for (const p of split.original) {
                    allOriginals.add(p);
                }
            }

            for (const child of Array.from(parent.childNodes)) {
                if (allOriginals.has(child)) {
                    // 找到对应的合并节点
                    const split = splits.find(s => s.original.includes(child));
                    if (split && child === split.original[0]) {
                        frag.appendChild(split.merged);
                    }
                    // 非 firstP 的原始节点跳过（已合并到 mergedP 中）
                } else {
                    frag.appendChild(child);
                }
            }

            parent.replaceChildren(frag);
        }

        const restoredCount = parentSplits.size;
        if (restoredCount > 0) {
            console.log(`[AindentPaper] 已恢复 ${restoredCount} 个被拆分的段落`);
        }
    }
}

/* ===========================================================================
 * 滚动性能预取器：提前渲染即将进入视口的内容块
 *
 * 原理：
 *   CSS content-visibility:auto 使元素在进入视口时才开始渲染，
 *   快速滚动时大量元素同时触发渲染会造成帧率下降。
 *   本预取器使用 IntersectionObserver 以 2 个视口高度的提前量
 *   监听元素，当元素进入“预取区”时将其 content-visibility
 *   设为 visible，给浏览器充足的预渲染时间，减少空白持续时间。
 *
 * 边界控制：
 *   - 完全独立于段落拆分、纸质纹理、段落缩进等功能
 *   - 仅操作 style.contentVisibility 属性，不修改 DOM 结构
 *   - 停止时完全清理，不残留任何副作用
 * ======================================================================== */
class ScrollPerfPrefetcher {
    constructor() {
        this._observer = null;
        this._observed = new Set();
        this._started = false;
        /* content-visibility 选择器：与 styles.css 中的规则完全对应 */
        this._selectors = [
            '.markdown-preview-sizer > div',
            '.markdown-preview-sizer > table',
            '.markdown-preview-sizer > pre',
            '.markdown-preview-sizer > ul',
            '.markdown-preview-sizer > ol',
            '.markdown-preview-sizer > blockquote',
            '.markdown-reading-view .markdown-rendered > div',
            '.markdown-reading-view .markdown-rendered > table',
            '.markdown-reading-view .markdown-rendered > pre',
            '.markdown-reading-view .markdown-rendered > ul',
            '.markdown-reading-view .markdown-rendered > ol',
            '.markdown-reading-view .markdown-rendered > blockquote',
        ].join(',');
    }

    /**
     * 启动预取器
     * 创建 IntersectionObserver，监听当前文档中所有符合条件的内容块
     */
    start() {
        if (this._started) return;
        this._started = true;

        /* rootMargin: 上下各扩展 200%（约 2 个视口高度），提前触发渲染 */
        this._observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        entry.target.style.contentVisibility = 'visible';
                        this._observer.unobserve(entry.target);
                        this._observed.delete(entry.target);
                    }
                }
            },
            { rootMargin: '200% 0px 200% 0px' }
        );

        this._observeExisting();
        this._setupMutationObserver();

        console.log('[AindentPaper] 滚动性能预取器已启动');
    }

    /**
     * 观察当前已存在的所有内容块
     */
    _observeExisting() {
        if (!this._observer) return;
        const leaves = document.querySelectorAll('.workspace-leaf-content:not([data-type="canvas"])');
        for (const leaf of leaves) {
            const elements = leaf.querySelectorAll(this._selectors);
            for (const el of elements) {
                if (!this._observed.has(el)) {
                    this._observer.observe(el);
                    this._observed.add(el);
                }
            }
        }
    }

    /**
     * 监听 DOM 变化，对新插入的内容块自动添加观察
     */
    _setupMutationObserver() {
        this._mutObserver = new MutationObserver((mutations) => {
            if (!this._observer) return;
            for (const m of mutations) {
                if (!m.addedNodes || !m.addedNodes.length) continue;
                for (const node of m.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    /* 检查新加入的节点本身是否匹配 */
                    if (node.matches && node.matches(this._selectors)) {
                        if (!this._observed.has(node)) {
                            this._observer.observe(node);
                            this._observed.add(node);
                        }
                    }
                    /* 检查新加入的节点内部是否含有匹配元素 */
                    if (node.querySelectorAll) {
                        const els = node.querySelectorAll(this._selectors);
                        for (const el of els) {
                            if (!this._observed.has(el)) {
                                this._observer.observe(el);
                                this._observed.add(el);
                            }
                        }
                    }
                }
            }
        });

        const leaves = document.querySelectorAll('.workspace-leaf-content:not([data-type="canvas"])');
        for (const leaf of leaves) {
            this._mutObserver.observe(leaf, { childList: true, subtree: true });
        }
    }

    /**
     * 停止预取器，清理所有观察和样式副作用
     */
    stop() {
        if (!this._started) return;
        this._started = false;

        if (this._mutObserver) {
            this._mutObserver.disconnect();
            this._mutObserver = null;
        }

        if (this._observer) {
            this._observer.disconnect();
            this._observer = null;
        }

        /* 清除已设置的内联 contentVisibility，让 CSS 规则重新接管 */
        for (const el of this._observed) {
            if (el && el.style) {
                el.style.contentVisibility = '';
            }
        }
        this._observed.clear();

        console.log('[AindentPaper] 滚动性能预取器已停止');
    }
}

/* ===========================================================================
 * 纸质纹理 SVG 数据映射
 *
 * 纹理类型 key → SVG data URL（base64 编码）
 * JS 端统一管理纹理数据，通过 CSS 变量 --aindentpaper-paper-texture 注入，
 * 避免 CSS 中为每种纹理类型定义 body class 选择器。
 *
 * SVG 纹理特点：
 *   - 200×200px 小尺寸，合成开销极低
 *   - 使用 feTurbulence + feComponentTransfer 生成程序化噪声
 *   - 不同纹理通过 baseFrequency / numOctaves / seed / slope / intercept 区分
 * ======================================================================== */
const PAPER_TEXTURES = {
    /* kraft - 牛皮纸：暖色米黄基底 + 中频纤维噪声（提高对比度至明显可见） */
    kraft: "url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48ZGVmcz48ZmlsdGVyIGlkPSJuIiB4PSItNSUiIHk9Ii01JSIgd2lkdGg9IjExMCUiIGhlaWdodD0iMTEwJSIgc3R5bGU9ImNvbG9yLWludGVycG9sYXRpb24tZmlsdGVyczpzUkdCIj48ZmVUdXJidWxlbmNlIHR5cGU9ImZyYWN0YWxOb2lzZSIgYmFzZUZyZXF1ZW5jeT0iMC42IiBudW1PY3RhdmVzPSIzIiBzdGl0Y2hUaWxlcz0ic3RpdGNoIiBzZWVkPSI1Ii8+PGZlQ29sb3JNYXRyaXggdHlwZT0ibWF0cml4IiB2YWx1ZXM9IjAgMCAwIDAgMC43MiAgMCAwIDAgMCAwLjU4ICAwIDAgMCAwIDAuMzggIDAgMCAwIDEuMCAwIi8+PGZlQ29tcG9zaXRlIGluMj0iU291cmNlR3JhcGhpYyIgb3BlcmF0b3I9ImluIi8+PC9maWx0ZXI+PC9kZWZzPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbHRlcj0idXJsKCNuKSIgZmlsbD0iI2M0YTU3NCIvPjwvc3ZnPg==)",
    /* fine - 细腻白纸：冷白基底 + 高频细密纹理（提高对比度至明显可见） */
    fine: "url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48ZGVmcz48ZmlsdGVyIGlkPSJuIiB4PSItNSUiIHk9Ii01JSIgd2lkdGg9IjExMCUiIGhlaWdodD0iMTEwJSIgc3R5bGU9ImNvbG9yLWludGVycG9sYXRpb24tZmlsdGVyczpzUkdCIj48ZmVUdXJidWxlbmNlIHR5cGU9ImZyYWN0YWxOb2lzZSIgYmFzZUZyZXF1ZW5jeT0iMi4wIiBudW1PY3RhdmVzPSIyIiBzdGl0Y2hUaWxlcz0ic3RpdGNoIiBzZWVkPSIyIi8+PGZlQ29sb3JNYXRyaXggdHlwZT0ibWF0cml4IiB2YWx1ZXM9IjAgMCAwIDAgMC44NSAgMCAwIDAgMCAwLjg3ICAwIDAgMCAwIDAuOTAgIDAgMCAwIDEuMCAwIi8+PGZlQ29tcG9zaXRlIGluMj0iU291cmNlR3JhcGhpYyIgb3BlcmF0b3I9ImluIi8+PC9maWx0ZXI+PC9kZWZzPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbHRlcj0idXJsKCNuKSIgZmlsbD0iI2YwZjJmNSIvPjwvc3ZnPg==)",
    /* parchment - 羊皮纸：暗黄基底 + 低频大斑块 */
    parchment: "url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48ZGVmcz48ZmlsdGVyIGlkPSJuIiB4PSItNSUiIHk9Ii01JSIgd2lkdGg9IjExMCUiIGhlaWdodD0iMTEwJSIgc3R5bGU9ImNvbG9yLWludGVycG9sYXRpb24tZmlsdGVyczpzUkdCIj48ZmVUdXJidWxlbmNlIHR5cGU9ImZyYWN0YWxOb2lzZSIgYmFzZUZyZXF1ZW5jeT0iMC4yNSIgbnVtT2N0YXZlcz0iNSIgc3RpdGNoVGlsZXM9InN0aXRjaCIgc2VlZD0iOCIvPjxmZUNvbG9yTWF0cml4IHR5cGU9Im1hdHJpeCIgdmFsdWVzPSIwIDAgMCAwIDAuNjUgIDAgMCAwIDAgMC41MCAgMCAwIDAgMCAwLjMwICAwIDAgMCAwLjY1IDAiLz48ZmVDb21wb3NpdGUgaW4yPSJTb3VyY2VHcmFwaGljIiBvcGVyYXRvcj0iaW4iLz48L2ZpbHRlcj48L2RlZnM+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsdGVyPSJ1cmwoI24pIiBmaWxsPSIjZDRiODk2Ii8+PC9zdmc+)",
    /* rough - 粗纹纸：暖色浅灰基底 + 纤维 + 无规则折痕（折痕比青灰纸更清晰明显） */
    rough: "url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj4KICA8ZGVmcz4KICAgIDxmaWx0ZXIgaWQ9ImNyZWFzZSIgeD0iLTUlIiB5PSItNSUiIHdpZHRoPSIxMTAlIiBoZWlnaHQ9IjExMCUiIHN0eWxlPSJjb2xvci1pbnRlcnBvbGF0aW9uLWZpbHRlcnM6c1JHQiI+CiAgICAgIDxmZVR1cmJ1bGVuY2UgdHlwZT0idHVyYnVsZW5jZSIgYmFzZUZyZXF1ZW5jeT0iMC4wMyAwLjAwNiIgbnVtT2N0YXZlcz0iNCIgc2VlZD0iMzUiIHN0aXRjaFRpbGVzPSJzdGl0Y2giLz4KICAgICAgPGZlQ29sb3JNYXRyaXggdHlwZT0ibWF0cml4IiB2YWx1ZXM9IjAgMCAwIDAgMC40OCAgMCAwIDAgMCAwLjQ1ICAwIDAgMCAwIDAuNDAgIDAgMCAwIDAuOCAwIi8+CiAgICA8L2ZpbHRlcj4KICAgIDxmaWx0ZXIgaWQ9ImZpYmVyIiB4PSItNSUiIHk9Ii01JSIgd2lkdGg9IjExMCUiIGhlaWdodD0iMTEwJSIgc3R5bGU9ImNvbG9yLWludGVycG9sYXRpb24tZmlsdGVyczpzUkdCIj4KICAgICAgPGZlVHVyYnVsZW5jZSB0eXBlPSJmcmFjdGFsTm9pc2UiIGJhc2VGcmVxdWVuY3k9IjAuMSAwLjgiIG51bU9jdGF2ZXM9IjMiIHNlZWQ9IjQ1IiBzdGl0Y2hUaWxlcz0ic3RpdGNoIi8+CiAgICAgIDxmZUNvbG9yTWF0cml4IHR5cGU9Im1hdHJpeCIgdmFsdWVzPSIwIDAgMCAwIDAuNTIgIDAgMCAwIDAgMC41MCAgMCAwIDAgMCAwLjQ2ICAwIDAgMCAwLjU1IDAiLz4KICAgIDwvZmlsdGVyPgogIDwvZGVmcz4KICA8cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjREREOEQwIi8+CiAgPHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsdGVyPSJ1cmwoI2NyZWFzZSkiIG9wYWNpdHk9IjAuODUiLz4KICA8cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWx0ZXI9InVybCgjZmliZXIpIiBvcGFjaXR5PSIwLjY1Ii8+Cjwvc3ZnPg==)",
    /* cyan-gray - 青灰纸：浅青灰基底 + 纤维 + 无规则折痕（非噪点） */
    cyanGray: "url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj4KICA8ZGVmcz4KICAgIDxmaWx0ZXIgaWQ9ImNyZWFzZSIgeD0iLTUlIiB5PSItNSUiIHdpZHRoPSIxMTAlIiBoZWlnaHQ9IjExMCUiIHN0eWxlPSJjb2xvci1pbnRlcnBvbGF0aW9uLWZpbHRlcnM6c1JHQiI+CiAgICAgIDxmZVR1cmJ1bGVuY2UgdHlwZT0idHVyYnVsZW5jZSIgYmFzZUZyZXF1ZW5jeT0iMC4wMjUgMC4wMDUiIG51bU9jdGF2ZXM9IjQiIHNlZWQ9IjMwIiBzdGl0Y2hUaWxlcz0ic3RpdGNoIi8+CiAgICAgIDxmZUNvbG9yTWF0cml4IHR5cGU9Im1hdHJpeCIgdmFsdWVzPSIwIDAgMCAwIDAuNTAgIDAgMCAwIDAgMC41NiAgMCAwIDAgMCAwLjYwICAwIDAgMCAwLjU1IDAiLz4KICAgIDwvZmlsdGVyPgogICAgPGZpbHRlciBpZD0iZmliZXIiIHg9Ii01JSIgeT0iLTUlIiB3aWR0aD0iMTEwJSIgaGVpZ2h0PSIxMTAlIiBzdHlsZT0iY29sb3ItaW50ZXJwb2xhdGlvbi1maWx0ZXJzOnNSR0IiPgogICAgICA8ZmVUdXJidWxlbmNlIHR5cGU9ImZyYWN0YWxOb2lzZSIgYmFzZUZyZXF1ZW5jeT0iMC4xMiAwLjg1IiBudW1PY3RhdmVzPSIzIiBzZWVkPSI0MiIgc3RpdGNoVGlsZXM9InN0aXRjaCIvPgogICAgICA8ZmVDb2xvck1hdHJpeCB0eXBlPSJtYXRyaXgiIHZhbHVlcz0iMCAwIDAgMCAwLjQ4ICAwIDAgMCAwIDAuNTUgIDAgMCAwIDAgMC42MCAgMCAwIDAgMC41NSAwIi8+CiAgICA8L2ZpbHRlcj4KICA8L2RlZnM+CiAgPHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0iI0Q4RTBFNCIvPgogIDxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbHRlcj0idXJsKCNjcmVhc2UpIiBvcGFjaXR5PSIwLjc1Ii8+CiAgPHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsdGVyPSJ1cmwoI2ZpYmVyKSIgb3BhY2l0eT0iMC42Ii8+Cjwvc3ZnPg==)",
    /* frosted-glass - 磨砂玻璃：半透明白色基底 + 细腻磨砂颗粒感 */
    frostedGlass: "url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj4KICA8ZGVmcz4KICAgIDxmaWx0ZXIgaWQ9ImZyb3N0IiB4PSItNSUiIHk9Ii01JSIgd2lkdGg9IjExMCUiIGhlaWdodD0iMTEwJSIgc3R5bGU9ImNvbG9yLWludGVycG9sYXRpb24tZmlsdGVyczpzUkdCIj4KICAgICAgPGZlVHVyYnVsZW5jZSB0eXBlPSJmcmFjdGFsTm9pc2UiIGJhc2VGcmVxdWVuY3k9IjAuOSIgbnVtT2N0YXZlcz0iNCIgc2VlZD0iNjAiIHN0aXRjaFRpbGVzPSJzdGl0Y2giLz4KICAgICAgPGZlQ29sb3JNYXRyaXggdHlwZT0ibWF0cml4IiB2YWx1ZXM9IjAgMCAwIDAgMC45MiAgMCAwIDAgMCAwLjk0ICAwIDAgMCAwIDAuOTYgIDAgMCAwIDAuMzUgMCIvPgogICAgPC9maWx0ZXI+CiAgICA8ZmlsdGVyIGlkPSJmcm9zdEJsdXIiIHg9Ii01JSIgeT0iLTUlIiB3aWR0aD0iMTEwJSIgaGVpZ2h0PSIxMTAlIiBzdHlsZT0iY29sb3ItaW50ZXJwb2xhdGlvbi1maWx0ZXJzOnNSR0IiPgogICAgICA8ZmVUdXJidWxlbmNlIHR5cGU9ImZyYWN0YWxOb2lzZSIgYmFzZUZyZXF1ZW5jeT0iMC40NSIgbnVtT2N0YXZlcz0iMiIgc2VlZD0iNzAiIHN0aXRjaFRpbGVzPSJzdGl0Y2giLz4KICAgICAgPGZlQ29sb3JNYXRyaXggdHlwZT0ibWF0cml4IiB2YWx1ZXM9IjAgMCAwIDAgMC44OCAgMCAwIDAgMCAwLjkwICAwIDAgMCAwIDAuOTMgIDAgMCAwIDAuMiAwIi8+CiAgICA8L2ZpbHRlcj4KICA8L2RlZnM+CiAgPHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0iI0U4RUNGMCIvPgogIDxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbHRlcj0idXJsKCNmcm9zdEJsdXIpIiBvcGFjaXR5PSIwLjYiLz4KICA8cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWx0ZXI9InVybCgjZnJvc3QpIiBvcGFjaXR5PSIwLjUiLz4KPC9zdmc+)",
    /* grid - 网格背景：由 CSS 变量和独立 body class 控制，不使用 SVG data URL */
    grid: "grid",
    /* none - 无纹理：纯背景色，没有任何纹理 */
    none: "none",
};

/* ===========================================================================
 * 设置分组定义
 * ======================================================================== */
const SETTING_GROUPS = [
    {
        id: 'aindentpaper-paragraph-indent-enabled',
        name: '启用段落首行缩进',
        desc: '预览视图段落首行缩进',
        default: false,
        children: [
            { type: 'var-toggle', id: 'paragraph-indent-enabled', name: '段落首行缩进', desc: '', varName: '--paragraph-indent-enabled', default: 0 },
            { type: 'slider', id: 'text-paragraph-gap', name: '文本段间距', varName: '--text-paragraph-gap', default: 2.0, min: 1, max: 10, step: 0.1 },
            { type: 'slider', id: 'text-line-height', name: '文本行高 (px)', varName: '--text-line-height', default: 24, min: 20, max: 40, step: 1 },
        ]
    },
    {
        id: 'aindentpaper-paper-texture-enabled',
        name: '启用纸质纹理背景',
        desc: '为笔记编辑和预览视图添加纸质纹理背景效果',
        default: false,
        children: [
            { type: 'paper-texture-select', id: 'paper-texture-type', name: '纸质纹理样式', desc: '选择笔记内容的纸质纹理背景样式', default: 'kraft',
              options: [
                { value: 'kraft', label: '牛皮纸' },
                { value: 'fine', label: '细腻白纸' },
                { value: 'parchment', label: '旧纸/羊皮纸' },
                { value: 'rough', label: '粗纹纸' },
                { value: 'cyanGray', label: '青灰纸' },
                { value: 'frostedGlass', label: '磨砂玻璃' },
                { value: 'grid', label: '网格背景' },
                { value: 'none', label: '无纹理' },
              ]
            },
            { type: 'slider', id: 'paper-texture-opacity', name: '纹理透明度', varName: '--aindentpaper-paper-texture-opacity', default: 0.6, min: 0, max: 1, step: 0.05 },
            { type: 'class-toggle-sub', id: 'aindentpaper-canvas-paper-texture', name: '白板幕布纸质纹理', desc: '开启后，白板的整个幕布背景显示纸质纹理效果', default: false },
        ]
    },
];

/* ===========================================================================
 * 默认设置生成
 * ======================================================================== */
function buildDefaultSettings() {
    const defaults = { paragraphSplitterEnabled: false, scrollPerfEnabled: false };
    for (const group of SETTING_GROUPS) {
        defaults[group.id] = group.default;
        if (group.children) {
            for (const child of group.children) {
                if (child.type === 'heading') continue;
                defaults[child.id] = child.default;
            }
        }
    }
    /* 网格背景子设置默认值 */
    defaults['grid-line-color-light'] = '#000000';
    defaults['grid-line-color-dark'] = '#ffffff';
    defaults['grid-size'] = 20;
    defaults['grid-line-width'] = 1;
    defaults['grid-line-style'] = 'solid';
    return defaults;
}

const DEFAULT_SETTINGS = buildDefaultSettings();

/* ===========================================================================
 * 主插件类
 * ======================================================================== */
class FirstLineIndentPlugin extends Plugin {
    async onload() {
        let savedSettings = {};
        try {
            savedSettings = (await this.loadData()) || {};
        } catch (e) {
            console.warn('[AindentPaper] 加载设置失败:', e);
        }

        /* 迁移旧设置：firstlindent-* → aindentpaper-* */
        const migrationMap = {
            'firstlindent-paragraph-indent-enabled': 'aindentpaper-paragraph-indent-enabled',
            'firstlindent-paper-texture-enabled': 'aindentpaper-paper-texture-enabled',
        };
        let migrated = false;
        for (const [oldKey, newKey] of Object.entries(migrationMap)) {
            if (savedSettings[oldKey] !== undefined && savedSettings[newKey] === undefined) {
                savedSettings[newKey] = savedSettings[oldKey];
                delete savedSettings[oldKey];
                migrated = true;
            }
        }
        if (migrated) {
            console.log('[AindentPaper] 已迁移旧设置到新的 key');
            try {
                await this.saveData(savedSettings);
            } catch (e) {
                console.warn('[AindentPaper] 迁移设置保存失败:', e);
            }
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);

        this.splitter = new ParagraphSplitter();
        this.scrollPerfPrefetcher = new ScrollPerfPrefetcher();

        this.addSettingTab(new FirstLineIndentSettingTab(this.app, this));

        /* 初始加载时避免 applyAllSettings 过早启动 splitter
           等 Obsidian 工作区布局完全渲染后再启动 */
        const splitter = this.splitter;
        this.splitter = null;
        this.applyAllSettings();
        this.splitter = splitter;

        if (this.settings.paragraphSplitterEnabled) {
            this.app.workspace.onLayoutReady(() => {
                // 初始只扫描当前激活的 Markdown 视图，避免长文本启动时全量扫描 document.body
                const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (activeView && activeView.previewMode && activeView.previewMode.containerEl) {
                    this.splitter.processContainer(activeView.previewMode.containerEl);
                }
                // 启动 Observer 监听后续变化，跳过全量扫描
                this.splitter.setEnabled(true, true);
            });
        }

        /* 滚动性能优化预取器：等布局就绪后启动 */
        if (this.settings.scrollPerfEnabled) {
            this.app.workspace.onLayoutReady(() => {
                this.scrollPerfPrefetcher.start();
            });
        }

        /* =====================================================================
         * MarkdownPostProcessor — 段落拆分（PDF 导出 / 打印支持）
         * =====================================================================
         * Obsidian 导出 PDF 时使用独立渲染上下文，MutationObserver 不存在，
         * 但 registerMarkdownPostProcessor 回调仍会执行。
         * 此处注册轻量级拆分逻辑，确保 PDF 导出时每个段落都能被正确拆分
         * 从而获得独立的 text-indent。
         * 
         * 与 MutationObserver 的共存：
         *   - PostProcessor 先执行（渲染阶段），设置 data-split-group
         *   - Observer 后触发（mutation 回调），检测到 data-split-group 自动跳过
         *   - 不会发生重复拆分
         * ===================================================================== */
        let ppSplitCounter = 0;
        this.registerMarkdownPostProcessor((el) => {
            if (!this.settings.paragraphSplitterEnabled) return;

            const paragraphs = el.querySelectorAll('p:not([data-split-group])');
            if (paragraphs.length === 0) return;

            for (const p of paragraphs) {
                // 快速检查：是否含有 <br> 子元素
                let hasBr = false;
                for (const child of p.childNodes) {
                    if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
                        hasBr = true;
                        break;
                    }
                }
                if (!hasBr) continue;

                // 排除：列表/表格/引用/callout/数学/嵌入 内的段落
                if (p.closest('li, table, blockquote, .callout, .math, .math-block, .internal-embed, .external-embed')) continue;

                // 执行拆分：以 <br> 为边界分割为多个段落
                const segments = [];
                let current = [];
                for (const node of Array.from(p.childNodes)) {
                    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
                        segments.push(current);
                        current = [];
                    } else {
                        current.push(node);
                    }
                }
                segments.push(current);

                // 过滤空段
                const validSegments = segments.filter(seg =>
                    seg.some(n =>
                        (n.nodeType === Node.TEXT_NODE && n.nodeValue.trim() !== '') ||
                        n.nodeType === Node.ELEMENT_NODE
                    )
                );
                if (validSegments.length <= 1) continue;

                ppSplitCounter++;
                const groupId = 'pp' + ppSplitCounter;
                const parent = p.parentNode;
                if (!parent) continue;

                const fragment = document.createDocumentFragment();
                for (const segNodes of validSegments) {
                    const newP = document.createElement('p');
                    if (p.className) newP.className = p.className;
                    newP.setAttribute('data-split-group', groupId);
                    for (const n of segNodes) newP.appendChild(n);
                    fragment.appendChild(newP);
                }
                parent.replaceChild(fragment, p);
            }
        });

        /* =====================================================================
         * MarkdownPostProcessor — 非段落元素缩进排除
         * =====================================================================
         * 检测阅读视图中仅包含标签(#tag)、内部链接([[...]])、外部链接、
         * 图片、嵌入等非文本内容的 <p> 元素，标记 data-no-indent 属性
         * 以便 CSS 排除其首行缩进。
         * 运行时机：每个 section 渲染时执行一次，包括 PDF 导出。
         * ===================================================================== */
        this.registerMarkdownPostProcessor((el) => {
            const paragraphs = el.querySelectorAll('p:not([data-no-indent])');
            if (paragraphs.length === 0) return;

            for (const p of paragraphs) {
                // 快速跳过：如果有非空白文本节点，说明是正常段落，不处理
                let hasText = false;
                let hasNonTextElement = false;

                for (const node of p.childNodes) {
                    if (node.nodeType === Node.TEXT_NODE) {
                        if (node.nodeValue.trim() !== '') {
                            hasText = true;
                            break;
                        }
                    } else if (node.nodeType === Node.ELEMENT_NODE) {
                        hasNonTextElement = true;
                    }
                }

                // 有文本内容 → 正常段落，保留缩进
                if (hasText) continue;
                // 无任何元素 → 空段落，跳过
                if (!hasNonTextElement) continue;

                // 检查所有子元素是否都是“非段落文本”类型
                let allNonText = true;
                for (const node of p.childNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    const el = node;
                    // 允许的非段落元素：标签、内部链接、外部链接、图片、嵌入
                    if (el.matches('a.tag, a.internal-link, a.external-link, img, .internal-embed, .external-embed, br')) continue;
                    // 其它元素（如 <strong>、<em>、<code>）→ 这是带格式的文本段落
                    allNonText = false;
                    break;
                }

                if (allNonText) {
                    p.setAttribute('data-no-indent', '');
                }
            }
        });
        
        this.addCommand({
            id: 'aindentpaper-rescan-paragraphs',
            name: '重新扫描并拆分段落',
            callback: () => {
                if (this.splitter && this.settings.paragraphSplitterEnabled) {
                    this.splitter.scheduleProcess(document.body);
                    new Notice('AindentPaper: 已重新扫描段落');
                } else {
                    new Notice('AindentPaper: 段落拆分器未启用');
                }
            }
        });

        this.addCommand({
            id: 'aindentpaper-toggle-splitter',
            name: '切换段落拆分器开关',
            callback: () => {
                this.settings.paragraphSplitterEnabled = !this.settings.paragraphSplitterEnabled;
                this.saveSettings();
                this.splitter.setEnabled(this.settings.paragraphSplitterEnabled);
                document.body.classList.toggle('aindentpaper-splitter-enabled', this.settings.paragraphSplitterEnabled);
                new Notice(`AindentPaper: 段落拆分器已${this.settings.paragraphSplitterEnabled ? '启用' : '禁用'}`);
            }
        });

        this.addCommand({
            id: 'aindentpaper-reset-settings',
            name: '重置所有设置为默认值',
            callback: () => {
                this.settings = Object.assign({}, DEFAULT_SETTINGS);
                this.saveSettings();
                this.applyAllSettings();
                new Notice('AindentPaper: 已重置所有设置为默认值');
            }
        });

        console.log('[AindentPaper] 插件已加载');
    }

    onunload() {
        if (this.splitter) {
            this.splitter.stop();
            this.splitter = null;
        }

        if (this.scrollPerfPrefetcher) {
            this.scrollPerfPrefetcher.stop();
            this.scrollPerfPrefetcher = null;
        }

        /* 完整清理：移除插件添加的所有 body 类和内联 CSS 变量
           确保禁用插件后不残留任何视觉副作用 */
        const body = document.body;
        const root = document.documentElement;

        // 移除 SETTING_GROUPS 中的 body 类
        for (const group of SETTING_GROUPS) {
            body.classList.remove(group.id);
            if (group.children) {
                for (const child of group.children) {
                    if (child.type === 'class-toggle-sub') {
                        body.classList.remove(child.id);
                    }
                }
            }
        }

        // 移除性能优化 body 类
        body.classList.remove('aindentpaper-scroll-perf-enabled');

        // 移除段落拆分器 body 类
        body.classList.remove('aindentpaper-splitter-enabled');

        // 移除网格线样式类
        body.classList.remove('aindentpaper-grid-line-solid');
        body.classList.remove('aindentpaper-grid-line-dashed');

        // 移除插件设置的所有内联 CSS 变量
        for (const group of SETTING_GROUPS) {
            if (!group.children) continue;
            for (const child of group.children) {
                if (child.varName) {
                    root.style.removeProperty(child.varName);
                    body.style.removeProperty(child.varName);
                }
            }
        }
        // 清理额外已知变量（网格/纹理相关）
        const extraVars = [
            '--aindentpaper-paper-texture',
            '--aindentpaper-grid-line-color-light',
            '--aindentpaper-grid-line-color-dark',
            '--aindentpaper-grid-size',
            '--aindentpaper-grid-line-width',
        ];
        for (const v of extraVars) {
            root.style.removeProperty(v);
            body.style.removeProperty(v);
        }

        console.log('[AindentPaper] 插件已卸载，所有副作用已清理');
    }

    async saveSettings() {
        try {
            await this.saveData(this.settings);
        } catch (e) {
            console.warn('[AindentPaper] 保存设置失败:', e);
        }
    }

    applyAllSettings() {
        const body = document.body;
        const root = document.documentElement;

        for (const group of SETTING_GROUPS) {
            const enabled = this.settings[group.id] !== false;
            body.classList.toggle(group.id, enabled);
        }

        for (const group of SETTING_GROUPS) {
            if (!group.children) continue;
            for (const child of group.children) {
                if (child.type === 'heading') continue;
                const val = this.settings[child.id];

                if (child.type === 'class-toggle-sub') {
                    body.classList.toggle(child.id, val === true);
                    continue;
                }

                /* 纸质纹理类型：短 key → SVG data URL 转换 */
                if (child.type === 'paper-texture-select') {
                    this.applyPaperTextureType(val || child.default);
                    continue;
                }

                if (val !== undefined && val !== null && val !== '') {
                    let finalVal = String(val);
                    if (child.type === 'number' && child.format) {
                        finalVal = `${val}${child.format}`;
                    }
                    this.applyVariable(child.varName, finalVal);
                }
            }
        }

        if (this.splitter) {
            this.splitter.setEnabled(this.settings.paragraphSplitterEnabled !== false);
        }

        /* 应用段落拆分器 body 类（独立于 SETTING_GROUPS） */
        body.classList.toggle('aindentpaper-splitter-enabled', this.settings.paragraphSplitterEnabled !== false);

        /* 应用滚动性能优化开关 */
        const scrollPerfOn = this.settings.scrollPerfEnabled === true;
        document.body.classList.toggle('aindentpaper-scroll-perf-enabled', scrollPerfOn);
        if (this.scrollPerfPrefetcher) {
            if (scrollPerfOn) {
                this.scrollPerfPrefetcher.start();
            } else {
                this.scrollPerfPrefetcher.stop();
            }
        }

        /* 应用网格背景相关设置（即使当前未选择 grid，也预置变量便于切换） */
        this.applyGridSettings();
    }

    applyClassToggle(id, enabled) {
        document.body.classList.toggle(id, enabled);
    }

    applyVariable(varName, value) {
        if (value === undefined || value === null || value === '') {
            document.documentElement.style.removeProperty(varName);
            document.body.style.removeProperty(varName);
        } else {
            const strVal = String(value);
            document.documentElement.style.setProperty(varName, strVal, 'important');
            document.body.style.setProperty(varName, strVal, 'important');
        }
    }

    /**
     * 将纸质纹理类型短 key 转换为纹理数据并设置 CSS 变量 / body class
     * 当选择 "none" 时，移除所有纹理相关类，使主题原始背景自然显示
     * 当选择 "grid" 时，使用独立 body class 渲染 CSS 网格背景（不使用 SVG / ::before）
     * @param {string} typeKey - 纹理类型 key（kraft / fine / parchment / rough / cyanGray / frostedGlass / grid / none）
     */
    applyPaperTextureType(typeKey) {
        const textureUrl = PAPER_TEXTURES[typeKey] || PAPER_TEXTURES['kraft'];
        
        if (typeKey === 'none') {
            // 无纹理：移除所有纹理相关类
            document.body.classList.remove('aindentpaper-paper-texture-enabled');
            document.body.classList.remove('aindentpaper-paper-texture-grid');
        } else if (typeKey === 'grid') {
            // 网格背景：依赖独立 body class，不使用 ::before 伪元素
            document.body.classList.remove('aindentpaper-paper-texture-grid');
            if (this.settings['aindentpaper-paper-texture-enabled']) {
                document.body.classList.add('aindentpaper-paper-texture-enabled');
                document.body.classList.add('aindentpaper-paper-texture-grid');
            }
        } else {
            // 纸质纹理
            document.body.classList.remove('aindentpaper-paper-texture-grid');
            if (this.settings['aindentpaper-paper-texture-enabled']) {
                document.body.classList.add('aindentpaper-paper-texture-enabled');
            }
        }
        
        // 网格模式不使用 SVG 纹理变量
        this.applyVariable('--aindentpaper-paper-texture', typeKey === 'grid' ? 'none' : textureUrl);
    }

    /**
     * 应用网格背景相关设置
     */
    applyGridSettings() {
        this.applyGridLineColor('light', this.settings['grid-line-color-light'] || '#000000');
        this.applyGridLineColor('dark', this.settings['grid-line-color-dark'] || '#ffffff');
        this.applyVariable('--aindentpaper-grid-size', `${this.settings['grid-size'] || 20}px`);
        this.applyVariable('--aindentpaper-grid-line-width', `${this.settings['grid-line-width'] || 1}px`);
        this.applyGridLineStyle(this.settings['grid-line-style'] || 'solid');
    }

    /**
     * 将 HEX 颜色转换为半透明 RGBA 并应用为网格线颜色变量
     * @param {string} mode - 'light' 或 'dark'
     * @param {string} hex - HEX 颜色值
     */
    applyGridLineColor(mode, hex) {
        const varName = mode === 'dark' ? '--aindentpaper-grid-line-color-dark' : '--aindentpaper-grid-line-color-light';
        this.applyVariable(varName, hexToRgba(hex, 0.08));
    }

    /**
     * 切换网格线实线/虚线 body class
     * @param {string} style - 'solid' 或 'dashed'
     */
    applyGridLineStyle(style) {
        document.body.classList.toggle('aindentpaper-grid-line-solid', style === 'solid');
        document.body.classList.toggle('aindentpaper-grid-line-dashed', style === 'dashed');
    }

    startSplitter() {
        const start = () => this.splitter.start();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            setTimeout(start, 0);
        }
    }
}

/* ===========================================================================
 * 插件设置面板
 * ======================================================================== */
class FirstLineIndentSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.gridSettingsContainer = null;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('div', {
            text: 'AindentPaper - 段落首行缩进插件。打开功能开关后，下方会展开对应的细节调整项。修改即时生效。',
            cls: 'setting-item-description'
        });

        for (const group of SETTING_GROUPS) {
            const isEnabled = this.plugin.settings[group.id] !== false;

            const groupEl = containerEl.createDiv({ cls: 'aindentpaper-group' });

            const toggleSetting = new Setting(groupEl)
                .setName(group.name)
                .setDesc(group.desc || '')
                .addToggle(toggle => toggle
                    .setValue(isEnabled)
                    .onChange(async (value) => {
                        this.plugin.settings[group.id] = value;
                        this.plugin.applyClassToggle(group.id, value);
                        if (childContainer) {
                            childContainer.style.display = value ? 'block' : 'none';
                        }
                        if (arrowEl) {
                            arrowEl.innerHTML = value ? '∨' : '>';
                        }
                        await this.plugin.saveSettings();
                    }));

            const hasChildren = group.children && group.children.length > 0;
            let arrowEl = null;
            if (hasChildren) {
                arrowEl = toggleSetting.settingEl.createDiv({ cls: 'aindentpaper-collapse-arrow' });
                arrowEl.innerHTML = isEnabled ? '∨' : '>';
                arrowEl.style.cursor = 'pointer';
                arrowEl.style.marginRight = '8px';
                arrowEl.style.fontSize = '14px';
                arrowEl.style.fontWeight = 'bold';
                arrowEl.style.transition = 'transform 0.2s';
                arrowEl.style.userSelect = 'none';
                arrowEl.style.flexShrink = '0';
                arrowEl.style.color = 'var(--text-muted)';
                toggleSetting.settingEl.insertBefore(arrowEl, toggleSetting.settingEl.firstChild);
            }

            let childContainer = null;
            if (hasChildren) {
                childContainer = groupEl.createDiv({ cls: 'aindentpaper-child-container' });
                childContainer.style.paddingLeft = '24px';
                childContainer.style.borderLeft = '2px solid var(--background-modifier-border)';
                childContainer.style.marginLeft = '12px';
                childContainer.style.marginBottom = '12px';
                childContainer.style.display = isEnabled ? 'block' : 'none';
            }

            if (hasChildren) {
                toggleSetting.settingEl.style.cursor = 'pointer';
                toggleSetting.settingEl.addEventListener('click', (evt) => {
                    if (evt.target.closest('.toggle')) return;
                    const isExpanded = childContainer.style.display !== 'none';
                    childContainer.style.display = isExpanded ? 'none' : 'block';
                    if (arrowEl) arrowEl.innerHTML = isExpanded ? '>' : '∨';
                });
            }

            if (group.children && group.children.length > 0) {
                for (const child of group.children) {
                    if (child.type === 'heading') {
                        new Setting(childContainer)
                            .setName(child.title)
                            .setHeading();
                    } else {
                        this.renderVarSetting(child, childContainer);
                        if (child.type === 'paper-texture-select') {
                            this.gridSettingsContainer = childContainer.createDiv({ cls: 'aindentpaper-grid-settings' });
                            this.gridSettingsContainer.style.paddingLeft = '24px';
                            this.gridSettingsContainer.style.borderLeft = '2px solid var(--background-modifier-border)';
                            this.gridSettingsContainer.style.marginLeft = '12px';
                            this.gridSettingsContainer.style.marginBottom = '12px';
                            this.gridSettingsContainer.style.display = this.plugin.settings['paper-texture-type'] === 'grid' ? 'block' : 'none';
                            this.renderGridSettings(this.gridSettingsContainer);
                        }
                    }
                }
            }
        }

        new Setting(containerEl)
            .setName('段落拆分器（独立开关）')
            .setDesc('控制 <br> 自动拆分功能的总开关。即使关闭了"段落首行缩进"，仍可独立控制是否拆分。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.paragraphSplitterEnabled !== false)
                .onChange(async (value) => {
                    this.plugin.settings.paragraphSplitterEnabled = value;
                    this.plugin.splitter.setEnabled(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('长文本滚动性能优化(实验性功能)')
            .setDesc('优化预览视图快速滚动时的卡顿问题。使用 content-visibility 跳过屏幕外元素渲染，缓解长文本（10万字+）阅读体验。完全独立于其他功能，可随时开关，按需使用。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.scrollPerfEnabled === true)
                .onChange(async (value) => {
                    this.plugin.settings.scrollPerfEnabled = value;
                    document.body.classList.toggle('aindentpaper-scroll-perf-enabled', value);
                    if (this.plugin.scrollPerfPrefetcher) {
                        if (value) {
                            this.plugin.scrollPerfPrefetcher.start();
                        } else {
                            this.plugin.scrollPerfPrefetcher.stop();
                        }
                    }
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('重置所有设置')
            .setDesc('将所有 AindentPaper 设置恢复为默认值。')
            .addButton(btn => btn
                .setButtonText('重置')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
                    this.plugin.applyAllSettings();
                    await this.plugin.saveSettings();
                    this.display();
                    new Notice('AindentPaper: 已重置为默认值');
                }));
    }

    renderVarSetting(v, container) {
        const setting = new Setting(container)
            .setName(v.name);

        if (v.desc) setting.setDesc(v.desc);

        const currentVal = this.plugin.settings[v.id];

        switch (v.type) {
            case 'text':
                setting.addText(text => text
                    .setValue(currentVal !== undefined ? String(currentVal) : '')
                    .setPlaceholder(v.default)
                    .onChange(async (value) => {
                        this.plugin.settings[v.id] = value;
                        this.plugin.applyVariable(v.varName, value);
                        await this.plugin.saveSettings();
                    }));
                break;

            case 'number':
                setting.addText(text => {
                    text.inputEl.type = 'number';
                    if (v.min !== undefined) text.inputEl.min = String(v.min);
                    if (v.max !== undefined) text.inputEl.max = String(v.max);
                    text.setValue(currentVal !== undefined ? String(currentVal) : '')
                        .setPlaceholder(String(v.default))
                        .onChange(async (value) => {
                            const num = parseFloat(value);
                            const finalNum = isNaN(num) ? v.default : num;
                            this.plugin.settings[v.id] = finalNum;
                            const finalVal = v.format ? `${finalNum}${v.format}` : String(finalNum);
                            this.plugin.applyVariable(v.varName, finalVal);
                            await this.plugin.saveSettings();
                        });
                });
                break;

            case 'slider':
                setting.addSlider(slider => slider
                    .setLimits(v.min, v.max, v.step)
                    .setValue(currentVal !== undefined ? Number(currentVal) : v.default)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings[v.id] = value;
                        this.plugin.applyVariable(v.varName, value);
                        await this.plugin.saveSettings();
                    }));
                break;

            case 'select':
                setting.addDropdown(dropdown => {
                    dropdown.addOptions(Object.fromEntries(
                        v.options.map(o => [o.value, o.label])
                    ));
                    dropdown.setValue(currentVal !== undefined ? String(currentVal) : String(v.default));
                    dropdown.onChange(async (value) => {
                        this.plugin.settings[v.id] = value;
                        this.plugin.applyVariable(v.varName, value);
                        await this.plugin.saveSettings();
                    });
                });
                break;

            case 'color':
                setting.addColorPicker(picker => {
                    picker.setValue(currentVal !== undefined ? String(currentVal) : v.default);
                    picker.onChange(async (value) => {
                        const hex = value;
                        this.plugin.settings[v.id] = hex;
                        this.plugin.applyVariable(v.varName, hex);
                        await this.plugin.saveSettings();
                    });
                });
                break;

            case 'var-toggle':
                setting.addToggle(toggle => toggle
                    .setValue(currentVal === 1 || currentVal === '1' || currentVal === true)
                    .onChange(async (value) => {
                        const numVal = value ? 1 : 0;
                        this.plugin.settings[v.id] = numVal;
                        this.plugin.applyVariable(v.varName, numVal);
                        await this.plugin.saveSettings();
                    }));
                break;

            case 'class-toggle-sub':
                setting.addToggle(toggle => toggle
                    .setValue(currentVal === true || currentVal === 'true')
                    .onChange(async (value) => {
                        this.plugin.settings[v.id] = value;
                        document.body.classList.toggle(v.id, value);
                        await this.plugin.saveSettings();
                    }));
                break;

            case 'paper-texture-select':
                setting.addDropdown(dropdown => {
                    dropdown.addOptions(Object.fromEntries(
                        v.options.map(o => [o.value, o.label])
                    ));
                    dropdown.setValue(currentVal !== undefined ? String(currentVal) : String(v.default));
                    dropdown.onChange(async (value) => {
                        this.plugin.settings[v.id] = value;
                        this.plugin.applyPaperTextureType(value);
                        this.toggleGridSettings(value === 'grid');
                        await this.plugin.saveSettings();
                    });
                });
                break;

            default:
                setting.setDesc(`（未支持的类型：${v.type}）`);
        }

        setting.addExtraButton(btn => {
            btn.setIcon('rotate-ccw');
            btn.setTooltip('恢复默认值');
            btn.onClick(async () => {
                this.plugin.settings[v.id] = v.default;
                if (v.type === 'paper-texture-select') {
                    this.plugin.applyPaperTextureType(v.default);
                } else {
                    let defaultVal = v.default;
                    if (v.type === 'number' && v.format) {
                        defaultVal = `${v.default}${v.format}`;
                    }
                    this.plugin.applyVariable(v.varName, defaultVal);
                }
                await this.plugin.saveSettings();
                this.display();
            });
        });
    }

    /**
     * 切换网格背景子设置项容器的显示/隐藏
     */
    toggleGridSettings(show) {
        if (this.gridSettingsContainer) {
            this.gridSettingsContainer.style.display = show ? 'block' : 'none';
        }
    }

    /**
     * 渲染网格背景子设置项
     */
    renderGridSettings(container) {
        container.empty();

        /* 网格线颜色 - 浅色模式 */
        new Setting(container)
            .setName('网格线颜色（浅色模式）')
            .addColorPicker(picker => {
                picker.setValue(this.plugin.settings['grid-line-color-light'] || '#000000')
                    .onChange(async (value) => {
                        this.plugin.settings['grid-line-color-light'] = value;
                        this.plugin.applyGridLineColor('light', value);
                        await this.plugin.saveSettings();
                    });
            })
            .addExtraButton(btn => {
                btn.setIcon('rotate-ccw');
                btn.setTooltip('恢复默认值');
                btn.onClick(async () => {
                    this.plugin.settings['grid-line-color-light'] = '#000000';
                    this.plugin.applyGridLineColor('light', '#000000');
                    await this.plugin.saveSettings();
                    this.renderGridSettings(container);
                });
            });

        /* 网格线颜色 - 深色模式 */
        new Setting(container)
            .setName('网格线颜色（深色模式）')
            .addColorPicker(picker => {
                picker.setValue(this.plugin.settings['grid-line-color-dark'] || '#ffffff')
                    .onChange(async (value) => {
                        this.plugin.settings['grid-line-color-dark'] = value;
                        this.plugin.applyGridLineColor('dark', value);
                        await this.plugin.saveSettings();
                    });
            })
            .addExtraButton(btn => {
                btn.setIcon('rotate-ccw');
                btn.setTooltip('恢复默认值');
                btn.onClick(async () => {
                    this.plugin.settings['grid-line-color-dark'] = '#ffffff';
                    this.plugin.applyGridLineColor('dark', '#ffffff');
                    await this.plugin.saveSettings();
                    this.renderGridSettings(container);
                });
            });

        /* 网格大小 */
        new Setting(container)
            .setName('网格大小')
            .setDesc('单位：像素')
            .addSlider(slider => slider
                .setLimits(5, 100, 1)
                .setValue(this.plugin.settings['grid-size'] || 20)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings['grid-size'] = value;
                    this.plugin.applyVariable('--aindentpaper-grid-size', `${value}px`);
                    await this.plugin.saveSettings();
                }))
            .addExtraButton(btn => {
                btn.setIcon('rotate-ccw');
                btn.setTooltip('恢复默认值');
                btn.onClick(async () => {
                    this.plugin.settings['grid-size'] = 20;
                    this.plugin.applyVariable('--aindentpaper-grid-size', '20px');
                    await this.plugin.saveSettings();
                    this.renderGridSettings(container);
                });
            });

        /* 网格线粗细 */
        new Setting(container)
            .setName('网格线粗细')
            .setDesc('单位：像素')
            .addSlider(slider => slider
                .setLimits(0.5, 5, 0.5)
                .setValue(this.plugin.settings['grid-line-width'] || 1)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings['grid-line-width'] = value;
                    this.plugin.applyVariable('--aindentpaper-grid-line-width', `${value}px`);
                    await this.plugin.saveSettings();
                }))
            .addExtraButton(btn => {
                btn.setIcon('rotate-ccw');
                btn.setTooltip('恢复默认值');
                btn.onClick(async () => {
                    this.plugin.settings['grid-line-width'] = 1;
                    this.plugin.applyVariable('--aindentpaper-grid-line-width', '1px');
                    await this.plugin.saveSettings();
                    this.renderGridSettings(container);
                });
            });

        /* 网格线样式 */
        new Setting(container)
            .setName('网格线样式')
            .addDropdown(dropdown => {
                dropdown.addOptions({ solid: '实线', dashed: '虚线' });
                dropdown.setValue(this.plugin.settings['grid-line-style'] || 'solid');
                dropdown.onChange(async (value) => {
                    this.plugin.settings['grid-line-style'] = value;
                    this.plugin.applyGridLineStyle(value);
                    await this.plugin.saveSettings();
                });
            })
            .addExtraButton(btn => {
                btn.setIcon('rotate-ccw');
                btn.setTooltip('恢复默认值');
                btn.onClick(async () => {
                    this.plugin.settings['grid-line-style'] = 'solid';
                    this.plugin.applyGridLineStyle('solid');
                    await this.plugin.saveSettings();
                    this.renderGridSettings(container);
                });
            });
    }
}

/* ===========================================================================
 * Obsidian 插件导出
 * ======================================================================== */
module.exports = FirstLineIndentPlugin;
module.exports.default = FirstLineIndentPlugin;
