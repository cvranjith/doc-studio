const BASE = "/api";

async function req(method, path, body, isForm) {
  const opts = { method, headers: {} };
  if (isForm) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail || JSON.stringify(j);
    } catch (_) {}
    throw new Error(`${method} ${path} failed: ${detail}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res;
}

export const api = {
  listDocuments: () => req("GET", "/documents"),
  createDocument: (title, doc_type, client) => req("POST", "/documents", { title, doc_type, client }),
  getDocument: (slug) => req("GET", `/documents/${slug}`),
  updateDocument: (slug, payload) => req("PATCH", `/documents/${slug}`, payload),
  getChapter: (slug, file) => req("GET", `/documents/${slug}/chapters/${file}`),
  saveChapter: (slug, file, payload) => req("PUT", `/documents/${slug}/chapters/${file}`, payload),
  addChapter: (slug, title, position) => req("POST", `/documents/${slug}/chapters`, { title, position }),
  deleteChapter: (slug, file) => req("DELETE", `/documents/${slug}/chapters/${file}`),
  reorderChapters: (slug, order) => req("POST", `/documents/${slug}/chapters/reorder`, { order }),

  uploadSource: async (slug, file) => {
    const form = new FormData();
    form.append("file", file);
    return req("POST", `/documents/${slug}/sources`, form, true);
  },
  updateSource: (slug, id, payload) => req("PATCH", `/documents/${slug}/sources/${id}`, payload),
  deleteSource: (slug, id) => req("DELETE", `/documents/${slug}/sources/${id}`),
  getExtracted: (slug, id) => req("GET", `/documents/${slug}/sources/${id}/extracted`),

  clarify: (slug, payload) => req("POST", `/documents/${slug}/clarify`, payload),

  saveVersion: (slug) => req("POST", `/documents/${slug}/versions`),
  listVersions: (slug) => req("GET", `/documents/${slug}/versions`),
  getVersion: (slug, v) => req("GET", `/documents/${slug}/versions/${v}`),
  getVersionChapter: (slug, v, file) => req("GET", `/documents/${slug}/versions/${v}/chapters/${file}`),
  diffChapter: (slug, v, file) => req("GET", `/documents/${slug}/versions/${v}/diff/${file}`),
  restore: (slug, v) => req("POST", `/documents/${slug}/restore/${v}`),

  export: (slug, payload) => req("POST", `/documents/${slug}/export`, payload),
  publish: (slug) => req("POST", `/documents/${slug}/publish`),

  listDocTypes: () => req("GET", "/templates/doc_types"),
  getDocType: (docType) => req("GET", `/templates/doc_types/${docType}`),
  saveDocType: (docType, payload) => req("PUT", `/templates/doc_types/${docType}`, payload),
  attachDocTypeWordTemplate: async (docType, file) => {
    const form = new FormData();
    form.append("file", file);
    return req("POST", `/templates/doc_types/${docType}/word_template`, form, true);
  },

  listWordTemplates: () => req("GET", "/templates/word"),
  uploadWordTemplate: async (file) => {
    const form = new FormData();
    form.append("file", file);
    return req("POST", "/templates/word", form, true);
  },

  // SSE streaming instruct call. onEvent(parsedJson) is called per event.
  async instruct(slug, payload, onEvent, signal) {
    const res = await fetch(`${BASE}/documents/${slug}/instruct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`instruct failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          const json = JSON.parse(line.slice(6));
          onEvent(json);
        }
      }
    }
  },
};
