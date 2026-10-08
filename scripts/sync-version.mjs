#!/usr/bin/env node
// bumpp execute 钩子（提交前运行）：把 package.json 的版本同步到
// tauri.conf.json / Cargo.toml / Cargo.lock，并 git add 供 bumpp 一并提交。
// 任一文件的替换计数不符预期即失败——防止未来文件重命名/工作区化后静默失效。
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[sync-version] package.json 版本非法: ${version}`);
  process.exit(1);
}
console.log(`[sync-version] 目标版本 ${version}`);

let failures = 0;

// tauri.conf.json：保持 2 空格缩进 + 末尾换行（与手写格式一致）
{
  const path = "src-tauri/tauri.conf.json";
  const json = JSON.parse(readFileSync(path, "utf8"));
  json.version = version;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  console.log(`[sync-version] ${path} -> ${version}`);
}

// Cargo.toml：仅 [package] 的首处 version（无 /g，天然只命中第一行）
{
  const path = "src-tauri/Cargo.toml";
  let count = 0;
  const out = readFileSync(path, "utf8").replace(
    /^(version\s*=\s*)"[^"]*"/m,
    (m, p1) => {
      count += 1;
      return `${p1}"${version}"`;
    },
  );
  if (count !== 1) {
    console.error(`[sync-version] ${path} 预期 1 处 version，实际 ${count}`);
    failures += 1;
  } else {
    writeFileSync(path, out);
    console.log(`[sync-version] ${path} -> ${version}`);
  }
}

// Cargo.lock：name = "eye-guard" 块内的 version 行（全仓库恰 1 处，计数守卫）
{
  const path = "src-tauri/Cargo.lock";
  let count = 0;
  const out = readFileSync(path, "utf8").replace(
    /(\[\[package\]\]\nname = "eye-guard"\nversion = )"[^"]*"/g,
    (m, p1) => {
      count += 1;
      return `${p1}"${version}"`;
    },
  );
  if (count !== 1) {
    console.error(`[sync-version] ${path} 预期 1 处 eye-guard 块，实际 ${count}`);
    failures += 1;
  } else {
    writeFileSync(path, out);
    console.log(`[sync-version] ${path} -> ${version}`);
  }
}

if (failures > 0) process.exit(1);

execSync(
  "git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock",
  { stdio: "inherit" },
);
console.log("[sync-version] 版本同步完成");
