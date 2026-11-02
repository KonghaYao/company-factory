import type { ModelLibraryView, ModelTier } from "../../lib/types";
import { MODEL_TIERS, tierLabel } from "../../lib/model";
import { Field } from "../../ui/primitives";

/**
 * per-Agent profile / alias 选择器。
 * 只产生配置草稿变更，由 AgentSettings 的 JSON 编辑器统一保存；
 * 从不写回模型库，也不触发重启。
 */
export function ModelProfilePicker({
  profile,
  alias,
  library,
  onChange,
}: {
  /** 已保存或草稿中的 profile；空字符串表示继承模型库默认。 */
  profile: string;
  /** 已保存或草稿中的 alias；空字符串表示继承 profile。 */
  alias: string;
  library?: ModelLibraryView | null;
  onChange: (patch: { modelProfile?: string; modelAlias?: string }) => void;
}) {
  const profiles = library?.profiles ?? [];
  const selected = profiles.find((item) => item.id === profile);
  const inheritedAlias: ModelTier = selected?.activeAlias ?? "sonnet";
  const knownAlias = MODEL_TIERS.includes(alias as ModelTier);
  return (
    <div className="model-profile-picker">
      <Field
        label="模型 profile"
        hint="留空继承模型库默认 profile；只改草稿，保存并重启后生效。"
      >
        <select
          value={profile}
          data-testid="model-profile-select"
          onChange={(event) =>
            onChange({ modelProfile: event.target.value })
          }
        >
          <option value="">
            继承模型库默认
            {library?.activeProfile ? `（${library.activeProfile}）` : ""}
          </option>
          {profile && !selected && (
            <option value={profile}>{profile}（库中不存在）</option>
          )}
          {profiles.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id}
              {item.label ? ` · ${item.label}` : ""}
              {item.enabled ? "" : "（已禁用）"}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="活动档位 alias"
        hint="留空继承 profile 的 activeAlias；只改草稿，保存并重启后生效。"
      >
        <select
          value={alias}
          data-testid="model-alias-select"
          onChange={(event) => onChange({ modelAlias: event.target.value })}
        >
          <option value="">继承 profile（{inheritedAlias}）</option>
          {alias && !knownAlias && (
            <option value={alias}>{alias}（非法档位）</option>
          )}
          {MODEL_TIERS.map((tier) => (
            <option key={tier} value={tier}>
              {tierLabel(tier)} · {tier}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}
