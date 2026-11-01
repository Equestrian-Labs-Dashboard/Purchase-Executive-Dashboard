import { authorize } from '../_lib/authz.js';
import { canUseReport } from '../_lib/registry.js';
import { json } from '../_lib/http.js';

const ALERTS = {
  margin: {
    subject: '[TEST] Purchase alert — Gross margin below 20%',
    title: 'Gross margin below 20%',
    rule: 'Products sold during the previous week with gross margin below 20%.',
    next: 'The automated version will list each affected product, sales period, gross margin and supporting values.'
  },
  sellthrough: {
    subject: '[TEST] Purchase alert — Critically low sell-through',
    title: 'Critically low sell-through',
    rule: 'Products materially below the expected sell-through at 30, 60 or 90 days from the inventory receipt date.',
    next: 'The automated version will compare each eligible receipt cohort with the approved 30/60/90-day goals and show the largest gaps.'
  },
  stockrisk: {
    subject: '[TEST] Purchase alert — Stock at risk',
    title: 'Stock at risk',
    rule: 'Products whose available stock may be insufficient compared with seasonal demand for the same period last year.',
    next: 'The comparison baseline (same month last year or the comparable three-month average) still needs final approval before automation.'
  },
  discounts: {
    subject: '[TEST] Purchase alert — Discount exceptions',
    title: 'Discount exceptions',
    rule: 'Orders with a discount greater than 20%, or more than one discount code applied to the same order.',
    next: 'The automated version will list the order, discount codes, discount percentage and margin impact where available.'
  }
};
const validEmail = value => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value) && value.length <= 254;
const reply = (body, status=200) => json(body, status);

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (request.method !== 'POST') return reply({error:'Method not allowed.'},405);
  if (request.headers.get('origin') !== url.origin) return reply({error:'Same-origin request required.'},403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({error:'JSON body required.'},415);
  let user;
  try {
    ({user} = await authorize(context));
    if (!canUseReport(user, 'purchase_executive')) return reply({error:'Purchase report access is required.'},403);
  } catch (error) {
    return reply({error:Number(error.status) < 500 ? error.message : 'Unable to verify Purchase access.'},Number(error.status)||401);
  }
  if (!env.RESEND_API_KEY || !env.PURCHASE_ALERT_FROM) return reply({error:'Email sending is not configured yet. Add RESEND_API_KEY and PURCHASE_ALERT_FROM in Cloudflare Pages environment variables.'},503);
  let payload;
  try { payload = await request.json(); } catch { return reply({error:'Invalid JSON.'},400); }
  const alert = ALERTS[payload?.type];
  const recipients = Array.isArray(payload?.recipients) ? [...new Set(payload.recipients.map(x=>String(x).trim().toLowerCase()))] : [];
  if (!alert) return reply({error:'Unknown alert type.'},400);
  if (!recipients.length || recipients.length > 8 || recipients.some(x=>!validEmail(x))) return reply({error:'Enter between 1 and 8 valid email addresses.'},400);

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#20302a;line-height:1.55"><div style="max-width:620px;margin:auto;padding:24px"><p style="font-size:12px;letter-spacing:2px;color:#52745d;font-weight:bold">EQUESTRIAN LABS · CORRO PURCHASE</p><div style="display:inline-block;padding:6px 10px;background:#fff0cc;color:#805900;font-size:12px;font-weight:bold">TEST EMAIL — NOT A LIVE ALERT</div><h1 style="font-size:24px">${alert.title}</h1><p><strong>Requested rule:</strong> ${alert.rule}</p><p>${alert.next}</p><hr style="border:0;border-top:1px solid #ddd;margin:24px 0"><p style="font-size:12px;color:#65736c">This message was sent manually from the Purchase Alert Testing Centre by ${String(user.email).replace(/[&<>"']/g,'')} . No automatic alert rule has been activated.</p></div></body></html>`;
  const text = `TEST EMAIL — NOT A LIVE ALERT\n\n${alert.title}\n\nRequested rule: ${alert.rule}\n\n${alert.next}\n\nSent manually from Purchase Alert Testing Centre. No automatic alert rule has been activated.`;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{'Authorization':`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({from:env.PURCHASE_ALERT_FROM,to:recipients,subject:alert.subject,html,text})
    });
    const result = await response.json().catch(()=>({}));
    if (!response.ok) return reply({error:result.message || result.name || 'Email provider rejected the message.'},502);
    return reply({ok:true,id:result.id,recipientCount:recipients.length});
  } catch {
    return reply({error:'Could not reach the email provider. Please try again.'},502);
  }
}
