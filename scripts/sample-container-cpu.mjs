//
// Samples container CPU and memory while a benchmark runs.
//
// The grading report gives CPU average and max per container, so a local run is
// only comparable to it if the same numbers are collected here. Throughput on
// its own says nothing about headroom: 900 logs/s at 55% of one database CPU
// and 15,000 logs/s at 25% are different machines doing different work, and
// only the ratio makes that visible.
//
//   node scripts/sample-container-cpu.mjs --duration=70
//

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);

const DURATION_S = Number(args.duration ?? 60);
const INTERVAL_MS = Number(args.interval ?? 2000);

const samples = new Map();

function addSample(name, cpu, mem) {
  if (!samples.has(name)) {
    samples.set(name, { cpu: [], mem: [] });
  }

  const entry = samples.get(name);
  entry.cpu.push(cpu);
  entry.mem.push(mem);
}

async function sample() {
  const { stdout } = await run("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}",
  ]);

  for (const line of stdout.trim().split("\n")) {
    const [name, cpuRaw, memRaw] = line.split("\t");

    if (!name || !cpuRaw) {
      continue;
    }

    const cpu = Number(cpuRaw.replace("%", ""));
    const mem = Number((memRaw ?? "").split("/")[0]?.replace(/[^\d.]/g, ""));

    if (Number.isFinite(cpu)) {
      addSample(name, cpu, Number.isFinite(mem) ? mem : 0);
    }
  }
}

const deadline = Date.now() + DURATION_S * 1000;

while (Date.now() < deadline) {
  try {
    await sample();
  } catch (error) {
    console.error("sample failed:", error.message);
  }

  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}

const avg = (values) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

console.log("\nCONTAINER RESOURCES");

for (const [name, entry] of samples) {
  console.log(`  ${name}`);
  console.log(`    cpu avg            ${avg(entry.cpu).toFixed(2)}%`);
  console.log(`    cpu max            ${Math.max(...entry.cpu).toFixed(2)}%`);
  console.log(`    mem avg            ${avg(entry.mem).toFixed(1)} MiB`);
  console.log(`    mem max            ${Math.max(...entry.mem).toFixed(1)} MiB`);
  console.log(`    samples            ${entry.cpu.length}`);
}
