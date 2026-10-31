import { create } from "zustand";
import type { Scope, FileBuffer, FileReference } from "./types";
import { scopeKey } from "./types";
export type LocalScope = {
  draft: string;
  issueId?: string;
  tab: "run" | "tasks" | "files" | "messages";
  references: FileReference[];
  files: Record<string, FileBuffer>;
  activeFile?: string;
};
const empty = (): LocalScope => ({
  draft: "",
  tab: "run",
  references: [],
  files: {},
});
type State = {
  scopes: Record<string, LocalScope>;
  ensure: (scope: Scope) => void;
  patch: (scope: Scope, patch: Partial<LocalScope>) => void;
  file: (scope: Scope, path: string, patch: Partial<FileBuffer>) => void;
  clearSent: (scope: Scope, draft: string, refs: FileReference[]) => void;
};
export const useLocal = create<State>((set) => ({
  scopes: {},
  ensure: (scope) =>
    set((state) =>
      state.scopes[scopeKey(scope)]
        ? state
        : { scopes: { ...state.scopes, [scopeKey(scope)]: empty() } },
    ),
  patch: (scope, patch) =>
    set((state) => ({
      scopes: {
        ...state.scopes,
        [scopeKey(scope)]: {
          ...(state.scopes[scopeKey(scope)] || empty()),
          ...patch,
        },
      },
    })),
  file: (scope, path, patch) =>
    set((state) => {
      const local = state.scopes[scopeKey(scope)] || empty();
      return {
        scopes: {
          ...state.scopes,
          [scopeKey(scope)]: {
            ...local,
            files: {
              ...local.files,
              [path]: {
                ...(local.files[path] || {
                  path,
                  original: "",
                  content: "",
                  dirty: false,
                }),
                ...patch,
              },
            },
          },
        },
      };
    }),
  clearSent: (scope, draft, refs) =>
    set((state) => {
      const local = state.scopes[scopeKey(scope)] || empty();
      return {
        scopes: {
          ...state.scopes,
          [scopeKey(scope)]: {
            ...local,
            draft: local.draft === draft ? "" : local.draft,
            references: local.references === refs ? [] : local.references,
          },
        },
      };
    }),
}));
export const emptyLocal: LocalScope = empty();
