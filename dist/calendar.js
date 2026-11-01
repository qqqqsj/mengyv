/* 言字卡 · 日历模块 v1.0.0 —— 独立文件，不修改 app.v22.2.1.js
 *
 * 安装：本文件放进 dist/ ，然后在 index.html 里
 *       <script defer src="dist/app.v22.2.1.js"></script>
 *       这一行的下面加一行：
 *       <script defer src="dist/calendar.js"></script>
 *
 * 功能：月视图日历 · 倒数日 / 生日 / 一次性日子 · 只读显示站内纪念日
 *       经期与排卵日推算（粉＝经期，黄＝排卵日，浅黄＝易孕窗口）· 导入 .ics
 * 数据：存在 data.calendar，随站内 save() 落盘，「导出全部数据」会一起备份
 * 说明：网页读不到手机系统日历（浏览器无此权限），所以走手动录入 + 导入 .ics
 */
(function () {
  'use strict';

  var CAL_VER = '1.2.0';
  var CAL_KEY = 'ordinal-calendar';
  var PREDICT_MONTHS = 6;

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
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseYmd(s) {
    var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  function parseCompact(s) {
    var m = /^(\d{4})(\d{2})(\d{2})/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  function addDays(d, n) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }
  function dayDiff(a, b) {
    return Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) -
      new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
  }
  function today() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function sameDay(a, b) { return !!a && !!b && ymd(a) === ymd(b); }
  function md(d) { return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日'; }

  /* ============ 1. 数据层 ============ */

  function defStore() {
    return {
      v: CAL_VER,
      events: [],
      ics: [],
      period: { on: false, lastStart: '', cycleLen: 28, periodLen: 5, luteal: 14 },
      moon: { on: true, mode: 'auto', full1: '', full2: '' }
    };
  }

  function siteReady() {
    try { return (typeof data !== 'undefined' && data && typeof data === 'object'); } catch (e) { return false; }
  }

  function norm(c) {
    if (!c || typeof c !== 'object') c = defStore();
    if (!Array.isArray(c.events)) c.events = [];
    if (!Array.isArray(c.ics)) c.ics = [];
    if (!c.period || typeof c.period !== 'object') c.period = defStore().period;
    var p = c.period;
    p.cycleLen = Math.min(45, Math.max(21, Number(p.cycleLen) || 28));
    p.periodLen = Math.min(10, Math.max(2, Number(p.periodLen) || 5));
    p.luteal = Math.min(16, Math.max(10, Number(p.luteal) || 14));
    p.on = !!p.on;
    p.lastStart = parseYmd(p.lastStart) ? String(p.lastStart).slice(0, 10) : '';
    if (!c.moon || typeof c.moon !== 'object') c.moon = defStore().moon;
    var mo = c.moon;
    mo.on = mo.on !== false;
    mo.mode = mo.mode === 'calib' ? 'calib' : 'auto';
    mo.full1 = parseYmd(mo.full1) ? String(mo.full1).slice(0, 10) : '';
    mo.full2 = parseYmd(mo.full2) ? String(mo.full2).slice(0, 10) : '';
    return c;
  }

  function root() {
    if (siteReady()) {
      data.calendar = norm(data.calendar);
      return data.calendar;
    }
    try {
      var raw = localStorage.getItem(CAL_KEY);
      return raw ? norm(JSON.parse(raw)) : defStore();
    } catch (e) { return defStore(); }
  }

  function persist() {
    if (siteReady() && data.calendar) {
      try { if (typeof save === 'function') { save(); return; } } catch (e) {}
    }
    try { localStorage.setItem(CAL_KEY, JSON.stringify(root())); } catch (e2) {}
  }

  /* 站内 data 就绪后，把兜底期存下的东西并进来（只并一次） */
  function mergeFallback() {
    try {
      var raw = localStorage.getItem(CAL_KEY);
      if (!raw || !siteReady()) return;
      var old = norm(JSON.parse(raw));
      data.calendar = norm(data.calendar);
      if (!data.calendar.events.length && old.events.length) data.calendar.events = old.events;
      if (!data.calendar.ics.length && old.ics.length) data.calendar.ics = old.ics;
      if (!data.calendar.period.on && old.period.on) data.calendar.period = old.period;
      localStorage.removeItem(CAL_KEY);
      persist();
    } catch (e) {}
  }

  /* ============ 2. 经期推算 ============ */

  function periodMap(fromD, toD) {
    var out = {};
    var st = root().period;
    if (!st || !st.on) return out;
    var anchor = parseYmd(st.lastStart);
    if (!anchor) return out;
    var cyc = st.cycleLen, len = st.periodLen, lut = st.luteal;
    var limit = addDays(today(), PREDICT_MONTHS * 31);
    var end = toD > limit ? limit : toD;
    var k = Math.floor(dayDiff(anchor, fromD) / cyc) - 1;
    if (k < -60) k = -60;
    for (; k < 600; k++) {
      var cs = addDays(anchor, k * cyc);
      if (cs > end) break;
      var i, d, key;
      for (i = 0; i < len; i++) {
        d = addDays(cs, i);
        if (d >= fromD && d <= end) out[ymd(d)] = 'p';
      }
      var ov = addDays(cs, cyc - lut);
      if (ov >= fromD && ov <= end) { key = ymd(ov); if (!out[key]) out[key] = 'o'; }
      for (i = -5; i <= 1; i++) {
        d = addDays(ov, i);
        if (d >= fromD && d <= end) { key = ymd(d); if (!out[key]) out[key] = 'w'; }
      }
    }
    return out;
  }

  function periodInfo() {
    var st = root().period;
    if (!st || !st.on) return null;
    var anchor = parseYmd(st.lastStart);
    if (!anchor) return null;
    var cyc = st.cycleLen, len = st.periodLen, lut = st.luteal, t = today();
    var k = Math.floor(dayDiff(anchor, t) / cyc);
    var cs = addDays(anchor, k * cyc);
    var guard = 0;
    while (dayDiff(cs, t) < 0 && guard++ < 900) { k--; cs = addDays(anchor, k * cyc); }
    guard = 0;
    while (dayDiff(cs, t) >= cyc && guard++ < 900) { k++; cs = addDays(anchor, k * cyc); }
    var inCycleDay = dayDiff(cs, t) + 1;
    var nextStart = addDays(cs, cyc);
    var ovu = addDays(nextStart, -lut);
    return {
      cycleStart: cs,
      dayInCycle: inCycleDay,
      inPeriod: inCycleDay <= len,
      periodDayNo: inCycleDay <= len ? inCycleDay : 0,
      nextStart: nextStart,
      toNext: dayDiff(t, nextStart),
      ovu: ovu,
      toOvu: dayDiff(t, ovu)
    };
  }

  /* ============ 2b. 月相 ============ */

  var SYNODIC = 29.530588853;                  // 朔望月平均长度（天），仅用于「月龄」显示与手动校准模式
  var REF_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14, 0);   // 手动校准缺锚点时的兜底历元
  var MOON_NAMES = ['新月（朔）', '峨眉月', '上弦月', '盈凸月', '满月（望）', '亏凸月', '下弦月', '残月'];
  var MOON_SAY = [
    '传统上把这一天当作「起点」。民俗说法：适合许下新的意愿、开启新计划、写下目标；不急着要结果。',
    '意愿已经落下、开始动手的一段。民俗说法：适合迈出第一步、收集资料、把习惯建立起来。',
    '半亮、力量上升。民俗说法：适合做决定、付诸行动、公开推进、正面处理阻力。',
    '接近圆满。民俗说法：适合调整细节、补齐缺漏、耐心等结果，不宜大改方向。',
    '一个月里最「满」的时刻。民俗说法：适合庆祝、完成、感恩与释放；情绪也容易起伏，留出余地。',
    '开始回收。民俗说法：适合分享所得、把经验教给别人、整理成果。',
    '半亮、力量下降。民俗说法：适合断舍离、清理、放下、给旧事收尾。',
    '最暗的一段。民俗说法：适合休息、内省、静默，不做重大决定。'
  ];
  var MOON_NOTE = '默认「自动推算」：按月球与太阳的黄经差算相位，含中心差、出差、二均差等主要摄动项（Meeus 简化式），关键月相时刻精度约在几十分钟内，再按你手机的时区换算成日期。上面那些「适合做什么」是各地民俗与占星传统里的说法，不是天文结论。';

  function moonCfg() {
    var c = root();
    if (!c.moon) c.moon = defStore().moon;
    return c.moon;
  }

  function rad(x) { return x * Math.PI / 180; }
  function norm360(x) { return ((x % 360) + 360) % 360; }

  /* 自动推算：返回相位进度 0..1（0=新月 0.25=上弦 0.5=满月 0.75=下弦） */
  function moonPhaseAuto(date) {
    var jd = date.getTime() / 86400000 + 2440587.5;
    var T = (jd - 2451545.0) / 36525;
    // 太阳
    var Ls = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
    var Ms = rad(norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T));
    var Cs = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Ms)
      + (0.019993 - 0.000101 * T) * Math.sin(2 * Ms)
      + 0.000289 * Math.sin(3 * Ms);
    var sunLon = Ls + Cs;
    // 月球（主要周期项）
    var Lp = norm360(218.3164477 + 481267.88123421 * T - 0.0015786 * T * T);
    var D = rad(norm360(297.8501921 + 445267.1114034 * T - 0.0017661 * T * T));
    var Mm = rad(norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T));
    var Ms2 = Ms;
    var F = rad(norm360(93.2720950 + 483202.0175233 * T - 0.0036539 * T * T));
    var lam = Lp
      + 6.288774 * Math.sin(Mm)
      + 1.274027 * Math.sin(2 * D - Mm)
      + 0.658314 * Math.sin(2 * D)
      + 0.213618 * Math.sin(2 * Mm)
      - 0.185116 * Math.sin(Ms2)
      - 0.114332 * Math.sin(2 * F)
      + 0.058793 * Math.sin(2 * D - 2 * Mm)
      + 0.057062 * Math.sin(2 * D - Ms2 - Mm)
      + 0.053322 * Math.sin(2 * D + Mm)
      + 0.045758 * Math.sin(2 * D - Ms2)
      - 0.040923 * Math.sin(Ms2 - Mm)
      - 0.034720 * Math.sin(D)
      - 0.030383 * Math.sin(Mm + 2 * F)
      + 0.015327 * Math.sin(2 * D - 2 * F)
      - 0.012528 * Math.sin(D + Mm)
      + 0.010980 * Math.sin(D - Mm)
      + 0.010675 * Math.sin(4 * D - Mm)
      + 0.010034 * Math.sin(3 * Mm)
      + 0.008548 * Math.sin(2 * D + 2 * Mm);
    return norm360(lam - sunLon) / 360;
  }

  /* 手动校准：以你填的上次满月为锚，用两次满月相差的天数当周期，线性反推 */
  function moonCalibParams() {
    var m = moonCfg();
    if (m.mode !== 'calib') return null;
    var a = parseYmd(m.full1), b = parseYmd(m.full2);
    if (!a) return null;
    var per = SYNODIC;
    if (b) {
      var d = Math.abs(dayDiff(a, b));
      if (d >= 20 && d <= 40) per = d;
    }
    return { t: new Date(a.getFullYear(), a.getMonth(), a.getDate(), 12).getTime(), per: per };
  }

  function moonPhaseFrac(date) {
    var cb = moonCalibParams();
    if (!cb) return moonPhaseAuto(date);
    var days = (date.getTime() - cb.t) / 86400000;
    var f = (0.5 + days / cb.per) % 1;
    return f < 0 ? f + 1 : f;
  }

  function moonPeriodNow() {
    var cb = moonCalibParams();
    return cb ? cb.per : SYNODIC;
  }

  function moonInfo(date) {
    var noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
    var prog = moonPhaseFrac(noon);
    var frac = (1 - Math.cos(2 * Math.PI * prog)) / 2;
    var idx = Math.floor(prog * 8 + 0.5) % 8;
    return {
      prog: prog, frac: frac, waxing: prog < 0.5, idx: idx,
      age: prog * moonPeriodNow(), period: moonPeriodNow(),
      name: MOON_NAMES[idx], say: MOON_SAY[idx],
      calib: !!moonCalibParams()
    };
  }

  /* 亮面路径：外圆沿亮侧半圈 + 明暗界线那半个椭圆（k=1-2f 决定椭圆短半轴） */
  function moonLitPath(frac, waxing) {
    var R = 9, C = 12, k = 1 - 2 * frac, rx = Math.abs(k) * R;
    var top = C + ' ' + (C - R), bot = C + ' ' + (C + R);
    var outerSweep = waxing ? 1 : 0;
    var retSweep = waxing ? (k > 0 ? 0 : 1) : (k > 0 ? 1 : 0);
    return 'M' + top + 'A' + R + ' ' + R + ' 0 0 ' + outerSweep + ' ' + bot +
      'A' + (Math.round(rx * 100) / 100) + ' ' + R + ' 0 0 ' + retSweep + ' ' + top + 'Z';
  }

  function moonSvg(size, info) {
    var f = Math.max(0, Math.min(1, info.frac));
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true">'
      + '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".45"/>'
      + '<path d="' + moonLitPath(f, info.waxing) + '" fill="currentColor" stroke="none"/>'
      + '</svg>';
  }

  /* 本月四个关键月相的准确时刻：逐小时扫过、二分细化到分钟，再取本地日期 */
  var _moonCache = {};
  function moonPhaseInstants(y, m) {
    var key = y + '-' + m + (moonCalibParams() ? '-c' : '-a');
    if (_moonCache[key]) return _moonCache[key];
    var start = new Date(y, m, 1).getTime(), end = new Date(y, m + 1, 1).getTime();
    var targets = [[0, '新月'], [0.25, '上弦月'], [0.5, '满月'], [0.75, '下弦月']];
    var step = 3600000, out = [];
    function wrapDiff(p, tg) { var d = p - tg; if (d < -0.5) d += 1; if (d > 0.5) d -= 1; return d; }
    var prevP = moonPhaseFrac(new Date(start));
    for (var t = start + step; t <= end; t += step) {
      var p = moonPhaseFrac(new Date(t));
      for (var i = 0; i < targets.length; i++) {
        var a = wrapDiff(prevP, targets[i][0]), b = wrapDiff(p, targets[i][0]);
        if (a > 0 || b <= 0) continue;
        var lo = t - step, hi = t;
        for (var k = 0; k < 24; k++) {
          var mid = (lo + hi) / 2;
          if (wrapDiff(moonPhaseFrac(new Date(mid)), targets[i][0]) < 0) lo = mid; else hi = mid;
        }
        var at = new Date((lo + hi) / 2);
        out.push({
          name: targets[i][1], date: at, day: at.getDate(),
          hhmm: pad2(at.getHours()) + ':' + pad2(at.getMinutes()),
          info: moonInfo(at)
        });
      }
      prevP = p;
    }
    out.sort(function (x, z) { return x.date - z.date; });
    _moonCache = {};
    _moonCache[key] = out;
    return out;
  }

  function monthKeyMoons(y, m) { return moonPhaseInstants(y, m); }

  /* ============ 3. 日子（倒数日 / 生日 / 一次性 / .ics） ============ */

  function evOccurInYear(ev, y) {
    var d = parseYmd(ev.date);
    if (!d) return null;
    if (isYearly(ev)) return new Date(y, d.getMonth(), d.getDate());
    return d.getFullYear() === y ? d : null;
  }
  function isYearly(ev) { return ev.type === 'birthday' || ev.repeat === 'yearly'; }

  function whoName(cid) {
    try {
      if (typeof chatPartnerNameOf === 'function') { var n = chatPartnerNameOf(cid); if (n) return n; }
      var cs = (siteReady() && data.contacts) || [];
      for (var i = 0; i < cs.length; i++) if (cs[i] && cs[i].id === cid) return cs[i].name || '';
    } catch (e) {}
    return '';
  }

  function contactList() {
    try { return (siteReady() && Array.isArray(data.contacts)) ? data.contacts : []; } catch (e) { return []; }
  }

  function annivList() {
    try {
      if (typeof annList === 'function') { var l = annList(); if (Array.isArray(l)) return l; }
    } catch (e) {}
    try { if (siteReady() && Array.isArray(data.anniversaries)) return data.anniversaries; } catch (e2) {}
    return [];
  }

  function itemsOn(d) {
    var key = ymd(d), y = d.getFullYear(), out = [];
    root().events.forEach(function (ev) {
      var o = evOccurInYear(ev, y);
      if (!o || ymd(o) !== key) return;
      var base = parseYmd(ev.date);
      var extra = '';
      if (ev.type === 'birthday' && base && y > base.getFullYear()) extra = (y - base.getFullYear()) + ' 岁';
      else if (isYearly(ev) && base && y > base.getFullYear()) extra = '第 ' + (y - base.getFullYear()) + ' 次';
      out.push({
        kind: ev.type || 'once', title: ev.title || '（未命名）', id: ev.id, own: true, extra: extra,
        time: ev.time || '', who: ev.who ? whoName(ev.who) : ''
      });
    });
    root().ics.forEach(function (e) {
      if (!e || !e.start) return;
      var s = parseYmd(e.start);
      if (!s) return;
      var hit;
      if (e.yearly) hit = (s.getMonth() === d.getMonth() && s.getDate() === d.getDate());
      else if (e.end) hit = (e.start <= key && key <= e.end);
      else hit = (e.start === key);
      if (hit) out.push({ kind: 'ics', title: e.title || '（无标题）', id: e.id, own: true, ics: true, extra: e.yearly ? '每年' : '', time: '', who: '' });
    });
    annivList().forEach(function (a) {
      if (!a || !a.date) return;
      var ad = parseYmd(a.date);
      if (!ad) return;
      if (ad.getMonth() !== d.getMonth() || ad.getDate() !== d.getDate()) return;
      var yrs = y - ad.getFullYear();
      out.push({
        kind: 'anniv', title: a.name || '纪念日', id: a.id, own: false,
        extra: yrs > 0 ? (yrs + ' 周年') : (a.main ? '主纪念日' : '纪念日'), time: '', who: ''
      });
    });
    return out;
  }

  function upcoming(limit) {
    var t = today(), out = [], y = t.getFullYear();
    for (var pass = 0; pass < 2; pass++) {
      root().events.forEach(function (ev) {
        var o = evOccurInYear(ev, y + pass);
        if (!o) return;
        var n = dayDiff(t, o);
        if (n < 0) return;
        out.push({ at: n, date: o, kind: ev.type || 'once', title: ev.title || '（未命名）', id: ev.id, own: true, time: ev.time || '' });
      });
      root().ics.forEach(function (e) {
        if (!e || !e.start || !e.yearly) return;
        var s = parseYmd(e.start);
        if (!s) return;
        var o2 = new Date(y + pass, s.getMonth(), s.getDate());
        var n2 = dayDiff(t, o2);
        if (n2 < 0) return;
        out.push({ at: n2, date: o2, kind: 'ics', title: e.title || '（无标题）', id: e.id, own: true });
      });
      annivList().forEach(function (a) {
        if (!a || !a.date) return;
        var ad = parseYmd(a.date);
        if (!ad) return;
        var o3 = new Date(y + pass, ad.getMonth(), ad.getDate());
        var n3 = dayDiff(t, o3);
        if (n3 < 0) return;
        var yrs = (y + pass) - ad.getFullYear();
        out.push({
          at: n3, date: o3, kind: 'anniv', title: a.name || '纪念日', id: a.id, own: false,
          extra: yrs > 0 ? (yrs + ' 周年') : ''
        });
      });
      if (out.length >= (limit || 8)) break;
    }
    out.sort(function (a, b) { return a.at - b.at; });
    return out.slice(0, limit || 8);
  }

  /* ============ 4. .ics 解析（纯本地，不联网） ============ */

  function icsDate(v) {
    v = String(v == null ? '' : v).trim();
    if (/^\d{8}$/.test(v)) return parseCompact(v);
    var m = /^(\d{4})(\d{2})(\d{2})T/.exec(v);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return parseYmd(v);
  }
  function icsUnesc(s) {
    return String(s).replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
  }
  function parseIcs(txt) {
    var lines = String(txt).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    var ok = [], skipped = 0, noDate = 0, badRule = 0, inEv = false, cur = null;
    lines.forEach(function (ln) {
      var s = ln.trim();
      if (!s) return;
      if (s.toUpperCase() === 'BEGIN:VEVENT') { inEv = true; cur = { sum: '', st: '', en: '', rr: '' }; return; }
      if (s.toUpperCase() === 'END:VEVENT') {
        inEv = false;
        if (!cur) return;
        var st = icsDate(cur.st);
        if (!st) { noDate++; skipped++; cur = null; return; }
        var yearly = /FREQ=YEARLY/i.test(cur.rr || '');
        if (cur.rr && !yearly) { badRule++; skipped++; cur = null; return; }
        var en = cur.en ? icsDate(cur.en) : null;
        ok.push({
          id: nid(), title: icsUnesc(cur.sum) || '（无标题）',
          start: ymd(st), end: en ? ymd(en) : '', yearly: yearly
        });
        cur = null;
        return;
      }
      if (!inEv || !cur) return;
      var i = s.indexOf(':');
      if (i < 0) return;
      var k = s.slice(0, i).split(';')[0].toUpperCase(), v = s.slice(i + 1);
      if (k === 'SUMMARY') cur.sum = v;
      else if (k === 'DTSTART') cur.st = v;
      else if (k === 'DTEND') cur.en = v;
      else if (k === 'RRULE') cur.rr = v;
    });
    return { ok: ok, skipped: skipped, noDate: noDate, badRule: badRule };
  }

  /* ============ 5. 图标（照站内 24×24 线性描边风格手绘，非 emoji） ============ */

  var CAL_ICO = '<rect x="3" y="5" width="18" height="16" rx="3"/>'
    + '<path d="M3 10h18"/>'
    + '<path d="M8 2.6v4.2"/><path d="M16 2.6v4.2"/>'
    + '<circle cx="8.4" cy="14.2" r="1.1" fill="currentColor" stroke="none"/>'
    + '<circle cx="12" cy="14.2" r="1.1" fill="currentColor" stroke="none"/>'
    + '<circle cx="15.6" cy="14.2" r="1.1" fill="currentColor" stroke="none"/>'
    + '<circle cx="8.4" cy="17.8" r="1.1" fill="currentColor" stroke="none"/>';

  var ICO_GEAR = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  /* ============ 6. 样式 ============ */

  var CSS = [
    '#calendarView{padding-bottom:96px}',
    '#calendarView .home-greet{align-items:flex-start;overflow:visible;height:auto}',
    '.cal-bar{display:flex;gap:8px;align-items:stretch;flex-wrap:nowrap;margin:10px 0 2px}',
    '.cal-btn{flex:1 1 auto;min-height:38px;padding:0 12px;border:1px solid rgba(0,0,0,.14);border-radius:12px;background:#fff;color:var(--ink,#1c1917);font:inherit;font-size:13px;line-height:1.2;display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}',
    '.cal-btn:active{opacity:.6}',
    '.cal-btn-ico{flex:none;width:40px;padding:0}',
    '.cal-btn-ico svg{width:17px;height:17px;display:block}',
    '.cal-nav{display:flex;align-items:center;gap:6px;margin:14px 0 8px}',
    '.cal-nav-t{flex:1 1 auto;text-align:center;font-size:15px;font-weight:600;letter-spacing:.4px;color:var(--ink,#1c1917)}',
    '.cal-nav button{flex:none;min-width:34px;height:32px;padding:0 10px;border:1px solid rgba(0,0,0,.12);border-radius:11px;background:#fff;color:var(--ink,#1c1917);font-size:13px;line-height:1}',
    '.cal-nav button:active{opacity:.6}',
    '.cal-week,.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}',
    '.cal-week span{text-align:center;font-size:11px;color:var(--muted,#6b6a67);padding:4px 0;letter-spacing:.5px}',
    '.cal-cell{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:2px;height:50px;padding:5px 0 4px;border:1px solid transparent;border-radius:12px;background:rgba(0,0,0,.028);color:var(--ink,#1c1917);font:inherit}',
    '.cal-cell.out{opacity:.32}',
    '.cal-cell .cal-n{font-size:13px;line-height:1.15;font-variant-numeric:tabular-nums}',
    '.cal-cell.today{border-color:var(--ink,#1c1917)}',
    '.cal-cell.sel{background:var(--ink,#1c1917);border-color:var(--ink,#1c1917);color:#fff}',
    '.cal-cell.sel .cal-tag{background:rgba(255,255,255,.85);color:#1c1917}',
    '.cal-cell.m-p{background:rgba(233,150,170,.34)}',
    '.cal-cell.m-p .cal-n{color:#96395a;font-weight:600}',
    '.cal-cell.m-o{background:rgba(226,182,92,.42)}',
    '.cal-cell.m-o .cal-n{color:#7a5c14;font-weight:600}',
    '.cal-cell.m-w{background:rgba(226,182,92,.17)}',
    '.cal-cell.sel.m-p,.cal-cell.sel.m-o,.cal-cell.sel.m-w{background:var(--ink,#1c1917)}',
    '.cal-cell.sel.m-p .cal-n,.cal-cell.sel.m-o .cal-n,.cal-cell.sel.m-w .cal-n{color:#fff}',
    '.cal-tag{font-size:9px;line-height:1.3;padding:0 3px;border-radius:5px;background:rgba(150,57,90,.16);color:#96395a}',
    '.cal-tag.o{background:rgba(122,92,20,.16);color:#7a5c14}',
    '.cal-dots{display:flex;gap:2px;height:5px;align-items:center}',
    '.cal-dot{width:4px;height:4px;border-radius:50%;background:var(--ink,#1c1917);opacity:.55}',
    '.cal-dot.k-anniv{background:var(--gold-ink,#a8873f);opacity:.95}',
    '.cal-dot.k-birthday{background:#c2628a;opacity:.95}',
    '.cal-dot.k-ics{opacity:.3}',
    '.cal-legend{display:flex;flex-wrap:wrap;gap:10px;margin:10px 2px 4px;font-size:11px;color:var(--muted,#6b6a67)}',
    '.cal-legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:4px;vertical-align:-1px}',
    '.cal-l-p{background:rgba(233,150,170,.55)}',
    '.cal-l-o{background:rgba(226,182,92,.65)}',
    '.cal-l-w{background:rgba(226,182,92,.25)}',
    '.cal-l-a{background:var(--gold-ink,#a8873f)}',
    '.cal-sum{margin:2px 0 10px;padding:10px 12px;border-radius:14px;background:rgba(0,0,0,.035);font-size:12.5px;line-height:1.7;color:var(--ink,#1c1917)}',
    '.cal-sum b{font-weight:600}',
    '.cal-row{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:14px;background:rgba(0,0,0,.028);margin-bottom:7px;text-align:left;width:100%;border:0;font:inherit;color:inherit}',
    '.cal-row-ico{flex:none;width:26px;height:26px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.05)}',
    '.cal-row-ico svg{width:15px;height:15px}',
    '.cal-row-tx{flex:1 1 auto;min-width:0}',
    '.cal-row-tx b{display:block;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cal-row-tx small{display:block;font-size:11px;color:var(--muted,#6b6a67);margin-top:2px}',
    '.cal-row-n{flex:none;font-size:12px;color:var(--muted,#6b6a67);font-variant-numeric:tabular-nums}',
    '.cal-row-n.hot{color:#96395a;font-weight:600}',
    '.cal-empty{padding:16px 12px;font-size:12px;color:var(--muted,#6b6a67);text-align:center}',
    '.cal-frm-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid rgba(0,0,0,.06)}',
    '.cal-frm-row>span{flex:none;width:82px;font-size:12.5px;color:var(--muted,#6b6a67)}',
    '.cal-frm-row input[type=text],.cal-frm-row input[type=date],.cal-frm-row input[type=number],.cal-frm-row textarea{flex:1 1 auto;min-width:0;padding:9px 10px;border:1px solid rgba(0,0,0,.14);border-radius:11px;background:#fff;color:var(--ink,#1c1917);font:inherit;font-size:13.5px}',
    '.cal-frm-row textarea{min-height:60px;resize:vertical;line-height:1.6}',
    '.cal-chips{display:flex;gap:6px;flex-wrap:wrap;flex:1 1 auto}',
    '.cal-chip{padding:7px 12px;border:1px solid rgba(0,0,0,.14);border-radius:999px;background:#fff;color:var(--muted,#6b6a67);font:inherit;font-size:12.5px}',
    '.cal-chip[aria-pressed=true]{background:var(--ink,#1c1917);border-color:var(--ink,#1c1917);color:#fff}',
    '.cal-acts{display:flex;gap:8px;margin-top:16px}',
    '.cal-acts .soft-btn{flex:1 1 auto}',
    '.cal-note{font-size:11.5px;line-height:1.75;color:var(--muted,#6b6a67);margin:10px 0 0}',
    '.cal-moon{position:absolute;top:2px;right:2px;width:11px;height:11px;line-height:0;color:var(--ink,#1c1917);opacity:.72;pointer-events:none}',
    '.cal-cell.sel .cal-moon{color:#fff;opacity:.95}',
    '.cal-cell.out .cal-moon{opacity:.5}',
    '.cal-mooncard{display:flex;gap:11px;align-items:flex-start;margin:0 0 10px;padding:11px 12px;border-radius:14px;background:rgba(0,0,0,.035)}',
    '.cal-moonbig{flex:none;width:38px;height:38px;line-height:0;color:var(--ink,#1c1917)}',
    '.cal-mooncard-tx{flex:1 1 auto;min-width:0}',
    '.cal-mooncard-tx b{display:block;font-size:13.5px;font-weight:600;color:var(--ink,#1c1917)}',
    '.cal-mooncard-tx small{display:block;font-size:11px;color:var(--muted,#6b6a67);margin-top:3px;font-variant-numeric:tabular-nums}',
    '.cal-mooncard-tx p{margin:6px 0 0;font-size:11.5px;line-height:1.75;color:var(--muted,#6b6a67)}',
    '.cal-moonrow{display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:13px;background:rgba(0,0,0,.028);margin-bottom:6px}',
    '.cal-moonico{flex:none;width:20px;height:20px;line-height:0;color:var(--ink,#1c1917)}',
    '.cal-moonrow b{flex:none;min-width:52px;font-size:12.5px;font-weight:600;color:var(--ink,#1c1917)}',
    '.cal-moonrow small{flex:1 1 auto;font-size:11px;color:var(--muted,#6b6a67);text-align:right;font-variant-numeric:tabular-nums}',
    '.cal-dot.k-video{background:#5b7fa6;opacity:.95;width:5px;height:5px}',
    '.cal-row-tx small .cal-t{color:var(--ink,#1c1917);font-weight:600;font-variant-numeric:tabular-nums}',
    '.cal-who-row{display:flex;gap:6px;flex-wrap:wrap;flex:1 1 auto;max-height:96px;overflow-y:auto}',
    '.cal-who-row .cal-chip{padding:6px 10px;font-size:12px}'
  ].join('\n');

  function injectStyle() {
    if (qs('#calStyle')) return;
    var s = document.createElement('style');
    s.id = 'calStyle';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ============ 7. 视图 DOM ============ */

  var VIEW_HTML = ''
    + '<div class="home-greet">'
    + '  <div>'
    + '    <div class="g-eyebrow">CALENDAR</div><div class="g-hi">日历</div>'
    + '    <div class="g-sub" id="calSub"></div>'
    + '  </div>'
    + '</div>'
    + '<div class="cal-bar">'
    + '  <button type="button" class="cal-btn" id="calAddBtn">＋ 添加日子</button>'
    + '  <button type="button" class="cal-btn cal-btn-ico" id="calSetBtn" aria-label="经期与导入" title="经期与导入">' + ICO_GEAR + '</button>'
    + '</div>'
    + '<div class="cal-sum" id="calSum" hidden></div>'
    + '<div class="cal-nav">'
    + '  <button type="button" id="calPrev" aria-label="上个月">‹</button>'
    + '  <div class="cal-nav-t" id="calTitle"></div>'
    + '  <button type="button" id="calNext" aria-label="下个月">›</button>'
    + '  <button type="button" id="calToday">今天</button>'
    + '</div>'
    + '<div class="cal-week"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>'
    + '<div class="cal-grid" id="calGrid"></div>'
    + '<div class="cal-legend">'
    + '  <span><i class="cal-l-p"></i>经期</span>'
    + '  <span><i class="cal-l-o"></i>排卵日</span>'
    + '  <span><i class="cal-l-w"></i>易孕窗口</span>'
    + '  <span><i class="cal-l-a"></i>纪念日</span>'
    + '</div>'
    + '<div class="sec-label" id="calMoonLab">本月月相 <i>MOON</i></div>'
    + '<div id="calMoonMonth"></div>'
    + '<div class="sec-label" id="calDayLab">这一天 <i>DAY</i></div>'
    + '<div id="calDayList"></div>'
    + '<div class="sec-label">接下来的日子 <i>UPCOMING</i></div>'
    + '<div id="calUpcoming"></div>';

  var EDIT_HTML = ''
    + '<div class="fs-sheet-mask fs-sheet-full" id="calEditMask" hidden>'
    + '  <div class="fs-sheet">'
    + '    <div class="fs-sheet-bar">'
    + '      <div class="fs-sheet-t"><span class="fs-sheet-ti" id="calEditTi">添加日子</span><span class="fs-sheet-en">DATE</span></div>'
    + '      <button type="button" class="fs-sheet-close" id="calEditClose" aria-label="关闭">×</button>'
    + '    </div>'
    + '    <div class="fs-sheet-body">'
    + '      <div class="cal-frm-row"><span>叫什么</span><input type="text" id="calEvTitle" maxlength="30" placeholder="例如：生日 / 考试 / 在一起"></div>'
    + '      <div class="cal-frm-row"><span>哪一天</span><input type="date" id="calEvDate"></div>'
    + '      <div class="cal-frm-row"><span>几点</span><input type="time" id="calEvTime"><button type="button" class="cal-chip" id="calEvTimeClear" style="flex:none">不填</button></div>'
    + '      <div class="cal-frm-row"><span>和谁</span><div class="cal-who-row" id="calEvWho"></div></div>'
    + '      <div class="cal-frm-row"><span>类型</span><div class="cal-chips" id="calEvType">'
    + '        <button type="button" class="cal-chip" data-v="countdown" aria-pressed="true">倒数日</button>'
    + '        <button type="button" class="cal-chip" data-v="birthday" aria-pressed="false">生日</button>'
    + '        <button type="button" class="cal-chip" data-v="once" aria-pressed="false">只这一次</button>'
    + '        <button type="button" class="cal-chip" data-v="video" aria-pressed="false">看视频</button>'
    + '      </div></div>'
    + '      <div class="cal-frm-row"><span>每年重复</span><div class="cal-chips" id="calEvRepeat">'
    + '        <button type="button" class="cal-chip" data-v="yearly" aria-pressed="true">每年</button>'
    + '        <button type="button" class="cal-chip" data-v="none" aria-pressed="false">不重复</button>'
    + '      </div></div>'
    + '      <div class="cal-frm-row"><span>备注</span><textarea id="calEvNote" maxlength="200" placeholder="选填"></textarea></div>'
    + '      <p class="cal-note" id="calEvHint"></p>'
    + '      <div class="cal-acts">'
    + '        <button type="button" class="soft-btn danger" id="calEvDel" hidden>删除</button>'
    + '        <button type="button" class="soft-btn" id="calEvSave">保存</button>'
    + '      </div>'
    + '    </div>'
    + '  </div>'
    + '</div>';

  var SET_HTML = ''
    + '<div class="fs-sheet-mask fs-sheet-full" id="calSetMask" hidden>'
    + '  <div class="fs-sheet">'
    + '    <div class="fs-sheet-bar">'
    + '      <div class="fs-sheet-t"><span class="fs-sheet-ti">经期 · 月相 · 导入</span><span class="fs-sheet-en">SETTINGS</span></div>'
    + '      <button type="button" class="fs-sheet-close" id="calSetClose" aria-label="关闭">×</button>'
    + '    </div>'
    + '    <div class="fs-sheet-body">'
    + '      <div class="setting-subhead">经期</div>'
    + '      <div class="cal-frm-row"><span>启用</span><div class="cal-chips" id="calPOn">'
    + '        <button type="button" class="cal-chip" data-v="on" aria-pressed="false">开启</button>'
    + '        <button type="button" class="cal-chip" data-v="off" aria-pressed="true">不用</button>'
    + '      </div></div>'
    + '      <div class="cal-frm-row"><span>上次首日</span><input type="date" id="calPLast"></div>'
    + '      <div class="cal-frm-row"><span>周期天数</span><input type="number" id="calPCycle" min="21" max="45" step="1" inputmode="numeric"></div>'
    + '      <div class="cal-frm-row"><span>经期天数</span><input type="number" id="calPLen" min="2" max="10" step="1" inputmode="numeric"></div>'
    + '      <div class="cal-frm-row"><span>黄体期</span><input type="number" id="calPLut" min="10" max="16" step="1" inputmode="numeric"></div>'
    + '      <p class="cal-note">排卵日按「下次经期首日 − 黄体期天数」推算（黄体期一般固定 14 天）。易孕窗口＝排卵日前 5 天到后 1 天。日历只往后推 ' + PREDICT_MONTHS + ' 个月。这些都只是日历标注，不是医疗建议；周期不规律或身体有状况请看医生。</p>'
    + '      <div class="setting-subhead" style="margin-top:18px">月相</div>'
    + '      <div class="cal-frm-row"><span>显示月相</span><div class="cal-chips" id="calMoonOn">'
    + '        <button type="button" class="cal-chip" data-v="on" aria-pressed="true">显示</button>'
    + '        <button type="button" class="cal-chip" data-v="off" aria-pressed="false">不显示</button>'
    + '      </div></div>'
    + '      <div class="cal-frm-row"><span>推算方式</span><div class="cal-chips" id="calMoonMode">'
    + '        <button type="button" class="cal-chip" data-v="auto" aria-pressed="true">自动推算</button>'
    + '        <button type="button" class="cal-chip" data-v="calib" aria-pressed="false">按我填的满月校准</button>'
    + '      </div></div>'
    + '      <div class="cal-frm-row"><span>上次满月</span><input type="date" id="calMoonF1"></div>'
    + '      <div class="cal-frm-row"><span>下次满月</span><input type="date" id="calMoonF2"></div>'
    + '      <p class="cal-note">' + MOON_NOTE + '</p>'
    + '      <p class="cal-note">选「按我填的满月校准」时：填进上、下次满月的日期，模块用两者相差的天数当作周期长度，并以上次满月那天为锚点反推整月月相（相差要在 20–40 天之间才认，否则自动退回天文推算）。</p>'
    + '      <div class="setting-subhead" style="margin-top:18px">导入系统日历（.ics）</div>'
    + '      <p class="cal-note">网页读不到手机系统日历（浏览器没有这个权限），所以走导出再导入：先在系统日历里导出 / 分享成 .ics 文件，再从下面选进来。解析全程在你手机本地完成，不上传任何网络。重复规则只支持「每年重复」，其余会跳过并告诉你跳了几条。</p>'
    + '      <div class="cal-acts">'
    + '        <button type="button" class="soft-btn" id="calIcsPick">选 .ics 文件</button>'
    + '        <button type="button" class="soft-btn danger" id="calIcsClear">清空导入的</button>'
    + '      </div>'
    + '      <p class="cal-note" id="calIcsStat"></p>'
    + '      <div class="setting-subhead" style="margin-top:18px">这一页</div>'
    + '      <p class="cal-note">日历模块 v' + CAL_VER + ' · 数据存在这台设备上，随「导出全部数据」一起备份。纪念日是从站内「纪念日」那边只读取来显示的，删改请回原页面。</p>'
    + '    </div>'
    + '  </div>'
    + '</div>';

  var calState = { view: today(), sel: today(), editId: '' };

  function injectDom() {
    if (qs('#calendarView')) return;
    var shell = qs('.app-shell') || document.body;
    var sec = document.createElement('section');
    sec.className = 'view';
    sec.id = 'calendarView';
    sec.innerHTML = VIEW_HTML;
    var more = qs('#moreView');
    if (more && more.parentNode === shell) shell.insertBefore(sec, more);
    else shell.appendChild(sec);
    document.body.insertAdjacentHTML('beforeend', EDIT_HTML + SET_HTML
      + '<input type="file" id="calIcsFile" accept=".ics,text/calendar" hidden>');
    bindAll();
  }

  /* ============ 8. 渲染 ============ */

  function renderAll() {
    renderSum();
    renderGrid();
    renderMoonMonth();
    renderDay();
    renderUpcoming();
  }

  function renderSum() {
    var box = qs('#calSum'), sub = qs('#calSub');
    if (!box) return;
    var info = periodInfo();
    if (!info) {
      box.hidden = true;
      if (sub) sub.textContent = '倒数日 · 生日 · 纪念日 · 经期 · 月相';
      return;
    }
    box.hidden = false;
    var parts = [];
    if (info.inPeriod) parts.push('<b>经期第 ' + info.periodDayNo + ' 天</b>（共 ' + root().period.periodLen + ' 天）');
    else parts.push('距下次经期还有 <b>' + info.toNext + ' 天</b>（' + md(info.nextStart) + '）');
    if (info.toOvu === 0) parts.push('<b>今天可能是排卵日</b>');
    else if (info.toOvu > 0) parts.push('排卵日约在 ' + info.toOvu + ' 天后（' + md(info.ovu) + '）');
    parts.push('本周期第 ' + info.dayInCycle + ' 天 / ' + root().period.cycleLen + ' 天');
    box.innerHTML = parts.join('<br>');
    if (sub) sub.textContent = '倒数日 · 生日 · 纪念日 · 经期 · 月相';
  }

  function renderGrid() {
    var box = qs('#calGrid'), ti = qs('#calTitle');
    if (!box) return;
    var v = calState.view, y = v.getFullYear(), m = v.getMonth();
    var first = new Date(y, m, 1);
    var lead = (first.getDay() + 6) % 7;
    var from = addDays(first, -lead);
    var to = addDays(from, 41);
    var pm = periodMap(from, to);
    var t = today(), html = [], i, moonOn = moonCfg().on;
    for (i = 0; i < 42; i++) {
      var d = addDays(from, i), k = ymd(d), mark = pm[k] || '';
      var items = itemsOn(d);
      var cls = ['cal-cell'];
      if (d.getMonth() !== m) cls.push('out');
      if (sameDay(d, t)) cls.push('today');
      if (sameDay(d, calState.sel)) cls.push('sel');
      if (mark) cls.push('m-' + mark);
      var dots = items.slice(0, 3).map(function (it) {
        return '<i class="cal-dot k-' + esc(it.kind) + '"></i>';
      }).join('');
      var tag = mark === 'p' ? '<span class="cal-tag">经</span>'
        : (mark === 'o' ? '<span class="cal-tag o">排</span>' : '');
      var moon = moonOn ? '<span class="cal-moon">' + moonSvg(11, moonInfo(d)) + '</span>' : '';
      html.push('<button type="button" class="' + cls.join(' ') + '" data-d="' + k + '" aria-label="' + k + '">'
        + moon + '<span class="cal-n">' + d.getDate() + '</span>' + tag
        + '<span class="cal-dots">' + dots + '</span></button>');
    }
    box.innerHTML = html.join('');
    if (ti) ti.textContent = y + ' 年 ' + (m + 1) + ' 月';
  }

  function kindLabel(k) {
    return { countdown: '倒数日', birthday: '生日', once: '日子', anniv: '纪念日', ics: '导入', video: '看视频' }[k] || '日子';
  }

  function rowHTML(it, when) {
    var bits = [];
    if (it.time) bits.push('<span class="cal-t">' + esc(it.time) + '</span>');
    bits.push(esc(kindLabel(it.kind)));
    if (it.who) bits.push('和 ' + esc(it.who));
    if (it.extra) bits.push(esc(it.extra));
    if (when) bits.push(when);
    return '<div class="cal-row">'
      + '<span class="cal-row-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + CAL_ICO + '</svg></span>'
      + '<span class="cal-row-tx"><b>' + esc(it.title) + '</b><small>' + bits.join(' · ') + '</small></span>'
      + (it.own && !it.ics ? '<span class="cal-row-n">改</span>' : '')
      + '</div>';
  }

  function moonCardHTML(d) {
    if (!moonCfg().on) return '';
    var i = moonInfo(d);
    return '<div class="cal-mooncard">'
      + '<span class="cal-moonbig">' + moonSvg(38, i) + '</span>'
      + '<span class="cal-mooncard-tx"><b>' + esc(i.name) + '</b>'
      + '<small>照明 ' + Math.round(i.frac * 100) + '% · 月龄 ' + i.age.toFixed(1) + ' / '
      + i.period.toFixed(2) + ' 天 · ' + (i.waxing ? '盈（渐圆）' : '亏（渐缺）')
      + (i.calib ? ' · 已按你填的满月校准' : '') + '</small>'
      + '<p>' + esc(i.say) + '</p></span></div>';
  }

  function renderMoonMonth() {
    var box = qs('#calMoonMonth'), lab = qs('#calMoonLab');
    if (!box) return;
    if (!moonCfg().on) {
      box.innerHTML = '';
      if (lab) lab.style.display = 'none';
      return;
    }
    if (lab) lab.style.display = '';
    var v = calState.view, list = monthKeyMoons(v.getFullYear(), v.getMonth());
    if (!list.length) { box.innerHTML = '<div class="cal-empty">这个月算不出关键月相</div>'; return; }
    box.innerHTML = list.map(function (k) {
      return '<div class="cal-moonrow"><span class="cal-moonico">' + moonSvg(20, k.info) + '</span>'
        + '<b>' + esc(k.name) + '</b><small>' + (v.getMonth() + 1) + ' 月 ' + k.day + ' 日 '
        + (k.hhmm || '') + ' · 照明 ' + Math.round(k.info.frac * 100) + '%</small></div>';
    }).join('');
  }

  function renderDay() {
    var box = qs('#calDayList'), lab = qs('#calDayLab');
    if (!box) return;
    var d = calState.sel, items = itemsOn(d), pm = periodMap(d, d)[ymd(d)];
    if (lab) lab.innerHTML = (sameDay(d, today()) ? '今天' : md(d)) + ' <i>DAY</i>';
    var extra = [];
    if (pm === 'p') extra.push('经期');
    else if (pm === 'o') extra.push('排卵日');
    else if (pm === 'w') extra.push('易孕窗口');
    var head = moonCardHTML(d)
      + (extra.length ? '<div class="cal-sum" style="margin-top:0">' + extra.join(' · ') + '</div>' : '');
    if (!items.length) {
      box.innerHTML = head + '<div class="cal-empty">这一天还没有安排 · 点上面「＋ 添加日子」</div>';
      return;
    }
    box.innerHTML = head + items.map(function (it) { return rowHTML(it, ''); }).join('');
  }

  function renderUpcoming() {
    var box = qs('#calUpcoming');
    if (!box) return;
    var list = upcoming(8);
    if (!list.length) {
      box.innerHTML = '<div class="cal-empty">还没有即将到来的日子</div>';
      return;
    }
    box.innerHTML = list.map(function (it) {
      var when = it.at === 0 ? '就是今天' : (it.at + ' 天后 · ' + md(it.date));
      return '<div class="cal-row">'
        + '<span class="cal-row-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + CAL_ICO + '</svg></span>'
        + '<span class="cal-row-tx"><b>' + esc(it.title) + '</b><small>'
        + (it.time ? '<span class="cal-t">' + esc(it.time) + '</span> · ' : '')
        + esc(kindLabel(it.kind)) + (it.extra ? ' · ' + esc(it.extra) : '') + ' · ' + md(it.date) + '</small></span>'
        + '<span class="cal-row-n' + (it.at <= 3 ? ' hot' : '') + '">' + (it.at === 0 ? '今天' : it.at + ' 天') + '</span>'
        + '</div>';
    }).join('');
  }

  /* ============ 9. 交互 ============ */

  function openSheet(id) {
    var m = qs('#' + id);
    if (m) m.hidden = false;
  }
  function closeSheet(id) {
    var m = qs('#' + id);
    if (m) m.hidden = true;
  }
  function chipSet(wrapId, val) {
    qsa('#' + wrapId + ' .cal-chip').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.v === val ? 'true' : 'false');
    });
  }
  function chipVal(wrapId, dflt) {
    var on = qs('#' + wrapId + ' .cal-chip[aria-pressed=true]');
    return on ? on.dataset.v : dflt;
  }

  function openEdit(id) {
    var ev = null;
    if (id) ev = root().events.filter(function (x) { return String(x.id) === String(id); })[0] || null;
    calState.editId = ev ? ev.id : '';
    var ti = qs('#calEditTi'), del = qs('#calEvDel');
    if (ti) ti.textContent = ev ? '改这一天' : '添加日子';
    if (del) del.hidden = !ev;
    qs('#calEvTitle').value = ev ? (ev.title || '') : '';
    qs('#calEvDate').value = ev ? String(ev.date || '').slice(0, 10) : ymd(calState.sel);
    var tm = qs('#calEvTime'); if (tm) tm.value = ev ? (ev.time || '') : '';
    qs('#calEvNote').value = ev ? (ev.note || '') : '';
    renderWhoChips(ev ? (ev.who || '') : '');
    chipSet('calEvType', ev ? (ev.type || 'countdown') : 'countdown');
    chipSet('calEvRepeat', ev ? (ev.repeat || (ev.type === 'birthday' ? 'yearly' : 'none')) : 'yearly');
    syncHint();
    openSheet('calEditMask');
  }

  function renderWhoChips(sel) {
    var box = qs('#calEvWho');
    if (!box) return;
    var cs = contactList();
    if (!cs.length) { box.innerHTML = '<span class="cal-note" style="margin:0">还没有联系人</span>'; return; }
    box.innerHTML = '<button type="button" class="cal-chip" data-cid="" aria-pressed="' + (!sel ? 'true' : 'false') + '">不指定</button>'
      + cs.map(function (c) {
        if (!c || !c.id) return '';
        return '<button type="button" class="cal-chip" data-cid="' + esc(c.id) + '" aria-pressed="'
          + (String(sel) === String(c.id) ? 'true' : 'false') + '">' + esc(c.name || '(未命名)')
          + (c.kind === 'group' ? ' · 群' : '') + '</button>';
      }).join('');
  }

  function syncHint() {
    var h = qs('#calEvHint');
    if (!h) return;
    var ty = chipVal('calEvType', 'countdown'), rp = chipVal('calEvRepeat', 'none');
    if (ty === 'video') h.textContent = '看视频：填上几点、和谁，日历格里会多一枚蓝灰点。视频模块发出的邀请、以及 TA 主动约你的时间，也会自动记到这里。';
    else if (ty === 'birthday') h.textContent = '生日默认每年重复，会在日历上标出「几岁」。';
    else if (ty === 'once') h.textContent = '只在那一天出现一次，过了就不再显示。';
    else h.textContent = rp === 'yearly'
      ? '倒数日按每年重复：每年都会出现，显示「还有 N 天」。'
      : '倒数日只算一次：过了那一天就不再出现在「接下来的日子」里。';
  }

  function saveEdit() {
    var title = (qs('#calEvTitle').value || '').trim();
    var dateV = qs('#calEvDate').value;
    var d = parseYmd(dateV);
    if (!title) { toast('先给它起个名字'); return; }
    if (!d) { toast('日期没填对'); return; }
    var ty = chipVal('calEvType', 'countdown');
    var rp = ty === 'birthday' ? 'yearly' : chipVal('calEvRepeat', 'none');
    var note = (qs('#calEvNote').value || '').trim();
    var timeV = (qs('#calEvTime') && qs('#calEvTime').value) || '';
    var whoV = '';
    var whoOn = qs('#calEvWho .cal-chip[aria-pressed=true]');
    if (whoOn) whoV = whoOn.dataset.cid || '';
    var c = root();
    if (calState.editId) {
      c.events.forEach(function (x) {
        if (String(x.id) === String(calState.editId)) {
          x.title = title; x.date = ymd(d); x.type = ty; x.repeat = rp; x.note = note;
          x.time = timeV; x.who = whoV;
        }
      });
    } else {
      c.events.push({ id: nid(), title: title, date: ymd(d), type: ty, repeat: rp, note: note, time: timeV, who: whoV });
    }
    persist();
    closeSheet('calEditMask');
    calState.sel = d;
    calState.view = new Date(d.getFullYear(), d.getMonth(), 1);
    renderAll();
    toast(calState.editId ? '改好了' : '加上了');
    calState.editId = '';
  }

  function delEdit() {
    if (!calState.editId) return;
    var id = calState.editId;
    var doIt = function () {
      var c = root();
      c.events = c.events.filter(function (x) { return String(x.id) !== String(id); });
      persist();
      closeSheet('calEditMask');
      calState.editId = '';
      renderAll();
      toast('删掉了');
    };
    try {
      if (typeof window.openModal === 'function') {
        window.openModal('删除这一天', '', function () { doIt(); },
          { noInput: true, staticText: '确定删掉这条日子吗？删了不能撤销。', okText: '删掉', danger: true });
        return;
      }
    } catch (e) {}
    if (window.confirm('确定删掉这条日子吗？')) doIt();
  }

  function openSet() {
    var p = root().period, mo = moonCfg();
    chipSet('calMoonOn', mo.on ? 'on' : 'off');
    chipSet('calMoonMode', mo.mode);
    qs('#calMoonF1').value = mo.full1 || '';
    qs('#calMoonF2').value = mo.full2 || '';
    chipSet('calPOn', p.on ? 'on' : 'off');
    qs('#calPLast').value = p.lastStart || '';
    qs('#calPCycle').value = p.cycleLen;
    qs('#calPLen').value = p.periodLen;
    qs('#calPLut').value = p.luteal;
    var n = root().ics.length;
    var st = qs('#calIcsStat');
    if (st) st.textContent = n ? ('已导入 ' + n + ' 条。') : '还没有导入过。';
    openSheet('calSetMask');
  }

  function saveSet() {
    var c = root();
    var on = chipVal('calPOn', 'off') === 'on';
    var d = parseYmd(qs('#calPLast').value);
    var cyc = Math.min(45, Math.max(21, Number(qs('#calPCycle').value) || 28));
    var len = Math.min(10, Math.max(2, Number(qs('#calPLen').value) || 5));
    var lut = Math.min(16, Math.max(10, Number(qs('#calPLut').value) || 14));
    if (on && !d) { toast('要开启的话，得填上次经期的首日'); return false; }
    c.period.on = on;
    c.period.lastStart = d ? ymd(d) : '';
    c.period.cycleLen = cyc;
    c.period.periodLen = len;
    c.period.luteal = lut;
    var mo = c.moon;
    mo.on = chipVal('calMoonOn', 'on') === 'on';
    mo.mode = chipVal('calMoonMode', 'auto') === 'calib' ? 'calib' : 'auto';
    var f1 = parseYmd(qs('#calMoonF1').value), f2 = parseYmd(qs('#calMoonF2').value);
    mo.full1 = f1 ? ymd(f1) : '';
    mo.full2 = f2 ? ymd(f2) : '';
    if (mo.mode === 'calib') {
      var gap = (f1 && f2) ? Math.abs(dayDiff(f1, f2)) : 0;
      if (gap < 20 || gap > 40) toast('两个满月日期要相差 20–40 天才认；现在仍按自动推算显示');
    }
    persist();
    renderAll();
    return true;
  }

  function importIcs(file) {
    if (!file) return;
    var rd = new FileReader();
    rd.onload = function () {
      var r = parseIcs(String(rd.result || ''));
      if (!r.ok.length) {
        toast(r.skipped ? ('没导入进来 · 跳过了 ' + r.skipped + ' 条（' + (r.badRule ? r.badRule + ' 条重复规则不支持，' : '') + (r.noDate ? r.noDate + ' 条没日期' : '') + '）') : '这个文件里没有找到日程');
        return;
      }
      var c = root();
      var seen = {};
      c.ics.forEach(function (e) { seen[e.start + '|' + e.title] = 1; });
      var added = 0;
      r.ok.forEach(function (e) {
        var k = e.start + '|' + e.title;
        if (seen[k]) return;
        seen[k] = 1;
        c.ics.push(e);
        added++;
      });
      persist();
      renderAll();
      var st = qs('#calIcsStat');
      if (st) st.textContent = '已导入 ' + c.ics.length + ' 条（这次新增 ' + added + ' 条，重复的自动跳过了）。';
      toast('导入 ' + added + ' 条' + (r.skipped ? (' · 跳过 ' + r.skipped + ' 条') : ''));
    };
    rd.onerror = function () { toast('这个文件读不出来'); };
    try { rd.readAsText(file, 'utf-8'); } catch (e) { toast('这个文件读不出来'); }
  }

  function bindAll() {
    var grid = qs('#calGrid');
    if (grid) grid.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.cal-cell') : null;
      if (!b) return;
      var d = parseYmd(b.dataset.d);
      if (!d) return;
      calState.sel = d;
      renderGrid();
      renderDay();
    });

    var pv = qs('#calPrev'), nx = qs('#calNext'), td = qs('#calToday');
    if (pv) pv.addEventListener('click', function () { shiftMonth(-1); });
    if (nx) nx.addEventListener('click', function () { shiftMonth(1); });
    if (td) td.addEventListener('click', function () {
      calState.view = today(); calState.sel = today(); renderAll();
    });

    var add = qs('#calAddBtn');
    if (add) add.addEventListener('click', function () { openEdit(''); });
    var st = qs('#calSetBtn');
    if (st) st.addEventListener('click', function () { openSet(); });

    var dl = qs('#calDayList');
    if (dl) dl.addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('.cal-row') : null;
      if (!row) return;
      var d = calState.sel, items = itemsOn(d);
      var i = qsa('.cal-row', dl).indexOf(row);
      if (i >= 0 && items[i] && items[i].own && !items[i].ics) openEdit(items[i].id);
      else if (i >= 0 && items[i] && items[i].ics) openSet();
      else if (i >= 0 && items[i]) toast('纪念日请回「纪念日」那一页改');
    });

    ['calEvType', 'calEvRepeat'].forEach(function (id) {
      var w = qs('#' + id);
      if (w) w.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.cal-chip') : null;
        if (!b) return;
        chipSet(id, b.dataset.v);
        if (id === 'calEvType' && b.dataset.v === 'birthday') chipSet('calEvRepeat', 'yearly');
        syncHint();
      });
    });

    var who = qs('#calEvWho');
    if (who) who.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.cal-chip') : null;
      if (!b) return;
      qsa('#calEvWho .cal-chip').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    });
    var tc = qs('#calEvTimeClear');
    if (tc) tc.addEventListener('click', function () { var t = qs('#calEvTime'); if (t) t.value = ''; });

    var es = qs('#calEvSave'); if (es) es.addEventListener('click', saveEdit);
    var ed = qs('#calEvDel'); if (ed) ed.addEventListener('click', delEdit);
    var ec = qs('#calEditClose'); if (ec) ec.addEventListener('click', function () { closeSheet('calEditMask'); });

    var pw = qs('#calPOn');
    if (pw) pw.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.cal-chip') : null;
      if (b) chipSet('calPOn', b.dataset.v);
    });
    ['calMoonOn', 'calMoonMode'].forEach(function (wid) {
      var w = qs('#' + wid);
      if (!w) return;
      w.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.cal-chip') : null;
        if (b) chipSet(wid, b.dataset.v);
      });
    });

    var sc = qs('#calSetClose');
    if (sc) sc.addEventListener('click', function () { if (saveSet() !== false) closeSheet('calSetMask'); });

    var ip = qs('#calIcsPick'), ifl = qs('#calIcsFile');
    if (ip && ifl) {
      ip.addEventListener('click', function () { ifl.value = ''; ifl.click(); });
      ifl.addEventListener('change', function () {
        var f = ifl.files && ifl.files[0];
        if (f) importIcs(f);
      });
    }
    var ic = qs('#calIcsClear');
    if (ic) ic.addEventListener('click', function () {
      var c = root();
      if (!c.ics.length) { toast('本来就没有导入的'); return; }
      var n = c.ics.length;
      c.ics = [];
      persist();
      renderAll();
      var s = qs('#calIcsStat');
      if (s) s.textContent = '已清空（删掉了 ' + n + ' 条）。';
      toast('清空了 ' + n + ' 条导入的日程');
    });

    [qs('#calEditMask'), qs('#calSetMask')].forEach(function (m) {
      if (!m) return;
      m.addEventListener('click', function (e) {
        if (e.target !== m) return;
        if (m.id === 'calSetMask' && saveSet() === false) return;
        m.hidden = true;
      });
    });
  }

  function shiftMonth(n) {
    var v = calState.view;
    calState.view = new Date(v.getFullYear(), v.getMonth() + n, 1);
    var s = new Date(calState.view.getFullYear(), calState.view.getMonth(), 1);
    calState.sel = new Date(s.getFullYear(), s.getMonth(), Math.min(calState.sel.getDate(), new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate()));
    renderGrid();
    renderDay();
  }

  /* ============ 10. 接进站内：路由 + 更多页磁贴 ============ */

  /* 保险：万一站内 .home-greet 之类的样式把这一行压扁或裁掉，量一下就强行撑开 */
  function ensureBar() {
    var bar = qs('.cal-bar');
    if (!bar) return;
    try {
      var r = bar.getBoundingClientRect();
      if (!r || r.height < 4) {
        bar.style.cssText = 'display:flex !important;position:relative !important;z-index:9;'
          + 'overflow:visible !important;height:auto !important;opacity:1 !important;visibility:visible !important';
      }
    } catch (e) {}
  }

  function calOpen() {
    var sec = qs('#calendarView');
    if (!sec) { injectDom(); sec = qs('#calendarView'); }
    if (!sec) return;
    if (!siteReady()) { toast('数据还没载入完，稍等一下再点'); return; }
    var prev = document.body.dataset.view || '';
    qsa('.view').forEach(function (v) {
      v.classList.toggle('active', v.id === 'calendarView');
      v.classList.remove('no-anim');
    });
    qsa('[data-view]').forEach(function (b) {
      if (b.id === 'backChatsBtn' || b.id === 'topbarTitle') return;
      b.classList.toggle('active', b.dataset.view === 'calendar');
    });
    document.body.dataset.view = 'calendar';
    try {
      if (prev && prev !== 'calendar' && typeof _navStack !== 'undefined' && _navStack && _navStack.push) {
        _navStack.push(prev);
      }
    } catch (e) {}
    try { if (typeof _setBackTarget === 'function') _setBackTarget('calendar'); } catch (e) {}
    try { if (typeof updateTopbarTitle === 'function') updateTopbarTitle('calendar'); } catch (e) {}
    var tt = qs('#topbarTitleText');
    if (tt) tt.textContent = '日历';
    calState.sel = today();
    calState.view = today();
    renderAll();
    ensureBar();
    try { sec.scrollTop = 0; } catch (e2) {}
  }

  function hookRouter() {
    try {
      if (typeof window.showView !== 'function' || window.showView.__calWrapped) return;
      var orig = window.showView;
      var wrap = function (name) {
        if (name === 'calendar') { calOpen(); return; }
        return orig.apply(this, arguments);
      };
      wrap.__calWrapped = 1;
      window.showView = wrap;
    } catch (e) {}
  }

  function hookTile() {
    try {
      if (typeof HUB_GROUPS === 'undefined' || !HUB_GROUPS || !HUB_GROUPS.length) return;
      var dup = false;
      HUB_GROUPS.forEach(function (g) {
        (g.rows || []).forEach(function (r) { if (r && r.nav === 'calendar') dup = true; });
      });
      if (dup) return;
      var host = null;
      for (var i = 0; i < HUB_GROUPS.length; i++) {
        if (HUB_GROUPS[i] && HUB_GROUPS[i].name === '记录') { host = HUB_GROUPS[i]; break; }
      }
      if (!host) host = HUB_GROUPS[HUB_GROUPS.length - 1];
      if (!host || !host.rows) return;
      host.rows.push({
        ico: CAL_ICO,
        name: '日历',
        desc: '倒数日、生日、纪念日与经期一起看；可导入 .ics',
        nav: 'calendar',
        more: { o: 6, d: '倒数日 · 生日 · 经期' }
      });
      if (typeof renderMorePage === 'function') renderMorePage();
      hookMoreClicks();
      if (typeof renderHubPage === 'function' && document.body.dataset.view === 'hub') renderHubPage();
    } catch (e) {}
  }

  /* app.js 第 49663-49672 行是「逐个元素」给 [data-view] 绑点击、且只在加载时绑一次。
   * 上面 renderMorePage() 会把 #moreList 里的按钮整批换新，原有绑定随之丢失，
   * 所以这里在容器上补一个委托监听：重画多少次都不会掉，顺带把其它磁贴一起接回来。 */
  function hookMoreClicks() {
    try {
      var list = document.getElementById('moreList');
      if (!list || list.dataset.calBound === '1') return;
      list.dataset.calBound = '1';
      list.addEventListener('click', function (e) {
        var b = (e.target && e.target.closest) ? e.target.closest('[data-view]') : null;
        if (!b || !list.contains(b)) return;
        var v = b.dataset.view;
        if (!v) return;
        if (v.charAt(0) === '#' && typeof _hubRoute === 'function') {
          try { _hubRoute(v); } catch (err) {}
          return;
        }
        if (typeof window.showView === 'function') window.showView(v);
      });
    } catch (e) {}
  }

  /* ============ 11. 启动 ============ */

  function boot() {
    try { injectStyle(); injectDom(); hookRouter(); hookTile(); hookMoreClicks(); } catch (e) {
      try { console.warn('[日历模块] 初始化失败', e); } catch (e2) {}
    }
  }

  function onReady() {
    try { mergeFallback(); hookTile(); hookMoreClicks(); } catch (e) {}
  }

  boot();
  try { document.addEventListener('ordinal-data-ready', onReady); } catch (e) {}
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); onReady(); });
  } else {
    onReady();
  }
  try {
    window.__calModuleReady = CAL_VER;
    /* 调试与自检钩子：控制台敲 __calSelfTest() 打印一份体检结果 */
    window.__calDebug = {
      periodMap: periodMap, periodInfo: periodInfo, parseIcs: parseIcs,
      itemsOn: itemsOn, upcoming: upcoming, root: root,
      whoName: whoName, contactList: contactList, kindLabel: kindLabel, rowHTML: rowHTML,
      moonInfo: moonInfo, moonPhaseFrac: moonPhaseFrac, moonPeriodNow: moonPeriodNow,
      monthKeyMoons: monthKeyMoons, moonPhaseInstants: moonPhaseInstants, moonLitPath: moonLitPath, moonSvg: moonSvg,
      ymd: ymd, parseYmd: parseYmd, addDays: addDays, dayDiff: dayDiff, today: today
    };
    window.__calSelfTest = function () {
      var out = { 模块版本: CAL_VER, 站点data就绪: siteReady() };
      try {
        out.日子条数 = root().events.length;
        out.导入条数 = root().ics.length;
        out.经期开启 = !!root().period.on;
      } catch (e) { out.数据层 = '读取失败 ' + e; }
      try { out.今天 = ymd(today()); out.今天条目数 = itemsOn(today()).length; } catch (e2) { out.渲染层 = '失败 ' + e2; }
      try {
        out.带时间的约定 = root().events.filter(function (x) { return x && x.time; }).length;
        out.看视频约定 = root().events.filter(function (x) { return x && x.type === 'video'; }).length;
      } catch (e9) {}
      try { out.经期信息 = periodInfo() ? '有' : '未开启或未填首日'; } catch (e3) { out.经期 = '失败 ' + e3; }
      try {
        var mi = moonInfo(today());
        out.今天月相 = mi.name + ' · 照明 ' + Math.round(mi.frac * 100) + '% · 月龄 ' + mi.age.toFixed(1) + ' 天';
        out.月相周期 = mi.period.toFixed(3) + ' 天' + (mi.calib ? '（已校准）' : '（天文推算）');
        out.本月关键月相 = monthKeyMoons(today().getFullYear(), today().getMonth())
          .map(function (k) { return k.name + ' ' + k.day + '日'; }).join(' / ');
      } catch (e8) { out.月相 = '失败 ' + e8; }
      try { out.视图已注入 = !!document.getElementById('calendarView'); } catch (e4) {}
      try { out.路由已接管 = !!(window.showView && window.showView.__calWrapped); } catch (e5) {}
      try {
        out.磁贴已加入 = (typeof HUB_GROUPS !== 'undefined') && HUB_GROUPS.some(function (g) {
          return (g.rows || []).some(function (r) { return r && r.nav === 'calendar'; });
        });
      } catch (e6) {}
      try { if (console.table) console.table(out); else console.log(out); } catch (e7) {}
      return out;
    };
  } catch (e) {}
})();
