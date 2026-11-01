const $ = (id) => document.getElementById(id);
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
      if (!response.ok) throw new Error(result.error || `Email service returned ${response.status}`);
      status.textContent = `Test email accepted by email service for ${recipients.length} recipient(s).`;
    } catch (error) { status.textContent = error.message || 'Unable to send test email.'; }
    finally { button.disabled = false; }
  });
}
