/* 言字卡 · 视频（一起看）模块 v1.0.0 —— 独立文件，不修改 app.v22.2.1.js
 *
 * 安装：本文件放进 dist/ ，在 index.html 里 app.v22.2.1.js 那行下面加：
 *         <script defer src="dist/calendar.js"></script>     ← 若已装日历
 *         <script defer src="dist/video.js"></script>        ← 本模块，放在最后
 *
 * 能做什么：
 *   · 用 B站官方外链播放器（player.bilibili.com）在站内播任意公开视频，带弹幕、可全屏
 *   · 自建片单：粘贴链接或 BV 号入库，想看 / 收藏 / 看过三档，全在本机
 *   · 一起看：选一位或多位联系人（含群聊），播放时他们按概率说话
 *   · 他们说的话从站内字卡库抽：主字卡与「TA心里话」两类，公共池 + 该位专属池，
 *     完全复用站内 groupUsableFor / cardText / chatCardOwners 规则
 *   · 把视频发进任意会话；TA 也能主动邀你一起看
 *
 * 做不到什么（已在设置面板里对用户写明）：
 *   · 登录 B站账号：静态网页做不到（api.bilibili.com 直接 412 风控，且无 CORS 头）
 *   · 真的给视频点赞 / 收藏到 B站账号：同上，要登录与 WBI 签名
 *   · 站内搜索 B站：搜索接口 412，改为「去 B站挑」跳转 + 复制链接回来
 *   · 自动连播：跨域 iframe 拿不到「播放结束」事件，改为手动下一条或定时跳
 *   · 多人真实同步观影：需要服务器，本模块是本地模拟，进度以这台设备为准
 */
(function () {
  'use strict';

  var VID_VER = '1.2.0';
  var PLAYER_BASE = 'https://player.bilibili.com/player.html';
  var TICK_MS = 30 * 1000;

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
  function nid() {
    try { if (typeof nextId === 'function') return String(nextId()); } catch (e) {}
    return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function siteReady() {
    try { return (typeof data !== 'undefined' && data && typeof data === 'object'); } catch (e) { return false; }
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function stamp(ts) {
    var d = new Date(ts || Date.now());
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ============ 1. 数据层 ============ */

  function defStore() {
    return {
      v: VID_VER,
      list: [],
      cur: '',
      watch: { on: false, withCids: [], prob: 35, gapMin: 3 },
      prefs: { embedSite: false, autoNextMin: 0, inviteProb: 6, acceptProb: 70, danmaku: true, highQ: true },
      stats: { watched: 0, together: 0 }
    };
  }

  function norm(s) {
    if (!s || typeof s !== 'object') s = defStore();
    if (!Array.isArray(s.list)) s.list = [];
    if (!s.watch || typeof s.watch !== 'object') s.watch = defStore().watch;
    if (!Array.isArray(s.watch.withCids)) s.watch.withCids = [];
    s.watch.prob = Math.min(100, Math.max(0, Number(s.watch.prob) || 0));
    s.watch.gapMin = Math.min(60, Math.max(1, Number(s.watch.gapMin) || 3));
    s.watch.on = !!s.watch.on;
    if (!s.prefs || typeof s.prefs !== 'object') s.prefs = defStore().prefs;
    s.prefs.embedSite = !!s.prefs.embedSite;
    s.prefs.danmaku = s.prefs.danmaku !== false;
    s.prefs.highQ = s.prefs.highQ !== false;
    s.prefs.autoNextMin = Math.min(180, Math.max(0, Number(s.prefs.autoNextMin) || 0));
    s.prefs.inviteProb = Math.min(100, Math.max(0, Number(s.prefs.inviteProb) || 0));
    s.prefs.acceptProb = (s.prefs.acceptProb === 0 || s.prefs.acceptProb === '0') ? 0
      : Math.min(100, Math.max(0, Number(s.prefs.acceptProb) || 70));
    if (!s.stats || typeof s.stats !== 'object') s.stats = defStore().stats;
    return s;
  }

  function root() {
    if (siteReady()) { data.video = norm(data.video); return data.video; }
    try {
      var raw = localStorage.getItem('ordinal-video');
      return raw ? norm(JSON.parse(raw)) : defStore();
    } catch (e) { return defStore(); }
  }

  function persist() {
    if (siteReady() && data.video) {
      try { if (typeof save === 'function') { save(); return; } } catch (e) {}
    }
    try { localStorage.setItem('ordinal-video', JSON.stringify(root())); } catch (e2) {}
  }

  function mergeFallback() {
    try {
      var raw = localStorage.getItem('ordinal-video');
      if (!raw || !siteReady()) return;
      var old = norm(JSON.parse(raw));
      data.video = norm(data.video);
      if (!data.video.list.length && old.list.length) data.video.list = old.list;
      localStorage.removeItem('ordinal-video');
      persist();
    } catch (e) {}
  }

  /* ============ 2. 链接解析 ============ */

  function parseInput(txt) {
    var s = String(txt == null ? '' : txt).trim();
    if (!s) return null;
    var m = /(BV[0-9A-Za-z]{10})/.exec(s);
    if (m) return { kind: 'bvid', id: m[1] };
    m = /[?&]aid=(\d+)/.exec(s);
    if (m) return { kind: 'aid', id: m[1] };
    m = /(?:^|[^0-9])av(\d{4,})/i.exec(s);
    if (m) return { kind: 'aid', id: m[1] };
    if (/^b23\.tv\//i.test(s) || /b23\.tv\//i.test(s)) return { kind: 'short', id: s };
    return null;
  }

  function playerUrl(item) {
    var q = [];
    if (item.bv) q.push('bvid=' + encodeURIComponent(item.bv));
    else if (item.aid) q.push('aid=' + encodeURIComponent(item.aid));
    else return '';
    var st = root().prefs;
    q.push('page=' + (item.page || 1));
    q.push('high_quality=' + (st.highQ ? 1 : 0));
    q.push('autoplay=0');
    q.push('danmaku=' + (st.danmaku ? 1 : 0));
    return PLAYER_BASE + '?' + q.join('&');
  }

  function siteUrl(item) {
    if (item.bv) return 'https://www.bilibili.com/video/' + item.bv + '/';
    if (item.aid) return 'https://www.bilibili.com/video/av' + item.aid + '/';
    return '';
  }

  function embedUrl(item) {
    return root().prefs.embedSite ? siteUrl(item) : playerUrl(item);
  }

  /* ============ 3. 片单 ============ */

  function findItem(id) {
    var l = root().list;
    for (var i = 0; i < l.length; i++) if (String(l[i].id) === String(id)) return l[i];
    return null;
  }
  function curItem() { return root().cur ? findItem(root().cur) : null; }

  function addItem(txt, title, note) {
    var p = parseInput(txt);
    if (!p) return { err: '没认出这是 B站 链接或 BV 号' };
    if (p.kind === 'short') return { err: 'b23.tv 短链解析不了（要联网跳转）。请在 B站 里点「分享 → 复制链接」拿到带 BV 号的完整链接' };
    var key = p.kind === 'bvid' ? p.id : ('av' + p.id);
    var list = root().list, i;
    for (i = 0; i < list.length; i++) {
      if ((list[i].bv || ('av' + (list[i].aid || ''))) === key) {
        if (title) list[i].title = title;
        persist();
        return { dup: true, item: list[i] };
      }
    }
    var it = {
      id: nid(), title: String(title || '').trim() || (p.kind === 'bvid' ? p.id : 'av' + p.id),
      note: String(note || '').trim(),
      bv: p.kind === 'bvid' ? p.id : '', aid: p.kind === 'aid' ? p.id : '',
      page: 1, tag: 'want', addedAt: Date.now(), lastWatchAt: 0, count: 0
    };
    list.unshift(it);
    root().cur = it.id;
    persist();
    return { item: it };
  }

  function removeItem(id) {
    var s = root();
    s.list = s.list.filter(function (x) { return String(x.id) !== String(id); });
    if (String(s.cur) === String(id)) s.cur = (s.list[0] || {}).id || '';
    persist();
  }

  function setTag(id, tag) {
    var it = findItem(id);
    if (!it) return;
    it.tag = tag;
    persist();
  }

  function stepItem(dir) {
    var s = root();
    if (!s.list.length) return null;
    var i = 0;
    for (var k = 0; k < s.list.length; k++) if (String(s.list[k].id) === String(s.cur)) { i = k; break; }
    var n = (i + dir + s.list.length) % s.list.length;
    s.cur = s.list[n].id;
    persist();
    return s.list[n];
  }

  function markWatched(it) {
    if (!it) return;
    it.count = (it.count || 0) + 1;
    it.lastWatchAt = Date.now();
    root().stats.watched = (root().stats.watched || 0) + 1;
    persist();
  }

  /* ============ 4. 站内字卡库抽一句话（主字卡 + TA心里话，公共池 + 专属池） ============ */

  function speakerNameFor(cid) {
    try {
      var c = null, cs = (data.contacts || []);
      for (var i = 0; i < cs.length; i++) if (cs[i] && cs[i].id === cid) { c = cs[i]; break; }
      if (c && c.kind === 'group' && Array.isArray(c.members) && c.members.length) {
        return c.members[Math.floor(Math.random() * c.members.length)];
      }
      if (typeof chatPartnerNameOf === 'function') return chatPartnerNameOf(cid) || '';
      return (c && c.name) || '';
    } catch (e) { return ''; }
  }

  function contactName(cid) {
    try {
      if (typeof chatPartnerNameOf === 'function') { var n = chatPartnerNameOf(cid); if (n) return n; }
      var cs = (data.contacts || []);
      for (var i = 0; i < cs.length; i++) if (cs[i] && cs[i].id === cid) return cs[i].name || '';
    } catch (e) {}
    return '';
  }

  function cardPool(cid, speakerName) {
    var pool = [];
    try {
      var groups = (data && data.groups) || [];
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        if (!g || !Array.isArray(g.cards) || g.off) continue;
        var cat = g.category || '主字卡';
        if (cat !== '主字卡' && cat !== 'TA心里话') continue;
        if (typeof groupUsableFor === 'function' && !groupUsableFor(g, cid, speakerName)) continue;
        for (var j = 0; j < g.cards.length; j++) {
          var t = '';
          try { t = (typeof cardText === 'function') ? cardText(g.cards[j]) : ''; } catch (e2) { t = ''; }
          if (!t && typeof g.cards[j] === 'string') t = g.cards[j];
          if (!t && g.cards[j] && typeof g.cards[j] === 'object') t = g.cards[j].t || g.cards[j].text || '';
          t = String(t || '').trim();
          if (t && t.length <= 120) pool.push(t);
        }
      }
    } catch (e) {}
    return pool;
  }

  function pickLine(cid) {
    var pool = cardPool(cid, speakerNameFor(cid));
    if (!pool.length) return '';
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ============ 5. 投消息进会话 ============ */

  function say(cid, text, extra) {
    if (!cid || !text) return false;
    try {
      if (typeof _deliverToChat !== 'function' || typeof nextId !== 'function') return false;
      var msg = { id: nextId(), from: 'partner', text: String(text), unread: true, src: 'video' };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
      _deliverToChat(msg, cid);
      return true;
    } catch (e) { return false; }
  }

  function sayMe(cid, text) {
    try {
      if (typeof _deliverToChat !== 'function' || typeof nextId !== 'function') return false;
      _deliverToChat({ id: nextId(), from: 'me', text: String(text) }, cid);
      return true;
    } catch (e) { return false; }
  }

  function pushToChat(cid, it, prefix) {
    if (!it) { toast('现在没有在放的视频'); return false; }
    var who = speakerNameFor(cid);
    var line = pickLine(cid);
    var head = prefix || ('分享一个视频：' + it.title);
    var text = head + '\n' + siteUrl(it) + (line ? ('\n' + (who ? who + '：' : '') + line) : '');
    var okk = cid ? sayMe(cid, text) : false;
    if (!okk) {
      // 没有指定会话时，退回「投给一起看的人」
      var w = root().watch.withCids;
      if (w && w.length) okk = sayMe(w[0], text);
    }
    if (okk) { logLine('我', '已发进聊天：' + it.title); toast('已发进聊天'); }
    else toast('没发出去：先在「一起看」里选人，或先进一个会话');
    return okk;
  }

  /* ============ 5b. 邀请：答应/婉拒语料与时间工具 ============ */

  var ACCEPT_YES = [
    '好啊，一起看', '来，我这就过来', '等我一下，马上到', '这个我想看，一起',
    '行，那现在就开', '一起看吧，正好有空', '好，位置给我留一个'
  ];
  var ACCEPT_NO = [
    '这次先不看了，你自己先看', '现在不太方便，晚点行吗', '这一条我先记下，改天一起',
    '手头有点事，你先看', '今天先不了，下次一定', '让我缓一缓，等会儿找你'
  ];

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length) % arr.length]; }
  function pad2n(n) { return (n < 10 ? '0' : '') + n; }
  function parseDateLocal(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtWhen(dstr, tstr) {
    var d = parseDateLocal(dstr);
    if (!d) return '';
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日' + (tstr ? (' ' + tstr) : '');
  }
  function ymdLocal(d) { return d.getFullYear() + '-' + pad2n(d.getMonth() + 1) + '-' + pad2n(d.getDate()); }

  /* 随机提一个未来的时间：今晚或往后 7 天的 19:00–23:30 */
  function proposeWhen() {
    var d = new Date(), addD = Math.floor(Math.random() * 8);
    d.setDate(d.getDate() + addD);
    var h;
    if (addD === 0) {
      h = Math.max(d.getHours() + 1, 19);
      if (h > 23) { d.setDate(d.getDate() + 1); h = 19 + Math.floor(Math.random() * 5); }
    } else { h = 19 + Math.floor(Math.random() * 5); }
    return { date: ymdLocal(d), time: pad2n(h) + ':' + (Math.random() < 0.5 ? '00' : '30') };
  }

  /* 写进日历模块的数据（没装日历就不写，并明确告知） */
  function calReady() {
    try { return siteReady() && data.calendar && Array.isArray(data.calendar.events); } catch (e) { return false; }
  }
  function writeAppointment(cid, dstr, tstr, it) {
    if (!calReady() || !it) return null;
    var ev = {
      id: nid(), title: '一起看《' + it.title + '》', date: dstr, type: 'video', repeat: 'none',
      time: tstr || '', who: cid || '', bv: it.bv || '', aid: it.aid || '', note: ''
    };
    data.calendar.events.push(ev);
    try { if (typeof save === 'function') save(); } catch (e) {}
    return ev;
  }

  /* ============ 6. 一起看 ============ */

  var vidTimer = 0, vidAutoTimer = 0, vidLog = [];

  function logLine(who, text) {
    vidLog.push({ who: who, text: text, at: Date.now() });
    if (vidLog.length > 60) vidLog.shift();
    renderChat();
  }

  function coTick() {
    var s = root();
    if (!s.watch.on || !s.watch.withCids.length) return;
    if (!curItem()) return;
    if (document.hidden) return;
    var gap = Math.max(1, s.watch.gapMin) * 60000;
    var now = Date.now();
    s.watch.withCids.forEach(function (cid) {
      var st = s.watch._at || (s.watch._at = {});
      if (st[cid] && now - st[cid] < gap) return;
      if (Math.random() * 100 >= (s.watch.prob || 0)) return;
      var line = pickLine(cid);
      if (!line) return;
      st[cid] = now;
      var who = contactName(cid) || 'TA';
      if (say(cid, line, { videoBv: (curItem() || {}).bv || '' })) {
        s.stats.together = (s.stats.together || 0) + 1;
        logLine(who, line);
      }
    });
    persist();
  }

  function startCo() {
    if (vidTimer) clearInterval(vidTimer);
    vidTimer = setInterval(coTick, TICK_MS);
  }

  function startAutoNext() {
    if (vidAutoTimer) { clearInterval(vidAutoTimer); vidAutoTimer = 0; }
    var min = root().prefs.autoNextMin;
    if (!min) return;
    vidAutoTimer = setInterval(function () {
      if (document.hidden) return;
      var it = stepItem(1);
      if (it) { loadPlayer(it, true); logLine('片单', '自动跳到下一条：' + it.title); }
    }, Math.max(1, min) * 60000);
  }

  /* TA 主动邀你一起看：有 55% 概率顺便提一个具体时间，并写进日历 */
  function maybeInvite() {
    try {
      var s = root();
      var p = Number(s.prefs.inviteProb) || 0;
      if (!p || !s.list.length) return;
      if (Math.random() * 100 >= p) return;
      var cs = (data.contacts || []);
      var solo = cs.filter(function (c) { return c && c.kind !== 'group'; });
      if (!solo.length) return;
      var who = solo[Math.floor(Math.random() * solo.length)];
      var it = s.list[Math.floor(Math.random() * s.list.length)];
      var line = pickLine(who.id);
      var w = (Math.random() < 0.55) ? proposeWhen() : null;
      var head = w ? ('想约你 ' + fmtWhen(w.date, w.time) + ' 一起看《' + it.title + '》')
        : ('我找了个视频想跟你一起看：《' + it.title + '》');
      var text = head + '\n' + siteUrl(it) + (line ? ('\n' + line) : '');
      if (!say(who.id, text, { videoInvite: it.id })) return;
      var nm = contactName(who.id) || 'TA';
      logLine(nm, w ? ('约你 ' + fmtWhen(w.date, w.time) + ' 看《' + it.title + '》') : ('邀你一起看《' + it.title + '》'));
      if (w) {
        if (writeAppointment(who.id, w.date, w.time, it)) logLine('日历', '已记下这条约定，可在日历里改或删');
        else logLine('日历', '没检测到日历模块的数据，这条约定没写进日历');
      }
    } catch (e) {}
  }

  /* 你邀请 TA：发进会话 → 按成功率掷 → 答应就加入一起看、约了时间就写日历 */
  var invPicked = [];

  function renderInvWho() {
    var box = qs('#vidInvWho');
    if (!box) return;
    var cs = [];
    try { cs = (data.contacts || []).slice(); } catch (e) { cs = []; }
    if (!cs.length) { box.innerHTML = '<div class="vid-note">还没有联系人</div>'; return; }
    box.innerHTML = cs.map(function (c) {
      if (!c || !c.id) return '';
      var on = invPicked.indexOf(c.id) >= 0;
      return '<button type="button" class="vid-who" data-cid="' + esc(c.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">'
        + '<b>' + esc(c.name || '(未命名)') + '</b><small>' + (c.kind === 'group' ? '群聊' : (on ? '已选' : '点一下选')) + '</small></button>';
    }).join('');
  }

  function inviteOpen() {
    var it = curItem();
    var w = qs('#vidInvWhat');
    if (w) w.innerHTML = it ? ('要邀请一起看的是：<b>' + esc(it.title) + '</b>') : '还没有在放的视频 · 先去「片单」加一条';
    var s = root();
    invPicked = s.watch.withCids.slice();
    if (!invPicked.length) { var ac = currentChatId(); if (ac) invPicked = [ac]; }
    renderInvWho();
    chipSet('vidInvWhen', 'now');
    var r1 = qs('#vidInvAtRow'), r2 = qs('#vidInvAtRow2');
    if (r1) r1.hidden = true;
    if (r2) r2.hidden = true;
    var dv = qs('#vidInvDate');
    if (dv && !dv.value) dv.value = ymdLocal(new Date());
    var tv = qs('#vidInvTime');
    if (tv && !tv.value) tv.value = '21:00';
    var pb = qs('#vidInvProb');
    if (pb) pb.value = s.prefs.acceptProb;
    openSheet('vidInvMask');
  }

  function inviteSend() {
    var it = curItem();
    if (!it) { toast('先在片单里挑一条视频'); return { yes: 0, no: 0 }; }
    if (!invPicked.length) { toast('还没选邀请谁'); return { yes: 0, no: 0 }; }
    var when = chipVal('vidInvWhen', 'now') === 'at';
    var dstr = when ? ((qs('#vidInvDate') || {}).value || '') : '';
    var tstr = when ? ((qs('#vidInvTime') || {}).value || '') : '';
    if (when && !parseDateLocal(dstr)) { toast('约时间就得填一个日期'); return { yes: 0, no: 0 }; }
    var accEl = qs('#vidInvProb');
    if (accEl && String(accEl.value || '').trim() !== '') setTune('acceptProb', accEl.value);
    var acc = Math.min(100, Math.max(0, Number(root().prefs.acceptProb) || 0));
    var yes = 0, no = 0, s = root();
    invPicked.forEach(function (cid) {
      var nm = contactName(cid) || 'TA';
      sayMe(cid, '一起看《' + it.title + '》吗？\n' + siteUrl(it) + (when ? ('\n就约 ' + fmtWhen(dstr, tstr)) : ''));
      logLine('我', '邀请 ' + nm + ' 一起看《' + it.title + '》');
      var line = pickLine(cid);
      if (Math.random() * 100 < acc) {
        yes++;
        var y1 = pick(ACCEPT_YES);
        say(cid, y1 + (line ? ('\n' + line) : ''), { videoBv: it.bv || '' });
        logLine(nm, y1);
        if (s.watch.withCids.indexOf(cid) < 0) s.watch.withCids.push(cid);
        s.watch.on = true;
        if (when) {
          if (writeAppointment(cid, dstr, tstr, it)) {
            var y2 = '那就 ' + fmtWhen(dstr, tstr) + '，我记下了';
            say(cid, y2);
            logLine(nm, y2);
            logLine('日历', '已记下：' + fmtWhen(dstr, tstr) + ' 和 ' + nm);
          } else {
            logLine('日历', '没检测到日历模块的数据，这条约定没写进日历');
          }
        }
      } else {
        no++;
        var n1 = pick(ACCEPT_NO);
        say(cid, n1 + (line ? ('\n' + line) : ''));
        logLine(nm, n1);
      }
    });
    persist();
    renderAll();
    closeSheet('vidInvMask');
    toast(yes && no ? (yes + ' 位答应、' + no + ' 位这次不行') : (yes ? (yes + ' 位答应了') : '这次都没答应，晚点再问问'));
    return { yes: yes, no: no };
  }

  /* ============ 7. 图标（24×24 线性描边，跟站内一套；无 emoji） ============ */

  var VID_ICO = '<rect x="2.5" y="5" width="19" height="14" rx="3.2"/>'
    + '<path d="M10.2 9.6v4.8l4.2-2.4z" fill="currentColor" stroke="none"/>'
    + '<path d="M7 2.8v2.4"/><path d="M17 2.8v2.4"/>'
    + '<circle cx="19" cy="7.6" r="1.05" fill="currentColor" stroke="none"/>';

  var ICO_PLUS = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
  var ICO_GEAR = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v2.6M12 18.8v2.6M4.5 7.2l2.2 1.3M17.3 15.5l2.2 1.3M4.5 16.8l2.2-1.3M17.3 8.5l2.2-1.3"/></svg>';
  var ICO_LIST = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h11M4 12h11M4 17h7"/><path d="M18.5 13.5v5l4-2.5z"/></svg>';
  var ICO_PEOPLE = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 20v-1.8a3.6 3.6 0 0 0-3.6-3.6H6.6A3.6 3.6 0 0 0 3 18.2V20"/><circle cx="9.5" cy="7.5" r="3.4"/><path d="M21 20v-1.8a3.6 3.6 0 0 0-2.7-3.5"/><path d="M16.5 4.3a3.6 3.6 0 0 1 0 6.9"/></svg>';
  var ICO_CHAT = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11.6a7.9 7.9 0 0 1-8.5 7.9 8.4 8.4 0 0 1-3.6-.8L3.5 20.5l1.7-4.6a7.9 7.9 0 0 1-.9-3.8 7.9 7.9 0 0 1 8-8.1 7.9 7.9 0 0 1 8.2 7.6z"/></svg>';
  var ICO_SEND = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2.5 11 13"/><path d="M21.5 2.5 15 21.5l-4-8.5-8.5-4z"/></svg>';

  /* ============ 8. 样式 ============ */

  var CSS = [
    '#videoView{padding-bottom:96px}',
    '.vid-frame{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:14px;overflow:hidden;margin:12px 0 10px}',
    '.vid-frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}',
    '.vid-frame-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#c9c8c6;font-size:12.5px;text-align:center;padding:0 18px;line-height:1.7}',
    '.vid-now{margin:0 0 10px}',
    '.vid-now b{display:block;font-size:14px;font-weight:600;color:var(--ink,#1c1917);line-height:1.5}',
    '.vid-now small{display:block;font-size:11px;color:var(--muted,#6b6a67);margin-top:4px;line-height:1.7}',
    '.vid-btns{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 10px}',
    '.vid-btn{flex:1 1 auto;min-height:38px;padding:0 11px;display:flex;align-items:center;justify-content:center;gap:5px;border:1px solid rgba(0,0,0,.14);border-radius:12px;background:#fff;color:var(--ink,#1c1917);font:inherit;font-size:12.5px;white-space:nowrap}',
    '.vid-btn:active{opacity:.6}',
    '.vid-btn.on{background:var(--ink,#1c1917);border-color:var(--ink,#1c1917);color:#fff}',
    '.vid-btn-ico{flex:none;width:40px;padding:0}',
    '.vid-co{margin:0 0 10px;padding:10px 12px;border-radius:14px;background:rgba(0,0,0,.035);font-size:12px;line-height:1.75;color:var(--ink,#1c1917)}',
    '.vid-co b{font-weight:600}',
    '.vid-chat{margin:0 0 10px;border:1px solid rgba(0,0,0,.08);border-radius:14px;overflow:hidden}',
    '.vid-chat-hd{display:flex;align-items:center;gap:7px;padding:9px 12px;background:rgba(0,0,0,.035);font-size:12px;color:var(--muted,#6b6a67)}',
    '.vid-chat-log{max-height:190px;overflow-y:auto;padding:9px 12px;display:flex;flex-direction:column;gap:7px}',
    '.vid-chat-log:empty::after{content:"还没有人说话 · 开启「一起看」后他们会按概率插话";font-size:11.5px;color:var(--muted,#6b6a67)}',
    '.vid-line{font-size:12.5px;line-height:1.65;color:var(--ink,#1c1917)}',
    '.vid-line b{font-weight:600;margin-right:6px;color:var(--muted,#6b6a67)}',
    '.vid-line time{float:right;font-size:10px;color:var(--muted,#6b6a67);opacity:.7;margin-left:8px}',
    '.vid-chat-in{display:flex;gap:7px;padding:9px 10px;border-top:1px solid rgba(0,0,0,.07)}',
    '.vid-chat-in input{flex:1 1 auto;min-width:0;padding:9px 11px;border:1px solid rgba(0,0,0,.14);border-radius:11px;background:#fff;color:var(--ink,#1c1917);font:inherit;font-size:13px}',
    '.vid-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:rgba(0,0,0,.028);margin-bottom:7px;width:100%;border:0;font:inherit;color:inherit;text-align:left}',
    '.vid-item.cur{background:rgba(0,0,0,.07)}',
    '.vid-item-tx{flex:1 1 auto;min-width:0}',
    '.vid-item-tx b{display:block;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.vid-item-tx small{display:block;font-size:11px;color:var(--muted,#6b6a67);margin-top:3px}',
    '.vid-item-n{flex:none;font-size:11px;color:var(--muted,#6b6a67);font-variant-numeric:tabular-nums}',
    '.vid-tags{display:flex;gap:6px;margin:2px 0 10px;flex-wrap:wrap}',
    '.vid-frm{display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid rgba(0,0,0,.06)}',
    '.vid-frm>span{flex:none;width:78px;font-size:12.5px;color:var(--muted,#6b6a67)}',
    '.vid-frm input[type=text],.vid-frm input[type=number],.vid-frm textarea{flex:1 1 auto;min-width:0;padding:9px 10px;border:1px solid rgba(0,0,0,.14);border-radius:11px;background:#fff;color:var(--ink,#1c1917);font:inherit;font-size:13px}',
    '.vid-chips{display:flex;gap:6px;flex-wrap:wrap;flex:1 1 auto}',
    '.vid-chip{padding:7px 11px;border:1px solid rgba(0,0,0,.14);border-radius:999px;background:#fff;color:var(--muted,#6b6a67);font:inherit;font-size:12px}',
    '.vid-chip[aria-pressed=true]{background:var(--ink,#1c1917);border-color:var(--ink,#1c1917);color:#fff}',
    '.vid-who{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:13px;background:rgba(0,0,0,.028);margin-bottom:6px;width:100%;border:0;font:inherit;color:inherit;text-align:left}',
    '.vid-who b{flex:1 1 auto;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.vid-who small{flex:none;font-size:11px;color:var(--muted,#6b6a67)}',
    '.vid-who[aria-pressed=true]{background:rgba(0,0,0,.09)}',
    '.vid-who[aria-pressed=true] small{color:var(--ink,#1c1917);font-weight:600}',
    '.vid-acts{display:flex;gap:8px;margin-top:15px}',
    '.vid-acts .soft-btn{flex:1 1 auto}',
    '.vid-note{font-size:11.5px;line-height:1.75;color:var(--muted,#6b6a67);margin:10px 0 0}',
    '.vid-warn{margin:10px 0 0;padding:10px 12px;border-radius:13px;background:rgba(178,83,106,.09);font-size:11.5px;line-height:1.75;color:#8d4257}',
    '.vid-tune{margin:0 0 10px;padding:11px 12px;border-radius:14px;background:rgba(0,0,0,.035)}',
    '.vid-tune-hd{display:flex;align-items:center;gap:7px}',
    '.vid-tune-hd>b{flex:1 1 auto;font-size:12.5px;font-weight:600;color:var(--ink,#1c1917)}',
    '.vid-tune-fold{flex:none;width:27px;height:27px;border:1px solid rgba(0,0,0,.12);border-radius:9px;background:#fff;color:var(--muted,#6b6a67);font:inherit;font-size:12px;line-height:1}',
    '.vid-tune-row{display:flex;align-items:center;gap:9px;padding:7px 0 0}',
    '.vid-tune-row>span{flex:none;width:82px;font-size:11.5px;color:var(--muted,#6b6a67)}',
    '.vid-tune-row input[type=range]{flex:1 1 auto;min-width:0;margin:0;accent-color:#1c1917}',
    '.vid-tune-row output{flex:none;width:58px;text-align:right;font-size:11.5px;color:var(--ink,#1c1917);font-variant-numeric:tabular-nums}',
    '.vid-tune-ft{display:flex;gap:7px;margin-top:10px}',
    '.vid-tune-ft button{flex:1 1 auto;min-height:33px;padding:0 8px;border:1px solid rgba(0,0,0,.14);border-radius:10px;background:#fff;color:var(--muted,#6b6a67);font:inherit;font-size:11.5px}',
    '.vid-tune-ft button:active{opacity:.6}',
    '.vid-nowrow{display:flex;align-items:center;gap:8px;margin:0 0 10px}',
    '.vid-nowrow .vid-now{flex:1 1 auto;min-width:0;margin:0}',
    '.vid-mini{flex:none;width:34px;height:34px;border:1px solid rgba(0,0,0,.12);border-radius:11px;background:#fff;color:var(--ink,#1c1917);font:inherit;font-size:15px;line-height:1}',
    '.vid-mini:active{opacity:.6}',
    '.vid-icons{display:flex;gap:7px;margin:0 0 10px}',
    '.vid-ic{flex:1 1 0;min-width:0;height:46px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:1px solid rgba(0,0,0,.1);border-radius:14px;background:#fff;color:var(--muted,#6b6a67);font:inherit;font-size:10px;line-height:1}',
    '.vid-ic svg{width:18px;height:18px}',
    '.vid-ic.on{background:var(--ink,#1c1917);border-color:var(--ink,#1c1917);color:#fff}',
    '.vid-ic:active{opacity:.65}',
    '.vid-ic-main{color:#a8506b;border-color:rgba(168,80,107,.32)}',
    '.vid-ic-main.on{background:#a8506b;border-color:#a8506b;color:#fff}',
    '.vid-strip{display:flex;gap:7px;overflow-x:auto;padding-bottom:5px;margin:0 0 10px;-webkit-overflow-scrolling:touch}',
    '.vid-strip:empty{display:none}',
    '.vid-chip2{flex:none;max-width:190px;padding:8px 11px;border:1px solid rgba(0,0,0,.12);border-radius:12px;background:#fff;color:var(--muted,#6b6a67);font:inherit;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.vid-chip2.cur{background:var(--ink,#1c1917);border-color:var(--ink,#1c1917);color:#fff}',
    '.vid-folds{display:flex;gap:7px;margin:0 0 10px}',
    '.vid-fold{flex:1 1 auto;min-height:37px;padding:0 11px;display:flex;align-items:center;gap:6px;border:1px solid rgba(0,0,0,.09);border-radius:12px;background:rgba(0,0,0,.028);color:var(--muted,#6b6a67);font:inherit;font-size:11.5px;text-align:left}',
    '.vid-fold:active{opacity:.65}',
    '.vid-fold b{flex:none;font-weight:600;color:var(--ink,#1c1917)}',
    '.vid-fold span{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.vid-fold i{flex:none;font-style:normal;opacity:.55}'
  ].join('\n');

  function injectStyle() {
    if (qs('#vidStyle')) return;
    var s = document.createElement('style');
    s.id = 'vidStyle';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ============ 9. 视图 DOM ============ */

  var VIEW_HTML = ''
    + '<div class="home-greet">'
    + '  <div>'
    + '    <div class="g-eyebrow">VIDEO</div><div class="g-hi">视频</div>'
    + '    <div class="g-sub" id="vidSub"></div>'
    + '  </div>'
    + '</div>'
    + '<div class="vid-frame" id="vidFrameWrap"><div class="vid-frame-empty" id="vidFrameEmpty">还没有在放的视频<br>点下面「片单」粘贴一个 B站 链接</div></div>'
    + '<div class="vid-nowrow">'
    + '  <button type="button" class="vid-mini" id="vidPrev" aria-label="上一条">‹</button>'
    + '  <div class="vid-now" id="vidNow" hidden></div>'
    + '  <button type="button" class="vid-mini" id="vidNext" aria-label="下一条">›</button>'
    + '</div>'
    + '<div class="vid-icons">'
    + '  <button type="button" class="vid-ic" id="vidAddBtn" aria-label="添加视频">' + ICO_PLUS + '添加</button>'
    + '  <button type="button" class="vid-ic" id="vidListBtn" aria-label="片单">' + ICO_LIST + '片单</button>'
    + '  <button type="button" class="vid-ic vid-ic-main" id="vidInviteBtn" aria-label="邀请一起看">' + ICO_SEND + '邀请</button>'
    + '  <button type="button" class="vid-ic" id="vidCoBtn" aria-label="一起看">' + ICO_PEOPLE + '一起看</button>'
    + '  <button type="button" class="vid-ic" id="vidSetBtn" aria-label="视频设置">' + ICO_GEAR + '设置</button>'
    + '</div>'
    + '<div class="vid-strip" id="vidStrip"></div>'
    + '<div class="vid-co" id="vidCoBar" hidden></div>'
    + '<div class="vid-folds">'
    + '  <button type="button" class="vid-fold" id="vidTuneToggle"><b>节奏</b><span id="vidTuneSum"></span><i>︿</i></button>'
    + '  <button type="button" class="vid-fold" id="vidChatToggle"><b>对话</b><span id="vidChatSum"></span><i>︿</i></button>'
    + '</div>'
    + '<div class="vid-tune" id="vidTune" hidden>'
    + '  <div class="vid-tune-hd"><b>节奏 · 拖了就立刻生效</b>'
    + '    <button type="button" class="vid-chip" id="vidCoQuick" aria-pressed="false">一起看：关</button>'
    + '  </div>'
    + '  <div id="vidTuneBody">'
    + '    <div class="vid-tune-row"><span>插话概率</span><input type="range" id="vidTProb" min="0" max="100" step="1" aria-label="插话概率"><output id="vidTProbOut"></output></div>'
    + '    <div class="vid-tune-row"><span>最短间隔</span><input type="range" id="vidTGap" min="1" max="60" step="1" aria-label="同一位两次插话的最短间隔"><output id="vidTGapOut"></output></div>'
    + '    <div class="vid-tune-row"><span>邀请成功率</span><input type="range" id="vidTAccept" min="0" max="100" step="1" aria-label="邀请成功率"><output id="vidTAcceptOut"></output></div>'
    + '    <div class="vid-tune-row"><span>TA 主动邀你</span><input type="range" id="vidTInvite" min="0" max="100" step="1" aria-label="TA 主动邀请概率"><output id="vidTInviteOut"></output></div>'
    + '    <div class="vid-tune-row"><span>自动跳下一条</span><input type="range" id="vidTAuto" min="0" max="60" step="1" aria-label="自动跳下一条的分钟数"><output id="vidTAutoOut"></output></div>'
    + '    <div class="vid-tune-ft">'
    + '      <button type="button" id="vidTNow">让 TA 现在就说一句</button>'
    + '      <button type="button" id="vidTReset">恢复默认</button>'
    + '    </div>'
    + '    <p class="vid-note">插话概率＝每 30 秒每人各掷一次，中了就从字卡库抽一句发进会话；最短间隔＝同一位两次插话之间至少隔这么久；<b>邀请成功率</b>＝你发出「一起看」邀请后对方答应的概率；TA 主动邀你＝进这一页时掷一次；自动跳下一条填 0 就是关。这几个数在「一起看」与「视频设置」面板里也能改，两处同一份数据。</p>'
    + '  </div>'
    + '</div>'
    + '<div class="vid-chat" id="vidChat" hidden>'
    + '  <div class="vid-chat-hd">' + ICO_CHAT + '<span id="vidChatHd">一起看的对话</span>'
    + '    <button type="button" class="vid-btn vid-btn-ico" id="vidSendBtn" aria-label="把当前视频发进聊天" style="margin-left:auto;width:32px;min-height:28px">' + ICO_SEND + '</button>'
    + '  </div>'
    + '  <div class="vid-chat-log" id="vidChatLog"></div>'
    + '  <div class="vid-chat-in" id="vidChatIn">'
    + '    <input type="text" id="vidChatInput" maxlength="200" placeholder="说一句，发进当前会话">'
    + '    <button type="button" class="vid-btn vid-btn-ico" id="vidChatSend" aria-label="发送">' + ICO_SEND + '</button>'
    + '  </div>'
    + '</div>';

  var LIST_SHEET = ''
    + '<div class="fs-sheet-mask fs-sheet-full" id="vidListMask" hidden>'
    + '  <div class="fs-sheet">'
    + '    <div class="fs-sheet-bar">'
    + '      <div class="fs-sheet-t"><span class="fs-sheet-ti">片单</span><span class="fs-sheet-en">VIDEOS</span></div>'
    + '      <button type="button" class="fs-sheet-close" id="vidListClose" aria-label="关闭">×</button>'
    + '    </div>'
    + '    <div class="fs-sheet-body">'
    + '      <div class="vid-frm"><span>链接/BV号</span><input type="text" id="vidAddUrl" placeholder="粘贴 B站 链接，或直接写 BV 号"></div>'
    + '      <div class="vid-frm"><span>标题</span><input type="text" id="vidAddTitle" maxlength="60" placeholder="选填，留空就用 BV 号"></div>'
    + '      <div class="vid-frm"><span>备注</span><input type="text" id="vidAddNote" maxlength="60" placeholder="选填"></div>'
    + '      <div class="vid-acts">'
    + '        <button type="button" class="soft-btn" id="vidAddGo">加进片单</button>'
    + '        <button type="button" class="soft-btn" id="vidOpenSite">去 B站挑</button>'
    + '      </div>'
    + '      <p class="vid-note">站内搜不了 B站（搜索接口被风控拦，返回 412），所以是「去 B站挑 → 复制链接 → 回来粘贴」。在 B站 里点「分享 → 复制链接」，要拿到带 BV 号的完整链接；b23.tv 那种短链解析不了。</p>'
    + '      <div class="vid-tags" id="vidTagRow" style="margin-top:14px">'
    + '        <button type="button" class="vid-chip" data-tag="all" aria-pressed="true">全部</button>'
    + '        <button type="button" class="vid-chip" data-tag="want" aria-pressed="false">想看</button>'
    + '        <button type="button" class="vid-chip" data-tag="fav" aria-pressed="false">收藏</button>'
    + '        <button type="button" class="vid-chip" data-tag="seen" aria-pressed="false">看过</button>'
    + '      </div>'
    + '      <div id="vidListBody"></div>'
    + '    </div>'
    + '  </div>'
    + '</div>';

  var CO_SHEET = ''
    + '<div class="fs-sheet-mask fs-sheet-full" id="vidCoMask" hidden>'
    + '  <div class="fs-sheet">'
    + '    <div class="fs-sheet-bar">'
    + '      <div class="fs-sheet-t"><span class="fs-sheet-ti">一起看</span><span class="fs-sheet-en">TOGETHER</span></div>'
    + '      <button type="button" class="fs-sheet-close" id="vidCoClose" aria-label="关闭">×</button>'
    + '    </div>'
    + '    <div class="fs-sheet-body">'
    + '      <div class="vid-frm"><span>开启</span><div class="vid-chips" id="vidCoOn">'
    + '        <button type="button" class="vid-chip" data-v="on" aria-pressed="false">一起看</button>'
    + '        <button type="button" class="vid-chip" data-v="off" aria-pressed="true">自己看</button>'
    + '      </div></div>'
    + '      <div class="vid-frm"><span>插话概率</span><input type="number" id="vidCoProb" min="0" max="100" step="1" inputmode="numeric"> </div>'
    + '      <div class="vid-frm"><span>最短间隔</span><input type="number" id="vidCoGap" min="1" max="60" step="1" inputmode="numeric"></div>'
    + '      <p class="vid-note">概率＝每 30 秒掷一次，每人各掷；间隔＝同一位两次插话之间至少隔这么久（分钟）。他们说的话从站内字卡库抽：只用「主字卡」与「TA心里话」两类，走公共池＋这一位的专属池，完全照站内 groupUsableFor 的规则——你在字卡库里关掉的组、或给某位勾了「不用公共字卡」，这里一样生效。</p>'
    + '      <div class="setting-subhead" style="margin-top:16px">和谁一起看</div>'
    + '      <div id="vidCoWho"></div>'
    + '      <p class="vid-note">可以选多位，也能选群聊（群里会随机由一位成员开口）。这是本地模拟：他们的进度以你这台设备为准，不是真的多人同步观影——那需要服务器。</p>'
    + '    </div>'
    + '  </div>'
    + '</div>';

  var INV_SHEET = ''
    + '<div class="fs-sheet-mask fs-sheet-full" id="vidInvMask" hidden>'
    + '  <div class="fs-sheet">'
    + '    <div class="fs-sheet-bar">'
    + '      <div class="fs-sheet-t"><span class="fs-sheet-ti">邀请一起看</span><span class="fs-sheet-en">INVITE</span></div>'
    + '      <button type="button" class="fs-sheet-close" id="vidInvClose" aria-label="关闭">×</button>'
    + '    </div>'
    + '    <div class="fs-sheet-body">'
    + '      <p class="vid-note" id="vidInvWhat" style="margin-top:0"></p>'
    + '      <div class="setting-subhead">邀请谁</div>'
    + '      <div id="vidInvWho"></div>'
    + '      <div class="setting-subhead" style="margin-top:16px">要不要约个时间</div>'
    + '      <div class="vid-frm"><span>约时间</span><div class="vid-chips" id="vidInvWhen">'
    + '        <button type="button" class="vid-chip" data-v="now" aria-pressed="true">就现在看</button>'
    + '        <button type="button" class="vid-chip" data-v="at" aria-pressed="false">约到某一天</button>'
    + '      </div></div>'
    + '      <div class="vid-frm" id="vidInvAtRow" hidden><span>日期</span><input type="date" id="vidInvDate"></div>'
    + '      <div class="vid-frm" id="vidInvAtRow2" hidden><span>几点</span><input type="time" id="vidInvTime"></div>'
    + '      <p class="vid-note">约了时间就会同时写进「日历」，那天日历格里会多一枚蓝灰点，点开能看到几点、和谁、看哪一条。TA 答应了才算约成；没答应不会往日历里写。</p>'
    + '      <div class="vid-frm"><span>邀请成功率</span><input type="number" id="vidInvProb" min="0" max="100" step="1" inputmode="numeric"></div>'
    + '      <p class="vid-note">答不答应按这个概率掷。答应／婉拒那句话是内置的固定语义，后面会再跟一句从这位字卡库里抽的话，所以口吻还是他的人设。</p>'
    + '      <div class="vid-acts">'
    + '        <button type="button" class="soft-btn" id="vidInvGo">发出邀请</button>'
    + '      </div>'
    + '    </div>'
    + '  </div>'
    + '</div>';

  var SET_SHEET = ''
    + '<div class="fs-sheet-mask fs-sheet-full" id="vidSetMask" hidden>'
    + '  <div class="fs-sheet">'
    + '    <div class="fs-sheet-bar">'
    + '      <div class="fs-sheet-t"><span class="fs-sheet-ti">视频设置</span><span class="fs-sheet-en">SETTINGS</span></div>'
    + '      <button type="button" class="fs-sheet-close" id="vidSetClose" aria-label="关闭">×</button>'
    + '    </div>'
    + '    <div class="fs-sheet-body">'
    + '      <div class="setting-subhead">播放</div>'
    + '      <div class="vid-frm"><span>弹幕</span><div class="vid-chips" id="vidSetDm">'
    + '        <button type="button" class="vid-chip" data-v="on" aria-pressed="true">开</button>'
    + '        <button type="button" class="vid-chip" data-v="off" aria-pressed="false">关</button>'
    + '      </div></div>'
    + '      <div class="vid-frm"><span>高画质</span><div class="vid-chips" id="vidSetHq">'
    + '        <button type="button" class="vid-chip" data-v="on" aria-pressed="true">要</button>'
    + '        <button type="button" class="vid-chip" data-v="off" aria-pressed="false">不要</button>'
    + '      </div></div>'
    + '      <div class="vid-frm"><span>自动跳下一条</span><input type="number" id="vidSetAuto" min="0" max="180" step="1" inputmode="numeric"></div>'
    + '      <p class="vid-note">填 0＝不自动跳；填 N＝每 N 分钟自动跳下一条。跨域 iframe 拿不到「播放结束」事件，所以做不到真正的自动连播，只能用定时近似。高画质那档是给外链播放器传的参数，实际能给到多少由 B站 决定（未登录通常有上限）。</p>'
    + '      <div class="setting-subhead" style="margin-top:16px">TA 的主动</div>'
    + '      <div class="vid-frm"><span>邀你看</span><input type="number" id="vidSetInvite" min="0" max="100" step="1" inputmode="numeric"></div>'
    + '      <div class="vid-frm"><span>邀请成功率</span><input type="number" id="vidSetAccept" min="0" max="100" step="1" inputmode="numeric"></div>'
    + '      <p class="vid-note">进这一页时掷一次，中了他就往自己会话里发一条「我找了个视频想跟你一起看」，带标题、链接和一句从字卡库抽的话。填 0＝永不邀。</p>'
    + '      <div class="setting-subhead" style="margin-top:16px">实验性</div>'
    + '      <div class="vid-frm"><span>直接嵌 B站 网页</span><div class="vid-chips" id="vidSetEmbed">'
    + '        <button type="button" class="vid-chip" data-v="off" aria-pressed="true">关（用官方外链播放器）</button>'
    + '        <button type="button" class="vid-chip" data-v="on" aria-pressed="false">开</button>'
    + '      </div></div>'
    + '      <p class="vid-warn">开了以后 iframe 直接装 www.bilibili.com 的视频页。实测这个域名当前没有 X-Frame-Options 响应头、页面里也没有反嵌套脚本，所以<b>可能</b>装得进来；但三个坑：① iframe 里第三方 Cookie 被浏览器拦，<b>登不上你的账号</b>；② 手机版排版是桌面布局，窄屏很难用；③ B站 哪天加一条响应头就整个失效。所以默认关闭，出问题请先关回来。</p>'
    + '      <div class="setting-subhead" style="margin-top:16px">做不到的三件事</div>'
    + '      <p class="vid-note">① <b>登录 B站账号</b>：静态网页做不到。实测 api.bilibili.com 的搜索接口直接返回 412 风控、且没有 CORS 头；登录还要 passport 扫码 + WBI 签名 + CSRF，纯前端算不出来。这跟网易云那次的限制是同一堵墙，必须有服务端中转，打包成 App 也一样绕不过（限制在 B站 服务端）。② <b>真点赞 / 真收藏到 B站</b>：同上。片单里的「收藏」是存在你这台设备上的本地标记。③ <b>站内搜 B站</b>：搜索接口 412，改用「去 B站挑」跳转 + 复制链接回来。</p>'
    + '      <p class="vid-note">视频模块 v' + VID_VER + ' · 片单与设置都存在这台设备上，随「导出全部数据」一起备份 · 不存任何 B站 Cookie、不代你登录、不抓取 B站 数据</p>'
    + '    </div>'
    + '  </div>'
    + '</div>';

  var vidState = { tag: 'all', chatFold: false };

  function injectDom() {
    if (qs('#videoView')) return;
    var shell = qs('.app-shell') || document.body;
    var sec = document.createElement('section');
    sec.className = 'view';
    sec.id = 'videoView';
    sec.innerHTML = VIEW_HTML;
    var more = qs('#moreView');
    if (more && more.parentNode === shell) shell.insertBefore(sec, more);
    else shell.appendChild(sec);
    document.body.insertAdjacentHTML('beforeend', LIST_SHEET + CO_SHEET + INV_SHEET + SET_SHEET);
    bindAll();
  }

  /* ============ 10. 渲染 ============ */

  var TUNE_DEF = { prob: 35, gapMin: 3, inviteProb: 6, acceptProb: 70, autoNextMin: 0 };

  function setTune(key, val) {
    var s = root();
    var sv = String(val == null ? '' : val).trim();
    if (sv === '') return false;          // 空值一律拒绝，不能把已存的数静默清零
    var n = Number(sv);
    if (isNaN(n)) return false;
    n = Math.round(n);
    if (key === 'prob') s.watch.prob = Math.min(100, Math.max(0, n));
    else if (key === 'gapMin') s.watch.gapMin = Math.min(60, Math.max(1, n));
    else if (key === 'inviteProb') s.prefs.inviteProb = Math.min(100, Math.max(0, n));
    else if (key === 'acceptProb') s.prefs.acceptProb = Math.min(100, Math.max(0, n));
    else if (key === 'autoNextMin') s.prefs.autoNextMin = Math.min(180, Math.max(0, n));
    else return false;
    persist();
    if (key === 'autoNextMin') startAutoNext();
    renderTune();
    renderCoBar();
    renderSub();
    return true;
  }

  function renderTune() {
    var s = root();
    var q = qs('#vidCoQuick');
    if (q) {
      q.setAttribute('aria-pressed', s.watch.on ? 'true' : 'false');
      q.textContent = '一起看：' + (s.watch.on
        ? (s.watch.withCids.length ? ('开 · ' + s.watch.withCids.length + ' 位') : '开（还没选人）')
        : '关');
    }
    var map = [['#vidTProb', '#vidTProbOut', s.watch.prob, '%'],
      ['#vidTGap', '#vidTGapOut', s.watch.gapMin, ' 分钟'],
      ['#vidTInvite', '#vidTInviteOut', s.prefs.inviteProb, '%'],
      ['#vidTAccept', '#vidTAcceptOut', s.prefs.acceptProb, '%'],
      ['#vidTAuto', '#vidTAutoOut', s.prefs.autoNextMin, '']];
    map.forEach(function (row) {
      var el = qs(row[0]), out = qs(row[1]);
      if (el) el.value = (row[0] === '#vidTAuto') ? Math.min(60, row[2]) : row[2];
      if (out) out.textContent = (row[0] === '#vidTAuto') ? (row[2] ? (row[2] + ' 分钟') : '关') : (row[2] + row[3]);
    });
  }

  function sayNow() {
    var s = root();
    if (!s.watch.withCids.length) { toast('先在「一起看」里选人'); openCo(); return 0; }
    var it = curItem();
    if (!it) { toast('先在片单里挑一条视频'); return 0; }
    var n = 0;
    s.watch._at = s.watch._at || {};
    s.watch.withCids.forEach(function (cid) {
      var line = pickLine(cid);
      if (!line) return;
      if (say(cid, line, { videoBv: it.bv || '' })) {
        s.watch._at[cid] = Date.now();
        logLine(contactName(cid) || 'TA', line);
        n++;
      }
    });
    persist();
    toast(n ? (n + ' 位说了话，去聊天页看') : '没抽出话——这几位的字卡池可能是空的');
    return n;
  }

  function renderAll() {
    renderPlayer();
    renderCoBar();
    renderTune();
    renderChat();
    renderListInline();
    renderFolds();
    renderSub();
  }

  function renderSub() {
    var el = qs('#vidSub');
    if (!el) return;
    var s = root();
    var it = curItem();
    var who = s.watch.on ? s.watch.withCids.map(contactName).filter(Boolean).join('、') : '';
    el.textContent = (it ? ('在放《' + it.title + '》') : '还没挑视频')
      + (who ? (' · ' + who + ' 陪着看') : '')
      + ' · 片单 ' + s.list.length + ' 条';
  }

  function loadPlayer(it, quiet) {
    var wrap = qs('#vidFrameWrap');
    if (!wrap) return;
    var old = qs('#vidFrame');
    if (old) old.parentNode.removeChild(old);
    var empty = qs('#vidFrameEmpty');
    if (!it) { if (empty) empty.style.display = ''; return; }
    if (empty) empty.style.display = 'none';
    var f = document.createElement('iframe');
    f.id = 'vidFrame';
    f.src = embedUrl(it);
    f.setAttribute('frameborder', '0');
    f.setAttribute('allowfullscreen', 'true');
    f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('title', it.title || '视频');
    wrap.appendChild(f);
    if (!quiet) markWatched(it);
    renderPlayer();
  }

  function renderPlayer() {
    var it = curItem(), box = qs('#vidNow');
    if (!box) return;
    if (!it) { box.hidden = true; return; }
    box.hidden = false;
    var tagTxt = { want: '想看', fav: '收藏', seen: '看过' }[it.tag] || '';
    box.innerHTML = '<b>' + esc(it.title) + '</b><small>'
      + esc(it.bv ? it.bv : ('av' + (it.aid || ''))) + (tagTxt ? ' · ' + tagTxt : '')
      + (it.count ? ' · 看过 ' + it.count + ' 次' : '')
      + (it.note ? ' · ' + esc(it.note) : '')
      + (root().prefs.embedSite ? ' · <b style="color:#8d4257">实验性：直接嵌 B站 网页</b>' : '')
      + '</small>';
  }

  function renderCoBar() {
    var box = qs('#vidCoBar');
    if (!box) return;
    var s = root();
    if (!s.watch.on || !s.watch.withCids.length) { box.hidden = true; return; }
    box.hidden = false;
    var names = s.watch.withCids.map(contactName).filter(Boolean);
    box.innerHTML = '<b>一起看</b>：' + esc(names.join('、') || '（选人后才生效）')
      + ' · 插话概率 ' + s.watch.prob + '% · 最短间隔 ' + s.watch.gapMin + ' 分钟'
      + '<br><span style="color:var(--muted,#6b6a67)">他们说的话从你的字卡库抽（主字卡＋TA心里话，公共池＋各自专属池）</span>';
    var b = qs('#vidCoBtn');
    if (b) b.classList.add('on');
  }

  function renderChat() {
    var box = qs('#vidChatLog');
    if (!box) return;
    box.innerHTML = vidLog.map(function (l) {
      return '<div class="vid-line"><time>' + stamp(l.at) + '</time><b>' + esc(l.who) + '</b>' + esc(l.text) + '</div>';
    }).join('');
    try { box.scrollTop = box.scrollHeight; } catch (e) {}
  }

  function listFiltered() {
    var l = root().list;
    return vidState.tag === 'all' ? l : l.filter(function (x) { return (x.tag || 'want') === vidState.tag; });
  }

  function itemHTML(it) {
    return '<button type="button" class="vid-item' + (String(root().cur) === String(it.id) ? ' cur' : '') + '" data-id="' + esc(it.id) + '">'
      + '<span class="vid-item-tx"><b>' + esc(it.title) + '</b><small>'
      + esc(it.bv || ('av' + (it.aid || '')))
      + ' · ' + ({ want: '想看', fav: '收藏', seen: '看过' }[it.tag] || '想看')
      + (it.count ? ' · 看过 ' + it.count + ' 次' : '')
      + (it.note ? ' · ' + esc(it.note) : '')
      + '</small></span><span class="vid-item-n">播</span></button>';
  }

  function renderListInline() {
    var box = qs('#vidStrip');
    if (!box) return;
    var l = root().list.slice(0, 8);
    if (!l.length) { box.innerHTML = ''; return; }
    box.innerHTML = l.map(function (it) {
      return '<button type="button" class="vid-chip2' + (String(root().cur) === String(it.id) ? ' cur' : '')
        + '" data-id="' + esc(it.id) + '" title="' + esc(it.title) + '">' + esc(it.title) + '</button>';
    }).join('');
  }

  function renderFolds() {
    var s = root();
    var ts = qs('#vidTuneSum');
    if (ts) ts.textContent = '插话 ' + s.watch.prob + '% · 间隔 ' + s.watch.gapMin + ' 分 · 邀请成功 ' + s.prefs.acceptProb + '%';
    var cs = qs('#vidChatSum');
    if (cs) {
      var last = vidLog.length ? vidLog[vidLog.length - 1] : null;
      cs.textContent = last ? (last.who + '：' + last.text) : '还没有人说话';
    }
    var co = qs('#vidCoBtn');
    if (co && co.classList) co.classList.toggle('on', !!s.watch.on);
    var tgl = qs('#vidTuneToggle'), cgl = qs('#vidChatToggle');
    if (tgl) { var a = tgl.querySelector('i'); if (a) a.textContent = qs('#vidTune') && !qs('#vidTune').hidden ? '︿' : '﹀'; }
    if (cgl) { var b = cgl.querySelector('i'); if (b) b.textContent = qs('#vidChat') && !qs('#vidChat').hidden ? '︿' : '﹀'; }
  }

  function renderListSheet() {
    var box = qs('#vidListBody');
    if (!box) return;
    var l = listFiltered();
    qsa('#vidTagRow .vid-chip').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.tag === vidState.tag ? 'true' : 'false');
    });
    if (!l.length) { box.innerHTML = '<div class="vid-note" style="text-align:center;padding:14px 0">这一档还没有视频</div>'; return; }
    box.innerHTML = l.map(function (it) {
      return '<div class="vid-item' + (String(root().cur) === String(it.id) ? ' cur' : '') + '" style="display:flex">'
        + '<span class="vid-item-tx"><b>' + esc(it.title) + '</b><small>'
        + esc(it.bv || ('av' + (it.aid || ''))) + (it.count ? ' · 看过 ' + it.count + ' 次' : '')
        + (it.note ? ' · ' + esc(it.note) : '') + '</small></span>'
        + '<span style="flex:none;display:flex;gap:6px">'
        + '<button type="button" class="vid-chip" data-act="play" data-id="' + esc(it.id) + '">播</button>'
        + '<button type="button" class="vid-chip" data-act="tag" data-id="' + esc(it.id) + '">档</button>'
        + '<button type="button" class="vid-chip" data-act="send" data-id="' + esc(it.id) + '">发</button>'
        + '<button type="button" class="vid-chip" data-act="del" data-id="' + esc(it.id) + '">删</button>'
        + '</span></div>';
    }).join('');
  }

  function renderCoWho() {
    var box = qs('#vidCoWho');
    if (!box) return;
    var cs = [];
    try { cs = (data.contacts || []).slice(); } catch (e) { cs = []; }
    if (!cs.length) { box.innerHTML = '<div class="vid-note">还没有联系人</div>'; return; }
    var picked = root().watch.withCids;
    box.innerHTML = cs.map(function (c) {
      if (!c || !c.id) return '';
      var on = picked.indexOf(c.id) >= 0;
      return '<button type="button" class="vid-who" data-cid="' + esc(c.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">'
        + '<b>' + esc(c.name || '(未命名)') + '</b><small>'
        + (c.kind === 'group' ? '群聊' : (on ? '在一起看' : '点一下加入')) + '</small></button>';
    }).join('');
  }

  /* ============ 11. 交互 ============ */

  function openSheet(id) { var m = qs('#' + id); if (m) m.hidden = false; }
  function closeSheet(id) { var m = qs('#' + id); if (m) m.hidden = true; }
  function chipSet(w, v) { qsa('#' + w + ' .vid-chip').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false'); }); }
  function chipVal(w, d) { var o = qs('#' + w + ' .vid-chip[aria-pressed=true]'); return o ? o.dataset.v : d; }

  function openList() { renderListSheet(); openSheet('vidListMask'); }
  function openCo() {
    var s = root();
    chipSet('vidCoOn', s.watch.on ? 'on' : 'off');
    qs('#vidCoProb').value = s.watch.prob;
    qs('#vidCoGap').value = s.watch.gapMin;
    renderCoWho();
    openSheet('vidCoMask');
  }
  function openSet() {
    var p = root().prefs;
    chipSet('vidSetDm', p.danmaku ? 'on' : 'off');
    chipSet('vidSetHq', p.highQ ? 'on' : 'off');
    chipSet('vidSetEmbed', p.embedSite ? 'on' : 'off');
    qs('#vidSetAuto').value = p.autoNextMin;
    qs('#vidSetInvite').value = p.inviteProb;
    var ap = qs('#vidSetAccept'); if (ap) ap.value = p.acceptProb;
    openSheet('vidSetMask');
  }

  function saveCo() {
    var s = root();
    s.watch.on = chipVal('vidCoOn', 'off') === 'on';
    s.watch.prob = Math.min(100, Math.max(0, Number(qs('#vidCoProb').value) || 0));
    s.watch.gapMin = Math.min(60, Math.max(1, Number(qs('#vidCoGap').value) || 3));
    if (s.watch.on && !s.watch.withCids.length) { toast('还没选人，一起看不会生效'); }
    persist();
    renderAll();
  }

  function saveSet() {
    var p = root().prefs;
    var oldDm = p.danmaku, oldHq = p.highQ, oldEmb = p.embedSite;
    p.danmaku = chipVal('vidSetDm', 'on') === 'on';
    p.highQ = chipVal('vidSetHq', 'on') === 'on';
    p.embedSite = chipVal('vidSetEmbed', 'off') === 'on';
    p.autoNextMin = Math.min(180, Math.max(0, Number(qs('#vidSetAuto').value) || 0));
    p.inviteProb = Math.min(100, Math.max(0, Number(qs('#vidSetInvite').value) || 0));
    var apEl = qs('#vidSetAccept');
    if (apEl) p.acceptProb = Math.min(100, Math.max(0, Number(apEl.value) || 0));
    persist();
    startAutoNext();
    if (oldDm !== p.danmaku || oldHq !== p.highQ || oldEmb !== p.embedSite) {
      var it = curItem();
      if (it) loadPlayer(it, true);
    }
    renderAll();
  }

  function bindAll() {
    var lb = qs('#vidListBtn'); if (lb) lb.addEventListener('click', openList);
    var ab = qs('#vidAddBtn'); if (ab) ab.addEventListener('click', openList);
    var ib = qs('#vidInviteBtn'); if (ib) ib.addEventListener('click', inviteOpen);
    var ic = qs('#vidInvClose'); if (ic) ic.addEventListener('click', function () { closeSheet('vidInvMask'); });
    var ig = qs('#vidInvGo'); if (ig) ig.addEventListener('click', function () { inviteSend(); });
    var iw = qs('#vidInvWho');
    if (iw) iw.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.vid-who') : null;
      if (!b) return;
      var cid = b.dataset.cid, i = invPicked.indexOf(cid);
      if (i < 0) invPicked.push(cid); else invPicked.splice(i, 1);
      b.setAttribute('aria-pressed', i < 0 ? 'true' : 'false');
      var sm = b.querySelector('small');
      if (sm) sm.textContent = i < 0 ? '已选' : '点一下选';
    });
    var iwn = qs('#vidInvWhen');
    if (iwn) iwn.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.vid-chip') : null;
      if (!b) return;
      chipSet('vidInvWhen', b.dataset.v);
      var at = b.dataset.v === 'at';
      var r1 = qs('#vidInvAtRow'), r2 = qs('#vidInvAtRow2');
      if (r1) r1.hidden = !at;
      if (r2) r2.hidden = !at;
    });
    var tt = qs('#vidTuneToggle');
    if (tt) tt.addEventListener('click', function () {
      var p = qs('#vidTune'); if (!p) return;
      p.hidden = !p.hidden; renderFolds();
    });
    var ct = qs('#vidChatToggle');
    if (ct) ct.addEventListener('click', function () {
      var p = qs('#vidChat'); if (!p) return;
      p.hidden = !p.hidden; renderFolds();
    });
    var cb = qs('#vidCoBtn'); if (cb) cb.addEventListener('click', openCo);
    var sb = qs('#vidSetBtn'); if (sb) sb.addEventListener('click', openSet);
    var lc = qs('#vidListClose'); if (lc) lc.addEventListener('click', function () { closeSheet('vidListMask'); });
    var cc = qs('#vidCoClose'); if (cc) cc.addEventListener('click', function () { saveCo(); closeSheet('vidCoMask'); });
    var sc = qs('#vidSetClose'); if (sc) sc.addEventListener('click', function () { saveSet(); closeSheet('vidSetMask'); });

    var pv = qs('#vidPrev'); if (pv) pv.addEventListener('click', function () { var it = stepItem(-1); if (it) loadPlayer(it); else toast('片单是空的'); });
    var nx = qs('#vidNext'); if (nx) nx.addEventListener('click', function () { var it = stepItem(1); if (it) loadPlayer(it); else toast('片单是空的'); });

    var os = qs('#vidOpenSite');
    if (os) os.addEventListener('click', function () {
      try { window.open('https://www.bilibili.com/', '_blank', 'noopener'); } catch (e) { location.href = 'https://www.bilibili.com/'; }
    });

    var ag = qs('#vidAddGo');
    if (ag) ag.addEventListener('click', function () {
      var u = qs('#vidAddUrl'), t = qs('#vidAddTitle'), n = qs('#vidAddNote');
      var r = addItem(u.value, t.value, n.value);
      if (r.err) { toast(r.err); return; }
      u.value = ''; t.value = ''; n.value = '';
      if (r.dup) toast('这条已经在片单里了，帮你切过去');
      else toast('加进片单了');
      loadPlayer(r.item, true);
      renderListSheet();
      renderAll();
    });

    var tagRow = qs('#vidTagRow');
    if (tagRow) tagRow.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.vid-chip') : null;
      if (!b || !b.dataset.tag) return;
      vidState.tag = b.dataset.tag;
      renderListSheet();
      renderListInline();
    });

    var lbody = qs('#vidListBody');
    if (lbody) lbody.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.vid-chip[data-act]') : null;
      if (!b) return;
      var it = findItem(b.dataset.id);
      if (!it) return;
      var act = b.dataset.act;
      if (act === 'play') { root().cur = it.id; persist(); loadPlayer(it); renderListSheet(); renderAll(); closeSheet('vidListMask'); }
      else if (act === 'tag') {
        var order = ['want', 'fav', 'seen'];
        setTag(it.id, order[(order.indexOf(it.tag || 'want') + 1) % 3]);
        renderListSheet(); renderListInline(); renderPlayer();
      } else if (act === 'send') { pushToChat(currentChatId(), it, '推荐一个视频：' + it.title); renderListSheet(); }
      else if (act === 'del') {
        var doDel = function () { removeItem(it.id); renderListSheet(); renderAll(); toast('删掉了'); };
        try {
          if (typeof window.openModal === 'function') {
            window.openModal('删掉这条', '', function () { doDel(); },
              { noInput: true, staticText: '从片单里删掉《' + it.title + '》？只删你本机的记录，不影响 B站 上的视频。', okText: '删掉', danger: true });
            return;
          }
        } catch (e2) {}
        if (window.confirm('从片单里删掉《' + it.title + '》？')) doDel();
      }
    });

    var inline = qs('#vidStrip');
    if (inline) inline.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.vid-chip2[data-id]') : null;
      if (!b) return;
      var it = findItem(b.dataset.id);
      if (!it) return;
      root().cur = it.id; persist();
      loadPlayer(it);
      renderAll();
    });

    var who = qs('#vidCoWho');
    if (who) who.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.vid-who') : null;
      if (!b) return;
      var cid = b.dataset.cid, arr = root().watch.withCids, i = arr.indexOf(cid);
      if (i < 0) arr.push(cid); else arr.splice(i, 1);
      b.setAttribute('aria-pressed', i < 0 ? 'true' : 'false');
      var sm = b.querySelector('small');
      if (sm) sm.textContent = i < 0 ? '在一起看' : '点一下加入';
      persist();
      renderCoBar();
      renderSub();
    });

    ['vidCoOn', 'vidSetDm', 'vidSetHq', 'vidSetEmbed'].forEach(function (w) {
      var el = qs('#' + w);
      if (!el) return;
      el.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.vid-chip') : null;
        if (b) chipSet(w, b.dataset.v);
      });
    });

    [['vidTProb', 'prob'], ['vidTGap', 'gapMin'], ['vidTInvite', 'inviteProb'], ['vidTAuto', 'autoNextMin']]
      .forEach(function (pair) {
        var el = qs('#' + pair[0]);
        if (!el) return;
        var go = function () { setTune(pair[1], el.value); };
        el.addEventListener('input', go);
        el.addEventListener('change', go);
      });

    var qc = qs('#vidCoQuick');
    if (qc) qc.addEventListener('click', function () {
      var s = root();
      s.watch.on = !s.watch.on;
      persist();
      renderTune(); renderCoBar(); renderSub(); startCo();
      if (s.watch.on && !s.watch.withCids.length) { toast('还没选人 · 挑一位再一起看'); openCo(); }
    });

    var tf = qs('#vidTuneFold');
    if (tf) tf.addEventListener('click', function () {
      var b = qs('#vidTuneBody');
      if (!b) return;
      var folded = b.style.display === 'none';
      b.style.display = folded ? '' : 'none';
      tf.textContent = folded ? '︿' : '﹀';
    });

    var tn = qs('#vidTNow');
    if (tn) tn.addEventListener('click', function () { sayNow(); });

    var tr = qs('#vidTReset');
    if (tr) tr.addEventListener('click', function () {
      setTune('prob', TUNE_DEF.prob);
      setTune('gapMin', TUNE_DEF.gapMin);
      setTune('inviteProb', TUNE_DEF.inviteProb);
      setTune('acceptProb', TUNE_DEF.acceptProb);
      setTune('autoNextMin', TUNE_DEF.autoNextMin);
      toast('已恢复默认：插话 35% · 间隔 3 分 · 邀请成功 70% · TA 主动邀 6% · 不自动跳');
    });

    var send = qs('#vidSendBtn');
    if (send) send.addEventListener('click', function () { pushToChat(currentChatId(), curItem()); });

    var cin = qs('#vidChatInput'), cs = qs('#vidChatSend');
    var doSendMine = function () {
      var t = (cin.value || '').trim();
      if (!t) return;
      var cid = currentChatId() || (root().watch.withCids[0] || '');
      if (!cid) { toast('先进一个会话，或在「一起看」里选人'); return; }
      if (sayMe(cid, t)) { logLine('我', t); cin.value = ''; }
      else toast('没发出去');
    };
    if (cs) cs.addEventListener('click', doSendMine);
    if (cin) cin.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSendMine(); } });

    var fold = qs('#vidChatFold');
    if (fold) fold.addEventListener('click', function () {
      vidState.chatFold = !vidState.chatFold;
      var log = qs('#vidChatLog'), inp = qs('#vidChatIn');
      if (log) log.style.display = vidState.chatFold ? 'none' : '';
      if (inp) inp.style.display = vidState.chatFold ? 'none' : '';
      fold.textContent = vidState.chatFold ? '﹀' : '︿';
    });

    [qs('#vidListMask'), qs('#vidCoMask'), qs('#vidSetMask')].forEach(function (m) {
      if (!m) return;
      m.addEventListener('click', function (e) {
        if (e.target !== m) return;
        if (m.id === 'vidCoMask') saveCo();
        if (m.id === 'vidSetMask') saveSet();
        m.hidden = true;
      });
    });
  }

  function currentChatId() {
    try { if (siteReady() && data.activeChat) return data.activeChat; } catch (e) {}
    try { if (typeof mainChatId === 'function') return mainChatId(); } catch (e2) {}
    return '';
  }

  /* ============ 12. 路由 + 磁贴 ============ */

  function vidOpen() {
    var sec = qs('#videoView');
    if (!sec) { injectDom(); sec = qs('#videoView'); }
    if (!sec) return;
    if (!siteReady()) { toast('数据还没载入完，稍等一下再点'); return; }
    var prev = document.body.dataset.view || '';
    qsa('.view').forEach(function (v) {
      v.classList.toggle('active', v.id === 'videoView');
      v.classList.remove('no-anim');
    });
    qsa('[data-view]').forEach(function (b) {
      if (b.id === 'backChatsBtn' || b.id === 'topbarTitle') return;
      b.classList.toggle('active', b.dataset.view === 'video');
    });
    document.body.dataset.view = 'video';
    try {
      if (prev && prev !== 'video' && typeof _navStack !== 'undefined' && _navStack && _navStack.push) _navStack.push(prev);
    } catch (e) {}
    try { if (typeof _setBackTarget === 'function') _setBackTarget('video'); } catch (e) {}
    try { if (typeof updateTopbarTitle === 'function') updateTopbarTitle('video'); } catch (e) {}
    var tt = qs('#topbarTitleText');
    if (tt) tt.textContent = '视频';
    renderAll();
    startCo();
    startAutoNext();
    maybeInvite();
    try { sec.scrollTop = 0; } catch (e2) {}
  }

  function hookRouter() {
    try {
      if (typeof window.showView !== 'function' || window.showView.__vidWrapped) return;
      var orig = window.showView;
      var wrap = function (name) {
        if (name === 'video') { vidOpen(); return; }
        return orig.apply(this, arguments);
      };
      wrap.__vidWrapped = 1;
      wrap.__calWrapped = orig.__calWrapped;
      window.showView = wrap;
    } catch (e) {}
  }

  function hookTile() {
    try {
      if (typeof HUB_GROUPS === 'undefined' || !HUB_GROUPS || !HUB_GROUPS.length) return;
      var dup = false;
      HUB_GROUPS.forEach(function (g) { (g.rows || []).forEach(function (r) { if (r && r.nav === 'video') dup = true; }); });
      if (dup) return;
      var host = null;
      for (var i = 0; i < HUB_GROUPS.length; i++) {
        if (HUB_GROUPS[i] && (HUB_GROUPS[i].name === '玩' || HUB_GROUPS[i].name === '记录')) { host = HUB_GROUPS[i]; break; }
      }
      if (!host) host = HUB_GROUPS[HUB_GROUPS.length - 1];
      if (!host || !host.rows) return;
      host.rows.push({
        ico: VID_ICO,
        name: '视频',
        desc: '用 B站官方外链播放器在站内看；可以叫上一位或几位一起看，他们会从字卡库里抽话插嘴',
        nav: 'video',
        more: { o: 5, d: '一起看 · 片单 · 本地收藏' }
      });
      if (typeof renderMorePage === 'function') renderMorePage();
      hookMoreClicks();
      if (typeof renderHubPage === 'function' && document.body.dataset.view === 'hub') renderHubPage();
    } catch (e) {}
  }

  /* 磁贴点击委托：日历模块若已绑过（calBound）就不重复绑，避免一次点击触发两遍 */
  function hookMoreClicks() {
    try {
      var list = document.getElementById('moreList');
      if (!list || list.dataset.calBound === '1' || list.dataset.vidBound === '1') return;
      list.dataset.vidBound = '1';
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

  /* ============ 13. 启动 ============ */

  function boot() {
    try { injectStyle(); injectDom(); hookRouter(); hookTile(); hookMoreClicks(); startCo(); startAutoNext(); }
    catch (e) { try { console.warn('[视频模块] 初始化失败', e); } catch (e2) {} }
  }

  function onReady() {
    try { mergeFallback(); hookTile(); hookMoreClicks(); } catch (e) {}
  }

  boot();
  try { document.addEventListener('ordinal-data-ready', onReady); } catch (e) {}
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); onReady(); });
  } else { onReady(); }

  try {
    window.__vidModuleReady = VID_VER;
    window.__vidDebug = {
      parseInput: parseInput, playerUrl: playerUrl, siteUrl: siteUrl, embedUrl: embedUrl,
      addItem: addItem, root: root, cardPool: cardPool, pickLine: pickLine,
      speakerNameFor: speakerNameFor, contactName: contactName, curItem: curItem,
      say: say, sayMe: sayMe, coTick: coTick, pushToChat: pushToChat, maybeInvite: maybeInvite,
      inviteSend: inviteSend, inviteOpen: inviteOpen, writeAppointment: writeAppointment,
      proposeWhen: proposeWhen, fmtWhen: fmtWhen, calReady: calReady, setInvPicked: function (a) { invPicked = a.slice(); },
      ACCEPT_YES: ACCEPT_YES, ACCEPT_NO: ACCEPT_NO,
      stepItem: stepItem, removeItem: removeItem, setTag: setTag, findItem: findItem,
      markWatched: markWatched, sayNow: sayNow, setTune: setTune,
      log: function () { return vidLog; }
    };
    window.__vidSelfTest = function () {
      var out = { 模块版本: VID_VER, 站点data就绪: siteReady() };
      try {
        out.片单条数 = root().list.length;
        out.一起看 = root().watch.on ? ('开着 · ' + root().watch.withCids.length + ' 位') : '关着';
        out.节奏 = '插话 ' + root().watch.prob + '% · 间隔 ' + root().watch.gapMin + ' 分 · 邀请成功 '
          + root().prefs.acceptProb + '% · TA主动邀 ' + root().prefs.inviteProb + '% · 自动跳 '
          + (root().prefs.autoNextMin ? (root().prefs.autoNextMin + ' 分') : '关');
        out.日历可写 = calReady();
        out.实验性嵌站 = !!root().prefs.embedSite;
      } catch (e) { out.数据层 = '失败 ' + e; }
      try {
        var cid = currentChatId();
        out.当前会话 = cid || '（无）';
        out.可用字卡数 = cid ? cardPool(cid, speakerNameFor(cid)).length : 0;
        out.抽一句样例 = cid ? (pickLine(cid) || '（这位没有可用字卡）') : '';
      } catch (e2) { out.字卡层 = '失败 ' + e2; }
      try { out.链接解析 = JSON.stringify(parseInput('https://www.bilibili.com/video/BV1GJ411x7h7/')); } catch (e3) {}
      try { out.视图已注入 = !!document.getElementById('videoView'); } catch (e4) {}
      try { out.路由已接管 = !!(window.showView && window.showView.__vidWrapped); } catch (e5) {}
      try {
        out.磁贴已加入 = (typeof HUB_GROUPS !== 'undefined') && HUB_GROUPS.some(function (g) {
          return (g.rows || []).some(function (r) { return r && r.nav === 'video'; });
        });
      } catch (e6) {}
      try { if (console.table) console.table(out); else console.log(out); } catch (e7) {}
      return out;
    };
  } catch (e) {}
})();
