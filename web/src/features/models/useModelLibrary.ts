import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { ModelLibraryView } from "../../lib/types";

/**
 * 模型库只读投影。仅在 Sheet / 模型 tab 打开时启用，
 * 不加入 App 级高频轮询；同一 queryKey 的并发挂载由 React Query 去重。
 */
export function useModelLibrary(enabled = true) {
  return useQuery<ModelLibraryView>({
    queryKey: ["model-library"],
    queryFn: () => api<ModelLibraryView>("/api/model-library"),
    enabled,
  });
}
