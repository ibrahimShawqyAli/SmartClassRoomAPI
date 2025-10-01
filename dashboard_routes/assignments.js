// dashboard_routes/assignments.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");
const { parsePaging } = require("../utils/paging");

// Admin gate
function requireAdmin(req, res, next) {
  if ((req.user?.role || "").toLowerCase() !== "admin") {
    return res.status(403).json({ status: false, error: "Admin only" });
  }
  next();
}

/**
 * POST /dashboard/assignments
 * Body: { offering_id, user_id, role }   role in: student|teacher|assistant
 * - Validates offering & user exist
 * - Prevents duplicates (unique on offering_id + user_id)
 */
router.post("/", auth, requireAdmin, async (req, res) => {
  try {
    const { offering_id, user_id, role } = req.body || {};
    const allowed = new Set(["student", "teacher", "assistant"]);
    if (!offering_id || !user_id || !role || !allowed.has(String(role))) {
      return res.status(400).json({
        status: false,
        error:
          "offering_id, user_id and role are required. role must be student|teacher|assistant",
      });
    }

    // Validate offering
    const off = await query(
      "SELECT id FROM dbo.course_offerings WHERE id=@p0",
      [offering_id]
    );
    if (!off.recordset.length) {
      return res
        .status(404)
        .json({ status: false, error: "Offering not found" });
    }

    // Validate user
    const usr = await query(
      "SELECT id, role AS user_role FROM dbo.users WHERE id=@p0",
      [user_id]
    );
    if (!usr.recordset.length) {
      return res.status(404).json({ status: false, error: "User not found" });
    }

    // Insert
    const sql = `
      INSERT INTO dbo.offering_assignments (offering_id, user_id, role)
      OUTPUT INSERTED.id
      VALUES (@p0, @p1, @p2)
    `;
    const r = await query(sql, [offering_id, user_id, String(role)]);

    return res.json({
      status: true,
      id: r.recordset[0].id,
      message: "User assigned to offering",
    });
  } catch (err) {
    // duplicate unique key (offering_id, user_id)
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({
        status: false,
        error: "User already assigned to this offering",
      });
    }
    // FK error
    if (err.number === 547) {
      return res
        .status(400)
        .json({ status: false, error: "Invalid offering_id or user_id" });
    }
    console.error("assign create error:", err);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * GET /dashboard/assignments
 * Query:
 *   ?offering_id=123      (required)
 *   &role=teacher         (optional: student|teacher|assistant)
 *   &search=ali           (optional: name/email contains)
 *   &page=1&limit=20
 * Returns paginated list of users assigned to offering with their role
 */
router.get("/", auth, requireAdmin, async (req, res) => {
  try {
    const { page, limit, search } = parsePaging(req.query);
    const role = (req.query.role || "").trim().toLowerCase();

    // NOTE: treat "offering_id" as present whenever it exists in the querystring,
    // even if it's "0". Only ignore if it's truly missing.
    const hasOfferingId = Object.prototype.hasOwnProperty.call(
      req.query,
      "offering_id"
    );
    const offeringId = hasOfferingId ? Number(req.query.offering_id) : null;

    const assignedRaw = (req.query.assigned || "").toString().toLowerCase();
    const assigned =
      assignedRaw === "1" || assignedRaw === "true"
        ? 1
        : assignedRaw === "0" || assignedRaw === "false"
        ? 0
        : null;

    const filters = [];
    const params = [];

    if (search) {
      filters.push(
        "(u.name LIKE @p" +
          params.length +
          " OR u.email LIKE @p" +
          params.length +
          ")"
      );
      params.push(`%${search}%`);
    }
    if (role) {
      filters.push("LOWER(u.role) = @p" + params.length);
      params.push(role);
    }

    // Apply offering filter whenever offering_id was provided, even if it's 0.
    if (hasOfferingId && assigned === 1) {
      filters.push(
        "EXISTS (SELECT 1 FROM dbo.offering_assignments oa " +
          "WHERE oa.offering_id = @p" +
          params.length +
          " AND oa.user_id = u.id)"
      );
      params.push(offeringId);
    } else if (hasOfferingId && assigned === 0) {
      filters.push(
        "NOT EXISTS (SELECT 1 FROM dbo.offering_assignments oa " +
          "WHERE oa.offering_id = @p" +
          params.length +
          " AND oa.user_id = u.id)"
      );
      params.push(offeringId);
    }
    // If hasOfferingId && assigned === null → ignore offering filter (keeps old behavior)

    const where = filters.length ? "WHERE " + filters.join(" AND ") : "";

    // Count
    const countSql = `
      SELECT COUNT(*) AS total
      FROM dbo.users u
      ${where};
    `;
    const countRes = await query(countSql, params);
    const total = countRes.recordset[0].total;

    // Page
    const offset = (page - 1) * limit;
    const dataSql = `
      SELECT
        u.id, u.name, u.email, u.role, u.department, u.[level], u.[section], u.group_name
      FROM dbo.users u
      ${where}
      ORDER BY u.name ASC, u.id ASC
      OFFSET @p${params.length} ROWS
      FETCH NEXT @p${params.length + 1} ROWS ONLY;
    `;
    const dataRes = await query(dataSql, [...params, offset, limit]);

    res.json({
      status: true,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      data: dataRes.recordset,
    });
  } catch (e) {
    console.error("users list error:", e);
    res.status(500).json({ status: false, error: "Server error" });
  }
});
/**
 * PATCH /dashboard/assignments
 * Body: { offering_id, user_id, role, new_role }
 * - Changes the role for an existing assignment (e.g., assistant -> teacher)
 */
router.patch("/", auth, requireAdmin, async (req, res) => {
  try {
    const { offering_id, user_id, role, new_role } = req.body || {};
    const allowed = new Set(["student", "teacher", "assistant"]);

    if (!offering_id || !user_id || !role || !new_role) {
      return res.status(400).json({
        status: false,
        error: "offering_id, user_id, role and new_role are required",
      });
    }
    if (!allowed.has(String(role)) || !allowed.has(String(new_role))) {
      return res
        .status(400)
        .json({ status: false, error: "Invalid role/new_role" });
    }

    const sql = `
      UPDATE dbo.offering_assignments
         SET role = @p3
       WHERE offering_id=@p0 AND user_id=@p1 AND role=@p2;
      SELECT @@ROWCOUNT AS affected;
    `;
    const r = await query(sql, [
      offering_id,
      user_id,
      String(role),
      String(new_role),
    ]);

    if (!r.recordset[0].affected) {
      return res.status(404).json({
        status: false,
        error: "Assignment not found for given offering_id/user_id/role",
      });
    }

    return res.json({ status: true, message: "Assignment updated" });
  } catch (err) {
    console.error("assign update error:", err);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * DELETE /dashboard/assignments
 * Body: { offering_id, user_id, role? }
 * - If role omitted, unassign the user from the offering entirely
 * - If role provided, unassign only that role row
 */
router.delete("/", auth, requireAdmin, async (req, res) => {
  try {
    const { offering_id, user_id, role } = req.body || {};
    if (!offering_id || !user_id) {
      return res
        .status(400)
        .json({ status: false, error: "offering_id and user_id are required" });
    }

    let sql, params;
    if (role) {
      sql = `
        DELETE FROM dbo.offering_assignments
         WHERE offering_id=@p0 AND user_id=@p1 AND role=@p2;
        SELECT @@ROWCOUNT AS affected;
      `;
      params = [offering_id, user_id, String(role)];
    } else {
      sql = `
        DELETE FROM dbo.offering_assignments
         WHERE offering_id=@p0 AND user_id=@p1;
        SELECT @@ROWCOUNT AS affected;
      `;
      params = [offering_id, user_id];
    }

    const r = await query(sql, params);

    if (!r.recordset[0].affected) {
      return res
        .status(404)
        .json({ status: false, error: "Nothing to unassign" });
    }

    return res.json({ status: true, message: "Unassigned successfully" });
  } catch (err) {
    console.error("assign delete error:", err);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
