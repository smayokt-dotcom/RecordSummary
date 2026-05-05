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

// ── Word Dictionary ──────────────────────────────────────────────────────────
function loadWordDict() {
  try { return JSON.parse(localStorage.getItem('wordDict') || '[]'); } catch { return []; }
}
function saveWordDict(dict) {
  localStorage.setItem('wordDict', JSON.stringify(dict));
}
function applyWordDict(text) {
  const dict = loadWordDict();
  let result = text;
  for (const { from, to } of dict) {
    if (!from) continue;
    result = result.split(from).join(to);
  }
  return result;
}

function exportWordDict() {
  const dict = loadWordDict();
  const defaultName = `word-dict-${new Date().toISOString().slice(0, 10)}`;
  const filename = prompt('エクスポートファイル名を入力してください（.json は自動付加）', defaultName);
  if (filename == null) return;
  const name = (filename.trim() || defaultName).replace(/\.json$/i, '') + '.json';
  const blob = new Blob([JSON.stringify(dict, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function importWordDict() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('配列形式のJSONではありません');
      const imported = data.filter(e => e && typeof e.from === 'string' && e.from);
      if (!imported.length) { alert('有効なエントリが見つかりませんでした'); return; }
      const merge = confirm(`${imported.length}件を読み込みます。\nOK → 現在の辞書に追加\nキャンセル → 現在の辞書を上書き`);
      saveWordDict(merge ? [...loadWordDict(), ...imported] : imported);
      renderWordDictTable();
      toast(`${imported.length}件をインポートしました`);
    } catch (err) {
      alert('インポートに失敗しました: ' + err.message);
    }
  };
  input.click();
}

// ── Minutes mode ─────────────────────────────────────────────────────────────
const MODES = [
  { id: 'standard', label: '標準' },
  { id: 'simple',   label: 'シンプル' },
  { id: 'action',   label: 'アクション' }
];
function getMode() { return localStorage.getItem('minutesMode') || 'standard'; }
function modeSelectHTML(idAttr) {
  const cur = getMode();
  return `<select class="input mode-select-inline" id="${idAttr}">
    ${MODES.map(m => `<option value="${m.id}"${m.id === cur ? ' selected' : ''}>${m.label}</option>`).join('')}
  </select>`;
}

// ── State ────────────────────────────────────────────────────────────────────
const S = {
  view: 'home',
  meetings: [],
  currentMeeting: null,
  rec: {
    active: false,
    paused: false,
    processing: false,
    segments: [],
    rawSegments: [],      // [{text, ts, elapsed}]
    stream: null,
    mediaRecorder: null,
    audioBuffer: [],
    elapsed: 0,
    elapsedBase: 0,       // accumulated elapsed from previous sessions
    timer: null,
    chunkTimer: null,
    chunkStartTime: 0,
    audioContext: null
  },
  generating: false,
  streamText: '',
  editingMinutes: false,
  editingTranscript: false,
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
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button class="btn-icon js-edit" data-id="${m.id}" title="編集" style="color:var(--text-muted);font-size:15px">✏</button>
          <button class="btn-icon delete-btn" data-id="${m.id}" title="削除">✕</button>
        </div>
      </div>
      ${(m.location || m.participants) ? `
      <div class="meeting-meta-extra">
        ${m.location ? `<span>📍 ${esc(m.location)}</span>` : ''}
        ${m.participants ? `<span>👥 ${esc(m.participants)}</span>` : ''}
      </div>` : ''}
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
      <h1 class="app-title">メモまる</h1>
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
  let statusText = '停止中';
  if (rec.active && rec.paused) statusText = '一時停止中';
  else if (rec.active) statusText = '録音中';
  else if (rec.processing) statusText = '処理中…';

  let controls = '';
  if (rec.active) {
    controls = `
      ${rec.paused
        ? `<button class="btn btn-primary btn-large js-resume">▶&ensp;録音再開</button>`
        : `<button class="btn btn-warning btn-large js-pause">⏸&ensp;一時停止</button>`}
      <button class="btn btn-danger btn-large js-stop">⏹&ensp;録音停止</button>
    `;
  } else {
    controls = `
      ${rec.segments.length
        ? `<button class="btn btn-primary btn-large js-start-resume">🎙&ensp;録音を続ける</button>
           <button class="btn btn-secondary btn-large js-generate-now">📝&ensp;議事録を生成</button>`
        : `<button class="btn btn-primary btn-large js-start">🎙&ensp;録音開始</button>`}
    `;
  }

  return `
    <header class="app-header">
      <button class="btn-icon js-back">←</button>
      <h1 class="app-title">${esc(S.currentMeeting?.title || '')}</h1>
      <div style="min-width:36px"></div>
    </header>
    <main class="main-content">
      <div class="record-status">
        <div class="status-dot${rec.active && !rec.paused ? ' recording' : ''}${rec.active && rec.paused ? ' paused' : ''}${rec.processing ? ' processing' : ''}"></div>
        <span class="status-text">${statusText}</span>
        <span style="margin-left:auto;display:flex;gap:10px;align-items:center">
          ${rec.active && !rec.paused ? `<span class="chunk-cd" id="chunkCountdown">−</span>` : ''}
          ${rec.active ? `<span class="elapsed" id="elapsedDisplay">${fmtElapsed(rec.elapsed)}</span>` : ''}
        </span>
      </div>
      <div class="transcript-box">
        <div class="transcript-label">
          文字起こし（Gemini Audio）
          <span class="word-count" id="wordCountDisplay">${charCount} 文字</span>
        </div>
        <div class="transcript-content" id="transcriptContent">
          ${rec.rawSegments.map(s => `
            <div class="segment-block">
              <span class="ts-badge">${esc(s.ts)}</span>
              ${esc(s.text)}
            </div>`).join('')}
          ${rec.processing ? '<div class="processing-indicator">⏳ Gemini で文字起こし処理中…</div>' : ''}
          ${!rec.rawSegments.length && !rec.processing ? `<div class="transcript-empty">録音を開始すると ${chunkSec} 秒ごとに文字起こし結果が表示されます</div>` : ''}
        </div>
      </div>
      <div class="record-controls">${controls}</div>
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
        ` : S.editingMinutes ? `
          <textarea class="edit-textarea" id="minutesEditArea">${esc(m?.minutes || '')}</textarea>
          <div class="edit-actions">
            <button class="btn btn-ghost js-cancel-edit-minutes">キャンセル</button>
            <button class="btn btn-primary js-save-edit-minutes">💾&ensp;保存</button>
          </div>
        ` : `
          <div class="minutes-content">${renderMinutesHTML(m?.minutes || '')}</div>
          <div class="minutes-actions">
            <button class="btn btn-ghost js-view-transcript-from-minutes">文字起こし</button>
            <button class="btn btn-ghost js-edit-minutes">✏&ensp;編集</button>
            <button class="btn btn-secondary js-regenerate">再生成</button>
          </div>
        `}
      </div>
    </main>
  `;
}

function renderMinutesHTML(text) {
  if (!text) return '<p style="color:var(--text-muted)">議事録がありません</p>';
  const spk = S.currentMeeting?.speakerNames;
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return '<div class="m-blank"></div>';
    const e = wrapSpeakers(esc(t), spk);
    if (/^【.*】$/.test(t) && !/^■/.test(t)) return `<div class="m-header">${e}</div>`;
    if (/^■/.test(t)) return `<div class="m-section">${e}</div>`;
    if (/^[・•]/.test(t)) return `<div class="m-item">${e}</div>`;
    if (/^【.+】/.test(t)) return `<div class="m-topic">${e}</div>`;
    return `<div class="m-line">${e}</div>`;
  }).join('');
}

// ── View: Transcript ─────────────────────────────────────────────────────────
function vTranscript() {
  const m = S.currentMeeting;
  const rawSegs = m?.rawSegments || [];
  const _allTransText = [...(m?.transcript || []), ...(m?.rawSegments || []).map(s => s.text)].join('');
  const hasSpeakers = _allTransText.match(/話者[A-Z]:/) || Object.keys(m?.speakerNames || {}).length > 0;

  let content;
  if (S.editingTranscript) {
    const fullText = rawSegs.length
      ? rawSegs.map(s => `[${s.ts}]\n${s.text}`).join('\n\n')
      : (m?.transcript || []).join('\n\n');
    content = `
      <textarea class="edit-textarea" id="transcriptEditArea">${esc(fullText)}</textarea>
      <div class="edit-actions">
        <button class="btn btn-ghost js-cancel-edit-transcript">キャンセル</button>
        <button class="btn btn-primary js-save-edit-transcript">💾&ensp;保存</button>
      </div>`;
  } else if (rawSegs.length) {
    const spk = m?.speakerNames;
    content = rawSegs.map(s =>
      `<div class="raw-segment"><span class="ts-label">[${esc(s.ts)}]</span><div class="ts-text">${wrapSpeakers(esc(s.text), spk)}</div></div>`
    ).join('');
  } else {
    const text = (m?.transcript || []).join('\n\n');
    const spk = m?.speakerNames;
    content = `<div style="white-space:pre-wrap">${wrapSpeakers(esc(text), spk) || '文字起こしデータがありません'}</div>`;
  }

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
        ${m?.location ? `<span>📍 ${esc(m.location)}</span>` : ''}
        ${m?.participants ? `<span>👥 ${esc(m.participants)}</span>` : ''}
      </div>
      <div class="transcript-full">${content}</div>
      ${!S.editingTranscript ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${hasSpeakers ? `<button class="btn btn-ghost js-assign-speakers">👤&ensp;話者名を設定</button>` : ''}
          <button class="btn btn-ghost js-edit-transcript">✏&ensp;編集</button>
          ${!m?.minutes && m?.transcript?.length
            ? `<button class="btn btn-primary js-generate-now">📝&ensp;議事録を生成</button>` : ''}
        </div>` : ''}
    </main>
  `;
}

// ── View: Settings ───────────────────────────────────────────────────────────
function vSettings() {
  const key = localStorage.getItem('geminiApiKey') || '';
  const savedModel = localStorage.getItem('geminiModel') || 'gemini-2.5-flash';
  const models = loadStoredModels();
  const lang = localStorage.getItem('speechLang') || 'ja-JP';
  const langs = [
    ['ja-JP','日本語'], ['en-US','English (US)'], ['en-GB','English (UK)'],
    ['zh-CN','中文（简体）'], ['ko-KR','한국어']
  ];
  const minutesMode = localStorage.getItem('minutesMode') || 'standard';

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
          <input type="text" id="modelSelect" class="input" placeholder="gemini-2.5-flash" value="${esc(savedModel)}">
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
        <div class="settings-label">話者切り分け</div>
        <select id="diarizeSelect" class="input">
          <option value="false"${(localStorage.getItem('speakerDiarization')||'false')==='false'?' selected':''}>オフ</option>
          <option value="true"${localStorage.getItem('speakerDiarization')==='true'?' selected':''}>オン（話者A / 話者B … でラベル付け）</option>
        </select>
        <div class="settings-hint">Geminiが声の違いを検出し「話者A:」「話者B:」のラベルを付けます。前チャンクの話者ラベルを引き継いで一貫性を保ちます。</div>
        <button class="btn btn-primary js-save-diarize" style="width:auto">保存</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">マイク感度（ゲイン増幅）</div>
        <select id="gainSelect" class="input">
          ${[['1','×1（標準）'],['2','×2'],['3','×3（推奨）'],['4','×4'],['5','×5（最大）']].map(
            ([v,l]) => `<option value="${v}"${(localStorage.getItem('micGain')||'3')===v?' selected':''}>${l}</option>`
          ).join('')}
        </select>
        <div class="settings-hint">会議室など声が遠い環境では ×3〜×5 を推奨。増幅しすぎると音割れするので調整してください。</div>
        <button class="btn btn-primary js-save-gain" style="width:auto">保存</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">オーディオフィルター</div>
        <select id="filterPresetSelect" class="input">
          ${[['off','オフ'],['standard','標準（100Hz〜8kHz）'],['conference','会議室（200Hz〜6kHz）'],['phone','電話品質（300Hz〜3.4kHz）'],['custom','カスタム']].map(
            ([v,l]) => `<option value="${v}"${(localStorage.getItem('filterPreset')||'off')===v?' selected':''}>${l}</option>`
          ).join('')}
        </select>
        <div id="customFilterInputs" style="display:${(localStorage.getItem('filterPreset')||'off')==='custom'?'flex':'none'};flex-direction:column;gap:8px;margin-top:8px">
          <div style="display:flex;gap:8px;align-items:center">
            <span style="font-size:13px;color:var(--text-muted);min-width:72px">ハイパス</span>
            <input type="number" id="highpassInput" class="input" placeholder="100" min="20" max="2000" value="${esc(localStorage.getItem('highpassFreq')||'100')}" style="flex:1">
            <span style="font-size:13px;color:var(--text-muted)">Hz</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <span style="font-size:13px;color:var(--text-muted);min-width:72px">ローパス</span>
            <input type="number" id="lowpassInput" class="input" placeholder="8000" min="1000" max="20000" value="${esc(localStorage.getItem('lowpassFreq')||'8000')}" style="flex:1">
            <span style="font-size:13px;color:var(--text-muted)">Hz</span>
          </div>
        </div>
        <div class="settings-hint">エアコン・低音ノイズはハイパスで、高音ノイズはローパスでカット。次の録音から適用されます。</div>
        <button class="btn btn-primary js-save-filter" style="width:auto">保存</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">ダイナミクスコンプレッサー</div>
        <select id="compressorSelect" class="input">
          <option value="false"${(localStorage.getItem('compressor')||'false')==='false'?' selected':''}>オフ</option>
          <option value="true"${localStorage.getItem('compressor')==='true'?' selected':''}>オン（音量ムラを均一化）</option>
        </select>
        <div class="settings-hint">遠い声と近い声の音量差を均一化します。会議室での使用に効果的です。</div>
        <button class="btn btn-primary js-save-compressor" style="width:auto">保存</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">単語辞書（誤変換修正）</div>
        <div class="settings-hint">専門用語・固有名詞の誤変換を登録。Geminiプロンプトへのヒント注入と後処理置換の両方に適用されます。</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary js-add-dict-entry" style="width:auto">＋ 追加</button>
          <button class="btn btn-ghost js-list-dict" style="width:auto">📋 一覧</button>
          <button class="btn btn-ghost js-export-dict" style="width:auto">📤 エクスポート</button>
          <button class="btn btn-ghost js-import-dict" style="width:auto">📥 インポート</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-label">議事録まとめモード</div>
        <select id="minutesModeSelect" class="input">
          <option value="standard"${minutesMode==='standard'?' selected':''}>標準（サマリ＋アクション＋トピック）</option>
          <option value="simple"${minutesMode==='simple'?' selected':''}>シンプル（サマリのみ）</option>
          <option value="action"${minutesMode==='action'?' selected':''}>アクション重視</option>
        </select>
        <div class="settings-hint">※ モード別テンプレートは後日追加予定</div>
        <button class="btn btn-primary js-save-minutes-mode" style="width:auto">保存</button>
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
        <div>メモまる v1.0</div>
        <div class="settings-hint">文字起こし: Gemini Audio API<br>議事録生成: Gemini API</div>
      </div>
    </main>
  `;
}

function loadStoredModels() {
  try { return JSON.parse(localStorage.getItem('geminiModels') || '[]'); } catch { return []; }
}

// ── Word Dict UI ─────────────────────────────────────────────────────────────
function renderWordDictTable() {
  const container = document.getElementById('wordDictList');
  if (!container) return;
  const dict = loadWordDict();
  if (!dict.length) {
    container.innerHTML = '<div class="settings-hint dict-empty">エントリがありません。「＋ 追加」で登録できます。</div>';
    return;
  }
  container.innerHTML = `
    <table class="dict-table">
      <thead>
        <tr>
          <th>誤変換 / 変換前</th>
          <th>正しい表記 / 変換後</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${dict.map((entry, i) => `
          <tr>
            <td class="dict-cell-from">${esc(entry.from)}</td>
            <td class="dict-cell-to">${esc(entry.to)}</td>
            <td class="dict-cell-actions">
              <button class="btn btn-sm btn-ghost dict-edit-btn" data-idx="${i}">編集</button>
              <button class="btn btn-sm btn-ghost dict-del-btn" data-idx="${i}" style="color:var(--danger);border-color:var(--danger)">削除</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  container.querySelectorAll('.dict-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openDictEntryModal(parseInt(btn.dataset.idx)));
  });
  container.querySelectorAll('.dict-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const d = loadWordDict();
      const entry = d[idx];
      if (!confirm(`「${entry.from}」→「${entry.to}」を削除しますか？`)) return;
      d.splice(idx, 1);
      saveWordDict(d);
      renderWordDictTable();
    });
  });
}

function openDictListModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '55';
  document.body.appendChild(overlay);

  function refresh() {
    const dict = loadWordDict();
    overlay.innerHTML = `
      <div class="modal modal-wide">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="modal-heading" style="margin:0">単語辞書</div>
          <span style="font-size:13px;color:var(--text-muted)">${dict.length}件</span>
        </div>
        <div class="dict-modal-body">
          ${dict.length ? `
            <table class="dict-table">
              <thead><tr><th>変換前</th><th>変換後</th><th></th></tr></thead>
              <tbody>
                ${dict.map((e, i) => `
                  <tr>
                    <td class="dict-cell-from">${esc(e.from)}</td>
                    <td class="dict-cell-to">${esc(e.to)}</td>
                    <td class="dict-cell-actions">
                      <button class="btn btn-sm btn-ghost dict-edit-btn" data-idx="${i}">編集</button>
                      <button class="btn btn-sm btn-ghost dict-del-btn" data-idx="${i}" style="color:var(--danger);border-color:var(--danger)">削除</button>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>` : '<div class="dict-empty settings-hint">エントリがありません。「＋ 追加」で登録できます。</div>'}
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="dictListClose">閉じる</button>
          <button class="btn btn-primary" id="dictListAdd">＋ 追加</button>
        </div>
      </div>`;

    overlay.querySelector('#dictListClose').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#dictListAdd').addEventListener('click', () => openDictEntryModal(null, refresh));
    overlay.querySelectorAll('.dict-edit-btn').forEach(btn =>
      btn.addEventListener('click', () => openDictEntryModal(parseInt(btn.dataset.idx), refresh)));
    overlay.querySelectorAll('.dict-del-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.idx);
        const d = loadWordDict();
        if (!confirm(`「${d[i].from}」→「${d[i].to}」を削除しますか？`)) return;
        d.splice(i, 1);
        saveWordDict(d);
        refresh();
      }));
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }
  refresh();
}

function openDictEntryModal(idx = null, onSave = null) {
  const dict = loadWordDict();
  const entry = idx !== null ? dict[idx] : { from: '', to: '' };
  const isNew = idx === null;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-heading">${isNew ? '辞書エントリを追加' : '辞書エントリを編集'}</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <label style="font-size:13px;color:var(--text-muted)">変換前（誤変換・略語など）</label>
        <input type="text" class="input" id="dictFromInput" placeholder="例: えーあい" value="${esc(entry.from)}">
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <label style="font-size:13px;color:var(--text-muted)">変換後（正しい表記）</label>
        <input type="text" class="input" id="dictToInput" placeholder="例: AI" value="${esc(entry.to)}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="dictModalCancel">キャンセル</button>
        <button class="btn btn-primary" id="dictModalSave">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#dictFromInput').focus();

  const close = () => overlay.remove();
  const save = () => {
    const from = document.getElementById('dictFromInput').value.trim();
    const to   = document.getElementById('dictToInput').value.trim();
    if (!from) { alert('変換前の語を入力してください'); return; }
    const d = loadWordDict();
    if (isNew) { d.push({ from, to }); } else { d[idx] = { from, to }; }
    saveWordDict(d);
    if (onSave) onSave();
    close();
    toast(isNew ? 'エントリを追加しました' : 'エントリを更新しました');
  };

  overlay.querySelector('#dictModalCancel').addEventListener('click', close);
  overlay.querySelector('#dictModalSave').addEventListener('click', save);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#dictToInput').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
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
    generateWithModeModal(S.currentMeeting);
  });
  onAll('.js-edit', 'click', btn => openEditMeetingModal(btn.dataset.id));
  onAll('.delete-btn', 'click', async btn => {
    if (!confirm('この会議を削除しますか？')) return;
    await removeMeeting(btn.dataset.id);
    S.meetings = await fetchAllMeetings();
    render();
  });

  on('.js-start', 'click', () => startRecording(false));
  on('.js-start-resume', 'click', () => startRecording(true));
  on('.js-pause', 'click', pauseRecording);
  on('.js-resume', 'click', resumeRecording);
  on('.js-stop', 'click', stopRecording);
  on('.js-generate-now', 'click', () => generateWithModeModal(S.currentMeeting));

  on('.js-copy-minutes', 'click', () => {
    navigator.clipboard.writeText(S.currentMeeting?.minutes || '').then(() => toast('コピーしました'));
  });
  on('.js-view-transcript-from-minutes', 'click', () => { S.editingMinutes = false; go('transcript'); });
  on('.js-regenerate', 'click', () => generateWithModeModal(S.currentMeeting));

  // 議事録 編集
  on('.js-edit-minutes', 'click', () => { S.editingMinutes = true; render(); });
  on('.js-cancel-edit-minutes', 'click', () => { S.editingMinutes = false; render(); });
  on('.js-save-edit-minutes', 'click', async () => {
    const val = document.getElementById('minutesEditArea')?.value;
    if (val == null) return;
    S.currentMeeting.minutes = val;
    await putMeeting(S.currentMeeting);
    S.meetings = await fetchAllMeetings();
    S.editingMinutes = false;
    toast('議事録を保存しました');
    render();
  });

  // 文字起こし 編集
  on('.js-edit-transcript', 'click', () => { S.editingTranscript = true; render(); });
  on('.js-cancel-edit-transcript', 'click', () => { S.editingTranscript = false; render(); });
  on('.js-save-edit-transcript', 'click', async () => {
    const val = document.getElementById('transcriptEditArea')?.value;
    if (val == null) return;
    // タイムスタンプ形式 "[MM:SS]\ntext" をパースして rawSegments 再構築
    const blocks = val.split(/\n\n+/);
    const rawSegs = [], plainSegs = [];
    for (const block of blocks) {
      const m = block.match(/^\[(\d+:\d+(?::\d+)?)\]\n?([\s\S]*)/);
      if (m) { rawSegs.push({ ts: m[1], elapsed: 0, text: m[2].trim() }); plainSegs.push(m[2].trim()); }
      else if (block.trim()) { plainSegs.push(block.trim()); }
    }
    S.currentMeeting.rawSegments = rawSegs;
    S.currentMeeting.transcript = plainSegs;
    await putMeeting(S.currentMeeting);
    S.meetings = await fetchAllMeetings();
    S.editingTranscript = false;
    toast('文字起こしを保存しました');
    render();
  });
  on('.js-assign-speakers', 'click', () => openSpeakerNamesModal(S.currentMeeting));

  on('.js-copy-transcript', 'click', () => {
    const m = S.currentMeeting;
    const rawSegs = m?.rawSegments || [];
    const text = rawSegs.length
      ? rawSegs.map(s => `[${s.ts}]\n${s.text}`).join('\n\n')
      : (m?.transcript || []).join('\n\n');
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
  on('.js-save-gain', 'click', () => {
    const val = document.getElementById('gainSelect')?.value;
    if (!val) return;
    localStorage.setItem('micGain', val);
    toast('感度設定を保存しました');
  });
  on('.js-save-diarize', 'click', () => {
    const val = document.getElementById('diarizeSelect')?.value;
    if (val == null) return;
    localStorage.setItem('speakerDiarization', val);
    toast('話者切り分け設定を保存しました');
  });
  on('#filterPresetSelect', 'change', () => {
    const val = document.getElementById('filterPresetSelect')?.value;
    const el = document.getElementById('customFilterInputs');
    if (el) el.style.display = val === 'custom' ? 'flex' : 'none';
  });
  on('.js-save-filter', 'click', () => {
    const preset = document.getElementById('filterPresetSelect')?.value;
    if (!preset) return;
    localStorage.setItem('filterPreset', preset);
    if (preset === 'custom') {
      const hp = document.getElementById('highpassInput')?.value;
      const lp = document.getElementById('lowpassInput')?.value;
      if (hp) localStorage.setItem('highpassFreq', hp);
      if (lp) localStorage.setItem('lowpassFreq', lp);
    }
    toast('フィルター設定を保存しました');
  });
  on('.js-save-compressor', 'click', () => {
    const val = document.getElementById('compressorSelect')?.value;
    if (val == null) return;
    localStorage.setItem('compressor', val);
    toast('コンプレッサー設定を保存しました');
  });
  // 単語辞書
  on('.js-add-dict-entry', 'click', () => openDictEntryModal(null));
  on('.js-list-dict',      'click', openDictListModal);
  on('.js-export-dict',    'click', exportWordDict);
  on('.js-import-dict',    'click', importWordDict);
  on('.js-save-minutes-mode', 'click', () => {
    const val = document.getElementById('minutesModeSelect')?.value;
    if (!val) return;
    localStorage.setItem('minutesMode', val);
    toast('まとめモードを保存しました');
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
  const model = document.getElementById('modelSelect')?.value?.trim() || localStorage.getItem('geminiModel') || 'gemini-2.5-flash';
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
  S.editingMinutes = false;
  S.editingTranscript = false;
  S.meetings = await fetchAllMeetings();
  go('home');
}

// ── New meeting modal ─────────────────────────────────────────────────────────
function openNewMeetingModal() {
  const curInterval = localStorage.getItem('chunkInterval') || '60';
  const curGain     = localStorage.getItem('micGain') || '3';
  const curFilter   = localStorage.getItem('filterPreset') || 'off';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-heading">新しい会議</div>
      <input type="text" class="input" id="modalTitleInput" placeholder="会議タイトル（例：週次定例）" maxlength="80">
      <div class="modal-setting-row">
        <label class="modal-setting-label">文字起こし間隔</label>
        <select id="modalChunkInterval" class="input modal-setting-select">
          ${[['30','30秒'],['60','1分'],['120','2分'],['300','5分']].map(
            ([v,l]) => `<option value="${v}"${v===curInterval?' selected':''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="modal-setting-row">
        <label class="modal-setting-label">マイク感度</label>
        <select id="modalMicGain" class="input modal-setting-select">
          ${[['1','×1 標準'],['2','×2'],['3','×3 推奨'],['4','×4'],['5','×5 最大']].map(
            ([v,l]) => `<option value="${v}"${v===curGain?' selected':''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="modal-setting-row">
        <label class="modal-setting-label">フィルター</label>
        <select id="modalFilterPreset" class="input modal-setting-select">
          ${[['off','オフ'],['standard','標準'],['conference','会議室'],['phone','電話品質']].map(
            ([v,l]) => `<option value="${v}"${v===curFilter?' selected':''}>${l}</option>`).join('')}
        </select>
      </div>
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
  const confirm = () => {
    const settings = {
      chunkInterval: overlay.querySelector('#modalChunkInterval').value,
      micGain:       overlay.querySelector('#modalMicGain').value,
      filterPreset:  overlay.querySelector('#modalFilterPreset').value,
    };
    close();
    createMeeting(input.value.trim(), settings);
  };

  overlay.querySelector('#modalCancel').addEventListener('click', close);
  overlay.querySelector('#modalConfirm').addEventListener('click', confirm);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

async function createMeeting(title, settings = {}) {
  if (settings.chunkInterval) localStorage.setItem('chunkInterval', settings.chunkInterval);
  if (settings.micGain)       localStorage.setItem('micGain', settings.micGain);
  if (settings.filterPreset)  localStorage.setItem('filterPreset', settings.filterPreset);
  const meeting = {
    id: uid(),
    title: title || '無題の会議',
    location: '',
    participants: '',
    startTime: new Date().toISOString(),
    endTime: null,
    transcript: [],
    rawSegments: [],
    minutes: null,
    createdAt: Date.now()
  };
  await putMeeting(meeting);
  S.currentMeeting = meeting;
  S.meetings = [meeting, ...S.meetings];
  S.rec = {
    active: false, paused: false, processing: false, segments: [],
    rawSegments: [], stream: null, mediaRecorder: null, audioBuffer: [],
    elapsed: 0, elapsedBase: 0, timer: null, chunkTimer: null,
    chunkStartTime: 0, audioContext: null
  };
  go('record');
}

// ── Edit meeting modal ────────────────────────────────────────────────────────
async function openEditMeetingModal(id) {
  const meeting = await getMeeting(id);
  if (!meeting) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-heading">会議を編集</div>
      <input type="text" class="input" id="editTitleInput" placeholder="会議タイトル" value="${esc(meeting.title)}" maxlength="80">
      <input type="text" class="input" id="editLocationInput" placeholder="場所（例：第一会議室）" value="${esc(meeting.location||'')}" maxlength="80">
      <textarea class="input" id="editParticipantsInput" placeholder="参加者（例：山田、鈴木、田中）" maxlength="200" style="resize:vertical;min-height:64px">${esc(meeting.participants||'')}</textarea>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="editModalCancel">キャンセル</button>
        <button class="btn btn-primary" id="editModalConfirm">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#editTitleInput').focus();

  const close = () => overlay.remove();
  const save = async () => {
    const t = document.getElementById('editTitleInput').value.trim();
    meeting.title = t || meeting.title;
    meeting.location = document.getElementById('editLocationInput').value.trim();
    meeting.participants = document.getElementById('editParticipantsInput').value.trim();
    await putMeeting(meeting);
    S.meetings = await fetchAllMeetings();
    close();
    render();
  };

  overlay.querySelector('#editModalCancel').addEventListener('click', close);
  overlay.querySelector('#editModalConfirm').addEventListener('click', save);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

// ── Pause / Resume recording ─────────────────────────────────────────────────
function pauseRecording() {
  const rec = S.rec;
  if (!rec.active || rec.paused) return;
  if (rec.mediaRecorder?.state === 'recording') {
    rec.mediaRecorder.pause();
  }
  clearInterval(rec.timer);
  clearInterval(rec.chunkTimer);
  rec.timer = null;
  rec.chunkTimer = null;
  rec.paused = true;
  render();
}

function resumeRecording() {
  const rec = S.rec;
  if (!rec.active || !rec.paused) return;
  if (rec.mediaRecorder?.state === 'paused') {
    rec.mediaRecorder.resume();
  }
  const chunkMs = parseInt(localStorage.getItem('chunkInterval') || '60') * 1000;
  rec.paused = false;
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

// ── MediaRecorder + Gemini Audio ─────────────────────────────────────────────
let processingQueue = Promise.resolve();

// Audio processing chain: Gain → [Highpass] → [Lowpass] → [Compressor] → dest
function buildAudioChain(audioCtx, source) {
  const nodes = [];

  const gain = audioCtx.createGain();
  gain.gain.value = parseFloat(localStorage.getItem('micGain') || '3');
  nodes.push(gain);

  const preset = localStorage.getItem('filterPreset') || 'off';
  if (preset !== 'off') {
    let hp, lp;
    if      (preset === 'standard')   { hp = 100; lp = 8000; }
    else if (preset === 'conference') { hp = 200; lp = 6000; }
    else if (preset === 'phone')      { hp = 300; lp = 3400; }
    else {
      hp = parseFloat(localStorage.getItem('highpassFreq') || '100');
      lp = parseFloat(localStorage.getItem('lowpassFreq') || '8000');
    }
    const hpf = audioCtx.createBiquadFilter();
    hpf.type = 'highpass'; hpf.frequency.value = hp; hpf.Q.value = 0.7;
    nodes.push(hpf);
    const lpf = audioCtx.createBiquadFilter();
    lpf.type = 'lowpass'; lpf.frequency.value = lp; lpf.Q.value = 0.7;
    nodes.push(lpf);
  }

  if (localStorage.getItem('compressor') === 'true') {
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -24; comp.knee.value = 30;
    comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.25;
    nodes.push(comp);
  }

  source.connect(nodes[0]);
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  const dest = audioCtx.createMediaStreamDestination();
  nodes[nodes.length - 1].connect(dest);
  return dest;
}

function getSupportedMimeType() {
  return ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function transcribeAudio(base64, mimeType) {
  const apiKey = localStorage.getItem('geminiApiKey');
  if (!apiKey) throw new Error('APIキーが設定されていません');
  const model = localStorage.getItem('geminiModel') || 'gemini-2.5-flash';
  const lang = localStorage.getItem('speechLang') || 'ja-JP';
  const langName = { 'ja-JP':'日本語','en-US':'英語','en-GB':'英語','zh-CN':'中国語','ko-KR':'韓国語' }[lang] || '日本語';
  const diarize = localStorage.getItem('speakerDiarization') === 'true';
  const ctx = S.rec.segments.slice(-2).join('').slice(-400);

  // ※ 辞書ヒントはプロンプトに含めない（音声が無音・希薄な場合にGeminiが辞書語を幻覚するバグを防ぐ）
  // 辞書適用は後処理（applyWordDict）のみで行う
  let prompt;
  if (diarize) {
    prompt = `この音声を${langName}で、話者ごとにラベルを付けて文字起こしして。
各発言の先頭に「話者A:」「話者B:」のようにラベルを付けること。
${ctx
  ? `直前の文脈（ここに登場した話者ラベルを必ず引き継いで一貫性を保つこと）:\n「…${ctx}」`
  : '初めて登場する話者から順に話者A・話者B・話者Cと割り当てること。'}
話し言葉そのままで、句読点を適切に追加。
音声が無音または聞き取れない場合は空文字のみを返すこと。
文字起こしテキストのみ出力すること。`;
  } else {
    prompt = `この音声を${langName}で正確に文字起こしして。${ctx ? `直前の文脈:「…${ctx}」` : ''}
話し言葉そのままで、句読点を適切に追加。複数話者もそのまま書き起こす。
音声が無音または聞き取れない場合は空文字のみを返すこと。
文字起こしテキストのみ出力すること。`;
  }

  if (!base64 || base64.length < 100) throw new Error('base64 データが空です');
  console.log(`[transcribe] mime=${mimeType} base64len=${base64.length}`);

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
  // タイムスタンプ：チャンク処理時点の経過時間
  const chunkElapsed = rec.elapsed;
  const chunkTs = fmtElapsed(chunkElapsed);
  rec.chunkStartTime = Date.now();

  const rawMime = rec.mediaRecorder?.mimeType || 'audio/webm';
  let mimeType = rawMime.split(';')[0].trim();
  const geminiAudioTypes = ['audio/webm','audio/mp4','audio/mpeg','audio/wav','audio/ogg','audio/aac','audio/flac'];
  if (mimeType.startsWith('video/') || !geminiAudioTypes.includes(mimeType)) {
    mimeType = 'audio/webm';
  }

  const blob = new Blob(chunks, { type: mimeType });
  console.log(`[chunk] size=${blob.size} mime=${mimeType} rawMime=${rawMime}`);
  if (blob.size < 1000) return;

  rec.processing = true;
  updateTranscriptUI();

  processingQueue = processingQueue.then(async () => {
    try {
      const base64 = await blobToBase64(blob);
      let text = await transcribeAudio(base64, mimeType);
      // 単語辞書の後処理適用
      text = applyWordDict(text);
      if (text) {
        rec.segments.push(text);
        rec.rawSegments.push({ text, ts: chunkTs, elapsed: chunkElapsed });
        autoSave();
      }
    } catch (e) {
      console.error('Transcription error:', e);
    } finally {
      rec.processing = false;
      updateTranscriptUI();
    }
  });
}

async function startRecording(resuming = false) {
  if (!localStorage.getItem('geminiApiKey')) {
    alert('先に設定画面でGemini APIキーを設定してください。');
    return;
  }
  let stream;
  try {
    const audioConstraints = [
      { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      { echoCancellation: true,  noiseSuppression: false, autoGainControl: true },
      true
    ];
    for (const constraint of audioConstraints) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraint });
        break;
      } catch (e) {
        if (e.name === 'NotAllowedError') throw e;
        if (constraint === true) throw e;
      }
    }
  } catch (e) {
    alert(e.name === 'NotAllowedError'
      ? 'マイクへのアクセスが拒否されました。ブラウザの設定を確認してください。'
      : `マイクエラー: ${e.message}`);
    return;
  }

  const rec = S.rec;
  rec.active = true;
  rec.paused = false;
  rec.stream = stream;
  rec.audioBuffer = [];
  rec.chunkStartTime = Date.now();

  if (resuming) {
    // 前回の経過時間を引き継ぐ
    rec.elapsed = rec.elapsedBase;
  } else {
    rec.elapsed = 0;
    rec.elapsedBase = 0;
    rec.segments = [];
    rec.rawSegments = [];
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let recordingStream = stream;
  if (AudioCtx) {
    try {
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const dest = buildAudioChain(audioCtx, source);
      rec.audioContext = audioCtx;
      recordingStream = dest.stream;
    } catch (e) {
      console.warn('Audio chain setup failed, using raw stream:', e);
    }
  }

  const mimeType = getSupportedMimeType();
  const mrOptions = mimeType
    ? { mimeType, audioBitsPerSecond: 128000 }
    : { audioBitsPerSecond: 128000 };
  const mr = new MediaRecorder(recordingStream, mrOptions);
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
  rec.paused = false;
  // 次の「録音を続ける」のために経過時間を保存
  rec.elapsedBase = rec.elapsed;
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
    if (rec.audioContext) { rec.audioContext.close().catch(() => {}); rec.audioContext = null; }
    await processChunk();
    await processingQueue;
    if (S.currentMeeting) {
      S.currentMeeting.endTime = new Date().toISOString();
      S.currentMeeting.transcript = [...rec.segments];
      S.currentMeeting.rawSegments = [...rec.rawSegments];
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
  const chunkSec = parseInt(localStorage.getItem('chunkInterval') || '60');
  container.innerHTML =
    rec.rawSegments.map(s => `
      <div class="segment-block">
        <span class="ts-badge">${esc(s.ts)}</span>
        ${esc(s.text)}
      </div>`).join('') +
    (rec.processing ? '<div class="processing-indicator">⏳ Gemini で文字起こし処理中…</div>' : '') +
    (!rec.rawSegments.length && !rec.processing ? `<div class="transcript-empty">録音を開始すると ${chunkSec} 秒ごとに文字起こし結果が表示されます</div>` : '');
  container.scrollTop = container.scrollHeight;
  const wc = document.getElementById('wordCountDisplay');
  if (wc) wc.textContent = `${rec.segments.join('').length} 文字`;
}

async function autoSave() {
  if (!S.currentMeeting) return;
  S.currentMeeting.transcript = [...S.rec.segments];
  S.currentMeeting.rawSegments = [...S.rec.rawSegments];
  await putMeeting(S.currentMeeting).catch(() => {});
}

// ── Speaker name assignment modal ─────────────────────────────────────────────
function openSpeakerNamesModal(meeting) {
  const allText = [...(meeting.transcript || []), ...(meeting.rawSegments || []).map(s => s.text)].join('\n');
  const textLabels = (allText.match(/話者([A-Z])/g) || []).map(m => m.replace('話者', ''));
  const savedLabels = Object.keys(meeting.speakerNames || {});
  const labels = [...new Set([...textLabels, ...savedLabels])].sort();
  if (!labels.length) { toast('話者ラベルが見つかりませんでした'); return; }

  const savedNames = meeting.speakerNames || {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-heading">話者名を設定</div>
      <div class="settings-hint">話者ラベルに人名を割り当てます。文字起こし・議事録の両方に適用されます。</div>
      <div id="speakerRows">
        ${labels.map(l => `
          <div class="speaker-row">
            <span class="speaker-label-badge">話者${l}</span>
            <input class="input" data-label="${l}" placeholder="例: 山田" value="${esc(savedNames[l] || '')}">
          </div>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="speakerCancel">キャンセル</button>
        <button class="btn btn-primary" id="speakerApply">適用</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#speakerCancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#speakerApply').addEventListener('click', async () => {
    const names = {};
    overlay.querySelectorAll('input[data-label]').forEach(inp => {
      const v = inp.value.trim();
      if (v) names[inp.dataset.label] = v;
    });
    meeting.speakerNames = names;
    // テキスト内の「話者X:」を「名前:」に置換
    function replaceSpeakers(text) {
      return text.replace(/話者([A-Z]):/g, (_, l) => names[l] ? `${names[l]}:` : `話者${l}:`);
    }
    meeting.transcript = (meeting.transcript || []).map(replaceSpeakers);
    meeting.rawSegments = (meeting.rawSegments || []).map(s => ({ ...s, text: replaceSpeakers(s.text) }));
    if (meeting.minutes) meeting.minutes = replaceSpeakers(meeting.minutes);
    await putMeeting(meeting);
    S.meetings = await fetchAllMeetings();
    close();
    toast('話者名を適用しました');
    render();
  });
}

// ── Generate with mode modal ──────────────────────────────────────────────────
function generateWithModeModal(meeting) {
  const curMode = getMode();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-heading">議事録を生成</div>
      <div class="mode-options">
        ${MODES.map(m => `
          <label class="mode-option">
            <input type="radio" name="genMode" value="${m.id}"${m.id===curMode?' checked':''}>
            <div class="mode-option-body">
              <strong>${m.label}</strong>
              <span>${m.id==='standard'?'サマリ＋アクション＋トピック別要点':m.id==='simple'?'サマリのみ（詳しめ）':'サマリ＋アクション＋決定事項'}</span>
            </div>
          </label>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="genModalCancel">キャンセル</button>
        <button class="btn btn-primary" id="genModalConfirm">📝&ensp;生成する</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  const go = () => {
    const sel = overlay.querySelector('input[name="genMode"]:checked');
    if (sel) localStorage.setItem('minutesMode', sel.value);
    close();
    doGenerate(meeting);
  };

  overlay.querySelector('#genModalCancel').addEventListener('click', close);
  overlay.querySelector('#genModalConfirm').addEventListener('click', go);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

// ── Preamble stripper ────────────────────────────────────────────────────────
function removePreamble(text) {
  // Gemini がたまに「承知いたしました。…」などの前置きを付けることがある。
  // 最初の【 または ■ より前にある行が 5 行以下なら前置きとみなして除去する。
  const idx = text.search(/^[【■]/m);
  if (idx <= 0) return text;
  const before = text.slice(0, idx);
  const lineCount = before.split('\n').filter(l => l.trim()).length;
  return lineCount <= 5 ? text.slice(idx) : text;
}

// ── Speaker label colorizer ───────────────────────────────────────────────────
// escapedHtml: already-HTML-escaped string (話者X: は &lt; などを含まない想定)
// speakerNames: { A: '山田', B: '鈴木', … }
function wrapSpeakers(escapedHtml, speakerNames) {
  // 「話者X:」パターンをラップ
  let result = escapedHtml.replace(/話者([A-Z]):/g,
    (_, l) => `<span class="speaker-tag">話者${l}:</span>`);
  // 割り当て済みの人名もラップ（「山田:」など）
  if (speakerNames) {
    for (const name of Object.values(speakerNames)) {
      if (!name) continue;
      // 行頭近くにある「名前:」だけを対象にする（本文中の固有名詞は触らない）
      const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`(?<![\\w\\u3041-\\u9FFF])${safe}:`, 'g'),
        `<span class="speaker-tag">${name}:</span>`);
    }
  }
  return result;
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
    let text = transcript.length > 80000
      ? await generateChunked(transcript, meeting, apiKey)
      : await callGemini(buildPrompt(meeting, transcript), apiKey);

    text = removePreamble(text);
    // 日時が切れた場合に正しい値で上書き
    text = text.replace(/【日時】[^\n]*/m, `【日時】${fmtDateTime(meeting.startTime, meeting.endTime)}`);

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
  const locationLine = meeting.location ? `\n場所: ${meeting.location}` : '';
  const participantsLine = meeting.participants ? `\n参加者: ${meeting.participants}` : '';
  const headerLines =
    `【会議名】${meeting.title}\n【日時】${dt}` +
    (meeting.location ? `\n【場所】${meeting.location}` : '') +
    (meeting.participants ? `\n【参加者】${meeting.participants}` : '');
  const mode = getMode();

  const info = `あなたは優秀な秘書です。以下の会議の文字起こしをもとに、議事録を作成してください。

【会議情報】
会議名: ${meeting.title}
日時: ${dt}${dur ? ` (${dur})` : ''}${locationLine}${participantsLine}

【文字起こし】
${transcript}`;

  if (mode === 'simple') {
    return `${info}

【出力形式】
${headerLines}

■ サマリ
（会議全体の要約を5〜8文で詳しく記述。重要な決定事項・数値・固有名詞を必ず含める）

文字起こしの内容を忠実に反映し、推測は行わないでください。`;
  }

  if (mode === 'action') {
    return `${info}

【出力形式】
${headerLines}

■ サマリ
（会議全体の要約を2〜3文で簡潔に）

■ アクションアイテム
・（アクション内容） → 担当：（担当者名、不明の場合は「不明」） / 期限：（期日、不明の場合は「不明」）
（複数ある場合は行を分けて列挙。なければ「なし」）

■ 決定事項
・（決定した内容を箇条書き。なければ「なし」）

文字起こしの内容を忠実に反映し、推測は行わないでください。担当者名・期限は明示された情報のみ使用してください。`;
  }

  // standard (default)
  return `${info}

【出力形式】以下の形式で正確に出力してください（形式を変えないこと）：

${headerLines}

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

async function callGemini(prompt, apiKey, retries = 3) {
  const model = localStorage.getItem('geminiModel') || 'gemini-2.5-flash';
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
    const msg = err.error?.message || `API エラー (HTTP ${res.status})`;
    // 503/429 (高負荷・レート制限) は自動リトライ
    if (retries > 0 && (res.status === 503 || res.status === 429)) {
      const wait = res.status === 429 ? 5000 : 3000;
      console.warn(`[callGemini] ${res.status} — ${wait}ms 後にリトライ (残り${retries}回)`);
      const preview = document.getElementById('streamPreview');
      if (preview) preview.textContent = `⏳ サーバー混雑中。${wait/1000}秒後に自動リトライ…`;
      await new Promise(r => setTimeout(r, wait));
      return callGemini(prompt, apiKey, retries - 1);
    }
    throw new Error(msg);
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
      const trimmed = line.trimEnd();
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
