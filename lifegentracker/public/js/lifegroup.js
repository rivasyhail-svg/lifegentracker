// Lifegroup leader report page (/lifegroup?t=TOKEN). No login: the token in the link is the key.
// Mobile-first, plain fetch; shares the look of the registration page.
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'LifegenTracker' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const token = new URLSearchParams(location.search).get('t') || '';
const body = document.getElementById('lgBody');
const lead = document.getElementById('lgLead');
const title = document.getElementById('lgTitle');

async function call(method, path, data) {
  const res = await fetch(path, { method, headers: H, body: data === undefined ? undefined : JSON.stringify(data), cache: 'no-store' });
  let out = null; try { out = await res.json(); } catch { /* no body */ }
  if (!res.ok) { const e = new Error(out?.error || `Request failed (${res.status})`); e.status = res.status; e.details = out?.details; throw e; }
  return out;
}
function toast(msg, type = 'success') {
  const t = document.createElement('div'); t.className = `toast toast--${type}`; t.textContent = msg;
  document.getElementById('toasts').appendChild(t); setTimeout(() => t.remove(), 3600);
}
const fmtDate = (s) => { const d = new Date(`${s}T00:00:00`); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
const weekLabel = (s) => { const d = new Date(`${s}T00:00:00`); return `${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`; };
const DAY = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

let d = null;

function render() {
  const g = d.group;
  title.textContent = `${g.name} · Weekly report`;
  lead.textContent = `Hi ${g.leader_name || 'Leader'}! Report your Lifegroup every week — it takes under a minute.${g.schedule_day ? ` Your schedule: ${DAY[g.schedule_day]}${g.schedule_time ? ' ' + g.schedule_time : ''}.` : ''}`;
  document.getElementById('lgChurch').textContent = d.church_name || '';
  const last = d.calendar[d.calendar.length - 1];
  const pct = Math.min(100, Math.round((d.solid / d.target) * 100));
  body.innerHTML = `
    <section class="card reg-card" style="padding:18px">
      <div class="row row--between"><b>${d.is_solid ? 'Solid Lifegroup 🎉' : 'Progress to a solid Lifegroup'}</b><span class="small muted">${d.solid}/${d.target} solid</span></div>
      <div class="progress mt-1"><span style="width:${pct}%"></span></div>
      <p class="small muted mt-1" style="margin-bottom:0">${d.is_solid ? `You have ${d.solid} solid members. Keep meeting every week!` : `${d.target - d.solid} more solid member${d.target - d.solid === 1 ? '' : 's'} to go. Tag a member <b>Solid</b> below once they are committed and consistent.`}</p>
      <div class="kpi-row mt-2" style="grid-template-columns:repeat(3,1fr)">
        <div class="kpi ${d.met_this_week ? '' : 'kpi--amber'}"><b>${d.met_this_week ? 'Yes' : last && last.meeting ? 'No' : '—'}</b><span>This week</span></div>
        <div class="kpi"><b>${d.held_last_4}<small>/4</small></b><span>Last 4 weeks</span></div>
        <div class="kpi"><b>${d.streak}</b><span>Week streak</span></div>
      </div>
      <div class="wk wk--md mt-2" aria-label="Last 8 weeks">${d.calendar.map((w) => { const m = w.meeting; return `<span class="wk__c ${!m ? 'wk__c--none' : m.held ? 'wk__c--held' : 'wk__c--skip'}" title="Week of ${weekLabel(w.week_start)}">${m && m.held ? m.present : m ? '×' : ''}</span>`; }).join('')}</div>
      <div class="small muted mt-1">Last 8 weeks · green = held (number present) · amber = no Lifegroup · dashed = not reported</div>
    </section>

    <form id="rep" class="card reg-card mt-2" novalidate>
      <fieldset class="reg-step">
        <legend class="reg-step-title"><span class="reg-step-no">1</span> This week's Lifegroup</legend>
        <div id="repErr" class="alert alert--error" hidden role="alert"></div>
        <div class="field"><label for="mdate">Date of the meeting</label><input class="input" id="mdate" type="date" max="${d.today}" value="${d.today}" required /><span class="help">Pick the day your Lifegroup met (or should have met).</span></div>
        <div class="field"><label>Did your Lifegroup meet?</label>
          <div class="choice"><label class="choice__opt"><input type="radio" name="held" value="1" checked /><span>Yes, we met</span></label><label class="choice__opt"><input type="radio" name="held" value="0" /><span>No Lifegroup</span></label></div></div>
        <div class="field" id="reasonWrap" hidden><label for="reason">Why no Lifegroup? <span class="req">*</span></label><input class="input" id="reason" maxlength="160" placeholder="e.g. exams week, I was sick, holiday" /></div>
        <div id="heldWrap">
          <div class="field"><label for="topic">Topic <span class="opt">optional</span></label><input class="input" id="topic" maxlength="160" placeholder="e.g. Prayer, Identity in Christ" /></div>
          <div class="field mt-1"><label>Who was present? <span class="small muted" id="presentCount"></span></label>
            ${d.members.length ? `<div class="checklist" id="presentList">${d.members.map((m) => `<label class="checklist__item"><input type="checkbox" name="present" value="${m.id}" /><span>${esc(m.name)}</span>${m.tier === 'solid' ? '<span class="badge badge--present badge--nodot">Solid</span>' : ''}</label>`).join('')}</div>` : '<p class="small muted">No members yet — add your first members below.</p>'}
          </div>
          <div class="field mt-1"><label for="newbies">New people this week <span class="opt">optional</span></label><textarea class="input" id="newbies" rows="2" placeholder="One full name per line, e.g. Juan Dela Cruz"></textarea><span class="help">They will be added to your Lifegroup as <b>New</b> and counted present. The Lifegen team completes their details later.</span></div>
        </div>
        <div class="field"><label for="notes">Notes for the Lifegen team <span class="opt">optional</span></label><textarea class="input" id="notes" rows="2" maxlength="1000" placeholder="Prayer requests, concerns, testimonies…"></textarea></div>
        <div class="reg-actions"><button class="btn btn--primary btn--lg" type="submit" id="repSave" style="width:100%">Send report</button></div>
      </fieldset>
    </form>

    <section class="card reg-card mt-2">
      <fieldset class="reg-step">
        <legend class="reg-step-title"><span class="reg-step-no">2</span> Your members <span class="small muted" style="font-weight:400">${d.total}</span></legend>
        <p class="small muted" style="margin:-6px 0 0">Tap <b>Mark Solid</b> when a member is committed and consistent. ${d.target} solid members = a solid Lifegroup. New people stay under <b>New</b> until then.</p>
        ${d.members.length ? `<div class="table-wrap"><table class="table"><tbody>${d.members.map((m) => `<tr>
          <td><b>${esc(m.name)}</b>${m.role !== 'member' ? ` <span class="badge badge--leader">${m.role === 'leader' ? 'Leader' : 'Assistant'}</span>` : ''}<div class="small muted">${m.meetings_attended} meeting${m.meetings_attended === 1 ? '' : 's'}${m.last_meeting_attended ? ` · last ${fmtDate(m.last_meeting_attended)}` : ''}</div></td>
          <td class="nowrap" style="text-align:right">${m.tier === 'solid' ? '<span class="badge badge--present badge--nodot">Solid</span> ' : '<span class="badge badge--nodot">New</span> '}<button type="button" class="btn btn--sm ${m.tier === 'solid' ? 'btn--ghost' : ''}" data-tier="${m.id}" data-to="${m.tier === 'solid' ? 'new' : 'solid'}">${m.tier === 'solid' ? 'Set as New' : 'Mark Solid'}</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="small muted">No members yet.</p>'}
      </fieldset>
    </section>

    ${d.recent.length ? `<section class="card reg-card mt-2"><fieldset class="reg-step"><legend class="reg-step-title"><span class="reg-step-no">3</span> Recent reports</legend>
      <ul class="small" style="margin:0;padding-left:18px;line-height:1.7">${d.recent.map((m) => `<li><b>${fmtDate(m.meeting_date)}</b> — ${m.held ? `held, ${m.present_count} present${m.topic ? ` · ${esc(m.topic)}` : ''}` : `no Lifegroup (${esc(m.no_meeting_reason || '')})`}</li>`).join('')}</ul>
      <p class="small muted" style="margin:0">Sending a report for the same date again replaces the earlier one.</p></fieldset></section>` : ''}`;

  const form = body.querySelector('#rep');
  const sync = () => { const held = form.querySelector('[name=held]:checked').value === '1'; form.querySelector('#reasonWrap').hidden = held; form.querySelector('#heldWrap').hidden = !held; };
  form.querySelectorAll('[name=held]').forEach((r) => r.addEventListener('change', sync));
  const count = () => { const n = form.querySelectorAll('[name=present]:checked').length; const el = form.querySelector('#presentCount'); if (el) el.textContent = n ? `· ${n} selected` : ''; };
  form.addEventListener('change', count);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('#repErr'); err.hidden = true;
    const held = form.querySelector('[name=held]:checked').value === '1';
    const payload = {
      meeting_date: form.querySelector('#mdate').value, held,
      no_meeting_reason: form.querySelector('#reason').value.trim() || null, topic: form.querySelector('#topic').value.trim() || null, notes: form.querySelector('#notes').value.trim() || null,
      present_ids: held ? [...form.querySelectorAll('[name=present]:checked')].map((c) => Number(c.value)) : [],
      new_members: held ? form.querySelector('#newbies').value.split('\n').map((s) => s.trim()).filter(Boolean).map((full_name) => ({ full_name })) : [],
    };
    if (!payload.meeting_date) { err.textContent = 'Please choose the meeting date.'; err.hidden = false; return; }
    if (!held && !payload.no_meeting_reason) { err.textContent = 'Please tell us why there was no Lifegroup.'; err.hidden = false; form.querySelector('#reason').focus(); return; }
    if (held && !payload.present_ids.length && !payload.new_members.length && !(await confirmNoOne())) return;
    const btn = form.querySelector('#repSave'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await call('POST', `/api/public/lifegroup/${encodeURIComponent(token)}/report`, payload);
      toast(r.updated ? 'Report updated. Thank you!' : 'Report sent. Thank you!');
      await load(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Send report'; if (ex.status === 404) setTimeout(load, 1500); }
  };
  body.querySelectorAll('[data-tier]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await call('PUT', `/api/public/lifegroup/${encodeURIComponent(token)}/members/${b.dataset.tier}/tier`, { tier: b.dataset.to }); toast(b.dataset.to === 'solid' ? 'Marked Solid.' : 'Set as New.'); await load(); }
      catch (ex) { toast(ex.message, 'error'); b.disabled = false; }
    };
  });
}
function confirmNoOne() { return Promise.resolve(window.confirm('No one is ticked as present. Send the report anyway?')); }

function renderError(e) {
  title.textContent = 'Lifegroup Report';
  lead.textContent = '';
  body.innerHTML = `<section class="card reg-card"><div class="reg-closed">
    <div class="empty__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
    <h2>${e.status === 404 ? 'This link is not valid' : 'Could not load your Lifegroup'}</h2>
    <p>${esc(e.message)}</p>
    ${e.status === 404 ? '' : '<button class="btn btn--primary" id="retry">Try again</button>'}
  </div></section>`;
  body.querySelector('#retry')?.addEventListener('click', load);
}

async function load() {
  if (!token) { renderError({ status: 404, message: 'Open the link exactly as the Lifegen admin sent it (it ends with ?t=…).' }); return; }
  try { d = await call('GET', `/api/public/lifegroup/${encodeURIComponent(token)}`); render(); }
  catch (e) { renderError(e); }
}
load();
