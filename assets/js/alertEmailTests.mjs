const $ = (id) => document.getElementById(id);
let signInStarted = false;
async function offerSignIn() {
  const panel = $('auth-panel');
  if (!panel) return;
  panel.hidden = false;
  panel.scrollIntoView({behavior:'smooth', block:'center'});
  if (signInStarted) return;
  signInStarted = true;
  const status = $('auth-status');
  try {
    const res = await fetch('/api/config', {credentials:'same-origin',cache:'no-store'});
    const config = await res.json();
    if (!res.ok || !config.googleClientId) throw new Error('Google sign-in is not configured in Cloudflare.');
    const waitForGoogle = async () => {
      for (let i = 0; i < 40 && !window.google?.accounts?.id; i++) await new Promise(resolve => setTimeout(resolve, 150));
      if (!window.google?.accounts?.id) throw new Error('Google sign-in did not load. Disable blockers for accounts.google.com and reload.');
    };
    await waitForGoogle();
    google.accounts.id.initialize({client_id:config.googleClientId,callback:async ({credential})=>{
      try {
        status.textContent = 'Signing in…';
        const response = await fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({credential})});
        const result = await response.json().catch(()=>({}));
        if (!response.ok) throw new Error(result.error || 'Sign-in failed. Verify your Purchase access in the user registry.');
        status.textContent = 'Signed in. You can now click the test email button again.';
        panel.hidden = true;
      } catch (error) {status.textContent = error.message || 'Sign-in failed.';}
    }});
    google.accounts.id.renderButton($('google-signin'),{theme:'outline',size:'large',text:'signin_with',width:280});
    status.textContent = 'Sign in first, then retry the email.';
  } catch(error) {status.textContent = error.message || 'Unable to start Google sign-in.';}
}

try { document.documentElement.dataset.theme = localStorage.getItem('purchase-theme') || 'light'; } catch {}
$('theme').onclick = () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('purchase-theme', next); } catch {} };
for (const button of document.querySelectorAll('.send-alert')) {
  button.addEventListener('click', async () => {
    const type = button.dataset.type;
    const input = $(`to-${type}`);
    const status = $(`status-${type}`);
    const recipients = input.value.split(/[;,\s]+/).map(x => x.trim()).filter(Boolean);
    if (!recipients.length) { status.textContent = 'Enter at least one recipient email.'; input.focus(); return; }
    button.disabled = true; status.textContent = 'Sending test email…';
    try {
      const response = await fetch('/api/alert-test', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify({type, recipients}) });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) { await offerSignIn(); throw new Error('Sign in with Google above, then try sending again.'); }
      if (!response.ok) throw new Error(result.error || `Email service returned ${response.status}`);
      status.textContent = `Test email accepted by email service for ${recipients.length} recipient(s).`;
    } catch (error) { status.textContent = error.message || 'Unable to send test email.'; }
    finally { button.disabled = false; }
  });
}
