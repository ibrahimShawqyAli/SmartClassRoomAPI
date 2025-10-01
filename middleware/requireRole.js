// middleware/requireRole.js
/**
 * Usage:
 *   const requireRole = require("./requireRole");
 *   router.post("/admin-task", auth, requireRole("admin"), handler);
 *   router.post("/staff-task", auth, requireRole("admin", "staff"), handler);
 *
 * Assumes auth middleware sets: req.auth.role (string)
 */
module.exports = function requireRole(...allowedRoles) {
  if (!allowedRoles || allowedRoles.length === 0) {
    throw new Error("requireRole: you must pass at least one allowed role");
  }

  // Normalize roles to lowercase strings
  const allow = new Set(allowedRoles.map((r) => String(r).toLowerCase()));

  return (req, res, next) => {
    const role = req?.auth?.role;
    if (!role) {
      return res.status(403).json({ status: false, error: "No role on token" });
    }

    const has = allow.has(String(role).toLowerCase());
    if (!has) {
      return res.status(403).json({ status: false, error: "Forbidden" });
    }

    return next();
  };
};
