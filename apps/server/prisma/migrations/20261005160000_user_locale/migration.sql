-- The language a person chose for termhub (TER-405): 'pt-BR' or 'en'; null = automatic (the
-- browser's language on the web, pt-BR for e-mails and push). Nullable, no default: the release
-- still serving during the blue/green switch never reads it.
ALTER TABLE "users" ADD COLUMN "locale" TEXT;
