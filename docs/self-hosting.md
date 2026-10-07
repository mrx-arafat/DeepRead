# Host DeepRead on your own server

This guide puts DeepRead on a Linux server at its own web address, such as `https://read.example.com`.
When it is done, the people you read with open that address in any browser, tap their profile, and type their code.
Nobody installs anything, and there is no key link to pass around.

It is written for a plain Linux server (a VPS or a computer at home) that you reach over SSH.
Any hosting panel that can run a Node.js app behind a reverse proxy works too: the settings and the pitfalls are the same.

If DeepRead only needs to reach your own phone now and then, you do not need a server: see [Read on your phone](../README.md#read-on-your-phone).

## Contents

1. [What you need](#what-you-need)
2. [How the pieces fit](#how-the-pieces-fit)
3. [Install Node.js and get DeepRead](#1-install-nodejs-and-get-deepread)
4. [Install and build](#2-install-and-build)
5. [Write the settings](#3-write-the-settings)
6. [Run it as a service](#4-run-it-as-a-service)
7. [Put it on the web with HTTPS](#5-put-it-on-the-web-with-https)
8. [Cloudflare in front (recommended)](#6-cloudflare-in-front-recommended)
9. [Sign in and invite people](#7-sign-in-and-invite-people)
10. [AI helpers on a server](#8-ai-helpers-on-a-server)
11. [Backups](#9-backups)
12. [Updating](#10-updating)
13. [Troubleshooting](#troubleshooting)
14. [What is public, and what is not](#what-is-public-and-what-is-not)

## What you need

| Thing | Why |
| --- | --- |
| A Linux server with SSH access and `sudo` | Ubuntu 22.04 or 24.04 and Debian 12 are what these steps use. Other distributions work with their own package commands. |
| 1 GB of memory or more, plus swap | DeepRead itself uses about 100 to 200 MB. Building it takes more for a minute; on 1 GB, add swap (see [Troubleshooting](#the-build-is-killed-or-runs-out-of-memory)). |
| Disk space for the books | Each book keeps its PDF, its text and its cover. Plan for about twice the size of the PDFs, or keep the books in [Cloudflare R2](../README.md#keep-your-books-in-cloudflare-r2) instead. |
| A domain name | A name such as `read.example.com`, with a DNS `A` record pointing to the server's IP address. HTTPS needs a name; a bare IP address will not do. |
| Node.js 24 or newer, and git | Node.js 24 is what DeepRead is built and tested on. 22.18 also starts; anything older fails at once. |
| Ports 80 and 443 open | For HTTPS. DeepRead's own port (8787) stays closed: it only listens on the server itself. |

## How the pieces fit

```text
Browser ──https──▶ (Cloudflare, optional) ──▶ Caddy or nginx on :443 ──http──▶ DeepRead on 127.0.0.1:8787
                                                                                 │
                                                                                 ├─ data/  (books, unless kept in R2)
                                                                                 └─ .env   (your settings)
```

DeepRead never faces the internet directly.
A reverse proxy (Caddy or nginx) takes the HTTPS connection and passes it on.
DeepRead checks that each request is for the address you configured and comes from its own pages, then asks for the profile's code.

## 1. Install Node.js and get DeepRead

Connect to the server over SSH, then install Node.js 24 and git.
On Ubuntu or Debian, the NodeSource packages are the simplest way:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v
```

`node -v` should print `v24` or newer.

Make a user of its own for DeepRead, so it cannot touch anything else on the server, and download DeepRead into its folder:

```bash
sudo useradd --system --create-home --home-dir /srv/deepread --shell /usr/sbin/nologin deepread
sudo -u deepread git clone https://github.com/mrx-arafat/DeepRead.git /srv/deepread/app
```

Every later command that touches DeepRead's files runs as that user, with `sudo -u deepread`.
If you run them as yourself or as root instead, the service cannot write its own files later.

## 2. Install and build

```bash
cd /srv/deepread/app
sudo -u deepread -H npx --yes pnpm@11 install --frozen-lockfile --prod
sudo -u deepread -H npx --yes pnpm@11 build
```

- `npx --yes pnpm@11` runs the package manager DeepRead uses without installing it for the whole server.
  If pnpm 11 is already installed, plain `pnpm` works the same.
- `--frozen-lockfile` installs exactly the versions DeepRead was tested with.
- `--prod` leaves out the tools only developers need, which saves several hundred megabytes.
- The build writes the web app into `dist/`.
  It ends with a line like `✓ built in 3.21s`.

## 3. Write the settings

DeepRead reads its settings from a file named `.env` in its folder.
Create it, readable only by the DeepRead user, because it holds your passkey and any API keys:

```bash
sudo -u deepread touch /srv/deepread/app/.env
sudo chmod 600 /srv/deepread/app/.env
sudo -u deepread nano /srv/deepread/app/.env
```

Start with this, putting your own values in place of the `<...>` parts:

```bash
NODE_ENV=production
DEEPREAD_PUBLIC_URL=https://read.example.com
DEEPREAD_API_PORT=8787

ADMIN_PASSKEY=<a long passphrase, 12 characters or more>
ADMIN_NAME=<your name>

DEEPREAD_STORAGE=local
DEEPREAD_STORAGE_LIMIT=8GB
```

| Setting | What it does |
| --- | --- |
| `NODE_ENV=production` | Serves the built web app from `dist/`. Without it, the server answers only `/api`, and the address shows `404 Not Found`. |
| `DEEPREAD_PUBLIC_URL` | The address people type, with `https://` and nothing after the name. DeepRead answers browsers only at this exact address. Change it if you move DeepRead to another name. |
| `DEEPREAD_API_PORT` | The port DeepRead listens on, on the server itself only. 8787 if not set. Your proxy must point to the same number. |
| `ADMIN_PASSKEY` | Turns profiles on, and is the admin's own code. It opens every profile, so with `DEEPREAD_PUBLIC_URL` set DeepRead refuses to start unless it is at least 12 characters long. Several unrelated words make a good one. Changing it later signs everyone out. |
| `ADMIN_NAME` | The admin profile's name the first time DeepRead starts. You can rename it later. |
| `DEEPREAD_STORAGE` | `local` keeps the books in `data/` next to DeepRead. `r2` keeps them in a Cloudflare R2 bucket; see [.env.example](../.env.example) for the R2 lines. |
| `DEEPREAD_STORAGE_LIMIT` | The most space all the books together may take. Uploads past it are refused. Leave it empty for no limit. |
| `DEEPREAD_DATA_DIR` | Optional. Where the `data` folder is. `./data` inside DeepRead's folder if not set. |
| `DEEPREAD_ENCRYPTION_KEY` | Optional. Encrypts the books and notes at rest. Read its warning in [.env.example](../.env.example) first: losing the key loses the books. |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_DAILY_LIMIT` | Optional. The AI helper for readers; see [AI helpers on a server](#8-ai-helpers-on-a-server). |

[.env.example](../.env.example) explains every setting in more detail.

## 4. Run it as a service

A service starts DeepRead when the server boots, and restarts it if it ever stops.
Create the file `/etc/systemd/system/deepread.service`:

```bash
sudo nano /etc/systemd/system/deepread.service
```

```ini
[Unit]
Description=DeepRead
After=network-online.target
Wants=network-online.target

[Service]
User=deepread
Group=deepread
WorkingDirectory=/srv/deepread/app
ExecStart=/usr/bin/node server/index.ts
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/usr/bin/node` is where the NodeSource package puts Node.js.
If you installed it another way, use what `command -v node` prints instead.

Start it, and make it start at every boot:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now deepread
sudo journalctl -u deepread -n 20 --no-pager
```

The log should end with lines like these:

```text
DeepRead API listening on http://127.0.0.1:8787 (data: /srv/deepread/app/data)
Settings from .env.
Published at https://read.example.com: anyone can open it there, and each profile's code guards its books.
Books are kept in the data folder, up to 8 GB.
Profiles are on: 1 profile.
```

If it says `DeepRead could not start.` instead, the rest of that line names the setting to fix.

Check that it answers on the server itself:

```bash
curl http://127.0.0.1:8787/api/health
```

It should print `{"ok":true}`.

<details>
<summary><b>Using PM2 instead of systemd</b></summary>

If your server already runs Node.js apps with PM2, run DeepRead the same way, as the `deepread` user:

```bash
cd /srv/deepread/app
sudo -u deepread -H pm2 start server/index.ts --name deepread --interpreter node
sudo -u deepread -H pm2 save
sudo env PATH=$PATH pm2 startup systemd -u deepread --hp /srv/deepread
```

DeepRead loads `.env` itself, so PM2 needs no extra settings.

</details>

## 5. Put it on the web with HTTPS

Pick one proxy.
Caddy is the shorter path because it gets and renews the HTTPS certificate on its own.
nginx is the usual choice when the server already runs it.

Both must do three things, or DeepRead misbehaves in ways that are hard to trace:

- **Keep the `Host` the browser sent.** DeepRead compares it with `DEEPREAD_PUBLIC_URL` and refuses any other.
- **Not hold back streamed answers.** Explanations arrive word by word; a proxy that buffers them shows nothing until the end, or cuts them off.
- **Accept large uploads.** A PDF may be up to 300 MB.

### Option A: Caddy

Install Caddy by following [its instructions for your system](https://caddyserver.com/docs/install), then replace `/etc/caddy/Caddyfile` with:

```caddyfile
read.example.com {
	request_body {
		max_size 310MB
	}
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
```

```bash
sudo systemctl reload caddy
```

Caddy keeps the `Host` by default, and gets a certificate the first time someone opens the address.

### Option B: nginx with Let's Encrypt

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/deepread
```

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name read.example.com;

    # A PDF may be up to 300 MB; nginx refuses anything over 1 MB unless told otherwise.
    client_max_body_size 310m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        # DeepRead checks this against DEEPREAD_PUBLIC_URL.
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # Explanations are streamed: pass every word on as it comes.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

Turn it on, then let certbot add HTTPS and the redirect from `http://`:

```bash
sudo ln -s /etc/nginx/sites-available/deepread /etc/nginx/sites-enabled/deepread
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d read.example.com --redirect
```

certbot renews the certificate on its own.

### Firewall

Open only SSH and the web ports.
Never open DeepRead's own port: it listens on the server only, and must stay behind the proxy.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Open `https://read.example.com`.
You should see **Who's reading?** with the admin's profile.

## 6. Cloudflare in front (recommended)

After 5 wrong codes in a row, DeepRead locks that profile for 5 minutes for that visitor, doubling with each further lock up to a day.
It tells visitors apart by the address Cloudflare reports for each of them.

- **With Cloudflare in front**, each visitor has their own count, so a stranger guessing codes locks out only themselves.
- **Without Cloudflare**, DeepRead cannot tell visitors apart, so all of them share one count per profile.
  A stranger typing wrong codes for your profile then locks you out too, for a while.
  They still get no more guesses than that, so the books stay safe; it is only an annoyance.

To put Cloudflare in front:

1. Add your domain to Cloudflare and point the name to the server's IP with the proxy on (the orange cloud).
2. In **SSL/TLS**, choose **Full (strict)**.
   The Let's Encrypt certificate from step 5 works for it, or use a Cloudflare origin certificate.
3. **Let only Cloudflare reach the server.**
   Otherwise someone can skip Cloudflare, connect to the server's IP directly, and pretend to be a new visitor with every guess.
   For nginx, write Cloudflare's address list into a file and include it in the `server` block that listens on 443:

   ```bash
   { for ip in $(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6); do echo "allow $ip;"; done; echo "deny all;"; } \
     | sudo tee /etc/nginx/snippets/cloudflare-only.conf
   ```

   ```nginx
   server {
       listen 443 ssl;
       server_name read.example.com;
       include snippets/cloudflare-only.conf;
       # ... the rest as before
   }
   ```

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

   Cloudflare's list changes rarely; run the first command again every few months.
   With Caddy, a firewall rule that accepts ports 80 and 443 only from those addresses does the same.
4. Cloudflare's free plan accepts uploads up to 100 MB each.
   A larger PDF fails with `413` before it reaches DeepRead; see [Troubleshooting](#uploads-fail-or-stop-at-a-certain-size).

## 7. Sign in and invite people

1. Open `https://read.example.com`, choose the admin's profile, and type your `ADMIN_PASSKEY`.
2. Open **Admin** from the profile menu (or go to `/admin`).
3. Add a profile for each person, with a name and a code of at least 6 characters.
   You can also choose which AI helper each of them may use.
4. Send each person two things: the address, and their own code.

They open the address, tap their profile, and type their code.
Their sign-in lasts 30 days on that device.
[Read together](../README.md#read-together-profiles-and-sharing) explains profiles and sharing books in full.

## 8. AI helpers on a server

DeepRead explains words and passages with an AI helper, and on a server one choice stands out.

- **An OpenRouter API key** (recommended on a server).
  Make a key at [openrouter.ai/keys](https://openrouter.ai/keys), pick a model, and set `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` in `.env`, or on the admin page.
  `OPENROUTER_DAILY_LIMIT` caps how many requests each reader may make in a day (100 if not set), so a shared server cannot run up your bill.
- **Claude Code or Codex.**
  These run on the server under the `deepread` user's own sign-in, and every reader you give them to uses that one account.
  Install one as that user and sign in once, for example `sudo -u deepread -H claude`, and check that the account's terms allow sharing it.

Reading, listening and notes work without any helper.

## 9. Backups

| What | Where | Why it matters |
| --- | --- | --- |
| `.env` | `/srv/deepread/app/.env` | Your passkey, keys and settings. If you set `DEEPREAD_ENCRYPTION_KEY`, the books cannot be opened without it. |
| `data/` | `/srv/deepread/app/data` | With `DEEPREAD_STORAGE=local`: every book, note and profile. With R2: only small things (the sign-in secret, wrong-code locks, the admin's OpenRouter settings, saved word translations). |
| Your R2 bucket | Cloudflare | With `DEEPREAD_STORAGE=r2`: the books, notes and profiles. |

A nightly copy of the folder is enough for most people:

```bash
sudo tar -czf /root/deepread-$(date +%F).tar.gz -C /srv/deepread/app .env data
```

Copy the file somewhere off the server.
To restore, stop DeepRead, unpack it into the same folder, give the files back to the `deepread` user (`sudo chown -R deepread:deepread /srv/deepread/app`), and start DeepRead again.

## 10. Updating

```bash
cd /srv/deepread/app
sudo -u deepread git pull --ff-only
sudo -u deepread -H npx --yes pnpm@11 install --frozen-lockfile --prod
sudo -u deepread -H npx --yes pnpm@11 build
sudo systemctl restart deepread
```

Your settings and books are not in Git, so updating never touches them.
If `git pull` refuses because of local changes, someone edited DeepRead's own files on the server: `sudo -u deepread git status` shows which.

## Troubleshooting

Start with the log, which almost always names the problem:

```bash
sudo journalctl -u deepread -n 50 --no-pager
```

<details>
<summary><b>The page opens, but everything says "DeepRead only answers requests from this computer."</b></summary>

DeepRead did not recognise the address the request was for.

- `DEEPREAD_PUBLIC_URL` is not set, or DeepRead was not restarted after you set it.
  The log must say `Published at https://...` when DeepRead starts.
- The address in the browser differs from `DEEPREAD_PUBLIC_URL`, for example `www.read.example.com` against `read.example.com`, or an extra port.
  Make the proxy redirect every other name to the one you set.
- The proxy replaces the `Host` header.
  nginx needs `proxy_set_header Host $host;` (step 5).
  Some panels and tunnels send `localhost` or the server's IP instead; set them to pass the original host.

</details>

<details>
<summary><b>Actions fail with "DeepRead only answers requests from its own pages."</b></summary>

The page was loaded from another address than the one in `DEEPREAD_PUBLIC_URL`, or another website tried to use DeepRead from your browser.
Open DeepRead at exactly the address in `DEEPREAD_PUBLIC_URL`.
If you changed the address, update the setting and restart.

</details>

<details>
<summary><b>DeepRead stops at once with "DeepRead could not start."</b></summary>

The rest of the line says why:

- `ADMIN_PASSKEY ... must be at least 12 characters long`: choose a longer passkey.
- `DEEPREAD_PUBLIC_URL lets anyone reach DeepRead, so it needs profiles`: set `ADMIN_PASSKEY`.
- `DEEPREAD_PUBLIC_URL must start with https://`: HTTPS is required, because the sign-in cookie only travels over it.
- `DEEPREAD_PUBLIC_URL must be the site's own address`: DeepRead cannot live in a folder such as `https://example.com/deepread`.
  Give it a name of its own, such as `read.example.com`.
- `could not open the place your books are kept`: the storage settings are wrong (often an R2 value still showing the example from `.env.example`), or the `data` folder belongs to another user.
  `sudo chown -R deepread:deepread /srv/deepread/app` fixes the second.

</details>

<details>
<summary><b>It fails with "Unknown file extension .ts" or a syntax error</b></summary>

Node.js is too old to run DeepRead's server code.
`node -v` must show 24 or newer (22.18 is the oldest that works).
If the service uses a different Node.js than your shell, check the path in `ExecStart`.

</details>

<details>
<summary><b>502 Bad Gateway</b></summary>

The proxy cannot reach DeepRead.
Either DeepRead is not running (`sudo systemctl status deepread`), or the port in the proxy differs from `DEEPREAD_API_PORT`.
`curl http://127.0.0.1:8787/api/health` on the server tells you which.

</details>

<details>
<summary><b>"address already in use" (EADDRINUSE)</b></summary>

Another program already uses port 8787.
Set `DEEPREAD_API_PORT` to a free port, use the same number in the proxy, and restart both.
`sudo ss -ltnp | grep 8787` shows what holds the port.

</details>

<details>
<summary><b>Uploads fail or stop at a certain size</b></summary>

Each layer has its own size limit, and the smallest one wins:

| Layer | Limit | Error you see |
| --- | --- | --- |
| nginx | 1 MB unless `client_max_body_size` is set | `413 Request Entity Too Large` |
| Caddy | none unless `request_body` sets one | |
| Cloudflare free plan | 100 MB per upload | `413` from Cloudflare |
| DeepRead | 300 MB per PDF | "This PDF is larger than 300 MB." |
| `DEEPREAD_STORAGE_LIMIT` | what you set | DeepRead says the library is full |

</details>

<details>
<summary><b>Explanations appear all at once at the end, or stop halfway</b></summary>

The proxy is holding the streamed answer back.
In nginx, `proxy_buffering off;` in the DeepRead `location` fixes it; with Caddy, `flush_interval -1`.
An answer that fails after a minute in which nothing arrived means `proxy_read_timeout` is too short (nginx's default is 60 seconds).

</details>

<details>
<summary><b>The build is killed or runs out of memory</b></summary>

On a server with 1 GB or less, the build can run out of memory and die with `Killed` or `JavaScript heap out of memory`.
Add 2 GB of swap once, then build again:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

</details>

<details>
<summary><b>pnpm fails during install</b></summary>

- `ERR_PNPM_OUTDATED_LOCKFILE` or `ERR_PNPM_FROZEN_LOCKFILE`: DeepRead's folder has local changes to `package.json`.
  `git status` shows them; `git checkout package.json pnpm-lock.yaml` puts them back.
- A message about workspace settings or `minimumReleaseAge`: an older pnpm is being used.
  Use `npx --yes pnpm@11` as written above.
- Network errors: the server cannot reach the npm registry.
  Try again, or check the server's DNS and outgoing firewall.

</details>

<details>
<summary><b>A profile is locked after wrong codes</b></summary>

After 5 wrong codes in a row DeepRead locks that profile for that visitor, for 5 minutes at first.
Wait, then type the right code.
If everyone is locked out at once, DeepRead cannot tell visitors apart: see [Cloudflare in front](#6-cloudflare-in-front-recommended).
The admin can give a profile a new code on the admin page.

</details>

<details>
<summary><b>Everyone was signed out</b></summary>

`ADMIN_PASSKEY` changed, or the `data` folder was lost (it holds the sign-in secret).
Everyone signs in again with their code; no books or notes are lost.

</details>

<details>
<summary><b>Running a second copy against the same R2 bucket</b></summary>

Do not run two DeepReads on one bucket and prefix at the same time, for example the server and your own computer.
Both keep the list of profiles in the bucket and write it back whole, so a change made on one can undo a change made on the other.
Give each copy its own `DEEPREAD_R2_PREFIX`, or stop one before starting the other.

</details>

## What is public, and what is not

Anyone who opens the address can see:

- the **Who's reading?** page, with each profile's name, picture and badge;
- the empty page shell of the app.

Everything else needs a profile's code: books, notes, reading places, AI answers and the admin page.
Codes are stored only as salted scrypt hashes, and wrong ones are locked out as described above.
The admin passkey opens every profile, which is why it must be long, and it lives only in `.env` on the server.
