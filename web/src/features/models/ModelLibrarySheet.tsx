import { Sheet } from "../../ui/primitives";
import { ModelLibraryContent } from "./ModelLibraryContent";

/** 顶栏「模型库」入口：全局只读 Sheet，只在该 Sheet 打开时请求。 */
export function ModelLibrarySheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={open}
      wide
      title="模型库"
      subtitle="宿主私有 model-library.yaml 的只读投影。密钥与 endpoint 值不会显示；修改库文件后，已有 Agent 需手动重启才会应用。"
      onClose={onClose}
    >
      {open && <ModelLibraryContent />}
    </Sheet>
  );
}
