# frigate-ext: a shared injection protocol for Frigate companion extensions

Frigate has no frontend plugin API, so a companion that wants to add UI must make
Frigate's own nginx (a) inject a `<script>` into the dashboard HTML and (b) route a
private path prefix to the companion. There is exactly **one** `nginx.conf` in the
Frigate container, so two independent extensions can race and clobber each other.

This document defines **`frigate-ext`**, a small convention that lets any number of
extensions inject safely and concurrently. `frigate-layout-sync` implements it in
[`src/nginx.js`](src/nginx.js) — that file is the reference implementation; this doc
is the language-agnostic spec so another extension (in any language) can interoperate
with it byte-for-byte.

> **Building a second extension?** Implement the algorithm below with the **exact
> same shared constants**, your own `EXT_ID` / route / upstream. Do **not** edit
> `nginx.conf` blocks directly, and do **not** change any `SHARED` constant.

## Why a single combined `sub_filter` (read this — it's the whole point)

nginx's `sub_filter` consumes each **source token** once: if two extensions both do
`sub_filter '</body>' '...'`, they collide and only the first-included one fires.
Using different tokens (`</head>` / `</body>` / `</html>`) only buys three slots.

So we do **not** give each extension its own `sub_filter`. Instead, each extension
just drops its `<script>` **tag** in a file, and the integrator regenerates **one**
shared `sub_filter '</body>' '...'` whose replacement is the concatenation of every
extension's tag. One directive, no collision, scales to N extensions. Per-extension
`location` blocks have distinct path prefixes, so those never collide.

```
server {
    ...
    include /usr/local/nginx/conf/frigate-ext/locations/*.conf;     # <- added once
    location / {
        ... (Frigate's own config) ...
        root /opt/frigate/web;
        include /usr/local/nginx/conf/frigate-ext/generated/*.conf;  # <- added once (the ONE combined sub_filter)
        try_files ...;
    }
}
```

## SHARED constants — identical in every extension (do not change)

| Name | Value |
|---|---|
| Lock file | `/tmp/frigate-inject.lock` |
| Ext root | `/usr/local/nginx/conf/frigate-ext` |
| Inject dir (your `<script>` tag) | `…/frigate-ext/inject/<ext-id>.html` |
| Locations dir (your `location {}`) | `…/frigate-ext/locations/<ext-id>.conf` |
| Generated dir (the ONE combined sub_filter) | `…/frigate-ext/generated/subfilter.conf` |
| Managed-line marker | `# frigate-ext (managed)` |
| Locations-include anchor | insert **before** the line containing `location / {` |
| Generated-include anchor | insert **after** the line containing `root /opt/frigate/web` |
| nginx.conf path | `/usr/local/nginx/conf/nginx.conf` |

## PER-EXTENSION values (you choose, must be unique)

- `EXT_ID` — unique slug, e.g. `frigate-layout-sync`, `better-frigate-face-recognition`. Used as your filenames (`<EXT_ID>.html`, `<EXT_ID>.conf`).
- `ROUTE` — your path prefix, e.g. `/__layoutsync/`, `/__betterfaces/`. **Pick a unique prefix** that can't collide with Frigate's own paths or another extension.
- `UPSTREAM` — `host:port` your companion listens on, resolvable from inside the Frigate container (put your container on Frigate's Docker network).

## The two files you own

1. **`inject/<EXT_ID>.html`** — your one `<script>` tag, e.g.
   `<script src="/__yourprefix/inject.js" defer></script>` — **no single quotes** (it goes inside a single-quoted nginx string) and **no newline**.
2. **`locations/<EXT_ID>.conf`** — your nginx location, e.g.
   ```nginx
   location /__yourprefix/ {
       resolver 127.0.0.11 ipv6=off valid=10s;   # docker DNS; lazy resolve so your
       set $up "http://<UPSTREAM>";               # companion being down can't break Frigate
       proxy_pass $up$request_uri;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
   }
   ```

## The algorithm

Access Docker via `docker exec <frigate-container> ...` (mount `/var/run/docker.sock`
into your companion). Run **`ensure()`** at startup, on every Frigate (re)start, and
on a ~30s timer:

1. **Write your two files atomically** (`mkdir -p` the dir, write `<file>.tmp`, `mv`). No lock needed (distinct filenames per extension).
2. **Under `flock <LOCK>` (one shell pass):**
   a. `mkdir -p inject locations generated`.
   b. **Ensure the include lines** (each idempotent — check with `grep -F` so an upgrade adds a missing one): the `generated/*.conf` include after `root /opt/frigate/web`, the `locations/*.conf` include before `location / {`, each tagged with the managed marker.
   c. **Regenerate the combined sub_filter** — this MUST be byte-identical logic in every extension so concurrent runs converge:
      ```sh
      TAGS=$(cat <ext-root>/inject/*.html 2>/dev/null | tr -d '\r\n')
      if [ -n "$TAGS" ]; then
        printf "sub_filter '</body>' '%s</body>';\n" "$TAGS" > <ext-root>/generated/subfilter.conf.tmp \
          && mv <ext-root>/generated/subfilter.conf.tmp <ext-root>/generated/subfilter.conf
      else rm -f <ext-root>/generated/subfilter.conf; fi
      ```
   d. **`nginx -t`; if OK `nginx -s reload`.** If `nginx -t` **fails**, remove **only your own** `inject/<EXT_ID>.html` + `locations/<EXT_ID>.conf`, regenerate, recover, and report — so a bad apply never leaves the running nginx broken.

**Self-heal:** a Frigate upgrade recreates the container from a fresh image, wiping
everything. Watch `docker events --filter type=container --filter event=start` and
re-run `ensure()` when the **event actor name** equals the Frigate container (do
**not** use `--filter container=<name>` — it binds to the old id and misses the
recreated one). The ~30s timer is the backstop.

**Uninstall:** under the lock, delete only your `inject/<EXT_ID>.html` +
`locations/<EXT_ID>.conf`, regenerate the combined sub_filter, reload.

## Why this is race-free

- **The combined sub_filter** is deterministic from `inject/*.html`, so whichever extension regenerates it last produces the same correct result; it's rebuilt under the lock.
- **Per-extension inputs** are separate files written atomically (`tmp`+`mv`) — two extensions can't corrupt or overwrite each other.
- **Include edits + reloads** run under the shared `flock`, so `nginx -t` always sees a consistent set of files and reloads don't interleave.

## Migration note (v1 → v2)

v1 of this spec had each extension write its own `subfilters/<ext-id>.conf` with its
own `sub_filter` — that's the collision this v2 fixes. The reference integrator keeps
the old `subfilters/*.conf` include working during migration, so an extension still on
v1 keeps injecting (use a different token like `</head>` until you migrate). To move
to v2: stop writing `subfilters/<ext-id>.conf`, write `inject/<ext-id>.html` instead,
and regenerate the combined sub_filter as above. (`frigate-layout-sync`'s integrator
auto-removes its own old `subfilters` file on upgrade.)

## Manual / no-socket mode

If you don't want to grant the Docker socket, do the same edits by hand (or bind-mount
a custom `nginx.conf`): add the two `include` lines once, drop your `inject/<ext-id>.html`
+ `locations/<ext-id>.conf`, and write the combined `generated/subfilter.conf`.
