// 更新下载进度的展示格式化（纯函数，便于 vitest 覆盖）。
// 插件 Progress 事件只给 chunkLength + 可缺省的 contentLength：
// 总量已知显示百分比（向下取整、封顶 100%），未知降级为已下载字节数。

export function formatProgress(received: number, total: number | null): string {
  if (total && total > 0) {
    const pct = Math.min(100, Math.floor((received / total) * 100));
    return `${pct}%`;
  }
  return formatBytes(received);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.floor(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
