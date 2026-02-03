// ==UserScript==
// @name         LZ Auto Input (debug v2.4 timing + submit fix)
// @namespace    https://tampermonkey.net/
// @version      0.2.4
// @description  自动打开“添加”layui iframe，选择轮转科室/病历号/日期/住院病历/主要诊断/技能/备注，并保存；支持批量（修复：重复提交/主要诊断时序）
// @match        http://222.247.54.182:10082/*
// @run-at       document-end
// @noframes
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    // 单实例 + 只在top
    if (window.top !== window.self) return;
    if (window.__LZ_AUTO_BOOTED__) return;
    window.__LZ_AUTO_BOOTED__ = true;

    const CFG = {
        TARGET_DEPT_NAME: '麻醉科 (2025-04-01~2025-08-31)',
        DATE_FALLBACK: '2025-04-01',
        PICK_MAIN_DIAG_COUNT: 1,
        PICK_SKILL_COUNT: -1,
        SKILL_FALLBACK_PICK_COUNT: 3,
        PRIORITIZE_UNFINISHED: true,
        SKILL_COMBOS: [
            {
                name: '组合一',
                minMatch: 4,
                items: [
                    ['监护麻醉管理', 'MAC'],
                    ['X线/CT/MR读片', 'MR读片', 'CT/MR'],
                    ['气管插管全身麻醉'],
                    ['心电图读图'],
                    ['呼吸机管理'],
                    ['手工填写麻醉记录单', '围术期相关表单'],
                    ['动脉穿刺', '置管与监测'],
                ],
            },
            {
                name: '组合二',
                minMatch: 2,
                items: [
                    ['外周神经阻滞'],
                    ['喉罩'],
                    ['椎管内麻醉', '椎管内阻滞', '椎管内'],
                ],
            },
            {
                name: '组合三',
                minMatch: 2,
                items: [
                    ['纤维支气管镜', '可视插管软镜'],
                    ['中心静脉穿刺', '置管与监测'],
                    ['双腔支气管插管', '及对位'],
                ],
            },
            {
                name: '组合四',
                minMatch: 1,
                items: [
                  ['经鼻气管插管'],
                  ['自体血回输'],
                  ['住院病历书写'],
                  ['动脉穿刺置管与监测'],
                ],
            }
        ],
        REMARK: {
            enabled: false,
            preferInputRemark: true,
            separator: '；',
            fallback: '自动录入',
            fields: [
                'department',
                'operatingRoom',
                'number',
                'name',
                'surgeryName',
                'anesthesiaMethod',
                'mainAnesthesiologist',
                'assistantAnesthesiologist',
            ],
            labels: {
                department: '科室',
                operatingRoom: '手术间',
                number: '台次',
                name: '患者',
                surgeryName: '手术',
                anesthesiaMethod: '麻醉',
                mainAnesthesiologist: '主麻',
                assistantAnesthesiologist: '副麻',
            },
        },
        STEP_DELAY: 250,
        WAIT_TIMEOUT: 20000,

        // 新增：关键步骤后的额外 settle（比固定 sleep 更稳）
        AFTER_DEPT_SETTLE_MS: 120,
        AFTER_CHANGEVALUE_SETTLE_MS: 120,
        BEFORE_SUBMIT_SETTLE_MS: 120,
    };

    const log = (...args) => console.log('%c[LZ-AUTO]', 'color:#22a;font-weight:bold;', ...args);
    const warn = (...args) => console.warn('%c[LZ-AUTO]', 'color:#c60;font-weight:bold;', ...args);
    const err = (...args) => console.error('%c[LZ-AUTO]', 'color:#c00;font-weight:bold;', ...args);

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    function isVisibleIn(win, el) {
        if (!el) return false;
        const style = win.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function highlight(el, color = '#ff3') {
        try {
            el.style.outline = `3px solid ${color}`;
            el.style.outlineOffset = '2px';
            setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 1200);
        } catch (_) { }
    }

    function fireInput(win, el) {
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
        el.dispatchEvent(new win.KeyboardEvent('keyup', { bubbles: true }));
    }

    function setValue(win, el, value) {
        el.value = value;
        fireInput(win, el);
    }

    // ⚠️ 修复：这里不要再 el.click()，避免一次调用产生两次 click（dispatch + native）
    function clickEl(win, el, label = '') {
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { }
        highlight(el, '#9f9');
        const evOpt = { bubbles: true, cancelable: true, view: win };
        el.dispatchEvent(new win.MouseEvent('mouseover', evOpt));
        el.dispatchEvent(new win.MouseEvent('mousedown', evOpt));
        el.dispatchEvent(new win.MouseEvent('mouseup', evOpt));
        el.dispatchEvent(new win.MouseEvent('click', evOpt));
        log('CLICK', label, el);
        return true;
    }

    async function waitFor(fn, timeoutMs = CFG.WAIT_TIMEOUT, intervalMs = 200, label = '') {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            const v = (() => { try { return fn(); } catch (_) { return null; } })();
            if (v) return v;
            await sleep(intervalMs);
        }
        throw new Error('waitFor timeout: ' + label);
    }

    function waitChildAppear(win, root, selector, timeout = 20000, label = '') {
        return new Promise((resolve, reject) => {
            if (!root) return reject(new Error('waitChildAppear root null: ' + label));
            const hitNow = root.querySelector(selector);
            if (hitNow) return resolve(hitNow);

            const mo = new win.MutationObserver(() => {
                const hit = root.querySelector(selector);
                if (hit) { mo.disconnect(); resolve(hit); }
            });
            mo.observe(root, { childList: true, subtree: true });

            setTimeout(() => { mo.disconnect(); reject(new Error('waitChildAppear timeout: ' + label)); }, timeout);
        });
    }

    // 选择真正业务iframe（mainshow + LzReportIllnessSkillOpetative 优先）
    async function detectContext(timeoutMs = 12000) {
        const start = Date.now();
        function scoreCandidate(iframeEl, doc) {
            let s = 0;
            const src = iframeEl?.src || '';
            const id = iframeEl?.id || '';
            if (id.includes('mainshow')) s += 200;
            if (src.includes('LzReportIllnessSkillOpetative')) s += 180;
            try {
                const w = doc.defaultView;
                const btn = doc.querySelector('#btnAdd');
                if (btn) s += 80;
                if (btn && w && isVisibleIn(w, btn)) s += 120;
            } catch (_) { }
            return s;
        }
        function collect() {
            const res = [];
            res.push({
                where: 'self',
                doc: document,
                win: window,
                iframe: null,
                score: (document.querySelector('#btnAdd') ? 150 : 10),
            });
            for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
                try {
                    const d = ifr.contentDocument;
                    const w = ifr.contentWindow;
                    if (!d || !w) continue;
                    res.push({
                        where: `iframe(${ifr.id || ''}) src=${ifr.src || ''}`,
                        doc: d,
                        win: w,
                        iframe: ifr,
                        score: scoreCandidate(ifr, d),
                    });
                } catch (_) { }
            }
            res.sort((a, b) => b.score - a.score);
            return res;
        }

        let candidates = collect();
        while ((!candidates.length || candidates[0].score < 100) && Date.now() - start < timeoutMs) {
            await sleep(300);
            candidates = collect();
        }
        log('CTX candidates:', candidates.map(c => ({ where: c.where, score: c.score })));
        const best = candidates[0] || { where: 'fallback(self)', doc: document, win: window, iframe: null, score: 0 };
        log('CTX pick =', best.where, 'score=', best.score);
        return best;
    }

    function uniqWins(wins) {
        const out = [];
        const seen = new Set();
        for (const w of wins) {
            if (!w) continue;
            try {
                const key = w.location?.href + "|" + (w.name || "");
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(w);
            } catch (e) {
                out.push(w);
            }
        }
        return out;
    }

    function findVisibleLayuiDialog(win) {
        const doc = win.document;
        const dialogs = Array.from(doc.querySelectorAll(".layui-layer.layui-layer-dialog"))
            .filter(el => isVisibleIn(win, el));
        if (!dialogs.length) return null;

        const prefer = dialogs.find(d => {
            const title = d.querySelector(".layui-layer-title")?.innerText?.trim() || "";
            return title.includes("系统提示");
        });

        return prefer || dialogs[0];
    }

    function findDialogOkButton(dialog) {
        let btn =
            dialog.querySelector(".layui-layer-btn .layui-layer-btn0") ||
            Array.from(dialog.querySelectorAll(".layui-layer-btn a")).find(a => (a.innerText || "").trim() === "确定");
        if (!btn) btn = dialog.querySelector(".layui-layer-close");
        return btn;
    }

    async function handleLayuiSystemDialogAfterSave(modal, label = "保存后系统提示") {
        const wins = uniqWins([modal?.win, modal?.win?.parent, modal?.win?.top]);

        const t0 = Date.now();
        const timeout = 12000;

        while (Date.now() - t0 < timeout) {
            for (const w of wins) {
                try {
                    const dlg = findVisibleLayuiDialog(w);
                    if (!dlg) continue;

                    const title = dlg.querySelector(".layui-layer-title")?.innerText?.trim() || "";
                    const content = dlg.querySelector(".layui-layer-content")?.innerText?.trim() || "";
                    log(`[${label}] dialog FOUND in win=${w.name || "(noname)"} title=`, title, "content=", content);

                    const ok = findDialogOkButton(dlg);
                    if (!ok) {
                        warn(`[${label}] dialog has no OK/CLOSE button`, dlg);
                        return false;
                    }

                    humanClick(w, ok, `${label} 点击确定/关闭`);
                    await sleep(250);

                    await waitFor(() => !isVisibleIn(w, dlg), 6000, 150, `${label} dialog disappear`).catch(() => { });
                    return true;
                } catch (e) { }
            }
            await sleep(200);
        }

        warn(`[${label}] timeout: no dialog detected`);
        return false;
    }

    // ====== humanClick (保持你原来的强力点击) ======
    function humanClick(win, el, label = '') {
        if (!el) return false;

        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch { }

        const r = el.getBoundingClientRect();
        const x = Math.floor(r.left + Math.min(r.width * 0.5, 20));
        const y = Math.floor(r.top + r.height * 0.5);

        const hit = win.document.elementFromPoint(x, y) || el;

        try { hit.focus?.({ preventScroll: true }); } catch { }

        const base = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: win,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: 1,
        };

        try {
            if (typeof win.PointerEvent === 'function') {
                hit.dispatchEvent(new win.PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
                hit.dispatchEvent(new win.PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
            }
        } catch { }

        hit.dispatchEvent(new win.MouseEvent('mousedown', base));
        hit.dispatchEvent(new win.MouseEvent('mouseup', base));
        hit.dispatchEvent(new win.MouseEvent('click', base));

        log(`[humanClick] ${label} hit=`, hit, `@(${x},${y})`);
        return true;
    }

    const raf = (win) => new Promise(r => win.requestAnimationFrame(() => r()));
    async function settleUI(win, ms = 0) {
        await raf(win); await raf(win);
        if (ms) await sleep(ms);
    }

    async function waitJqIdle(win, timeout = 12000, label = 'jQuery idle') {
        if (!win.jQuery) return;
        await waitFor(() => win.jQuery.active === 0, timeout, 120, label);
        await settleUI(win, 80);
    }

    // ====== layer/iframe 检测与复用 ======
    function getTopWin(modal) {
        try { return modal?.win?.top || window.top; } catch { return window; }
    }

    function parseZ(el) {
        const z = parseInt((el?.style && el.style.zIndex) || getComputedStyle(el).zIndex || '0', 10);
        return Number.isFinite(z) ? z : 0;
    }

    function isAddLayer(layerEl) {
        if (!layerEl) return false;
        const title = layerEl.querySelector('.layui-layer-title')?.innerText?.trim() || '';
        if (!title.includes('添加')) return false;

        const iframe = layerEl.querySelector('iframe');
        const src = iframe?.getAttribute('src') || '';
        return src.includes('/LZ/LzReportIllnessSkillOpetative/LzReportIllnessSkillOpetativeAddEdit')
            && src.includes('ot=add');
    }

    function findAddLayers(topWin) {
        const doc = topWin.document;
        const layers = Array.from(doc.querySelectorAll('.layui-layer.layui-layer-iframe'))
            .filter(el => isVisibleIn(topWin, el))
            .filter(isAddLayer);

        layers.sort((a, b) => parseZ(a) - parseZ(b));
        return layers;
    }

    function closeLayer(topWin, layerEl, reason = 'close layer') {
        const closeBtn =
            layerEl.querySelector('.layui-layer-setwin .layui-layer-close') ||
            layerEl.querySelector('.layui-layer-setwin .layui-layer-close1');
        if (!closeBtn) {
            warn('[LZ-AUTO] no close button for layer', layerEl);
            return false;
        }
        humanClick(topWin, closeBtn, reason);
        return true;
    }

    async function ensureSingleAddLayer(modal, label = 'ensureSingleAddLayer') {
        const topWin = getTopWin(modal);
        const layers = findAddLayers(topWin);

        if (!layers.length) {
            log(`[LZ-AUTO] ${label}: addLayers=0`);
            return null;
        }

        const keep = layers[layers.length - 1];
        if (layers.length > 1) {
            warn(`[LZ-AUTO] ${label}: addLayers=${layers.length} -> closing extras, keep z=${parseZ(keep)}`);

            for (let i = 0; i < layers.length - 1; i++) {
                closeLayer(topWin, layers[i], `${label} close extra add layer #${i + 1}`);
                await sleep(120);
            }
        } else {
            log(`[LZ-AUTO] ${label}: addLayers=1 keep z=${parseZ(keep)}`);
        }

        return keep;
    }

    function getAddIframeCtxFromLayer(topWin, layerEl) {
        const iframe = layerEl.querySelector('iframe');
        if (!iframe) throw new Error('添加layer里找不到 iframe');
        const win = iframe.contentWindow;
        const doc = iframe.contentDocument || win.document;
        return { topWin, layerEl, iframeEl: iframe, win, doc, where: 'layui-add-layer-iframe' };
    }

    async function waitAddLayersGone(modal, timeout = 12000) {
        const topWin = getTopWin(modal);
        await waitFor(() => findAddLayers(topWin).length === 0, timeout, 150, 'add layers gone');
    }

    async function openAddModalFromMain(mainCtx) {
        const existed = await ensureSingleAddLayer(mainCtx, 'pre-open');
        const topWin = getTopWin(mainCtx);
        if (existed) {
            log('[LZ-AUTO] add layer already exists -> reuse, NO click #btnAdd');
            return await waitFor(() => {
                const ctx = getAddIframeCtxFromLayer(topWin, existed);
                const hasForm = ctx.doc.querySelector('#form1') && ctx.doc.querySelector('#ddl_train_dept') && ctx.doc.querySelector('#submitId');
                if (!hasForm) return null;
                return { layer: existed, iframe: ctx.iframeEl, doc: ctx.doc, win: ctx.win, topWin };
            }, 15000, 150, 'add iframe ready (reuse)');
        }

        const btnAdd = mainCtx.doc.querySelector('#btnAdd');
        if (!btnAdd) throw new Error('找不到 #btnAdd');
        humanClick(mainCtx.win, btnAdd, '逐条添加(#btnAdd) 单击');
        await sleep(250);

        await waitFor(() => findAddLayers(topWin).length > 0, 15000, 150, 'add layer appear');

        const layer = await ensureSingleAddLayer(mainCtx, 'post-open');
        if (!layer) throw new Error('打开后仍未找到添加layer');

        return await waitFor(() => {
            const ctx = getAddIframeCtxFromLayer(topWin, layer);
            const hasForm = ctx.doc.querySelector('#form1') && ctx.doc.querySelector('#ddl_train_dept') && ctx.doc.querySelector('#submitId');
            if (!hasForm) return null;
            return { layer, iframe: ctx.iframeEl, doc: ctx.doc, win: ctx.win, topWin };
        }, 15000, 150, 'add iframe ready');
    }

    async function warmupAddEdit(modal) {
        const { doc, win } = modal;

        await sleep(200);

        try {
            if (typeof waitJqIdle === 'function') {
                await waitJqIdle(win, 12000, 'warmup jq idle');
            } else if (win.jQuery) {
                await waitFor(() => win.jQuery.active === 0, 12000, 120, 'warmup jq idle');
            }
        } catch { }

        const ill = await waitFor(() => doc.querySelector('#ddl_illness'), 20000, 150, 'warmup #ddl_illness');
        await waitChildAppear(win, ill, '.dropcontent.alldropinner', 20000, 'warmup illness dropcontent');

        const sk = await waitFor(() => doc.querySelector('#ddl_skill'), 20000, 150, 'warmup #ddl_skill');
        await waitChildAppear(win, sk, '.dropcontent.alldropinner', 20000, 'warmup skill dropcontent');

        await settleUI(win, 120);
    }

    function isHyOpen(win, ddl, pop) {
        if (!ddl || !pop) return false;
        const st = win.getComputedStyle(pop);
        return ddl.classList.contains('select') || (st.display !== 'none' && st.visibility !== 'hidden');
    }

    // ====== 下拉选择：singleDrop ======
    async function selectFromSingleDrop(modal, dropdownRootSel, targetTitle) {
        const { doc, win } = modal;
        const root = doc.querySelector(dropdownRootSel);
        if (!root) throw new Error(`找不到下拉: ${dropdownRootSel}`);

        // 打开
        clickEl(win, root, `open ${dropdownRootSel}`);
        await sleep(CFG.STEP_DELAY);

        const ul = await waitFor(() => root.querySelector('ul.singleDrop'), CFG.WAIT_TIMEOUT, 200, 'singleDrop ul');

        const li =
            Array.from(ul.querySelectorAll('li')).find(x => (x.getAttribute('title') || x.innerText || '').trim() === targetTitle) ||
            Array.from(ul.querySelectorAll('li')).find(x => (x.innerText || '').includes(targetTitle));

        if (!li) {
            const titles = Array.from(ul.querySelectorAll('li')).slice(0, 30).map(x => x.getAttribute('title') || x.innerText);
            warn('singleDrop sample titles=', titles);
            throw new Error('下拉里找不到目标：' + targetTitle);
        }

        // ✅ 修复：不要稳定触发两次 click；先 native click，一次不生效再 fallback
        const labelEl = root.querySelector('span.dropdowmlable, .dropdowmlable');
        const beforeLabel = (labelEl?.innerText || '').trim();

        try { li.scrollIntoView({ block: 'nearest' }); } catch { }
        try { li.click(); } catch { }
        log('[selectFromSingleDrop] native click li =>', targetTitle);

        await settleUI(win, 120);

        const afterLabel = (labelEl?.innerText || '').trim();
        if (beforeLabel === afterLabel && win.jQuery) {
            try { win.jQuery(li).trigger('click'); } catch { }
            log('[selectFromSingleDrop] fallback jQuery trigger click =>', targetTitle);
            await settleUI(win, 120);
        }

        return true;
    }

    // ====== hyCheckbox 相关 ======
    function getOptText(opt) {
        const t = (opt.innerText || opt.textContent || "").trim();
        if (t) return t;
        const sp = opt.querySelector?.("span");
        return (sp?.getAttribute?.("title") || sp?.innerText || "").trim();
    }

    function parseReqDoneFromText(text) {
        const s = (text || '').toString();
        const m = s.match(/要求数\s*[:：]\s*(\d+)\s*[,，]?\s*完成数\s*[:：]\s*(\d+)/);
        if (!m) return null;
        const req = parseInt(m[1], 10);
        const done = parseInt(m[2], 10);
        if (!Number.isFinite(req) || !Number.isFinite(done)) return null;
        return { req, done, remaining: Math.max(0, req - done) };
    }

    function isUnfinishedText(text) {
        const p = parseReqDoneFromText(text);
        return !!(p && p.done < p.req);
    }

    function pickBestNeedIndex(win, texts) {
        // texts: string[]
        const parsed = texts.map((t, i) => ({ i, p: parseReqDoneFromText(t) }));
        const unfinished = parsed.filter(x => x.p && x.p.remaining > 0);
        if (!unfinished.length) return -1;

        const maxRem = Math.max(...unfinished.map(x => x.p.remaining));
        const top = unfinished.filter(x => x.p.remaining === maxRem);
        return top[randIndex(win, top.length)].i;
    }

    function matchByAlts(text, alts) {
        return alts.some(k => k && text.includes(k));
    }

    function findHitByAlts(win, pool, used, itemAlts) {
        const alts = Array.isArray(itemAlts) ? itemAlts.filter(Boolean).map(x => x.toString()) : [];
        if (!alts.length) return null;

        const preferUnfinished = !!CFG.PRIORITIZE_UNFINISHED;

        function chooseCandidate(cands) {
            if (!cands.length) return null;
            if (!preferUnfinished) return cands[0];

            const unfinished = cands.filter(c => isUnfinishedText(c.text));
            if (!unfinished.length) return cands[0];

            const idx = pickBestNeedIndex(win, unfinished.map(x => x.text));
            if (idx >= 0) return unfinished[idx];
            return unfinished[randIndex(win, unfinished.length)];
        }

        // 优先匹配第一个关键词（通常是“更精确”的名字），避免像“置管与监测”这种泛词把匹配抢走
        const primary = alts[0];
        if (primary) {
            const strongCands = pool.filter(x => !used.has(x.opt) && x.text && x.text.includes(primary));
            const strongPick = chooseCandidate(strongCands);
            if (strongPick) return strongPick;
        }

        const weakCands = pool.filter(x => !used.has(x.opt) && x.text && matchByAlts(x.text, alts));
        return chooseCandidate(weakCands);
    }

    function pickSkillSubset(win, chosen, maxPick) {
        const preferUnfinished = !!CFG.PRIORITIZE_UNFINISHED;
        if (!preferUnfinished) return shuffledCopy(win, chosen).slice(0, maxPick);

        const remaining = chosen.slice();
        const picked = [];

        // 先尽量挑“未达标”且 remaining 最大的
        while (picked.length < maxPick) {
            const unfinished = remaining.filter(x => isUnfinishedText(x.text));
            if (!unfinished.length) break;

            const idx = pickBestNeedIndex(win, unfinished.map(x => x.text));
            const sel = (idx >= 0) ? unfinished[idx] : unfinished[randIndex(win, unfinished.length)];
            picked.push(sel);
            const rmIdx = remaining.indexOf(sel);
            if (rmIdx >= 0) remaining.splice(rmIdx, 1);
        }

        // 不够再从剩余里补齐（随机）
        if (picked.length < maxPick) {
            const fill = shuffledCopy(win, remaining).slice(0, maxPick - picked.length);
            return picked.concat(fill);
        }

        return picked;
    }

    function isBadOther(text) {
        return text.includes("其他(") || text.includes("请在[其他") || text.includes("请在其他");
    }

    async function openHy(modal, ddlSel, label) {
        const { doc, win } = modal;

        await waitFor(() => doc.querySelector(ddlSel), 20000, 150, `${label} ddl exist`);

        const t0 = Date.now();
        let ddl;
        let pop;

        while (Date.now() - t0 < 20000) {
            ddl = doc.querySelector(ddlSel);
            if (!ddl) { await sleep(120); continue; }

            pop = ddl.querySelector('.dropcontent.alldropinner');
            if (pop) break;

            const labelSpanTry = ddl.querySelector('span.dropdowmlable, .dropdowmlable') || ddl;
            try { humanClick(win, labelSpanTry, `${label} trigger inject`); } catch { }
            await sleep(120);

            try {
                pop = await waitChildAppear(win, ddl, '.dropcontent.alldropinner', 1200, `${label} dropcontent inject`);
                if (pop) break;
            } catch { }
        }

        if (!ddl || !pop) throw new Error(`${label} dropcontent still missing (timeout)`);

        const labelSpan = ddl.querySelector('span.dropdowmlable') || ddl.querySelector('.dropdowmlable');
        const icon = ddl.querySelector('i.dropiconws');

        for (let round = 1; round <= 3; round++) {
            if (labelSpan) humanClick(win, labelSpan, `open ${label} r${round} label`);
            await sleep(180);
            if (win.getComputedStyle(pop).display !== 'none') break;

            if (icon) humanClick(win, icon, `open ${label} r${round} icon`);
            await sleep(180);
            if (win.getComputedStyle(pop).display !== 'none') break;

            humanClick(win, ddl, `open ${label} r${round} ddl`);
            await sleep(180);
            if (win.getComputedStyle(pop).display !== 'none') break;

            log(`[${label}] round${round} pop.display=`, win.getComputedStyle(pop).display, 'ddl.class=', ddl.className);
        }

        await waitFor(() => win.getComputedStyle(pop).display !== 'none', 20000, 120, `popup visible ${label}`);

        const area = await waitFor(() => pop.querySelector('.area-inner'), 20000, 200, `area-inner ${label}`);
        await waitChildAppear(win, area, '.areaname, div[attr-id], li', 20000, `options ${label}`);

        let options = Array.from(area.querySelectorAll('.areaname'));
        if (!options.length) options = Array.from(area.querySelectorAll('div[attr-id]'));
        if (!options.length) options = Array.from(area.querySelectorAll('li'));

        options = options.filter(Boolean);

        log(`[${label}] options=`, options.length);
        return { ddl, pop, area, options, win };
    }

    function clickSure(win, pop, label) {
        const sure =
            pop.querySelector(".sureBtns") ||
            pop.querySelector(".area-btn-sure") ||
            Array.from(pop.querySelectorAll("span")).find(x => (x.innerText || "").trim() === "确定");
        if (!sure) throw new Error(`${label} 找不到“确定”按钮`);
        humanClick(win, sure, `${label} 确定`);
    }

    // ✅ 新增：等待 hidden 真写入（避免“看起来选了但没保存”）
    async function waitHiddenFilled(modal, selector, label, timeout = 8000) {
        const { doc, win } = modal;
        await waitFor(() => doc.querySelector(selector)?.value?.trim(), timeout, 120, `${label} filled: ${selector}`);
        await settleUI(win, 80);
    }

    function randIndex(win, n) {
        if (n <= 1) return 0;

        // 更均匀：crypto（避免 Math.random 的一些偏差/可预测性）
        const c = win.crypto || window.crypto;
        if (c && c.getRandomValues) {
            const arr = new Uint32Array(1);
            const max = 0xFFFFFFFF;
            const limit = max - (max % n); // 拒绝采样避免取模偏差
            let x;
            do {
                c.getRandomValues(arr);
                x = arr[0];
            } while (x >= limit);
            return x % n;
        }

        return Math.floor(Math.random() * n);
    }

    function shuffledCopy(win, arr) {
        const a = Array.isArray(arr) ? arr.slice() : [];
        for (let i = a.length - 1; i > 0; i--) {
            const j = randIndex(win, i + 1);
            const tmp = a[i];
            a[i] = a[j];
            a[j] = tmp;
        }
        return a;
    }

    function getHyLeafOptions(area) {
        // 叶子项优先：通常诊断/技能真正可选项都有 attr-id
        let leaf = Array.from(area.querySelectorAll('div[attr-id], li[attr-id], [attr-id]'))
            .filter(el => (el.getAttribute('attr-id') || '').trim());

        // 有些分类也可能带 attr-id（保险过滤一下常见“分类节点”class）
        leaf = leaf.filter(el => !el.classList.contains('areaname'));

        // 实在取不到，再退化为你原来的方案
        if (!leaf.length) {
            leaf = Array.from(area.querySelectorAll('.areaname, div[attr-id], li')).filter(Boolean);
        }
        return leaf;
    }

    // ====== 主要诊断：随机选（避开“其他”） ======
    async function pickMainDiagnosisNoOther(modal) {
        const { doc, win } = modal;
        const { pop, area } = await openHy(modal, "#ddl_illness", "主要诊断");

        const all = getHyLeafOptions(area);

        // 过滤掉“其他…”
        const good = all.filter(opt => {
            const text = getOptText(opt);
            return text && !text.includes("其他(请在其他主要诊断中录入)") && !text.startsWith("其他");
        });

        if (!good.length) throw new Error("主要诊断没有可选项（过滤后为空）");

        let candidateList = good;
        let candidateLabel = 'all';
        if (CFG.PRIORITIZE_UNFINISHED) {
            const unfinished = good.filter(opt => isUnfinishedText(getOptText(opt)));
            if (unfinished.length) {
                candidateList = unfinished;
                candidateLabel = 'unfinished';
            }
        }

        let pick;
        if (CFG.PRIORITIZE_UNFINISHED) {
            const bestIdx = pickBestNeedIndex(win, candidateList.map(o => getOptText(o)));
            pick = (bestIdx >= 0) ? candidateList[bestIdx] : candidateList[randIndex(win, candidateList.length)];
        } else {
            pick = candidateList[randIndex(win, candidateList.length)];
        }

        const t = getOptText(pick);
        const p = parseReqDoneFromText(t);
        const stat = p ? `(要求数:${p.req},完成数:${p.done})` : '';
        log(`[主要诊断] PICK(${candidateLabel}) ${stat} =>`, t);

        const target = pick.querySelector("span") || pick;
        humanClick(win, target, "主要诊断 option");
        await sleep(200);

        clickSure(win, pop, "主要诊断");

        // 等 hidden 回填（你 v2.4 里已有 waitHiddenFilled 就用它）
        await waitHiddenFilled(modal, '#report_IllnessSkillOperative_illness_ids', 'illness_ids');
        await waitHiddenFilled(modal, '#illness_name', 'illness_name');
    }


    // ====== 技能：按组合优先自动勾选 + 等回填 ======
    async function pickSkillsByCombos(modal) {
        const { doc, win } = modal;
        const { pop, options } = await openHy(modal, "#ddl_skill", "技能操作");

        const pool = options
            .map(opt => ({ opt, text: getOptText(opt) }))
            .filter(x => x.text && !isBadOther(x.text));

        log("[技能操作] pool=", pool.length);

        let chosen = [];
        let chosenCombo = null;

        const combosRaw = Array.isArray(CFG.SKILL_COMBOS) ? CFG.SKILL_COMBOS : [];
        const combos = shuffledCopy(win, combosRaw);
        log('[技能操作] combos shuffled order =', combos.map(c => c?.name || '(noname)'));

        for (const combo of combos) {
            const picks = [];
            const used = new Set();

            for (const itemAlts of combo.items) {
                const hit = findHitByAlts(win, pool, used, itemAlts);
                if (hit) {
                    picks.push(hit);
                    used.add(hit.opt);
                }
            }

            log(`[技能操作] try ${combo.name}: match=${picks.length}/${combo.items.length}`, picks.map(p => p.text));

            if (picks.length >= combo.minMatch) {
                chosen = picks;
                chosenCombo = combo.name;
                break;
            }
        }

        if (!chosen.length) {
            const n = Math.max(1, parseInt(CFG.SKILL_FALLBACK_PICK_COUNT || 3, 10));
            chosenCombo = `fallback(前${n}个非其他)`;
            if (CFG.PRIORITIZE_UNFINISHED) {
                const unfinished = pool.filter(x => isUnfinishedText(x.text));
                const src = unfinished.length ? unfinished : pool;
                chosen = shuffledCopy(win, src).slice(0, n);
            } else {
                chosen = pool.slice(0, n);
            }
        }

        // 如果页面实际只允许保存少量技能：按 PICK_SKILL_COUNT 限制最终点击数量，并随机抽样
        const maxPick = parseInt(CFG.PICK_SKILL_COUNT ?? 0, 10);
        if (Number.isFinite(maxPick) && maxPick > 0 && chosen.length > maxPick) {
            const before = chosen.length;
            chosen = pickSkillSubset(win, chosen, maxPick);
            log(`[技能操作] apply PICK_SKILL_COUNT=${maxPick}: ${before} -> ${chosen.length}`);
        }

        log("[技能操作] chosenCombo =", chosenCombo);
        chosen.forEach((x, idx) => {
            const target = x.opt.querySelector("span") || x.opt;
            humanClick(win, target, `技能 opt#${idx + 1}`);
        });

        await sleep(250);
        clickSure(win, pop, "技能操作");

        // 等 hidden 回填
        await waitHiddenFilled(modal, '#report_IllnessSkillOperative_skill_ids', 'skill_ids');
    }

    // ====== 提交：只点一次（修复重复 insert） ======
    function clickSubmitOnce(modalCtx) {
        const btn = modalCtx.doc.querySelector('#submitId');
        if (!btn) throw new Error('找不到保存按钮 #submitId');

        if (btn.dataset.lzautoSubmitted === '1') {
            warn('[LZ-AUTO] submit already clicked (script lock), skip');
            return false;
        }
        btn.dataset.lzautoSubmitted = '1';

        btn.style.pointerEvents = '';
        btn.disabled = false;
        try { btn.focus?.(); } catch { }

        // ✅ 只保留一次 native click（不要再 dispatch 第二次 click）
        log('[LZ-AUTO] [submit] native btn.click()');
        try { btn.click(); } catch (e) { warn('btn.click failed:', e); }

        btn.style.opacity = '0.65';

        setTimeout(() => {
            try {
                const topWin = getTopWin(modalCtx);
                const stillHasAdd = findAddLayers(topWin).length > 0;
                const hasDialog = !!findVisibleLayuiDialog(topWin);
                if (stillHasAdd && !hasDialog) {
                    warn('[LZ-AUTO] [submit] no dialog/layer still here -> auto unlock submit');
                    delete btn.dataset.lzautoSubmitted;
                    btn.style.opacity = '';
                    btn.style.pointerEvents = '';
                }
            } catch { }
        }, 6000);

        return true;
    }

    // ====== 数据处理 ======
    function normalizeInputJson(text) {
        const raw = (text || '').trim();
        if (!raw) return [];
        let obj;
        try { obj = JSON.parse(raw); } catch (e) { throw new Error('JSON解析失败：' + e.message); }

        let arr = [];
        if (Array.isArray(obj)) arr = obj;
        else if (obj && Array.isArray(obj.surgeries)) arr = obj.surgeries;
        else arr = [obj];

        return arr.map((r, i) => ({
            _idx: i,
            recordNo: (r.hospitalNumber || r.inpatient_no || r.inpatientNo || r.recordNo || '').toString().trim(),
            operateDate: (r.operateDate || r.operate_date || r.date || '').toString().trim(),
            remark: (r.remarks ?? r.remark ?? '').toString(),
            raw: r,
        }));
    }

    function buildRemark(rec) {
        const cfg = CFG.REMARK || {};
        const enabled = cfg.enabled !== false;
        if (!enabled) return '';

        const preferInput = cfg.preferInputRemark !== false;
        const inputRemark = (rec?.remark || '').trim();
        if (preferInput && inputRemark) return inputRemark;

        const r = rec?.raw || {};
        const separator = (cfg.separator ?? '；').toString();
        const fields = Array.isArray(cfg.fields) && cfg.fields.length ? cfg.fields : [
            'department',
            'operatingRoom',
            'number',
            'name',
            'surgeryName',
            'anesthesiaMethod',
            'mainAnesthesiologist',
            'assistantAnesthesiologist',
        ];
        const labels = cfg.labels || {};

        const parts = [];
        for (const key of fields) {
            const k = (key || '').toString();
            if (!k) continue;
            const val = (r[k] ?? '').toString().trim();
            if (!val) continue;
            const label = (labels[k] ?? k).toString();
            parts.push(`${label}:${val}`);
        }

        const built = parts.join(separator).trim();
        const fallback = (cfg.fallback ?? '自动录入').toString();
        return built || fallback;
    }

    // ✅ 新增：提交前自检，防止异步把 hidden 清空
    async function preSubmitValidate(modal) {
        const { doc, win } = modal;

        // 等页面请求都落地再检查（避免“我刚选完，下一秒异步把我清了”）
        await waitJqIdle(win, 12000, 'before submit jq idle');
        await settleUI(win, CFG.BEFORE_SUBMIT_SETTLE_MS);

        const illIds = doc.querySelector('#report_IllnessSkillOperative_illness_ids')?.value?.trim() || '';
        const skillIds = doc.querySelector('#report_IllnessSkillOperative_skill_ids')?.value?.trim() || '';

        if (!illIds) {
            warn('[LZ-AUTO] illness_ids empty before submit -> repick main diagnosis');
            await pickMainDiagnosisNoOther(modal);
        }
        if (!skillIds) {
            warn('[LZ-AUTO] skill_ids empty before submit -> repick skills');
            await pickSkillsByCombos(modal);
        }

        // 再等一次（确保 repick 的回填也稳定）
        await waitJqIdle(win, 12000, 'after repick jq idle');
        await settleUI(win, 80);
    }

    async function fillAndSaveOne(ctx, rec) {
        log('===== RUN ONE ===== idx=', rec._idx, rec);

        let didSubmit = false;

        const modal = await openAddModalFromMain(ctx);
        log('Add modal iframe FOUND ✅', modal.iframe, 'src=', modal.iframe.getAttribute('src'));
        highlight(modal.layer, '#ff3');

        await warmupAddEdit(modal);

        const { doc, win } = modal;

        // 3) 轮转科室
        await selectFromSingleDrop(modal, '#ddl_train_dept', CFG.TARGET_DEPT_NAME);

        await waitFor(() => doc.querySelector('#person_dept_plan_id')?.value, CFG.WAIT_TIMEOUT, 200, 'person_dept_plan_id value');
        log('person_dept_plan_id=', doc.querySelector('#person_dept_plan_id').value);

        // ✅ 修复：科室变更后，等异步落地再继续（防止后续控件被重置）
        await waitJqIdle(win, 12000, 'after dept change');
        await settleUI(win, CFG.AFTER_DEPT_SETTLE_MS);

        // 4) 编号类型：病历号
        const radioCase = doc.querySelector('#record_no_type1');
        if (!radioCase) throw new Error('找不到 病历号 单选 #record_no_type1');
        clickEl(win, radioCase, '编号类型=病历号');
        await sleep(CFG.STEP_DELAY);

        // 5) 编号
        if (!rec.recordNo) throw new Error('数据缺少编号(recordNo)。请提供 hospitalNumber / inpatient_no');
        const recordNo = doc.querySelector('#record_no');
        if (!recordNo) throw new Error('找不到编号输入 #record_no');
        setValue(win, recordNo, rec.recordNo);
        log('record_no set=', rec.recordNo);

        // 6) 操作日期
        const opDate = doc.querySelector('#operate_date');
        if (!opDate) throw new Error('找不到操作日期 #operate_date');
        const useDate = rec.operateDate || CFG.DATE_FALLBACK;
        setValue(win, opDate, useDate);
        log('operate_date set=', useDate);

        // 触发时间校验逻辑
        try {
            if (typeof win.ChangeValue === 'function') {
                win.ChangeValue();
                log('ChangeValue() called');
            }
        } catch (e) {
            warn('ChangeValue call failed:', e);
        }

        // ✅ 修复：ChangeValue 后等异步结束
        await waitJqIdle(win, 12000, 'after ChangeValue');
        await settleUI(win, CFG.AFTER_CHANGEVALUE_SETTLE_MS);

        // 7) 病历类型：住院病历
        const med2 = doc.querySelector('#medical_record_type2');
        if (!med2) throw new Error('找不到住院病历 #medical_record_type2');
        clickEl(win, med2, '病历类型=住院病历');
        await sleep(CFG.STEP_DELAY);

        // 8) 主要诊断
        await pickMainDiagnosisNoOther(modal);
        log('main illness ids=', doc.querySelector('#report_IllnessSkillOperative_illness_ids')?.value);
        log('main illness name=', doc.querySelector('#illness_name')?.value);

        // 9) 技能操作
        await pickSkillsByCombos(modal);
        log('skill ids=', doc.querySelector('#report_IllnessSkillOperative_skill_ids')?.value);

        // 10) 备注
        const remarkEl = doc.querySelector('#remark');
        if (!remarkEl) {
            warn('找不到备注 #remark（跳过填写）');
        } else {
            const remark = buildRemark(rec);
            if (remark && remark.trim()) {
                setValue(win, remarkEl, remark);
                log('remark set=', remark);
            } else {
                log('remark skipped (empty/disabled)');
            }
        }

        // ✅ 提交前再做一次自检（防止异步把你刚选的清空）
        await preSubmitValidate(modal);

        // 11) 保存（单次锁）
        didSubmit = clickSubmitOnce(modal);
        log('提交已点击(单次锁)，等待系统提示/窗口关闭...');

        if (didSubmit) {
            await handleLayuiSystemDialogAfterSave(modal).catch(() => { });
            await waitAddLayersGone(modal, 20000);
            await ensureSingleAddLayer(modal, 'final-clean');
        }

        log('弹窗已关闭 ✅');
    }

    // ===== Shadow UI =====
    function createShadowUI(initialCtx) {
        const launcher = document.createElement('button');
        launcher.textContent = 'LZ Auto';
        launcher.style.cssText = `
      position:fixed; top:12px; right:12px; z-index:2147483647;
      padding:10px 14px; border-radius:14px; border:0;
      background:#22b573; color:#fff; font-weight:900; cursor:pointer;
      box-shadow:0 10px 30px rgba(0,0,0,.25);
    `;
        document.body.appendChild(launcher);

        const host = document.createElement('div');
        host.style.cssText = `position:fixed; top:60px; right:12px; z-index:2147483647;`;
        document.body.appendChild(host);

        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
      <style>
        .panel{width:380px;background:rgba(20,20,20,.92);color:#fff;border-radius:14px;padding:12px;
          font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial;
          box-shadow:0 10px 30px rgba(0,0,0,.35);}
        .title{display:flex;justify-content:space-between;align-items:center;font-weight:900;font-size:14px;}
        .mini{opacity:.85;font-size:11px;margin-top:6px;line-height:1.35;}
        .status{margin-top:8px;padding:8px;border-radius:12px;background:rgba(255,255,255,.08);}
        .row{display:flex;gap:10px;margin-top:10px;}
        button{flex:1;padding:10px;border-radius:12px;border:0;cursor:pointer;font-weight:900;}
        .ok{background:#3bb273;color:#fff;}
        .warn{background:#f0ad4e;color:#111;}
        .bad{background:#d9534f;color:#fff;}
        textarea{width:100%;height:150px;margin-top:10px;border-radius:12px;border:1px solid rgba(255,255,255,.15);
          background:rgba(0,0,0,.35);color:#fff;padding:10px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;}
      </style>

      <div class="panel">
        <div class="title">
          <div>LZ Auto (debug v2.4)</div>
          <button id="hide" class="warn" style="flex:0;padding:6px 10px;">Hide</button>
        </div>

        <div class="mini">CTX: <span id="ctxText"></span></div>
        <div class="status" id="status">Idle</div>

        <div class="row">
          <button id="scan" class="warn">Scan</button>
          <button id="runOne" class="ok">Run One</button>
        </div>
        <div class="row">
          <button id="startBatch" class="ok">Start Batch</button>
          <button id="stop" class="bad">Stop</button>
        </div>

        <textarea id="json" placeholder='粘贴 JSON：{ "surgeries":[ ... ] } 或 [ ... ]'></textarea>

        <div class="mini">
          默认：轮转科室=${CFG.TARGET_DEPT_NAME}<br/>
          操作日期默认=${CFG.DATE_FALLBACK}（可在数据里传 operateDate）<br/>
          若失败：把控制台 [LZ-AUTO] 最后 15 行贴给我。
        </div>
      </div>
    `;

        const ctxText = shadow.getElementById('ctxText');
        const status = shadow.getElementById('status');
        const txt = shadow.getElementById('json');

        let ctx = initialCtx;
        let stopped = false;

        const setStatus = (s) => status.textContent = s;
        const setCtx = (c) => { ctx = c; ctxText.textContent = c.where; };

        setCtx(ctx);

        function togglePanel() {
            host.style.display = (host.style.display === 'none') ? 'block' : 'none';
        }
        launcher.onclick = togglePanel;
        shadow.getElementById('hide').onclick = () => { host.style.display = 'none'; };

        shadow.getElementById('stop').onclick = () => {
            stopped = true;
            setStatus('Stopped');
            warn('STOP requested');
        };

        shadow.getElementById('scan').onclick = async () => {
            stopped = false;
            setStatus('Scanning...');
            try {
                const newCtx = await detectContext();
                setCtx(newCtx);
                setStatus('Scan done');
            } catch (e) {
                err(e);
                setStatus('Scan error: ' + (e.message || e));
            }
        };

        shadow.getElementById('runOne').onclick = async () => {
            stopped = false;
            setStatus('Running one...');
            try {
                const arr = normalizeInputJson(txt.value);
                if (!arr.length) throw new Error('没有可用数据（请粘贴JSON）');
                await fillAndSaveOne(ctx, arr[0]);
                if (!stopped) setStatus('Done ✅');
            } catch (e) {
                err(e);
                setStatus('Error: ' + (e.message || e));
            }
        };

        shadow.getElementById('startBatch').onclick = async () => {
            stopped = false;
            setStatus('Batch running...');
            try {
                const arr = normalizeInputJson(txt.value);
                if (!arr.length) throw new Error('没有可用数据（请粘贴JSON）');

                for (let i = 0; i < arr.length; i++) {
                    if (stopped) break;
                    setStatus(`Batch ${i + 1}/${arr.length} ...`);
                    log(`===== BATCH ${i + 1}/${arr.length} =====`, arr[i]);
                    await fillAndSaveOne(ctx, arr[i]);
                    await sleep(400);
                }

                setStatus(stopped ? 'Batch stopped' : 'Batch done ✅');
            } catch (e) {
                err(e);
                setStatus('Batch error: ' + (e.message || e));
            }
        };
    }

    (async function boot() {
        log('Booting v2.4...');
        const ctx = await detectContext();
        createShadowUI(ctx);
        log('Ready ✅');
    })();

})();
