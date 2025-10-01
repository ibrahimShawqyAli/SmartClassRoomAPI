const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { query } = require("../DB/dbConnection");
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth");
const { buildAssignedSchedule } = require("../utils/buildSchedule");
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";
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

    if (!["student", "teacher", "assistant", "admin"].includes(role)) {
      return res.status(400).json({
        status: false,
        error: "Role must be student, teacher, assistant, or admin",
      });
    }

    // hash default password
    const defaultPw = process.env.DEFAULT_PW || "123456";
    const passwordHash = await bcrypt.hash(defaultPw, 10);

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
      message: `User registered successfully (default password = ${defaultPw})`,
    });
  } catch (err) {
    console.error("Register error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Registration failed" });
  }
});

// POST /auth/login

router.post("/login", async (req, res) => {
  try {
    const { email, password, udid } = req.body || {};

    if (!email || !password) {
      return res
        .status(400)
        .json({ status: false, error: "Missing email or password" });
    }

    // 1) Find user
    const userSql = `SELECT * FROM dbo.users WHERE email=@p0`;
    const ures = await query(userSql, [email]);
    if (!ures.recordset.length) {
      return res
        .status(401)
        .json({ status: false, error: "Invalid credentials" });
    }
    const user = ures.recordset[0];

    // 2) Verify password (bcrypt hash stored in users.password_hash)
    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return res
        .status(401)
        .json({ status: false, error: "Invalid credentials" });
    }

    // 3) Device binding policy
    if (String(user.role).toLowerCase() === "admin") {
      // Admin: UDID optional; upsert if provided (non-fatal if fails)
      if (udid) {
        try {
          await query(
            `IF EXISTS (SELECT 1 FROM dbo.devices WHERE user_id=@p0)
               UPDATE dbo.devices SET udid=@p1 WHERE user_id=@p0
             ELSE
               INSERT INTO dbo.devices (user_id, udid) VALUES (@p0, @p1);`,
            [user.id, udid]
          );
        } catch (e) {
          console.warn("admin device bind warning:", e?.message || e);
        }
      }
    } else {
      // Non-admins must provide UDID
      if (!udid) {
        return res
          .status(400)
          .json({ status: false, error: "Missing udid for this account" });
      }
      const dev = await query(
        `SELECT udid FROM dbo.devices WHERE user_id=@p0`,
        [user.id]
      );
      if (!dev.recordset.length) {
        // first login → bind
        await query(
          `INSERT INTO dbo.devices (user_id, udid) VALUES (@p0, @p1)`,
          [user.id, udid]
        );
      } else if (dev.recordset[0].udid !== udid) {
        return res
          .status(403)
          .json({ status: false, error: "Device mismatch for this user" });
      }
    }

    // 4) Issue JWT (1 year)
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
      expiresIn: "365d",
    });

    // 5) Build assigned schedule (works with legacy or new schema)
    const assigned_schedule = await buildAssignedSchedule(user.id);

    // 6) Respond
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
      assigned_schedule,
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ status: false, error: "Login failed" });
  }
});

// POST /auth/password/reset
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

    if (!new_password) {
      return res.json({ status: true, message: "Email/UDID verified" });
    }
    if (typeof new_password !== "string" || new_password.length < 6) {
      return res.status(400).json({
        status: false,
        error: "new_password must be at least 6 characters",
      });
    }

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

// POST /auth/change-password
router.post("/change-password", auth, async (req, res) => {
  try {
    console.log("change-password body:", req.body); // <— TEMP
    console.log("change-password user:", req.user); // <— TEMP

    if (!req.user || !req.user.id) {
      return res.status(401).json({ status: false, error: "Unauthorized" });
    }
    const { old_password, new_password } = req.body || {};
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

    const u = await query(
      "SELECT id, password_hash FROM dbo.users WHERE id=@p0",
      [req.user.id]
    );
    if (!u.recordset.length)
      return res.status(404).json({ status: false, error: "User not found" });

    const ok = await bcrypt.compare(old_password, u.recordset[0].password_hash);
    if (!ok)
      return res
        .status(401)
        .json({ status: false, error: "Old password is incorrect" });

    const newHash = await bcrypt.hash(new_password, 10);
    await query(
      `UPDATE dbo.users SET password_hash=@p1, updated_at = SYSUTCDATETIME() WHERE id=@p0`,
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
