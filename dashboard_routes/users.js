const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");
const { parsePaging } = require("../utils/paging");

// simple admin gate
function requireAdmin(req, res, next) {
  if ((req.user?.role || "").toLowerCase() !== "admin") {
    return res.status(403).json({ status: false, error: "Admin only" });
  }
  next();
}

/**
 * POST /dashboard/users
 * Body:
 * {
 *   name: string,
 *   email: string,
 *   role: "student" | "teacher" | "assistant" | "admin",
 *   department?: string,
 *   level?: string,
 *   section?: string,
 *   group_name?: string,
 *   password?: string,                // defaults to "123456"
 *   force_password_change?: boolean   // defaults to true
 * }
 */
router.post("/", auth, requireAdmin, async (req, res) => {
  try {
    const {
      name,
      email,
      role,
      department,
      level,
      section,
      group_name,
      password,
      force_password_change,
    } = req.body || {};

    // basic validation
    if (!name || !email || !role) {
      return res.status(400).json({
        status: false,
        error: "name, email and role are required",
      });
    }

    const allowedRoles = new Set(["student", "teacher", "assistant", "admin"]);
    if (!allowedRoles.has(String(role).toLowerCase())) {
      return res.status(400).json({ status: false, error: "Invalid role" });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
      return res.status(400).json({ status: false, error: "Invalid email" });
    }

    const rawPassword =
      password && String(password).length >= 6 ? String(password) : "123456";
    const hash = await bcrypt.hash(rawPassword, 10);
    const fpc = force_password_change === false ? 0 : 1; // default true

    const sql = `
      INSERT INTO dbo.users
        (name, email, password_hash, department, [level], [section], group_name, role, force_password_change, created_at, updated_at)
      OUTPUT INSERTED.id
      VALUES
        (@p0, @p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8, SYSUTCDATETIME(), SYSUTCDATETIME());
    `;

    const r = await query(sql, [
      name,
      cleanEmail,
      hash,
      department || null,
      level || null,
      section || null,
      group_name || null,
      String(role).toLowerCase(),
      fpc,
    ]);

    return res.json({
      status: true,
      id: r.recordset[0].id,
      message:
        fpc === 1
          ? "User created (default password set; user must change it on first login)"
          : "User created",
      default_password_used: rawPassword === "123456",
    });
  } catch (e) {
    // duplicate email, unique constraint
    if (e.number === 2627 || e.number === 2601) {
      return res
        .status(409)
        .json({ status: false, error: "Email already exists" });
    }
    console.error("Create user error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * GET /dashboard/users
 * Query: ?page=1&limit=20&search=ali&role=student
 */
router.get("/", auth, requireAdmin, async (req, res) => {
  try {
    const { page, limit, search } = parsePaging(req.query);
    const role = (req.query.role || "").trim(); // optional exact filter

    // dynamic WHERE with parameters
    const filters = [];
    const params = [];

    if (search) {
      filters.push(
        "(u.name LIKE @p0 OR u.email LIKE @p0 OR u.department LIKE @p0)"
      );
      params.push(`%${search}%`);
    }
    if (role) {
      filters.push("u.role = @p" + params.length);
      params.push(role);
    }

    const where = filters.length ? "WHERE " + filters.join(" AND ") : "";

    // total count (for UI pagination)
    const countSql = `
      SELECT COUNT(*) AS total
      FROM dbo.users u
      ${where};
    `;
    const countRes = await query(countSql, params);
    const total = countRes.recordset[0].total;

    // data page
    const offset = (page - 1) * limit;

    const dataSql = `
      SELECT u.id, u.name, u.email, u.role, u.department, u.[level], u.[section], u.group_name
      FROM dbo.users u
      ${where}
      ORDER BY u.name ASC, u.id ASC
      OFFSET @p${params.length} ROWS
      FETCH NEXT @p${params.length + 1} ROWS ONLY;
    `;
    const dataParams = [...params, offset, limit];
    const dataRes = await query(dataSql, dataParams);

    return res.json({
      status: true,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      data: dataRes.recordset,
    });
  } catch (e) {
    console.error("users list error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * GET /dashboard/users/:id
 */
router.get("/:id", auth, requireAdmin, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, name, email, role, department, [level], [section], group_name
       FROM dbo.users WHERE id=@p0`,
      [req.params.id]
    );
    if (!r.recordset.length) {
      return res.status(404).json({ status: false, error: "User not found" });
    }
    res.json({ status: true, user: r.recordset[0] });
  } catch (e) {
    console.error("get user error:", e);
    res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * PATCH /dashboard/users/:id
 * (your existing updater, kept as-is with minor guard)
 */
router.patch("/:id", auth, requireAdmin, async (req, res) => {
  try {
    const { role, department, level, section, group_name } = req.body || {};

    // Only update provided fields
    const sets = [];
    const params = [req.params.id]; // @p0 is id

    const push = (sqlFrag, value) => {
      sets.push(sqlFrag.replace("{{idx}}", params.length));
      params.push(value);
    };

    if (role !== undefined) {
      const allowed = new Set(["student", "teacher", "assistant", "admin"]);
      if (!allowed.has(String(role))) {
        return res.status(400).json({ status: false, error: "Invalid role" });
      }
      push(`role = @p{{idx}}`, role);
    }
    if (department !== undefined) push(`[department] = @p{{idx}}`, department);
    if (level !== undefined) push(`[level] = @p{{idx}}`, level);
    if (section !== undefined) push(`[section] = @p{{idx}}`, section);
    if (group_name !== undefined) push(`[group_name] = @p{{idx}}`, group_name);

    if (!sets.length) {
      return res
        .status(400)
        .json({ status: false, error: "No fields to update" });
    }

    const sql = `
      UPDATE dbo.users
         SET ${sets.join(", ")},
             updated_at = SYSUTCDATETIME()
       WHERE id = @p0;
      SELECT @@ROWCOUNT AS affected;
    `;
    const r = await query(sql, params);

    if (!r.recordset[0].affected) {
      return res
        .status(404)
        .json({ status: false, error: "User not found or no changes" });
    }

    return res.json({ status: true, message: "User updated" });
  } catch (e) {
    console.error("users update error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * DELETE /dashboard/users/:id
 * Hard delete. If you prefer soft delete, add an is_active flag instead.
 */
router.delete("/:id", auth, requireAdmin, async (req, res) => {
  try {
    const r = await query(
      `DELETE FROM dbo.users WHERE id=@p0; SELECT @@ROWCOUNT AS affected;`,
      [req.params.id]
    );
    if (!r.recordset[0].affected) {
      return res.status(404).json({ status: false, error: "User not found" });
    }
    res.json({ status: true, message: "User deleted" });
  } catch (e) {
    // FK references (attendance, assignments) may block deletes
    if (e.number === 547) {
      return res.status(409).json({
        status: false,
        error:
          "User is referenced by other records (assignments/attendance). Remove those first or implement soft delete.",
      });
    }
    console.error("delete user error:", e);
    res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
