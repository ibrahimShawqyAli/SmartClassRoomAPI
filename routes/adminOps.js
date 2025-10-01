const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

// helper to read user/role from either req.auth or req.user
function getReqUser(req) {
  const src = req.auth || req.user || {};
  return { id: src.id, role: (src.role || "").toLowerCase(), email: src.email };
}

/**
 * POST /admin/reset-udid
 * Body: { email }
 *
 * Admins can reset anyone. A user can reset their own UDID.
 */
router.post("/reset-udid", auth, async (req, res) => {
  try {
    const { id: requesterId, role: requesterRole } = getReqUser(req);

    let { email } = req.body || {};
    if (typeof email !== "string" || !email.trim()) {
      return res
        .status(400)
        .json({ status: false, error: "email is required" });
    }
    email = email.trim();

    // 1) find the user by email (case-insensitive)
    const u = await query(
      "SELECT id, email FROM dbo.users WHERE LOWER(email)=LOWER(@p0)",
      [email]
    );
    if (!u.recordset.length) {
      return res.status(404).json({ status: false, error: "User not found" });
    }
    const target = u.recordset[0];

    // 2) permission: admin OR same user
    const isAdmin = requesterRole === "admin";
    const isSelf = requesterId === target.id;
    if (!isAdmin && !isSelf) {
      return res.status(403).json({ status: false, error: "Forbidden" });
    }

    // 3) remove device bindings for this user
    const del = await query(
      "DELETE FROM dbo.devices WHERE user_id=@p0; SELECT @@ROWCOUNT AS removed;",
      [target.id]
    );
    // Alternative (without SELECT): const removed = del.rowsAffected?.[0] || 0;

    return res.json({
      status: true,
      message: "UDID reset successfully",
      removed: del.recordset[0].removed,
      user_id: target.id,
      email: target.email,
    });
  } catch (e) {
    console.error("reset-udid error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * POST /admin/set-modulation
 * Body: { lecture_id, modulation_string }
 *
 * Admins always allowed.
 * Teachers only if assigned to that lecture as 'teacher'.
 */
router.post("/set-modulation", auth, async (req, res) => {
  try {
    const { id: requesterId, role: requesterRole } = getReqUser(req);

    const { lecture_id, modulation_string } = req.body || {};
    if (
      !Number.isInteger(lecture_id) ||
      typeof modulation_string !== "string"
    ) {
      return res.status(400).json({
        status: false,
        error: "lecture_id (int) and modulation_string (string) are required",
      });
    }

    const mod = modulation_string.trim();
    if (!mod) {
      return res
        .status(400)
        .json({ status: false, error: "modulation_string cannot be empty" });
    }
    // Optional: enforce only 0/1 and a sensible length (uncomment if needed)
    // if (!/^[01]{4,64}$/.test(mod)) {
    //   return res.status(400).json({ status: false, error: "modulation_string must be 0/1 only (len 4..64)" });
    // }

    // 1) ensure lecture exists
    const lec = await query("SELECT id FROM dbo.lectures WHERE id=@p0", [
      lecture_id,
    ]);
    if (!lec.recordset.length) {
      return res
        .status(404)
        .json({ status: false, error: "Lecture not found" });
    }

    // 2) permissions: admin OR assigned teacher
    if (requesterRole !== "admin") {
      const a = await query(
        `SELECT TOP 1 1
           FROM dbo.lecture_assignments
          WHERE lecture_id=@p0 AND user_id=@p1 AND LOWER(role)='teacher'`,
        [lecture_id, requesterId]
      );
      if (!a.recordset.length) {
        return res.status(403).json({
          status: false,
          error: "Only assigned teacher or admin can change modulation_string",
        });
      }
    }

    // 3) update
    const up = await query(
      `UPDATE dbo.lectures
          SET modulation_string=@p1
        WHERE id=@p0;
        SELECT @@ROWCOUNT AS affected;`,
      [lecture_id, mod]
    );

    if (!up.recordset[0].affected) {
      return res.status(500).json({ status: false, error: "Update failed" });
    }

    return res.json({
      status: true,
      lecture_id,
      modulation_string: mod,
      message: "modulation_string updated",
    });
  } catch (e) {
    console.error("set-modulation error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
