// routes/attendanceReport.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");
const Excel = require("exceljs");

// Admin gate
function requireAdmin(req, res, next) {
  const role = (req.user?.role || req.auth?.role || "").toLowerCase();
  if (role !== "admin") {
    return res.status(403).json({ status: false, error: "Admin only" });
  }
  next();
}

// Paging helper
function parsePaging(q) {
  const page = Math.max(1, parseInt(q.page || "1", 10));
  const limit = Math.min(1000, Math.max(1, parseInt(q.limit || "100", 10)));
  return { page, limit };
}

// Excel helper
async function sendExcel(res, filename, columns, rows) {
  const Excel = require("exceljs");
  const wb = new Excel.Workbook();
  const ws = wb.addWorksheet("Attendance");
  ws.columns = columns;
  rows.forEach((r) => ws.addRow(r));

  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_") + ".xlsx";
  res.attachment(safe); // sets Content-Disposition + sensible filename
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );

  await wb.xlsx.write(res);
  res.end();
}

/**
 * GET /dashboard/attendance/course/:id
 * Query:
 *   date_from=YYYY-MM-DD
 *   date_to=YYYY-MM-DD
 *   role=student|teacher|assistant
 *   page=1&limit=100  (ignored if download=1)
 *   download=1        (Excel)
 */
router.get("/course/:id", auth, requireAdmin, async (req, res) => {
  try {
    const offeringId = Number(req.params.id);
    const { date_from, date_to, role } = req.query;
    const download = String(req.query.download || "") === "1";

    // dynamic WHERE
    const where = ["s.offering_id = @p0"];
    const params = [offeringId];

    if (date_from) {
      where.push(`CAST(s.planned_start_utc AS DATE) >= @p${params.length}`);
      params.push(date_from);
    }
    if (date_to) {
      where.push(`CAST(s.planned_start_utc AS DATE) <= @p${params.length}`);
      params.push(date_to);
    }
    if (role) {
      where.push(`u.role = @p${params.length}`);
      params.push(String(role));
    }

    const baseSelect = `
      SELECT
        ar.id                       AS attendance_id,
        ar.user_id,
        u.name,
        u.email,
        u.role,
        s.id                        AS session_id,
        s.status                    AS session_status,
        s.planned_start_utc,
        s.planned_end_utc,
        ar.check_in_at,
        ar.check_out_at,
        ar.status                   AS attendance_status
      FROM dbo.attendance_records ar
      JOIN dbo.course_sessions s ON s.id = ar.session_id
      JOIN dbo.users u          ON u.id = ar.user_id
      WHERE ${where.join(" AND ")}
    `;

    if (download) {
      const data = await query(
        `${baseSelect}
         ORDER BY s.planned_start_utc, u.name, u.id`,
        params
      );
      return sendExcel(
        res,
        `attendance_course_${offeringId}`,
        [
          { header: "User ID", key: "user_id", width: 10 },
          { header: "Name", key: "name", width: 25 },
          { header: "Email", key: "email", width: 28 },
          { header: "Role", key: "role", width: 12 },
          { header: "Session ID", key: "session_id", width: 12 },
          { header: "Session Status", key: "session_status", width: 14 },
          {
            header: "Planned Start (UTC)",
            key: "planned_start_utc",
            width: 22,
          },
          { header: "Planned End (UTC)", key: "planned_end_utc", width: 22 },
          { header: "Check-in (UTC)", key: "check_in_at", width: 22 },
          { header: "Check-out (UTC)", key: "check_out_at", width: 22 },
          { header: "Attendance Status", key: "attendance_status", width: 16 },
        ],
        data.recordset
      );
    }

    // paged JSON
    const { page, limit } = parsePaging(req.query);
    const offset = (page - 1) * limit;

    const countSql = `
      SELECT COUNT(*) AS total
      FROM dbo.attendance_records ar
      JOIN dbo.course_sessions s ON s.id = ar.session_id
      JOIN dbo.users u          ON u.id = ar.user_id
      WHERE ${where.join(" AND ")}
    `;
    const total = (await query(countSql, params)).recordset[0].total;

    const pageSql = `
      ${baseSelect}
      ORDER BY s.planned_start_utc, u.name, u.id
      OFFSET @p${params.length} ROWS
      FETCH NEXT @p${params.length + 1} ROWS ONLY;
    `;
    const pageData = await query(pageSql, [...params, offset, limit]);

    return res.json({
      status: true,
      offering_id: offeringId,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      data: pageData.recordset,
    });
  } catch (e) {
    console.error("attendance by course error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * GET /dashboard/attendance/user/:id
 * Query:
 *   offering_id? (optional)
 *   date_from / date_to
 *   page / limit (ignored if download=1)
 *   download=1  (Excel)
 */
router.get("/user/:id", auth, requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const offeringId = req.query.offering_id
      ? Number(req.query.offering_id)
      : null;
    const { date_from, date_to } = req.query;
    const download = String(req.query.download || "") === "1";

    const where = ["ar.user_id = @p0"];
    const params = [userId];

    if (offeringId) {
      where.push(`s.offering_id = @p${params.length}`);
      params.push(offeringId);
    }
    if (date_from) {
      where.push(`CAST(s.planned_start_utc AS DATE) >= @p${params.length}`);
      params.push(date_from);
    }
    if (date_to) {
      where.push(`CAST(s.planned_start_utc AS DATE) <= @p${params.length}`);
      params.push(date_to);
    }

    const baseSelect = `
      SELECT
        s.offering_id,
        c.name                    AS course_name,
        ar.session_id,
        s.status                  AS session_status,
        s.planned_start_utc,
        s.planned_end_utc,
        ar.check_in_at,
        ar.check_out_at,
        ar.status                 AS attendance_status
      FROM dbo.attendance_records ar
      JOIN dbo.course_sessions  s ON s.id = ar.session_id
      JOIN dbo.course_offerings o ON o.id = s.offering_id
      JOIN dbo.courses         c ON c.id = o.course_id
      WHERE ${where.join(" AND ")}
    `;

    if (download) {
      const data = await query(
        `${baseSelect}
         ORDER BY c.name, s.planned_start_utc, ar.session_id`,
        params
      );
      return sendExcel(
        res,
        `attendance_user_${userId}`,
        [
          { header: "Course", key: "course_name", width: 28 },
          { header: "Offering ID", key: "offering_id", width: 12 },
          { header: "Session ID", key: "session_id", width: 12 },
          { header: "Session Status", key: "session_status", width: 14 },
          {
            header: "Planned Start (UTC)",
            key: "planned_start_utc",
            width: 22,
          },
          { header: "Planned End (UTC)", key: "planned_end_utc", width: 22 },
          { header: "Check-in (UTC)", key: "check_in_at", width: 22 },
          { header: "Check-out (UTC)", key: "check_out_at", width: 22 },
          { header: "Attendance Status", key: "attendance_status", width: 16 },
        ],
        data.recordset
      );
    }

    const { page, limit } = parsePaging(req.query);
    const offset = (page - 1) * limit;

    const countSql = `
      SELECT COUNT(*) AS total
      FROM dbo.attendance_records ar
      JOIN dbo.course_sessions  s ON s.id = ar.session_id
      JOIN dbo.course_offerings o ON o.id = s.offering_id
      JOIN dbo.courses         c ON c.id = o.course_id
      WHERE ${where.join(" AND ")}
    `;
    const total = (await query(countSql, params)).recordset[0].total;

    const pageSql = `
      ${baseSelect}
      ORDER BY c.name, s.planned_start_utc, ar.session_id
      OFFSET @p${params.length} ROWS
      FETCH NEXT @p${params.length + 1} ROWS ONLY;
    `;
    const pageData = await query(pageSql, [...params, offset, limit]);

    return res.json({
      status: true,
      user_id: userId,
      offering_id: offeringId || null,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      data: pageData.recordset,
    });
  } catch (e) {
    console.error("attendance by user error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
