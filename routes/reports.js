const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

// normalize user from auth middleware
function getReqUser(req) {
  const src = req.auth || req.user || {};
  return { id: src.id, role: (src.role || "").toLowerCase() };
}

// build 16 weekly slots starting from an anchor date
function generateWeeks(startISO) {
  const weeks = [];
  for (let w = 0; w < 16; w++) {
    const d = new Date(startISO);
    d.setUTCDate(d.getUTCDate() + 7 * w);
    weeks.push({ week: w + 1, planned_date: d.toISOString().slice(0, 10) });
  }
  return weeks;
}

// determine start anchor date (earliest session or course_offering.created_at)
async function findAnchorDate(offeringId) {
  const s = await query(
    `SELECT TOP 1 planned_start_utc 
       FROM dbo.course_sessions 
      WHERE offering_id=@p0 
      ORDER BY planned_start_utc ASC`,
    [offeringId]
  );
  if (s.recordset.length && s.recordset[0].planned_start_utc)
    return new Date(s.recordset[0].planned_start_utc)
      .toISOString()
      .slice(0, 10);

  const o = await query(
    `SELECT created_at 
       FROM dbo.course_offerings 
      WHERE id=@p0`,
    [offeringId]
  );
  if (o.recordset.length && o.recordset[0].created_at)
    return new Date(o.recordset[0].created_at).toISOString().slice(0, 10);

  return new Date().toISOString().slice(0, 10);
}

/* ==============================
   STUDENT REPORT
   POST /reports/student
   ============================== */
router.get("/student", auth, async (req, res) => {
  try {
    const { id: userId, role } = getReqUser(req);
    const { offering_id } = req.body || {};

    if (!offering_id)
      return res
        .status(400)
        .json({ status: false, error: "offering_id required" });

    // permission: admin OR assigned student
    if (role !== "admin") {
      const assigned = await query(
        `SELECT 1 FROM dbo.offering_assignments 
          WHERE offering_id=@p0 AND user_id=@p1 AND role='student'`,
        [offering_id, userId]
      );
      if (!assigned.recordset.length)
        return res
          .status(403)
          .json({ status: false, error: "Not assigned to this course" });
    }

    // validate offering
    const off = await query(
      `SELECT o.id, o.created_at, c.name AS course_name
         FROM dbo.course_offerings o
         JOIN dbo.courses c ON c.id = o.course_id
        WHERE o.id=@p0`,
      [offering_id]
    );
    if (!off.recordset.length)
      return res
        .status(404)
        .json({ status: false, error: "Course offering not found" });

    const anchor = await findAnchorDate(offering_id);
    const weeks = generateWeeks(anchor);
    const today = new Date().toISOString().slice(0, 10);

    // sessions for this offering
    const sessions = await query(
      `SELECT id, planned_start_utc, status, started_at, ended_at
         FROM dbo.course_sessions
        WHERE offering_id=@p0`,
      [offering_id]
    );
    const ses = sessions.recordset;

    // attendance for this student
    const att = await query(
      `SELECT session_id, check_in_at, check_out_at
         FROM dbo.attendance_records
        WHERE user_id=@p0
          AND session_id IN (SELECT id FROM dbo.course_sessions WHERE offering_id=@p1)`,
      [userId, offering_id]
    );
    const attRows = att.recordset;

    const findByDate = (ymd) =>
      ses.find(
        (s) =>
          s.planned_start_utc &&
          new Date(s.planned_start_utc).toISOString().slice(0, 10) === ymd
      );

    const weekReports = [];
    const summary = { attend: 0, absence: 0, cancelled: 0, upcoming: 0 };

    for (const w of weeks) {
      const session = findByDate(w.planned_date);
      let status = "upcoming";
      let check_in_time = null;
      let check_out_time = null;

      if (w.planned_date > today) {
        status = "upcoming";
      } else if (!session) {
        status = "cancelled";
      } else {
        const recs = attRows.filter((r) => r.session_id === session.id);
        const hasIn = recs.some((r) => r.check_in_at);
        if (hasIn) {
          status = "attend";
          const minIn = Math.min(
            ...recs
              .filter((r) => r.check_in_at)
              .map((r) => new Date(r.check_in_at).getTime())
          );
          check_in_time = new Date(minIn).toISOString().slice(11, 19);

          const outs = recs.filter((r) => r.check_out_at);
          if (outs.length) {
            const maxOut = Math.max(
              ...outs.map((r) => new Date(r.check_out_at).getTime())
            );
            check_out_time = new Date(maxOut).toISOString().slice(11, 19);
          }
        } else {
          status = "absence";
        }
      }

      summary[status] += 1;
      weekReports.push({
        week: w.week,
        planned_date: w.planned_date,
        status,
        check_in_time,
        check_out_time,
      });
    }

    return res.json({
      status: true,
      offering_id,
      student_id: userId,
      course_name: off.recordset[0].course_name,
      weeks_total: 16,
      weeks: weekReports,
      summary,
    });
  } catch (e) {
    console.error("student report error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/* ==============================
   TEACHER REPORT
   POST /reports/teacher
   ============================== */
router.get("/teacher", auth, async (req, res) => {
  try {
    const { id: userId, role } = getReqUser(req);
    const { offering_id } = req.body || {};

    if (!offering_id)
      return res
        .status(400)
        .json({ status: false, error: "offering_id required" });

    // permission: admin OR teacher on this course
    if (role !== "admin") {
      const assigned = await query(
        `SELECT 1 FROM dbo.offering_assignments 
          WHERE offering_id=@p0 AND user_id=@p1 AND role='teacher'`,
        [offering_id, userId]
      );
      if (!assigned.recordset.length)
        return res
          .status(403)
          .json({ status: false, error: "Not assigned as teacher" });
    }

    // offering info
    const off = await query(
      `SELECT o.id, o.created_at, c.name AS course_name
         FROM dbo.course_offerings o
         JOIN dbo.courses c ON c.id = o.course_id
        WHERE o.id=@p0`,
      [offering_id]
    );
    if (!off.recordset.length)
      return res
        .status(404)
        .json({ status: false, error: "Course offering not found" });

    const anchor = await findAnchorDate(offering_id);
    const weeks = generateWeeks(anchor);
    const today = new Date().toISOString().slice(0, 10);

    const sessions = await query(
      `SELECT id, planned_start_utc, status, started_at, ended_at
         FROM dbo.course_sessions
        WHERE offering_id=@p0`,
      [offering_id]
    );
    const ses = sessions.recordset;

    const findByDate = (ymd) =>
      ses.find(
        (s) =>
          s.planned_start_utc &&
          new Date(s.planned_start_utc).toISOString().slice(0, 10) === ymd
      );

    const weekReports = [];
    const summary = { ended: 0, started: 0, cancelled: 0, upcoming: 0 };

    for (const w of weeks) {
      const session = findByDate(w.planned_date);
      let status = "upcoming";
      let start_time = null;
      let end_time = null;

      if (w.planned_date > today) {
        status = "upcoming";
      } else if (!session) {
        status = "cancelled";
      } else if (session.status === "ended") {
        status = "ended";
        start_time = session.started_at
          ? new Date(session.started_at).toISOString().slice(11, 19)
          : null;
        end_time = session.ended_at
          ? new Date(session.ended_at).toISOString().slice(11, 19)
          : null;
      } else if (session.status === "started") {
        status = "started";
        start_time = session.started_at
          ? new Date(session.started_at).toISOString().slice(11, 19)
          : null;
      } else {
        status = "cancelled";
      }

      summary[status] += 1;
      weekReports.push({
        week: w.week,
        planned_date: w.planned_date,
        status,
        start_time,
        end_time,
      });
    }

    return res.json({
      status: true,
      offering_id,
      course_name: off.recordset[0].course_name,
      weeks_total: 16,
      weeks: weekReports,
      summary,
    });
  } catch (e) {
    console.error("teacher report error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
