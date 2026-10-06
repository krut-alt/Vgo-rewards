// VGO Rewards member app: sign up, home, offers, use rewards, account.
// Plain browser JavaScript; installable from the browser until the store apps exist.
import { code128Svg } from './barcode.js';

const root = document.getElementById('app');
const sheet = document.getElementById('sheet');
const sheetBody = document.getElementById('sheet-body');

let config = null; // public program config
let me = null; // signed-in member's home payload
let token = load('vgo.token');

// ---------- helpers ----------

function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: stay signed in for this tab only */
  }
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api/app${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    signOutLocal();
    throw new Error(data.error || 'Please sign in again.');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}

const ICONS = {
  home: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  offers: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
  use: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>',
  account: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  pump: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12"/><path d="M4 10h10"/><path d="M14 8h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V9l-3-3"/></svg>',
  pin: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  cake: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><path d="M2 21h20"/><path d="M7 8v3M12 8v3M17 8v3"/><path d="M7 4h.01M12 4h.01M17 4h.01"/></svg>',
  bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
};

function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2400);
}

function openSheet(...children) {
  sheetBody.replaceChildren(...children);
  if (!sheet.open) sheet.showModal();
}
sheet.addEventListener('click', (e) => e.target === sheet && sheet.close());

const fmtPhone = (p) => `${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6)}`;
const storeLabel = (s) => `${s.name}${s.city ? ` · ${s.city}, ${s.state}` : ` · ${s.state}`}`;
const money = (c) => `$${(c / 100).toFixed(2)}`;

function lockup(big) {
  const b = config.branding;
  return h(
    'div',
    { class: `lockup${big ? ' big' : ''}` },
    h('div', { class: 'mark' }, h('img', { src: b.logoDataUrl || '/app/vgo-logo.png', alt: 'VGO' })),
    h('span', { class: 'word' }, b.logoDataUrl ? b.programName : b.programName.replace(/^VGO\s+/i, '')),
  );
}

function applyBranding() {
  const b = config.branding;
  document.documentElement.style.setProperty('--main', b.mainColor);
  document.documentElement.style.setProperty('--accent', b.accentColor);
  document.querySelector('meta[name=theme-color]').setAttribute('content', b.mainColor);
  document.title = b.programName;
}

function signOutLocal() {
  token = null;
  me = null;
  store('vgo.token', null);
}

// ---------- sign up and sign in ----------

let joinState = { mode: 'join', step: 'details', phone: '', firstName: '', email: '', emailOptIn: true, smsOptIn: true, homeStoreId: null, devCode: null, error: null };

function renderJoin() {
  const s = joinState;
  s.homeStoreId ??= config.defaultStoreId;
  const err = s.error && h('div', { class: 'error', role: 'alert' }, s.error);
  const w = config.welcome;

  let form;
  if (s.step === 'details') {
    const phone = h('input', { id: 'phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel-national', placeholder: '(803) 555-0123', value: s.phone, oninput: (e) => (s.phone = e.target.value) });
    form = [
      h('div', { class: 'field' }, h('label', { for: 'phone' }, 'Mobile number'), phone, h('span', { class: 'hint' }, 'This is your member ID. Type it on the PIN pad at checkout.')),
      s.mode === 'join' && [
        h('div', { class: 'field' }, h('label', { for: 'first' }, 'First name'), h('input', { id: 'first', type: 'text', autocomplete: 'given-name', placeholder: 'Jordan', value: s.firstName, oninput: (e) => (s.firstName = e.target.value) })),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'email' }, 'Email (optional)'),
          h('input', { id: 'email', type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com', value: s.email, oninput: (e) => (s.email = e.target.value) }),
          h('span', { class: 'hint' }, 'For receipts and offers by email. You still sign in with your phone.'),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'home' }, 'Your store'),
          h(
            'select',
            { id: 'home', onchange: (e) => (s.homeStoreId = e.target.value) },
            config.stores.map((st) => h('option', { value: st.id, selected: st.id === s.homeStoreId }, `${storeLabel(st)}${st.loyaltyLive ? '' : ' (coming soon)'}`)),
          ),
        ),
        h(
          'label',
          { class: 'check' },
          h('input', { type: 'checkbox', checked: s.smsOptIn, onchange: (e) => (s.smsOptIn = e.target.checked) }),
          'Text me offers from my store. Msg and data rates may apply. Reply STOP to opt out.',
        ),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.emailOptIn, onchange: (e) => (s.emailOptIn = e.target.checked) }), 'Email me offers too, if I added an email'),
      ],
      err,
      h('div', { style: 'flex:1' }),
      h('button', { class: 'cta', onclick: sendCode }, s.mode === 'join' ? w.cta : 'Send my code'),
      s.mode === 'join' && h('span', { class: 'fine' }, `${w.fine} By joining you agree to the `, h('a', { href: '#terms' }, 'program terms'), ' and ', h('a', { href: '#privacy' }, 'privacy policy'), '.'),
      h(
        'button',
        { class: 'switch-mode', onclick: () => ((s.mode = s.mode === 'join' ? 'signin' : 'join'), (s.error = null), renderJoin()) },
        s.mode === 'join' ? 'Already a member? Sign in' : 'New here? Join free',
      ),
    ];
  } else {
    const code = h('input', { id: 'code', class: 'code-input', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, oninput: (e) => e.target.value.length === 6 && verifyCode(e.target.value) });
    setTimeout(() => code.focus(), 50);
    form = [
      h('div', { class: 'field' }, h('label', { for: 'code' }, `Enter the 6-digit code we texted to ${fmtPhone(s.phone.replace(/\D/g, '').slice(-10))}`), code),
      s.devCode && h('div', { class: 'devcode' }, `Test mode: your code is ${s.devCode}. Real members get it by text.`),
      err,
      h('div', { style: 'flex:1' }),
      h('button', { class: 'cta', onclick: () => verifyCode(code.value) }, s.mode === 'join' ? 'Join' : 'Sign in'),
      h('button', { class: 'switch-mode', onclick: sendCode }, 'Send a new code'),
      h('button', { class: 'switch-mode', onclick: () => ((s.step = 'details'), (s.error = null), renderJoin()) }, 'Change number'),
    ];
  }

  root.replaceChildren(
    h(
      'div',
      { class: 'join' },
      h(
        'section',
        { class: 'join-top' },
        lockup(true),
        h('h1', {}, s.mode === 'join' ? w.headline : 'Welcome back'),
        h('p', {}, s.mode === 'join' ? 'Join free with your phone number. Earn points inside the store and at the pump, then save on fuel.' : 'Sign in with the phone number you joined with.'),
        s.mode === 'join' && w.imageUrl && h('div', { class: 'join-art' }, h('img', { src: w.imageUrl, alt: '' })),
        s.mode === 'join' && h('div', { class: 'perks' }, ['Points at the pump', 'Points inside', 'Member-only deals'].map((t) => h('span', {}, svg(ICONS.check), t))),
      ),
      h('section', { class: 'join-form' }, form),
    ),
  );
}

async function sendCode() {
  const s = joinState;
  const digits = s.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (digits.length !== 10) return ((s.error = 'Enter your 10-digit mobile number.'), renderJoin());
  if (s.mode === 'join' && !s.firstName.trim()) return ((s.error = 'Enter your first name.'), renderJoin());
  if (s.mode === 'join' && s.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email.trim())) return ((s.error = 'Check the email address, or leave it blank.'), renderJoin());
  try {
    const res = await api('POST', '/code', { phone: digits });
    Object.assign(s, { phone: digits, step: 'code', devCode: res.devCode ?? null, error: null });
  } catch (e) {
    s.error = e.message;
  }
  renderJoin();
}

async function verifyCode(code) {
  const s = joinState;
  try {
    const res = await api('POST', '/verify', {
      phone: s.phone,
      code,
      ...(s.mode === 'join' ? { firstName: s.firstName, smsOptIn: s.smsOptIn, homeStoreId: s.homeStoreId, email: s.email.trim(), emailOptIn: s.emailOptIn } : {}),
    });
    if (res.needsSignup) {
      // Signed in with a number that isn't a member yet: collect a name, then the same code still works.
      Object.assign(s, { mode: 'join', step: 'details', error: 'That number isn’t a member yet. Add your first name to join.' });
      return renderJoin();
    }
    token = res.token;
    store('vgo.token', token);
    joinState = { ...joinState, step: 'details', devCode: null, error: null };
    if (res.isNew) toast('Welcome! Your reward is ready.');
    location.hash = '#/home';
    render();
  } catch (e) {
    s.error = e.message;
    renderJoin();
  }
}

// ---------- signed-in screens ----------

function tabs(active) {
  const tab = (id, label) => h('a', { href: `#/${id}`, class: active === id ? 'on' : '', 'aria-current': active === id ? 'page' : undefined }, svg(ICONS[id]), label);
  return h('nav', { class: 'tabs', 'aria-label': 'Main' }, tab('home', 'Home'), tab('offers', 'Offers'), tab('use', 'Use rewards'), tab('account', 'Account'));
}

function frame(active, ...children) {
  root.replaceChildren(h('div', { class: 'screen' }, ...children), tabs(active));
}

/** The 16:9 picture on every reward: uploaded artwork, or the headline on a colored banner. */
function artFrame(o, extra = '') {
  if (o.imageUrl) return h('div', { class: `art ${extra}` }, h('img', { src: o.imageUrl, alt: '', loading: 'lazy', decoding: 'async' }));
  return h(
    'div',
    { class: `art poster ${o.kind || 'other'}${o.stockArtUrl ? ' has-pic' : ''} ${extra}` },
    h('span', { class: 'poster-text' }, o.headline),
    o.stockArtUrl && h('img', { class: 'poster-pic', src: o.stockArtUrl, alt: '', loading: 'lazy', decoding: 'async' }),
    h('img', { class: 'poster-logo', src: config.branding.logoDataUrl || '/app/vgo-logo.png', alt: '' }),
  );
}

function offerAction(o, onChange) {
  if (o.how === 'clip')
    return o.clipped
      ? h('div', { class: 'between' }, h('div', { class: 'added' }, svg(ICONS.check), 'On your card'), h('button', { class: 'switch-mode', onclick: () => clip(o, false, onChange) }, 'Remove'))
      : h('button', { class: `pill-btn${o.kind === 'brand' ? ' outline' : ''}`, style: 'align-self:flex-start', onclick: () => clip(o, true, onChange) }, 'Add to card');
  return h('div', { class: 'added' }, svg(ICONS.check), o.how === 'auto-pump' ? 'Applies at the pump when you enter your phone' : o.how === 'punch' ? 'Counts automatically at the register' : 'Applies automatically at the register');
}

function offerCard(o, onChange) {
  return h(
    'article',
    { class: 'promo' },
    h('div', { class: 'art-wrap' }, artFrame(o), o.nearby && h('span', { class: 'ribbon' }, svg(ICONS.pin), 'Near you'), o.ends && h('span', { class: 'ends' }, `Ends ${o.ends}`)),
    h(
      'div',
      { class: 'promo-body' },
      h('span', { class: `kicker${o.kind === 'brand' ? ' brand' : ''}` }, o.kicker),
      h('span', { class: 'title' }, o.name),
      h('span', { class: 'sub' }, o.line),
      offerAction(o, onChange),
    ),
  );
}

/** The birthday reward on home: ready to use, coming up, or a nudge to add a birthday. */
function birthdayCard(b, m) {
  if (!b) return null;
  if (b.state === 'add-birthday')
    return h(
      'section',
      { class: 'card row bday-nudge' },
      h('div', { class: 'icon-tile' }, svg(ICONS.cake)),
      h('div', { class: 'grow' }, h('span', { class: 'title', style: 'font-size:18px' }, 'Get a birthday treat'), h('span', { class: 'sub' }, `Add your birthday and we’ll have ${b.name.replace(/^Birthday treat:\s*/i, 'a ').toLowerCase()} waiting.`)),
      h('a', { class: 'pill-btn', href: '#/account' }, 'Add'),
    );
  if (b.state === 'coming')
    return h(
      'section',
      { class: 'card row' },
      h('div', { class: 'icon-tile' }, svg(ICONS.cake)),
      h('div', { class: 'grow' }, h('span', { class: 'ready', style: 'color:var(--muted)' }, 'Birthday treat'), h('span', { class: 'title', style: 'font-size:18px' }, b.name.replace(/^Birthday treat:\s*/i, '')), h('span', { class: 'sub' }, `Unlocks ${b.on}.`)),
    );
  const o = b.offer;
  return h(
    'article',
    { class: 'promo bday' },
    h('div', { class: 'art-wrap' }, o.imageUrl ? artFrame(o) : h('div', { class: `art poster birthday${o.stockArtUrl ? ' has-pic' : ''}` }, h('span', { class: 'poster-text' }, `Happy birthday, ${m.firstName}!`), h('span', { class: 'confetti', 'aria-hidden': 'true' }), o.stockArtUrl && h('img', { class: 'poster-pic', src: o.stockArtUrl, alt: '' }))),
    h('div', { class: 'promo-body' }, h('span', { class: 'kicker' }, 'Your birthday treat'), h('span', { class: 'title' }, o.name), h('span', { class: 'sub' }, o.line), offerAction(o, renderHome)),
  );
}

/** Big swipeable banners at the top of home. */
function featuredSlider(list) {
  if (!list.length) return null;
  const dots = h('div', { class: 'dots' }, list.map((_, i) => h('span', { class: i === 0 ? 'on' : '' })));
  const track = h(
    'div',
    {
      class: 'slider',
      onscroll: (e) => {
        const i = Math.round(e.target.scrollLeft / e.target.clientWidth);
        [...dots.children].forEach((d, j) => d.classList.toggle('on', i === j));
      },
    },
    list.map((o) =>
      h(
        'a',
        { class: 'slide', href: '#/offers', 'aria-label': o.name },
        artFrame(o),
        h('div', { class: 'slide-cap' }, h('span', { class: 'slide-kicker' }, o.kicker.split(' · ')[0]), h('span', { class: 'slide-title' }, o.name), h('span', { class: 'slide-cta' }, o.how === 'clip' && !o.clipped ? 'Add to card' : 'See offer')),
      ),
    ),
  );
  return h('section', { class: 'featured', 'aria-label': 'Featured offers' }, track, list.length > 1 && dots);
}

async function clip(o, on, onChange) {
  try {
    if (on && o.nearby && !here) here = await locate();
    await api(on ? 'POST' : 'DELETE', `/offers/${o.ruleId}/clip`, on && here ? { lat: here.lat, lng: here.lng } : undefined);
    toast(on ? 'Added to your card' : 'Removed from your card');
    onChange();
  } catch (e) {
    toast(e.message);
  }
}

async function renderHome() {
  me = await api('GET', '/me');
  const m = me.member;
  const next = me.nextReward;
  const progress = next ? Math.max(0, Math.min(1, m.points / next.costPoints)) : 1;
  const affordableFuel = me.redeem.find((r) => r.kind === 'fuel' && r.affordable);
  const ready = me.freeFuel[0] ?? (affordableFuel && { title: affordableFuel.title, detail: affordableFuel.detail });

  frame(
    'home',
    h('header', { class: 'top' }, h('div', { style: 'display:flex;flex-direction:column;gap:2px' }, h('span', { class: 'hello' }, `${me.greeting}, ${m.firstName}`), lockup()), h('a', { class: 'round-btn', href: '#/offers', 'aria-label': 'Offers' }, svg(ICONS.bell))),
    h(
      'main',
      { class: 'content' },
      featuredSlider(me.featured ?? []),
      h(
        'section',
        { class: 'points' },
        h(
          'div',
          { class: 'row' },
          h('div', {}, h('div', { class: 'label' }, 'Your points'), h('div', { class: 'big' }, m.points.toLocaleString())),
          h('div', { class: 'store' }, 'Home store', h('br'), storeLabel(m.homeStore)),
        ),
        next &&
          h(
            'div',
            { style: 'display:flex;flex-direction:column;gap:6px' },
            h('div', { class: 'track', role: 'progressbar', 'aria-valuenow': Math.round(progress * 100), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Progress to next reward' }, h('div', { style: `width:${progress * 100}%` })),
            h('span', { class: 'next' }, `${next.pointsNeeded} more points to your next ${next.title}`),
          ),
        me.earnSummary && h('span', { class: 'rates' }, me.earnSummary),
      ),
      birthdayCard(me.birthday, m),
      !m.homeStore.loyaltyLive && h('div', { class: 'card' }, h('b', {}, `Rewards are coming soon to ${m.homeStore.name}`), h('span', { class: 'sub' }, 'You can earn and use rewards at stores where they are live. Change your store in Account.')),
      ready &&
        h(
          'section',
          { class: 'card row' },
          h('div', { class: 'icon-tile' }, svg(ICONS.pump)),
          h('div', { class: 'grow' }, h('span', { class: 'ready' }, 'Ready to use'), h('span', { class: 'title' }, ready.title), h('span', { class: 'sub' }, ready.detail)),
          h('a', { class: 'pill-btn', href: '#/use' }, 'Use'),
        ),
      me.punchCards.map((c) =>
        h(
          'section',
          { class: 'card' },
          h('div', { class: 'section-head' }, h('b', {}, c.name), h('span', { class: 'sub' }, `${Math.min(c.count, c.every)} of ${c.every}`)),
          h(
            'div',
            { class: 'punches', role: 'img', 'aria-label': `${c.count} of ${c.every} punches` },
            Array.from({ length: c.every }, (_, i) => h('div', { class: `punch${i < c.count ? '' : ' empty'}` })),
            h('div', { class: 'free-tag' }, `${c.every + 1}${c.every + 1 === 2 ? 'nd' : c.every + 1 === 3 ? 'rd' : 'th'} free`),
          ),
        ),
      ),
      h(
        'section',
        { style: 'display:flex;flex-direction:column;gap:10px' },
        h('div', { class: 'section-head' }, h('b', {}, 'Offers for you'), h('a', { href: '#/offers' }, 'See all')),
        me.offers.length
          ? h(
              'div',
              { class: 'strip' },
              me.offers.map((o) =>
                h(
                  'a',
                  { class: 'mini', href: '#/offers' },
                  artFrame(o),
                  h('span', { class: 'mini-title' }, o.name),
                  h('span', { class: 'sub' }, `${o.kicker.split(' · ')[1] ?? ''}${o.ends ? ` · ends ${o.ends}` : ''}`),
                ),
              ),
            )
          : h('div', { class: 'card sub' }, 'New offers show up here.'),
      ),
    ),
  );
}

let offerFilter = 'all';
let offerStoreId = null;
// The phone's location, only after the member asks for near-store deals. Never stored.
let here = null;
let locating = false;

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This phone can’t share its location with the app.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(new Error(e.code === 1 ? 'Location is off for this app. Turn it on in your browser settings to see deals near you.' : 'Couldn’t find your location. Try again.')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 },
    );
  });
}

async function findNearby() {
  locating = true;
  renderOffers();
  try {
    here = await locate();
  } catch (e) {
    toast(e.message);
  }
  locating = false;
  renderOffers();
}

// If the member already allowed location, refresh it quietly so near-store deals show up.
async function refreshHereIfAllowed() {
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    if (p?.state === 'granted') here = await locate();
  } catch {}
}

async function renderOffers() {
  const q = new URLSearchParams();
  if (offerStoreId) q.set('storeId', offerStoreId);
  if (here) q.set('lat', String(here.lat)), q.set('lng', String(here.lng));
  const res = await api('GET', `/offers${q.size ? `?${q}` : ''}`);
  const shown = res.offers.filter((o) => offerFilter === 'all' || o.kind === offerFilter);
  const filter = (id, label) => h('button', { class: `filter${offerFilter === id ? ' on' : ''}`, 'aria-pressed': offerFilter === id, onclick: () => ((offerFilter = id), renderOffers()) }, label);
  frame(
    'offers',
    h(
      'header',
      { class: 'page-title', style: 'gap:14px' },
      h('h1', {}, 'Offers'),
      h('button', { class: 'store-btn', onclick: pickStore }, svg(ICONS.pin), h('span', { style: 'flex:1' }, 'Showing offers at ', h('strong', {}, storeLabel(res.store))), h('span', { style: 'font-weight:600' }, 'Change')),
      h('div', { class: 'filters' }, filter('all', 'All'), filter('fuel', 'Fuel'), filter('food', 'Food and drink'), filter('brand', 'Brands')),
    ),
    h(
      'main',
      { class: 'content' },
      res.nearbyOffers &&
        !here &&
        h(
          'section',
          { class: 'card row' },
          svg(ICONS.pin),
          h('span', { style: 'flex:1;font-size:15px' }, 'Some deals only unlock when you’re at the store.'),
          h('button', { class: 'pill-btn', disabled: locating, onclick: findNearby }, locating ? 'Finding you…' : 'Show deals near me'),
        ),
      shown.length ? shown.map((o) => offerCard(o, renderOffers)) : h('div', { class: 'empty-state' }, 'No offers here right now. Check back soon.'),
    ),
  );
}

function pickStore() {
  openSheet(
    h('b', { style: 'font-size:18px' }, 'Show offers at'),
    config.stores.map((s) =>
      h(
        'button',
        {
          class: 'store-btn',
          onclick: () => {
            offerStoreId = s.id;
            sheet.close();
            renderOffers();
          },
        },
        svg(ICONS.pin),
        h('span', { style: 'flex:1' }, storeLabel(s)),
        h('span', { class: 'sub' }, s.loyaltyLive ? '' : 'Coming soon'),
      ),
    ),
  );
}

async function renderUse() {
  me = await api('GET', '/me');
  const m = me.member;
  const fuelOptions = me.redeem.filter((r) => r.kind === 'fuel');
  const itemOptions = me.redeem.filter((r) => r.kind === 'item');
  const chosen = new Set(me.redeem.filter((r) => r.selected).map((r) => r.ruleId));
  const free = me.freeFuel[0];
  const bestFreeCpg = free?.centsPerGallon ?? 0;
  const { offers } = await api('GET', '/offers');
  const onCard = offers.filter((o) => o.how === 'clip' && o.clipped).length;

  async function save(next) {
    try {
      await api('PUT', '/redeem', { ruleIds: [...next] });
      toast(next.size ? 'Saved for your next visit' : 'No points will be used');
      renderUse();
    } catch (e) {
      toast(e.message);
    }
  }
  const pickFuel = (ruleId) => {
    const next = new Set([...chosen].filter((id) => !fuelOptions.some((f) => f.ruleId === id)));
    if (ruleId) next.add(ruleId);
    save(next);
  };
  const fuelSelected = fuelOptions.find((f) => chosen.has(f.ruleId));
  const cpgOf = (title) => Number(/(\d+)¢/.exec(title)?.[1] ?? 0);

  frame(
    'use',
    h('header', { class: 'page-title' }, h('h1', {}, 'Use rewards'), h('span', {}, 'At the pump or the register')),
    h(
      'main',
      { class: 'content' },
      h(
        'section',
        { class: 'id-card' },
        h('span', { class: 'hint' }, 'Enter on the PIN pad when asked for your rewards ID'),
        h('span', { class: 'phone-id' }, fmtPhone(m.phone)),
        h('hr'),
        h('span', { class: 'hint' }, 'Or show this code to the cashier'),
        h('div', { class: 'barcode' }, svg(code128Svg(m.phone))),
      ),
      (free || fuelOptions.length > 0) &&
        h(
          'section',
          { style: 'display:flex;flex-direction:column;gap:10px' },
          h('b', { style: 'font-size:17px' }, 'Fuel reward for this fill-up'),
          free &&
            h(
              'label',
              { class: `choice${!fuelSelected ? ' on' : ''}` },
              h('input', { type: 'radio', name: 'fuel', checked: !fuelSelected, onchange: () => pickFuel(null) }),
              h('span', { class: 'grow' }, h('span', { class: 'title', style: 'font-size:18px' }, free.title), h('span', { class: 'sub' }, `${free.detail} · free`)),
              h('span', { class: 'best' }, 'Best'),
            ),
          !free &&
            h(
              'label',
              { class: `choice${!fuelSelected ? ' on' : ''}` },
              h('input', { type: 'radio', name: 'fuel', checked: !fuelSelected, onchange: () => pickFuel(null) }),
              h('span', { class: 'grow' }, h('span', { class: 'title', style: 'font-size:18px' }, 'Save my points'), h('span', { class: 'sub' }, 'Earn on this fill-up without spending points')),
            ),
          fuelOptions.map((f) =>
            h(
              'label',
              { class: `choice${chosen.has(f.ruleId) ? ' on' : ''}${f.affordable ? '' : ' off'}` },
              h('input', { type: 'radio', name: 'fuel', checked: chosen.has(f.ruleId), disabled: !f.affordable, onchange: () => pickFuel(f.ruleId) }),
              h('span', { class: 'grow' }, h('span', { class: 'title', style: 'font-size:18px' }, f.title), h('span', { class: 'sub' }, f.affordable ? f.detail : `Needs ${f.costPoints} points · you have ${m.points}`)),
            ),
          ),
          h(
            'span',
            { class: 'sub', style: 'line-height:1.4' },
            fuelSelected && bestFreeCpg >= cpgOf(fuelSelected.title)
              ? `Your free ${free.title} is bigger, so it applies first and your points stay for next time.`
              : 'One fuel discount per fill-up. Points are only used when the discount applies.',
          ),
        ),
      itemOptions.length > 0 &&
        h(
          'section',
          { style: 'display:flex;flex-direction:column;gap:10px' },
          h('b', { style: 'font-size:17px' }, 'Inside the store'),
          itemOptions.map((r) =>
            h(
              'label',
              { class: `choice${chosen.has(r.ruleId) ? ' on' : ''}${r.affordable || chosen.has(r.ruleId) ? '' : ' off'}` },
              h('input', {
                type: 'checkbox',
                checked: chosen.has(r.ruleId),
                disabled: !r.affordable && !chosen.has(r.ruleId),
                onchange: (e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(r.ruleId);
                  else next.delete(r.ruleId);
                  save(next);
                },
              }),
              h('div', { class: 'choice-art' }, artFrame({ ...r, kind: 'food' })),
              h('span', { class: 'grow' }, h('span', { class: 'title', style: 'font-size:18px' }, r.title), h('span', { class: 'sub' }, r.affordable ? r.detail : `Needs ${r.costPoints} points · you have ${m.points}`)),
            ),
          ),
        ),
      h('section', { class: 'card row' }, svg(ICONS.offers), h('span', { style: 'flex:1;font-size:15px' }, onCard ? `${onCard} in-store ${onCard === 1 ? 'offer' : 'offers'} on your card apply at the register` : 'Add in-store offers to your card'), h('a', { href: '#/offers' }, 'View')),
    ),
  );
}

async function renderAccount() {
  me = await api('GET', '/me');
  const visits = await api('GET', '/visits');
  const m = me.member;
  const name = h('input', { id: 'acct-name', type: 'text', value: m.firstName, autocomplete: 'given-name' });
  frame(
    'account',
    h('header', { class: 'page-title' }, h('h1', {}, 'Account'), h('span', {}, `Member ID ${fmtPhone(m.phone)}`)),
    h(
      'main',
      { class: 'content' },
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'field' }, h('label', { for: 'acct-name' }, 'First name'), name),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'acct-store' }, 'Home store'),
          h('select', { id: 'acct-store' }, config.stores.map((s) => h('option', { value: s.id, selected: s.id === m.homeStore.id }, `${storeLabel(s)}${s.loyaltyLive ? '' : ' (coming soon)'}`))),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'acct-email' }, 'Email (optional)'),
          h('input', { id: 'acct-email', type: 'email', inputmode: 'email', autocomplete: 'email', value: m.email }),
          h('span', { class: 'hint' }, 'Your phone number stays your member ID and how you sign in.'),
        ),
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'label', id: 'bday-label' }, 'Birthday (optional)'),
          h(
            'div',
            { class: 'two', role: 'group', 'aria-labelledby': 'bday-label' },
            h(
              'select',
              { id: 'acct-bmonth', 'aria-label': 'Month' },
              h('option', { value: '' }, 'Month'),
              ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((mo, i) => h('option', { value: String(i + 1).padStart(2, '0'), selected: m.birthday.slice(0, 2) === String(i + 1).padStart(2, '0') }, mo)),
            ),
            h(
              'select',
              { id: 'acct-bday', 'aria-label': 'Day' },
              h('option', { value: '' }, 'Day'),
              Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')).map((d) => h('option', { value: d, selected: m.birthday.slice(3) === d }, String(Number(d)))),
            ),
          ),
          h('span', { class: 'hint' }, 'We may send you a treat on your birthday. No year needed.'),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'acct-zip' }, 'ZIP code (optional)'),
          h('input', { id: 'acct-zip', type: 'text', inputmode: 'numeric', autocomplete: 'postal-code', maxlength: 5, value: m.zip }),
        ),
        h('label', { class: 'check' }, h('input', { id: 'acct-sms', type: 'checkbox', checked: m.smsOptIn }), 'Text me offers from my store'),
        h('label', { class: 'check' }, h('input', { id: 'acct-email-optin', type: 'checkbox', checked: m.emailOptIn }), 'Email me offers'),
        h(
          'button',
          {
            class: 'cta',
            onclick: async () => {
              try {
                await api('PUT', '/me', {
                  firstName: name.value,
                  homeStoreId: document.getElementById('acct-store').value,
                  smsOptIn: document.getElementById('acct-sms').checked,
                  email: document.getElementById('acct-email').value,
                  emailOptIn: document.getElementById('acct-email-optin').checked,
                  birthday: (() => {
                    const mo = document.getElementById('acct-bmonth').value;
                    const d = document.getElementById('acct-bday').value;
                    if (!mo && !d) return '';
                    if (!mo || !d) throw new Error('Pick both the month and day of your birthday.');
                    return `${mo}-${d}`;
                  })(),
                  zip: document.getElementById('acct-zip').value,
                });
                toast('Saved');
                renderAccount();
              } catch (e) {
                toast(e.message);
              }
            },
          },
          'Save',
        ),
      ),
      h(
        'section',
        { class: 'card' },
        h('b', {}, 'Recent visits'),
        visits.length
          ? h(
              'div',
              { class: 'list' },
              visits.map((v) =>
                h(
                  'div',
                  {},
                  h('span', {}, h('b', {}, new Date(v.at).toLocaleDateString()), h('br'), h('span', { class: 'sub' }, `${v.store}${v.gallons ? ` · ${v.gallons} gal` : ''}`)),
                  h('span', { style: 'text-align:right' }, `+${v.pointsEarned} pts`, v.pointsSpent ? ` −${v.pointsSpent}` : '', h('br'), v.savedCents ? h('span', { class: 'sub' }, `Saved ${money(v.savedCents)}`) : ''),
                ),
              ),
            )
          : h('span', { class: 'sub' }, 'Your visits show up here after you enter your phone at the pump or register.'),
      ),
      h(
        'button',
        {
          class: 'cta secondary',
          onclick: async () => {
            await api('POST', '/signout').catch(() => {});
            signOutLocal();
            location.hash = '';
            render();
          },
        },
        'Sign out',
      ),
      h('p', { class: 'fine' }, h('a', { href: '#terms' }, 'Program terms'), ' · ', h('a', { href: '#privacy' }, 'Privacy policy')),
    ),
  );
}

// ---------- router ----------

async function render() {
  if (!config) {
    config = await api('GET', '/config');
    applyBranding();
  }
  if (!token) return renderJoin();
  const page = location.hash.replace(/^#\/?/, '') || 'home';
  try {
    if (page === 'offers') {
      if (!here) await refreshHereIfAllowed();
      return await renderOffers();
    }
    if (page === 'use') return await renderUse();
    if (page === 'account') return await renderAccount();
    return await renderHome();
  } catch (e) {
    if (!token) return renderJoin();
    root.replaceChildren(h('div', { class: 'content' }, h('div', { class: 'error' }, e.message), h('button', { class: 'cta', onclick: render }, 'Try again')));
  }
}

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});
render().catch((e) => root.replaceChildren(h('div', { class: 'content' }, h('div', { class: 'error' }, e.message))));
