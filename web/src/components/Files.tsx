import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Editor, { DiffEditor, loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import {
  Folder,
  FolderOpen,
  File,
  ChevronRight,
  ChevronDown,
  Search,
  Save,
  GitCompareArrows,
  GitCommitHorizontal,
  X,
  Quote,
  RefreshCw,
  FilePlus2,
} from "lucide-react";
import type { Scope, FileEntry, FileReference } from "../lib/types";
import { scopeKey } from "../lib/types";
import { useLocal, emptyLocal } from "../lib/state";
import { api, scoped, post, list, ApiError } from "../lib/api";
import { ErrorBox, Loading, Empty, Modal, Field } from "./Common";
(self as any).MonacoEnvironment = {
  getWorker: (_moduleId: string, label: string) =>
    label === "json"
      ? new JsonWorker()
      : ["css", "scss", "less"].includes(label)
        ? new CssWorker()
        : ["html", "handlebars", "razor"].includes(label)
          ? new HtmlWorker()
          : ["typescript", "javascript"].includes(label)
            ? new TsWorker()
            : new EditorWorker(),
};
loader.config({ monaco });
function language(path: string) {
  const e = path.split(".").pop();
  return (
    (
      {
        md: "markdown",
        json: "json",
        yaml: "yaml",
        yml: "yaml",
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        css: "css",
        html: "html",
        py: "python",
        sh: "shell",
        env: "shell",
      } as Record<string, string>
    )[e || ""] || "plaintext"
  );
}
export function Files({
  scope,
  openReference,
  onReference,
}: {
  scope: Scope;
  openReference?: FileReference;
  onReference: (ref: FileReference) => void;
}) {
  const qc = useQueryClient();
  const local = useLocal((s) => s.scopes[scopeKey(scope)] || emptyLocal);
  const file = useLocal((s) => s.file);
  const patch = useLocal((s) => s.patch);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
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
  const root = useQuery({
    queryKey: ["files", scope.companyId, scope.agentId, ""],
    queryFn: () => api(scoped(scope, "files", { path: "" })),
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
  useEffect(() => {
    if (!active || !disk.data) return;
    const incoming = String(disk.data.content ?? "");
    const v = disk.data.version;
    if (incoming === active.original) return;
    if (active.dirty) {
      if (incoming !== active.content)
        file(scope, active.path, {
          diskConflict: incoming,
          conflictVersion: v,
        });
    } else
      file(scope, active.path, {
        original: incoming,
        content: incoming,
        version: v,
        dirty: false,
        diskConflict: undefined,
      });
  }, [disk.data, active?.path, active?.dirty]);
  const open = async (path: string, ref?: FileReference) => {
    const capture = { ...scope };
    let resolvedPath = path;
    setOpenError(null);
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
      } catch (e) {
        if (scopeKey(scopeRef.current) === scopeKey(capture)) setOpenError(e);
        return;
      }
    }
    patch(capture, { activeFile: resolvedPath });
    if (ref?.startLine && scopeKey(scopeRef.current) === scopeKey(capture)) {
      setTimeout(() => {
        const editor = editorRef.current;
        editor?.setSelection({
          startLineNumber: ref.startLine!,
          endLineNumber: ref.endLine || ref.startLine!,
          startColumn: 1,
          endColumn: 999,
        });
        editor?.revealLineInCenter(ref.startLine!);
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
    onSuccess: (data, c) => {
      qc.setQueryData(
        ["file-content", c.scope.companyId, c.scope.agentId, c.path],
        { ...data, content: c.content },
      );
      const current =
        useLocal.getState().scopes[scopeKey(c.scope)]?.files[c.path];
      file(c.scope, c.path, {
        original: c.content,
        version: data.version,
        dirty: current?.content !== c.content,
        diskConflict: undefined,
      });
      qc.invalidateQueries({
        queryKey: ["files", c.scope.companyId, c.scope.agentId],
      });
      qc.invalidateQueries({
        queryKey: ["file-content", c.scope.companyId, c.scope.agentId, c.path],
      });
      qc.invalidateQueries({
        queryKey: ["file-diff", c.scope.companyId, c.scope.agentId, c.path],
      });
    },
    onError: async (error, c) => {
      if (
        error instanceof ApiError &&
        (error.code === "version_conflict" || error.code === "409")
      ) {
        try {
          const data = await api(
            scoped(c.scope, "files/read", { path: c.path }),
          );
          file(c.scope, c.path, {
            diskConflict: data.content,
            conflictVersion: data.version,
          });
        } catch {}
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
    onSuccess: (data, c) => {
      const path = data.path || c.path;
      qc.setQueryData(
        ["file-content", c.scope.companyId, c.scope.agentId, path],
        data,
      );
      file(c.scope, path, {
        original: c.content,
        content: c.content,
        dirty: false,
        version: data.version,
      });
      patch(c.scope, { activeFile: path });
      setCreateOpen(false);
      setNewPath("");
      setNewContent("");
      qc.invalidateQueries({
        queryKey: ["files", c.scope.companyId, c.scope.agentId],
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
        local.activeFile === path
          ? Object.keys(files).at(-1)
          : local.activeFile,
    });
  };
  const mount: OnMount = (editor) => {
    editorRef.current = editor;
  };
  const reference = () => {
    const s = editorRef.current?.getSelection();
    const model = editorRef.current?.getModel();
    if (!active || !s || !model) return;
    onReference({
      path: active.path,
      startLine: s.startLineNumber,
      endLine: s.endLineNumber,
      content: model.getValueInRange(s),
      version: active.version,
    });
  };
  const roots = Array.isArray(root.data?.roots) ? root.data.roots : [];
  return (
    <div className="files-panel">
      <div className="files-toolbar">
        <div className="segmented compact">
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
          <button
            className="icon-button"
            title="新建文件"
            onClick={() => setCreateOpen(true)}
          >
            <FilePlus2 size={15} />
          </button>
          <button
            className="icon-button"
            title="刷新文件"
            onClick={() =>
              qc.invalidateQueries({
                queryKey: ["files", scope.companyId, scope.agentId],
              })
            }
          >
            <RefreshCw size={14} />
          </button>
          <button
            className="icon-button"
            title="提交 Agent 文件 Git 变更"
            onClick={() => setCommitOpen(true)}
          >
            <GitCommitHorizontal size={16} />
          </button>
        </div>
      </div>
      <form
        className="file-search"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query);
        }}
      >
        <Search size={14} />
        <input
          aria-label="搜索文件内容"
          placeholder="搜索当前 Workspace…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value) setSearch("");
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
                list<any>(searches.data, "results").map((m, i) => (
                  <button
                    className="search-result"
                    key={i}
                    disabled={!m.path}
                    onClick={() =>
                      m.path &&
                      open(m.path, {
                        path: m.path,
                        startLine: m.line || m.lineNumber,
                      })
                    }
                  >
                    <strong>
                      {m.path}:{m.line || m.lineNumber}
                    </strong>
                    <span>{m.text || m.content}</span>
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
                list<any>(changes.data, "changes").map((c, i) => (
                  <button
                    className="file-node"
                    key={i}
                    onClick={() => {
                      void open(c.path || c.file);
                      setDiff(true);
                    }}
                  >
                    <span className="change-marker">{c.status || "M"}</span>
                    <span>{c.path || c.file}</span>
                  </button>
                ))
              )}
              <ErrorBox error={changes.error} />
            </>
          ) : (
            <>
              <p className="tree-label">Agent 活动目录</p>
              {root.isLoading ? (
                <Loading />
              ) : (
                list<FileEntry>(root.data, "entries").map((e) => (
                  <TreeNode
                    key={e.path}
                    entry={e}
                    scope={scope}
                    depth={0}
                    active={local.activeFile}
                    onOpen={open}
                  />
                ))
              )}
              <ErrorBox error={root.error} />
              {roots
                .filter(
                  (r: any) =>
                    r.kind === "knowledge" ||
                    r.kind === "project" ||
                    r.name?.includes("knowledge") ||
                    r.name?.includes("知识"),
                )
                .map((r: any) => (
                  <div key={r.path}>
                    <p className="tree-label">
                      {r.kind === "project" ? "项目仓库" : "共享知识"}
                    </p>
                    <TreeNode
                      entry={{
                        path: r.path,
                        name: r.name || "knowledgebase",
                        type: "directory",
                      }}
                      scope={scope}
                      depth={0}
                      active={local.activeFile}
                      onOpen={open}
                    />
                  </div>
                ))}
            </>
          )}
        </aside>
        <div className="file-editor-area">
          <div className="file-tabs">
            {Object.values(local.files).map((f) => (
              <div
                className={`file-tab ${f.path === local.activeFile ? "active" : ""}`}
                key={f.path}
              >
                <button onClick={() => patch(scope, { activeFile: f.path })}>
                  {f.path.split("/").pop()}
                  {f.dirty && <span className="dirty-dot" />}
                </button>
                <button
                  onClick={() => closeFile(f.path)}
                  aria-label={`关闭 ${f.path}`}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
          <ErrorBox error={openError || save.error} />
          {active ? (
            <>
              <div className="editor-toolbar">
                <span title={active.path}>{active.path}</span>
                <div>
                  <button
                    className={`icon-button ${diff ? "active" : ""}`}
                    title="Git Diff · HEAD 与当前缓冲区"
                    onClick={() => setDiff(!diff)}
                  >
                    <GitCompareArrows size={15} />
                  </button>
                  <button
                    className="icon-button"
                    title="将选中代码引用到 Chat"
                    onClick={reference}
                    disabled={diff}
                  >
                    <Quote size={15} />
                  </button>
                  <button
                    data-testid="file-save"
                    className="secondary small"
                    disabled={
                      !active.dirty ||
                      save.isPending ||
                      active.diskConflict !== undefined
                    }
                    onClick={() =>
                      save.mutate({
                        scope: { ...scope },
                        path: active.path,
                        content: active.content,
                        version: active.version,
                      })
                    }
                  >
                    <Save size={13} />
                    保存
                  </button>
                </div>
              </div>
              {active.diskConflict !== undefined && (
                <div className="file-conflict" data-testid="file-conflict">
                  <strong>磁盘文件已变化 · 你的未保存内容已保留</strong>
                  <p>
                    下方比较左侧磁盘版本与右侧你的缓冲区。合并后采用新的版本依据，再保存。
                  </p>
                  <div className="inline-actions">
                    <button
                      className="secondary small"
                      onClick={() =>
                        file(scope, active.path, {
                          original: active.diskConflict!,
                          version: active.conflictVersion,
                          diskConflict: undefined,
                          dirty: true,
                        })
                      }
                    >
                      保留我的内容，采用新依据
                    </button>
                    <button
                      className="quiet"
                      onClick={() => {
                        if (
                          window.confirm("确认丢弃当前缓冲区，使用磁盘内容？")
                        )
                          file(scope, active.path, {
                            content: active.diskConflict!,
                            original: active.diskConflict!,
                            version: active.conflictVersion,
                            diskConflict: undefined,
                            dirty: false,
                          });
                      }}
                    >
                      使用磁盘内容
                    </button>
                  </div>
                </div>
              )}
              {diff && (
                <div className="diff-base">
                  比较依据：{gitDiff.data?.base || "HEAD"} → 当前缓冲区
                  <ErrorBox error={gitDiff.error} />
                </div>
              )}
              <div className="monaco-container">
                {active.diskConflict !== undefined ? (
                  <DiffEditor
                    key={`conflict:${scopeKey(scope)}:${active.path}`}
                    original={active.diskConflict}
                    modified={active.content}
                    language={language(active.path)}
                    options={{
                      readOnly: true,
                      automaticLayout: true,
                      minimap: { enabled: false },
                      fontSize: 12,
                    }}
                  />
                ) : diff ? (
                  <DiffEditor
                    key={`diff:${scopeKey(scope)}:${active.path}`}
                    original={gitDiff.data?.original || ""}
                    modified={active.content}
                    language={language(active.path)}
                    options={{
                      readOnly: true,
                      automaticLayout: true,
                      minimap: { enabled: false },
                      fontSize: 12,
                    }}
                  />
                ) : (
                  <Editor
                    path={`${scopeKey(scope)}/${active.path}`}
                    value={active.content}
                    language={language(active.path)}
                    onMount={mount}
                    onChange={(value) =>
                      file(scope, active.path, {
                        content: value || "",
                        dirty: value !== active.original,
                      })
                    }
                    options={{
                      automaticLayout: true,
                      minimap: { enabled: false },
                      fontSize: 12,
                      tabSize: 2,
                      wordWrap: "on",
                      padding: { top: 12 },
                      scrollBeyondLastLine: false,
                    }}
                  />
                )}
              </div>
              <footer className="editor-footer">
                <span>{language(active.path)}</span>
                <span>
                  {active.dirty ? "未保存" : "已保存到磁盘"} · 保存不等于 Git
                  commit
                </span>
              </footer>
            </>
          ) : (
            <Empty icon={<File size={27} />} title="打开一个文件">
              文件树来自 Peri 默认 Workspace。
              <br />
              配置、记忆、知识和执行资料均在这里。
            </Empty>
          )}
        </div>
      </div>
      {commitOpen && (
        <Modal title="提交 Agent 文件变更" onClose={() => setCommitOpen(false)}>
          <p className="modal-intro">
            将当前 Agent 仓库中的变更提交到本地
            Git。项目代码仍在各自项目仓库管理。
          </p>
          <Field label="提交说明">
            <input
              autoFocus
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="记录这次变更的目的"
            />
          </Field>
          <ErrorBox error={commit.error} />
          <div className="modal-actions">
            <button className="secondary" onClick={() => setCommitOpen(false)}>
              取消
            </button>
            <button
              className="primary"
              disabled={!commitMessage.trim() || commit.isPending}
              onClick={() => commit.mutate()}
            >
              提交到 Git
            </button>
          </div>
        </Modal>
      )}
      {createOpen && (
        <Modal title="新建文件" onClose={() => setCreateOpen(false)}>
          <Field label="相对活动目录的路径">
            <input
              autoFocus
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="notes/ideas.md"
            />
          </Field>
          <Field label="文件内容">
            <textarea
              rows={7}
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
            />
          </Field>
          <ErrorBox error={create.error} />
          <div className="modal-actions">
            <button className="secondary" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button
              className="primary"
              disabled={!newPath.trim() || create.isPending}
              onClick={() =>
                create.mutate({
                  scope: { ...scope },
                  path: newPath,
                  content: newContent,
                })
              }
            >
              创建文件
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function TreeNode({
  scope,
  entry: e,
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
  const dir = e.type === "directory" || e.type === "dir" || e.isDirectory;
  const q = useQuery({
    queryKey: ["files", scope.companyId, scope.agentId, e.path],
    queryFn: () => api(scoped(scope, "files", { path: e.path })),
    enabled: !!dir && expanded && !e.children,
  });
  return (
    <>
      <button
        className={`file-node ${active === e.path ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (dir ? setExpanded(!expanded) : onOpen(e.path))}
        title={e.path}
      >
        {dir ? (
          expanded ? (
            <ChevronDown size={11} />
          ) : (
            <ChevronRight size={11} />
          )
        ) : (
          <span style={{ width: 11 }} />
        )}
        {dir ? (
          expanded ? (
            <FolderOpen size={14} />
          ) : (
            <Folder size={14} />
          )
        ) : (
          <File size={13} />
        )}
        <span>{e.name || e.path.split("/").pop()}</span>
      </button>
      {dir && expanded && (
        <>
          {q.isLoading && <Loading />}
          <ErrorBox error={q.error} />
          {(e.children || list<FileEntry>(q.data, "entries")).map((c) => (
            <TreeNode
              key={c.path}
              scope={scope}
              entry={c}
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
