import fs from 'node:fs/promises';
import path from 'node:path';
import { ImapFlow } from 'imapflow';

const EMAIL = process.env.TITAN_EMAIL;
const PASSWORD = process.env.TITAN_PASSWORD;
const HOST = process.env.TITAN_HOST || 'imap.titan.email';
const SRC = path.resolve(process.env.SRC || path.join('./mails', EMAIL || ''));
const SKIP = new Set((process.env.SKIP || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const DRY = !!process.env.DRY_RUN;

if (!EMAIL || (!PASSWORD && !DRY)) {
  console.error('TITAN_EMAIL ve TITAN_PASSWORD ortam değişkenleri gerekli. README.md dosyasına bakın.');
  process.exit(1);
}

const SPECIAL = { inbox: 'INBOX', sent: '\\Sent', drafts: '\\Drafts', trash: '\\Trash', junk: '\\Junk' };

async function findFolderDirs(root) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (entries.some(e => e.name === '_meta.json')) out.push(dir);
    for (const e of entries) if (e.isDirectory()) await walk(path.join(dir, e.name));
  }
  await walk(root);
  return out;
}

async function resolveTarget(client, mailboxes, yaaniPath) {
  const parts = yaaniPath.split('/').filter(Boolean);
  const top = parts[0].toLowerCase();
  if (parts.length === 1 && SPECIAL[top]) {
    if (SPECIAL[top] === 'INBOX') return 'INBOX';
    const mb = mailboxes.find(m => m.specialUse === SPECIAL[top]);
    if (mb) return mb.path;
  }
  const delim = mailboxes[0]?.delimiter || '/';
  const target = parts.join(delim);
  if (!mailboxes.some(m => m.path === target) && !DRY) {
    await client.mailboxCreate(parts);
    mailboxes.push({ path: target, delimiter: delim });
  }
  return target;
}

async function main() {
  const dirs = await findFolderDirs(SRC);
  if (!dirs.length) throw new Error(`${SRC} altında indirilmiş klasör bulunamadı. Önce export.mjs çalıştırın.`);

  const client = new ImapFlow({ host: HOST, port: 993, secure: true, auth: { user: EMAIL, pass: PASSWORD }, logger: false });
  if (!DRY) {
    console.log(`${HOST}:993 sunucusuna ${EMAIL} ile bağlanılıyor...`);
    await client.connect();
    console.log('Giriş başarılı.');
  }
  const mailboxes = DRY ? [] : await client.list();
  if (!DRY) console.log('Sunucudaki klasörler: ' + mailboxes.map(m => m.path + (m.specialUse ? ` (${m.specialUse})` : '')).join(', '));

  const summary = [];
  for (const dir of dirs) {
    const meta = JSON.parse(await fs.readFile(path.join(dir, '_meta.json'), 'utf8'));
    if (SKIP.has(meta.name.toLowerCase())) { console.log(`[${meta.folder}] atlandı`); continue; }

    const target = await resolveTarget(client, mailboxes, meta.folder);
    const stateFile = path.join(dir, '_uploaded.json');
    const uploaded = new Set(JSON.parse(await fs.readFile(stateFile, 'utf8').catch(() => '[]')));
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.eml'));
    console.log(`\n[${meta.folder}] -> Titan "${target}"  (${files.length} mail, ${uploaded.size} önceden yüklenmiş)`);

    let ok = 0, fail = 0, n = 0;
    for (const f of files) {
      const id = f.replace(/\.eml$/, '');
      n++;
      if (uploaded.has(id)) continue;
      const m = meta.messages[id] || {};
      const flags = [];
      if (!m.unread) flags.push('\\Seen');
      if (m.flag) flags.push('\\Flagged');
      if (m.replied) flags.push('\\Answered');
      if (m.draft) flags.push('\\Draft');
      const date = m.time ? new Date(m.time * 1000) : undefined;
      try {
        if (!DRY) {
          const raw = await fs.readFile(path.join(dir, f));
          await client.append(target, raw, flags, date);
        }
        uploaded.add(id); ok++;
        if (ok % 25 === 0 && !DRY) await fs.writeFile(stateFile, JSON.stringify([...uploaded]));
      } catch (e) {
        fail++; console.error(`\n  HATA ${id}: ${e.responseText || e.message}`);
        if (!client.usable && !DRY) { await fs.writeFile(stateFile, JSON.stringify([...uploaded])); throw new Error('IMAP bağlantısı koptu, script\'i tekrar çalıştırın (kaldığı yerden devam eder).'); }
      }
      if (n % 25 === 0 || n === files.length) process.stdout.write(`\r  ${n}/${files.length}  (yüklenen ${ok}, hata ${fail})`);
    }
    if (!DRY) await fs.writeFile(stateFile, JSON.stringify([...uploaded]));
    console.log('');
    summary.push({ klasor: meta.folder, hedef: target, toplam: files.length, yuklu: uploaded.size, hata: fail });
  }

  if (!DRY) await client.logout();
  console.log('\nÖzet:');
  console.table(summary);
  const failed = summary.reduce((a, s) => a + s.hata, 0);
  console.log(failed ? `\n${failed} mail yüklenemedi — tekrar çalıştırın, sadece eksikleri dener.` : '\nTamamlandı.');
}

main().catch(e => {
  console.error('\nHATA: ' + e.message);
  if (e.authenticationFailed) console.error('→ Giriş reddedildi. TITAN_EMAIL / TITAN_PASSWORD doğru mu? Kutu GoDaddy\'de yeni oluşturulduysa birkaç dakika bekleyin; webmail\'e (email.secureserver.net) bir kez giriş yapıp ilk kurulumu tamamlayın.');
  for (const k of ['responseText', 'serverResponseCode', 'responseStatus', 'executedCommand', 'code']) if (e[k]) console.error(`  ${k}: ${String(e[k]).replace(PASSWORD || '\u0000', '***')}`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
