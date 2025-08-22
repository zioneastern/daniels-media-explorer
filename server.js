// server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import fetch from "node-fetch";
import Gun from "gun";
import path from "path";
import { fileURLToPath } from "url";
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==== CONFIG ====
const PORT = process.env.PORT || 8596;
const PIXABAY_KEY = process.env.PIXABAY_KEY || "51243648-1ed97e0bbac9dec2e3b08e350";
const APP_NS = "dme_pixabay_v1"; // Gun namespace

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public")));

// ---- Start HTTP server first, then attach GUN
const server = app.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

// Gun
const gun = Gun({ web: server });
const ROOT = gun.get(APP_NS);

// Helper: safe counter init
function initCounter(node, key) {
  node.get(key).once(val => {
    if (val == null) node.get(key).put(0);
  });
}

// Flatten media for Gun
function normalizePixabayItem(item, type) {
  const id = String(item.id);
  const createdAt = Date.now();
  const tags = (item.tags || "").split(",").map(s => s.trim()).filter(Boolean);

  let src = "", thumb = "", width = 0, height = 0;
  if (type === "image") {
    src = item.largeImageURL || item.webformatURL || item.previewURL;
    thumb = item.previewURL || item.webformatURL || item.largeImageURL;
    width = item.imageWidth || item.webformatWidth || 0;
    height = item.imageHeight || item.webformatHeight || 0;
  } else {
    const v = item.videos || {};
    src = v.medium?.url || v.small?.url || v.tiny?.url || v.large?.url || "";
    thumb = item.userImageURL || "";
  }

  return {
    id,
    type,
    src,
    thumb,
    title: tags[0] || (type === "image" ? "Image" : "Video"),
    tags: tags.join(","), // store as string
    width,
    height,
    author: item.user || "unknown",
    source: "pixabay",
    sourcePage: item.pageURL || "",
    createdAt
  };
}

// Store media safely
function putMediaRecord(rec) {
  return new Promise((resolve) => {
    const node = ROOT.get("media").get(rec.id);

    node.put(rec, () => resolve(rec));

    initCounter(node, "likes");
    initCounter(node, "downloads");
  });
}

// Index for quick lookup
function indexRecord(queryKey, id) {
  ROOT.get("index").get(queryKey).get(id).put(true);
}

// Fetch from Pixabay
async function fetchFromPixabay({ q, type = "image", category = "", orientation = "", safesearch = "true", per_page = 20 }) {
  const base = type === "image"
    ? `https://pixabay.com/api/?key=${PIXABAY_KEY}&image_type=photo`
    : `https://pixabay.com/api/videos/?key=${PIXABAY_KEY}`;

  const url = new URL(base);
  url.searchParams.set("q", q);
  if (category) url.searchParams.set("category", category);
  if (type === "image" && orientation) url.searchParams.set("orientation", orientation);
  url.searchParams.set("safesearch", safesearch);
  url.searchParams.set("per_page", String(per_page));
  url.searchParams.set("order", "popular");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Pixabay error: ${res.status}`);
  const data = await res.json();
  return data.hits || [];
}

// List from Gun index
async function listFromIndex(queryKey, limit = 50) {
  return new Promise((resolve) => {
    const ids = new Set();
    ROOT.get("index").get(queryKey).map().once((val, id) => {
      if (val) ids.add(id);
    });

    setTimeout(() => {
      const out = [];
      let pending = ids.size;
      if (!pending) return resolve([]);
      ids.forEach((id) => {
        ROOT.get("media").get(id).once((rec) => {
          if (rec && rec.id) out.push(rec);
          pending -= 1;
          if (pending === 0) resolve(out.slice(0, limit));
        });
      });
    }, 250);
  });
}

// ============ PUBLIC API ============

// Search
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.query || req.query.q || "nature").toString();
    const type = (req.query.type || "image").toString();
    const category = (req.query.category || "").toString();
    const orientation = (req.query.orientation || "").toString();
    const safesearch = (req.query.safesearch ?? "true").toString();
    const per_page = Number(req.query.per_page || (type === "image" ? 24 : 12));

    const hits = await fetchFromPixabay({ q, type, category, orientation, safesearch, per_page });
    const normalized = hits.map(h => normalizePixabayItem(h, type));

    for (const rec of normalized) {
      await putMediaRecord(rec);
      indexRecord(q.toLowerCase(), rec.id);
    }

    res.json({ ok: true, count: normalized.length, query: q, type, items: normalized });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Feed
app.get("/api/feed", async (req, res) => {
  const q = (req.query.query || req.query.q || "nature").toString().toLowerCase();
  const limit = Number(req.query.limit || 50);
  try {
    const items = await listFromIndex(q, limit);
    res.json({ ok: true, count: items.length, query: q, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Single media
app.get("/api/media", async (req, res) => {
  const id = (req.query.id || "").toString();
  if (!id) return res.status(400).json({ ok: false, error: "id is required" });

  ROOT.get("media").get(id).once((rec) => {
    if (!rec || !rec.id) return res.status(404).json({ ok: false, error: "not found" });
    ROOT.get("media").get(id).get("likes").once(likes => {
      ROOT.get("media").get(id).get("downloads").once(downloads => {
        res.json({ ok: true, item: { ...rec, likes: Number(likes || 0), downloads: Number(downloads || 0) } });
      });
    });
  });
});

// Like
app.post("/api/like", (req, res) => {
  const { id, uid } = req.body || {};
  if (!id || !uid) return res.status(400).json({ ok: false, error: "id and uid required" });

  const node = ROOT.get("media").get(String(id));
  node.get("likers").get(uid).once((val) => {
    if (val) return res.json({ ok: true, liked: true, message: "already liked" });
    node.get("likers").get(uid).put(true);
    node.get("likes").once((cur) => {
      const next = Number(cur || 0) + 1;
      node.get("likes").put(next, () => res.json({ ok: true, liked: true, likes: next }));
    });
  });
});

// Unlike
app.post("/api/unlike", (req, res) => {
  const { id, uid } = req.body || {};
  if (!id || !uid) return res.status(400).json({ ok: false, error: "id and uid required" });

  const node = ROOT.get("media").get(String(id));
  node.get("likers").get(uid).once((val) => {
    if (!val) return res.json({ ok: true, liked: false, message: "not liked yet" });
    node.get("likers").get(uid).put(null);
    node.get("likes").once((cur) => {
      const next = Math.max(0, Number(cur || 0) - 1);
      node.get("likes").put(next, () => res.json({ ok: true, liked: false, likes: next }));
    });
  });
});

// Download counter
app.post("/api/download", (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  const node = ROOT.get("media").get(String(id));
  node.get("downloads").once((cur) => {
    const next = Number(cur || 0) + 1;
    node.get("downloads").put(next, () => res.json({ ok: true, downloads: next }));
  });
});

// Docs page
app.get("/docs", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "docs.html"));
});

// Health
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "Daniel’s Media Explorer API" }));
