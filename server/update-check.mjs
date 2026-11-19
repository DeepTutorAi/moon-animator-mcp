// Tells the user when a newer release exists. Nothing is downloaded or
// installed here: the running version stays the one the user chose, and
// updating (see update.mjs) is a command they run themselves.

export const REPOSITORY = 'DeepTutorAi/moon-animator-mcp';
const LATEST_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/package.json`;
const CHANGELOG_URL = `https://github.com/${REPOSITORY}/blob/main/CHANGELOG.md`;
const TIMEOUT_MS = 4000;

// The package as npx takes it, pinned to a release.
export function packageSpec(version) {
  return `github:${REPOSITORY}#v${version}`;
}

function parts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  return match ? match.slice(1).map(Number) : null;
}

// True when `candidate` is a later x.y.z than `current`.
export function isNewer(candidate, current) {
  const a = parts(candidate);
  const b = parts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// The version on the repository's main branch, or null when it cannot be read
// (offline, blocked, slow). One small GET; nothing about this machine is sent.
export async function fetchLatestVersion(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(LATEST_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    const version = (await response.json()).version;
    return parts(version) ? version : null;
  } catch {
    return null;
  }
}

export function updateInstructions(latest) {
  return (
    `To update the server and the skill, the user runs \`npx -y ${packageSpec(latest)} update\` in their project ` +
    `folder and restarts the session (Claude Code plugin: \`claude plugin update moon-animator@moon-animator-mcp\`). ` +
    `Changes: ${CHANGELOG_URL}`
  );
}

// `start()` looks up the latest version once, in the background. `info()` is
// what is known so far; `takeNotice()` returns the notice text the first time
// it is called after a newer version was found, then null.
export function createUpdateCheck({ current, fetchLatest = fetchLatestVersion, disabled = false, log = () => {} }) {
  let latest = null;
  let announced = false;

  const available = () => latest !== null && isNewer(latest, current);
  const notice = () =>
    `Update available: moon-animator-mcp ${latest} (running ${current}). Nothing is updated automatically; ` +
    `tell the user and let them decide. ${updateInstructions(latest)}`;

  return {
    async start() {
      if (disabled) return;
      latest = await fetchLatest();
      if (available()) log(notice());
    },
    // Short on purpose: the full explanation is the notice, said once.
    info() {
      const info = { running: current };
      if (latest !== null) info.latest = latest;
      if (available()) info.update = `npx -y ${packageSpec(latest)} update`;
      return info;
    },
    takeNotice() {
      if (announced || !available()) return null;
      announced = true;
      return notice();
    },
  };
}
