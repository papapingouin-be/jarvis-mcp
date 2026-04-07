export type FetchRunner = typeof fetch;

export const defaultFetchRunner: FetchRunner = (...args) => fetch(...args);
