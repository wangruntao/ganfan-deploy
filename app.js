/* 今天吃什么 · 桌面管理后台
   ---------------------------------------------------------------
   结构：state → mock 数据 → 接入层 api → 渲染 → 事件
   接入层集中在 api 对象里，字段形状与 cloudfunctions/adminApi 一致，
   后面把 api 的实现换成真实 cloudFunction 调用即可，渲染逻辑不用动。
*/

const ENV_ID = 'today-eat-d1g9okcsi57960feb';

const state = {
  tab: 'stat',
  page: 1,
  size: 10,
  keyword: '',
  scope: 'all',
  rows: [],
  total: 0,
  fbScope: 'open',
  editing: null,
  stats: null,
  me: null,
  /** 菜谱库勾选中的 id（只存当前页，翻页/筛选即清空，避免跨页误改） */
  selected: [],
  /** 账号弹层模式：add（新增）/ reset（重置他人密码） */
  accMode: 'add',
  accTarget: null,
  /** 操作日志：独立分页与筛选，不复用菜谱库那套 */
  log: { page: 1, size: 20, action: 'all', keyword: '' },
  /** 会员：子 tab / 码列表分页与筛选 / 勾选 / 最近一批（生成后可一键复制） */
  memberSub: 'codes',
  code: { page: 1, size: 20, status: '', batch: '' },
  codeSelected: [],
  lastBatch: null,
  member: { page: 1, size: 20, keyword: '' }
};

/* 口味分布（接入后按 public 菜谱库实时聚合 groupBy taste） */
const TASTE_COLORS = {
  '家常': '#FF8A2B',
  '鲜辣': '#FF5B4A',
  '清淡': '#37BE7B',
  '酸甜': '#FFC46B',
  '咸香': '#8C6A4F'
};

/* ---------------------------------------------------------------- 接入层 */

/**
 * 真实后端：云开发 HTTP 网关 → adminApi 云函数。
 *
 * 为什么不用 @cloudbase/js-sdk：
 *   浏览器里没有微信 openid，SDK 的登录态体系（匿名/用户名密码）与本项目
 *   的 openid 白名单是两套身份，接入反而多一层。这里用网关把云函数暴露成
 *   HTTPS 接口，POST JSON + Bearer token，鉴权完全由云函数签名校验，
 *   前端只负责保存 token。
 *
 * token 存 localStorage：刷新页面不掉登录；退出登录即清除。
 * 有效期由服务端决定（12 小时 / 记住我 7 天），过期后任何请求返回
 * UNAUTHORIZED，这里统一清 token 并弹回登录页。
 */
const API_BASE = 'https://today-eat-d1g9okcsi57960feb-1529065185.ap-shanghai.app.tcloudbase.com/api';
const TOKEN_KEY = 'today_eat_admin_token';

/** 带 code 的错误，页面按 code 分型提示（401 / 弱密码 / 重名 …） */
class ApiError extends Error {
  constructor(code, message) {
    super(message || '操作失败');
    this.code = code || 'FAIL';
  }
}

const api = {
  get token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  },
  setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 隐私模式下 localStorage 不可用，退化为内存态 */ }
    this._mem = t || '';
  },

  async call(action, payload) {
    const body = Object.assign({ action: action }, payload || {});
    const headers = { 'content-type': 'application/json' };
    const tk = this.token || this._mem;
    if (tk) headers.authorization = 'Bearer ' + tk;

    let res;
    try {
      res = await fetch(API_BASE, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new ApiError('NETWORK', '网络连接失败，请检查网络后重试');
    }

    // 服务端现在会按业务结果返回 4xx/5xx（便于网关与监控按状态码告警），
    // 但响应体结构没变——所以先解析 body，有 code 就按 code 处理，别被状态码提前打断
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!data) {
      if (!res.ok) throw new ApiError('HTTP_' + res.status, '服务异常（HTTP ' + res.status + '）');
      throw new ApiError('BAD_JSON', '服务返回格式异常');
    }

    if (!data.ok) {
      // 登录过期：清 token 并回到登录页，避免用户对着空列表反复点
      if (data.code === 'UNAUTHORIZED') {
        api.setToken('');
        if (typeof onSessionLost === 'function') onSessionLost(data.message);
      }
      throw new ApiError(data.code, data.message);
    }
    return data;
  },

  /* 账号密码登录 → 服务端签发 token */
  async login(username, password, remember) {
    const r = await this.call('login', { username: username, password: password, remember: !!remember });
    this.setToken(r.token);
    return r;
  },

  whoami() { return this.call('whoami'); },
  stats() { return this.call('stats'); },
  dashboard() { return this.call('dashboard'); },

  async foods({ page, size, keyword, scope }) {
    const r = await this.call('foods', { page: page, size: size, keyword: keyword || '', scope: scope || 'all' });
    return { ok: true, total: r.total, page: r.page, size: r.size, rows: r.list };
  },

  foodSave(food) {
    return this.call('foodSave', { id: food.id || '', data: food });
  },

  foodHidden(id, hidden) {
    return this.call('foodHidden', { id: id, hidden: !!hidden });
  },

  foodBatch(items) {
    return this.call('foodBatch', { items: items });
  },

  async quotaSearch(keyword) {
    const r = await this.call('quotaSearch', { keyword: keyword });
    return { ok: true, rows: r.list, today: r.today };
  },

  quotaAdjust(openid, field, delta, daily) {
    return this.call('quotaAdjust', { openid: openid, field: field, delta: delta, daily: daily });
  },

  async feedbackList(scope) {
    const r = await this.call('feedbackList', { page: 1, size: 20, scope: scope === 'open' ? 'open' : 'all' });
    return { ok: true, rows: r.list, total: r.total };
  },

  feedbackHandle(id, handled) {
    return this.call('feedbackHandle', { id: id, handled: !!handled });
  },

  /* 菜谱批量操作：op = hide | show | budget | taste；ids 上限 50（服务端同限制） */
  foodBatchOps(ids, op, value) {
    return this.call('foodBatchOps', { ids: ids, op: op, value: value });
  },

  /* ---------------- 账号管理（仅 Web 通道） ---------------- */
  adminUsers() {
    return this.call('adminUsers');
  },
  adminUserAdd(username, password, avatar) {
    const data = { username: username, password: password };
    if (avatar !== undefined && avatar !== '') data.avatar = avatar;
    return this.call('adminUserAdd', data);
  },
  adminUserUpdate(id, disabled, avatar) {
    const data = { id: id, disabled: !!disabled };
    if (avatar !== undefined) data.avatar = avatar;
    return this.call('adminUserUpdate', data);
  },
  adminUserResetPwd(id, newPassword) {
    return this.call('adminUserResetPwd', { id: id, newPassword: newPassword });
  },
  adminUserDelete(id) {
    return this.call('adminUserDelete', { id: id });
  },
  /** 解除登录节流：清该账号在所有 IP 上的失败记录 + 本机 IP 的总计数 */
  loginUnlock(username) {
    return this.call('loginUnlock', { username: username || '' });
  },

  changePwd(oldPassword, newPassword) {
    return this.call('changePwd', { oldPassword: oldPassword, newPassword: newPassword });
  },

  /** 上传菜品图：走云函数写云存储，返回可持久保存的 fileID */
  uploadImage({ base64, ext }) {
    return this.call('upload', { base64: base64, ext: ext || 'jpg' });
  },

  /**
   * 操作日志：服务端已按 whitelist 脱敏（不含密码/token/base64），这里只管分页与筛选。
   * filter.action = 'all' 表示不筛；keyword 同时匹配操作人 / 对象 / 说明 / IP。
   */
  auditList({ page, size, actionType, keyword }) {
    // 筛选字段叫 actionType 而不是 action：action 是分发字段，同名会被覆盖
    return this.call('auditList', {
      page: page || 1,
      size: size || 20,
      actionType: actionType || 'all',
      keyword: keyword || ''
    });
  },

  /* 图片台账：看清楚云存储里有多少张、多少张已经没人用 */
  mediaStats() { return this.call('mediaStats'); },
  mediaClean() { return this.call('mediaClean'); },

  /* 看板增强：用户盘子 / 热门菜 Top10 / AI 用量构成 */
  dashboardExtra() { return this.call('dashboardExtra'); },

  /* 安全面板：登录封锁现状 / 今日登录失败 / 最近失败操作 */
  securitySummary() { return this.call('securitySummary'); },

  /* 导出：服务端生成 CSV 文本，前端负责落盘 */
  exportCsv(type) { return this.call('exportCsv', { type: type }); },

  /* 会员：发码 / 作废 / 会员列表 / 手动授予 */
  memberCodes(o) {
    const p = o || {};
    return this.call('memberCodes', {
      page: p.page || 1, size: p.size || 20, status: p.status || '', batch: p.batch || ''
    });
  },
  memberCodeGen(o) {
    const p = o || {};
    return this.call('memberCodeGen', { plan: p.plan, count: p.count, note: p.note || '' });
  },
  memberCodeDisable(ids) { return this.call('memberCodeDisable', { ids: ids }); },
  memberUsers(o) {
    const p = o || {};
    return this.call('memberUsers', { page: p.page || 1, size: p.size || 20, keyword: p.keyword || '' });
  },
  memberGrant(openid, plan) { return this.call('memberGrant', { openid: openid, plan: plan }); },
  memberRevoke(openid) { return this.call('memberRevoke', { openid: openid }); }
};

/* 图片地址解析：
   ① 云端已换成临时 https 链接（imgUrl）优先
   ② https 外链直接用
   ③ 包内文件名 → 静态托管下的 assets/dishes/
   ④ 其它（cloud:// 换链接失败）→ 本地占位图，保证不出现破图 */
const PLACEHOLDER_IMG = 'assets/dishes/dish-01.jpg';

function imgSrc(f) {
  if (!f) return PLACEHOLDER_IMG;
  if (f.imgUrl) return f.imgUrl;
  const v = String(f.img || '');
  if (/^https:\/\//i.test(v)) return v;
  if (/^[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp|gif)$/i.test(v)) return 'assets/dishes/' + v;
  return PLACEHOLDER_IMG;
}

/* ---------------------------------------------------------------- 小工具 */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

let toastTimer = null;
function toast(msg, bad) {
  const el = $('toast');
  el.innerHTML = `<svg aria-hidden="true"><use href="#${bad ? 'i-close' : 'i-check'}"/></svg><span>${esc(msg)}</span>`;
  el.classList.toggle('bad', !!bad);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------------------------------------------------------------- 页面切换 */

const TITLES = {
  stat: ['概览', '今天的运营概览与待办'],
  foods: ['菜谱库', '维护公共菜品：内容、图片与上下架'],
  quota: ['用户与配额', '查询用户，调整每日 AI 生成次数'],
  feedback: ['反馈', '查看用户对 AI 结果的评价并及时处理'],
  users: ['账号管理', '管理可登录本后台的账号与密码'],
  member: ['会员', '发放兑换码、查看会员用户与手动授予'],
  security: ['安全面板', '登录封锁现状与异常操作一览'],
  log: ['操作日志', '谁在什么时候改了什么，全部留痕']
};

const TABS = ['stat', 'foods', 'quota', 'member', 'feedback', 'users', 'security', 'log'];

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#nav .nav-item').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  TABS.forEach((t) => { $('tab-' + t).hidden = t !== tab; });
  $('pageTitle').textContent = TITLES[tab][0];
  $('pageSub').textContent = TITLES[tab][1];
  $('pageCrumb').textContent = TITLES[tab][0];
  $('content').scrollTop = 0;

  if (tab === 'stat') {
    loadStats();
    loadMediaStats();
  }
  if (tab === 'foods') loadFoods();
  if (tab === 'feedback') loadFeedback(state.fbScope);
  if (tab === 'member') syncMemberSub();
  if (tab === 'users') loadAdminUsers();
  if (tab === 'security') loadSecurity();
  if (tab === 'log') loadAudit();
}

/* ---------------------------------------------------------------- 概览 */

function deltaHtml(now, avg) {
  if (!avg) return '<span class="delta flat">暂无对比</span>';
  const p = Math.round(((now - avg) / avg) * 100);
  if (p === 0) return '<span class="delta flat">与日均持平</span>';
  return `<span class="delta ${p > 0 ? 'up' : 'down'}">${p > 0 ? '↑' : '↓'} ${Math.abs(p)}%</span>`;
}

async function loadStats() {
  let r, d;
  try {
    // stats 给今日/本周汇总，dashboard 给趋势与口味分布（同一次点击并发拉取）
    [r, d] = await Promise.all([api.stats(), api.dashboard()]);
  } catch (e) {
    toast(e.message, true);
    return;
  }
  state.stats = r;

  const avgDraw = r.week.draws / 7;
  const avgAi = r.week.ai / 7;

  $('stDraw').innerHTML = `${r.today.draws}<small>次</small>`;
  $('stDrawFoot').innerHTML = `${deltaHtml(r.today.draws, avgDraw)} <span>较日均 ${Math.round(avgDraw)} 次</span>`;

  $('stAi').innerHTML = `${r.today.ai}<small>次</small>`;
  $('stAiFoot').innerHTML = `${deltaHtml(r.today.ai, avgAi)} <span>较日均 ${Math.round(avgAi)} 次</span>`;

  $('stActive').innerHTML = `${r.today.activeUsers}<small>人</small>`;
  $('stActiveFoot').innerHTML = `<span>累计注册 ${r.totals.users} 人</span>`;

  $('stFoods').innerHTML = `${r.totals.foods}<small>道</small>`;
  $('stFoodsFoot').innerHTML = r.totals.hiddenFoods
    ? `<span class="tag tag-off">已下架 ${r.totals.hiddenFoods} 道</span>`
    : '<span>全部在架</span>';

  // 反馈角标
  const badge = $('navFbBadge');
  if (r.totals.badFeedback > 0) {
    badge.textContent = r.totals.badFeedback;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }

  renderTrend(d.trend);
  renderDonut(d.taste);
  loadDashFeedback();
  // 看板增强是锦上添花：单独拉取单独渲染，失败不影响主看板
  api.dashboardExtra().then(renderDashExtra).catch(() => { renderDashExtra(null); });

  const warn = d.truncated ? '<span class="pill pill-warn">数据量超出统计上限</span>' : '';
  $('pageActs').innerHTML = `${warn}<span class="pill">数据日期 ${esc(r.date)}</span>
    <button class="btn" id="btnRefreshStat"><svg aria-hidden="true"><use href="#i-refresh"/></svg>刷新数据</button>`;
  $('btnRefreshStat').addEventListener('click', () => { loadStats(); loadMediaStats(); });
}

/* 看板增强卡片：用户盘子 / 热门菜 Top10 / AI 用量构成（数据拉不到时给占位文案） */
function renderDashExtra(x) {
  const u = x && x.users;
  if (!u) {
    $('ueTotal').textContent = '—';
    ['ueToday', 'ueWeek', 'ueActive', 'ueMembers'].forEach((id) => { $(id).textContent = '—'; });
    $('ueHint').textContent = '看板增强数据加载失败，点「刷新数据」重试';
    $('topDishList').innerHTML = '<div class="hint">暂无数据</div>';
    $('aiMixBar').innerHTML = '';
    $('aiMixText').textContent = '—';
    return;
  }
  $('ueTotal').innerHTML = `${u.total}<small>人</small>`;
  $('ueToday').textContent = '+' + (u.today || 0);
  $('ueWeek').textContent = '+' + (u.week || 0);
  $('ueActive').textContent = u.active7 || 0;
  $('ueMembers').textContent = u.members || 0;
  $('ueHint').textContent = '近 7 日活跃 = 抽过签或用过 AI 的去重人数';

  const dishes = x.topDishes || [];
  const maxN = dishes.length ? dishes[0].n : 0;
  $('topDishList').innerHTML = dishes.length
    ? dishes.map((d, i) => `
      <div class="dish-rank">
        <span class="rank-no rank-${i === 0 ? '1' : i === 1 ? '2' : i === 2 ? '3' : 'n'}">${i + 1}</span>
        <span class="rank-name">${esc(d.name)}</span>
        <span class="rank-bar"><i style="width:${maxN ? Math.round((d.n / maxN) * 100) : 0}%"></i></span>
        <span class="rank-n">${d.n} 次</span>
      </div>`).join('')
    : '<div class="hint">近 7 日还没有抽签记录</div>';

  const m = x.aiMix || { meal: 0, week: 0 };
  const totalAi = m.meal + m.week;
  const wp = totalAi ? Math.round((m.week / totalAi) * 100) : 0;
  $('aiMixBar').innerHTML = totalAi
    ? `<i class="mix-meal" style="width:${100 - wp}%"></i><i class="mix-week" style="width:${wp}%"></i>`
    : '';
  $('aiMixText').innerHTML = totalAi
    ? `单餐 <b>${m.meal}</b> 次 · 周计划 <b>${m.week}</b> 次（周计划占 ${wp}%）`
    : '近 7 日没有 AI 生成记录';
}

/* 折线图：纯 SVG，无第三方库（后台要能离线部署到静态托管）
   宽度按容器实测，窗口变化时重绘，避免 viewBox 拉伸导致线宽变形 */
let trendRows = [];

function renderTrend(rows) {
  trendRows = rows || [];
  const svg = $('trendSvg');
  if (!svg) return;

  const W = Math.max(360, svg.parentElement.clientWidth || 640);
  const H = 232;
  const pad = { l: 40, r: 14, t: 16, b: 28 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);

  const maxV = Math.max(...trendRows.map((r) => Math.max(r.draw, r.ai)));
  const step = Math.max(10, Math.ceil(maxV / 4 / 10) * 10);
  const top = step * 4;

  const x = (i) => pad.l + (iw * i) / Math.max(1, trendRows.length - 1);
  const y = (v) => pad.t + ih - (ih * v) / top;

  // 横向网格 + y 轴刻度
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = step * i;
    const gy = y(v);
    grid += `<line x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}" stroke="#F4ECE0" stroke-width="1"/>`;
    grid += `<text x="${pad.l - 10}" y="${gy + 4}" text-anchor="end" font-size="10.5" fill="#A99A8C">${v}</text>`;
  }

  // 平滑路径（Catmull-Rom → 三次贝塞尔）
  const smooth = (key) => {
    const pts = trendRows.map((r, i) => [x(i), y(r[key])]);
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  };

  const dDraw = smooth('draw');
  const dAi = smooth('ai');
  const areaDraw = `${dDraw} L ${x(trendRows.length - 1)} ${pad.t + ih} L ${pad.l} ${pad.t + ih} Z`;

  const dots = trendRows.map((r, i) =>
    `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10.5" fill="#A99A8C">${r.d}</text>`).join('');

  svg.innerHTML = `
    <defs>
      <linearGradient id="gDraw" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FF8A2B" stop-opacity="0.20"/>
        <stop offset="100%" stop-color="#FF8A2B" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}
    <path d="${areaDraw}" fill="url(#gDraw)"/>
    <path d="${dAi}" fill="none" stroke="#37BE7B" stroke-width="2" stroke-linecap="round" stroke-dasharray="5 4"/>
    <path d="${dDraw}" fill="none" stroke="#FF8A2B" stroke-width="2.4" stroke-linecap="round"/>
    <circle id="tDot" r="4.5" fill="#fff" stroke="#FF8A2B" stroke-width="2.4" opacity="0"/>
    <line id="tLine" y1="${pad.t}" y2="${pad.t + ih}" stroke="#FF8A2B" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
    ${dots}
    <rect id="tHit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent" style="cursor:crosshair"/>`;

  // 悬停提示
  const tip = $('trendTip');
  const hit = svg.querySelector('#tHit');
  const dot = svg.querySelector('#tDot');
  const line = svg.querySelector('#tLine');

  const onMove = (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    let i = Math.round((px - pad.l) / (iw / Math.max(1, trendRows.length - 1)));
    i = Math.max(0, Math.min(trendRows.length - 1, i));
    const r = trendRows[i];
    const cx = x(i);
    const cy = y(r.draw);

    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    dot.setAttribute('opacity', '1');
    line.setAttribute('x1', cx);
    line.setAttribute('x2', cx);
    line.setAttribute('opacity', '1');

    tip.innerHTML = `<div style="font-weight:700;margin-bottom:3px">${r.d}</div>
      <div class="row"><span class="k">抽签</span><span class="v">${r.draw}</span></div>
      <div class="row"><span class="k">AI 生成</span><span class="v">${r.ai}</span></div>`;
    tip.style.left = (cx / W) * box.width + 'px';
    tip.style.top = (cy / H) * box.height + 'px';
    tip.classList.add('on');
  };

  hit.addEventListener('mousemove', onMove);
  hit.addEventListener('mouseleave', () => {
    tip.classList.remove('on');
    dot.setAttribute('opacity', '0');
    line.setAttribute('opacity', '0');
  });
}

/* 环形图：用 stroke-dasharray 拼，无依赖 */
function renderDonut(rows) {
  const svg = $('donutSvg');
  const legend = $('donutLegend');
  if (!svg || !rows) return;

  const total = rows.reduce((s, r) => s + r.n, 0) || 1;
  const R = 58;
  const SW = 18;
  const C = 2 * Math.PI * R;

  let acc = 0;
  const arcs = rows.map((r) => {
    const len = (r.n / total) * C;
    const gap = 3;
    const seg = Math.max(0, len - gap);
    const el = `<circle cx="74" cy="74" r="${R}" fill="none"
      stroke="${TASTE_COLORS[r.taste] || '#C9B9A6'}" stroke-width="${SW}"
      stroke-dasharray="${seg.toFixed(2)} ${(C - seg).toFixed(2)}"
      stroke-dashoffset="${(-acc).toFixed(2)}"
      transform="rotate(-90 74 74)" stroke-linecap="butt"/>`;
    acc += len;
    return el;
  }).join('');

  svg.setAttribute('viewBox', '0 0 148 148');
  svg.innerHTML = `${arcs}
    <text x="74" y="73" text-anchor="middle" class="donut-center-num">${total}</text>
    <text x="74" y="90" text-anchor="middle" class="donut-center-lab">道菜谱</text>`;

  legend.innerHTML = rows.map((r) => `
    <div class="dl-row">
      <span class="dl-dot" style="background:${TASTE_COLORS[r.taste] || '#C9B9A6'}"></span>
      <span class="dl-name">${esc(r.taste)}</span>
      <span class="dl-val">${r.n}</span>
      <span class="dl-pct">${Math.round((r.n / total) * 100)}%</span>
    </div>`).join('');
}

/** 云数据库回来的时间可能是 Date / 时间戳 / ISO 字符串，统一成 MM-DD HH:mm */
function fmtTime(v) {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v));
  if (isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** adminApi.feedbackList 的行 → 表格行 */
function normFeedback(f) {
  return {
    id: f.id,
    who: f.openid || '匿名用户',
    at: fmtTime(f.createdAt),
    reason: f.reason || f.title || '（用户未填写原因）',
    condition: f.condition || '',
    handled: f.handled === true
  };
}

async function loadDashFeedback() {
  let r;
  try {
    r = await api.feedbackList('open');
  } catch (e) {
    $('dashFb').innerHTML = `<div class="empty" style="padding:28px 0">${esc(e.message)}</div>`;
    return;
  }
  const rows = r.rows.map(normFeedback);
  const box = $('dashFb');
  if (!rows.length) {
    box.innerHTML = '<div class="empty" style="padding:28px 0">暂无待处理反馈</div>';
    return;
  }
  box.innerHTML = rows.slice(0, 3).map((f) => `
    <div class="mini-row">
      <div class="mini-av">${esc(f.who.slice(0, 1))}</div>
      <div class="mini-main">
        <div class="mini-text">${esc(f.reason)}</div>
        <div class="mini-meta">${esc(f.who)} · ${esc(f.at)}</div>
      </div>
      <button class="link-btn" data-act="fb" data-id="${f.id}">处理</button>
    </div>`).join('');
}

/* ---------------------------------------------------------------- 菜谱库 */

async function loadFoods() {
  let r;
  try {
    r = await api.foods({ page: state.page, size: state.size, keyword: state.keyword, scope: state.scope });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  state.rows = r.rows;
  state.total = r.total;
  // 翻页/换筛选后旧的勾选已经不在视野里，继续留着只会让人误改别的菜
  state.selected = [];
  $('ckAll').checked = false;
  syncBulkBar();

  if (!r.rows.length) {
    $('foodRows').innerHTML = `<tr><td colspan="8" class="empty">
      <div class="empty-ico"><svg aria-hidden="true"><use href="#i-book"/></svg></div>
      没有匹配的菜品</td></tr>`;
  } else {
    $('foodRows').innerHTML = r.rows.map((f) => `
      <tr>
        <td><input type="checkbox" class="ck ckRow" data-id="${f.id}" aria-label="选择 ${esc(f.name)}"></td>
        <td>
          <div class="cell-food">
            <img class="thumb" src="${imgSrc(f)}" alt="${esc(f.name)}" loading="lazy"
              onerror="this.src='${PLACEHOLDER_IMG}'">
            <div style="min-width:0">
              <div class="food-name">${esc(f.name)}</div>
              <div class="food-desc">${esc(f.desc || '—')}</div>
            </div>
          </div>
        </td>
        <td><span class="no-chip">No.${f.foodNo}</span></td>
        <td><span class="tag">${esc(f.taste)}</span></td>
        <td class="mono">${f.time} 分钟</td>
        <td class="mono">¥${f.budget}</td>
        <td>${f.hidden
          ? '<span class="tag tag-off"><span class="dot"></span>已下架</span>'
          : '<span class="tag tag-ok"><span class="dot"></span>已上架</span>'}</td>
        <td>
          <div class="row-acts">
            <button class="link-btn" data-act="edit" data-id="${f.id}">编辑</button>
            <button class="link-btn muted" data-act="toggle" data-id="${f.id}">${f.hidden ? '上架' : '下架'}</button>
          </div>
        </td>
      </tr>`).join('');
  }

  const pages = Math.max(1, Math.ceil(state.total / state.size));
  $('pagerInfo').textContent = `共 ${state.total} 道菜 · 第 ${state.page} / ${pages} 页`;

  // 页码：始终显示首尾 + 当前附近，中间用省略号
  const nums = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - state.page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  $('pagerBtns').innerHTML =
    `<button class="pg-btn" id="pgPrev" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>` +
    nums.map((n) => n === '…'
      ? '<span style="padding:0 4px;color:#C9B9A6">…</span>'
      : `<button class="pg-btn ${n === state.page ? 'on' : ''}" data-page="${n}">${n}</button>`).join('') +
    `<button class="pg-btn" id="pgNext" ${state.page >= pages ? 'disabled' : ''}>下一页</button>`;

  $('pgPrev').addEventListener('click', () => { if (state.page > 1) { state.page--; loadFoods(); } });
  $('pgNext').addEventListener('click', () => { if (state.page < pages) { state.page++; loadFoods(); } });
  $('pagerBtns').querySelectorAll('[data-page]').forEach((b) => {
    b.addEventListener('click', () => { state.page = Number(b.dataset.page); loadFoods(); });
  });
}

/* ------------------------------------------------------------ 批量操作 */

/** 勾选变化后同步操作条、计数与全选框（半选态用 indeterminate） */
function syncBulkBar() {
  const n = state.selected.length;
  $('bulkBar').hidden = n === 0;
  $('bulkCount').textContent = String(n);
  const all = state.rows.length > 0 && n === state.rows.length;
  $('ckAll').checked = all;
  $('ckAll').indeterminate = n > 0 && !all;
}

function clearSelection() {
  state.selected = [];
  document.querySelectorAll('.ckRow').forEach((c) => { c.checked = false; });
  syncBulkBar();
}

const BULK_LABEL = { show: '上架', hide: '下架', budget: '改成本', taste: '改口味' };

/** 上下架：一次请求搞定，成功后重拉当前页（保持筛选与页码） */
async function runBulkOp(op) {
  const ids = state.selected.slice();
  if (!ids.length) { toast('请先勾选菜品', true); return; }
  try {
    const r = await api.foodBatchOps(ids, op);
    const miss = ids.length - r.updated;
    toast(`已${BULK_LABEL[op] || op} ${r.updated} 道菜` + (miss > 0 ? `（${miss} 道未匹配）` : ''));
  } catch (e) {
    toast(e.message, true);
    return;
  }
  loadFoods();
}

function openBulkEdit() {
  if (!state.selected.length) { toast('请先勾选菜品', true); return; }
  $('bulkSub').textContent = `已选 ${state.selected.length} 道菜`;
  $('bulkBudget').value = '';
  $('bulkTaste').value = '';
  $('bulkErr').textContent = '';
  $('bulkMask').hidden = false;
  setTimeout(() => $('bulkBudget').focus(), 80);
}

function closeBulkEdit() { $('bulkMask').hidden = true; }

/**
 * 批量改属性：成本与口味分两次请求。
 * 服务端一次只认一个 op，硬塞成「复合操作」会让失败时说不清是哪项没成；
 * 分开提交也便于各自校验（成本是数字、口味是枚举）。
 */
async function doBulkEdit() {
  const budgetRaw = $('bulkBudget').value.trim();
  const taste = $('bulkTaste').value;
  const err = $('bulkErr');
  if (!budgetRaw && !taste) { err.textContent = '请至少填写一项要修改的内容'; return; }
  if (budgetRaw && !/^\d+(\.\d+)?$/.test(budgetRaw)) {
    err.textContent = '成本请填数字（元）';
    $('bulkBudget').focus();
    return;
  }

  const btn = $('bulkSubmit');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '提交中…';
  err.textContent = '';

  const ids = state.selected.slice();
  let updated = 0;
  try {
    if (budgetRaw) updated = (await api.foodBatchOps(ids, 'budget', Number(budgetRaw))).updated;
    if (taste) updated = (await api.foodBatchOps(ids, 'taste', taste)).updated;
    closeBulkEdit();
    toast(`已更新 ${updated} 道菜`);
    loadFoods();
  } catch (e) {
    err.textContent = e.message || '批量修改失败';
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ---------------------------------------------------------------- 配额 / 反馈 */

/** AI 每日免费次数（与小程序 config.biz.aiDailyQuota 保持一致） */
const AI_DAILY_QUOTA = 5;

async function loadQuota(keyword) {
  let r;
  try {
    r = await api.quotaSearch(keyword || '');
  } catch (e) {
    toast(e.message, true);
    return;
  }
  const rows = r.rows.map((u) => ({
    openid: u.openid || '',
    nick: u.nickname || (u.openid ? '用户 ' + String(u.openid).slice(-6) : '未知用户'),
    used: Number(u.mealUsed) || 0,
    weekly: Number(u.weekUsed) || 0,
    daily: AI_DAILY_QUOTA
  }));

  if (!rows.length) {
    $('userRows').innerHTML = `<tr><td colspan="5" class="empty">
      <div class="empty-ico"><svg aria-hidden="true"><use href="#i-users"/></svg></div>
      没有匹配的用户</td></tr>`;
    return;
  }
  $('userRows').innerHTML = rows.map((u) => `
    <tr>
      <td>
        <div class="cell-food" style="min-width:160px">
          <div class="mini-av">${esc(u.nick.slice(0, 1))}</div>
          <div class="food-name">${esc(u.nick)}</div>
        </div>
      </td>
      <td class="mono" style="font-size:11px">${esc(u.openid)}</td>
      <td><span class="tag ${u.used >= u.daily ? 'tag-warn' : 'tag-soft'}">${u.used} 次</span></td>
      <td class="mono">${u.daily} 次</td>
      <td>
        <div class="row-acts">
          <button class="link-btn" data-act="quota" data-op="+1" data-openid="${esc(u.openid)}">+1 次</button>
          <button class="link-btn muted" data-act="quota" data-op="reset" data-openid="${esc(u.openid)}">重置</button>
        </div>
      </td>
    </tr>`).join('');
}

async function loadFeedback(scope) {
  let r;
  try {
    r = await api.feedbackList(scope || 'open');
  } catch (e) {
    toast(e.message, true);
    return;
  }
  const rows = r.rows.map(normFeedback);
  if (!rows.length) {
    $('fbRows').innerHTML = `<tr><td colspan="5" class="empty">
      <div class="empty-ico"><svg aria-hidden="true"><use href="#i-chat"/></svg></div>
      ${scope === 'open' ? '没有待处理反馈' : '还没有收到反馈'}</td></tr>`;
    return;
  }
  $('fbRows').innerHTML = rows.map((f) => `
    <tr>
      <td class="mono">${esc(f.at)}</td>
      <td><span class="no-chip">${esc(f.who)}</span></td>
      <td>${esc(f.reason)}</td>
      <td>${f.handled
        ? '<span class="tag tag-off"><span class="dot"></span>已处理</span>'
        : '<span class="tag tag-warn"><span class="dot"></span>待处理</span>'}</td>
      <td>${f.handled ? '<span class="mono" style="color:#C9B9A6">—</span>'
        : `<button class="link-btn" data-act="fb" data-id="${f.id}">标记已处理</button>`}</td>
    </tr>`).join('');
}

async function markFeedbackHandled(id) {
  try {
    await api.feedbackHandle(id, true);
  } catch (e) {
    toast(e.message, true);
    return;
  }
  toast('已标记处理');
  if (state.tab === 'feedback') loadFeedback(state.fbScope);
  else if (state.tab === 'stat') loadStats();
}

/* ---------------------------------------------------------------- 编辑弹层 */

/** 本机新选的图（保存时才上传，取消编辑不产生垃圾文件） */
let pickedImg = null; // { base64, ext, previewUrl }

function openEdit(food) {
  state.editing = food || {
    id: '', foodNo: '', name: '', desc: '', taste: '家常', scene: '午餐、晚餐',
    time: 20, budget: 20, ing: '', steps: '', avoidTags: '', img: '', imgUrl: '', hidden: false
  };
  pickedImg = null;
  $('editTitle').textContent = food ? '编辑菜谱' : '新增菜谱';
  $('fName').value = state.editing.name || '';
  $('fTaste').value = state.editing.taste || '家常';
  $('fNo').value = state.editing.foodNo ? 'No.' + state.editing.foodNo : '保存后自动生成';
  $('fTime').value = state.editing.time || 20;
  $('fBudget').value = state.editing.budget || 20;
  $('fDesc').value = state.editing.desc || '';
  $('fIng').value = state.editing.ing || '';
  $('fSteps').value = state.editing.steps || '';
  $('fIng').placeholder = '顿号或逗号分隔，例如：鸡胸肉、花生、黄瓜';
  $('fImg').src = imgSrc(state.editing);
  $('btnClearImg').hidden = true;
  $('editMask').hidden = false;
  setTimeout(() => $('fName').focus(), 60);
}

function closeEdit() {
  $('editMask').hidden = true;
  state.editing = null;
  pickedImg = null;
}

/**
 * 图片压缩：长边不超过 1280、JPEG 0.82。
 * 手机原图动辄 4~8MB，不压就会顶到云函数请求体上限；
 * 菜谱封面在后台是 56px 缩略图、小程序里也不大，1280 足够清晰。
 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxSide = 1280;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const dataUrl = cv.toDataURL('image/jpeg', 0.82);
      resolve({
        base64: dataUrl.replace(/^data:image\/\w+;base64,/, ''),
        ext: 'jpg',
        previewUrl: dataUrl
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ApiError('BAD_IMAGE', '这张图片读不出来，换一张试试'));
    };
    img.src = url;
  });
}

/* ---------------------------------------------------------------- 批量导入 */

const BATCH_MAX = 50;
const FIELDS = {
  '菜名': 'name', '名称': 'name', '菜品': 'name', '菜品名称': 'name',
  '口味': 'taste', '时长': 'time', '时间': 'time', '烹饪时长': 'time',
  '成本': 'budget', '预算': 'budget', '价格': 'budget',
  '食材': 'ing', '食材清单': 'ing', '步骤': 'steps', '做法': 'steps',
  '描述': 'desc', '简介': 'desc', '场景': 'scene', '忌口': 'avoidTags'
};
const DEFAULT_ORDER = ['name', 'taste', 'time', 'budget', 'ing', 'steps', 'desc', 'scene', 'avoidTags'];
const MAXLEN = { name: 20, desc: 60, taste: 8, ing: 200, steps: 600, scene: 40, avoidTags: 60 };

function splitCells(line) {
  return line.split(/[|｜\t]/).map((s) => s.trim());
}

function parseBatch(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const items = [];
  const errors = [];
  let order = DEFAULT_ORDER;

  lines.forEach((line, idx) => {
    const cells = splitCells(line);
    if (idx === 0) {
      const mapped = cells.map((c) => FIELDS[c]);
      if (mapped.filter(Boolean).length >= 2 && mapped.includes('name')) {
        order = mapped;
        return;
      }
    }
    if (items.length >= BATCH_MAX) return;
    const rec = {};
    order.forEach((field, i) => {
      if (!field) return;
      let v = cells[i] == null ? '' : cells[i];
      if (MAXLEN[field]) v = v.slice(0, MAXLEN[field]);
      rec[field] = v;
    });
    if (!rec.name) { errors.push(`第 ${idx + 1} 行：缺少菜名`); return; }
    rec.time = Number(rec.time) || 20;
    rec.budget = Number(rec.budget) || 20;
    if (!rec.taste) rec.taste = '家常';
    items.push(rec);
  });

  return { items, errors };
}

function renderBatchPreview() {
  const { items, errors } = parseBatch($('batchText').value);
  $('batchSum').innerHTML = `识别到 <b>${items.length}</b> 道菜` +
    (errors.length ? ` · <span style="color:#FF5B4A">${errors.length} 行有问题</span>` : '');

  const rows = items.slice(0, 8).map((it) => `
    <div class="preview-row">
      <b>${esc(it.name)}</b>
      <span>${esc(it.taste)}</span>
      <span>${it.time} 分</span>
      <span>¥${it.budget}</span>
      <span>${esc((it.ing || '—').slice(0, 26))}</span>
    </div>`).join('');

  $('batchPreview').innerHTML = rows +
    (items.length > 8 ? `<div class="hint">另有 ${items.length - 8} 条未展示…</div>` : '') +
    errors.slice(0, 3).map((e) => `<div class="hint" style="color:#FF5B4A">${esc(e)}</div>`).join('');

  $('batchSubmit').disabled = items.length === 0;
  $('batchTip').textContent = items.length
    ? `将导入 ${items.length} 道菜，同名自动跳过`
    : '同名菜会自动跳过，不会覆盖已有内容';
}

/* ------------------------------------------------------------ 账号管理 */

function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 与后端 cleanAdminName 一致：小写 + 只留字母数字下划线 */
function cleanAccName(v) {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

async function loadAdminUsers() {
  let r;
  try {
    r = await api.adminUsers();
  } catch (e) {
    $('adminRows').innerHTML = `<tr><td colspan="5" class="empty">
      <div class="empty-ico"><svg aria-hidden="true"><use href="#i-shield"/></svg></div>
      ${esc(e.message || '账号加载失败')}</td></tr>`;
    return;
  }

  const list = r.list || [];
  if (!list.length) {
    $('adminRows').innerHTML = `<tr><td colspan="5" class="empty">
      <div class="empty-ico"><svg aria-hidden="true"><use href="#i-shield"/></svg></div>
      还没有账号，点右上角「新增账号」创建</td></tr>`;
    return;
  }

  $('adminRows').innerHTML = list.map((u) => {
    const state_ = u.disabled
      ? '<span class="tag tag-off"><span class="dot"></span>已停用</span>'
      : u.locked
        ? '<span class="tag tag-warn"><span class="dot"></span>已锁定</span>'
        : u.recentFails > 0
          ? `<span class="tag tag-warn" title="近 10 分钟有人用错误密码试过这个账号"><span class="dot"></span>失败 ${u.recentFails} 次</span>`
          : '<span class="tag tag-ok"><span class="dot"></span>正常</span>';
    const pwd = u.pwdChangedAt ? '密码更新于 ' + fmtTime(u.pwdChangedAt) : '仍在使用初始密码';
    // 只有真出现过失败才给「解锁」：平时多一个按钮只会让人误点
    const unlock = u.recentFails > 0
      ? `<button class="link-btn muted" data-act="unlock" data-name="${esc(u.username)}">解除限制</button>`
      : '';
    const acts = (u.isSelf
      ? '<span class="link-btn muted" style="cursor:default">当前账号</span>'
      : `<button class="link-btn muted" data-act="toggle" data-id="${u.id}" data-name="${esc(u.username)}" data-disabled="${u.disabled ? '1' : ''}">${u.disabled ? '启用' : '停用'}</button>
         <button class="link-btn muted" data-act="del" data-id="${u.id}" data-name="${esc(u.username)}">删除</button>`)
      + `<button class="link-btn muted" data-act="avatar" data-id="${u.id}" data-name="${esc(u.username)}">换头像</button>`;
    const avInner = u.avatar
      ? `<img class="mini-av-img" src="${esc(u.avatar)}" alt="">`
      : esc(String(u.username || '?').slice(0, 1).toUpperCase());
    return `
      <tr>
        <td>
          <div class="cell-food" style="min-width:150px">
            <div class="mini-av">${avInner}</div>
            <div style="min-width:0">
              <div class="food-name">${esc(u.username)}</div>
              <div class="food-desc">${pwd}</div>
            </div>
          </div>
        </td>
        <td>${state_}</td>
        <td class="mono" style="font-size:11.5px">${fmtTime(u.lastLoginAt)}</td>
        <td class="mono" style="font-size:11.5px">${fmtTime(u.createdAt)}</td>
        <td>
          <div class="row-acts">
            <button class="link-btn" data-act="reset" data-id="${u.id}" data-name="${esc(u.username)}">重置密码</button>
            ${unlock}
            ${acts}
          </div>
        </td>
      </tr>`;
  }).join('');
}

function syncAccTip() {
  const v = $('accPwd').value;
  const tip = $('accPwdTip');
  const bad = pwdProblem(v);
  if (!v) {
    tip.textContent = '密码至少 8 位，需同时包含字母和数字（最长 64 位）';
    tip.classList.remove('ok');
    return;
  }
  tip.textContent = bad || '密码强度合格';
  tip.classList.toggle('ok', !bad);
}

function resetAccFields() {
  $('accPwd').value = '';
  $('accPwd2').value = '';
  $('accErr').textContent = '';
  syncAccTip();
}

function openAccAdd() {
  state.accMode = 'add';
  state.accTarget = null;
  state.accAvatar = '';
  $('accTitle').textContent = '新增账号';
  $('accSub').textContent = '新账号可立即用账号密码登录后台';
  $('accNameField').hidden = false;
  $('accName').value = '';
  $('accAvatarField').hidden = false;
  $('accAvatarImg').hidden = true;
  $('accAvatarImg').removeAttribute('src');
  $('accAvatarPlaceholder').hidden = false;
  $('accSubmit').textContent = '保存';
  resetAccFields();
  $('accMask').hidden = false;
  setTimeout(() => $('accName').focus(), 80);
}

function openAccReset(id, name) {
  state.accMode = 'reset';
  state.accTarget = { id: id, name: name };
  $('accTitle').textContent = '重置密码';
  $('accSub').textContent = '为「' + name + '」设置新密码，原密码立即失效';
  $('accNameField').hidden = true;
  $('accAvatarField').hidden = true;
  $('accSubmit').textContent = '重置密码';
  resetAccFields();
  $('accMask').hidden = false;
  setTimeout(() => $('accPwd').focus(), 80);
}

function closeAcc() { $('accMask').hidden = true; }

async function doAccSubmit() {
  const err = $('accErr');
  const pwd = $('accPwd').value;
  const pwd2 = $('accPwd2').value;
  const isAdd = state.accMode === 'add';

  let name = '';
  if (isAdd) {
    name = cleanAccName($('accName').value);
    if (name.length < 3 || name.length > 20) {
      err.textContent = '账号需 3~20 位字母、数字或下划线';
      $('accName').focus();
      return;
    }
  }
  const bad = pwdProblem(pwd);
  if (bad) { err.textContent = bad; $('accPwd').focus(); return; }
  if (pwd !== pwd2) { err.textContent = '两次输入的密码不一致'; $('accPwd2').focus(); return; }

  const btn = $('accSubmit');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '提交中…';
  err.textContent = '';

  try {
    if (isAdd) {
      await api.adminUserAdd(name, pwd, state.accAvatar || undefined);
      toast('账号已创建：' + name);
    } else {
      await api.adminUserResetPwd(state.accTarget.id, pwd);
      toast('已重置「' + state.accTarget.name + '」的密码');
    }
    closeAcc();
    loadAdminUsers();
  } catch (e) {
    err.textContent = e.message || '保存失败';
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function toggleAdminUser(id, name, disabled) {
  const next = !disabled;
  if (next && !confirm('停用「' + name + '」后该账号将无法登录后台，确定停用？')) return;
  try {
    await api.adminUserUpdate(id, next);
    toast(next ? '已停用「' + name + '」' : '已启用「' + name + '」');
    loadAdminUsers();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteAdminUser(id, name) {
  if (!confirm('删除账号「' + name + '」后不可恢复，确定删除？')) return;
  try {
    await api.adminUserDelete(id);
    toast('已删除「' + name + '」');
    loadAdminUsers();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------------- 账号头像（2026-11-18） ---------------- */

/** 本地文件 → 128×128 方形 JPEG dataURL（canvas 居中裁剪，控制在服务端 80KB 限制内） */
function fileToAvatarDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('请选择图片文件'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const size = 128;
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const ctx = c.getContext('2d');
        const s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        resolve(c.toDataURL('image/jpeg', 0.85));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

/** 换头像：打开文件选择 → 本地裁剪预览确认 → 存到账号记录 */
function changeAvatar(id, name) {
  const input = $('avFile');
  input.value = '';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let dataUrl;
    try {
      dataUrl = await fileToAvatarDataUrl(file);
    } catch (err) {
      toast(err.message || '图片处理失败', true);
      return;
    }
    if (!confirm('将这张图设为「' + name + '」的头像？')) return;
    try {
      await api.adminUserUpdate(id, undefined, dataUrl);
      toast('头像已更新');
      loadAdminUsers();
    } catch (err) {
      toast(err.message || '头像更新失败', true);
    }
  };
  input.click();
}

/** 解除登录节流：清掉该账号的失败记录，顺带清本机 IP 的总计数 */
async function unlockLogin(name) {
  try {
    const r = await api.loginUnlock(name);
    const n = (r.cleared && (r.cleared.pair + r.cleared.ip)) || 0;
    toast(n ? '已解除「' + name + '」的登录限制' : '本来就没事，没有需要解除的记录');
    loadAdminUsers();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------------------------------------------------------------- 操作日志 */

/** action → 人话。服务端存的是 action 名，表格里直接显示英文名对运营不友好 */
const LOG_LABEL = {
  login: '登录',
  foodSave: '菜谱编辑',
  foodHidden: '上下架',
  foodBatchOps: '批量操作',
  foodBatch: '批量导入',
  upload: '图片上传',
  quotaAdjust: '配额调整',
  feedbackHandle: '反馈处理',
  adminUserAdd: '新增账号',
  adminUserUpdate: '启停账号',
  adminUserResetPwd: '重置密码',
  adminUserDelete: '删除账号',
  loginUnlock: '解除限制',
  changePwd: '修改密码',
  migrate: '数据迁移',
  mediaClean: '清理图片',
  memberCodeGen: '生成兑换码',
  memberCodeDisable: '作废兑换码',
  memberGrant: '手动授予会员',
  memberRevoke: '取消会员'
};

const VIA_LABEL = { web: '网页', wx: '微信', anon: '—' };

function logLabel(a) {
  return LOG_LABEL[a] || a || '—';
}

async function loadAudit() {
  const f = state.log;
  let r;
  try {
    r = await api.auditList({ page: f.page, size: f.size, actionType: f.action, keyword: f.keyword });
  } catch (e) {
    toast(e.message, true);
    $('logRows').innerHTML = `<tr><td colspan="6" class="empty">
      <div class="empty-ico"><svg aria-hidden="true"><use href="#i-log"/></svg></div>
      ${esc(e.message || '日志加载失败')}</td></tr>`;
    return;
  }

  const rows = r.list || [];
  $('logKeep').textContent = '保留 ' + (r.keepDays || 90) + ' 天';

  if (!rows.length) {
    const filtered = f.action !== 'all' || f.keyword;
    $('logRows').innerHTML = `<tr><td colspan="6" class="empty">
      <div class="empty-ico"><svg aria-hidden="true"><use href="#i-log"/></svg></div>
      ${filtered ? '没有匹配的操作记录' : '还没有操作记录，做一次改动就会出现在这里'}</td></tr>`;
    $('logInfo').textContent = '共 0 条';
    $('logPager').innerHTML = '';
    return;
  }

  $('logRows').innerHTML = rows.map((l) => `
    <tr>
      <td class="mono" style="font-size:11.5px">${fmtTime(l.at)}</td>
      <td>
        <div class="log-who">
          <span class="log-target" style="font-weight:600">${esc(l.actor || '—')}</span>
          <span class="log-via">${esc(VIA_LABEL[l.via] || l.via || '—')}</span>
        </div>
      </td>
      <td><span class="tag tag-soft">${esc(logLabel(l.action))}</span></td>
      <td>
        <div class="log-target">${esc(l.target || '—')}</div>
        <div class="log-detail">${esc(l.detail || '')}</div>
      </td>
      <td>${l.ok
        ? '<span class="tag tag-ok"><span class="dot"></span>成功</span>'
        : `<span class="tag tag-off" title="${esc(l.code || '')}"><span class="dot"></span>失败</span>`}</td>
      <td class="mono" style="font-size:11.5px">${esc(l.ip || '—')}</td>
    </tr>`).join('');

  const pages = Math.max(1, Math.ceil((r.total || 0) / f.size));
  $('logInfo').textContent = `共 ${r.total} 条 · 第 ${f.page} / ${pages} 页`;
  const nums = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - f.page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  $('logPager').innerHTML =
    `<button class="pg-btn" data-lpg="prev" ${f.page <= 1 ? 'disabled' : ''}>上一页</button>` +
    nums.map((n) => n === '…'
      ? '<span style="padding:0 4px;color:#C9B9A6">…</span>'
      : `<button class="pg-btn ${n === f.page ? 'on' : ''}" data-lpage="${n}">${n}</button>`).join('') +
    `<button class="pg-btn" data-lpg="next" ${f.page >= pages ? 'disabled' : ''}>下一页</button>`;

  $('logPager').querySelectorAll('[data-lpage]').forEach((b) => {
    b.addEventListener('click', () => { state.log.page = Number(b.dataset.lpage); loadAudit(); });
  });
  const prev = $('logPager').querySelector('[data-lpg="prev"]');
  const next = $('logPager').querySelector('[data-lpg="next"]');
  if (prev) prev.addEventListener('click', () => { if (state.log.page > 1) { state.log.page--; loadAudit(); } });
  if (next) next.addEventListener('click', () => { if (state.log.page < pages) { state.log.page++; loadAudit(); } });
}

/* ------------------------------------------------------------ 安全面板 */

async function loadSecurity() {
  let r;
  try {
    r = await api.securitySummary();
  } catch (e) {
    $('secFails').textContent = '—';
    $('secBlocked').textContent = '—';
    $('secThrottle').textContent = '—';
    $('secBlockedRows').innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message || '加载失败')}</td></tr>`;
    $('secFailRows').innerHTML = `<tr><td colspan="6" class="empty">${esc(e.message || '加载失败')}</td></tr>`;
    $('pageActs').innerHTML = '';
    return;
  }

  $('secFails').innerHTML = `${r.loginFailsToday || 0}<small>次</small>`;
  $('secBlocked').innerHTML = `${r.blockedNow || 0}<small>个</small>`;
  $('secThrottle').innerHTML = `${r.throttleTotal || 0}<small>条</small>`;

  const blocked = r.blocked || [];
  $('secBlockedRows').innerHTML = blocked.length
    ? blocked.map((b) => {
        const who = b.kind === 'pair' ? '账号 ' + b.who : 'IP ' + (b.who || '');
        const kind = b.kind === 'pair' ? '账号+IP' : '来源 IP';
        return `
      <tr>
        <td>${esc(kind)}</td>
        <td class="mono" style="font-size:11.5px">${esc(who)}</td>
        <td>${b.fails} 次失败</td>
        <td>累计封锁 ${b.blockCount} 次</td>
        <td>解封于 ${fmtTime(b.blockedUntil)}</td>
      </tr>`;
      }).join('')
    : '<tr><td colspan="5" class="empty">当前没有封锁中的 IP 或账号</td></tr>';

  const fails = r.recentFails || [];
  $('secFailRows').innerHTML = fails.length
    ? fails.map((f) => `
      <tr>
        <td class="mono" style="font-size:11.5px">${fmtTime(f.at)}</td>
        <td>${esc(f.actor || '—')}</td>
        <td>${esc(logLabel(f.action))}</td>
        <td class="mono" style="font-size:11.5px">${esc(f.code || '—')}</td>
        <td>${esc(f.via === 'web' ? '网页后台' : f.via === 'wx' ? '小程序' : (f.via || '—'))}</td>
        <td class="mono" style="font-size:11.5px">${esc(f.ip || '—')}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty">没有失败操作记录，一切正常</td></tr>';

  $('pageActs').innerHTML = '<button class="btn" id="btnRefreshSec"><svg aria-hidden="true"><use href="#i-refresh"/></svg>刷新</button>';
  $('btnRefreshSec').addEventListener('click', loadSecurity);
}

/* ------------------------------------------------------------ 存储与导出 */

/* ---------------------------------------------------------------- 会员 */

const PLAN_LABEL = { d30: '30 天', d90: '90 天', forever: '永久' };
const CODE_TAG = {
  unused: '<span class="tag tag-ok"><span class="dot"></span>未使用</span>',
  used: '<span class="tag tag-off"><span class="dot"></span>已使用</span>',
  disabled: '<span class="tag tag-warn"><span class="dot"></span>已作废</span>'
};

/** 子 tab 切换：两个面板互斥显示，切到哪个才拉哪个（不预拉，省一次请求） */
function syncMemberSub() {
  const sub = state.memberSub;
  document.querySelectorAll('#memberSubnav .subnav-item').forEach((b) => {
    b.classList.toggle('on', b.dataset.sub === sub);
  });
  $('subMemberCodes').hidden = sub !== 'codes';
  $('subMemberUsers').hidden = sub !== 'members';
  if (sub === 'codes') loadMemberCodes();
  else loadMemberUsers();
}

/** 作废按钮只在有勾选时出现，并把数量带上 —— 批量操作最怕「不知道选了几个」 */
function syncCodeBar() {
  const n = state.codeSelected.length;
  const btn = $('btnDisableCodes');
  if (!btn) return;
  btn.hidden = n === 0;
  btn.innerHTML = '<svg aria-hidden="true"><use href="#i-trash"/></svg>作废所选' + (n ? ' (' + n + ')' : '');
}

async function loadMemberCodes() {
  const c = state.code;
  let r;
  try {
    r = await api.memberCodes({ page: c.page, size: c.size, status: c.status, batch: c.batch });
  } catch (e) {
    $('codeRows').innerHTML = `<tr><td colspan="7" class="empty">
      <div class="empty-ico"><svg aria-hidden="true"><use href="#i-ticket"/></svg></div>
      ${esc(e.message || '兑换码加载失败')}</td></tr>`;
    return;
  }

  const list = r.list || [];
  state.codeSelected = [];
  syncCodeBar();
  const all = $('codeAll');
  if (all) all.checked = false;
  $('codeStat').textContent = '共 ' + (r.total || 0) + ' 张';

  if (!list.length) {
    const filtered = c.status || c.batch;
    $('codeRows').innerHTML = `<tr><td colspan="7" class="empty">
      <div class="empty-ico"><svg aria-hidden="true"><use href="#i-ticket"/></svg></div>
      ${filtered ? '没有符合条件的兑换码' : '还没有兑换码：右上角选好套餐和数量，点「生成」'}</td></tr>`;
    return;
  }

  $('codeRows').innerHTML = list.map((d) => {
    // 只有未使用的码能勾选：已核销/已作废的勾了也没用，白占一个操作位
    const pick = d.status === 'unused'
      ? `<input type="checkbox" class="code-pick" data-id="${esc(d.id)}" aria-label="选择">`
      : '';
    const who = d.usedBy ? '…' + String(d.usedBy).slice(-6) : '';
    const sub = d.usedBy
      ? '使用于 ' + fmtTime(d.usedAt)
      : (d.note ? '' : '未发放');
    return `
      <tr>
        <td>${pick}</td>
        <td><button class="link-btn mono" data-copy="${esc(d.code)}" title="点击复制">${esc(d.code)}</button></td>
        <td>${esc(d.planLabel || '')}</td>
        <td>${CODE_TAG[d.status] || esc(d.status)}</td>
        <td class="mono" style="font-size:11.5px">${esc(d.batch || '—')}</td>
        <td>
          ${d.note ? `<div class="food-name" style="font-size:12.5px">${esc(d.note)}</div>` : ''}
          ${who ? `<div class="food-desc mono">${who}</div>` : ''}
          ${sub ? `<div class="food-desc">${sub}</div>` : ''}
          ${!d.note && !who && !sub ? '<span class="food-desc">—</span>' : ''}
        </td>
        <td class="mono" style="font-size:11.5px">${fmtTime(d.createdAt)}</td>
      </tr>`;
  }).join('');
}

async function genCodes() {
  const plan = $('codePlan').value;
  const count = Number($('codeCount').value) || 0;
  const note = $('codeNote').value.trim();
  if (count < 1 || count > 100) {
    toast('生成数量需在 1~100 之间', true);
    return;
  }
  const btn = $('btnGenCodes');
  btn.disabled = true;
  try {
    const r = await api.memberCodeGen({ plan: plan, count: count, note: note });
    // 记住这一批：运营生成完通常要立刻复制出去发，不记住就只能一张张手动抄
    const codes = r.codes || [];
    state.lastBatch = codes.length ? { batch: r.batch, codes: codes } : null;
    const copyBtn = $('btnCopyBatch');
    copyBtn.hidden = !codes.length;
    copyBtn.innerHTML = '<svg aria-hidden="true"><use href="#i-download"/></svg>复制本批 (' + codes.length + ')';
    toast('已生成 ' + r.added + ' 张 ' + (r.planLabel || '') + (r.failed ? '，' + r.failed + ' 张失败' : ''));
    $('codeNote').value = '';
    state.code.page = 1;
    state.code.batch = '';
    loadMemberCodes();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function copyBatch() {
  const b = state.lastBatch;
  if (!b || !b.codes.length) return;
  try {
    await navigator.clipboard.writeText(b.codes.join('\n'));
    toast('已复制 ' + b.codes.length + ' 张码，可直接粘贴发送');
  } catch (e) {
    // 非 https 或浏览器拒绝剪贴板权限：把码摊开让用户自己选，总比什么都没有好
    toast('浏览器未授权剪贴板，请手动复制下方列表中的码', true);
  }
}

async function disableCodes() {
  const ids = state.codeSelected.slice();
  if (!ids.length) return;
  if (!confirm('作废选中的 ' + ids.length + ' 张兑换码？\n作废后无法恢复，也不能再被兑换。')) return;
  try {
    const r = await api.memberCodeDisable(ids);
    toast('已作废 ' + r.disabled + ' 张' + (r.skipped ? '，跳过 ' + r.skipped + ' 张（已使用）' : ''));
    loadMemberCodes();
  } catch (e) {
    toast(e.message, true);
  }
}

async function loadMemberUsers() {
  const m = state.member;
  let r;
  try {
    r = await api.memberUsers({ page: m.page, size: m.size, keyword: m.keyword });
  } catch (e) {
    $('memberRows').innerHTML = `<tr><td colspan="6" class="empty">
      <div class="empty-ico"><svg aria-hidden="true"><use href="#i-users"/></svg></div>
      ${esc(e.message || '会员列表加载失败')}</td></tr>`;
    return;
  }

  const list = r.list || [];
  if (!list.length) {
    $('memberRows').innerHTML = `<tr><td colspan="6" class="empty">
      <div class="empty-ico"><svg aria-hidden="true"><use href="#i-users"/></svg></div>
      ${m.keyword ? '没有匹配的会员' : '还没有会员：发一批兑换码，或在上方输入 openid 直接授予'}</td></tr>`;
    return;
  }

  $('memberRows').innerHTML = list.map((u) => {
    const active = !!(u.member && u.member.active);
    const tag = active
      ? '<span class="tag tag-ok"><span class="dot"></span>有效</span>'
      : '<span class="tag tag-off"><span class="dot"></span>已过期</span>';
    const left = u.daysLeft === null ? '永久' : (u.daysLeft || 0) + ' 天';
    const expire = u.daysLeft === null
      ? '永久有效'
      : (u.member && u.member.expireAt ? fmtTime(u.member.expireAt) : '已过期');
    return `
      <tr>
        <td>
          <div class="cell-food" style="min-width:140px">
            <div class="mini-av">${esc(String(u.nickname || '微').slice(0, 1))}</div>
            <div style="min-width:0">
              <div class="food-name">${esc(u.nickname || '微信用户')}</div>
              <div class="food-desc">${esc(PLAN_LABEL[u.member.plan] || u.member.plan || '')}</div>
            </div>
          </div>
        </td>
        <td class="mono" style="font-size:11px;word-break:break-all">${esc(u.openid)}</td>
        <td>${tag}</td>
        <td>${left}</td>
        <td class="mono" style="font-size:11.5px">${expire}</td>
        <td><button class="link-btn muted" data-revoke="${esc(u.openid)}" data-nick="${esc(u.nickname || '')}">取消会员</button></td>
      </tr>`;
  }).join('');
}

async function grantMember() {
  const openid = $('grantOpenid').value.trim();
  const plan = $('grantPlan').value;
  if (!openid) {
    toast('请先填写要授予的 openid', true);
    return;
  }
  if (!confirm('确认给这个用户授予「' + (PLAN_LABEL[plan] || plan) + '」会员？\n该操作会记入操作日志。')) return;
  try {
    const r = await api.memberGrant(openid, plan);
    toast(r.extended ? '已为其续期' : '已开通会员');
    $('grantOpenid').value = '';
    loadMemberUsers();
  } catch (e) {
    toast(e.message, true);
  }
}

async function revokeMember(openid, nick) {
  if (!confirm('取消「' + (nick || openid) + '」的会员？\n取消后立即恢复免费额度。')) return;
  try {
    await api.memberRevoke(openid);
    toast('已取消会员');
    loadMemberUsers();
  } catch (e) {
    toast(e.message, true);
  }
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / 1024 / 1024).toFixed(1) + ' MB';
}

async function loadMediaStats() {
  try {
    const r = await api.mediaStats();
    $('msUsed').textContent = r.used;
    $('msOrphan').textContent = r.orphan;
    $('msCleanable').textContent = r.cleanable;
    $('msSize').textContent = fmtBytes(r.cleanableBytes);
    $('btnMediaClean').disabled = !r.cleanable;
    $('msCleanableBox').classList.toggle('warn', !!r.cleanable);
    $('msHint').innerHTML = r.cleanable
      ? `有 <b>${r.cleanable}</b> 张图超过 ${r.graceHours} 小时没被任何菜谱使用，可释放 ${fmtBytes(r.cleanableBytes)}。`
      : `台账共 ${r.total} 张，暂无超过 ${r.graceHours} 小时的空闲图。刚上传但没保存的图会先保留观察，避免误删。`;
  } catch (e) {
    $('msHint').textContent = e.message || '图片台账读取失败';
    $('btnMediaClean').disabled = true;
  }
}

async function doMediaClean() {
  const btn = $('btnMediaClean');
  btn.disabled = true;
  try {
    const r = await api.mediaClean();
    if (r.deleted) toast(`已清理 ${r.deleted} 张，释放 ${fmtBytes(r.freedBytes)}`);
    else if (r.kept) toast('检查后没有可安全删除的图片');
    else toast('没有需要清理的图片');
    loadMediaStats();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
}

/** 下载 CSV：服务端已加 BOM 并按 RFC 4180 转义，前端只负责落盘 */
async function doExport(type) {
  try {
    const r = await api.exportCsv(type);
    const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = r.filename || (type + '.csv');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`已导出 ${r.rows} 条`);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------------------------------------------------------------- 事件 */

function bind() {
  // 导航
  $('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (btn) switchTab(btn.dataset.tab);
  });

  // 顶栏
  $('btnHelp').addEventListener('click', () => toast('在「我的」页连点 5 次可进入手机端应急后台'));
  $('btnPwd').addEventListener('click', openPwd);
  $('btnLogout').addEventListener('click', () => {
    api.setToken('');
    $('lgPass').value = '';
    showLogin('已退出登录');
  });
  $('btnAllFb').addEventListener('click', () => { state.fbScope = 'open'; syncSegFb(); switchTab('feedback'); });

  // 概览快捷入口
  document.querySelectorAll('[data-quick]').forEach((b) => {
    b.addEventListener('click', () => {
      const k = b.dataset.quick;
      if (k === 'batch') { switchTab('foods'); openBatch(); }
      if (k === 'new-food') { switchTab('foods'); openEdit(null); }
      if (k === 'feedback') { state.fbScope = 'open'; syncSegFb(); switchTab('feedback'); }
      if (k === 'gen-codes') { switchTab('member'); toast('在上方选好套餐和数量后点「生成」'); }
      if (k === 'export') { switchTab('log'); }
    });
  });

  // 概览：图片存储与导出
  $('btnMediaRefresh').addEventListener('click', () => { loadMediaStats(); toast('已刷新'); });
  $('btnMediaClean').addEventListener('click', doMediaClean);
  document.querySelectorAll('[data-export]').forEach((b) => {
    b.addEventListener('click', () => doExport(b.dataset.export));
  });

  // 概览反馈行
  $('dashFb').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act=fb]');
    if (btn) markFeedbackHandled(btn.dataset.id);
  });

  // 菜谱
  $('qFood').addEventListener('input', debounce(() => {
    state.keyword = $('qFood').value.trim();
    state.page = 1;
    loadFoods();
  }, 260));

  $('segScope').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state.scope = b.dataset.scope;
    state.page = 1;
    $('segScope').querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
    loadFoods();
  });

  $('btnReload').addEventListener('click', () => { loadFoods(); toast('已刷新'); });

  $('ckAll').addEventListener('change', (e) => {
    document.querySelectorAll('.ckRow').forEach((c) => { c.checked = e.target.checked; });
    state.selected = e.target.checked ? state.rows.map((f) => f.id) : [];
    syncBulkBar();
  });

  // 单行勾选：只维护 id 列表，不重渲染（重渲染会把用户滚动位置和勾选一起打乱）
  $('foodRows').addEventListener('change', (e) => {
    const ck = e.target.closest('.ckRow');
    if (!ck) return;
    const id = ck.dataset.id;
    const i = state.selected.indexOf(id);
    if (ck.checked && i < 0) state.selected.push(id);
    if (!ck.checked && i >= 0) state.selected.splice(i, 1);
    syncBulkBar();
  });

  // 批量操作条
  $('bulkBar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-bulk]');
    if (!b) return;
    if (b.dataset.bulk === 'edit') openBulkEdit();
    else runBulkOp(b.dataset.bulk);
  });
  $('bulkClear').addEventListener('click', clearSelection);

  $('bulkClose').addEventListener('click', closeBulkEdit);
  $('bulkCancel').addEventListener('click', closeBulkEdit);
  $('bulkSubmit').addEventListener('click', doBulkEdit);
  $('bulkMask').addEventListener('click', (e) => { if (e.target === $('bulkMask')) closeBulkEdit(); });
  $('bulkTaste').addEventListener('keydown', (e) => { if (e.key === 'Enter') doBulkEdit(); });

  // 账号管理
  $('btnReloadUsers').addEventListener('click', () => { loadAdminUsers(); toast('已刷新'); });
  $('btnNewUser').addEventListener('click', openAccAdd);

  // 操作日志：筛选/搜索都会把页码拉回第 1 页，否则会出现「第 3 页空着」
  $('logAction').addEventListener('change', (e) => {
    state.log.action = e.target.value;
    state.log.page = 1;
    loadAudit();
  });
  $('qLog').addEventListener('input', debounce((e) => {
    state.log.keyword = e.target.value.trim();
    state.log.page = 1;
    loadAudit();
  }, 320));
  $('btnReloadLog').addEventListener('click', () => { loadAudit(); toast('已刷新'); });
  $('btnExportLogs').addEventListener('click', () => doExport('logs'));

  // 会员：子 tab 切换 / 发码 / 作废 / 复制 / 授予 / 取消
  document.querySelectorAll('#memberSubnav .subnav-item').forEach((b) => {
    b.addEventListener('click', () => {
      if (state.memberSub === b.dataset.sub) return;
      state.memberSub = b.dataset.sub;
      syncMemberSub();
    });
  });
  $('btnGenCodes').addEventListener('click', genCodes);
  $('codeCount').addEventListener('keydown', (e) => { if (e.key === 'Enter') genCodes(); });
  $('btnReloadCodes').addEventListener('click', () => { loadMemberCodes(); toast('已刷新'); });
  $('btnCopyBatch').addEventListener('click', copyBatch);
  $('btnDisableCodes').addEventListener('click', disableCodes);
  $('codeStatus').addEventListener('change', (e) => {
    state.code.status = e.target.value;
    state.code.page = 1;
    loadMemberCodes();
  });

  // 勾选：行是动态渲染的，只能事件委托；全选只作用于当前页（跨页全选会误伤）
  $('codeAll').addEventListener('change', (e) => {
    const on = e.target.checked;
    state.codeSelected = [];
    document.querySelectorAll('#codeRows .code-pick').forEach((cb) => {
      cb.checked = on;
      if (on) state.codeSelected.push(cb.dataset.id);
    });
    syncCodeBar();
  });
  $('codeRows').addEventListener('change', (e) => {
    const cb = e.target.closest('.code-pick');
    if (!cb) return;
    const i = state.codeSelected.indexOf(cb.dataset.id);
    if (cb.checked && i < 0) state.codeSelected.push(cb.dataset.id);
    if (!cb.checked && i >= 0) state.codeSelected.splice(i, 1);
    syncCodeBar();
  });
  $('codeRows').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-copy]');
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast('已复制 ' + b.dataset.copy);
    } catch (err) {
      toast('复制失败，请手动选取该码', true);
    }
  });

  $('qMember').addEventListener('input', debounce((e) => {
    state.member.keyword = e.target.value.trim();
    state.member.page = 1;
    loadMemberUsers();
  }, 320));
  $('btnGrant').addEventListener('click', grantMember);
  $('grantOpenid').addEventListener('keydown', (e) => { if (e.key === 'Enter') grantMember(); });
  $('memberRows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-revoke]');
    if (b) revokeMember(b.dataset.revoke, b.dataset.nick);
  });
  $('accClose').addEventListener('click', closeAcc);
  $('accCancel').addEventListener('click', closeAcc);
  $('accSubmit').addEventListener('click', doAccSubmit);
  $('accPwd').addEventListener('input', syncAccTip);
  $('accName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('accPwd').focus(); });
  $('accPwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('accPwd2').focus(); });
  $('accPwd2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAccSubmit(); });
  $('accMask').addEventListener('click', (e) => { if (e.target === $('accMask')) closeAcc(); });

  /* 新增账号弹窗：点头像圆块选图（复用全局 #avFile，每次点击重挂 onchange 不冲突） */
  $('accAvatar').addEventListener('click', () => {
    const input = $('avFile');
    input.value = '';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const dataUrl = await fileToAvatarDataUrl(file);
        state.accAvatar = dataUrl;
        $('accAvatarImg').src = dataUrl;
        $('accAvatarImg').hidden = false;
        $('accAvatarPlaceholder').hidden = true;
        $('accAvatarTip').textContent = '已选择头像，保存后生效';
      } catch (err) {
        toast(err.message || '图片处理失败', true);
      }
    };
    input.click();
  });

  $('adminRows').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const d = btn.dataset;
    if (d.act === 'reset') openAccReset(d.id, d.name);
    if (d.act === 'toggle') toggleAdminUser(d.id, d.name, d.disabled === '1');
    if (d.act === 'del') deleteAdminUser(d.id, d.name);
    if (d.act === 'unlock') unlockLogin(d.name);
    if (d.act === 'avatar') changeAvatar(d.id, d.name);
  });

  $('foodRows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = state.rows.find((f) => f.id === btn.dataset.id);
    if (!row) return;
    if (btn.dataset.act === 'edit') openEdit(row);
    if (btn.dataset.act === 'toggle') {
      await api.foodHidden(row.id, !row.hidden);
      toast(row.hidden ? '已上架，重新进入抽签池' : '已下架，不再参与抽签');
      loadFoods();
    }
  });

  $('btnNewFood').addEventListener('click', () => openEdit(null));
  $('editClose').addEventListener('click', closeEdit);
  $('editCancel').addEventListener('click', closeEdit);
  $('editMask').addEventListener('click', (e) => { if (e.target.id === 'editMask') closeEdit(); });

  $('editSave').addEventListener('click', async () => {
    const name = $('fName').value.trim();
    if (!name) { toast('菜品名称不能为空', true); $('fName').focus(); return; }

    const btn = $('editSave');
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    const label = btn.textContent;
    btn.textContent = '保存中…';
    btn.disabled = true;

    try {
      const food = Object.assign({}, state.editing, {
        name: name,
        taste: $('fTaste').value,
        time: Number($('fTime').value) || 20,
        budget: Number($('fBudget').value) || 20,
        desc: $('fDesc').value.trim(),
        ing: $('fIng').value.trim(),
        steps: $('fSteps').value.trim()
      });

      // 选了新图才上传：先拿到 fileID 再存菜谱，避免存了个指向空白图的记录
      if (pickedImg) {
        btn.textContent = '上传图片…';
        const up = await api.uploadImage(pickedImg);
        food.img = up.fileID;
        delete food.imgUrl;
      }

      btn.textContent = '保存中…';
      const r = await api.foodSave(food);
      closeEdit();
      toast(r.mode === 'add' ? `已新增，编号 No.${r.foodNo}` : '已保存');
      loadFoods();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.dataset.busy = '';
      btn.textContent = label;
      btn.disabled = false;
    }
  });

  // 选图：本机压缩后先预览，点保存才真正上传
  $('btnPickImg').addEventListener('click', () => $('fileImg').click());
  $('fileImg').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) { toast('仅支持 jpg / png / webp', true); return; }
    try {
      pickedImg = await compressImage(file);
      $('fImg').src = pickedImg.previewUrl;
      $('btnClearImg').hidden = false;
    } catch (err) {
      toast(err.message || '图片处理失败', true);
    }
  });
  $('btnClearImg').addEventListener('click', () => {
    pickedImg = null;
    $('fImg').src = imgSrc(state.editing);
    $('btnClearImg').hidden = true;
  });

  // 批量导入
  $('btnBatchImport').addEventListener('click', openBatch);
  $('btnExportFoods').addEventListener('click', () => doExport('foods'));
  $('batchClose').addEventListener('click', closeBatch);
  $('batchCancel').addEventListener('click', closeBatch);
  $('batchMask').addEventListener('click', (e) => { if (e.target.id === 'batchMask') closeBatch(); });
  $('batchText').addEventListener('input', renderBatchPreview);
  $('batchSubmit').addEventListener('click', async () => {
    const { items } = parseBatch($('batchText').value);
    if (!items.length) return;

    const btn = $('batchSubmit');
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = `导入中…（${items.length} 条）`;

    try {
      const r = await api.foodBatch(items);
      closeBatch();
      // 有跳过/失败时用弹窗列明细：toast 一闪而过，用户看不清哪几条没进
      const extra = [];
      if (r.skipped && r.skipped.length) extra.push(`同名跳过 ${r.skipped.length} 条：${r.skipped.slice(0, 6).join('、')}${r.skipped.length > 6 ? ' 等' : ''}`);
      if (r.failed && r.failed.length) extra.push(`失败 ${r.failed.length} 条：${r.failed.slice(0, 4).map((f) => f.name + '(' + f.reason + ')').join('、')}`);
      if (extra.length) {
        alert(`导入完成：成功 ${r.added} 条\n\n${extra.join('\n')}`);
      } else {
        toast(`导入成功 ${r.added} 条`);
      }
      loadFoods();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.textContent = label;
      btn.disabled = false;
    }
  });

  // 配额
  $('btnUserSearch').addEventListener('click', () => loadQuota($('qUser').value.trim()));
  $('qUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadQuota($('qUser').value.trim()); });
  $('userRows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act=quota]');
    if (!btn) return;
    const openid = btn.dataset.openid;
    const isReset = btn.dataset.op === 'reset';
    btn.disabled = true;
    try {
      // +1 = 送一次（已用数 -1）；重置 = 回到满额（已用数归 0）
      const r = await api.quotaAdjust(openid, 'meal', isReset ? 99 : 1, AI_DAILY_QUOTA);
      toast(isReset ? '已重置为满额' : `已加 1 次，今日剩余 ${r.left} 次`);
      loadQuota($('qUser').value.trim());
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  // 反馈
  $('segFb').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state.fbScope = b.dataset.fbscope;
    $('segFb').querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
    loadFeedback(state.fbScope);
  });
  $('btnReloadFb').addEventListener('click', () => { loadFeedback(state.fbScope); toast('已刷新'); });
  $('fbRows').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act=fb]');
    if (btn) markFeedbackHandled(btn.dataset.id);
  });

  // 登录
  $('lgSubmit').addEventListener('click', doLogin);
  $('lgPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('lgUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lgPass').focus(); });

  // 修改密码
  $('pwdClose').addEventListener('click', closePwd);
  $('pwdCancel').addEventListener('click', closePwd);
  $('pwdSubmit').addEventListener('click', doChangePwd);
  $('pwdNew').addEventListener('input', syncPwdTip);
  $('pwdOld').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pwdNew').focus(); });
  $('pwdNew').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pwdNew2').focus(); });
  $('pwdNew2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doChangePwd(); });
  // 点遮罩空白处关闭（点弹层内部不关）
  $('pwdMask').addEventListener('click', (e) => { if (e.target === $('pwdMask')) closePwd(); });

  // ESC 关闭弹层
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('pwdMask').hidden) closePwd();
    else if (!$('accMask').hidden) closeAcc();
    else if (!$('bulkMask').hidden) closeBulkEdit();
    else if (!$('editMask').hidden) closeEdit();
    else if (!$('batchMask').hidden) closeBatch();
  });

  // 窗口尺寸变化重绘折线（只重绘图表，不重拉数据）
  let rz;
  window.addEventListener('resize', () => {
    clearTimeout(rz);
    rz = setTimeout(() => { if (state.tab === 'stat' && trendRows.length) renderTrend(trendRows); }, 160);
  });
}

function syncSegFb() {
  $('segFb').querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x.dataset.fbscope === state.fbScope));
}

function openBatch() {
  $('batchMask').hidden = false;
  renderBatchPreview();
  setTimeout(() => $('batchText').focus(), 80);
}
function closeBatch() { $('batchMask').hidden = true; }

/* ------------------------------------------------------------ 修改密码 */

/**
 * 密码规则与云函数 adminApi/auth.checkPasswordStrength 保持一致。
 * 前端先拦一道只是省一次往返，真正生效的是服务端校验——不能只信这里。
 */
function pwdProblem(p) {
  const s = String(p || '');
  if (!s) return '请输入新密码';
  if (s.length < 8) return '密码至少 8 位（还差 ' + (8 - s.length) + ' 位）';
  if (s.length > 64) return '密码过长（最多 64 位）';
  if (!/[a-zA-Z]/.test(s)) return '密码需包含字母';
  if (!/[0-9]/.test(s)) return '密码需包含数字';
  return '';
}

function openPwd() {
  if (!state.me || state.me.via !== 'web') {
    toast('仅账号密码登录的管理员可修改密码', true);
    return;
  }
  $('pwdOld').value = '';
  $('pwdNew').value = '';
  $('pwdNew2').value = '';
  $('pwdErr').textContent = '';
  $('pwdMask').hidden = false;
  syncPwdTip();
  setTimeout(() => $('pwdOld').focus(), 80);
}

function closePwd() { $('pwdMask').hidden = true; }

/** 新密码输入时的实时提示：还差什么一眼可见，不用等提交才报错 */
function syncPwdTip() {
  const v = $('pwdNew').value;
  const tip = $('pwdTip');
  const bad = pwdProblem(v);
  if (!v) {
    tip.textContent = '密码至少 8 位，需同时包含字母和数字（最长 64 位）';
    tip.classList.remove('ok');
    return;
  }
  tip.textContent = bad || '密码强度合格';
  tip.classList.toggle('ok', !bad);
}

async function doChangePwd() {
  const oldP = $('pwdOld').value;
  const newP = $('pwdNew').value;
  const newP2 = $('pwdNew2').value;
  const err = $('pwdErr');

  if (!oldP) { err.textContent = '请输入当前密码'; $('pwdOld').focus(); return; }
  const bad = pwdProblem(newP);
  if (bad) { err.textContent = bad; $('pwdNew').focus(); return; }
  if (newP !== newP2) { err.textContent = '两次输入的新密码不一致'; $('pwdNew2').focus(); return; }
  if (newP === oldP) { err.textContent = '新密码不能与当前密码相同'; $('pwdNew').focus(); return; }

  const btn = $('pwdSubmit');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '提交中…';
  err.textContent = '';

  try {
    const r = await api.changePwd(oldP, newP);
    // 服务端改密后旧 token 立即失效，会随响应下发一张新 token，换掉手里的那张
    if (r && r.token) api.setToken(r.token);
    closePwd();
    toast('密码已修改，其它设备需重新登录');
  } catch (e) {
    err.textContent = e.message || '修改失败';
    if (e.code === 'BAD_CREDENTIALS') { $('pwdOld').focus(); $('pwdOld').select(); }
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ---------------------------------------------------------------- 启动 */

function showLogin(msg) {
  $('loginWrap').hidden = false;
  $('lgErr').textContent = msg || '';
  $('lgPass').value = '';
  setTimeout(() => { ($('lgUser').value ? $('lgPass') : $('lgUser')).focus(); }, 80);
}

/** 登录态失效时的统一出口（由 api.call 内部触发） */
function onSessionLost(msg) {
  showLogin(msg || '登录已过期，请重新登录');
}

async function doLogin() {
  const u = $('lgUser').value.trim();
  const p = $('lgPass').value;
  if (!u || !p) {
    $('lgErr').textContent = '请填写账号和密码';
    return;
  }
  const btn = $('lgSubmit');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '登录中…';
  $('lgErr').textContent = '';

  try {
    await api.login(u, p, $('lgRemember') && $('lgRemember').checked);
    $('loginWrap').hidden = true;
    await boot();
  } catch (e) {
    $('lgErr').textContent = e.message || '登录失败';
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** 顶栏与侧栏的身份信息 */
function applyIdentity(me) {
  const isWeb = me.via === 'web';
  state.me = me;
  $('whoami').textContent = isWeb ? (me.username || '管理员') : '管理员';
  $('adminCount').textContent = isWeb
    ? '账号密码登录 · 会话 12 小时'
    : `微信身份 · ${(me.openid || '').slice(0, 8)}…（共 ${me.adminCount} 人）`;
  $('avatar').textContent = isWeb ? String(me.username || '管').slice(0, 1).toUpperCase() : '管';
  $('envTag').textContent = ENV_ID;
  // 修改密码只对账号密码通道开放（服务端 changePwd 限定 via='web'），
  // openid 通道直接隐藏入口，免得点了才被拒
  $('btnPwd').hidden = !isWeb;
}

async function boot() {
  if (!api.token && !api._mem) {
    showLogin();
    return;
  }

  let me;
  try {
    me = await api.whoami();
  } catch (e) {
    showLogin(e.message || '连接服务器失败');
    return;
  }

  if (!me.isAdmin) {
    api.setToken('');
    showLogin('登录状态无效，请重新登录');
    return;
  }

  $('loginWrap').hidden = true;
  applyIdentity(me);
  route();

  // 调试参数：?edit=<编号或菜名> 直接打开编辑弹层，?batch=1 打开批量导入（验收截图用）
  const em = location.search.match(/edit=([^&]+)/);
  if (em) {
    switchTab('foods');
    const key = decodeURIComponent(em[1]);
    const row = state.rows.find((f) => f.id === key || f.name === key);
    openEdit(row || (await findFood(key)));
  }
  if (location.search.indexOf('batch=1') >= 0) {
    switchTab('foods');
    $('batchText').value = '菜名|口味|时长|成本|食材|步骤\n宫保鸡丁|鲜辣|25|28|鸡胸肉、花生、黄瓜|切丁→腌制→爆炒\n番茄鸡蛋面|家常|15|8|番茄、鸡蛋、面条|炒蛋→煮面→合炒\n可乐鸡翅|酸甜|30|24|鸡翅、可乐、姜|焯水→煎黄→焖煮';
    openBatch();
  }
  if (location.search.indexOf('pwd=1') >= 0) openPwd();
  // 操作日志验收：直接落到日志分区（与 ?edit= / ?bulk=1 同风格）
  if (location.search.indexOf('log=1') >= 0) switchTab('log');
  // 批量操作条验收：勾前 3 行，省得手点（与 ?edit= / ?batch=1 同风格）
  if (location.search.indexOf('bulk=1') >= 0) {
    switchTab('foods');
    await loadFoods();
    state.selected = state.rows.slice(0, 3).map((f) => f.id);
    document.querySelectorAll('.ckRow').forEach((c, i) => { c.checked = i < 3; });
    syncBulkBar();
  }
}

/** 按关键字（编号或菜名）找一道菜，找不到返回 null（新增态） */
async function findFood(key) {
  try {
    const r = await api.foods({ page: 1, size: 20, keyword: '', scope: 'all' });
    return r.rows.find((f) => f.id === key || f.name === key || String(f.foodNo) === key) || null;
  } catch (e) {
    return null;
  }
}

function route() {
  const m = location.search.match(/tab=(\w+)/);
  switchTab(m && TITLES[m[1]] ? m[1] : 'stat');
}

bind();
if (location.search.indexOf('login') >= 0) {
  api.setToken('');
  showLogin();
} else {
  boot();
}
