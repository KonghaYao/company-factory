import ReactMarkdown from "react-markdown";

/**
 * 会话、评论与 Issue 描述共用同一套 Markdown 渲染。
 * 这里只做容器与排版，具体样式在 styles/markdown.css。
 */
export function Markdown({
  children,
  muted = false,
}: {
  children?: string;
  muted?: boolean;
}) {
  return (
    <div className={`markdown ${muted ? "is-muted" : ""}`}>
      <ReactMarkdown>{children || ""}</ReactMarkdown>
    </div>
  );
}
