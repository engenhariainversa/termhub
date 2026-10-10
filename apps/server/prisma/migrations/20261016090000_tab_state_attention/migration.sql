-- Tab states that tell the attention indicator apart (TER-1046): a blocked automatic run, a login that
-- expired and the folder trust dialog. Adding enum values is backward compatible: the release still
-- serving during the switch never writes them.
ALTER TYPE "TabState" ADD VALUE 'blocked';
ALTER TYPE "TabState" ADD VALUE 'auth_required';
ALTER TYPE "TabState" ADD VALUE 'trust_prompt';
