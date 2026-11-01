/* 言字卡 · 账户与商城模块 v1.0.0 —— 独立文件，不修改 app.v22.2.1.js
 *
 * 安装：本文件放进 dist/ ，在 index.html 已有那几行 script 的最后面加一行：
 *         <script defer src="dist/money.js"></script>
 *
 * 做什么：
 *   账户  看你和每位梦角的余额；梦角申请充值会在他单聊里落一条系统消息，你批准才到账；
 *         双向转账（金额随机、节奏写在代码里，不设概率开关）；流水可查。
 *   商城  四类内置商品（日用品 / 增强连接 / 出行 / 情侣礼物），图标全部手绘 SVG、无 emoji；
 *         你买来立刻送或定时送给梦角，可附一封信；梦角也会自己买一件送你（扣他余额）。
 *
 * 转账气泡：作为一条普通消息发出，所以气泡底色/圆角/字体自动跟随你的全局气泡设置；
 *          渲染后由本模块把气泡内容换成「图标 + 大字金额 + 留言」的卡片（保留 .bubble 外壳）。
 *          万一升级没生效，气泡里仍是可读的「转账 ￥52.00」纯文字，不会变成空白。
 *
 * 金额一律以「分」为单位存整数，避免浮点误差；显示时才转成 ￥xx.xx。
 */
(function () {
  'use strict';

  var MN_VER = '1.2.0';
  var NIGHT_FROM = 1, NIGHT_TO = 7;     // 「夜里不打扰」的时间窗：凌晨 1 点到早上 7 点
  var MIN_CENT = 100;                   // 最少 ￥1 才发得出转账
  var TICK_MS = 60 * 1000;              // 主循环每分钟醒一次，按下面 tickMin 决定这轮掷不掷

  /* TA 的主动行为：全部可在「账户」页调，默认值如下 */
  var PREFS_DEF = {
    pTransfer: 6,      // 主动转账概率 %
    pGift: 5,          // 主动买礼物送你概率 %
    pTopUp: 8,         // 自己往账户充钱概率 %（不用你批，直接到账）
    topUpMax: 5000,    // 他自己充值单笔上限（元）
    pLetter: 30,       // 送礼时附一封信概率 %
    tickMin: 30,       // 多少分钟掷一次
    nightOff: true,    // 23:00–07:00 不打扰
    maxTransfer: 0     // 单笔转账上限（元），0＝不限，只受余额约束
  };

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
  function nid(pre) {
    try { if (typeof nextId === 'function') return String(nextId()); } catch (e) {}
    return (pre || 'm') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function siteReady() {
    try { return (typeof data !== 'undefined' && data && typeof data === 'object'); } catch (e) { return false; }
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

  function fen2yuan(c) {
    var n = Math.round(Number(c) || 0);
    var sign = n < 0 ? '-' : '';
    n = Math.abs(n);
    return sign + '￥' + Math.floor(n / 100) + '.' + ('0' + (n % 100)).slice(-2);
  }
  function yuan2fen(v) {
    var n = Number(String(v == null ? '' : v).replace(/[￥,\s]/g, ''));
    if (!isFinite(n)) return NaN;
    return Math.round(n * 100);
  }
  function stamp(ts) {
    var d = new Date(ts || Date.now());
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function ymdLocal(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function isNight() {
    if (!prefs().nightOff) return false;
    var h = new Date().getHours();
    // 窗口不跨零点时用 &&，跨零点时才用 ||，否则会把全天都判成夜里
    return NIGHT_FROM <= NIGHT_TO ? (h >= NIGHT_FROM && h < NIGHT_TO) : (h >= NIGHT_FROM || h < NIGHT_TO);
  }
  function inHourWindow(h, from, to) {
    return from <= to ? (h >= from && h < to) : (h >= from || h < to);
  }

  /* ============ 1. 数据层 ============ */

  function defStore() {
    return {
      v: MN_VER,
      me: { balance: 0, log: [] },
      byCid: {},
      pending: [],
      shop: { items: clone(SHOP_SEED), orders: [], cats: [] },
      prefs: clone(PREFS_DEF),
      stats: { transfers: 0, gifts: 0, toppedUp: 0 }
    };
  }

  function walletOf(cid) {
    var s = root();
    if (!cid || cid === '__me__') return s.me;
    if (!isObj(s.byCid[cid])) s.byCid[cid] = { balance: 0, log: [] };
    if (!Array.isArray(s.byCid[cid].log)) s.byCid[cid].log = [];
    return s.byCid[cid];
  }
  function balanceOf(cid) { return Math.round(Number(walletOf(cid).balance) || 0); }
  function prefs() { return root().prefs; }

  /* 他自己充值的金额：随机掷一个数。
   * 18% 概率蹦一个有意义的数（520 / 1314 / 8888 …），其余按对数均匀分布在 ￥10 到上限之间——
   * 这样小额出现得多、大额偶尔来一次，而不是一水儿的三位数。最后取整到 10 元。 */
  function rollTopUp() {
    var maxYuan = Math.round(Number(prefs().topUpMax) || 0);
    if (maxYuan < 10) maxYuan = 5000;
    var r = Math.random(), yuan;
    if (r < 0.18) {
      var specials = [520, 666, 888, 999, 1314, 5200, 6666, 8888, 13140];
      var pickPool = specials.filter(function (v) { return v <= maxYuan; });
      yuan = pickPool.length ? pickPool[Math.floor(Math.random() * pickPool.length)] : maxYuan;
    } else {
      var lo = Math.log(10), hi = Math.log(Math.max(11, maxYuan));
      yuan = Math.exp(lo + Math.random() * (hi - lo));
    }
    yuan = Math.min(maxYuan, Math.max(10, Math.round(yuan / 10) * 10));
    return Math.round(yuan) * 100;
  }

  function logPush(w, entry) {
    if (!w || !Array.isArray(w.log)) return;
    w.log.unshift(entry);
    if (w.log.length > 200) w.log.length = 200;
  }

  function credit(cid, cents, kind, note) {
    var w = walletOf(cid);
    w.balance = Math.round((Number(w.balance) || 0) + cents);
    logPush(w, { at: Date.now(), dir: 'in', cents: cents, kind: kind || '', note: note || '' });
    return w.balance;
  }
  function debit(cid, cents, kind, note) {
    var w = walletOf(cid);
    var have = Math.round(Number(w.balance) || 0);
    if (cents > have) return false;                     // 不允许透支
    w.balance = have - cents;
    logPush(w, { at: Date.now(), dir: 'out', cents: cents, kind: kind || '', note: note || '' });
    return true;
  }

  function norm(s) {
    if (!isObj(s)) s = defStore();
    if (!isObj(s.me)) s.me = { balance: 0, log: [] };
    if (!Array.isArray(s.me.log)) s.me.log = [];
    s.me.balance = Math.max(0, Math.round(Number(s.me.balance) || 0));
    if (!isObj(s.byCid)) s.byCid = {};
    if (!Array.isArray(s.pending)) s.pending = [];
    if (!isObj(s.shop)) s.shop = { items: clone(SHOP_SEED), orders: [], cats: [] };
    if (!Array.isArray(s.shop.items) || !s.shop.items.length) s.shop.items = clone(SHOP_SEED);
    if (!Array.isArray(s.shop.orders)) s.shop.orders = [];
    if (!Array.isArray(s.shop.cats)) s.shop.cats = [];
    s.shop.cats = s.shop.cats.filter(function (c) { return typeof c === 'string' && !!c.trim(); });
    if (!isObj(s.prefs)) s.prefs = clone(PREFS_DEF);
    var pf = s.prefs, df = PREFS_DEF;
    function clampNum(k, lo, hi) {
      var n = Number(pf[k]);
      pf[k] = isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : df[k];
    }
    clampNum('pTransfer', 0, 100); clampNum('pGift', 0, 100);
    clampNum('pTopUp', 0, 100); clampNum('pLetter', 0, 100);
    clampNum('tickMin', 5, 180); clampNum('maxTransfer', 0, 100000);
    clampNum('topUpMax', 10, 100000);
    pf.nightOff = pf.nightOff !== false;
    if (!isObj(s.stats)) s.stats = { transfers: 0, gifts: 0, toppedUp: 0 };
    return s;
  }

  function root() {
    if (siteReady()) { data.money = norm(data.money); return data.money; }
    try {
      var raw = localStorage.getItem('ordinal-money');
      return raw ? norm(JSON.parse(raw)) : defStore();
    } catch (e) { return defStore(); }
  }
  function persist() {
    if (siteReady() && data.money) {
      try { if (typeof save === 'function') { save(); return; } } catch (e) {}
    }
    try { localStorage.setItem('ordinal-money', JSON.stringify(root())); } catch (e2) {}
  }

  /* ============ 2. 商品目录（图标全部手绘 SVG 片段，24×24 线性描边，无 emoji） ============ */

  var ICO = {
    cocoa: '<path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 9.5h1.8a2.7 2.7 0 0 1 0 5.4H17"/><path d="M8 5.2c-.7-.9-.7-1.7 0-2.6M12 5.2c-.7-.9-.7-1.7 0-2.6"/>',
    coffee: '<path d="M5 7h11v7a4.5 4.5 0 0 1-4.5 4.5h-2A4.5 4.5 0 0 1 5 14z"/><path d="M16 8.6h1.6a2.6 2.6 0 0 1 0 5.2H16"/><path d="M4 21.2h13"/>',
    cream: '<rect x="8" y="7.5" width="8" height="13" rx="2.6"/><path d="M9.6 7.5V5.2h4.8v2.3"/><path d="M9.6 12.4h4.8"/>',
    warmer: '<rect x="5" y="4.5" width="14" height="15" rx="3.4"/><path d="M12 9c1.9 1.6 2.8 2.9 2.8 4.1a2.8 2.8 0 1 1-5.6 0C9.2 11.9 10.1 10.6 12 9z"/>',
    song: '<path d="M9 18V6.2l10-1.7V16"/><circle cx="6.4" cy="18" r="2.6"/><circle cx="16.4" cy="16" r="2.6"/>',
    talk: '<path d="M20.6 11.8a7.9 7.9 0 0 1-8.4 7.9 8.3 8.3 0 0 1-3.6-.8L3.4 20.6l1.7-4.6a7.9 7.9 0 0 1-.9-3.8 7.9 7.9 0 0 1 8-8.1 7.9 7.9 0 0 1 8.4 7.7z"/><path d="M9 11.6h.01M12.2 11.6h.01M15.4 11.6h.01"/>',
    card: '<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2.6"/><path d="M12 9.4c1.5-1.9 4.4-1.2 4.4 1 0 1.7-2.6 3.3-4.4 4.6-1.8-1.3-4.4-2.9-4.4-4.6 0-2.2 2.9-2.9 4.4-1z"/>',
    voice: '<rect x="9.2" y="3" width="5.6" height="11" rx="2.8"/><path d="M5.6 11.6a6.4 6.4 0 0 0 12.8 0"/><path d="M12 18v3.2"/>',
    ticket: '<path d="M3.4 8.4h17.2v2.2a1.8 1.8 0 0 0 0 3.6v2.2H3.4v-2.2a1.8 1.8 0 0 0 0-3.6z"/><path d="M13.4 8.4v7.2" stroke-dasharray="1.6 1.8"/>',
    park: '<circle cx="12" cy="9.4" r="5.4"/><path d="M12 4v10.8M6.6 9.4h10.8M8.2 5.6l7.6 7.6M15.8 5.6l-7.6 7.6"/><path d="M12 14.8v6.4"/>',
    trip: '<path d="M4 19.4 20 5.6"/><path d="M8.4 5.2h11.2v11"/><circle cx="6.6" cy="17.4" r="2.2"/>',
    sea: '<path d="M3.4 15.6c1.8-1.6 3.4-1.6 5.2 0s3.4 1.6 5.2 0 3.4-1.6 5.2 0"/><path d="M3.4 19.4c1.8-1.6 3.4-1.6 5.2 0s3.4 1.6 5.2 0 3.4-1.6 5.2 0"/><circle cx="16.6" cy="6.6" r="2.6"/><path d="M4.6 9.4h7.2"/>',
    note: '<path d="M6 3.6h9.2L19 7.4v13H6z"/><path d="M14.8 3.6v4h4"/><path d="M8.8 12h6.4M8.8 15.4h4.4"/>',
    flower: '<circle cx="12" cy="8.2" r="2.2"/><path d="M12 6c0-2 1-3.2 2.4-3.2S16.6 4.4 15.4 6M12 6c0-2-1-3.2-2.4-3.2S7.4 4.4 8.6 6M14.2 8.2c2 0 3.2 1 3.2 2.4S15.8 12.8 14.2 11.6M9.8 8.2c-2 0-3.2 1-3.2 2.4S8.2 12.8 9.8 11.6"/><path d="M12 10.4v10.8"/><path d="M12 15.6c-2 0-3.4-1-3.8-2.8 1.9-.3 3.3.6 3.8 2.8z"/>',
    ring: '<circle cx="12" cy="14.6" r="5.4"/><path d="M9.6 8.6 12 4.4l2.4 4.2"/><path d="M10.6 8.9h2.8"/>',
    perfume: '<rect x="7.4" y="8.6" width="9.2" height="12" rx="2.6"/><path d="M10.4 8.6V5.8h3.2v2.8"/><path d="M14.6 4.4h2.6"/><path d="M9.8 13.4h4.4"/>',
    box: '<path d="M3.6 7.6 12 3.4l8.4 4.2v8.8L12 20.6l-8.4-4.2z"/><path d="M3.6 7.6 12 11.8l8.4-4.2M12 11.8v8.8"/>'
  };

  var SHOP_SEED = [
    { id: 'it_cocoa', name: '一杯热可可', cat: '日用品', cents: 1800, ico: 'cocoa', note: '冬天那种，上面浮两颗棉花糖' },
    { id: 'it_coffee', name: '一杯咖啡', cat: '日用品', cents: 2200, ico: 'coffee', note: '提神的，少糖' },
    { id: 'it_cream', name: '护手霜', cat: '日用品', cents: 3900, ico: 'cream', note: '手干了记得擦' },
    { id: 'it_warmer', name: '暖手宝', cat: '日用品', cents: 5900, ico: 'warmer', note: '充好电的那种' },
    { id: 'it_song', name: '一起听歌券', cat: '增强连接', cents: 6600, ico: 'song', note: '兑换一次「就现在，一起听一首」' },
    { id: 'it_talk', name: '深夜长谈券', cat: '增强连接', cents: 12800, ico: 'talk', note: '兑换一次不设时限的长谈' },
    { id: 'it_card', name: '专属字卡一张', cat: '增强连接', cents: 9900, ico: 'card', note: '他为你写一句只属于你们的话' },
    { id: 'it_voice', name: '一句语音', cat: '增强连接', cents: 8800, ico: 'voice', note: '他念给你听' },
    { id: 'it_ticket', name: '电影票两张', cat: '出行', cents: 12000, ico: 'ticket', note: '后排靠中间' },
    { id: 'it_park', name: '游乐场门票', cat: '出行', cents: 29900, ico: 'park', note: '一整天，含摩天轮' },
    { id: 'it_trip', name: '周边一日游', cat: '出行', cents: 46800, ico: 'trip', note: '换个城市走走' },
    { id: 'it_sea', name: '看海车票', cat: '出行', cents: 33000, ico: 'sea', note: '去海边住一晚' },
    { id: 'it_note', name: '手写卡片', cat: '情侣礼物', cents: 2000, ico: 'note', note: '字不好看也算心意' },
    { id: 'it_flower', name: '一束花', cat: '情侣礼物', cents: 19900, ico: 'flower', note: '当季的花，不挑贵' },
    { id: 'it_perfume', name: '一瓶香水', cat: '情侣礼物', cents: 39900, ico: 'perfume', note: '闻起来像刚下过雨' },
    { id: 'it_ring', name: '一枚银戒', cat: '情侣礼物', cents: 52000, ico: 'ring', note: '不贵，但是认真的' }
  ];

  var CATS = ['日用品', '增强连接', '出行', '情侣礼物'];   // 内置四类，不可删

  function allCats() {
    var s = root(), out = CATS.slice();
    (s.shop.cats || []).forEach(function (c) { if (out.indexOf(c) < 0) out.push(c); });
    items().forEach(function (it) { if (it && it.cat && out.indexOf(it.cat) < 0) out.push(it.cat); });
    return out;
  }
  function isBuiltinCat(c) { return CATS.indexOf(c) >= 0; }
  function catCount(c) { return items().filter(function (it) { return it.cat === c; }).length; }
  function addCat(name) {
    var n = String(name == null ? '' : name).trim();
    if (!n) return { ok: false, why: '名字是空的' };
    if (n.length > 8) return { ok: false, why: '分类名最多 8 个字' };
    if (allCats().indexOf(n) >= 0) return { ok: false, why: '已经有这个分类了' };
    root().shop.cats.push(n);
    persist();
    return { ok: true, name: n };
  }
  function delCat(name) {
    if (isBuiltinCat(name)) return { ok: false, why: '内置的四类不能删（可以不用它）' };
    var s = root(), i = s.shop.cats.indexOf(name), moved = 0;
    items().forEach(function (it) { if (it.cat === name) { it.cat = CATS[0]; moved++; } });
    if (i >= 0) s.shop.cats.splice(i, 1);
    if (mnState.cat === name) mnState.cat = '全部';
    persist();
    return { ok: true, moved: moved };
  }
  function delItem(id) {
    var s = root(), before = s.shop.items.length;
    s.shop.items = s.shop.items.filter(function (x) { return String(x.id) !== String(id); });
    if (s.shop.items.length === before) return { ok: false, why: '没有这件商品' };
    persist();
    return { ok: true };
  }

  /* 相册图：居中裁正方形 → 压到 96×96 → 优先 PNG，太大退 JPEG */
  function readIconFile(file, cb) {
    if (!file) { cb(null, '还没选文件'); return; }
    if (!/^image\//.test(String(file.type || '')) && !/\.(png|jpe?g|webp|gif)$/i.test(String(file.name || ''))) {
      cb(null, '这个不是图片文件'); return;
    }
    var rd = new FileReader();
    rd.onload = function () {
      var img = new Image();
      img.onload = function () {
        try {
          var S = 96, cv = document.createElement('canvas');
          cv.width = S; cv.height = S;
          var cx = cv.getContext('2d');
          var m = Math.min(img.width || S, img.height || S);
          cx.drawImage(img, ((img.width || S) - m) / 2, ((img.height || S) - m) / 2, m, m, 0, 0, S, S);
          var url = '';
          try { url = cv.toDataURL('image/png'); } catch (e1) { url = ''; }
          if (!url || url.length > 220000) {
            try { url = cv.toDataURL('image/jpeg', 0.8); } catch (e2) { url = ''; }
          }
          if (!url) { cb(null, '这张图压不出来，换一张试试'); return; }
          if (url.length > 400000) { cb(null, '这张图太大了（' + Math.round(url.length / 1024) + ' KB），换一张小一点的'); return; }
          cb(url, '');
        } catch (e) { cb(null, '这张图读不出来'); }
      };
      img.onerror = function () { cb(null, '这张图读不出来'); };
      img.src = String(rd.result || '');
    };
    rd.onerror = function () { cb(null, '这个文件读不出来'); };
    try { rd.readAsDataURL(file); } catch (e) { cb(null, '这个文件读不出来'); }
  }

  function svgOf(key, size) {
    var body = ICO[key] || ICO.box;
    return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) + '" fill="none" '
      + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + body + '</svg>';
  }

  /* 商品图标：有相册图就用图，没有就用内置那套手绘 SVG */
  function icoHTML(it, size) {
    var n = size || 20;
    if (it && it.icoImg) {
      return '<img class="mn-goods-img" src="' + esc(it.icoImg) + '" alt="" width="' + n + '" height="' + n + '">';
    }
    return svgOf(it && it.ico, n);
  }

  function items() { return root().shop.items; }
  function itemOf(id) {
    var l = items();
    for (var i = 0; i < l.length; i++) if (String(l[i].id) === String(id)) return l[i];
    return null;
  }

  /* ============ 3. 联系人 ============ */

  function soloContacts() {
    try { return (data.contacts || []).filter(function (c) { return c && c.id && c.kind !== 'group'; }); } catch (e) { return []; }
  }
  function allContacts() {
    try { return (data.contacts || []).filter(function (c) { return c && c.id; }); } catch (e) { return []; }
  }
  function nameOf(cid) {
    try { if (typeof chatPartnerNameOf === 'function') { var n = chatPartnerNameOf(cid); if (n) return n; } } catch (e) {}
    var cs = allContacts();
    for (var i = 0; i < cs.length; i++) if (cs[i].id === cid) return cs[i].name || '';
    return '';
  }
  function memberOf(gid, name) {
    var cs = allContacts();
    for (var i = 0; i < cs.length; i++) if (cs[i].kind !== 'group' && cs[i].name === name) return cs[i];
    return null;
  }

  /* ============ 4. 字卡库抽一句（沿用站内规则） ============ */

  function pickLine(cid) {
    try {
      if (typeof window.__vidDebug === 'object' && window.__vidDebug && typeof window.__vidDebug.pickLine === 'function') {
        var t = window.__vidDebug.pickLine(cid);
        if (t) return t;
      }
    } catch (e) {}
    var pool = [];
    try {
      var gs = (data && data.groups) || [];
      var nm = '';
      var c = allContacts().filter(function (x) { return x.id === cid; })[0];
      if (c && c.kind === 'group' && (c.members || []).length) nm = c.members[Math.floor(Math.random() * c.members.length)];
      else nm = nameOf(cid);
      for (var i = 0; i < gs.length; i++) {
        var g = gs[i];
        if (!g || !Array.isArray(g.cards) || g.off) continue;
        var cat = g.category || '主字卡';
        if (cat !== '主字卡' && cat !== 'TA心里话') continue;
        if (typeof groupUsableFor === 'function' && !groupUsableFor(g, cid, nm)) continue;
        for (var j = 0; j < g.cards.length; j++) {
          var t2 = '';
          try { t2 = (typeof cardText === 'function') ? cardText(g.cards[j]) : ''; } catch (e2) { t2 = ''; }
          if (!t2 && typeof g.cards[j] === 'string') t2 = g.cards[j];
          t2 = String(t2 || '').trim();
          if (t2 && t2.length <= 120) pool.push(t2);
        }
      }
    } catch (e3) {}
    if (!pool.length) return '';
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ============ 5. 投消息 ============ */

  function sayTo(cid, text, extra) {
    try {
      if (typeof _deliverToChat !== 'function' || typeof nextId !== 'function') return false;
      var msg = { id: nextId(), from: 'partner', text: String(text), unread: true, src: 'money' };
      var c = allContacts().filter(function (x) { return x.id === cid; })[0];
      if (c && c.kind === 'group' && extra && extra.sender) msg.sender = extra.sender;
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k) && k !== 'sender') msg[k] = extra[k];
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
  function saySys(cid, text, extra) {
    try {
      if (typeof _deliverToChat !== 'function' || typeof nextId !== 'function') return false;
      var msg = { id: nextId(), from: 'system', text: String(text) };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
      _deliverToChat(msg, cid);
      return true;
    } catch (e) { return false; }
  }

  /* ============ 6. 转账 ============ */

  var PAY_HEAD = '转账 ';

  function payText(cents, note) {
    return PAY_HEAD + fen2yuan(cents) + (note ? ('\n' + note) : '');
  }
  function isPayText(t) {
    return /^转账\s*￥\s*\d[\d,]*(\.\d{1,2})?/.test(String(t || '').trim());
  }
  function payAmountOf(t) {
    var m = /^转账\s*￥\s*([\d,]+(?:\.\d{1,2})?)/.exec(String(t || '').trim());
    if (!m) return NaN;
    return yuan2fen(m[1]);
  }

  /* 随机金额：偏向小额，偶尔蹦一个有意义的数；上限＝付款方余额 */
  function rollAmount(balance) {
    var cap = Math.round(Number(balance) || 0);
    var mx = Math.round(Number(prefs().maxTransfer) || 0);
    if (mx > 0) cap = Math.min(cap, mx * 100);        // 你在账户页设的单笔上限
    if (cap < MIN_CENT) return 0;
    var specials = [520, 1314, 5200, 6600, 8800, 999, 1314, 2520];
    var r = Math.random();
    var cents;
    if (r < 0.18) cents = specials[Math.floor(Math.random() * specials.length)];
    else if (r < 0.72) cents = 500 + Math.floor(Math.random() * 8300);        // ￥5 – ￥88
    else cents = 8800 + Math.floor(Math.random() * 20000);                    // ￥88 – ￥288
    var balance = cap;
    cents = Math.min(cents, cap);
    cents = Math.max(MIN_CENT, Math.round(cents / 100) * 100);
    return cents > balance ? 0 : cents;
  }

  /* from: '__me__' 或 联系人id；to 同理 */
  function doTransfer(from, to, cents, note, quiet) {
    cents = Math.round(Number(cents) || 0);
    if (cents < MIN_CENT) return { ok: false, why: '金额太小（最少 ￥1）' };
    if (balanceOf(from) < cents) return { ok: false, why: '余额不够（现有 ' + fen2yuan(balanceOf(from)) + '）' };
    if (!debit(from, cents, 'transfer', note || '')) return { ok: false, why: '扣款没成功' };
    credit(to, cents, 'transfer', note || '');
    var s = root();
    s.stats.transfers = (s.stats.transfers || 0) + 1;
    var fromMe = from === '__me__';
    var chatCid = fromMe ? to : from;              // 落在对方那个会话里
    var line = fromMe ? '' : pickLine(from);
    // 留言优先用你手填的；TA 转账时没填就带一句从他字卡库抽的话
    var text = payText(cents, note || (fromMe ? '' : line));
    var sender = null;
    var c = allContacts().filter(function (x) { return x.id === chatCid; })[0];
    if (c && c.kind === 'group' && !fromMe) {
      var mem = allContacts().filter(function (x) { return x.id === from; })[0];
      sender = (mem && mem.name) || '';
    }
    var okMsg = fromMe ? sayMe(chatCid, text) : sayTo(chatCid, text, { pay: cents, sender: sender || undefined });
    persist();
    if (!quiet) toast((fromMe ? '转出去 ' : '收到 ') + fen2yuan(cents));
    return { ok: true, cents: cents, msg: okMsg, text: text };
  }

  /* 梦角主动转账（内置节奏，无设置项） */
  function maybeTransfer() {
    try {
      if (isNight() || document.hidden) return null;
      if (Math.random() * 100 >= prefs().pTransfer) return null;
      var cs = soloContacts();
      if (!cs.length) return null;
      var pool = cs.filter(function (c) { return balanceOf(c.id) >= MIN_CENT; });
      if (!pool.length) return null;
      var who = pool[Math.floor(Math.random() * pool.length)];
      var cents = rollAmount(balanceOf(who.id));
      if (!cents) return null;
      var r = doTransfer(who.id, '__me__', cents, '', true);
      if (r.ok) logAct('转账', nameOf(who.id) + ' 转给你 ' + fen2yuan(cents));
      return r.ok ? { cid: who.id, cents: cents } : null;
    } catch (e) { return null; }
  }

  /* ============ 7. 充值申请 ============ */

  function taAskTopUp(cid, cents) {
    var s = root();
    var id = nid('p');
    s.pending.push({ id: id, cid: cid, cents: cents, at: Date.now(), state: 'wait' });
    persist();
    saySys(cid, nameOf(cid) + ' 申请充值 ' + fen2yuan(cents) + ' · 点这条去账户页批一下', { payAsk: id });
    logAct('申请', nameOf(cid) + ' 申请充值 ' + fen2yuan(cents));
    return id;
  }

  /* 梦角自己往账户充钱：金额随机，直接到账，不需要你批 */
  function maybeTopUp() {
    try {
      if (isNight() || document.hidden) return null;
      if (Math.random() * 100 >= prefs().pTopUp) return null;
      var cs = soloContacts();
      if (!cs.length) return null;
      var who = cs[Math.floor(Math.random() * cs.length)];
      var cents = rollTopUp();
      credit(who.id, cents, 'topup', '他自己充的');
      root().stats.toppedUp = (root().stats.toppedUp || 0) + 1;
      persist();
      saySys(who.id, nameOf(who.id) + ' 给自己账户充了 ' + fen2yuan(cents)
        + ' · 现在余额 ' + fen2yuan(balanceOf(who.id)), { payTop: cents });
      logAct('充值', nameOf(who.id) + ' 自己充了 ' + fen2yuan(cents));
      return { cid: who.id, cents: cents };
    } catch (e) { return null; }
  }

  /* 旧版本留下的待批申请：一次性全部自动到账，之后不再有审批这回事 */
  function migratePending() {
    try {
      var s = root();
      if (!Array.isArray(s.pending) || !s.pending.length) return 0;
      var n = 0;
      s.pending.forEach(function (p) {
        if (p && p.state === 'wait' && Math.round(Number(p.cents) || 0) >= MIN_CENT) {
          credit(p.cid, Math.round(Number(p.cents)), 'topup', '旧申请自动到账');
          n++;
        }
      });
      s.pending = [];
      persist();
      if (n) logAct('迁移', '把旧版 ' + n + ' 条待批申请直接到账了');
      return n;
    } catch (e) { return 0; }
  }

  function settlePending(id, yes) {
    var s = root();
    var p = null;
    for (var i = 0; i < s.pending.length; i++) if (String(s.pending[i].id) === String(id)) { p = s.pending[i]; break; }
    if (!p || p.state !== 'wait') return { ok: false, why: '这条申请不在了' };
    p.state = yes ? 'ok' : 'no';
    p.at2 = Date.now();
    if (yes) {
      credit(p.cid, p.cents, 'topup', '你批准的充值');
      s.stats.toppedUp = (s.stats.toppedUp || 0) + 1;
      sayTo(p.cid, '到账了，' + fen2yuan(p.cents) + '。' + (pickLine(p.cid) || '谢谢你'));
      logAct('批准', nameOf(p.cid) + ' 充值 ' + fen2yuan(p.cents) + ' 已到账');
    } else {
      sayTo(p.cid, '这次先不充了。' + (pickLine(p.cid) || ''));
      logAct('驳回', nameOf(p.cid) + ' 的 ' + fen2yuan(p.cents) + ' 申请被驳回');
    }
    persist();
    return { ok: true, cents: p.cents, cid: p.cid };
  }

  function topUpMe(cents) {
    cents = Math.round(Number(cents) || 0);
    if (cents < MIN_CENT) return { ok: false, why: '金额太小（最少 ￥1）' };
    credit('__me__', cents, 'topup', '你自己充的');
    root().stats.toppedUp = (root().stats.toppedUp || 0) + 1;
    persist();
    logAct('充值', '你充值 ' + fen2yuan(cents));
    return { ok: true, cents: cents };
  }

  /* ============ 8. 商城 ============ */

  function buy(itemId, toCid, opts) {
    opts = opts || {};
    var it = itemOf(itemId);
    if (!it) return { ok: false, why: '没有这件商品' };
    if (!toCid) return { ok: false, why: '还没选送给谁' };
    var from = opts.fromMe === false ? (opts.fromCid || '') : '__me__';
    if (!from) return { ok: false, why: '没指定是谁买' };
    if (balanceOf(from) < it.cents) return { ok: false, why: '余额不够（' + fen2yuan(balanceOf(from)) + ' < ' + fen2yuan(it.cents) + '）' };
    if (!debit(from, it.cents, 'gift', it.name)) return { ok: false, why: '扣款没成功' };
    var s = root();
    var order = {
      id: nid('o'), itemId: it.id, name: it.name, cat: it.cat, cents: it.cents, ico: it.ico,
      icoImg: it.icoImg || '',
      from: from, to: opts.fromMe === false ? '__me__' : toCid,
      at: Date.now(), when: opts.when || '', note: opts.note || '', letter: !!opts.letter
    };
    s.shop.orders.unshift(order);
    if (s.shop.orders.length > 300) s.shop.orders.length = 300;
    s.stats.gifts = (s.stats.gifts || 0) + 1;
    persist();
    if (opts.when) {
      scheduleGift(order);
      logAct('定时', fen2yuan(it.cents) + ' 的「' + it.name + '」定在 ' + opts.when + ' 送出');
    } else {
      deliverGift(order);
    }
    return { ok: true, order: order };
  }

  function deliverGift(order) {
    if (!order || order.done) return false;
    var toName = order.to === '__me__' ? '你' : nameOf(order.to);
    var fromName = order.from === '__me__' ? '你' : nameOf(order.from);
    var chatCid = order.to === '__me__' ? order.from : order.to;
    var text = fromName + ' 送给 ' + toName + '：' + order.name
      + '（' + fen2yuan(order.cents) + '）'
      + (order.note ? ('\n留言：' + order.note) : '');
    var line = order.from === '__me__' ? '' : pickLine(order.from);
    if (line) text += '\n' + line;
    if (order.from === '__me__') sayMe(chatCid, text); else sayTo(chatCid, text, { gift: order.id });
    order.done = true;
    order.doneAt = Date.now();
    if (order.letter) writeGiftLetter(order);
    persist();
    logAct('送出', fromName + ' → ' + toName + '：' + order.name);
    return true;
  }

  function scheduleGift(order) {
    try {
      if (!siteReady() || !data.calendar || !Array.isArray(data.calendar.events)) return false;
      var parts = String(order.when).split(/[ T]+/);
      var d = parts[0] || '', t = parts[1] || '';
      data.calendar.events.push({
        id: nid('g'), title: '送出「' + order.name + '」给 ' + (order.to === '__me__' ? '你' : nameOf(order.to)),
        date: d, type: 'once', repeat: 'none', time: t, who: order.to === '__me__' ? '' : order.to,
        note: '商城定时礼物 · 到点在商城页点「送出」', giftOrder: order.id
      });
      if (typeof save === 'function') save();
      return true;
    } catch (e) { return false; }
  }

  /* 'YYYY-MM-DD HH:MM' → 本地毫秒；解析不出来返回 0（绝不用 Date.parse 的时区歧义） */
  function parseWhen(w) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(w || '').trim());
    if (!m) return 0;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), 0);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  /* 到点提醒：每次打开商城页时检查有没有该送了的定时礼物 */
  function flushDueGifts() {
    var s = root(), n = 0, now = Date.now();
    (s.shop.orders || []).forEach(function (o) {
      if (!o || o.done || !o.when) return;
      var t = parseWhen(o.when);
      if (!t) return;
      if (t <= now) { deliverGift(o); n++; }
    });
    if (n) { persist(); toast('有 ' + n + ' 件定时礼物到点送出了'); }
    return n;
  }

  /* 2A：不改信件编辑器，直接按站内字段生成一封信 */
  function writeGiftLetter(order) {
    try {
      if (!siteReady()) return false;
      var toName = order.to === '__me__' ? '你' : nameOf(order.to);
      var fromName = order.from === '__me__' ? '我' : nameOf(order.from);
      var body = '随信附上一件小东西：' + order.name + '。\n'
        + (order.note ? ('想说的话：' + order.note + '\n') : '')
        + '—— ' + fromName + ' 给 ' + toName;
      var tm = (typeof time === 'function') ? time() : new Date().toLocaleTimeString('zh-CN');
      var pmk = (typeof formatPostmarkDate === 'function') ? formatPostmarkDate() : ymdLocal(new Date());
      if (order.from === '__me__') {
        if (!Array.isArray(data.sentLetters)) data.sentLetters = [];
        data.sentLetters.push({ text: body, time: tm, postmark: pmk, charCount: body.length, cid: order.to, img: '' });
      } else {
        if (!Array.isArray(data.receivedLetters)) data.receivedLetters = [];
        var lid = (typeof mbLetterId === 'function') ? mbLetterId() : nid('L');
        var L = { lid: lid, text: body, time: tm, postmark: pmk, charCount: body.length, read: false, cid: order.from, kind: 'proactive', reason: '随礼物附上一封信', img: '' };
        data.receivedLetters.push(L);
        try { if (typeof _mbLand === 'function') _mbLand(L); } catch (e) {}
        try { if (typeof renderMailbox === 'function') renderMailbox(); } catch (e2) {}
      }
      if (typeof save === 'function') save();
      return true;
    } catch (e) { return false; }
  }

  /* 梦角自己买一件送你（扣他余额） */
  function maybeGift() {
    try {
      if (isNight() || document.hidden) return null;
      if (Math.random() * 100 >= prefs().pGift) return null;
      var cs = soloContacts().filter(function (c) { return balanceOf(c.id) >= 1000; });
      if (!cs.length) return null;
      var who = cs[Math.floor(Math.random() * cs.length)];
      var bal = balanceOf(who.id);
      var afford = items().filter(function (it) { return it.cents <= bal; });
      if (!afford.length) return null;
      var it = afford[Math.floor(Math.random() * afford.length)];
      var r = buy(it.id, '__me__', { fromMe: false, fromCid: who.id, letter: Math.random() * 100 < prefs().pLetter });
      if (r.ok) logAct('收到', nameOf(who.id) + ' 送你「' + it.name + '」');
      return r.ok ? { cid: who.id, item: it.name } : null;
    } catch (e) { return null; }
  }

  /* ============ 9. 动态日志（面板里给你看最近发生了什么） ============ */

  var mnLog = [];
  function logAct(kind, text) {
    mnLog.push({ at: Date.now(), kind: kind, text: text });
    if (mnLog.length > 60) mnLog.shift();
    renderFeed();
  }

  /* ============ 10. 转账卡片升级（保留 .bubble 外壳，所以气泡色仍跟随全局） ============ */

  function payCardHTML(text) {
    var t = String(text || '').trim();
    var m = /^转账\s*￥\s*([\d,]+(?:\.\d{1,2})?)/.exec(t);
    if (!m) return '';
    var rest = t.slice(m[0].length).replace(/^[\s:：]+/, '').replace(/^[\r\n]+/, '').trim();
    return '<span class="mn-pay-ico">' + svgOf('box', 20) + '</span>'
      + '<span class="mn-pay-tx"><b>转账 ' + esc(m[1].indexOf('.') >= 0 ? m[1] : m[1] + '.00') + '</b>'
      + '<small>' + esc(rest || '转账给你 · 点开账户页看余额') + '</small></span>';
  }

  function upgradeBubbles(scope) {
    try {
      var list = scope || document.getElementById('messageList');
      if (!list || !list.querySelectorAll) return 0;
      var bs = list.querySelectorAll('.bubble');
      var n = 0;
      for (var i = 0; i < bs.length; i++) {
        var b = bs[i];
        if (b.getAttribute('data-mn-up') === '1') continue;
        if (b.querySelector && b.querySelector('.mn-pay-ico')) { b.setAttribute('data-mn-up', '1'); continue; }
        var txt = (b.textContent || '').trim();
        if (!isPayText(txt)) continue;
        var html = payCardHTML(txt);
        if (!html) continue;
        b.setAttribute('data-mn-up', '1');
        b.classList.add('mn-pay');
        b.innerHTML = html;
        n++;
      }
      return n;
    } catch (e) { return 0; }
  }

  var mnMo = null, mnRaf = 0;
  function startWatcher() {
    try {
      var list = document.getElementById('messageList');
      if (!list || mnMo) return;
      mnMo = new MutationObserver(function () {
        if (mnRaf) return;
        mnRaf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
          mnRaf = 0;
          upgradeBubbles();
        });
      });
      mnMo.observe(list, { childList: true, subtree: true, characterData: true });
      upgradeBubbles(list);
    } catch (e) {}
  }

  /* ============ 11. 图标 ============ */

  var WALLET_ICO = '<rect x="2.8" y="5.6" width="18.4" height="13.4" rx="3.2"/>'
    + '<path d="M2.8 10h18.4"/>'
    + '<circle cx="16.8" cy="14.4" r="1.15" fill="currentColor" stroke="none"/>'
    + '<path d="M6.6 5.6V4.2a1.4 1.4 0 0 1 1.4-1.4h7.4"/>';
  var SHOP_ICO = '<path d="M4 8.4h16v11.2a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 19.6z"/>'
    + '<path d="M8.6 8.4V6a3.4 3.4 0 0 1 6.8 0v2.4"/>'
    + '<path d="M9.4 13.2h5.2"/>';

  /* ============ 12. 样式 ============ */

  var CSS = [
    '.bubble.mn-pay{display:flex !important;align-items:center;gap:10px;min-width:186px;text-align:left}',
    '.mn-pay-ico{flex:none;width:34px;height:34px;border-radius:11px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.07)}',
    '.mn-pay-tx{flex:1 1 auto;min-width:0}',
    '.mn-pay-tx b{display:block;font-size:15px;font-weight:600;letter-spacing:.3px;line-height:1.35}',
    '.mn-pay-tx small{display:block;font-size:11px;opacity:.72;margin-top:3px;line-height:1.6}',
    '#walletView,#shopView{padding-bottom:96px}',
    '.mn-bal{margin:12px 0;padding:14px;border-radius:16px;background:rgba(0,0,0,.04)}',
    '.mn-bal small{display:block;font-size:11px;color:var(--muted,#6b6a67);letter-spacing:.6px}',
    '.mn-bal b{display:block;font-size:27px;font-weight:600;letter-spacing:.5px;margin-top:5px;font-variant-numeric:tabular-nums;color:var(--ink,#1c1917)}',
    '.mn-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:rgba(0,0,0,.028);margin-bottom:7px;width:100%;border:0;font:inherit;color:inherit;text-align:left}',
    '.mn-row-ico{flex:none;width:34px;height:34px;border-radius:11px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.05);color:var(--ink,#1c1917)}',
    '.mn-row-tx{flex:1 1 auto;min-width:0}',
    '.mn-row-tx b{display:block;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink,#1c1917)}',
    '.mn-row-tx small{display:block;font-size:11px;color:var(--muted,#6b6a67);margin-top:3px;line-height:1.6}',
    '.mn-row-n{flex:none;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink,#1c1917)}',
    '.mn-row-n.in{color:#2f7a52}',
    '.mn-row-n.out{color:#a8506b}',
    '.mn-btns{display:flex;gap:7px;margin:0 0 10px}',
    '.mn-btn{flex:1 1 auto;min-height:38px;padding:0 11px;display:flex;align-items:center;justify-content:center;gap:5px;border:1px solid rgba(0,0,0,.14);border-radius:12px;background:#fff;color:var(--ink,#1c1917);font:inherit;font-size:12.5px;white-space:nowrap}',
    '.mn-btn:active{opacity:.6}',
    '.mn-cats{position:relative;z-index:8;display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;padding:3px 1px 10px;margin:6px 0 12px;-webkit-overflow-scrolling:touch;scrollbar-width:none}',
    '.mn-cats::-webkit-scrollbar{display:none;height:0}',
    '.mn-cats .mn-chip{flex:none;position:relative;z-index:8;box-shadow:0 1px 0 rgba(0,0,0,.04)}',
    '.mn-quick{flex:none;min-width:42px;padding:3px 7px;border:1px solid rgba(0,0,0,.1);border-radius:8px;background:rgba(0,0,0,.028);color:var(--muted,#6b6a67);font:inherit;font-size:11px;line-height:1.5;text-align:center;font-variant-numeric:tabular-nums}',
    '.mn-quick[aria-pressed=true]{background:var(--ink,#1c1917);border-color:var(--ink,#1c1917);color:#fff}',
    '.mn-tune{margin:0 0 10px;padding:11px 12px;border-radius:14px;background:rgba(0,0,0,.035)}',
    '.mn-tune-row{display:flex;align-items:center;gap:9px;padding:7px 0 0}',
    '.mn-tune-row>span{flex:none;width:94px;font-size:11.5px;color:var(--muted,#6b6a67)}',
    '.mn-tune-row input[type=range]{flex:1 1 auto;min-width:0;margin:0;accent-color:#1c1917}',
    '.mn-tune-row output{flex:none;width:64px;text-align:right;font-size:11.5px;color:var(--ink,#1c1917);font-variant-numeric:tabular-nums}',
    '.mn-tune-ft{display:flex;gap:7px;margin-top:11px}',
    '.mn-tune-ft .mn-btn{min-height:34px;font-size:11.5px}',
    '.mn-ico-pv{flex:none;width:42px;height:42px;border-radius:12px;background:rgba(0,0,0,.045);overflow:hidden;display:flex;align-items:center;justify-content:center}',
    '.mn-ico-pv img{width:100%;height:100%;object-fit:cover;display:block}',
    '.mn-ico-pv:empty::after{content:"没选图";font-size:10px;color:var(--muted,#6b6a67)}',
    '.mn-goods-img{border-radius:9px;object-fit:cover;display:block}',
    '.mn-chip{flex:none;padding:7px 12px;border:1px solid rgba(0,0,0,.14);border-radius:999px;background:#fff;color:var(--muted,#6b6a67);font:inherit;font-size:12px;white-space:nowrap}',
    '.mn-chip[aria-pressed=true]{background:var(--ink,#1c1917);border-color:var(--ink,#1c1917);color:#fff}',
    '.mn-grid{position:relative;z-index:1;display:grid;grid-template-columns:repeat(2,1fr);gap:8px}',
    '.mn-goods{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:11px;border:1px solid rgba(0,0,0,.09);border-radius:15px;background:#fff;font:inherit;color:inherit;text-align:left}',
    '.mn-goods:active{opacity:.65}',
    '.mn-goods-ico{width:36px;height:36px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.045);color:var(--ink,#1c1917)}',
    '.mn-goods b{display:block;font-size:12.5px;font-weight:600;color:var(--ink,#1c1917);line-height:1.4}',
    '.mn-goods small{display:block;font-size:10.5px;color:var(--muted,#6b6a67);line-height:1.6;margin-top:2px}',
    '.mn-goods i{display:block;font-style:normal;font-size:12.5px;font-weight:600;color:var(--ink,#1c1917);margin-top:4px;font-variant-numeric:tabular-nums}',
    '.mn-frm{display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid rgba(0,0,0,.06)}',
    '.mn-frm>span{flex:none;width:78px;font-size:12.5px;color:var(--muted,#6b6a67)}',
    '.mn-frm input[type=text],.mn-frm input[type=number],.mn-frm input[type=date],.mn-frm input[type=time],.mn-frm textarea{flex:1 1 auto;min-width:0;padding:9px 10px;border:1px solid rgba(0,0,0,.14);border-radius:11px;background:#fff;color:var(--ink,#1c1917);font:inherit;font-size:13px}',
    '.mn-frm textarea{min-height:58px;resize:vertical;line-height:1.6}',
    '.mn-chips{display:flex;gap:6px;flex-wrap:wrap;flex:1 1 auto}',
    '.mn-acts{display:flex;gap:8px;margin-top:15px}',
    '.mn-acts .soft-btn{flex:1 1 auto;min-height:42px}',
    '.mn-note{font-size:11.5px;line-height:1.75;color:var(--muted,#6b6a67);margin:10px 0 0}',
    '.mn-feed{margin:0 0 10px;padding:10px 12px;border-radius:14px;background:rgba(0,0,0,.035);font-size:11.5px;line-height:1.85;color:var(--muted,#6b6a67)}',
    '.mn-feed:empty::after{content:"还没有动静"}',
    '.mn-feed div b{color:var(--ink,#1c1917);font-weight:600;margin-right:5px}',
    '.mn-pend{border:1px solid rgba(168,80,107,.3);background:rgba(168,80,107,.06)}',
    '.mn-pend-btns{flex:none;display:flex;gap:6px}'
  ].join('\n');

  function injectStyle() {
    if (qs('#mnStyle')) return;
    var s = document.createElement('style');
    s.id = 'mnStyle';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ============ 13. 视图 ============ */

  var WALLET_HTML = ''
    + '<div class="home-greet"><div>'
    + '  <div class="g-eyebrow">WALLET</div><div class="g-hi">账户</div>'
    + '  <div class="g-sub" id="mnSub"></div>'
    + '</div></div>'
    + '<div class="mn-bal"><small>我的余额</small><b id="mnMyBal">￥0.00</b></div>'
    + '<div class="mn-btns">'
    + '  <button type="button" class="mn-btn" id="mnTopMe">＋ 我充值</button>'
    + '  <button type="button" class="mn-btn" id="mnSendBtn">转账给 TA</button>'
    + '</div>'
    + '<div class="mn-feed" id="mnFeed"></div>'
    + '<div class="sec-label">TA 的主动 · 概率与节奏 <i>AUTO</i></div>'
    + '<div class="mn-tune" id="mnTune">'
    + '  <div class="mn-tune-row"><span>主动转账</span><input type="range" id="mnPTransfer" min="0" max="100" step="1" aria-label="主动转账概率"><output id="mnPTransferOut"></output></div>'
    + '  <div class="mn-tune-row"><span>主动送礼</span><input type="range" id="mnPGift" min="0" max="100" step="1" aria-label="主动送礼概率"><output id="mnPGiftOut"></output></div>'
    + '  <div class="mn-tune-row"><span>他自己充值</span><input type="range" id="mnPTopUp" min="0" max="100" step="1" aria-label="他自己充值概率"><output id="mnPTopUpOut"></output></div>'
    + '  <div class="mn-tune-row"><span>送礼附信</span><input type="range" id="mnPLetter" min="0" max="100" step="1" aria-label="送礼时附一封信的概率"><output id="mnPLetterOut"></output></div>'
    + '  <div class="mn-tune-row"><span>多久掷一次</span><input type="range" id="mnPTick" min="5" max="180" step="5" aria-label="多少分钟掷一次"><output id="mnPTickOut"></output></div>'
    + '  <div class="mn-tune-row"><span>单笔转账上限</span><input type="range" id="mnPMax" min="0" max="1000" step="10" aria-label="单笔转账上限"><output id="mnPMaxOut"></output></div>'
    + '  <div class="mn-tune-row"><span>他自充上限</span><input type="range" id="mnPTopMax" min="100" max="50000" step="100" aria-label="他自己充值的单笔上限"><output id="mnPTopMaxOut"></output></div>'
    + '  <div class="mn-tune-row"><span>夜里不打扰</span><div class="mn-chips" id="mnPNight">'
    + '    <button type="button" class="mn-chip" data-v="on" aria-pressed="true">01:00–07:00 静默</button>'
    + '    <button type="button" class="mn-chip" data-v="off" aria-pressed="false">不用</button>'
    + '  </div></div>'
    + '  <div class="mn-tune-ft">'
    + '    <button type="button" class="mn-btn" id="mnPFire">让他们现在动一下</button>'
    + '    <button type="button" class="mn-btn" id="mnPReset">恢复默认</button>'
    + '  </div>'
    + '  <p class="mn-note">概率＝每到「多久掷一次」那个点，每人各掷一次，中了才动。转账金额是随机的，「单笔转账上限」能卡住最大值（拉到 0＝不限）。他自己充值也是<b>随机掷一个数</b>：18% 概率蹦一个有意义的数（520 / 1314 / 8888 之类），其余在 ￥10 到「他自充上限」之间按对数均匀分布——小额多、大额偶尔来一次，最后取整到 10 元；<b>直接到账不用你批</b>。「夜里不打扰」的时间窗是<b>凌晨 01:00 到 07:00</b>，跟站内免打扰对齐。这些数只存在你这台设备上。</p>'
    + '</div>'
    + '<div class="sec-label">每个人的账户 <i>WALLETS</i></div>'
    + '<div id="mnPeople"></div>'
    + '<div class="sec-label">我的流水 <i>LEDGER</i></div>'
    + '<div id="mnLedger"></div>';

  var SHOP_HTML = ''
    + '<div class="home-greet"><div>'
    + '  <div class="g-eyebrow">SHOP</div><div class="g-hi">商城</div>'
    + '  <div class="g-sub" id="mnShopSub"></div>'
    + '</div></div>'
    + '<div class="sec-label">分类 <i>CATEGORY</i></div>'
    + '<div class="mn-cats" id="mnCats"></div>'
    + '<div class="mn-grid" id="mnGoods"></div>'
    + '<div class="sec-label">送出记录 <i>ORDERS</i></div>'
    + '<div id="mnOrders"></div>'
    + '<div class="mn-btns" style="margin-top:12px">'
    + '  <button type="button" class="mn-btn" id="mnAddItem">＋ 自己加一件商品</button>'
    + '  <button type="button" class="mn-btn" id="mnCatMgr">分类与自建商品</button>'
    + '</div>';

  var SHEETS = ''
    + '<div class="fs-sheet-mask fs-sheet-full" id="mnSendMask" hidden><div class="fs-sheet">'
    + '  <div class="fs-sheet-bar"><div class="fs-sheet-t"><span class="fs-sheet-ti">转账</span><span class="fs-sheet-en">TRANSFER</span></div>'
    + '  <button type="button" class="fs-sheet-close" id="mnSendClose" aria-label="关闭">×</button></div>'
    + '  <div class="fs-sheet-body">'
    + '    <div class="mn-frm"><span>转给谁</span><div class="mn-chips" id="mnSendWho"></div></div>'
    + '    <div class="mn-frm"><span>金额</span><input type="number" id="mnSendAmt" min="1" step="1" inputmode="decimal" placeholder="元"></div>'
    + '    <div class="mn-frm"><span>留言</span><input type="text" id="mnSendNote" maxlength="40" placeholder="选填"></div>'
    + '    <p class="mn-note">从你的余额里扣，转进对方账户；对方会话里会出现一条转账气泡（底色跟随你的全局气泡设置）。余额不够会直接拒绝，不会透支。</p>'
    + '    <div class="mn-acts"><button type="button" class="soft-btn" id="mnSendRand">随机一个数</button><button type="button" class="soft-btn" id="mnSendGo">转出去</button></div>'
    + '  </div></div></div>'

    + '<div class="fs-sheet-mask fs-sheet-full" id="mnTopMask" hidden><div class="fs-sheet">'
    + '  <div class="fs-sheet-bar"><div class="fs-sheet-t"><span class="fs-sheet-ti">我充值</span><span class="fs-sheet-en">TOP UP</span></div>'
    + '  <button type="button" class="fs-sheet-close" id="mnTopClose" aria-label="关闭">×</button></div>'
    + '  <div class="fs-sheet-body">'
    + '    <div class="mn-frm"><span>金额</span><input type="number" id="mnTopAmt" min="1" step="1" inputmode="decimal" placeholder="元"></div>'
    + '    <div class="mn-chips" id="mnTopQuick" style="margin:10px 0 0;gap:6px">'
    + '      <button type="button" class="mn-quick" data-amt="50">￥50</button>'
    + '      <button type="button" class="mn-quick" data-amt="100">￥100</button>'
    + '      <button type="button" class="mn-quick" data-amt="200">￥200</button>'
    + '      <button type="button" class="mn-quick" data-amt="520">￥520</button>'
    + '      <button type="button" class="mn-quick" data-amt="1314">￥1314</button>'
    + '      <button type="button" class="mn-quick" data-amt="5200">￥5200</button>'
    + '    </div>'
    + '    <p class="mn-note">这里的钱是站内虚拟的，只存在你这台设备上，不连任何真实支付。梦角那边同理会自己申请充值，你批了才到账。</p>'
    + '    <div class="mn-acts"><button type="button" class="soft-btn" id="mnTopGo">充进我的账户</button></div>'
    + '  </div></div></div>'

    + '<div class="fs-sheet-mask fs-sheet-full" id="mnBuyMask" hidden><div class="fs-sheet">'
    + '  <div class="fs-sheet-bar"><div class="fs-sheet-t"><span class="fs-sheet-ti" id="mnBuyTi">买下来送出去</span><span class="fs-sheet-en">GIFT</span></div>'
    + '  <button type="button" class="fs-sheet-close" id="mnBuyClose" aria-label="关闭">×</button></div>'
    + '  <div class="fs-sheet-body">'
    + '    <div id="mnBuyHead"></div>'
    + '    <div class="mn-frm"><span>送给谁</span><div class="mn-chips" id="mnBuyWho"></div></div>'
    + '    <div class="mn-frm"><span>什么时候</span><div class="mn-chips" id="mnBuyWhen">'
    + '      <button type="button" class="mn-chip" data-v="now" aria-pressed="true">立刻送</button>'
    + '      <button type="button" class="mn-chip" data-v="at" aria-pressed="false">定时送</button>'
    + '    </div></div>'
    + '    <div class="mn-frm" id="mnBuyDateRow" hidden><span>日期</span><input type="date" id="mnBuyDate"></div>'
    + '    <div class="mn-frm" id="mnBuyTimeRow" hidden><span>几点</span><input type="time" id="mnBuyTime"></div>'
    + '    <div class="mn-frm"><span>留言</span><input type="text" id="mnBuyNote" maxlength="40" placeholder="选填"></div>'
    + '    <div class="mn-frm"><span>附一封信</span><div class="mn-chips" id="mnBuyLetter">'
    + '      <button type="button" class="mn-chip" data-v="no" aria-pressed="true">不用</button>'
    + '      <button type="button" class="mn-chip" data-v="yes" aria-pressed="false">要，随礼物寄一封信</button>'
    + '    </div></div>'
    + '    <p class="mn-note">定时送会同时写进「日历」，那天格子上会多一枚标记；到点后再打开商城页就会自动送出。「附一封信」是按站内信件的字段直接生成一封信投进信箱，不改动写信页。</p>'
    + '    <div class="mn-acts"><button type="button" class="soft-btn" id="mnBuyGo">买下并送出</button></div>'
    + '  </div></div></div>'

    + '<div class="fs-sheet-mask fs-sheet-full" id="mnItemMask" hidden><div class="fs-sheet">'
    + '  <div class="fs-sheet-bar"><div class="fs-sheet-t"><span class="fs-sheet-ti">加一件商品</span><span class="fs-sheet-en">ITEM</span></div>'
    + '  <button type="button" class="fs-sheet-close" id="mnItemClose" aria-label="关闭">×</button></div>'
    + '  <div class="fs-sheet-body">'
    + '    <div class="mn-frm"><span>叫什么</span><input type="text" id="mnItName" maxlength="20" placeholder="例如：一盏小夜灯"></div>'
    + '    <div class="mn-frm"><span>价格</span><input type="number" id="mnItPrice" min="1" step="1" inputmode="decimal" placeholder="元"></div>'
    + '    <div class="mn-frm"><span>分类</span><div class="mn-chips" id="mnItCat"></div></div>'
    + '    <div class="mn-frm"><span>说明</span><input type="text" id="mnItNote" maxlength="40" placeholder="选填"></div>'
    + '    <div class="mn-frm"><span>图标来源</span><div class="mn-chips" id="mnItIcoMode">'
    + '      <button type="button" class="mn-chip" data-v="album" aria-pressed="true">从相册导入</button>'
    + '      <button type="button" class="mn-chip" data-v="built" aria-pressed="false">用内置图标</button>'
    + '    </div></div>'
    + '    <div class="mn-frm" id="mnItAlbumRow"><span>选图</span><div class="mn-chips" style="align-items:center">'
    + '      <button type="button" class="mn-chip" id="mnItPick">从相册挑一张</button>'
    + '      <span class="mn-ico-pv" id="mnItPv"></span>'
    + '    </div></div>'
    + '    <div class="mn-frm" id="mnItIcoRow" hidden><span>内置图标</span><div class="mn-chips" id="mnItIco"></div></div>'
    + '    <p class="mn-note">相册里的图会居中裁成正方形、压到 96×96 再存，只存在你这台设备上（会跟着「导出全部数据」一起备份）。内置那套是 24×24 线性描边、跟站内其他图标一致，没有 emoji。</p>'
    + '    <div class="mn-acts"><button type="button" class="soft-btn" id="mnItGo">加进商城</button></div>'
    + '  </div></div></div>'

    + '<div class="fs-sheet-mask fs-sheet-full" id="mnCatMask" hidden><div class="fs-sheet">'
    + '  <div class="fs-sheet-bar"><div class="fs-sheet-t"><span class="fs-sheet-ti">分类与自建商品</span><span class="fs-sheet-en">MANAGE</span></div>'
    + '  <button type="button" class="fs-sheet-close" id="mnCatClose" aria-label="关闭">×</button></div>'
    + '  <div class="fs-sheet-body">'
    + '    <div class="mn-frm"><span>新建分类</span><input type="text" id="mnCatName" maxlength="8" placeholder="最多 8 个字，例如：小零食"></div>'
    + '    <div class="mn-acts"><button type="button" class="soft-btn" id="mnCatAdd">建这个分类</button></div>'
    + '    <div class="sec-label" style="margin-top:16px">现有分类 <i>CATEGORIES</i></div>'
    + '    <div id="mnCatList"></div>'
    + '    <div class="sec-label" style="margin-top:16px">自建商品 <i>YOUR ITEMS</i></div>'
    + '    <div id="mnMyItems"></div>'
    + '    <p class="mn-note">内置的四类（日用品 · 增强连接 · 出行 · 情侣礼物）不能删，但可以不用。删掉一个自建分类时，里面的商品会被挪到「日用品」，不会丢。删商品只影响商城，已经送出去的那条消息和那封信不动。</p>'
    + '  </div></div></div>';

  var mnState = { cat: '全部', buyItem: '', sendTo: '', buyTo: '', itCat: '日用品', itIco: 'box', itIcoMode: 'album', itImg: '' };

  function injectDom() {
    var shell = qs('.app-shell') || document.body;
    [['walletView', WALLET_HTML], ['shopView', SHOP_HTML]].forEach(function (pair) {
      if (qs('#' + pair[0])) return;
      var sec = document.createElement('section');
      sec.className = 'view';
      sec.id = pair[0];
      sec.innerHTML = pair[1];
      var more = qs('#moreView');
      if (more && more.parentNode === shell) shell.insertBefore(sec, more);
      else shell.appendChild(sec);
    });
    if (!qs('#mnSendMask')) document.body.insertAdjacentHTML('beforeend', SHEETS + '<input type="file" id="mnItFile" accept="image/*" hidden>');
    bindAll();
  }

  /* ============ 14. 渲染 ============ */

  var PREF_LIM = {
    pTransfer: [0, 100], pGift: [0, 100], pTopUp: [0, 100], pLetter: [0, 100],
    tickMin: [5, 180], maxTransfer: [0, 100000], topUpMax: [10, 100000]
  };

  function setPref(key, val) {
    var pf = prefs();
    if (key === 'nightOff') {
      var sv = String(val == null ? '' : val).trim();
      if (sv !== 'on' && sv !== 'off') return false;
      pf.nightOff = sv === 'on';
      persist(); renderPrefs(); return true;
    }
    var str = String(val == null ? '' : val).trim();
    if (str === '') return false;                       // 空值一律拒绝，不把已存的数静默清零
    var n = Number(str);
    if (!isFinite(n)) return false;
    var lim = PREF_LIM[key];
    if (!lim) return false;
    pf[key] = Math.min(lim[1], Math.max(lim[0], Math.round(n)));
    persist();
    renderPrefs();
    return true;
  }

  function renderPrefs() {
    var pf = prefs();
    [['#mnPTransfer', '#mnPTransferOut', pf.pTransfer, '%'],
      ['#mnPGift', '#mnPGiftOut', pf.pGift, '%'],
      ['#mnPTopUp', '#mnPTopUpOut', pf.pTopUp, '%'],
      ['#mnPLetter', '#mnPLetterOut', pf.pLetter, '%'],
      ['#mnPTick', '#mnPTickOut', pf.tickMin, ' 分钟'],
      ['#mnPMax', '#mnPMaxOut', pf.maxTransfer, ''],
      ['#mnPTopMax', '#mnPTopMaxOut', pf.topUpMax, '']].forEach(function (r) {
      var el = qs(r[0]), out = qs(r[1]);
      if (el) el.value = r[2];
      if (out) {
        if (r[0] === '#mnPMax') out.textContent = r[2] ? ('￥' + r[2]) : '不限';
        else if (r[0] === '#mnPTopMax') out.textContent = '￥' + r[2];
        else out.textContent = r[2] + r[3];
      }
    });
    qsa('#mnPNight .mn-chip').forEach(function (b) {
      b.setAttribute('aria-pressed', (b.dataset.v === 'on') === !!pf.nightOff ? 'true' : 'false');
    });
  }

  /* 手动触发一轮：不看概率、不看夜间，充值 + 转账 + 送礼各来一次（用来验证设置有没有生效） */
  function fireOnce() {
    var cs = soloContacts();
    if (!cs.length) { toast('还没有联系人'); return null; }
    var res = { topup: null, transfer: null, gift: null };
    var who = cs[Math.floor(Math.random() * cs.length)];
    var cents = rollTopUp();
    credit(who.id, cents, 'topup', '手动触发');
    root().stats.toppedUp = (root().stats.toppedUp || 0) + 1;
    saySys(who.id, nameOf(who.id) + ' 给自己账户充了 ' + fen2yuan(cents) + ' · 现在余额 ' + fen2yuan(balanceOf(who.id)), { payTop: cents });
    res.topup = { cid: who.id, cents: cents };
    logAct('充值', nameOf(who.id) + ' 自己充了 ' + fen2yuan(cents) + '（手动触发）');
    var amt = rollAmount(balanceOf(who.id));
    if (amt) {
      var r = doTransfer(who.id, '__me__', amt, '', true);
      if (r.ok) { res.transfer = { cid: who.id, cents: amt }; logAct('转账', nameOf(who.id) + ' 转给你 ' + fen2yuan(amt) + '（手动触发）'); }
    }
    var bal = balanceOf(who.id);
    var afford = items().filter(function (it) { return it.cents <= bal; });
    if (afford.length) {
      var it = afford[Math.floor(Math.random() * afford.length)];
      var b = buy(it.id, '__me__', { fromMe: false, fromCid: who.id, letter: Math.random() * 100 < prefs().pLetter });
      if (b.ok) { res.gift = { cid: who.id, item: it.name }; logAct('收到', nameOf(who.id) + ' 送你「' + it.name + '」（手动触发）'); }
    }
    persist();
    renderWallet();
    renderShop();
    var n = (res.topup ? 1 : 0) + (res.transfer ? 1 : 0) + (res.gift ? 1 : 0);
    toast('触发了一轮：' + n + ' 件事，去 ' + (nameOf(who.id) || 'TA') + ' 的聊天页看');
    return res;
  }

  function renderWallet() {
    var s = root();
    var b = qs('#mnMyBal');
    if (b) b.textContent = fen2yuan(s.me.balance);
    var sub = qs('#mnSub');
    var cs = soloContacts();
    var total = 0;
    cs.forEach(function (c) { total += balanceOf(c.id); });
    if (sub) sub.textContent = cs.length + ' 位 · 他们手上一共 ' + fen2yuan(total)
      + ' · 转账 ' + (s.stats.transfers || 0) + ' 笔 · 送礼 ' + (s.stats.gifts || 0) + ' 件';

    renderPrefs();

    var ppl = qs('#mnPeople');
    if (ppl) {
      ppl.innerHTML = cs.length ? cs.map(function (c) {
        return '<button type="button" class="mn-row" data-person="' + esc(c.id) + '">'
          + '<span class="mn-row-ico">' + svgOf('box', 19) + '</span>'
          + '<span class="mn-row-tx"><b>' + esc(c.name || '(未命名)') + '</b><small>'
          + ((c.kind === 'group' ? '群聊' : '单聊') + ' · 最近 ' + (walletOf(c.id).log.length ? stamp(walletOf(c.id).log[0].at) : '没有记录'))
          + '</small></span><span class="mn-row-n">' + fen2yuan(balanceOf(c.id)) + '</span></button>';
      }).join('') : '<div class="mn-note" style="text-align:center;padding:12px 0">还没有联系人</div>';
    }

    var led = qs('#mnLedger');
    if (led) {
      var lg = (s.me.log || []).slice(0, 20);
      led.innerHTML = lg.length ? lg.map(function (e) {
        return '<div class="mn-row"><span class="mn-row-ico">' + svgOf(e.dir === 'in' ? 'note' : 'box', 18) + '</span>'
          + '<span class="mn-row-tx"><b>' + esc(kindLabel(e.kind)) + (e.note ? (' · ' + esc(e.note)) : '') + '</b><small>'
          + stamp(e.at) + '</small></span>'
          + '<span class="mn-row-n ' + (e.dir === 'in' ? 'in' : 'out') + '">'
          + (e.dir === 'in' ? '+' : '−') + fen2yuan(e.cents) + '</span></div>';
      }).join('') : '<div class="mn-note" style="text-align:center;padding:12px 0">还没有流水</div>';
    }
    renderFeed();
  }

  function kindLabel(k) {
    return { transfer: '转账', topup: '充值', gift: '买礼物' }[k] || '记录';
  }

  function renderFeed() {
    var box = qs('#mnFeed');
    if (!box) return;
    box.innerHTML = mnLog.slice(-6).reverse().map(function (l) {
      return '<div><b>' + stamp(l.at) + ' ' + esc(l.kind) + '</b>' + esc(l.text) + '</div>';
    }).join('');
  }

  function renderShop() {
    var s = root();
    var cats = ['全部'].concat(allCats());
    var cb = qs('#mnCats');
    if (cb) cb.innerHTML = cats.map(function (c) {
      var n = c === '全部' ? items().length : catCount(c);
      return '<button type="button" class="mn-chip" data-cat="' + esc(c) + '" aria-pressed="'
        + (mnState.cat === c ? 'true' : 'false') + '">' + esc(c) + ' ' + n + '</button>';
    }).join('') + '<button type="button" class="mn-chip" data-cat="__new__">＋ 新分类</button>';
    var gb = qs('#mnGoods');
    if (gb) {
      var list = items().filter(function (it) { return mnState.cat === '全部' || it.cat === mnState.cat; });
      gb.innerHTML = list.length ? list.map(function (it) {
        return '<button type="button" class="mn-goods" data-item="' + esc(it.id) + '">'
          + '<span class="mn-goods-ico">' + icoHTML(it, 21) + '</span>'
          + '<span><b>' + esc(it.name) + '</b><small>' + esc(it.cat) + (it.note ? (' · ' + esc(it.note)) : '') + '</small>'
          + '<i>' + fen2yuan(it.cents) + '</i></span></button>';
      }).join('') : '<div class="mn-note">这一类还没有商品</div>';
    }
    var ob = qs('#mnOrders');
    if (ob) {
      var os = (s.shop.orders || []).slice(0, 15);
      ob.innerHTML = os.length ? os.map(function (o) {
        var who = o.from === '__me__' ? ('你 → ' + (nameOf(o.to) || 'TA')) : ((nameOf(o.from) || 'TA') + ' → 你');
        return '<div class="mn-row"><span class="mn-row-ico">' + icoHTML(o, 19) + '</span>'
          + '<span class="mn-row-tx"><b>' + esc(o.name) + '</b><small>' + esc(who) + ' · '
          + (o.done ? (stamp(o.doneAt || o.at) + ' 已送出') : ('定时 ' + esc(o.when) + ' · 还没送'))
          + (o.letter ? ' · 附了一封信' : '') + '</small></span>'
          + '<span class="mn-row-n out">' + fen2yuan(o.cents) + '</span></div>';
      }).join('') : '<div class="mn-note" style="text-align:center;padding:12px 0">还没有送出记录</div>';
    }
    var sub = qs('#mnShopSub');
    if (sub) sub.textContent = items().length + ' 件商品 · ' + (allCats().length) + ' 个分类 · 我的余额 ' + fen2yuan(s.me.balance);
    flushDueGifts();
  }

  function renderWho(boxId, picked) {
    var box = qs('#' + boxId);
    if (!box) return;
    var cs = allContacts();
    box.innerHTML = cs.map(function (c) {
      return '<button type="button" class="mn-chip" data-cid="' + esc(c.id) + '" aria-pressed="'
        + (picked === c.id ? 'true' : 'false') + '">' + esc(c.name || '(未命名)')
        + (c.kind === 'group' ? ' · 群' : '') + '</button>';
    }).join('') || '<span class="mn-note" style="margin:0">还没有联系人</span>';
  }

  /* ============ 15. 交互 ============ */

  function openSheet(id) { var m = qs('#' + id); if (m) m.hidden = false; }
  function closeSheet(id) { var m = qs('#' + id); if (m) m.hidden = true; }
  function chipVal(w, d) { var o = qs('#' + w + ' .mn-chip[aria-pressed=true]'); return o ? (o.dataset.v || o.dataset.amt || o.dataset.cid) : d; }
  function chipSet(w, v) {
    qsa('#' + w + ' .mn-chip').forEach(function (b) {
      b.setAttribute('aria-pressed', (b.dataset.v || b.dataset.amt || b.dataset.cid) === v ? 'true' : 'false');
    });
  }

  function openSend() {
    var cs = allContacts();
    if (!mnState.sendTo && cs.length) mnState.sendTo = cs[0].id;
    renderWho('mnSendWho', mnState.sendTo);
    var a = qs('#mnSendAmt'); if (a && !a.value) a.value = '';
    var n = qs('#mnSendNote'); if (n) n.value = '';
    openSheet('mnSendMask');
  }
  function openTop() { var a = qs('#mnTopAmt'); if (a) a.value = ''; openSheet('mnTopMask'); }
  function openBuy(id) {
    var it = itemOf(id);
    if (!it) return;
    mnState.buyItem = id;
    var cs = allContacts();
    if (!mnState.buyTo && cs.length) mnState.buyTo = cs[0].id;
    renderWho('mnBuyWho', mnState.buyTo);
    var h = qs('#mnBuyHead');
    if (h) h.innerHTML = '<div class="mn-row" style="margin-bottom:12px"><span class="mn-row-ico">' + icoHTML(it, 20)
      + '</span><span class="mn-row-tx"><b>' + esc(it.name) + '</b><small>' + esc(it.cat)
      + (it.note ? (' · ' + esc(it.note)) : '') + '</small></span><span class="mn-row-n">' + fen2yuan(it.cents) + '</span></div>';
    var ti = qs('#mnBuyTi'); if (ti) ti.textContent = '买「' + it.name + '」送出去';
    chipSet('mnBuyWhen', 'now');
    chipSet('mnBuyLetter', 'no');
    var dr = qs('#mnBuyDateRow'), tr = qs('#mnBuyTimeRow');
    if (dr) dr.hidden = true;
    if (tr) tr.hidden = true;
    var dv = qs('#mnBuyDate'); if (dv && !dv.value) dv.value = ymdLocal(new Date());
    var tv = qs('#mnBuyTime'); if (tv && !tv.value) tv.value = '20:00';
    openSheet('mnBuyMask');
  }
  function renderItCats() {
    var cb = qs('#mnItCat');
    if (!cb) return;
    cb.innerHTML = allCats().map(function (c) {
      return '<button type="button" class="mn-chip" data-v="' + esc(c) + '" aria-pressed="'
        + (mnState.itCat === c ? 'true' : 'false') + '">' + esc(c) + '</button>';
    }).join('') + '<button type="button" class="mn-chip" data-v="__new__">＋ 新分类</button>';
  }

  function renderItIco() {
    var ib = qs('#mnItIco');
    if (ib) ib.innerHTML = Object.keys(ICO).map(function (k) {
      return '<button type="button" class="mn-chip" data-v="' + k + '" aria-pressed="' + (mnState.itIco === k ? 'true' : 'false')
        + '" style="padding:6px;width:38px;display:flex;justify-content:center">' + svgOf(k, 18) + '</button>';
    }).join('');
    var ar = qs('#mnItAlbumRow'), ir = qs('#mnItIcoRow');
    if (ar) ar.hidden = mnState.itIcoMode !== 'album';
    if (ir) ir.hidden = mnState.itIcoMode !== 'built';
    var pv = qs('#mnItPv');
    if (pv) pv.innerHTML = mnState.itImg ? ('<img src="' + esc(mnState.itImg) + '" alt="图标预览">') : '';
    qsa('#mnItIcoMode .mn-chip').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.v === mnState.itIcoMode ? 'true' : 'false');
    });
  }

  function openItem() {
    ['mnItName', 'mnItPrice', 'mnItNote'].forEach(function (id) { var el = qs('#' + id); if (el) el.value = ''; });
    mnState.itImg = '';
    if (allCats().indexOf(mnState.itCat) < 0) mnState.itCat = CATS[0];
    renderItCats();
    renderItIco();
    openSheet('mnItemMask');
  }

  function renderCatMgr() {
    var box = qs('#mnCatList');
    if (box) {
      box.innerHTML = allCats().map(function (c) {
        return '<div class="mn-row"><span class="mn-row-ico">' + svgOf('box', 18) + '</span>'
          + '<span class="mn-row-tx"><b>' + esc(c) + '</b><small>'
          + (isBuiltinCat(c) ? '内置 · 不能删' : '自建') + ' · ' + catCount(c) + ' 件商品</small></span>'
          + (isBuiltinCat(c) ? '' : '<span class="mn-pend-btns"><button type="button" class="mn-chip" data-delcat="' + esc(c) + '">删</button></span>')
          + '</div>';
      }).join('');
    }
    var mb = qs('#mnMyItems');
    if (mb) {
      var mine = items().filter(function (it) { return it.custom; });
      mb.innerHTML = mine.length ? mine.map(function (it) {
        return '<div class="mn-row"><span class="mn-row-ico">' + icoHTML(it, 19) + '</span>'
          + '<span class="mn-row-tx"><b>' + esc(it.name) + '</b><small>' + esc(it.cat) + ' · '
          + (it.icoImg ? '相册图' : '内置图标') + (it.note ? (' · ' + esc(it.note)) : '') + '</small></span>'
          + '<span class="mn-row-n">' + fen2yuan(it.cents) + '</span>'
          + '<span class="mn-pend-btns"><button type="button" class="mn-chip" data-delitem="' + esc(it.id) + '">删</button></span></div>';
      }).join('') : '<div class="mn-note" style="text-align:center;padding:12px 0">还没有自建商品</div>';
    }
  }
  function openCatMgr() { renderCatMgr(); openSheet('mnCatMask'); }

  function askNewCat(after) {
    var run = function (v) {
      var r = addCat(v);
      if (!r.ok) { toast(r.why); return; }
      if (after) after(r.name);
      else toast('分类建好了：' + r.name);
    };
    try {
      if (typeof window.openModal === 'function') {
        window.openModal('新建分类', '', function (v) { run(v); },
          { staticText: '给这个分类起个名字（最多 8 个字），建好之后在「自己加一件商品」里就能选它。', okText: '建' });
        return;
      }
    } catch (e) {}
    var v = window.prompt('新分类叫什么（最多 8 个字）？');
    if (v != null) run(v);
  }

  function bindAll() {
    var a = qs('#mnTopMe'); if (a) a.addEventListener('click', openTop);
    var b = qs('#mnSendBtn'); if (b) b.addEventListener('click', openSend);
    var c = qs('#mnAddItem'); if (c) c.addEventListener('click', openItem);
    ['mnSendClose', 'mnTopClose', 'mnBuyClose', 'mnItemClose'].forEach(function (id) {
      var el = qs('#' + id);
      if (el) el.addEventListener('click', function () { closeSheet(id.replace('Close', 'Mask')); });
    });

    [[ 'mnPTransfer', 'pTransfer' ], [ 'mnPGift', 'pGift' ], [ 'mnPTopUp', 'pTopUp' ],
      [ 'mnPLetter', 'pLetter' ], [ 'mnPTick', 'tickMin' ], [ 'mnPMax', 'maxTransfer' ],
      [ 'mnPTopMax', 'topUpMax' ]].forEach(function (pair) {
      var el = qs('#' + pair[0]);
      if (!el) return;
      var go = function () { setPref(pair[1], el.value); };
      el.addEventListener('input', go);
      el.addEventListener('change', go);
    });
    var pn = qs('#mnPNight');
    if (pn) pn.addEventListener('click', function (e) {
      var ch = e.target.closest ? e.target.closest('.mn-chip[data-v]') : null;
      if (ch) setPref('nightOff', ch.dataset.v);
    });
    var pfire = qs('#mnPFire');
    if (pfire) pfire.addEventListener('click', function () { fireOnce(); });
    var preset = qs('#mnPReset');
    if (preset) preset.addEventListener('click', function () {
      Object.keys(PREFS_DEF).forEach(function (k) {
        var pf = prefs();
        pf[k] = (typeof PREFS_DEF[k] === 'boolean') ? PREFS_DEF[k] : PREFS_DEF[k];
      });
      persist(); renderPrefs();
      toast('已恢复默认：转账 6% · 送礼 5% · 自充 8% · 附信 30% · 每 30 分钟 · 转账不限额 · 自充上限 ￥5000 · 凌晨 1–7 点静默');
    });

    var cm = qs('#mnCatMgr');
    if (cm) cm.addEventListener('click', openCatMgr);
    var cc = qs('#mnCatClose');
    if (cc) cc.addEventListener('click', function () { closeSheet('mnCatMask'); });
    var ca = qs('#mnCatAdd');
    if (ca) ca.addEventListener('click', function () {
      var el = qs('#mnCatName');
      var r = addCat((el && el.value) || '');
      if (!r.ok) { toast(r.why); return; }
      if (el) el.value = '';
      renderCatMgr(); renderShop();
      toast('分类建好了：' + r.name);
    });
    var cl = qs('#mnCatList');
    if (cl) cl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-delcat]') : null;
      if (!b) return;
      var name = b.dataset.delcat;
      var run = function () {
        var r = delCat(name);
        if (!r.ok) { toast(r.why); return; }
        renderCatMgr(); renderShop();
        toast(r.moved ? ('删掉了，里面 ' + r.moved + ' 件商品挪进了「日用品」') : '删掉了');
      };
      var msg = '删掉分类「' + name + '」？里面的商品不会丢，会被挪到「日用品」。';
      try {
        if (typeof window.openModal === 'function') {
          window.openModal('删掉分类', '', function () { run(); }, { noInput: true, staticText: msg, okText: '删掉', danger: true });
          return;
        }
      } catch (e2) {}
      if (window.confirm(msg)) run();
    });
    var mi = qs('#mnMyItems');
    if (mi) mi.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-delitem]') : null;
      if (!b) return;
      var it = itemOf(b.dataset.delitem);
      var run = function () {
        var r = delItem(b.dataset.delitem);
        if (!r.ok) { toast(r.why); return; }
        renderCatMgr(); renderShop();
        toast('删掉了');
      };
      var msg = '从商城删掉「' + ((it && it.name) || '这件') + '」？已经送出去的消息和信不会动。';
      try {
        if (typeof window.openModal === 'function') {
          window.openModal('删掉商品', '', function () { run(); }, { noInput: true, staticText: msg, okText: '删掉', danger: true });
          return;
        }
      } catch (e3) {}
      if (window.confirm(msg)) run();
    });

    var im = qs('#mnItIcoMode');
    if (im) im.addEventListener('click', function (e) {
      var ch = e.target.closest ? e.target.closest('.mn-chip[data-v]') : null;
      if (!ch) return;
      mnState.itIcoMode = ch.dataset.v;
      renderItIco();
    });
    var ip = qs('#mnItPick'), iff = qs('#mnItFile');
    if (ip && iff) {
      ip.addEventListener('click', function () { iff.value = ''; iff.click(); });
      iff.addEventListener('change', function () {
        var f = iff.files && iff.files[0];
        if (!f) return;
        readIconFile(f, function (url, err) {
          if (err) { toast(err); return; }
          mnState.itImg = url;
          renderItIco();
          toast('图标选好了');
        });
      });
    }
    var itc = qs('#mnItCat');
    if (itc) itc.addEventListener('click', function (e) {
      var ch = e.target.closest ? e.target.closest('.mn-chip[data-v]') : null;
      if (!ch) return;
      if (ch.dataset.v === '__new__') {
        askNewCat(function (nm) { mnState.itCat = nm; renderItCats(); renderShop(); toast('分类建好了：' + nm); });
        return;
      }
      mnState.itCat = ch.dataset.v;
      renderItCats();
    });

    var pp = qs('#mnPeople');
    if (pp) pp.addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('[data-person]') : null;
      if (!row) return;
      var cid = row.dataset.person;
      var w = walletOf(cid);
      var lines = (w.log || []).slice(0, 12).map(function (en) {
        return stamp(en.at) + ' ' + (en.dir === 'in' ? '+' : '−') + fen2yuan(en.cents) + ' ' + kindLabel(en.kind) + (en.note ? (' · ' + en.note) : '');
      }).join('\n') || '还没有记录';
      try {
        if (typeof window.openModal === 'function') {
          window.openModal((nameOf(cid) || 'TA') + ' 的账户', '', null,
            { noInput: true, staticText: '余额 ' + fen2yuan(w.balance) + '\n\n' + lines, okText: '知道了' });
          return;
        }
      } catch (e2) {}
      window.alert('余额 ' + fen2yuan(w.balance) + '\n\n' + lines);
    });

    var cats = qs('#mnCats');
    if (cats) cats.addEventListener('click', function (e) {
      var ch = e.target.closest ? e.target.closest('.mn-chip[data-cat]') : null;
      if (!ch) return;
      if (ch.dataset.cat === '__new__') { askNewCat(function () { renderShop(); }); return; }
      mnState.cat = ch.dataset.cat;
      renderShop();
    });

    var gd = qs('#mnGoods');
    if (gd) gd.addEventListener('click', function (e) {
      var g = e.target.closest ? e.target.closest('[data-item]') : null;
      if (!g) return;
      openBuy(g.dataset.item);
    });

    var sw = qs('#mnSendWho');
    if (sw) sw.addEventListener('click', function (e) {
      var ch = e.target.closest ? e.target.closest('.mn-chip[data-cid]') : null;
      if (!ch) return;
      mnState.sendTo = ch.dataset.cid;
      chipSet('mnSendWho', mnState.sendTo);
    });
    var bw = qs('#mnBuyWho');
    if (bw) bw.addEventListener('click', function (e) {
      var ch = e.target.closest ? e.target.closest('.mn-chip[data-cid]') : null;
      if (!ch) return;
      mnState.buyTo = ch.dataset.cid;
      chipSet('mnBuyWho', mnState.buyTo);
    });

    var sr = qs('#mnSendRand');
    if (sr) sr.addEventListener('click', function () {
      var cents = rollAmount(balanceOf('__me__'));
      var el = qs('#mnSendAmt');
      if (!cents) { toast('你的余额不够 ￥1，先充值'); return; }
      if (el) el.value = (cents / 100).toFixed(2);
    });

    var sg = qs('#mnSendGo');
    if (sg) sg.addEventListener('click', function () {
      if (!mnState.sendTo) { toast('先选转给谁'); return; }
      var cents = yuan2fen((qs('#mnSendAmt') || {}).value);
      if (!isFinite(cents) || cents <= 0) { toast('金额没填对'); return; }
      var note = ((qs('#mnSendNote') || {}).value || '').trim();
      var r = doTransfer('__me__', mnState.sendTo, cents, note);
      if (!r.ok) { toast('没转出去：' + r.why); return; }
      closeSheet('mnSendMask');
      renderWallet();
      logAct('转账', '你转给 ' + (nameOf(mnState.sendTo) || 'TA') + ' ' + fen2yuan(cents));
    });

    var tq = qs('#mnTopQuick');
    if (tq) tq.addEventListener('click', function (e) {
      var ch = e.target.closest ? e.target.closest('.mn-chip[data-amt]') : null;
      if (!ch) return;
      var el = qs('#mnTopAmt');
      if (el) el.value = ch.dataset.amt;
    });
    var tg = qs('#mnTopGo');
    if (tg) tg.addEventListener('click', function () {
      var cents = yuan2fen((qs('#mnTopAmt') || {}).value);
      if (!isFinite(cents) || cents <= 0) { toast('金额没填对'); return; }
      var msg = '给你自己的账户充 ' + fen2yuan(cents) + '？这是站内虚拟的钱，不连任何真实支付。';
      var run = function () {
        var r = topUpMe(cents);
        if (!r.ok) { toast(r.why); return; }
        closeSheet('mnTopMask');
        renderWallet();
        toast('已到账 ' + fen2yuan(cents));
      };
      try {
        if (typeof window.openModal === 'function') {
          window.openModal('我充值', '', function () { run(); }, { noInput: true, staticText: msg, okText: '充值' });
          return;
        }
      } catch (e) {}
      if (window.confirm(msg)) run();
    });

    var bwn = qs('#mnBuyWhen');
    if (bwn) bwn.addEventListener('click', function (e) {
      var ch = e.target.closest ? e.target.closest('.mn-chip[data-v]') : null;
      if (!ch) return;
      chipSet('mnBuyWhen', ch.dataset.v);
      var at = ch.dataset.v === 'at';
      var dr = qs('#mnBuyDateRow'), tr = qs('#mnBuyTimeRow');
      if (dr) dr.hidden = !at;
      if (tr) tr.hidden = !at;
    });
    var bl = qs('#mnBuyLetter');
    if (bl) bl.addEventListener('click', function (e) {
      var ch = e.target.closest ? e.target.closest('.mn-chip[data-v]') : null;
      if (ch) chipSet('mnBuyLetter', ch.dataset.v);
    });
    var bg = qs('#mnBuyGo');
    if (bg) bg.addEventListener('click', function () {
      if (!mnState.buyItem) return;
      if (!mnState.buyTo) { toast('先选送给谁'); return; }
      var when = '';
      if (chipVal('mnBuyWhen', 'now') === 'at') {
        var d = (qs('#mnBuyDate') || {}).value || '', t = (qs('#mnBuyTime') || {}).value || '';
        if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(d)) { toast('定时送就得填日期'); return; }
        when = d + ' ' + (t || '20:00');
      }
      var r = buy(mnState.buyItem, mnState.buyTo, {
        fromMe: true, when: when,
        note: ((qs('#mnBuyNote') || {}).value || '').trim(),
        letter: chipVal('mnBuyLetter', 'no') === 'yes'
      });
      if (!r.ok) { toast('没买成：' + r.why); return; }
      closeSheet('mnBuyMask');
      renderShop();
      renderWallet();
    });

    var ic = qs('#mnItCat');
    if (ic) ic.addEventListener('click', function (e) {
      var ch = e.target.closest ? e.target.closest('.mn-chip[data-v]') : null;
      if (!ch) return;
      mnState.itCat = ch.dataset.v;
      chipSet('mnItCat', mnState.itCat);
    });
    var ii = qs('#mnItIco');
    if (ii) ii.addEventListener('click', function (e) {
      var ch = e.target.closest ? e.target.closest('.mn-chip[data-v]') : null;
      if (!ch) return;
      mnState.itIco = ch.dataset.v;
      chipSet('mnItIco', mnState.itIco);
    });
    var ig = qs('#mnItGo');
    if (ig) ig.addEventListener('click', function () {
      var name = ((qs('#mnItName') || {}).value || '').trim();
      var cents = yuan2fen((qs('#mnItPrice') || {}).value);
      if (!name) { toast('先给它起个名'); return; }
      if (!isFinite(cents) || cents < 100) { toast('价格至少 ￥1'); return; }
      if (mnState.itIcoMode === 'album' && !mnState.itImg) { toast('选了「从相册导入」就得挑一张图，或者改用内置图标'); return; }
      items().unshift({
        id: nid('it'), name: name, cat: mnState.itCat, cents: cents,
        ico: mnState.itIco, icoImg: mnState.itIcoMode === 'album' ? mnState.itImg : '',
        note: ((qs('#mnItNote') || {}).value || '').trim(), custom: true
      });
      persist();
      closeSheet('mnItemMask');
      renderShop();
      toast('加进商城了：' + name);
    });

    ['mnSendMask', 'mnTopMask', 'mnBuyMask', 'mnItemMask', 'mnCatMask'].forEach(function (id) {
      var m = qs('#' + id);
      if (m) m.addEventListener('click', function (e) { if (e.target === m) m.hidden = true; });
    });
  }

  /* ============ 16. 路由与磁贴 ============ */

  function openView(which) {
    var id = which === 'shop' ? 'shopView' : 'walletView';
    var sec = qs('#' + id);
    if (!sec) { injectDom(); sec = qs('#' + id); }
    if (!sec) return;
    if (!siteReady()) { toast('站内数据还没载入完，稍等一下再点'); return; }
    var prev = document.body.dataset.view || '';
    qsa('.view').forEach(function (v) {
      v.classList.toggle('active', v.id === id);
      v.classList.remove('no-anim');
    });
    qsa('[data-view]').forEach(function (bt) {
      if (bt.id === 'backChatsBtn' || bt.id === 'topbarTitle') return;
      bt.classList.toggle('active', bt.dataset.view === which);
    });
    document.body.dataset.view = which;
    try {
      if (prev && prev !== which && typeof _navStack !== 'undefined' && _navStack && _navStack.push) _navStack.push(prev);
    } catch (e) {}
    try { if (typeof _setBackTarget === 'function') _setBackTarget(which); } catch (e) {}
    try { if (typeof updateTopbarTitle === 'function') updateTopbarTitle(which); } catch (e) {}
    var tt = qs('#topbarTitleText');
    if (tt) tt.textContent = which === 'shop' ? '商城' : '账户';
    if (which === 'shop') renderShop(); else renderWallet();
    startWatcher();
    try { sec.scrollTop = 0; } catch (e2) {}
  }

  function hookRouter() {
    try {
      if (typeof window.showView !== 'function' || window.showView.__mnWrapped) return;
      var orig = window.showView;
      var wrap = function (name) {
        if (name === 'wallet') { openView('wallet'); return; }
        if (name === 'shop') { openView('shop'); return; }
        return orig.apply(this, arguments);
      };
      wrap.__mnWrapped = 1;
      wrap.__bulkWrapped = orig.__bulkWrapped;
      wrap.__vidWrapped = orig.__vidWrapped;
      wrap.__calWrapped = orig.__calWrapped;
      window.showView = wrap;
    } catch (e) {}
  }

  function hookTiles() {
    try {
      if (typeof HUB_GROUPS === 'undefined' || !HUB_GROUPS || !HUB_GROUPS.length) return;
      var has = { wallet: false, shop: false };
      HUB_GROUPS.forEach(function (g) {
        (g.rows || []).forEach(function (r) { if (r && has.hasOwnProperty(r.nav)) has[r.nav] = true; });
      });
      var host = null;
      var want = ['记录', '陪伴', '玩'];
      for (var w = 0; w < want.length && !host; w++) {
        for (var i = 0; i < HUB_GROUPS.length; i++) if (HUB_GROUPS[i] && HUB_GROUPS[i].name === want[w]) { host = HUB_GROUPS[i]; break; }
      }
      if (!host) host = HUB_GROUPS[0];
      if (!host || !host.rows) return;
      var added = false;
      if (!has.wallet) {
        host.rows.push({
          ico: WALLET_ICO, name: '账户', nav: 'wallet',
          desc: '你和每位梦角各有一本账户：余额、流水、充值申请与批准、双向转账',
          more: { o: 8, d: '余额 · 转账 · 充值申请' }
        });
        added = true;
      }
      if (!has.shop) {
        host.rows.push({
          ico: SHOP_ICO, name: '商城', nav: 'shop',
          desc: '四类商品（日用品·增强连接·出行·情侣礼物），买来立刻送或定时送给梦角，可附一封信；梦角也会自己买一件送你',
          more: { o: 9, d: '买礼物 · 定时送 · 附信' }
        });
        added = true;
      }
      if (added && typeof renderMorePage === 'function') renderMorePage();
      hookMoreClicks();
      if (typeof renderHubPage === 'function' && (document.body.dataset.view === 'hub')) renderHubPage();
    } catch (e) {}
  }

  function hookMoreClicks() {
    try {
      var list = document.getElementById('moreList');
      if (!list) return;
      if (list.dataset.calBound === '1' || list.dataset.vidBound === '1' || list.dataset.bulkBound === '1' || list.dataset.mnBound === '1') return;
      list.dataset.mnBound = '1';
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

  /* ============ 17. 启动 ============ */

  var mnTimer = 0;
  function startTicks() {
    if (mnTimer) clearInterval(mnTimer);
    var last = 0;
    mnTimer = setInterval(function () {
      var now = Date.now();
      var every = Math.max(5, Math.min(180, Number(prefs().tickMin) || 30)) * 60000;
      if (now - last < every) return;
      last = now;
      maybeTransfer();
      maybeTopUp();
      maybeGift();
    }, TICK_MS);
  }

  function boot() {
    try { injectStyle(); injectDom(); hookRouter(); hookTiles(); hookMoreClicks(); startWatcher(); startTicks(); }
    catch (e) { try { console.warn('[账户与商城模块] 初始化失败', e); } catch (e2) {} }
  }

  boot();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); startWatcher(); });
  }
  try {
    document.addEventListener('ordinal-data-ready', function () {
      hookTiles();
      flushDueGifts();
      migratePending();
      try { renderWallet(); } catch (e) {}
    });
  } catch (e) {}

  try {
    window.__mnModuleReady = MN_VER;
    window.__mnDebug = {
      root: root, walletOf: walletOf, balanceOf: balanceOf, credit: credit, debit: debit,
      fen2yuan: fen2yuan, yuan2fen: yuan2fen, rollAmount: rollAmount, doTransfer: doTransfer,
      maybeTransfer: maybeTransfer, maybeGift: maybeGift,
      taAskTopUp: taAskTopUp, settlePending: settlePending, topUpMe: topUpMe,
      maybeTopUp: maybeTopUp, migratePending: migratePending, prefs: prefs, PREFS_DEF: PREFS_DEF,
      rollTopUp: rollTopUp, inHourWindow: inHourWindow, NIGHT_FROM: NIGHT_FROM, NIGHT_TO: NIGHT_TO,
      allCats: allCats, addCat: addCat, delCat: delCat, delItem: delItem, isBuiltinCat: isBuiltinCat,
      catCount: catCount, icoHTML: icoHTML, readIconFile: readIconFile, setPref: setPref,
      renderPrefs: renderPrefs, fireOnce: fireOnce, isNight: isNight,
      buy: buy, deliverGift: deliverGift, flushDueGifts: flushDueGifts, writeGiftLetter: writeGiftLetter,
      items: items, itemOf: itemOf, SHOP_SEED: SHOP_SEED, ICO: ICO, svgOf: svgOf,
      payText: payText, isPayText: isPayText, payAmountOf: payAmountOf, payCardHTML: payCardHTML, parseWhen: parseWhen,
      upgradeBubbles: upgradeBubbles, pickLine: pickLine, nameOf: nameOf, logAct: logAct,
      feed: function () { return mnLog; }
    };
    window.__mnSelfTest = function () {
      var out = { 模块版本: MN_VER, 站点data就绪: siteReady() };
      try {
        out.我的余额 = fen2yuan(root().me.balance);
        out.联系人数 = allContacts().length;
        out.商品件数 = items().length;
        out.待批申请 = root().pending.filter(function (p) { return p.state === 'wait'; }).length + '（已停用，仅显示遗留）';
        var pf = prefs();
        out.TA的主动 = '转账 ' + pf.pTransfer + '% · 送礼 ' + pf.pGift + '% · 自充 ' + pf.pTopUp
          + '% · 附信 ' + pf.pLetter + '% · 每 ' + pf.tickMin + ' 分钟'
          + (pf.maxTransfer ? (' · 转账上限 ￥' + pf.maxTransfer) : ' · 转账不限额')
          + ' · 自充上限 ￥' + pf.topUpMax + (pf.nightOff ? ' · 01:00–07:00 静默' : '');
        out.分类 = allCats().join(' / ');
        out.送出记录 = root().shop.orders.length;
      } catch (e) { out.数据层 = '失败 ' + e; }
      try { out.转账文案识别 = isPayText(payText(5200, '测试')) ? '正常' : '异常'; } catch (e2) {}
      try { out.卡片可生成 = payCardHTML(payText(5200, '给你的')) ? '是' : '否'; } catch (e3) {}
      try { out.气泡监听 = !!mnMo; } catch (e4) {}
      try { out.视图已注入 = !!document.getElementById('walletView') && !!document.getElementById('shopView'); } catch (e5) {}
      try { out.路由已接管 = !!(window.showView && window.showView.__mnWrapped); } catch (e6) {}
      try {
        out.磁贴 = (typeof HUB_GROUPS !== 'undefined') ? HUB_GROUPS.reduce(function (a, g) {
          (g.rows || []).forEach(function (r) { if (r && (r.nav === 'wallet' || r.nav === 'shop')) a.push(r.name); });
          return a;
        }, []).join('/') : '（无）';
      } catch (e7) {}
      try { if (console.table) console.table(out); else console.log(out); } catch (e8) {}
      return out;
    };
  } catch (e) {}
})();
