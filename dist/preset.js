/* 言字卡 · 预设字卡管理模块 v1.0.0 —— 独立文件，不修改 app.v22.2.1.js
 *
 * 安装：本文件放进 dist/ ，在 index.html 已有那几行 script 的最后面加一行：
 *         <script defer src="dist/preset.js"></script>
 *
 * 解决什么：站内「系统预设字卡」那一页是故意做成只读的（app.js 第 14450 行
 *          `const addBtn = presetOnly ? '' : ...`，批量模式也在第 14337 行被关掉），
 *          所以预设内容少了你也没法补。本模块给你一套自己的管理面板。
 *
 * 关键机制（已在 app.js 核实）：
 *   · 预设组存在 data.groups 里，标记 g.preset === true（第 14318 行按这个标记分页显示）
 *   · 站内是「按分组名」取卡的：第 64198 行那种映射 ansYes: '我同意后TA说'
 *     → 往已有分组里加卡，立刻生效
 *     → 自己起新名字的分组，站内不会去抽（只存不用），面板里会明确标出来
 *   · 分组归属哪个页签由 PRESET_FEATURE_OF 决定（第 31-43 行），未知名字归到「其他」
 *   · 预设卡是纯字符串（第 1701 行那种），所以本模块也写字符串，与站内 cardText() 兼容
 *
 * 安全设计：
 *   · 只动 g.preset === true 的组，绝不碰你自己字卡库里的组
 *   · 任何删除都先把原内容快照到 data.presetUndo，可撤销一层
 *   · 删组/删卡都要二次确认
 */
(function () {
  'use strict';

  var PS_VER = '1.0.0';
  var MAX_LEN = 200;

  /* ============ 0. 工具 ============ */

  function qs(s, r) { return (r || document).querySelector(s); }
  function qsa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(t) {
    try { if (typeof showToast === 'function') { showToast(t); return; } } catch (e) {}
    try { window.alert(t); } catch (e2) {}
  }
  function siteReady() {
    try { return (typeof data !== 'undefined' && data && typeof data === 'object'); } catch (e) { return false; }
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function cardStr(c) {
    try { if (typeof cardText === 'function') { var t = cardText(c); if (t) return t; } } catch (e) {}
    if (typeof c === 'string') return c;
    if (isObj(c)) return String(c.text || '');
    return '';
  }

  /* ============ 1. 数据 ============ */

  function groups() {
    try { return (siteReady() && Array.isArray(data.groups)) ? data.groups : []; } catch (e) { return []; }
  }
  function presetGroups() {
    return groups().filter(function (g) { return g && g.preset === true; });
  }
  function persist() {
    try { if (typeof save === 'function') { save(); return true; } } catch (e) {}
    return false;
  }
  function refresh() {
    try { if (typeof renderSysCards === 'function') renderSysCards(); } catch (e) {}
  }

  /* 站内认得的组名（＝出厂就在的那些），用来判断"新组会不会被抽到" */
  function knownNames() {
    if (!siteReady()) return [];
    if (!Array.isArray(data.presetKnown) || !data.presetKnown.length) {
      data.presetKnown = presetGroups().map(function (g) { return g.name; }).filter(Boolean);
      persist();
    }
    return data.presetKnown;
  }
  function isKnown(name) { return knownNames().indexOf(name) >= 0; }

  function featureOf(g) {
    try { if (typeof presetFeatureOf === 'function') return presetFeatureOf(g) || '其他'; } catch (e) {}
    return '其他';
  }
  function featureTabs() {
    try {
      if (typeof presetFeatureTabs === 'function') {
        var t = presetFeatureTabs(groups());
        if (Array.isArray(t) && t.length) return t;
      }
    } catch (e) {}
    var out = [];
    presetGroups().forEach(function (g) { var f = featureOf(g); if (out.indexOf(f) < 0) out.push(f); });
    return out;
  }

  function undoStore() {
    if (!siteReady()) return null;
    if (!isObj(data.presetUndo)) data.presetUndo = {};
    return data.presetUndo;
  }
  function snapGroup(name) {
    var st = undoStore();
    if (!st) return;
    var g = findGroup(name);
    // 存整组（不只 cards），这样"整组被删掉"也能撤销回来
    st[name] = g ? { existed: true, group: clone(g) } : { existed: false, group: null };
  }
  function findGroup(name) {
    var gs = presetGroups();
    for (var i = 0; i < gs.length; i++) if (gs[i].name === name) return gs[i];
    return null;
  }
  function findGroupIdx(name) {
    var all = groups();
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].preset === true && all[i].name === name) return i;
    return -1;
  }

  /* ============ 2. 增删改 ============ */

  function cleanText(v) {
    var t = String(v == null ? '' : v).replace(/\s+$/, '').replace(/^\s+/, '');
    if (!t) return { ok: false, why: '内容是空的' };
    if (t.length > MAX_LEN) return { ok: false, why: '一条最多 ' + MAX_LEN + ' 字（你写了 ' + t.length + ' 字）' };
    return { ok: true, text: t };
  }

  function addCard(groupName, text, atIndex) {
    var c = cleanText(text);
    if (!c.ok) return c;
    var g = findGroup(groupName);
    if (!g) return { ok: false, why: '没有这个分组：' + groupName };
    if (!Array.isArray(g.cards)) g.cards = [];
    snapGroup(groupName);
    var i = (typeof atIndex === 'number' && atIndex >= 0 && atIndex <= g.cards.length) ? atIndex : g.cards.length;
    g.cards.splice(i, 0, c.text);
    persist(); refresh();
    return { ok: true, count: g.cards.length, text: c.text };
  }

  function editCard(groupName, index, text) {
    var c = cleanText(text);
    if (!c.ok) return c;
    var g = findGroup(groupName);
    if (!g || !Array.isArray(g.cards)) return { ok: false, why: '没有这个分组' };
    if (index < 0 || index >= g.cards.length) return { ok: false, why: '没有这一条' };
    snapGroup(groupName);
    var wasObj = isObj(g.cards[index]);
    if (wasObj) g.cards[index].text = c.text;      // 原来是对象形式就保持对象，别改形状
    else g.cards[index] = c.text;
    persist(); refresh();
    return { ok: true, text: c.text };
  }

  function delCard(groupName, index) {
    var g = findGroup(groupName);
    if (!g || !Array.isArray(g.cards)) return { ok: false, why: '没有这个分组' };
    if (index < 0 || index >= g.cards.length) return { ok: false, why: '没有这一条' };
    snapGroup(groupName);
    var removed = g.cards.splice(index, 1)[0];
    persist(); refresh();
    return { ok: true, removed: cardStr(removed), left: g.cards.length };
  }

  function addGroup(name, cards, note) {
    var c = cleanText(name);
    if (!c.ok) return { ok: false, why: '分组名' + c.why };
    if (c.text.length > 20) return { ok: false, why: '分组名最多 20 字' };
    if (findGroup(c.text)) return { ok: false, why: '已经有同名分组了' };
    if (!siteReady() || !Array.isArray(data.groups)) return { ok: false, why: '站内数据还没就绪' };
    var usable = isKnown(c.text);      // 必须在 push 之前判断，否则新组会把自己算进"站内认得的组名"
    snapGroup(c.text);                 // 记下"这组原本不存在"，于是新建也能撤销
    var list = [];
    (Array.isArray(cards) ? cards : String(cards || '').split('\n')).forEach(function (x) {
      var t = cleanText(typeof x === 'string' ? x : cardStr(x));
      if (t.ok) list.push(t.text);
    });
    data.groups.push({
      name: c.text, category: 'TA心里话', scope: 'public',
      cards: list, preset: true, custom: true, note: String(note || '').slice(0, 60)
    });
    persist(); refresh();
    return { ok: true, name: c.text, count: list.length, usable: usable };
  }

  function delGroup(name) {
    var i = findGroupIdx(name);
    if (i < 0) return { ok: false, why: '没有这个分组' };
    var g = groups()[i];
    if (g && !g.custom && isKnown(name)) return { ok: false, why: '这是站内出厂分组，删了会让对应功能没话可说；要清空请用「清空这一组」' };
    snapGroup(name);
    data.groups.splice(i, 1);
    persist(); refresh();
    return { ok: true, name: name };
  }

  function clearGroup(name) {
    var g = findGroup(name);
    if (!g) return { ok: false, why: '没有这个分组' };
    snapGroup(name);
    var n = (g.cards || []).length;
    g.cards = [];
    persist(); refresh();
    return { ok: true, cleared: n };
  }

  /* 撤销：只保留每组的最近一层快照 */
  function undoGroup(name) {
    var st = undoStore();
    if (!st || !isObj(st[name])) return { ok: false, why: '这一组没有可撤销的快照' };
    var snap = st[name];
    delete st[name];
    if (!snap.existed || !isObj(snap.group)) {
      var i = findGroupIdx(name);
      if (i >= 0) data.groups.splice(i, 1);
      persist(); refresh();
      return { ok: true, restored: 0 };
    }
    var g = findGroup(name);
    if (g) g.cards = clone(snap.group.cards || []);
    else if (siteReady() && Array.isArray(data.groups)) data.groups.push(clone(snap.group));
    persist(); refresh();
    return { ok: true, restored: (snap.group.cards || []).length };
  }
  function undoList() {
    var st = undoStore();
    return st ? Object.keys(st) : [];
  }

  /* ============ 3. 图标 ============ */

  var PS_ICO = '<rect x="3.4" y="4.6" width="17.2" height="15" rx="3"/>'
    + '<path d="M3.4 9.4h17.2"/>'
    + '<path d="M8 13.4h5.4"/><path d="M8 16.4h3.2"/>'
    + '<path d="M17.4 12.6v5.2M14.8 15.2h5.2"/>';
  var ICO_PLUS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

  /* ============ 4. 样式 ============ */

  var CSS = [
    '.ps-headbtn{flex:none;display:flex;align-items:center;gap:5px;min-height:34px;padding:0 12px;border:1px solid rgba(0,0,0,.13);border-radius:12px;background:#fff;color:var(--ink,#1c1917);font:inherit;font-size:12.5px}',
    '.ps-headbtn:active{opacity:.6}',
    '.ps-cats{display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;padding:3px 1px 10px;margin:2px 0 12px;position:relative;z-index:8;-webkit-overflow-scrolling:touch;scrollbar-width:none}',
    '.ps-cats::-webkit-scrollbar{display:none;height:0}',
    '.ps-chip{flex:none;padding:6px 11px;border:1px solid rgba(0,0,0,.13);border-radius:999px;background:#fff;color:var(--muted,#6b6a67);font:inherit;font-size:12px;white-space:nowrap}',
    '.ps-chip[aria-pressed=true]{background:var(--ink,#1c1917);border-color:var(--ink,#1c1917);color:#fff}',
    '.ps-grp{border:1px solid rgba(0,0,0,.08);border-radius:15px;background:rgba(0,0,0,.02);margin-bottom:9px;overflow:hidden}',
    '.ps-grp-hd{display:flex;align-items:center;gap:9px;width:100%;padding:11px 12px;border:0;background:none;font:inherit;color:inherit;text-align:left}',
    '.ps-grp-hd:active{opacity:.65}',
    '.ps-grp-tx{flex:1 1 auto;min-width:0}',
    '.ps-grp-tx b{display:block;font-size:13px;font-weight:600;color:var(--ink,#1c1917);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ps-grp-tx small{display:block;font-size:10.5px;color:var(--muted,#6b6a67);margin-top:3px;line-height:1.6}',
    '.ps-tag{flex:none;padding:2px 7px;border-radius:7px;font-size:10px;line-height:1.6;background:rgba(0,0,0,.06);color:var(--muted,#6b6a67)}',
    '.ps-tag.warn{background:rgba(178,83,106,.12);color:#8d4257}',
    '.ps-tag.ok{background:rgba(47,122,82,.12);color:#2f7a52}',
    '.ps-grp-bd{padding:0 12px 11px;border-top:1px solid rgba(0,0,0,.06)}',
    '.ps-card{display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px dashed rgba(0,0,0,.07)}',
    '.ps-card:last-child{border-bottom:0}',
    '.ps-card-n{flex:none;width:22px;font-size:10.5px;color:var(--muted,#6b6a67);text-align:right;font-variant-numeric:tabular-nums;padding-top:2px}',
    '.ps-card-tx{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.7;color:var(--ink,#1c1917);word-break:break-word}',
    '.ps-card-acts{flex:none;display:flex;gap:5px}',
    '.ps-mini{padding:3px 8px;border:1px solid rgba(0,0,0,.13);border-radius:8px;background:#fff;color:var(--muted,#6b6a67);font:inherit;font-size:11px;line-height:1.6}',
    '.ps-mini:active{opacity:.6}',
    '.ps-mini.danger{color:#8d4257;border-color:rgba(178,83,106,.32)}',
    '.ps-grp-ft{display:flex;gap:6px;flex-wrap:wrap;padding-top:9px}',
    '.ps-add{display:flex;gap:7px;align-items:flex-start;padding-top:9px}',
    '.ps-add textarea{flex:1 1 auto;min-width:0;min-height:56px;padding:9px 10px;border:1px solid rgba(0,0,0,.14);border-radius:11px;background:#fff;color:var(--ink,#1c1917);font:inherit;font-size:12.5px;line-height:1.7;resize:vertical}',
    '.ps-note{font-size:11.5px;line-height:1.75;color:var(--muted,#6b6a67);margin:10px 0 0}',
    '.ps-warn{margin:10px 0 0;padding:10px 12px;border-radius:13px;background:rgba(178,83,106,.09);font-size:11.5px;line-height:1.75;color:#8d4257}',
    '.ps-frm{display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid rgba(0,0,0,.06)}',
    '.ps-frm>span{flex:none;width:70px;font-size:12.5px;color:var(--muted,#6b6a67)}',
    '.ps-frm input[type=text],.ps-frm textarea{flex:1 1 auto;min-width:0;padding:9px 10px;border:1px solid rgba(0,0,0,.14);border-radius:11px;background:#fff;color:var(--ink,#1c1917);font:inherit;font-size:13px}',
    '.ps-frm textarea{min-height:96px;resize:vertical;line-height:1.75}',
    '.ps-acts{display:flex;gap:8px;margin-top:15px}',
    '.ps-acts .soft-btn{flex:1 1 auto;min-height:42px}',
    '.ps-empty{text-align:center;padding:18px 12px;font-size:12px;color:var(--muted,#6b6a67)}'
  ].join('\n');

  function injectStyle() {
    if (qs('#psStyle')) return;
    var s = document.createElement('style');
    s.id = 'psStyle';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ============ 5. 面板 ============ */

  var SHEET = ''
    + '<div class="fs-sheet-mask fs-sheet-full" id="psMask" hidden><div class="fs-sheet">'
    + '  <div class="fs-sheet-bar"><div class="fs-sheet-t"><span class="fs-sheet-ti">预设字卡管理</span><span class="fs-sheet-en">PRESETS</span></div>'
    + '  <button type="button" class="fs-sheet-close" id="psClose" aria-label="关闭">×</button></div>'
    + '  <div class="fs-sheet-body">'
    + '    <div class="ps-cats" id="psCats"></div>'
    + '    <div id="psList"></div>'
    + '    <div class="ps-acts" style="margin-top:12px">'
    + '      <button type="button" class="soft-btn" id="psNewGrp">＋ 新建分组</button>'
    + '      <button type="button" class="soft-btn" id="psUndoBtn">撤销上一次改动</button>'
    + '    </div>'
    + '    <p class="ps-warn"><b>哪些改动会真的生效？</b>站内是<b>按分组名</b>去取卡的（app.js 第 64198 行那种映射，例如「我同意后TA说」对应答"好"之后要说的话）。所以：<b>往已有分组里加卡＝立刻生效</b>；<b>自己起新名字的分组＝只存不抽</b>，站内不知道要去读它。下面每组都标了「站内会用」还是「只存不抽」。</p>'
    + '    <p class="ps-note">只动带 preset 标记的预设组，你自己字卡库里的组一律不碰。删卡、清空、删组之前都会存一层快照，可以用「撤销上一次改动」退回来（每组各留一层，只存在这台设备上，不进备份）。有些组的卡带前缀分段，比如「时辰的话」用「凌晨：」「清晨：」「夜里：」开头，照着同样的前缀写才会被归到对的时段。</p>'
    + '  </div></div></div>'

    + '<div class="fs-sheet-mask fs-sheet-full" id="psGrpMask" hidden><div class="fs-sheet">'
    + '  <div class="fs-sheet-bar"><div class="fs-sheet-t"><span class="fs-sheet-ti">新建分组</span><span class="fs-sheet-en">GROUP</span></div>'
    + '  <button type="button" class="fs-sheet-close" id="psGrpClose" aria-label="关闭">×</button></div>'
    + '  <div class="fs-sheet-body">'
    + '    <div class="ps-frm"><span>组名</span><input type="text" id="psGrpName" maxlength="20" placeholder="例如：一起看视频时说"></div>'
    + '    <div class="ps-frm"><span>字卡</span><textarea id="psGrpCards" placeholder="一行一条，例如：&#10;这段太好笑了&#10;暂停一下，我要记下来&#10;你看到第几分钟了"></textarea></div>'
    + '    <div class="ps-frm"><span>备注</span><input type="text" id="psGrpNote" maxlength="60" placeholder="选填，只给你自己看"></div>'
    + '    <p class="ps-warn">自名字的分组<b>不会被站内抽到</b>（站内按固定组名取卡）。想让你加的话真的被用上，请<b>往已有分组里加</b>——比如想让 TA 邀你听歌时多说几种话，就去「听歌」页签下的「TA邀我听歌时说」那一组里加。</p>'
    + '    <p class="ps-note">新建的组会归到「其他」页签下，标记为自建，可以随时删掉。</p>'
    + '    <div class="ps-acts"><button type="button" class="soft-btn" id="psGrpGo">建这个分组</button></div>'
    + '  </div></div></div>';

  var psState = { tab: '全部', open: {} };

  function injectSheet() {
    if (qs('#psMask')) return;
    document.body.insertAdjacentHTML('beforeend', SHEET);
    bindAll();
  }

  /* 在「系统预设字卡」页顶部塞一枚入口按钮（那个 .cards-greet 不会被重渲染，所以塞一次就够） */
  function injectPageBtn() {
    try {
      var greet = qs('#sysCardsView .cards-greet') || qs('#sysCardsView .home-greet');
      if (!greet || qs('#psPageBtn')) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-headbtn';
      b.id = 'psPageBtn';
      b.innerHTML = ICO_PLUS + '加自己的话';
      b.addEventListener('click', function () { psOpen(); });
      greet.appendChild(b);
    } catch (e) {}
  }

  /* ============ 6. 渲染 ============ */

  function listOfTab() {
    var gs = presetGroups();
    if (psState.tab === '全部') return gs;
    if (psState.tab === '只存不抽') return gs.filter(function (g) { return !isKnown(g.name); });
    if (psState.tab === '站内会用') return gs.filter(function (g) { return isKnown(g.name); });
    return gs.filter(function (g) { return featureOf(g) === psState.tab; });
  }

  function renderCats() {
    var box = qs('#psCats');
    if (!box) return;
    var tabs = ['全部'].concat(featureTabs()).concat(['站内会用', '只存不抽']);
    var seen = {};
    tabs = tabs.filter(function (t) { if (seen[t]) return false; seen[t] = 1; return true; });
    if (tabs.indexOf(psState.tab) < 0) psState.tab = '全部';
    box.innerHTML = tabs.map(function (t) {
      var n = t === '全部' ? presetGroups().length
        : (t === '站内会用' ? presetGroups().filter(function (g) { return isKnown(g.name); }).length
          : (t === '只存不抽' ? presetGroups().filter(function (g) { return !isKnown(g.name); }).length
            : presetGroups().filter(function (g) { return featureOf(g) === t; }).length));
      return '<button type="button" class="ps-chip" data-tab="' + esc(t) + '" aria-pressed="'
        + (psState.tab === t ? 'true' : 'false') + '">' + esc(t) + ' ' + n + '</button>';
    }).join('');
  }

  function renderList() {
    var box = qs('#psList');
    if (!box) return;
    var gs = listOfTab();
    if (!gs.length) { box.innerHTML = '<div class="ps-empty">这一档还没有预设分组</div>'; return; }
    box.innerHTML = gs.map(function (g) {
      var name = g.name || '(未命名)';
      var open = !!psState.open[name];
      var known = isKnown(name);
      var cards = Array.isArray(g.cards) ? g.cards : [];
      var head = '<div class="ps-grp"><button type="button" class="ps-grp-hd" data-grp="' + esc(name) + '" aria-expanded="' + (open ? 'true' : 'false') + '">'
        + '<span class="ps-grp-tx"><b>' + esc(name) + '</b><small>' + esc(featureOf(g))
        + ' · ' + cards.length + ' 条' + (g.custom ? ' · 自建' : '') + (g.note ? (' · ' + esc(g.note)) : '') + '</small></span>'
        + '<span class="ps-tag ' + (known ? 'ok' : 'warn') + '">' + (known ? '站内会用' : '只存不抽') + '</span>'
        + '<span class="ps-tag">' + (open ? '︿' : '﹀') + '</span></button>';
      if (!open) return head + '</div>';
      var body = '<div class="ps-grp-bd">'
        + (cards.length ? cards.map(function (c, i) {
          return '<div class="ps-card"><span class="ps-card-n">' + (i + 1) + '</span>'
            + '<span class="ps-card-tx">' + esc(cardStr(c)) + '</span>'
            + '<span class="ps-card-acts">'
            + '<button type="button" class="ps-mini" data-act="edit" data-g="' + esc(name) + '" data-i="' + i + '">改</button>'
            + '<button type="button" class="ps-mini danger" data-act="del" data-g="' + esc(name) + '" data-i="' + i + '">删</button>'
            + '</span></div>';
        }).join('') : '<div class="ps-empty" style="padding:12px 0">这一组还是空的</div>')
        + '<div class="ps-add"><textarea id="psNew_' + esc(name) + '" maxlength="' + MAX_LEN + '" placeholder="写一条新的，回车就能加"></textarea>'
        + '<button type="button" class="ps-mini" data-act="add" data-g="' + esc(name) + '">加</button></div>'
        + '<div class="ps-grp-ft">'
        + '<button type="button" class="ps-mini" data-act="addmany" data-g="' + esc(name) + '">一次加多条</button>'
        + '<button type="button" class="ps-mini danger" data-act="clear" data-g="' + esc(name) + '">清空这一组</button>'
        + (g.custom || !known ? '<button type="button" class="ps-mini danger" data-act="delgrp" data-g="' + esc(name) + '">删掉这一组</button>' : '')
        + (undoList().indexOf(name) >= 0 ? '<button type="button" class="ps-mini" data-act="undo" data-g="' + esc(name) + '">撤销这一组</button>' : '')
        + '</div></div>';
      return head + body + '</div>';
    }).join('');
  }

  function renderAll() { renderCats(); renderList(); }

  function psOpen() {
    if (!siteReady()) { toast('站内数据还没载入完，稍等一下再点'); return; }
    injectSheet();
    knownNames();
    renderAll();
    var m = qs('#psMask');
    if (m) m.hidden = false;
  }
  function psClose() { var m = qs('#psMask'); if (m) m.hidden = true; }

  /* ============ 7. 交互 ============ */

  function ask(title, msg, okText, danger, run) {
    try {
      if (typeof window.openModal === 'function') {
        window.openModal(title, '', function () { run(); }, { noInput: true, staticText: msg, okText: okText || '好', danger: !!danger });
        return;
      }
    } catch (e) {}
    if (window.confirm(msg)) run();
  }
  function askText(title, placeholder, run) {
    try {
      if (typeof window.openModal === 'function') {
        window.openModal(title, '', function (v) { run(v); }, { okText: '好' });
        return;
      }
    } catch (e) {}
    var v = window.prompt(title);
    if (v != null) run(v);
  }

  function bindAll() {
    var cl = qs('#psClose'); if (cl) cl.addEventListener('click', psClose);
    var m = qs('#psMask'); if (m) m.addEventListener('click', function (e) { if (e.target === m) psClose(); });

    var cats = qs('#psCats');
    if (cats) cats.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.ps-chip[data-tab]') : null;
      if (!b) return;
      psState.tab = b.dataset.tab;
      renderAll();
    });

    var list = qs('#psList');
    if (list) {
      list.addEventListener('click', function (e) {
        var hd = e.target.closest ? e.target.closest('.ps-grp-hd[data-grp]') : null;
        if (hd) {
          var nm = hd.dataset.grp;
          psState.open[nm] = !psState.open[nm];
          renderList();
          return;
        }
        var btn = e.target.closest ? e.target.closest('.ps-mini[data-act]') : null;
        if (!btn) return;
        var g = btn.dataset.g, act = btn.dataset.act, i = Number(btn.dataset.i);
        if (act === 'add') {
          var ta = qs('#psNew_' + g);
          var v = ta ? ta.value : '';
          if (!String(v).trim()) { toast('先写一条'); return; }
          if (String(v).indexOf('\n') >= 0) { doAddMany(g, v); return; }
          var r = addCard(g, v);
          if (!r.ok) { toast(r.why); return; }
          toast('加上了，这一组现在 ' + r.count + ' 条');
          renderList();
          return;
        }
        if (act === 'addmany') {
          var ta2 = qs('#psNew_' + g);
          askText('一次加多条（一行一条）', '', function (txt) {
            if (txt == null) return;
            doAddMany(g, txt);
          });
          if (ta2 && ta2.value) { doAddMany(g, ta2.value); }
          return;
        }
        if (act === 'edit') {
          var grp = findGroup(g);
          var cur = (grp && grp.cards && grp.cards[i] !== undefined) ? cardStr(grp.cards[i]) : '';
          askText('改这一条', '', function (v2) {
            if (v2 == null) return;
            var r2 = editCard(g, i, v2);
            if (!r2.ok) { toast(r2.why); return; }
            toast('改好了');
            renderList();
          });
          if (typeof window.openModal !== 'function') return;
          try { var inp = qs('#appModalInput'); if (inp) inp.value = cur; } catch (e) {}
          return;
        }
        if (act === 'del') {
          ask('删掉这一条', '确定删掉第 ' + (i + 1) + ' 条吗？可以用「撤销这一组」退回来。', '删掉', true, function () {
            var r3 = delCard(g, i);
            if (!r3.ok) { toast(r3.why); return; }
            toast('删掉了，这一组还剩 ' + r3.left + ' 条');
            renderList();
          });
          return;
        }
        if (act === 'clear') {
          ask('清空这一组', '把「' + g + '」里的字卡全删掉？分组本身留着。可以用「撤销这一组」退回来。', '清空', true, function () {
            var r4 = clearGroup(g);
            if (!r4.ok) { toast(r4.why); return; }
            toast('清空了 ' + r4.cleared + ' 条');
            renderList();
          });
          return;
        }
        if (act === 'delgrp') {
          ask('删掉这一组', '把分组「' + g + '」连同里面的字卡一起删掉？可以用「撤销这一组」退回来。', '删掉', true, function () {
            var r5 = delGroup(g);
            if (!r5.ok) { toast(r5.why); return; }
            delete psState.open[g];
            toast('删掉了');
            renderAll();
          });
          return;
        }
        if (act === 'undo') {
          var r6 = undoGroup(g);
          if (!r6.ok) { toast(r6.why); return; }
          toast('已退回，这一组现在 ' + r6.restored + ' 条');
          renderList();
        }
      });
      list.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.shiftKey) return;
        var ta = e.target;
        if (!ta || ta.tagName !== 'TEXTAREA') return;
        var idm = /^psNew_(.+)$/.exec(ta.id || '');
        if (!idm) return;
        var v = String(ta.value || '');
        if (!v.trim()) return;
        e.preventDefault();
        if (v.indexOf('\n') >= 0) { doAddMany(idm[1], v); return; }
        var r = addCard(idm[1], v);
        if (!r.ok) { toast(r.why); return; }
        toast('加上了，这一组现在 ' + r.count + ' 条');
        renderList();
      });
    }

    var ng = qs('#psNewGrp');
    if (ng) ng.addEventListener('click', function () {
      ['psGrpName', 'psGrpCards', 'psGrpNote'].forEach(function (id) { var el = qs('#' + id); if (el) el.value = ''; });
      var gm = qs('#psGrpMask'); if (gm) gm.hidden = false;
    });
    var gc = qs('#psGrpClose');
    if (gc) gc.addEventListener('click', function () { var gm = qs('#psGrpMask'); if (gm) gm.hidden = true; });
    var gg = qs('#psGrpGo');
    if (gg) gg.addEventListener('click', function () {
      var r = addGroup((qs('#psGrpName') || {}).value, (qs('#psGrpCards') || {}).value, (qs('#psGrpNote') || {}).value);
      if (!r.ok) { toast(r.why); return; }
      var gm = qs('#psGrpMask'); if (gm) gm.hidden = true;
      psState.open[r.name] = true;
      renderAll();
      toast(r.usable ? ('建好了：' + r.name + '（' + r.count + ' 条）') : ('建好了：' + r.name + '（' + r.count + ' 条）· 提醒：这个名字站内不会去抽'));
    });
    var gm2 = qs('#psGrpMask');
    if (gm2) gm2.addEventListener('click', function (e) { if (e.target === gm2) gm2.hidden = true; });

    var ub = qs('#psUndoBtn');
    if (ub) ub.addEventListener('click', function () {
      var names = undoList();
      if (!names.length) { toast('没有可撤销的改动'); return; }
      ask('撤销上一次改动', '现在有这些组存着快照：\n' + names.join('\n') + '\n\n全部退回改动前的样子？', '全部撤销', true, function () {
        var n = 0;
        names.forEach(function (nm) { if (undoGroup(nm).ok) n++; });
        renderAll();
        toast('撤销了 ' + n + ' 组');
      });
    });
  }

  function doAddMany(groupName, text) {
    var lines = String(text || '').split('\n');
    var n = 0, bad = 0;
    lines.forEach(function (ln) {
      var t = String(ln || '').trim();
      if (!t) return;
      var r = addCard(groupName, t);
      if (r.ok) n++; else bad++;
    });
    toast(n ? ('加上了 ' + n + ' 条' + (bad ? ('，' + bad + ' 条没加进去') : '')) : '一条都没加进去');
    renderList();
  }

  /* ============ 8. 路由与磁贴 ============ */

  function hookRouter() {
    try {
      if (typeof window.showView !== 'function' || window.showView.__psWrapped) return;
      var orig = window.showView;
      var wrap = function (name) {
        if (name === 'presetmgr') { psOpen(); return; }
        return orig.apply(this, arguments);
      };
      wrap.__psWrapped = 1;
      wrap.__mnWrapped = orig.__mnWrapped;
      wrap.__bulkWrapped = orig.__bulkWrapped;
      wrap.__vidWrapped = orig.__vidWrapped;
      wrap.__calWrapped = orig.__calWrapped;
      window.showView = wrap;
    } catch (e) {}
  }

  function hookTile() {
    try {
      if (typeof HUB_GROUPS === 'undefined' || !HUB_GROUPS || !HUB_GROUPS.length) return;
      var dup = false;
      HUB_GROUPS.forEach(function (g) { (g.rows || []).forEach(function (r) { if (r && r.nav === 'presetmgr') dup = true; }); });
      if (dup) return;
      var host = null, want = ['记录', '陪伴', '玩'];
      for (var w = 0; w < want.length && !host; w++) {
        for (var i = 0; i < HUB_GROUPS.length; i++) if (HUB_GROUPS[i] && HUB_GROUPS[i].name === want[w]) { host = HUB_GROUPS[i]; break; }
      }
      if (!host) host = HUB_GROUPS[0];
      if (!host || !host.rows) return;
      host.rows.push({
        ico: PS_ICO, name: '预设字卡', nav: 'presetmgr',
        desc: '给站内那些预设分组补自己的话：按分组名取卡，所以往已有分组里加就立刻生效；也能新建分组（自名字的只存不抽）',
        more: { o: 10, d: '给预设分组补话 · 可撤销' }
      });
      if (typeof renderMorePage === 'function') renderMorePage();
      hookMoreClicks();
      if (typeof renderHubPage === 'function' && document.body.dataset.view === 'hub') renderHubPage();
    } catch (e) {}
  }

  function hookMoreClicks() {
    try {
      var list = document.getElementById('moreList');
      if (!list) return;
      if (list.dataset.calBound === '1' || list.dataset.vidBound === '1' || list.dataset.bulkBound === '1'
        || list.dataset.mnBound === '1' || list.dataset.psBound === '1') return;
      list.dataset.psBound = '1';
      list.addEventListener('click', function (e) {
        var b = (e.target && e.target.closest) ? e.target.closest('[data-view]') : null;
        if (!b || !list.contains(b)) return;
        var v = b.dataset.view;
        if (!v) return;
        if (v.charAt(0) === '#' && typeof _hubRoute === 'function') { try { _hubRoute(v); } catch (err) {} return; }
        if (typeof window.showView === 'function') window.showView(v);
      });
    } catch (e) {}
  }

  /* ============ 9. 启动 ============ */

  function boot() {
    try { injectStyle(); injectSheet(); injectPageBtn(); hookRouter(); hookTile(); hookMoreClicks(); }
    catch (e) { try { console.warn('[预设字卡管理模块] 初始化失败', e); } catch (e2) {} }
  }

  boot();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); });
  }
  try {
    document.addEventListener('ordinal-data-ready', function () {
      injectPageBtn(); hookTile();
      try { knownNames(); } catch (e) {}
    });
  } catch (e) {}

  try {
    window.__psModuleReady = PS_VER;
    window.__psDebug = {
      presetGroups: presetGroups, findGroup: findGroup, featureOf: featureOf, featureTabs: featureTabs,
      knownNames: knownNames, isKnown: isKnown, cardStr: cardStr, cleanText: cleanText,
      addCard: addCard, editCard: editCard, delCard: delCard,
      addGroup: addGroup, delGroup: delGroup, clearGroup: clearGroup,
      undoGroup: undoGroup, undoList: undoList, snapGroup: snapGroup, MAX_LEN: MAX_LEN
    };
    window.__psSelfTest = function () {
      var out = { 模块版本: PS_VER, 站点data就绪: siteReady() };
      try {
        var gs = presetGroups();
        out.预设分组数 = gs.length;
        out.预设字卡总数 = gs.reduce(function (a, g) { return a + ((g.cards || []).length); }, 0);
        out.站内会用的组 = gs.filter(function (g) { return isKnown(g.name); }).length;
        out.只存不抽的组 = gs.filter(function (g) { return !isKnown(g.name); }).length;
        out.页签 = featureTabs().join(' / ');
        out.可撤销的组 = undoList().length;
        out.自己字卡库的组数 = groups().filter(function (g) { return g && !g.preset; }).length;
      } catch (e) { out.数据层 = '失败 ' + e; }
      try { out.页面入口按钮 = !!document.getElementById('psPageBtn'); } catch (e2) {}
      try { out.面板已注入 = !!document.getElementById('psMask'); } catch (e3) {}
      try { out.路由已接管 = !!(window.showView && window.showView.__psWrapped); } catch (e4) {}
      try {
        out.磁贴已加入 = (typeof HUB_GROUPS !== 'undefined') && HUB_GROUPS.some(function (g) {
          return (g.rows || []).some(function (r) { return r && r.nav === 'presetmgr'; });
        });
      } catch (e5) {}
      try { if (console.table) console.table(out); else console.log(out); } catch (e6) {}
      return out;
    };
  } catch (e) {}
})();
