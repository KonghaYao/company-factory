import type { Organization, OrgNode } from "../../lib/types";

export type NodeOption = { node: OrgNode; path: string };

/** Active nodes with their display path, sorted for a stable select order. */
export function activeNodeOptions(
  organization: Organization | null,
): NodeOption[] {
  const nodes =
    organization?.nodes.filter((node) => node.status === "active") ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path = (node: OrgNode): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let current: OrgNode | undefined = node;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return names.join(" / ");
  };
  return nodes
    .slice()
    .sort((a, b) => path(a).localeCompare(path(b), "zh-CN"))
    .map((node) => ({ node, path: path(node) }));
}

/**
 * Parent candidates. Editing a node must never offer itself or its subtree:
 * both would create a cycle that the domain rejects after the user edited.
 */
export function parentNodeOptions(
  organization: Organization | null,
  editingId?: string,
): NodeOption[] {
  const options = activeNodeOptions(organization);
  if (!editingId) return options;
  const excluded = new Set([editingId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of organization?.nodes ?? []) {
      if (
        node.parentId &&
        excluded.has(node.parentId) &&
        !excluded.has(node.id)
      ) {
        excluded.add(node.id);
        changed = true;
      }
    }
  }
  return options.filter(({ node }) => !excluded.has(node.id));
}

/**
 * Root nodes keep an empty parent. Editing must not fall through to the first
 * available node when `parentId` is null, otherwise a rename silently reparents.
 */
export function defaultParentId(
  editing: OrgNode | undefined,
  parentId: string | undefined,
  options: NodeOption[],
): string {
  if (editing) return editing.parentId ?? "";
  return parentId ?? options[0]?.node.id ?? "";
}
