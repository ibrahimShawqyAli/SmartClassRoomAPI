// middleware/auth.js
const jwt = require("jsonwebtoken");
const SECRET = process.env.JWT_SECRET || "supersecret";

function extractBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  return h;
}

module.exports = function auth(req, res, next) {
  try {
    const rawAuth = extractBearer(req);
    console.log("[AUTH] header:", rawAuth || "(none)");

    if (!rawAuth) {
      console.log("[AUTH] no Authorization header");
      return res
        .status(401)
        .json({ status: false, error: "No token provided" });
    }

    const parts = rawAuth.trim().split(/\s+/);
    if (!(parts.length === 2 && /^Bearer$/i.test(parts[0]))) {
      console.log("[AUTH] malformed header (expect 'Bearer <token>')");
      return res
        .status(401)
        .json({ status: false, error: "No token provided" });
    }

    const token = parts[1];
    const decoded = jwt.verify(token, SECRET, { clockTolerance: 30 });

    const id = typeof decoded.id === "string" ? Number(decoded.id) : decoded.id;
    const role = (decoded.role || "").toString().toLowerCase();

    req.auth = { id, role, raw: decoded };
    req.user = { id, role };

    console.log("[AUTH] ok ->", req.user);
    return next();
  } catch (err) {
    console.error("[AUTH] error:", err?.name, err?.message);
    return res
      .status(err?.name === "TokenExpiredError" ? 401 : 403)
      .json({ status: false, error: "Invalid or expired token" });
  }
};
