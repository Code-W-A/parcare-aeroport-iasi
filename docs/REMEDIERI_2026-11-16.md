# Remedieri după audit — 16.11.2026

Acest document actualizează [auditul inițial](RAPORT_TESTARE_2026-11-16.md). Corecțiile sunt locale, fără deploy sau schimbări în datele cloud.

## Corecții funcționale

- **Rezervări:** „Viitoare” acceptă numai mișcări `waiting`/`parked`. O plecare anticipată rămâne în „Istoric”; anulările sunt și ele excluse din celelalte taburi. Nu sunt necesare citiri suplimentare sau filtrare după paginare. Generatorul include indexurile noi; acestea trebuie publicate împreună cu API-ul.
- **Paginare:** obiecte JSON nule, primitive, structuri greșite, ID-uri invalide, numere nefinite și timestampuri în afara intervalului Firestore răspund cu `400 VALIDATION_ERROR`, `retryable: false`. Se verifică și timestampurile secundare din cursor. Un `asOf` în afara intervalului Firestore este respins cu 400.
- **Pornire Expo:** conversia datelor a fost extrasă în `lib/dateConversion.ts`, eliminând ciclul `dateFormat → bookingPricing → dateFormat`, cu aceeași logică de calcul.
- **Emulatoare:** runnerul folosește CLI-ul fixat în proiect și închide grupul de procese, inclusiv Firestore Java. Se evită procesul orfan care păstra portul 8088 ocupat după teste.

Regresiile API pentru primele două corecții sunt în `firebase-iasi/functions/test/commerce.test.cjs`; auditul separat este `firebase-iasi/functions/audit/run.cjs`.

## Teste adaptate la aplicația Iași

Cele 23 de suite Jest care eșuau au fost adaptate la implementarea activă. `testMatch` nu a fost restrâns, nu au fost excluse fișiere și nu au fost adăugate teste ignorate.

- Fixture-uri comune pentru profil/draft/rezervări Iași și providerul corect pentru ecrane.
- Rezervare, validări după editare, taburi disjuncte, navigare, stare goală, sumar, retry și protecție la apăsări repetate.
- Testele OTP pentru NETOPIA, billing, blacklist și QR au fost înlocuite cu verificările funcțiilor Iași existente. Rutele înlocuite au teste de redirecționare. Acestea nu verifică integrări externe încă neimplementate.
- Au fost păstrate testele valide pentru componente, calcule și utilitare. O suită nouă testează providerul demo real: plată atomică, puncte acordate o singură dată, retry, beneficiu unic și păstrarea rezervării salvate.
- Browserul verifică separat fluxul Firebase real în emulator: setări → cerere → confirmare → încasare → fidelizare/notificări/raport, plus offline, sesiuni și revocare staff.

Numărul de teste Jest s-a schimbat deoarece așteptările pentru funcțiile OTP retrase au fost înlocuite; nu este aceeași suită veche de 222 de teste declarată brusc verde.

## Dependențe

- Next.js `15.2.6 → 15.5.29`; PostCSS `8.5.33`, cu override pentru copia adusă de Next.
- API: Express `4.22.3`, Zod `4.6.7`, Firebase Admin `14.5.1`, Firebase Functions `7.4.0`. CLI `15.36.0` este fixat în devDependencies; CLI global 14 folosea `functions.config()` eliminat în SDK 7 și nu putea încărca workerul.
- SDK 56 Expo aliniat la versiunile recomandate, inclusiv Expo `56.0.24`, Router `56.2.22`, Screens `4.26.0`. `expo install --check` trece.
- gRPC `1.14.7` prin override compatibil în același major, inclusiv pentru SDK-urile client folosite în teste.
- Dependențe legacy Next: Nodemailer `10.6.0`; SheetJS `0.20.3` din distribuția oficială, cu tipuri proprii. Stub-ul `@types/xlsx`, care instala versiunea veche vulnerabilă, a fost eliminat. `scripts/test-security-dependencies.cjs` verifică un XLSX în memorie și generează un email numai local prin `streamTransport`; nu livrează mesaje.

Auditul `npm audit --omit=dev` după actualizări:

| Proiect | Critice | Ridicate | Moderate | Scăzute |
| --- | ---: | ---: | ---: | ---: |
| Next.js | 0 | 0 | 0 | 0 |
| Functions Iași | 0 | 0 | 0 | 0 |
| Expo | 0 | 6 | 12 | 7 |

**Auditul Expo nu este încă curat.** Rămân lanțurile `expo-router → query-string → decode-uri-component`, `metro → image-size`, Zod din Expo CLI și avertizări moderate/scăzute din toolchain. Actualizarea compatibilă a acestor lanțuri rămâne deschisă. Propunerile automate includ salturi de SDK/major sau downgrade-uri nepotrivite; nu au fost aplicate. Prezența advisory-urilor nu demonstrează o exploatare, dar nici nu este declarată rezolvată prin faptul că buildul trece.

Auditul complet Next, incluzând noul CLI de dezvoltare, mai raportează 14 pachete moderate. Functions are zero și cu dependențele de dezvoltare incluse. Numerele sunt pachete semnalate în fiecare arbore, nu incidente și nu se adună între proiecte.

Surse pentru actualizări: [distribuția oficială SheetJS](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/), [Firebase Admin release notes](https://firebase.google.com/support/release-notes/admin/node), [migrarea Zod 4](https://zod.dev/v4/changelog). Lockfile-urile fixează pachetele și integritatea descărcărilor.

## Verificări după corecții

- Jest: **51 suite / 199 teste trecute**, zero eșuate sau ignorate.
- API și reguli: **17/17 trecute**.
- Audit extins: **10/10 trecute**, inclusiv 30 retry-uri concurente, 30 comenzi de încasare concurente și 10.000 de rezervări. Trei pagini admin au 150 de ID-uri distincte; paginile rămân limitate la 50/20. Mostrele locale nu reprezintă facturarea sau latența producției.
- Browser Firebase, cu SDK/CLI actualizate: **6/6 trecute** (desktop și Pixel 5 emulat).
- Browser demo: **12/12 trecute**.
- Build Next.js, TypeScript Expo, export Android/iOS/web, compatibilitate SDK 56 și `git diff --check`: **trecute**.
- Native iOS și Android: **trecute**. Testele folosesc Expo Go 56 în simulatoare, cu guest → contacte → închidere completă → restaurare sesiune → logout. Nu reprezintă validarea unor builduri proprii pe telefoane fizice.

Loguri: `/tmp/iasi-fix-{backend-final,jest,extended,flows-final,demo,build,types,export}.log`; native: `/tmp/iasi-fix-ios-final.log` și `/tmp/iasi-fix-android-pass.log`; audituri JSON în `/tmp/iasi-fix-{next,expo,functions}-deps.json`. Documentația de pornire, inclusiv Java 21 și CLI-ul local, este în `firebase-iasi/README.md`.

## Ce rămâne pentru lansare

Actualizările de toolchain descrise mai sus; procesatorul de plăți și integrarea website-ului; recuperare guest prin email; configurarea canalelor push/email; deploy API/scheduler/reguli/indexuri; medii, CORS, App Check, conturi staff și măsurători Firestore în staging; builduri proprii și teste pe telefoane fizice.

Nu au fost activate facturarea, plăți sau trimiteri reale de email. Nu s-a făcut deploy.
