import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const target = path.join(root, "deployment", `render-source-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(target, { recursive: true });
const directories = ["src", "public", "schemas", "data/policy-packs", "data/templates", "data/benchmark-library", "data/discovery", "data/golden"];
const files = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "render.yaml", ".gitignore", ".env.example", "DEPLOY_RENDER.md", "scripts/prepare-render.mjs", "scripts/start-real.ts", "scripts/smoke-real-model.ts", "scripts/validate-config.mjs"];
files.push("候选人评估系统_模拟候选人_seed.json", "Agentic_Commerce_模拟候选人_seed.json");
for (const relative of directories) {
  fs.cpSync(path.join(root, relative), path.join(target, relative), { recursive: true,
    filter: source => !fs.lstatSync(source).isSymbolicLink() && !/\.(sqlite|db|log|zip)$/i.test(source) });
}
for (const relative of files) {
  fs.mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
  fs.copyFileSync(path.join(root, relative), path.join(target, relative));
}
console.log(`Render源文件已准备：${target}`);
console.log("不含运行数据库、上传材料、.env密钥、测试报告或聊天记录。请先检查配置种子中的样本信息，再上传私有仓库。此命令不会创建云服务或产生费用。");
