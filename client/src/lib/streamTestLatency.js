/**
 * 流式 chat 测试：latency 为首 token（有内容的 delta）到达时间。
 * 会把流读完整再返回，避免中途 abort 导致网关不落账。
 */

function parseSseChunk(buf, anthropicEventRef, onFirstToken) {
  const lines = buf.split('\n');
  const rest = lines.pop() || '';
  for (const line of lines) {
    const t = line.trimEnd();
    if (!t) { anthropicEventRef.v = null; continue; }
    // Anthropic SSE（/messages?stream=true）
    if (t.startsWith('event: ')) {
      anthropicEventRef.v = t.slice(7).trim();
      continue;
    }
    if (t.startsWith('data: ') && anthropicEventRef.v === 'content_block_delta') {
      try {
        const d = JSON.parse(t.slice(6));
        const text = d.delta?.type === 'text_delta' ? d.delta.text : '';
        if (text) onFirstToken();
      } catch { /* ignore malformed chunk */ }
      continue;
    }
    // OpenAI SSE（/chat/completions?stream=true）
    if (t === 'data: [DONE]') continue;
    if (t.startsWith('data: ')) {
      try {
        const d = JSON.parse(t.slice(6));
        const delta = d.choices?.[0]?.delta?.content ?? d.choices?.[0]?.delta?.text ?? '';
        if (delta) onFirstToken();
      } catch { /* ignore malformed chunk */ }
    }
  }
  return rest;
}

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {Record<string,string>} opts.headers
 * @param {object} opts.body  需含 stream:true
 * @param {number} [opts.timeoutMs=30000]
 * @returns {Promise<{ok:boolean, latency:number, error?:string}>}
 */
export async function runStreamChatTest({ url, headers, body, timeoutMs = 30000 }) {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ ...body, stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      const msg = b?.error?.detail || b?.error?.message || b?.detail || `HTTP ${res.status}`;
      return { ok: false, error: msg, latency: Date.now() - start };
    }

    let firstTokenMs = null;
    const markFirst = () => { if (firstTokenMs == null) firstTokenMs = Date.now() - start; };
    const reader = res.body?.getReader();
    if (!reader) return { ok: true, latency: Date.now() - start };

    const decoder = new TextDecoder();
    let buf = '';
    const anthropicEventRef = { v: null };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = parseSseChunk(buf, anthropicEventRef, markFirst);
    }
    // 流结束仍无内容 delta 时，回退到首块时间（极端情况）
    return { ok: true, latency: firstTokenMs ?? (Date.now() - start) };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'timeout' : (e?.message || 'connect failed');
    return { ok: false, error: msg, latency: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}
