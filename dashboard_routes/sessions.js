// dashboard_routes/sessions.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

// Admin gate
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ status: false, error: "Admin only" });
  }
  next();
}

// Simple paging helper
function parsePaging(q) {
  const page = Math.max(1, parseInt(q.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(q.limit || "20", 10)));
  return { page, limit };
}

/**
 * GET /dashboard/sessions
 * Query:
 *  - offering_id?    (number)
 *  - status?         ('planned'|'started'|'ended'|'cancelled')
 *  - date_from?      (YYYY-MM-DD)
 *  - date_to?        (YYYY-MM-DD)
 *  - page, limit
 */
router.get("/", auth, requireAdmin, async (req, res) => {
  try {
    const { page, limit } = parsePaging(req.query);
    const offset = (page - 1) * limit;

    const offeringId = req.query.offering_id
      ? Number(req.query.offering_id)
      : null;
    const status = req.query.status || null;
    const from = req.query.date_from || null;
    const to = req.query.date_to || null;

    const where = [];
    const params = [];

    if (offeringId) {
      where.push(`s.offering_id = @p${params.length}`);
      params.push(offeringId);
    }
    if (status) {
      where.push(`s.status = @p${params.length}`);
      params.push(status);
    }
    if (from) {
      where.push(`CAST(s.planned_start_utc AS DATE) >= @p${params.length}`);
      params.push(from);
    }
    if (to) {
      where.push(`CAST(s.planned_start_utc AS DATE) <= @p${params.length}`);
      params.push(to);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countSql = `
      SELECT COUNT(*) AS total
      FROM dbo.course_sessions s
      ${whereSql}
    `;
    const total = (await query(countSql, params)).recordset[0].total;

    const dataSql = `
      SELECT s.id, s.offering_id, s.status,
             s.planned_start_utc, s.planned_end_utc,
             s.started_at, s.ended_at, s.room_id
      FROM dbo.course_sessions s
      ${whereSql}
      ORDER BY s.planned_start_utc DESC, s.id DESC
      OFFSET @p${params.length} ROWS
      FETCH NEXT @p${params.length + 1} ROWS ONLY;
    `;
    const data = await query(dataSql, [...params, offset, limit]);

    res.json({
      status: true,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      data: data.recordset,
    });
  } catch (e) {
    console.error("sessions list error:", e);
    res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
