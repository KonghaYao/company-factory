"use client";

import { useEffect, useRef, useState } from "react";

export type UseCopyToClipboardOptions = {
  copiedDuration?: number;
};

/**
 * `navigator.clipboard` is secure-context only, so it is unavailable on plain
 * HTTP LAN addresses. The selection-based command still works there and runs
 * inside the same user gesture.
 */
const copyWithSelection = (value: string): boolean => {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  const selection = document.getSelection();
  const previous =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  if (selection && previous) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return copied;
};

export const useCopyToClipboard = ({
  copiedDuration = 3000,
}: UseCopyToClipboardOptions = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const scopeGenerationRef = useRef(0);

  useEffect(
    () => () => {
      scopeGenerationRef.current += 1;
      if (copiedTimerRef.current === undefined) return;

      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = undefined;
      setIsCopied(false);
    },
    [],
  );

  const copyToClipboard = (value: string) => {
    if (!value) return;

    const scopeGeneration = scopeGenerationRef.current;
    const markCopied = () => {
      if (scopeGeneration !== scopeGenerationRef.current) return;

      if (copiedTimerRef.current !== undefined) {
        clearTimeout(copiedTimerRef.current);
      }
      setIsCopied(true);
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = undefined;
        setIsCopied(false);
      }, copiedDuration);
    };

    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(markCopied, () => {});
      return;
    }
    if (copyWithSelection(value)) markCopied();
  };

  return { isCopied, copyToClipboard };
};
