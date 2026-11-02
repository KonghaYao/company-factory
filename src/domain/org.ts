import { createHash } from "node:crypto";
import {
  DomainError,
  requireValue,
  type Group,
  type OrgNode,
  type OrgNodeKind,
  type OrgPlacement,
  type OrgMemberStatus,
  type Organization,
  type Roster,
  type RosterMember,
} from "./types";

/** Independent organization document. It references people; it never owns them. */
export const ORG_SCHEMA = "company-org/v1" as const;
export const ROSTER_SCHEMA = "company-people/v2" as const;
export const ORG_NODE_KINDS: readonly OrgNodeKind[] = [
  "company",
  "division",
  "department",
  "team",
  "squad",
  "committee",
];
/** Maximum number of nodes on a root-to-leaf path. */
export const MAX_ORG_DEPTH = 16;

export function isOrgNodeKind(value: unknown): value is OrgNodeKind {
  return typeof value === "string" && ORG_NODE_KINDS.includes(value as OrgNodeKind);
}

const text = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;
const optionalText = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Read-side normalization. Corrupt documents fail loudly; otherwise defaults
 * keep older organization files readable without rewriting them.
 */
export function normalizeOrganization(value: unknown): Organization {
  const doc = value as Partial<Organization> | null;
  requireValue(
    !!doc,
    "invalid_document",
    "Invalid organization.yaml",
    500,
  );
  requireValue(
    Array.isArray(doc.nodes) && Array.isArray(doc.placements),
    "invalid_document",
    "Invalid organization.yaml: nodes and placements must be arrays",
    500,
  );
  const seen = new Set<string>();
  const nodes: OrgNode[] = doc.nodes.map((raw, index) => {
    const node = raw as Partial<OrgNode>;
    requireValue(
      typeof node.id === "string" && node.id.length > 0,
      "invalid_document",
      "Invalid organization.yaml: node id is required",
      500,
    );
    requireValue(
      !seen.has(node.id),
      "invalid_document",
      "Invalid organization.yaml: duplicate node id",
      500,
    );
    seen.add(node.id);
    const kind = isOrgNodeKind(node.kind) ? node.kind : "department";
    return {
      id: node.id,
      name: text(node.name, node.id),
      kind,
      parentId:
        typeof node.parentId === "string" && node.parentId.length > 0
          ? node.parentId
          : null,
      order: Number.isInteger(node.order) ? Number(node.order) : index,
      responsibilities: text(node.responsibilities),
      leadPersonId: optionalText(node.leadPersonId) ?? null,
      status: node.status === "archived" ? "archived" : "active",
      version: Number.isInteger(node.version) ? Number(node.version) : 1,
    };
  });
  const placements: OrgPlacement[] = doc.placements.map((raw, index) => {
    const placement = raw as Partial<OrgPlacement>;
    requireValue(
      typeof placement.personId === "string" && placement.personId.length > 0,
      "invalid_document",
      "Invalid organization.yaml: placement personId is required",
      500,
    );
    requireValue(
      typeof placement.nodeId === "string" && placement.nodeId.length > 0,
      "invalid_document",
      "Invalid organization.yaml: placement nodeId is required",
      500,
    );
    return {
      personId: placement.personId,
      nodeId: placement.nodeId,
      title: optionalText(placement.title),
      order: Number.isInteger(placement.order) ? Number(placement.order) : index,
      primary: true,
      reportsToPersonId: optionalText(placement.reportsToPersonId) ?? null,
      since: text(placement.since),
      movedAt: text(placement.movedAt, text(placement.since)),
      movedBy: text(placement.movedBy, "legacy"),
      previousNodeId: optionalText(placement.previousNodeId) ?? null,
      version: Number.isInteger(placement.version) ? Number(placement.version) : 1,
    };
  });
  return {
    schema: ORG_SCHEMA,
    version: Number.isInteger(doc.version) ? Number(doc.version) : 1,
    nodes,
    placements,
  };
}

export function normalizeRoster(value: unknown, createdAt: string): Roster {
  const doc = value as Partial<Roster> | null;
  const members = Array.isArray(doc?.members) ? doc.members : [];
  return {
    schema: ROSTER_SCHEMA,
    version: doc && Number.isInteger(doc.version) ? Number(doc.version) : 1,
    members: members.map((raw): RosterMember => {
      const member = raw as Partial<RosterMember>;
      return {
        agentId: text(member.agentId),
        status: member.status === "archived" ? "archived" : "active",
        joinedAt: text(member.joinedAt, createdAt),
        ...(typeof member.groupId === "string"
          ? { groupId: member.groupId }
          : {}),
        ...(typeof member.role === "string" ? { role: member.role } : {}),
      };
    }),
  };
}

/** Roster v2 is a flat people index: no organization or access-role copy. */
export function rosterV2(roster: Roster): Roster {
  return {
    schema: ROSTER_SCHEMA,
    version: roster.version,
    members: roster.members.map((member) => ({
      agentId: member.agentId,
      status: member.status === "archived" ? "archived" : "active",
      joinedAt: member.joinedAt,
    })),
  };
}

/**
 * In-memory legacy projection. `groups.yaml` had no parents, so every group is
 * a root. Two existing roots are deliberately not nested under each other.
 */
export function legacyOrganization(
  groups: Group[],
  roster: Roster,
  createdAt: string,
): Organization {
  const nodes: OrgNode[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!group || typeof group.id !== "string" || seen.has(group.id)) continue;
    seen.add(group.id);
    nodes.push({
      id: group.id,
      name: text(group.name, group.id),
      kind: group.id === "headquarters" ? "company" : "department",
      parentId: null,
      order: nodes.length,
      responsibilities: text(group.responsibilities),
      leadPersonId: null,
      status: "active",
      version: 1,
    });
  }
  const orders = new Map<string, number>();
  const placements: OrgPlacement[] = [];
  for (const member of roster.members) {
    if (!member.groupId || !seen.has(member.groupId)) continue;
    if (member.status === "archived") continue;
    const order = orders.get(member.groupId) ?? 0;
    orders.set(member.groupId, order + 1);
    placements.push({
      personId: member.agentId,
      nodeId: member.groupId,
      order,
      primary: true,
      reportsToPersonId: null,
      since: member.joinedAt || createdAt,
      movedAt: member.joinedAt || createdAt,
      movedBy: "legacy",
      previousNodeId: null,
      version: 1,
    });
  }
  return { schema: ORG_SCHEMA, version: 1, nodes, placements };
}

export function toGroups(nodes: OrgNode[]): Group[] {
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    responsibilities: node.responsibilities ?? "",
  }));
}

export function findNode(org: Organization, id: string): OrgNode | undefined {
  return org.nodes.find((node) => node.id === id);
}

export function childNodes(org: Organization, parentId: string | null): OrgNode[] {
  return org.nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function nodeDepth(org: Organization, id: string): number {
  let depth = 0;
  let current = findNode(org, id);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id))
      throw new DomainError("invalid_document", "Organization tree contains a cycle", 500);
    seen.add(current.id);
    depth++;
    if (!current.parentId) return depth;
    current = findNode(org, current.parentId);
  }
  throw new DomainError("invalid_document", "Organization node parent is missing", 500);
}

export function subtreeIds(org: Organization, id: string): string[] {
  const result: string[] = [];
  const queue = [id];
  while (queue.length) {
    const current = queue.shift()!;
    if (result.includes(current)) continue;
    result.push(current);
    queue.push(...org.nodes.filter((node) => node.parentId === current).map((node) => node.id));
  }
  return result;
}

export function nextNodeOrder(
  org: Organization,
  parentId: string | null,
  excludeId?: string,
): number {
  const siblings = childNodes(org, parentId).filter((node) => node.id !== excludeId);
  return siblings.reduce((max, node) => Math.max(max, node.order + 1), 0);
}

export function nextPlacementOrder(org: Organization, nodeId: string): number {
  return org.placements
    .filter((placement) => placement.nodeId === nodeId)
    .reduce((max, placement) => Math.max(max, placement.order + 1), 0);
}

/** Height of a node subtree in nodes; a leaf is 1. */
export function subtreeHeight(org: Organization, id: string): number {
  const children = org.nodes.filter((node) => node.parentId === id);
  if (!children.length) return 1;
  return 1 + Math.max(...children.map((node) => subtreeHeight(org, node.id)));
}

/** Root → node. Missing parents stop the path rather than inventing names. */
export function nodePath(org: Organization, id: string): { id: string; name: string }[] {
  const reversed: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  let current = findNode(org, id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    reversed.push({ id: current.id, name: current.name });
    current = current.parentId ? findNode(org, current.parentId) : undefined;
  }
  return reversed.reverse();
}

export function placementFor(
  org: Organization,
  personId: string,
): OrgPlacement | undefined {
  return org.placements.find(
    (placement) => placement.personId === personId && placement.primary,
  );
}

/** Same formula as runtime WASM scope/cwd binding: sha256(JSON([companyId, agentId])). */
export function runtimeScopeId(companyId: string, agentId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([companyId, agentId]))
    .digest("hex");
}
