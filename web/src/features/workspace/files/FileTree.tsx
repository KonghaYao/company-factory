import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
} from "lucide-react";
import type { FileEntry, Scope } from "../../../lib/types";
import { api, list, scoped } from "../../../lib/api";
import { ErrorBox, Loading } from "../../../ui/primitives";

/** 文件树只在展开目录时请求子节点，避免一次性读取整个仓库。 */
export function TreeNode({
  scope,
  entry,
  depth,
  active,
  onOpen,
}: {
  scope: Scope;
  entry: FileEntry;
  depth: number;
  active?: string;
  onOpen: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const directory =
    entry.type === "directory" || entry.type === "dir" || entry.isDirectory;
  const childrenQuery = useQuery({
    queryKey: ["files", scope.companyId, scope.agentId, entry.path],
    queryFn: () => api(scoped(scope, "files", { path: entry.path })),
    enabled: !!directory && expanded && !entry.children,
  });

  return (
    <>
      <button
        className={`file-node ${active === entry.path ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (directory ? setExpanded(!expanded) : onOpen(entry.path))}
        title={entry.path}
      >
        {directory ? (
          expanded ? (
            <ChevronDown size={11} />
          ) : (
            <ChevronRight size={11} />
          )
        ) : (
          <span style={{ width: 11 }} />
        )}
        {directory ? (
          expanded ? (
            <FolderOpen size={14} />
          ) : (
            <Folder size={14} />
          )
        ) : (
          <FileIcon size={13} />
        )}
        <span>{entry.name || entry.path.split("/").pop()}</span>
      </button>
      {directory && expanded && (
        <>
          {childrenQuery.isLoading && <Loading />}
          <ErrorBox error={childrenQuery.error} />
          {(entry.children ||
            list<FileEntry>(childrenQuery.data, "entries")).map((child) => (
            <TreeNode
              key={child.path}
              scope={scope}
              entry={child}
              depth={depth + 1}
              active={active}
              onOpen={onOpen}
            />
          ))}
        </>
      )}
    </>
  );
}
