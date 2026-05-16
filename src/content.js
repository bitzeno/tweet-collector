(function () {
  const STORAGE_TWEETS = 'tc_tweets';
  const STORAGE_SETTINGS = 'tc_settings';

  const DEFAULT_PATTERN = '\\$[A-Z]{1,5}\\b';
  let settings = { enabled: false, pattern: DEFAULT_PATTERN, flags: '' };
  let regex = null;
  let saveTimer = null;
  const collected = {};
  let collectedLoaded = false;

  function compileRegex() {
    if (!settings.pattern) { regex = null; return; }
    try {
      regex = new RegExp(settings.pattern, settings.flags || '');
    } catch (e) {
      regex = null;
    }
  }

  async function loadState() {
    const data = await chrome.storage.local.get([STORAGE_SETTINGS, STORAGE_TWEETS]);
    if (data[STORAGE_SETTINGS]) settings = { ...settings, ...data[STORAGE_SETTINGS] };
    if (data[STORAGE_TWEETS]) Object.assign(collected, data[STORAGE_TWEETS]);
    collectedLoaded = true;
    compileRegex();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_SETTINGS] && changes[STORAGE_SETTINGS].newValue) {
      settings = { ...settings, ...changes[STORAGE_SETTINGS].newValue };
      compileRegex();
    }
    if (changes[STORAGE_TWEETS]) {
      const nv = changes[STORAGE_TWEETS].newValue || {};
      // Reflect external clears so we don't think we already saw something.
      for (const k of Object.keys(collected)) {
        if (!(k in nv)) delete collected[k];
      }
      for (const k of Object.keys(nv)) {
        if (!(k in collected)) collected[k] = nv[k];
      }
    }
  });

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      chrome.storage.local.set({ [STORAGE_TWEETS]: collected });
    }, 400);
  }

  function extractText(el) {
    let result = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'IMG' && node.alt) {
          result += node.alt;
        } else if (node.tagName === 'BR') {
          result += '\n';
        } else {
          result += extractText(node);
        }
      }
    }
    return result;
  }

  function parseUserName(userNameEl) {
    const text = (userNameEl.innerText || userNameEl.textContent || '').trim();
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    const displayName = lines[0] || '';
    const handle = lines.find(l => l.startsWith('@')) || '';
    return { displayName, handle };
  }

  function isInsideQuoteCard(node, root) {
    let p = node.parentElement;
    while (p && p !== root) {
      if (p.getAttribute('role') === 'link' && p.getAttribute('tabindex') === '0') return p;
      p = p.parentElement;
    }
    return null;
  }

  function findQuoted(article, mainUserNameEl) {
    const candidates = article.querySelectorAll('div[role="link"][tabindex="0"]');
    for (const q of candidates) {
      const qUser = q.querySelector('[data-testid="User-Name"]');
      if (!qUser || qUser === mainUserNameEl) continue;
      if (q.contains(mainUserNameEl)) continue;
      const qTextEl = q.querySelector('[data-testid="tweetText"]');
      const qTime = q.querySelector('time');
      const { displayName, handle } = parseUserName(qUser);
      return {
        displayName,
        handle,
        text: qTextEl ? extractText(qTextEl) : '',
        datetime: qTime ? qTime.getAttribute('datetime') : null
      };
    }
    return null;
  }

  function findReplyContext(article) {
    // Looks for a "Replying to ..." block X renders above the tweet text.
    const candidates = article.querySelectorAll('div');
    for (const d of candidates) {
      const t = (d.innerText || '').trim();
      if (!t.startsWith('Replying to ')) continue;
      const handles = [];
      d.querySelectorAll('a').forEach(a => {
        const h = a.textContent.trim();
        if (h.startsWith('@') && !handles.includes(h)) handles.push(h);
      });
      if (handles.length) return handles;
      const m = t.match(/@\S+/g);
      return m || null;
    }
    return null;
  }

  function getConversationContext() {
    const m = location.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (m) return { user: m[1], id: m[2], url: location.origin + '/' + m[1] + '/status/' + m[2] };
    return null;
  }

  function findMainTweetTextEl(article) {
    const all = article.querySelectorAll('[data-testid="tweetText"]');
    for (const t of all) {
      if (!isInsideQuoteCard(t, article)) return t;
    }
    return null;
  }

  function parseArticle(article) {
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    const timeEl = article.querySelector('time');
    if (!userNameEl || !timeEl) return null;

    const timeLink = timeEl.closest('a');
    const href = timeLink ? timeLink.getAttribute('href') : null;
    const idMatch = href ? href.match(/\/status\/(\d+)/) : null;
    if (!idMatch) return null;
    const tweetId = idMatch[1];

    const mainTextEl = findMainTweetTextEl(article);
    const text = mainTextEl ? extractText(mainTextEl) : '';
    const { displayName, handle } = parseUserName(userNameEl);
    const datetime = timeEl.getAttribute('datetime');
    let url = null;
    try { url = href ? new URL(href, location.origin).href : null; } catch (_) {}
    const quoted = findQuoted(article, userNameEl);
    const replyingTo = findReplyContext(article);
    const conversation = getConversationContext();

    return {
      tweetId,
      displayName,
      handle,
      text,
      datetime,
      url,
      quoted,
      replyingTo,
      conversation,
      collectedAt: new Date().toISOString()
    };
  }

  function handleArticle(article) {
    if (!settings.enabled || !collectedLoaded) return;
    let data;
    try { data = parseArticle(article); } catch (_) { return; }
    if (!data) return;

    if (collected[data.tweetId]) {
      // Re-seeing a tweet on its thread page lets us learn the conversation it belongs to.
      const existing = collected[data.tweetId];
      if (!existing.conversation && data.conversation) {
        existing.conversation = data.conversation;
        scheduleSave();
      }
      return;
    }

    if (!data.text) return;

    // Regex filter applies to original tweets. For replies in a thread whose root
    // we already care about, accept unconditionally — that thread is in-scope.
    const inActiveThread = !!(data.conversation && collected[data.conversation.id]);
    if (!inActiveThread && regex && !regex.test(data.text)) return;

    collected[data.tweetId] = data;
    scheduleSave();
  }

  const intersectionObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) handleArticle(e.target);
    }
  }, { threshold: 0.25 });

  function scanForTweets(root) {
    (root || document).querySelectorAll('article[data-testid="tweet"]').forEach(a => {
      if (!a.dataset.tcObserved) {
        a.dataset.tcObserved = '1';
        intersectionObserver.observe(a);
      }
    });
  }

  const mutationObserver = new MutationObserver(() => scanForTweets());

  loadState().then(() => {
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    scanForTweets();
  });
})();
