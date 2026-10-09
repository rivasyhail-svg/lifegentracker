/* Public QR registration form. Plain ES module — no login, talks only to /api/public/register*. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'LifegenTracker' };
const FIELDS = ['full_name', 'email', 'age', 'school', 'ministry', 'leader_name', 'network_leader_name'];
const LABELS = { full_name: 'Full name', email: 'Email / Gmail', age: 'Age', school: 'School', ministry: 'Ministry', leader_name: 'Leader', network_leader_name: 'Network leader' };
const STEP_FIELDS = { 1: ['full_name', 'email', 'age', 'school'], 2: ['ministry', 'leader_name', 'network_leader_name'] };
const DRAFT_KEY = 'lifegen.register.draft'; // sessionStorage only: survives a refresh, cleared on success

const form = $('#regForm');
const QR_TOKEN = (new URLSearchParams(location.search).get('k') || '').trim().toUpperCase(); // rotating-QR token (empty in reusable mode)
let options = null;
let formToken = null;
let deviceHeader = null; // fallback when the browser drops the httpOnly device cookie
let step = 1;
let lastCheck = { email_taken: false, name_match: false };

async function api(method, url, body) {
  const headers = { ...H };
  if (deviceHeader) headers['X-Lifegen-Device'] = deviceHeader;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'same-origin' });
  const dev = res.headers.get('X-Lifegen-Device'); if (dev) { deviceHeader = dev; try { localStorage.setItem('lifegen.device', dev); } catch { /* ignore */ } }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.status = res.status; e.details = data && data.details; throw e; }
  return data;
}

// ---- validation (mirrors the server; the server is still the authority) ----
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function tidy(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }
function validateField(name) {
  const v = values();
  switch (name) {
    case 'full_name': {
      const n = tidy(v.full_name);
      if (!n) return 'Please enter your full name.';
      if (n.length < 3) return 'Please enter your real full name.';
      if (n.split(' ').length < 2) return 'Please enter your first and last name.';
      if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]*$/u.test(n)) return 'Names can only contain letters, spaces, dots, apostrophes and hyphens.';
      return '';
    }
    case 'email': {
      const e = tidy(v.email).toLowerCase();
      if (!e) return 'Please enter your email / Gmail.';
      if (!EMAIL_RE.test(e)) return 'That email address does not look valid (e.g. name@gmail.com).';
      if (lastCheck.email_taken && lastCheck.for_email === e) return 'This email is already registered. If you believe this is an error, please contact the Lifegen admin.';
      return '';
    }
    case 'age': {
      if (v.age === '') return 'Please enter your age.';
      const n = Number(v.age);
      if (!Number.isInteger(n) || String(v.age).includes('.')) return 'Age must be a whole number.';
      if (n < 5 || n > 100) return 'Age must be between 5 and 100.';
      return '';
    }
    case 'school': return tidy(v.school) ? '' : 'Please enter your school.';
    case 'ministry': return v.ministry ? '' : 'Please choose a ministry.';
    case 'leader_name': return tidy(v.leader_name) ? '' : "Please enter your leader's name.";
    case 'network_leader_name': return tidy(v.network_leader_name) ? '' : "Please enter your network leader's name.";
    default: return '';
  }
}
function values() {
  const o = {};
  for (const f of FIELDS) o[f] = form.elements[f] ? form.elements[f].value : '';
  o.website = form.elements.website.value;
  return o;
}
function showError(name, msg) {
  const el = form.elements[name];
  const box = $(`[data-error-for="${name}"]`);
  if (box) box.textContent = msg || '';
  if (el) { el.setAttribute('aria-invalid', msg ? 'true' : 'false'); el.closest('.field')?.classList.toggle('is-invalid', Boolean(msg)); }
}
function validateStep(n, { show = true } = {}) {
  let ok = true, first = null;
  for (const f of STEP_FIELDS[n]) {
    const msg = validateField(f);
    if (show) showError(f, msg);
    if (msg) { ok = false; first = first || f; }
  }
  if (!ok && show && first) form.elements[first].focus();
  return ok;
}
function allValid() { return validateStep(1, { show: false }) && validateStep(2, { show: false }); }

// ---- steps ----
function goto(n) {
  step = n;
  $$('.reg-step').forEach((fs) => { fs.hidden = Number(fs.dataset.step) !== n; });
  $$('[data-step-dot]').forEach((li) => {
    const k = Number(li.dataset.stepDot);
    li.classList.toggle('is-current', k === n); li.classList.toggle('is-done', k < n);
  });
  if (n === 3) renderReview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const first = $$('.reg-step')[n - 1].querySelector('input, select, button');
  if (first && window.matchMedia('(min-width: 600px)').matches) first.focus();
}
function renderReview() {
  const v = values();
  $('#regReview').innerHTML = FIELDS.map((f) => `<div><dt>${LABELS[f]}</dt><dd></dd></div>`).join('');
  $$('#regReview dd').forEach((dd, i) => { dd.textContent = f2(FIELDS[i], v[FIELDS[i]]); });
  $('#regDupWarn').hidden = !lastCheck.name_match;
  $('#regSubmitError').hidden = true;
  $('#regSubmit').disabled = !allValid();
}
function f2(f, v) { return f === 'email' ? tidy(v).toLowerCase() : tidy(v); }

// ---- duplicate pre-check (booleans only; server re-checks on submit) ----
let checkTimer = null;
function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, 400);
}
async function runCheck() {
  const v = values();
  const email = tidy(v.email).toLowerCase();
  const name = tidy(v.full_name);
  if (!EMAIL_RE.test(email) && name.split(' ').length < 2) return;
  try {
    const r = await api('POST', '/api/public/register/check', { full_name: name, email });
    lastCheck = { ...r, for_email: email, for_name: name.toLowerCase() };
    $('#nameWarn').hidden = !r.name_match;
    if (form.elements.email.value && !form.elements.email.matches(':focus')) showError('email', validateField('email'));
    else if (r.email_taken) showError('email', validateField('email'));
    if (step === 3) renderReview();
  } catch { /* best effort — the submit is the real check */ }
}

// ---- draft (sessionStorage so a refresh / failed submit never loses answers) ----
function saveDraft() {
  try { const v = values(); delete v.website; sessionStorage.setItem(DRAFT_KEY, JSON.stringify(v)); } catch { /* private mode */ }
}
function loadDraft() {
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
    if (!d) return;
    for (const f of FIELDS) if (form.elements[f] && d[f] != null) form.elements[f].value = d[f];
  } catch { /* ignore */ }
}

// ---- submit ----
async function submit() {
  if (!validateStep(1) ) { goto(1); return; }
  if (!validateStep(2)) { goto(2); return; }
  const btn = $('#regSubmit');
  btn.disabled = true; btn.classList.add('is-loading'); btn.setAttribute('aria-busy', 'true');
  $('#regSubmitError').hidden = true;
  const v = values();
  const body = {};
  for (const f of FIELDS) body[f] = f2(f, v[f]);
  body.age = Number(body.age);
  body.website = v.website;
  body.form_token = formToken;
  if (QR_TOKEN) body.qr_token = QR_TOKEN;
  try {
    const r = await api('POST', '/api/public/register', body);
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    $('#regRefCode').textContent = r.ref_code;
    form.hidden = true; $('#regFailed').hidden = true; $('#regSuccess').hidden = false;
    $('.reg-steps').hidden = true;
    window.scrollTo({ top: 0 });
    $('#regSuccess h2').setAttribute('tabindex', '-1'); $('#regSuccess h2').focus();
  } catch (e) {
    if (e.status === 400 && e.details && e.details.form === 'too_fast') {
      const box = $('#regSubmitError'); box.textContent = e.message; box.hidden = false;
    } else if (e.status === 400 && e.details && e.details.form === 'expired') {
      // form token aged out (phone slept for hours) → fetch a fresh one and let them tap Submit again; answers are kept
      try { const o = await api('GET', '/api/public/register/options' + (QR_TOKEN ? `?k=${encodeURIComponent(QR_TOKEN)}` : '')); formToken = o.form_token || formToken; } catch { /* keep old */ }
      const box = $('#regSubmitError'); box.textContent = 'Your session was refreshed. Please tap Submit Registration again.'; box.hidden = false;
    } else if (e.status === 400 && e.details && typeof e.details === 'object') {
      // field-level errors from the server → jump to the step that has the first one
      let firstStep = null;
      for (const [f, msg] of Object.entries(e.details)) { showError(f, msg); if (!firstStep) firstStep = STEP_FIELDS[1].includes(f) ? 1 : 2; }
      goto(firstStep || 1);
    } else if (e.status === 409 && e.details && e.details.reason === 'device') {
      showClosed({ reason: 'device', message: e.message, ref_code: e.details.ref_code });
    } else if (e.status === 409) {
      lastCheck = { ...lastCheck, email_taken: true, for_email: body.email };
      showError('email', e.message);
      const box = $('#regSubmitError'); box.textContent = e.message; box.hidden = false;
    } else if (e.status === 403) {
      showClosed({ reason: (e.details && e.details.reason) || 'disabled', message: e.message });
    } else if (e.status === 429) {
      const box = $('#regSubmitError'); box.textContent = e.message; box.hidden = false;
    } else {
      // network / server failure → dedicated failure screen with Retry (answers kept)
      $('#regFailedMsg').textContent = e.status ? `We couldn’t complete your registration right now. Please try again. (${e.message})` : 'We couldn’t complete your registration right now. Please check your internet connection and try again.';
      form.hidden = true; $('#regFailed').hidden = false;
      window.scrollTo({ top: 0 });
    }
  } finally {
    btn.classList.remove('is-loading'); btn.removeAttribute('aria-busy');
    btn.disabled = !allValid();
  }
}

// ---- closed states (window / expired QR / paused / disabled / blocked / device) ----
const CLOSED_TITLES = {
  disabled: 'Registration is currently unavailable',
  window: 'Registration is closed right now',
  expired: 'This QR code has expired',
  paused: 'Registration is paused for a moment',
  blocked: 'Registration could not be submitted',
  device: 'This phone already registered',
  ip_cap: 'Please see an usher',
};
function showClosed({ reason, message, ref_code }) {
  form.hidden = true; $('.reg-steps').hidden = true; $('#regFailed').hidden = true;
  $('#regClosedTitle').textContent = CLOSED_TITLES[reason] || CLOSED_TITLES.disabled;
  $('#regClosedMsg').textContent = message || 'The Lifegen team has paused online registration for now. Please approach any Lifegen leader or usher this Sunday and we will register you personally.';
  const ref = $('#regClosedRef'); ref.hidden = !ref_code; if (ref_code) ref.querySelector('strong').textContent = ref_code;
  $('#regClosed').hidden = false;
  window.scrollTo({ top: 0 });
}

// ---- boot ----
function fillList(id, items) {
  const dl = $(id);
  dl.innerHTML = '';
  for (const v of items || []) { const o = document.createElement('option'); o.value = v; dl.appendChild(o); }
}
async function boot() {
  try { deviceHeader = localStorage.getItem('lifegen.device') || null; } catch { /* ignore */ }
  try {
    options = await api('GET', '/api/public/register/options' + (QR_TOKEN ? `?k=${encodeURIComponent(QR_TOKEN)}` : ''));
  } catch (e) {
    $('#regLoading').hidden = true;
    $('#regFailedMsg').textContent = 'We couldn’t load the registration form right now. Please check your internet connection and try again.';
    $('#regFailed').hidden = false;
    $('#regRetry').onclick = () => { $('#regFailed').hidden = true; $('#regLoading').hidden = false; boot(); };
    return;
  }
  $('#regLoading').hidden = true;
  if (options.church_name) $('#regChurch').textContent = `${options.church_name} · ${options.service_name || 'Lifegen'}`;
  if (!options.enabled) { showClosed({ reason: options.closed_reason, message: options.closed_message }); return; }
  if (options.already_registered) {
    showClosed({ reason: 'device', message: `This phone already submitted a registration. One registration per person — if you need to change something, please tell your leader or the Lifegen admin.`, ref_code: options.ref_code });
    return;
  }
  formToken = options.form_token;
  const sel = form.elements.ministry;
  for (const m of options.ministries) { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); }
  fillList('#schoolList', options.schools);
  fillList('#leaderList', options.leaders);
  fillList('#networkLeaderList', options.network_leaders);
  loadDraft();
  form.hidden = false;

  form.addEventListener('input', (e) => {
    const name = e.target.name;
    if (name && e.target.getAttribute('aria-invalid') === 'true') showError(name, validateField(name));
    if (name === 'email' || name === 'full_name') { if (name === 'email') lastCheck = { ...lastCheck, email_taken: false }; scheduleCheck(); }
    if (step === 3) $('#regSubmit').disabled = !allValid();
    saveDraft();
  });
  form.addEventListener('focusout', (e) => { if (e.target.name && FIELDS.includes(e.target.name)) showError(e.target.name, validateField(e.target.name)); });
  form.addEventListener('click', (e) => {
    const next = e.target.closest('[data-next]'); const prev = e.target.closest('[data-prev]');
    if (next) { const n = Number(next.dataset.next); if (validateStep(n - 1)) goto(n); }
    if (prev) goto(Number(prev.dataset.prev));
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); if (step === 3) submit(); });
  form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && step < 3) { e.preventDefault(); if (validateStep(step)) goto(step + 1); } });
  $('#regRetry').onclick = () => { $('#regFailed').hidden = true; form.hidden = false; goto(3); submit(); };
  goto(1);
}
boot();
