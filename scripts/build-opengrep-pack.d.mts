export function buildPack(options: {
	upstream: string;
	registryFile?: string;
	commit?: string;
	check?: boolean;
	packDir?: string;
}): {
	chosen: Array<{ id: string }>;
	excluded: Array<{ id: string; license: string }>;
	bytes: number;
	same?: boolean;
	rulesPath?: string;
};
export function defuseSecretShapes(text: string): string;
