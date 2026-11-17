# Raport de testare — Parcare Aeroport Iași

> Actualizat ulterior: bugurile confirmate au fost corectate și suita Jest a fost adaptată. Vezi [remedierile și verificările ulterioare](REMEDIERI_2026-11-16.md). Rezultatele de mai jos păstrează auditul inițial.

Data: 16.11.2026. Sunt verificate frontendul activ `next-js/demo`, aplicația Expo SDK 56 și backendul izolat `firebase-iasi`. Testele cu date folosesc exclusiv emulatoarele Firebase locale, cu contacte fictive. Starea generală: fluxurile principale trec; auditul extins confirmă două probleme funcționale și datorii de testare/securitate înainte de lansare.

## Rezultate executate acum

| Verificare | Rezultat | Observații |
| --- | --- | --- |
| API și reguli Firestore | **15/15 trecute** | Autorizare, UID, roluri/revocare, plăți la locație, fidelizare, audit, mementouri, filtre și CSV |
| Browser, integrare Firebase | **6/6 trecute** | Desktop și Pixel 5 emulat: setări, cereri, confirmare, încasare, reducere, puncte, notificări, CSV, răspuns pierdut după commit, reload și cache offline |
| Browser, modul demo | **12/12 trecute** | Rezervare/plată simulată, retry/anulare, reducere unică, istoric, notificări și administrare demo |
| Audit suplimentar API și volum | **7 trecute / 3 eșuate** | Cele trei eșecuri reprezintă cele două probleme descrise mai jos |
| Jest complet | **135 trecute / 86 eșuate / 1 ignorat** | 27 suite trecute și 23 eșuate; 50 suite, 222 teste în total |
| Build Next.js | **Trecut** | `next build demo` |
| TypeScript Expo | **Trecut** | `tsc --noEmit` |
| Export Expo Android/iOS/web | **Trecut** | `/tmp/iasi-audit-export` |
| Native iOS în Expo Go SDK 56 | **Trecut** | iPhone 17 Pro, simulator iOS 26.5: guest, contacte, închidere completă, restaurare sesiune și logout |
| Native Android în Expo Go SDK 56 | **Trecut** | Small Phone, emulator Android 17/API 37: guest, contacte, închidere completă, restaurare sesiune și logout |
| Compatibilitate dependențe Expo | **Necesită actualizare** | `expo install --check` raportează 12 pachete în afara versiunilor recomandate |
| Audit dependențe de producție | **Necesită triere și actualizare** | Detaliat mai jos; nu este dovada exploatării unei vulnerabilități în aplicație |
| Verificare whitespace Next.js | **Trecut** | `git diff --check` |

Testele native sunt automate prin Maestro 2.12.1, folosind aplicația nativă Expo Go 56. Nu sunt teste pe telefoane fizice și nici validarea unui build propriu de distribuție. Android a fost pornit cu `-read-only`, astfel încât schimbările făcute în sesiunea de test nu sunt salvate în AVD-ul original. Pentru accesul emulatoarelor Firebase s-au folosit porturi locale și `adb reverse`.

## Probleme funcționale confirmate, încă necorectate

### 1. Aceeași rezervare poate fi în „Viitoare” și „Istoric”

Reproducere: creează o rezervare cu sosire programată în viitor, confirmă cererea, apoi înregistrează sosirea și plecarea anticipată. Adminul permite aceste tranziții. API-ul o întoarce atât în `GET /v1/bookings?tab=upcoming`, cât și în `?tab=history`.

Cauză: filtrul `upcoming` verifică starea rezervării și `arrivalAt > now`, fără să excludă `movementStatus == departed`. Istoricul include explicit `departed`. Loc: `firebase-iasi/functions/src/commerce/queries.ts`, în `ownBookings()`.

Corecție necesară: clasificare cu precedență clară pentru încheiat/anulat, filtre/indexuri corespunzătoare și test de regresie pentru apartenența la un singur tab. Nu s-a observat o dublare a documentului sau a încasării; problema este clasificarea/listarea.

### 2. Anumite cursoare invalide răspund cu HTTP 503 în loc de 400

Două reproduceri:

- `cursor` conține JSON `null`, codificat base64url: accesul la `cursor.q` produce TypeError.
- Un cursor valid este modificat cu `value = 1e100`: trece de `Number.isFinite`, dar depășește limitele unui Timestamp Firestore.

Ambele ajung la eroarea generică `UNAVAILABLE`, HTTP 503 și `retryable: true`. Loc: `firebase-iasi/functions/src/commerce/queries.ts`, în `page()`.

Corecție necesară: validare obiect nenul și a structurii cursorului, verificarea intervalului timestampului și răspuns `VALIDATION_ERROR`, HTTP 400. Nu s-a observat acces la datele altui utilizator prin aceste cereri.

## Concurență, volum și robustețe

Auditul reproductibil este `firebase-iasi/functions/audit/run.cjs`; refuză pornirea fără **ambele** hosturi de emulator localhost exacte. Creează numai date sintetice, nu șterge colecții și nu folosește cloudul.

- **30 retry-uri simultane**, aceeași cheie: o singură cerere creată, același ID în toate răspunsurile.
- **30 încasări concurente**, chei diferite și aceeași revision: un singur succes, 29 conflicte; puncte și intrare în ledger o singură dată.
- Accesul din alt UID și încercările clientului de a modifica puncte sau încasări sunt respinse.
- JSON de 128 KB și echivalentul comprimat gzip sunt respinse; limita este aplicată și după decomprimare.
- Editarea doar a contactelor păstrează totalul manual neachitat.
- „Citit toate” urmat de o notificare nouă și citirea uneia vechi păstrează corect contorul nou.
- **10.000 de rezervări**: pagini admin de 50 și pagini proprii de 20, cu cursor. Trei pagini admin consecutive au 150 ID-uri distincte. Răspunsul unei pagini rămâne sub 100 KB.
- Timpi locali pentru cele trei pagini: **96 / 82 / 66 ms**, pe emulatoare. Aceste trei mostre nu sunt p95, măsurare de producție sau dovadă a facturii Firestore. Costul intrărilor de index și Query Explain trebuie verificate în staging.

Rulare, după pornirea emulatoarelor din `next-js`:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8088 \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
node firebase-iasi/functions/audit/run.cjs
```

Raportul JSON este `/tmp/iasi-audit-extended.json`. Comanda iese cu cod 1 cât timp cele trei verificări de mai sus eșuează; nu este inclusă în cele 15 teste de bază și nu ascunde rezultatele negative.

## Suita Jest veche

Cele 86 de teste eșuate nu înseamnă 86 de defecte confirmate în produs. Exemple verificate:

- Multe ecrane sunt randate prin utilitare vechi, fără `DemoProvider`, și se opresc la „DemoProvider lipsește”.
- Există așteptări pentru NETOPIA, diferențe de plată, billing, recuperare după email și ecrane login/register înlocuite sau neactive în produsul Iași.
- Unele teste cer vechile culori OTP, video/camere sau componente eliminate deliberat.

Este necesară adaptarea suitei și a fixture-urilor la contractul Iași și la providerii reali. Nu trebuie reintroduse funcții OTP pentru a satisface teste depășite și nici eliminate arbitrar aserțiile. Pentru modulele noi există integrarea API/browser verificată, dar suită Jest complet verde nu există încă.

## Dependențe și compatibilitate

Rezultatul `npm audit --omit=dev --json` din această sesiune:

| Pachet/proiect | Critice | Ridicate | Moderate | Scăzute |
| --- | ---: | ---: | ---: | ---: |
| Next.js, inclusiv dependențele legacy din manifest | 4 | 12 | 20 | 0 |
| Expo, inclusiv instrumente aduse tranzitiv de dependențe | 1 | 19 | 16 | 7 |
| Functions Iași | 0 | 4 | 10 | 0 |

Acestea sunt numere de pachete semnalate automat în fiecare arbore, nu vulnerabilități unice demonstrate și nu se adună între proiecte. Aplicabilitatea depinde de componentele și configurațiile folosite. Root-ul Next conține și cod/dependențe OTP inactive. Frameworkul Next este însă folosit de aplicația activă, iar Express/Zod sunt folosite în API-ul nou.

Exemplu primar verificat: Next.js 15.2.6 se află în intervalele afectate de advisory-ul oficial [DoS cu Server Components](https://github.com/vercel/next.js/security/advisories/GHSA-h25m-26qc-wcjf). Auditul raportează și alte advisories, inclusiv condiționate de Windows sau Image Optimization; raportul nu pretinde că acestea au fost exploatate în aplicația actuală.

`expo install --check` cere alinierea a 12 pachete, inclusiv Expo 56.0.12 → ~56.0.24, expo-router ~56.2.22, expo-constants ~56.0.27 și react-native-screens ~4.26.0. Sunt necesare actualizări compatibile, cu regresii. Un `npm audit fix --force` nu este o soluție verificată: unele propuneri sar la alt SDK/alt major.

Fișierele de audit complet sunt în `/tmp/iasi-audit-{next,expo,functions}-deps.json`, iar verificarea Expo în `/tmp/iasi-audit-expo-compat.log`.

## Ce a rămas

1. **Corecții și stabilizare:** cele două probleme funcționale de mai sus; adaptarea testelor vechi; actualizări de securitate și alinierea SDK 56, urmate de regresii. Există și warning-ul circular `dateFormat → bookingPricing → dateFormat`, fără crash în verificările executate.
2. **Integrări externe:** procesatorul de plăți încă neales, plata online/webhook/reconciliere și verificări sandbox; integrarea website-ului după obținerea accesului; recuperarea guest pe alt dispozitiv cu dovadă pe email. Push/email suplimentare cer stabilirea canalelor și configurarea lor.
3. **Validare și lansare:** publicarea backendului/schedulerului/regulilor/indexurilor, medii reale și CORS, conturi staff reale, App Check și protecții de lansare; Query Explain/costuri și monitorizare în staging; builduri proprii și teste pe telefoane Android/iOS fizice; apoi publicare Vercel/EAS/store conform etapei de release.

Nu s-au executat plăți reale, trimiteri reale de email, comenzi către bariere/LPR/POS sau teste de integrare cu website-ul. Nu s-a făcut deploy și nu a fost activată facturarea.

## Dovezi și reproducere

- Loguri: `/tmp/iasi-audit-backend.log`, `-flows.log`, `-demo.log`, `-jest.log`, `-build.log`, `-types.log`, `-export.log`, `-extended.log`.
- Browser: `/tmp/iasi-audit-evidence/`.
- Native: `expo-mobile-app/e2e/native/ios-firebase.yaml`, `android-firebase.yaml`; rezultate Maestro în `/tmp/iasi-audit-ios-persistence/` și `/tmp/iasi-audit-android-final/`.
- Testele native folosesc Expo Go, Metro local pe 8092/8093 și Firebase local pe 5001/8088/9099. Meniul și warning-urile Expo Go se închid în test; nu sunt elemente ale buildului publicat.
