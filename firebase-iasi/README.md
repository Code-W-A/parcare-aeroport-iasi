# Firebase Iași — etapele 1 și 2

Proiect cloud: `parcare-aeroport-iasi` (575168679746), Firestore Standard în `europe-west1`.
Backend izolat de aplicația OTP și de `../functions`. Nu folosi configurația Firebase din rădăcina vechiului proiect pentru acest backend.

Etapa 2: vezi [modulele conectate, regulile comerciale și strategia de citire](ETAPA_2.md).

## Fundația implementată

- API Functions v2 TypeScript: `GET /v1/meta`, `POST /v1/guest/session`, `GET/PATCH /v1/me`, `GET /v1/staff/session`.
- Guest email + telefon, identitate Firebase anonimă transparentă, sesiune persistentă și cache de profil 60 s (date vechi disponibile până la 24 h la eroare de rețea).
- Un email introdus din nou nu acordă acces la istoricul altui profil. Recuperarea cu dovadă pe email rămâne pentru integrarea de lansare.
- Personal: email/parolă, custom claim `role`, document `staffAccess/{uid}` activ. Revocarea se verifică la fiecare comandă și la revenirea în fereastra web.
- Reguli implicite deny, scrieri client interzise pentru date comerciale, pagini limitate, indexuri inițiale. Modulele conectate și limitele lor sunt descrise în ETAPA_2.md.
- Fără rezervări demo sau creditări/plăți simulate în modul `firebase`. Demo-ul rămâne disponibil explicit prin `*_APP_MODE=demo`.

## Pornire locală

Necesită Node 22 și Java 21 sau mai nou pe `PATH`. Firebase CLI 15.36.0 este fixat în dependențele de dezvoltare ale proiectului; CLI 14 global nu este compatibil cu Firebase Functions 7. Scriptul folosește Node 22 prin npm exec și un cache local. La oprire închide și procesele copil, inclusiv Firestore Java.

Din `next-js`:

```sh
npm ci
npm --prefix firebase-iasi/functions ci
npm run foundation:emulators
```

Pe acest Mac, Java 21 există în Homebrew. Pentru o comandă locală fără schimbarea configurației globale: `PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH" npm run foundation:emulators`. Același `PATH` se aplică la `foundation:test` și la testele browser care pornesc emulatoarele.

În alt terminal, din același director:

```sh
npm run foundation:seed
npm run dev -- --port 3010
```

Din `expo-mobile-app`:

```sh
npm run web -- --port 8090
```

Servicii locale: Auth 9099, Firestore 8088, Functions 5001, UI emulator 4000. API: `http://127.0.0.1:5001/parcare-aeroport-iasi/europe-west1/api`.

Contul fictiv **numai din emulator** după seed: `operator@example.com`, parola `Local-Emulator-Only-123!`. Nu se creează sau trimite un cont real de personal prin seed. Aceste date nu sunt acceptate în proiectul cloud.

`.env` Expo și `demo/.env.local` Next sunt configurate cu înregistrările reale ale proiectului Iași, dar `*_FIREBASE_USE_EMULATORS=true`. Nu modifica doar unul dintre flag și URL: API-ul verifică același projectId și același mediu. Pentru telefon, setează hostul accesibil și rulează emulatoarele cu acces de rețea controlat sau folosește `adb reverse`; 127.0.0.1 de pe telefon nu este calculatorul. Nu expune emulatoarele public.

## Verificări

```sh
# Din next-js, oprește înainte emulatoarele interactive care ocupă aceleași porturi.
npm run foundation:test
npm run foundation:contracts
npm run build

# Din expo-mobile-app
npm run typecheck
PLAYWRIGHT_CHANNEL=chrome npm run test:foundation
```

Testele API/Rules folosesc `demo-parcare-iasi` și cer explicit Auth + Firestore emulat. Testele browser folosesc emulatoarele proiectului Iași; niciun cont sau document de test nu este creat în cloud.

Validare etapa 1: 5 teste API/Rules, 4 scenarii browser pe desktop/mobil și 12 regresii UI demo trecute; build Next.js, typecheck Expo și export Android/iOS/web trecute. Persistența pe dispozitive native fizice nu a fost încă verificată.

Contractele API sunt generate din `functions/src/contracts.ts` în cele două frontenduri; rulează `foundation:contracts` după schimbarea lor. Sursele generate sunt versionate, deci buildurile fiecărui checkout nu depind de importuri relative către celălalt checkout.

## Personal real și release

Bootstrap-ul este utilitarul `functions/scripts/staff.cjs`, cu ADC/identitate de serviciu limitată la proiectul Iași. Pentru cloud cere explicit `IASI_STAFF_BOOTSTRAP=true`; parola unui cont nou vine exclusiv din stdin protejat. Nu se transmite prin argumente, nu apare în log și nu se adaugă în Git. Parametri: email, admin/operator, enable/disable. La dezactivare se revocă refresh tokenurile.

Firebase Auth cloud este activat și verificat: autentificare anonimă și email/parolă. Regulile și indexurile sunt publicate în proiectul Iași. Nu este creat automat un cont live de personal. Nu este publicat API-ul Functions și nu este activat Blaze/facturarea în etapa 1.

Regulile și indexurile Iași se publică numai cu `--project parcare-aeroport-iasi` din acest director. Nu rula `firebase deploy` din vechea configurație a aplicației OTP. Înainte de lansare trebuie stabilite domeniile CORS reale, App Check, credențialele staff și URL-ul API publicat. Fișierele locale `.env` nu sunt o configurare a mediilor Vercel/EAS.
