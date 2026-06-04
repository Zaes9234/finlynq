/**
 * Shared SWR seam (FINLYNQ-115). Barrel for the fetcher + key/config
 * convention adopted behind the FINLYNQ-111 transactions data hooks.
 *
 * See ./README.md for the convention new screens should follow.
 */

export { jsonFetcher, softJsonFetcher, FetchError } from "./fetcher";
export { swrListOptions, swrKey } from "./config";
