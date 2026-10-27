/* =========================================================================
 * 免费音乐播放站 — 前端逻辑 v2
 * 音乐接口 : /api        → music-api.gdstudio.xyz
 * 账号接口 : /auth/*  /sync  /admin/api/*
 * ========================================================================= */
(() => {
  'use strict';

  const API = '/api';
  const PAGE_SIZE = 30;
  const LS_KEY = 'xq.state.v2';
  const MAX_RECENT = 100;
  const MAX_QUEUE = 200;

  /* ---------------------------------------------------------------- 音源表 */
  const SOURCES = [
    { id: 'netease',  name: '网易云音乐', extra: '曲库全 · 支持无损' },
    { id: 'joox',     name: 'JOOX',      extra: '港台 / 华语' },
    { id: 'tencent',  name: 'QQ 音乐',   extra: '华语主流' },
    { id: 'kugou',    name: '酷狗音乐',  extra: '华语 / 老歌' },
    { id: 'kuwo',     name: '酷我音乐',  extra: '华语 / 老歌' },
    { id: 'migu',     name: '咪咕音乐',  extra: '华语正版' },
    { id: 'tidal',    name: 'Tidal',     extra: '海外无损' },
    { id: 'ytmusic',  name: 'YouTube Music', extra: '海外曲库' },
  ];

  const BR_NAME = { 128: '标准', 192: '较高', 320: '高品质', 740: '无损', 999: 'Hi-Res' };

  // 站点外观默认值（后台可改，/site 覆盖）
  const SITE_DEFAULTS = {
    siteName: '免费音乐播放站',
    brandEn: 'FREE MUSIC STREAMING',
    logo: { mode: 'text', text: '柒', url: '' },
    entryKicker: 'LOCAL MUSIC STATION',
    entryTitle: '',
    entrySub: '搜索 · 试听 · 歌词 · 本机下载',
    entryBtn: '进入播放站',
    entryTags: ['多音源', '双音质', '歌词', '账号同步'],
    entryFoot: '免费音乐播放站 · 本地部署 v1.0.0 | 数据来自公开音乐接口',
  };

  /* ---------------------------------------------------------------- 状态 */
  const S = {
    source: 'netease',
    br: 320,            // 在线播放音质
    brDl: 320,          // 下载音质（独立）
    tab: 'search',
    results: [],
    queue: [],          // 只由用户手动添加
    recent: [],         // 最近播放
    nav: [],            // 上一首/下一首 的导航上下文
    ni: -1,
    page: 1,
    query: '',
    playing: false,
    mode: 'order',
    lyrics: [],
    lyrIdx: -1,
    offset: 0,
    cur: null,
    curUrl: '',
    usingProxy: false,
    loading: false,
    lastVolume: 82,
    user: null,
    site: null,
    saveTimer: null,
  };

  /* ---------------------------------------------------------------- DOM */
  const $ = (id) => document.getElementById(id);
  const D = {
    entry: $('entry'), enterBtn: $('enterBtn'), app: $('app'),
    form: $('searchForm'), q: $('q'),
    sourceSel: $('sourceSel'), qualitySel: $('qualitySel'),
    brand: $('brand'),
    tabs: [...document.querySelectorAll('.tab')],
    trackList: $('trackList'), empty: $('emptyState'), hotChips: $('hotChips'),
    loadMore: $('loadMoreBtn'), playAll: $('playAllBtn'), clearBtn: $('clearBtn'),
    queueCount: $('queueCount'), recentCount: $('recentCount'),
    netDot: $('netDot'),
    nowPanel: $('nowPanel'), nowClose: $('nowClose'),
    nowCover: $('nowCover'), vinyl: $('vinyl'), coverImg: $('coverImg'),
    nowTitle: $('nowTitle'), nowArtist: $('nowArtist'),
    badgeSource: $('badgeSource'), badgeBr: $('badgeBr'),
    lyricScroll: $('lyricScroll'), lyricInner: $('lyricInner'),
    lyricOffset: $('lyricOffset'), offsetVal: $('offsetVal'),
    playerbar: document.querySelector('.playerbar'), pbLeft: $('pbLeft'),
    pbWrap: document.querySelector('.pb-cover-wrap'),
    pbCover: $('pbCover'), pbTitle: $('pbTitle'), pbArtist: $('pbArtist'),
    audio: $('audio'),
    playBtn: $('playBtn'), prevBtn: $('prevBtn'), nextBtn: $('nextBtn'),
    modeBtn: $('modeBtn'), dlBtn: $('dlBtn'),
    seek: $('seek'), vol: $('vol'), volBtn: $('volBtn'),
    curTime: $('curTime'), durTime: $('durTime'),
    toasts: $('toasts'),
    // 站点外观
    brandMark: $('brandMark'), siteName: $('siteName'), brandEn: $('brandEn'),
    authBrandMark: $('authBrandMark'), authSiteName: $('authSiteName'),
    evLabel: $('evLabel'),
    entryKicker: $('entryKicker'), entryTitle: $('entryTitle'), entrySub: $('entrySub'),
    entryBtnText: $('entryBtnText'), entryTags: $('entryTags'), entryFoot: $('entryFoot'),
    // 账号
    loginBtn: $('loginBtn'), acctIn: $('acctIn'), acctAvatar: $('acctAvatar'),
    acctMenu: $('acctMenu'), acctInitial: $('acctInitial'),
    acctName: $('acctName'), acctRole: $('acctRole'),
    acctAdmin: $('acctAdmin'), acctLogout: $('acctLogout'),
    authModal: $('authModal'), authForm: $('authForm'),
    authUser: $('authUser'), authPass: $('authPass'),
    authError: $('authError'), authSubmit: $('authSubmit'), authHint: $('authHint'),
    authTabs: [...document.querySelectorAll('.auth-tab')],
    // 下载弹窗
    dlModal: $('dlModal'), dlSong: $('dlSong'), dlOpts: $('dlOpts'),
    dlOk: $('dlOk'), dlCancel: $('dlCancel'),
  };

  const ICON = (id) => '<svg><use href="#i-' + id + '"/></svg>';
  const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;
  const IS_MOBILE = () => window.matchMedia('(max-width: 980px)').matches;

  /* ---------------------------------------------------------------- 工具 */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmt = (sec) => {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };

  const keyOf = (t) => t.id + '|' + (t.album || '');

  function toast(msg, kind, ms) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    D.toasts.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 340);
    }, ms || 2400);
  }

  function setNet(state) {
    D.netDot.classList.toggle('is-off', state === 'off');
    D.netDot.classList.toggle('is-busy', state === 'busy');
  }

  /* ---------------------------------------------------------------- 请求 */
  async function readJson(res) {
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (e) { return {}; }
  }

  async function musicApi(params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(API + '?' + qs, { cache: 'no-store' });
    const data = await readJson(res);
    if (data && data._error) throw new Error(data._error);
    return data;
  }

  async function userApi(path, options) {
    const opt = Object.assign({ credentials: 'same-origin' }, options || {});
    if (opt.body && typeof opt.body !== 'string') {
      opt.headers = Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {});
      opt.body = JSON.stringify(opt.body);
    }
    const res = await fetch(path, opt);
    const data = await readJson(res);
    if (!res.ok) {
      const err = new Error(data.error || ('请求失败 (' + res.status + ')'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------------------------------------------------------------- 封面 */
  const proxied = (url) => '/img?url=' + encodeURIComponent(url);
  const picCache = new Map();

  function resolvePic(item, size) {
    const src = item.source || S.source;
    const pid = item.pic_id || item.id;
    if (!pid) return Promise.resolve('');
    const key = src + '|' + pid + '|' + size;
    if (picCache.has(key)) return Promise.resolve(picCache.get(key));
    return musicApi({ types: 'pic', source: src, id: pid, size: size })
      .then((d) => {
        const url = (d && d.url) || '';
        picCache.set(key, url);
        return url;
      })
      .catch(() => '');
  }

  function bindImgFallback(img) {
    img.addEventListener('error', () => {
      const src = img.getAttribute('src') || '';
      if (!src) return;
      if (img.dataset.fb) { img.style.opacity = '.15'; return; }
      img.dataset.fb = '1';
      if (src.indexOf('http') === 0) img.src = proxied(src);
    });
  }

  async function fillCovers() {
    const imgs = [...D.trackList.querySelectorAll('img.t-img')];
    let cursor = 0;
    const worker = async () => {
      while (cursor < imgs.length) {
        const img = imgs[cursor++];
        const box = img.closest('.t-cover');
        if (!box) continue;
        const url = await resolvePic({ source: box.dataset.src, pic_id: box.dataset.pic }, 300);
        if (url) img.src = url;
        else img.style.opacity = '.12';
      }
    };
    for (let i = 0; i < 5; i++) worker();
  }

  function bindPreview(scope) {
    if (IS_TOUCH) return;
    scope.querySelectorAll('.t-cover').forEach((box) => {
      box.addEventListener('mouseenter', () => {
        const big = box.querySelector('.t-big');
        if (!big || big.dataset.done) return;
        big.dataset.done = '1';
        resolvePic({ source: box.dataset.src, pic_id: box.dataset.pic }, 500)
          .then((url) => { if (url) big.src = url; });
      });
    });
  }

  /* ---------------------------------------------------------------- 本地存储 */
  function localState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      return obj;
    } catch (e) { return null; }
  }

  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        queue: S.queue,
        recent: S.recent,
        settings: { source: S.source, brPlay: S.br, brDownload: S.brDl },
      }));
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function scheduleCloudSave() {
    saveLocal();
    if (!S.user) return;
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(pushCloud, 700);
  }

  async function pushCloud() {
    if (!S.user) return;
    try {
      await userApi('/sync', {
        method: 'PUT',
        body: {
          queue: S.queue,
          recent: S.recent,
          settings: { source: S.source, brPlay: S.br, brDownload: S.brDl },
        },
      });
    } catch (e) {
      if (e.status === 401) signOutLocal();
    }
  }

  async function pullCloudAndMerge() {
    let data;
    try {
      data = await userApi('/sync');
    } catch (e) {
      return;
    }
    const serverQueue = Array.isArray(data.queue) ? data.queue : [];
    const serverRecent = Array.isArray(data.recent) ? data.recent : [];
    const srvSettings = data.settings || {};

    // 合并：服务端顺序优先，本地独有的追加在后
    const mergedQueue = dedupe(serverQueue.concat(S.queue), MAX_QUEUE);
    let mergedRecent = dedupe(serverRecent.concat(S.recent), MAX_RECENT);

    // 本地“有没有内容”决定设置以谁为准
    if (srvSettings.brPlay) S.br = srvSettings.brPlay;
    if (srvSettings.brDownload) S.brDl = srvSettings.brDownload;
    if (srvSettings.source) S.source = srvSettings.source;
    applySettingsToUI();

    S.queue = mergedQueue;
    S.recent = mergedRecent;
    renderCounts();
    if (S.tab === 'queue') renderQueue();
    if (S.tab === 'recent') renderRecent();

    pushCloud();
  }

  function dedupe(list, cap) {
    const out = [], seen = new Set();
    (list || []).forEach((t) => {
      if (!t || !t.id) return;
      const k = keyOf(t);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(t);
    });
    return out.slice(0, cap);
  }

  function applySettingsToUI() {
    D.qualitySel.value = String(S.br);
    if (!D.sourceSel.dataset.probed) {
      D.sourceSel.value = S.source;
    }
  }

  function renderCounts() {
    D.queueCount.textContent = S.queue.length;
    D.recentCount.textContent = S.recent.length;
  }

  /* ---------------------------------------------------------------- 音源探测 */
  let probed = false;
  async function probeSources() {
    if (probed) return;
    probed = true;
    const list = await Promise.all(SOURCES.map(async (s) => {
      if (s.id === S.source) return Object.assign({}, s, { ok: true, playable: true });
      try {
        const d = await musicApi({ types: 'search', source: s.id, name: 'love', count: 3, pages: 1 });
        if (!Array.isArray(d) || !d.length) return Object.assign({}, s, { ok: false, playable: false });
        let playable = false;
        try {
          const u = await musicApi({ types: 'url', source: s.id, id: d[0].url_id || d[0].id, br: 320 });
          playable = !!(u && u.url);
        } catch (e) { playable = false; }
        return Object.assign({}, s, { ok: true, playable: playable });
      } catch (e) {
        return Object.assign({}, s, { ok: false, playable: false });
      }
    }));
    renderSourceOptions(list);
  }

  function renderSourceOptions(list) {
    D.sourceSel.innerHTML = list.map((s) => {
      const sel = s.id === S.source ? ' selected' : '';
      const dis = s.playable ? '' : (s.ok ? '' : ' disabled');
      let label;
      if (s.playable) label = s.name;
      else if (s.ok) label = s.name + ' · 仅搜索';
      else label = s.name + ' · 不可用';
      return '<option value="' + s.id + '"' + sel + dis + ' title="' + esc(s.extra) + '">' +
             esc(label) + '</option>';
    }).join('');
    D.sourceSel.dataset.probed = '1';
  }

  /* ---------------------------------------------------------------- 搜索 */
  async function doSearch(name, page, append) {
    name = (name || '').trim();
    page = page || 1;
    if (!name) { D.q.focus(); return; }
    if (S.loading) return;

    S.query = name;
    S.loading = true;
    setNet('busy');
    D.loadMore.disabled = true;

    if (!append) {
      switchTab('search');
      D.empty.hidden = true;
      D.trackList.hidden = false;
      D.trackList.innerHTML = skeleton(6);
    } else {
      D.loadMore.textContent = '加载中…';
    }

    try {
      const data = await musicApi({
        types: 'search', source: S.source, name: name, count: PAGE_SIZE, pages: page,
      });
      if (!Array.isArray(data)) throw new Error('搜索结果格式异常');

      const items = data.map((it) => ({
        id: String(it.id),
        name: it.name || '未知曲目',
        artist: Array.isArray(it.artist) ? it.artist.filter(Boolean).join(' / ') : (it.artist || '未知歌手'),
        album: it.album || '',
        pic_id: it.pic_id || it.id,
        url_id: it.url_id || it.id,
        lyric_id: it.lyric_id || it.id,
        source: it.source || S.source,
      }));

      S.page = page;
      if (append) {
        const seen = {};
        S.results.forEach((r) => { seen[keyOf(r)] = 1; });
        S.results = S.results.concat(items.filter((i) => !seen[keyOf(i)]));
      } else {
        S.results = items;
      }
      renderTracks(S.results);
      D.loadMore.hidden = items.length < PAGE_SIZE;
      D.loadMore.textContent = '加载更多';
      setNet('on');
      if (!S.results.length) {
        D.empty.hidden = false;
        D.trackList.hidden = true;
        D.empty.querySelector('.empty-title').textContent = '没有找到相关结果';
        D.empty.querySelector('.empty-sub').textContent = '换个关键词，或者切换一个音源再试试';
      }
    } catch (err) {
      setNet('off');
      if (!append) { D.trackList.hidden = true; D.empty.hidden = false; }
      toast('搜索失败：' + err.message, 'err', 3200);
      D.loadMore.textContent = '加载更多';
    } finally {
      S.loading = false;
      D.loadMore.disabled = false;
    }
  }

  function skeleton(n) {
    let html = '';
    for (let i = 0; i < n; i++) {
      html += '<div class="skeleton-row">' +
        '<div class="sk sk-cover"></div>' +
        '<div><div class="sk sk-line w60"></div><div class="sk sk-line w35"></div></div>' +
        '<div class="sk" style="width:52px;height:20px"></div>' +
        '</div>';
    }
    return html;
  }

  /* ---------------------------------------------------------------- 列表 */
  function sourceName(id) {
    const s = SOURCES.find((x) => x.id === id);
    return s ? s.name : id;
  }

  function currentList() {
    if (S.tab === 'queue') return S.queue;
    if (S.tab === 'recent') return S.recent;
    return S.results;
  }

  function renderTracks(list) {
    if (!list.length) {
      D.trackList.innerHTML = '';
      D.trackList.hidden = true;
      D.empty.hidden = false;
      return;
    }
    D.empty.hidden = true;
    D.trackList.hidden = false;
    if (IS_TOUCH) D.trackList.classList.add('list-touch');

    const frag = document.createDocumentFragment();
    list.forEach((t, i) => frag.appendChild(trackRow(t, i)));
    D.trackList.innerHTML = '';
    D.trackList.appendChild(frag);
    highlightPlaying();
    [...D.trackList.querySelectorAll('img')].forEach(bindImgFallback);
    fillCovers();
    bindPreview(D.trackList);
  }

  function actionButtons(t, idx) {
    const inQueue = S.queue.some((q) => keyOf(q) === keyOf(t));
    if (S.tab === 'queue') {
      return '<button class="t-act is-del" data-act="remove" title="移出队列">' + ICON('close') + '</button>' +
             '<button class="t-act" data-act="download" title="下载到本机">' + ICON('download') + '</button>';
    }
    return '<button class="t-act' + (inQueue ? ' is-ok' : '') + '" data-act="queue" title="' +
             (inQueue ? '已在队列中' : '加入播放队列') + '">' + ICON(inQueue ? 'list' : 'plus') + '</button>' +
           '<button class="t-act" data-act="download" title="下载到本机">' + ICON('download') + '</button>';
  }

  function trackRow(t, idx) {
    const row = document.createElement('div');
    row.className = 'track';
    row.dataset.idx = idx;
    row.dataset.key = keyOf(t);
    row.style.animationDelay = Math.min(idx * 18, 320) + 'ms';

    row.innerHTML =
      '<div class="t-cover" data-src="' + esc(t.source || S.source) + '" data-pic="' + esc(t.pic_id || t.id) + '">' +
        '<img class="t-img" alt="" loading="lazy" />' +
        '<div class="t-play">' + ICON('play') + '</div>' +
        '<div class="t-preview"><img class="t-big" alt="" loading="lazy" /></div>' +
      '</div>' +
      '<div class="t-info">' +
        '<div class="t-name">' + esc(t.name) + '</div>' +
        '<div class="t-sub"><b>' + esc(t.artist) + '</b>' + (t.album ? '<i>·</i>' + esc(t.album) : '') + '</div>' +
      '</div>' +
      '<div class="t-meta"><span class="t-tag">' + esc(sourceName(t.source)) + '</span></div>' +
      '<div class="t-actions">' + actionButtons(t, idx) + '</div>';

    row.addEventListener('click', (ev) => {
      const act = ev.target.closest ? ev.target.closest('.t-act') : null;
      if (act) {
        ev.stopPropagation();
        if (act.dataset.act === 'queue') enqueue(t);
        else if (act.dataset.act === 'remove') removeFromQueue(t);
        else if (act.dataset.act === 'download') openDlModal(t, act);
        return;
      }
      playFromList(currentList(), idx);
    });

    return row;
  }

  function highlightPlaying() {
    const key = S.cur ? keyOf(S.cur) : '';
    D.trackList.querySelectorAll('.track').forEach((row) => {
      const on = key && row.dataset.key === key;
      row.classList.toggle('is-playing', !!on);
      const btn = row.querySelector('.t-play');
      if (btn) btn.innerHTML = ICON(on && S.playing ? 'pause' : 'play');
    });
  }

  /* ---------------------------------------------------------------- 队列（仅手动） */
  function enqueue(t, silent) {
    if (S.queue.some((q) => keyOf(q) === keyOf(t))) {
      if (!silent) toast('已在播放队列中');
      return false;
    }
    if (S.queue.length >= MAX_QUEUE) {
      toast('队列已达上限 ' + MAX_QUEUE + ' 首', 'err');
      return false;
    }
    S.queue.push(t);
    renderCounts();
    scheduleCloudSave();
    if (!silent) toast('已加入队列 · 共 ' + S.queue.length + ' 首', 'ok');
    if (S.tab === 'queue') renderQueue();
    refreshRowActions();
    return true;
  }

  function removeFromQueue(t) {
    const before = S.queue.length;
    S.queue = S.queue.filter((q) => keyOf(q) !== keyOf(t));
    if (S.queue.length !== before) {
      renderCounts();
      scheduleCloudSave();
      renderQueue();
      toast('已移出队列');
    }
  }

  function clearQueue(silent) {
    if (!S.queue.length) return;
    S.queue = [];
    renderCounts();
    scheduleCloudSave();
    renderQueue();
    if (!silent) toast('队列已清空', 'ok');
  }

  function renderQueue() {
    if (!S.queue.length) {
      D.trackList.hidden = true;
      D.empty.hidden = false;
      D.empty.querySelector('.empty-title').textContent = '播放队列还是空的';
      D.empty.querySelector('.empty-sub').textContent = '在搜索结果里点「+」手动加入，队列只收手动添加的歌';
      return;
    }
    renderTracks(S.queue);
  }

  function refreshRowActions() {
    if (S.tab === 'queue') return;
    D.trackList.querySelectorAll('.track').forEach((row) => {
      const box = row.querySelector('.t-actions');
      if (!box) return;
      const closed = box.querySelector('[data-act="queue"]');
      const down = box.querySelector('[data-act="download"]');
      if (!closed || !down) return;
      const t = currentList()[Number(row.dataset.idx)];
      if (!t) return;
      const inQueue = S.queue.some((q) => keyOf(q) === keyOf(t));
      closed.innerHTML = ICON(inQueue ? 'list' : 'plus');
      closed.title = inQueue ? '已在队列中' : '加入播放队列';
      closed.classList.toggle('is-ok', inQueue);
    });
  }

  /* ---------------------------------------------------------------- 最近播放 */
  function addRecent(t) {
    if (!t) return;
    S.recent = dedupe([t].concat(S.recent), MAX_RECENT);
    renderCounts();
    scheduleCloudSave();
    if (S.tab === 'recent') renderRecent();
  }

  function renderRecent() {
    if (!S.recent.length) {
      D.trackList.hidden = true;
      D.empty.hidden = false;
      D.empty.querySelector('.empty-title').textContent = '还没有播放记录';
      D.empty.querySelector('.empty-sub').textContent = '听过的歌会自动出现在这里';
      return;
    }
    renderTracks(S.recent);
  }

  /* ---------------------------------------------------------------- 播放地址 */
  function brChain(br) {
    const arr = [br];
    if (arr.indexOf(320) < 0) arr.push(320);
    if (arr.indexOf(128) < 0) arr.push(128);
    return arr;
  }

  async function resolveUrl(track, br) {
    const id = track.url_id || track.id;
    const chain = brChain(br || S.br);
    let lastErr = null;
    for (let i = 0; i < chain.length; i++) {
      try {
        const d = await musicApi({ types: 'url', source: track.source || S.source, id: id, br: chain[i] });
        if (d && d.url) return { url: d.url, br: d.br > 0 ? d.br : chain[i] };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('该曲目暂无可用播放地址');
  }

  /* ---------------------------------------------------------------- 播放 */
  async function playFromList(list, idx) {
    if (!list || !list[idx]) return;
    S.nav = list;
    await playAt(idx);
  }

  async function playAt(idx) {
    if (!S.nav || !S.nav[idx]) return;
    S.ni = idx;
    await playTrack(S.nav[idx]);
  }

  async function playTrack(t) {
    S.cur = t;
    S.usingProxy = false;
    S.lyrics = [];
    S.lyrIdx = -1;
    D.lyricInner.style.transform = 'none';
    D.lyricInner.innerHTML = '<p class="lyric-tip">歌词加载中…</p>';

    D.coverImg.removeAttribute('src');
    D.coverImg.dataset.fb = '';
    D.pbCover.removeAttribute('src');
    D.pbCover.dataset.fb = '';
    D.pbWrap.classList.add('is-empty');
    resolvePic(t, 500).then((u) => { if (u && S.cur === t) D.coverImg.src = u; });
    resolvePic(t, 300).then((u) => {
      if (u && S.cur === t) {
        D.pbCover.src = u;
        D.pbWrap.classList.remove('is-empty');
      }
    });

    D.nowTitle.textContent = t.name;
    D.nowArtist.textContent = t.artist + (t.album ? ' · ' + t.album : '');
    D.pbTitle.textContent = t.name;
    D.pbArtist.textContent = t.artist;
    D.badgeSource.textContent = '音源 ' + sourceName(t.source);
    D.badgeSource.classList.add('is-on');
    D.badgeBr.textContent = '音质 解析中…';
    D.badgeBr.classList.remove('is-on');
    D.nowCover.classList.add('is-on');
    document.title = t.name + ' - ' + siteName();
    highlightPlaying();

    loadLyric(t);

    D.playBtn.classList.add('is-loading');
    try {
      const r = await resolveUrl(t, S.br);
      S.curUrl = r.url;
      D.badgeBr.textContent = '音质 ' + (r.br >= 900 ? r.br + 'K 无损' : r.br + 'K');
      D.badgeBr.classList.add('is-on');

      D.audio.src = r.url;
      D.audio.load();
      await safePlay();
      addRecent(t);
    } catch (err) {
      toast('播放失败：' + err.message, 'err', 3200);
      D.badgeBr.textContent = '音质 —';
      S.playing = false;
      updatePlayUI();
    } finally {
      D.playBtn.classList.remove('is-loading');
    }
  }

  async function safePlay() {
    try {
      await D.audio.play();
      S.playing = true;
      updatePlayUI();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      S.playing = false;
      updatePlayUI();
      toast('点击播放按钮开始播放');
    }
  }

  function updatePlayUI() {
    D.playBtn.innerHTML = ICON(S.playing ? 'pause' : 'play');
    D.vinyl.classList.toggle('is-spinning', S.playing);
    D.playerbar.classList.toggle('is-playing', S.playing);
    highlightPlaying();
  }

  function togglePlay() {
    if (!S.cur) {
      const list = S.queue.length ? S.queue : S.recent.length ? S.recent : S.results;
      if (list.length) return playFromList(list, 0);
      toast('先搜索一首歌吧');
      return;
    }
    if (D.audio.paused) safePlay();
    else { D.audio.pause(); S.playing = false; updatePlayUI(); }
  }

  function nextIndex(step) {
    const list = S.nav || [];
    const n = list.length;
    if (!n) return -1;
    if (S.mode === 'shuffle') {
      if (n === 1) return 0;
      let r = S.ni;
      while (r === S.ni) r = Math.floor(Math.random() * n);
      return r;
    }
    return ((S.ni < 0 ? 0 : S.ni) + step + n) % n;
  }

  function playNext(manual) {
    if (!S.nav || !S.nav.length) { toast('当前没有可播放的列表'); return; }
    if (!manual && S.mode === 'single') { D.audio.currentTime = 0; safePlay(); return; }
    const i = nextIndex(1);
    if (i >= 0) playAt(i);
  }

  function playPrev() {
    if (!S.nav || !S.nav.length) return;
    if (D.audio.currentTime > 3) { D.audio.currentTime = 0; return; }
    const i = nextIndex(-1);
    if (i >= 0) playAt(i);
  }

  /* ---------------------------------------------------------------- 歌词 */
  function parseLRC(text) {
    const out = [];
    if (!text) return out;
    String(text).split(/\r?\n/).forEach((line) => {
      const stamps = [];
      const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
      let m;
      while ((m = re.exec(line)) !== null) stamps.push(m);
      if (!stamps.length) return;
      const content = line.replace(/\[[^\]]*\]/g, '').trim();
      if (!content) return;
      stamps.forEach((mm) => {
        const frac = mm[3] ? parseFloat('0.' + mm[3].padEnd(3, '0').slice(0, 3)) : 0;
        out.push({
          t: parseInt(mm[1], 10) * 60 + parseInt(mm[2], 10) + frac,
          text: content,
        });
      });
    });
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  async function loadLyric(t, attempt) {
    attempt = attempt || 1;
    try {
      const d = await musicApi({
        types: 'lyric',
        source: t.source || S.source,
        id: t.lyric_id || t.id,
      });
      if (S.cur !== t) return;

      const main = parseLRC(d.lyric || '');
      const trans = parseLRC(d.tlyric || '');
      if (!main.length) {
        D.lyricInner.innerHTML = '<p class="lyric-tip">暂无歌词<br><span style="font-size:11.5px;opacity:.6">纯音乐，请欣赏</span></p>';
        return;
      }
      if (trans.length) {
        main.forEach((line) => {
          const hit = trans.find((x) => Math.abs(x.t - line.t) < 0.45);
          if (hit && hit.text !== line.text) line.tr = hit.text;
        });
      }
      S.lyrics = main;
      renderLyric();
      syncLyric(D.audio.currentTime || 0, true);
    } catch (e) {
      if (S.cur !== t) return;
      // 上游偶发抽风，自动重试两次
      if (attempt < 3) {
        D.lyricInner.innerHTML = '<p class="lyric-tip">歌词加载中…</p>';
        setTimeout(() => { if (S.cur === t) loadLyric(t, attempt + 1); }, 700 * attempt);
        return;
      }
      D.lyricInner.innerHTML = '<p class="lyric-tip">歌词加载失败<br><span style="font-size:11.5px;opacity:.6">稍后再试或换一首</span></p>';
    }
  }

  function renderLyric() {
    D.lyricInner.style.transform = 'none';
    D.lyricInner.innerHTML = S.lyrics.map((l, i) =>
      '<div class="lyric-line" data-i="' + i + '">' + esc(l.text) +
      (l.tr ? '<span class="tr">' + esc(l.tr) + '</span>' : '') + '</div>'
    ).join('');

    D.lyricInner.querySelectorAll('.lyric-line').forEach((el) => {
      el.addEventListener('click', () => {
        const line = S.lyrics[+el.dataset.i];
        if (!line) return;
        D.audio.currentTime = Math.max(0, line.t - S.offset);
        if (D.audio.paused) safePlay();
      });
    });
  }

  function lyricIndexAt(time) {
    const arr = S.lyrics;
    if (!arr.length) return -1;
    const t = time + S.offset;
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function syncLyric(time, force) {
    const idx = lyricIndexAt(time);
    if (idx === S.lyrIdx && !force) return;
    S.lyrIdx = idx;

    const lines = D.lyricInner.querySelectorAll('.lyric-line');
    lines.forEach((el, i) => el.classList.toggle('is-active', i === idx));

    if (idx >= 0 && lines[idx]) {
      const el = lines[idx];
      const target = el.offsetTop + el.offsetHeight / 2 - D.lyricScroll.clientHeight / 2;
      D.lyricInner.style.transform = 'translateY(' + (-Math.max(0, target)) + 'px)';
    }
  }

  /* ---------------------------------------------------------------- 下载 */
  // 点击下载 → 先弹音质选择 → 确定才开始下；取消则什么都不做
  let dlPending = null;      // { track, btn, br }

  function openDlModal(track, btn) {
    const t = track || S.cur;
    if (!t) { toast('先选一首歌'); return; }

    dlPending = { track: t, btn: btn || null, br: S.brDl };
    D.dlSong.textContent = (t.artist ? t.artist + ' · ' : '') + t.name;
    D.dlOpts.querySelectorAll('.dl-opt').forEach((b) => {
      b.classList.toggle('is-active', Number(b.dataset.br) === S.brDl);
    });
    D.dlOk.disabled = false;
    D.dlOk.textContent = '确定下载';
    D.dlModal.hidden = false;
  }

  function closeDlModal() {
    D.dlModal.hidden = true;
    dlPending = null;
  }

  function pickDlBr(br) {
    if (!dlPending) return;
    dlPending.br = br;
    D.dlOpts.querySelectorAll('.dl-opt').forEach((b) => {
      b.classList.toggle('is-active', Number(b.dataset.br) === br);
    });
  }

  function confirmDownload() {
    if (!dlPending) return;
    const job = dlPending;
    S.brDl = job.br;                 // 记住这次选择，下次默认
    scheduleCloudSave();
    D.dlOk.disabled = true;
    D.dlOk.textContent = '准备中…';
    D.dlModal.hidden = true;
    dlPending = null;
    downloadTrack(job.track, job.btn, job.br);
  }

  async function downloadTrack(track, btn, br) {
    const t = track || S.cur;
    if (!t) { toast('先选一首歌'); return; }
    const targetBr = br || S.brDl;

    const prevHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.classList.add('is-ok'); }

    try {
      // 下载按用户选定的音质解析，与在线播放音质互不影响
      const r = await resolveUrl(t, targetBr);
      const url = r.url;

      const cleanArtist = String(t.artist || '').replace(/\s*\/\s*/g, ', ');
      const base = (cleanArtist + ' - ' + t.name)
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[\s._]+|[\s._]+$/g, '')
        .slice(0, 100);

      const res = await fetch('/dl?url=' + encodeURIComponent(url) + '&name=' + encodeURIComponent(base));
      if (!res.ok) throw new Error('下载通道异常 (' + res.status + ')');

      const total = Number(res.headers.get('Content-Length') || 0);
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;

      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        chunks.push(step.value);
        got += step.value.length;
        if (btn && total) btn.innerHTML = Math.min(99, Math.round(got / total * 100)) + '%';
      }

      const type = res.headers.get('Content-Type') || 'audio/mpeg';
      const blob = new Blob(chunks, { type: type.split(';')[0] });
      const name = guessName(res, base);

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1200);

      const br = r.br >= 900 ? r.br + 'K 无损' : r.br + 'K';
      toast('已保存到本机 · ' + name + ' · ' + br, 'ok', 3200);
    } catch (err) {
      toast('下载失败：' + err.message, 'err', 3200);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('is-ok');
        setTimeout(() => { btn.innerHTML = prevHTML; }, 1100);
      }
    }
  }

  function guessName(res, base) {
    const cd = res.headers.get('Content-Disposition') || '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (star) {
      try { return decodeURIComponent(star[1]); } catch (e) { /* noop */ }
    }
    return base + '.mp3';
  }

  /* ---------------------------------------------------------------- 标签页 */
  function switchTab(tab) {
    S.tab = tab;
    D.tabs.forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));

    D.playAll.hidden = false;
    D.clearBtn.hidden = tab === 'search';

    if (tab === 'search') {
      D.playAll.innerHTML = ICON('list') + ' 全部加入队列';
      if (S.results.length) renderTracks(S.results);
      else {
        D.trackList.hidden = true;
        D.empty.hidden = false;
        D.empty.querySelector('.empty-title').textContent = '今天想听点什么？';
        D.empty.querySelector('.empty-sub').textContent = '在上方输入歌名或歌手，回车即可搜索';
      }
    } else if (tab === 'queue') {
      D.playAll.innerHTML = ICON('play') + ' 播放全部';
      renderQueue();
    } else {
      D.playAll.innerHTML = ICON('list') + ' 全部加入队列';
      renderRecent();
    }
    D.loadMore.hidden = tab !== 'search' || S.results.length < PAGE_SIZE;
    highlightPlaying();
  }

  function setRangeFill(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const p = ((Number(input.value) - min) / (max - min)) * 100;
    input.style.setProperty('--p', p + '%');
  }

  /* ---------------------------------------------------------------- 账号 UI */
  function openAuth(mode) {
    authMode = mode || 'login';
    D.authModal.hidden = false;
    D.authError.hidden = true;
    setAuthMode(authMode);
    setTimeout(() => D.authUser.focus(), 120);
  }

  function closeAuth() { D.authModal.hidden = true; }

  let authMode = 'login';

  function setAuthMode(mode) {
    authMode = mode;
    D.authTabs.forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
    D.authSubmit.textContent = mode === 'login' ? '登录' : '注册';
    D.authPass.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    D.authHint.textContent = mode === 'login'
      ? '未登录也能正常听歌，登录后队列与最近播放会跟着账号走。'
      : '注册后播放队列、最近播放、音质偏好会保存到你的账号。';
  }

  function renderAccount() {
    const u = S.user;
    if (!u) {
      D.loginBtn.hidden = false;
      D.acctIn.hidden = true;
      D.acctMenu.classList.remove('is-open');
      return;
    }
    D.loginBtn.hidden = true;
    D.acctIn.hidden = false;
    D.acctInitial.textContent = (u.username || 'U').slice(0, 1).toUpperCase();
    D.acctName.textContent = u.username;
    D.acctRole.textContent = u.role === 'admin' ? '管理员' : '普通用户';
    D.acctAdmin.hidden = u.role !== 'admin';
    D.acctAvatar.title = u.username;
  }

  function signOutLocal() {
    S.user = null;
    renderAccount();
  }

  async function refreshMe() {
    try {
      const d = await userApi('/auth/me');
      S.user = d.user || null;
    } catch (e) {
      S.user = null;
    }
    renderAccount();
  }

  async function submitAuth(ev) {
    ev.preventDefault();
    const username = D.authUser.value.trim();
    const password = D.authPass.value;
    if (!username || !password) {
      showAuthError('请填写用户名和密码');
      return;
    }
    D.authSubmit.disabled = true;
    D.authError.hidden = true;
    try {
      const path = authMode === 'login' ? '/auth/login' : '/auth/register';
      const d = await userApi(path, { method: 'POST', body: { username, password } });
      S.user = d.user;
      renderAccount();
      closeAuth();
      toast(authMode === 'login' ? '欢迎回来，' + d.user.username : '注册成功，已自动登录', 'ok');
      await pullCloudAndMerge();
    } catch (err) {
      showAuthError(err.message);
    } finally {
      D.authSubmit.disabled = false;
    }
  }

  function showAuthError(msg) {
    D.authError.textContent = msg;
    D.authError.hidden = false;
  }

  /* ---------------------------------------------------------------- 手机抽屉 */
  function openSheet() {
    if (!IS_MOBILE()) return;
    D.nowPanel.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => syncLyric(D.audio.currentTime || 0, true), 420);
  }

  function closeSheet() {
    D.nowPanel.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  /* ---------------------------------------------------------------- 站点外观 */
  const siteCfg = () => S.site || SITE_DEFAULTS;
  const siteName = () => siteCfg().siteName || SITE_DEFAULTS.siteName;

  async function loadSite() {
    try {
      const d = await userApi('/site');
      const raw = (d && d.site) || {};
      S.site = Object.assign({}, SITE_DEFAULTS, raw, {
        logo: Object.assign({}, SITE_DEFAULTS.logo, raw.logo || {}),
        entryTags: Array.isArray(raw.entryTags) ? raw.entryTags : SITE_DEFAULTS.entryTags.slice(),
      });
    } catch (e) {
      S.site = Object.assign({}, SITE_DEFAULTS, { logo: Object.assign({}, SITE_DEFAULTS.logo) });
    }
    applySite();
  }

  function paintLogo(el, round) {
    if (!el) return;
    const logo = siteCfg().logo || SITE_DEFAULTS.logo;
    if (logo.mode === 'image' && logo.url) {
      el.innerHTML = '<img src="' + esc(logo.url) + '" alt="logo" />';
    } else {
      const glyph = logo.text || '柒';
      el.innerHTML = round
        ? '<span>' + esc(glyph) + '</span>'
        : '<span class="bm-glyph">' + esc(glyph) + '</span>';
    }
  }

  function entryBtnLabel() {
    return S.cur ? '继续听' : (siteCfg().entryBtn || SITE_DEFAULTS.entryBtn);
  }

  function applySite() {
    const c = siteCfg();
    document.title = siteName();
    D.siteName.textContent = siteName();
    D.brandEn.textContent = c.brandEn || '';
    D.authSiteName.textContent = siteName();

    D.entryKicker.textContent = c.entryKicker || '';
    D.entryTitle.textContent = c.entryTitle || siteName();
    D.entrySub.textContent = c.entrySub || '';
    D.entryBtnText.textContent = entryBtnLabel();
    D.entryTags.innerHTML = (c.entryTags || []).map((t) => '<li>' + esc(t) + '</li>').join('');
    D.entryFoot.textContent = c.entryFoot || '';

    paintLogo(D.brandMark, false);
    paintLogo(D.authBrandMark, false);
    paintLogo(D.evLabel, true);
  }

  /* ---------------------------------------------------------------- 入口 */
  function enterApp(skipAnim) {
    if (D.entry.dataset.done) return;
    D.entry.dataset.done = '1';
    D.entry.classList.remove('is-back');
    D.app.classList.add('is-in');
    D.app.setAttribute('aria-hidden', 'false');
    if (skipAnim) {
      D.entry.style.display = 'none';
    } else {
      D.entry.classList.add('is-leaving');
      setTimeout(() => { D.entry.style.display = 'none'; }, 820);
    }
    setTimeout(() => {
      if (!IS_MOBILE()) D.q.focus();
      probeSources();
    }, skipAnim ? 120 : 900);
  }

  // 点左上角品牌 → 回到入场界面（音乐不中断，可再点进来继续）
  function showEntry() {
    closeAuth();
    closeDlModal();
    closeSheet();
    D.acctMenu.classList.remove('is-open');

    D.entry.dataset.done = '';
    D.entry.style.display = '';
    D.entry.classList.remove('is-leaving');
    void D.entry.offsetWidth;               // 强制重排，让动画重新播放
    D.entry.classList.add('is-back');

    D.app.classList.remove('is-in');
    D.app.setAttribute('aria-hidden', 'true');
    document.title = siteName();

    D.entryBtnText.textContent = entryBtnLabel();

    setTimeout(() => D.entry.classList.remove('is-back'), 700);
  }

  /* ---------------------------------------------------------------- 事件 */
  D.brand.addEventListener('click', (ev) => {
    ev.preventDefault();
    showEntry();
  });

  D.enterBtn.addEventListener('click', () => enterApp(false));

  D.form.addEventListener('submit', (e) => {
    e.preventDefault();
    doSearch(D.q.value, 1, false);
    D.q.blur();
  });

  D.sourceSel.addEventListener('change', () => {
    S.source = D.sourceSel.value;
    const s = SOURCES.find((x) => x.id === S.source);
    toast('已切换音源：' + (s ? s.name : S.source));
    scheduleCloudSave();
    if (D.q.value.trim()) doSearch(D.q.value, 1, false);
  });

  D.qualitySel.addEventListener('change', () => {
    S.br = Number(D.qualitySel.value);
    toast('在线播放音质：' + S.br + 'K · ' + BR_NAME[S.br]);
    scheduleCloudSave();
    if (!S.cur) return;
    const at = D.audio.currentTime;
    const wasPlaying = !D.audio.paused;
    const target = S.cur;
    resolveUrl(target, S.br).then((r) => {
      if (S.cur !== target) return;
      S.curUrl = r.url;
      D.badgeBr.textContent = '音质 ' + (r.br >= 900 ? r.br + 'K 无损' : r.br + 'K');
      D.audio.src = r.url;
      D.audio.load();
      D.audio.currentTime = at;
      if (wasPlaying) safePlay();
    }).catch(() => toast('切换音质失败', 'err'));
  });

  // 下载音质弹窗
  D.dlOpts.addEventListener('click', (ev) => {
    const b = ev.target.closest('.dl-opt');
    if (b) pickDlBr(Number(b.dataset.br));
  });
  D.dlOk.addEventListener('click', confirmDownload);
  D.dlCancel.addEventListener('click', closeDlModal);
  D.dlModal.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-close]')) closeDlModal();
  });

  D.tabs.forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  D.loadMore.addEventListener('click', () => doSearch(S.query, S.page + 1, true));

  D.playAll.addEventListener('click', () => {
    if (S.tab === 'queue') {
      if (!S.queue.length) { toast('队列是空的'); return; }
      playFromList(S.queue, 0);
      toast('开始播放队列 ' + S.queue.length + ' 首', 'ok');
      return;
    }
    const list = currentList();
    if (!list.length) { toast('列表是空的'); return; }
    let added = 0;
    list.forEach((t) => { if (enqueue(t, true)) added += 1; });
    renderCounts();
    toast(added ? '已加入 ' + added + ' 首到播放队列' : '这些歌都已在队列中', added ? 'ok' : '');
    scheduleCloudSave();
    if (added) playFromList(S.queue.slice(), 0);
  });

  D.clearBtn.addEventListener('click', () => {
    if (S.tab === 'queue') {
      if (!S.queue.length) return;
      clearQueue();
    } else if (S.tab === 'recent') {
      if (!S.recent.length) return;
      S.recent = [];
      renderCounts();
      scheduleCloudSave();
      renderRecent();
      toast('最近播放已清空', 'ok');
    }
  });

  D.playBtn.addEventListener('click', togglePlay);
  D.nextBtn.addEventListener('click', () => playNext(true));
  D.prevBtn.addEventListener('click', playPrev);
  D.dlBtn.addEventListener('click', () => openDlModal(S.cur, null));

  const MODES = [
    { k: 'order', icon: 'order', tip: '顺序播放' },
    { k: 'single', icon: 'single', tip: '单曲循环' },
    { k: 'shuffle', icon: 'shuffle', tip: '随机播放' },
  ];
  D.modeBtn.addEventListener('click', () => {
    let i = 0;
    MODES.forEach((m, k) => { if (m.k === S.mode) i = k; });
    const next = MODES[(i + 1) % MODES.length];
    S.mode = next.k;
    D.modeBtn.innerHTML = ICON(next.icon);
    D.modeBtn.title = next.tip;
    toast(next.tip);
  });

  // 进度
  let seeking = false;
  D.seek.addEventListener('input', () => {
    seeking = true;
    setRangeFill(D.seek);
    const d = D.audio.duration || 0;
    D.curTime.textContent = fmt(d * (Number(D.seek.value) / 1000));
  });
  D.seek.addEventListener('change', () => {
    const d = D.audio.duration || 0;
    if (d) D.audio.currentTime = d * (Number(D.seek.value) / 1000);
    seeking = false;
  });

  // 音量
  D.vol.addEventListener('input', () => {
    const v = Number(D.vol.value);
    D.audio.volume = v / 100;
    if (v > 0) S.lastVolume = v;
    setRangeFill(D.vol);
    D.volBtn.innerHTML = ICON(v === 0 ? 'mute' : 'volume');
  });
  D.volBtn.addEventListener('click', () => {
    if (D.audio.volume > 0) {
      S.lastVolume = Number(D.vol.value) || 82;
      D.audio.volume = 0;
      D.vol.value = 0;
    } else {
      D.audio.volume = S.lastVolume / 100;
      D.vol.value = S.lastVolume;
    }
    setRangeFill(D.vol);
    D.volBtn.innerHTML = ICON(D.audio.volume === 0 ? 'mute' : 'volume');
  });

  // 歌词偏移
  D.lyricOffset.addEventListener('input', () => {
    S.offset = Number(D.lyricOffset.value);
    D.offsetVal.textContent = (S.offset > 0 ? '+' : '') + S.offset.toFixed(1) + 's';
    syncLyric(D.audio.currentTime || 0, true);
  });

  // 手机抽屉
  D.pbLeft.addEventListener('click', () => {
    if (!IS_MOBILE()) return;
    if (D.nowPanel.classList.contains('is-open')) closeSheet();
    else openSheet();
  });
  D.nowClose.addEventListener('click', closeSheet);

  // 账号
  D.loginBtn.addEventListener('click', () => openAuth('login'));
  D.acctAvatar.addEventListener('click', (e) => {
    e.stopPropagation();
    D.acctMenu.classList.toggle('is-open');
  });
  document.addEventListener('click', (e) => {
    if (!D.acctMenu.contains(e.target)) D.acctMenu.classList.remove('is-open');
  });
  D.acctAdmin.addEventListener('click', () => {
    window.open('/admin', '_blank', 'noopener');
  });
  D.acctLogout.addEventListener('click', async () => {
    try { await userApi('/auth/logout', { method: 'POST' }); } catch (e) { /* noop */ }
    signOutLocal();
    D.acctMenu.classList.remove('is-open');
    toast('已退出登录', 'ok');
  });

  D.authTabs.forEach((b) => b.addEventListener('click', () => {
    setAuthMode(b.dataset.mode);
    D.authError.hidden = true;
  }));
  D.authForm.addEventListener('submit', submitAuth);
  D.authModal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeAuth();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!D.authModal.hidden) closeAuth();
      if (!D.dlModal.hidden) closeDlModal();
      if (D.nowPanel.classList.contains('is-open')) closeSheet();
    }
  });

  // 音频事件
  D.audio.addEventListener('timeupdate', () => {
    if (!seeking) {
      const d = D.audio.duration || 0;
      if (d) {
        D.seek.value = Math.round((D.audio.currentTime / d) * 1000);
        setRangeFill(D.seek);
      }
      D.curTime.textContent = fmt(D.audio.currentTime);
    }
    syncLyric(D.audio.currentTime || 0, false);
  });

  D.audio.addEventListener('loadedmetadata', () => {
    D.durTime.textContent = fmt(D.audio.duration);
  });

  D.audio.addEventListener('play', () => { S.playing = true; updatePlayUI(); });
  D.audio.addEventListener('pause', () => { S.playing = false; updatePlayUI(); });

  D.audio.addEventListener('ended', () => {
    if (S.mode === 'single') { D.audio.currentTime = 0; safePlay(); return; }
    playNext(false);
  });

  D.audio.addEventListener('error', () => {
    if (!S.cur) return;
    if (!S.usingProxy && S.curUrl) {
      S.usingProxy = true;
      const at = D.audio.currentTime || 0;
      D.audio.src = '/stream?url=' + encodeURIComponent(S.curUrl);
      D.audio.load();
      D.audio.currentTime = at;
      safePlay();
      return;
    }
    toast('该曲目无法播放，试试切换音质或下一首', 'err', 3000);
    S.playing = false;
    updatePlayUI();
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!D.authModal.hidden || !D.dlModal.hidden) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowRight' && e.shiftKey) { e.preventDefault(); playNext(true); }
    else if (e.code === 'ArrowLeft' && e.shiftKey) { e.preventDefault(); playPrev(); }
    else if (e.code === 'ArrowRight') { D.audio.currentTime = Math.min(D.audio.duration || 0, D.audio.currentTime + 5); }
    else if (e.code === 'ArrowLeft') { D.audio.currentTime = Math.max(0, D.audio.currentTime - 5); }
    else if (e.key === 'm' || e.key === 'M') { D.volBtn.click(); }
  });

  window.addEventListener('resize', () => {
    if (!IS_MOBILE()) closeSheet();
    if (S.lyrIdx >= 0) syncLyric(D.audio.currentTime || 0, true);
  });

  /* ---------------------------------------------------------------- 初始化 */
  function init() {
    // 站点外观（站名 / Logo / 入场文案，来自后台设置）
    loadSite();

    // 热门快捷搜索
    const hots = ['周杰伦', '林俊杰', '陈奕迅', '邓紫棋', '薛之谦', '李荣浩', '粤语经典', '深夜emo'];
    D.hotChips.innerHTML = hots.map((h) => '<button type="button">' + esc(h) + '</button>').join('');
    D.hotChips.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        D.q.value = b.textContent;
        doSearch(b.textContent, 1, false);
      });
    });

    // 本地状态 / 设置
    const local = localState();
    if (local) {
      if (Array.isArray(local.queue)) S.queue = dedupe(local.queue, MAX_QUEUE);
      if (Array.isArray(local.recent)) S.recent = dedupe(local.recent, MAX_RECENT);
      const st = local.settings || {};
      if (st.source) S.source = st.source;
      if (st.brPlay) S.br = Number(st.brPlay);
      if (st.brDownload) S.brDl = Number(st.brDownload);
    }

    D.sourceSel.innerHTML = SOURCES.map((s) =>
      '<option value="' + s.id + '"' + (s.id === S.source ? ' selected' : '') + ' title="' +
      esc(s.extra) + '">' + esc(s.name) + '</option>'
    ).join('');

    D.qualitySel.value = String(S.br);
    setRangeFill(D.vol);
    setRangeFill(D.seek);
    D.audio.volume = Number(D.vol.value) / 100;
    D.audio.preload = 'metadata';
    D.offsetVal.textContent = '0.0s';
    D.modeBtn.innerHTML = ICON('order');
    D.playBtn.innerHTML = ICON('play');
    D.pbWrap.classList.add('is-empty');
    renderCounts();
    renderAccount();
    switchTab('search');

    [D.coverImg, D.pbCover].forEach(bindImgFallback);

    // 登录态 + 云同步
    refreshMe().then(() => {
      if (S.user) pullCloudAndMerge();
    });

    // URL 参数
    const params = new URLSearchParams(location.search);
    const preset = params.get('q');
    const auto = params.get('auto') === '1';
    if (params.get('fast') === '1') {
      enterApp(true);
      if (preset) {
        setTimeout(async () => {
          D.q.value = preset;
          await doSearch(preset, 1, false);
          if (auto && S.results.length) {
            playFromList(S.results, 0);
          }
        }, 80);
      }
    } else if (preset) {
      D.q.value = preset;
    }
  }

  init();
})();
