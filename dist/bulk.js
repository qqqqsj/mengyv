/* 言字卡 · 统一设置（按人设置批量套用）模块 v1.0.0 —— 独立文件，不修改 app.v22.2.1.js
 *
 * 安装：本文件放进 dist/ ，在 index.html 里已有那几行的最后面加一行：
 *         <script defer src="dist/bulk.js"></script>
 *
 * 解决什么：站内「TA 的设置」是按人一本账的，想让几位联系人的回复频率等设置一样，
 *          就得一个个进去点。本模块让你选一位当模板，一次性套给全部或选中的几位。
 *
 * 覆盖的六本按人账（都在 app.js 里核实过）：
 *   data.chatSettings[cid]   回复设置主体：回复节奏、主动行为、已读不回、别频繁主动找、语音等
 *   data.callSettingsBy[cid] 通话设置
 *   data.collectBy[cid]      收藏设置（收什么、发回概率）
 *   data.emotionBy[cid]      聊天情绪字卡
 *   data.callLookBy[cid]     通话美化
 *   data.playerBy[cid]       播放器权限（能不能邀你一起听等）
 *
 * 安全设计：
 *   · 深拷贝，绝不让两位联系人共享同一个对象引用
 *   · 应用前自动快照，可撤销一次（快照存本机 ordinal-bulk-snap，不随备份走）
 *   · 群聊不在范围内（群内成员是另一套 groupBh 结构）
 *   · 改完 chatSettings 会重指 data.behavior —— 站内第 8196、11271 行的约定是
 *     data.behavior 始终指向当前会话那一本，漏了这步当前聊天页会读到旧对象
 */
(function () {
  'use strict';

  var BULK_VER = '1.1.0';
  var SNAP_KEY = 'ordinal-bulk-snap';

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
  function stamp(ts) {
    var d = new Date(ts || Date.now());
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ============ 1. 六本按人账 ============ */

  var STORES = [
    { k: 'chatSettings', label: '回复设置', desc: '回复节奏 · 主动行为 · 已读不回 · 别频繁主动找 · 语音', kind: 'book', on: true },
    { k: 'callSettingsBy', label: '通话设置', desc: '语音/视频通话按人的那些开关', kind: 'patch', on: false },
    { k: 'collectBy', label: '收藏设置', desc: 'TA 收什么、多大概率把收藏发回聊天', kind: 'patch', on: false },
    { k: 'emotionBy', label: '聊天情绪字卡', desc: '按人调的情绪字卡那一本', kind: 'patch', on: false },
    { k: 'callLookBy', label: '通话美化', desc: '通话界面的按人美化', kind: 'patch', on: false },
    { k: 'playerBy', label: '播放器权限', desc: 'TA 能不能邀你一起听、曲终替你做哪几件事', kind: 'patch', on: false }
  ];

  function soloContacts() {
    try {
      return ((data.contacts || []).filter(function (c) { return c && c.id && c.kind !== 'group'; }));
    } catch (e) { return []; }
  }
  function nameOf(cid) {
    try {
      if (typeof chatPartnerNameOf === 'function') { var n = chatPartnerNameOf(cid); if (n) return n; }
    } catch (e) {}
    var cs = soloContacts();
    for (var i = 0; i < cs.length; i++) if (cs[i].id === cid) return cs[i].name || '';
    return '';
  }

  /* 模板这一本的内容；useDefault 时用全站出厂默认当模板 */
  function bookOf(storeKey, cid, useDefault) {
    if (useDefault) {
      try {
        if (storeKey === 'chatSettings' && typeof defaults !== 'undefined' && defaults.behavior) return clone(defaults.behavior);
      } catch (e) {}
      return null;
    }
    try {
      var m = data[storeKey];
      if (!isObj(m)) return null;
      return isObj(m[cid]) ? m[cid] : null;
    } catch (e) { return null; }
  }

  function storeCount(storeKey) {
    try {
      var m = data[storeKey];
      return isObj(m) ? Object.keys(m).length : 0;
    } catch (e) { return 0; }
  }

  /* ============ 2. 快照与撤销 ============ */

  function readSnap() {
    try {
      var raw = localStorage.getItem(SNAP_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeSnap(snap) {
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(snap)); return true; } catch (e) { return false; }
  }
  function clearSnap() { try { localStorage.removeItem(SNAP_KEY); } catch (e) {} }

  /* ============ 3. 应用 ============ */

  function bulkApply(opts) {
    var src = opts.src, useDef = !!opts.useDefault, keys = opts.stores || [], targets = opts.targets || [];
    if (!siteReady()) return { ok: false, why: '站内数据还没就绪' };
    if (!keys.length) return { ok: false, why: '还没选要复制哪几本账' };
    if (!targets.length) return { ok: false, why: '还没选应用到谁' };
    if (!useDef && !src) return { ok: false, why: '还没选模板' };
    // 群聊不在范围内：群内成员用的是另一套 groupBh 结构，写进去会串味
    var soloIds = {};
    soloContacts().forEach(function (c) { soloIds[c.id] = 1; });
    targets = targets.filter(function (id) { return !!soloIds[id]; });
    if (!targets.length) return { ok: false, why: '没有可套用的目标（群聊不在范围内）' };
    if (!useDef && targets.indexOf(src) >= 0 && targets.length === 1) return { ok: false, why: '只有模板自己，没什么可套的' };

    var snap = { at: Date.now(), src: useDef ? '' : src, useDef: useDef, items: {} };
    var changed = 0, perStore = {}, skipped = [];

    keys.forEach(function (sk) {
      var def = null;
      for (var i = 0; i < STORES.length; i++) if (STORES[i].k === sk) def = STORES[i];
      if (!def) return;
      var srcBook = bookOf(sk, src, useDef);
      if (def.kind === 'book' && !isObj(srcBook)) {
        // 整本账（chatSettings）绝不能删：站内 data.behavior 是它的别名，删了会让当前聊天页的设置写了不生效。
        // 所以缺模板时退回全站出厂默认，仍然写一本完整的进去。
        try { if (typeof defaults !== 'undefined' && isObj(defaults.behavior)) srcBook = clone(defaults.behavior); } catch (e) {}
        if (!isObj(srcBook)) { skipped.push(sk); return; }   // 连出厂默认都拿不到，这一本整个跳过
      }
      if (!isObj(data[sk])) data[sk] = {};
      var n = 0;
      snap.items[sk] = {};
      targets.forEach(function (cid) {
        if (!useDef && cid === src) return;
        var before = isObj(data[sk][cid]) ? clone(data[sk][cid]) : null;
        snap.items[sk][cid] = before;
        if (isObj(srcBook)) data[sk][cid] = clone(srcBook);
        else delete data[sk][cid];      // 补丁型账本：模板没有＝跟随全站默认，删掉按人覆盖
        n++;
      });
      perStore[sk] = n;
      changed += n;
    });

    // 站内约定：data.behavior 始终指向当前会话那一本（app.js 8196 / 11271 行）
    healAlias();

    if (!writeSnap(snap)) snapFailed = true; else snapFailed = false;
    try { if (typeof save === 'function') save(); } catch (e) {}
    refreshUi();
    return { ok: true, changed: changed, perStore: perStore, skipped: skipped, snapSaved: !snapFailed };
  }
  var snapFailed = false;

  function bulkUndo() {
    var snap = readSnap();
    if (!snap || !snap.items) return { ok: false, why: '没有可撤销的快照' };
    if (!siteReady()) return { ok: false, why: '站内数据还没就绪' };
    var n = 0;
    Object.keys(snap.items).forEach(function (sk) {
      if (!isObj(data[sk])) data[sk] = {};
      var one = snap.items[sk] || {};
      Object.keys(one).forEach(function (cid) {
        if (one[cid]) { data[sk][cid] = clone(one[cid]); }
        else { delete data[sk][cid]; }
        n++;
      });
    });
    healAlias();
    clearSnap();
    try { if (typeof save === 'function') save(); } catch (e) {}
    refreshUi();
    return { ok: true, restored: n, at: snap.at };
  }

  /* 站内约定：data.behavior 始终指向当前会话那一本（app.js 8196 / 11271 行）。
   * 若那本意外缺失，就地补一本出厂默认，绝不让别名指向脱离的对象。 */
  function healAlias() {
    try {
      if (!data.activeChat) return;
      if (!isObj(data.chatSettings)) data.chatSettings = {};
      if (!isObj(data.chatSettings[data.activeChat])) {
        var seed = null;
        try { if (typeof defaults !== 'undefined' && isObj(defaults.behavior)) seed = clone(defaults.behavior); } catch (e) {}
        if (!seed) return;
        data.chatSettings[data.activeChat] = seed;
      }
      data.behavior = data.chatSettings[data.activeChat];
    } catch (e) {}
  }

  function refreshUi() {
    try {
      var v = document.body.dataset.view;
      if (v === 'mate' && typeof renderProfile === 'function') renderProfile();
      if (v === 'mate' && typeof renderFolds === 'function') renderFolds();
      if (v === 'settings' && typeof renderApSettings === 'function') renderApSettings();
      if (typeof renderChatsList === 'function' && (v === 'chats')) renderChatsList();
    } catch (e) {}
  }

  /* ============ 3b. 群聊跟随单聊 ============
   * 站内机制（app.js 已核实）：
   *   群聊的基线＝这个群自己那本 data.chatSettings[群id]（_gbhGroup，14844 行）
   *   每位成员的覆盖＝data.groupBh[群id].bh[成员名]（_gbhPatch，14849 行）
   *   合并结果＝_gbhMerged(群id, 成员名)，且只有 GBH_KEYS 白名单里的键生效（14819-14826 行）
   *   群聊回复引擎确实读它（16620、16628、16929 行），所以改这份数据就能改群里的回复行为
   * 写入一律走站内自己的 _gbhSet（14874 行）：它管类型（布尔必须是真布尔）、
   * 按 GBH_RANGE 夹范围、自动建嵌套结构，且 _gbhSanitize（14909 行）重启后认它写的格式。
   */

  function groupContacts() {
    try {
      return (data.contacts || []).filter(function (c) { return c && c.id && c.kind === 'group' && Array.isArray(c.members); });
    } catch (e) { return []; }
  }
  function soloByName(name) {
    var cs = soloContacts();
    for (var i = 0; i < cs.length; i++) if (cs[i].name === name) return cs[i];
    return null;
  }
  function gbhKeys() {
    try { if (typeof GBH_KEYS !== 'undefined' && Array.isArray(GBH_KEYS)) return GBH_KEYS; } catch (e) {}
    return [];
  }

  /* 让群里每位成员跟随他自己的单聊设置 */
  function groupFollowSolo(gids) {
    if (!siteReady()) return { ok: false, why: '站内数据还没就绪' };
    var keys = gbhKeys();
    if (!keys.length) return { ok: false, why: '取不到站内的 GBH_KEYS 白名单（app.js 没载完？）' };
    if (typeof _gbhSet !== 'function') return { ok: false, why: '取不到站内的 _gbhSet 写入函数' };
    var gs = groupContacts().filter(function (g) { return !gids || !gids.length || gids.indexOf(g.id) >= 0; });
    if (!gs.length) return { ok: false, why: '没有群聊可选' };
    var members = 0, wrote = 0, skipped = 0;
    gs.forEach(function (g) {
      (g.members || []).forEach(function (nm) {
        var solo = soloByName(nm);
        if (!solo) { skipped++; return; }
        var book = (data.chatSettings || {})[solo.id];
        if (!isObj(book)) { skipped++; return; }
        var hit = 0;
        keys.forEach(function (k) {
          var v = book[k];
          if (v === undefined || v === null || v === '') return;   // 没有这一项就别写默认值进去当覆盖
          _gbhSet(g.id, nm, k, v);
          hit++;
        });
        if (hit) { members++; wrote += hit; } else skipped++;
      });
    });
    try { if (typeof save === 'function') save(); } catch (e) {}
    refreshUi();
    return { ok: true, groups: gs.length, members: members, wrote: wrote, skipped: skipped };
  }

  /* 清掉群内按人覆盖 → 每位成员回到「跟随这个群自己的设置」 */
  function groupUnfollow(gids) {
    if (!siteReady()) return { ok: false, why: '站内数据还没就绪' };
    var gs = groupContacts().filter(function (g) { return !gids || !gids.length || gids.indexOf(g.id) >= 0; });
    if (!gs.length) return { ok: false, why: '没有群聊可选' };
    var n = 0;
    gs.forEach(function (g) {
      var e = isObj(data.groupBh) ? data.groupBh[g.id] : null;
      if (!e || !isObj(e.bh)) return;
      Object.keys(e.bh).forEach(function (nm) {
        if (typeof _gbhFollow === 'function') _gbhFollow(g.id, nm);
        else delete e.bh[nm];
        n++;
      });
    });
    try { if (typeof save === 'function') save(); } catch (e) {}
    refreshUi();
    return { ok: true, groups: gs.length, cleared: n };
  }

  /* 预览：某位成员在群里现在实际生效的值 vs 他单聊的值 */
  function groupDiffPreview(gid, name) {
    var out = { merged: null, solo: null, diff: [] };
    try {
      if (typeof _gbhMerged === 'function') out.merged = _gbhMerged(gid, name);
    } catch (e) {}
    var solo = soloByName(name);
    if (solo && isObj(data.chatSettings) && isObj(data.chatSettings[solo.id])) out.solo = data.chatSettings[solo.id];
    if (out.merged && out.solo) {
      gbhKeys().forEach(function (k) {
        if (out.solo[k] === undefined) return;
        if (JSON.stringify(out.merged[k]) !== JSON.stringify(out.solo[k])) out.diff.push(k);
      });
    }
    return out;
  }

  /* ============ 4. 图标（24×24 线性描边，与站内一套；无 emoji） ============ */

  var BULK_ICO = '<rect x="3" y="4" width="8" height="7" rx="2.2"/>'
    + '<rect x="13" y="4" width="8" height="7" rx="2.2"/>'
    + '<rect x="3" y="14" width="8" height="7" rx="2.2"/>'
    + '<path d="M17 14v7M13.6 17.6h6.8"/>';

  /* ============ 5. 样式 ============ */

  var CSS = [
    '.bk-sec{margin:16px 0 7px;font-size:12px;font-weight:600;color:var(--ink,#1c1917)}',
    '.bk-who{display:flex;gap:6px;flex-wrap:wrap}',
    '.bk-chip{padding:7px 11px;border:1px solid rgba(0,0,0,.14);border-radius:999px;background:#fff;color:var(--muted,#6b6a67);font:inherit;font-size:12px}',
    '.bk-chip[aria-pressed=true]{background:var(--ink,#1c1917);border-color:var(--ink,#1c1917);color:#fff}',
    '.bk-store{display:flex;align-items:flex-start;gap:9px;padding:9px 11px;border-radius:13px;background:rgba(0,0,0,.028);margin-bottom:6px;width:100%;border:0;font:inherit;color:inherit;text-align:left}',
    '.bk-store[aria-pressed=true]{background:rgba(0,0,0,.085)}',
    '.bk-store-tx{flex:1 1 auto;min-width:0}',
    '.bk-store-tx b{display:block;font-size:12.5px;font-weight:600;color:var(--ink,#1c1917)}',
    '.bk-store-tx small{display:block;font-size:11px;color:var(--muted,#6b6a67);margin-top:3px;line-height:1.6}',
    '.bk-store-n{flex:none;font-size:11px;color:var(--muted,#6b6a67);font-variant-numeric:tabular-nums}',
    '.bk-sum{margin:12px 0 0;padding:11px 12px;border-radius:14px;background:rgba(0,0,0,.035);font-size:12px;line-height:1.8;color:var(--ink,#1c1917)}',
    '.bk-sum b{font-weight:600}',
    '.bk-acts{display:flex;gap:8px;margin-top:14px}',
    '.bk-acts .soft-btn{flex:1 1 auto;min-height:42px}',
    '.bk-note{font-size:11.5px;line-height:1.75;color:var(--muted,#6b6a67);margin:10px 0 0}',
    '.bk-warn{margin:10px 0 0;padding:10px 12px;border-radius:13px;background:rgba(178,83,106,.09);font-size:11.5px;line-height:1.75;color:#8d4257}',
    '.bk-snap{margin:14px 0 0;padding:10px 12px;border-radius:13px;background:rgba(0,0,0,.035);font-size:11.5px;line-height:1.7;color:var(--muted,#6b6a67)}'
  ].join('\n');

  function injectStyle() {
    if (qs('#bulkStyle')) return;
    var s = document.createElement('style');
    s.id = 'bulkStyle';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ============ 6. 面板 ============ */

  var SHEET = ''
    + '<div class="fs-sheet-mask fs-sheet-full" id="bulkMask" hidden>'
    + '  <div class="fs-sheet">'
    + '    <div class="fs-sheet-bar">'
    + '      <div class="fs-sheet-t"><span class="fs-sheet-ti">统一设置</span><span class="fs-sheet-en">APPLY TO ALL</span></div>'
    + '      <button type="button" class="fs-sheet-close" id="bulkClose" aria-label="关闭">×</button>'
    + '    </div>'
    + '    <div class="fs-sheet-body">'
    + '      <p class="bk-note" style="margin-top:0">选一位当模板，把他的按人设置一次性套给其他几位——不用再一个个进去点。</p>'
    + '      <div class="bk-sec">一、模板从哪来</div>'
    + '      <div class="bk-who" id="bkSrcRow"></div>'
    + '      <div class="bk-sec">二、复制哪几本账</div>'
    + '      <div id="bkStoreList"></div>'
    + '      <div class="bk-sec">三、套给谁</div>'
    + '      <div class="bk-who" id="bkScopeRow">'
    + '        <button type="button" class="bk-chip" data-scope="all" aria-pressed="true">全部联系人</button>'
    + '        <button type="button" class="bk-chip" data-scope="pick" aria-pressed="false">我自己挑</button>'
    + '      </div>'
    + '      <div class="bk-who" id="bkTargetRow" style="margin-top:7px" hidden></div>'
    + '      <div class="bk-sec">四、群聊跟随单聊（可选）</div>'
    + '      <p class="bk-note" style="margin-top:0">站内群聊的基线是<b>这个群自己那本设置</b>，每位成员再叠一层按人覆盖。下面这一键把每位成员<b>单聊里的那本</b>抄进他的群内覆盖，于是他在群里忙不忙、多久回、回几条、会不会已读不回，都跟他单聊时一致。</p>'
    + '      <div class="bk-who" id="bkGroupRow"></div>'
    + '      <div class="bk-acts">'
    + '        <button type="button" class="soft-btn" id="bkGroupGo">让群里每位跟随他自己的单聊设置</button>'
    + '      </div>'
    + '      <div class="bk-acts">'
    + '        <button type="button" class="soft-btn" id="bkGroupUndo">清掉群内按人覆盖（回到跟随群设置）</button>'
    + '      </div>'
    + '      <p class="bk-note" id="bkGroupNote"></p>'
    + '      <p class="bk-note">只有站内白名单里的键能按人覆盖（回复延迟 rsMin/rsMax、回几条 replyMin/replyMax、已读不回 rcProb/rcRefix、按状态 rnByState、主动概率 rnProb、表情/图片/语音概率等）。白名单之外的项，群里本来就是共用群那本设置，不在这一步的范围内。写入走站内自己的函数，会按各项范围夹好、布尔保持布尔，重启后不会被清洗掉。</p>'
    + '      <div class="bk-sum" id="bkSum"></div>'
    + '      <div class="bk-acts">'
    + '        <button type="button" class="soft-btn" id="bkGo">套用到这几位</button>'
    + '      </div>'
    + '      <div class="bk-snap" id="bkSnap"></div>'
    + '      <p class="bk-warn">套用会<b>覆盖</b>目标联系人原有的这几本账，原来的值会被替换掉。应用前会自动存一层快照，可以用下面的「撤销」退回去；但快照只保留最近一次，且只存在这台设备上（不进备份、清站点数据就没了）。群聊不在范围内——群内成员用的是另一套结构。</p>'
    + '      <p class="bk-note">「跟随全站默认」的意思：模板这一本没有按人覆盖时，套过去等于<b>删掉</b>目标的按人覆盖，让他回到全站默认那套。这是站内本来的语义（app.js 第 60306-60308 行按人覆盖是叠在全站默认上的）。</p>'
    + '      <div class="bk-acts">'
    + '        <button type="button" class="soft-btn" id="bkUndo">撤销上一次套用</button>'
    + '      </div>'
    + '    </div>'
    + '  </div>'
    + '</div>';

  var bkState = { src: '', useDef: false, scope: 'all', picked: [], stores: {} };

  function injectDom() {
    if (qs('#bulkMask')) return;
    document.body.insertAdjacentHTML('beforeend', SHEET);
    STORES.forEach(function (s) { bkState.stores[s.k] = !!s.on; });
    bindAll();
  }

  function renderSrc() {
    var box = qs('#bkSrcRow');
    if (!box) return;
    var cs = soloContacts();
    var html = '<button type="button" class="bk-chip" data-src="__default__" aria-pressed="'
      + (bkState.useDef ? 'true' : 'false') + '">全站默认（等于清掉按人设置）</button>';
    html += cs.map(function (c) {
      return '<button type="button" class="bk-chip" data-src="' + esc(c.id) + '" aria-pressed="'
        + (!bkState.useDef && bkState.src === c.id ? 'true' : 'false') + '">' + esc(c.name || '(未命名)') + '</button>';
    }).join('');
    box.innerHTML = cs.length ? html : '<span class="bk-note" style="margin:0">还没有联系人</span>';
  }

  function renderStores() {
    var box = qs('#bkStoreList');
    if (!box) return;
    box.innerHTML = STORES.map(function (s) {
      var has = bkState.useDef ? (s.k === 'chatSettings' ? '出厂默认' : '无（＝跟随默认）')
        : (bookOf(s.k, bkState.src, false) ? '有' : '无（＝跟随默认）');
      return '<button type="button" class="bk-store" data-store="' + s.k + '" aria-pressed="'
        + (bkState.stores[s.k] ? 'true' : 'false') + '">'
        + '<span class="bk-store-tx"><b>' + esc(s.label) + '</b><small>' + esc(s.desc) + '</small></span>'
        + '<span class="bk-store-n">' + esc(has) + '<br>全站 ' + storeCount(s.k) + ' 位</span></button>';
    }).join('');
  }

  function renderTargets() {
    var row = qs('#bkTargetRow');
    if (!row) return;
    row.hidden = bkState.scope !== 'pick';
    if (bkState.scope !== 'pick') return;
    var cs = soloContacts();
    row.innerHTML = cs.map(function (c) {
      return '<button type="button" class="bk-chip" data-tgt="' + esc(c.id) + '" aria-pressed="'
        + (bkState.picked.indexOf(c.id) >= 0 ? 'true' : 'false') + '">' + esc(c.name || '(未命名)') + '</button>';
    }).join('') || '<span class="bk-note" style="margin:0">还没有联系人</span>';
  }

  function pickedGroups() {
    var box = qs('#bkGroupRow');
    if (!box) return [];
    var all = qs('#bkGroupRow .bk-chip[data-grp=\"__all__\"]');
    var on = qsa('#bkGroupRow .bk-chip[data-grp]').filter(function (x) {
      return x.dataset.grp !== '__all__' && x.getAttribute('aria-pressed') === 'true';
    }).map(function (x) { return x.dataset.grp; });
    if (all && all.getAttribute('aria-pressed') === 'true') return groupContacts().map(function (g) { return g.id; });
    return on;
  }

  function targetIds() {
    var cs = soloContacts().map(function (c) { return c.id; });
    if (bkState.scope === 'pick') return cs.filter(function (id) { return bkState.picked.indexOf(id) >= 0; });
    return cs;
  }

  function renderGroups() {
    var box = qs('#bkGroupRow');
    if (!box) return;
    var gs = groupContacts();
    if (!gs.length) { box.innerHTML = '<span class="bk-note" style="margin:0">还没有群聊</span>'; return; }
    box.innerHTML = '<button type="button" class="bk-chip" data-grp="__all__" aria-pressed="true">全部群</button>'
      + gs.map(function (g) {
        var n = 0;
        try { n = Object.keys((data.groupBh && data.groupBh[g.id] && data.groupBh[g.id].bh) || {}).length; } catch (e) {}
        return '<button type="button" class="bk-chip" data-grp="' + esc(g.id) + '" aria-pressed="false">'
          + esc(g.name || '(未命名群)') + ' · ' + (g.members || []).length + ' 人' + (n ? (' · 已覆盖 ' + n) : '') + '</button>';
      }).join('');
    var note = qs('#bkGroupNote');
    if (note) {
      var lines = [];
      gs.forEach(function (g) {
        (g.members || []).forEach(function (nm) {
          var d = groupDiffPreview(g.id, nm);
          if (d.diff && d.diff.length) lines.push(esc(g.name || '群') + ' 里的 ' + esc(nm) + '：有 ' + d.diff.length + ' 项与他单聊不一致');
        });
      });
      note.innerHTML = lines.length ? ('现在对不上的：' + lines.slice(0, 6).join('；') + (lines.length > 6 ? (' 等 ' + lines.length + ' 处') : '')) : '各群成员当前都跟自己单聊一致。';
    }
  }

  function renderSum() {
    var box = qs('#bkSum');
    if (!box) return;
    var keys = STORES.filter(function (s) { return bkState.stores[s.k]; }).map(function (s) { return s.label; });
    var tg = targetIds().filter(function (id) { return bkState.useDef || id !== bkState.src; });
    var srcName = bkState.useDef ? '全站默认' : (bkState.src ? (nameOf(bkState.src) || '（未选）') : '（未选）');
    box.innerHTML = '模板：<b>' + esc(srcName) + '</b><br>'
      + '复制：<b>' + esc(keys.length ? keys.join('、') : '（还没选）') + '</b><br>'
      + '套给：<b>' + tg.length + ' 位</b>' + (tg.length ? ('（' + esc(tg.slice(0, 6).map(nameOf).filter(Boolean).join('、'))
        + (tg.length > 6 ? (' 等 ' + tg.length + ' 位') : '') + '）') : '');
  }

  function renderSnap() {
    var box = qs('#bkSnap');
    if (!box) return;
    var s = readSnap();
    if (!s) { box.innerHTML = '还没有可撤销的快照。'; box.hidden = true; return; }
    var keys = Object.keys(s.items || {});
    var n = 0;
    keys.forEach(function (k) { n += Object.keys(s.items[k] || {}).length; });
    box.hidden = false;
    box.innerHTML = '上一次的快照：<b>' + stamp(s.at) + '</b> · 模板「'
      + esc(s.useDef ? '全站默认' : (nameOf(s.src) || '（已删）')) + '」 · 覆盖 ' + keys.length + ' 本账共 ' + n + ' 处。';
    var u = qs('#bkUndo');
    if (u) u.disabled = false;
  }

  function renderAll() { renderSrc(); renderStores(); renderTargets(); renderGroups(); renderSum(); renderSnap(); }

  function bulkOpen() {
    if (!siteReady()) { toast('站内数据还没载入完，稍等一下再点'); return; }
    injectDom();
    if (!bkState.src && !bkState.useDef) {
      var cs = soloContacts();
      if (cs.length) bkState.src = cs[0].id;
    }
    if (!bkState.picked.length) bkState.picked = targetIds();
    renderAll();
    var m = qs('#bulkMask');
    if (m) m.hidden = false;
  }
  function bulkClose() { var m = qs('#bulkMask'); if (m) m.hidden = true; }

  function doApply() {
    var keys = STORES.filter(function (s) { return bkState.stores[s.k]; }).map(function (s) { return s.k; });
    var tg = targetIds().filter(function (id) { return bkState.useDef || id !== bkState.src; });
    if (!keys.length) { toast('先选要复制哪几本账'); return; }
    if (!tg.length) { toast('没有可套用的目标（检查一下模板和范围）'); return; }
    if (!bkState.useDef && !bkState.src) { toast('先选一位当模板'); return; }
    var srcName = bkState.useDef ? '全站默认' : (nameOf(bkState.src) || '这位');
    var labels = STORES.filter(function (s) { return bkState.stores[s.k]; }).map(function (s) { return s.label; }).join('、');
    var msg = '把「' + srcName + '」的【' + labels + '】套给 ' + tg.length + ' 位联系人？\n\n'
      + '这几位原来的这些设置会被覆盖。会先存一层快照，可以撤销一次。';
    var run = function () {
      var r = bulkApply({ src: bkState.useDef ? '' : bkState.src, useDefault: bkState.useDef, stores: keys, targets: tg });
      if (!r.ok) { toast('没套用：' + r.why); return; }
      renderAll();
      toast('已套用到 ' + Object.keys(r.perStore).length + ' 本账、共 ' + r.changed + ' 处'
        + (r.snapSaved ? '（可撤销）' : '（快照没存上，撤销不可用）'));
    };
    try {
      if (typeof window.openModal === 'function') {
        window.openModal('统一设置', '', function () { run(); },
          { noInput: true, staticText: msg, okText: '套用', danger: true });
        return;
      }
    } catch (e) {}
    if (window.confirm(msg)) run();
  }

  function doUndo() {
    var s = readSnap();
    if (!s) { toast('没有可撤销的快照'); return; }
    var msg = '退回到 ' + stamp(s.at) + ' 之前的状态？这一次套用会被整个撤销。';
    var run = function () {
      var r = bulkUndo();
      if (!r.ok) { toast('没撤销：' + r.why); return; }
      renderAll();
      toast('已撤销，退回 ' + r.restored + ' 处');
    };
    try {
      if (typeof window.openModal === 'function') {
        window.openModal('撤销上一次套用', '', function () { run(); },
          { noInput: true, staticText: msg, okText: '撤销', danger: true });
        return;
      }
    } catch (e) {}
    if (window.confirm(msg)) run();
  }

  function bindAll() {
    var cl = qs('#bulkClose'); if (cl) cl.addEventListener('click', bulkClose);
    var go = qs('#bkGo'); if (go) go.addEventListener('click', doApply);
    var un = qs('#bkUndo'); if (un) un.addEventListener('click', doUndo);

    var sr = qs('#bkSrcRow');
    if (sr) sr.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.bk-chip[data-src]') : null;
      if (!b) return;
      if (b.dataset.src === '__default__') { bkState.useDef = true; bkState.src = ''; }
      else { bkState.useDef = false; bkState.src = b.dataset.src; }
      renderAll();
    });

    var sl = qs('#bkStoreList');
    if (sl) sl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.bk-store[data-store]') : null;
      if (!b) return;
      var k = b.dataset.store;
      bkState.stores[k] = !bkState.stores[k];
      b.setAttribute('aria-pressed', bkState.stores[k] ? 'true' : 'false');
      renderSum();
    });

    var sc = qs('#bkScopeRow');
    if (sc) sc.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.bk-chip[data-scope]') : null;
      if (!b) return;
      bkState.scope = b.dataset.scope;
      qsa('#bkScopeRow .bk-chip').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      if (bkState.scope === 'pick' && !bkState.picked.length) bkState.picked = targetIds();
      renderTargets();
      renderSum();
    });

    var tr = qs('#bkTargetRow');
    if (tr) tr.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.bk-chip[data-tgt]') : null;
      if (!b) return;
      var id = b.dataset.tgt, i = bkState.picked.indexOf(id);
      if (i < 0) bkState.picked.push(id); else bkState.picked.splice(i, 1);
      b.setAttribute('aria-pressed', i < 0 ? 'true' : 'false');
      renderSum();
    });

    var gr = qs('#bkGroupRow');
    if (gr) gr.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.bk-chip[data-grp]') : null;
      if (!b) return;
      if (b.dataset.grp === '__all__') {
        var all = b.getAttribute('aria-pressed') !== 'true';
        qsa('#bkGroupRow .bk-chip').forEach(function (x) { x.setAttribute('aria-pressed', all ? 'true' : (x === b ? 'true' : 'false')); });
        return;
      }
      var on = b.getAttribute('aria-pressed') === 'true';
      b.setAttribute('aria-pressed', on ? 'false' : 'true');
      var allBtn = qs('#bkGroupRow .bk-chip[data-grp="__all__"]');
      if (allBtn) {
        var others = qsa('#bkGroupRow .bk-chip[data-grp]').filter(function (x) { return x.dataset.grp !== '__all__'; });
        allBtn.setAttribute('aria-pressed', others.length && others.every(function (x) { return x.getAttribute('aria-pressed') === 'true'; }) ? 'true' : 'false');
      }
    });

    var gg = qs('#bkGroupGo');
    if (gg) gg.addEventListener('click', function () {
      var ids = pickedGroups();
      var run = function () {
        var r = groupFollowSolo(ids);
        if (!r.ok) { toast('没改成：' + r.why); return; }
        renderGroups();
        toast('已让 ' + r.members + ' 位在群里跟随自己的单聊设置（共写 ' + r.wrote + ' 项'
          + (r.skipped ? ('，跳过 ' + r.skipped + ' 处') : '') + '）');
      };
      var msg = '把每位成员单聊里的那本设置抄进他的群内覆盖？\n\n群里原来的按人覆盖会被替换。这一步不进上面那层快照，但可以用「清掉群内按人覆盖」退回去。';
      try {
        if (typeof window.openModal === 'function') {
          window.openModal('群聊跟随单聊', '', function () { run(); }, { noInput: true, staticText: msg, okText: '改', danger: true });
          return;
        }
      } catch (e) {}
      if (window.confirm(msg)) run();
    });

    var gu = qs('#bkGroupUndo');
    if (gu) gu.addEventListener('click', function () {
      var ids = pickedGroups();
      var run = function () {
        var r = groupUnfollow(ids);
        if (!r.ok) { toast('没改成：' + r.why); return; }
        renderGroups();
        toast('已清掉 ' + r.cleared + ' 处群内覆盖，他们回到跟随群设置');
      };
      var msg = '清掉群内按人覆盖？\n\n清完每位成员回到「跟随这个群自己的设置」，不是回到他单聊那本。';
      try {
        if (typeof window.openModal === 'function') {
          window.openModal('清掉群内覆盖', '', function () { run(); }, { noInput: true, staticText: msg, okText: '清掉', danger: true });
          return;
        }
      } catch (e) {}
      if (window.confirm(msg)) run();
    });

    var mask = qs('#bulkMask');
    if (mask) mask.addEventListener('click', function (e) { if (e.target === mask) bulkClose(); });
  }

  /* ============ 7. 接进站内：路由 + 更多页磁贴 ============ */

  function hookRouter() {
    try {
      if (typeof window.showView !== 'function' || window.showView.__bulkWrapped) return;
      var orig = window.showView;
      var wrap = function (name) {
        if (name === 'bulkset') { bulkOpen(); return; }
        return orig.apply(this, arguments);
      };
      wrap.__bulkWrapped = 1;
      wrap.__vidWrapped = orig.__vidWrapped;
      wrap.__calWrapped = orig.__calWrapped;
      window.showView = wrap;
    } catch (e) {}
  }

  /* ============ 8. 启动 ============ */

  function boot() {
    try { injectStyle(); injectDom(); hookRouter(); }
    catch (e) { try { console.warn('[统一设置模块] 初始化失败', e); } catch (e2) {} }
  }

  boot();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); });
  }

  try {
    window.__bulkModuleReady = BULK_VER;
    window.__bulkDebug = {
      STORES: STORES, soloContacts: soloContacts, nameOf: nameOf, bookOf: bookOf, storeCount: storeCount,
      bulkApply: bulkApply, bulkUndo: bulkUndo, readSnap: readSnap, clearSnap: clearSnap, healAlias: healAlias,
      groupContacts: groupContacts, soloByName: soloByName, gbhKeys: gbhKeys,
      groupFollowSolo: groupFollowSolo, groupUnfollow: groupUnfollow, groupDiffPreview: groupDiffPreview,
      targetIds: targetIds, state: bkState
    };
    window.__bulkSelfTest = function () {
      var out = { 模块版本: BULK_VER, 站点data就绪: siteReady() };
      try {
        out.单聊联系人数 = soloContacts().length;
        out.六本账各有几位 = STORES.map(function (s) { return s.label + ' ' + storeCount(s.k); }).join(' / ');
      } catch (e) { out.数据层 = '失败 ' + e; }
      try { var sn = readSnap(); out.可撤销快照 = sn ? (stamp(sn.at) + ' · ' + Object.keys(sn.items || {}).length + ' 本账') : '无'; } catch (e2) {}
      try { out.面板已注入 = !!document.getElementById('bulkMask'); } catch (e3) {}
      try { out.路由已接管 = !!(window.showView && window.showView.__bulkWrapped); } catch (e4) {}
      try { out.入口 = '设置页 → 统一设置（index.html 里那枚 data-view="bulkset" 按钮）'; } catch (e5) {}
      try {
        out.群聊数 = groupContacts().length;
        out.白名单键数 = gbhKeys().length;
      } catch (e6) {}
      try { if (console.table) console.table(out); else console.log(out); } catch (e7) {}
      return out;
    };
  } catch (e) {}
})();
