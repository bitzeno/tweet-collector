const STORAGE_TWEETS = 'tc_tweets';
const STORAGE_SETTINGS = 'tc_settings';
const DEFAULT_PATTERN = '\\$[A-Z]{1,5}\\b';
const DEFAULT_FLAGS = '';

const enabledEl = document.getElementById('enabled');
const patternEl = document.getElementById('pattern');
const flagsEl = document.getElementById('flags');
const errorEl = document.getElementById('error');
const countEl = document.getElementById('count');
const previewEl = document.getElementById('preview');
const downloadBtn = document.getElementById('download');
const copyBtn = document.getElementById('copy');
const clearBtn = document.getElementById('clear');
const resetPatternBtn = document.getElementById('reset-pattern');

async function loadAll() {
  const data = await chrome.storage.local.get([STORAGE_SETTINGS, STORAGE_TWEETS]);
  const settings = data[STORAGE_SETTINGS] || { enabled: false, pattern: DEFAULT_PATTERN, flags: DEFAULT_FLAGS };
  enabledEl.checked = !!settings.enabled;
  patternEl.value = settings.pattern || '';
  flagsEl.value = settings.flags || '';
  const tweets = data[STORAGE_TWEETS] || {};
  const md = renderMarkdown(tweets);
  countEl.textContent = Object.keys(tweets).length;
  previewEl.textContent = md || '(no tweets collected yet)';
  validatePattern();
}

function validatePattern() {
  errorEl.textContent = '';
  if (!patternEl.value) return true;
  try {
    new RegExp(patternEl.value, flagsEl.value);
    return true;
  } catch (e) {
    errorEl.textContent = 'Invalid regex: ' + e.message;
    return false;
  }
}

let saveTimer = null;
async function saveSettings() {
  if (!validatePattern()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await chrome.storage.local.set({
      [STORAGE_SETTINGS]: {
        enabled: enabledEl.checked,
        pattern: patternEl.value,
        flags: flagsEl.value
      }
    });
  }, 150);
}

[enabledEl, patternEl, flagsEl].forEach(el => {
  el.addEventListener('change', saveSettings);
  el.addEventListener('input', saveSettings);
});

resetPatternBtn.addEventListener('click', () => {
  patternEl.value = DEFAULT_PATTERN;
  flagsEl.value = DEFAULT_FLAGS;
  validatePattern();
  saveSettings();
});

function renderTweet(t, depth) {
  const indent = '  '.repeat(depth);
  const out = [];
  const handle = t.handle || '';
  const name = t.displayName ? `${t.displayName} ` : '';
  const ts = t.datetime || '';
  out.push(`${indent}- **${name}${handle}** · ${ts}`);
  if (t.replyingTo && t.replyingTo.length) {
    out.push(`${indent}  _Replying to ${t.replyingTo.join(', ')}_`);
  }
  if (t.text) {
    for (const ln of t.text.split('\n')) {
      out.push(`${indent}  ${ln}`);
    }
  }
  if (t.quoted) {
    const q = t.quoted;
    const qHandle = q.handle || '';
    const qName = q.displayName ? `${q.displayName} ` : '';
    const qTs = q.datetime || '';
    out.push('');
    out.push(`${indent}  > **Quoting ${qName}${qHandle}** · ${qTs}`);
    if (q.text) {
      for (const ln of q.text.split('\n')) {
        out.push(`${indent}  > ${ln}`);
      }
    }
  }
  if (t.url && depth === 0) {
    out.push(`${indent}  [view](${t.url})`);
  }
  out.push('');
  return out;
}

function renderMarkdown(tweets) {
  const list = Object.values(tweets);
  if (!list.length) return '';

  // A tweet's thread key is its conversation root id if known, else its own
  // tweetId (it might itself be a root). This pulls a feed-collected root
  // into the same bucket as replies that learned the conversation later.
  const threadKey = (t) => (t.conversation && t.conversation.id) || t.tweetId;

  const buckets = new Map();
  for (const t of list) {
    const k = threadKey(t);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(t);
  }

  const threads = [];
  const standalone = [];
  for (const [id, items] of buckets) {
    const isThread = items.length > 1 || items.some(t => t.conversation && t.conversation.id);
    if (isThread) threads.push({ id, items });
    else standalone.push(...items);
  }

  const earliestCollected = (items) =>
    Math.min(...items.map(t => Date.parse(t.collectedAt) || 0));
  threads.sort((a, b) => earliestCollected(a.items) - earliestCollected(b.items));

  const lines = ['# Collected Tweets', ''];

  for (const { id, items } of threads) {
    items.sort((a, b) => (Date.parse(a.datetime) || 0) - (Date.parse(b.datetime) || 0));
    const root = items.find(t => t.tweetId === id);
    const rootForUrl = root || items.find(t => t.conversation && t.conversation.id === id && t.conversation.url);
    const headingUrl = root && root.url ? root.url
      : (rootForUrl && rootForUrl.conversation && rootForUrl.conversation.url) || `https://x.com/i/status/${id}`;
    lines.push(`## Thread — ${headingUrl}`);
    lines.push('');
    if (root) {
      lines.push(...renderTweet(root, 0));
      for (const t of items) {
        if (t === root) continue;
        lines.push(...renderTweet(t, 1));
      }
    } else {
      // No root collected; just list members at depth 0.
      for (const t of items) lines.push(...renderTweet(t, 0));
    }
    lines.push('');
  }

  if (standalone.length) {
    if (threads.length) {
      lines.push('## Standalone');
      lines.push('');
    }
    standalone.sort((a, b) => (Date.parse(a.datetime) || 0) - (Date.parse(b.datetime) || 0));
    for (const t of standalone) lines.push(...renderTweet(t, 0));
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

downloadBtn.addEventListener('click', async () => {
  const data = await chrome.storage.local.get(STORAGE_TWEETS);
  const md = renderMarkdown(data[STORAGE_TWEETS] || {}) || '# Collected Tweets\n';
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  await chrome.downloads.download({
    url,
    filename: `tweets-${date}.md`,
    saveAs: true
  });
});

copyBtn.addEventListener('click', async () => {
  const data = await chrome.storage.local.get(STORAGE_TWEETS);
  const md = renderMarkdown(data[STORAGE_TWEETS] || {});
  await navigator.clipboard.writeText(md);
  const original = copyBtn.textContent;
  copyBtn.textContent = 'Copied!';
  setTimeout(() => (copyBtn.textContent = original), 1200);
});

clearBtn.addEventListener('click', async () => {
  if (!confirm('Clear all collected tweets?')) return;
  await chrome.storage.local.set({ [STORAGE_TWEETS]: {} });
  loadAll();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_TWEETS]) loadAll();
});

loadAll();
