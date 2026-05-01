'use strict';

// ── IndexedDB ────────────────────────────────────────────────────────────────
const DB_NAME = 'minutesMakerDB';
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      const store = d.createObjectStore('meetings', { keyPath: 'id' });
      store.createIndex('createdAt', 'createdAt');
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function dbTx(mode, fn) {
  const tx = db.transaction('meetings', mode);
  const store = tx.objectStore('meetings');
  return new Promise((resolve, reject) => {
    const req = fn(store);
    if (req) req.onsuccess = () => resolve(req.result);
    tx.oncomplete = () => { if (!req) resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

const getAllMeetings = () => dbTx('readonly', store => {
  const req = store.index('createdAt').getAll();
  return { onsuccess: null, _req: req, then: undefined };
}).catch(() => []).then ? null : null; // override below

async function fetchAllMeetings() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meetings', 'readonly');
    const req = tx.objectStore('meetings').index('createdAt').getAll();
    req.onsuccess = () => resolve([...req.result].reverse());
    req.onerror = () => reject(req.error);
  });
}

async function getMeeting(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meetings', 'readonly');
    const req = tx.objectStore('meetings').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putMeeting(meeting) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meetings', 'readwrite');
    tx.objectStore('meetings').put(meeting);
    tx.oncomplete = () => resolve(meeting);
    tx.onerror = () => reject(tx.error);
  });
}

async function removeMeeting(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meetings', 'readwrite');
    tx.objectStore('meetings').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Utilities ────────────────────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}`;
}
function fmtTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDateTime(start, end) {
  return `${fmtDate(start)} ${fmtTime(start)}〜${end ? fmtTime(end) : '−'}`;
}
function fmtDuration(start, end) {
  if (!end) return '';
  const m = Math.floor((new Date(end) - new Date(start)) / 60000);
  return m >= 60 ? `${Math.floor(m/60)}時間${m%60}分` : `${m}分`;
}
function fmtElapsed(sec) {
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── State ────────────────────────────────────────────────────────────────────
const S = {
  view: 'home',
  meetings: [],
  currentMeeting: null,
  rec: {
    active: false, processing: false, segments: [],
    stream: null, mediaRecorder: null, audioBuffer: [],
    elapsed: 0, timer: null, chunkTimer: null, chunkStartTime: 0
  },
  generating: false,
  streamText: '',
  installPrompt: null,
  updateAvailable: false,
  swRegistration: null
};

// ── Router ───────────────────────────────────────────────────────────────────
function go(view) { S.view = view; render(); }

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  const root = document.getElementById('root');
  const views = { home: vHome, record: vRecord, minutes: vMinutes, transcript: vTranscript, settings: vSettings };
  root.innerHTML = (views[S.view] || vHome)();
  bind();
}

// ── View: Home ───────────────────────────────────────────────────────────────
function vHome() {
  const cards = S.meetings.map(m => `
    <div class="meeting-card">
      <div class="meeting-card-header">
        <span class="meeting-title">${esc(m.title)}</span>
        <button class="btn-icon delete-btn" data-id="${m.id}" title="削除">✕</button>
      </div>
      <div class="meeting-meta">
        <span>${fmtDateTime(m.startTime, m.endTime)}</span>
        ${m.endTime
          ? `<span>${fmtDuration(m.startTime, m.endTime)}</span>`
          : '<span class="badge badge-recording">録音中</span>'}
      </div>
      <div class="meeting-actions">
        ${m.minutes ? `<button class="btn btn-sm btn-primary js-view-minutes" data-id="${m.id}">議事録を見る</button>` : ''}
        <button class="btn btn-sm btn-ghost js-view-transcript" data-id="${m.id}">文字起こし</button>
        ${!m.minutes && m.transcript?.length ? `<button class="btn btn-sm btn-secondary js-generate" data-id="${m.id}">議事録を生成</button>` : ''}
      </div>
    </div>
  `).join('');

  return `
    <header class="app-header">
      <div style="min-width:36px"></div>
      <h1 class="app-title">議事録メーカー</h1>
      <button class="btn-icon js-settings" title="設定">⚙</button>
    </header>
    <main class="main-content">
      <button class="btn btn-primary btn-large new-meeting-btn js-new">🎙&ensp;新しい会議を録音</button>
      <div class="section-title">過去の議事録</div>
      <div class="meetings-list">
        ${cards || '<div class="empty-state"><div class="empty-icon">📋</div>録音された会議はまだありません</div>'}
      </div>
    </main>
  `;
}

// ── View: Record ─────────────────────────────────────────────────────────────
function vRecord() {
  const rec = S.rec;
  const charCount = rec.segments.join('').length;
  const chunkSec = parseInt(localStorage.getItem('chunkInterval') || '60');
  const statusText = rec.processing ? '処理中…' : rec.active ? '録音中' : '停止中';

  return `
    <header class="app-header">
      <button class="btn-icon js-back">←</button>
      <h1 class="app-title">${esc(S.currentMeeting?.title || '')}</h1>
      <div style="min-width:36px"></div>
    </header>
    <main class="main-content">
      <div class="record-status">
        <div class="status-dot${rec.active ? ' recording' : ''}${rec.processing ? ' processing' : ''}"></div>
        <span class="status-text">${statusText}</span>
        <span style="margin-left:auto;display:flex;gap:10px;align-items:center">
          ${rec.active ? `<span class="chunk-cd" id="chunkCountdown">−</span>` : ''}
          ${rec.active ? `<span class="elapsed" id="elapsedDisplay">${fmtElapsed(rec.elapsed)}</span>` : ''}
        </span>
      </div>
      <div class="transcript-box">
        <div class="transcript-label">
          文字起こし（Gemini Audio）
          <span class="word-count" id="wordCountDisplay">${charCount} 文字</span>
        </div>
        <div class="transcript-content" id="transcriptContent">
          ${rec.segments.map(s => `<div class="segment-block">${esc(s)}</div>`).join('')}
          ${rec.processing ? '<div class="processing-indicator">⏳ Gemini で文字起こし処理中…</div>' : ''}
          ${!rec.segments.length && !rec.processing ? `<div class="transcript-empty">録音を開始すると ${chunkSec} 秒ごとに文字起こし結果が表示されます</div>` : ''}
        </div>
      </div>
      <div class="record-controls">
        ${rec.active
          ? `<button class="btn btn-danger btn-large js-stop">⏹&ensp;録音停止</button>`
          : `<button class="btn btn-primary btn-large js-start">🎙&ensp;録音開始</button>
             ${rec.segments.length ? `<button class="btn btn-secondary btn-large js-generate-now">📝&ensp;議事録を生成</button>` : ''}`
        }
      </div>
    </main>
  `;
}

// ── View: Minutes ─────────────────────────────────────────────────────────────
function vMinutes() {
  const m = S.currentMeeting;
  return `
    <header class="app-header">
      <button class="btn-icon js-back">←</button>
      <h1 class="app-title">議事録</h1>
      <button class="btn-icon js-copy-minutes" title="コピー">📋</button>
    </header>
    <main class="main-content">
      <div class="minutes-card">
        ${S.generating ? `
          <div class="generating-state">
            <div class="spinner"></div>
            <div class="generating-text">議事録を生成中…</div>
            <div class="generating-preview" id="streamPreview">${esc(S.streamText)}</div>
          </div>
        ` : `
          <div class="minutes-content">${renderMinutesHTML(m?.minutes || '')}</div>
          <div class="minutes-actions">
            <button class="btn btn-ghost js-view-transcript-from-minutes">文字起こし</button>
            <button class="btn btn-secondary js-regenerate">再生成</button>
          </div>
        `}
      </div>
    </main>
  `;
}

function renderMinutesHTML(text) {
  if (!text) return '<p style="color:var(--text-muted)">議事録がありません</p>';
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return '<div class="m-blank"></div>';
    if (/^【.*】$/.test(t) && !/^■/.test(t)) return `<div class="m-header">${esc(t)}</div>`;
    if (/^■/.test(t)) return `<div class="m-section">${esc(t)}</div>`;
    if (/^[・•]/.test(t)) return `<div class="m-item">${esc(t)}</div>`;
    if (/^【.+】/.test(t)) return `<div class="m-topic">${esc(t)}</div>`;
    return `<div class="m-line">${esc(t)}</div>`;
  }).join('');
}

// ── View: Transcript ─────────────────────────────────────────────────────────
function vTranscript() {
  const m = S.currentMeeting;
  const text = (m?.transcript || []).join('\n\n');
  return `
    <header class="app-header">
      <button class="btn-icon js-back">←</button>
      <h1 class="app-title">文字起こし</h1>
      <button class="btn-icon js-copy-transcript" title="コピー">📋</button>
    </header>
    <main class="main-content">
      <div class="transcript-meta">
        <strong>${esc(m?.title || '')}</strong>
        <span>${fmtDateTime(m?.startTime, m?.endTime)}</span>
      </div>
      <div class="transcript-full">${esc(text) || '文字起こしデータがありません'}</div>
      ${!m?.minutes && m?.transcript?.length
        ? `<button class="btn btn-primary btn-large js-generate-now">📝&ensp;議事録を生成</button>`
        : ''}
    </main>
  `;
}

// ── View: Settings ───────────────────────────────────────────────────────────
function vSettings() {
  const key = localStorage.getItem('geminiApiKey') || '';
  const savedModel = localStorage.getItem('geminiModel') || 'gemini-2.0-flash';
  const models = loadStoredModels();
  const lang = localStorage.getItem('speechLang') || 'ja-JP';
  const langs = [
    ['ja-JP','日本語'], ['en-US','English (US)'], ['en-GB','English (UK)'],
    ['zh-CN','中文（简体）'], ['ko-KR','한국어']
  ];
  return `
    <header class="app-header">
      <button class="btn-icon js-back">←</button>
      <h1 class="app-title">設定</h1>
      <div style="min-width:36px"></div>
    </header>
    <main class="main-content">

      <div class="settings-section">
        <div class="settings-label">Gemini API キー</div>
        <div class="input-row">
          <input type="password" id="apiKeyInput" class="input" placeholder="AIza..." value="${esc(key)}">
          <button class="btn btn-secondary js-load-models" style="flex-shrink:0;white-space:nowrap">読み込む</button>
        </div>
        <div class="settings-hint">
          Google AI Studio（aistudio.google.com）から取得してください。ローカルストレージのみに保存されます。
        </div>
        <div id="loadStatus"></div>
        <button class="btn btn-primary js-save-key">APIキーを保存</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">モデル選択</div>
        ${models.length ? `
          <select id="modelSelect" class="input">
            ${models.map(m => `<option value="${esc(m.id)}"${m.id === savedModel ? ' selected' : ''}>${esc(m.displayName)}</option>`).join('')}
          </select>
        ` : `
          <input type="text" id="modelSelect" class="input" placeholder="gemini-2.0-flash" value="${esc(savedModel)}">
          <div class="settings-hint">APIキーを入力して「読み込む」を押すとモデル一覧を取得できます</div>
        `}
        <div class="input-row" style="margin-top:4px">
          <button class="btn btn-primary js-save-model">保存</button>
          <button class="btn btn-ghost js-test-model">テスト接続</button>
        </div>
        <div id="testResult"></div>
      </div>

      <div class="settings-section">
        <div class="settings-label">文字起こし間隔</div>
        <select id="intervalSelect" class="input">
          ${[['30','30秒（高頻度）'],['60','1分（標準）'],['120','2分'],['300','5分']].map(
            ([v,l]) => `<option value="${v}"${(localStorage.getItem('chunkInterval')||'60')===v?' selected':''}>${l}</option>`
          ).join('')}
        </select>
        <div class="settings-hint">短いほどリアルタイムに近くなりますが、APIコール数が増えます</div>
        <button class="btn btn-primary js-save-interval" style="width:auto">保存</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">文字起こし言語</div>
        <select id="langSelect" class="input">
          ${langs.map(([v,l]) => `<option value="${v}"${v === lang ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="btn btn-primary js-save-lang" style="width:auto">保存</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">データ管理</div>
        <button class="btn btn-danger js-clear-data">全データを削除</button>
      </div>

      <div class="settings-section app-info">
        <div>議事録メーカー v1.0</div>
        <div class="settings-hint">文字起こし: Web Speech API（Chrome/Edge）<br>議事録生成: Gemini API</div>
      </div>
    </main>
  `;
}

function loadStoredModels() {
  try { return JSON.parse(localStorage.getItem('geminiModels') || '[]'); } catch { return []; }
}

// ── Bind events ──────────────────────────────────────────────────────────────
function bind() {
  on('.js-new', 'click', openNewMeetingModal);
  on('.js-settings', 'click', () => go('settings'));
  on('.js-back', 'click', handleBack);

  onAll('.js-view-minutes', 'click', async btn => {
    S.currentMeeting = await getMeeting(btn.dataset.id);
    go('minutes');
  });
  onAll('.js-view-transcript', 'click', async btn => {
    S.currentMeeting = await getMeeting(btn.dataset.id);
    go('transcript');
  });
  onAll('.js-generate', 'click', async btn => {
    S.currentMeeting = await getMeeting(btn.dataset.id);
    doGenerate(S.currentMeeting);
  });
  onAll('.delete-btn', 'click', async btn => {
    if (!confirm('この会議を削除しますか？')) return;
    await removeMeeting(btn.dataset.id);
    S.meetings = await fetchAllMeetings();
    render();
  });

  on('.js-start', 'click', startRecording);
  on('.js-stop', 'click', stopRecording);
  on('.js-generate-now', 'click', () => doGenerate(S.currentMeeting));

  on('.js-copy-minutes', 'click', () => {
    navigator.clipboard.writeText(S.currentMeeting?.minutes || '').then(() => toast('コピーしました'));
  });
  on('.js-view-transcript-from-minutes', 'click', () => go('transcript'));
  on('.js-regenerate', 'click', () => doGenerate(S.currentMeeting));

  on('.js-copy-transcript', 'click', () => {
    const text = (S.currentMeeting?.transcript || []).join('\n\n');
    navigator.clipboard.writeText(text).then(() => toast('コピーしました'));
  });

  on('.js-save-key', 'click', () => {
    const val = document.getElementById('apiKeyInput')?.value.trim();
    if (!val) return;
    localStorage.setItem('geminiApiKey', val);
    toast('APIキーを保存しました');
  });
  on('.js-load-models', 'click', loadGeminiModels);
  on('.js-save-model', 'click', saveModel);
  on('.js-test-model', 'click', testGeminiModel);
  on('.js-save-lang', 'click', () => {
    const val = document.getElementById('langSelect')?.value;
    if (!val) return;
    localStorage.setItem('speechLang', val);
    toast('言語設定を保存しました');
  });
  on('.js-save-interval', 'click', () => {
    const val = document.getElementById('intervalSelect')?.value;
    if (!val) return;
    localStorage.setItem('chunkInterval', val);
    toast('間隔を保存しました');
  });
  on('.js-clear-data', 'click', async () => {
    if (!confirm('全てのデータを削除しますか？この操作は取り消せません。')) return;
    for (const m of S.meetings) await removeMeeting(m.id);
    S.meetings = [];
    toast('削除しました');
    go('home');
  });
}

function on(sel, ev, fn) {
  document.querySelector(sel)?.addEventListener(ev, fn);
}
function onAll(sel, ev, fn) {
  document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, () => fn(el)));
}

// ── Settings actions ─────────────────────────────────────────────────────────
function setStatusEl(id, type, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `status-msg status-${type}`;
  el.textContent = msg;
}

async function loadGeminiModels() {
  const apiKey = document.getElementById('apiKeyInput')?.value.trim() || localStorage.getItem('geminiApiKey');
  if (!apiKey) { setStatusEl('loadStatus', 'err', 'APIキーを入力してください'); return; }

  localStorage.setItem('geminiApiKey', apiKey);
  setStatusEl('loadStatus', 'loading', 'モデルを読み込み中…');

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const models = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({ id: m.name.replace('models/', ''), displayName: m.displayName || m.name.replace('models/', '') }))
      .sort((a, b) => a.id.localeCompare(b.id));

    if (!models.length) throw new Error('対応モデルが見つかりませんでした');
    localStorage.setItem('geminiModels', JSON.stringify(models));

    if (!localStorage.getItem('geminiModel')) {
      const def = models.find(m => m.id.includes('2.0-flash')) || models[0];
      localStorage.setItem('geminiModel', def.id);
    }

    setStatusEl('loadStatus', 'ok', `✓ ${models.length} 件のモデルを読み込みました`);
    setTimeout(() => go('settings'), 600);
  } catch (e) {
    setStatusEl('loadStatus', 'err', `✗ ${e.message}`);
  }
}

function saveModel() {
  const val = document.getElementById('modelSelect')?.value?.trim();
  if (!val) return;
  localStorage.setItem('geminiModel', val);
  toast('モデルを保存しました');
}

async function testGeminiModel() {
  const apiKey = document.getElementById('apiKeyInput')?.value.trim() || localStorage.getItem('geminiApiKey');
  const model = document.getElementById('modelSelect')?.value?.trim() || localStorage.getItem('geminiModel') || 'gemini-2.0-flash';
  if (!apiKey) { setStatusEl('testResult', 'err', 'APIキーを入力してください'); return; }

  setStatusEl('testResult', 'loading', 'テスト中…');
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: '「OK」とだけ答えてください' }] }],
          generationConfig: { maxOutputTokens: 20 }
        })
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '(応答なし)';
    setStatusEl('testResult', 'ok', `✓ 接続成功 — ${model}: ${text}`);
  } catch (e) {
    setStatusEl('testResult', 'err', `✗ ${e.message}`);
  }
}

async function handleBack() {
  if (S.rec.active) {
    if (!confirm('録音中です。停止して戻りますか？')) return;
    stopRecording();
  }
  S.meetings = await fetchAllMeetings();
  go('home');
}

// ── New meeting modal ─────────────────────────────────────────────────────────
function openNewMeetingModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-heading">新しい会議</div>
      <input type="text" class="input" id="modalTitleInput" placeholder="会議タイトル（例：週次定例）" maxlength="80">
      <div class="modal-actions">
        <button class="btn btn-ghost" id="modalCancel">キャンセル</button>
        <button class="btn btn-primary" id="modalConfirm">🎙&ensp;録音へ</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#modalTitleInput');
  input.focus();

  const close = () => overlay.remove();
  const confirm = () => { close(); createMeeting(input.value.trim()); };

  overlay.querySelector('#modalCancel').addEventListener('click', close);
  overlay.querySelector('#modalConfirm').addEventListener('click', confirm);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); });
}

async function createMeeting(title) {
  const meeting = {
    id: uid(),
    title: title || '無題の会議',
    startTime: new Date().toISOString(),
    endTime: null,
    transcript: [],
    minutes: null,
    createdAt: Date.now()
  };
  await putMeeting(meeting);
  S.currentMeeting = meeting;
  S.meetings = [meeting, ...S.meetings];
  S.rec = { active: false, segments: [], interim: '', recognition: null, keepAlive: true, elapsed: 0, timer: null };
  go('record');
}

// ── MediaRecorder + Gemini Audio ─────────────────────────────────────────────
let processingQueue = Promise.resolve();

function getSupportedMimeType() {
  return ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function transcribeAudio(base64, mimeType) {
  const apiKey = localStorage.getItem('geminiApiKey');
  if (!apiKey) throw new Error('APIキーが設定されていません');
  const model = localStorage.getItem('geminiModel') || 'gemini-2.0-flash';
  const lang = localStorage.getItem('speechLang') || 'ja-JP';
  const langName = { 'ja-JP':'日本語','en-US':'英語','en-GB':'英語','zh-CN':'中国語','ko-KR':'韓国語' }[lang] || '日本語';
  const ctx = S.rec.segments.slice(-2).join('').slice(-300);
  const prompt = `この音声を${langName}で正確に文字起こしして。${ctx ? `直前の文脈:「…${ctx}」` : ''}
話し言葉そのままで、句読点を適切に追加。複数話者もそのまま書き起こす。
文字起こしテキストのみ出力すること。`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: mimeType, data: base64 } },
          { text: prompt }
        ]}],
        generationConfig: { maxOutputTokens: 2048 }
      })
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function processChunk() {
  const rec = S.rec;
  if (!rec.audioBuffer.length) return;
  const chunks = [...rec.audioBuffer];
  rec.audioBuffer = [];
  rec.chunkStartTime = Date.now();

  const mimeType = (rec.mediaRecorder?.mimeType || 'audio/webm').split(';')[0];
  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size < 2000) return;

  rec.processing = true;
  updateTranscriptUI();

  processingQueue = processingQueue.then(async () => {
    try {
      const base64 = await blobToBase64(blob);
      const text = await transcribeAudio(base64, mimeType);
      if (text) { rec.segments.push(text); autoSave(); }
    } catch (e) {
      console.error('Transcription error:', e);
    } finally {
      rec.processing = false;
      updateTranscriptUI();
    }
  });
}

async function startRecording() {
  if (!localStorage.getItem('geminiApiKey')) {
    alert('先に設定画面でGemini APIキーを設定してください。');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true }
    });
  } catch (e) {
    alert(e.name === 'NotAllowedError'
      ? 'マイクへのアクセスが拒否されました。ブラウザの設定を確認してください。'
      : `マイクエラー: ${e.message}`);
    return;
  }

  const rec = S.rec;
  rec.active = true;
  rec.stream = stream;
  rec.audioBuffer = [];
  rec.chunkStartTime = Date.now();
  rec.elapsed = 0;

  const mimeType = getSupportedMimeType();
  const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  rec.mediaRecorder = mr;
  mr.ondataavailable = e => { if (e.data.size > 0) rec.audioBuffer.push(e.data); };
  mr.start(1000);

  const chunkMs = parseInt(localStorage.getItem('chunkInterval') || '60') * 1000;
  rec.chunkTimer = setInterval(processChunk, chunkMs);

  rec.timer = setInterval(() => {
    rec.elapsed++;
    const el = document.getElementById('elapsedDisplay');
    if (el) el.textContent = fmtElapsed(rec.elapsed);
    const remaining = Math.max(0, Math.round(chunkMs / 1000 - (Date.now() - rec.chunkStartTime) / 1000));
    const cd = document.getElementById('chunkCountdown');
    if (cd) cd.textContent = `${remaining}秒後に処理`;
  }, 1000);

  render();
}

function stopRecording() {
  const rec = S.rec;
  rec.active = false;
  clearInterval(rec.timer);
  clearInterval(rec.chunkTimer);
  rec.timer = null;
  rec.chunkTimer = null;

  const finish = async () => {
    if (rec.mediaRecorder && rec.mediaRecorder.state !== 'inactive') {
      await new Promise(resolve => {
        rec.mediaRecorder.addEventListener('stop', resolve, { once: true });
        rec.mediaRecorder.stop();
      });
    }
    if (rec.stream) { rec.stream.getTracks().forEach(t => t.stop()); rec.stream = null; }
    await processChunk();
    await processingQueue;
    if (S.currentMeeting) {
      S.currentMeeting.endTime = new Date().toISOString();
      S.currentMeeting.transcript = [...rec.segments];
      await putMeeting(S.currentMeeting);
    }
    render();
  };

  render();
  finish().catch(console.error);
}

function updateTranscriptUI() {
  const container = document.getElementById('transcriptContent');
  if (!container) return;
  const rec = S.rec;
  container.innerHTML =
    rec.segments.map(s => `<div class="segment-block">${esc(s)}</div>`).join('') +
    (rec.processing ? '<div class="processing-indicator">⏳ Gemini で文字起こし処理中…</div>' : '') +
    (!rec.segments.length && !rec.processing ? `<div class="transcript-empty">録音を開始すると ${parseInt(localStorage.getItem('chunkInterval')||'60')} 秒ごとに文字起こし結果が表示されます</div>` : '');
  container.scrollTop = container.scrollHeight;
  const wc = document.getElementById('wordCountDisplay');
  if (wc) wc.textContent = `${rec.segments.join('').length} 文字`;
}

async function autoSave() {
  if (!S.currentMeeting) return;
  S.currentMeeting.transcript = [...S.rec.segments];
  await putMeeting(S.currentMeeting).catch(() => {});
}

// ── Gemini API ───────────────────────────────────────────────────────────────
async function doGenerate(meeting) {
  let apiKey = localStorage.getItem('geminiApiKey');
  if (!apiKey) {
    const k = prompt('Gemini API キーを入力してください (AIza...):');
    if (!k) return;
    apiKey = k.trim();
    localStorage.setItem('geminiApiKey', apiKey);
  }

  S.currentMeeting = meeting;
  S.generating = true;
  S.streamText = '';
  go('minutes');

  const transcript = (meeting.transcript || []).join('\n');
  if (!transcript.trim()) {
    alert('文字起こしデータがありません');
    S.generating = false;
    render();
    return;
  }

  try {
    const text = transcript.length > 80000
      ? await generateChunked(transcript, meeting, apiKey)
      : await callGemini(buildPrompt(meeting, transcript), apiKey);

    meeting.minutes = text;
    await putMeeting(meeting);
    S.meetings = await fetchAllMeetings();
  } catch (e) {
    console.error(e);
    alert(`議事録の生成に失敗しました:\n${e.message}`);
  }

  S.generating = false;
  render();
}

function buildPrompt(meeting, transcript) {
  const dt = fmtDateTime(meeting.startTime, meeting.endTime);
  const dur = fmtDuration(meeting.startTime, meeting.endTime);
  return `あなたは優秀な秘書です。以下の会議の文字起こしをもとに、構造化された議事録を作成してください。

【会議情報】
会議名: ${meeting.title}
日時: ${dt}${dur ? ` (${dur})` : ''}

【文字起こし】
${transcript}

【議事録の形式】
以下の形式で正確に出力してください（形式を変えないこと）：

【会議名】${meeting.title}
【日時】${dt}

■ サマリ
（会議全体の要約を3〜5文で記述）

■ アクションアイテム
・（アクション内容） → 担当：（担当者名、不明の場合は「不明」） / 期限：（期日、不明の場合は「不明」）
（複数ある場合は行を分けて列挙。なければ「なし」と記載）

■ トピック別要点
【トピック1】（トピック名）
（要点を箇条書きで。各行の先頭に・を付ける）

【トピック2】（トピック名）
（要点を箇条書きで）
（必要に応じてトピックを追加）

■ その他・決定事項
（その他の決定事項、共有事項等。なければ「なし」）

文字起こしの内容を忠実に反映し、推測は行わないでください。担当者名・期限は明示された情報のみ使用してください。`;
}

async function generateChunked(transcript, meeting, apiKey) {
  const chunkSize = 40000;
  const chunks = [];
  for (let i = 0; i < transcript.length; i += chunkSize) {
    chunks.push(transcript.slice(i, i + chunkSize));
  }

  const summaries = [];
  for (let i = 0; i < chunks.length; i++) {
    const p = `以下は長い会議の文字起こしのパート${i+1}/${chunks.length}です。重要な発言、決定事項、アクションアイテム、数字・固有名詞を漏れなく箇条書きでまとめてください：\n\n${chunks[i]}`;
    const s = await callGemini(p, apiKey);
    summaries.push(`=== パート${i+1}/${chunks.length} ===\n${s}`);
  }

  return callGemini(buildPrompt(meeting, `[長時間会議・分割要約]\n\n${summaries.join('\n\n')}`), apiKey);
}

async function callGemini(prompt, apiKey) {
  const model = localStorage.getItem('geminiModel') || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 8192 }
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API エラー (HTTP ${res.status})`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trimEnd(); // \r\n 対応
      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          full += text;
          S.streamText = full;
          const el = document.getElementById('streamPreview');
          if (el) el.textContent = full;
        }
      } catch (_) {}
    }
  }

  if (!full) throw new Error('モデルから応答がありませんでした。モデル名とAPIキーを確認してください。');
  return full;
}

// ── Toast ────────────────────────────────────────────────────────────────────
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.classList.add('toast-visible');
    setTimeout(() => {
      el.classList.remove('toast-visible');
      setTimeout(() => el.remove(), 280);
    }, 2000);
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  db = await openDB();
  S.meetings = await fetchAllMeetings();
  go('home');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  }
}

init();
