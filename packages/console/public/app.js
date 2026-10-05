// VGO Rewards console. Plain browser JavaScript, no build step.
// Screens follow the approved designs: Offers, Create offer, Reward rules, Stores and groups, Members, Results.

const main = document.getElementById('main');
const dialog = document.getElementById('dialog');
const dialogBody = document.getElementById('dialog-body');

let boot = null; // bootstrap data from the API

// Pages pass `condition && element`; skip the falses instead of printing them.
const replaceMain = main.replaceChildren.bind(main);
main.replaceChildren = (...children) => replaceMain(...children.flat(Infinity).filter((c) => c !== false && c !== null && c !== undefined && c !== ''));

// ---------- helpers ----------

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw Object.assign(new Error('Please sign in.'), { problems: ['Please sign in.'], signIn: true });
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.problems = data.problems || [err.message];
    throw err;
  }
  return data;
}

/** Builds DOM safely: h('div', {class: 'x', onclick}, 'text', child). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

function openDialog(...children) {
  dialogBody.replaceChildren(...children);
  if (!dialog.open) dialog.showModal();
}
function closeDialog() {
  dialog.close();
}
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) closeDialog();
});

const DISCOUNT_TYPES = ['fuelDiscount', 'itemDiscount', 'basketDiscount', 'punchCard'];
const isDiscount = (rule) => DISCOUNT_TYPES.includes(rule.effect?.type);

function discountSummary(rule) {
  const e = rule.effect;
  if (e.type === 'fuelDiscount') return `${e.centsPerGallon}¢ a gallon off, up to ${e.maxGallons} gallons${e.costPoints ? `, for ${e.costPoints} points` : ''}`;
  if (e.type === 'basketDiscount') return `${money(e.centsOff)} off the purchase`;
  if (e.type === 'punchCard') return `Buy ${e.every}, get the next one free`;
  if (e.type === 'itemDiscount') return e.percentOff ? `${e.percentOff}% off` : e.centsOff ? `${money(e.centsOff)} off` : 'Free item';
  return '';
}
function targetSummary(rule) {
  const sc = rule.scope;
  if (sc.kind === 'all') return `All ${boot.stores.length} locations`;
  if (sc.kind === 'groups') return sc.groupIds.map((g) => boot.groups.find((x) => x.id === g)?.name ?? g).join(', ');
  return sc.storeIds.map(storeName).join(', ');
}
const PAYER = { jobber: 'Corporate', store: 'The store', manufacturer: 'The manufacturer', split: 'Split between corporate and the store' };

/** Asks once more before a discount goes live. Resolves true when confirmed. */
function confirmDiscounts(rules) {
  const list = rules.filter(isDiscount);
  if (!list.length) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => {
      dialog.removeEventListener('close', onClose);
      closeDialog();
      resolve(ok);
    };
    const onClose = () => done(false);
    dialog.addEventListener('close', onClose);
    openDialog(
      h('h2', {}, list.length > 1 ? `Confirm ${list.length} discounts` : 'Confirm this discount'),
      h('p', {}, 'Customers will get this at checkout once it’s on. Please check it once more.'),
      ...list.map((r) =>
        h(
          'div',
          { class: 'card confirm-card' },
          h('b', {}, r.name || 'Untitled'),
          h('div', {}, discountSummary(r)),
          h('div', { class: 'meta' }, `Where: ${targetSummary(r)}`),
          h('div', { class: 'meta' }, `Who pays: ${PAYER[r.fundedBy] ?? r.fundedBy}`),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'grow' }),
        h('button', { class: 'btn ghost', onclick: () => done(false) }, 'Go back'),
        h('button', { class: 'btn accent', onclick: () => done(true) }, 'Yes, save it'),
      ),
    );
  });
}

function errorBox(err) {
  const problems = err.problems || [err.message];
  return h('div', { class: 'error', role: 'alert' }, problems.length > 1 ? h('ul', {}, problems.map((p) => h('li', {}, p))) : problems[0]);
}

const isAdmin = () => boot?.me?.role !== 'store';
const fundTotal = (f) => f.corporateCents + f.storeCents + f.otherCents;
const fundSplit = (f) => `Corporate ${money(f.corporateCents + f.otherCents)} · store ${money(f.storeCents)}`;
const money = (cents) => (cents % 100 === 0 ? `$${(cents / 100).toLocaleString()}` : `$${(cents / 100).toFixed(2)}`);
const dollarsToCents = (v) => Math.round(Number(String(v).replace(/[$,]/g, '')) * 100);
const pct = (x) => `${Math.round(x * 100)}%`;
const catLabel = (id) => boot.categories.find((c) => c.id === id)?.label ?? id;
const storeName = (id) => boot.stores.find((s) => s.id === id)?.name ?? id;
const posLabel = (p) =>
  ({ 'verifone-commander': 'Verifone Commander', 'gilbarco-passport': 'Gilbarco Passport', 'ncr-radiant': 'NCR Radiant', other: 'POS not confirmed' })[p] ?? p;

/** Store-local (Eastern) YYYY-MM-DD for an ISO instant. */
function localYmd(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
}
/** ISO instant for local midnight starting a YYYY-MM-DD date, Eastern time. */
function localMidnightIso(ymd) {
  const probe = new Date(`${ymd}T05:00:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName').value;
  const m = /GMT([+-])(\d{1,2})/.exec(name);
  const off = m ? `${m[1]}${m[2].padStart(2, '0')}:00` : 'Z';
  return new Date(`${ymd}T00:00:00${off}`).toISOString();
}
function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function applyBranding() {
  const b = boot.branding;
  document.documentElement.style.setProperty('--main', b.mainColor);
  document.documentElement.style.setProperty('--accent', b.accentColor);
  document.getElementById('logo').src = b.logoDataUrl || '/vgo-logo.png';
  document.getElementById('brand-name').textContent = b.logoDataUrl ? b.programName : b.programName.replace(/^VGO\s+/i, '');
  document.title = `${b.programName} console`;
}

async function reload() {
  boot = await api('GET', '/bootstrap');
  applyBranding();
  showSignedIn(boot.me);
}

// ---------- sign-in ----------

function showSignedIn(me) {
  const store = me.role === 'store';
  document.body.classList.remove('signed-out');
  document.body.classList.toggle('store-user', store);
  document.getElementById('console-kind').textContent = store ? 'Store back office' : 'Jobber console';
  document.getElementById('who').textContent = `Signed in as ${me.name}`;
  const out = document.getElementById('signout');
  out.hidden = me.id === 'master' && !boot.signInRequired;
  out.onclick = async () => {
    await api('POST', '/logout');
    boot = null;
    showLogin();
  };
}

function showLogin() {
  if (document.body.classList.contains('signed-out') && main.querySelector('.login-card')) return;
  document.body.classList.add('signed-out');
  document.body.classList.remove('store-user');
  document.getElementById('who').textContent = '';
  document.getElementById('signout').hidden = true;
  if (dialog.open) closeDialog();
  const email = h('input', { type: 'text', autocomplete: 'username', required: true, autocapitalize: 'none' });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div', { role: 'alert' });
  main.replaceChildren(
    h(
      'form',
      {
        class: 'card pad login-card',
        onsubmit: async (e) => {
          e.preventDefault();
          err.replaceChildren();
          try {
            await api('POST', '/login', { email: email.value.trim(), password: password.value });
            await reload();
            render();
          } catch (ex) {
            err.replaceChildren(errorBox(ex));
          }
        },
      },
      h('h1', {}, 'Sign in'),
      h('p', { class: 'note' }, 'Use the email and password your VGO admin gave you. The master account signs in as "admin".'),
      h('label', { class: 'field' }, h('span', {}, 'Email'), email),
      h('label', { class: 'field' }, h('span', {}, 'Password'), password),
      err,
      h('button', { class: 'btn accent', type: 'submit' }, 'Sign in'),
    ),
  );
  email.focus();
}

function pageHead(title, lede, ...actions) {
  return h('header', { class: 'page-head' }, h('div', { class: 'intro' }, h('h1', {}, title), lede && h('span', { class: 'lede' }, lede)), ...actions);
}

const plusIcon = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', '18');
  s.setAttribute('height', '18');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>';
  return s;
};

// ---------- Offers ----------

let offerFilter = { kind: 'all' };

function touches(rule, filter) {
  const s = rule.scope;
  if (filter.kind === 'all' || s.kind === 'all') return true;
  const storesIn = filter.kind === 'group' ? boot.stores.filter((st) => st.groupIds.includes(filter.id)) : boot.stores.filter((st) => st.id === filter.id);
  if (s.kind === 'groups') return storesIn.some((st) => st.groupIds.some((g) => s.groupIds.includes(g)));
  return storesIn.some((st) => s.storeIds.includes(st.id));
}

function renderOffers() {
  const order = ['Live', 'Scheduled', 'Paused', 'Ended', 'Draft'];
  const offers = boot.rules
    .filter((r) => r.section !== 'earn' && r.status !== 'retired' && touches(r, offerFilter))
    .sort((a, b) => Number(Boolean(b.welcome)) - Number(Boolean(a.welcome)) || order.indexOf(a.display.status) - order.indexOf(b.display.status));
  const pill = (label, filter) =>
    h(
      'button',
      {
        class: `pill${JSON.stringify(filter) === JSON.stringify(offerFilter) ? ' on' : ''}`,
        onclick: () => {
          offerFilter = filter;
          render();
        },
      },
      label,
    );
  const storeSelect = h(
    'select',
    {
      class: `pill${offerFilter.kind === 'store' ? ' on' : ''}`,
      'aria-label': 'One store',
      onchange: (e) => {
        offerFilter = e.target.value ? { kind: 'store', id: e.target.value } : { kind: 'all' };
        render();
      },
    },
    h('option', { value: '' }, 'One store…'),
    boot.stores.map((s) => h('option', { value: s.id, selected: offerFilter.id === s.id }, s.name)),
  );
  const stacking =
    boot.settings.fuelStacking.mode === 'best'
      ? 'at most one fuel discount per fill-up, and the largest one wins.'
      : `fuel discounts add up to ${boot.settings.fuelStacking.maxCentsPerGallon}¢/gal per fill-up.`;
  const retired = boot.rules.filter((r) => r.section !== 'earn' && r.status === 'retired').length;

  main.replaceChildren(
    pageHead(
      'Offers',
      `Every offer targets one store, a store group, or all ${boot.stores.length} stores.`,
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => tryVisitDialog() }, 'Try a visit'), h('a', { class: 'btn accent', href: '#/offers/new' }, plusIcon(), 'New offer')),
    ),
    h(
      'div',
      { class: 'pills' },
      h('span', { class: 'note' }, 'Show offers for'),
      pill(isAdmin() ? 'Whole portfolio' : 'All my locations', { kind: 'all' }),
      boot.groups.map((g) => pill(g.name, { kind: 'group', id: g.id })),
      storeSelect,
    ),
    h(
      'div',
      { class: 'card table-wrap' },
      h(
        'table',
        { style: 'min-width: 900px' },
        h('thead', {}, h('tr', {}, ['Offer', 'Type', 'Target', 'Funded by', 'Runs', 'Status'].map((t) => h('th', {}, t)))),
        h(
          'tbody',
          {},
          offers.length
            ? offers.map((r) =>
                h(
                  'tr',
                  { class: 'click', tabindex: 0, onclick: () => (location.hash = `#/offers/${r.id}`), onkeydown: (e) => e.key === 'Enter' && (location.hash = `#/offers/${r.id}`) },
                  h(
                    'td',
                    { class: 'strong' },
                    h('div', { class: 'offer-name' }, h('div', { class: 'thumb' }, artFrame({ imageUrl: r.display.imageUrl, headline: r.display.headline, kind: r.display.artKind })), h('span', {}, r.name, r.featured && h('span', { class: 'feat' }, 'Featured'))),
                  ),
                  h('td', {}, r.display.type),
                  h('td', {}, r.display.target),
                  h('td', {}, r.display.funded),
                  h('td', {}, r.display.runs),
                  h('td', {}, h('span', { class: `badge ${r.display.status}` }, r.display.status)),
                ),
              )
            : h('tr', {}, h('td', { colspan: 6, class: 'note' }, 'No offers for this selection yet.')),
        ),
      ),
    ),
    h(
      'p',
      { class: 'note' },
      `Stacking rule: ${stacking} Fuel discounts can only be created by the jobber. Store managers can create store-only offers within the limits you set.`,
      retired ? ` ${retired} retired ${retired === 1 ? 'offer is' : 'offers are'} hidden.` : '',
    ),
  );
}

// ---------- Create / edit offer ----------

const KINDS = [
  { id: 'fuel', title: 'Fuel discount', sub: 'Cents off per gallon' },
  { id: 'item', title: 'Item or basket', sub: 'Dollars or % off inside' },
  { id: 'punch', title: 'Punch card', sub: 'Buy N, get one free' },
  { id: 'points', title: 'Bonus points', sub: 'Extra points on items' },
];

function blankForm() {
  const today = localYmd(new Date().toISOString());
  return {
    id: null,
    section: 'offer',
    status: 'draft',
    kind: isAdmin() ? 'fuel' : 'item',
    name: '',
    memberText: '',
    centsPerGallon: 10,
    maxGallons: 20,
    costPoints: '',
    itemMode: 'cents',
    itemAmount: '1.00',
    categories: [],
    maxQty: 1,
    every: 5,
    pointsMode: 'flat',
    points: 100,
    minGallons: '',
    minSpend: '',
    grades: [],
    firstVisit: false,
    otherConditions: [],
    fundedBy: isAdmin() ? 'jobber' : 'store',
    scopeKind: 'stores',
    storeIds: [isAdmin() ? boot.pilot.storeId : boot.stores[0]?.id].filter(Boolean),
    groupIds: [],
    starts: today,
    ends: '',
    days: [],
    hoursFrom: '',
    hoursTo: '',
    limitCount: '',
    limitPeriod: 'day',
    budget: '',
    stackingGroup: undefined,
    priority: undefined,
    welcome: false,
    requiresClip: false,
    geofence: false,
    radiusMiles: 1,
    mediaId: null,
    headline: '',
    featured: false,
  };
}

function formFromRule(rule) {
  const f = blankForm();
  const e = rule.effect;
  Object.assign(f, {
    id: rule.id ?? null,
    section: rule.section,
    status: rule.status,
    name: rule.name,
    memberText: rule.memberText ?? '',
    fundedBy: rule.fundedBy,
    stackingGroup: rule.stackingGroup,
    priority: rule.priority,
    welcome: rule.welcome ?? false,
    requiresClip: rule.requiresClip ?? false,
    geofence: Boolean(rule.geofence),
    radiusMiles: rule.geofence?.radiusMiles ?? 1,
    mediaId: rule.artwork?.mediaId ?? null,
    headline: rule.headline ?? '',
    featured: rule.featured ?? false,
    starts: rule.schedule?.startsAt ? localYmd(rule.schedule.startsAt) : '',
    ends: rule.schedule?.endsAt ? addDaysYmd(localYmd(rule.schedule.endsAt), -1) : '',
    days: rule.schedule?.daysOfWeek ?? [],
    hoursFrom: rule.schedule?.hours?.from ?? '',
    hoursTo: rule.schedule?.hours?.to ?? '',
    limitCount: rule.perMemberLimit?.count ?? '',
    limitPeriod: rule.perMemberLimit?.period ?? 'day',
    budget: rule.monthlyBudgetCents ? (rule.monthlyBudgetCents / 100).toFixed(2) : '',
    scopeKind: rule.scope.kind,
    storeIds: rule.scope.kind === 'stores' ? rule.scope.storeIds : [],
    groupIds: rule.scope.kind === 'groups' ? rule.scope.groupIds : [],
  });
  f.otherConditions = [];
  for (const c of rule.conditions) {
    if (c.type === 'minGallons') f.minGallons = c.gallons;
    else if (c.type === 'minInsideSpend') f.minSpend = (c.cents / 100).toFixed(2);
    else if (c.type === 'fuelGrade') f.grades = c.grades;
    else if (c.type === 'firstVisit') f.firstVisit = true;
    else if (c.type === 'hasItem' && (e.type === 'itemDiscount' || e.type === 'basketDiscount')) {
      // "Buy X" qualifiers on item discounts are rebuilt from the discounted items.
      if (e.type === 'basketDiscount') f.otherConditions.push(c);
    } else f.otherConditions.push(c);
  }
  switch (e.type) {
    case 'fuelDiscount':
      Object.assign(f, { kind: 'fuel', centsPerGallon: e.centsPerGallon, maxGallons: e.maxGallons, costPoints: e.costPoints ?? '' });
      break;
    case 'itemDiscount':
      Object.assign(f, {
        kind: 'item',
        categories: e.categories ?? [],
        maxQty: e.maxQty,
        costPoints: e.costPoints ?? '',
        itemMode: e.percentOff === 100 ? 'free' : e.percentOff !== undefined ? 'percent' : 'cents',
        itemAmount: e.percentOff !== undefined ? String(e.percentOff) : ((e.centsOff ?? 0) / 100).toFixed(2),
      });
      break;
    case 'basketDiscount':
      Object.assign(f, { kind: 'item', categories: [], itemMode: 'cents', itemAmount: (e.centsOff / 100).toFixed(2) });
      break;
    case 'punchCard':
      Object.assign(f, { kind: 'punch', categories: e.categories ?? [], every: e.every, cardId: e.cardId });
      break;
    case 'pointsFlat':
      Object.assign(f, { kind: 'points', pointsMode: 'flat', points: e.points });
      break;
    case 'pointsPerDollar':
      Object.assign(f, { kind: 'points', pointsMode: 'dollar', points: e.points, categories: e.categories ?? [], exclude: e.excludeCategories });
      break;
    case 'pointsPerGallon':
      Object.assign(f, { kind: 'points', pointsMode: 'gallon', points: e.points, maxGallons: e.maxGallons ?? '' });
      break;
  }
  return f;
}

function ruleFromForm(f) {
  const num = (v) => (v === '' || v === undefined || v === null ? undefined : Number(v));
  const conditions = [...f.otherConditions];
  let effect;
  switch (f.kind) {
    case 'fuel':
      effect = { type: 'fuelDiscount', centsPerGallon: num(f.centsPerGallon), maxGallons: num(f.maxGallons) };
      if (num(f.costPoints)) effect.costPoints = num(f.costPoints);
      break;
    case 'item':
      if (!f.categories.length) {
        effect = { type: 'basketDiscount', centsOff: dollarsToCents(f.itemAmount) };
      } else {
        effect = { type: 'itemDiscount', categories: f.categories, maxQty: num(f.maxQty) ?? 1 };
        if (f.itemMode === 'free') effect.percentOff = 100;
        else if (f.itemMode === 'percent') effect.percentOff = num(f.itemAmount);
        else effect.centsOff = dollarsToCents(f.itemAmount);
        if (num(f.costPoints)) effect.costPoints = num(f.costPoints);
        // The member has to buy the item for it to be discounted.
        else conditions.push({ type: 'hasItem', categories: f.categories });
      }
      break;
    case 'punch':
      effect = { type: 'punchCard', cardId: f.cardId || `card-${f.categories.join('-') || 'items'}`, categories: f.categories, every: num(f.every) };
      break;
    case 'points':
      if (f.pointsMode === 'flat') effect = { type: 'pointsFlat', points: num(f.points) };
      else if (f.pointsMode === 'gallon') effect = { type: 'pointsPerGallon', points: num(f.points), ...(num(f.maxGallons) ? { maxGallons: num(f.maxGallons) } : {}) };
      else effect = { type: 'pointsPerDollar', points: num(f.points), ...(f.categories.length ? { categories: f.categories } : { excludeCategories: f.exclude ?? ['tobacco', 'lottery', 'gift-cards'] }) };
      break;
  }
  if (num(f.minGallons)) conditions.push({ type: 'minGallons', gallons: num(f.minGallons) });
  if (num(f.minSpend)) conditions.push({ type: 'minInsideSpend', cents: dollarsToCents(f.minSpend), excludeCategories: ['tobacco', 'lottery', 'gift-cards'] });
  if (f.grades.length) conditions.push({ type: 'fuelGrade', grades: f.grades });
  if (f.firstVisit) conditions.push({ type: 'firstVisit' });

  const schedule = {};
  if (f.starts) schedule.startsAt = localMidnightIso(f.starts);
  if (f.ends) schedule.endsAt = localMidnightIso(addDaysYmd(f.ends, 1));
  if (f.days.length && f.days.length < 7) schedule.daysOfWeek = [...f.days].sort();
  if (f.hoursFrom !== '' && f.hoursTo !== '') schedule.hours = { from: Number(f.hoursFrom), to: Number(f.hoursTo) };

  const scope =
    f.scopeKind === 'all' ? { kind: 'all' } : f.scopeKind === 'groups' ? { kind: 'groups', groupIds: f.groupIds } : { kind: 'stores', storeIds: f.storeIds };

  const rule = {
    name: f.name.trim(),
    section: f.section,
    status: f.status,
    scope,
    conditions,
    effect,
    fundedBy: f.fundedBy,
    // null clears a field that was set before.
    schedule: Object.keys(schedule).length ? schedule : null,
    perMemberLimit: num(f.limitCount) ? { count: num(f.limitCount), period: f.limitPeriod } : null,
    monthlyBudgetCents: f.budget ? dollarsToCents(f.budget) : null,
    memberText: f.memberText.trim() || null,
    stackingGroup: f.stackingGroup ?? null,
    priority: f.priority ?? null,
    welcome: f.welcome || null,
    requiresClip: f.requiresClip || (f.section === 'offer' && f.geofence) || null,
    geofence: f.section === 'offer' && f.geofence ? { radiusMiles: Number(f.radiusMiles) } : null,
    artwork: f.mediaId ? { mediaId: f.mediaId } : null,
    headline: f.headline.trim() || null,
    featured: f.featured || null,
  };
  if (f.id) rule.id = f.id;
  return rule;
}

let form = null;
let checkTimer = null;

function renderOfferForm(id) {
  const existing = id && id !== 'new' ? boot.rules.find((r) => r.id === id) : null;
  if (id && id !== 'new' && !existing) {
    main.replaceChildren(pageHead('Offer not found'), h('a', { href: '#/offers' }, 'Back to offers'));
    return;
  }
  if (!form || form._for !== id) {
    form = existing ? formFromRule(existing) : pendingDraft ? formFromRule(pendingDraft) : blankForm();
    form._for = id;
    form._fromDraft = Boolean(pendingDraft && !existing);
    pendingDraft = null;
  }
  const f = form;
  const aside = h('aside', {});
  const errors = h('div', {});
  const set = (patch, rerender = false) => {
    Object.assign(f, patch);
    if (rerender) renderOfferForm(id);
    else scheduleCheck();
  };
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint && h('small', { class: 'note' }, hint));
  const text = (key, attrs = {}) => h('input', { type: 'text', value: f[key] ?? '', oninput: (e) => set({ [key]: e.target.value }), ...attrs });
  const number = (key, attrs = {}) => h('input', { type: 'number', min: 0, value: f[key] ?? '', oninput: (e) => set({ [key]: e.target.value }), ...attrs });
  const toggles = (key, options) =>
    h(
      'div',
      { class: 'pills' },
      options.map((o) =>
        h(
          'button',
          {
            type: 'button',
            class: `pill${f[key].includes(o.value) ? ' on' : ''}`,
            'aria-pressed': f[key].includes(o.value),
            onclick: () => set({ [key]: f[key].includes(o.value) ? f[key].filter((x) => x !== o.value) : [...f[key], o.value] }, true),
          },
          o.label,
        ),
      ),
    );
  const pills = (key, options) =>
    h(
      'div',
      { class: 'pills', role: 'radiogroup' },
      options.map((o) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': f[key] === o.value, class: `pill${f[key] === o.value ? ' on' : ''}`, onclick: () => set({ [key]: o.value }, true) }, o.label),
      ),
    );
  const itemOptions = boot.categories.filter((c) => !['tobacco', 'lottery', 'gift-cards'].includes(c.id)).map((c) => ({ label: c.label, value: c.id }));

  // Step 2 fields per kind.
  let reward;
  if (f.kind === 'fuel') {
    reward = [
      h('div', { class: 'grid2' }, field('Cents off per gallon', number('centsPerGallon', { min: 1 })), field('Up to how many gallons', number('maxGallons', { min: 1 }))),
      h(
        'div',
        { class: 'grid2' },
        field('Requires fuel grade', h('div', {}, toggles('grades', boot.grades.map((g) => ({ label: g.label, value: g.id }))))),
        field('Costs points (optional)', number('costPoints'), 'Leave empty for a free offer. With points, members choose it in the app.'),
      ),
    ];
  } else if (f.kind === 'item') {
    reward = [
      h(
        'div',
        { class: 'grid2' },
        field(
          'Discount',
          h(
            'div',
            { class: 'row' },
            h(
              'select',
              { onchange: (e) => set({ itemMode: e.target.value }, true), 'aria-label': 'Discount type' },
              [
                ['cents', '$ off'],
                ['percent', '% off'],
                ['free', 'Free'],
              ].map(([v, l]) => h('option', { value: v, selected: f.itemMode === v }, l)),
            ),
            f.itemMode !== 'free' && text('itemAmount', { style: 'width: 110px', 'aria-label': f.itemMode === 'percent' ? 'Percent off' : 'Dollars off' }),
          ),
        ),
        field('Max items per visit', number('maxQty', { min: 1 })),
      ),
      field('On items in', toggles('categories', itemOptions), 'Pick none for money off the whole inside purchase.'),
      field('Costs points (optional)', number('costPoints'), 'Leave empty for a free offer.'),
    ];
  } else if (f.kind === 'punch') {
    reward = [
      field('Items that earn a punch', toggles('categories', itemOptions)),
      field('Buy how many, then one free', number('every', { min: 1, max: 50 })),
    ];
  } else {
    reward = [
      field(
        'Bonus',
        h(
          'div',
          { class: 'row' },
          number('points', { min: 1, style: 'width: 110px', 'aria-label': 'Points' }),
          h(
            'select',
            { onchange: (e) => set({ pointsMode: e.target.value }, true), 'aria-label': 'Points per' },
            [
              ['flat', 'points per visit'],
              ['dollar', 'points per $1'],
              ['gallon', 'points per gallon'],
            ].map(([v, l]) => h('option', { value: v, selected: f.pointsMode === v }, l)),
          ),
        ),
      ),
      f.pointsMode === 'dollar' && field('On items in', toggles('categories', itemOptions), 'Pick none for all inside purchases except tobacco, lottery and gift cards.'),
      f.pointsMode === 'gallon' && field('Requires fuel grade', toggles('grades', boot.grades.map((g) => ({ label: g.label, value: g.id })))),
    ];
  }

  const storeRows = boot.stores.map((s) =>
    h(
      'label',
      {},
      h('input', {
        type: 'checkbox',
        checked: f.storeIds.includes(s.id),
        onchange: (e) => set({ storeIds: e.target.checked ? [...new Set([...f.storeIds, s.id])] : f.storeIds.filter((x) => x !== s.id) }),
      }),
      h('div', { class: 'grow' }, h('div', { style: 'font-weight:600' }, `${s.name}${s.city ? ` · ${s.city}, ${s.state}` : ` · ${s.state}`}`), h('div', { class: 'meta' }, posLabel(s.pos))),
      s.loyaltyLive ? h('span', { class: 'live-dot' }, 'Loyalty live') : h('span', { class: 'off-dot' }, 'Not enabled yet'),
    ),
  );
  const groupRows = boot.groups.map((g) =>
    h(
      'label',
      {},
      h('input', { type: 'checkbox', checked: f.groupIds.includes(g.id), onchange: (e) => set({ groupIds: e.target.checked ? [...f.groupIds, g.id] : f.groupIds.filter((x) => x !== g.id) }) }),
      h('div', { class: 'grow', style: 'font-weight:600' }, g.name),
      h('span', { class: 'meta' }, `${boot.stores.filter((s) => s.groupIds.includes(g.id)).length} stores`),
    ),
  );

  const save = async (status) => {
    errors.replaceChildren();
    const rule = ruleFromForm({ ...f, status: status ?? f.status });
    if (rule.status !== 'draft' && !(await confirmDiscounts([rule]))) return;
    try {
      const saved = existing ? await api('PUT', `/rules/${existing.id}`, rule) : await api('POST', '/rules', rule);
      await reload();
      form = null;
      toast(existing ? 'Saved' : status === 'draft' ? 'Saved as a draft' : status === 'paused' ? 'Added as a paused rule' : 'Offer scheduled');
      location.hash = saved.section === 'offer' ? '#/offers' : '#/rules';
    } catch (err) {
      errors.replaceChildren(errorBox(err));
      errors.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };
  const setStatus = async (status) => {
    if (status === 'active' && !(await confirmDiscounts([existing]))) return;
    try {
      await api('POST', `/rules/${existing.id}/status`, { status });
      await reload();
      form = null;
      toast(`Offer ${status === 'active' ? 'turned on' : status}`);
      renderOfferForm(id);
    } catch (err) {
      errors.replaceChildren(errorBox(err));
    }
  };

  const actions = existing
    ? h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn accent', onclick: () => save() }, 'Save changes'),
        existing.status !== 'active' && h('button', { class: 'btn', onclick: () => setStatus('active') }, existing.status === 'draft' ? 'Schedule offer' : 'Turn on'),
        existing.status === 'active' && h('button', { class: 'btn ghost', onclick: () => setStatus('paused') }, 'Pause'),
        existing.status !== 'retired' && !existing.welcome && h('button', { class: 'link', onclick: () => confirm(`Retire "${existing.name}"? Members stop seeing it.`) && setStatus('retired') }, 'Retire'),
      )
    : f._fromDraft
      ? h('div', { class: 'row' }, h('button', { class: 'btn accent', onclick: () => save('paused') }, 'Add as a paused rule'))
      : h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => save('draft') }, 'Save draft'), h('button', { class: 'btn accent', onclick: () => save('active') }, 'Schedule offer'));

  const backHref = f.section === 'offer' ? '#/offers' : '#/rules';
  main.replaceChildren(
    h('a', { href: backHref }, f.section === 'offer' ? 'Back to offers' : 'Back to reward rules'),
    pageHead(existing ? existing.name : f._fromDraft ? 'Adjust drafted rule' : 'New offer', existing ? `${existing.display.type} · ${existing.display.status}` : ''),
    h(
      'div',
      { class: 'create' },
      h(
        'div',
        { class: 'form' },
        h(
          'section',
          { class: 'card pad step' },
          h('h2', {}, '1. What kind of offer'),
          h(
            'div',
            { class: 'choice-grid' },
            KINDS.map((k) =>
              h('button', { type: 'button', class: `choice${f.kind === k.id ? ' on' : ''}`, 'aria-pressed': f.kind === k.id, onclick: () => set({ kind: k.id }, true) }, h('b', {}, k.title), h('small', {}, k.sub)),
            ),
          ),
        ),
        h(
          'section',
          { class: 'card pad step' },
          h('h2', {}, '2. Reward and qualifier'),
          field('Offer name members see', text('name', { maxlength: 80, placeholder: 'e.g. $1 off any sandwich with a fill-up' })),
          reward,
          h(
            'div',
            { class: 'grid2' },
            f.kind !== 'fuel' && !(f.kind === 'points' && f.pointsMode === 'gallon') && field('Requires fuel of at least (gallons)', number('minGallons', { step: '0.1' }), 'Optional'),
            field('Requires inside spend of at least ($)', text('minSpend', { inputmode: 'decimal', placeholder: 'Optional' })),
          ),
          h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: f.firstVisit, onchange: (e) => set({ firstVisit: e.target.checked }) }), 'Only on a member’s first visit'),
          f.section === 'offer' &&
            h(
              'label',
              { class: 'row' },
              h('input', { type: 'checkbox', checked: f.requiresClip, onchange: (e) => set({ requiresClip: e.target.checked }) }),
              'Members add it to their card in the app first',
            ),
          f.otherConditions.length > 0 && h('p', { class: 'note' }, `Also keeps ${f.otherConditions.length} other qualifier${f.otherConditions.length > 1 ? 's' : ''} set earlier.`),
          field('Line members see under the name (optional)', h('textarea', { maxlength: 140, oninput: (e) => set({ memberText: e.target.value }) }, f.memberText)),
          !isAdmin() && h('p', { class: 'note' }, 'Your store pays for offers you create. They run on top of the corporate program.'),
          isAdmin() &&
          field(
            'Who pays for the discount',
            pills('fundedBy', [
              { label: 'Jobber', value: 'jobber' },
              { label: 'Store', value: 'store' },
              { label: 'Split 50/50', value: 'split' },
              { label: 'Manufacturer', value: 'manufacturer' },
            ]),
          ),
        ),
        h(
          'section',
          { class: 'card pad step' },
          h('h2', {}, '3. Where it runs'),
          isAdmin() &&
          h(
            'div',
            { class: 'pills', role: 'radiogroup' },
            [
              ['stores', 'Stores'],
              ['groups', 'Store group'],
              ['all', `All ${boot.stores.length} stores`],
            ].map(([v, l]) =>
              h('button', { type: 'button', role: 'radio', 'aria-checked': f.scopeKind === v, class: `pill${f.scopeKind === v ? ' on' : ''}`, onclick: () => set({ scopeKind: v }, true) }, l),
            ),
          ),
          f.scopeKind === 'stores' && h('div', { class: 'store-pick' }, storeRows),
          f.scopeKind === 'groups' && h('div', { class: 'store-pick' }, groupRows),
          f.section === 'offer' &&
            h(
              'label',
              { class: 'row' },
              h('input', { type: 'checkbox', checked: f.geofence, onchange: (e) => set({ geofence: e.target.checked, ...(e.target.checked ? { requiresClip: true } : {}) }, true) }),
              'Near-store promo (geofence)',
            ),
          f.section === 'offer' &&
            f.geofence &&
            h(
              'div',
              { class: 'geo-box' },
              field(
                'How close',
                h(
                  'select',
                  { onchange: (e) => set({ radiusMiles: Number(e.target.value) }) },
                  [0.25, 0.5, 1, 2, 3, 5, 10].map((mi) => h('option', { value: mi, selected: Number(f.radiusMiles) === mi }, `Within ${mi} ${mi === 1 ? 'mile' : 'miles'}`)),
                ),
              ),
              h(
                'p',
                { class: 'note' },
                'Members see it in the app when their phone is within this distance, add it to their card there, and redeem it at the register by scanning their barcode or typing their phone. Each store needs a map location on the Locations page.',
              ),
            ),
          h('p', { class: 'note' }, 'Stores without loyalty enabled keep the offer saved and start it once their POS is connected.'),
        ),
        h(
          'section',
          { class: 'card pad step' },
          h('h2', {}, '4. When and limits'),
          h(
            'div',
            { class: 'grid2' },
            field('Starts', h('input', { type: 'date', value: f.starts, oninput: (e) => set({ starts: e.target.value }) }), 'Empty starts it as soon as it is on.'),
            field('Ends', h('input', { type: 'date', value: f.ends, oninput: (e) => set({ ends: e.target.value }) }), 'Last day it runs. Empty runs until you end it.'),
          ),
          field(
            'Days',
            toggles(
              'days',
              ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => ({ label: d, value: i })),
            ),
            'Pick none for every day.',
          ),
          h(
            'div',
            { class: 'grid2' },
            field(
              'Hours (optional)',
              h(
                'div',
                { class: 'row' },
                hourSelect(f.hoursFrom, (v) => set({ hoursFrom: v }), 'From'),
                'to',
                hourSelect(f.hoursTo, (v) => set({ hoursTo: v }), 'To', true),
              ),
            ),
            field(
              'Uses per member',
              h(
                'div',
                { class: 'row' },
                number('limitCount', { style: 'width: 90px', placeholder: 'Any', 'aria-label': 'Uses' }),
                h(
                  'select',
                  { onchange: (e) => set({ limitPeriod: e.target.value }), 'aria-label': 'Per' },
                  [
                    ['day', 'per day'],
                    ['week', 'per week'],
                    ['month', 'per month'],
                    ['lifetime', 'ever'],
                  ].map(([v, l]) => h('option', { value: v, selected: f.limitPeriod === v }, l)),
                ),
              ),
            ),
            field('Budget cap per month ($)', text('budget', { inputmode: 'decimal', placeholder: 'No cap' }), 'Stops the discount once it has cost this much in a month.'),
          ),
        ),
        artSection(f, set),
        errors,
        actions,
      ),
      aside,
    ),
  );

  async function check() {
    const rule = ruleFromForm(f);
    try {
      const res = await api('POST', '/rules/check', rule);
      const v = res.view;
      aside.replaceChildren(
        h(
          'section',
          { class: 'card pad step' },
          h('h2', {}, 'How it looks in the app'),
          h(
            'div',
            { class: 'app-card' },
            artFrame({ imageUrl: f.mediaId ? `/media/${f.mediaId}` : null, headline: v?.display.headline ?? (f.headline || 'YOUR DEAL'), kind: v?.display.artKind ?? 'other', name: rule.name }),
            h(
              'div',
              { class: 'app-card-body' },
              h('span', { class: 'kicker' }, v ? `${v.display.type} · ${v.display.target}` : 'Offer'),
              h('span', { class: 'title' }, rule.name || 'Offer name'),
              h('span', { class: 'line' }, v ? v.display.memberLine : ''),
              v && h('span', { class: 'tag' }, v.display.runs),
            ),
          ),
        ),
        h(
          'section',
          { class: 'card pad step' },
          h('h2', {}, 'Checks'),
          h(
            'ul',
            { class: 'checks' },
            res.blockers.map((b) => h('li', { class: 'no' }, b)),
            res.checks.map((c) => h('li', { class: c.ok ? 'ok' : 'no' }, c.text)),
          ),
        ),
      );
    } catch (err) {
      aside.replaceChildren(errorBox(err));
    }
  }
  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(check, 250);
  }
  check();
}

function hourSelect(value, onChange, label, isEnd) {
  const opts = [h('option', { value: '' }, '—')];
  for (let i = isEnd ? 1 : 0; i <= (isEnd ? 24 : 23); i++) {
    const l = i === 0 || i === 24 ? 'midnight' : i === 12 ? 'noon' : i < 12 ? `${i}am` : `${i - 12}pm`;
    opts.push(h('option', { value: i, selected: value !== '' && Number(value) === i }, l));
  }
  return h('select', { 'aria-label': label, onchange: (e) => onChange(e.target.value) }, opts);
}

// ---------- Reward rules ----------

let pendingDraft = null; // a drafted rule handed to the form via Adjust
let ruleEdits = {}; // rule id -> edited rule, saved with "Save changes"
let settingsEdits = {};
let brandingEdits = {};
let lastDraft = null;

const CUSTOM = '__custom';

/** A dropdown of preset values plus Custom…, which swaps in a number box. */
function presetSelect({ value, options, onChange, label, suffix = '', custom = true }) {
  const known = options.some((o) => JSON.stringify(o.value) === JSON.stringify(value));
  const wrap = h('span', { class: 'row', style: 'gap:6px' });
  const select = h(
    'select',
    {
      'aria-label': label,
      onchange: (e) => {
        if (e.target.value === CUSTOM) {
          wrap.replaceChildren(select, numberBox());
          wrap.querySelector('input').focus();
        } else onChange(JSON.parse(e.target.value));
      },
    },
    options.map((o) => h('option', { value: JSON.stringify(o.value), selected: JSON.stringify(o.value) === JSON.stringify(value) }, o.label)),
    custom && h('option', { value: CUSTOM, selected: !known }, known ? 'Custom…' : `Custom: ${value}${suffix}`),
  );
  const numberBox = () =>
    h('input', {
      class: 'n',
      type: 'number',
      min: 0,
      'aria-label': `${label}, custom`,
      value: known ? '' : value,
      oninput: (e) => e.target.value !== '' && onChange(Number(e.target.value)),
    });
  wrap.append(select);
  if (!known && custom) wrap.append(numberBox());
  return wrap;
}

function editedRule(rule) {
  return ruleEdits[rule.id] ?? rule;
}
function editRule(rule, change) {
  const base = structuredClone(editedRule(rule));
  change(base);
  ruleEdits[rule.id] = base;
  document.getElementById(`rule-${rule.id}`)?.classList.add('dirty');
  updateSaveBar();
}

function sentenceFor(rule) {
  const r = editedRule(rule);
  const e = r.effect;
  const P = boot.presets;
  const opts = (xs, unit = '') => xs.map((x) => ({ label: `${x}${unit}`, value: x }));
  const set = (fn) => (v) => editRule(rule, (x) => fn(x, v));
  if (e.type === 'pointsPerDollar') {
    return [
      'Earn',
      presetSelect({ label: 'Points earned', value: e.points, options: opts(P.pointsPerDollar), onChange: set((x, v) => (x.effect.points = v)) }),
      e.points === 1 ? 'point per $1' : 'points per $1',
      e.categories?.length
        ? `spent on ${e.categories.map(catLabel).join(', ').toLowerCase()}`
        : [
            'spent inside, except',
            presetSelect({ label: 'Not earning', value: e.excludeCategories ?? [], options: P.exclusions, custom: false, onChange: set((x, v) => (x.effect.excludeCategories = v)) }),
          ],
    ];
  }
  if (e.type === 'pointsPerGallon') {
    const grades = r.conditions.find((c) => c.type === 'fuelGrade')?.grades ?? [];
    const setGrades = set((x, v) => {
      x.conditions = x.conditions.filter((c) => c.type !== 'fuelGrade');
      if (v.length) x.conditions.push({ type: 'fuelGrade', grades: v });
    });
    const days = r.schedule?.daysOfWeek ?? [];
    const setDays = set((x, v) => {
      x.schedule = { ...(x.schedule ?? {}) };
      if (v.length) x.schedule.daysOfWeek = v;
      else delete x.schedule.daysOfWeek;
      if (!Object.keys(x.schedule).length) x.schedule = undefined;
    });
    return [
      'Earn',
      presetSelect({ label: 'Points per gallon', value: e.points, options: opts(P.pointsPerGallon), onChange: set((x, v) => (x.effect.points = v)) }),
      e.points === 1 ? 'point per gallon of' : 'points per gallon of',
      presetSelect({ label: 'Fuel grade', value: grades, options: P.fuelGrades, custom: false, onChange: setGrades }),
      'on',
      P.days.some((d) => JSON.stringify(d.value) === JSON.stringify(days))
        ? presetSelect({ label: 'Days', value: days, options: P.days, custom: false, onChange: setDays })
        : h('span', { class: 'chip' }, days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')),
    ];
  }
  if (e.type === 'fuelDiscount' && e.costPoints) {
    return [
      presetSelect({ label: 'Points required', value: e.costPoints, options: opts(P.redeemFuelPoints), onChange: set((x, v) => (x.effect.costPoints = v)) }),
      'points =',
      presetSelect({ label: 'Cents off per gallon', value: e.centsPerGallon, options: opts(P.redeemFuelCents, '¢'), suffix: '¢', onChange: set((x, v) => (x.effect.centsPerGallon = v)) }),
      'off per gallon, up to',
      presetSelect({ label: 'Gallon cap', value: e.maxGallons, options: opts(P.gallonCaps), onChange: set((x, v) => (x.effect.maxGallons = v)) }),
      'gallons',
    ];
  }
  if (e.type === 'itemDiscount' && e.costPoints && e.percentOff === 100 && e.categories?.length === 1) {
    return [
      presetSelect({ label: 'Points required for item', value: e.costPoints, options: opts(P.redeemItemPoints), onChange: set((x, v) => (x.effect.costPoints = v)) }),
      'points = a free',
      presetSelect({
        label: 'Item',
        value: e.categories[0],
        options: P.items.map((i) => ({ label: i.label.replace(/s$/, '').toLowerCase(), value: i.value })),
        custom: false,
        onChange: set((x, v) => (x.effect.categories = [v])),
      }),
    ];
  }
  return [r.display?.reward ?? rule.display.reward];
}

function ruleRow(rule) {
  const on = rule.status === 'active';
  return h(
    'article',
    { class: `card rule-row${on ? '' : ' off'}${ruleEdits[rule.id] ? ' dirty' : ''}`, id: `rule-${rule.id}` },
    h(
      'label',
      { class: 'toggle' },
      h('input', {
        type: 'checkbox',
        checked: on,
        'aria-label': `${rule.name} on or off`,
        onchange: async (e) => {
          if (e.target.checked && !(await confirmDiscounts([rule]))) {
            e.target.checked = false;
            return;
          }
          try {
            await api('POST', `/rules/${rule.id}/status`, { status: e.target.checked ? 'active' : 'paused' });
            await reload();
            toast(`${rule.name} ${e.target.checked ? 'on' : 'off'}`);
            render();
          } catch (err) {
            e.target.checked = !e.target.checked;
            toast(err.message);
          }
        },
      }),
      on ? 'On' : 'Off',
    ),
    // Each word chunk gets its own span so flex gaps space them.
    h('div', { class: 'sentence' }, [sentenceFor(rule)].flat(Infinity).map((x) => (typeof x === 'string' ? h('span', {}, x) : x))),
    h('span', { class: 'target' }, rule.display.target, rule.display.runs !== 'Always on' ? ` · ${rule.display.runs}` : ''),
    h('a', { href: `#/offers/${rule.id}` }, 'Edit'),
  );
}

function updateSaveBar() {
  const n = Object.keys(ruleEdits).length + Object.keys(settingsEdits).length + Object.keys(brandingEdits).length;
  const btn = document.getElementById('save-rules');
  if (btn) {
    btn.disabled = n === 0;
    btn.textContent = n ? `Save changes (${n})` : 'Save changes';
  }
}

function drafterSection() {
  const input = h('input', {
    id: 'describe',
    class: 'big-input',
    type: 'text',
    value: lastDraft?.text ?? '',
    placeholder: boot.draftExamples[0],
    onkeydown: (e) => e.key === 'Enter' && build(),
  });
  const out = h('div', {});
  async function build() {
    const text = input.value.trim();
    if (!text) return input.focus();
    const res = await api('POST', '/rules/draft', { text });
    lastDraft = { text, res };
    show();
  }
  function show() {
    const res = lastDraft?.res;
    if (!res) return out.replaceChildren();
    if (!res.ok) return out.replaceChildren(h('div', { class: 'notice' }, res.error));
    out.replaceChildren(
      h(
        'div',
        { class: 'drafted' },
        h('span', { class: 'section-label' }, 'Drafted rule'),
        res.chips.map((c) => h('span', { class: 'chip' }, c)),
        h('div', { class: 'grow' }),
        h(
          'button',
          {
            class: 'link',
            onclick: () => {
              pendingDraft = res.rule;
              form = null;
              location.hash = '#/offers/new';
            },
          },
          'Adjust',
        ),
        h(
          'button',
          {
            class: 'btn accent',
            onclick: async () => {
              try {
                await api('POST', '/rules', res.rule);
                lastDraft = null;
                await reload();
                toast('Added as a paused rule');
                render();
              } catch (err) {
                out.append(errorBox(err));
              }
            },
          },
          'Add as a paused rule',
        ),
      ),
      res.notes.length ? h('ul', { class: 'note' }, res.notes.map((n) => h('li', {}, n))) : null,
    );
  }
  show();
  return h(
    'section',
    { class: 'card pad drafter' },
    h('label', { for: 'describe' }, 'Describe a rule in your own words'),
    h('div', { class: 'row' }, input, h('button', { class: 'btn', style: 'flex: 1 1 140px; min-height: 48px', onclick: build }, 'Build rule')),
    h(
      'div',
      { class: 'examples' },
      h('span', { class: 'note' }, 'Try:'),
      boot.draftExamples.slice(1).map((ex) =>
        h(
          'button',
          {
            type: 'button',
            onclick: () => {
              input.value = ex;
              build();
            },
          },
          ex,
        ),
      ),
    ),
    out,
    h('span', { class: 'note' }, 'Nothing goes live until you review the drafted rule and turn it on.'),
  );
}

const TEMPLATES = [
  { label: 'Earn points per $1 inside', section: 'earn', name: 'Points on inside purchases', effect: { type: 'pointsPerDollar', points: 1, excludeCategories: ['tobacco', 'lottery', 'gift-cards'] }, stackingGroup: 'earn-dollar' },
  { label: 'Earn points per gallon', section: 'earn', name: 'Points on fuel', effect: { type: 'pointsPerGallon', points: 1 }, stackingGroup: 'earn-gallon' },
  { label: 'Bonus multiplier on a fuel grade', section: 'earn', name: '2x points on premium', effect: { type: 'pointsPerGallon', points: 2 }, conditions: [{ type: 'fuelGrade', grades: ['premium'] }], schedule: { daysOfWeek: [0, 6] }, stackingGroup: 'earn-gallon' },
  { label: 'Points for cents off fuel', section: 'redeem', name: '100 points = 10¢/gal', effect: { type: 'fuelDiscount', centsPerGallon: 10, maxGallons: 20, costPoints: 100 } },
  { label: 'Points for a free item', section: 'redeem', name: 'Free fountain drink for points', effect: { type: 'itemDiscount', categories: ['fountain'], percentOff: 100, maxQty: 1, costPoints: 300 } },
];

function addRuleDialog() {
  openDialog(
    h('h2', {}, 'Add rule'),
    h('p', { class: 'note' }, 'It starts paused with the pilot store as its target. Set the numbers, then turn it on.'),
    h(
      'div',
      { class: 'choice-grid' },
      TEMPLATES.map((t) =>
        h(
          'button',
          {
            class: 'choice',
            onclick: async () => {
              const { label, ...rest } = t;
              try {
                await api('POST', '/rules', { conditions: [], fundedBy: 'jobber', status: 'paused', scope: { kind: 'groups', groupIds: ['pilot'] }, ...rest });
                await reload();
                closeDialog();
                toast('Rule added, paused');
                render();
              } catch (err) {
                dialogBody.append(errorBox(err));
              }
            },
          },
          h('b', {}, label),
          h('small', {}, t.section === 'earn' ? 'Earn' : 'Redeem'),
        ),
      ),
    ),
    h('div', { class: 'row' }, h('div', { class: 'grow' }), h('button', { class: 'btn ghost', onclick: closeDialog }, 'Cancel')),
  );
}

function settingsSection() {
  const s = { ...boot.settings, ...settingsEdits };
  const b = { ...boot.branding, ...brandingEdits };
  const P = boot.presets;
  const welcome = boot.rules.find((r) => r.welcome);
  const setS = (patch) => {
    Object.assign(settingsEdits, patch);
    updateSaveBar();
  };
  const setB = (patch) => {
    Object.assign(brandingEdits, patch);
    applyPreviewBranding();
    updateSaveBar();
  };
  const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);

  let welcomeChoice = 'custom';
  if (welcome) {
    const e = editedRule(welcome).effect;
    if (e.type === 'fuelDiscount' && e.centsPerGallon === 25 && e.maxGallons === 20) welcomeChoice = 'fuel-25';
    else if (e.type === 'pointsFlat') welcomeChoice = 'points';
    else if (e.type === 'itemDiscount' && e.percentOff === 100) welcomeChoice = 'item';
  }
  const welcomeEffects = {
    'fuel-25': { type: 'fuelDiscount', centsPerGallon: 25, maxGallons: 20 },
    points: { type: 'pointsFlat', points: 100 },
    item: { type: 'itemDiscount', categories: ['fountain'], percentOff: 100, maxQty: 1 },
  };
  const welcomeNames = { 'fuel-25': 'Welcome: 25¢/gal off next fill-up', points: 'Welcome: 100 bonus points', item: 'Welcome: free fountain drink' };
  const welcomeField = welcome
    ? h(
        'span',
        { class: 'row', style: 'gap:6px' },
        h(
          'select',
          {
            'aria-label': 'Welcome reward',
            onchange: (e) => {
              if (e.target.value === CUSTOM) return (location.hash = `#/offers/${welcome.id}`);
              editRule(welcome, (x) => {
                x.effect = welcomeEffects[e.target.value];
                x.name = welcomeNames[e.target.value];
                x.memberText = undefined;
                x.conditions = x.conditions.filter((c) => c.type !== 'hasItem');
                if (x.effect.type === 'itemDiscount') x.conditions.push({ type: 'hasItem', categories: ['fountain'] });
              });
            },
          },
          P.welcome.map((o) => h('option', { value: o.value, selected: welcomeChoice === o.value }, o.label)),
          h('option', { value: CUSTOM, selected: welcomeChoice === 'custom' }, welcomeChoice === 'custom' ? `Custom: ${welcome.display.reward}` : 'Custom…'),
        ),
        h('a', { href: `#/offers/${welcome.id}` }, 'Edit'),
      )
    : h('span', { class: 'note' }, 'No welcome reward set.');

  const stackSelect = h(
    'span',
    { class: 'row', style: 'gap:6px' },
    h(
      'select',
      {
        'aria-label': 'Fuel discounts per fill-up',
        onchange: (e) => {
          setS({ fuelStacking: e.target.value === 'best' ? { mode: 'best' } : { mode: 'stack', maxCentsPerGallon: 50 } });
          render();
        },
      },
      h('option', { value: 'best', selected: s.fuelStacking.mode === 'best' }, 'One, largest wins'),
      h('option', { value: 'stack', selected: s.fuelStacking.mode === 'stack' }, 'Stack up to a cap'),
    ),
    s.fuelStacking.mode === 'stack' &&
      h('input', {
        type: 'number',
        min: 1,
        style: 'width: 90px',
        'aria-label': 'Cap, cents per gallon',
        value: s.fuelStacking.maxCentsPerGallon,
        oninput: (e) => setS({ fuelStacking: { mode: 'stack', maxCentsPerGallon: Number(e.target.value) } }),
      }),
    s.fuelStacking.mode === 'stack' && '¢/gal',
  );

  const logoImg = h('img', { src: b.logoDataUrl || '/vgo-logo.png', alt: 'Logo preview' });
  const fileInput = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/svg+xml,image/webp',
    class: 'sr',
    id: 'logo-file',
    onchange: (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 500_000) return toast('Logo must be under 500 KB');
      const reader = new FileReader();
      reader.onload = () => {
        setB({ logoDataUrl: reader.result });
        logoImg.src = reader.result;
      };
      reader.readAsDataURL(file);
    },
  });
  const colorField = (key, label) => {
    const hex = h('input', {
      type: 'text',
      value: b[key],
      'aria-label': `${label} hex`,
      oninput: (e) => {
        if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
          picker.value = e.target.value;
          setB({ [key]: e.target.value });
        }
      },
    });
    const picker = h('input', {
      type: 'color',
      value: b[key],
      'aria-label': label,
      oninput: (e) => {
        hex.value = e.target.value.toUpperCase();
        setB({ [key]: e.target.value.toUpperCase() });
      },
    });
    return field(label, h('span', { class: 'color-field' }, picker, hex));
  };

  return [
    h(
      'section',
      { class: 'card pad step' },
      h('h2', {}, 'Program settings'),
      h(
        'div',
        { class: 'grid2' },
        field('Welcome reward', welcomeField),
        field(
          'Points expire after',
          presetSelect({ label: 'Points expire after', value: s.pointsExpireMonths, options: P.expiry, suffix: ' months', onChange: (v) => setS({ pointsExpireMonths: v }) }),
        ),
        field('Fuel discounts per fill-up', stackSelect),
        field(
          'Store manager max discount ($)',
          h('input', { type: 'text', inputmode: 'decimal', value: (s.maxStoreDiscountCents / 100).toFixed(2), oninput: (e) => setS({ maxStoreDiscountCents: dollarsToCents(e.target.value) }) }),
        ),
        field(
          'Monthly rewards budget ($)',
          h('input', { type: 'text', inputmode: 'decimal', value: (s.monthlyBudgetCents / 100).toFixed(0), oninput: (e) => setS({ monthlyBudgetCents: dollarsToCents(e.target.value) }) }),
        ),
        field('Program name', h('input', { type: 'text', maxlength: 40, value: b.programName, oninput: (e) => setB({ programName: e.target.value }) })),
      ),
    ),
    h(
      'section',
      { class: 'card pad step' },
      h('h2', {}, 'Branding'),
      h(
        'div',
        { class: 'grid2' },
        field(
          'Logo',
          h(
            'span',
            { class: 'row' },
            h('span', { class: 'logo-box' }, logoImg),
            fileInput,
            h('label', { for: 'logo-file', class: 'btn ghost', role: 'button', tabindex: 0 }, 'Upload'),
            b.logoDataUrl &&
              h(
                'button',
                {
                  class: 'link',
                  onclick: () => {
                    setB({ logoDataUrl: '' });
                    logoImg.src = '/vgo-logo.png';
                  },
                },
                'Use VGO logo',
              ),
          ),
        ),
        colorField('mainColor', 'Main color'),
        colorField('accentColor', 'Accent color'),
      ),
      h('p', { class: 'note' }, 'Logo, colors and program name update in the app and console right away. The app store icon changes with the next app update.'),
    ),
  ];
}

function applyPreviewBranding() {
  const b = { ...boot.branding, ...brandingEdits };
  document.documentElement.style.setProperty('--main', b.mainColor);
  document.documentElement.style.setProperty('--accent', b.accentColor);
}

async function saveRulesPage() {
  const errors = document.getElementById('rules-errors');
  errors.replaceChildren();
  if (!(await confirmDiscounts(Object.values(ruleEdits).filter((r) => r.status !== 'draft')))) return;
  try {
    for (const [id, rule] of Object.entries(ruleEdits)) {
      const { display, createdAt, updatedAt, createdBy, ...input } = rule;
      await api('PUT', `/rules/${id}`, input);
      delete ruleEdits[id];
    }
    if (Object.keys(settingsEdits).length) {
      await api('PUT', '/settings', settingsEdits);
      settingsEdits = {};
    }
    if (Object.keys(brandingEdits).length) {
      await api('PUT', '/branding', brandingEdits);
      brandingEdits = {};
    }
    await reload();
    toast('Changes saved');
    render();
  } catch (err) {
    errors.replaceChildren(errorBox(err));
  }
}

async function historyDialog() {
  const items = await api('GET', '/history');
  openDialog(
    h('h2', {}, 'Change history'),
    h(
      'ul',
      { class: 'history', style: 'list-style:none;margin:0;padding:0' },
      items.map((i) => h('li', {}, h('time', {}, `${new Date(i.at).toLocaleString()} · ${i.userId}`), i.what)),
    ),
    h('div', { class: 'row' }, h('div', { class: 'grow' }), h('button', { class: 'btn', onclick: closeDialog }, 'Close')),
  );
}

function memberPreviewDialog() {
  const b = { ...boot.branding, ...brandingEdits };
  const live = boot.rules.filter((r) => r.section !== 'earn' && r.display.status === 'Live').slice(0, 3);
  openDialog(
    h('h2', {}, 'Preview for a member'),
    h(
      'div',
      { style: `background:${b.mainColor};color:#fff;border-radius:20px;padding:20px;display:flex;flex-direction:column;gap:12px;max-width:360px` },
      h('div', { class: 'row' }, h('img', { src: b.logoDataUrl || '/vgo-logo.png', alt: '', style: 'width:48px;height:48px;object-fit:contain' }), h('b', { style: "font-family:'Barlow Condensed';font-size:24px" }, b.programName)),
      h('div', { style: 'font-size:14px;opacity:.8' }, 'Points balance'),
      h('div', { style: "font-family:'Barlow Condensed';font-size:44px;font-weight:700;line-height:1" }, '1,240'),
      live.map((r) =>
        h('div', { style: 'background:#fff;color:#0F2747;border-radius:14px;padding:12px 14px' }, h('b', {}, r.name), h('div', { style: 'font-size:14px;color:#55606E' }, r.display.memberLine)),
      ),
      h('button', { style: `background:${b.accentColor};color:#fff;border:0;border-radius:22px;min-height:44px;font-weight:700;font-size:16px` }, 'Use at pump'),
    ),
    h('p', { class: 'note' }, 'A quick look with your unsaved branding. The full app comes next.'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }), h('button', { class: 'btn', onclick: closeDialog }, 'Close')),
  );
}

function renderRules() {
  const earn = boot.rules.filter((r) => r.section === 'earn' && r.status !== 'retired');
  const redeem = boot.rules.filter((r) => r.section === 'redeem' && r.status !== 'retired');
  main.replaceChildren(
    pageHead(
      'Reward rules',
      'You set how members earn and redeem. Change any number, add or pause a rule, and choose where it applies. Changes take effect at the next transaction; members keep points they already earned.',
      h('button', { class: 'btn accent', onclick: addRuleDialog }, plusIcon(), 'Add rule'),
    ),
    drafterSection(),
    h('section', { class: 'step' }, h('span', { class: 'section-label' }, 'Earn'), earn.map(ruleRow)),
    h('section', { class: 'step' }, h('span', { class: 'section-label' }, 'Redeem'), redeem.map(ruleRow)),
    ...settingsSection(),
    h('div', { id: 'rules-errors' }),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'link', onclick: historyDialog }, 'See change history'),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn ghost', onclick: memberPreviewDialog }, 'Preview for a member'),
      h('button', { class: 'btn accent', id: 'save-rules', onclick: saveRulesPage }, 'Save changes'),
    ),
  );
  updateSaveBar();
}

// ---------- Stores and groups ----------

function storeDialog(store) {
  const isNew = !store;
  const s = store
    ? structuredClone(store)
    : { id: '', name: '', address: '', city: '', state: 'SC', zip: '', contactName: '', email: '', phone: '', groupIds: [], pos: 'verifone-commander', posSiteId: '', loyaltyLive: false, mappedCategories: [] };
  const errors = h('div', {});
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
  const text = (key, attrs = {}) => h('input', { value: s[key] ?? '', oninput: (e) => (s[key] = e.target.value), ...attrs });
  openDialog(
    h('h2', {}, isNew ? 'Add a location' : s.name),
    h('h3', { class: 'dialog-section' }, 'Site'),
    h(
      'div',
      { class: 'grid2' },
      field('Site name', text('name', { placeholder: 'e.g. VGO 14' })),
      field('Contact person', text('contactName')),
      field('Street address', text('address')),
      field('City', text('city')),
      field('State', text('state', { maxlength: 2, placeholder: 'SC', style: 'text-transform:uppercase' })),
      field('ZIP', text('zip', { inputmode: 'numeric', maxlength: 10 })),
      field('Email (optional)', text('email', { type: 'email' })),
      field('Phone (optional)', text('phone', { type: 'tel', inputmode: 'tel' })),
    ),
    h('h3', { class: 'dialog-section' }, 'POS connection'),
    h(
      'div',
      { class: 'grid2' },
      field(
        'POS',
        h(
          'select',
          { onchange: (e) => (s.pos = e.target.value) },
          ['verifone-commander', 'gilbarco-passport', 'ncr-radiant', 'other'].map((p) => h('option', { value: p, selected: s.pos === p }, posLabel(p))),
        ),
      ),
      field('POS link site ID', text('posSiteId', { placeholder: 'Filled in when the link is set up' }), 'The ID the POS loyalty link uses for this store.'),
      field(
        'Map location (for near-store promos)',
        h('input', {
          value: s.lat !== undefined && s.lat !== null ? `${s.lat}, ${s.lng}` : '',
          placeholder: '34.8526, -82.3940',
          oninput: (e) => (s.mapSpot = e.target.value),
        }),
        'In Google Maps, right-click the store and click the numbers at the top to copy them, then paste here.',
      ),
    ),
    h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: s.loyaltyLive, onchange: (e) => (s.loyaltyLive = e.target.checked) }), 'Loyalty live at this store (POS connected and tested)'),
    field(
      'Groups',
      h(
        'div',
        { class: 'pills' },
        boot.groups.map((g) =>
          h('label', { class: 'pill' }, h('input', { type: 'checkbox', checked: s.groupIds.includes(g.id), onchange: (e) => (s.groupIds = e.target.checked ? [...s.groupIds, g.id] : s.groupIds.filter((x) => x !== g.id)) }), ` ${g.name}`),
        ),
      ),
    ),
    field(
      'Item categories mapped in this store’s POS',
      h(
        'div',
        { class: 'pills' },
        boot.categories.map((c) =>
          h(
            'label',
            { class: 'pill' },
            h('input', { type: 'checkbox', checked: s.mappedCategories.includes(c.id), onchange: (e) => (s.mappedCategories = e.target.checked ? [...s.mappedCategories, c.id] : s.mappedCategories.filter((x) => x !== c.id)) }),
            ` ${c.label}`,
          ),
        ),
      ),
    ),
    errors,
    h(
      'div',
      { class: 'row' },
      h('div', { class: 'grow' }),
      h('button', { class: 'btn ghost', onclick: closeDialog }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn accent',
          onclick: async () => {
            try {
              const body = { ...s };
              for (const k of ['address', 'zip', 'contactName', 'email', 'phone', 'posSiteId']) if (!String(body[k] ?? '').trim()) body[k] = null;
              if (body.mapSpot !== undefined) {
                const nums = body.mapSpot.match(/-?\d+(?:\.\d+)?/g) ?? [];
                if (!body.mapSpot.trim()) (body.lat = null), (body.lng = null);
                else if (nums.length !== 2) throw Object.assign(new Error('Paste the map location as two numbers, like 34.8526, -82.3940.'), { problems: ['Paste the map location as two numbers, like 34.8526, -82.3940.'] });
                else (body.lat = Number(nums[0])), (body.lng = Number(nums[1]));
                delete body.mapSpot;
              }
              if (isNew) await api('POST', '/stores', body);
              else await api('PUT', `/stores/${s.id}`, body);
              await reload();
              closeDialog();
              toast(isNew ? 'Location added' : 'Location saved');
              render();
            } catch (err) {
              errors.replaceChildren(errorBox(err));
            }
          },
        },
        isNew ? 'Add location' : 'Save',
      ),
    ),
  );
}

function groupDialog(group) {
  const g = group ? { ...group } : { id: '', name: '' };
  let storeIds = boot.stores.filter((s) => g.id && s.groupIds.includes(g.id)).map((s) => s.id);
  const errors = h('div', {});
  openDialog(
    h('h2', {}, group ? `Edit ${group.name}` : 'New store group'),
    h('label', { class: 'field' }, h('span', {}, 'Group name'), h('input', { value: g.name, oninput: (e) => (g.name = e.target.value), placeholder: 'e.g. Highway stores' })),
    h(
      'div',
      { class: 'store-pick' },
      boot.stores.map((s) =>
        h(
          'label',
          {},
          h('input', { type: 'checkbox', checked: storeIds.includes(s.id), onchange: (e) => (storeIds = e.target.checked ? [...storeIds, s.id] : storeIds.filter((x) => x !== s.id)) }),
          h('div', { class: 'grow', style: 'font-weight:600' }, s.name),
          h('span', { class: 'meta' }, s.state),
        ),
      ),
    ),
    errors,
    h(
      'div',
      { class: 'row' },
      h('div', { class: 'grow' }),
      h('button', { class: 'btn ghost', onclick: closeDialog }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn accent',
          onclick: async () => {
            try {
              await api('POST', '/groups', { id: g.id || undefined, name: g.name, storeIds });
              await reload();
              closeDialog();
              toast('Group saved');
              render();
            } catch (err) {
              errors.replaceChildren(errorBox(err));
            }
          },
        },
        'Save',
      ),
    ),
  );
}

function renderStores() {
  const live = boot.stores.filter((s) => s.loyaltyLive).length;
  main.replaceChildren(
    pageHead(
      'Locations',
      `${live} of ${boot.stores.length} locations have loyalty live. Groups let you send an offer to several stores at once.`,
      h('button', { class: 'btn accent', onclick: () => storeDialog(null) }, plusIcon(), 'Add location'),
    ),
    h(
      'div',
      { class: 'card table-wrap' },
      h(
        'table',
        { style: 'min-width: 760px' },
        h('thead', {}, h('tr', {}, ['Site', 'Address', 'Contact', 'POS', 'Loyalty', 'Groups'].map((t) => h('th', {}, t)))),
        h(
          'tbody',
          {},
          boot.stores.map((s) =>
            h(
              'tr',
              { class: 'click', tabindex: 0, onclick: () => storeDialog(s), onkeydown: (e) => e.key === 'Enter' && storeDialog(s) },
              h('td', { class: 'strong' }, s.name),
              h('td', {}, [s.address, s.city ? `${s.city}, ${s.state}` : s.state].filter(Boolean).join(', ')),
              h('td', {}, s.contactName || '—'),
              h('td', {}, posLabel(s.pos)),
              h('td', {}, h('span', { class: `badge ${s.loyaltyLive ? 'Live' : 'Draft'}` }, s.loyaltyLive ? 'Live' : 'Not enabled')),
              h('td', {}, s.groupIds.map((g) => boot.groups.find((x) => x.id === g)?.name ?? g).join(', ')),
            ),
          ),
        ),
      ),
    ),
    h('p', { class: 'note' }, 'Cities, the state split and POS for stores 02 to 13 are placeholders until confirmed. Click a location to update it.'),
    h(
      'div',
      { class: 'page-head' },
      h('h2', {}, 'Store groups'),
      h('button', { class: 'btn ghost', onclick: () => groupDialog(null) }, plusIcon(), 'New group'),
    ),
    h(
      'div',
      { class: 'kpis' },
      boot.groups.map((g) => {
        const members = boot.stores.filter((s) => s.groupIds.includes(g.id));
        return h(
          'div',
          { class: 'card kpi' },
          h('b', { style: 'font-size:18px' }, g.name),
          h('span', { class: 'sub' }, members.length ? members.map((s) => s.name).join(', ') : 'No stores yet'),
          h('button', { class: 'link', style: 'align-self:flex-start', onclick: () => groupDialog(g) }, 'Edit'),
        );
      }),
    ),
  );
}

// ---------- Members ----------

let memberQuery = '';

async function renderMembers() {
  const res = await api('GET', `/members?q=${encodeURIComponent(memberQuery)}`);
  const search = h('input', {
    class: 'big-input',
    type: 'search',
    placeholder: 'Search by name, phone or email',
    'aria-label': 'Search members',
    value: memberQuery,
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        memberQuery = e.target.value;
        renderMembers();
      }
    },
  });
  const sample = res.members.some((m) => m.tags.includes('sample'));
  main.replaceChildren(
    pageHead('Members', `${res.total.toLocaleString()} ${memberQuery ? 'matching' : 'enrolled'}. Members join in the app with their phone number.`, h('button', { class: 'btn accent', onclick: addMemberDialog }, plusIcon(), 'Add member')),
    h('div', { class: 'row' }, search, h('button', { class: 'btn', onclick: () => ((memberQuery = search.value), renderMembers()) }, 'Search')),
    sample && h('div', { class: 'notice' }, 'These are sample members so Results has data to show. Clear them on Results when real members start joining.'),
    h(
      'div',
      { class: 'card table-wrap' },
      h(
        'table',
        { style: 'min-width: 760px' },
        h('thead', {}, h('tr', {}, ['Member', 'Phone', 'Home store', 'Points', 'Visits', 'Last visit'].map((t, i) => h('th', { class: i >= 3 && i <= 4 ? 'num' : '' }, t)))),
        h(
          'tbody',
          {},
          res.members.map((m) =>
            h(
              'tr',
              { class: 'click', tabindex: 0, onclick: () => memberDialog(m.id), onkeydown: (e) => e.key === 'Enter' && memberDialog(m.id) },
              h('td', { class: 'strong' }, m.name || 'No name'),
              h('td', {}, `(•••) •••-${m.phone.slice(-4)}`),
              h('td', {}, m.homeStoreId ? storeName(m.homeStoreId) : '—'),
              h('td', { class: 'num' }, m.pointsBalance.toLocaleString()),
              h('td', { class: 'num' }, m.visitCount),
              h('td', {}, m.lastVisitAt ? new Date(m.lastVisitAt).toLocaleDateString() : 'Not yet'),
            ),
          ),
        ),
      ),
    ),
    res.total > res.members.length && h('p', { class: 'note' }, `Showing the newest ${res.members.length}. Search to find others.`),
  );
}

function addMemberDialog() {
  const m = { name: '', phone: '', homeStoreId: boot.pilot.storeId };
  const errors = h('div', {});
  openDialog(
    h('h2', {}, 'Add member'),
    h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { oninput: (e) => (m.name = e.target.value) })),
    h('label', { class: 'field' }, h('span', {}, 'Mobile number'), h('input', { type: 'tel', inputmode: 'tel', oninput: (e) => (m.phone = e.target.value) })),
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Home store'),
      h('select', { onchange: (e) => (m.homeStoreId = e.target.value) }, boot.stores.map((s) => h('option', { value: s.id, selected: s.id === m.homeStoreId }, s.name))),
    ),
    errors,
    h(
      'div',
      { class: 'row' },
      h('div', { class: 'grow' }),
      h('button', { class: 'btn ghost', onclick: closeDialog }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn accent',
          onclick: async () => {
            try {
              await api('POST', '/members', m);
              closeDialog();
              toast('Member added');
              renderMembers();
            } catch (err) {
              errors.replaceChildren(errorBox(err));
            }
          },
        },
        'Add',
      ),
    ),
  );
}

async function memberDialog(id) {
  const { member: m, visits } = await api('GET', `/members/${id}`);
  const adj = { delta: '', reason: '' };
  const errors = h('div', {});
  const ruleName = (rid) => boot.rules.find((r) => r.id === rid)?.name ?? rid;
  openDialog(
    h('h2', {}, m.name || 'Member'),
    h(
      'p',
      { class: 'note' },
      `Phone ending ${m.phone.slice(-4)} · joined ${new Date(m.joinedAt).toLocaleDateString()} · ${m.visitCount} visits · home store ${m.homeStoreId ? storeName(m.homeStoreId) : 'not set'}`,
    ),
    h(
      'p',
      { class: 'note' },
      [
        m.email ? `Email ${m.email}` : 'No email on file',
        m.birthday && `Birthday ${new Date(2024, Number(m.birthday.slice(0, 2)) - 1, Number(m.birthday.slice(3))).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`,
        m.zip && `ZIP ${m.zip}`,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
    h(
      'p',
      { class: 'note' },
      `Offer texts: ${m.smsOptIn ? `yes${m.smsOptInAt ? `, agreed ${new Date(m.smsOptInAt).toLocaleDateString()}` : ''}` : 'no'} · Offer emails: ${m.emailOptIn ? `yes${m.emailOptInAt ? `, agreed ${new Date(m.emailOptInAt).toLocaleDateString()}` : ''}` : 'no'}`,
    ),
    h('div', { class: 'kpi card' }, h('span', { class: 'label' }, 'Points balance'), h('span', { class: 'value' }, m.pointsBalance.toLocaleString())),
    Object.keys(m.punches).length > 0 && h('p', { class: 'note' }, `Punch cards: ${Object.entries(m.punches).map(([k, v]) => `${k} ${v}`).join(', ')}`),
    h(
      'div',
      { class: 'row' },
      h('input', { type: 'number', placeholder: '+/- points', 'aria-label': 'Points to add or remove', style: 'width:130px;height:44px', oninput: (e) => (adj.delta = e.target.value) }),
      h('input', { type: 'text', placeholder: 'Reason (required)', 'aria-label': 'Reason', class: 'big-input', style: 'height:44px', oninput: (e) => (adj.reason = e.target.value) }),
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            try {
              await api('POST', `/members/${id}/points`, { delta: Number(adj.delta), reason: adj.reason });
              toast('Points adjusted');
              memberDialog(id);
            } catch (err) {
              errors.replaceChildren(errorBox(err));
            }
          },
        },
        'Adjust points',
      ),
    ),
    errors,
    h('h2', { style: 'font-size:16px' }, 'Recent visits'),
    visits.length
      ? h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ['When', 'Store', 'Fuel', 'Earned', 'Spent', 'Rewards'].map((t) => h('th', {}, t)))),
          h(
            'tbody',
            {},
            visits.map((v) =>
              h(
                'tr',
                {},
                h('td', {}, new Date(v.tx.at).toLocaleDateString()),
                h('td', {}, storeName(v.tx.storeId)),
                h('td', {}, v.tx.fuel ? `${v.tx.fuel.gallons} gal` : '—'),
                h('td', {}, v.pointsEarned),
                h('td', {}, v.pointsSpent || '—'),
                h('td', {}, v.discounts.filter((d) => d.centsOff > 0).map((d) => `${ruleName(d.ruleId)} (${money(d.centsOff)})`).join(', ') || '—'),
              ),
            ),
          ),
        )
      : h('p', { class: 'note' }, 'No visits yet.'),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => tryVisitDialog(id) }, 'Try a visit for this member'), h('div', { class: 'grow' }), h('button', { class: 'btn', onclick: closeDialog }, 'Close')),
  );
}

/** Runs a made-up visit through the live rules without saving it, to see what a member would get. */
async function tryVisitDialog(memberId) {
  const members = memberId ? [(await api('GET', `/members/${memberId}`)).member] : (await api('GET', '/members')).members.slice(0, 50);
  const v = { storeId: boot.pilot.storeId, memberId: members[0]?.id, gallons: '12', grade: 'regular', items: [], redeem: [] };
  const out = h('div', {});
  const redeemRules = boot.rules.filter((r) => r.section === 'redeem' && r.status === 'active');
  async function run() {
    const at = new Date().toISOString();
    const tx = {
      id: `try-${Date.now()}`,
      storeId: v.storeId,
      at,
      items: v.items.map((id) => ({ sku: id, category: id, qty: 1, unitCents: 299 })),
      fuel: Number(v.gallons) > 0 ? { grade: v.grade, gallons: Number(v.gallons), pricePerGallonCents: 309 } : undefined,
      redeemRuleIds: v.redeem,
    };
    try {
      const r = await api('POST', '/pos/preview', { tx, memberId: v.memberId });
      const name = (rid) => boot.rules.find((x) => x.id === rid)?.name ?? rid;
      out.replaceChildren(
        h(
          'div',
          { class: 'card pad step' },
          h('b', {}, `Earns ${r.pointsEarned} points${r.pointsSpent ? `, spends ${r.pointsSpent}` : ''}`),
          r.discounts.length
            ? h(
                'ul',
                { class: 'checks' },
                r.discounts.map((d) => h('li', { class: 'ok' }, `${name(d.ruleId)}: ${d.centsPerGallon ? `${d.centsPerGallon}¢/gal, ` : ''}${money(d.centsOff)} off`)),
              )
            : h('span', { class: 'note' }, 'No discounts on this visit.'),
          h('span', { class: 'note' }, `Rules applied: ${r.appliedRuleIds.map(name).join(', ') || 'none'}. Nothing was saved.`),
        ),
      );
    } catch (err) {
      out.replaceChildren(errorBox(err));
    }
  }
  const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
  openDialog(
    h('h2', {}, 'Try a visit'),
    h('p', { class: 'note' }, 'See what the live rules give a member, without saving anything. Each item is priced at $2.99 and fuel at $3.09/gal.'),
    h(
      'div',
      { class: 'grid2' },
      field('Member', h('select', { onchange: (e) => (v.memberId = e.target.value) }, members.map((m) => h('option', { value: m.id }, `${m.name || m.id} · ${m.pointsBalance} pts · ${m.visitCount} visits`)))),
      field('Store', h('select', { onchange: (e) => (v.storeId = e.target.value) }, boot.stores.map((s) => h('option', { value: s.id, selected: s.id === v.storeId }, s.name)))),
      field('Gallons', h('input', { type: 'number', min: 0, step: '0.1', value: v.gallons, oninput: (e) => (v.gallons = e.target.value) })),
      field('Grade', h('select', { onchange: (e) => (v.grade = e.target.value) }, boot.grades.map((g) => h('option', { value: g.id }, g.label)))),
    ),
    field(
      'Items bought',
      h(
        'div',
        { class: 'pills' },
        boot.categories.map((c) => h('label', { class: 'pill' }, h('input', { type: 'checkbox', onchange: (e) => (v.items = e.target.checked ? [...v.items, c.id] : v.items.filter((x) => x !== c.id)) }), ` ${c.label}`)),
      ),
    ),
    redeemRules.length > 0 &&
      field(
        'Member chooses to redeem',
        h(
          'div',
          { class: 'pills' },
          redeemRules.map((r) => h('label', { class: 'pill' }, h('input', { type: 'checkbox', onchange: (e) => (v.redeem = e.target.checked ? [...v.redeem, r.id] : v.redeem.filter((x) => x !== r.id)) }), ` ${r.name}`)),
        ),
      ),
    out,
    h('div', { class: 'row' }, h('div', { class: 'grow' }), h('button', { class: 'btn ghost', onclick: closeDialog }, 'Close'), h('button', { class: 'btn accent', onclick: run }, 'Run visit')),
  );
}

// ---------- Results ----------

let resultsView = 'pilot';

async function renderResults() {
  const r = await api('GET', `/results?view=${resultsView}`);
  const kpi = (label, value, sub) => h('div', { class: 'card kpi' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value), sub && h('span', { class: 'sub' }, sub));
  const change = (cur, prev, fmt) => (prev === null ? 'First month of data' : `${cur >= prev ? 'Up' : 'Down'} from ${fmt(prev)} the 30 days before`);
  main.replaceChildren(
    h(
      'header',
      { class: 'page-head' },
      h(
        'div',
        { class: 'intro' },
        h('div', { class: 'row' }, h('h1', {}, !isAdmin() ? 'Your results' : r.view === 'pilot' ? 'Pilot results' : 'Portfolio results'), r.sample && h('span', { class: 'badge Sample' }, 'Sample data')),
        h('span', { class: 'lede' }, isAdmin() ? `${r.pilot.storeName} · day ${r.pilot.day} of ${r.pilot.days} · members compared with non-members at the same stores` : boot.stores.map((x) => x.name).join(', ')),
      ),
      isAdmin() && h(
        'div',
        { class: 'pills' },
        h('span', { class: 'note' }, 'View'),
        [
          ['pilot', 'Group: Pilot'],
          ['all', `All ${r.rollout.total} stores`],
        ].map(([v, l]) => h('button', { class: `pill${resultsView === v ? ' on' : ''}`, onclick: () => ((resultsView = v), renderResults()) }, l)),
      ),
    ),
    r.sample &&
      isAdmin() &&
      h(
        'div',
        { class: 'notice row' },
        h('span', { class: 'grow' }, 'These numbers come from made-up visits so you can see the screen working. Clear them before the pilot goes live.'),
        h(
          'button',
          {
            class: 'btn ghost',
            onclick: async () => {
              if (!confirm('Remove all sample visits and sample members? This cannot be undone.')) return;
              await api('POST', '/sample/clear');
              await reload();
              toast('Sample data cleared');
              renderResults();
            },
          },
          'Clear sample data',
        ),
      ),
    h(
      'div',
      { class: 'kpis' },
      kpi('Members enrolled', r.membersEnrolled.toLocaleString(), 'Target: set after baseline'),
      kpi('Transactions with a member ID', pct(r.memberTxShare.current), change(r.memberTxShare.current, r.memberTxShare.previous, pct)),
      kpi('Gallons per visit, member vs non-member', `${r.gallonsPerVisit.member.toFixed(1)} vs ${r.gallonsPerVisit.nonMember.toFixed(1)}`, 'Fuel lines on loyalty transactions'),
      kpi('Inside sales per visit, member vs non-member', `${money(Math.round(r.insidePerVisitCents.member))} vs ${money(Math.round(r.insidePerVisitCents.nonMember))}`, 'Excludes tobacco, lottery, gift cards'),
      kpi('Visits per member per month', r.visitsPerMemberPerMonth.current.toFixed(1), change(r.visitsPerMemberPerMonth.current, r.visitsPerMemberPerMonth.previous, (x) => x.toFixed(1))),
      kpi(
        'Reward cost per incremental gallon',
        r.rewardCostPerIncrementalGallonCents === null ? '—' : money(Math.round(r.rewardCostPerIncrementalGallonCents)),
        'Compare with your fuel margin per gallon',
      ),
    ),
    h(
      'div',
      { class: 'kpis' },
      kpi(`Active members (visit in last ${r.activeDays} days)`, r.activeMembers.toLocaleString(), isAdmin() ? (r.view === 'all' ? 'All locations' : 'Pilot locations') : 'Your locations'),
      kpi('Rewards cashed out this month', money(fundTotal(r.rewardsThisMonth)), fundSplit(r.rewardsThisMonth)),
      isAdmin() && r.budget.monthlyCents > 0 && kpi('Against the monthly budget', `${money(r.budget.usedCents)} of ${money(r.budget.monthlyCents)}`, 'Tracker only. Offers keep running past it.'),
    ),
    h('h2', {}, 'By location'),
    h(
      'div',
      { class: 'card table-wrap' },
      h(
        'table',
        { style: 'min-width: 760px' },
        h('thead', {}, h('tr', {}, ['Location', 'Loyalty', 'Active members', 'New in 30 days', 'Member visits, 30 days', 'Corporate rewards', 'Store rewards'].map((t, i) => h('th', { class: i >= 2 ? 'num' : '' }, t)))),
        h(
          'tbody',
          {},
          r.locations.map((l) =>
            h(
              'tr',
              {},
              h('td', { class: 'strong' }, l.name),
              h('td', {}, l.loyaltyLive ? 'Live' : 'Not yet'),
              h('td', { class: 'num' }, l.activeMembers.toLocaleString()),
              h('td', { class: 'num' }, l.newMembers30.toLocaleString()),
              h('td', { class: 'num' }, l.visits30.toLocaleString()),
              h('td', { class: 'num' }, money(l.rewards.corporateCents + l.rewards.otherCents)),
              h('td', { class: 'num' }, money(l.rewards.storeCents)),
            ),
          ),
        ),
      ),
    ),
    h('h2', {}, 'Rewards cashed out by member this month'),
    r.cashOuts.length
      ? h(
          'div',
          { class: 'card table-wrap' },
          h(
            'table',
            { style: 'min-width: 600px' },
            h('thead', {}, h('tr', {}, ['Member', 'Phone', 'Visits with a reward', 'Corporate', 'Store', 'Total'].map((t, i) => h('th', { class: i >= 2 ? 'num' : '' }, t)))),
            h(
              'tbody',
              {},
              r.cashOuts.map((c) =>
                h(
                  'tr',
                  { class: 'click', tabindex: 0, onclick: () => memberDialog(c.memberId) },
                  h('td', { class: 'strong' }, c.name),
                  h('td', {}, c.phoneLast4 ? `••• ${c.phoneLast4}` : ''),
                  h('td', { class: 'num' }, c.visits),
                  h('td', { class: 'num' }, money(c.rewards.corporateCents + c.rewards.otherCents)),
                  h('td', { class: 'num' }, money(c.rewards.storeCents)),
                  h('td', { class: 'num strong' }, money(fundTotal(c.rewards))),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'note' }, 'No rewards cashed out yet this month.'),
    h('h2', {}, 'Offer performance'),
    h(
      'div',
      { class: 'card table-wrap' },
      h(
        'table',
        { style: 'min-width: 700px' },
        h('thead', {}, h('tr', {}, ['Offer', 'Target', 'Redemptions', 'Discount cost', 'Gallons on those visits'].map((t, i) => h('th', { class: i >= 2 ? 'num' : '' }, t)))),
        h(
          'tbody',
          {},
          r.offers.map((o) =>
            h(
              'tr',
              {},
              h('td', { class: 'strong' }, o.name),
              h('td', {}, o.target),
              h('td', { class: 'num' }, o.redemptions.toLocaleString()),
              h('td', { class: 'num' }, money(o.costCents)),
              h('td', { class: 'num' }, o.gallons === null ? 'Not tied to fuel' : o.gallons.toLocaleString()),
            ),
          ),
        ),
      ),
    ),
    isAdmin() &&
      h(
      'section',
      { class: 'card pad row' },
      h(
        'div',
        { class: 'grow' },
        h('h2', {}, 'Rollout readiness'),
        h('p', { class: 'note' }, `${r.rollout.live} of ${r.rollout.total} stores ${r.rollout.live === 1 ? 'has' : 'have'} loyalty enabled. The rest need a technician visit to go live.`),
      ),
      h('a', { class: 'btn', href: '#/stores' }, 'Manage locations'),
    ),
  );
}


// ---------- Reward artwork ----------

const ART_W = 1200;
const ART_H = 675;

/** The 16:9 picture on an app card: the uploaded art, or the headline on a colored panel. */
function artFrame({ imageUrl, headline, kind, name }) {
  if (imageUrl) return h('div', { class: 'art-frame' }, h('img', { src: imageUrl, alt: name ? `${name} artwork` : 'Reward artwork', loading: 'lazy' }));
  return h('div', { class: `art-frame poster ${kind || 'other'}` }, h('span', { class: 'poster-text' }, headline), h('img', { class: 'poster-logo', src: boot.branding.logoDataUrl || '/vgo-logo.png', alt: '' }));
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not an image this browser can read. Use a JPG, PNG or WebP.'));
    img.src = url;
  });
}

/**
 * Resizes any picture to the one standard reward size. "fill" crops to fill the frame;
 * "fit" keeps the whole flyer and fills the sides with a blurred copy of it.
 */
async function standardArt(file, fit) {
  const img = await loadImage(file);
  const c = document.createElement('canvas');
  c.width = ART_W;
  c.height = ART_H;
  const ctx = c.getContext('2d');
  const cover = Math.max(ART_W / img.width, ART_H / img.height);
  const drawAt = (scale) => {
    const w = img.width * scale;
    const hh = img.height * scale;
    ctx.drawImage(img, (ART_W - w) / 2, (ART_H - hh) / 2, w, hh);
  };
  if (fit === 'fit') {
    ctx.filter = 'blur(28px) brightness(0.75)';
    drawAt(cover * 1.1);
    ctx.filter = 'none';
    drawAt(Math.min(ART_W / img.width, ART_H / img.height));
  } else drawAt(cover);
  let q = 0.86;
  let url = c.toDataURL('image/jpeg', q);
  while (url.length > 1_800_000 && q > 0.5) url = c.toDataURL('image/jpeg', (q -= 0.1));
  return url;
}

/** Tall or square flyers keep their whole picture; wide photos fill the frame. */
const autoFit = (img) => (img.width / img.height < 1.45 ? 'fit' : 'fill');

async function uploadArt(file, fit) {
  const dataUrl = await standardArt(file, fit);
  return api('POST', '/media', { dataUrl, name: file.name });
}

async function artLibraryDialog(onPick) {
  const items = await api('GET', '/media');
  openDialog(
    h('h2', {}, 'Artwork library'),
    h('p', { class: 'note' }, 'Everything uploaded so far. Pick one to use it on this reward.'),
    items.length
      ? h(
          'div',
          { class: 'art-library' },
          items.map((m) =>
            h(
              'button',
              { class: 'art-pick', type: 'button', onclick: () => (closeDialog(), onPick(m.id)) },
              h('div', { class: 'art-frame' }, h('img', { src: `/media/${m.id}`, alt: '', loading: 'lazy' })),
              h('span', { class: 'note' }, m.name),
            ),
          ),
        )
      : h('p', {}, 'No artwork yet.'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }), h('button', { class: 'btn ghost', onclick: closeDialog }, 'Close')),
  );
}

function artSection(f, set) {
  const status = h('div', {});
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', hidden: true });
  const useFile = async (picked, fit) => {
    status.replaceChildren(h('p', { class: 'note' }, 'Sizing and uploading…'));
    try {
      f.artFile = picked;
      f.artFit = fit ?? autoFit(await loadImage(picked));
      const info = await uploadArt(picked, f.artFit);
      set({ mediaId: info.id }, true);
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  };
  file.onchange = () => file.files?.[0] && useFile(file.files[0]);
  const drop = h(
    'div',
    {
      class: 'art-drop',
      ondragover: (e) => (e.preventDefault(), e.currentTarget.classList.add('over')),
      ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove('over');
        const picked = e.dataTransfer.files?.[0];
        if (picked) useFile(picked);
      },
    },
    f.mediaId ? h('div', { class: 'art-frame' }, h('img', { src: `/media/${f.mediaId}`, alt: 'Current artwork' })) : h('div', { class: 'art-empty' }, h('b', {}, 'Drop a flyer or picture here'), h('span', { class: 'note' }, 'or use the buttons below. Any size works.')),
  );
  return h(
    'section',
    { class: 'card pad step' },
    h('h2', {}, '5. Artwork and app display'),
    h(
      'p',
      { class: 'note' },
      `Every picture is resized to the same ${ART_W}×${ART_H} banner, so all rewards line up in the app. Without artwork, the app shows the headline on a colored banner.`,
    ),
    drop,
    file,
    status,
    h(
      'div',
      { class: 'row wrap' },
      h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, f.mediaId ? 'Replace artwork' : 'Upload artwork'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => artLibraryDialog((id) => ((f.artFile = null), set({ mediaId: id }, true))) }, 'Choose from library'),
      f.mediaId && h('button', { class: 'btn ghost', type: 'button', onclick: () => ((f.artFile = null), set({ mediaId: null }, true)) }, 'Remove'),
    ),
    f.mediaId &&
      f.artFile &&
      h(
        'div',
        { class: 'pills', role: 'radiogroup', 'aria-label': 'How the picture fits' },
        h('span', { class: 'note' }, 'Fit'),
        [
          ['fit', 'Show the whole flyer'],
          ['fill', 'Fill the banner (crops edges)'],
        ].map(([v, l]) =>
          h('button', { type: 'button', role: 'radio', 'aria-checked': f.artFit === v, class: `pill${f.artFit === v ? ' on' : ''}`, onclick: () => f.artFit !== v && useFile(f.artFile, v) }, l),
        ),
      ),
    h(
      'div',
      { class: 'grid2' },
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Banner headline (when there is no artwork)'),
        h('input', { type: 'text', maxlength: 28, value: f.headline, placeholder: 'Made from the reward, e.g. 25¢ OFF A GALLON', oninput: (e) => set({ headline: e.target.value }) }),
      ),
    ),
    h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: f.featured, onchange: (e) => set({ featured: e.target.checked }) }), 'Feature it in the big slider at the top of the app home screen'),
  );
}

// ---------- Users (back-office access) ----------

async function renderUsers() {
  const users = await api('GET', '/users');
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never');
  main.replaceChildren(
    pageHead(
      'Users',
      'Give each store its own back-office sign-in. One person can have several locations, and several people can share one.',
      boot.signInRequired && h('button', { class: 'btn accent', onclick: () => userDialog(null) }, plusIcon(), 'Add user'),
    ),
    !boot.signInRequired && h('div', { class: 'notice' }, 'Sign-in is off on this server, so users cannot be added here. It turns on when VGO_ADMIN_PASSWORD is set.'),
    h(
      'div',
      { class: 'card table-wrap' },
      h(
        'table',
        { style: 'min-width: 700px' },
        h('thead', {}, h('tr', {}, ['Name', 'Email', 'Access', 'Last sign-in'].map((t) => h('th', {}, t)))),
        h(
          'tbody',
          {},
          h('tr', {}, h('td', { class: 'strong' }, 'Master admin'), h('td', {}, 'admin'), h('td', {}, 'Everything'), h('td', {}, '')),
          users.map((u) =>
            h(
              'tr',
              { class: 'click', tabindex: 0, onclick: () => userDialog(u), onkeydown: (e) => e.key === 'Enter' && userDialog(u) },
              h('td', { class: 'strong' }, u.name),
              h('td', {}, u.email),
              h('td', {}, u.role === 'admin' ? 'Admin, all locations' : h('div', { class: 'chips' }, u.storeIds.map((id) => h('span', { class: 'chip' }, storeName(id))))),
              h('td', {}, when(u.lastSignInAt)),
            ),
          ),
        ),
      ),
    ),
  );
}

function userDialog(user) {
  const isNew = !user;
  const u = user ? structuredClone(user) : { name: '', email: '', role: 'store', storeIds: [] };
  let password = '';
  const errors = h('div', {});
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
  const storePick = h(
    'div',
    { class: 'pills' },
    boot.stores.map((st) =>
      h(
        'label',
        { class: 'pill' },
        h('input', { type: 'checkbox', checked: u.storeIds.includes(st.id), onchange: (e) => (u.storeIds = e.target.checked ? [...u.storeIds, st.id] : u.storeIds.filter((x) => x !== st.id)) }),
        ` ${st.name}`,
      ),
    ),
  );
  const draw = () =>
    openDialog(
      h('h2', {}, isNew ? 'Add a user' : u.name),
      h(
        'div',
        { class: 'grid2' },
        field('Name', h('input', { value: u.name, oninput: (e) => (u.name = e.target.value) })),
        field('Email (used to sign in)', h('input', { type: 'email', value: u.email, autocomplete: 'off', oninput: (e) => (u.email = e.target.value) })),
      ),
      field(
        'Access',
        h(
          'div',
          { class: 'pills', role: 'radiogroup' },
          [
            ['store', 'Store back office'],
            ['admin', 'Admin (everything)'],
          ].map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': u.role === v, class: `pill${u.role === v ? ' on' : ''}`, onclick: () => ((u.role = v), draw()) }, l)),
        ),
      ),
      u.role === 'store' && field('Locations they can see and run offers for', storePick),
      field(
        isNew ? 'Starting password' : 'New password (leave blank to keep the current one)',
        h('input', { type: 'text', autocomplete: 'new-password', value: password, oninput: (e) => (password = e.target.value) }),
        'At least 8 characters. Share it with them privately. Changing it signs them out everywhere.',
      ),
      errors,
      h(
        'div',
        { class: 'row' },
        !isNew &&
          h(
            'button',
            {
              class: 'btn ghost',
              onclick: async () => {
                if (!confirm(`Remove ${u.name}? They will be signed out and lose access.`)) return;
                await api('DELETE', `/users/${u.id}`);
                closeDialog();
                toast('User removed');
                render();
              },
            },
            'Remove user',
          ),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn ghost', onclick: closeDialog }, 'Cancel'),
        h(
          'button',
          {
            class: 'btn accent',
            onclick: async () => {
              try {
                const body = { name: u.name.trim(), email: u.email.trim(), role: u.role, storeIds: u.role === 'store' ? u.storeIds : [] };
                if (password) body.password = password;
                if (isNew) await api('POST', '/users', body);
                else await api('PUT', `/users/${u.id}`, body);
                closeDialog();
                toast(isNew ? 'User added' : 'User saved');
                render();
              } catch (err) {
                errors.replaceChildren(errorBox(err));
              }
            },
          },
          isNew ? 'Add user' : 'Save',
        ),
      ),
    );
  draw();
}

// ---------- Items catalog ----------

let itemQuery = '';

async function renderItems() {
  const r = await api('GET', `/items?q=${encodeURIComponent(itemQuery)}`);
  const file = h('input', { type: 'file', accept: '.csv,.txt,text/csv', hidden: true });
  const status = h('div', {});
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    status.replaceChildren(h('p', { class: 'note' }, `Reading ${f.name}…`));
    try {
      const res = await api('POST', '/items/upload', { csv: await f.text(), fileName: f.name });
      toast(`${res.count.toLocaleString()} items uploaded`);
      itemQuery = '';
      await renderItems();
      if (res.skipped) main.prepend(h('div', { class: 'notice' }, `${res.skipped.toLocaleString()} rows were skipped because they had no SKU, UPC or name.`));
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  };
  const search = h('input', {
    type: 'search',
    placeholder: 'Search by name, SKU, UPC or department',
    value: itemQuery,
    'aria-label': 'Search items',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        itemQuery = e.target.value;
        renderItems();
      }
    },
  });
  main.replaceChildren(
    pageHead(
      'Items',
      r.count
        ? `${r.count.toLocaleString()} items from ${r.fileName || 'the last upload'}, uploaded ${new Date(r.uploadedAt).toLocaleString()}. Item rewards will be tied to these SKUs and UPCs.`
        : 'Upload your latest pricebook so item rewards can be tied to exact SKUs and UPCs.',
      h('button', { class: 'btn accent', onclick: () => file.click() }, r.count ? 'Upload a new catalog' : 'Upload catalog'),
      file,
    ),
    status,
    h(
      'p',
      { class: 'note' },
      'Use a CSV export from your back office or POS. The first row names the columns: SKU or Item code, UPC, Name or Description, Department, Price. A new upload replaces the whole catalog.',
    ),
    r.count > 0 && h('div', { class: 'row' }, search, h('span', { class: 'note' }, `${r.total.toLocaleString()} match${r.total === 1 ? '' : 'es'}${r.total > r.items.length ? `, showing the first ${r.items.length}` : ''}`)),
    r.count > 0 &&
      h(
        'div',
        { class: 'card table-wrap' },
        h(
          'table',
          { style: 'min-width: 700px' },
          h('thead', {}, h('tr', {}, ['SKU', 'UPC', 'Name', 'Department', 'Category', 'Price'].map((t, i) => h('th', { class: i === 5 ? 'num' : '' }, t)))),
          h(
            'tbody',
            {},
            r.items.map((i) =>
              h(
                'tr',
                {},
                h('td', {}, i.sku),
                h('td', {}, i.upc ?? ''),
                h('td', { class: 'strong' }, i.name),
                h('td', {}, i.department ?? ''),
                h('td', {}, i.category ? catLabel(i.category) : ''),
                h('td', { class: 'num' }, i.priceCents === undefined ? '' : money(i.priceCents)),
              ),
            ),
          ),
        ),
      ),
  );
}

// ---------- router ----------

async function render() {
  if (!boot) return showLogin();
  const [page, id] = location.hash.replace(/^#\/?/, '').split('/');
  const section = page || 'offers';
  for (const a of document.querySelectorAll('[data-nav]')) {
    const active = a.dataset.nav === section || (section === 'offers' && a.dataset.nav === 'offers');
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  try {
    if (section === 'offers' && id) return renderOfferForm(id);
    form = null;
    if (section === 'rules' && isAdmin()) return renderRules();
    if (section === 'stores' && isAdmin()) return renderStores();
    if (section === 'members') return await renderMembers();
    if (section === 'results') return await renderResults();
    if (section === 'users' && isAdmin()) return await renderUsers();
    if (section === 'items' && isAdmin()) return await renderItems();
    return renderOffers();
  } catch (err) {
    if (!err.signIn) main.replaceChildren(errorBox(err));
  }
}

window.addEventListener('hashchange', () => {
  render();
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

reload()
  .then(render)
  .catch((err) => err.signIn || main.replaceChildren(errorBox(err)));
