// helpers/requireAdmin.js
const jwt = require("jsonwebtoken");
const SECRET = process.env.JWT_SECRET || "supersecret";

module.exports = function requireAdmin(req, res, next) {
  try {
    // Always decode directly from the header (reliable)
    const hdr = req.headers.authorization || req.headers.Authorization || "";
    const parts = hdr.trim().split(/\s+/);
    if (parts.length !== 2 || !/^Bearer$/i.test(parts[0])) {
      return res.status(401).json({ status: false, error: "Unauthorized" });
    }
    const token = parts[1];

    const decoded = jwt.verify(token, SECRET, { clockTolerance: 30 });
    const id = typeof decoded.id === "string" ? Number(decoded.id) : decoded.id;
    const role = (decoded.role || "").toString().toLowerCase();

    if (role !== "admin") {
      return res.status(403).json({ status: false, error: "Admin only" });
    }

    // Ensure downstream middlewares/handlers can use it
    req.user = req.user || { id, role };
    req.auth = req.auth || { id, role, raw: decoded };
    return next();
  } catch (e) {
    console.error("requireAdmin error:", e?.message || e);
    return res.status(401).json({ status: false, error: "Unauthorized" });
  }
};
