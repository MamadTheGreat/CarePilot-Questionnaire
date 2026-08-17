const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const questionnaires = require("./data/questionnaires");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_KEY = process.env.SURVEY_ADMIN_KEY || "local-review";
const GOOGLE_APPS_SCRIPT_URL = process.env.GOOGLE_APPS_SCRIPT_URL || "";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const RESPONSES_FILE = path.join(DATA_DIR, "responses.ndjson");

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RESPONSES_FILE)) fs.writeFileSync(RESPONSES_FILE, "", "utf8");

function send(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function readResponses() {
  return fs
    .readFileSync(RESPONSES_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function createResponseRecord(payload) {
  return {
    responseId: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    questionnaire: payload.questionnaire,
    completionMode: payload.completionMode === "interviewer" ? "interviewer" : "self",
    answers: payload.answers || {},
  };
}

function appendResponse(record) {
  fs.appendFileSync(RESPONSES_FILE, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

async function forwardToGoogleSheet(record) {
  if (!GOOGLE_APPS_SCRIPT_URL) return;
  const response = await fetch(GOOGLE_APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  if (!response.ok) {
    throw new Error(`google_apps_script_${response.status}`);
  }
}

function isAdmin(url, req) {
  const key = url.searchParams.get("key") || req.headers["x-survey-admin-key"];
  return key === ADMIN_KEY;
}

function aggregate(questionnaireId, responses) {
  const form = questionnaires[questionnaireId];
  if (!form) return null;
  const scoped = responses.filter((r) => r.questionnaire === questionnaireId);
  const questions = [...(form.demographics || []), ...form.questions].map((q) => {
    const counts = {};
    let answered = 0;
    for (const response of scoped) {
      const value = response.answers?.[q.id];
      if (value === undefined || value === null || value === "") continue;
      answered += 1;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) counts[item] = (counts[item] || 0) + 1;
    }
    return { id: q.id, label: q.label, hypotheses: q.hypotheses || [], answered, counts };
  });
  return { questionnaireId, title: form.title, totalResponses: scoped.length, questions };
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join(" | ") : value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv(responses) {
  const rows = [["response_id", "received_at", "questionnaire", "completion_mode", "question_id", "answer"]];
  for (const response of responses) {
    for (const [questionId, answer] of Object.entries(response.answers || {})) {
      rows.push([
        response.responseId,
        response.receivedAt,
        response.questionnaire,
        response.completionMode,
        questionId,
        answer,
      ]);
    }
  }
  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

function safeFilePath(urlPath) {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const absolute = path.normalize(path.join(PUBLIC_DIR, relative));
  return absolute.startsWith(PUBLIC_DIR) ? absolute : null;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/questionnaires") {
    return json(
      res,
      200,
      Object.entries(questionnaires).map(([id, form]) => ({
        id,
        title: form.title,
        questionCount: (form.demographics || []).length + form.questions.length,
      })),
    );
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/form/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/form/".length));
    const form = questionnaires[id];
    if (!form) return json(res, 404, { error: "questionnaire_not_found" });
    return json(res, 200, form);
  }

  if (req.method === "GET" && url.pathname === "/api/admin/summary") {
    if (!isAdmin(url, req)) return json(res, 401, { error: "unauthorized" });
    const responses = readResponses();
    return json(res, 200, {
      totalResponses: responses.length,
      forms: Object.keys(questionnaires).map((id) => aggregate(id, responses)),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/responses") {
    if (!isAdmin(url, req)) return json(res, 401, { error: "unauthorized" });
    return json(res, 200, readResponses());
  }

  if (req.method === "GET" && url.pathname === "/api/admin/export.csv") {
    if (!isAdmin(url, req)) return json(res, 401, { error: "unauthorized" });
    return send(
      res,
      200,
      exportCsv(readResponses()),
      "text/csv; charset=utf-8",
      { "Content-Disposition": 'attachment; filename="survey-responses.csv"' },
    );
  }

  if (req.method === "POST" && url.pathname === "/api/responses") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        if (!questionnaires[payload.questionnaire]) {
          return json(res, 400, { error: "questionnaire_not_found" });
        }
        const form = questionnaires[payload.questionnaire];
        const allowed = new Set([...(form.demographics || []), ...form.questions].map((q) => q.id));
        const answers = Object.fromEntries(
          Object.entries(payload.answers || {}).filter(([key]) => allowed.has(key)),
        );
        const record = createResponseRecord({
          questionnaire: payload.questionnaire,
          completionMode: payload.completionMode,
          answers,
        });
        await forwardToGoogleSheet(record);
        appendResponse(record);
        return json(res, 201, { ok: true, responseId: record.responseId });
      } catch {
        return json(res, 502, { error: "response_storage_failed" });
      }
    });
    return;
  }

  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
  const filePath = safeFilePath(url.pathname);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
  const ext = path.extname(filePath);
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  }[ext] || "application/octet-stream";
  return send(res, 200, fs.readFileSync(filePath), mime);
}

http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`Survey app running at http://${HOST}:${PORT}`);
  console.log(`Admin dashboard: http://${HOST}:${PORT}/admin.html?key=${ADMIN_KEY}`);
});
