import { RefreshCw } from "lucide-react";
import {
  libraryStatusHint,
  libraryStatusLabel,
  libraryStatusTone,
  libraryTierRows,
  modelErrorLabel,
  shortRevision,
} from "../../lib/model";
import { Badge, Button, ErrorBox, Loading } from "../../ui/primitives";
import type { ModelLibraryProviderView } from "../../lib/types";
import { ModelTierTable } from "./ModelTierTable";
import { useModelLibrary } from "./useModelLibrary";

function ProviderCard({ provider }: { provider: ModelLibraryProviderView }) {
  const ready =
    provider.enabled &&
    provider.endpointConfigured &&
    provider.credentialConfigured;
  return (
    <div className="model-library-provider">
      <div className="model-library-provider-head">
        <strong>{provider.id}</strong>
        <Badge tone={ready ? "positive" : "warning"}>
          {ready ? "可用" : "未就绪"}
        </Badge>
        {!provider.enabled && <Badge tone="neutral">已禁用</Badge>}
      </div>
      <span className="model-provider-meta">
        {provider.type}
        {provider.label ? ` · ${provider.label}` : ""}
      </span>
      <small>baseUrlEnv · {provider.baseUrlEnv}</small>
      <small>apiKeyEnv · {provider.apiKeyEnv}</small>
      <small>
        endpoint {provider.endpointConfigured ? "已配置" : "未配置"} · credential{" "}
        {provider.credentialConfigured ? "已配置" : "未配置"}
      </small>
    </div>
  );
}

/** 全局模型库只读视图：结构、env 变量名与就绪布尔，不包含任何值。 */
export function ModelLibraryContent() {
  const query = useModelLibrary(true);
  if (query.isLoading) return <Loading label="正在读取模型库…" />;
  if (query.error) return <ErrorBox error={query.error} />;
  const library = query.data;
  if (!library)
    return <p className="model-muted">模型库暂无数据。</p>;
  return (
    <div className="model-library-content" data-testid="model-library-content">
      <div className="model-library-top">
        <span data-testid="model-library-status">
          <Badge tone={libraryStatusTone(library.status)}>
            {libraryStatusLabel(library.status)}
          </Badge>
        </span>
        <span
          className="model-library-path"
          data-testid="model-library-path"
          title={library.path}
        >
          {library.path}
        </span>
        <Button
          variant="secondary"
          size="sm"
          data-testid="model-library-refresh"
          disabled={query.isFetching}
          onClick={() => query.refetch()}
        >
          <RefreshCw
            size={13}
            className={query.isFetching ? "spin" : undefined}
          />
          {query.isFetching ? "刷新中…" : "刷新"}
        </Button>
      </div>

      <dl className="model-library-facts">
        <div>
          <dt>默认 profile</dt>
          <dd>{library.activeProfile ?? "未设置"}</dd>
        </div>
        <div>
          <dt>revision</dt>
          <dd>{library.revision ? shortRevision(library.revision) : "—"}</dd>
        </div>
        <div>
          <dt>version</dt>
          <dd>{library.version ?? "—"}</dd>
        </div>
      </dl>

      {library.status !== "ok" && (
        <div className="notice notice-warn" data-testid="model-library-error">
          模型库当前不可用：
          {modelErrorLabel(library.error)}。{libraryStatusHint(library.status)}
        </div>
      )}
      {library.issues.length > 0 && (
        <ul className="model-library-issues" aria-label="模型库问题">
          {library.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <section className="model-library-section">
        <h3>Profiles</h3>
        {library.profiles.length ? (
          library.profiles.map((profile) => (
            <article
              className="model-library-profile"
              key={profile.id}
              data-testid={`model-library-profile-${profile.id}`}
            >
              <header className="model-library-profile-head">
                <strong>{profile.id}</strong>
                {library.activeProfile === profile.id && (
                  <Badge tone="active">默认</Badge>
                )}
                {!profile.enabled && <Badge tone="warning">已禁用</Badge>}
                <span>activeAlias · {profile.activeAlias}</span>
                {profile.label && (
                  <span className="model-profile-label">{profile.label}</span>
                )}
              </header>
              <ModelTierTable
                rows={libraryTierRows(profile)}
                origin="library"
                label={`profile ${profile.id} 四档`}
              />
            </article>
          ))
        ) : (
          <p className="model-muted">模型库没有 profile。</p>
        )}
      </section>

      <section className="model-library-section">
        <h3>Providers</h3>
        {library.providers.length ? (
          library.providers.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} />
          ))
        ) : (
          <p className="model-muted">模型库没有 provider。</p>
        )}
      </section>

      <p className="model-library-hint">
        {libraryStatusHint(library.status)}{" "}
        本页只读；密钥与 endpoint 值始终只存在于宿主进程环境。
      </p>
    </div>
  );
}
