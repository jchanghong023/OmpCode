import { useMemo } from "react";
import type { SubagentRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationAgentToolCallRow } from "@/v4/ConversationAgentToolCallRow.js";
import { ompSubagentCardItem } from "@/v4/OmpSubagentCard.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

export function OmpSubagentRow({
  row,
  context,
}: {
  row: SubagentRow;
  context: ConversationRowRenderContext;
}) {
  const item = useMemo(() => ompSubagentCardItem(row), [row]);
  return <ConversationAgentToolCallRow item={item} context={context} />;
}
