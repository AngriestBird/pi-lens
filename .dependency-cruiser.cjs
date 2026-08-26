const eagerClients = require("./config/dependency-cruiser-eager-allowlist.json");

const eagerClientPattern = `^(?:\\./)?(?:${eagerClients
	.map((modulePath) =>
		modulePath.replace(/^\.\//, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	)
	.join("|")})$`;

module.exports = {
	forbidden: [
		{
			name: "no-client-cycles",
			severity: "error",
			comment: "clients/ modules must remain acyclic.",
			from: { path: "^(?:\\./)?clients/" },
			to: { path: "^(?:\\./)?clients/", circular: true },
		},
		{
			name: "declared-client-leaf",
			severity: "error",
			comment: "Declared leaf modules must not import another clients/ module.",
			from: {
				path: "^(?:\\./)?clients/(ledger-bounds|lsp/workspace-diagnostics-session)\\.js$",
			},
			to: { path: "^(?:\\./)?clients/" },
		},
		{
			name: "session-start-eager-allowlist-config-dependency-cruiser-eager-allowlist-json",
			severity: "error",
			comment:
				"A session-start eager import must be added to config/dependency-cruiser-eager-allowlist.json deliberately.",
			from: { path: "^index\\.ts$" },
			to: { path: "^(?:\\./)?clients/", pathNot: eagerClientPattern },
		},
	],
	options: {
		tsConfig: { fileName: "tsconfig.json" },
		doNotFollow: { path: "(^|/)node_modules/" },
		preserveSymlinks: false,
	},
};
