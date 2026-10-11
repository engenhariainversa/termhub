-- A tab started in an automation card's worktree keeps that folder (null = the project's folder).
ALTER TABLE "tabs" ADD COLUMN "cwd" TEXT;
