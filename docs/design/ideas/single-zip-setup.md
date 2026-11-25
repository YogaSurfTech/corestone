# Idea: single-zip setup

Status: exploring · Started: 2026-11-25 · Owner: Thom

## The idea

Corestone ships as one zip with one executable. Running its setup once produces a working, secure
server: database, data repository, first administrator, HTTPS and the repository hooks. All data
lives in three places next to each other: the data repository, `accounts.json` and a properties
file with every startup parameter.

## What exists already

The server already creates the data repository when it is missing (`-repo`), creates its database
schema including the `ltree` extension (`projection.go`, `migrate`), and rebuilds the index from Git
whenever they disagree. An empty accounts file lets the first visitor create the administrator.

## Decisions

1. **One executable.** The web client and draw.io are compiled into it (Go `embed`).
2. **One properties file**, `corestone.properties` next to the executable: repository path, accounts
   file, database, listen address, server URL, HTTPS mode, auth mode. Command-line flags and
   environment variables still override it.
3. **`corestone setup`** asks the questions, writes the properties and sets everything up. It can be
   run again to repair or update an installation.
4. **HTTPS is built in.** Go serves HTTPS itself, with Let's Encrypt certificates (`autocert`) or
   certificate files; no reverse proxy is part of the setup.
5. **Plain HTTP only on purpose.** Disabling HTTPS needs a command-line switch and a confirmation
   at every start; a second switch skips the confirmation. Nobody ends up unencrypted by accident.
6. **The first administrator is created by setup**, not by the first visitor of the website.
7. **Every setting can be changed later**, nothing is fixed at install time: SSH on or off, HTTPS mode,
   listen address, server URL, database, auth mode, locations. Three ways, all writing the same
   properties file:
   - edit `corestone.properties` and restart;
   - `corestone config set ssh=on` (checks the value, then asks whether to restart now);
   - run `corestone setup` again, which shows the current answers as defaults.

   Changes that need more than a restart are done by the command itself: turning SSH on creates the
   server's host key and, in Docker, publishes the port; moving the database rebuilds the index there.

## Platforms

- **Linux:** all options (package manager, manual, Docker).
- **macOS:** Docker, or manual with the credentials of an existing PostgreSQL.
- **Windows:** Docker, or manual with the credentials of an existing PostgreSQL. Setup recommends
  running Corestone inside WSL instead, where the Linux options apply.

## Setup flow

1. **Check the system:** operating system, Docker, an existing PostgreSQL, the package manager.
2. **Database:**
   - **local, package manager:** `apt install postgresql` (Debian, Ubuntu) or
     `dnf install postgresql-server` and its initialisation (Fedora, RHEL); needs `sudo` once;
   - **local, manual:** connection details of an existing PostgreSQL;
   - **Docker:** everything in containers (below).

   For the local options, setup creates a `corestone` role and database owned by it. `ltree` is a trusted
   extension since PostgreSQL 13, so the owner can enable it. Locally, Corestone connects over the
   socket with peer authentication: no database password in the properties file. Setup refuses a
   PostgreSQL older than the version CI tests against, and never touches other databases on the server.
3. **Final questions:** server URL, HTTPS mode, administrator name, email and password, locations of
   repository and accounts file (defaults offered).
4. **Set up:** write the properties, create the data repository, the database and schema, the first
   administrator in `accounts.json`, the `pre-receive` and `reference-transaction` hooks, and a
   systemd service so Corestone starts after a reboot.

## Docker option

Everything runs in containers; setup writes a `docker-compose.yml` next to the executable and starts it.

- **Corestone** in its container, serving HTTPS itself on published ports 80 and 443 (same modes as below).
- **PostgreSQL** (`postgres:16`) in a second container, reachable only on the compose network, with a
  generated password kept in the properties file.
- **Data repository and `accounts.json`** in a named volume (`corestone-data`). The database has its
  own named volume, which never needs a backup: it is the index, rebuilt from Git.
- **The properties file** is mounted read-only from the host, so settings are edited without entering
  a container.
- **Optional SSH for Git**, off by default, because standard work happens in the client and Git access
  is for administrators and special cases: an SSH server for pushes and clones on its own published
  port (e.g. 2222), only for Git (`corestone git-shell` as the forced command, as in `push-hook.md`), with
  keys managed by Corestone, keys only, no passwords. **Corestone serves SSH itself** (Go's
  `golang.org/x/crypto/ssh`, as Gitea does): no second process, no system accounts, the same on local
  installs. Security fixes reach users only through Corestone releases, so CI runs `govulncheck`,
  dependency updates are automated, and a security fix is released within days.
- Restart policies replace the systemd service.
- Backup is a copy of the named volume, e.g.
  `docker run --rm -v corestone-data:/data -v "$PWD":/backup debian tar czf /backup/corestone-data.tgz /data`.

## HTTPS

| Situation | Mode | Result |
| --- | --- | --- |
| Public domain pointing to the server, ports 80 and 443 reachable | `https=letsencrypt` (default when a domain is given) | trusted certificate, renewed automatically |
| Own certificate (company CA) | `https=files`, `cert=…`, `key=…` | trusted within the company |
| LAN without a domain | `https=self-signed` | encrypted; browsers warn; no help with trusting the certificate is offered |
| Anything else (own proxy, testing) | `-insecure-http` | plain HTTP after a typed confirmation at start |

- `-insecure-http` alone: at every start Corestone prints that sign-in passwords and session cookies
  travel unencrypted and waits for a typed `yes`. Without a terminal it refuses to start.
- `-insecure-http -insecure-http-confirmed`: starts without asking, for setups that run their own
  TLS proxy in front. The warning still goes to the log.
- Plain HTTP listens on `127.0.0.1` unless an address is given explicitly.
- Behind an own proxy, a `-trusted-proxy <address>` setting lets Corestone take HTTPS from the proxy's
  forwarded headers, so the session cookie is still marked `Secure` (today it is marked only when
  Corestone itself sees TLS, `internal/httpapi/auth.go`).

## Updates

- Replace the executable and run `corestone setup` again, or just restart.
- **The database needs no migrations:** it is only the index. When the schema changes, Corestone drops
  the index and rebuilds it from Git.
- **The data repository's format** is versioned (`.corestone/format.json`); a format change is a
  migration commit made by the new version, checked by the hooks like any other commit.
- Hooks and the systemd unit are rewritten by setup to match the new version.

## Unattended setup

`corestone setup --unattended` takes every answer from the properties file and asks nothing. If no
administrator password is given, it generates one and prints it once; it is never stored in plain text.

## Uninstall

`corestone uninstall` removes the service (or the containers), the database and its role, and the
database volume. It keeps the data repository, `accounts.json` and the properties file, and prints
where they are:

```
Corestone removed. Kept:
  repository   /srv/corestone/data/corestone.git      (Docker: volume corestone-data)
  accounts     /srv/corestone/data/accounts.json
  properties   /srv/corestone/corestone.properties
Delete them yourself if you no longer need them.
```

## Backups

The data repository and `accounts.json` are all there is to back up; the properties file is
convenient to keep. The database never needs a backup: it is rebuilt from Git.

## Open questions

None at the moment.
