-- The chat's concierge types into terminals through the MCP write tools (open_tab, send_input,
-- send_key, run_command, start_agent, close_tab), and `/mcp` lists a tool only when the user's role
-- holds its grant — 'terminals' / 'write' for all of them. No migration ever granted it, so on any
-- role but ADMIN (which bypasses grants) the concierge saw read tools only and told the user it
-- could not type. BETA is the role that has the chat, so it gets the grant; every write the
-- concierge attempts still stops at the chat's confirmation gate. AUTHENTICATED and MANAGER, which
-- have no chat, are left as they are.
--
-- Data only, and idempotent: the previous release reads this grant exactly like any other.
INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_beta_terminals_write', 'terminals', 'write', r."id"
FROM "roles" r
WHERE r."name" = 'BETA'
ON CONFLICT DO NOTHING;
