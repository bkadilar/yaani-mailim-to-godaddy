# yaani-mailim-to-godaddy

YaaniMail (mailim.com) hesabındaki mailleri GoDaddy'nin Titan mail servisine taşır.

## Nasıl çalışır

YaaniMail'de IMAP kapalı, bu yüzden normal taşıma araçları çalışmıyor. İş iki adımda yapılıyor:

1. **`export.mjs`**: Webmail'in kullandığı API'ye (`capi.yaanimail.com`) tarayıcıdan alınan token ile bağlanır. Klasörleri listeler, her maili ham haliyle `.eml` olarak indirir. Her klasöre okundu, bayrak ve tarih bilgilerini içeren bir `_meta.json` yazar.
2. **`import.mjs`**: İndirilen `.eml` dosyalarını IMAP `APPEND` ile Titan'a yükler. Tarihleri ve bayrakları `_meta.json`'dan alır. Inbox, Sent, Drafts, Trash ve Junk Titan'daki karşılıklarına gider, diğer klasörler aynı adla oluşturulur.

İki script de kaldığı yerden devam eder. Export, diskte olan mailleri tekrar indirmez. Import, yüklediklerini `_uploaded.json` dosyasına yazar.

Ekler mailin içinde olduğu için onlar da taşınır. Kişiler ve takvim taşınmaz.

## Kurulum

Node.js 20.6 veya üzeri gerekir.

```bash
npm install
cp .env.example .env
```

## Token alma

mailim.com'a giriş yapın, tarayıcı Console'una (`Cmd + Option + J`) yapıştırın:

```js
(async () => {
  const all = Object.keys(localStorage).map(k => localStorage.getItem(k) || '').join('\n');
  const toks = [...new Set(all.match(/[A-Za-z0-9._-]{32,}/g) || [])];
  const devs = [...new Set(all.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])];
  for (const t of toks) for (const d of devs) {
    const r = await fetch('https://capi.yaanimail.com/gateway/v1/emails/info',
      { headers: { Authorization: 'Bearer ' + t, 'Device-ID': d, 'Device-OS': 'WEB', 'App-Version': '1.9.15.2' } });
    if (r.ok) {
      const email = location.pathname.split('/')[2];
      copy(`YAANI_TOKEN=${t}\nYAANI_DEVICE_ID=${d}\nYAANI_EMAIL=${email}`);
      return 'Panoya kopyalandı';
    }
  }
  return 'Bulunamadı';
})()
```

Panoya kopyalanan üç satırı `.env`'e yapıştırın. Script bulamazsa: DevTools → Network → herhangi bir `capi.yaanimail.com` isteği → `Authorization` (Bearer sonrası) ve `Device-ID` header'ları.

## Komutlar

| Komut | Açıklama |
| --- | --- |
| `npm run export` | Mailleri `mails/<e-posta>/<klasör>/` altına indirir |
| `npm run import:dry` | Neyin nereye gideceğini gösterir, bir şey yüklemez |
| `npm run import` | Mailleri Titan'a yükler |

## Ayarlar (.env)

| Değişken | Açıklama |
| --- | --- |
| `YAANI_TOKEN`, `YAANI_DEVICE_ID`, `YAANI_EMAIL` | Webmail'den alınan oturum bilgileri |
| `TITAN_EMAIL`, `TITAN_PASSWORD` | Titan hesabı |
| `TITAN_HOST` | Varsayılan `imap.titan.email` |
| `SKIP` | Atlanacak klasörler, örn. `Junk,Trash` |
| `CONCURRENCY` | Aynı anda indirilecek mail sayısı, varsayılan 3 |
| `OUT` / `SRC` | İndirme ve yükleme klasörü, varsayılan `./mails` |

## Geçiş sırası

1. `npm run export` ve `npm run import`. Bu sırada mailler hâlâ YaaniMail'e gelir.
2. DNS'te MX ve SPF kayıtlarını Titan'a çevirin.
3. 1-2 gün sonra yeni token alıp iki komutu tekrar çalıştırın, aradaki mailler de taşınır.

Token süresi dolarsa (`Oturum geçersiz` hatası) yenisini alıp aynı komutu tekrar çalıştırın.

Birden fazla hesap için `.env`'deki bilgileri değiştirip adımları tekrarlayın, her hesap kendi klasörüne iner.
