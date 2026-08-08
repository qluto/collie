// Child process for the store concurrency test: applies N read-modify-write
// updates to one task, each incrementing its own label counter inside
// run.resultSummary ("A=3 B=17"). Lost updates would show as a low final count.
import { updateTask } from "../src/index.ts";

const [id, nStr, label] = process.argv.slice(2);
const n = Number(nStr);
if (!id || !Number.isFinite(n) || !label) {
  console.error("usage: hammer.ts <taskId> <n> <label>");
  process.exit(2);
}

for (let i = 0; i < n; i++) {
  updateTask(id, (task) => {
    const summary = task.run?.resultSummary ?? "";
    const counts = new Map<string, number>();
    for (const part of summary.split(" ").filter(Boolean)) {
      const [k, v] = part.split("=");
      if (k && v) counts.set(k, Number(v));
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
    task.run = {
      ...task.run,
      resultSummary: [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(" "),
    };
  });
}
process.exit(0);
