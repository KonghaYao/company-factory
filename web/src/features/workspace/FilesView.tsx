import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import {
  ArrowUp,
  FilePlus2,
  GitCommitHorizontal,
  Home,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { FileEntry, FileReference, Scope } from "../../lib/types";
import { scopeKey } from "../../lib/types";
import { useLocal, emptyLocal } from "../../lib/state";
import { api, ApiError, list, post, scoped } from "../../lib/api";
import { ErrorBox, IconButton, Loading } from "../../ui/primitives";
import { FileEditor } from "./files/FileEditor";
import { TreeNode } from "./files/FileTree";
import { CommitSheet, CreateFileSheet } from "./files/FileSheets";

/**
 * 文件视图 = 目录/搜索/变更 + 多标签编辑器。
 * 事实顺序：磁盘 → 缓冲区 → 保存 → Git commit，界面上始终标明当前处于哪一步。
 */
export function FilesView({
  scope,
  openReference,
  onReference,
}: {
  scope: Scope;
  openReference?: FileReference;
  onReference: (reference: FileReference) => void;
}) {
  const qc = useQueryClient();
  const local = useLocal(
    (state) => state.scopes[scopeKey(scope)] || emptyLocal,
  );
  const file = useLocal((state) => state.file);
  const patch = useLocal((state) => state.patch);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [browse, setBrowse] = useState("");
  const [mode, setMode] = useState<"all" | "changes">("all");
  const [diff, setDiff] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newContent, setNewContent] = useState("");
  const [openError, setOpenError] = useState<unknown>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // 切换 Agent 时回到该 Agent 的活动目录，避免停留在上一个 Agent 的路径。
  useEffect(() => {
    setBrowse("");
  }, [scope.companyId, scope.agentId]);

  const root = useQuery({
    queryKey: ["files", scope.companyId, scope.agentId, browse],
    queryFn: () => api(scoped(scope, "files", { path: browse })),
    refetchInterval: 7000,
  });
  const searches = useQuery({
    queryKey: ["file-search", scope.companyId, scope.agentId, search],
    queryFn: () => api(scoped(scope, "files/search", { q: search })),
    enabled: !!search,
  });
  const changes = useQuery({
    queryKey: ["file-changes", scope.companyId, scope.agentId],
    queryFn: () => api(scoped(scope, "files/changes")),
    enabled: mode === "changes",
    refetchInterval: 6000,
  });
  const active = local.activeFile ? local.files[local.activeFile] : undefined;
  const disk = useQuery({
    queryKey: [
      "file-content",
      scope.companyId,
      scope.agentId,
      local.activeFile,
    ],
    queryFn: () => api(scoped(scope, "files/read", { path: local.activeFile })),
    enabled: !!local.activeFile,
    refetchInterval: 5000,
  });
  const gitDiff = useQuery({
    queryKey: ["file-diff", scope.companyId, scope.agentId, local.activeFile],
    queryFn: () => api(scoped(scope, "files/diff", { path: local.activeFile })),
    enabled: !!local.activeFile && diff,
  });

  // 磁盘变化只在缓冲区干净时静默跟进；有草稿时不覆盖用户输入。
  useEffect(() => {
    if (!active || !disk.data) return;
    const incoming = String(disk.data.content ?? "");
    const version = disk.data.version;
    const scopedLocal =
      useLocal.getState().scopes[scopeKey(scopeRef.current)];
    const current = scopedLocal?.files[active.path];
    if (!current) return;
    if (incoming === current.content) {
      if (current.version !== version)
        file(scopeRef.current, active.path, { version });
      return;
    }
    if (!current.dirty) {
      file(scopeRef.current, active.path, {
        original: incoming,
        content: incoming,
        version,
        dirty: false,
        diskConflict: undefined,
      });
      return;
    }
    if (incoming !== current.original && current.diskConflict !== incoming)
      file(scopeRef.current, active.path, {
        diskConflict: incoming,
        conflictVersion: version,
      });
  }, [disk.data, active?.path, active?.dirty]);

  const open = async (path: string, reference?: FileReference) => {
    const capture = { ...scope };
    let resolvedPath = path;
    setOpenError(null);
    setDiff(false);
    if (!local.files[path]) {
      try {
        const data = await api(scoped(capture, "files/read", { path }));
        resolvedPath = data.path || path;
        qc.setQueryData(
          ["file-content", capture.companyId, capture.agentId, resolvedPath],
          data,
        );
        const existing =
          useLocal.getState().scopes[scopeKey(capture)]?.files[resolvedPath];
        if (!existing)
          file(capture, resolvedPath, {
            original: String(data.content ?? ""),
            content: String(data.content ?? ""),
            version: data.version,
            dirty: false,
          });
      } catch (failure) {
        if (scopeKey(scopeRef.current) === scopeKey(capture))
          setOpenError(failure);
        return;
      }
    }
    patch(capture, { activeFile: resolvedPath });
    if (
      reference?.startLine &&
      scopeKey(scopeRef.current) === scopeKey(capture)
    ) {
      setTimeout(() => {
        const editor = editorRef.current;
        editor?.setSelection({
          startLineNumber: reference.startLine!,
          endLineNumber: reference.endLine || reference.startLine!,
          startColumn: 1,
          endColumn: 999,
        });
        editor?.revealLineInCenter(reference.startLine!);
      }, 180);
    }
  };

  useEffect(() => {
    if (openReference) void open(openReference.path, openReference);
  }, [
    openReference?.path,
    openReference?.startLine,
    scope.companyId,
    scope.agentId,
  ]);

  const save = useMutation({
    mutationFn: (capture: {
      scope: Scope;
      path: string;
      content: string;
      version?: string | number;
    }) =>
      post(scoped(capture.scope, "files/save"), {
        companyId: capture.scope.companyId,
        path: capture.path,
        content: capture.content,
        expectedVersion: capture.version,
      }),
    onMutate: async (capture) => {
      await qc.cancelQueries({
        queryKey: [
          "file-content",
          capture.scope.companyId,
          capture.scope.agentId,
          capture.path,
        ],
      });
    },
    onSuccess: (data, capture) => {
      qc.setQueryData(
        ["file-content", capture.scope.companyId, capture.scope.agentId, capture.path],
        { ...data, content: capture.content },
      );
      const current =
        useLocal.getState().scopes[scopeKey(capture.scope)]?.files[capture.path];
      file(capture.scope, capture.path, {
        original: capture.content,
        version: data.version,
        dirty: current?.content !== capture.content,
        diskConflict: undefined,
      });
      qc.invalidateQueries({
        queryKey: ["files", capture.scope.companyId, capture.scope.agentId],
      });
      qc.invalidateQueries({
        queryKey: [
          "file-content",
          capture.scope.companyId,
          capture.scope.agentId,
          capture.path,
        ],
      });
      qc.invalidateQueries({
        queryKey: [
          "file-diff",
          capture.scope.companyId,
          capture.scope.agentId,
          capture.path,
        ],
      });
    },
    onError: async (error, capture) => {
      if (
        error instanceof ApiError &&
        (error.code === "version_conflict" || error.code === "409")
      ) {
        try {
          const data = await api(
            scoped(capture.scope, "files/read", { path: capture.path }),
          );
          file(capture.scope, capture.path, {
            diskConflict: data.content,
            conflictVersion: data.version,
          });
        } catch {
          // 读取磁盘版本失败时保留原有冲突提示。
        }
      }
    },
  });
  const commit = useMutation({
    mutationFn: () =>
      post(scoped(scope, "files/commit"), {
        companyId: scope.companyId,
        message: commitMessage,
      }),
    onSuccess: () => {
      setCommitOpen(false);
      setCommitMessage("");
      qc.invalidateQueries({
        queryKey: ["file-changes", scope.companyId, scope.agentId],
      });
      qc.invalidateQueries({
        queryKey: ["file-diff", scope.companyId, scope.agentId],
      });
    },
  });
  const create = useMutation({
    mutationFn: (capture: { scope: Scope; path: string; content: string }) =>
      post(scoped(capture.scope, "files/save"), {
        companyId: capture.scope.companyId,
        path: capture.path,
        content: capture.content,
        expectedVersion: null,
      }),
    onSuccess: (data, capture) => {
      const path = data.path || capture.path;
      qc.setQueryData(
        ["file-content", capture.scope.companyId, capture.scope.agentId, path],
        data,
      );
      file(capture.scope, path, {
        original: capture.content,
        content: capture.content,
        dirty: false,
        version: data.version,
      });
      patch(capture.scope, { activeFile: path });
      setCreateOpen(false);
      setNewPath("");
      setNewContent("");
      qc.invalidateQueries({
        queryKey: ["files", capture.scope.companyId, capture.scope.agentId],
      });
    },
  });

  const closeFile = (path: string) => {
    const buffer = local.files[path];
    if (
      buffer.dirty &&
      !window.confirm("此文件有未保存的修改。关闭标签将丢弃该缓冲区，确定吗？")
    )
      return;
    const files = { ...local.files };
    delete files[path];
    patch(scope, {
      files,
      activeFile:
        local.activeFile === path ? Object.keys(files).at(-1) : local.activeFile,
    });
  };
  const mount: OnMount = (editor) => {
    editorRef.current = editor;
  };
  const reference = () => {
    const selection = editorRef.current?.getSelection();
    const model = editorRef.current?.getModel();
    if (!active || !selection || !model) return;
    onReference({
      path: active.path,
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber,
      content: model.getValueInRange(selection),
      version: active.version,
    });
  };
  const roots = Array.isArray(root.data?.roots) ? root.data.roots : [];
  const location = String(root.data?.path ?? browse);
  const parentOf = (value: string) => {
    const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    if (index < 0) return "";
    if (index === 0) return "/";
    return value.slice(0, index);
  };

  return (
    <div className="files-view">
      <div className="files-toolbar">
        <div className="segmented segmented-sm">
          <button
            className={mode === "all" ? "active" : ""}
            onClick={() => setMode("all")}
          >
            全部文件
          </button>
          <button
            className={mode === "changes" ? "active" : ""}
            onClick={() => setMode("changes")}
          >
            Git 变更
          </button>
        </div>
        <div className="inline-actions">
          <IconButton label="新建文件" onClick={() => setCreateOpen(true)}>
            <FilePlus2 size={15} />
          </IconButton>
          <IconButton
            label="刷新文件"
            onClick={() =>
              qc.invalidateQueries({
                queryKey: ["files", scope.companyId, scope.agentId],
              })
            }
          >
            <RefreshCw size={14} />
          </IconButton>
          <IconButton
            label="提交 Agent 文件 Git 变更"
            onClick={() => setCommitOpen(true)}
          >
            <GitCommitHorizontal size={16} />
          </IconButton>
        </div>
      </div>

      <form
        className="file-search"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query);
        }}
      >
        <Search size={14} />
        <input
          aria-label="搜索文件内容"
          placeholder="搜索当前 Workspace…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!event.target.value) setSearch("");
          }}
        />
        {search && (
          <button
            type="button"
            aria-label="清除搜索"
            onClick={() => {
              setQuery("");
              setSearch("");
            }}
          >
            <X size={12} />
          </button>
        )}
      </form>

      <div className="file-workspace">
        <aside className="file-tree" aria-label="文件目录">
          {search ? (
            <>
              <p className="tree-label">搜索结果</p>
              {searches.isLoading ? (
                <Loading />
              ) : (
                list<any>(searches.data, "results").map((match, index) => (
                  <button
                    className="search-result"
                    key={index}
                    disabled={!match.path}
                    onClick={() =>
                      match.path &&
                      open(match.path, {
                        path: match.path,
                        startLine: match.line || match.lineNumber,
                      })
                    }
                  >
                    <strong>
                      {match.path}:{match.line || match.lineNumber}
                    </strong>
                    <span>{match.text || match.content}</span>
                  </button>
                ))
              )}
              <ErrorBox error={searches.error} />
            </>
          ) : mode === "changes" ? (
            <>
              <p className="tree-label">工作区 vs HEAD</p>
              {changes.isLoading ? (
                <Loading />
              ) : (
                list<any>(changes.data, "changes").map((change, index) => (
                  <button
                    className="file-node"
                    key={index}
                    onClick={() => {
                      void open(change.path || change.file);
                      setDiff(true);
                    }}
                  >
                    <span className="change-marker">
                      {change.status || "M"}
                    </span>
                    <span>{change.path || change.file}</span>
                  </button>
                ))
              )}
              <ErrorBox error={changes.error} />
            </>
          ) : (
            <>
              <div className="file-location">
                <button
                  type="button"
                  title="上一级"
                  aria-label="上一级目录"
                  disabled={!browse}
                  onClick={() => setBrowse(parentOf(location || browse))}
                >
                  <ArrowUp size={13} />
                </button>
                <input
                  key={location}
                  aria-label="当前目录路径"
                  defaultValue={location}
                  placeholder="输入绝对路径后回车"
                  title={location}
                  spellCheck={false}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    setBrowse(event.currentTarget.value.trim());
                  }}
                />
                <button
                  type="button"
                  title="回到 Agent 活动目录"
                  aria-label="回到 Agent 活动目录"
                  onClick={() => setBrowse("")}
                >
                  <Home size={13} />
                </button>
              </div>
              <p className="tree-label" title={location}>
                {browse ? "浏览目录" : "Agent 活动目录"}
              </p>
              {root.isLoading ? (
                <Loading />
              ) : (
                list<FileEntry>(root.data, "entries").map((entry) => (
                  <TreeNode
                    key={entry.path}
                    entry={entry}
                    scope={scope}
                    depth={0}
                    active={local.activeFile}
                    onOpen={open}
                  />
                ))
              )}
              <ErrorBox error={root.error} />
              {roots.filter((item: any) => item.kind !== "agent").length >
                0 && <p className="tree-label">常用位置</p>}
              {roots
                .filter((item: any) => item.kind !== "agent")
                .map((item: any) => (
                  <TreeNode
                    key={item.path}
                    entry={{
                      path: item.path,
                      name: item.name || "目录",
                      type: "directory",
                    }}
                    scope={scope}
                    depth={0}
                    active={local.activeFile}
                    onOpen={open}
                  />
                ))}
            </>
          )}
        </aside>

        <div className="file-editor-area">
          <div className="file-tabs">
            {Object.values(local.files).map((buffer) => (
              <div
                className={`file-tab ${buffer.path === local.activeFile ? "active" : ""}`}
                key={buffer.path}
              >
                <button onClick={() => patch(scope, { activeFile: buffer.path })}>
                  {buffer.path.split("/").pop()}
                  {buffer.dirty && <span className="dirty-dot" />}
                </button>
                <button
                  onClick={() => closeFile(buffer.path)}
                  aria-label={`关闭 ${buffer.path}`}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
          <ErrorBox error={openError} />
          <FileEditor
            scope={scope}
            buffer={active}
            diff={diff}
            gitDiff={gitDiff.data}
            gitDiffError={gitDiff.error}
            saving={save.isPending}
            saveError={save.error}
            onToggleDiff={() => setDiff(!diff)}
            onReference={reference}
            onMount={mount}
            onSave={() =>
              save.mutate({
                scope: { ...scope },
                path: active!.path,
                content: active!.content,
                version: active!.version,
              })
            }
            onChange={(value) =>
              file(scope, active!.path, {
                content: value,
                dirty: value !== active!.original,
              })
            }
            onAdoptDisk={() =>
              file(scope, active!.path, {
                original: active!.diskConflict!,
                version: active!.conflictVersion,
                diskConflict: undefined,
                dirty: true,
              })
            }
            onUseDisk={() => {
              if (!window.confirm("确认丢弃当前缓冲区，使用磁盘内容？")) return;
              file(scope, active!.path, {
                content: active!.diskConflict!,
                original: active!.diskConflict!,
                version: active!.conflictVersion,
                diskConflict: undefined,
                dirty: false,
              });
            }}
          />
        </div>
      </div>

      <CommitSheet
        open={commitOpen}
        message={commitMessage}
        pending={commit.isPending}
        error={commit.error}
        onMessage={setCommitMessage}
        onClose={() => setCommitOpen(false)}
        onSubmit={() => commit.mutate()}
      />

      <CreateFileSheet
        open={createOpen}
        path={newPath}
        content={newContent}
        pending={create.isPending}
        error={create.error}
        onPath={setNewPath}
        onContent={setNewContent}
        onClose={() => setCreateOpen(false)}
        onSubmit={() => {
          const target = newPath.trim();
          const base = location.replace(/[\\/]+$/, "");
          const absolute = /^([\\/]|[A-Za-z]:[\\/])/.test(target);
          create.mutate({
            scope: { ...scope },
            path: absolute || !base ? target : `${base}/${target}`,
            content: newContent,
          });
        }}
      />
    </div>
  );
}
