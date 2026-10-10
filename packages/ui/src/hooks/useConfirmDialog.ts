import { useConfirmDialogStore, type ConfirmDialogRequest } from "@/store/confirmDialogStore.js";

// Hook 的请求类型由状态所有者公开命名，避免声明生成引用不可导出的私有类型。
export function useConfirmDialog(): (payload: ConfirmDialogRequest) => Promise<boolean> {
  return useConfirmDialogStore((state) => state.requestConfirmation);
}
