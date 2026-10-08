import { api } from '../api.js';
import { esc, formData, withLoading } from '../ui.js';

function shell(title, subtitle, body, foot = '') {
  return `
    <div class="auth">
      <div class="auth__card">
        <div class="auth__brand">
          <span class="brand__mark">LG</span>
          <div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>
        </div>
        <div class="card"><div class="card__body">${body}</div></div>
        <p class="auth__foot">LifegenTracker · Lifegen / 3rd Service attendance${foot} · <a href="#/privacy">Privacy &amp; Terms</a></p>
      </div>
    </div>`;
}

export function renderLogin(root, onSuccess) {
  root.innerHTML = shell('LifegenTracker', 'Sign in to continue', `
    <form id="loginForm" class="stack" novalidate>
      <div id="loginError" class="alert alert--error" hidden></div>
      <div class="field"><label for="u">Username</label><input id="u" name="username" autocomplete="username" required autofocus /></div>
      <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required /></div>
      <button class="btn btn--primary btn--lg btn--block" type="submit">Sign in</button>
    </form>`);
  const form = root.querySelector('#loginForm');
  const errBox = root.querySelector('#loginError');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const { username, password } = formData(form);
    errBox.hidden = true;
    if (!username || !password) { errBox.textContent = 'Please enter your username and password.'; errBox.hidden = false; return; }
    await withLoading(form.querySelector('button'), async () => {
      try {
        const { user } = await api.login(username, password);
        onSuccess(user);
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
      }
    });
  };
}

export function renderSetup(root, onSuccess) {
  root.innerHTML = shell('Welcome to LifegenTracker', 'Create the first administrator account to get started', `
    <form id="setupForm" class="stack" novalidate>
      <div class="alert alert--info">This one-time setup creates the Admin account. You can add Attendance Staff and Viewer accounts later from Settings.</div>
      <div id="setupError" class="alert alert--error" hidden></div>
      <div class="field"><label>Church name</label><input name="church_name" value="Lifegiver Church of Faith" /></div>
      <div class="field"><label>Your name <span class="req">*</span></label><input name="display_name" placeholder="e.g. Pastor Juan" required /></div>
      <div class="field"><label>Username <span class="req">*</span></label><input name="username" autocomplete="username" placeholder="e.g. admin" required /><span class="help">3–32 characters: letters, numbers, dots, dashes or underscores.</span></div>
      <div class="field"><label>Password <span class="req">*</span></label><input name="password" type="password" autocomplete="new-password" required /><span class="help">At least 8 characters.</span></div>
      <div class="field"><label>Confirm password <span class="req">*</span></label><input name="confirm" type="password" autocomplete="new-password" required /></div>
      <button class="btn btn--primary btn--lg btn--block" type="submit">Create admin account</button>
    </form>`);
  const form = root.querySelector('#setupForm');
  const errBox = root.querySelector('#setupError');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(form);
    errBox.hidden = true;
    if (d.password !== d.confirm) { errBox.textContent = 'Passwords do not match.'; errBox.hidden = false; return; }
    await withLoading(form.querySelector('button'), async () => {
      try {
        const { user } = await api.setup({ church_name: d.church_name, display_name: d.display_name, username: d.username, password: d.password });
        onSuccess(user);
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
      }
    });
  };
}
