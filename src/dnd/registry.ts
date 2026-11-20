/**
 * DOM registries used by live hit-testing:
 *  - drop containers (day cells, Inbox drop zones) by element, so the element under the pointer can be
 *    mapped to a container by walking up its ancestors (works across scroll containers and sheets);
 *  - sortable items per container (element + occurrence), so drop positions are computed from what is
 *    actually rendered right now, not from rects measured when the drag started.
 */
import type { Occurrence } from '@shared/types';

export interface ContainerEntry {
  id: string;
  kind: 'day' | 'inbox';
}

export interface ItemEntry {
  /** dnd-kit draggable id. */
  id: string;
  occ: Occurrence;
  containerId: string | null;
  node: HTMLElement | null;
}

const containersByNode = new Map<Element, ContainerEntry>();
const itemsByContainer = new Map<string, Set<ItemEntry>>();
const nodesById = new Map<string, Set<HTMLElement>>();
/** Rendered order (draggable ids) of each sortable list, from <SortableList itemIds>. */
const listOrders = new Map<string, readonly string[]>();

export function setListOrder(containerId: string, ids: readonly string[]): void {
  listOrders.set(containerId, ids);
}

export function clearListOrder(containerId: string, ids: readonly string[]): void {
  if (listOrders.get(containerId) === ids) listOrders.delete(containerId);
}

export function listOrderOf(containerId: string): readonly string[] | undefined {
  return listOrders.get(containerId);
}

export function registerContainer(node: Element, entry: ContainerEntry): void {
  containersByNode.set(node, entry);
}

export function unregisterContainer(node: Element): void {
  containersByNode.delete(node);
}

export function containerOfNode(node: Element): ContainerEntry | undefined {
  return containersByNode.get(node);
}

/** Adds/moves an item entry to the set of its container (call after mutating entry.containerId). */
export function indexItem(entry: ItemEntry, prevContainerId: string | null): void {
  if (prevContainerId !== null && prevContainerId !== entry.containerId) {
    itemsByContainer.get(prevContainerId)?.delete(entry);
  }
  if (entry.containerId === null) return;
  let set = itemsByContainer.get(entry.containerId);
  if (!set) {
    set = new Set();
    itemsByContainer.set(entry.containerId, set);
  }
  set.add(entry);
}

export function unindexItem(entry: ItemEntry): void {
  if (entry.containerId === null) return;
  const set = itemsByContainer.get(entry.containerId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) itemsByContainer.delete(entry.containerId);
}

export function itemsOfContainer(containerId: string): Iterable<ItemEntry> {
  return itemsByContainer.get(containerId) ?? [];
}

/** Tracks which DOM nodes currently render a draggable id (the overlay needs the source's look). */
export function setNodeForId(id: string, node: HTMLElement | null, prev: HTMLElement | null): void {
  if (prev) {
    const set = nodesById.get(id);
    set?.delete(prev);
    if (set && set.size === 0) nodesById.delete(id);
  }
  if (node) {
    let set = nodesById.get(id);
    if (!set) {
      set = new Set();
      nodesById.set(id, set);
    }
    set.add(node);
  }
}

/** A connected node rendering `id` (the last registered one when several exist). */
export function nodeForId(id: string): HTMLElement | null {
  const set = nodesById.get(id);
  if (!set) return null;
  let found: HTMLElement | null = null;
  for (const n of set) if (n.isConnected) found = n;
  return found;
}
