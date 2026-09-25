// 首沿+尾沿节流器：窗口内的调用只触发一次立即执行，但最后一次调用保证由尾沿
// 定时器补发。丢弃式节流会吞掉轮次终态的 sessions-index 通知（GUI 实测缺陷：
// 侧栏会话转圈不止），这里以尾沿补发保证终态必达。

export class TrailingThrottle {
  private timer: NodeJS.Timeout | null = null;
  private lastFiredAt = 0;

  constructor(
    private readonly windowMs: number,
    private readonly fire: () => void,
  ) {}

  ping(): void {
    if (this.timer) {
      return;
    }
    const remaining = this.windowMs - (Date.now() - this.lastFiredAt);
    if (remaining <= 0) {
      this.lastFiredAt = Date.now();
      this.fire();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastFiredAt = Date.now();
      this.fire();
    }, remaining);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
