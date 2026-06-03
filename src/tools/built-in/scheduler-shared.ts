import type { Scheduler } from "../../core/scheduler.js";

let scheduler: Scheduler | null = null;

export function setSchedulerForTools(s: Scheduler | null): void {
  scheduler = s;
}

export function getSchedulerForTools(): Scheduler | null {
  return scheduler;
}
