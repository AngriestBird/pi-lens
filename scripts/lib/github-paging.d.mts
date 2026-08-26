import type { FetchFn } from "./merge-train-warden.d.mts";

export const REST_PAGE_SIZE: number;
export const MAX_REST_PAGES: number;

export function paginate(fetcher: FetchFn, url: string): Promise<unknown[]>;
export function commentMarkerExists(
	fetcher: FetchFn,
	owner: string,
	repo: string,
	number: number,
	marker: string,
): Promise<boolean>;
