const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { query } = require("../DB/dbConnection");
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth");
// POST /auth/register
router.post("/register", async (req, res) => {
  try {
    const { name, email, department, level, section, group_name, role } =
      req.body;

    if (!name || !email || !role) {
      return res
        .status(400)
        .json({ status: false, error: "Missing required fields" });
    }

    if (!["student", "teacher"].includes(role)) {
      return res
        .status(400)
        .json({ status: false, error: "Role must be student or teacher" });
    }

    // hash default password "123456"
    const passwordHash = await bcrypt.hash("123456", 10);

    const sql = `
      INSERT INTO dbo.users
      (name, email, password_hash, department, [level], [section], group_name, role, force_password_change)
      OUTPUT INSERTED.id
      VALUES (@p0, @p1, @p2, @p3, @p4, @p5, @p6, @p7, 1)
    `;

    const result = await query(sql, [
      name,
      email,
      passwordHash,
      department || null,
      level || null,
      section || null,
      group_name || null,
      role,
    ]);

    return res.json({
      status: true,
      userId: result.recordset[0].id,
      message: "User registered successfully (default password = 123456)",
    });
  } catch (err) {
    console.error("Register error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password, udid } = req.body;

    if (!email || !password || !udid) {
      return res
        .status(400)
        .json({ status: false, error: "Missing email, password, or udid" });
    }

    // 1) Find user
    const userSql = "SELECT * FROM dbo.users WHERE email=@p0";
    const result = await query(userSql, [email]);
    if (result.recordset.length === 0) {
      return res
        .status(401)
        .json({ status: false, error: "Invalid credentials" });
    }
    const user = result.recordset[0];

    // 2) Verify password
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res
        .status(401)
        .json({ status: false, error: "Invalid credentials" });
    }

    // 3) Check/bind device
    const devRes = await query(
      "SELECT udid FROM dbo.devices WHERE user_id=@p0",
      [user.id]
    );
    if (devRes.recordset.length === 0) {
      await query("INSERT INTO dbo.devices (user_id, udid) VALUES (@p0,@p1)", [
        user.id,
        udid,
      ]);
    } else if (devRes.recordset[0].udid !== udid) {
      return res
        .status(403)
        .json({ status: false, error: "Device mismatch for this user" });
    }

    // 4) Generate JWT (valid 1 year)
    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET || "supersecret",
      { expiresIn: "365d" }
    );

    // 5) Fetch assigned lectures for this user (grouped by weekday)
    const lecSql = `
      SELECT
        l.day_of_week,
        l.id  AS lecture_id,
        l.name, l.place,
        l.start_date,
        CONVERT(VARCHAR(8), l.start_time, 108) AS start_time,  -- "HH:mm:ss"
        CONVERT(VARCHAR(8), l.end_time,   108) AS end_time,    -- "HH:mm:ss"
        l.duration_minutes,
        la.role
      FROM dbo.lecture_assignments la
      JOIN dbo.lectures l ON l.id = la.lecture_id
      WHERE la.user_id = @p0
      ORDER BY l.day_of_week, l.start_time, l.place, l.id;
    `;
    const assigned = await query(lecSql, [user.id]);

    // Build week buckets 0..6
    const week = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    for (const row of assigned.recordset) {
      week[String(row.day_of_week)].push({
        lecture_id: row.lecture_id,
        name: row.name,
        place: row.place,
        start_date: row.start_date, // first calendar date
        start_time: row.start_time, // "HH:mm:ss"
        end_time: row.end_time, // "HH:mm:ss"
        duration_minutes: row.duration_minutes,
        role: row.role, // 'student' or 'teacher'
      });
    }

    // 6) Return success + schedule
    return res.json({
      status: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        department: user.department,
        level: user.level,
        section: user.section,
        group_name: user.group_name,
        role: user.role,
      },
      assigned_schedule: {
        totals: Object.fromEntries(
          Object.keys(week).map((k) => [k, week[k].length])
        ),
        week,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ status: false, error: "Login failed" });
  }
});

/**
 * POST /auth/password/reset
 * Body: { email, udid, new_password? }
 * - If new_password is missing: only verify email+udid match -> { status: true } if OK
 * - If new_password present: update user's password -> { status: true, message: "Password updated" }
 */
router.post("/password/reset", async (req, res) => {
  try {
    const { email, udid, new_password } = req.body || {};

    if (!email || !udid) {
      return res
        .status(400)
        .json({ status: false, error: "email and udid are required" });
    }

    // 1) Find user by email
    const u = await query(`SELECT TOP 1 * FROM dbo.users WHERE email=@p0`, [
      email,
    ]);
    if (!u.recordset.length) {
      return res.status(404).json({ status: false, error: "User not found" });
    }
    const user = u.recordset[0];

    // 2) Check device bound to this user & matches UDID
    const d = await query(
      `SELECT TOP 1 * FROM dbo.devices WHERE user_id=@p0 AND udid=@p1`,
      [user.id, udid]
    );
    if (!d.recordset.length) {
      return res.status(403).json({
        status: false,
        error: "Device mismatch or no device bound for this user",
      });
    }

    // 3) If no new_password -> verify-only success
    if (!new_password) {
      return res.json({ status: true, message: "Email/UDID verified" });
    }

    // (Optional) enforce a simple password policy
    if (typeof new_password !== "string" || new_password.length < 6) {
      return res.status(400).json({
        status: false,
        error: "new_password must be at least 6 characters",
      });
    }

    // 4) Hash and update password
    const hash = await bcrypt.hash(new_password, 10);
    await query(
      `UPDATE dbo.users
         SET password_hash=@p0,
             force_password_change=0,
             updated_at=SYSUTCDATETIME()
       WHERE id=@p1`,
      [hash, user.id]
    );

    return res.json({ status: true, message: "Password updated" });
  } catch (err) {
    console.error("password reset error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to reset password" });
  }
});
/**
 * POST /auth/change-password
 * Header: Authorization: Bearer <JWT>
 * Body: { old_password, new_password }
 */
router.post("/change-password", auth, async (req, res) => {
  try {
    const { old_password, new_password } = req.body || {};

    // basic checks
    if (!old_password || !new_password) {
      return res.status(400).json({
        status: false,
        error: "old_password and new_password are required",
      });
    }
    if (new_password.length < 6) {
      return res.status(400).json({
        status: false,
        error: "new_password must be at least 6 characters",
      });
    }

    // 1) get current hash for this user (from token)
    const u = await query(
      "SELECT id, password_hash FROM dbo.users WHERE id=@p0",
      [req.user.id]
    );
    if (u.recordset.length === 0) {
      return res.status(404).json({ status: false, error: "User not found" });
    }

    // 2) verify old password
    const ok = await bcrypt.compare(old_password, u.recordset[0].password_hash);
    if (!ok) {
      return res
        .status(401)
        .json({ status: false, error: "Old password is incorrect" });
    }

    // 3) hash new password & update
    const newHash = await bcrypt.hash(new_password, 10);
    await query(
      `UPDATE dbo.users
         SET password_hash=@p1, updated_at = SYSUTCDATETIME()
       WHERE id=@p0`,
      [req.user.id, newHash]
    );

    return res.json({ status: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("change-password error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to change password" });
  }
});
module.exports = router;
