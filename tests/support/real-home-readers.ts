/**
 * #4789: the tests that read the maintainer's REAL home on purpose.
 *
 * `tests/support/vitest-setup.ts` pins HOME, USERPROFILE and the XDG
 * directories for every worker, so `os.homedir()` answers the worker's own
 * scratch home. A test that needs the real one goes through `REAL_HOME` (or
 * `os.userInfo()`, which does not read HOME). Each such file is a row here,
 * with the reason it cannot use the pinned home, and carries the same
 * `// real-home: <reason>` header at the top of the file. The scan in
 * `tests/config/real-home-reader-registry.test.ts` fails a file that spells
 * either and has no row, and a row whose file no longer does.
 *
 * Reading is the only admission: a row never lets a test WRITE through the
 * real home. Keep this list short; a test that can use `pinFixtureHome` does.
 */
export const REAL_HOME_READERS: Readonly<Record<string, string>> = {
	"tests/clients/formatter-template-preserve.test.ts":
		"read-only path probe for the maintainer's managed prettier (`~/.pi-lens/tools/node_modules/prettier`); prettier is not a devDependency, so without the real home the suite skips on the one host that has it",
	"tests/clients/knip-cache-consumer-staleness.test.ts":
		"read-only PATH probe for the maintainer's managed knip (`~/.pi-lens/tools/node_modules/.bin`); the pinned home has no managed tools tree, and the case skips where neither that nor a PATH knip exists",
	"tests/clients/turn-scenarios.test.ts":
		"read-only PATH probe for the maintainer's managed knip (`~/.pi-lens/tools/node_modules/.bin`); the pinned home has no managed tools tree, and the scenario skips where neither that nor a PATH knip exists",
	"tests/clients/installer/tool-discovery.test.ts":
		"mocks node:os with its own `userInfo` that answers a fixture home; reads nothing of the real one",
	"tests/clients/installer/version-drift.test.ts":
		"mocks node:os with its own `userInfo` that answers a fixture home; reads nothing of the real one",
	"tests/clients/worker-home-pin-hermeticity.test.ts":
		"the pin's own proof: compares paths against the passwd home to show a child never sees it; never reads or writes through it",
};
