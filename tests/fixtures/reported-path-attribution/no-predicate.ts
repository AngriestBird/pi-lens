// A comment naming pathsEqual must not launder this parser into the census.
export function parse(raw: string) {
	return raw.match(/^(.*?):(\d+):(\d+)/);
}
