// Must match the "version" field in apps/agent/package.json — bumped together on release.
// (Reading package.json at build time would be simpler but is awkward with tsup's bundling;
// version.test.ts asserts the two stay in sync.)
export const AGENT_VERSION = '0.6.0';
