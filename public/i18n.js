/* i18n.js — one language at a time, site-wide.
 *
 * The templates in this project are written bilingually, e.g.
 *     "我的活动 · My Events"       "满员 · Registration full"
 *     "登录 / Log in"              "已签到 · Checked in"
 *
 * Rather than rewriting every template, this module splits each text node on
 * the bilingual separator ("·" / "•" / "/" surrounded by spaces) and then
 * shows ONLY the matching half:
 *   - English  → keep the non-CJK segments
 *   - 中文      → keep the CJK segments
 *
 * Pure-Chinese strings fall back to `PHRASES` (zh → en). Pure-English strings
 * fall back to `REVERSE` (en → zh) so common labels translate both ways.
 * Originals are cached per text node, so switching back and forth is lossless
 * and needs no page reload.
 */
(function () {
  const STORAGE_KEY = 'n1.lang';
  const DEFAULT_LANG = 'en';

  // CJK ideographs only — punctuation and fullwidth symbols must not count as
  // "Chinese content", otherwise labels like "＋ New Event" look translated.
  const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  const CJK_RUN = /[\u4e00-\u9fff\u3400-\u4dbf]+/g;
  // Bilingual separator: middle dot, bullet, full-width bar, or a spaced slash.
  const SEP = /\s+[·•｜|]\s+|\s+\/\s+/;

  // The site is English-only. Ignore any previously saved Chinese preference.
  let lang = DEFAULT_LANG;

  // ── Dictionaries ───────────────────────────────────────
  // Pure-Chinese strings (no English half in the template).
  const PHRASES = {
    '设置名额': 'Set capacity',
    '已报名': 'registered',
    '确定': 'Confirm',
    '取消': 'Cancel',
    '关闭': 'Close',
    '已签到': 'Checked in',
    '未记录': 'Not recorded',
    '进行中': 'Live',
    '活动已满员': 'Event full',
    '满员': 'Full',
    '报名开放': 'Open for registration',
    '有人候补中': 'Some waitlisted',
    '候补位置': 'Waitlist position',
    '有了空位会自动通知你': 'We will notify you when a spot opens',
    '候选期间无需付款': 'No payment is needed while you are on the waitlist',
    '候补期间无需付款': 'No payment is needed while you are on the waitlist',
    '名额已满，请加入候补，有人取消时会自动通知你。':
      'All spots are taken. Join the waitlist and you will be notified automatically if a spot opens.',
    '候补期间无需付款。': 'No payment is needed while you are on the waitlist.',
    '候补转正时发送邮件通知（留空则关闭）：':
      'Email for waitlist promotions (leave blank to disable):',
    '邮件通知': 'Email alerts',
    '邮件通知已开启': 'Email alerts enabled',
    '邮件通知已关闭': 'Email alerts disabled',
    '邮箱格式不正确': 'Invalid email address',
    '请先登录': 'Please log in first',
    '扫码签到需要先登录账号。': 'Please log in to check in.',
    '操作失败': 'Something went wrong',
    '暂时没有可签到或报名的活动。': 'No events available right now.',
    '目前没有正在进行的场地': 'No courts are in play right now',
    '连接实时队列…': 'Connecting to the live queue…',
    '你还没有进入现场队列 — 到场后向管理员报到即可加入。':
      'You are not in the venue queue yet — check in with an organiser when you arrive.',
    '签到二维码': 'Check-in QR code',
    '现场签到二维码': 'On-site check-in QR code',
    '把这个二维码打印出来贴在场地，球员扫码即可自助签到。':
      'Print this QR code and put it up at the venue. Players scan it to check themselves in.',
    '打开手机签到页': 'Open mobile check-in page',
    '打开完整对战板': 'Open full board',
    '查看活动': 'View events',
    '我的比赛': 'My matches',
    '有比赛记录 · 未报名此活动': 'Match records · not registered for this event',
    '第一次参加？查看活动详情：费用、训练+社交、停车与常见问题。':
      'First time? See the event details for fees, training + social, parking and FAQs.',
    '有人取消时，候补第一位会自动转正并收到通知。':
      'If someone cancels, the first person on the waitlist is promoted automatically and notified.',
    '你已加入候补。有人取消时会自动通知你，无需反复刷新。':
      'You are on the waitlist. We will notify you if a spot opens — no need to keep refreshing.',
    '报名成功！别忘了在活动开始前完成付款。':
      'Registration confirmed! Please complete payment before the event.',
    '确定取消报名吗？取消后名额会释放给候补名单。':
      'Cancel your registration? Your spot will be released to the waitlist.',
    '确定离开候补名单吗？': 'Leave the waitlist?',
    '已取消，名额已自动转给候补球员。':
      'Cancelled — the spot has been released to the next person on the waitlist.',
    '已取消报名。': 'Registration cancelled.',
    '已离开候补名单。': 'You have left the waitlist.',
    '名额已满，你已加入候补。有空位会自动通知你。':
      'The event is full — you are on the waitlist. We will notify you when a spot opens.',
    '报名成功！': 'Registration confirmed!',
    '你已经签到过了': 'You are already checked in',
    '签到成功，祝你玩得开心！': 'Checked in — have a great game!',
    '知道': 'Dismiss',
    '知道了': 'Dismiss',
    '中午': 'Noon',
    '天': '',
  };

  // Pure-English strings → Chinese (used only in 中文 mode).
  const REVERSE = {
    'My Events': '我的活动',
    'Upcoming': '可报名',
    'Open for registration': '报名开放',
    'Registration full': '满员',
    'Checked in': '已签到',
    'Not registered': '尚未报名',
    'On waitlist': '候补中',
    'Waitlist position': '候补位置',
    'Waitlist promoted': '候补已转正',
    'Join waitlist': '加入候补',
    'Register now': '立即报名',
    'Cancel registration': '取消报名',
    'Leave waitlist': '离开候补',
    'Registration confirmed': '报名成功',
    'My matches': '我的比赛',
    'All events': '全部活动',
    'Log in': '登录',
    'Admin': '管理员',
    'Dismiss': '知道了',
    'Capacity': '名额',
    'Location': '地点',
    'Live now': '活动进行中',
    'in play': '正在比赛',
    'up next': '准备上场',
    'Not recorded': '未记录',
    'Pay': '付款',
    'Paid': '已付',
    'Unpaid': '未付',
    'Full': '满员',
    'Open': '开放',
    'Social Only': '仅社交',
    'Training + Social': '训练 + 社交',
    // Landing page navigation and headings
    "What's New": '最新动态',
    'About': '关于我们',
    'Waiting List': '等候名单',
    'Play & Train': '训练与玩耍',
    'FAQs': '常见问题',
    'Travel': '交通指南',
    'Entry': '入场指南',
    'Cancellation': '取消政策',
    'Contact': '联系我们',
    'Welcome to N1 Badminton': '欢迎来到 N1 羽球',
    'Login / Register': '登录 / 注册',
    'How it works': '活动说明',
    'Important notes': '重要提示',
    'Price': '费用',
    'FEE': '费用',
    'PAYMENT': '支付',
    'WHAT TO BRING': '携带物品',
    'Travel Instructions': '交通指南',
    'Entry Guide': '入场指南',
    'Cancellation Policy': '取消政策',
    'Disclaimer': '免责声明',
    'Contact Us': '联系我们',
    'About N1 Badminton': '关于 N1 羽球',
    // Login / register page
    'Registration & Training System': '报名与训练系统',
    'Login': '登录',
    'Register': '注册',
    'Username': '用户名',
    'Password': '密码',
    'Username (for login)': '用户名（用于登录）',
    'Display Name (shown on board)': '显示名称（显示在球场板上）',
    'Skill Level': '技术水平',
    'Advanced': '高级',
    'Intermediate': '中级',
    'Novice': '初级',
    'Beginner': '入门',
    'Create Account': '创建账号',
    'Your username': '你的用户名',
    'Choose a username': '选择一个用户名',
    'At least 4 characters': '至少 4 个字符',
    'Your name on the court board': '显示在球场板上的名字',
    // Shared navigation and page chrome
    'Live Board': '实时球板',
    'Matches': '比赛',
    'Logout': '退出登录',
    'Events': '活动',
    'Info': '信息',
    'Admin': '管理员',
    'New Event': '新建活动',
    'All': '全部',
    'Active': '进行中',
    'Finished': '已结束',
    'N1 Admin Dashboard': 'N1 管理后台',
    'N1 My Matches': 'N1 我的比赛',
    'N1 Badminton Social': 'N1 羽毛球社交',
    'Match Days': '比赛天数',
    'Wins': '胜',
    'Losses': '负',
    'Pending': '待定',
    'Filters': '筛选',
    'Clear': '清除',
    'Go to events →': '前往活动 →',
    'Go to dashboard →': '前往管理后台 →',
    'New to N1? Read the event info — fees, Play & Train, parking & FAQs.':
      '第一次来？查看活动详情 — 费用、Play & Train、停车与常见问题。',
    'No events open for registration yet. Check back soon!': '暂时没有开放报名的活动，请稍后再来看看！',
    // Live board
    'Tap to register': '点击报名',
    'How to Play': '玩法说明',
    'Join Queue': '加入排队',
    'Courts': '球场',
    'On Deck': '准备上场',
    'Waiting Queue': '候场队列',
    'Waiting': '候场',
    'No one waiting': '暂无排队',
    'Tap "Join Queue" to start': '点击「加入排队」开始',
    'Enter your name to join': '输入姓名加入',
    'Select your level': '选择你的水平',
    'Play with (optional)': '搭档（可选）',
    'Join': '加入',
    'Assign to Court': '分配到球场',
    'Please log in first': '请先登录',
    'Please log in to check in.': '扫码签到需要先登录账号。',
    'online': '在线',
    'Idle': '空闲',
    'Empty': '空闲',
    'Waiting for players': '等待球员',
    '① Tap "Join Queue"': '① 点击「加入排队」',
    '② Watch for your name in On Deck': '② 留意「准备上场」里的名字',
    '③ Head to your court': '③ 前往你的球场',
    '⏳ Next': '⏳ 下一位',
    'Training Area': '训练区',
    'No players': '暂无球员',
    'Cancel': '取消',
    'Confirm': '确认',
    'Pick Players': '选择球员',
    'Pair Players': '配对球员',
    'Pair': '配对',
    'Scan to Join': '扫码加入',
    '🔒 LOCK pair — stay together all session': '🔒 固定搭档 — 全程一起',
    'Close': '关闭',
    'Change Level': '修改水平',
    'Session Stats': '本场统计',
    'Games CSV': '比赛记录 CSV',
    'Players CSV': '球员 CSV',
    'End Game': '结束比赛',
    'Record the score (optional), then re-queue players': '记录比分（可选），然后重新排队',
    'End & Re-queue': '结束并重新排队',
    'Clear all data?': '清除所有数据？',
    'This removes everyone from the waitlist, On Deck and all courts, clears game history, and resets courts to 6–10. This cannot be undone.':
      '这将移除候场、准备上场及所有球场上的球员，清空比赛记录，并将球场恢复为 6–10 号。此操作无法撤销。',
    'Clear everything': '全部清除',
  };

  // Notification / server-generated patterns (English ⇄ Chinese).
  const PATTERNS = [
    {
      re: /^Waitlist promoted(?:\s*:\s*(.+))?$/i,
      zh: m => m[1] ? `候补转正：${m[1]}` : '候补已转正',
      en: m => m[1] ? `Waitlist promoted: ${m[1]}` : 'Waitlist promoted',
    },
    // Dynamic page chrome
    { re: /^Hi, (.+) \((.+)\)$/, zh: m => `你好，${m[1]}（${m[2]}）` },
    { re: /^Hi (.+)$/, zh: m => `你好，${m[1]}` },
    { re: /^Already logged in as (.+)\.$/, zh: m => `已登录：${m[1]}` },
    { re: /^👥\s*(\d+)\s+(?:players\s+)?online$/i, zh: m => `👥 ${m[1]} 人在线` },
    { re: /^Court (\d+)$/, zh: m => `第 ${m[1]} 号球场` },
    { re: /^On Deck (\d+)$/i, zh: m => `第 ${m[1]} 组准备上场` },
    { re: /^○\s*(\d+)\s*Idle$/, zh: m => `○ ${m[1]} 空闲` },
  ];

  const norm = s => s
    .replace(/[\u2100-\u214f]/g, '')     // letterlike symbols (ℹ ™ etc.)
    .replace(/[^\p{L}\p{N}]/gu, '');
  const PHRASE_INDEX = {};
  Object.keys(PHRASES).forEach(k => { PHRASE_INDEX[norm(k)] = PHRASES[k]; });
  const REVERSE_INDEX = {};
  Object.keys(REVERSE).forEach(k => { REVERSE_INDEX[norm(k)] = REVERSE[k]; });

  // ── Translation core ───────────────────────────────────
  function pickSegments(text, want) {
    const parts = text.split(SEP);
    if (parts.length < 2) return null;
    const keep = parts.filter(p => {
      const hasCjk = CJK.test(p);
      return want === 'zh' ? hasCjk : !hasCjk;
    });
    if (!keep.length) return null;
    return keep.join(' · ').trim();
  }

  function translateString(s) {
    const trimmed = s.trim();
    if (!trimmed) return s;

    // 1) Bilingual template text — keep only the requested half.
    const half = pickSegments(trimmed, lang);
    if (half) return s.replace(trimmed, half);

    const hasCjk = CJK.test(trimmed);

    if (lang === 'en') {
      // Not enough to split → dictionary lookup (handles emoji prefixes too).
      if (hasCjk) {
        const hit = PHRASES[trimmed] ?? PHRASE_INDEX[norm(trimmed)];
        if (hit !== undefined) {
          const prefix = trimmed.match(/^[^\p{L}]*/u)?.[0] ?? '';
          return s.replace(trimmed, (prefix + hit).trim());
        }
        // Keep unknown copy intact. Removing untranslated text silently loses
        // information and often leaves labels empty in English mode.
        return s;
      }
      return s; // already English
    }

    // lang === 'zh'
    for (const p of PATTERNS) {
      const m = trimmed.match(p.re);
      if (m) return s.replace(trimmed, p.zh(m));
    }
    if (!hasCjk) {
      const hit = REVERSE[trimmed] ?? REVERSE_INDEX[norm(trimmed)];
      if (hit !== undefined) {
        const prefix = trimmed.match(/^[^\p{L}]*/u)?.[0] ?? '';
        return s.replace(trimmed, (prefix + hit).trim());
      }
    }
    return s; // Chinese already, or no translation available
  }

  // ── Language-specific blocks ───────────────────────────
  // The landing page pairs an English block with a Chinese one marked `.zh`.
  // Hide the Chinese block in EN mode, and hide its English counterpart in 中文
  // mode. The English sibling is tagged `.n1-en` at runtime (no template edits).
  const STYLE_ID = 'n1-i18n-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html[lang="en"] .zh { display: none !important; }
      html[lang="en"] .n1-zh { display: none !important; }
      html[lang="zh-CN"] .n1-en { display: none !important; }
    `;
    document.head.appendChild(style);
  }

  // Wrap a raw English text node so it can be hidden in 中文 mode.
  function wrapEnglishText(node) {
    const text = node.nodeValue.trim();
    if (!text || CJK.test(text) || !/[A-Za-z]/.test(text)) return;
    if (node.parentElement && node.parentElement.classList.contains('n1-en')) return;
    const wrap = document.createElement('span');
    wrap.className = 'n1-en';
    node.parentNode.insertBefore(wrap, node);
    wrap.appendChild(node);
  }

  function tagLanguageBlocks(root) {
    const scope = root || document.body;
    scope.querySelectorAll('.zh').forEach(zh => {
      const parent = zh.parentElement;
      if (!parent) return;
      Array.from(parent.childNodes).forEach(n => {
        if (n.nodeType === 3) { wrapEnglishText(n); return; }
        if (n.nodeType !== 1 || n === zh || n.classList.contains('zh')) return;
        // Hide the English mirror of this Chinese block: any sibling that
        // carries no Chinese text at all (the translation lives in `.zh`).
        const own = Array.from(n.childNodes)
          .filter(c => c.nodeType === 3).map(c => c.nodeValue).join(' ');
        if (!CJK.test(own)) n.classList.add('n1-en');
      });
    });
  }

  // Inline labels that exist only in Chinese (e.g. "| 最新动态" next to a
  // section title). Hide them in English mode and hide the English heading
  // text beside them in 中文 mode.
  function tagChineseOnlyLeaf(el) {
    // The language selector must remain bilingual and clickable in either
    // mode; never classify its Chinese button as page copy to hide.
    if (el.closest && el.closest('#lang-switch')) return;
    if (el.classList.contains('zh') || el.classList.contains('n1-zh')) return;
    if (el.children.length) return;
    const direct = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.nodeValue)
      .join('')
      .trim();
    if (!direct || !CJK.test(direct)) return;
    // Section titles use "<English> | <中文>"; the Chinese side may contain
    // latin letters (e.g. "关于 N1 羽球"), so treat a leading bar as the marker.
    const isSecondaryLabel = /^[|｜]/.test(direct);
    if (!isSecondaryLabel) {
      if (/[A-Za-z]/.test(direct)) return;           // English half present
      if (translateString(direct) !== direct) return; // has a dictionary entry
    }
    el.classList.add('n1-zh');
    const parent = el.parentElement;
    if (parent) {
      Array.from(parent.childNodes).forEach(n => {
        if (n.nodeType === 3) wrapEnglishText(n);
      });
    }
  }

  // ── DOM plumbing ───────────────────────────────────────
  const textOriginals = new WeakMap(); // Text node -> original string
  const attrOriginals = new WeakMap(); // Element -> { attr: original }
  const ATTRS = ['placeholder', 'title', 'aria-label'];

  function processTextNode(node) {
    if (!textOriginals.has(node)) textOriginals.set(node, node.nodeValue);
    const original = textOriginals.get(node);
    node.nodeValue = original === null ? '' : translateString(original);
  }

  function processAttributes(el) {
    if (!attrOriginals.has(el)) {
      const map = {};
      ATTRS.forEach(a => { if (el.hasAttribute(a)) map[a] = el.getAttribute(a); });
      attrOriginals.set(el, map);
    }
    const map = attrOriginals.get(el);
    Object.keys(map).forEach(a => el.setAttribute(a, translateString(map[a])));
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) { processTextNode(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (root.tagName === 'SCRIPT' || root.tagName === 'STYLE') return;
      processAttributes(root);
      if (lang === 'en') tagChineseOnlyLeaf(root);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === Node.TEXT_NODE) processTextNode(n);
      else if (n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE') {
        processAttributes(n);
        if (lang === 'en') tagChineseOnlyLeaf(n);
      }
    }
  }

  function refreshLanguageBlocks(root) {
    const scope = root || document.body;
    scope.querySelectorAll('.n1-en, .n1-zh').forEach(el => {
      el.classList.remove('n1-en', 'n1-zh');
    });
    tagLanguageBlocks(scope);
    if (lang === 'en') {
      if (scope.nodeType === Node.ELEMENT_NODE) tagChineseOnlyLeaf(scope);
      scope.querySelectorAll('*').forEach(tagChineseOnlyLeaf);
    }
  }

  // Translate JS-rendered content as it appears.
  let observer = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'childList') m.addedNodes.forEach(n => { walk(n); refreshLanguageBlocks(n); });
        else if (m.type === 'characterData' && m.target.nodeType === Node.TEXT_NODE) {
          const cached = textOriginals.get(m.target);
          if (cached !== undefined && m.target.nodeValue === translateString(cached)) continue;
          textOriginals.delete(m.target);
          processTextNode(m.target);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ── Page titles ────────────────────────────────────────
  // <title> lives in <head>, which the body walker never touches, so map it
  // explicitly per route: [English, 中文].
  const TITLES = {
    '/': ['N1 Badminton — Event Info', 'N1 Badminton — 活动详情'],
    '/login': ['N1 Badminton — Login', 'N1 Badminton — 登录'],
    '/events': ['N1 Badminton — Events', 'N1 Badminton — 活动'],
    '/dashboard': ['N1 Badminton — Dashboard', 'N1 Badminton — 管理后台'],
    '/matches': ['N1 Badminton — My Matches', 'N1 Badminton — 我的比赛'],
    '/board': ['🏸 N1 Badminton Social', '🏸 N1 Badminton 社交球局'],
    '/mobile': ['N1 · Check-in', 'N1 · 签到'],
  };

  function currentRoute() {
    let p = location.pathname.replace(/\.html$/, '').replace(/\/index$/, '');
    return p || '/';
  }

  function applyTitle() {
    const entry = TITLES[currentRoute()];
    if (entry) document.title = lang === 'zh' ? entry[1] : entry[0];
  }

  // ── Switcher ───────────────────────────────────────────
  function injectSwitcher() {
    if (document.getElementById('lang-switch')) return;
    const box = document.createElement('div');
    box.id = 'lang-switch';
    box.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:9999',
      'display:flex', 'gap:2px', 'background:#fff', 'border-radius:999px',
      'padding:3px', 'box-shadow:0 2px 10px rgba(15,23,42,.18)',
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    ].join(';');
    box.innerHTML = `
      <button data-lang="en">EN</button>
      <button data-lang="zh">中文</button>`;
    box.addEventListener('click', e => {
      const b = e.target.closest('button[data-lang]');
      if (b) setLang(b.dataset.lang);
    });
    document.body.appendChild(box);
    paint();
  }

  function paint() {
    const box = document.getElementById('lang-switch');
    if (!box) return;
    box.querySelectorAll('button').forEach(b => {
      const on = b.dataset.lang === lang;
      b.style.cssText = [
        'border:0', 'border-radius:999px', 'padding:7px 13px',
        'font-size:12px', 'font-weight:800', 'cursor:pointer',
        `background:${on ? '#0f172a' : 'transparent'}`,
        `color:${on ? '#fff' : '#64748b'}`,
      ].join(';');
    });
  }

  function setLang(next) {
    lang = 'en';
    localStorage.removeItem(STORAGE_KEY);
    document.documentElement.lang = 'en';
    walk(document.body);
    refreshLanguageBlocks(document.body);
    paint();
    applyTitle();
    window.dispatchEvent(new CustomEvent('n1:langchange', { detail: { lang } }));
  }

  // ── Public API ─────────────────────────────────────────
  // Declare bilingual strings in JS: t('English', '中文').
  window.t = (en, zh) => (lang === 'zh' ? (zh || en) : en);
  window.N1I18N = {
    get lang() { return lang; },
    t: window.t,
    setLang,
    apply: walk,
    money: c => 'AUD$' + ((Number(c) || 0) / 100).toFixed(2),
    /** Translate a server-provided string (notifications, errors). */
    translate: translateString,
    _translate: translateString,
  };

  function boot() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    injectStyle();
    walk(document.body);
    refreshLanguageBlocks(document.body);
    applyTitle();
    startObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
