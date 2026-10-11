-- A tab whose agent ended its turn with a report that asks nothing (TER-972). Adding an enum value is
-- backward compatible: the release still serving during the switch never writes it.
ALTER TYPE "TabState" ADD VALUE 'finished';
