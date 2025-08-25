// index.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { query } = require("./DB/dbConnection");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.set("io", io);

// health check
app.get("/", (req, res) => res.json({ ok: true }));

// mount routes
app.use("/auth", require("./routes/auth"));
app.use("/lectures", require("./routes/lectures"));
app.use("/lecture-assignments", require("./routes/lectureAssignments"));
app.use("/lecture-sessions", require("./routes/lectureSessions"));
app.use("/attendance", require("./routes/attendance"));
app.use("/reports", require("./routes/reports"));
app.use("/weekly-reports", require("./routes/weeklySummary"));
app.use("/files", require("./routes/files"));
app.use("/lecture-sessions", require("./routes/getLectureSessions"));
app.use("/admin", require("./routes/adminOps"));

// 404 fallback
app.use((req, res) =>
  res.status(404).json({ status: false, error: "Not found", path: req.path })
);

/* ------------------ Socket.IO (only assigned users) ------------------ */

// authenticate socket using JWT from handshake auth
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("no token"));
    const user = jwt.verify(token, process.env.JWT_SECRET || "supersecret");
    socket.user = { id: user.id, role: user.role };
    socket.join(`user:${user.id}`); // optional per-user room
    next();
  } catch {
    next(new Error("bad token"));
  }
});

// allow joining lecture rooms only if the user is assigned to that lecture
io.on("connection", (socket) => {
  socket.on("join-lecture", async (lectureId) => {
    try {
      const r = await query(
        `SELECT role FROM dbo.lecture_assignments WHERE lecture_id=@p0 AND user_id=@p1`,
        [lectureId, socket.user.id]
      );

      if (!r.recordset.length && socket.user.role !== "admin") {
        return socket.emit("join-denied", {
          lecture_id: lectureId,
          reason: "not assigned",
        });
      }

      const role = r.recordset[0]?.role || socket.user.role;

      if (role === "student") socket.join(`lec:${lectureId}:students`);
      if (role === "teacher") socket.join(`lec:${lectureId}:teachers`);
      socket.join(`lec:${lectureId}:all`); // optional combined

      socket.emit("join-ok", { lecture_id: lectureId, role });
    } catch {
      socket.emit("join-denied", {
        lecture_id: lectureId,
        reason: "server error",
      });
    }
  });

  socket.on("leave-lecture", (lectureId) => {
    socket.leave(`lec:${lectureId}:students`);
    socket.leave(`lec:${lectureId}:teachers`);
    socket.leave(`lec:${lectureId}:all`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Server + Socket.IO on http://localhost:${PORT}`)
);
