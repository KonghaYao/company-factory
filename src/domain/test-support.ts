import { randomUUID } from "node:crypto";
import type { CallerContext, CompanyDomain } from "./index";

/**
 * Test-only organization fixture. Mirrors the HR flow: create a department,
 * create its department-head member, then make that member the node lead.
 * Provisioning still goes through the domain's injected test double.
 */
export async function createDepartmentWithHead(
  domain: CompanyDomain,
  hr: CallerContext,
  input: {
    nodeId: string;
    headId: string;
    nodeName?: string;
    headName?: string;
    parentId?: string;
    responsibilities?: string;
  },
): Promise<CallerContext> {
  await domain.createOrgNode(hr, {
    id: input.nodeId,
    name: input.nodeName ?? input.nodeId,
    parentId: input.parentId ?? "headquarters",
    kind: "department",
    responsibilities: input.responsibilities ?? "Department delivery",
    requestId: randomUUID(),
  });
  await domain.createMember(hr, {
    agentId: input.headId,
    name: input.headName ?? "Department Head",
    groupId: input.nodeId,
    role: "department-head",
    responsibilities: input.responsibilities ?? "Lead the department",
    requestId: randomUUID(),
  });
  const { organization } = await domain.organization(hr);
  await domain.updateOrgNode(hr, {
    id: input.nodeId,
    version: organization.version,
    leadPersonId: input.headId,
    requestId: randomUUID(),
  });
  return { type: "agent", id: input.headId, companyId: hr.companyId };
}
