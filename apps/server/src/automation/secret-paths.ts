/**
 * The paths the deny list's `Read`/`Edit` rules protect, as they show up in a shell command: a Bash read
 * rule (`Bash(cat:*)`, `Bash(grep:*)`, TER-989) must not let `cat .env` or `grep -r x ~/.ssh` through,
 * where the path rules cannot be matched. Claude Code applies the Read rules to those commands itself.
 * Shared by automatic runs (`answers.ts`) and the auto mode dialogs of manual tabs (TER-1210).
 */
export const SECRET_PATH = /(^|[\/'"=])\.env|\.ssh(\/|$)|\.config\/gh(\/|$)|\.credentials\.json|\.aws(\/|$)|\.termhub\/(config\.json|hook\.env|tabs(\/|$))|\.npmrc|\.netrc|\.git-credentials|\.docker\/config\.json/;
