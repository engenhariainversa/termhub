-- A tab whose agent ended its turn while its background work still runs (TER-644). Adding an enum
-- value is backward compatible: the release still serving during the switch never writes it.
ALTER TYPE "TabState" ADD VALUE 'waiting_background';
