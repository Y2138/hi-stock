export function insufficientBalanceMessage(error: unknown): string | null {
  const value = error as { status?: unknown; message?: unknown } | null;
  const message = typeof error === "string" ? error : String(value?.message ?? "");
  return value?.status === 402 || /HTTP\s*402\b|^402\s*:|insufficient.?balance|余额不足/i.test(message)
    ? "模型厂商余额不足（HTTP 402），请充值后手动重新运行；本次不自动重试"
    : null;
}
