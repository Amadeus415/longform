# Deploying Longform Anywhere (Web + Native Mobile App)

Longform runs as a single always-on container (Node 24 + Hono + `yt-dlp` + SQLite) serving **both** the web app/PWA and the native Capacitor iOS & Android apps from the same foundation.

Your laptop can be completely off — you open Longform on your phone (browser, PWA, or native iOS/Android app), sign in with Google, listen to videos with your screen locked, and read your daily news brief. All channels, news sources, algorithm rules, and listening progress sync automatically per account.

---

## 1. Create Google OAuth Credentials (2 minutes)

1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Click **Create Credentials → OAuth client ID → Web application**.
3. Under **Authorized redirect URIs**, add your deployed callback URL:
   - Fly.io example: `https://longform-app.fly.dev/api/auth/google/callback`
   - Railway example: `https://longform-production.up.railway.app/api/auth/google/callback`
4. Copy the **Client ID** and **Client Secret**.

> **Opening Longform to other people later:** Start with `ALLOWED_EMAILS=you@gmail.com` and `ALLOW_PUBLIC_SIGNUP=false`. Whenever you want anyone to be able to sign in and connect their own channels & news sources, flip one env var: `ALLOW_PUBLIC_SIGNUP=true`. Every Google account automatically gets its own isolated profile and synced state.

---

## 2. Deploy the Always-On Backend

Pick either **Fly.io** (great CLI, ~$0–3/mo) or **Railway** (zero-CLI GitHub deploy):

### Option A: Fly.io (`fly.toml` included)

```sh
brew install flyctl
fly auth login

# Edit app = "longform-app" in fly.toml to a unique name first, then:
fly apps create <your-app-name>
fly volumes create longform_data --region sjc --size 1

# Set secrets (generate SESSION_SECRET with: openssl rand -hex 32)
fly secrets set \
  PUBLIC_URL="https://<your-app-name>.fly.dev" \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  GOOGLE_CLIENT_ID="<your-client-id>" \
  GOOGLE_CLIENT_SECRET="<your-client-secret>" \
  ALLOWED_EMAILS="you@gmail.com" \
  ALLOW_PUBLIC_SIGNUP="false"

fly deploy
```

### Option B: Railway (`railway.toml` included)

1. Push this repo to GitHub and create a **New Project → Deploy from GitHub Repo** in [Railway](https://railway.app).
2. Railway automatically detects `railway.toml` and builds the `Dockerfile` (with Node 24, SQLite, and `yt-dlp`).
3. In **Settings → Networking**, generate a public domain (e.g. `https://longform.up.railway.app`).
4. In **Volumes**, add a persistent volume mounted at `/data`.
5. In **Variables**, add:
   - `PUBLIC_URL` = `https://<your-railway-domain>`
   - `SESSION_SECRET` = random 64-char hex string (`openssl rand -hex 32`)
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   - `ALLOWED_EMAILS` = `you@gmail.com`
   - `ALLOW_PUBLIC_SIGNUP` = `false` (set to `true` when ready for public accounts)
   - `DATABASE_PATH` = `/data/longform.db`

### Optional: If YouTube challenges cloud IPs in Listen mode

YouTube occasionally rate-limits datacenter IPs for audio extraction. If Listen mode ever shows *"Audio unavailable"* on your cloud host:

1. Export a YouTube `cookies.txt` file (Netscape format).
2. Base64-encode it: `base64 -i cookies.txt | tr -d '\n'`
3. Set `YTDLP_COOKIES_B64` in Fly.io secrets or Railway variables. Longform writes it securely to `/tmp` on boot and passes it to `yt-dlp`.

---

## 3. Access on Your Phone Right Away (Web / PWA)

Open `https://<your-server-url>` on your phone in Safari (iOS) or Chrome (Android):
- Sign in with Google.
- Tap **Share → Add to Home Screen** (iOS) or **Install App** (Android).

---

## 4. Build & Install the Native Mobile App (iOS & Android)

The native app wraps the exact same React + Vite foundation via **Capacitor**, adding:
- True iOS `AVAudioSession` background audio (`UIBackgroundModes: audio`) so Listen mode keeps playing when locked and ignores the mute switch.
- Native Sign in with Google via in-app Safari View Controller / Chrome Custom Tabs (`longform://auth/callback` deep link).
- Native haptics, status bar theming, and in-app article browser.

### Build with your live server pre-configured

```sh
VITE_API_URL="https://<your-server-url>" npm run build:mobile
```

*(You can also leave `VITE_API_URL` unset — the app will prompt you for your server URL on first launch, and you can switch servers anytime in **Library → Account & Sync → Server**.)*

### Run on your iPhone (Xcode)

```sh
npm run cap:ios
```

1. In Xcode, select the **App** target → **Signing & Capabilities** → choose your Apple ID team.
2. Plug in your iPhone (or choose an iOS Simulator) and press **Run (⌘R)**.
3. For TestFlight / App Store distribution, choose **Product → Archive**.

### Run on Android (Android Studio)

```sh
npm run cap:android
```

Open in Android Studio, select your phone or emulator, and press **Run**.
