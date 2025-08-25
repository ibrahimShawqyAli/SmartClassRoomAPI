// routes/adminOps.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

/**
 * POST /admin/reset-udid
 * Body: { email }
 *
 * Behavior:
 * - Finds the user by email.
 * - Deletes any rows from dbo.devices for that user (effectively unbinding UDID).
 * Permissions:
 * - Admins can reset any user.
 * - A user can reset their own UDID (email must match their account).
 */
router.post("/reset-udid", auth, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res
        .status(400)
        .json({ status: false, error: "email is required" });
    }

    // 1) find the user by email
    const u = await query("SELECT id, email FROM dbo.users WHERE email=@p0", [
      email,
    ]);
    if (!u.recordset.length) {
      return res.status(404).json({ status: false, error: "User not found" });
    }
    const target = u.recordset[0];

    // 2) permission: admin OR same user
    if (req.user.role !== "admin" && req.user.id !== target.id) {
      return res.status(403).json({ status: false, error: "Forbidden" });
    }

    // 3) remove device bindings for this user
    const del = await query(
      "DELETE FROM dbo.devices WHERE user_id=@p0; SELECT @@ROWCOUNT AS removed;",
      [target.id]
    );

    return res.json({
      status: true,
      message: "UDID reset successfully",
      removed: del.recordset[0].removed, // number of device rows removed
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
 * Behavior:
 * - Updates dbo.lectures.modulation_string.
 * Permissions:
 * - Admins always allowed.
 * - Teachers only if they are assigned to that lecture as 'teacher'.
 */
router.post("/set-modulation", auth, async (req, res) => {
  try {
    const { lecture_id, modulation_string } = req.body || {};
    if (!lecture_id || typeof modulation_string !== "string") {
      return res.status(400).json({
        status: false,
        error: "lecture_id and modulation_string are required",
      });
    }

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
    if (req.user.role !== "admin") {
      const a = await query(
        `SELECT 1 FROM dbo.lecture_assignments
         WHERE lecture_id=@p0 AND user_id=@p1 AND role='teacher'`,
        [lecture_id, req.user.id]
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
      [lecture_id, modulation_string.trim()]
    );

    if (!up.recordset[0].affected) {
      return res.status(500).json({ status: false, error: "Update failed" });
    }

    return res.json({
      status: true,
      lecture_id,
      modulation_string: modulation_string.trim(),
      message: "modulation_string updated",
    });
  } catch (e) {
    console.error("set-modulation error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
