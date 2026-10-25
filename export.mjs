import fs from 'node:fs/promises';
import path from 'node:path';

const API = 'https://capi.yaanimail.com/gateway/v1';
const TOKEN = process.env.YAANI_TOKEN;
const DEVICE_ID = process.env.YAANI_DEVICE_ID;
const EMAIL = process.env.YAANI_EMAIL;
const OUT = path.resolve(process.env.OUT || './mails', EMAIL || '');
const SKIP = new Set((process.env.SKIP || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const PAGE = 200;

if (!TOKEN || !DEVICE_ID || !EMAIL) {
  console.error('YAANI_TOKEN, YAANI_DEVICE_ID ve YAANI_EMAIL ortam değişkenleri gerekli. README.md dosyasına bakın.');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Device-ID': DEVICE_ID,
  'Device-OS': 'WEB',
  'Device-Name': 'Mac - Chrome',
  'Device-Language': 'tr_TR',
  'App-Version': '1.9.15.2',
  Accept: 'application/json, text/plain, */*',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

class AuthError extends Error {}

async function call(url, opts = {}, attempt = 1) {
  let res;
  try {
    res = await fetch(url, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) } });
  } catch (e) {
    if (attempt >= 5) throw e;
    await sleep(1000 * 2 ** attempt);
    return call(url, opts, attempt + 1);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`Oturum geçersiz (${res.status}). Webmail'e yeniden girip yeni token alın, script kaldığı yerden devam eder.`);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`HTTP ${res.status}: ${url}`);
    await sleep(1500 * 2 ** attempt);
    return call(url, opts, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url} — ${(await res.text()).slice(0, 200)}`);
  return res;
}

function flattenFolders(list, acc = []) {
  for (const f of list || []) {
    acc.push(f);
    if (f.sub_folders?.length) flattenFolders(f.sub_folders, acc);
  }
  return acc;
}

function folderQuery(f) {
  const p = (f.absfolderpath || `/${f.name}`).replace(/^\//, '');
  return `in:"${p.includes('/') ? p : p.toLowerCase()}"`;
}

const safe = s => s.replace(/[\\:*?"<>|]/g, '_');

async function listMessages(f) {
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await call(`${API}/emails/messages/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: folderQuery(f), order: 'date', order_type: 'desc', types: 'message',
        limit: PAGE, offset, owner_email: EMAIL,
      }),
    });
    const page = await res.json();
    if (!Array.isArray(page)) throw new Error(`Beklenmeyen liste yanıtı: ${JSON.stringify(page).slice(0, 200)}`);
    all.push(...page.filter(m => String(m.folder_id) === String(f.id)));
    if (page.length < PAGE) break;
  }
  return all;
}

async function exists(file, size) {
  try { const st = await fs.stat(file); return !size || st.size === Number(size); } catch { return false; }
}

async function downloadOne(m, dir) {
  const file = path.join(dir, `${m.id}.eml`);
  if (await exists(file, m.size)) return 'skip';
  const res = await call(`${API}/emails/messages/${m.id}/details?raw=1&owner_email=${encodeURIComponent(EMAIL)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`Boş içerik: ${m.id}`);
  await fs.writeFile(file + '.part', buf);
  await fs.rename(file + '.part', file);
  return Number(m.size) && buf.length !== Number(m.size) ? 'sizediff' : 'ok';
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const folders = flattenFolders(await (await call(`${API}/emails/folders/all?include_shared_folders=1`)).json())
    .filter(f => !f.shared_mailbox && (!f.owner_email || f.owner_email === EMAIL));

  console.log(`\n${EMAIL} — ${folders.length} klasör bulundu:`);
  for (const f of folders) console.log(`  ${f.absfolderpath.padEnd(30)} ${String(f.mail_count).padStart(6)} mail  ${(f.size / 1048576).toFixed(0).padStart(6)} MB${SKIP.has(f.name.toLowerCase()) ? '  (atlanacak)' : ''}`);

  const summary = [];
  for (const f of folders) {
    if (SKIP.has(f.name.toLowerCase())) continue;
    const dir = path.join(OUT, ...f.absfolderpath.split('/').filter(Boolean).map(safe));
    await fs.mkdir(dir, { recursive: true });

    process.stdout.write(`\n[${f.absfolderpath}] listeleniyor... `);
    const msgs = await listMessages(f);
    console.log(`${msgs.length} / ${f.mail_count}`);
    if (msgs.length !== Number(f.mail_count)) console.warn(`  UYARI: listelenen sayı panelden farklı (${msgs.length} ≠ ${f.mail_count}).`);

    const meta = Object.fromEntries(msgs.map(m => [m.id, {
      time: m.time, date: m.date, unread: !!Number(m.unread), flag: !!Number(m.flag),
      replied: !!Number(m.replied), forwarded: !!Number(m.forwarded), draft: !!Number(m.drafts), size: Number(m.size),
    }]));
    await fs.writeFile(path.join(dir, '_meta.json'), JSON.stringify({ folder: f.absfolderpath, name: f.name, messages: meta }, null, 1));

    let ok = 0, skip = 0, fail = 0, diff = 0;
    await pool(msgs, CONCURRENCY, async m => {
      try {
        const r = await downloadOne(m, dir);
        if (r === 'skip') skip++; else ok++;
        if (r === 'sizediff') diff++;
      } catch (e) {
        if (e instanceof AuthError) throw e;
        fail++; console.error(`\n  HATA ${m.id}: ${e.message}`);
      }
      const done = ok + skip + fail;
      if (done % 25 === 0 || done === msgs.length) process.stdout.write(`\r  ${done}/${msgs.length}  (yeni ${ok}, atlandı ${skip}, hata ${fail})`);
    });
    console.log('');
    if (diff) console.log(`  Not: ${diff} mailin boyutu listedekinden farklı (genelde sorun değil).`);
    summary.push({ klasor: f.absfolderpath, panel: Number(f.mail_count), indirilen: ok + skip, hata: fail });
  }

  console.log('\nÖzet:');
  console.table(summary);
  const failed = summary.reduce((a, s) => a + s.hata, 0);
  console.log(failed ? `\n${failed} mail indirilemedi — script'i tekrar çalıştırın, sadece eksikleri dener.` : `\nTamamlandı. Mailler: ${OUT}`);
}

main().catch(e => {
  console.error('\n' + (e instanceof AuthError ? e.message : e.stack || e));
  process.exit(1);
});
