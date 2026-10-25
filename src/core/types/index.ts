export * from './common.types';
export * from './project-index.types';
/*
| SE-F-009 — the barrel claims to be the public type surface, yet Blueprint
| and every blueprint shape lived only in ./blueprint.types.ts: a consumer
| importing from 'core/types' got type errors for names the contract says are
| public. Pure-type module (no imports, no runtime), so it adds no load cost
| and cannot drag an optional native dependency into `require`-time.
*/
export * from './blueprint.types';
