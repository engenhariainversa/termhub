---
symptom: "Vite dev server answers 403 (Playwright: TimeoutError on page.goto) when another container opens it by its container name"
tags: [vite, docker, playwright, screenshot]
evidence: fixed
card: TER-1165
agent: claude
date: 2026-11-09
---
## Cause

Vite 6 checks the `Host` header (`server.allowedHosts`) and refuses any host name it does not know with
403. Run with `VITE_HOST=0.0.0.0`, it accepts `localhost` and IP addresses, but not a Docker container
name such as `http://th-shot-vite:5173`. The page never loads, so Playwright only reports a timeout.

## Fix

Open the dev server by the container's IP instead of its name:
`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <vite-container>`, then
`http://<ip>:5173/...`. (Adding the name to `server.allowedHosts` also works, but needs a config change.)

## How to check

`docker run --rm --network <net> curlimages/curl -s -o /dev/null -w '%{http_code}' http://<name>:5173/`
prints 403; the same with the IP prints 200.
