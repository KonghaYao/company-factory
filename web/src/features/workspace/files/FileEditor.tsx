import Editor, { DiffEditor, loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import { File as FileIcon, GitCompareArrows, Quote, Save } from "lucide-react";
import type { FileBuffer, Scope } from "../../../lib/types";
import { scopeKey } from "../../../lib/types";
import { Button, EmptyState, ErrorBox, IconButton } from "../../../ui/primitives";

/**
 * Monaco 只在文件工作区加载。这里同时承担三个视图：
 * 普通编辑、Git Diff（只读）与磁盘冲突对比（只读）。
 */
loader.config({ monaco });
self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css") return new CssWorker();
    if (label === "html") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

function language(path: string) {
  const extension = path.split(".").pop();
  return (
    {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      json: "json",
      md: "markdown",
      css: "css",
      scss: "scss",
      html: "html",
      yml: "yaml",
      yaml: "yaml",
      sh: "shell",
      py: "python",
      go: "go",
      rs: "rust",
    }[extension || ""] || "plaintext"
  );
}

export function FileEditor({
  scope,
  buffer,
  diff,
  gitDiff,
  gitDiffError,
  saving,
  saveError,
  onToggleDiff,
  onReference,
  onSave,
  onChange,
  onMount,
  onUseDisk,
  onAdoptDisk,
}: {
  scope: Scope;
  buffer?: FileBuffer;
  diff: boolean;
  gitDiff?: { base?: string; original?: string };
  gitDiffError?: unknown;
  saving: boolean;
  saveError?: unknown;
  onToggleDiff: () => void;
  onReference: () => void;
  onSave: () => void;
  onChange: (value: string) => void;
  onMount: OnMount;
  onUseDisk: () => void;
  onAdoptDisk: () => void;
}) {
  if (!buffer) {
    return (
      <EmptyState
        icon={<FileIcon size={22} />}
        title="打开一个文件"
        description="文件树来自 Peri 默认 Workspace；配置、记忆、知识与执行资料都在这里。"
      />
    );
  }

  const conflict = buffer.diskConflict !== undefined;

  return (
    <>
      <div className="editor-toolbar">
        <span className="editor-path" title={buffer.path}>
          {buffer.path}
        </span>
        <div className="inline-actions">
          <IconButton
            label="Git Diff · HEAD 与当前缓冲区"
            className={diff ? "is-active" : ""}
            onClick={onToggleDiff}
          >
            <GitCompareArrows size={15} />
          </IconButton>
          <IconButton
            label="将选中代码引用到 Chat"
            onClick={onReference}
            disabled={diff}
          >
            <Quote size={15} />
          </IconButton>
          <Button
            variant="secondary"
            size="sm"
            data-testid="file-save"
            disabled={!buffer.dirty || saving || conflict}
            onClick={onSave}
          >
            <Save size={13} />
            保存
          </Button>
        </div>
      </div>

      <ErrorBox error={saveError} />

      {conflict && (
        <div className="file-conflict" data-testid="file-conflict">
          <strong>磁盘文件已变化 · 你的未保存内容已保留</strong>
          <p>
            下方比较左侧磁盘版本与右侧你的缓冲区。合并后采用新的版本依据，再保存。
          </p>
          <div className="inline-actions">
            <Button variant="secondary" size="sm" onClick={onAdoptDisk}>
              保留我的内容，采用新依据
            </Button>
            <Button variant="ghost" size="sm" onClick={onUseDisk}>
              使用磁盘内容
            </Button>
          </div>
        </div>
      )}

      {diff && (
        <div className="diff-base">
          比较依据：{gitDiff?.base || "HEAD"} → 当前缓冲区
          <ErrorBox error={gitDiffError} />
        </div>
      )}

      <div className="monaco-container">
        {conflict ? (
          <DiffEditor
            key={`conflict:${scopeKey(scope)}:${buffer.path}`}
            original={buffer.diskConflict}
            modified={buffer.content}
            language={language(buffer.path)}
            options={{
              readOnly: true,
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 12,
            }}
          />
        ) : diff ? (
          <DiffEditor
            key={`diff:${scopeKey(scope)}:${buffer.path}`}
            original={gitDiff?.original || ""}
            modified={buffer.content}
            language={language(buffer.path)}
            options={{
              readOnly: true,
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 12,
            }}
          />
        ) : (
          <Editor
            path={`${scopeKey(scope)}/${buffer.path}`}
            value={buffer.content}
            language={language(buffer.path)}
            onMount={onMount}
            onChange={(value) => onChange(value || "")}
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
        <span>{language(buffer.path)}</span>
        <span>
          {buffer.dirty ? "未保存" : "已保存到磁盘"} · 保存不等于 Git commit
        </span>
      </footer>
    </>
  );
}
