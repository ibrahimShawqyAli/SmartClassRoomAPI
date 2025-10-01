// dbConnection.js
const sql = require("mssql");
require("dotenv").config();

const pool = new sql.ConnectionPool({
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DB,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  options: {
    encrypt: process.env.SQL_ENCRYPT === "true",
    trustServerCertificate: process.env.SQL_TRUST_CERT === "true",
    port: 1433,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
});

let poolPromise;
function getPool() {
  if (!poolPromise) poolPromise = pool.connect();
  return poolPromise;
}

// plain text query (you already had this)
async function query(q, params = []) {
  const p = await getPool();
  const request = p.request();
  params.forEach((v, i) => request.input(`p${i}`, v));
  return request.query(q);
}

/* ---------- ADD BELOW: typed inputs + execProc helper ---------- */
function addInputs(request, params = {}, types = {}) {
  // params: { name: value, ... }
  // types:  { name: sql.Type, ... }  // optional per-param override
  for (const [name, value] of Object.entries(params)) {
    const t = types[name];
    if (t) request.input(name, t, value);
    else request.input(name, value); // let mssql infer if type not provided
  }
  return request;
}

async function execProc(procName, params = {}, types = {}) {
  const p = await getPool();
  const request = addInputs(p.request(), params, types);
  return request.execute(procName);
}

/* Common type aliases you’ll use when calling execProc */
const TYPES = {
  Int: sql.Int,
  TinyInt: sql.TinyInt,
  VarChar: sql.VarChar,
  NVarChar: sql.NVarChar,
  Date: sql.Date,
  DateTime2: sql.DateTime2,
  Time: sql.Time,
  Bit: sql.Bit,
};

/* Optional: expose a close() for tests/shutdowns */
async function close() {
  if (poolPromise) {
    const p = await poolPromise;
    await p.close();
    poolPromise = null;
  }
}

module.exports = { sql, TYPES, getPool, query, execProc, close };
