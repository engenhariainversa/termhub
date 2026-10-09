/**
 * The oldest @termhub/agent the server lets a machine keep (TER-1056). A connected agent below it is
 * told to update as soon as it is idle — even with the machine's auto-update switch off — and the
 * machine screens show a red notice until it does. Raise it in the PR that publishes an agent release
 * with a fix every machine needs (a security fix, or a server feature that cannot work without it):
 * CI publishes the agent and deploys this value from the same merge, and the server only ever installs
 * a release whose provenance it verified, so a minimum above the newest verified release just keeps the
 * notice up until that release is processed by npm.
 *
 * 0.27.0: the screen login (0.26.0), the device key (0.25.0), the hooks status read (0.21.0) and the
 * TER-1054 login fixes.
 */
export const MIN_AGENT_VERSION = '0.27.0';
