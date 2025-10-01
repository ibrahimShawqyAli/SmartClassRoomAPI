// index.js
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { query } = require("./DB/dbConnection");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.set("io", io);

// static files for uploaded content
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// health
app.get("/", (req, res) => res.json({ ok: true }));

/* ============== ROUTES ============== */
// offering details (GET /offering-details?offering_id=...)
app.use("/", require("./routes/offeringDetails.js"));

// auth
app.use("/auth", require("./routes/auth"));

// NEW offering-based routes
app.use("/offerings", require("./routes/offerings.js"));
app.use("/offering-assignments", require("./routes/offeringAssignments.js"));
app.use("/sessions", require("./routes/sessions.js"));

app.use("/lectures", require("./routes/offerings.js"));
app.use("/lecture-assignments", require("./routes/offeringAssignments.js"));
app.use("/lecture-sessions", require("./routes/getLectureSessions.js"));
// Face recognition, attendance, reports, weekly summary
app.use("/fr", require("./routes/face.js"));
app.use("/attendance", require("./routes/attendance"));
app.use("/reports", require("./routes/reports"));
app.use("/weekly-reports", require("./routes/summary.js"));
app.use("/files", require("./routes/files"));
app.use("/admin", require("./routes/adminOps"));

// Admin dashboard
app.use("/dashboard", require("./dashboard_routes/index.js"));

// 404
app.use((req, res) =>
  res.status(404).json({ status: false, error: "Not found", path: req.path })
);

/* ============== SOCKET.IO ============== */
// Socket.IO auth
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("no token"));
    const user = jwt.verify(token, process.env.JWT_SECRET || "supersecret");
    socket.user = { id: user.id, role: user.role };
    socket.join(`user:${user.id}`);
    next();
  } catch (err) {
    next(new Error("bad token"));
  }
});

// helper: join offering rooms with permission check
async function joinOfferingRooms(socket, offeringId) {
  const uid = socket.user.id;
  const role = (socket.user.role || "").toLowerCase();

  // admin can always join; otherwise must be assigned
  if (role !== "admin") {
    const r = await query(
      `SELECT role FROM dbo.offering_assignments WHERE offering_id=@p0 AND user_id=@p1`,
      [offeringId, uid]
    );
    if (!r.recordset.length) {
      socket.emit("join-denied", {
        offering_id: offeringId,
        reason: "not assigned",
      });
      return;
    }
    const assignedRole = (r.recordset[0].role || "").toLowerCase();
    if (assignedRole === "student") socket.join(`off:${offeringId}:students`);
    if (assignedRole === "teacher") socket.join(`off:${offeringId}:teachers`);
  } else {
    // admin joins both teacher & student rooms logically
    socket.join(`off:${offeringId}:teachers`);
    socket.join(`off:${offeringId}:students`);
  }

  socket.join(`off:${offeringId}:all`);
  socket.emit("join-ok", { offering_id: offeringId, role });
}

function leaveOfferingRooms(socket, offeringId) {
  socket.leave(`off:${offeringId}:students`);
  socket.leave(`off:${offeringId}:teachers`);
  socket.leave(`off:${offeringId}:all`);
}

io.on("connection", (socket) => {
  // New events (preferred)
  socket.on("join-offering", async (offeringId) => {
    try {
      await joinOfferingRooms(socket, offeringId);
    } catch (e) {
      console.error("join-offering error:", e);
      socket.emit("join-denied", {
        offering_id: offeringId,
        reason: "server error",
      });
    }
  });

  socket.on("leave-offering", (offeringId) => {
    leaveOfferingRooms(socket, offeringId);
  });

  // Backward-compatible legacy events (map to new)
  socket.on("join-lecture", async (lectureId) => {
    try {
      // find mapped offering (if map table exists)
      const m = await query(
        `SELECT offering_id FROM dbo.map_lecture_offering WHERE lecture_id=@p0`,
        [lectureId]
      );
      const offeringId = m.recordset[0]?.offering_id || null;
      if (!offeringId) {
        socket.emit("join-denied", {
          lecture_id: lectureId,
          reason: "no mapping",
        });
        return;
      }
      await joinOfferingRooms(socket, offeringId);
      // Inform client of the mapped id (optional)
      socket.emit("mapped-offering", {
        lecture_id: lectureId,
        offering_id: offeringId,
      });
    } catch (e) {
      console.error("join-lecture error:", e);
      socket.emit("join-denied", {
        lecture_id: lectureId,
        reason: "server error",
      });
    }
  });

  socket.on("leave-lecture", async (lectureId) => {
    try {
      const m = await query(
        `SELECT offering_id FROM dbo.map_lecture_offering WHERE lecture_id=@p0`,
        [lectureId]
      );
      const offeringId = m.recordset[0]?.offering_id || null;
      if (offeringId) leaveOfferingRooms(socket, offeringId);
    } catch (e) {
      // ignore
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Server + Socket.IO on http://localhost:${PORT}`)
);
