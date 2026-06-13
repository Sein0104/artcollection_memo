import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, normalize, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const dataDir = resolve(root, "data");
const dbPath = resolve(dataDir, "artcatch.sqlite");
const seedPath = resolve(dataDir, "seed-data.json");
const port = Number(globalThis.ARTCATCH_PORT || globalThis.process?.env?.PORT || 5177);

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(globalThis.process ? dbPath : ":memory:");
initializeDatabase();

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    serveStatic(response, url);
  } catch (error) {
    sendJson(response, statusForError(error), { error: error.message || "server_error" });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`ArtCatch running at http://127.0.0.1:${port}`);
});

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artworks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      year TEXT NOT NULL,
      origin TEXT NOT NULL,
      period TEXT NOT NULL,
      region TEXT NOT NULL,
      category TEXT NOT NULL,
      tags TEXT NOT NULL,
      palette TEXT NOT NULL,
      image TEXT,
      premium INTEGER NOT NULL DEFAULT 0,
      cost INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS museums (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL,
      city TEXT NOT NULL,
      tags TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      museum_id TEXT NOT NULL,
      artwork_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      likes INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS users (
      nickname TEXT PRIMARY KEY,
      password_hash TEXT,
      password_salt TEXT,
      points INTEGER NOT NULL DEFAULT 40,
      installed_reward_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      artwork_id TEXT NOT NULL,
      source TEXT NOT NULL,
      date_key TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchases (
      nickname TEXT NOT NULL,
      artwork_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (nickname, artwork_id)
    );
  `);
  addColumnIfMissing("users", "password_hash", "TEXT");
  addColumnIfMissing("users", "password_salt", "TEXT");

  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  seedArtworks(seed.artworks || []);
  seedMuseums(seed.museums || []);
  seedPosts(seed.posts || []);
}

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function seedArtworks(artworks) {
  const statement = db.prepare(`
    INSERT INTO artworks (
      id, title, artist, year, origin, period, region, category, tags, palette, image, premium, cost
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      year = excluded.year,
      origin = excluded.origin,
      period = excluded.period,
      region = excluded.region,
      category = excluded.category,
      tags = excluded.tags,
      palette = excluded.palette,
      image = excluded.image,
      premium = excluded.premium,
      cost = excluded.cost
  `);

  for (const art of artworks) {
    statement.run(
      art.id,
      art.title,
      art.artist,
      art.year,
      art.origin,
      art.period,
      art.region,
      JSON.stringify(art.category || []),
      JSON.stringify(art.tags || []),
      JSON.stringify(art.palette || [120, 120, 120]),
      art.image || null,
      art.premium ? 1 : 0,
      art.cost || 0,
    );
  }
}

function seedMuseums(museums) {
  const statement = db.prepare(`
    INSERT INTO museums (id, name, scope, city, tags)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      scope = excluded.scope,
      city = excluded.city,
      tags = excluded.tags
  `);

  for (const museum of museums) {
    statement.run(museum.id, museum.name, museum.scope, museum.city, JSON.stringify(museum.tags || []));
  }
}

function seedPosts(posts) {
  const statement = db.prepare(`
    INSERT OR IGNORE INTO posts (id, author, title, body, museum_id, artwork_id, created_at, likes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const post of posts) {
    statement.run(
      post.id,
      post.author,
      post.title,
      post.body,
      post.museumId,
      post.artworkId,
      post.createdAt,
      post.likes || 0,
    );
  }
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/artworks") {
    sendJson(response, 200, { artworks: getArtworks() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/museums") {
    sendJson(response, 200, { museums: getMuseums() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/posts") {
    const museumId = url.searchParams.get("museumId");
    sendJson(response, 200, { posts: getPosts(museumId) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/posts") {
    const body = await readJson(request);
    const post = createPost(body);
    sendJson(response, 201, { post, posts: getPosts() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/signup") {
    const body = await readJson(request);
    const nickname = validateNickname(body.nickname);
    const password = validatePassword(body.password);
    createUser(nickname, password);
    sendJson(response, 200, { user: { nickname }, state: getUserState(nickname) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(request);
    const nickname = validateNickname(body.nickname);
    const password = validatePassword(body.password);
    loginUser(nickname, password);
    sendJson(response, 200, { user: { nickname }, state: getUserState(nickname) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    const nickname = validateNickname(url.searchParams.get("nickname"));
    requireUser(nickname);
    sendJson(response, 200, { user: { nickname }, state: getUserState(nickname) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/collections") {
    const body = await readJson(request);
    const nickname = validateNickname(body.nickname);
    const source = body.source === "미션" ? "미션" : "일반";
    requireUser(nickname);
    addCollection({
      nickname,
      artworkId: String(body.artworkId || ""),
      source,
      dateKey: body.dateKey || null,
    });
    sendJson(response, 200, { state: getUserState(nickname) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/rewards/buy") {
    const body = await readJson(request);
    const nickname = validateNickname(body.nickname);
    requireUser(nickname);
    buyReward(nickname, String(body.artworkId || ""));
    sendJson(response, 200, { state: getUserState(nickname) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/rewards/install") {
    const body = await readJson(request);
    const nickname = validateNickname(body.nickname);
    requireUser(nickname);
    installReward(nickname, String(body.artworkId || ""));
    sendJson(response, 200, { state: getUserState(nickname) });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

function getArtworks() {
  return db
    .prepare("SELECT * FROM artworks ORDER BY premium ASC, title ASC")
    .all()
    .map(normalizeArtwork);
}

function getMuseums() {
  return db
    .prepare("SELECT * FROM museums ORDER BY scope ASC, name ASC")
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      scope: row.scope,
      city: row.city,
      tags: JSON.parse(row.tags),
    }));
}

function getPosts(museumId) {
  const statement = museumId
    ? db.prepare("SELECT * FROM posts WHERE museum_id = ? ORDER BY created_at DESC")
    : db.prepare("SELECT * FROM posts ORDER BY created_at DESC");
  const rows = museumId ? statement.all(museumId) : statement.all();
  return rows.map(normalizePost);
}

function getUserState(nickname) {
  const user = db.prepare("SELECT * FROM users WHERE nickname = ?").get(nickname);
  const collections = db
    .prepare("SELECT artwork_id, source, date_key, created_at FROM collections WHERE nickname = ? ORDER BY created_at DESC")
    .all(nickname)
    .map((row) => ({
      artworkId: row.artwork_id,
      source: row.source,
      dateKey: row.date_key,
      createdAt: row.created_at,
    }));
  const purchases = db.prepare("SELECT artwork_id FROM purchases WHERE nickname = ? ORDER BY created_at DESC").all(nickname);

  return {
    points: user?.points ?? 0,
    installedRewardId: user?.installed_reward_id || null,
    collection: collections.filter((entry) => entry.source === "일반"),
    missionCollection: collections.filter((entry) => entry.source === "미션"),
    purchases: purchases.map((row) => row.artwork_id),
  };
}

function normalizeArtwork(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    year: row.year,
    origin: row.origin,
    period: row.period,
    region: row.region,
    category: JSON.parse(row.category),
    tags: JSON.parse(row.tags),
    palette: JSON.parse(row.palette),
    image: row.image,
    premium: Boolean(row.premium),
    cost: row.cost,
  };
}

function normalizePost(row) {
  return {
    id: row.id,
    author: row.author,
    title: row.title,
    body: row.body,
    museumId: row.museum_id,
    artworkId: row.artwork_id,
    createdAt: row.created_at,
    likes: row.likes,
  };
}

function createUser(nickname, password) {
  const { salt, hash } = hashPassword(password);
  const existing = db.prepare("SELECT nickname, password_hash FROM users WHERE nickname = ?").get(nickname);
  if (existing?.password_hash) throw new Error("nickname_taken");

  if (existing) {
    db.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE nickname = ?").run(hash, salt, nickname);
    return;
  }

  db.prepare("INSERT INTO users (nickname, password_hash, password_salt, points, created_at) VALUES (?, ?, ?, 40, ?)")
    .run(nickname, hash, salt, new Date().toISOString());
}

function loginUser(nickname, password) {
  const user = db.prepare("SELECT nickname, password_hash, password_salt FROM users WHERE nickname = ?").get(nickname);
  if (!user) throw new Error("login_failed");
  if (!user.password_hash || !user.password_salt) throw new Error("password_required");
  if (!verifyPassword(password, user.password_salt, user.password_hash)) throw new Error("login_failed");
}

function requireUser(nickname) {
  const user = db.prepare("SELECT nickname FROM users WHERE nickname = ?").get(nickname);
  if (!user) throw new Error("login_required");
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = Buffer.from(scryptSync(password, salt, 32).toString("hex"), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function addCollection({ nickname, artworkId, source, dateKey }) {
  const artwork = db.prepare("SELECT id, premium FROM artworks WHERE id = ?").get(artworkId);
  if (!artwork || artwork.premium) throw new Error("invalid_artwork");

  const existing = db
    .prepare(
      `SELECT id FROM collections
       WHERE nickname = ? AND artwork_id = ? AND source = ? AND COALESCE(date_key, '') = COALESCE(?, '')`,
    )
    .get(nickname, artworkId, source, dateKey);

  if (existing) return;

  db.prepare("INSERT INTO collections (nickname, artwork_id, source, date_key, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(nickname, artworkId, source, dateKey, new Date().toISOString());
  db.prepare("UPDATE users SET points = points + ? WHERE nickname = ?").run(source === "미션" ? 80 : 12, nickname);
}

function buyReward(nickname, artworkId) {
  const artwork = db.prepare("SELECT id, cost, premium FROM artworks WHERE id = ?").get(artworkId);
  if (!artwork || !artwork.premium) throw new Error("invalid_reward");

  const existing = db.prepare("SELECT artwork_id FROM purchases WHERE nickname = ? AND artwork_id = ?").get(nickname, artworkId);
  if (existing) {
    installReward(nickname, artworkId);
    return;
  }

  const user = db.prepare("SELECT points FROM users WHERE nickname = ?").get(nickname);
  if (!user || user.points < artwork.cost) throw new Error("not_enough_points");

  db.prepare("UPDATE users SET points = points - ?, installed_reward_id = ? WHERE nickname = ?")
    .run(artwork.cost, artworkId, nickname);
  db.prepare("INSERT INTO purchases (nickname, artwork_id, created_at) VALUES (?, ?, ?)")
    .run(nickname, artworkId, new Date().toISOString());
}

function installReward(nickname, artworkId) {
  const existing = db.prepare("SELECT artwork_id FROM purchases WHERE nickname = ? AND artwork_id = ?").get(nickname, artworkId);
  if (!existing) throw new Error("reward_not_owned");
  db.prepare("UPDATE users SET installed_reward_id = ? WHERE nickname = ?").run(artworkId, nickname);
}

function createPost(body) {
  const author = validateNickname(body.author);
  requireUser(author);
  const title = String(body.title || "").trim().slice(0, 36);
  const postBody = String(body.body || "").trim().slice(0, 240);
  const museumId = String(body.museumId || "");
  const artworkId = String(body.artworkId || "");

  if (!title || !postBody) throw new Error("missing_post_content");
  if (!db.prepare("SELECT id FROM museums WHERE id = ?").get(museumId)) throw new Error("invalid_museum");
  if (!db.prepare("SELECT id FROM artworks WHERE id = ?").get(artworkId)) throw new Error("invalid_artwork");

  const post = {
    id: randomUUID(),
    author,
    title,
    body: postBody,
    museumId,
    artworkId,
    createdAt: new Date().toISOString(),
    likes: 0,
  };

  db.prepare("INSERT INTO posts (id, author, title, body, museum_id, artwork_id, created_at, likes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(post.id, post.author, post.title, post.body, post.museumId, post.artworkId, post.createdAt, post.likes);

  return post;
}

function validateNickname(value) {
  const nickname = String(value || "").trim();
  if (!nickname || [...nickname].length > 7) throw new Error("invalid_nickname");
  return nickname;
}

function validatePassword(value) {
  const password = String(value || "");
  if (!password || password.length < 4 || password.length > 64) throw new Error("invalid_password");
  return password;
}

function statusForError(error) {
  const clientErrors = new Set([
    "invalid_nickname",
    "invalid_password",
    "invalid_artwork",
    "invalid_reward",
    "invalid_museum",
    "missing_post_content",
    "not_enough_points",
    "reward_not_owned",
  ]);
  if (error.message === "nickname_taken") return 409;
  if (["login_failed", "password_required", "login_required"].includes(error.message)) return 401;
  if (clientErrors.has(error.message)) return 400;
  return 500;
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function serveStatic(response, url) {
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  let filePath = resolve(root, requested || "index.html");

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = resolve(root, "index.html");
  }

  response.writeHead(200, {
    "Content-Type": types[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
}
