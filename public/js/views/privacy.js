import { state } from '../app.js';
import { html, raw, icon } from '../ui.js';

/**
 * Privacy notice + terms of use for LifegenTracker.
 * Plain language, written for the Lifegen team and the people whose details are kept.
 * Reachable before sign-in (#/privacy) and from Settings.
 */
export function privacyContent(settings = state.settings || {}) {
  const church = settings.church_name || 'the church';
  const contact = settings.privacy_contact || settings.church_contact || '';
  const address = settings.church_address || '';
  const standalone = Boolean(state.standalone);
  return html`
    <div class="privacy">
      <section>
        <h2>Privacy notice</h2>
        <p>LifegenTracker is an internal tool of <b>${church}</b> for the Lifegen / 3rd Service. It keeps a simple record of who attends on Sundays and which Lifegroup each person belongs to, so leaders can follow up and care for people. This notice explains what is stored, why, and your rights under the <b>Data Privacy Act of 2012 (Republic Act 10173)</b>.</p>
      </section>
      <section>
        <h3>What we collect — only what is needed</h3>
        <ul>
          <li><b>Required:</b> name, contact number, and attendance status (first timer, returning, regular…).</li>
          <li><b>Optional, only if you give it:</b> birthday, boy/girl, email, address, school or course, occupation, a photo, Lifegroup preferences (area, day, time) and short notes written by staff.</li>
          <li><b>Created by the system:</b> which Sundays you were present, your Lifegroup membership and its history, and when your record was changed and by whom.</li>
        </ul>
        <p>We do not collect government IDs, financial details, or anything not needed for attendance and Lifegroup follow-up.</p>
      </section>
      <section>
        <h3>Why we use it</h3>
        <ul>
          <li>To know who came on Sunday and to welcome first timers.</li>
          <li>To connect people to a Lifegroup near them and keep that connection accurate.</li>
          <li>To give leaders simple counts (attendance, boys/girls groups, growth). Reports are totals, not profiles.</li>
        </ul>
      </section>
      <section>
        <h3>Consent</h3>
        <p>When you are registered, staff ask if you agree that Lifegen keeps your details for this purpose and tick <i>privacy consent</i> on your record with the date. You can say no, change your mind, or ask what is stored about you at any time.</p>
      </section>
      <section>
        <h3>Who can see it</h3>
        <ul>
          <li>Only signed-in Lifegen staff. <b>Admins</b> manage everything, <b>Attendance staff</b> mark attendance and register people, <b>Viewers</b> see names and counts only — contact numbers, email, address and notes are hidden from them.</li>
          <li>Your details are <b>never sold or shared</b> with anyone outside the church, and there is no advertising.</li>
        </ul>
      </section>
      <section>
        <h3>Where it is stored and for how long</h3>
        ${standalone
          ? html`<p>This copy of LifegenTracker runs <b>entirely in this browser</b> — data stays on this device (browser storage) and is not sent to any server. Backups you download are your responsibility to keep safe.</p>`
          : html`<p>Data is kept in the church's own database on the church's server — not on a third-party cloud service. Daily backups are kept for 14 days.</p>`}
        <p>Records are kept while you are part of Lifegen. Inactive people can be deactivated, then archived or deleted by an Admin on request.</p>
      </section>
      <section>
        <h3>Cookies and tracking</h3>
        <p>${standalone ? html`This page sets no cookies.` : html`The only cookie is a <b>strictly necessary sign-in session</b> cookie for staff; it holds no personal details and is removed on sign-out.`} There are <b>no analytics, no advertising trackers, no social-media embeds and no third-party scripts or fonts</b>. Because nothing is tracked, no cookie banner is needed.</p>
      </section>
      <section>
        <h3>Your rights</h3>
        <p>Under RA 10173 you may ask to <b>see</b>, <b>correct</b>, <b>withdraw consent</b> for, or <b>delete</b> your record, and to object to how it is used. Ask any Lifegen leader or contact the person below — requests are handled by an Admin and logged.</p>
        <p class="privacy__contact">${icon('people', 15)} <b>Data privacy contact:</b> ${contact || raw('<span class="muted">not set yet — ask your Lifegen leader (Admins: Settings → Church details)</span>')}${address ? html`<br />${icon('pin', 15)} ${church}, ${address}` : ''}</p>
      </section>

      <section class="privacy__terms">
        <h2>Terms of use (for staff)</h2>
        <ol>
          <li>Use LifegenTracker only for Lifegen attendance and Lifegroup care. Do not copy member details to personal apps, chats or spreadsheets.</li>
          <li>Keep your account to yourself. Sign out on shared devices. Report a lost device or suspected misuse to an Admin at once.</li>
          <li>Record only what is true and needed. Notes must be respectful — the person may read them.</li>
          <li>Ask for consent when registering someone, and respect a "no".</li>
          <li>Every change is written to the activity log with your name.</li>
          <li>Lifegroups and Networks are boys-only or girls-only — never combined — as set by the church.</li>
        </ol>
        <p class="small muted">LifegenTracker is provided as-is for church use. It is not a legal service; for formal data-protection questions consult the National Privacy Commission (privacy.gov.ph) or the church's counsel.</p>
      </section>
    </div>`;
}

/** Signed-in page */
export async function renderPrivacy({ main }) {
  main.innerHTML = html`
    <div class="page-header">
      <div><h1>Privacy &amp; Terms</h1><p class="sub">How ${state.settings.church_name} handles the details kept in LifegenTracker.</p></div>
      <div class="page-actions"><button class="btn" id="printPrivacy">${icon('print')} Print</button></div>
    </div>
    <div class="card"><div class="card__body">${privacyContent()}</div></div>`;
  main.querySelector('#printPrivacy').onclick = () => window.print();
}

/** Public page (before sign-in) */
export function renderPublicPrivacy(root) {
  root.innerHTML = html`
    <div class="auth auth--wide">
      <div class="auth__card" style="max-width:760px">
        <div class="auth__brand"><span class="brand__mark">LG</span><div><h1>Privacy &amp; Terms</h1><p>${state.settings.church_name} · LifegenTracker</p></div></div>
        <div class="card"><div class="card__body">${privacyContent()}</div></div>
        <p class="auth__foot"><a href="#/dashboard">${icon('chevL', 13)} Back to sign in</a></p>
      </div>
    </div>`.value;
}
