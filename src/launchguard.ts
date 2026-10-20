import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type Confidence = "CONFIRMED" | "SUSPECTED" | "NEEDS MANUAL REVIEW";
export type Area = "Build" | "Testing" | "Security" | "API" | "UX" | "Documentation";
export type Status = "PASS" | "WARNING" | "ERROR";

export interface Finding {
  area: Area;
  severity: Severity;
  confidence: Confidence;
  title: string;
  evidence: string[];
  why: string;
  action: string;
  verify: string;
}

export interface Report {
  generatedAt: string;
  overall: "READY" | "NEEDS WORK" | "NOT READY";
  areas: Record<Area, Status>;
  project: Record<string, string>;
  findings: Finding[];
  limitations: string[];
}

interface Pkg {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}
interface SourceFile {
  rel: string;
  text: string;
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AREAS: Area[] = ["Build", "Testing", "Security", "API", "UX", "Documentation"];
const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".next", "coverage"]);
const TEXT_EXT = new Set([".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".html", ".css", ".prisma", ".yml", ".yaml", ".txt"]);
const PLACEHOLDER = /your|example|changeme|placeholder|x{4,}|<|\*{3}|^pass(word)?$/i;

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

function collectFiles(dir: string, out: SourceFile[] = [], depth = 0): SourceFile[] {
  if (depth > 6) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collectFiles(full, out, depth + 1);
      continue;
    }
    // This file contains the secret-detection patterns themselves, so it is skipped.
    if (e.name === "package-lock.json" || e.name === "launchguard.ts") continue;
    if (!e.name.startsWith(".env") && !TEXT_EXT.has(path.extname(e.name))) continue;
    try {
      if (fs.statSync(full).size > 300_000) continue;
    } catch {
      continue;
    }
    const text = readText(full);
    if (text !== null) {
      out.push({ rel: path.relative(ROOT, full).split(path.sep).join("/"), text });
    }
  }
  return out;
}

function eachLine(f: SourceFile, fn: (line: string, n: number) => void): void {
  f.text.split("\n").forEach((line, i) => fn(line, i + 1));
}

const SECRET_PATTERNS: { name: string; re: RegExp; group?: number; strong: boolean }[] = [
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, strong: true },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/, strong: true },
  { name: "TaskWise-style access key", re: /\btw_[A-Za-z0-9_-]{30,}\b/, strong: true },
  {
    name: "Database URL containing a password",
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/'"]+:([^\s@/'"]+)@/,
    group: 1,
    strong: true,
  },
  {
    name: "Hardcoded credential assignment",
    re: /\b(?:api[_-]?key|secret|token|passwd|password)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    strong: false,
  },
];

export function runLaunchGuard(): Report {
  const files = collectFiles(ROOT);
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const allText = files.map((f) => f.text).join("\n");
  const srcFiles = files.filter((f) => f.rel.startsWith("src/") && f.rel.endsWith(".ts"));

  // ---------- Project discovery ----------
  let pkg: Pkg = {};
  const pkgText = readText(path.join(ROOT, "package.json"));
  if (pkgText) {
    try {
      pkg = JSON.parse(pkgText) as Pkg;
    } catch {
      add({
        area: "Build", severity: "HIGH", confidence: "CONFIRMED",
        title: "package.json is not valid JSON", evidence: ["package.json"],
        why: "The project cannot install or build with a broken package.json.",
        action: "Fix the JSON syntax (look for a missing comma or bracket).",
        verify: "Run `npm install` locally with no errors.",
      });
    }
  } else {
    add({
      area: "Build", severity: "HIGH", confidence: "CONFIRMED",
      title: "No package.json found", evidence: ["package.json is missing from the project root"],
      why: "LaunchGuard and Render both need it to know how to build and start the project.",
      action: "Add a package.json at the project root.",
      verify: "Run LaunchGuard again.",
    });
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = pkg.scripts ?? {};
  const lockfile = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"].find(exists);
  const framework = ["express", "next", "fastify", "koa", "nestjs"].find((d) => deps[d]) ?? "unknown";

  // ---------- Build ----------
  for (const s of ["build", "start"]) {
    if (!scripts[s]) {
      add({
        area: "Build", severity: "HIGH", confidence: "CONFIRMED",
        title: `Missing "${s}" script`, evidence: [`package.json has no scripts.${s}`],
        why: "Hosting platforms rely on this script to build and run the app.",
        action: `Add a "${s}" script to package.json.`,
        verify: `Run \`npm run ${s}\` locally.`,
      });
    }
  }
  if (!lockfile) {
    add({
      area: "Build", severity: "MEDIUM", confidence: "CONFIRMED",
      title: "No dependency lockfile", evidence: ["No package-lock.json, yarn.lock, or pnpm-lock.yaml"],
      why: "Without a lockfile, every deploy can install different package versions.",
      action: "Run `npm install` and commit package-lock.json.",
      verify: "package-lock.json appears in the repo.",
    });
  }
  const nodeRange = pkg.engines?.node;
  if (!nodeRange || /^>=/.test(nodeRange)) {
    add({
      area: "Build", severity: "LOW", confidence: "CONFIRMED",
      title: "Node version is not pinned", evidence: [`engines.node = ${nodeRange ?? "not set"}`],
      why: "An open range lets the host pick a brand-new Node version that your packages may not support yet.",
      action: 'Set "engines": { "node": "20.x" } in package.json.',
      verify: "The Render build log says it is using Node 20.",
    });
  }
  const tsconfig = readText(path.join(ROOT, "tsconfig.json"));
  if (tsconfig && !/"strict"\s*:\s*true/.test(tsconfig)) {
    add({
      area: "Build", severity: "MEDIUM", confidence: "CONFIRMED",
      title: "TypeScript strict mode is off", evidence: ["tsconfig.json"],
      why: "Strict mode catches missing-value and wrong-type bugs before deploy.",
      action: 'Set "strict": true in tsconfig.json and fix the errors it reports.',
      verify: "`npm run typecheck` passes.",
    });
  }
  add({
    area: "Build", severity: "INFO", confidence: "NEEDS MANUAL REVIEW",
    title: "Build, tests, lint and dependency audit were not executed",
    evidence: ["LaunchGuard reads project files only; it does not run commands on the server"],
    why: "A passing configuration does not prove the code builds or the tests pass.",
    action: "Run `npm run typecheck`, `npm test` and `npm audit` on your computer or in CI. A successful Render deploy also proves the build step passed.",
    verify: "All three commands finish without errors.",
  });

  // ---------- Testing ----------
  const testFiles = files.filter((f) => /\.(test|spec)\.[tj]s$/.test(f.rel) || f.rel.startsWith("tests/"));
  if (!scripts.test || testFiles.length === 0) {
    add({
      area: "Testing", severity: "MEDIUM", confidence: "CONFIRMED",
      title: "No automated tests",
      evidence: [scripts.test ? "A test script exists" : "No scripts.test in package.json", `${testFiles.length} test files found`],
      why: "Without tests, any change (like moving to a database) can silently break task handling.",
      action: "Add tests for dates, task updates and planning, and a `test` script.",
      verify: "`npm test` runs and passes.",
    });
  }
  if (!scripts.lint) {
    add({
      area: "Testing", severity: "LOW", confidence: "CONFIRMED",
      title: "No lint script", evidence: ["package.json has no scripts.lint"],
      why: "Linting catches common mistakes automatically.",
      action: "Add ESLint and a `lint` script.",
      verify: "`npm run lint` runs.",
    });
  }

  // ---------- Security: secrets in files ----------
  const hits: string[] = [];
  let strongHit = false;
  for (const f of files) {
    if (f.rel === "package.json") continue;
    eachLine(f, (line, n) => {
      for (const p of SECRET_PATTERNS) {
        const m = p.re.exec(line);
        if (!m) continue;
        if (p.group && PLACEHOLDER.test(m[p.group] ?? "")) continue;
        if (!p.strong && (/process\.env/.test(line) || PLACEHOLDER.test(m[0]))) continue;
        if (p.strong) strongHit = true;
        hits.push(`${f.rel}:${n} (${p.name}, value hidden)`);
      }
    });
  }
  if (hits.length) {
    add({
      area: "Security", severity: strongHit ? "CRITICAL" : "HIGH", confidence: strongHit ? "CONFIRMED" : "SUSPECTED",
      title: "Possible secret stored in project files", evidence: hits,
      why: "Anything committed to GitHub can be copied, even from a private repo's history.",
      action: "Remove the value from the file, move it to an environment variable, and rotate (replace) the exposed credential.",
      verify: "Run LaunchGuard again; the file and line should no longer be listed.",
    });
  }
  if (files.some((f) => f.rel === ".env" || /^\.env\.(?!example)/.test(f.rel))) {
    add({
      area: "Security", severity: "HIGH", confidence: "CONFIRMED",
      title: "An environment file is part of the deployed project",
      evidence: files.filter((f) => /^\.env(\.(?!example).*)?$/.test(f.rel)).map((f) => f.rel),
      why: "A .env file that reaches the server was committed to the repo, and may hold real secrets.",
      action: "Delete it from the repo, keep it in .gitignore, and rotate any secrets it held.",
      verify: "The file no longer appears in GitHub.",
    });
  }
  const gitignore = readText(path.join(ROOT, ".gitignore")) ?? "";
  if (!/^\.env(\*|\.\*)?\s*$/m.test(gitignore)) {
    add({
      area: "Security", severity: "MEDIUM", confidence: "CONFIRMED",
      title: ".gitignore does not exclude .env files", evidence: [".gitignore"],
      why: "A local .env could be committed by accident.",
      action: "Add `.env` and `.env.*` (keeping `!.env.example`) to .gitignore.",
      verify: "`git check-ignore .env` prints `.env`.",
    });
  }

  // ---------- Security: runtime configuration (presence and length only) ----------
  const usesKey = srcFiles.some((f) => f.text.includes("process.env.TASKWISE_API_KEY"));
  const apiKey = process.env.TASKWISE_API_KEY ?? "";
  if (usesKey && !apiKey) {
    add({
      area: "Security", severity: "HIGH", confidence: "CONFIRMED",
      title: "API key is not set, so the server is open", evidence: ["TASKWISE_API_KEY is empty in this environment"],
      why: "Anyone with the URL can read, add and delete tasks.",
      action: "Set TASKWISE_API_KEY in your host's environment variables.",
      verify: "A request to /mcp without the key returns 401.",
    });
  } else if (usesKey && apiKey.length < 32) {
    add({
      area: "Security", severity: "MEDIUM", confidence: "CONFIRMED",
      title: "API key is short", evidence: [`TASKWISE_API_KEY is ${apiKey.length} characters`],
      why: "Short keys are easier to guess.",
      action: "Use a random key of at least 32 characters.",
      verify: "LaunchGuard no longer lists this finding.",
    });
  }
  const origin = process.env.ALLOWED_ORIGIN;
  if (srcFiles.some((f) => f.text.includes("ALLOWED_ORIGIN")) && (!origin || origin === "*")) {
    add({
      area: "Security", severity: "MEDIUM", confidence: "CONFIRMED",
      title: "CORS allows any website", evidence: [`ALLOWED_ORIGIN = ${origin ?? "not set"}`],
      why: "Any website can send requests to your API from a visitor's browser.",
      action: "Set ALLOWED_ORIGIN to your site's exact URL, for example https://taskwise-ef7s.onrender.com.",
      verify: "The startup warning about ALLOWED_ORIGIN disappears.",
    });
  }
  if (exists("prisma/schema.prisma") && !process.env.DATABASE_URL) {
    add({
      area: "Security", severity: "HIGH", confidence: "CONFIRMED",
      title: "DATABASE_URL is not set", evidence: ["prisma/schema.prisma exists but DATABASE_URL is empty"],
      why: "The app cannot reach its database.",
      action: "Set DATABASE_URL in your host's environment variables.",
      verify: "The dashboard loads tasks.",
    });
  }
  if (!deps.helmet) {
    add({
      area: "Security", severity: "LOW", confidence: "SUSPECTED",
      title: "No security headers package", evidence: ["helmet is not in dependencies"],
      why: "Browsers get no extra protections such as clickjacking and content-type guards.",
      action: "Add `helmet` and call `app.use(helmet())`.",
      verify: "Responses include headers such as X-Content-Type-Options.",
    });
  }
  const pub = files.filter((f) => f.rel.startsWith("public/"));
  if (pub.some((f) => /localStorage\.setItem/.test(f.text) && /key/i.test(f.text))) {
    add({
      area: "Security", severity: "LOW", confidence: "NEEDS MANUAL REVIEW",
      title: "Access key is kept in browser storage",
      evidence: pub.filter((f) => /localStorage\.setItem/.test(f.text)).map((f) => f.rel),
      why: "If a malicious script ever ran on the page, it could read the key. Fine for a personal app, weak for a public one.",
      action: "For multi-user use, move to real logins with sessions instead of one shared key.",
      verify: "Manual review of the sign-in design.",
    });
  }

  // ---------- API and backend ----------
  const ROUTE = /\bapp\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`](.*)$/;
  const open: string[] = [];
  for (const f of srcFiles) {
    eachLine(f, (line, n) => {
      const m = ROUTE.exec(line);
      if (!m) return;
      const guarded = /requireApiKey|requireAuth|authenticate|authorize/i.test(m[3]);
      const allowed = m[2] === "/health" || /methodNotAllowed/.test(m[3]);
      if (!guarded && !allowed) open.push(`${m[1].toUpperCase()} ${m[2]} (${f.rel}:${n})`);
    });
  }
  if (open.length) {
    add({
      area: "API", severity: "MEDIUM", confidence: "NEEDS MANUAL REVIEW",
      title: "Routes with no visible authentication", evidence: open,
      why: "These routes may be reachable by anyone. LaunchGuard only sees middleware named on the same line.",
      action: "Confirm each route is meant to be public, or add authentication.",
      verify: "Requests to those routes without a key behave as you intend.",
    });
  }
  if (!["zod", "joi", "yup", "ajv"].some((d) => deps[d])) {
    add({
      area: "API", severity: "MEDIUM", confidence: "SUSPECTED",
      title: "No input validation library", evidence: ["zod, joi, yup and ajv are all absent"],
      why: "Unchecked input leads to crashes and bad data.",
      action: "Validate every request body with a schema library such as zod.",
      verify: "Bad input returns a clear 4xx error instead of crashing.",
    });
  }
  if (!srcFiles.some((f) => /app\.use\(\s*\(\s*err/.test(f.text))) {
    add({
      area: "API", severity: "MEDIUM", confidence: "SUSPECTED",
      title: "No global error handler found", evidence: ["No app.use((err, ...) handler in src/"],
      why: "Unexpected errors can leak details or return unhelpful pages.",
      action: "Add an Express error-handling middleware at the end of the app setup.",
      verify: "A malformed request returns JSON, not an HTML error page.",
    });
  }
  if (!["express-rate-limit", "rate-limiter-flexible"].some((d) => deps[d])) {
    add({
      area: "API", severity: "MEDIUM", confidence: "SUSPECTED",
      title: "No rate limiting", evidence: ["No rate-limit package in dependencies"],
      why: "Nothing slows down repeated key guesses or request floods.",
      action: "Add `express-rate-limit` to /mcp.",
      verify: "Rapid repeated requests start returning 429.",
    });
  }

  // ---------- UX ----------
  const index = pub.find((f) => f.rel === "public/index.html");
  if (index) {
    const t = index.text;
    if (!/name="viewport"/.test(t)) {
      add({
        area: "UX", severity: "LOW", confidence: "CONFIRMED",
        title: "Missing mobile viewport tag", evidence: ["public/index.html"],
        why: "Phones may show the page zoomed out and tiny.",
        action: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head.',
        verify: "The page fits a phone screen.",
      });
    }
    const missing: string[] = [];
    if (!/loading|planning…|\.\.\./i.test(t)) missing.push("loading state");
    if (!/catch\s*\(/.test(t)) missing.push("error handling");
    if (!/start with|no tasks|nothing/i.test(t)) missing.push("empty state");
    if (missing.length) {
      add({
        area: "UX", severity: "MEDIUM", confidence: "SUSPECTED",
        title: "Screen states may be missing", evidence: missing.map((m) => `public/index.html: no ${m} detected`),
        why: "Users see a blank or frozen screen while waiting or when something fails.",
        action: "Show a message while loading, when a request fails, and when the list is empty.",
        verify: "Test each state by hand on a phone.",
      });
    }
  }
  const broken: string[] = [];
  for (const f of pub.filter((x) => x.rel.endsWith(".html"))) {
    for (const m of f.text.matchAll(/(?:href|src)="([^"#:]+)"/g)) {
      const target = path.join(ROOT, "public", m[1].replace(/^\//, ""));
      if (m[1] !== "/" && !fs.existsSync(target)) broken.push(`${f.rel} links to ${m[1]}`);
    }
  }
  if (broken.length) {
    add({
      area: "UX", severity: "MEDIUM", confidence: "CONFIRMED",
      title: "Broken local links", evidence: broken,
      why: "Visitors land on 'Cannot GET' pages.",
      action: "Fix the paths or add the missing files.",
      verify: "Open each link.",
    });
  }
  const todo: string[] = [];
  for (const f of [...srcFiles, ...pub]) {
    eachLine(f, (line, n) => {
      if (/\b(TODO|FIXME)\b|lorem ipsum|coming soon/i.test(line)) todo.push(`${f.rel}:${n}`);
    });
  }
  if (todo.length) {
    add({
      area: "UX", severity: "LOW", confidence: "CONFIRMED",
      title: "Placeholder or unfinished markers", evidence: todo,
      why: "These usually mark incomplete work.",
      action: "Finish or remove them.",
      verify: "LaunchGuard no longer lists them.",
    });
  }
  add({
    area: "UX", severity: "INFO", confidence: "NEEDS MANUAL REVIEW",
    title: "Layout and usability were not visually tested", evidence: ["LaunchGuard reads code; it cannot see the screen"],
    why: "Overlapping text, small tap targets and unreadable colors need human eyes.",
    action: "Click through every screen on a real phone.",
    verify: "Nothing looks or behaves wrong.",
  });

  // ---------- Documentation ----------
  const readme = readText(path.join(ROOT, "README.md"));
  if (!readme) {
    add({
      area: "Documentation", severity: "MEDIUM", confidence: "CONFIRMED",
      title: "No README", evidence: ["README.md is missing"],
      why: "A new developer cannot tell how to install, run or deploy the project.",
      action: "Add README.md covering install, environment variables, run, test, deploy, and features.",
      verify: "Someone new can run the project from the README alone.",
    });
  } else {
    const topics: [string, RegExp][] = [
      ["install", /install/i], ["environment variables", /environment|\.env|env var/i],
      ["running", /npm (run )?(start|dev)|run /i], ["testing", /test/i],
      ["deployment", /deploy|render/i], ["features", /feature|tool|what it does/i],
    ];
    const gaps = topics.filter(([, re]) => !re.test(readme)).map(([n]) => n);
    if (gaps.length) {
      add({
        area: "Documentation", severity: "LOW", confidence: "SUSPECTED",
        title: "README may be missing sections", evidence: gaps.map((g) => `No mention of ${g}`),
        why: "Gaps slow down every new contributor.",
        action: "Add the missing sections.",
        verify: "Read the README as if you were new.",
      });
    }
  }
  if (!exists(".env.example")) {
    add({
      area: "Documentation", severity: "MEDIUM", confidence: "CONFIRMED",
      title: "No .env.example", evidence: [".env.example is missing"],
      why: "Nobody can tell which environment variables the app needs.",
      action: "Add .env.example listing every variable with placeholder values.",
      verify: "Every variable used in code appears in the file.",
    });
  } else {
    const example = readText(path.join(ROOT, ".env.example")) ?? "";
    const used = new Set<string>();
    for (const f of srcFiles) for (const m of f.text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) used.add(m[1]);
    const undocumented = [...used].filter((v) => v !== "NODE_ENV" && !new RegExp(`^${v}=`, "m").test(example));
    if (undocumented.length) {
      add({
        area: "Documentation", severity: "LOW", confidence: "CONFIRMED",
        title: "Environment variables missing from .env.example", evidence: undocumented,
        why: "Anyone setting up the project will not know these exist.",
        action: "Add each one to .env.example with a placeholder value.",
        verify: "Every variable used in src/ is listed.",
      });
    }
  }
  if (!exists("SKILL.md")) {
    add({
      area: "Documentation", severity: "LOW", confidence: "CONFIRMED",
      title: "No SKILL.md", evidence: ["SKILL.md is missing"],
      why: "Agents need it to know when and how to use TaskWise and LaunchGuard.",
      action: "Add SKILL.md describing the tools, when to use them, and what needs confirmation.",
      verify: "The file exists and covers every tool.",
    });
  }

  // ---------- Scoring ----------
  const order = (s: Severity) => SEVERITIES.indexOf(s);
  findings.sort((a, b) => order(a.severity) - order(b.severity));
  const areas = {} as Record<Area, Status>;
  for (const a of AREAS) {
    const list = findings.filter((f) => f.area === a);
    areas[a] = list.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH")
      ? "ERROR"
      : list.some((f) => f.severity === "MEDIUM" || f.severity === "LOW")
        ? "WARNING"
        : "PASS";
  }
  const overall = findings.some((f) => f.severity === "CRITICAL")
    ? "NOT READY"
    : findings.some((f) => f.severity === "HIGH" || f.severity === "MEDIUM")
      ? "NEEDS WORK"
      : "READY";

  return {
    generatedAt: new Date().toISOString(),
    overall,
    areas,
    project: {
      name: pkg.name ?? "unknown",
      framework,
      packageManager: lockfile ? lockfile.replace("-lock.json", "").replace(".lock", "").replace("-lock.yaml", "") : "unknown",
      dependencies: String(Object.keys(pkg.dependencies ?? {}).length),
      filesScanned: String(files.length),
    },
    findings,
    limitations: [
      "Reads project files and environment variable presence only. It does not run builds, tests, or audits.",
      "It is not a penetration test and cannot prove an app is secure.",
      "Secret detection matches known formats and can miss or over-report. Values are never printed.",
    ],
  };
}

export function formatReport(r: Report, minSeverity: Severity = "INFO"): string {
  const out: string[] = ["LAUNCHGUARD REPORT", "", `Overall: ${r.overall}`, ""];
  for (const a of AREAS) out.push(`${a}: ${r.areas[a]}`);
  out.push("", "Project: " + Object.entries(r.project).map(([k, v]) => `${k}=${v}`).join(" | "), "");
  for (const sev of SEVERITIES.slice(0, SEVERITIES.indexOf(minSeverity) + 1)) {
    const list = r.findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    out.push(`${sev} (${list.length})`);
    list.forEach((f, i) => {
      out.push(`${i + 1}. [${f.confidence}] ${f.title}`, `   Area: ${f.area}`);
      f.evidence.slice(0, 8).forEach((e) => out.push(`   Evidence: ${e}`));
      out.push(`   Why it matters: ${f.why}`, `   Action: ${f.action}`, `   Verify: ${f.verify}`, "");
    });
  }
  out.push("Limits:", ...r.limitations.map((l) => `- ${l}`));
  return out.join("\n");
}