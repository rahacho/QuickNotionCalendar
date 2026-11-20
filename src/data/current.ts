/**
 * The active repository (set by boot.ts). Actions read it through getRepo(); kept in its own
 * module so store/actions.ts does not import boot.ts (which imports the store).
 */
import type { Repo } from './repo';

let current: Repo | null = null;

export function getRepo(): Repo | null {
  return current;
}

export function setCurrentRepo(repo: Repo | null): void {
  current = repo;
}
