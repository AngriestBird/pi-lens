/**
 * The project-root marker vocabulary shared by the startup scan and the test
 * harness (#4560). `findNearestProjectRoot` (clients/startup-scan.ts) is the
 * owner that resolves them; the harness imports the same list so a run whose
 * tmp root carries one can refuse instead of silently rooting every bare
 * fixture there. One list, no second spelling.
 */
export const PROJECT_ROOT_MARKERS = [
	".git",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"composer.json",
] as const;
