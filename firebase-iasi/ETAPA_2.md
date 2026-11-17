# Etapa 2 — aplicații conectate

Implementare locală, 16.11.2026. Backendul este exclusiv `firebase-iasi`; frontendurile active sunt `next-js/demo` și Expo. Configurația și datele OTP nu sunt utilizate.

## Fluxul de lucru

1. Un administrator se autentifică și deschide **Setări**. Configurează tariful pe zi începută, activarea cererilor, programul de fidelizare, punctele/zi achitată, pragul, procentul reducerii și minutele mementourilor. Numai rolul `admin` poate salva aceste setări. Valorile cloud nu sunt inițializate automat cu tarife demo.
2. Clientul intră cu email + telefon. Draftul, contactele și datele recente proprii se păstrează pe dispozitiv. Orele introduse sunt ale parcării, `Europe/Bucharest`; serverul respinge orele inexistente sau ambigue la schimbarea orei.
3. Sumarul vine de la server, în bani întregi. Clientul poate aplica beneficiul disponibil și trimite **o cerere**, fără încasare și fără promisiune automată a unui loc. Personalul verifică și confirmă cererea.
4. Administrația poate crea manual, edita, confirma/anula, înregistra sosirea/plecarea și încasarea la locație. Comenzile sunt idempotente, au revision și audit. Totalul personalizat pentru o rezervare neachitată cere motiv. Încasarea și prețul unei rezervări plătite rămân neschimbate; prelungirile indică separat diferența de regularizat.
5. Punctele se acordă o singură dată la încasare, folosind regula salvată la creare. La prima trecere a pragului se acordă un beneficiu; alte beneficii pot fi acordate manual. Un beneficiu este rezervat atomic unei singure cereri și consumat la încasare. Anularea unei cereri neachitate îl eliberează. Anularea unei rezervări plătite nu produce rambursare, reset de beneficiu sau retragere automată a punctelor.
6. Fidelizarea admin folosește sumarul clienților cu minimum două rezervări confirmate, neanulate. Istoricul rezervărilor și registrul ajustărilor se deschid separat, paginat. Ajustările cer motiv și versiunea curentă.
7. Rapoartele folosesc proiecțiile `movements`, cu ore programate și efective distincte. CSV-ul citește întregul interval în loturi de 500, cu memorie limitată și control de debit. Include UTF-8 și protecție împotriva formulelor. Exportul nu este un snapshot tranzacțional global; operatorii pot modifica date în timpul generării.
8. Notificările de cerere, confirmare, modificare, sosire/plecare, încasare, anulare și ajustare a beneficiilor sunt persistente. „Citit toate” avansează un watermark; nu rescrie fiecare mesaj. Alertele de întârziere refolosesc listele operative și calculează timpul local, fără scanări/scrieri periodice pe rezervări.

## Citiri și cache

- Expo: configurație 15 minute, profil/fidelizare/liste 60 secunde. Datele locale proprii sunt disponibile până la 24 h dacă serverul nu răspunde. Cache de date: maximum 20 intrări persistate/UID și 40 în memorie; draftul se păstrează separat. Cache-ul se elimină la schimbarea utilizatorului.
- Un singur request în curs pentru aceeași resursă; răspunsurile întârziate nu suprascriu alt filtru sau alt UID. Crearea reușită completează cache-ul detaliului din răspunsul comenzii.
- Tabul Expo selectat citește 20 rezervări + cursor; celelalte taburi nu sunt descărcate integral. Clasificarea după timp se face în query, nu prin scrieri zilnice.
- Admin: cache doar în memorie, pe UID și filtre, 30 secunde; rapoarte 2 minute. Fără date de clienți în localStorage pe calculatoare comune.
- Azi/Alerte folosesc aceleași trei liste live de maximum 50 documente și două documente statistice, cu actualizări incrementale. Listele se opresc la schimbarea secțiunii sau ascunderea paginii. Paginile suplimentare sunt încărcate numai la cerere; prima trecere la paginare API recitește cel mult prima pagină pentru cursor.
- Clopoțelul folosește un singur document metadata personal. Inboxul urmărește live numai cele mai recente 20 de notificări când este deschis, iar arhiva are cursor.
- Admin Rezervări/Clienți: pagini de 50; rapoarte 100; audit/ledger 20. API-ul folosește un document suplimentar de lookahead pentru a determina cursorul, deci limitele de UI nu sunt promisiuni de cost exact 20/50/100 citiri.
- Căutare după prefix de nume, telefon, auto sau cod; fără descărcarea arhivei pentru `.includes()`. Minimum două caractere sau patru cifre pentru telefon. Intervalul admin păstrează semantica sosire **sau** plecare în interval.
- Indexurile declarate se generează prin `npm run foundation:indexes`. Emulatorul verifică funcționalitatea query-urilor, nu facturează și nu demonstrează costul real al indexurilor. Publicarea indexurilor noi și Query Explain în staging rămân verificări de release.

## Mementouri

`notificationReminders` verifică numai `jobs` pending scadente, cu query indexat și limită de 100/rulare. Rulează la 15 minute după publicarea funcției programate. Joburile verifică revision/stare/destinatar și au deduplicare pentru aceeași oră programată. Modificarea/anularea invalidează programările vechi.

În emulatoarele de dezvoltare funcția programată nu pornește automat. Rulează manual, numai local:

```sh
# Din next-js, cu Auth/Firestore pornite:
npm run foundation:reminders
```

Sunt notificări în aplicație. Push, email, SMS și Cloud Tasks nu au fost activate. Față de propunerea inițială cu Tasks și fișiere private pentru exporturi mari, această etapă folosește un dispatcher indexat la 15 minute și export CSV în flux; nu presupune servicii plătite configurate.

## Verificare și pornire

Vezi [README](README.md) pentru emulatoare, seed și porturi. Înaintea testelor API oprește emulatoarele interactive, deoarece proiectul de test trebuie să fie `demo-parcare-iasi` și tokenurile trebuie emise pentru același proiect.

```sh
# next-js
npm run foundation:test
npm run build

# expo-mobile-app, după terminarea buildului Next:
npm run typecheck
PLAYWRIGHT_CHANNEL=chrome npm run test:foundation
PLAYWRIGHT_CHANNEL=chrome npm run test:frontend
EXPO_OFFLINE=1 npx expo export --platform all --output-dir /tmp/iasi-export
```

Nu rula simultan două servere Next dev sau build/dev pe același `demo/.next`. Nu porni emulatoarele manual în paralel cu pornirea lor automată din Playwright; fie le lași testelor, fie aștepți ca `/v1/meta` să răspundă înainte de test.

## Starea publicării

Codul etapei 2 este local. API-ul, schedulerul, regulile actualizate și indexurile noi nu au fost publicate. Configurația locală rămâne pe emulatoare. Nu a fost activată facturarea, nu au fost create conturi staff reale și nu s-a publicat nimic pe Vercel/EAS.

Procesatorul și plata online, integrarea website-ului, recuperarea guest cu dovadă pe email, App Check/întărirea pentru lansare și validarea pe dispozitive native fizice rămân separate de această etapă. Un email/telefon declarat nu recuperează istoricul altui UID.

## Rezultatul validării locale

- **15 teste API/reguli trecute**: roluri și revocare (inclusiv inbox), separare între UID-uri cu aceleași contacte, versiuni/concurență, chei idempotente, încasare/puncte o singură dată, rezervarea concurentă a reducerii, sumă personalizată și protecția încasării, mementouri, filtre combinate/OR, cursor și export peste 500 rânduri.
- **6 scenarii browser trecute**, desktop și Pixel 5 emulat: setări → cerere → confirmare/încasare → puncte → cererea următoare cu reducere → client recurent/ajustare → notificări → CSV. Include răspuns pierdut după commit, reîncărcare și recuperarea aceleiași cereri fără duplicare; cache offline după reload; persistența sesiunii și revocarea personalului.
- **12 regresii demo trecute**, pentru păstrarea modului demonstrativ explicit.
- Build Next.js, typecheck Expo și export Android/iOS/web trecute. `git diff --check` curat în repository-ul Next.js.
- Screenshoturi de verificare locală: `/tmp/iasi-stage2-evidence/`. Validarea pe browser mobil nu echivalează cu test pe dispozitiv Android/iOS fizic.
