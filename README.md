# Cloud Sync

Synchronisiert Kalender, Kontakte und E-Mail zwischen Apple iCloud und Google für ein oder mehrere unabhängige Konto-Paare (Profile). Läuft als einzelner Docker-Container.

## Schnellstart

```bash
git clone <repo-url> cloud-sync && cd cloud-sync
npm install                       # einmalig, nur für die CLI-Helfer
cp .env.example .env

npm run auth:hash-password        # -> USER_PASSWORD_HASH
npm run auth:totp-generate        # -> TOTP_SECRET + QR-Code für die Authenticator-App (optional)
npm run auth:generate-secrets     # -> SESSION_SECRET und ENCRYPTION_KEY
```

Die ausgegebenen Zeilen kommen in die `.env`. `TOTP_SECRET` ist optional: Bleibt es leer, fragt der Login nur Benutzername und Passwort ab und zeigt kein Feld für den Authenticator-Code. Lass es nur leer, wenn die App nicht öffentlich erreichbar ist oder ein anderer Schutz davorsitzt (z. B. VPN oder Reverse-Proxy-Auth). Den bcrypt-Hash dabei in einfachen Anführungszeichen lassen (`USER_PASSWORD_HASH='$2b$...'`), sonst expandiert Docker Compose das `$`.
`GOOGLE_CLIENT_ID` und `GOOGLE_CLIENT_SECRET` besorgst du wie unten beschrieben. Danach:

```bash
docker compose up -d --build
```

Die Oberfläche läuft auf `http://localhost:3000` (anderer Host-Port über `HOST_PORT` in der `.env`). Die Daten liegen im Volume `cloud-sync-data` (`/app/data`).

> **`ENCRYPTION_KEY` sichern.** Damit werden die gespeicherten Apple- und Google-Zugangsdaten verschlüsselt. Geht er verloren oder ändert er sich, müssen alle Profile neu verbunden werden.

## Lokal starten (ohne Docker)

Voraussetzungen: Node.js 22 oder neuer, `npm install` und eine ausgefüllte `.env` (siehe Schnellstart).

**Entwicklung mit Hot Reload**

```bash
npm run dev
```

Startet das Backend (Port 3000) und das Vite-Frontend zusammen. Die UI öffnest du unter <http://localhost:5173>. Vite leitet `/api` und `/webhooks` ans Backend weiter. Mit `Ctrl+C` beendest du beide Prozesse.

**Wie in Produktion (ein Prozess)**

```bash
npm run build
npm start
```

Der Server liefert UI und API auf <http://localhost:3000> aus. Nach Frontend-Änderungen `npm run build` wiederholen und neu starten.

Beide Varianten lesen die `.env` im Projektordner automatisch. Fehlt sie, gelten die Umgebungsvariablen der Shell.

> **Google-Login lokal:** Die Weiterleitungs-URI muss zur Adresse passen, unter der du die UI öffnest, also `http://localhost:5173/api/auth/google/callback` bei `npm run dev` und `http://localhost:3000/api/auth/google/callback` bei `npm start`. Setze in der `.env` am besten `PUBLIC_BASE_URL` auf die jeweilige Adresse, damit sie fest ist.

## Google-Zugangsdaten besorgen

Cloud Sync meldet sich per OAuth 2.0 bei deinem Google-Konto an. Dafür brauchst du einen eigenen **OAuth-Client** in der Google Cloud Console. Das ist kostenlos und dauert etwa 10 Minuten. Du erhältst dabei `GOOGLE_CLIENT_ID` und `GOOGLE_CLIENT_SECRET`.

Die Menünamen in der Cloud Console ändern sich gelegentlich. Die Schritte unten beziehen sich auf die aktuelle Oberfläche („Google Auth Platform“).

### 1. Projekt anlegen

1. Öffne <https://console.cloud.google.com/> und melde dich mit dem Google-Konto an, das du synchronisieren willst (oder einem beliebigen anderen, der Client gehört nur zum Projekt).
2. Oben im Projektwähler **Neues Projekt** wählen, z. B. Name `cloud-sync`, und erstellen.
3. Das neue Projekt als aktives Projekt auswählen.

### 2. APIs aktivieren

Unter **APIs & Dienste → Bibliothek** diese drei APIs suchen und jeweils **Aktivieren** klicken:

| API | Wofür |
| --- | --- |
| **Google Calendar API** | Kalender-Sync und Webhooks |
| **People API** | Kontakte-Sync |
| **Gmail API** | Mail-Sync (iCloud → Gmail) |

### 3. OAuth-Zustimmungsbildschirm einrichten

1. **APIs & Dienste → OAuth-Zustimmungsbildschirm** öffnen (bzw. **Google Auth Platform**) und **Jetzt starten** wählen.
2. **App-Informationen:** App-Name (z. B. `Cloud Sync`) und deine E-Mail-Adresse als Support-E-Mail.
3. **Zielgruppe:** **Extern** wählen. (**Intern** gibt es nur bei Google-Workspace-Organisationen.)
4. **Kontaktinformationen:** deine E-Mail-Adresse.
5. Nutzungsbedingungen akzeptieren und **Erstellen**.

### 4. Scopes hinterlegen

Unter **Datenzugriff** (bzw. „Bereiche“) **Bereiche hinzufügen oder entfernen** und diese drei Scopes eintragen. Wenn sie nicht in der Liste auftauchen, im Feld „Bereiche manuell hinzufügen“ einfügen:

```
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/contacts
https://www.googleapis.com/auth/gmail.modify
```

Speichern. Ohne diese Scopes kann Cloud Sync Kalender, Kontakte und Gmail-Labels nicht lesen und schreiben.

### 5. App auf „In Produktion“ stellen (wichtig)

Unter **Zielgruppe** steht der Veröffentlichungsstatus zunächst auf **Testing**. Google lässt die Umstellung erst zu, wenn das **Branding** ausgefüllt ist. Stelle den Status so um:

1. **Branding** öffnen und die Pflichtangaben ausfüllen: App-Name, Support-E-Mail und Entwicklerkontakt (E-Mail-Adresse). Speichern.
2. **Zielgruppe → App veröffentlichen** (Publish app) → bestätigen. Der Status lautet danach **In production**.

**Warum?** Im Status *Testing* lässt Google Refresh-Tokens nach **7 Tagen** ablaufen. Die Google-Verbindung bricht dann jede Woche und du musst jedes Profil neu verbinden. Im Status *In production* laufen die Tokens nicht ab.

Eine Google-Verifizierung der App ist für den privaten Gebrauch **nicht** nötig. Beim ersten Verbinden zeigt Google dann die Warnung „Google hat diese App nicht überprüft“. Klicke dort auf **Erweitert → Weiter zu Cloud Sync (unsicher)**. Die Grenze liegt bei 100 Nutzern, was für ein privates Setup reicht.

### 6. OAuth-Client erstellen

1. **Clients** (bzw. **APIs & Dienste → Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID**) öffnen.
2. **Anwendungstyp: Webanwendung**, Name z. B. `Cloud Sync`.
3. Unter **Autorisierte Weiterleitungs-URIs** die Callback-URL deiner Installation eintragen:

   | Betrieb | Weiterleitungs-URI |
   | --- | --- |
   | Lokal (Standardport) | `http://localhost:3000/api/auth/google/callback` |
   | Lokal mit `HOST_PORT=8080` | `http://localhost:8080/api/auth/google/callback` |
   | Hinter Reverse Proxy | `https://sync.example.com/api/auth/google/callback` |

   Die URI muss **zeichengenau** zu der Adresse passen, unter der du die Oberfläche öffnest. Ist `PUBLIC_BASE_URL` gesetzt, wird genau diese Adresse verwendet. Sonst gilt die Adresse, mit der du die Seite aufrufst. Google erlaubt `http://` nur für `localhost`, alles andere braucht `https://`.
4. **Erstellen**. Es erscheinen **Client-ID** und **Clientschlüssel** (Client Secret). Kopiere beide sofort. Das Secret wird später nur noch teilweise angezeigt. Notfalls kannst du in den Client-Einstellungen ein neues erzeugen.

### 7. In die `.env` eintragen

```dotenv
GOOGLE_CLIENT_ID=123456789012-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
# Nur bei Betrieb hinter einer öffentlichen https-Adresse:
PUBLIC_BASE_URL=https://sync.example.com
```

Container neu starten (`docker compose up -d`) und in der Oberfläche beim Profil **Google verbinden** wählen.

### Vor dem Kontakte-Sync: Google-Label anlegen

Kontakte werden gruppenweise synchronisiert: eine Apple-Gruppe (oder „All Contacts“) wird einem **Google-Label** zugeordnet. Cloud Sync zeigt nur Labels, die du selbst angelegt hast. Hat dein Google-Konto noch keines, steht im Kontakte-Sync „No Google labels found“. Lege dann unter <https://contacts.google.com> über **Label erstellen** ein Label an (z. B. `iCloud`) und lade die Oberfläche neu.

### Fehlersuche

| Meldung / Symptom | Ursache und Lösung |
| --- | --- |
| `redirect_uri_mismatch` | Die eingetragene Weiterleitungs-URI weicht von der tatsächlichen ab (Schema, Host, Port, abschließender Slash). Gib in Schritt 6 genau `<Adresse>/api/auth/google/callback` ein und achte darauf, ob `PUBLIC_BASE_URL` gesetzt ist. |
| `access_denied` / „App nicht verifiziert“ | Bei Warnung: **Erweitert → Weiter**. Bei `access_denied` im Status *Testing* dein Konto unter **Zielgruppe → Testnutzer** eintragen oder, besser, die App auf *In production* stellen. |
| Google-Verbindung bricht nach ca. 7 Tagen ab (`invalid_grant`) | Die App steht noch auf *Testing*. Auf *In production* stellen (Schritt 5, dafür zuerst das Branding ausfüllen) und das Profil neu verbinden. |
| `Access Not Configured` / `API has not been used in project` | Eine der drei APIs aus Schritt 2 ist nicht aktiviert. |
| Webhooks funktionieren nicht | Sie brauchen eine öffentlich erreichbare `https`-Adresse in `PUBLIC_BASE_URL`. Ohne sie, oder wenn Google sie ablehnt, läuft Cloud Sync automatisch im Polling-Modus. |
