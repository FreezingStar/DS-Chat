/* DeepSeek API client: streaming SSE over fetch (OpenAI-compatible). */
(function (global) {
  'use strict';

  var DEFAULT_BASE = 'https://api.deepseek.com';

  function ApiError(message, status, code) {
    var e = new Error(message);
    e.name = 'ApiError';
    e.status = status || 0;
    e.code = code || '';
    return e;
  }

  function normalizeBase(base) {
    var b = String(base || '').trim().replace(/\/+$/, '');
    if (!b) b = DEFAULT_BASE;
    if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
    return b;
  }

  function netHint(base) {
    var b = normalizeBase(base);
    var tip = '';
    if (/^http:\/\//i.test(b)) tip += '（当前地址是 http，如仍失败请改用 https）';
    if (!/\/[^/]+$/.test(b.replace(/^https?:\/\/[^/]+/i, ''))) tip += '（地址通常需要带版本路径，例如 /v1）';
    return tip;
  }

  async function toError(res) {
    var msg = '请求失败（HTTP ' + res.status + '）';
    var code = '';
    try {
      var j = await res.json();
      if (j && j.error) {
        if (j.error.message) msg = j.error.message;
        if (j.error.code) code = String(j.error.code);
      }
    } catch (e) { /* not json */ }
    if (res.status === 401) msg = 'API Key 无效或已过期，请在设置中检查';
    else if (res.status === 402) msg = '账户余额不足，请到 DeepSeek 开放平台充值';
    else if (res.status === 400 && /model/i.test(msg)) msg = '模型不可用：' + msg;
    else if (res.status === 429) msg = '请求过于频繁，请稍后再试';
    else if (res.status === 503) msg = '服务繁忙，请稍后再试';
    else if (res.status >= 500) msg = '服务端错误（HTTP ' + res.status + '），稍后再试';
    return ApiError(msg, res.status, code);
  }

  function buildBody(opts) {
    var body = {
      model: opts.model || 'deepseek-flash',
      messages: opts.messages,
      stream: opts.stream !== false
    };
    if (body.stream && opts.deepseek !== false) body.stream_options = { include_usage: true };
    // DeepSeek 专有参数只发给 DeepSeek 兼容接口，避免第三方 400
    if (opts.deepseek !== false) {
      if (opts.thinking !== undefined) {
        body.thinking = { type: opts.thinking ? 'enabled' : 'disabled' };
      }
      if (opts.thinking && opts.effort) {
        body.reasoning_effort = opts.effort;
      }
      if (opts.webSearch) {
        body.tools = [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }];
      }
    }
    if (!body.stream) delete body.stream_options;
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    return body;
  }

  async function* streamChat(opts) {
    var url = normalizeBase(opts.base) + '/chat/completions';
    var body = buildBody(opts);
    var res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Authorization': 'Bearer ' + opts.apiKey
        },
        body: JSON.stringify(body),
        signal: opts.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw ApiError('网络连接失败，请检查网络后重试' + netHint(opts.base), 0, 'network');
    }
    if (!res.ok) throw await toError(res);

    if (opts.stream === false) {
      var payload = await res.json();
      var choice = (payload && payload.choices && payload.choices[0]) || {};
      var msg = choice.message || {};
      yield {
        choices: [{ delta: { content: msg.content || '', reasoning_content: msg.reasoning_content || '' } }],
        usage: payload && payload.usage
      };
      return;
    }

    if (!res.body) throw ApiError('当前环境不支持流式响应', 0, 'nostream');

    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';
    try {
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          var line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (!line || line.charAt(0) === ':') continue;
          if (line.lastIndexOf('data:', 0) !== 0) continue;
          var payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          var json;
          try { json = JSON.parse(payload); } catch (e) { continue; }
          yield json;
        }
      }
    } finally {
      try { reader.releaseLock(); } catch (e) { /* noop */ }
    }
  }

  async function listModels(opts) {
    var url = normalizeBase(opts.base) + '/models';
    var res;
    try {
      res = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + opts.apiKey },
        signal: opts.signal
      });
    } catch (e) {
      throw ApiError('网络连接失败，请检查网络后重试' + netHint(opts.base), 0, 'network');
    }
    if (!res.ok) throw await toError(res);
    var j = await res.json();
    return (j && j.data) || [];
  }

  global.DeepSeekAPI = {
    streamChat: streamChat,
    listModels: listModels,
    normalizeBase: normalizeBase,
    DEFAULT_BASE: DEFAULT_BASE
  };
})(window);
