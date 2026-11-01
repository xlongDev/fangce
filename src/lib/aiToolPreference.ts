/**
 * Whether the assistant may call tools, remembered across panels.
 *
 * On by default. The switch used to start off, which meant 「梳理一下这几章的
 * 人物关系」 got prose: the model never saw the tool list, so it could not pick
 * the mind map. A feature nobody can find is a feature that does not exist.
 *
 * The cost is real — five tool schemas ride on every request — so the switch
 * stays, and turning it off is remembered per device.
 */
const KEY = "fangce.ai-tools";

export function toolsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setToolsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? "on" : "off");
  } catch {
    // Private mode. The switch still works for this session.
  }
}
