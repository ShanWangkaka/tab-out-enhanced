/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#ff6b6b',
    '#feca57',
    '#48dbfb',
    '#ff9ff3',
    '#54a0ff',
  ];

  const particleCount = 25;
  const particles = [];
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');
    const size = 4 + Math.random() * 6;
    const color = colors[i % colors.length];
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 120;

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: 50%;
      pointer-events: none;
      z-index: 99999;
      will-change: transform, opacity;
    `;

    particles.push({
      el,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 80,
      gravity: 180,
      startTime: performance.now(),
      duration: 600
    });

    fragment.appendChild(el);
  }

  document.body.appendChild(fragment);

  function animate() {
    const now = performance.now();
    let allDone = true;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const elapsed = (now - p.startTime) / 1000;
      const progress = elapsed / 0.6;

      if (progress >= 1) {
        p.el.remove();
        continue;
      }

      allDone = false;
      const px = p.vx * elapsed;
      const py = p.vy * elapsed + 0.5 * p.gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;

      p.el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;
      p.el.style.opacity = opacity;
    }

    if (!allDone) {
      requestAnimationFrame(animate);
    }
  }

  requestAnimationFrame(animate);
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening" + name
 */
function getGreeting() {
  const hour = new Date().getHours();
  let greeting;
  if (hour < 12) greeting = 'Good morning';
  else if (hour < 17) greeting = 'Good afternoon';
  else greeting = 'Good evening';
  return greeting;
}

/**
 * 每日激励语句
 */
const dailyQuotes = [
  "The wind waits, the flowers bloom, year after year 🌿",
  "Take your time, the best is yet to come 🌙",
  "The mountain is high, the road is long, take it easy 🏔️",
  "A gentle breeze blows, ripples not rising 🍃",
  "Mountains and seas in the heart, boundless peace 🌊",
  "Flowers half-open, wine half-drunk 🌸",
  "Spring has flowers, autumn has moon 🌙",
  "The flowers are blooming, take your time 🌺",
  "Simple joys are the sweetest 🍵",
  "Walk to the water's edge, sit and watch the clouds rise ☁️",
  "Where the heart is, there is the sea 🏝️",
  "Time knows its flavor, years leave their scent ⏳",
  "Slowly, but surely 🐢",
  "Flowers bloom and leaves fall, all are scenery 🍂",
  "Peaceful heart, gentle smile 😊",
  "Half hustle, half serenity 🌟",
  "Life is bright, everything is hopeful 🌈",
  "Time is gentle, everything is possible 🎐",
  "Seasons change, beauty remains 🍁",
  "In the mountains, pine wine, spring tea 🍵",
  "Spring hears birds, summer hears cicadas 🐦",
  "Autumn hears crickets, winter hears snow ❄️",
  "Time is silent, wait for the flowers to bloom 🌼",
  "Clouds in the sky, water in the bottle ☁️",
  "Where the heart rests, that is home 🏡",
  "Same rain, different mountains 🌧️",
  "The same moon shines everywhere 🌕",
  "Starlight asks no one ✨",
  "Time rewards the patient ⭐",
  "Take your time, all is coming 🌻",
  "Slow life, slow living 🍜",
  "Light boat passes ten thousand mountains 🚣",
  "Willows dark, flowers bright, another village 🌸",
  "Life is a journey, I am a traveler 🚶",
  "May you return as a child after sailing 🌅",
  "Though winds blow strong, never give up 💪",
  "Life is calm, but running brings wind 🌬️",
  "Take it easy, no rush 🌱",
  "The world is your oyster 🌍",
  "Bloom where you are planted 🌷",
  "Every cloud has a silver lining ☁️",
  "Keep your face always toward the sunshine 🌻",
  "In the middle of difficulty lies opportunity 🎯",
  "And the day came when the risk to remain tight in a bud was more painful than the risk it took to blossom 🌸",
  "The journey of a thousand miles begins with one step 🚶",
  "Do not go where the path may lead, go instead where there is no path and leave a trail 🌿",
  "Life is what happens when you're busy making other plans ⏳",
  "Get busy living or get busy dying 🌅",
  "Be the change you wish to see in the world 🌍",
  "Darkness cannot drive out darkness, only light can do that ✨",
  "Our greatest weakness lies in giving up 💪",
  "The only way to do great work is to love what you do ❤️",
  "Your time is limited, don't waste it living someone else's life ⏰",
  "Stay hungry, stay foolish 🍎",
  "Simplicity is the ultimate sophistication ✨",
  "The best time to plant a tree was 20 years ago, the second best time is now 🌳",
  "It does not matter how slowly you go as long as you do not stop 🐢",
  "The future belongs to those who believe in the beauty of their dreams 🌟",
  "You only live once, but if you do it right, once is enough 🦋",
  "Life is really simple, but we insist on making it complicated 🧘",
  "In three words I can sum up everything I've learned about life: it goes on 🌊",
  "Be yourself; everyone else is already taken ✨",
  "To live is the rarest thing in the world. Most people exist, that is all 🌟",
  "We are all in the gutter, but some of us are looking at the stars ✨",
  "The only person you are destined to become is the person you decide to be 🎯",
  "Do not dwell in the past, do not dream of the future, concentrate the mind on the present moment 🧘",
  "The present moment is filled with joy and happiness. If you are attentive, you will see it 🌸",
  "Peace comes from within. Do not seek it without ☮️",
  "The mind is everything. What you think you become 🧠",
  "Happiness is not something ready made. It comes from your own actions 😊",
  "Believe you can and you're halfway there 💪",
  "It is during our darkest moments that we must focus to see the light ✨",
  "In order to succeed, we must first believe that we can 🌟",
  "The only limit to our realization of tomorrow will be our doubts of today 🌈",
  "We may encounter many defeats but we must not be defeated 💪",
  "Nothing is impossible, the word itself says 'I'm possible'! ✨",
  "The best revenge is massive success 🎯",
  "Success is not final, failure is not fatal: it is the courage to continue that counts 💪",
  "I have not failed. I've just found 10,000 ways that won't work 🔧",
  "Quality is not an act, it is a habit ✨",
  "Well done is better than well said 🎯",
  "Early to bed and early to rise makes a man healthy, wealthy, and wise 🌅",
  "Lost time is never found again ⏰",
  "Tell me and I forget. Teach me and I remember. Involve me and I learn 📚",
  "An investment in knowledge pays the best interest 🎓",
  "Education is the most powerful weapon which you can use to change the world 🌍",
  "The beautiful thing about learning is that no one can take it away from you 🧠",
  "The more that you read, the more things you will know. The more that you learn, the more places you'll go 📖",
  "A room without books is like a body without a soul 📚",
  "There is no friend as loyal as a book 📖",
  "Reading is to the mind what exercise is to the body 💪",
  "The only journey is the one within 🧘",
  "Wherever you go becomes a part of you somehow 🌍",
  "To travel is to live ✈️",
  "The world is a book and those who do not travel read only one page 📖",
  "Adventure is worthwhile in itself 🗺️",
  "Life is either a daring adventure or nothing at all 🏔️",
  "The purpose of our lives is to be happy 😊",
  "Life is what we make it, always has been, always will be 🌟",
  "You have within you right now, everything you need to deal with whatever the world can throw at you 💪",
  "It's not what happens to you, but how you react to it that matters 🧘",
  "When you change your thoughts, remember to also change your world 🌍",
  "The only way to make sense out of change is to plunge into it, move with it, and join the dance 💃",
  "Change the world by being yourself ✨",
  "Yesterday is history, tomorrow is a mystery, today is a gift of God, which is why we call it the present 🎁",
  "Count your age by friends, not years. Count your life by smiles, not tears 😊",
  "It's not the destination, it's the journey 🚀",
  "Life is like riding a bicycle. To keep your balance you must keep moving 🚲",
  "The greatest glory in living lies not in never falling, but in rising every time we fall 💪",
  "The best and most beautiful things in the world cannot be seen or even touched - they must be felt with the heart ❤️",
  "Keep your face always toward the sunshine - and shadows will fall behind you 🌻",
  "What lies behind us and what lies before us are tiny matters compared to what lies within us 🌟",
  "Life is really simple, but we insist on making it complicated 🧘",
  "Be the change that you wish to see in the world 🌍",
  "In the end, it's not the years in your life that count. It's the life in your years 🌅",
  "The purpose of human life is to serve, and to show compassion and the will to help others ❤️",
  "Love and compassion are necessities, not luxuries. Without them, humanity cannot survive 💖",
  "If you want others to be happy, practice compassion. If you want to be happy, practice compassion ☮️",
  "Kindness in words creates confidence. Kindness in thinking creates profoundness. Kindness in giving creates love ❤️",
  "No act of kindness, no matter how small, is ever wasted 🌸",
  "Wherever there is a human being, there is an opportunity for a kindness 🤗",
  "Tenderness and kindness are not signs of weakness and despair, but manifestations of strength and resolution 💪",
  "A single act of kindness throws out roots in all directions, and the roots spring up and make new trees 🌳",
  "Kindness is the language which the deaf can hear and the blind can see ❤️",
  "Constant kindness can accomplish much. As the sun makes ice melt, kindness makes misunderstanding, mistrust, and hostility evaporate ☀️",
  "That which does not kill us makes us stronger 💪",
  "He who has a why to live can bear almost any how 🎯",
  "There is no greater agony than bearing an untold story inside you 📖",
  "You may encounter many defeats, but you must not be defeated 💪",
  "I can be changed by what happens to me. But I refuse to be reduced by it 🌟",
  "Do the best you can until you know better. Then when you know better, do better 📚",
  "You never really learn much from hearing yourself speak 🗣️",
  "The more I read, the more I acquire, the more certain I am that I know nothing 📖",
  "Real knowledge is to know the extent of one's ignorance 🧠",
  "I know that I know nothing 🧘",
  "Wonder is the beginning of wisdom ✨",
  "Education is the kindling of a flame, not the filling of a vessel 🔥",
  "We are what we repeatedly do. Excellence, then, is not an act, but a habit ✨",
  "It is not sufficient to know, we must also apply; it is not sufficient to will, we must also do 🎯",
  "The happiness of your life depends upon the quality of your thoughts 😊",
  "You have power over your mind - not outside events. Realize this, and you will find strength 💪",
  "The best revenge is to be unlike him who performed the injury 🧘",
  "Waste no more time arguing what a good man should be. Be one ✨",
  "Dwell on the beauty of life. Watch the stars, and see yourself running with them ✨",
  "The universe is change; our life is what our thoughts make it 🌌",
  "The happiness of your life depends upon the quality of your thoughts 😊",
  "Accept the things to which fate binds you, and love the people with whom fate brings you together, but do so with all your heart ❤️",
  "Never let the future disturb you. You will meet it, if you have to, with the same weapons of reason which today arm you against the present 🛡️",
  "Very little is needed to make a happy life; it is all within yourself, in your way of thinking 😊",
  "When you arise in the morning, think of what a precious privilege it is to be alive - to breathe, to think, to enjoy, to love 🌅",
  "Let us cultivate our garden 🌸",
  "Man is condemned to be free 🦅",
  "We are condemned to choose freedom 🌟",
  "Existence precedes essence 🧘",
  "You are what you do, not what you say you'll do 🎯",
  "We are our choices ✨",
  "The only way to deal with an unfree world is to become so absolutely free that your very existence is an act of rebellion 🗽",
  "Freedom is what you do with what's been done to you 🦅",
  "Man is not the creature of circumstances; circumstances are the creatures of men 💪",
  "We are all architects of our own lives 🏗️",
  "The limits of my language mean the limits of my world 🌍",
  "Whereof one cannot speak, thereof one must be silent 🤫",
  "The world is all that is the case 🌌",
  "We see the world not as it is, but as we are 🧘",
  "The eye sees only what the mind is prepared to comprehend 👁️",
  "Reality is merely an illusion, albeit a very persistent one 🌌",
  "The most beautiful thing we can experience is the mysterious ✨",
  "Imagination is more important than knowledge 🧠",
  "Two things are infinite: the universe and human stupidity; and I'm not sure about the universe 🌌",
  "Life is like a box of chocolates. You never know what you're gonna get 🍫",
  "Stupid is as stupid does 🤔",
  "You have to do the best with what God gave you 💪",
  "Mama always said life was like a box of chocolates. You never know what you're gonna get 🍫",
  "Carpe diem. Seize the day, boys. Make your lives extraordinary 🎯",
  "We don't read and write poetry because it's cute. We read and write poetry because we are members of the human race 📖",
  "You are not special. You are not a beautiful or unique snowflake. You are the same decaying organic matter as everything else ❄️",
  "The first rule of Fight Club is: you do not talk about Fight Club 🥊",
  "This is your life, and it's ending one minute at a time ⏰",
  "You are not your khakis. You are not your job. You are not how much money you have in the bank 💵",
  "I love waking up in the morning not knowing what's gonna happen or who I'm gonna meet, where I'm gonna wind up 🚢",
  "I'm the king of the world! 🚢",
  "Keep your friends close, but your enemies closer 🤝",
  "Great power comes with great responsibility 💪",
  "Why so serious? 🃏",
  "All we have to decide is what to do with the time that is given us ⏳",
  "Even the smallest person can change the course of the future 🧝",
  "The road goes ever on and on 🛤️",
  "Not all those who wander are lost 🗺️",
  "All that is gold does not glitter ✨",
  "Even the wisest cannot see all ends 🧙",
  "The greatest adventure is what lies ahead 🏔️",
  "May the Force be with you ✨",
  "Do or do not. There is no try 🎯",
  "Your eyes can deceive you. Don't trust them 👁️",
  "The fear of loss is a path to the dark side 🖤",
  "Train yourself to let go of everything you fear to lose 🧘",
  "In a hole in the ground there lived a hobbit 🏡",
  "There is some good in this world, and it's worth fighting for 💪",
  "So we beat on, boats against the current, borne back ceaselessly into the past ⛵",
  "So many books, so little time 📚",
  "Not all readers are leaders, but all leaders are readers 📖",
  "A reader lives a thousand lives before he dies. The man who never reads lives only one 📚",
  "We read to know we are not alone 📖",
  "A reader lives a thousand lives 🌍",
  "There is no friend as loyal as a book 📚",
  "The person, be it gentleman or lady, who has not pleasure in a good novel, must be intolerably stupid 😊",
  "We read to learn that we are not alone 📖",
  "Reading is essential for those who seek to rise above the ordinary 📚",
  "The more that you read, the more things you will know. The more that you learn, the more places you'll go 📖",
  "You can find magic wherever you look. Sit back and relax, all you need is a book 📚",
  "Once you learn to read, you will be forever free 📖",
  "The man who does not read has no advantage over the man who cannot read 📚",
  "Reading is to the mind what exercise is to the body 💪",
  "A book is a dream that you hold in your hand 📖",
  "There is more treasure in books than in all the pirate's loot on Treasure Island 🏴‍☠️",
  "Books are a uniquely portable magic 📚",
  "A great book should leave you with many experiences, and slightly exhausted at the end 📖",
  "Books are the quietest and most constant of friends; they are the most accessible and wisest of counselors; and the most patient of teachers 📚",
  "I find television very educating. Every time somebody turns on the set, I go into the other room and read a book 📖",
  "The only thing that you absolutely have to know, is the location of the library 📚",
  "Let us read, and let us dance; these two amusements will never do any harm to the world 💃",
  "I have always imagined that Paradise will be a kind of library 📚",
  "If you don't like to read, you haven't found the right book 📖",
  "Books are mirrors: you only see in them what you already have inside you 📚",
  "A book is a version of the world. If you do not like it, ignore it; or offer your own version in return 📖",
  "The world was hers for the reading 📚",
  "We are of opinion that instead of letting books grow moldy behind an iron grating, far from the vulgar gaze, it is better to let them wear out by being read 📖",
  "I cannot live without books 📚",
  "The best way to cheer yourself up is to try to cheer somebody else up 😊",
  "The human race has only one really effective weapon and that is laughter 😂",
  "Laughter is an instant vacation 🏖️",
  "A good laugh heals a lot of hurts 😂",
  "Laughter is the sun that drives winter from the human face ☀️",
  "The most wasted of all days is one without laughter 😂",
  "Laughter is the shortest distance between two people 😊",
  "He who laughs last didn't get the joke 😂",
  "I always keep a supply of stimulant handy in case I see a snake - which I also keep handy 🐍",
  "If you live to be one hundred, you've got it made. Very few people die past that age 🎂",
  "The best way to cheer yourself up is to try to cheer somebody else up 😊",
  "Clothes make the man. Naked people have little or no influence on society 👔",
  "Don't go around saying the world owes you a living. The world owes you nothing. It was here first 🌍",
  "I have never let my schooling interfere with my education 📚",
  "The man who does not read has no advantage over the man who cannot read 📖",
  "It is better to keep your mouth closed and let people think you are a fool than to open it and remove all doubt 🤐",
  "The secret of getting ahead is getting started 🚀",
  "The secret of getting started is breaking your complex overwhelming tasks into small manageable tasks, and then starting on the first one 🎯",
  "Continuous improvement is better than delayed perfection ✨",
  "Do something wonderful, people may imitate it 🎉",
  "I'm not upset that you lied to me, I'm upset that from now on I can't believe you 🤥",
  "I think; therefore I am 🧠",
  "The mind is the cause of all things 🧘",
  "Happiness depends upon ourselves 😊",
  "The happiness of your life depends upon the quality of your thoughts 🧠",
  "The first rule is to keep an untroubled spirit. The second is to look things in the face and know them for what they are 🧘",
  "Waste no more time arguing what a good man should be. Be one ✨",
  "The best revenge is to be unlike him who performed the injury 🧘",
  "You have power over your mind - not outside events. Realize this, and you will find strength 💪",
  "Dwell on the beauty of life. Watch the stars, and see yourself running with them ✨",
  "The universe is change; our life is what our thoughts make it 🌌",
  "Very little is needed to make a happy life; it is all within yourself, in your way of thinking 😊",
  "When you arise in the morning, think of what a precious privilege it is to be alive - to breathe, to think, to enjoy, to love 🌅",
  "Never let the future disturb you. You will meet it, if you have to, with the same weapons of reason which today arm you against the present 🛡️",
  "Accept the things to which fate binds you, and love the people with whom fate brings you together, but do so with all your heart ❤️",
  "The best revenge is to be unlike him who performed the injury 🧘",
  "We are all in the gutter, but some of us are looking at the stars ✨",
  "Be yourself; everyone else is already taken ✨",
  "To live is the rarest thing in the world. Most people exist, that is all 🌟",
  "We are all in the gutter, but some of us are looking at the stars ✨",
  "Always forgive your enemies; nothing annoys them so much 😊",
  "Some cause happiness wherever they go; others whenever they go 😄",
  "I have nothing to declare except my genius ✨",
  "The only way to get rid of a temptation is to yield to it 😈",
  "To love oneself is the beginning of a lifelong romance ❤️",
  "I can resist everything except temptation 😈",
  "We are all in the gutter, but some of us are looking at the stars ✨",
  "Life is too important to be taken seriously 😊",
  "A dream you dream alone is only a dream. A dream you dream together is reality ✨",
  "When the power of love overcomes the love of power the world will know peace ☮️",
  "One love, one heart ❤️",
  "Get up, stand up, stand up for your rights 🎵",
  "Every little thing gonna be alright ✨",
  "Don't worry, about a thing. 'Cause every little thing gonna be alright 🌻",
  "The sun is shining, the weather is sweet ☀️",
  "Three little birds, sat on my window 🐦",
  "Don't gain the world and lose your soul, wisdom is better than silver or gold 💎",
  "Love the life you live. Live the life you love ❤️",
  "You can fool some people sometimes, but you can't fool all the people all the time 😏",
  "No woman, no cry 😢",
  "Redemption song 🎵",
  "I shot the sheriff, but I did not shoot the deputy 🎯",
  "Get up, stand up, don't give up the fight 💪",
  "One good thing about music, when it hits you, you feel no pain 🎵",
  "One love, one heart, let's get together and feel alright ❤️"
];

/**
 * 获取今日激励语句
 */
function getDailyQuote() {
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const quoteIndex = dayOfYear % dailyQuotes.length;
  return dailyQuotes[quoteIndex];
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}

/**
 * 天气图标映射
 */
const weatherIconMap = {
  'Sunny': '☀️',
  'Clear': '☀️',
  'Partly cloudy': '⛅',
  'Cloudy': '☁️',
  'Overcast': '☁️',
  'Rain': '🌧️',
  'Light rain': '🌦️',
  'Heavy rain': '🌧️',
  'Drizzle': '🌦️',
  'Thunderstorm': '⛈️',
  'Snow': '❄️',
  'Light snow': '🌨️',
  'Fog': '🌫️',
  'Mist': '🌫️',
  'Haze': '🌫️'
};

function getWeatherIcon(condition) {
  for (const [key, icon] of Object.entries(weatherIconMap)) {
    if (condition && condition.toLowerCase().includes(key.toLowerCase())) {
      return icon;
    }
  }
  return '🌤️';
}

async function getWeatherInfo() {
  try {
    const response = await fetch('https://wttr.in/?format=j1');
    const data = await response.json();
    
    if (data && data.current_condition && data.current_condition[0]) {
      const current = data.current_condition[0];
      const location = data.nearest_area && data.nearest_area[0];
      
      return {
        icon: getWeatherIcon(current.weatherDesc ? current.weatherDesc[0].value : 'Clear'),
        description: current.weatherDesc ? current.weatherDesc[0].value : 'Clear',
        temp: Math.round(current.temp_C || 22),
        city: location ? (location.areaName ? location.areaName[0].value : '') : ''
      };
    }
  } catch (error) {
    console.warn('Failed to fetch weather:', error);
  }
  
  const now = new Date();
  const seed = now.getDate() + now.getMonth() * 31;
  const icons = ['☀️', '⛅', '☁️', '🌧️', '⛈️'];
  const descs = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Thunderstorm'];
  const index = seed % icons.length;
  
  return {
    icon: icons[index],
    description: descs[index],
    temp: 18 + Math.floor(Math.random() * 10),
    city: ''
  };
}

/**
 * 节日数据
 */
const festivals = {
  '1-1': { name: "New Year's Day", icon: '🎊' },
  '2-14': { name: "Valentine's Day", icon: '💕' },
  '3-8': { name: "International Women's Day", icon: '👩' },
  '3-17': { name: "St. Patrick's Day", icon: '🍀' },
  '4-1': { name: "April Fools' Day", icon: '🎭' },
  '7-4': { name: "Independence Day", icon: '🎆' },
  '10-31': { name: "Halloween", icon: '🎃' },
  '12-25': { name: "Christmas", icon: '🎄' },
  '12-31': { name: "New Year's Eve", icon: '🎉' },
  '5-1': { name: "May Day", icon: '🌸' },
  '6-1': { name: "Children's Day", icon: '🎈' },
  '9-10': { name: "Teachers' Day", icon: '🍎' },
  '11-11': { name: "Singles' Day", icon: '1️⃣' },
  '2-1': { name: "Spring Festival (Estimated)", icon: '🧧' },
  '1-15': { name: "Lantern Festival (Estimated)", icon: '🏮' },
  '5-5': { name: "Dragon Boat Festival (Estimated)", icon: '🐲' },
  '9-21': { name: "Mid-Autumn Festival (Estimated)", icon: '🌕' }
};

function getFestivalInfo() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const key = `${month}-${day}`;
  
  if (festivals[key]) {
    return festivals[key];
  }
  return null;
}

/**
 * 渲染天气和节日
 */
async function renderWeatherFestival() {
  const container = document.getElementById('weatherFestival');
  if (!container) return;
  
  let html = '';
  
  const weather = await getWeatherInfo();
  let weatherText = `${weather.temp}°C · ${weather.description}`;
  if (weather.city) {
    weatherText = `${weather.city} · ${weatherText}`;
  }
  
  html += `
    <div class="weather-item">
      <span class="weather-icon">${weather.icon}</span>
      <span class="weather-text">${weatherText}</span>
    </div>
  `;
  
  const festival = getFestivalInfo();
  if (festival) {
    html += `
      <div class="festival-item">
        <span class="festival-icon">${festival.icon}</span>
        <span class="festival-text">${festival.name}</span>
      </div>
    `;
  }
  
  container.innerHTML = html;
}

/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  const dailyQuoteEl = document.getElementById('dailyQuote');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();
  if (dailyQuoteEl) dailyQuoteEl.textContent = getDailyQuote();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   BOOKMARKS FUNCTIONALITY
   ---------------------------------------------------------------- */
let draggedElement = null;
let bookmarkOrder = [];

async function loadBookmarks() {
  const bookmarksList = document.getElementById('bookmarksList');
  if (!bookmarksList) return;

  try {
    const bookmarkTree = await chrome.bookmarks.getTree();
    const rootNodes = bookmarkTree[0].children || [];
    const seenUrls = new Set();
    let items = [];

    function normalizeUrl(url) {
      try {
        const u = new URL(url);
        // 保留完整URL用于去重，包括查询参数和哈希
        return url.toLowerCase();
      } catch {
        return url.toLowerCase();
      }
    }

    function getFaviconUrl(url) {
      try {
        return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`;
      } catch {
        return '';
      }
    }

    function getItemId(item) {
      if (item.url) {
        return `bookmark-${item.id}`;
      } else {
        return `folder-${item.id}`;
      }
    }

    function renderBookmarkItem(bookmark) {
      const normalizedUrl = normalizeUrl(bookmark.url);
      if (seenUrls.has(normalizedUrl)) {
        return null;
      }
      seenUrls.add(normalizedUrl);
      
      const faviconUrl = getFaviconUrl(bookmark.url);
      const itemId = getItemId(bookmark);
      
      return {
        id: itemId,
        type: 'bookmark',
        data: bookmark,
        html: `
          <a href="${bookmark.url}" class="bookmark-item" draggable="true" data-item-id="${itemId}" title="${bookmark.title || bookmark.url}">
            ${faviconUrl ? `<img src="${faviconUrl}" class="bookmark-favicon" alt="" data-favicon>` : ''}
            <span class="bookmark-title">${bookmark.title || bookmark.url}</span>
          </a>
        `
      };
    }

    function renderFolder(folder, isFirstLevel = false) {
      const children = folder.children || [];
      const directBookmarks = children.filter(c => c.url);
      const subFolders = children.filter(c => !c.url);

      if (directBookmarks.length === 0 && subFolders.length === 0) {
        return null;
      }

      const folderId = getItemId(folder);
      
      let folderContent = '';
      
      // 文件夹内部的书签不去重，让用户看到所有文档
      directBookmarks.forEach(bookmark => {
        const faviconUrl = getFaviconUrl(bookmark.url);
        folderContent += `
          <a href="${bookmark.url}" class="bookmark-item" title="${bookmark.title || bookmark.url}">
            ${faviconUrl ? `<img src="${faviconUrl}" class="bookmark-favicon" alt="" data-favicon>` : ''}
            <span class="bookmark-title">${bookmark.title || bookmark.url}</span>
          </a>
        `;
      });

      subFolders.forEach(subFolder => {
        const subChildren = subFolder.children || [];
        const subBookmarks = subChildren.filter(c => c.url);
        subBookmarks.forEach(bookmark => {
          const faviconUrl = getFaviconUrl(bookmark.url);
          folderContent += `
            <a href="${bookmark.url}" class="bookmark-item" title="${bookmark.title || bookmark.url}">
              ${faviconUrl ? `<img src="${faviconUrl}" class="bookmark-favicon" alt="" data-favicon>` : ''}
              <span class="bookmark-title">${bookmark.title || bookmark.url}</span>
            </a>
          `;
        });
      });

      if (folderContent === '') {
        return null;
      }

      return {
        id: folderId,
        type: 'folder',
        data: folder,
        html: `
          <div class="bookmark-folder" draggable="true" data-item-id="${folderId}" data-folder-id="${folderId}">
            <button class="bookmark-folder-btn" data-toggle-folder="${folderId}">
              <svg class="bookmark-folder-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 9.776h0c0 2.625 1.336 4.47 3.074 5.453a9.09 9.09 0 0 0 4.052 1.021c.953 0 1.867-.138 2.719-.4a4.337 4.337 0 0 0 1.668-1.214c.363-.484.564-1.06.564-1.66v-5.4a1.8 1.8 0 0 0-1.8-1.8h-1.332a2.25 2.25 0 0 1-1.948-1.11l-.305-.52A2.25 2.25 0 0 0 12.384 3h-3.63a4.505 4.505 0 0 0-4.39 3.398 4.104 4.104 0 0 0-.614 2.378v1" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9.75 18 6m0 0 2.25 3.75M18 6v12" />
              </svg>
              <span>${folder.title || 'Bookmarks'}</span>
            </button>
            <div class="bookmark-folder-dropdown" data-dropdown="${folderId}">
              ${folderContent}
            </div>
          </div>
        `
      };
    }

    rootNodes.forEach(rootNode => {
      if (rootNode.children) {
        rootNode.children.forEach(node => {
          if (node.url) {
            const item = renderBookmarkItem(node);
            if (item) items.push(item);
          } else {
            const item = renderFolder(node, true);
            if (item) items.push(item);
          }
        });
      }
    });

    try {
      const saved = localStorage.getItem('bookmarkOrder');
      if (saved) {
        bookmarkOrder = JSON.parse(saved);
        items.sort((a, b) => {
          const indexA = bookmarkOrder.indexOf(a.id);
          const indexB = bookmarkOrder.indexOf(b.id);
          if (indexA === -1 && indexB === -1) return 0;
          if (indexA === -1) return 1;
          if (indexB === -1) return -1;
          return indexA - indexB;
        });
      }
    } catch (e) {
      console.warn('Failed to load bookmark order:', e);
    }

    let html = items.map(item => item.html).join('');
    bookmarksList.innerHTML = html;

    document.querySelectorAll('[data-favicon]').forEach(img => {
      img.addEventListener('error', function() {
        this.style.display = 'none';
      });
    });

    document.querySelectorAll('[data-toggle-folder]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const folderId = btn.dataset.toggleFolder;
        const dropdown = document.querySelector(`[data-dropdown="${folderId}"]`);
        const isOpen = dropdown.classList.contains('open');
        
        document.querySelectorAll('.bookmark-folder-dropdown.open').forEach(d => {
          if (d !== dropdown) {
            d.classList.remove('open');
          }
        });
        document.querySelectorAll('.bookmark-folder-btn.open').forEach(b => {
          if (b !== btn) {
            b.classList.remove('open');
          }
        });

        // 切换打开状态
        dropdown.classList.toggle('open', !isOpen);
        btn.classList.toggle('open', !isOpen);

        // 如果打开了，调整下拉菜单位置以避免超出屏幕
        if (!isOpen) {
          const rect = dropdown.getBoundingClientRect();
          const container = document.querySelector('.container');
          const containerRect = container.getBoundingClientRect();

          // 如果右边超出容器，就右对齐
          if (rect.right > containerRect.right) {
            dropdown.style.left = 'auto';
            dropdown.style.right = '0';
          } else {
            dropdown.style.left = '0';
            dropdown.style.right = 'auto';
          }

          // 检查下面是否超出视口
          if (rect.bottom > window.innerHeight) {
            dropdown.style.top = 'auto';
            dropdown.style.bottom = '100%';
            dropdown.style.marginTop = '0';
            dropdown.style.marginBottom = '2px';
          } else {
            dropdown.style.top = '100%';
            dropdown.style.bottom = 'auto';
            dropdown.style.marginTop = '2px';
            dropdown.style.marginBottom = '0';
          }
        }
      });
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.bookmark-folder')) {
        document.querySelectorAll('.bookmark-folder-dropdown.open').forEach(d => {
          d.classList.remove('open');
        });
        document.querySelectorAll('.bookmark-folder-btn.open').forEach(b => {
          b.classList.remove('open');
        });
      }
    });

    setupDragAndDrop(bookmarksList, items);

  } catch (err) {
    console.warn('[tab-out] Failed to load bookmarks:', err);
  }
}

function setupDragAndDrop(bookmarksList, items) {
  const draggableItems = bookmarksList.querySelectorAll('[draggable="true"]');

  draggableItems.forEach(item => {
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragend', handleDragEnd);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('drop', handleDrop);
    item.addEventListener('dragenter', handleDragEnter);
    item.addEventListener('dragleave', handleDragLeave);
  });
}

function handleDragStart(e) {
  draggedElement = e.target.closest('[draggable="true"]');
  if (!draggedElement) return;
  
  draggedElement.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedElement.dataset.itemId);
}

function handleDragEnd(e) {
  if (draggedElement) {
    draggedElement.classList.remove('dragging');
  }
  document.querySelectorAll('.drag-over').forEach(el => {
    el.classList.remove('drag-over');
  });
  draggedElement = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function handleDragEnter(e) {
  const target = e.target.closest('[draggable="true"]');
  if (target && target !== draggedElement) {
    target.classList.add('drag-over');
  }
}

function handleDragLeave(e) {
  const target = e.target.closest('[draggable="true"]');
  if (target) {
    target.classList.remove('drag-over');
  }
}

function handleDrop(e) {
  e.preventDefault();
  
  const target = e.target.closest('[draggable="true"]');
  if (!target || !draggedElement || target === draggedElement) return;

  const bookmarksList = document.getElementById('bookmarksList');
  const allItems = Array.from(bookmarksList.querySelectorAll('[draggable="true"]'));
  const draggedIndex = allItems.indexOf(draggedElement);
  const targetIndex = allItems.indexOf(target);

  if (draggedIndex < targetIndex) {
    target.parentNode.insertBefore(draggedElement, target.nextSibling);
  } else {
    target.parentNode.insertBefore(draggedElement, target);
  }

  target.classList.remove('drag-over');

  saveBookmarkOrder();
}

function saveBookmarkOrder() {
  const bookmarksList = document.getElementById('bookmarksList');
  const allItems = bookmarksList.querySelectorAll('[draggable="true"]');
  bookmarkOrder = Array.from(allItems).map(item => item.dataset.itemId);
  
  try {
    localStorage.setItem('bookmarkOrder', JSON.stringify(bookmarkOrder));
  } catch (e) {
    console.warn('Failed to save bookmark order:', e);
  }
}

/* ----------------------------------------------------------------
   搜索功能
   ---------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  // Google 搜索
  const searchForm = document.getElementById('searchForm');
  const searchInput = document.getElementById('searchInput');
  
  if (searchForm && searchInput) {
    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const query = searchInput.value.trim();
      if (query) {
        let url;
        if (query.startsWith('http://') || query.startsWith('https://')) {
          url = query;
        } else if (query.includes('.') && !query.includes(' ')) {
          url = 'https://' + query;
        } else {
          url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
        }
        chrome.tabs.create({ url: url });
        searchInput.value = '';
      }
    });
    
    searchInput.focus();
  }
  
  // 百度搜索
  const baiduSearchForm = document.getElementById('baiduSearchForm');
  const baiduSearchInput = document.getElementById('baiduSearchInput');
  
  if (baiduSearchForm && baiduSearchInput) {
    baiduSearchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const query = baiduSearchInput.value.trim();
      if (query) {
        let url;
        if (query.startsWith('http://') || query.startsWith('https://')) {
          url = query;
        } else if (query.includes('.') && !query.includes(' ')) {
          url = 'https://' + query;
        } else {
          url = 'https://www.baidu.com/s?wd=' + encodeURIComponent(query);
        }
        chrome.tabs.create({ url: url });
        baiduSearchInput.value = '';
      }
    });
  }
});

/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
loadBookmarks();
renderWeatherFestival();
