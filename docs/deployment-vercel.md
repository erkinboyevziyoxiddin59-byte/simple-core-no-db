# Deploying Starjbot to Vercel (full SSR)

Target architecture: Telegram Mini App → Vercel SSR → TanStack server functions → Supabase.

## Build target

`vite.config.ts` pins the Nitro `vercel` preset, so `npm run build` emits `.vercel/output`
(Build Output API v3): a Node serverless function that serves SSR and all
`/_serverFn/*` RPC endpoints, plus static client assets on the CDN.

## Vercel project settings

| Setting | Value |
| --- | --- |
| Framework preset | Other (do **not** pick Vite — that builds a static SPA and drops SSR) |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | leave empty (`.vercel/output` is consumed automatically) |
| Node version | 20 or 22 |

## Environment variables

Set these in Vercel → Settings → Environment Variables. Names only below; never commit values.

Server-only (never `VITE_`-prefixed, never reaches the browser):

- `TELEGRAM_BOT_TOKEN`
- `SESSION_SECRET` — must stay stable across deployments; rotating it invalidates all sessions
- `ADMIN_TELEGRAM_IDS`
- `ALLOW_DEV_AUTH` = `false`
- `APP_ENV` = `production`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Client-side, embedded at build time (must exist when Vercel runs the build):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

`isProduction()` checks `APP_ENV` → `LOVABLE_ENV` → `NODE_ENV`, so setting `APP_ENV=production`
is what makes the dev-auth escape hatch fail closed.

## Telegram Mini App

Vercel serves every deployment over HTTPS, which the session cookie requires: it is
`httpOnly; Secure; SameSite=None` (`SameSite=None` is needed because the Mini App runs inside
Telegram's WebView). `initData` is verified server-side with an HMAC over the bot token; the
client's `initDataUnsafe` is never trusted.

After the first deploy, point the BotFather Mini App URL (Bot Settings → Menu Button, or
`/newapp`) at the Vercel domain.

## Supabase

Unchanged. Same project, schema, RLS and data; the serverless function reaches it over HTTPS
with the variables above. The service-role key is used only inside `*.server.ts` modules.

## Local production build

```sh
npm ci
npm run build
```
