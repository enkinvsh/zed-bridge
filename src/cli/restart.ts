import { runStop } from "./stop.js";
import { runStart } from "./start.js";

export async function runRestart(argv: string[]): Promise<number> {
  await runStop(argv);
  return runStart(argv);
}
