---
symptom: "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 169063 (apt-get) / E: Unable to lock directory /var/lib/apt/lists/ when pasting the agent install command from Add machine on a Linux VPS"
tags: [agent, install, apt, lock, linux, onboarding]
evidence: fixed
card: TER-1058
pr: https://github.com/engenhariainversa/termhub/pull/482
agent: claude
date: 2026-10-10
---
## Cause

Another apt run on the machine held the lock, and the install command called `apt-get update` with
no tolerance for it, so the whole paste failed before `npm i -g @termhub/agent`. On that VPS the
holder was an `apt-get -qq -y update` from another origin, stuck for over a month; the common case
is `unattended-upgrades` on a new VPS's first boot. The command also ran apt on machines that
already had every dependency, so a busy apt blocked an install that needed nothing from it.

`-o DPkg::Lock::Timeout=N` alone does not cover this symptom: it makes apt wait for the dpkg lock
(`/var/lib/dpkg/lock-frontend`), but `apt-get update` still fails at once on the lists lock
(`/var/lib/apt/lists/lock`).

## Fix

`linuxInstallCommand` in `apps/web/src/components/AgentEnrollment.tsx` (mirrored in
`apps/agent/README.md`):

- skips the package manager when `tmux`, `make`, `g++` and `python3` are already there;
- runs apt through `th_apt`: `DEBIAN_FRONTEND=noninteractive`, `-o DPkg::Lock::Timeout=120`, and a
  retry every 5 s for up to 120 s while another `apt`/`apt-get`/`dpkg`/`unattended-upgr` process is
  alive (which covers the lists lock). `unattended-upgrade-shutdown` does not count: Ubuntu keeps
  that daemon running all the time under the same 15-character process name, so matching it would
  turn every apt failure into a two-minute wait and a wrong "apt is in use" message;
- when the lock is still held, prints the holders (`PID`, name, elapsed time from `ps`) and what to
  do: wait, or end a process stuck for a long time and run `dpkg --configure -a`. Never delete the
  lock file: that leaves dpkg half configured.

On a machine already in this state: `ps -eo pid,etime,args | grep -E '[a]pt|[d]pkg'`; if the holder
has been running for days, `kill <pid>`, `dpkg --configure -a`, and paste the command again.

## How to check

`AgentEnrollment.commands.test.ts` runs the command in sh and bash with stubbed tools: lock released
in time (goes on), lock never released (message with the holder, no npm), dependencies present (no
package manager call).
