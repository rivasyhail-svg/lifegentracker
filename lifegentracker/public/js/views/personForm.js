import { api } from '../api.js';
import { html, raw, icon, toast, formData, withLoading, STATUS_LABELS, DAY_LABELS, TIME_LABELS, toISODate, initials } from '../ui.js';

/** Resize an image file to a small square JPEG data URL (client-side). */
export function fileToDataUrl(file, max = 320) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('Please choose an image file.'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = Math.min(max, side);
      canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

/** Shared person form markup. `p` may be null for a new person. */
export function personFormHtml(p = {}, { compact = false, defaults = {} } = {}) {
  const v = (k) => p?.[k] ?? defaults[k] ?? '';
  const field = (name, label, { type = 'text', required = false, help = '', placeholder = '', span = false, autocomplete = 'off' } = {}) => html`
    <div class="field ${span ? 'span-2' : ''}">
      <label for="f_${name}">${label}${required ? raw('<span class="req">*</span>') : raw('<span class="opt">optional</span>')}</label>
      ${type === 'textarea'
        ? html`<textarea id="f_${name}" name="${name}" placeholder="${placeholder}">${v(name)}</textarea>`
        : html`<input id="f_${name}" name="${name}" type="${type}" value="${v(name)}" placeholder="${placeholder}" autocomplete="${autocomplete}" ${required ? 'required' : ''} />`}
      ${help ? html`<span class="help">${help}</span>` : ''}
    </div>`;

  return html`
    <div class="form-section">
      <h3>Required</h3>
      <div class="form-grid">
        ${field('first_name', 'First name', { required: true, autocomplete: 'given-name' })}
        ${field('last_name', 'Last name', { required: true, autocomplete: 'family-name' })}
        ${field('contact_number', 'Contact number', { type: 'tel', required: true, placeholder: '09XX XXX XXXX', autocomplete: 'tel' })}
        <div class="field"><label for="f_status">Status<span class="req">*</span></label>
          <select id="f_status" name="status">${Object.entries(STATUS_LABELS).filter(([k]) => k !== 'inactive' || p?.status === 'inactive').map(([k, l]) => html`<option value="${k}" ${(v('status') || 'first_timer') === k ? 'selected' : ''}>${l}</option>`)}</select></div>
      </div>
    </div>
    <div class="form-section">
      <h3>Optional</h3>
      <div class="photo-picker mb-2">
        <span class="avatar avatar--lg" id="photoPreview">${p?.photo ? raw(`<img src="${p.photo}" alt="" />`) : (p?.first_name ? initials(p) : raw(icon('user', 28).value))}</span>
        <div>
          <div class="actions">
            <label class="btn btn--sm">${icon('camera')} ${p?.photo ? 'Change photo' : 'Add photo'}<input type="file" id="photoInput" accept="image/*" capture="user" hidden /></label>
            <button type="button" class="btn btn--sm btn--ghost" id="photoRemove" ${p?.photo ? '' : 'hidden'}>Remove</button>
          </div>
          <div class="help mt-1">Profile picture — resized automatically.</div>
          <input type="hidden" name="photo" id="photoValue" value="${p?.photo || ''}" />
        </div>
      </div>
      <div class="form-grid">
        ${field('middle_name', 'Middle name')}
        ${field('birthdate', 'Birthday', { type: 'date' })}
        <div class="field"><label for="f_sex">Sex<span class="opt">optional</span></label>
          <select id="f_sex" name="sex"><option value="">—</option><option value="male" ${v('sex') === 'male' ? 'selected' : ''}>Male (boy)</option><option value="female" ${v('sex') === 'female' ? 'selected' : ''}>Female (girl)</option></select></div>
        ${field('email', 'Email', { type: 'email', autocomplete: 'email' })}
        ${field('address', 'Address', { span: true, autocomplete: 'street-address' })}
        <div class="field span-2"><label class="toggle" for="f_privacy_consent"><input type="checkbox" id="f_privacy_consent" name="privacy_consent" value="1" ${p?.privacy_consent_at ? 'checked' : ''} /> The person agreed that Lifegen keeps their details for attendance and Lifegroup follow-up</label>
          <span class="help">${p?.privacy_consent_at ? `Recorded ${p.privacy_consent_at}. ` : ''}<a href="#/privacy" target="_blank" rel="noopener">Privacy notice</a></span></div>
        ${compact ? '' : html`
        ${field('school', 'School')}
        ${field('course_year', 'Course / Year level', { placeholder: 'e.g. BS Nursing – 2nd Year' })}
        ${field('age', 'Age', { type: 'number', placeholder: '18' })}
        ${field('ministry', 'Ministry', { placeholder: 'e.g. Ushering' })}
        ${field('occupation', 'Occupation')}
        ${field('date_registered', 'Date registered', { type: 'date' })}
        ${field('date_first_attended', 'Date first attended', { type: 'date' })}
        ${field('notes', 'Notes', { type: 'textarea', span: true })}`}
      </div>
    </div>`;
}

/** Wire photo picker behaviour inside a container. */
export function bindPhotoPicker(root) {
  const input = root.querySelector('#photoInput');
  const value = root.querySelector('#photoValue');
  const preview = root.querySelector('#photoPreview');
  const remove = root.querySelector('#photoRemove');
  if (!input) return;
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      const url = await fileToDataUrl(f);
      value.value = url;
      preview.innerHTML = `<img src="${url}" alt="" />`;
      remove.hidden = false;
    } catch (err) { toast(err.message, 'error'); }
    input.value = '';
  };
  remove.onclick = () => { value.value = ''; preview.innerHTML = icon('user', 28).value; remove.hidden = true; };
}

/**
 * Duplicate guard. Returns true when it is OK to save:
 *   - no possible duplicates → true
 *   - duplicates found → shows them inside `box` with a "Save anyway" choice and
 *     resolves true only if the user explicitly confirms. Pass excludeId when editing.
 * Network problems never block saving (the server's own validation still applies).
 */
export async function duplicateGuard(data, box, { excludeId = null } = {}) {
  let res;
  try {
    res = await api.duplicates({ first_name: data.first_name, last_name: data.last_name, contact_number: data.contact_number, email: data.email, birthdate: data.birthdate, exclude_id: excludeId });
  } catch (e) { return true; }
  const matches = (res && res.matches) || [];
  if (!matches.length) return true;
  // Already acknowledged these exact matches → let the save go through.
  const key = matches.map((m) => m.id).sort().join(',');
  if (box.dataset.ack === key) return true;

  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  box.className = 'alert alert--warn';
  box.innerHTML = `<div style="min-width:0;flex:1">
    <b>Possible duplicate found.</b> Please check before saving:
    <ul style="margin:6px 0 8px 18px;padding:0">
      ${matches.map((m) => `<li><a href="#/people/${m.id}" target="_blank" rel="noopener">${esc(m.first_name)} ${esc(m.last_name)}</a>
        <span class="muted">· ${esc(m.person_code)}${m.archived_at ? ' · archived' : ''} · ${esc(m.reasons.join(', '))}</span></li>`).join('')}
    </ul>
    <span class="small">If this is a different person, choose <b>Save anyway</b>.</span>
    <div class="row mt-1"><button type="button" class="btn btn--sm" data-dup="cancel">Review</button><button type="button" class="btn btn--sm btn--primary" data-dup="ok">Save anyway</button></div>
  </div>`;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return new Promise((resolve) => {
    box.querySelector('[data-dup="ok"]').onclick = () => { box.dataset.ack = key; box.hidden = true; resolve(true); };
    box.querySelector('[data-dup="cancel"]').onclick = () => { box.hidden = true; resolve(false); };
  });
}

/** Collect + normalise form values for the API. */
export function collectPerson(form) {
  const d = formData(form);
  for (const k of Object.keys(d)) if (d[k] === '') d[k] = null;
  const consent = form.querySelector('[name=privacy_consent]');
  if (consent) d.privacy_consent = consent.checked; // unchecked boxes are absent from FormData
  return d;
}

export async function renderPersonForm({ main, query }, id) {
  const editing = Boolean(id);
  let person = null;
  if (editing) person = await api.person(id);

  const defaults = { date_registered: toISODate(new Date()) };
  if (!editing && query.name) {
    const parts = query.name.trim().split(/\s+/);
    defaults.first_name = parts.slice(0, -1).join(' ') || parts[0];
    defaults.last_name = parts.length > 1 ? parts[parts.length - 1] : '';
  }

  main.innerHTML = html`
    <div class="page-header">
      <div>
        <a class="small" href="${editing ? `#/people/${id}` : '#/people'}">${icon('back', 14)} ${editing ? 'Back to profile' : 'Back to people'}</a>
        <h1 class="mt-1">${editing ? `Edit ${person.first_name} ${person.last_name}` : 'Add person'}</h1>
        ${editing ? html`<p class="sub">${person.person_code}</p>` : ''}
      </div>
    </div>
    <form id="personForm" class="card" novalidate>
      <div id="formError" class="alert alert--error" style="margin:20px 20px 0" hidden></div>
      <div id="dupBox" class="alert alert--warn" style="margin:20px 20px 0" hidden></div>
      ${raw(personFormHtml(person, { defaults }))}
      <div class="card__footer form-actions">
        <a class="btn" href="${editing ? `#/people/${id}` : '#/people'}">Cancel</a>
        <button class="btn btn--primary" type="submit">${editing ? 'Save changes' : 'Register'}</button>
      </div>
    </form>`;

  const form = main.querySelector('#personForm');
  bindPhotoPicker(form);
  const errBox = form.querySelector('#formError');
  form.querySelector('#f_first_name').focus();

  form.onsubmit = async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    const data = collectPerson(form);
    // QR-registered people have no contact number yet — staff may save without one and add it later.
    const required = person?.registration_source === 'qr' && !person?.contact_number ? ['first_name', 'last_name'] : ['first_name', 'last_name', 'contact_number'];
    const missing = required.find((k) => !data[k]);
    if (missing) {
      errBox.textContent = 'Please fill in first name, last name and contact number.';
      errBox.hidden = false;
      form.querySelector('#f_' + missing).focus();
      return;
    }
    await withLoading(form.querySelector('button[type=submit]'), async () => {
      try {
        if (!(await duplicateGuard(data, form.querySelector('#dupBox'), { excludeId: editing ? id : null }))) return;
        const saved = editing ? await api.updatePerson(id, data) : await api.createPerson(data);
        toast(editing ? 'Changes saved.' : `${saved.first_name} ${saved.last_name} registered · ${saved.person_code}`, 'success', 5000);
        location.hash = `#/people/${saved.id}`;
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  };
}
