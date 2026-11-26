// Écran « adresse du serveur » de l'application Windows (connexion directe : réseau local ou VPN installé à part).
const q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const url = $('url'), msg = $('msg'), f = $('f');
url.value = q.get('server') || '';
const show = (text, kind) => { msg.textContent = text; msg.className = 'msg ' + kind; };
const clean = (e) => (e && e.message ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
if (q.get('error')) show(q.get('error'), 'err');
else if (q.get('info')) show(q.get('info'), 'info');
url.focus();

const d = window.cashproDesktop;
if (d.onStatus) d.onStatus((text) => show(text, 'info'));
const payload = () => ({ url: url.value });
const busy = (on) => { $('save').disabled = on; $('test').disabled = on; };

$('test').addEventListener('click', async () => {
  busy(true);
  try { const r = await d.testServer(payload()); show(`✓ CashPro ${r.version} — ${r.origin}`, 'ok'); }
  catch (e) { show('تعذّر الاتصال / Connexion impossible : ' + clean(e), 'err'); }
  finally { busy(false); }
});
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  busy(true);
  try { await d.saveServer(payload()); }
  catch (err) { show('تعذّر الاتصال / Connexion impossible : ' + clean(err), 'err'); }
  finally { busy(false); }
});
