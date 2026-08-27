import teardown, {
	localConfigPath,
	snapshotGitConfigState,
} from "./git-config-guard.js";

export default function setup(): () => void {
	// Snapshot BEFORE any test runs so the teardown guard can tell a real
	// local identity that already matched a fixture value (environment) from
	// contamination introduced during the run (#2251).
	const baseline = snapshotGitConfigState(localConfigPath(process.cwd()));
	return () => teardown(baseline);
}
