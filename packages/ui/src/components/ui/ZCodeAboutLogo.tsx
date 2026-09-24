import { cn } from "@/components/lib/utils.js";

// omp 官方图标（oh-my-pi assets/icon.svg 的 π 符号 + 插件连接件；FORK.md 更换图标需求）。
// UI 场景为单色自适应（currentColor）+ 品牌橙连接件；槽口/装饰点在透明背景上省略。
function OmpMarkPaths() {
  return (
    <>
      <rect x="10" y="8" width="100" height="12" rx="2" fill="currentColor" />
      <rect x="25" y="20" width="12" height="62" rx="2" fill="currentColor" />
      <rect x="75" y="20" width="12" height="45" rx="2" fill="currentColor" />
      <rect x="71" y="55" width="20" height="16" rx="3" fill="#f97316" />
    </>
  );
}

export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="118"
      height="89"
      viewBox="0 0 120 90"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      <OmpMarkPaths />
    </svg>
  );
}

export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return (
    <svg
      width="244"
      height="54"
      viewBox="0 0 244 54"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      <g transform="translate(4 13) scale(0.311)">
        <OmpMarkPaths />
      </g>
      <text
        x="56"
        y="37"
        fill="currentColor"
        font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
        font-size="27"
        font-weight="680"
        letter-spacing="1"
      >
        OMPCODE
      </text>
    </svg>
  );
}
