-- TER-576: typing into a terminal — keystrokes over /ws/tabs, taps over /ws/sim, POST /tabs/:id/input
-- and /paste-file — now takes 'terminals' / 'write' instead of riding on 'terminals' / 'read' (the
-- sockets) or 'update' (the HTTP routes). Until now only BETA held that grant, so AUTHENTICATED,
-- MANAGER and any custom role that could already type would lose the keyboard on deploy.
--
-- Every non-admin role that holds terminals:update typed before this release, so it keeps typing: it
-- gets terminals:write. A role with terminals:read and no update becomes read-only, which is the fix.
-- ADMIN bypasses grants and needs no row. Side effect, intended: those roles now also see the MCP
-- write tools (send_input, send_key, run_command, …), which the same grant has always gated.
--
-- Data only, and idempotent: the previous release reads this grant exactly like any other.
INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_' || r."id" || '_terminals_write', 'terminals', 'write', r."id"
FROM "roles" r
WHERE r."is_admin" = false
  AND EXISTS (
    SELECT 1 FROM "permissions" p
    WHERE p."role_id" = r."id" AND p."resource" = 'terminals' AND p."action" = 'update'
  )
ON CONFLICT DO NOTHING;
