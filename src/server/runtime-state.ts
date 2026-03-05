export type RuntimeState = {
  transport: "stdio" | "http";
  tools: Array<string>;
  serverName: string;
  serverVersion: string;
  startedAt: number;
};

const state: RuntimeState = {
  transport: "stdio",
  tools: [],
  serverName: "mcp-server-starter",
  serverVersion: "1.0.0",
  startedAt: Date.now(),
};

export function setRuntimeState(nextState: Partial<RuntimeState>): void {
  Object.assign(state, nextState);
}

export function getRuntimeState(): RuntimeState {
  return {
    ...state,
    tools: [...state.tools],
  };
}
