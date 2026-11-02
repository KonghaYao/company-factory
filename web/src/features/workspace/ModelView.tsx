import { useQuery } from "@tanstack/react-query";
import { Cpu, Library } from "lucide-react";
import { api, scoped } from "../../lib/api";
import {
  appliedTierRows,
  libraryProfile,
  libraryStatusLabel,
  libraryStatusTone,
  libraryTierRows,
  modelReason,
  modelRevisionMismatch,
  shortRevision,
} from "../../lib/model";
import type { Runtime, Scope } from "../../lib/types";
import { Badge, Button, ErrorBox, Loading } from "../../ui/primitives";
import { ModelChain } from "../models/ModelChain";
import { ModelTierTable } from "../models/ModelTierTable";
import { useModelLibrary } from "../models/useModelLibrary";

/**
 * 右侧「模型」tab：当前 Agent 的已应用链路、保存草稿与四档表。
 * 只读；模型库修改仍通过文件与显式重启生效。
 */
export function ModelView({
  scope,
  runtime,
  onOpenLibrary,
}: {
  scope: Scope;
  runtime?: Runtime;
  onOpenLibrary: () => void;
}) {
  const library = useModelLibrary(true);
  const configuration = useQuery({
    queryKey: ["configuration", scope.companyId, scope.agentId],
    queryFn: () => api(scoped(scope, "configuration")),
  });
  const saved = configuration.data?.saved ?? {};
  const savedProfile =
    typeof saved.modelProfile === "string" ? saved.modelProfile : "";
  const savedAlias =
    typeof saved.modelAlias === "string" ? saved.modelAlias : "";
  const appliedRows = appliedTierRows(runtime);
  const currentRevision = library.data?.revision ?? null;
  const appliedRevision = runtime?.modelLibraryRevision ?? null;
  const revisionMismatch = modelRevisionMismatch(
    currentRevision,
    appliedRevision,
  );
  const pendingRestart = Boolean(
    runtime?.pendingRestart || configuration.data?.pendingRestart,
  );
  const effectiveProfile = savedProfile || library.data?.activeProfile || "";
  const currentLibraryProfile = libraryProfile(
    library.data,
    effectiveProfile,
  );

  return (
    <div className="panel-scroll model-view" data-testid="model-view">
      <section className="model-view-head">
        <div className="model-view-chain">
          <span className="panel-kicker">当前 Agent 链路</span>
          <ModelChain
            profile={runtime?.modelProfile}
            provider={runtime?.modelProvider}
            model={runtime?.model}
            alias={runtime?.modelAlias}
            empty={runtime?.configured === false ? "模型尚未配置" : "未配置"}
          />
        </div>
        <Badge tone={runtime?.configured === false ? "warning" : "positive"}>
          {runtime?.configured === false ? "未配置" : "已配置"}
        </Badge>
      </section>

      <dl className="model-view-facts">
        <div>
          <dt>已保存 profile</dt>
          <dd>
            {savedProfile ||
              `继承默认${library.data?.activeProfile ? `（${library.data.activeProfile}）` : ""}`}
          </dd>
        </div>
        <div>
          <dt>已保存 alias</dt>
          <dd>{savedAlias || "继承 profile"}</dd>
        </div>
        <div>
          <dt>已应用 revision</dt>
          <dd>
            {appliedRevision ? shortRevision(appliedRevision) : "—"}
          </dd>
        </div>
      </dl>

      {runtime?.configured === false && (
        <div className="notice notice-warn">
          模型尚未配置：{modelReason(runtime.modelError, runtime.modelMissing)}。
          修改模型库后需重启 Agent。
        </div>
      )}
      {revisionMismatch && (
        <div className="notice notice-warn">
          模型库已更新（{shortRevision(currentRevision!)} ≠ 已应用{" "}
          {shortRevision(appliedRevision!)}）；重启 Agent 后生效。
        </div>
      )}
      {runtime?.modelTierNotice && (
        <div className="notice notice-warn">{runtime.modelTierNotice}。</div>
      )}
      {pendingRestart && (
        <div className="notice notice-warn">有尚未应用的配置，重启后生效。</div>
      )}

      <section className="panel-section">
        <header className="section-head">
          <h3>已应用四档</h3>
          <span className="model-tier-caption">已应用快照</span>
        </header>
        {appliedRows ? (
          <ModelTierTable rows={appliedRows} origin="applied" />
        ) : currentLibraryProfile ? (
          <>
            <p className="model-muted">
              当前快照没有四档明细，以下来自模型库文件，尚未应用到该 Agent。
            </p>
            <ModelTierTable
              rows={libraryTierRows(currentLibraryProfile)}
              origin="library"
              label={`profile ${currentLibraryProfile.id} 四档（模型库文件）`}
            />
          </>
        ) : (
          <p className="model-muted">当前 Agent 没有可显示的四档明细。</p>
        )}
      </section>

      <section className="panel-section">
        <header className="section-head">
          <h3>模型库</h3>
          <Button
            variant="secondary"
            size="sm"
            data-testid="open-global-model-library"
            onClick={onOpenLibrary}
          >
            <Library size={13} />
            查看全局模型库
          </Button>
        </header>
        {library.isLoading ? (
          <Loading label="正在读取模型库…" />
        ) : library.error ? (
          <ErrorBox error={library.error} />
        ) : library.data ? (
          <div className="model-library-summary">
            <div className="model-library-summary-head">
              <Badge tone={libraryStatusTone(library.data.status)}>
                {libraryStatusLabel(library.data.status)}
              </Badge>
              <span>默认 · {library.data.activeProfile ?? "未设置"}</span>
              <span>
                revision ·{" "}
                {library.data.revision
                  ? shortRevision(library.data.revision)
                  : "—"}
              </span>
            </div>
            <span className="model-library-path" title={library.data.path}>
              {library.data.path}
            </span>
            <small>
              <Cpu size={11} /> 只读；密钥与 endpoint 值不会显示。
            </small>
          </div>
        ) : null}
      </section>
    </div>
  );
}
