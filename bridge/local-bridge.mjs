export async function probeLocalBridge({
  host,
  port,
  expectedBridge,
  timeoutMs = 2500,
}) {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { kind: "unavailable", status: response.status };
    }
    const health = await response.json();
    if (health?.bridge !== expectedBridge) {
      return {
        kind: "mismatch",
        actualBridge: health?.bridge || "unknown",
        health,
      };
    }
    return { kind: "ok", health };
  } catch (error) {
    return { kind: "unavailable", error };
  }
}

export function bridgeMismatchMessage(probe, port, expectedBridge) {
  return (
    `Local port ${port} belongs to '${probe.actualBridge}', not '${expectedBridge}'. ` +
    "Clear the conflicting bridge port override or stop the other application."
  );
}
