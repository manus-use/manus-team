/**
 * The driver kinds this gateway knows.
 *
 * Kept in its own module, with no imports, because the config, the role loader
 * and the name grammar all need the list, and none of them should load a driver
 * to get it. Building a driver is `./build.ts`.
 */
export const KNOWN_DRIVERS = ['acp', 'structured-cli'] as const;
export type KnownDriver = (typeof KNOWN_DRIVERS)[number];
