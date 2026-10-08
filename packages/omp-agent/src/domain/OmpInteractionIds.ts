/** OMP 嵌套 task 名以点拼接父前缀；每段只允许安全名称，不允许路径或空段。 */
export function safeInteractionAgentId(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value);
}
