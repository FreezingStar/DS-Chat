/* DS Chat · app controller
 *
 * 结构：
 *   常量/状态 → 存储 → 主题 → 渲染（消息/侧栏）→ 输入框 → 会话生命周期
 *   → 流式（缓冲 + 逐帧释放）→ 侧栏（置顶/多选）→ 设置 → 弹层/对话框
 *   → 导入导出（JSON / DeepSeek ZIP）→ 事件绑定
 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var scroller, messagesEl, welcomeEl, inputEl, sendBtn, thinkChip, searchChip, topTitle;

  var APP_VERSION = '1.0.2';
  var chatStore = window.DSChatStore;
  var SETTINGS_KEY = 'ds.settings.v1';
  var CHATS_KEY = 'ds.chats.v1'; // legacy, migrated into the isolated workspace
  var STORE_KEYS = { isolated: 'ds.chats.isolated.v1', shared: 'ds.chats.shared.v1' };
  var MODELS = {
    'deepseek-flash': { tag: 'Flash', label: 'DeepSeek-V4.1-Flash' },
    'deepseek-v4-pro': { tag: 'Pro', label: 'DeepSeek-V4-Pro' }
  };
  var DEFAULTS = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    theme: 'auto',
    systemPrompt: '',
    thinking: true,
    effort: 'high',
    thinkLang: 'zh',
    draft: '',
    webSearch: false,
    stream: true,
    isolation: true,
    mode: 'isolated',
    accessMode: 'quick',
    limits: {
      isolated: { maxOutput: 256000, compactAt: 1000000, unlimited: false },
      shared: { maxOutput: 64000, compactAt: 1000000, maxChats: 100, maxContext: 20000000, unlimited: false }
    }
  };
  var MAX_IMAGES = 3;

  var state = {
    settings: Object.assign({}, DEFAULTS),
    chats: [],
    stores: { isolated: [], shared: [] },
    activeId: null,
    streams: {},
    selecting: false,
    selected: {},
    atBottom: true,
    filter: '',
    pending: [],
    mode: 'isolated',
    models: [],
    modelStatus: 'idle',
    modelError: '',
    modelsSource: ''
  };


  // ---------------------------------------------------------------- utils
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) { return MD.esc(s); }
  function now() { return Date.now(); }

  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 2000);
  }

  function haptic() {
    try {
      if (window.Native && window.Native.tap) window.Native.tap();
      else if (navigator.vibrate) navigator.vibrate(6);
    } catch (e) { /* noop */ }
  }

  function isQuick() { return state.settings.accessMode !== 'compat'; }

  function isDeepSeekCompat() {
    if (isQuick()) return true;
    return /deepseek/i.test(state.settings.baseUrl || '') || /^deepseek/i.test(state.settings.model || '');
  }

  function effectiveBase() {
    return isQuick() ? DEFAULTS.baseUrl : (state.settings.baseUrl || DEFAULTS.baseUrl);
  }

  function readConnectionInputs() {
    state.settings.apiKey = ($('#apiKey').value || '').trim();
    state.settings.baseUrl = isQuick()
      ? DEFAULTS.baseUrl
      : (($('#baseUrl').value || '').trim() || DEFAULTS.baseUrl);
    saveSettings();
  }

  function renderAccessUI() {
    setSegment('#accessSeg', isQuick() ? 'quick' : 'compat');
    var desc = $('#accessDesc');
    var baseBlock = $('#baseUrlBlock');
    var fetchBtn = $('#btnFetchModels');
    if (desc) {
      desc.textContent = isQuick()
        ? '只填 DeepSeek 的 API Key，地址固定为 api.deepseek.com，模型自动列出。'
        : '兼容任意 OpenAI 兼容接口：自定义地址、按接口返回的模型名切换。';
    }
    if (baseBlock) baseBlock.hidden = isQuick();
    if (fetchBtn) fetchBtn.hidden = isQuick();
  }

  function modelsSourceKey() {
    return (state.settings.apiKey || '') + '|' + (state.settings.baseUrl || '');
  }

  function renderModelSeg() {
    var seg = $('#modelSeg');
    var status = $('#modelStatus');
    var about = $('#aboutModel');
    if (!seg) return;
    var key = (state.settings.apiKey || '').trim();
    if (!key) {
      seg.innerHTML = '<button disabled>请先填写 API Key</button>';
      if (status) { status.textContent = '没有 API Key，无法读取模型'; status.className = 'model-status'; }
      if (about) about.textContent = '—';
      return;
    }
    if (state.modelStatus === 'loading') {
      seg.innerHTML = '<button disabled>读取中…</button>';
      if (status) { status.textContent = '正在获取模型列表…'; status.className = 'model-status'; }
      if (about) about.textContent = '—';
      return;
    }
    if (state.modelStatus === 'error') {
      seg.innerHTML = '<button disabled>无法获取模型</button>';
      if (status) { status.textContent = state.modelError || '获取失败，请检查 Key 与地址'; status.className = 'model-status err'; }
      if (about) about.textContent = '—';
      return;
    }
    if (!state.models.length) {
      seg.innerHTML = '<button disabled>未获取</button>';
      if (status) { status.textContent = '点下方按钮获取该接口的模型'; status.className = 'model-status'; }
      if (about) about.textContent = '—';
      return;
    }
    var html = '';
    state.models.forEach(function (m) {
      html += '<button data-value="' + esc(m.id) + '"' + (m.id === state.settings.model ? ' class="on"' : '') + '>' +
        esc(m.name || m.id) + '</button>';
    });
    seg.innerHTML = html;
    if (status) {
      status.textContent = '共 ' + state.models.length + ' 个模型 · ' + (isDeepSeekCompat() ? 'DeepSeek 接口' : '第三方兼容接口');
      status.className = 'model-status ok';
    }
    if (about) {
      var cur = state.models.filter(function (m) { return m.id === state.settings.model; })[0];
      about.textContent = cur ? (cur.name || cur.id) : state.settings.model;
    }
    var eb = $('#effortBlock');
    var lb = $('#langBlock');
    if (eb) eb.hidden = !isDeepSeekCompat();
    if (lb) lb.hidden = !isDeepSeekCompat();
  }

  var modelsTimer = 0;
  async function fetchModels(force) {
    var key = (state.settings.apiKey || '').trim();
    if (!key) { state.models = []; state.modelStatus = 'idle'; renderModelSeg(); return false; }
    if (!force && state.modelsSource === modelsSourceKey() && state.models.length) { renderModelSeg(); return true; }
    state.modelStatus = 'loading';
    renderModelSeg();
    try {
      var list = await DeepSeekAPI.listModels({ apiKey: key, base: effectiveBase() });
      state.models = (list || []).map(function (m) { return { id: m.id || m.name, name: m.name || m.id }; })
        .filter(function (m) { return m.id; });
      if (isQuick()) {
        state.models = state.models.filter(function (m) { return /^deepseek/i.test(m.id); });
        if (!state.models.length) throw new Error('这不是 DeepSeek 的 API Key（快速模式仅支持 DeepSeek）');
      }
      state.modelStatus = 'ok';
      state.modelsSource = modelsSourceKey();
      state.modelError = '';
      if (state.models.length && !state.models.some(function (m) { return m.id === state.settings.model; })) {
        var preferred = state.models.filter(function (m) { return /deepseek-flash/.test(m.id); })[0] || state.models[0];
        state.settings.model = preferred.id;
        saveSettings();
        toast('已切换模型：' + (preferred.name || preferred.id));
      }
      renderModelSeg();
      refreshSendState();
      return true;
    } catch (e) {
      state.models = [];
      state.modelStatus = 'error';
      state.modelError = (e && e.status === 401 && isQuick())
        ? '这个 Key 不是 DeepSeek 的（快速模式只能填 DeepSeek API Key），需要别家请切到兼容模式'
        : ((e && e.message) || '获取模型失败');
      state.modelsSource = '';
      renderModelSeg();
      return false;
    }
  }

  function currentModel() {
    return (state.settings.model || '').trim() || 'deepseek-flash';
  }

  function limitsFor(mode) {
    var l = (state.settings.limits || {})[mode] || {};
    var d = DEFAULTS.limits[mode];
    var unlimited = !!l.unlimited;
    return {
      unlimited: unlimited,
      maxOutput: unlimited || l.maxOutput === '' || l.maxOutput === undefined ? '' : Number(l.maxOutput),
      compactAt: Number(l.compactAt || d.compactAt) || d.compactAt,
      maxChats: d.maxChats,
      // 隔离对话没有上下文上限；共享创作才有单条上限
      maxContext: mode === 'isolated' ? Infinity : (Number(l.maxContext) || d.maxContext || Infinity)
    };
  }

  function capInfo() {
    var lim = limitsFor(state.mode);
    var window = Math.max(1000, lim.compactAt || MODEL_CONTEXT);
    var maxCompactions = Math.max(1, Math.floor((lim.maxContext || Infinity) / window));
    return { lim: lim, window: window, maxCompactions: maxCompactions };
  }

  async function manualCompact(chat) {
    if (!chat) { toast('请先打开一个对话'); return false; }
    toast('正在压缩上下文…');
    var ok = await compactChat(chat);
    if (!ok) { toast('没有可压缩的早期内容'); return false; }
    // an explicit compaction also resets the shared-mode budget
    chat.compactions = 0;
    delete chat.notice;
    saveChats();
    renderChatNotice();
    renderMessages(true);
    toast('已压缩，额度已重置，可以继续聊天');
    return true;
  }

  function markLimit(chat, info) {
    chat.notice = '本对话上下文已达上限（等效 ' + fmtNum(info.lim.maxContext) + ' tokens），请新开对话。';
    saveChats();
    renderChatNotice();
  }

  function renderChatNotice() {
    var el = $('#chatNotice');
    if (!el) return;
    var chat = activeChat();
    var info = capInfo();
    var exhausted = chat && state.mode === 'shared' && (chat.compactions || 0) >= info.maxCompactions;
    if (chat && (chat.notice || exhausted)) {
      el.textContent = (chat.notice || ('本对话上下文已达上限（等效 ' + fmtNum(info.lim.maxContext) + ' tokens）。'))
        + ' 点这里压缩并继续，或新开对话。';
      el.hidden = false;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  function estTokens(text) {
    if (!text) return 0;
    var s2 = String(text);
    var cjk = (s2.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    return Math.ceil(cjk * 0.95 + (s2.length - cjk) / 4);
  }

  function contextTokens(chat) {
    var n = 0;
    chat.messages.forEach(function (m) {
      if (m.content) n += estTokens(m.content);
      if (m.reasoning) n += estTokens(m.reasoning);
      if (m.images && m.images.length) n += m.images.length * 800;
    });
    return n;
  }

  function pushVersion(chat, kind) {
    if (!chat) return;
    var snap = JSON.parse(JSON.stringify(chat.messages, function (k, v) {
      return k.charAt(0) === '_' ? undefined : v;
    }));
    if (!snap.length) return;
    chat.versions = chat.versions || [];
    chat.versions.unshift({ id: uid(), at: now(), kind: kind, messages: snap });
    if (chat.versions.length > 20) chat.versions.length = 20;
  }

  function restoreVersion(chat, versionId) {
    if (!chat) return;
    var v = (chat.versions || []).filter(function (x) { return x.id === versionId; })[0];
    if (!v) return;
    chat.messages = JSON.parse(JSON.stringify(v.messages));
    chat.updatedAt = now();
    state.msgLimit = MSG_PAGE;
    saveChats();
    renderMessages();
    renderTop();
    closeSheetLike();
    toast('已恢复到修改前的版本');
  }

  function showVersions() {
    var chat = activeChat();
    if (!chat) return;
    var list = chat.versions || [];
    var mask = document.createElement('div');
    mask.className = 'dlg-mask';
    var rows = list.length ? list.map(function (v) {
      var d = new Date(v.at);
      var hh = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      var label = v.kind === 'edit' ? '编辑前' : (v.kind === 'regen' ? '重新生成前' : '历史版本');
      return '<div class="ver-item"><div class="meta">' + label + ' · ' + v.messages.length + ' 条消息<small>' +
        (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hh + '</small></div>' +
        '<button class="restore" data-restore="' + v.id + '">恢复</button></div>';
    }).join('') : '<p style="color:var(--label-tertiary);margin:10px 0">这个对话还没有历史版本。编辑消息或重新生成后会自动存档。</p>';
    mask.innerHTML = '<div class="dlg dlg-wide" role="dialog"><h3>历史版本</h3>' +
      '<p>共 ' + list.length + ' 个存档，恢复会覆盖当前对话内容。</p>' +
      '<div class="ver-list">' + rows + '</div>' +
      '<div class="dlg-actions"><button class="dlg-btn primary" data-close>关闭</button></div></div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-restore]');
      if (b) { restoreVersion(chat, b.getAttribute('data-restore')); return; }
      if (ev.target === mask || ev.target.closest('[data-close]')) mask.remove();
    });
    dialog._close = function () { mask.remove(); };
  }

  function closeSheetLike() {
    var m = document.querySelector('.dlg-mask');
    if (m) m.remove();
  }

  function optsFor(chat) {
    var d = { model: state.settings.model, thinking: state.settings.thinking, webSearch: state.settings.webSearch };
    if (!state.settings.isolation || !chat) return d;
    if (!chat.opts) {
      chat.opts = { model: chat.model || d.model, thinking: d.thinking, webSearch: d.webSearch };
    }
    return chat.opts;
  }

  function streamOf(chat) {
    if (!chat) return null;
    for (var k in state.streams) {
      if (state.streams[k].chat === chat) return state.streams[k];
    }
    return null;
  }

  function isStreamingMsg(id) { return !!state.streams[id]; }

  function activeChat() {
    if (!state.activeId) return null;
    for (var i = 0; i < state.chats.length; i++) {
      if (state.chats[i].id === state.activeId) return state.chats[i];
    }
    return null;
  }

  var GREETINGS = {
    midnight: ['夜深了，早点休息', '这个点还在？我陪你想完'],
    morning: ['早上好，今天想做点什么？', '早上好，先来杯水吧'],
    forenoon: ['上午好，有什么要处理的？', '上午好，先从哪件事开始？'],
    noon: ['中午好，吃点什么好呢', '午安，歇一会儿再继续'],
    afternoon: ['下午好，今天想聊些什么？', '下午好，来杯咖啡继续吧'],
    evening: ['晚上好，今天过得怎么样？', '晚上好，想聊点什么？']
  };

  function periodOf(date) {
    var t = date.getHours() * 60 + date.getMinutes();
    if (t < 5 * 60) return 'midnight';       // 00:00 - 04:59
    if (t < 9 * 60) return 'morning';        // 05:00 - 08:59
    if (t < 11 * 60 + 30) return 'forenoon'; // 09:00 - 11:29
    if (t < 13 * 60 + 30) return 'noon';     // 11:30 - 13:29
    if (t < 18 * 60) return 'afternoon';     // 13:30 - 17:59
    return 'evening';                        // 18:00 - 23:59
  }

  function greetingFor(date) {
    var period = periodOf(date);
    var lines = GREETINGS[period];
    // stable within a day+period, changes when the period changes
    var seed = date.getFullYear() * 372 + date.getMonth() * 31 + date.getDate() + period.length;
    return { period: period, text: lines[seed % lines.length] };
  }

  function refreshGreeting() {
    var next = greetingFor(new Date());
    if (!state.greeting || state.greeting.period !== next.period) {
      state.greeting = next;
      var el = $('#greeting');
      if (el) el.textContent = next.text;
    }
  }

  // ---------------------------------------------------------------- storage
  function byRecent(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }

  var saveTimer = 0;
  var dirtyStores = {};

  function plain(chats) {
    return JSON.parse(JSON.stringify(chats, function (k, v) {
      return k.charAt(0) === '_' ? undefined : v;
    }));
  }

  async function loadState() {
    try {
      var s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (s && typeof s === 'object') state.settings = Object.assign({}, DEFAULTS, s);
      var lm = state.settings.limits || {};
      state.settings.limits = {
        isolated: Object.assign({}, DEFAULTS.limits.isolated, lm.isolated || {}),
        shared: Object.assign({}, DEFAULTS.limits.shared, lm.shared || {})
      };
    } catch (e) { /* ignore */ }

    state.stores = {
      isolated: (await chatStore.load('isolated')).filter(function (x) { return x && typeof x.id === 'string'; }),
      shared: (await chatStore.load('shared')).filter(function (x) { return x && typeof x.id === 'string'; })
    };
    try { localStorage.removeItem('ds.chats.v1'); } catch (e) { /* migrated by the store */ }

    state.stores.isolated.sort(byRecent);
    state.stores.shared.sort(byRecent);
    state.mode = state.settings.mode === 'shared' ? 'shared' : 'isolated';
    state.chats = state.stores[state.mode];
    if (!state.chats.length) state.activeId = null;
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { /* quota */ }
  }

  function saveStore(mode) {
    if (state.stores[mode]) dirtyStores[mode] = true;
    flushChats();
  }

  async function flushChats() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    var modes = Object.keys(dirtyStores);
    for (var i = 0; i < modes.length; i++) {
      var mode = modes[i];
      dirtyStores[mode] = false;
      try {
        await chatStore.save(mode, plain(state.stores[mode] || []));
      } catch (e) {
        toast('保存失败：' + (e && e.message ? e.message : e));
      }
    }
  }

  function stripOldImages(total) {
    var removed = 0;
    for (var i = state.chats.length - 1; i >= 0 && removed < total; i--) {
      var msgs = state.chats[i].messages || [];
      for (var j = 0; j < msgs.length && removed < total; j++) {
        if (msgs[j].images && msgs[j].images.length) {
          msgs[j].images = [];
          removed++;
        }
      }
    }
    return removed;
  }

  function saveChats() {
    // state.chats may be rebound (filter/clear), so keep the workspace store in sync
    state.stores[state.mode] = state.chats;
    dirtyStores[state.mode] = true;
    if (chatStore.backend() !== 'IndexedDB') {
      // localStorage fallback: synchronous write, with image eviction when full
      try {
        chatStore.saveSync(state.mode, plain(state.chats));
      } catch (e) {
        var steps = [2, 6, 999];
        for (var a = 0; a < steps.length; a++) {
          stripOldImages(steps[a]);
          try {
            chatStore.saveSync(state.mode, plain(state.chats));
            toast('存储空间紧张，已清理较早的图片');
            return;
          } catch (e2) { /* try more */ }
        }
        toast('本地存储空间不足，请先导出备份再清理对话');
      }
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushChats, 300);
  }

  function fmtSize(n) {
    if (!n) return '0';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (Math.round(n * 10) / 10) + ' ' + u[i];
  }

  async function refreshStorageInfo() {
    var el = $('#storageLine');
    if (!el) return;
    var text = chatStore.backend() === 'IndexedDB' ? 'IndexedDB' : 'localStorage（约 5 MB）';
    if (navigator.storage && navigator.storage.estimate) {
      try {
        var est = await navigator.storage.estimate();
        if (est && est.quota) text += ' · 已用 ' + fmtSize(est.usage) + ' / 可用 ' + fmtSize(est.quota);
      } catch (e) { /* noop */ }
    }
    el.textContent = text;
  }

  // ---------------------------------------------------------------- theme
  function isDark() {
    var t = state.settings.theme;
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme() {
    var dark = isDark();
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', dark ? 'dark light' : 'light dark');
    try { if (window.Native && window.Native.setTheme) window.Native.setTheme(dark ? 1 : 0); } catch (e) { /* noop */ }
  }

  // ---------------------------------------------------------------- rendering
  var lastRender = { chatId: null, ids: {} };

  function renderTop() {
    var chat = activeChat();
    topTitle.textContent = chat ? (chat.title || '新对话') : '';
    var hb = $('#btnHistory');
    if (hb) hb.hidden = !chat;
  }

  function renderMessages(keepScroll) {
    var chat = activeChat();
    if (!chat || !chat.messages.length) {
      messagesEl.innerHTML = '';
      welcomeEl.hidden = false;
      $('#welcomeCta').hidden = !!state.settings.apiKey;
      refreshGreeting();
      $('#greeting').textContent = (state.greeting && state.greeting.text) || '你好，我能帮什么忙吗？';
      renderTop();
      renderChatNotice();
      return;
    }
    welcomeEl.hidden = true;
    var html = '';
    var total = chat.messages.length;
    var limit = state.msgLimit || MSG_PAGE;
    var startIdx = Math.max(0, total - limit);
    if (startIdx > 0) {
      html += '<button class="load-more" id="loadEarlierMsgs">加载更早的 ' + startIdx + ' 条消息</button>';
    }
    for (var i = startIdx; i < total; i++) html += renderMsg(chat.messages[i]);
    var sameChat = lastRender.chatId === chat.id;
    var prevIds = sameChat ? lastRender.ids : {};
    messagesEl.innerHTML = html;
    var ids = {};
    var nodes = messagesEl.querySelectorAll('.msg[data-id]');
    for (var k = 0; k < nodes.length; k++) {
      var nid = nodes[k].getAttribute('data-id');
      ids[nid] = 1;
      if (!prevIds[nid]) nodes[k].classList.add('enter');
    }
    lastRender.chatId = chat.id;
    lastRender.ids = ids;
    renderTop();
    renderChatNotice();
    if (!keepScroll) scrollToBottom(true);
  }

  function renderMsg(m) {
    if (m.role === 'user') {
      var imgs = '';
      if (m.images && m.images.length) {
        imgs = '<div class="bubble-imgs">' + m.images.map(function (src) {
          return '<img src="' + src + '" alt="" loading="lazy">';
        }).join('') + '</div>';
      }
      return '<div class="msg user" data-id="' + m.id + '">' +
        '<div class="bubble">' + imgs + (m.content ? '<span class="bubble-text">' + esc(m.content) + '</span>' : '') + '</div>' +
        '<div class="msg-actions">' +
        '<button data-act="copy" data-id="' + m.id + '" aria-label="复制"><svg class="ico"><use href="#i-copy"/></svg></button>' +
        '<button data-act="edit" data-id="' + m.id + '" aria-label="编辑"><svg class="ico"><use href="#i-edit"/></svg></button></div>' +
        '</div>';
    }
    var streaming = isStreamingMsg(m.id);
    var actions = streaming ? '' :
      '<div class="msg-actions">' +
      '<button data-act="copy" data-id="' + m.id + '" aria-label="复制"><svg class="ico"><use href="#i-copy"/></svg></button>' +
      '<button data-act="regen" data-id="' + m.id + '" aria-label="重新生成"><svg class="ico"><use href="#i-refresh"/></svg></button>' +
      '</div>';
    return '<div class="msg ai" data-id="' + m.id + '">' +
      '<div class="ai-body">' + aiBody(m, streaming) + '</div>' + actions + '</div>';
  }

  function aiBody(m, streaming) {
    var html = '';
    if (m.searching) {
      html += '<div class="search-state"><span class="spin"></span>正在搜索网页…</div>';
    }
    var hasSources = !!(m.sources && m.sources.length);
    if (m.reasoning || hasSources) {
      var open = m.reasonOpen !== undefined ? m.reasonOpen : (streaming ? !m.content : false);
      var label;
      if (m.reasoning) {
        label = streaming && !m.content ? '深度思考中' : ('已深度思考' + (m.reasonSec ? '（用时 ' + m.reasonSec + ' 秒）' : ''));
      } else {
        label = '联网搜索' + (m.sources && m.sources.length ? ' · ' + m.sources.length + ' 个来源' : '');
      }
      var headIcon = m.reasoning ? 'i-spark' : 'i-globe';
      html += '<div class="think' + (open ? ' open' : '') + '" data-think="' + m.id + '">' +
        '<div class="think-head"><svg class="ico"><use href="#' + headIcon + '"/></svg><span>' + label + '</span>' +
        '<svg class="ico chev"><use href="#i-chev-down"/></svg></div>' +
        '<div class="think-body">' +
        (m.reasoning ? '<div class="think-text">' + esc(m.reasoning) + '</div>' : '') +
        (hasSources ? sourcesPanel(m) : '') +
        '</div></div>';
    }
    if (m.error) html += errCard(m);
    if (m.content) {
      var rendered = MD.render(m.content);
      if (streaming) {
        var cut = rendered.lastIndexOf('</p>');
        rendered = cut >= 0 && cut === rendered.length - 4
          ? rendered.slice(0, cut) + '<span class="caret"></span></p>'
          : rendered + '<span class="caret"></span>';
      }
      html += rendered;
    } else if (streaming && !m.error) {
      html += '<div class="dots"><i></i><i></i><i></i></div>';
    }

    if (m.notice) html += '<div class="notice">' + esc(m.notice) + '</div>';
    if (!html) html = '<p style="color:var(--label-tertiary)">（无内容）</p>';
    return html;
  }

  function sourcesPanel(m) {
    var items = m.sources.map(function (s) {
      return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' +
        esc(s.title || s.url) + '</a>' + (s.site ? '<span class="site">' + esc(s.site) + '</span>' : '') + '</li>';
    }).join('');
    var count = '参考来源 · ' + m.sources.length;
    // without reasoning the outer thinking panel is the collapse, so show the list directly
    if (!m.reasoning) {
      return '<div class="src-box open"><div class="src-head static">' + count + '</div>' +
        '<ol class="src-list">' + items + '</ol></div>';
    }
    return '<div class="src-box' + (m.sourcesOpen ? ' open' : '') + '" data-src="' + m.id + '">' +
      '<div class="src-head"><svg class="ico chev"><use href="#i-chev-down"/></svg><span>' + count + '</span></div>' +
      '<ol class="src-list">' + items + '</ol></div>';
  }

  function errCard(m) {
    var hint = '';
    var status = m.errorStatus || 0;
    if (status === 401) hint = '<button class="mini-btn brand" data-act="settings">打开设置</button>';
    if (status === 402) hint = '<a class="mini-btn" href="https://platform.deepseek.com/top_up" target="_blank">去充值</a>';
    return '<div class="err-card"><svg class="ico"><use href="#i-alert"/></svg><div>' +
      esc(m.error) +
      '<div class="err-actions"><button class="mini-btn" data-act="regen" data-id="' + m.id + '">重试</button>' + hint + '</div>' +
      '</div></div>';
  }

  function chatSort(a, b) {
    if (!!b.pinned !== !!a.pinned) return a.pinned ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  }

  function groupChats(chats) {
    var startOfDay = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
    var groups = [
      { label: '今天', items: [] },
      { label: '昨天', items: [] },
      { label: '最近 7 天', items: [] },
      { label: '更早', items: [] }
    ];
    chats.forEach(function (c) {
      var t = c.updatedAt || c.createdAt || 0;
      if (t >= startOfDay) groups[0].items.push(c);
      else if (t >= startOfDay - 86400000) groups[1].items.push(c);
      else if (t >= startOfDay - 6 * 86400000) groups[2].items.push(c);
      else groups[3].items.push(c);
    });
    return groups.filter(function (g) { return g.items.length; });
  }

  function matchesFilter(chat) {
    var q = state.filter.trim().toLowerCase();
    if (!q) return true;
    if ((chat.title || '').toLowerCase().indexOf(q) >= 0) return true;
    return chat.messages.some(function (m) { return (m.content || '').toLowerCase().indexOf(q) >= 0; });
  }

  function chatItemHtml(c) {
    var cls = 'chat-item';
    if (c.id === state.activeId) cls += ' active';
    if (state.selecting) cls += ' selecting';
    if (state.selected[c.id]) cls += ' checked';
    var html = '<div class="' + cls + '" data-chat="' + c.id + '" role="button" tabindex="0">';
    if (state.selecting) {
      html += '<span class="check"><svg class="ico"><use href="#i-check"/></svg></span>';
    }
    html += '<span class="title">' + esc(c.title || '新对话') + '</span>';
    if (c.pinned) html += '<svg class="ico pin-ico"><use href="#i-pin"/></svg>';
    if (streamOf(c)) html += '<span class="stream-dot" aria-label="生成中"></span>';
    if (!state.selecting) html += '<span class="more" data-more="' + c.id + '" role="button" aria-label="更多">⋯</span>';
    return html + '</div>';
  }

  function sectionHtml(label, items) {
    var html = '<div class="list-group"><h4>' + label + '</h4>';
    items.forEach(function (c) { html += chatItemHtml(c); });
    return html + '</div>';
  }

  var MSG_PAGE = 80;
  var SIDEBAR_PAGE = 60;
  var sidebarDirty = true;

  function renderSidebar(force) {
    var drawerOpen = $('#drawer') && $('#drawer').classList.contains('open');
    if (!drawerOpen && !force) { sidebarDirty = true; return; }
    sidebarDirty = false;
    var list = $('#chatList');
    var chats = state.chats.filter(matchesFilter).slice().sort(chatSort);
    if (!chats.length) {
      list.innerHTML = '<div class="chat-empty">' +
        (state.filter ? '没有找到相关对话' : '暂无对话<br>你与 DeepSeek 的对话将展示在这里') +
        '</div>';
      updateSelectBar();
      return;
    }
    var limit = state.sidebarLimit || SIDEBAR_PAGE;
    var shown = chats.slice(0, limit);
    var pinned = shown.filter(function (c) { return c.pinned; });
    var rest = shown.filter(function (c) { return !c.pinned; });
    var html = '';
    if (pinned.length) html += sectionHtml('置顶', pinned);
    groupChats(rest).forEach(function (g) { html += sectionHtml(g.label, g.items); });
    if (chats.length > shown.length) {
      html += '<button class="load-more" id="loadMoreChats">显示更多（还有 ' + (chats.length - shown.length) + ' 个）</button>';
    }
    list.innerHTML = html;
    updateSelectBar();
  }

  function updateSelectBar() {
    var bar = $('#selectBar');
    if (!bar) return;
    var count = Object.keys(state.selected).length;
    bar.hidden = !state.selecting;
    $('#drawerFoot').hidden = state.selecting;
    $('#btnSelect').textContent = state.selecting ? '取消' : '选择';
    var cnt = $('#selectCount');
    if (cnt) cnt.textContent = '已选 ' + count;
  }

  function setSelecting(on) {
    state.selecting = !!on;
    state.selected = {};
    renderSidebar();
  }

  function toggleSelected(id) {
    if (state.selected[id]) delete state.selected[id];
    else state.selected[id] = true;
    renderSidebar();
  }

  function deleteSelected() {
    var ids = Object.keys(state.selected);
    if (!ids.length) { toast('请先勾选对话'); return; }
    dialog({
      title: '删除所选对话',
      text: '将删除 ' + ids.length + ' 个对话，无法恢复。',
      ok: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      ids.forEach(function (id) {
        for (var k in state.streams) {
          if (state.streams[k].chat && state.streams[k].chat.id === id) {
            try { state.streams[k].controller.abort(); } catch (e) { /* noop */ }
            delete state.streams[k];
          }
        }
      });
      state.chats = state.chats.filter(function (c) { return !state.selected[c.id]; });
      state.stores[state.mode] = state.chats;
      if (state.selected[state.activeId]) state.activeId = null;
      state.selecting = false;
      state.selected = {};
      saveChats();
      renderSidebar();
      renderMessages();
      toast('已删除 ' + ids.length + ' 个对话');
    });
  }

  function togglePin(id) {
    var chat = null;
    state.chats.forEach(function (c) { if (c.id === id) chat = c; });
    if (!chat) return;
    chat.pinned = !chat.pinned;
    saveChats();
    renderSidebar();
    toast(chat.pinned ? '已置顶' : '已取消置顶');
  }

  // ---------------------------------------------------------------- scroll
  var scrollQueued = 0;
  function scrollToBottom(force) {
    if (!force && !state.atBottom) return;
    if (force) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    if (scrollQueued) return;
    scrollQueued = requestAnimationFrame(function () {
      scrollQueued = 0;
      scroller.scrollTop = scroller.scrollHeight;
    });
  }

  function onScroll() {
    var gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    state.atBottom = gap < 120;
  }

  // ---------------------------------------------------------------- composer
  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
    refreshSendState();
  }

  function refreshSendState() {
    if (streamOf(activeChat())) {
      sendBtn.disabled = false;
      sendBtn.classList.add('stop');
      sendBtn.innerHTML = '<svg class="ico"><use href="#i-stop"/></svg>';
      sendBtn.setAttribute('aria-label', '停止');
    } else {
      sendBtn.classList.remove('stop');
      sendBtn.innerHTML = '<svg class="ico"><use href="#i-send"/></svg>';
      sendBtn.setAttribute('aria-label', '发送');
      sendBtn.disabled = !inputEl.value.trim() && !state.pending.length;
    }
    var o = optsFor(activeChat());
    thinkChip.setAttribute('aria-pressed', o.thinking ? 'true' : 'false');
    searchChip.setAttribute('aria-pressed', o.webSearch ? 'true' : 'false');
  }

  function renderTray() {
    var tray = $('#imgTray');
    if (!state.pending.length) {
      tray.hidden = true;
      tray.innerHTML = '';
      return;
    }
    tray.hidden = false;
    tray.innerHTML = state.pending.map(function (src, i) {
      return '<div class="thumb"><img src="' + src + '" alt=""><button class="thumb-x" data-rm="' + i + '" aria-label="移除">×</button></div>';
    }).join('');
  }

  function addImageFile(file) {
    if (!file || !/^image\//.test(file.type || '')) { toast('只支持图片文件'); return; }
    if (state.pending.length >= MAX_IMAGES) { toast('最多 ' + MAX_IMAGES + ' 张图片'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 1024;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        var data = canvas.toDataURL('image/jpeg', 0.78);
        state.pending.push(data);
        renderTray();
        refreshSendState();
      };
      img.onerror = function () { toast('图片读取失败'); };
      img.src = String(reader.result || '');
    };
    reader.onerror = function () { toast('图片读取失败'); };
    reader.readAsDataURL(file);
  }

  // ---------------------------------------------------------------- chat
  function toggleOpt(key) {
    var chat = activeChat();
    var target;
    if (state.settings.isolation && chat) {
      target = optsFor(chat);
      target[key] = !target[key];
      saveChats();
    } else {
      state.settings[key] = !state.settings[key];
      saveSettings();
    }
    if (key === 'thinking') refreshSendState();
    else refreshSendState();
    if (chat) chat.model = optsFor(chat).model;
    return (state.settings.isolation && chat) ? optsFor(chat)[key] : state.settings[key];
  }

  function stashDraft() {
    var chat = activeChat();
    if (chat) {
      chat.draft = inputEl.value;
      chat.scrollTop = scroller ? scroller.scrollTop : 0;
    } else {
      state.settings.draft = inputEl.value;
    }
  }

  function newChat() {
    stashDraft();
    state.activeId = null;
    state.msgLimit = MSG_PAGE;
    state.pending = [];
    inputEl.value = state.settings.draft || '';
    autosize();
    renderTray();
    renderMessages();
    renderSidebar();
    closeDrawer();
    closeSettings();
    inputEl.focus();
  }

  function openChat(id) {
    stashDraft();
    state.activeId = id;
    state.pending = [];
    var chat = activeChat();
    state.msgLimit = MSG_PAGE;
    inputEl.value = (chat && chat.draft) || '';
    autosize();
    var restoreTop = chat && chat.scrollTop ? chat.scrollTop : 0;
    renderTray();
    renderMessages();
    renderSidebar();
    closeDrawer();
    closeSettings();
    if (restoreTop) {
      requestAnimationFrame(function () { scroller.scrollTop = restoreTop; });
    }
  }

  function ensureChat() {
    var chat = activeChat();
    if (chat) return chat;
    if (state.mode === 'shared') {
      var lim = limitsFor('shared');
      if (state.chats.length >= lim.maxChats) {
        toast('共享创作最多 ' + lim.maxChats + ' 个对话，请先在侧栏删除一些');
        return null;
      }
    }
    chat = {
      id: uid(), title: '新对话', createdAt: now(), updatedAt: now(),
      model: currentModel(), messages: [],
      opts: { model: currentModel(), thinking: state.settings.thinking, webSearch: state.settings.webSearch }
    };
    state.chats.unshift(chat);
    state.activeId = chat.id;
    return chat;
  }

  function titleFrom(text) {
    var t = (text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '图片对话';
    return t.length > 24 ? t.slice(0, 24) + '…' : t;
  }

  var MODE_DESC = {
    isolated: '每次请求只带当前对话，适合日常问答。',
    shared: '所有对话合并成一份上下文，适合跨对话协作；工作区与隔离模式完全独立。'
  };

  function renderMode() {
    var shared = state.mode === 'shared';
    setSegment('#modeSeg', state.mode);
    var desc = $('#modeDesc');
    if (desc) desc.textContent = MODE_DESC[state.mode] || MODE_DESC.isolated;
    var meta = $('#footMeta');
    if (meta) meta.textContent = (shared ? '共享创作' : '隔离对话') + ' · v' + APP_VERSION;
    document.documentElement.setAttribute('data-ctx-mode', state.mode);
  }

  function setMode(mode) {
    if (mode !== 'shared' && mode !== 'isolated') return;
    if (state.mode === mode) return;
    Object.keys(state.streams).forEach(function (key) {
      try { state.streams[key].controller.abort(); } catch (e) { /* noop */ }
    });
    state.streams = {};
    state.mode = mode;
    state.settings.mode = mode;
    saveSettings();
    state.chats = state.stores[mode];
    state.activeId = null;
    state.pending = [];
    inputEl.value = '';
    renderTray();
    autosize();
    renderMode();
    renderSidebar();
    renderMessages();
    refreshSendState();
    toast(mode === 'shared' ? '已切换到共享创作（独立工作区）' : '已切换到隔离对话（独立工作区）');
  }


  var MODEL_CONTEXT = 1000000;

  async function summarizeOnce(previous, transcript) {
    var out = '';
    for await (var chunk of DeepSeekAPI.streamChat({
      apiKey: state.settings.apiKey,
      base: effectiveBase(),
      model: currentModel(),
      messages: [
        { role: 'system', content: '你是对话压缩器。把对话压缩成不超过 400 字的中文要点，保留事实、约定、数字和待办，不要寒暄。' },
        { role: 'user', content: (previous ? '已有摘要：\n' + previous + '\n\n' : '') + '新增对话：\n' + transcript }
      ],
      thinking: false,
      stream: false,
      deepseek: isDeepSeekCompat()
    })) {
      var c = chunk.choices && chunk.choices[0];
      if (c && c.delta && c.delta.content) out += c.delta.content;
    }
    return (out || '').trim();
  }

  // Summarise the older part of a chat in chunks, so even oversized
  // histories (way beyond the model window) can still be compacted.
  async function compactChat(chat) {
    var from = chat.summaryUpto || 0;
    var keep = Math.min(6, Math.max(1, chat.messages.length - from - 1));
    var upto = chat.messages.length - keep;
    if (upto <= from) return false;

    var older = chat.messages.slice(from, upto);
    var chunks = [];
    var current = [];
    var tokens = 0;
    older.forEach(function (m) {
      var line = (m.role === 'user' ? '用户：' : '助手：') + (m.content || '').slice(0, 2000);
      var t = estTokens(line) + 10;
      if (tokens + t > 120000 && current.length) {
        chunks.push(current);
        current = [];
        tokens = 0;
      }
      current.push(line);
      tokens += t;
    });
    if (current.length) chunks.push(current);

    var summary = chat.summary || '';
    for (var i = 0; i < chunks.length; i++) {
      if (chunks.length > 1) toast('正在压缩 ' + (i + 1) + ' / ' + chunks.length + ' 段');
      var next = await summarizeOnce(summary, chunks[i].join('\n'));
      if (!next) return false;
      summary = next.slice(0, 4000);
    }
    if (!summary) return false;
    chat.summary = summary;
    chat.summaryUpto = upto;
    return true;
  }

  async function maybeCompact(chat, pendingText) {
    var info = capInfo();
    var est = contextTokens(chat) + estTokens(pendingText);
    // never let a request run into the hard model window without compacting first
    var trigger = Math.min(info.window, MODEL_CONTEXT);
    if (est < trigger) return;
    var shared = state.mode === 'shared';
    if (shared && (chat.compactions || 0) >= info.maxCompactions) {
      markLimit(chat, info);
      toast('该对话上下文已达上限，请新开对话');
      return;
    }
    toast('上下文达到 ' + fmtNum(info.window) + ' tokens，正在自动压缩…');
    var ok = await compactChat(chat);
    if (!ok) return;
    chat.compactions = (chat.compactions || 0) + 1;
    if (shared && chat.compactions >= info.maxCompactions) markLimit(chat, info);
    saveChats();
    toast('已压缩上下文（' + chat.compactions + (shared ? ' / ' + info.maxCompactions : '') + '）');
  }

  function buildContext(chat, stopBefore, opts, notify) {
    var out = [];
    var sysParts = [];
    var sys = (state.settings.systemPrompt || '').trim();
    if (sys) sysParts.push(sys);
    if ((!opts || opts.thinking) && state.settings.thinkLang !== 'auto' && isDeepSeekCompat()) {
      sysParts.push('请使用简体中文进行内部思考和推理。');
    }

    // compacted history summaries
    var summaries = [];
    if (state.mode === 'shared') {
      state.chats.forEach(function (c) {
        if (c.summary) summaries.push('· ' + (c.title || '对话') + '：' + c.summary);
      });
    } else if (chat.summary) {
      summaries.push(chat.summary);
    }
    if (summaries.length) {
      sysParts.push('以下是更早对话的压缩摘要，请当作已发生的事实：\n' + summaries.join('\n'));
    }

    // Style continuity: after compaction the model only sees a summary, so show it
    // the most recent *uncompressed* replies and let it imitate that style and length.
    if (chat.summary) {
      var stopIdx = stopBefore ? chat.messages.indexOf(stopBefore) : chat.messages.length;
      if (stopIdx < 0) stopIdx = chat.messages.length;
      var fromIdx = chat.summaryUpto || 0;
      var style = [];
      var lens = [];
      for (var si = stopIdx - 1; si >= fromIdx && style.length < 5; si--) {
        var sm = chat.messages[si];
        if (!sm || sm.role !== 'assistant') continue;
        var full = (sm.content || '').trim();
        if (!full) continue;
        lens.push(full.length);
        var text = full.length > 400 ? full.slice(0, 400) + '…' : full;
        var line = '· ' + text;
        var think = (sm.reasoning || '').trim();
        if (think) line += '\n  （当时的思考片段：' + think.slice(0, 160) + '…）';
        style.unshift(line);
      }
      if (style.length) {
        var avg = Math.round(lens.reduce(function (a, b) { return a + b; }, 0) / lens.length);
        avg = Math.max(60, Math.min(1200, avg));
        sysParts.push('以下是本对话最近 ' + style.length + ' 条回复，请延续同样的思考深度、结构与语气。' +
          '篇幅也要接近：这些回复平均约 ' + avg + ' 字，你的回复不要明显过短或过长。' +
          '只作风格参考，不要逐字复述，也不要提到这条说明：\n' + style.join('\n'));
      }
    }
    if (sysParts.length) out.push({ role: 'system', content: sysParts.join('\n\n') });

    var entries = [];
    function collect(owner) {
      var from = owner.summaryUpto || 0;
      (owner.messages || []).forEach(function (m, idx) {
        if (idx < from) return;
        if (m === stopBefore) return;
        if (!m.content && !(m.images && m.images.length)) return;
        entries.push({ chat: owner, msg: m });
      });
    }
    if (state.mode === 'shared') {
      state.chats.forEach(collect);
      entries.sort(function (a, b) { return (a.msg.ts || 0) - (b.msg.ts || 0); });
    } else {
      collect(chat);
    }

    // hard guard: never exceed the model window (prompt + reserved completion)
    var lim = limitsFor(state.mode);
    var reserve = Math.min(lim.maxOutput || 8000, 384000);
    var budget = MODEL_CONTEXT - reserve - 2000;
    var total = 0;
    var startIdx = entries.length;
    for (var i = entries.length - 1; i >= 0; i--) {
      var e = entries[i];
      var size = estTokens(e.msg.content) + estTokens(e.msg.reasoning) + (e.msg.images ? e.msg.images.length * 800 : 0);
      if (total + size > budget) break;
      total += size;
      startIdx = i;
    }
    if (notify && startIdx > 0) toast('上下文超过模型窗口，已省略较早的 ' + startIdx + ' 条消息');

    // DeepSeek requires strict user/assistant alternation starting with a user turn.
    var safe = [];
    entries.slice(startIdx).forEach(function (e) {
      var role = e.msg.role === 'assistant' ? 'assistant' : 'user';
      if (!safe.length && role !== 'user') return;
      var last = safe[safe.length - 1];
      if (last && last.role === role) last.items.push(e);
      else safe.push({ role: role, items: [e] });
    });

    safe.forEach(function (group) {
      if (group.role === 'user') {
        var texts = [];
        var imgs = [];
        group.items.forEach(function (e) {
          if (e.msg.content) texts.push(e.msg.content);
          if (e.chat === chat && e.msg.images) imgs = imgs.concat(e.msg.images);
        });
        if (imgs.length) {
          var blocks = [];
          if (texts.length) blocks.push({ type: 'text', text: texts.join('\n\n') });
          imgs.forEach(function (src) { blocks.push({ type: 'image_url', image_url: { url: src } }); });
          out.push({ role: 'user', content: blocks });
        } else if (texts.length) {
          out.push({ role: 'user', content: texts.join('\n\n') });
        }
      } else {
        var parts = [];
        group.items.forEach(function (e) { if (e.msg.content) parts.push(e.msg.content); });
        if (parts.length) out.push({ role: 'assistant', content: parts.join('\n\n') });
      }
    });
    return out;
  }

  async function send() {
    var text = inputEl.value.trim();
    var images = state.pending.slice();
    if (!text && !images.length) return;
    if (state.compacting) return;
    var current = activeChat();
    if (current && streamOf(current)) { toast('这个对话还在生成中'); return; }
    if (!state.settings.apiKey) {
      openSettings();
      toast('请先填写 API Key');
      return;
    }
    var chat = ensureChat();
    if (!chat) return;
    var info0 = capInfo();
    if (state.mode === 'shared' && (chat.compactions || 0) >= info0.maxCompactions) {
      markLimit(chat, info0);
      toast('该对话上下文已达上限，请新开对话');
      return;
    }
    state.compacting = true;
    try { await maybeCompact(chat, text); } finally { state.compacting = false; }
    chat.messages.push({ id: uid(), role: 'user', content: text, images: images, ts: now() });
    if (!chat.title || chat.title === '新对话') chat.title = titleFrom(text);
    chat.updatedAt = now();
    chat.model = optsFor(chat).model;

    var o = optsFor(chat);
    var aiMsg = {
      id: uid(), role: 'assistant', content: '', reasoning: '', ts: now(),
      model: o.model,
      opts: { model: o.model, thinking: o.thinking, webSearch: o.webSearch }
    };
    chat.messages.push(aiMsg);

    inputEl.value = '';
    chat.draft = '';
    state.settings.draft = '';
    saveSettings();
    state.pending = [];
    renderTray();
    autosize();
    saveChats();
    renderMessages();
    scrollToBottom(true);
    refreshSendState();

    await runCompletion(chat, aiMsg);
  }

  function mergeToolCalls(msg, list) {
    if (!Array.isArray(list) || !list.length) return;
    msg.steps = msg.steps || [];
    list.forEach(function (step) {
      var si = typeof step.index === 'number' ? step.index : msg.steps.length;
      var cur = msg.steps[si];
      if (!cur) { cur = { index: si, reasoning_content: '', calls: [] }; msg.steps[si] = cur; }
      if (step.reasoning_content) cur.reasoning_content = step.reasoning_content;
      (step.calls || []).forEach(function (call) {
        var ci = typeof call.index === 'number' ? call.index : cur.calls.length;
        cur.calls[ci] = call;
      });
      cur.running = cur.calls.some(function (c) { return c && c.status !== 'completed' && c.status !== 'failed'; });
    });
    msg.searching = msg.steps.some(function (s) { return s && s.running; });
    var collected = collectSources(msg);
    if (collected.length) msg.sources = collected;
  }

  function collectSources(msg) {
    var out = [];
    var seen = {};
    (msg.steps || []).forEach(function (step) {
      (step && step.calls ? step.calls : []).forEach(function (call) {
        if (!call) return;
        (call.sources || []).forEach(function (s) {
          if (s && s.url && !seen[s.url]) {
            seen[s.url] = 1;
            out.push({ url: s.url, title: s.title || s.url, site: s.site_name || '' });
          }
        });
        if (call.page && call.page.url && !seen[call.page.url]) {
          seen[call.page.url] = 1;
          out.push({ url: call.page.url, title: call.page.title || call.page.url, site: '' });
        }
      });
    });
    return out;
  }

  async function runCompletion(chat, aiMsg) {
    var controller = new AbortController();
    state.streams[aiMsg.id] = { controller: controller, chat: chat, msg: aiMsg };
    refreshSendState();
    renderSidebar();
    paintMessage(aiMsg, true);

    var started = now();
    aiMsg._t0 = 0;
    var promptTokens = contextTokens(chat);

    try {
      var o = aiMsg.opts || optsFor(chat);
      for await (var chunk of DeepSeekAPI.streamChat({
        apiKey: state.settings.apiKey,
        base: effectiveBase(),
        model: o.model || currentModel(),
        messages: buildContext(chat, aiMsg, o, true),
        thinking: o.thinking,
        effort: state.settings.effort,
        webSearch: o.webSearch,
        deepseek: isDeepSeekCompat(),
        stream: state.settings.stream !== false,
        maxTokens: limitsFor(state.mode).maxOutput || undefined,
        signal: controller.signal
      })) {
        if (chunk.usage) {
          aiMsg.usage = chunk.usage;
          if (chunk.usage.server_tool_use) aiMsg.toolUse = chunk.usage.server_tool_use;
        }
        if (chunk.server_tool_calls) mergeToolCalls(aiMsg, chunk.server_tool_calls);
        var choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        var d = choice.delta || {};
        if (d.reasoning_content) aiMsg._rbuf = (aiMsg._rbuf || '') + d.reasoning_content;
        if (d.content) aiMsg._cbuf = (aiMsg._cbuf || '') + d.content;
        if (d.server_tool_calls) mergeToolCalls(aiMsg, d.server_tool_calls);
        if (d.content) aiMsg._tok = (aiMsg._tok || 0) + estTokens(d.content);
        if (d.reasoning_content) aiMsg._rtok = (aiMsg._rtok || 0) + estTokens(d.reasoning_content);
        if (d.reasoning_content || d.content) kickReveal();
        else schedulePaint(aiMsg);
        if (state.mode === 'shared' && promptTokens + (aiMsg._tok || 0) + (aiMsg._rtok || 0) >= MODEL_CONTEXT) {
          aiMsg.notice = '已达到模型窗口（约 1M tokens）上限，已停止生成，请新开对话。';
          toast('已到模型窗口上限，请新开对话');
          try { controller.abort(); } catch (e) { /* noop */ }
          break;
        }
      }
    } catch (e) {
      if (!(e && e.name === 'AbortError')) {
        aiMsg.error = (e && e.message) || '请求失败，请重试';
        aiMsg.errorStatus = (e && e.status) || 0;
      }
    } finally {
      aiMsg._done = true;
      await drainReveal(aiMsg);
      delete aiMsg._done;
      delete aiMsg._cbuf;
      delete aiMsg._rbuf;
      delete aiMsg._paintKey;
      if (aiMsg.reasoning && !aiMsg.reasonSec) {
        aiMsg.reasonSec = Math.max(1, Math.round((now() - (aiMsg._t0 || started)) / 1000));
      }
      delete aiMsg._t0;
      delete aiMsg._tok;
      delete aiMsg._rtok;
      aiMsg.searching = false;
      delete aiMsg.steps;
      delete aiMsg.annotations;
      delete state.streams[aiMsg.id];
      // finishing touches the "last active" time, so the chat jumps to the top
      chat.updatedAt = now();
      saveChats();
      renderSidebar();
      if (activeChat() === chat) {
        renderMessages(true);
        scrollToBottom(false);
      }
      refreshSendState();
    }
  }

  function paintMessage(m, streaming) {
    var chat = activeChat();
    if (!chat || chat.messages.indexOf(m) < 0) return;
    var node = messagesEl.querySelector('.msg[data-id="' + m.id + '"] .ai-body');
    if (!node) {
      renderMessages(true);
      node = messagesEl.querySelector('.msg[data-id="' + m.id + '"] .ai-body');
    }
    if (!node) return;
    var key = (m.content ? m.content.length : 0) + '|' + (m.reasoning ? m.reasoning.length : 0) + '|' + (m.searching ? 1 : 0) + '|' + (streaming ? 1 : 0);
    if (m._paintKey === key) return;
    m._paintKey = key;
    node.innerHTML = aiBody(m, streaming);
    var wrap = messagesEl.querySelector('.msg[data-id="' + m.id + '"]');
    var act = wrap && wrap.querySelector('.msg-actions');
    if (act) act.style.display = streaming ? 'none' : '';
    scrollToBottom(false);
  }

  // Smooth "typewriter" reveal: API chunks arrive in bursts, so we queue them
  // and release characters at a steady frame rate instead of popping a whole chunk.
  var revealRaf = 0;
  var revealLastPaint = 0;

  function pumpReveal(m) {
    var cbuf = m._cbuf || '';
    var rbuf = m._rbuf || '';
    if (!cbuf && !rbuf) return false;
    // in the thinking phase (no answer text yet) reveal the reasoning first
    if (rbuf && (!m.content || !cbuf)) {
      var takeR = Math.max(1, Math.min(rbuf.length, Math.ceil(rbuf.length / 14), 10));
      m.reasoning = (m.reasoning || '') + rbuf.slice(0, takeR);
      m._rbuf = rbuf.slice(takeR);
      if (!m._t0) m._t0 = now();
    } else if (cbuf) {
      var take = Math.max(1, Math.min(cbuf.length, Math.ceil(cbuf.length / 20), 12));
      m.content = (m.content || '') + cbuf.slice(0, take);
      m._cbuf = cbuf.slice(take);
      if (!m._t0) m._t0 = now();
    } else {
      return false;
    }
    return true;
  }

  function revealTick(ts) {
    revealRaf = 0;
    var moved = false;
    for (var key in state.streams) {
      var entry = state.streams[key];
      var m = entry.msg;
      if (!pumpReveal(m)) continue;
      moved = true;
      if (activeChat() === entry.chat) {
        var len = m.content ? m.content.length : 0;
        var interval = len > 15000 ? 90 : len > 6000 ? 60 : 33;
        if (ts - revealLastPaint > interval || !m._cbuf) {
          revealLastPaint = ts;
          paintMessage(m, true);
        }
      }
    }
    if (moved) revealRaf = requestAnimationFrame(revealTick);
  }

  function kickReveal() {
    if (!revealRaf) revealRaf = requestAnimationFrame(revealTick);
  }

  function drainReveal(m) {
    return new Promise(function (resolve) {
      var startedAt = Date.now();
      (function step() {
        var pending = (m._cbuf && m._cbuf.length) || (m._rbuf && m._rbuf.length);
        if (!pending || Date.now() - startedAt > 6000) {
          if (m._cbuf) { m.content = (m.content || '') + m._cbuf; m._cbuf = ''; }
          if (m._rbuf) { m.reasoning = (m.reasoning || '') + m._rbuf; m._rbuf = ''; }
          paintMessage(m, true);
          resolve();
          return;
        }
        setTimeout(step, 24);
      })();
    });
  }

  var paintTimer = 0;
  function schedulePaint(m) {
    if (paintTimer) return;
    paintTimer = setTimeout(function () {
      paintTimer = 0;
      paintMessage(m, true);
    }, 40);
  }

  function stopStreaming() {
    var entry = streamOf(activeChat());
    if (!entry) return;
    try { entry.controller.abort(); } catch (e) { /* noop */ }
  }

  function regenerate(id) {
    var chat = activeChat();
    if (!chat || streamOf(chat)) return;
    var idx = -1;
    for (var i = 0; i < chat.messages.length; i++) if (chat.messages[i].id === id) idx = i;
    if (idx < 0 || chat.messages[idx].role !== 'assistant') return;
    var old = chat.messages[idx];
    pushVersion(chat, 'regen');
    chat.messages.splice(idx, 1);
    var aiMsg = {
      id: uid(), role: 'assistant', content: '', reasoning: '', ts: now(),
      model: old.model || currentModel(),
      opts: old.opts || { model: old.model || currentModel(), thinking: state.settings.thinking, webSearch: state.settings.webSearch }
    };
    chat.messages.push(aiMsg);
    chat.updatedAt = now();
    saveChats();
    renderMessages();
    runCompletion(chat, aiMsg);
  }

  function editMessage(id) {
    var chat = activeChat();
    if (!chat || streamOf(chat)) return;
    var idx = -1;
    for (var i = 0; i < chat.messages.length; i++) if (chat.messages[i].id === id) idx = i;
    if (idx < 0) return;
    var msg = chat.messages[idx];
    if (msg.role !== 'user') return;
    pushVersion(chat, 'edit');
    inputEl.value = msg.content || '';
    state.pending = (msg.images || []).slice();
    renderTray();
    autosize();
    inputEl.focus();
    chat.messages = chat.messages.slice(0, idx);
    chat.updatedAt = now();
    saveChats();
    renderMessages();
    renderSidebar();
  }

  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? '已复制' : '复制失败');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制'); }, fallback);
    } else fallback();
  }

  // ---------------------------------------------------------------- drawer
  function openDrawer() {
    renderSidebar(true);
    updateSelectBar();
    var d = $('#drawer');
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    $('#backdrop').hidden = false;
    requestAnimationFrame(function () { $('#backdrop').classList.add('show'); });
  }

  function closeDrawer() {
    var d = $('#drawer');
    if (!d.classList.contains('open')) return;
    if (state.selecting) { state.selecting = false; state.selected = {}; updateSelectBar(); }
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    $('#backdrop').classList.remove('show');
    setTimeout(function () { if (!d.classList.contains('open')) $('#backdrop').hidden = true; }, 230);
  }

  // ---------------------------------------------------------------- settings
  var settingsOpen = false;

  function openSettings() {
    var s = state.settings;
    $('#apiKey').value = s.apiKey || '';
    $('#baseUrl').value = isQuick() ? DEFAULTS.baseUrl : (s.baseUrl || DEFAULTS.baseUrl);
    renderAccessUI();
    refreshStorageInfo();
    $('#sysPrompt').value = s.systemPrompt || '';
    $('#apiKey').type = 'password';
    renderModelSeg();
    setSegment('#effortSeg', s.effort);
    setSegment('#langSeg', s.thinkLang || 'zh');
    refreshLimitsUI();
    var cc = activeChat();
    var hint = $('#compactHint');
    if (hint) hint.textContent = cc ? (fmtNum(contextTokens(cc)) + ' tokens') : '—';
    setSegment('#themeSeg', s.theme);
    setSwitch('#swStream', s.stream !== false);
    setSwitch('#swIsolation', s.isolation !== false);
    var chatNow = activeChat();
    var ver = $('#appVersion');
    if (ver) ver.textContent = APP_VERSION;
    var hasChat = !!chatNow;
    $('#btnApplyOpts').hidden = !(s.isolation !== false && hasChat);
    var cc = $('#ctxCount');
    if (cc) cc.textContent = chatNow
      ? (buildContext(chatNow, null, optsFor(chatNow)).length + ' 条' + (state.mode === 'shared' ? ' · ' + state.chats.length + ' 对话' : ''))
      : '—';
    closeDrawer();
    settingsOpen = true;
    var page = $('#settingsPage');
    page.classList.add('open');
    page.setAttribute('aria-hidden', 'false');
    clearTimeout(modelsTimer);
    modelsTimer = setTimeout(function () {
      if (!(state.settings.apiKey || '').trim()) { state.models = []; state.modelStatus = 'idle'; renderModelSeg(); return; }
      if (state.modelsSource !== modelsSourceKey() || !state.models.length) fetchModels(false);
    }, 200);
  }

  function commitSettings() {
    var before = modelsSourceKey();
    state.settings.apiKey = $('#apiKey').value.trim();
    state.settings.baseUrl = isQuick() ? DEFAULTS.baseUrl : ($('#baseUrl').value.trim() || DEFAULTS.baseUrl);
    state.settings.systemPrompt = $('#sysPrompt').value;
    saveSettings();
    if (modelsSourceKey() !== before) {
      state.models = [];
      state.modelStatus = 'idle';
      state.modelsSource = '';
      refreshSendState();
      if ((state.settings.apiKey || '').trim()) fetchModels(true);
    }
    renderMessages(true);
  }

  function closeSettings() {
    if (!settingsOpen) return;
    commitSettings();
    settingsOpen = false;
    var page = $('#settingsPage');
    page.classList.remove('open');
    page.setAttribute('aria-hidden', 'true');
  }

  function showContext() {
    var chat = activeChat();
    if (!chat) { toast('请先打开一个对话'); return; }
    var msgs = buildContext(chat, null, optsFor(chat));
    var shared = state.mode === 'shared';
    var text = JSON.stringify(msgs, null, 2);
    if (text.length > 12000) text = text.slice(0, 12000) + '\n…';
    var mask = document.createElement('div');
    mask.className = 'dlg-mask';
    mask.innerHTML = '<div class="dlg dlg-wide" role="dialog">' +
      '<h3>请求上下文</h3>' +
      '<p>' + (shared
        ? '共享创作模式：共 ' + msgs.length + ' 条，来自 ' + state.chats.length + ' 个对话。'
        : '隔离对话模式：共 ' + msgs.length + ' 条，只包含「' + esc(chat.title || '当前对话') + '」。') + '</p>' +
      '<pre class="ctx-pre"></pre>' +
      '<div class="dlg-actions">' +
      '<button class="dlg-btn" data-copy>复制</button>' +
      '<button class="dlg-btn primary" data-close>关闭</button>' +
      '</div></div>';
    mask.querySelector('.ctx-pre').textContent = text;
    document.body.appendChild(mask);
    function close() { mask.remove(); }
    mask.addEventListener('click', function (ev) {
      if (ev.target === mask) return close();
      if (ev.target.closest('[data-close]')) return close();
      if (ev.target.closest('[data-copy]')) copyText(text);
    });
    dialog._close = close;
  }

  function fmtNum(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function refreshLimitsUI() {
    var lim = limitsFor(state.mode);
    var mo = $('#maxOut');
    var ca = $('#compactAt');
    var note = $('#limitNote');
    if (mo) {
      var raw = state.settings.limits[state.mode].maxOutput;
      mo.value = raw === '' || raw === undefined ? '' : String(raw);
      mo.disabled = lim.unlimited;
      mo.style.opacity = lim.unlimited ? '0.45' : '';
    }
    setSwitch('#swUnlimited', lim.unlimited);
    if (ca) ca.value = String(lim.compactAt);
    if (note) {
      var base = state.mode === 'shared'
        ? '共享创作：最多 ' + lim.maxChats + ' 个对话，单条上下文上限 10B tokens。'
        : '隔离对话：对话数量不限，上下文不限。';
      var info = capInfo();
      note.textContent = (lim.unlimited ? '当前为单次输出无上限，上面的数字不生效。' : '')
        + base + ' 每 ' + fmtNum(info.window) + ' tokens 自动压缩一次'
        + (state.mode === 'shared'
          ? '，最多 ' + info.maxCompactions + ' 次（等效 ' + fmtNum(lim.maxContext) + '）；用完提示新开对话。'
          : '；不设次数上限。');
    }
  }

  function setSwitch(sel, on) {
    var el = $(sel);
    if (!el) return;
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    el.classList.toggle('on', !!on);
  }

  function setSegment(sel, value) {
    $$(sel + ' button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-value') === value);
    });
  }

  // ---------------------------------------------------------------- popover / dialog
  var menuEl = null;

  function closeMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
  }

  function showMenu(anchor, items) {
    closeMenu();
    var el = document.createElement('div');
    el.className = 'popover';
    el.innerHTML = items.map(function (it, i) {
      return '<button data-i="' + i + '" class="' + (it.danger ? 'danger' : '') + '">' + it.label + '</button>';
    }).join('');
    document.body.appendChild(el);
    var r = anchor.getBoundingClientRect();
    var w = 148;
    var left = Math.max(8, Math.min(r.right - w + 12, window.innerWidth - w - 8));
    var top = Math.min(r.bottom + 6, window.innerHeight - items.length * 44 - 24);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      var it = items[+b.getAttribute('data-i')];
      closeMenu();
      if (it && it.onClick) it.onClick();
    });
    menuEl = el;
  }

  function dialog(opts) {
    return new Promise(function (resolve) {
      var mask = document.createElement('div');
      mask.className = 'dlg-mask';
      var inputHtml = opts.input ? '<input class="dlg-input" type="text" value="' + esc(opts.value || '') + '" />' : '';
      mask.innerHTML = '<div class="dlg" role="dialog">' +
        '<h3>' + esc(opts.title) + '</h3>' +
        (opts.text ? '<p>' + esc(opts.text) + '</p>' : '') + inputHtml +
        '<div class="dlg-actions">' +
        '<button class="dlg-btn" data-v="0">' + esc(opts.cancel || '取消') + '</button>' +
        '<button class="dlg-btn ' + (opts.danger ? 'danger' : 'primary') + '" data-v="1">' + esc(opts.ok || '确定') + '</button>' +
        '</div></div>';
      document.body.appendChild(mask);
      var input = mask.querySelector('.dlg-input');
      if (input) { input.focus(); input.select(); }
      function finish(v) {
        mask.remove();
        document.removeEventListener('keydown', onKey);
        resolve(v);
      }
      mask.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-v]');
        if (!b) {
          if (ev.target === mask) finish(null);
          return;
        }
        finish(b.getAttribute('data-v') === '0' ? null : (opts.input ? (input.value || '') : true));
      });
      function onKey(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(opts.input ? (input.value || '') : true); }
        else if (ev.key === 'Escape') finish(null);
      }
      mask.addEventListener('keydown', onKey);
      dialog._close = function () { finish(null); };
    });
  }

  // ---------------------------------------------------------------- data
  function exportData() {
    if (!state.stores.isolated.length && !state.stores.shared.length) { toast('还没有可导出的对话'); return; }
    var data = {
      app: 'DS Chat',
      version: 3,
      exportedAt: new Date().toISOString(),
      workspaces: {
        isolated: state.stores.isolated,
        shared: state.stores.shared
      }
    };
    var text = JSON.stringify(data, null, 2);
    var name = 'ds-chat-' + new Date().toISOString().slice(0, 10) + '.json';
    try {
      if (window.Native && window.Native.saveFile) {
        window.Native.saveFile(name, text);
        toast('已导出到 Download/DeepSeek');
      } else {
        var blob = new Blob([text], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        toast('已导出');
      }
    } catch (e) {
      toast('导出失败：' + (e.message || e));
    }
  }

  function normalizeChats(raw) {
    if (!Array.isArray(raw)) return null;
    var out = [];
    raw.forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      var msgs = Array.isArray(c.messages) ? c.messages : [];
      var clean = [];
      msgs.forEach(function (m) {
        if (!m || typeof m !== 'object') return;
        var content = typeof m.content === 'string' ? m.content : '';
        var images = Array.isArray(m.images) ? m.images.filter(function (x) { return typeof x === 'string' && x.indexOf('data:image/') === 0; }) : [];
        if (!content && !images.length) return;
        clean.push({
          id: String(m.id || uid()),
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: content,
          images: images,
          reasoning: typeof m.reasoning === 'string' ? m.reasoning : '',
          reasonSec: m.reasonSec || 0,
          sources: Array.isArray(m.sources) ? m.sources.slice(0, 20) : [],
          ts: m.ts || now(),
          model: m.model || 'deepseek-flash'
        });
      });
      if (!clean.length) return;
      out.push({
        id: String(c.id || uid()),
        title: String(c.title || titleFrom(clean[0].content)),
        createdAt: c.createdAt || now(),
        updatedAt: c.updatedAt || now(),
        model: c.model || 'deepseek-flash',
        messages: clean
      });
    });
    return out;
  }

  function importData(text) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { toast('文件不是有效的 JSON'); return; }
    var ws = parsed && parsed.workspaces;
    if (ws && (Array.isArray(ws.isolated) || Array.isArray(ws.shared))) {
      var iso = normalizeChats(ws.isolated) || [];
      var sha = normalizeChats(ws.shared) || [];
      if (!iso.length && !sha.length) { toast('没有找到对话数据'); return; }
      dialog({
        title: '导入历史对话',
        text: '将覆盖两个工作区（隔离 ' + iso.length + ' 个 / 共享 ' + sha.length + ' 个对话），确定继续？',
        ok: '覆盖导入',
        danger: true
      }).then(async function (ok) {
        if (!ok) return;
        state.stores.isolated = iso;
        state.stores.shared = sha;
        state.chats = state.stores[state.mode];
        saveStore('isolated');
        saveStore('shared');
        await flushChats();
        state.activeId = null;
        renderSidebar();
        renderMessages();
        toast('已导入 ' + (iso.length + sha.length) + ' 个对话');
      });
      return;
    }

    var raw = Array.isArray(parsed) ? parsed : (parsed && parsed.chats);
    var chats = normalizeChats(raw);
    if (!chats || !chats.length) { toast('没有找到对话数据'); return; }
    dialog({
      title: '导入历史对话',
      text: '将用 ' + chats.length + ' 个对话覆盖当前工作区，确定继续？',
      ok: '覆盖导入',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      state.stores[state.mode] = chats;
      state.chats = chats;
      state.activeId = chats[0] ? chats[0].id : null;
      saveChats();
      renderSidebar();
      renderMessages();
      toast('已导入 ' + chats.length + ' 个对话');
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.readAsArrayBuffer(file);
    });
  }

  async function handleFile(file) {
    if (!file) return;
    var buf;
    try {
      buf = await readAsArrayBuffer(file);
    } catch (e) {
      toast('读取文件失败');
      return;
    }
    var head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    if (head[0] === 0x50 && head[1] === 0x4b) {
      await importZip(buf);
      return;
    }
    try {
      importData(new TextDecoder('utf-8').decode(new Uint8Array(buf)));
    } catch (e) {
      toast('无法识别该文件，请选择 DeepSeek 导出的 ZIP 或本 App 导出的 JSON');
    }
  }

  // ---- DeepSeek official export (manifest.json + chat_sessions/*.json) ----
  async function importZip(buffer) {
    var zip;
    try {
      zip = DSArchive.open(buffer);
    } catch (e) {
      toast('无法读取 ZIP：' + (e.message || e));
      return;
    }
    var manifest = zip.json('manifest.json') || {};
    var version = Number(manifest.export_format_version || 0);
    if (version > 3) { toast('文件版本过新，请升级后再导入'); return; }

    var names = zip.names();
    var sessionNames = names.filter(function (n) { return /^chat_sessions\/[^/]+\.json$/.test(n); });
    if (!sessionNames.length) {
      toast('ZIP 里没有找到对话数据，请选择 DeepSeek 导出的历史对话文件');
      return;
    }

    var imageCache = {};
    var imageCount = 0;
    function imageData(path) {
      if (Object.prototype.hasOwnProperty.call(imageCache, path)) return imageCache[path];
      var bytes = null;
      try { bytes = zip.bytes(path); } catch (e) { bytes = null; }
      if (!bytes || !bytes.length || bytes.length > 1600000 || imageCount >= 12) {
        imageCache[path] = null;
        return null;
      }
      imageCount++;
      var mime = /\.png$/i.test(path) ? 'image/png'
        : /\.webp$/i.test(path) ? 'image/webp'
        : /\.gif$/i.test(path) ? 'image/gif' : 'image/jpeg';
      var bin = '';
      for (var i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      imageCache[path] = 'data:' + mime + ';base64,' + btoa(bin);
      return imageCache[path];
    }

    var chats = [];
    for (var si = 0; si < sessionNames.length; si++) {
      if (si && si % 10 === 0) {
        if (si % 50 === 0) toast('正在导入 ' + si + ' / ' + sessionNames.length);
        await new Promise(function (r) { setTimeout(r, 0); });
      }
      var session = zip.json(sessionNames[si]);
      if (!session || !Array.isArray(session.messages)) continue;
      var chat = convertOfficialSession(session, imageData);
      if (chat) chats.push(chat);
    }

    if (!chats.length) { toast('ZIP 里没有可导入的对话内容'); return; }

    var total = chats.reduce(function (n, c) { return n + c.messages.length; }, 0);
    dialog({
      title: '导入 DeepSeek 历史对话',
      text: '检测到 ' + chats.length + ' 个对话（共 ' + total + ' 条消息），将覆盖当前工作区，确定导入？',
      ok: '导入',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      state.stores[state.mode] = chats;
      state.chats = chats;
      state.activeId = null;
      saveChats();
      renderSidebar();
      renderMessages();
      toast('已导入 ' + chats.length + ' 个对话');
    });
  }

  function convertOfficialSession(session, imageData) {
    var msgs = [];
    session.messages.forEach(function (m) {
      var frags = Array.isArray(m.fragments) ? m.fragments : [];
      var ts = Date.parse(m.inserted_at) || now();
      if (m.role === 'USER') {
        var text = frags.filter(function (f) { return f.type === 'REQUEST'; })
          .map(function (f) { return f.content || ''; }).join('\n');
        var images = [];
        frags.forEach(function (f) {
          if (f.type !== 'FILE' || !Array.isArray(f.files)) return;
          f.files.forEach(function (file) {
            if (!file.is_image || !file.export_path) return;
            var data = imageData(file.export_path);
            if (data) images.push(data);
          });
        });
        if (!text.trim() && !images.length) return;
        msgs.push({ id: String(m.id || uid()), role: 'user', content: text, images: images, ts: ts });
      } else {
        var reasoning = '';
        var content = '';
        var reasonSec = 0;
        var sources = [];
        var seen = {};
        frags.forEach(function (f) {
          if (f.type === 'THINK') {
            if (f.content) reasoning += (reasoning ? '\n\n' : '') + f.content;
            if (typeof f.elapsed_secs === 'number') reasonSec = Math.max(reasonSec, Math.round(f.elapsed_secs));
          } else if (f.type === 'RESPONSE' || f.type === 'TEMPLATE_RESPONSE') {
            if (f.content) content += (content ? '\n\n' : '') + f.content;
          } else if (f.type === 'TOOL_SEARCH' || f.type === 'READ_LINK' || f.type === 'TOOL_OPEN') {
            (f.results || []).forEach(function (r) {
              if (r && r.url && !seen[r.url]) {
                seen[r.url] = 1;
                sources.push({ url: r.url, title: r.title || r.url, site: r.site_name || '' });
              }
            });
            if (f.url && !seen[f.url]) {
              seen[f.url] = 1;
              sources.push({ url: f.url, title: f.title || f.url, site: '' });
            }
          }
        });
        if (!content && !reasoning) return;
        msgs.push({
          id: String(m.id || uid()),
          role: 'assistant',
          content: content,
          reasoning: reasoning,
          reasonSec: reasonSec,
          sources: sources.slice(0, 20),
          ts: ts,
          model: 'deepseek-flash'
        });
      }
    });
    if (!msgs.length) return null;
    var firstUser = msgs.filter(function (m) { return m.role === 'user'; })[0];
    return {
      id: String(session.id || uid()),
      title: session.title || (firstUser ? titleFrom(firstUser.content) : '导入的对话'),
      createdAt: Date.parse(session.inserted_at) || (msgs[0].ts || now()),
      updatedAt: Date.parse(session.updated_at) || now(),
      model: 'deepseek-flash',
      messages: msgs
    };
  }

  function renameChat(id) {
    var chat = null;
    state.chats.forEach(function (c) { if (c.id === id) chat = c; });
    if (!chat) return;
    dialog({ title: '重命名对话', value: chat.title, input: true, ok: '保存' }).then(function (v) {
      if (v === null) return;
      chat.title = String(v).trim() || chat.title;
      chat.updatedAt = now();
      saveChats();
      renderSidebar();
      renderTop();
    });
  }

  function deleteChat(id) {
    var chat = null;
    state.chats.forEach(function (c) { if (c.id === id) chat = c; });
    if (!chat) return;
    dialog({ title: '删除对话', text: '「' + chat.title + '」将被删除，无法恢复。', ok: '删除', danger: true }).then(function (ok) {
      if (!ok) return;
      for (var k in state.streams) {
        if (state.streams[k].chat && state.streams[k].chat.id === id) {
          try { state.streams[k].controller.abort(); } catch (e) { /* noop */ }
          delete state.streams[k];
        }
      }
      state.chats = state.chats.filter(function (c) { return c.id !== id; });
      if (state.activeId === id) state.activeId = null;
      saveChats();
      renderSidebar();
      renderMessages();
      toast('已删除');
    });
  }

  function clearAll() {
    if (!state.chats.length) { toast('当前工作区没有对话'); return; }
    var label = state.mode === 'shared' ? '共享创作' : '隔离对话';
    dialog({ title: '删除所有对话', text: '「' + label + '」工作区的对话都会被删除，另一个工作区不受影响。', ok: '全部删除', danger: true }).then(async function (ok) {
      if (!ok) return;
      state.chats = [];
      state.activeId = null;
      saveChats();
      await flushChats();
      renderSidebar();
      renderMessages();
      toast('已删除');
    });
  }

  async function testConnection() {
    var key = $('#apiKey').value.trim();
    var base = isQuick() ? DEFAULTS.baseUrl : ($('#baseUrl').value.trim() || DEFAULTS.baseUrl);
    if (!key) { toast('请先填写 API Key'); return; }
    toast('正在测试连接…');
    readConnectionInputs();
    var ok = await fetchModels(true);
    if (ok) toast('连接成功 · ' + state.models.length + ' 个模型');
    else toast(state.modelError || '连接失败');
  }

  // ---------------------------------------------------------------- wiring
  async function init() {
    scroller = $('#scroller');
    messagesEl = $('#messages');
    welcomeEl = $('#welcome');
    inputEl = $('#input');
    sendBtn = $('#sendBtn');
    thinkChip = $('#thinkChip');
    searchChip = $('#searchChip');
    topTitle = $('#topTitle');

    state.greeting = greetingFor(new Date());
    setInterval(refreshGreeting, 60 * 1000);

    await loadState();
    applyTheme();
    renderSidebar();
    renderMessages();
    renderTray();
    refreshSendState();

    var draftTimer = 0;
    inputEl.addEventListener('input', function () {
      autosize();
      clearTimeout(draftTimer);
      draftTimer = setTimeout(function () {
        var chat = activeChat();
        if (chat) {
          if (chat.draft !== inputEl.value) { chat.draft = inputEl.value; saveChats(); }
        } else if (state.settings.draft !== inputEl.value) {
          state.settings.draft = inputEl.value;
          saveSettings();
        }
      }, 600);
    });
    inputEl.addEventListener('focus', function () { $('#composer').classList.add('focus'); });
    inputEl.addEventListener('blur', function () { $('#composer').classList.remove('focus'); });
    inputEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && window.matchMedia('(pointer: fine)').matches) {
        ev.preventDefault();
        send();
      }
    });
    inputEl.addEventListener('paste', function (ev) {
      var items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
          addImageFile(items[i].getAsFile());
          ev.preventDefault();
        }
      }
    });

    sendBtn.addEventListener('click', function () {
      haptic();
      if (streamOf(activeChat())) stopStreaming();
      else send();
    });
    thinkChip.addEventListener('click', function () {
      if (!isDeepSeekCompat()) { toast('当前接口不支持深度思考参数'); return; }
      haptic();
      var on = toggleOpt('thinking');
      toast(on ? '深度思考：开' : '深度思考：关');
    });
    searchChip.addEventListener('click', function () {
      if (!isDeepSeekCompat()) { toast('当前接口不支持联网搜索参数'); return; }
      haptic();
      var on = toggleOpt('webSearch');
      toast(on ? '联网搜索：开（由模型决定是否搜索）' : '联网搜索：关');
    });
    $('#attachBtn').addEventListener('click', function () { $('#imageInput').click(); });
    $('#imageInput').addEventListener('change', function () {
      var files = this.files || [];
      for (var i = 0; i < files.length && i < MAX_IMAGES; i++) addImageFile(files[i]);
      this.value = '';
    });
    $('#imgTray').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-rm]');
      if (!b) return;
      state.pending.splice(+b.getAttribute('data-rm'), 1);
      renderTray();
      refreshSendState();
    });

    renderMode();

    scroller.addEventListener('scroll', onScroll, { passive: true });

    $('#btnDrawer').addEventListener('click', openDrawer);
    $('#btnHistory').addEventListener('click', function () { haptic(); showVersions(); });
    $('#btnNewChat').addEventListener('click', function () { haptic(); newChat(); });
    $('#btnNewChat2').addEventListener('click', function () { haptic(); newChat(); });
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#backdrop').addEventListener('click', closeDrawer);

    $('#chatNotice').addEventListener('click', function () {
      if (state.compacting) return;
      var chat = activeChat();
      if (!chat) return;
      manualCompact(chat);
    });
    $('#chatSearch').addEventListener('input', function () {
      state.filter = this.value;
      state.sidebarLimit = SIDEBAR_PAGE;
      renderSidebar(true);
    });

    $('#chatList').addEventListener('click', function (ev) {
      var item = ev.target.closest('[data-chat]');
      if (!item) return;
      var rowId = item.getAttribute('data-chat');
      if (state.selecting) { toggleSelected(rowId); return; }
      var more = ev.target.closest('[data-more]');
      if (more) {
        ev.stopPropagation();
        var chat = null;
        state.chats.forEach(function (c) { if (c.id === rowId) chat = c; });
        showMenu(more, [
          { label: chat && chat.pinned ? '取消置顶' : '置顶', onClick: function () { togglePin(rowId); } },
          { label: '重命名', onClick: function () { renameChat(rowId); } },
          { label: '删除', danger: true, onClick: function () { deleteChat(rowId); } }
        ]);
        return;
      }
      openChat(rowId);
    });

    $('#chatList').addEventListener('click', function (ev) {
      var more = ev.target.closest('#loadMoreChats');
      if (!more) return;
      state.sidebarLimit = (state.sidebarLimit || SIDEBAR_PAGE) + SIDEBAR_PAGE;
      renderSidebar(true);
    });
    $('#btnSelect').addEventListener('click', function () { haptic(); setSelecting(!state.selecting); });
    $('#btnSelectAll').addEventListener('click', function () {
      var chats = state.chats.filter(matchesFilter);
      var all = chats.length > 0 && chats.every(function (c) { return state.selected[c.id]; });
      state.selected = {};
      if (!all) chats.forEach(function (c) { state.selected[c.id] = true; });
      renderSidebar();
    });
    $('#btnDeleteSelected').addEventListener('click', deleteSelected);

    messagesEl.addEventListener('click', function (ev) {
      if (ev.target.closest('#loadEarlierMsgs')) {
        var before = scroller.scrollHeight;
        var top = scroller.scrollTop;
        state.msgLimit = (state.msgLimit || MSG_PAGE) + MSG_PAGE;
        renderMessages(true);
        requestAnimationFrame(function () {
          scroller.scrollTop = top + (scroller.scrollHeight - before);
        });
        return;
      }
      var copyBtn = ev.target.closest('.md-code-copy');
      if (copyBtn) {
        var block = copyBtn.closest('.md-code');
        var code = block && block.querySelector('code');
        if (code) copyText(code.textContent);
        return;
      }
      var srcHead = ev.target.closest('.src-head');
      if (srcHead) {
        var box = srcHead.closest('.src-box');
        if (!box || box.querySelector('.src-head').classList.contains('static')) return;
        box.classList.toggle('open');
        var chat0 = activeChat();
        var sid = box.getAttribute('data-src');
        if (chat0) {
          chat0.messages.forEach(function (m) { if (m.id === sid) m.sourcesOpen = box.classList.contains('open'); });
          saveChats();
        }
        return;
      }
      var think = ev.target.closest('.think-head');
      if (think) {
        var box = think.parentElement;
        box.classList.toggle('open');
        var chat = activeChat();
        var tid = box.getAttribute('data-think');
        if (chat) {
          chat.messages.forEach(function (m) { if (m.id === tid) m.reasonOpen = box.classList.contains('open'); });
          saveChats();
        }
        return;
      }
      var btn = ev.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      var id = btn.getAttribute('data-id');
      if (act === 'settings') { openSettings(); return; }
      if (act === 'copy') {
        var c = activeChat();
        var msg = c && c.messages.filter(function (m) { return m.id === id; })[0];
        if (msg) copyText(msg.content);
        return;
      }
      if (act === 'regen') { regenerate(id); return; }
      if (act === 'edit') { editMessage(id); return; }
    });

    $('#welcomeCta').addEventListener('click', openSettings);
    $('#btnSettings').addEventListener('click', openSettings);
    $('#settingsBack').addEventListener('click', closeSettings);

    $('#btnTest').addEventListener('click', testConnection);
    $('#toggleKey').addEventListener('click', function () {
      var el = $('#apiKey');
      var show = el.type === 'password';
      el.type = show ? 'text' : 'password';
      this.innerHTML = '<svg class="ico" style="width:16px;height:16px"><use href="#' + (show ? 'i-eye-off' : 'i-eye') + '"/></svg>';
    });
    $('#modelSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      state.settings.model = b.getAttribute('data-value');
      saveSettings();
      renderModelSeg();
      refreshSendState();
    });
    $('#effortSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      state.settings.effort = b.getAttribute('data-value');
      saveSettings();
      setSegment('#effortSeg', state.settings.effort);
    });
    $('#swUnlimited').addEventListener('click', function () {
      var lim = state.settings.limits[state.mode];
      lim.unlimited = !lim.unlimited;
      saveSettings();
      refreshLimitsUI();
    var cc = activeChat();
    var hint = $('#compactHint');
    if (hint) hint.textContent = cc ? (fmtNum(contextTokens(cc)) + ' tokens') : '—';
      toast(lim.unlimited ? '单次输出：无上限' : '单次输出：受上限限制');
    });
    $('#maxOut').addEventListener('change', function () {
      var v = this.value.replace(/[^\d]/g, '');
      state.settings.limits[state.mode].maxOutput = v ? Number(v) : '';
      saveSettings();
      refreshLimitsUI();
    var cc = activeChat();
    var hint = $('#compactHint');
    if (hint) hint.textContent = cc ? (fmtNum(contextTokens(cc)) + ' tokens') : '—';
    });
    $('#compactAt').addEventListener('change', function () {
      var v = Number(this.value.replace(/[^\d]/g, ''));
      if (!v || v < 1000) { toast('压缩阈值至少 1000 tokens'); refreshLimitsUI(); return; }
      state.settings.limits[state.mode].compactAt = v;
      saveSettings();
      refreshLimitsUI();
    var cc = activeChat();
    var hint = $('#compactHint');
    if (hint) hint.textContent = cc ? (fmtNum(contextTokens(cc)) + ' tokens') : '—';
    });
    $('#btnFetchModels').addEventListener('click', function () {
      readConnectionInputs();
      fetchModels(true);
    });
    $('#baseUrl').addEventListener('change', function () {
      readConnectionInputs();
      if ((state.settings.apiKey || '').trim()) fetchModels(true);
    });
    $('#apiKey').addEventListener('change', function () {
      readConnectionInputs();
      if ((state.settings.apiKey || '').trim()) fetchModels(true);
    });
    $('#accessSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      state.settings.accessMode = b.getAttribute('data-value');
      if (isQuick()) state.settings.baseUrl = DEFAULTS.baseUrl;
      saveSettings();
      renderAccessUI();
    refreshStorageInfo();
      state.models = [];
      state.modelStatus = 'idle';
      state.modelsSource = '';
      renderModelSeg();
      refreshSendState();
      toast(isQuick() ? '已切换到快速模式（仅 DeepSeek）' : '已切换到兼容模式，填接口地址后再获取模型');
      if (!isQuick()) {
        var bi = $('#baseUrl');
        if (bi) setTimeout(function () { bi.focus(); }, 60);
      }
      if ((state.settings.apiKey || '').trim()) fetchModels(true);
    });
    $('#langSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      state.settings.thinkLang = b.getAttribute('data-value');
      saveSettings();
      setSegment('#langSeg', state.settings.thinkLang);
      toast(state.settings.thinkLang === 'auto' ? '思考语言：跟随提问' : '思考语言：中文');
    });
    $('#themeSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      state.settings.theme = b.getAttribute('data-value');
      saveSettings();
      setSegment('#themeSeg', state.settings.theme);
      applyTheme();
    });
    $('#modeSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      haptic();
      setMode(b.getAttribute('data-value'));
      refreshLimitsUI();
    var cc = activeChat();
    var hint = $('#compactHint');
    if (hint) hint.textContent = cc ? (fmtNum(contextTokens(cc)) + ' tokens') : '—';
    });
    $('#btnCompact').addEventListener('click', function () { manualCompact(activeChat()); });
    $('#btnContext').addEventListener('click', showContext);
    $('#swStream').addEventListener('click', function () {
      state.settings.stream = !(state.settings.stream !== false);
      saveSettings();
      setSwitch('#swStream', state.settings.stream);
      toast(state.settings.stream ? '已开启流式输出' : '已关闭流式输出（一次性返回）');
    });
    $('#swIsolation').addEventListener('click', function () {
      state.settings.isolation = !(state.settings.isolation !== false);
      saveSettings();
      setSwitch('#swIsolation', state.settings.isolation);
      state.chats.forEach(function (c) { delete c.opts; });
      refreshSendState();
      toast(state.settings.isolation ? '对话已隔离：每个对话独立设置' : '已改为全局统一设置');
    });

    $('#btnApplyOpts').addEventListener('click', function () {
      var chat = activeChat();
      if (!chat) { toast('当前没有打开的对话'); return; }
      chat.opts = {
        model: state.settings.model,
        thinking: state.settings.thinking,
        webSearch: state.settings.webSearch
      };
      chat.model = state.settings.model;
      saveChats();
      refreshSendState();
      toast('已应用到当前对话');
    });

    $('#btnExport').addEventListener('click', exportData);
    $('#btnImport').addEventListener('click', function () { $('#fileInput').click(); });
    $('#btnClear').addEventListener('click', clearAll);
    $('#fileInput').addEventListener('change', function () {
      var f = this.files && this.files[0];
      handleFile(f);
      this.value = '';
    });

    document.addEventListener('click', function (ev) {
      var a = ev.target.closest('a[href]');
      if (!a) return;
      ev.preventDefault();
      var href = a.getAttribute('href');
      if (!/^https?:\/\//i.test(href)) return;
      try {
        if (window.Native && window.Native.openUrl) window.Native.openUrl(href);
        else window.open(href, '_blank');
      } catch (e) { /* noop */ }
    });

    window.__handleBack = function () {
      if (menuEl) { closeMenu(); return true; }
      if (document.querySelector('.dlg-mask')) { if (dialog._close) dialog._close(); return true; }
      if (settingsOpen) { closeSettings(); return true; }
      if ($('#drawer').classList.contains('open')) { closeDrawer(); return true; }
      if (state.activeId) { newChat(); return true; }
      return false;
    };

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', function () { if (state.settings.theme === 'auto') applyTheme(); });
    }

    if (navigator.storage && navigator.storage.persist) {
      try { navigator.storage.persist().catch(function () {}); } catch (e) { /* noop */ }
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { saveChats(); flushChats(); }
      else refreshGreeting();
    });
  }

  function onReady() {
    var run = function () {
      Promise.resolve(init()).catch(function (e) {
        console.error(e);
        toast('初始化失败：' + (e && e.message ? e.message : e));
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }
  onReady();
})();
